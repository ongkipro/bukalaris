import { expect, test } from "@playwright/test";
import { chooseDestination, evidence, login } from "./helpers";

const API = "/api/storefront/v1";

test("headless channel: one-time token, external backend via API, one-use handoff into hosted checkout", async ({ page, request }, info) => {
  // Owner registers a channel and reads the token exactly once (SC-21, IAM-11).
  await login(page, "owner-a@bukalaris.local");
  await page.goto("/seller/channels");
  await expect(page.getByRole("heading", { name: "Channel", level: 1 })).toBeVisible();
  await page.getByLabel("Nama").fill("Storefront Uji");
  await page.getByLabel("Origin storefront").fill("https://toko-ayu.example");
  await page.getByLabel("Path kembali").fill("/thanks");
  await evidence(page, info, "30-channel-form");
  await page.getByRole("button", { name: "Buat channel" }).click();
  const token = (await page.getByTestId("channel-token").textContent())!.trim();
  expect(token).toMatch(/^blsk_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/);
  expect(page.url()).not.toContain(token.slice(-20));
  await evidence(page, info, "31-channel-token-once");
  // The list shows only the prefix; a reload cannot recover the secret.
  await page.reload();
  await expect(page.getByText(`blsk_${token.slice(5, 13)}_…`)).toBeVisible();
  await expect(page.getByTestId("channel-token")).toHaveCount(0);

  // An external storefront backend: server-to-server calls with the bearer token (no browser cookies).
  const headers = { Authorization: `Bearer ${token}` };
  expect((await request.get(`${API}/products`)).status()).toBe(401);
  const products = await request.get(`${API}/products`, { headers });
  expect(products.status()).toBe(200);
  expect(products.headers()["cache-control"]).toBe("no-store");
  expect(products.headers()["access-control-allow-origin"]).toBeUndefined();
  const { items } = (await products.json()) as { items: { id: string; title: string; slug: string; min_price: { amount: number } }[] };
  const titles = items.map((p) => p.title);
  expect(titles).toEqual(expect.arrayContaining(["Kaos Katun Basic", "Totebag Kanvas"]));
  expect(titles).not.toContain("Topi (draf)"); // draft product hidden
  expect(titles).not.toContain("Kopi Arabika 250g"); // other store hidden
  expect(items.find((p) => p.slug === "kaos-katun-basic")).toMatchObject({ id: expect.stringMatching(/^[1-9][0-9]*$/), min_price: { amount: 89_000 } });

  const detail = (await (await request.get(`${API}/products/kaos-katun-basic`, { headers })).json()) as {
    variants: { id: string; title: string; price: { amount: number; currency: string } }[];
  };
  const m = detail.variants.find((v) => v.title === "M")!;
  expect(m.price).toEqual({ amount: 89_000, currency: "IDR" });

  const created = await request.post(`${API}/carts`, { headers, data: { items: [] } });
  expect(created.status()).toBe(201);
  const cartId = ((await created.json()) as { cart: { id: string } }).cart.id;
  const added = await request.post(`${API}/carts/${cartId}/items`, { headers, data: { variant_id: m.id, quantity: 2 } });
  expect(added.status()).toBe(200);
  expect(((await added.json()) as { subtotal: { amount: number } }).subtotal.amount).toBe(178_000);
  // Client-supplied prices are rejected (strict schema), as is a non-existent cart.
  expect((await request.post(`${API}/carts/${cartId}/items`, { headers, data: { variant_id: m.id, quantity: 1, unit_price: 1 } })).status()).toBe(422);
  expect((await request.get(`${API}/carts/00000000-0000-4000-8000-000000000000`, { headers })).status()).toBe(404);

  const handoff = await request.post(`${API}/carts/${cartId}/checkout-handoffs`, { headers, data: {} });
  expect(handoff.status()).toBe(201);
  const { checkout_url } = (await handoff.json()) as { checkout_url: string };
  expect(checkout_url).toMatch(/\/checkout\/h\/[A-Za-z0-9_-]{43}$/);

  // The buyer's browser follows the one-use URL and lands on the clean hosted checkout.
  await page.goto(checkout_url);
  await expect(page).toHaveURL(/\/checkout\?store=toko-a$/);
  await expect(page.getByRole("heading", { name: /Checkout · Toko Ayu/ })).toBeVisible();
  await expect(page.getByTestId("subtotal")).toHaveText("Rp 178.000");
  await evidence(page, info, "32-handoff-checkout");
  await chooseDestination(page);
  await page.getByLabel("Nama").fill("Budi Santoso");
  await page.getByLabel("Nomor HP").fill("081234567890");
  await page.getByLabel("Alamat lengkap").fill("Jl. Merdeka No. 1, Bandung 40111");
  await page.getByRole("button", { name: "Buat pesanan" }).click();
  await expect(page.getByRole("heading", { name: "Pesanan diterima" })).toBeVisible();
  await expect(page.getByTestId("order-total")).toHaveText("Rp 195.500"); // 178.000 + COD ongkir 17.500
  // Return goes only to the channel's registered origin + path.
  await expect(page.getByTestId("return-link")).toHaveAttribute("href", "https://toko-ayu.example/thanks");
  await evidence(page, info, "33-handoff-confirmation");

  // Replaying the handoff URL fails safely; the checked-out cart is gone from the API.
  await page.goto(checkout_url);
  await expect(page).toHaveURL(/\/checkout\/h\/invalid$/);
  await expect(page.getByRole("heading", { name: "Tautan checkout tidak berlaku" })).toBeVisible();
  await evidence(page, info, "34-handoff-replayed");
  expect((await request.get(`${API}/carts/${cartId}`, { headers })).status()).toBe(404);

  // Revocation in the UI denies the token immediately.
  await page.goto("/seller/channels");
  page.once("dialog", (d) => d.accept()); // T-28: revoking a token is destructive → confirm first
  await page.getByRole("button", { name: "Cabut Storefront Uji" }).click();
  await expect(page.getByText("Dicabut").first()).toBeVisible();
  await evidence(page, info, "35-channel-revoked");
  const denied = await request.get(`${API}/products`, { headers });
  expect(denied.status()).toBe(401);
  expect(await denied.json()).toMatchObject({ code: "unauthorized" });
});
