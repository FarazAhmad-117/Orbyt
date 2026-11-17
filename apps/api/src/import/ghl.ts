import { BadRequestException } from "@nestjs/common";
import { parse as parseCsv } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

/**
 * GoHighLevel CSV exports -> Orbyt. GHL names its columns like "Contact Name", "Business Name",
 * "Lead Value"; headers are matched case- and punctuation-insensitively so small differences
 * between GHL versions and locales still work.
 */
export const MAX_ROWS = 10_000;

const norm = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function readGhlCsv(text: string): Record<string, string>[] {
  let rows: Record<string, string>[];
  try {
    rows = parseCsv(text, {
      columns: (header: string[]) => header.map(norm),
      skip_empty_lines: true,
      bom: true,
      trim: true,
      relax_column_count: true,
    }) as Record<string, string>[];
  } catch (err) {
    throw new BadRequestException(`Invalid CSV: ${(err as Error).message}`);
  }
  if (rows.length > MAX_ROWS)
    throw new BadRequestException(`At most ${MAX_ROWS} rows per import`);
  return rows;
}

/** First non-empty value among the given (normalised) column names. */
export const pick = (r: Record<string, string>, ...keys: string[]) =>
  keys.map((k) => r[k]?.trim()).find((v) => v) ?? "";

/** Orbyt's own contact-CSV row for a GHL contact (tags joined with ";", which importCsv expects). */
export function ghlContactToRow(r: Record<string, string>) {
  const name =
    pick(r, "contact name", "full name", "name") ||
    [pick(r, "first name"), pick(r, "last name")].filter(Boolean).join(" ");
  return {
    email: pick(r, "email", "email address"),
    name,
    phone: pick(r, "phone", "phone number", "mobile phone"),
    company: pick(r, "business name", "company name", "company"),
    tags: pick(r, "tags")
      .split(/[,;]/)
      .map((t) => t.trim())
      .filter(Boolean)
      .join(";"),
    source: "gohighlevel",
  };
}

export function ghlContactsToCsv(text: string): string {
  const rows = readGhlCsv(text).map(ghlContactToRow);
  if (rows.length === 0) throw new BadRequestException("The CSV has no rows");
  if (rows.every((r) => !r.email))
    throw new BadRequestException(
      "No email column found. Export contacts from GoHighLevel with the Email column included.",
    );
  return stringify(rows, {
    header: true,
    columns: ["email", "name", "phone", "company", "tags", "source"],
  });
}

/** "$1,234.50" -> 123450 (cents). Anything unreadable is 0. */
export function parseMoneyCents(s: string): number {
  const n = Number(s.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** GHL: open / won / lost / abandoned. */
export function ghlStatus(s: string): "open" | "won" | "lost" {
  const v = s.trim().toLowerCase();
  return v === "won"
    ? "won"
    : v === "lost" || v === "abandoned"
      ? "lost"
      : "open";
}
