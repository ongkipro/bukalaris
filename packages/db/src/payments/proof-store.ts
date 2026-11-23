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
  const dir = process.env.PRIVATE_MEDIA_DIR;
  if (!dir && process.env.NODE_ENV === "production") throw new Error("PRIVATE_MEDIA_DIR is not set");
  return resolve(/*turbopackIgnore: true*/ dir ?? join(process.cwd(), "..", "..", "var", "private-media"));
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
  await mkdir(/*turbopackIgnore: true*/ join(p, ".."), { recursive: true });
  await writeFile(/*turbopackIgnore: true*/ p, bytes, { flag: "wx" });
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
export function proofResponse(bytes: Uint8Array, mime: string, n: number): Response {
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
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
