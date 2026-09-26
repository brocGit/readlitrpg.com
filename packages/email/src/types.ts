// Email is sent only by the jobs Worker (DESIGN §4.2). Other Workers enqueue a message on Q_EMAIL.

import { z } from "zod";

export type EmailStream = "transactional" | "marketing";

export interface EmailMessage {
  to: string;
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

/** Messages on Q_EMAIL. Validated when consumed; unknown kinds go to the DLQ. */
export const emailJobSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("magic_link"),
    to: z.email().max(320),
    url: z.url().max(2048),
    /** ISO time the link was requested; stale messages are dropped rather than sent late. */
    requestedAt: z.iso.datetime(),
  }),
]);

export type EmailJob = z.infer<typeof emailJobSchema>;
