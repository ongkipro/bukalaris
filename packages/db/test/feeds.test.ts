import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createProduct, updateProduct } from "../src/seller/commerce/catalog.ts";
import { createFeedToken, escapeXml, feedItems, feedSettings, feedUrls, FEED_FETCH_LIMIT, limitFeedFetch, renderGoogleRss, renderMetaCsv, resolveFeedToken, revokeFeedToken, storeBaseUrl } from "../src/storefront/feeds.ts";
import { feedToken, media, product } from "../src/schema.ts";
import { addVariant, db, makeStore, makeUser, platform, seller } from "./helpers.ts";

// Catalog feeds (T-40, PR-12, Q-7): one item per variant of an active product with a cover image,
// ids as strings (variant = item, product = group), token-protected, store-isolated.

process.env.BETTER_AUTH_URL = "http://localhost:3280";
delete process.env.STORE_ROOT_DOMAIN;

/** A media row is enough for the feed (it only publishes the URL); no file is written. */
async function cover(storeId: number, productId: number) {
  const [m] = await platform
    .insert(media)
    .values({ storeId, productId, position: 0, alt: "", mime: "image/jpeg", width: 800, height: 800, bytes: 1000 })
    .returning({ id: media.id });
  return m!.id;
}

/** Parse the CSV we emit (every cell quoted, quotes doubled, CRLF rows) back into records. */
function parseCsv(csv: string): Record<string, string>[] {
  const [header, ...body] = csv.split("\r\n").filter(Boolean);
  const cols = header!.split(",");
  return body.map((line) => Object.fromEntries(cols.map((h, i) => [h, [...line.matchAll(/"((?:[^"]|"")*)"/g)][i]![1]!.replace(/""/g, '"')])));
}
const xmlItems = (xml: string) => [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]!);
const tag = (block: string, name: string) => block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];

describe("feed items", () => {
  it("one item per variant of an active product with a cover; ids are the catalog id strings, group = product, link canonical, image absolute", async () => {
    const a = await makeStore("toko-a", { price: 125_000, stock: 3 });
    await addVariant(a.owner, a.productId, { title: "L", price: 130_000, stock: 0, weightGrams: 1000 });
    await cover(a.storeId, a.productId);
    // Second active product with a readable slug and no image → skipped; a draft → never in the feed.
    const noImage = await createProduct(a.owner, { title: "Totebag", slug: "totebag", status: "active", variant: { title: "Natural", price: 55_000, stock: 1, weightGrams: 1000 } });
    await createProduct(a.owner, { title: "Topi (draf)", status: "draft", variant: { title: "All size", price: 45_000, stock: 10, weightGrams: 1000 } });
    const { items, skipped } = await feedItems(a.sf);
    expect(skipped).toBe(1);
    expect(items).toHaveLength(2);
    const [m, l] = items;
    const rows = await platform.select({ catalogId: product.catalogId }).from(product).where(eq(product.id, a.productId));
    const groupId = rows[0]!.catalogId;
    expect(typeof m!.id).toBe("string");
    expect(m!.id).toMatch(/^[1-9][0-9]{4,}$/);
    expect(m!.groupId).toBe(groupId);
    expect(l!.groupId).toBe(groupId);
    expect(m!.id).not.toBe(l!.id);
    expect(items.map((i) => i.id)).not.toContain(groupId);
    expect(m).toMatchObject({ title: "Kaos toko-a - M", price: 125_000, inStock: true, brand: "Toko toko-a", description: "Kaos toko-a - M" });
    expect(l).toMatchObject({ title: "Kaos toko-a - L", price: 130_000, inStock: false });
    // No readable slug → the catalog id is the canonical segment; image is the cover on the store base.
    expect(m!.link).toBe(`http://localhost:3280/s/toko-a/products/${groupId}`);
    expect(m!.imageLink).toMatch(/^http:\/\/localhost:3280\/s\/toko-a\/media\/[0-9]+$/);
    expect(items.some((i) => i.title.startsWith("Totebag"))).toBe(false);
    // Give the skipped product an image and a readable slug: it appears with the slug URL.
    await cover(a.storeId, noImage);
    const again = await feedItems(a.sf);
    expect(again.skipped).toBe(0);
    expect(again.items.map((i) => i.link).at(-1)).toBe("http://localhost:3280/s/toko-a/products/totebag");
  });

  it("archiving a product removes its variants from the feed; stock drives availability", async () => {
    const a = await makeStore("toko-a", { stock: 0 });
    await cover(a.storeId, a.productId);
    expect((await feedItems(a.sf)).items[0]!.inStock).toBe(false);
    await updateProduct(a.owner, a.productId, { title: "Kaos toko-a", status: "archived" });
    expect((await feedItems(a.sf)).items).toEqual([]);
  });

  it("production base: https host mode on STORE_ROOT_DOMAIN; dev: path mode on the app origin", () => {
    expect(storeBaseUrl("toko-a", { STORE_ROOT_DOMAIN: "bukalaris.com", BETTER_AUTH_URL: "https://app.bukalaris.com" })).toBe("https://toko-a.bukalaris.com");
    expect(storeBaseUrl("toko-a", { STORE_ROOT_DOMAIN: "localhost", BETTER_AUTH_URL: "http://localhost:3280/" })).toBe("http://localhost:3280/s/toko-a");
    expect(storeBaseUrl("toko-a", {})).toBe("http://localhost:3000/s/toko-a");
    expect(feedUrls("blfd_x_y", { BETTER_AUTH_URL: "https://app.bukalaris.com" })).toEqual({
      meta: "https://app.bukalaris.com/feeds/blfd_x_y/meta.csv",
      google: "https://app.bukalaris.com/feeds/blfd_x_y/google.xml",
    });
  });
});

describe("renderers", () => {
  const item = {
    id: "10001",
    groupId: "10000",
    title: `Kaos "Premium" & <Co> - L`,
    description: "Bahan katun, 'adem'; cocok untuk > 30°C — Ünïcödé 😀",
    price: 125_000,
    inStock: true,
    link: "https://toko-a.bukalaris.com/products/kaos?a=1&b=2",
    imageLink: "https://toko-a.bukalaris.com/media/5",
    brand: "Toko A & B",
  };

  it("Meta CSV: header per spec, quoted cells with doubled quotes, availability and price formats, CRLF", () => {
    const csv = renderMetaCsv([item, { ...item, id: "10002", inStock: false }]);
    expect(csv.startsWith("id,item_group_id,title,description,availability,condition,price,link,image_link,brand\r\n")).toBe(true);
    expect(csv).toContain(`"Kaos ""Premium"" & <Co> - L"`);
    const [first, second] = parseCsv(csv);
    expect(first).toEqual({
      id: "10001",
      item_group_id: "10000",
      title: item.title,
      description: item.description,
      availability: "in stock",
      condition: "new",
      price: "125000 IDR",
      link: item.link,
      image_link: item.imageLink,
      brand: item.brand,
    });
    expect(second!.availability).toBe("out of stock");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("Google RSS 2.0: g namespace, channel title/link/description, g: attributes, escaped text, unicode intact", () => {
    const xml = renderGoogleRss([item], { storeName: "Toko A & B", storeSlug: "toko-a" });
    expect(xml.startsWith(`<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n<channel>`)).toBe(true);
    expect(tag(xml, "title")).toBe("Toko A &amp; B");
    expect(tag(xml, "link")).toBe("http://localhost:3280/s/toko-a");
    expect(tag(xml, "description")).toBe("Katalog produk Toko A &amp; B");
    const [i] = xmlItems(xml);
    expect(tag(i!, "g:id")).toBe("10001");
    expect(tag(i!, "g:item_group_id")).toBe("10000");
    expect(tag(i!, "g:title")).toBe("Kaos &quot;Premium&quot; &amp; &lt;Co&gt; - L");
    expect(tag(i!, "g:description")).toBe("Bahan katun, &apos;adem&apos;; cocok untuk &gt; 30°C — Ünïcödé 😀");
    expect(tag(i!, "g:link")).toBe("https://toko-a.bukalaris.com/products/kaos?a=1&amp;b=2");
    expect(tag(i!, "g:image_link")).toBe(item.imageLink);
    expect(tag(i!, "g:price")).toBe("125000 IDR");
    expect(tag(i!, "g:availability")).toBe("in_stock");
    expect(tag(i!, "g:condition")).toBe("new");
    expect(tag(i!, "g:brand")).toBe("Toko A &amp; B");
    expect(xml).not.toMatch(/<g:[a-z_]+><\/g:[a-z_]+>/); // no empty required field
    expect(escapeXml("a\u0000b\u0007c\td")).toBe("abc\td");
  });

  it("long or empty text: title clipped to 150, whitespace collapsed, empty description falls back to the title", async () => {
    const a = await makeStore("toko-a");
    await cover(a.storeId, a.productId);
    await updateProduct(a.owner, a.productId, { title: "K".repeat(200), description: "", status: "active" });
    const [i] = (await feedItems(a.sf)).items;
    expect(i!.title).toHaveLength(150);
    expect(i!.description).toBe(i!.title);
    // The catalog caps descriptions at 5 000 (the Google limit), so the clip only ever applies to titles.
    await updateProduct(a.owner, a.productId, { title: "Kaos", description: "a b\n\n  c <b>x</b> ", status: "active" });
    const [j] = (await feedItems(a.sf)).items;
    expect(j!.description).toBe("a b c <b>x</b>");
  });
});

describe("feed tokens", () => {
  it("owner creates a token (hash stored, shown once), it resolves to the store; regenerate revokes the old one; revoke → null", async () => {
    const a = await makeStore("toko-a");
    expect((await feedSettings(a.owner)).token).toBeNull();
    const first = await createFeedToken(a.owner);
    expect(first.token).toMatch(/^blfd_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/);
    const rows = await platform.select().from(feedToken).where(eq(feedToken.storeId, a.storeId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toContain(first.token.slice(-20));
    expect(rows[0]!.tokenPrefix).toBe(first.prefix);
    const settings = await feedSettings(a.owner);
    expect(settings.token?.prefix).toBe(first.prefix);
    expect(settings).toMatchObject({ activeProducts: 1, withoutImage: 1 });

    const scope = await resolveFeedToken(db, first.token);
    expect(scope).toMatchObject({ kind: "storefront", storeId: a.storeId, storeSlug: "toko-a" });

    const second = await createFeedToken(a.owner);
    expect(second.token).not.toBe(first.token);
    expect(await resolveFeedToken(db, first.token)).toBeNull();
    expect((await resolveFeedToken(db, second.token))?.storeId).toBe(a.storeId);
    const after = await platform.select({ status: feedToken.status }).from(feedToken).where(eq(feedToken.storeId, a.storeId)).orderBy(feedToken.id);
    expect(after.map((r) => r.status)).toEqual(["revoked", "active"]);

    await revokeFeedToken(a.owner);
    expect(await resolveFeedToken(db, second.token)).toBeNull();
    expect((await feedSettings(a.owner)).token).toBeNull();
    await expect(revokeFeedToken(a.owner)).rejects.toMatchObject({ code: "not_found" });
  });

  it("malformed, unknown, same-prefix-wrong-secret tokens and suspended stores resolve to nothing", async () => {
    const a = await makeStore("toko-a");
    const { token } = await createFeedToken(a.owner);
    expect(await resolveFeedToken(db, "")).toBeNull();
    expect(await resolveFeedToken(db, "blfd_short")).toBeNull();
    expect(await resolveFeedToken(db, token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(await resolveFeedToken(db, token.replace(/^blfd_/, "blsk_"))).toBeNull();
    await platform.execute(`update store set status = 'suspended' where id = ${a.storeId}`);
    expect(await resolveFeedToken(db, token)).toBeNull();
  });

  it("fetch budget is per store: the 61st fetch in the hour waits, another store is unaffected", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    for (let i = 0; i < FEED_FETCH_LIMIT.limit; i++) expect(await limitFeedFetch(db, a.sf)).toBeNull();
    const wait = await limitFeedFetch(db, a.sf);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(FEED_FETCH_LIMIT.windowSec);
    expect(await limitFeedFetch(db, b.sf)).toBeNull();
  });

  it("cross-store isolation: B's token never yields A's items; staff cannot manage tokens", async () => {
    const a = await makeStore("toko-a");
    const b = await makeStore("toko-b");
    await cover(a.storeId, a.productId);
    await cover(b.storeId, b.productId);
    const ta = await createFeedToken(a.owner);
    const tb = await createFeedToken(b.owner);
    const itemsA = (await feedItems((await resolveFeedToken(db, ta.token))!)).items;
    const itemsB = (await feedItems((await resolveFeedToken(db, tb.token))!)).items;
    expect(itemsA.map((i) => i.title)).toEqual(["Kaos toko-a - M"]);
    expect(itemsB.map((i) => i.title)).toEqual(["Kaos toko-b - M"]);
    expect(itemsB[0]!.link).toContain("/s/toko-b/");
    expect(itemsB[0]!.brand).toBe("Toko toko-b");
    // Store B's settings do not see A's token, and vice versa.
    expect((await feedSettings(b.owner)).token?.prefix).toBe(tb.prefix);
    expect((await feedSettings(a.owner)).token?.prefix).toBe(ta.prefix);

    const staffId = await makeUser("staff");
    await platform.execute(`insert into membership (store_id, user_id, role) values (${a.storeId}, '${staffId}', 'staff')`);
    const staff = await seller(staffId, a.storeId);
    await expect(createFeedToken(staff)).rejects.toMatchObject({ code: "forbidden" });
    await expect(feedSettings(staff)).rejects.toMatchObject({ code: "forbidden" });
    await expect(revokeFeedToken(staff)).rejects.toMatchObject({ code: "forbidden" });
    // Still exactly one active token per store (partial unique index).
    expect((await platform.select().from(feedToken).where(eq(feedToken.status, "active"))).length).toBe(2);
  });
});
