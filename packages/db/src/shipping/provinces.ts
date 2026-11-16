// T-105 (ADR-0013 section 4, OPEN-P4): the province codes a seller can block for COD, and the resolution of a provider area's province name.
// The codes are this product's own slugs, not an official numbering. The provider's spelling of a province name is UNVERIFIED (the
// documentation shows upper case, e.g. "PAPUA"); a name that does not match a known name or alias stays unresolved, and an unresolved
// province refuses COD (fail closed), never falls into a guess.

export const PROVINCES = [
  ["aceh", "Aceh", ["Nanggroe Aceh Darussalam", "NAD", "DI Aceh", "Daerah Istimewa Aceh"]],
  ["sumatera-utara", "Sumatera Utara", ["Sumatra Utara", "North Sumatra"]],
  ["sumatera-barat", "Sumatera Barat", ["Sumatra Barat", "West Sumatra"]],
  ["riau", "Riau", []],
  ["jambi", "Jambi", []],
  ["sumatera-selatan", "Sumatera Selatan", ["Sumatra Selatan", "South Sumatra"]],
  ["bengkulu", "Bengkulu", []],
  ["lampung", "Lampung", []],
  ["kepulauan-bangka-belitung", "Kepulauan Bangka Belitung", ["Bangka Belitung"]],
  ["kepulauan-riau", "Kepulauan Riau", []],
  ["dki-jakarta", "DKI Jakarta", ["Jakarta", "Daerah Khusus Ibukota Jakarta", "Daerah Khusus Jakarta"]],
  ["jawa-barat", "Jawa Barat", ["West Java"]],
  ["jawa-tengah", "Jawa Tengah", ["Central Java"]],
  ["di-yogyakarta", "DI Yogyakarta", ["Daerah Istimewa Yogyakarta", "Yogyakarta", "DIY"]],
  ["jawa-timur", "Jawa Timur", ["East Java"]],
  ["banten", "Banten", []],
  ["bali", "Bali", []],
  ["nusa-tenggara-barat", "Nusa Tenggara Barat", ["NTB"]],
  ["nusa-tenggara-timur", "Nusa Tenggara Timur", ["NTT"]],
  ["kalimantan-barat", "Kalimantan Barat", []],
  ["kalimantan-tengah", "Kalimantan Tengah", []],
  ["kalimantan-selatan", "Kalimantan Selatan", []],
  ["kalimantan-timur", "Kalimantan Timur", []],
  ["kalimantan-utara", "Kalimantan Utara", []],
  ["sulawesi-utara", "Sulawesi Utara", []],
  ["sulawesi-tengah", "Sulawesi Tengah", []],
  ["sulawesi-selatan", "Sulawesi Selatan", []],
  ["sulawesi-tenggara", "Sulawesi Tenggara", []],
  ["gorontalo", "Gorontalo", []],
  ["sulawesi-barat", "Sulawesi Barat", []],
  ["maluku", "Maluku", []],
  ["maluku-utara", "Maluku Utara", []],
  ["papua", "Papua", []],
  ["papua-barat", "Papua Barat", []],
  ["papua-selatan", "Papua Selatan", []],
  ["papua-tengah", "Papua Tengah", []],
  ["papua-pegunungan", "Papua Pegunungan", []],
  ["papua-barat-daya", "Papua Barat Daya", []],
] as const satisfies readonly (readonly [string, string, readonly string[]])[];

export type ProvinceCode = (typeof PROVINCES)[number][0];
export const PROVINCE_CODES = PROVINCES.map((p) => p[0]) as readonly ProvinceCode[];
export const PROVINCE_NAME = Object.fromEntries(PROVINCES.map(([code, name]) => [code, name])) as Record<ProvinceCode, string>;
/** OPEN-P4: offered as a suggestion the seller confirms (remote eastern provinces and Aceh); nothing is blocked without the seller's action. */
export const SUGGESTED_COD_BLOCKED: readonly ProvinceCode[] = ["aceh", "maluku", "maluku-utara", "papua", "papua-barat", "papua-selatan", "papua-tengah", "papua-pegunungan", "papua-barat-daya"];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const BY_NAME = new Map<string, ProvinceCode>(PROVINCES.flatMap(([code, name, aliases]) => [name, ...aliases].map((n) => [norm(n), code] as const)));

/** A provider province name → code, or null when it is missing or not one of the known names (then COD is refused). */
export function provinceCode(name: string | null | undefined): ProvinceCode | null {
  return name ? (BY_NAME.get(norm(name)) ?? null) : null;
}

/**
 * The province part of an area label as both adapters build it ("subdistrict, district, city, province ZIP"): the last comma segment without
 * the postal code. Null when the label has fewer than two segments.
 */
export function provinceOfLabel(label: string): string | null {
  const parts = label.split(",").map((p) => p.trim());
  if (parts.length < 2) return null;
  return parts.at(-1)!.replace(/\s*\d{5}$/, "").trim() || null;
}
