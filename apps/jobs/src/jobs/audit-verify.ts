// Nightly audit chain check (DESIGN §15.11). A break is a security event: page the owner.

import { verifyAuditLog } from "@rlr/core/audit";
import { openInboxItem } from "@rlr/core/inbox";
import type { JobContext } from "./types";

export async function verifyAudit({ db, log }: JobContext): Promise<number> {
  const result = await verifyAuditLog(db);
  if (result.ok) return result.checked;
  log.error("audit.chain_broken", { seq: result.brokenAtSeq, problem: result.problem });
  await openInboxItem(db, {
    type: "security_alert",
    title: `Audit log chain broken at #${result.brokenAtSeq} (${result.problem})`,
    subjectType: "audit_log",
    subjectId: String(result.brokenAtSeq),
    priority: 100,
    payload: result,
    dedupeKey: `audit.chain_broken:${result.brokenAtSeq}`,
  });
  throw new Error(`audit chain broken at seq ${result.brokenAtSeq}: ${result.problem}`);
}
