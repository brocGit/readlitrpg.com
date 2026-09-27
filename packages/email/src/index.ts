import { renderMagicLink } from "./templates/magic-link";
import { renderConfirm } from "./templates/reader";
import type { EmailJob, EmailMessage } from "./types";

export { ConsoleProvider } from "./providers/console";
export { SesError, SesProvider } from "./providers/ses";
export { escapeHtml } from "./templates/layout";
export { renderMagicLink } from "./templates/magic-link";
export * from "./templates/reader";
export * from "./types";

/** Magic links older than this when dequeued are dropped: the link would expire before use. */
export const MAGIC_LINK_MAX_QUEUE_AGE_SECONDS = 10 * 60;

/** Turn a queued job into a ready-to-send message, or null if it should be dropped. */
export function buildEmail(job: EmailJob, now = new Date()): EmailMessage | null {
  switch (job.kind) {
    case "magic_link": {
      const ageSeconds = (now.getTime() - Date.parse(job.requestedAt)) / 1000;
      if (ageSeconds > MAGIC_LINK_MAX_QUEUE_AGE_SECONDS) return null;
      return { to: job.to, stream: "transactional", template: "magic_link", ...renderMagicLink(job.url) };
    }
    case "confirm_subscription": {
      // A week-old confirmation is past its link's life; don't send it late.
      if (now.getTime() - Date.parse(job.requestedAt) > 7 * 86_400_000) return null;
      return {
        to: job.to,
        stream: "transactional",
        template: "confirm_subscription",
        userId: job.userId,
        ...renderConfirm({ url: job.url, className: job.className, listOnly: job.listOnly }),
      };
    }
    case "rendered":
      return {
        to: job.to,
        stream: job.stream,
        template: job.template,
        userId: job.userId,
        issueId: job.issueId,
        subject: job.subject,
        html: job.html,
        text: job.text,
        headers: job.headers,
      };
  }
}
