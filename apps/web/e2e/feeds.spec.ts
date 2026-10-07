import { expect, test, type APIRequestContext } from "@playwright/test";
import { deflateSync } from "node:zlib";
import { evidence, login } from "./helpers";

// feeds track (T-40, PR-12). The owner issues the store's feed token on /seller/marketing and the
// two URLs are fetched like Meta / Google would: unauthenticated, token in the path. Nothing is
// uploaded to either platform; the structure is asserted against their published field names.

/** A real solid-colour PNG (valid IHDR/IDAT/IEND) so the upload passes content sniffing (same as content.spec). */
function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => ~b.reduce((c, x) => table[(c ^ x) & 0xff]! ^ (c >>> 8), 0xffffffff) >>> 0;
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Our CSV: unquoted header, every body cell quoted with doubled quotes, CRLF rows. */
function parseCsv(csv: string): Record<string, string>[] {
  const [header, ...body] = csv.split("\r\n").filter(Boolean);
  const cols = header!.split(",");
  return body.map((line) => Object.fromEntries(cols.map((h, i) => [h, [...line.matchAll(/"((?:[^"]|"")*)"/g)][i]![1]!.replace(/""/g, '"')])));
}
const xmlItems = (xml: string) => [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]!);
const tag = (block: string, name: string) => block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];

async function fetchFeeds(request: APIRequestContext, urls: { meta: string; google: string }) {
  const [meta, google] = await Promise.all([request.get(urls.meta), request.get(urls.google)]);
  return { meta, google };
}

test("owner issues the feed token; Meta CSV and Google RSS list sellable variants with catalog ids; regenerate and revoke cut access", async ({ page, request }, info) => {
  page.on("dialog", (d) => d.accept());
  await login(page, "owner-a@bukalaris.local");

  // Both platforms require image_link: make sure the seeded product has a cover (idempotent across projects).
  // Wait for the product page before counting: `count()` does not wait, and a premature 0 would add a
  // third image that breaks content.spec's "two images" assumption on the next project.
  await page.getByRole("link", { name: "Kaos Katun Basic" }).click();
  await expect(page.getByLabel("Berkas gambar")).toBeVisible();
  if ((await page.getByTestId("product-images").getByRole("img").count()) === 0) {
    await page.getByLabel("Berkas gambar").setInputFiles({ name: "kaos.png", mimeType: "image/png", buffer: png(600, 600, [40, 90, 160]) });
    await page.getByLabel("Teks alternatif", { exact: true }).fill("Kaos katun tampak depan");
    await page.getByRole("button", { name: "Unggah gambar" }).click();
    await expect(page.getByRole("status")).toHaveText("Tersimpan.");
  }

  await page.goto("/seller/marketing");
  const section = page.getByTestId("feed-section");
  await expect(section.getByRole("heading", { name: "Feed katalog" })).toBeVisible();
  // Create (first project) or regenerate (second project: a token already exists → confirm dialog accepted above).
  await section.getByRole("button", { name: /Buat (ulang )?token feed/ }).click();
  const urls = {
    meta: await section.getByTestId("feed-url-meta").innerText(),
    google: await section.getByTestId("feed-url-google").innerText(),
  };
  expect(urls.meta).toMatch(/^http:\/\/localhost:\d+\/feeds\/blfd_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}\/meta\.csv$/);
  expect(urls.google).toBe(urls.meta.replace(/meta\.csv$/, "google.xml"));
  await evidence(page, info, "97-marketing-feeds");

  // Meta CSV.
  const { meta, google } = await fetchFeeds(request, urls);
  expect(meta.status()).toBe(200);
  expect(meta.headers()["content-type"]).toBe("text/csv; charset=utf-8");
  expect(meta.headers()["cache-control"]).toBe("private, max-age=300");
  expect(meta.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  const csv = await meta.text();
  expect(csv.split("\r\n")[0]).toBe("id,item_group_id,title,description,availability,condition,price,link,image_link,brand");
  const rows = parseCsv(csv);
  const kaos = rows.filter((r) => r.title!.startsWith("Kaos Katun Basic - "));
  expect(kaos.length).toBeGreaterThanOrEqual(2); // seeded variants
  for (const r of kaos) {
    expect(r.id).toMatch(/^[1-9][0-9]{4,}$/);
    expect(r.item_group_id).toMatch(/^[1-9][0-9]{4,}$/);
    expect(r.item_group_id).toBe(kaos[0]!.item_group_id);
    expect(r.id).not.toBe(r.item_group_id);
    expect(r.price).toMatch(/^[0-9]+ IDR$/);
    expect(["in stock", "out of stock"]).toContain(r.availability);
    expect(r.condition).toBe("new");
    expect(r.brand).toBe("Toko Ayu");
    expect(r.link).toMatch(/^http:\/\/localhost:\d+\/s\/toko-a\/products\/kaos-katun-basic$/);
    expect(r.image_link).toMatch(/^http:\/\/localhost:\d+\/s\/toko-a\/media\/[0-9]+$/);
  }
  expect(new Set(kaos.map((r) => r.id)).size).toBe(kaos.length);
  expect(rows.some((r) => r.title!.startsWith("Topi"))).toBe(false); // draft never listed
  expect(rows.every((r) => r.link!.includes("/s/toko-a/"))).toBe(true); // only this store
  // The image link is a working public URL.
  expect((await request.get(kaos[0]!.image_link!)).headers()["content-type"]).toMatch(/^image\//);

  // Google RSS 2.0.
  expect(google.status()).toBe(200);
  expect(google.headers()["content-type"]).toBe("application/xml; charset=utf-8");
  expect(google.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  const xml = await google.text();
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">')).toBe(true);
  expect(tag(xml, "title")).toBe("Toko Ayu");
  const items = xmlItems(xml);
  expect(items.map((i) => tag(i, "g:id")).sort()).toEqual(rows.map((r) => r.id!).sort());
  const first = items.find((i) => tag(i, "g:id") === kaos[0]!.id)!;
  expect(tag(first, "g:item_group_id")).toBe(kaos[0]!.item_group_id);
  expect(tag(first, "g:title")).toBe(kaos[0]!.title);
  expect(tag(first, "g:price")).toBe(kaos[0]!.price);
  expect(["in_stock", "out_of_stock"]).toContain(tag(first, "g:availability"));
  expect(tag(first, "g:condition")).toBe("new");
  expect(tag(first, "g:brand")).toBe("Toko Ayu");
  expect(tag(first, "g:link")).toBe(kaos[0]!.link);
  expect(tag(first, "g:image_link")).toBe(kaos[0]!.image_link);

  // Wrong token → 404, no body; a token with the right shape but wrong secret too.
  expect((await request.get("/feeds/not-a-token/meta.csv")).status()).toBe(404);
  const forged = urls.meta.replace(/_[A-Za-z0-9_-]{43}\/meta\.csv$/, `_${"A".repeat(43)}/meta.csv`);
  expect((await request.get(forged)).status()).toBe(404);
  expect((await request.get(forged.replace(/meta\.csv$/, "google.xml"))).status()).toBe(404);

  // Regenerate: the old URLs stop, the new ones work. The page shows only the prefix afterwards.
  await page.reload();
  await expect(section.getByTestId("feed-token-state")).toContainText("Token aktif");
  expect(await page.content()).not.toContain(urls.meta.split("/feeds/")[1]!.split("/")[0]!.slice(-20));
  await section.getByRole("button", { name: "Buat ulang token feed" }).click();
  const regenerated = await section.getByTestId("feed-url-meta").innerText();
  expect(regenerated).not.toBe(urls.meta);
  expect((await request.get(urls.meta)).status()).toBe(404);
  expect((await request.get(regenerated)).status()).toBe(200);

  // Revoke: both feeds answer 404 and the page offers to create again.
  await page.reload();
  await section.getByRole("button", { name: "Cabut token feed" }).click();
  await expect(page.getByRole("status")).toHaveText("Tersimpan.");
  await expect(section.getByTestId("feed-token-state")).toContainText("Belum ada token feed");
  expect((await request.get(regenerated)).status()).toBe(404);
  expect((await request.get(regenerated.replace(/meta\.csv$/, "google.xml"))).status()).toBe(404);
});

test("staff cannot see or manage the feed token", async ({ page }) => {
  await login(page, "staff-a@bukalaris.local");
  await page.goto("/seller/marketing");
  await expect(page.getByRole("note")).toContainText("Hanya pemilik toko");
  await expect(page.getByTestId("feed-section")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /token feed/ })).toHaveCount(0);
});
