import { beforeEach, describe, expect, it } from "vitest";
import { verifyAuditLog } from "../src/audit";
import { createDb, type Db } from "../src/db";
import { settings as settingsTable } from "../src/db/schema";
import {
  defaultSettings,
  loadSettings,
  mergeSettings,
  resetSetting,
  SETTINGS_CACHE_KEY,
  SettingValidationError,
  updateSetting,
} from "../src/settings";
import { createTestD1, TestKV } from "../src/testing";

let db: Db;
let kv: TestKV;
const actor = { type: "admin" as const, id: "owner" };

beforeEach(() => {
  db = createDb(createTestD1().asD1());
  kv = new TestKV();
});

describe("settings", () => {
  it("defaults match Appendix C", () => {
    const s = defaultSettings();
    expect(s["editorial.stale_hours"]).toBe(36);
    expect(s["match.weights"]).toEqual({ dial: 0.35, stat: 0.2, tag: 0.2, semantic: 0.15, quality: 0.1 });
    expect(s["flags.ads_paid"]).toBe(false);
    expect(s["flags.read_only_mode"]).toBe(false);
  });

  it("every default passes its own schema", async () => {
    const { SETTINGS } = await import("../src/settings/registry");
    for (const [key, def] of Object.entries(SETTINGS)) {
      expect(def.schema.safeParse(def.default).success, key).toBe(true);
    }
  });

  it("loads overrides from D1 once, then from KV", async () => {
    await db.insert(settingsTable).values({ key: "editorial.stale_hours", value: 48, updatedBy: "owner" });
    const first = await loadSettings({ db, kv: kv.asKV() });
    expect(first["editorial.stale_hours"]).toBe(48);
    expect(kv.store.has(SETTINGS_CACHE_KEY)).toBe(true);
    // Change D1 behind the cache's back: the cached value wins until the cache is dropped.
    await db.delete(settingsTable);
    const second = await loadSettings({ db, kv: kv.asKV() });
    expect(second["editorial.stale_hours"]).toBe(48);
  });

  it("invalid or unknown overrides fall back to defaults", () => {
    const merged = mergeSettings({ "editorial.stale_hours": -5, "no.such.key": 1, "flags.signups": false });
    expect(merged["editorial.stale_hours"]).toBe(36);
    expect(merged["flags.signups"]).toBe(false);
  });

  it("updates validate, audit and drop the cache", async () => {
    await loadSettings({ db, kv: kv.asKV() });
    await updateSetting({ db, kv: kv.asKV(), actor }, "flags.signups", false);
    expect(kv.store.has(SETTINGS_CACHE_KEY)).toBe(false);
    expect((await loadSettings({ db, kv: kv.asKV() }))["flags.signups"]).toBe(false);
    await expect(updateSetting({ db, kv: kv.asKV(), actor }, "flags.signups", "nope")).rejects.toBeInstanceOf(
      SettingValidationError,
    );
    await expect(
      updateSetting({ db, kv: kv.asKV(), actor }, "match.weights", {
        dial: 0.5,
        stat: 0.5,
        tag: 0.5,
        semantic: 0,
        quality: 0,
      }),
    ).rejects.toThrow(/sum to 1/);
    await resetSetting({ db, kv: kv.asKV(), actor }, "flags.signups");
    expect((await loadSettings({ db, kv: kv.asKV() }))["flags.signups"]).toBe(true);
    expect(await verifyAuditLog(db)).toMatchObject({ ok: true, checked: 2 });
  });
});
