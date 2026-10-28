import { eq, sql } from "drizzle-orm";
import type { Executor } from "../client.ts";
import { taxIdentity } from "./schema-tax.ts";
import { sealTaxValue, taxKeyring, unsealTaxValue, type TaxIdentityBinding } from "./seal.ts";

/**
 * JOB-23 building block for the `tax_identity` ring: re-seal one identity under the ring's current key id, AAD unchanged.
 * Returns false when it already carries the current id, was withdrawn or a concurrent run won. The plaintext never leaves this function.
 */
export async function resealTaxIdentity(exec: Executor, identityId: number): Promise<boolean> {
  const current = taxKeyring()[0]!;
  return exec.transaction(async (tx) => {
    const [row] = await tx.select().from(taxIdentity).where(eq(taxIdentity.id, identityId)).for("update");
    if (!row || row.idSealed === null || row.registeredNameSealed === null || row.idKeyVersion === null || row.idKeyVersion === current.keyId) return false;
    const subject = { subjectKind: row.subjectKind as "affiliate" | "store", subjectId: (row.affiliateId ?? row.storeId)!, version: row.version, idKind: row.idKind };
    const binding = (field: TaxIdentityBinding["field"]): TaxIdentityBinding => ({ ...subject, field });
    const identifier = sealTaxValue(unsealTaxValue(row.idSealed, row.idKeyVersion, binding("identifier")), binding("identifier"), current);
    const name = sealTaxValue(unsealTaxValue(row.registeredNameSealed, row.idKeyVersion, binding("registered_name")), binding("registered_name"), current);
    const [done] = (await tx.execute(sql`select public.tax_identity_reseal(${row.id}, ${row.idKeyVersion}, ${current.keyId}, ${identifier.envelope}, ${name.envelope}) as ok`)) as unknown as { ok: boolean }[];
    return done!.ok;
  });
}
