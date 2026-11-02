import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { makeTestDb, seedBasic } from "./helpers";
import { all, get, run } from "@/lib/db";
import { createBooking, SlotUnavailableError } from "@/lib/bookings";
import { createService } from "@/lib/services";

const child = path.resolve(import.meta.dirname, "fixtures/book-child.ts");
const root = path.resolve(import.meta.dirname, "..");

type Result = { ok: boolean; id?: string; error?: string; reason?: string; message?: string };

/** Spawn N real OS processes that all fire at the same instant. */
async function race(args: { mode: "app" | "raw"; file: string; serviceId: string; customerId: string; startAt: number; durationMin?: number }[], leadMs = 6000) {
  const go = Date.now() + leadMs;
  const runs = args.map(
    (a, i) =>
      new Promise<Result>((resolve, reject) => {
        const p = spawn(
          process.execPath,
          ["--import", "tsx", child, a.mode, a.file, a.serviceId, a.customerId, String(a.startAt), String(i), String(go), String(a.durationMin ?? 30)],
          { cwd: root, env: { ...process.env, APP_SECRET: "x".repeat(40), ADMIN_PASSWORD: "password123", NODE_NO_WARNINGS: "1" } },
        );
        let out = "";
        let err = "";
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", (d) => (err += d));
        p.on("close", () => {
          const line = out.trim().split("\n").filter(Boolean).at(-1);
          try {
            resolve(JSON.parse(line!));
          } catch {
            reject(new Error(`child failed: ${err || out}`));
          }
        });
      }),
  );
  return Promise.all(runs);
}

const t = makeTestDb("concurrency");
let serviceId = "";
let customerId = "";
const START = Date.parse("2030-06-03T10:00:00Z"); // a Monday

beforeAll(() => {
  const svc = seedBasic(t.db, { settings: { maxAdvanceDays: 3650 } });
  serviceId = svc.id;
  run(t.db, "INSERT INTO customers (id, name, email, created_at) VALUES ('c0','Raw','raw@example.com',1)");
  customerId = "c0";
});
afterAll(() => t.cleanup());

const bookings = () => all(t.db, "SELECT id, start_at FROM bookings WHERE status != 'cancelled'");

describe("no double booking under concurrency", () => {
  it("in-process: many attempts at one slot -> exactly one wins", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        Promise.resolve().then(() =>
          createBooking({ serviceId, startAt: START, name: `P${i}`, email: `p${i}@example.com`, timezone: "UTC" }, { db: t.db, paymentsEnabled: false }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected")) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(SlotUnavailableError);
    expect(bookings()).toHaveLength(1);
    run(t.db, "DELETE FROM bookings"); // slot_locks cascade
  });

  it("24 separate processes (own DB connections) fire at the same slot at the same instant -> exactly one wins", async () => {
    const results = await race(Array.from({ length: 24 }, () => ({ mode: "app" as const, file: t.file, serviceId, customerId, startAt: START })));
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(23);
    expect(losers.every((l) => l.error === "SlotUnavailableError")).toBe(true);
    expect(bookings()).toHaveLength(1);
    expect(get<{ n: number }>(t.db, "SELECT COUNT(*) AS n FROM slot_locks")!.n).toBe(6);
    run(t.db, "DELETE FROM bookings");
  }, 120_000);

  it("overlapping-but-different slots race: a 60-min visit at 10:00 vs 10:30 -> exactly one wins", async () => {
    const hour = createService({ name: "Hour", slug: "hour", durationMin: 60, priceMinor: 0 }, t.db);
    const args = Array.from({ length: 16 }, (_, i) => ({
      mode: "app" as const, file: t.file, serviceId: hour.id, customerId, startAt: i % 2 === 0 ? START : START + 30 * 60_000,
    }));
    const results = await race(args);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(bookings()).toHaveLength(1);
    run(t.db, "DELETE FROM bookings");
  }, 120_000);

  it("many different slots at once all succeed (no false conflicts)", async () => {
    const nine = Date.parse("2030-06-03T09:00:00Z"); // 12 consecutive half-hour slots from 09:00
    const results = await race(
      Array.from({ length: 12 }, (_, i) => ({ mode: "app" as const, file: t.file, serviceId, customerId, startAt: nine + i * 30 * 60_000 })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(12);
    expect(bookings()).toHaveLength(12);
    run(t.db, "DELETE FROM bookings");
  }, 120_000);

  it("the PRIMARY KEY alone stops double booking: raw inserts that skip every application check and use plain BEGIN", async () => {
    const results = await race(Array.from({ length: 16 }, () => ({ mode: "raw" as const, file: t.file, serviceId, customerId, startAt: START })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const failures = results.filter((r) => !r.ok);
    expect(failures).toHaveLength(15);
    expect(failures.every((f) => /UNIQUE constraint failed: slot_locks/i.test(f.message ?? ""))).toBe(true);
    expect(get<{ n: number }>(t.db, "SELECT COUNT(*) AS n FROM slot_locks")!.n).toBe(6);
  }, 120_000);
});
