// Email is sent only by the jobs Worker (DESIGN §4.2). Other Workers enqueue a message on Q_EMAIL.

import { z } from "zod";

export type EmailStream = "transactional" | "marketing";

export interface EmailMessage {
  to: string;
  /** For the send log (email_sends). */
  template?: string;
  userId?: string | null;
  issueId?: string | null;
  subject: string;
  html: string;
  text: string;
  stream: EmailStream;
  /** Extra headers, e.g. List-Unsubscribe for marketing mail (DESIGN §13.3). */
  headers?: Record<string, string>;
}

export interface SendResult {
  provider: string;
  messageId: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<SendResult>;
}

/** Templates named in the send log (email_sends.template). */
export const TEMPLATES = [
  "magic_link",
  "confirm_subscription",
  "welcome_1",
  "welcome_2",
  "welcome_3",
  "welcome_4",
  "weekly_digest",
  "release_alert",
  "export_ready",
  "author_invite",
  "author_notice",
  "change_digest",
  "release_ask",
] as const;

/** Messages on Q_EMAIL. Validated when consumed; unknown kinds go to the DLQ. */
export const emailJobSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("magic_link"),
    to: z.email().max(320),
    url: z.url().max(2048),
    /** ISO time the link was requested; stale messages are dropped rather than sent late. */
    requestedAt: z.iso.datetime(),
  }),
  /** E0, double opt-in (DESIGN §13.3). Sent from the web Worker's subscribe endpoint. */
  z.object({
    kind: z.literal("confirm_subscription"),
    to: z.email().max(320),
    userId: z.string().max(40),
    url: z.url().max(2048),
    className: z.string().max(80).nullable(),
    listOnly: z.boolean(),
    requestedAt: z.iso.datetime(),
  }),
  /** A team invite for an author profile (M6). Sent from the web Worker's Team page. */
  z.object({
    kind: z.literal("author_invite"),
    to: z.email().max(320),
    url: z.url().max(2048),
    authorName: z.string().min(1).max(200),
    role: z.enum(["owner", "editor"]),
    requestedAt: z.iso.datetime(),
  }),
  /** Built and rendered by a job (welcome, digest, alerts, exports); the consumer only sends it. */
  z.object({
    kind: z.literal("rendered"),
    to: z.email().max(320),
    userId: z.string().max(40).nullable(),
    template: z.enum(TEMPLATES),
    issueId: z.string().max(40).nullable(),
    stream: z.enum(["transactional", "marketing"]),
    subject: z.string().min(1).max(200),
    // Queue messages are capped at 128 KB, so the two parts together stay under it.
    html: z.string().max(75_000),
    text: z.string().max(35_000),
    headers: z.record(z.string().max(60), z.string().max(1000)).optional(),
  }),
]);

export type EmailJob = z.infer<typeof emailJobSchema>;
