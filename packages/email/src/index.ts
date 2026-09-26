import { renderMagicLink } from "./templates/magic-link";
import type { EmailJob, EmailMessage } from "./types";

export { ConsoleProvider } from "./providers/console";
export { SesError, SesProvider } from "./providers/ses";
export { escapeHtml } from "./templates/layout";
export { renderMagicLink } from "./templates/magic-link";
export * from "./types";

/** Magic links older than this when dequeued are dropped: the link would expire before use. */
export const MAGIC_LINK_MAX_QUEUE_AGE_SECONDS = 10 * 60;

/** Turn a queued job into a ready-to-send message, or null if it should be dropped. */
export function buildEmail(job: EmailJob, now = new Date()): EmailMessage | null {
  switch (job.kind) {
    case "magic_link": {
      const ageSeconds = (now.getTime() - Date.parse(job.requestedAt)) / 1000;
      if (ageSeconds > MAGIC_LINK_MAX_QUEUE_AGE_SECONDS) return null;
      return { to: job.to, stream: "transactional", ...renderMagicLink(job.url) };
    }
  }
}
