// Helpers for the console's plain HTML forms (post, then redirect with a flash message).

import { type AuditEntry, appendAudit } from "@rlr/core/audit";
import type { AdminSession } from "./admin-session";
import { getDb } from "./runtime";

export async function readForm(request: Request): Promise<Record<string, string>> {
  const form = await request.formData();
  const out: Record<string, string> = {};
  for (const [key, value] of form) if (typeof value === "string") out[key] = value.slice(0, 20_000);
  return out;
}

export function flash(path: string, message: string, kind: "ok" | "error" = "ok"): string {
  const url = new URL(path, "https://admin.invalid");
  url.searchParams.set(kind === "ok" ? "done" : "error", message.slice(0, 200));
  return `${url.pathname}${url.search}`;
}

export function audit(
  admin: AdminSession,
  requestId: string,
  entry: Omit<AuditEntry, "actor" | "requestId">,
): ReturnType<typeof appendAudit> {
  return appendAudit(getDb(), { ...entry, actor: { type: "admin", id: admin.userId }, requestId });
}
