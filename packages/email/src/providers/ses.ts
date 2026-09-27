// Amazon SES v2 SendEmail over HTTPS, signed with SigV4 by aws4fetch (DESIGN §13.2).

import { AwsClient } from "aws4fetch";
import type { EmailMessage, EmailProvider, SendResult } from "../types";

export interface SesConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Transactional mail, e.g. "ReadLitRPG <hello@notify.readlitrpg.com>" */
  from: string;
  /** Newsletters and alerts from their own subdomain, so their reputation is separate (DESIGN §13.1). */
  fromMarketing?: string;
  /** Separate configuration sets per stream keep reputations apart. */
  configurationSets?: Partial<Record<EmailMessage["stream"], string>>;
  fetch?: typeof fetch;
}

export class SesError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SesError";
  }

  /** 4xx other than throttling won't succeed on retry. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export class SesProvider implements EmailProvider {
  readonly name = "ses";
  private readonly client: AwsClient;

  constructor(private readonly config: SesConfig) {
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: config.region,
      service: "ses",
    });
  }

  async send(message: EmailMessage): Promise<SendResult> {
    const url = `https://email.${this.config.region}.amazonaws.com/v2/email/outbound-emails`;
    const headers = Object.entries(message.headers ?? {}).map(([Name, Value]) => ({ Name, Value }));
    const body = {
      FromEmailAddress:
        message.stream === "marketing" ? (this.config.fromMarketing ?? this.config.from) : this.config.from,
      Destination: { ToAddresses: [message.to] },
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: message.text, Charset: "UTF-8" },
            Html: { Data: message.html, Charset: "UTF-8" },
          },
          ...(headers.length ? { Headers: headers } : {}),
        },
      },
      ...(this.config.configurationSets?.[message.stream]
        ? { ConfigurationSetName: this.config.configurationSets[message.stream] }
        : {}),
    };
    const request = await this.client.sign(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const response = await (this.config.fetch ?? fetch)(request);
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new SesError(response.status, `SES ${response.status}: ${detail}`);
    }
    const json = (await response.json()) as { MessageId?: string };
    return { provider: this.name, messageId: json.MessageId ?? "" };
  }
}
