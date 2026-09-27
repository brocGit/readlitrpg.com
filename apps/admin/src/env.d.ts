/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    requestId: string;
    access: import("@rlr/core/security").AccessIdentity;
    admin: () => Promise<import("./lib/admin-session").AdminSession | null>;
    settings: () => Promise<import("@rlr/core/settings").Settings>;
    /** Set on editorial API requests that passed both locks. */
    editorial: { tokenSlot: number } | null;
  }
}
