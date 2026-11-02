/**
 * RFC 4180 CSV with spreadsheet-formula-injection protection: a customer can type
 * `=HYPERLINK(...)` into the notes box, and Excel/Sheets would execute it when the owner opens
 * the export. Cells that start with = + - @ (or tab / CR) are prefixed with an apostrophe.
 */
const DANGEROUS = /^[=+\-@\t\r]/;

export function csvCell(v: unknown): string {
  if (v == null) return "";
  let s = typeof v === "string" ? v : String(v);
  if (DANGEROUS.test(s) && !(typeof v === "number")) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
