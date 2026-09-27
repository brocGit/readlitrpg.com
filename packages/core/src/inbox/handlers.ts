// Every inbox type whose decision acts (DESIGN §8.2), for the console's buttons and the
// heartbeat's default actions. Kept apart from inbox/index.ts, which the modules below import.

import { AUTHOR_INBOX_HANDLERS } from "../authors/inbox";
import { CONTENT_INBOX_HANDLERS } from "../content/inbox";
import type { InboxHandler } from "./index";

export const INBOX_HANDLERS: Record<string, InboxHandler> = {
  ...AUTHOR_INBOX_HANDLERS,
  ...CONTENT_INBOX_HANDLERS,
};
