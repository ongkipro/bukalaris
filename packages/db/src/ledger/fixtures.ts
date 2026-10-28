import { sql } from "drizzle-orm";
import type { Executor } from "../client.ts";

/** Courier codes of the FAKE Mengantar adapter (`payments/providers.ts`) that the local seeds, tests and e2e treat as COD-capable with free returns. */
export const FAKE_COD_COURIERS = ["JNE"] as const;

/**
 * LOCAL FIXTURE, never called in production: the production COD allow-list is the `courier_service_policy` data the migration seeds (SPX only, UNVERIFIED, OPEN-F7). The
 * fake adapter quotes JNE and SiCepat, not SPX, so local dev, the demo seed, the test database and the e2e database register the fake courier JNE as a COD-capable service
 * (evidence reference `fixture:fake-adapter`) to keep the COD flows exercisable. SiCepat stays outside the list on purpose: it proves the gate refuses a non-allowed service.
 */
export async function seedFakeCourierPolicy(exec: Executor): Promise<void> {
  for (const code of FAKE_COD_COURIERS) {
    await exec.execute(sql`
      insert into courier_service_policy (courier_code, service_code, cod_allowed, return_free, return_free_evidence_ref, status, updated_by)
      values (${code}, '', true, true, 'fixture:fake-adapter', 'active', 'fixture:local-seed')
      on conflict (courier_code, service_code) do nothing`);
  }
}
