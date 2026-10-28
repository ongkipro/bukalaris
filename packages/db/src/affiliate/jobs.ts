import { z } from "zod";
import { registerHandler } from "../ops/jobs/jobs.ts";
import { registerProjection } from "../ops/jobs/manage.ts";
import { projectOffers, rebuildAffiliateCatalog } from "./catalog.ts";

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
