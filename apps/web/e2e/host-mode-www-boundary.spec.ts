import { expect, request, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

test.use({ trace: "off" });
const port = Number(process.env.E2E_PORT ?? 3100) + 3;
const transport = `http://127.0.0.1:${port}`;
const receiver = "/api/internal/www-redirect";

test("aligned local listeners retain loopback-only binding and original IPv4 transport", async () => {
  test.skip(process.platform !== "linux", "Socket-address evidence uses Linux ss; HTTP regressions remain portable.");
  const sockets = execFileSync("ss", ["-H", "-lnt", `( sport = :${port - 3} or sport = :${port} )`], { encoding: "utf8" });
  const addresses = sockets.trim().split("\n").filter(Boolean).map(line => line.trim().split(/\s+/)[3]).sort();
  expect(addresses).toEqual([`127.0.0.1:${port - 3}`, `127.0.0.1:${port}`].sort());
  const context = await request.newContext();
  try {
    for (const listener of [port - 3, port]) {
      expect((await context.get(`http://127.0.0.1:${listener}/api/health`)).status()).toBe(200);
    }
  } finally { await context.dispose(); }
  console.info(JSON.stringify({ listenerEvidence: addresses, originalTransport: "127.0.0.1" }));
});

// The receiver is implementation transport, not another public redirect API.
test("direct and forged WWW transport requests cannot redirect other hosts", async () => {
  for (const host of ["localhost", "www.localhost", "owner.localhost", "app.localhost", "checkout.localhost", "affiliate.localhost", "buyer.localhost", "logs.localhost", "toko-a.localhost", "unknown.example"]) {
    const context = await request.newContext({ baseURL: transport, extraHTTPHeaders: { host: `${host}:${port}`, "x-bl-www-redirect": "https://attacker.invalid/" } });
    try {
      for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) {
        const response = await context.fetch(receiver, { method, maxRedirects: 0 });
        expect(response.status(), `${host} ${method}`).toBe(404);
        expect(response.headers().location, `${host} ${method}`).toBeUndefined();
      }
    } finally { await context.dispose(); }
  }
});

test("WWW overwrites an inbound redirect header with its own canonical destination", async () => {
  const context = await request.newContext({ baseURL: transport, extraHTTPHeaders: { host: `www.localhost:${port}`, "x-bl-www-redirect": "https://attacker.invalid/" } });
  try {
    const response = await context.get("/s/toko-a?campaign=guard", { maxRedirects: 0 });
    expect(response.status()).toBe(308);
    expect(response.headers().location).toBe(`http://localhost:${port}/s/toko-a?campaign=guard`);
    expect(response.headers()["cache-control"]).toContain("no-store");
  } finally { await context.dispose(); }
});

test("WWW canonical origins normalize explicit default HTTP and HTTPS ports", async () => {
  for (const [proto, defaultPort] of [["http", 80], ["https", 443]] as const) {
    const context = await request.newContext({ baseURL: transport, extraHTTPHeaders: { host: `www.localhost:${defaultPort}`, "x-forwarded-proto": proto } });
    try {
      for (const method of ["GET", "HEAD"]) {
        const response = await context.fetch("/port-check?campaign=keep", { method, maxRedirects: 0 });
        expect(response.status(), `${proto} ${method}`).toBe(308);
        expect(response.headers().location).toBe(`${proto}://localhost/port-check?campaign=keep`);
      }
    } finally { await context.dispose(); }
  }
});

test("non-WWW redirect queries retain default internal-parameter normalization", async () => {
  for (const [host, path, expected] of [
    ["app.localhost", "/o/1.2.abc?_rsc=review&campaign=keep", `http://checkout.localhost:${port}/o/1.2.abc?campaign=keep`],
    ["toko-a.localhost", "/s/toko-a/cart?_rsc=review&campaign=keep", `http://toko-a.localhost:${port}/cart?campaign=keep`],
  ] as const) {
    const context = await request.newContext({ baseURL: transport, extraHTTPHeaders: { host: `${host}:${port}` } });
    try {
      const response = await context.get(path, { maxRedirects: 0 });
      expect(response.status(), host).toBe(308);
      expect(response.headers().location, host).toBe(expected);
    } finally { await context.dispose(); }
  }
});
