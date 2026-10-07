import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ORDER_STATUSES } from "../src/schema.ts";
import { DEMO_STORES } from "../src/demo/data.ts";
import { seedDemo } from "../src/demo/seed-demo.ts";
import { platform } from "./helpers.ts";

const stores = DEMO_STORES.slice(0, 1);
const mediaDir = await mkdtemp(join(tmpdir(), "bukalaris-demo-"));
afterAll(() => rm(mediaDir, { recursive: true, force: true }));

describe("demo seed", () => {
  it("seeds every store, status and image once, skips a second run, and rebuilds on --reset", async () => {
    const first = await seedDemo(platform, { mediaDir, imageSize: 32, stores });
    expect(first.skipped).toBe(false);
    const c = first.counts;
    expect(c.stores).toBe(stores.length);
    expect(c.users).toBe(1 + 2 * stores.length);
    expect(c.products).toBe(stores.reduce((n, s) => n + s.products.length, 0));
    expect(c.orders).toBe(16 * stores.length);
    expect([...c.statuses].sort()).toEqual([...ORDER_STATUSES].sort());
    expect(c.jobsFailed).toBe(0);
    // Every media row has its PNG on disk (the seed writes through addProductMedia's persist hook).
    const files = (await readdir(mediaDir, { recursive: true, withFileTypes: true })).filter((f) => f.isFile());
    expect(files.length).toBe(c.media);
    const png = await readFile(join(files[0]!.parentPath, files[0]!.name));
    expect(png.subarray(1, 4).toString()).toBe("PNG");

    const second = await seedDemo(platform, { mediaDir, imageSize: 32, stores });
    expect(second.skipped).toBe(true);
    expect(second.counts.orders).toBe(c.orders);

    const third = await seedDemo(platform, { mediaDir, imageSize: 32, stores, reset: true });
    expect(third.skipped).toBe(false);
    expect(third.counts.stores).toBe(c.stores);
    expect(third.counts.orders).toBe(c.orders);
  }, 180_000); // ~45 s on a loaded machine: three runs through the real services
});
