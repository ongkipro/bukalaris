import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../client.ts";
import { registerHandler, registerPlatformHandler } from "../ops/jobs/jobs.ts";
import { registerProjection } from "../ops/jobs/manage.ts";
import { registerSchedule } from "../ops/jobs/scheduler.ts";
import { projectOffers, rebuildAffiliateCatalog } from "./catalog.ts";
import { AFFILIATE_RELEASE_BATCH } from "./settings.ts";

// JOB-20 `affiliate.catalog.project` (T-52): the offer triggers of migration 0016 leave one ID-only job per offer revision (and one per store policy revision); the worker projects the live row on the platform
// pool. Importing this module registers the handler, the kind's policy (bulk, replay-safe) and the `affiliate_catalog` full rebuild of JOB-22 (a side effect, like
// buyer/jobs.ts): the worker imports it to run the handler, the web app (through index.ts) so an audited requeue and a rebuild know the kind.

export const AFFILIATE_CATALOG_PROJECT = "affiliate.catalog.project";
export const AFFILIATE_CATALOG_PROJECTION = "affiliate_catalog";

// `offerId` is absent on a store-wide job (a store policy change): every offer of the job's store is then reprojected.
const payload = z.object({ offerId: z.number().int().positive().optional(), revision: z.number().int().positive() });

// The store comes from the job row (written by the database trigger under the offer's own store), never from the payload. The handler ignores the payload revision for
// its decision: it projects the live row, and the catalog write itself refuses an older revision, so a stale, duplicated or reordered job changes nothing.
registerHandler(
  AFFILIATE_CATALOG_PROJECT,
  async ({ db }, j) => {
    const { offerId } = payload.parse(j.payload);
    await projectOffers(db, j.storeId, offerId === undefined ? undefined : [offerId]);
  },
  { replaySafe: true },
);
registerProjection(AFFILIATE_CATALOG_PROJECTION, rebuildAffiliateCatalog);

// JOB-38 `affiliate.commission.release` (T-108, ADR-0015 decision 4): every minute, on the platform pool, the pending obligations whose `payable_at` (delivery plus
// the hold the order froze) has passed become `payable`. Delivery and the void before delivery are stamped by the order status trigger, not here. The database
// guard refuses the move before `payable_at`, so a wrong clock or a stale query cannot release early; SKIP LOCKED lets two workers share a backlog, and a
// repeated or overlapping run finds nothing left to move (replay-safe). Returns how many moved.
export const AFFILIATE_COMMISSION_RELEASE = "affiliate.commission.release";

export async function releasePayableCommissions(exec: Executor, limit = AFFILIATE_RELEASE_BATCH): Promise<number> {
  const rows = (await exec.execute(sql`
    update public.affiliate_commission c set status = 'payable'
     where c.id in (select d.id from public.affiliate_commission d where d.status = 'pending' and d.payable_at <= now() order by d.payable_at, d.id limit ${limit} for update skip locked)
    returning c.id`)) as unknown as unknown[];
  return rows.length;
}

registerSchedule({ kind: AFFILIATE_COMMISSION_RELEASE, period: "minute", catchUp: 0 });
registerPlatformHandler(AFFILIATE_COMMISSION_RELEASE, async ({ db }) => { await releasePayableCommissions(db); }, { replaySafe: true });
