import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { normalizeEmail, normalizePhone, phoneLookupKey, samePhoneIdentity } from "../src/buyer/normalize.ts";
import { checkoutInput } from "../src/seller/commerce/checkout.ts";
import { phoneDigits62, phoneE164 } from "../src/storefront/signals.ts";
import { normalizeBuyerKey } from "../src/seller/commerce/privacy.ts";
import { admin } from "./helpers.ts";

// T-57 slice 1: one shared normalization (ADR-0010 section 2). Table-driven. The SQL port the database uses for the same decisions is run
// over the same tables, so a drift between the TypeScript module and the migration fails here.

const CANON = "6281234567890";

/** Every spelling of one Indonesian mobile number that a buyer, a seller or an import can produce. */
const SAME_NUMBER = [
  "081234567890",
  "6281234567890",
  "+6281234567890",
  "+62 812 3456 7890",
  "+62-812-3456-7890",
  "+62 (812) 3456-7890",
  "0812-3456-7890",
  "0812 3456 7890",
  "0812.3456.7890",
  "(0812) 3456 7890",
  "  081234567890  ",
  "\t0812 3456 7890\t",
  "0062 812 3456 7890",
  "006281234567890",
  "62081234567890", // a stray 0 after the country code
  "+62 0812 3456 7890",
];

/** Not an Indonesian mobile identity. `key` is the comparison key (null when the text is not a phone at all). */
const NOT_IDENTITY: { raw: unknown; key: string | null; why: string }[] = [
  { raw: "", key: null, why: "empty" },
  { raw: "   ", key: null, why: "blank" },
  { raw: "12345", key: null, why: "too short" },
  { raw: "0812", key: null, why: "too short after the trunk prefix" },
  { raw: "abc", key: null, why: "letters" },
  { raw: "0812abc3456", key: null, why: "letters inside" },
  { raw: "081234567890x", key: null, why: "trailing letter" },
  { raw: "081234567890 ext 12", key: null, why: "extension" },
  { raw: "+", key: null, why: "only a plus" },
  { raw: "++6281234567890", key: null, why: "double plus" },
  { raw: "6281234567890+", key: null, why: "plus at the end" },
  { raw: "+62+81234567890", key: null, why: "plus inside" },
  { raw: "0812/3456/7890", key: null, why: "slash is not an approved separator" },
  { raw: "0812,3456,7890", key: null, why: "comma is not an approved separator" },
  { raw: "0812\n3456", key: null, why: "newline" },
  { raw: "０８１２３４５６７８９０", key: null, why: "full-width digits" },
  { raw: "٠٨١٢٣٤٥٦٧٨٩٠", key: null, why: "Arabic-Indic digits" },
  { raw: "0812\u00a03456\u00a07890", key: null, why: "no-break space" },
  { raw: "08123456789012345678", key: null, why: "more than 15 digits" },
  { raw: `0812${"3".repeat(40)}`, key: null, why: "over-length text" },
  { raw: "+0812 3456 7890", key: null, why: "plus followed by the trunk zero" },
  { raw: "0000000000", key: null, why: "zeros" },
  { raw: "+1 415 555 2671", key: "14155552671", why: "foreign number keeps its key and is not an Indonesian identity" },
  { raw: "0044 20 7946 0958", key: "442079460958", why: "00 prefix of another country" },
  { raw: "021 5551 2345", key: "622155512345", why: "Jakarta landline has a key (lookups) but no mobile identity" },
  { raw: "81234567890", key: "81234567890", why: "bare digits without a prefix: no country is guessed" },
  { raw: "62812", key: null, why: "mobile prefix with too few digits" },
  { raw: null, key: null, why: "not text" },
  { raw: undefined, key: null, why: "not text" },
  { raw: 6281234567890, key: null, why: "a number, not text" },
  { raw: ["081234567890"], key: null, why: "an array" },
];

describe("phone normalization (T-57 slice 1)", () => {
  it.each(SAME_NUMBER)("%j is the one canonical Indonesian mobile number", (raw) => {
    expect(normalizePhone(raw)).toBe(CANON);
    expect(phoneLookupKey(raw)).toBe(CANON);
  });

  it("08…, 628… and +628… give exactly one canonical value, and no two different numbers collapse", () => {
    expect(new Set(SAME_NUMBER.map((r) => normalizePhone(r)))).toEqual(new Set([CANON]));
    const distinct = ["081234567890", "081234567891", "081234567809", "0812345678901", "08123456789", "089234567890"].map((r) => normalizePhone(r));
    expect(new Set(distinct).size).toBe(distinct.length);
    expect(normalizePhone("0811234567")).toBe("62811234567"); // 10-digit national number keeps its own value
    expect(normalizePhone("081234567890123")).toBeNull(); // 15 national digits + 62 = 17 > E.164 maximum
  });

  it.each(NOT_IDENTITY.map((c) => [c.why, c] as const))("%s", (_why, c) => {
    expect(normalizePhone(c.raw)).toBeNull();
    expect(phoneLookupKey(c.raw)).toBe(c.key);
  });

  it("the boundaries of the canonical form: 62 + 8 + 7..12 digits, never more than 15 digits in total", () => {
    expect(normalizePhone(`08${"1".repeat(7)}`)).toBe(`628${"1".repeat(7)}`); // shortest
    expect(normalizePhone(`08${"1".repeat(6)}`)).toBeNull();
    expect(normalizePhone(`08${"1".repeat(12)}`)).toBe(`628${"1".repeat(12)}`); // longest (15 digits)
    expect(normalizePhone(`08${"1".repeat(13)}`)).toBeNull();
  });

  it("a number is the same identity as itself and as a different spelling; never as an unusable text (affiliate self-referral input)", () => {
    expect(samePhoneIdentity("0812-3456-7890", "+62 812 3456 7890")).toBe(true);
    expect(samePhoneIdentity("081234567890", "081234567891")).toBe(false);
    expect(samePhoneIdentity("abc", "abc")).toBe(false);
    expect(samePhoneIdentity("", "")).toBe(false);
    expect(samePhoneIdentity("021 5551 2345", "021 5551 2345")).toBe(false); // a landline is no identity
    expect(samePhoneIdentity(null, undefined)).toBe(false);
  });

  it("every phone the checkout accepts is classified without throwing: an identity, a lookup-only key or nothing (no second person invented)", () => {
    const accepted = ["081234567890", "+6281234567890", "6281234567890", "0215551234", "+14155552671", "12345678", "+0812345678", "000000000000000"];
    for (const raw of accepted) {
      const parsed = checkoutInput.shape.buyerPhone.safeParse(raw);
      expect(parsed.success, raw).toBe(true);
      expect(() => normalizePhone(raw)).not.toThrow();
      const identity = normalizePhone(raw);
      if (identity) expect(phoneLookupKey(raw)).toBe(identity);
    }
  });
});

describe("e-mail normalization (T-57 slice 1)", () => {
  it("trims and lower-cases, nothing else: dots, +tags and provider aliases stay as typed", () => {
    expect(normalizeEmail("  Budi@Example.COM ")).toBe("budi@example.com");
    expect(normalizeEmail("Budi.Santoso+Toko@Gmail.com")).toBe("budi.santoso+toko@gmail.com");
    expect(normalizeEmail("budisantoso@gmail.com")).not.toBe(normalizeEmail("budi.santoso@gmail.com")); // no dot folding
    expect(normalizeEmail("budi+a@gmail.com")).not.toBe(normalizeEmail("budi@gmail.com")); // no tag stripping
    expect(normalizeEmail("budi@googlemail.com")).not.toBe(normalizeEmail("budi@gmail.com")); // no provider alias
    expect(normalizeEmail("\tbudi@example.com\n")).toBe("budi@example.com");
  });

  const INVALID = [
    "", "   ", "bukan email", "budi@", "@example.com", "a@b", "a b@example.com", "budi@@example.com", "a..b@example.com", ".budi@example.com",
    "budi@-example.com", "budi@example..com", "budi@example.c", "budi@exam ple.com", "mailto:budi@example.com",
    "büdi@example.com", "budi@exämple.com", "bu\u212Adi@example.com" /* Kelvin sign must not fold into an ASCII k */, "budi@example.com\u0000",
    `${"a".repeat(250)}@example.com`, `budi@${"a".repeat(250)}.com`,
  ];
  it.each(INVALID.map((v) => [JSON.stringify(v).slice(0, 48), v] as const))("%s is rejected", (_label, raw) => {
    expect(normalizeEmail(raw)).toBeNull();
  });

  it("rejects non-text and the maximum length plus one", () => {
    for (const raw of [null, undefined, 42, {}, ["a@b.co"]]) expect(normalizeEmail(raw)).toBeNull();
    const longest = `${"a".repeat(64)}@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(63)}.com`; // 254 characters
    expect(longest.length).toBe(254);
    expect(normalizeEmail(longest)).toBe(longest);
    expect(normalizeEmail(`a${longest}`)).toBeNull();
  });

  it("agrees with the checkout contract on every input: the same accepted set and the same value (trim, lower case, validator, 254)", () => {
    const corpus = ["  Budi@Example.COM ", "budi@example.com", "a..b@example.com", "a@b", "bukan email", "budi.santoso+toko@gmail.com", "x@y.co", "A_B-c@d-e.fgh", "'o@example.org", ...INVALID.filter((v) => /^[\x00-\x7f]*$/.test(v) && !v.includes("\u0000"))];
    for (const raw of corpus) {
      const checkout = checkoutInput.shape.buyerEmail.safeParse(raw);
      const shared = normalizeEmail(raw);
      if (raw.trim() === "") continue; // checkout treats an empty field as "not given"
      expect(shared !== null, raw).toBe(checkout.success);
      if (checkout.success) expect(shared, raw).toBe(checkout.data);
    }
  });
});

describe("callers migrated deliberately (no silent change of what existing paths computed)", () => {
  /** The pre-T-57 helpers, kept here as the oracle of what the lookups used to compute for stored (checkout-validated) snapshots. */
  const oldRiskKey = (p: string) => p.trim().replace(/^\+/, "").replace(/^62/, "0");
  const oldSignalDigits = (raw: string) => {
    let d = raw.replace(/[^0-9]/g, "");
    if (d.startsWith("0")) d = `62${d.slice(1)}`;
    else if (d.startsWith("620")) d = `62${d.slice(3)}`;
    return /^[1-9][0-9]{7,14}$/.test(d) ? d : null;
  };
  const stored = ["081234567890", "+6281234567890", "6281234567890", "62081234567890", "0211234567", "+622112345678", "+14155552671", "81234567890", "0811234567", "089999999999"];

  it("the Meta/TikTok phone hash input is unchanged for every stored shape that was usable before", () => {
    for (const raw of stored) {
      const before = oldSignalDigits(raw);
      if (before) expect(phoneDigits62(raw), raw).toBe(before);
    }
    expect(phoneE164("0812 3456 7890")).toBe("+6281234567890");
  });

  it("the repeat-buyer risk key groups exactly the numbers it grouped before, for Indonesian numbers in the stored shapes", () => {
    const indonesian = stored.filter((r) => /^(\+?62|0)/.test(r));
    for (const a of indonesian) {
      for (const b of indonesian) {
        const before = oldRiskKey(a) === oldRiskKey(b);
        const now = phoneLookupKey(a) === phoneLookupKey(b);
        if (before) expect(now, `${a} ~ ${b}`).toBe(true); // nothing that matched before stops matching
      }
    }
    expect(phoneLookupKey("0062 812 3456 7890")).toBe(phoneLookupKey("081234567890")); // the new 00 spelling joins the group
  });

  it("the privacy lookup key is the shared key, so every spelling reaches the same orders", () => {
    for (const raw of SAME_NUMBER) expect(normalizeBuyerKey(raw), raw).toEqual({ kind: "phone", value: CANON });
    expect(normalizeBuyerKey("021 5551 2345")).toEqual({ kind: "phone", value: "622155512345" }); // landline and foreign numbers stay findable for a data-subject request
    expect(normalizeBuyerKey("+1 415 555 2671")).toEqual({ kind: "phone", value: "14155552671" });
  });
});

describe("the SQL port agrees with the TypeScript module on every case above (migration 0013)", () => {
  const phones: unknown[] = [...SAME_NUMBER, ...NOT_IDENTITY.map((c) => c.raw), "0812345678", "08123456789012", "+6285 6", "  ", "0 8 1 2 3 4 5 6 7 8 9 0", "0062812345678901", "+62 8123", "-0812-3456-7890-", "(0812)(3456)(7890)", "0812.3456.7890.", "[dihapus]", "08\u2003123456789"];
  const emails: unknown[] = ["  Budi@Example.COM ", "budi.santoso+toko@gmail.com", "BUDI@EXAMPLE.CO.ID", "a..b@example.com", "a@b", "bukan email", "x@y.co", "'o@example.org", "bu\u212Adi@example.com", "büdi@example.com", "a@-b.com", `${"a".repeat(250)}@example.com`, "\tbudi@example.com\n", "[dihapus]", "", "  "];
  const texts = (values: unknown[]) => values.filter((v): v is string => typeof v === "string");

  it("buyer_phone_key = phoneLookupKey and buyer_canonical_phone = normalizePhone, case by case", async () => {
    const mismatches: string[] = [];
    for (const raw of texts(phones)) {
      const [row] = (await admin.execute(sql`select public.buyer_phone_key(${raw}) as key, public.buyer_canonical_phone(${raw}) as canonical`)) as unknown as { key: string | null; canonical: string | null }[];
      if (row!.key !== phoneLookupKey(raw)) mismatches.push(`key ${JSON.stringify(raw)}: sql ${row!.key} ts ${phoneLookupKey(raw)}`);
      if (row!.canonical !== normalizePhone(raw)) mismatches.push(`canonical ${JSON.stringify(raw)}: sql ${row!.canonical} ts ${normalizePhone(raw)}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("buyer_canonical_email = normalizeEmail, case by case", async () => {
    const mismatches: string[] = [];
    for (const raw of texts(emails)) {
      const [row] = (await admin.execute(sql`select public.buyer_canonical_email(${raw}) as email`)) as unknown as { email: string | null }[];
      if (row!.email !== normalizeEmail(raw)) mismatches.push(`${JSON.stringify(raw)}: sql ${row!.email} ts ${normalizeEmail(raw)}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("a NULL snapshot has no key (STRICT) and the checks of the identifier table accept exactly what the module accepts", async () => {
    const [row] = (await admin.execute(sql`select public.buyer_phone_key(null::text) as p, public.buyer_canonical_email(null::text) as e`)) as unknown as { p: null; e: null }[];
    expect(row).toEqual({ p: null, e: null });
    for (const raw of texts(emails)) {
      const canonical = normalizeEmail(raw);
      if (!canonical) continue;
      const [ok] = (await admin.execute(sql`select (${canonical} ~ '^(?:[A-Za-z0-9_''+-]+\.)*[A-Za-z0-9_''+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$') as ok`)) as unknown as { ok: boolean }[];
      expect(ok!.ok, canonical).toBe(true);
    }
  });
});
