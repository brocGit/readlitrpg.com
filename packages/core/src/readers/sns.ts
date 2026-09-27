// SES delivery events through SNS (DESIGN §13.2, §13.3): bounces and complaints suppress the address
// at once, and every event updates the send log. Each message is verified before anything happens:
// the signing certificate must come from an SNS host over HTTPS, the signature must check out with
// its key, the topic must be ours, and the message must be recent.

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { emailConsents, emailSends, users } from "../db/schema";
import { safeFetch } from "../net/safe-fetch";
import { nowIso } from "../time";
import { suppress } from "./consent";

export interface SnsMessage {
  Type: "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation";
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: "1" | "2";
  Signature: string;
  SigningCertURL: string;
  SubscribeURL?: string;
  Token?: string;
}

export class SnsError extends Error {}

const CERT_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

/** The exact string SNS signs, per message type. */
export function stringToSign(m: SnsMessage): string {
  const keys =
    m.Type === "Notification"
      ? [
          "Message",
          "MessageId",
          ...(m.Subject !== undefined ? ["Subject"] : []),
          "Timestamp",
          "TopicArn",
          "Type",
        ]
      : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  return keys.map((k) => `${k}\n${(m as unknown as Record<string, string>)[k] ?? ""}\n`).join("");
}

// ---------------------------------------------------------------------------------------------
// X.509 → SubjectPublicKeyInfo. WebCrypto imports "spki", not certificates, so walk just enough
// DER to find it: Certificate → tbsCertificate → [version], serial, signature, issuer, validity,
// subject, subjectPublicKeyInfo. We trust the certificate by where it came from, not by its chain.

function readTlv(der: Uint8Array, at: number): { tag: number; start: number; end: number; next: number } {
  const tag = der[at] ?? 0;
  let len = der[at + 1] ?? 0;
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new SnsError("bad certificate length");
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | (der[at + 2 + i] ?? 0);
    start = at + 2 + n;
  }
  const end = start + len;
  if (end > der.length) throw new SnsError("truncated certificate");
  return { tag, start, end, next: end };
}

export function spkiFromCertificate(pem: string): Uint8Array {
  const b64 = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const cert = readTlv(der, 0);
  const tbs = readTlv(der, cert.start);
  if (cert.tag !== 0x30 || tbs.tag !== 0x30) throw new SnsError("not a certificate");
  let at = tbs.start;
  const first = readTlv(der, at);
  if (first.tag === 0xa0) at = first.next; // explicit [0] version
  for (let i = 0; i < 5; i++) at = readTlv(der, at).next; // serial, signature, issuer, validity, subject
  const spki = readTlv(der, at);
  if (spki.tag !== 0x30) throw new SnsError("no public key in certificate");
  return der.slice(at, spki.end);
}

const certCache = new Map<string, Uint8Array>();

export interface VerifyOptions {
  topicArn: string;
  fetch?: typeof fetch;
  now?: Date;
  /** Tests hand the certificate over directly. */
  certificate?: (url: string) => Promise<string>;
}

export async function verifySnsMessage(m: SnsMessage, opts: VerifyOptions): Promise<void> {
  if (!["Notification", "SubscriptionConfirmation", "UnsubscribeConfirmation"].includes(m.Type))
    throw new SnsError("unknown message type");
  if (m.TopicArn !== opts.topicArn) throw new SnsError("not our topic");
  const age = (opts.now ?? new Date()).getTime() - Date.parse(m.Timestamp);
  if (!Number.isFinite(age) || age > 3_600_000 || age < -300_000)
    throw new SnsError("stale or future message");
  const url = new URL(m.SigningCertURL);
  if (url.protocol !== "https:" || !CERT_HOST.test(url.hostname) || !url.pathname.endsWith(".pem"))
    throw new SnsError("untrusted certificate URL");
  let spki = certCache.get(url.href);
  if (!spki) {
    let pem: string;
    if (opts.certificate) pem = await opts.certificate(url.href);
    else {
      const res = await safeFetch(url.href, {
        allowHosts: [url.hostname],
        fetch: opts.fetch,
        maxBytes: 20_000,
      });
      if (res.status !== 200) throw new SnsError(`certificate fetch failed (${res.status})`);
      pem = res.text;
    }
    spki = spkiFromCertificate(pem);
    certCache.set(url.href, spki);
  }
  const key = await crypto.subtle.importKey(
    "spki",
    new Uint8Array(spki),
    { name: "RSASSA-PKCS1-v1_5", hash: m.SignatureVersion === "2" ? "SHA-256" : "SHA-1" },
    false,
    ["verify"],
  );
  const signature = Uint8Array.from(atob(m.Signature), (c) => c.charCodeAt(0));
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    new TextEncoder().encode(stringToSign(m)),
  );
  if (!ok) throw new SnsError("bad signature");
}

/** Accept a verified subscription request by visiting its SubscribeURL (on an SNS host only). */
export async function confirmSnsSubscription(
  m: SnsMessage,
  opts: { fetch?: typeof fetch } = {},
): Promise<void> {
  if (m.Type !== "SubscriptionConfirmation" || !m.SubscribeURL)
    throw new SnsError("not a subscription request");
  const url = new URL(m.SubscribeURL);
  if (url.protocol !== "https:" || !CERT_HOST.test(url.hostname))
    throw new SnsError("untrusted subscribe URL");
  const res = await safeFetch(url.href, { allowHosts: [url.hostname], fetch: opts.fetch, maxBytes: 20_000 });
  if (res.status !== 200) throw new SnsError(`subscription confirmation failed (${res.status})`);
}

// ---------------------------------------------------------------------------------------------
// Acting on SES events (event publishing and the older notification format)

interface SesEvent {
  eventType?: string;
  notificationType?: string;
  mail?: { messageId?: string };
  bounce?: { bounceType?: string; bouncedRecipients?: { emailAddress?: string }[] };
  complaint?: { complainedRecipients?: { emailAddress?: string }[] };
}

export interface SesOutcome {
  kind: "bounce" | "complaint" | "delivery" | "other";
  suppressed: number;
}

export async function applySesEvent(db: Db, message: string): Promise<SesOutcome> {
  let e: SesEvent;
  try {
    e = JSON.parse(message) as SesEvent;
  } catch {
    return { kind: "other", suppressed: 0 };
  }
  const type = (e.eventType ?? e.notificationType ?? "").toLowerCase();
  const messageId = e.mail?.messageId;
  const mark = async (status: "bounced" | "complained" | "delivered") => {
    if (messageId)
      await db.update(emailSends).set({ status }).where(eq(emailSends.providerMessageId, messageId));
  };
  if (type === "bounce") {
    // Only permanent bounces mean the address is gone; transient ones (mailbox full) retry later.
    if (e.bounce?.bounceType !== "Permanent") return { kind: "bounce", suppressed: 0 };
    const addresses = (e.bounce.bouncedRecipients ?? [])
      .map((r) => r.emailAddress)
      .filter((a): a is string => Boolean(a));
    for (const a of addresses) await suppress(db, a, "bounce_hard");
    await mark("bounced");
    return { kind: "bounce", suppressed: addresses.length };
  }
  if (type === "complaint") {
    const addresses = (e.complaint?.complainedRecipients ?? [])
      .map((r) => r.emailAddress)
      .filter((a): a is string => Boolean(a));
    for (const a of addresses) {
      await suppress(db, a, "complaint");
      // A complaint unsubscribes from every marketing list (§13.3).
      const found = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, a.trim().toLowerCase()));
      if (found.length)
        await db
          .update(emailConsents)
          .set({ status: "unsubscribed", unsubscribedAt: nowIso(), updatedAt: nowIso() })
          .where(
            and(
              inArray(
                emailConsents.userId,
                found.map((f) => f.id),
              ),
              eq(emailConsents.status, "active"),
            ),
          );
    }
    await mark("complained");
    return { kind: "complaint", suppressed: addresses.length };
  }
  if (type === "delivery") {
    await mark("delivered");
    return { kind: "delivery", suppressed: 0 };
  }
  return { kind: "other", suppressed: 0 };
}
