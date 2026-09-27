// How each email list is described to readers (DESIGN §13.3).

import type { EmailList } from "@rlr/core/schema";

export const LIST_INFO: Record<EmailList, { name: string; blurb: string }> = {
  weekly_digest: {
    name: "Patch Notes (weekly)",
    blurb: "Fridays: new matches for your taste, what's out from what you follow, and what's coming soon.",
  },
  daily_digest: {
    name: "Patch Notes Daily",
    blurb:
      "Every morning: books out today, new announcements and date changes. Short, and only if you want it.",
  },
  release_alerts: {
    name: "Release-day alerts",
    blurb: "One email on days something you follow comes out. At most one a day.",
  },
  reading_list: {
    name: "Reading list and welcome emails",
    blurb: "Your quiz reading list and a few short emails that help sharpen your matches.",
  },
};
