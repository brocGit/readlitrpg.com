// Nightly D1 export (DESIGN §15.12): every table in BACKUP_TABLES as NDJSON parts, plus a manifest
// with row counts and checksums. Daily copies live under d1/daily/, and the 1st of each month is
// also written under d1/monthly/. Bucket lifecycle rules keep 35 daily and 12 monthly copies.

import { sha256Hex, utcDay } from "@rlr/core";
import { BACKUP_TABLES } from "@rlr/core/db/backup";
import type { JobContext } from "./types";

const PAGE_ROWS = 1000;
const PART_ROWS = 5000;

interface PartInfo {
  key: string;
  rows: number;
  sha256: string;
}

export async function exportBackup({ env, now }: JobContext): Promise<number> {
  const day = utcDay(now);
  const prefixes = [`d1/daily/${day}`];
  if (now.getUTCDate() === 1) prefixes.push(`d1/monthly/${day.slice(0, 7)}`);

  const manifest: { createdAt: string; tables: Record<string, { rows: number; parts: PartInfo[] }> } = {
    createdAt: now.toISOString(),
    tables: {},
  };
  let total = 0;

  for (const table of BACKUP_TABLES) {
    const parts: PartInfo[] = [];
    let buffer: string[] = [];
    let rows = 0;
    let lastRowId = 0;

    const flush = async () => {
      if (buffer.length === 0) return;
      const body = `${buffer.join("\n")}\n`;
      const hash = await sha256Hex(body);
      const name = `${table}/part-${String(parts.length + 1).padStart(4, "0")}.ndjson`;
      for (const prefix of prefixes) {
        await env.BACKUPS.put(`${prefix}/${name}`, body, {
          httpMetadata: { contentType: "application/x-ndjson" },
          sha256: hash,
        });
      }
      parts.push({ key: name, rows: buffer.length, sha256: hash });
      buffer = [];
    };

    for (;;) {
      // Keyset pagination on rowid: stable and cheap on every table (none are WITHOUT ROWID).
      const { results } = await env.DB.prepare(
        `SELECT rowid AS __rowid, * FROM "${table}" WHERE rowid > ?1 ORDER BY rowid LIMIT ${PAGE_ROWS}`,
      )
        .bind(lastRowId)
        .all<Record<string, unknown> & { __rowid: number }>();
      for (const { __rowid, ...row } of results) {
        buffer.push(JSON.stringify(row));
        lastRowId = __rowid;
        rows++;
        if (buffer.length >= PART_ROWS) await flush();
      }
      if (results.length < PAGE_ROWS) break;
    }
    await flush();
    manifest.tables[table] = { rows, parts };
    total += rows;
  }

  const manifestBody = JSON.stringify(manifest, null, 2);
  for (const prefix of prefixes) {
    await env.BACKUPS.put(`${prefix}/manifest.json`, manifestBody, {
      httpMetadata: { contentType: "application/json" },
    });
  }
  return total;
}
