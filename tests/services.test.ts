import { afterAll, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers";
import {
  createService, updateService, listServices, getServiceBySlug, deleteOrArchiveService, SlugTakenError,
} from "@/lib/services";
import { getSettings, saveSettings } from "@/lib/settings";

const t = makeTestDb("services");
afterAll(() => t.cleanup());

describe("services", () => {
  it("creates a service with duration, price, buffers and deposit", () => {
    const s = createService(
      { name: "Dental Checkup", slug: "dental", durationMin: 45, priceMinor: 120000, bufferAfterMin: 15, depositMinor: 30000 },
      t.db,
    );
    expect(s).toMatchObject({ durationMin: 45, priceMinor: 120000, bufferAfterMin: 15, bufferBeforeMin: 0, depositMinor: 30000, active: true });
    expect(getServiceBySlug("dental", t.db)?.id).toBe(s.id);
  });

  it("rejects invalid input (non-multiple-of-5 duration, deposit above price, bad slug)", () => {
    expect(() => createService({ name: "x", slug: "x", durationMin: 22, priceMinor: 0 }, t.db)).toThrow();
    expect(() => createService({ name: "x", slug: "x2", durationMin: 30, priceMinor: 100, depositMinor: 200 }, t.db)).toThrow(/Deposit/);
    expect(() => createService({ name: "x", slug: "Bad Slug!", durationMin: 30, priceMinor: 0 }, t.db)).toThrow();
  });

  it("enforces unique slugs", () => {
    createService({ name: "A", slug: "dup", durationMin: 30, priceMinor: 0 }, t.db);
    expect(() => createService({ name: "B", slug: "dup", durationMin: 30, priceMinor: 0 }, t.db)).toThrow(SlugTakenError);
  });

  it("updates and lists active services only on request", () => {
    const s = createService({ name: "Old", slug: "old", durationMin: 30, priceMinor: 0 }, t.db);
    updateService(s.id, { name: "New", slug: "old", durationMin: 60, priceMinor: 0, active: false }, t.db);
    expect(listServices({}, t.db).find((x) => x.id === s.id)?.name).toBe("New");
    expect(listServices({ activeOnly: true }, t.db).find((x) => x.id === s.id)).toBeUndefined();
  });

  it("hard-deletes unused services", () => {
    const s = createService({ name: "Tmp", slug: "tmp", durationMin: 30, priceMinor: 0 }, t.db);
    expect(deleteOrArchiveService(s.id, t.db)).toBe("deleted");
    expect(getServiceBySlug("tmp", t.db)).toBeNull();
  });
});

describe("settings", () => {
  it("returns defaults, persists patches and validates the time zone", () => {
    expect(getSettings(t.db).slotIntervalMin).toBe(30);
    saveSettings({ timezone: "America/New_York", minNoticeMin: 90 }, t.db);
    expect(getSettings(t.db)).toMatchObject({ timezone: "America/New_York", minNoticeMin: 90 });
    expect(() => saveSettings({ timezone: "Mars/Olympus" }, t.db)).toThrow();
  });
});
