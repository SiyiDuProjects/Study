import { z } from "zod";
import type { LectureReadWarning } from "../../core/src/lecture/types";

const MAX_PAGE_BYTES = 800_000;
const cursorSchema = z.object({
  version: z.literal(1),
  scope: z.string().max(2048),
  key: z.array(z.union([z.string().max(500), z.number().finite()])).max(6),
}).strict();

export class InvalidLectureCursor extends Error {
  constructor() { super("The lecture cursor is invalid for this query. Restart the read without a cursor."); }
}

export class InvalidLectureRecord extends Error {
  constructor() { super("The saved lecture metadata is invalid. Other recordings can still be read."); }
}

export function readCursor(cursor: string | undefined, scope: string): Array<string | number> | null {
  if (!cursor) return null;
  try {
    if (cursor.length > 4096) throw new InvalidLectureCursor();
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(cursor), (char) => char.charCodeAt(0)));
    const parsed = cursorSchema.parse(JSON.parse(decoded));
    if (parsed.scope !== scope) throw new InvalidLectureCursor();
    return parsed.key;
  } catch { throw new InvalidLectureCursor(); }
}

function writeCursor(scope: string, key: Array<string | number>): string {
  // Cursor payload contains only stable sort keys and query scope, never credentials or text.
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, scope, key }));
  return btoa(String.fromCharCode(...bytes));
}

export function validatedPage<Row, Item>(options: {
  rows: Row[];
  limit: number;
  scope: string;
  key: (row: Row, skipped: number) => Array<string | number>;
  id: (row: Row) => string;
  map: (row: Row) => unknown;
  schema: z.ZodType<Item>;
}): { items: Item[]; nextCursor: string | null; warnings: LectureReadWarning[] } {
  const items: Item[] = [];
  const warnings: LectureReadWarning[] = [];
  let consumed = 0;
  let bytes = 0;
  for (const row of options.rows.slice(0, options.limit)) {
    const parsed = options.schema.safeParse(options.map(row));
    if (!parsed.success) {
      warnings.push({
        code: "invalid_record",
        recordId: String(options.id(row)).slice(0, 160),
        message: "A saved record was skipped because its fields are invalid. The rest of this page remains usable.",
      });
      consumed += 1;
      continue;
    }
    const size = new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength;
    if (bytes + size > MAX_PAGE_BYTES && consumed > 0) break;
    items.push(parsed.data);
    bytes += size;
    consumed += 1;
  }
  const last = options.rows[consumed - 1];
  return {
    items,
    warnings,
    nextCursor: options.rows.length > consumed && last
      ? writeCursor(options.scope, options.key(last, warnings.length))
      : null,
  };
}
