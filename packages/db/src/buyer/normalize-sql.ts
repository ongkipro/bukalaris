import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { phoneLookupKey } from "./normalize.ts";

// Drizzle fragments for comparing a stored phone snapshot with a typed one (COD risk lookup, privacy export and redaction). The database side is
// the SQL port `buyer_phone_key` of normalize.ts (migration 0013): the stored text is only read, never rewritten.

/** `buyer_phone_key(column) = key`; never true without a key, and never for a redacted snapshot (`[dihapus]` has no digits, so its key is NULL). */
export const phoneKeyEquals = (column: SQLWrapper, key: string | null): SQL => (key === null ? sql`false` : sql`public.buyer_phone_key(${column}) = ${key}`);

/** Same for typed text: the key of `typed` through the shared module. */
export const phoneMatches = (column: SQLWrapper, typed: unknown): SQL => phoneKeyEquals(column, phoneLookupKey(typed));
