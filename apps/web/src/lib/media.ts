import "server-only";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

/**
 * Local-disk media store. `MEDIA_DIR` (default `./var/media`, git-ignored) must be a
 * persistent volume in Docker. Keys come from `mediaKey()` in packages/db
 * (`<storeId>/<id>.<ext>`), never from a request.
 */
// lazy: single-host disk store; upgrade path is an S3/R2 adapter with the same key.
// turbopackIgnore: the directory is runtime configuration, not a build-time asset.
const root = resolve(/*turbopackIgnore: true*/ process.env.MEDIA_DIR ?? "var/media");

function pathOf(key: string): string {
  if (!/^[0-9]+\/[0-9]+\.(jpg|png|webp)$/.test(key)) throw new Error(`bad media key: ${key}`);
  const p = join(/*turbopackIgnore: true*/ root, key);
  if (!isAbsolute(p) || !p.startsWith(root + sep)) throw new Error("media path escaped MEDIA_DIR");
  return p;
}

export async function writeMedia(key: string, bytes: Uint8Array): Promise<void> {
  const p = pathOf(key);
  await mkdir(/*turbopackIgnore: true*/ join(p, ".."), { recursive: true });
  await writeFile(/*turbopackIgnore: true*/ p, bytes, { flag: "wx" });
}

export async function readMedia(key: string): Promise<Uint8Array | null> {
  try {
    return await readFile(/*turbopackIgnore: true*/ pathOf(key));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function unlinkMedia(key: string): Promise<void> {
  await unlink(/*turbopackIgnore: true*/ pathOf(key)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
}

/** Immutable, inline-only image response; the id never changes once stored. */
export function imageResponse(bytes: Uint8Array, mime: string, maxAge = 31536000): Response {
  return new Response(bytes as BodyInit, {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": maxAge ? `public, max-age=${maxAge}, immutable` : "private, no-store",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

/** Public URL of a store image, relative to the storefront base (host or /s/<slug>). */
export const mediaUrl = (base: string, id: number) => `${base}/media/${id}`;
