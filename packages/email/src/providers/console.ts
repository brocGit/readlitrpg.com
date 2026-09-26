// Local development only: prints the email so a developer can click the sign-in link.
// The jobs Worker refuses to use this provider outside ENVIRONMENT=local.

import type { EmailMessage, EmailProvider, SendResult } from "../types";

export class ConsoleProvider implements EmailProvider {
  readonly name = "console";
  readonly sent: EmailMessage[] = [];

  constructor(private readonly print: (line: string) => void = console.log) {}

  async send(message: EmailMessage): Promise<SendResult> {
    this.sent.push(message);
    this.print(`\n--- email to ${message.to}: ${message.subject}\n${message.text}\n---\n`);
    return { provider: this.name, messageId: `console-${this.sent.length}` };
  }
}
