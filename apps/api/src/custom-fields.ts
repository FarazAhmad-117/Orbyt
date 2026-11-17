import { BadRequestException } from "@nestjs/common";
import { customFieldDefs, inArray, type Tx } from "@orbyt/db";

export type FieldValues = Record<string, string | number | boolean | null>;

/** Every key must be a defined custom field and the value must match its type. */
export async function validateCustomFields(tx: Tx, values: FieldValues) {
  const keys = Object.keys(values);
  if (keys.length === 0) return;
  const defs = await tx
    .select()
    .from(customFieldDefs)
    .where(inArray(customFieldDefs.key, keys));
  const byKey = new Map(defs.map((d) => [d.key, d]));
  for (const [key, value] of Object.entries(values)) {
    const def = byKey.get(key);
    if (!def) throw new BadRequestException(`Unknown custom field "${key}"`);
    if (value === null) continue;
    const ok =
      def.type === "text"
        ? typeof value === "string"
        : def.type === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : def.type === "boolean"
            ? typeof value === "boolean"
            : def.type === "date"
              ? typeof value === "string" && !Number.isNaN(Date.parse(value))
              : typeof value === "string" &&
                (def.options ?? []).includes(value);
    if (!ok)
      throw new BadRequestException(
        `Invalid value for custom field "${key}" (expected ${def.type})`,
      );
  }
}

/** Patch semantics: a null value removes the key. */
export function mergeCustomFields(
  existing: Record<string, unknown>,
  patch: FieldValues,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}
