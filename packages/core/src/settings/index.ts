// Settings access: code defaults, D1 overrides, and a 60-second KV read-through cache (DESIGN §4.5).
// KV is eventually consistent, so a change can take up to a minute to reach every location.

import { eq } from "drizzle-orm";
import { type AuditActor, appendAudit } from "../audit";
import type { Db } from "../db";
import { settings as settingsTable } from "../db/schema";
import type { Logger } from "../log";
import { nowIso } from "../time";
import {
  defaultSettings,
  isSettingKey,
  SETTINGS,
  type SettingKey,
  type Settings,
  type SettingValue,
} from "./registry";

export * from "./registry";

export const SETTINGS_CACHE_KEY = "settings:overrides:v1";
export const SETTINGS_CACHE_TTL_SECONDS = 60;

export interface SettingsDeps {
  db: Db;
  kv: KVNamespace;
  log?: Logger;
}

/** Load every setting. One KV read on the hot path; one D1 query on a cache miss. */
export async function loadSettings({ db, kv, log }: SettingsDeps): Promise<Settings> {
  let overrides: Record<string, unknown> | null = null;
  try {
    overrides = await kv.get<Record<string, unknown>>(SETTINGS_CACHE_KEY, {
      type: "json",
      cacheTtl: SETTINGS_CACHE_TTL_SECONDS,
    });
  } catch (error) {
    log?.warn("settings.kv_read_failed", { error });
  }
  if (!overrides) {
    overrides = await readOverrides(db);
    try {
      await kv.put(SETTINGS_CACHE_KEY, JSON.stringify(overrides), {
        expirationTtl: SETTINGS_CACHE_TTL_SECONDS,
      });
    } catch (error) {
      log?.warn("settings.kv_write_failed", { error });
    }
  }
  return mergeSettings(overrides, log);
}

export async function readOverrides(db: Db): Promise<Record<string, unknown>> {
  const rows = await db.select({ key: settingsTable.key, value: settingsTable.value }).from(settingsTable);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Apply overrides to the defaults. An override that no longer validates falls back to the default. */
export function mergeSettings(overrides: Record<string, unknown>, log?: Logger): Settings {
  const merged = defaultSettings() as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (!isSettingKey(key)) {
      log?.warn("settings.unknown_key", { key });
      continue;
    }
    const parsed = SETTINGS[key].schema.safeParse(value);
    if (parsed.success) merged[key] = parsed.data;
    else log?.error("settings.invalid_override", { key, issues: parsed.error.issues.length });
  }
  return merged as Settings;
}

export class SettingValidationError extends Error {
  constructor(
    readonly key: string,
    message: string,
  ) {
    super(message);
    this.name = "SettingValidationError";
  }
}

/** Change a setting: validate, write, audit, then drop the cache so the change spreads within a minute. */
export async function updateSetting<K extends SettingKey>(
  deps: SettingsDeps & { actor: AuditActor; requestId?: string; ipHash?: string },
  key: K,
  value: unknown,
): Promise<SettingValue<K>> {
  const def = SETTINGS[key];
  if (!def) throw new SettingValidationError(key, `unknown setting ${key}`);
  if ("readOnly" in def && def.readOnly) throw new SettingValidationError(key, `${key} is read-only`);
  const parsed = def.schema.safeParse(value);
  if (!parsed.success) {
    throw new SettingValidationError(key, parsed.error.issues.map((i) => i.message).join("; "));
  }
  const { db, kv, actor } = deps;
  const [before] = await db
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.key, key));
  const now = nowIso();
  await db
    .insert(settingsTable)
    .values({ key, value: parsed.data, updatedBy: actor.id ?? actor.type, updatedAt: now })
    .onConflictDoUpdate({
      target: settingsTable.key,
      set: { value: parsed.data, updatedBy: actor.id ?? actor.type, updatedAt: now },
    });
  await appendAudit(db, {
    actor,
    action: "settings.update",
    subjectType: "setting",
    subjectId: key,
    diff: { before: before?.value ?? { default: def.default }, after: parsed.data },
    requestId: deps.requestId,
    ipHash: deps.ipHash,
  });
  await kv.delete(SETTINGS_CACHE_KEY);
  return parsed.data as SettingValue<K>;
}

/** Remove an override so the key goes back to its default. */
export async function resetSetting(
  deps: SettingsDeps & { actor: AuditActor; requestId?: string; ipHash?: string },
  key: SettingKey,
): Promise<void> {
  const { db, kv, actor } = deps;
  const deleted = await db.delete(settingsTable).where(eq(settingsTable.key, key)).returning();
  if (deleted.length === 0) return;
  await appendAudit(db, {
    actor,
    action: "settings.reset",
    subjectType: "setting",
    subjectId: key,
    diff: { before: deleted[0]?.value, after: { default: SETTINGS[key].default } },
    requestId: deps.requestId,
    ipHash: deps.ipHash,
  });
  await kv.delete(SETTINGS_CACHE_KEY);
}
