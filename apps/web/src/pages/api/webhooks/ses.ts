import {
  applySesEvent,
  confirmSnsSubscription,
  SnsError,
  type SnsMessage,
  verifySnsMessage,
} from "@rlr/core/readers";
import type { APIRoute } from "astro";
import { z } from "zod";
import { log } from "../../../lib/log";
import { env, getDb } from "../../../lib/runtime";

// SES bounces, complaints and deliveries arrive here through SNS (DESIGN §13.3). SNS posts
// text/plain without an Origin header, so this route is exempt from the form origin check; every
// message is authenticated by its signature instead (verifySnsMessage).

const snsSchema = z.object({
  Type: z.enum(["Notification", "SubscriptionConfirmation", "UnsubscribeConfirmation"]),
  MessageId: z.string().max(200),
  TopicArn: z.string().max(300),
  Subject: z.string().max(500).optional(),
  Message: z.string().max(262_144),
  Timestamp: z.string().max(40),
  SignatureVersion: z.enum(["1", "2"]),
  Signature: z.string().max(2_000),
  SigningCertURL: z.string().url().max(500),
  SubscribeURL: z.string().url().max(2_000).optional(),
  Token: z.string().max(2_000).optional(),
});

export const POST: APIRoute = async ({ request }) => {
  const topicArn = env.SNS_TOPIC_ARN;
  if (!topicArn) {
    log.warn("ses_webhook.not_configured");
    return new Response("Not configured", { status: 503 });
  }
  const body = await request.text();
  if (body.length > 300_000) return new Response("Too large", { status: 413 });
  let parsed: SnsMessage;
  try {
    parsed = snsSchema.parse(JSON.parse(body)) as SnsMessage;
    await verifySnsMessage(parsed, { topicArn });
  } catch (error) {
    log.warn("ses_webhook.refused", { reason: error instanceof SnsError ? error.message : "malformed" });
    return new Response("Refused", { status: 403 });
  }
  if (parsed.Type === "SubscriptionConfirmation") {
    await confirmSnsSubscription(parsed);
    log.info("ses_webhook.subscribed", { topic: parsed.TopicArn });
    return new Response("OK");
  }
  if (parsed.Type === "Notification") {
    const outcome = await applySesEvent(getDb(), parsed.Message);
    log.info("ses_webhook.event", { ...outcome, sns_id: parsed.MessageId });
  }
  return new Response("OK");
};
