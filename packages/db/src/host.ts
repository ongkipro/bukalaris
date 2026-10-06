/**
 * Map a request Host to a store slug: `<slug>.<rootDomain>[:port]` → slug.
 * Anything else (apex, nested subdomains, other domains) → null.
 */
export function slugFromHost(host: string | null, rootDomain: string): string | null {
  if (!host) return null;
  const hostname = host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  const suffix = `.${rootDomain.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(label) ? label : null;
}
