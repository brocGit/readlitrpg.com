import { generateKeyPairSync, sign } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db";
import { emailConsents, emailSends, users } from "../src/db/schema";
import {
  applySesEvent,
  confirmSnsSubscription,
  isSuppressed,
  SnsError,
  type SnsMessage,
  setConsent,
  spkiFromCertificate,
  stringToSign,
  verifySnsMessage,
} from "../src/readers";
import { createTestD1 } from "../src/testing";

// A structurally valid certificate around a fresh RSA key. The verifier trusts a certificate by
// the SNS host it came from, so only the structure and the key matter here.
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
function tlv(tag: number, body: Uint8Array): Uint8Array {
  const len = body.length;
  const head = len < 128 ? [tag, len] : len < 256 ? [tag, 0x81, len] : [tag, 0x82, len >> 8, len & 0xff];
  return new Uint8Array([...head, ...body]);
}
const seq = (...parts: Uint8Array[]) => tlv(0x30, new Uint8Array(parts.flatMap((p) => [...p])));
const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
const der = seq(
  seq(
    tlv(0xa0, tlv(0x02, new Uint8Array([2]))),
    tlv(0x02, new Uint8Array([1])),
    seq(),
    seq(),
    seq(),
    seq(),
    spki,
  ),
  seq(),
  tlv(0x03, new Uint8Array([0])),
);
const pem = `-----BEGIN CERTIFICATE-----\n${Buffer.from(der).toString("base64")}\n-----END CERTIFICATE-----\n`;

const TOPIC = "arn:aws:sns:us-east-1:123456789012:rlr-ses-events";
const CERT = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem";

function signed(
  m: Omit<SnsMessage, "Signature" | "SignatureVersion" | "SigningCertURL">,
  version: "1" | "2" = "2",
): SnsMessage {
  const full = { ...m, SignatureVersion: version, SigningCertURL: CERT, Signature: "" } as SnsMessage;
  const signature = sign(version === "2" ? "sha256" : "sha1", Buffer.from(stringToSign(full)), privateKey);
  full.Signature = Buffer.from(signature).toString("base64");
  return full;
}

const note = (message: unknown, at = new Date().toISOString()) =>
  signed({
    Type: "Notification",
    MessageId: "m1",
    TopicArn: TOPIC,
    Message: JSON.stringify(message),
    Timestamp: at,
  });

describe("SNS verification", () => {
  const opts = { topicArn: TOPIC, certificate: async () => pem };

  it("finds the key in the certificate and accepts correctly signed messages (v1 and v2)", async () => {
    expect(spkiFromCertificate(pem)).toEqual(spki);
    await verifySnsMessage(note({ eventType: "Delivery" }), opts);
    await verifySnsMessage(
      signed(
        {
          Type: "Notification",
          MessageId: "m2",
          TopicArn: TOPIC,
          Message: "{}",
          Timestamp: new Date().toISOString(),
        },
        "1",
      ),
      opts,
    );
  });

  it("refuses tampered, foreign, stale and badly sourced messages", async () => {
    const good = note({ eventType: "Bounce" });
    await expect(verifySnsMessage({ ...good, Message: '{"eventType":"Delivery"}' }, opts)).rejects.toThrow(
      /signature/,
    );
    await expect(
      verifySnsMessage(good, { ...opts, topicArn: "arn:aws:sns:us-east-1:1:other" }),
    ).rejects.toThrow(SnsError);
    await expect(
      verifySnsMessage(note({}, new Date(Date.now() - 2 * 3_600_000).toISOString()), opts),
    ).rejects.toThrow(/stale/);
    await expect(
      verifySnsMessage({ ...good, SigningCertURL: "https://evil.example.com/cert.pem" }, opts),
    ).rejects.toThrow(/untrusted/);
    await expect(
      verifySnsMessage({ ...good, SigningCertURL: "http://sns.us-east-1.amazonaws.com/c.pem" }, opts),
    ).rejects.toThrow(/untrusted/);
  });

  it("confirms a subscription only on an SNS host", async () => {
    const seen: string[] = [];
    const fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input instanceof Request ? input.url : input));
      return new Response("<ConfirmSubscriptionResponse/>");
    }) as typeof globalThis.fetch;
    const request = signed({
      Type: "SubscriptionConfirmation",
      MessageId: "m2",
      TopicArn: TOPIC,
      Message: "You have chosen to subscribe",
      Timestamp: new Date().toISOString(),
      SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t",
      Token: "t",
    });
    await verifySnsMessage(request, opts);
    await confirmSnsSubscription(request, { fetch });
    expect(seen).toEqual([request.SubscribeURL]);
    await expect(
      confirmSnsSubscription({ ...request, SubscribeURL: "https://evil.example.com/?Action=x" }, { fetch }),
    ).rejects.toThrow(/untrusted/);
  });
});

describe("SES events", () => {
  let db: Db;
  beforeEach(async () => {
    db = createDb(createTestD1().asD1());
    await db.insert(users).values({ id: "u1", email: "reader@example.com", state: "active" });
    await setConsent(db, "u1", "weekly_digest", true);
    await db.insert(emailSends).values({
      id: "s1",
      userId: "u1",
      template: "weekly_digest",
      providerMessageId: "ses-1",
      status: "sent",
    });
  });

  it("a permanent bounce suppresses the address everywhere; a transient one doesn't", async () => {
    await applySesEvent(
      db,
      JSON.stringify({
        eventType: "Bounce",
        mail: { messageId: "ses-1" },
        bounce: { bounceType: "Transient", bouncedRecipients: [{ emailAddress: "reader@example.com" }] },
      }),
    );
    expect(await isSuppressed(db, "reader@example.com", "marketing")).toBe(false);
    const r = await applySesEvent(
      db,
      JSON.stringify({
        eventType: "Bounce",
        mail: { messageId: "ses-1" },
        bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "reader@example.com" }] },
      }),
    );
    expect(r).toEqual({ kind: "bounce", suppressed: 1 });
    expect(await isSuppressed(db, "reader@example.com", "transactional")).toBe(true);
    expect((await db.select().from(emailSends))[0]?.status).toBe("bounced");
  });

  it("a complaint suppresses marketing mail and unsubscribes every list", async () => {
    await applySesEvent(
      db,
      JSON.stringify({
        notificationType: "Complaint",
        mail: { messageId: "ses-1" },
        complaint: { complainedRecipients: [{ emailAddress: "Reader@Example.com" }] },
      }),
    );
    expect(await isSuppressed(db, "reader@example.com", "marketing")).toBe(true);
    expect(await isSuppressed(db, "reader@example.com", "transactional")).toBe(false);
    const [c] = await db.select().from(emailConsents).where(eq(emailConsents.userId, "u1"));
    expect(c?.status).toBe("unsubscribed");
    expect((await db.select().from(emailSends))[0]?.status).toBe("complained");
  });
});
