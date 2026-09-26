import { describe, expect, it } from "vitest";
import { buildEmail, emailJobSchema, renderMagicLink, SesError, SesProvider } from "../src";

describe("magic link email", () => {
  it("escapes the URL and includes a plain-text part", () => {
    const url = 'https://readlitrpg.com/signin/confirm?token=abc&x="><script>';
    const { html, text, subject } = renderMagicLink(url);
    expect(subject).toContain("sign-in link");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
    expect(text).toContain(url);
    expect(text).toContain("15 minutes");
  });

  it("drops links that sat in the queue too long", () => {
    const job = emailJobSchema.parse({
      kind: "magic_link",
      to: "a@example.com",
      url: "https://readlitrpg.com/signin/confirm?token=t",
      requestedAt: "2026-09-26T12:00:00.000Z",
    });
    expect(buildEmail(job, new Date("2026-09-26T12:05:00Z"))?.to).toBe("a@example.com");
    expect(buildEmail(job, new Date("2026-09-26T12:20:00Z"))).toBeNull();
  });

  it("rejects malformed jobs", () => {
    expect(
      emailJobSchema.safeParse({ kind: "magic_link", to: "nope", url: "x", requestedAt: "y" }).success,
    ).toBe(false);
    expect(emailJobSchema.safeParse({ kind: "unknown" }).success).toBe(false);
  });
});

describe("SES provider", () => {
  const message = {
    to: "a@example.com",
    subject: "Hi",
    html: "<p>Hi</p>",
    text: "Hi",
    stream: "transactional" as const,
    headers: { "List-Unsubscribe": "<https://readlitrpg.com/u/t>" },
  };

  it("signs a SendEmail request and returns the message id", async () => {
    let seen: Request | undefined;
    const provider = new SesProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      region: "us-east-1",
      from: "ReadLitRPG <hello@mail.readlitrpg.com>",
      configurationSets: { transactional: "rlr-transactional" },
      fetch: async (input) => {
        seen = input as Request;
        return Response.json({ MessageId: "m-1" });
      },
    });
    expect(await provider.send(message)).toEqual({ provider: "ses", messageId: "m-1" });
    expect(seen?.url).toBe("https://email.us-east-1.amazonaws.com/v2/email/outbound-emails");
    expect(seen?.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
    const body = (await seen?.json()) as {
      ConfigurationSetName: string;
      Content: { Simple: { Headers: unknown } };
    };
    expect(body.ConfigurationSetName).toBe("rlr-transactional");
    expect(body.Content.Simple.Headers).toEqual([
      { Name: "List-Unsubscribe", Value: "<https://readlitrpg.com/u/t>" },
    ]);
  });

  it("marks throttling and server errors retryable, other 4xx not", async () => {
    const failing = (status: number) =>
      new SesProvider({
        accessKeyId: "a",
        secretAccessKey: "b",
        region: "us-east-1",
        from: "x@y.z",
        fetch: async () => new Response("nope", { status }),
      });
    await expect(failing(429).send(message)).rejects.toMatchObject({ retryable: true });
    await expect(failing(503).send(message)).rejects.toMatchObject({ retryable: true });
    const error = await failing(400)
      .send(message)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SesError);
    expect((error as SesError).retryable).toBe(false);
  });
});
