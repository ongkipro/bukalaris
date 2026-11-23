import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

// T-113 (ADR-0013 decision 39, D-32): the private store of buyer proof-of-transfer images. A directory apart from the public media store
// (`MEDIA_DIR`), never served by a public route: the web app reads a file only after the signed order-status link or the store's finance role
// was checked. Keys come from `proofKey()` (store id and a random UUID), never from a request. The web server, the worker and the cleanup
// command must see the same directory: set `PRIVATE_MEDIA_DIR` to one absolute path (required in production); the local default
// `<repo>/var/private-media` assumes the process runs two levels below the repository root (apps/web, packages/db).
// lazy: single-host disk store, like the public media; upgrade path is an object store with the same keys (hosting work, T-79).

const KEY_RE = /^[0-9]{1,15}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

function root(): string {
  const dir = process.env.PRIVATE_MEDIA_DIR?.trim() || null;
  if (process.env.NODE_ENV === "production" && !(dir && isAbsolute(dir))) throw new Error("PRIVATE_MEDIA_DIR must be an absolute path");
  const base = resolve(/*turbopackIgnore: true*/ dir ?? join(process.cwd(), "..", "..", "var", "private-media"));
  // Never inside (or around) the public media store, which a public route serves.
  const pub = resolve(/*turbopackIgnore: true*/ process.env.MEDIA_DIR?.trim() || "var/media");
  if (base === pub || base.startsWith(pub + sep) || pub.startsWith(base + sep)) throw new Error("PRIVATE_MEDIA_DIR overlaps MEDIA_DIR");
  return base;
}
function pathOf(key: string): string {
  if (!KEY_RE.test(key)) throw new Error("bad proof key");
  const base = root();
  const p = join(/*turbopackIgnore: true*/ base, key);
  if (!isAbsolute(p) || !p.startsWith(base + sep)) throw new Error("proof path escaped PRIVATE_MEDIA_DIR");
  return p;
}
export const isProofKey = (key: string) => KEY_RE.test(key);

export async function writeProofFile(key: string, bytes: Uint8Array): Promise<void> {
  const p = pathOf(key);
  await mkdir(/*turbopackIgnore: true*/ join(p, ".."), { recursive: true, mode: 0o700 });
  await writeFile(/*turbopackIgnore: true*/ p, bytes, { flag: "wx", mode: 0o600 });
}
export async function readProofFile(key: string): Promise<Uint8Array | null> {
  try {
    return await readFile(/*turbopackIgnore: true*/ pathOf(key));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
export async function unlinkProofFile(key: string): Promise<void> {
  await unlink(/*turbopackIgnore: true*/ pathOf(key)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
}

/**
 * The response of a proof download: always an attachment, never rendered by the browser as a page, sandboxed, no caching (personal data,
 * decision 39). The file name is generic: no buyer, bank or order data in a header.
 */
const PROOF_MIMES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;
export function proofResponse(bytes: Uint8Array, mime: string, n: number): Response {
  if (!Object.hasOwn(PROOF_MIMES, mime)) throw new Error("proof file of an unexpected type");
  const ext = PROOF_MIMES[mime as keyof typeof PROOF_MIMES];
  return new Response(bytes as BodyInit, {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="bukti-transfer-${n}.${ext}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Referrer-Policy": "no-referrer",
    },
  });
}
