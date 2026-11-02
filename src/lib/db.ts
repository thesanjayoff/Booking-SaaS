import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { MIGRATIONS } from "./migrations";

export type Db = DatabaseSync;
export type Row = Record<string, any>;

const g = globalThis as unknown as { __bookingDb?: Map<string, Db> };

function resolveTarget(file?: string) {
  const target = file ?? process.env.DATABASE_PATH ?? "./data/app.db";
  const key = target === ":memory:" ? target : path.resolve(target);
  return { target, key };
}

function open(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 15000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  migrate(db);
  return db;
}

export function migrate(db: Db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  for (const [i, sql] of MIGRATIONS.entries()) {
    const version = i + 1;
    // IMMEDIATE so two processes starting together cannot both apply a migration
    db.exec("BEGIN IMMEDIATE");
    try {
      const done = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version);
      if (!done) {
        db.exec(sql);
        db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, Date.now());
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

/** One connection per file per process (tests use distinct files). */
export function getDb(file?: string): Db {
  const { target, key } = resolveTarget(file);
  g.__bookingDb ??= new Map();
  let db = g.__bookingDb.get(key);
  if (!db) {
    db = open(target);
    g.__bookingDb.set(key, db);
  }
  return db;
}

export function closeDb(file?: string) {
  const { key } = resolveTarget(file);
  const db = g.__bookingDb?.get(key);
  if (db) {
    db.close();
    g.__bookingDb!.delete(key);
  }
}

/**
 * Runs `fn` inside BEGIN IMMEDIATE: takes SQLite's write lock up-front so concurrent
 * writers (other requests, other processes) queue on busy_timeout instead of racing.
 */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw e;
  }
}

export function all<T = Row>(db: Db, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}
export function get<T = Row>(db: Db, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}
export function run(db: Db, sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).run(...params);
}

export function isUniqueViolation(e: unknown): boolean {
  const err = e as { errcode?: number; message?: string };
  return (
    err?.errcode === 1555 || // SQLITE_CONSTRAINT_PRIMARYKEY
    err?.errcode === 2067 || // SQLITE_CONSTRAINT_UNIQUE
    /UNIQUE constraint failed/i.test(err?.message ?? "")
  );
}
