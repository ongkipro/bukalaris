"use server";

import { requirePortalCsrf } from "@/lib/auth-csrf";

import { sellerScope } from "@/lib/context";
import { userError } from "@/lib/errors";
import { jakartaInstant, saveFlashSale, savePromoHub, saveVoucher } from "@bukalaris/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";

export type PromotionFormState = { error?: string; errors?: Record<string, string>; saved?: boolean; code?: string; values?: Record<string, string> };
export async function savePromotionAction(_previous: PromotionFormState, f: FormData): Promise<PromotionFormState> {
  try {
    await requirePortalCsrf(f);
  } catch (err) {
    return { error: userError(err) };
  }
  const scope = await sellerScope();
  const values = Object.fromEntries([...f.entries()].filter(([k]) => !k.startsWith("$ACTION_")).map(([k, v]) => [k, String(v)]));
  const n = (key: string) => Number(f.get(key) ?? 0);
  const optional = (key: string) => f.get(key) ? n(key) : null;
  const s = (key: string) => String(f.get(key) ?? "");
  try {
    const id = optional("id") ?? undefined;
    let code: string | undefined;
    if (s("type") === "voucher") {
      const voucher = await saveVoucher(scope, { kind: s("kind"), scope: s("scope"), productId: s("scope") === "product" ? optional("productId") : null, collectionId: s("scope") === "collection" ? optional("collectionId") : null, value: n("value"), minPurchaseIdr: n("minPurchaseIdr"), maxDiscountIdr: optional("maxDiscountIdr"), usageLimit: optional("usageLimit"), buyerUsageLimit: optional("buyerUsageLimit"), startsAt: jakartaInstant(s("startsAt")), endsAt: jakartaInstant(s("endsAt")), status: s("status"), public: f.has("public") }, id);
      code = voucher.code;
    } else if (s("type") === "flash") {
      await saveFlashSale(scope, { title: s("title"), startsAt: jakartaInstant(s("startsAt")), endsAt: jakartaInstant(s("endsAt")), status: s("status"), items: f.getAll("variantId").map((v, i) => ({ variantId: Number(v), salePriceIdr: n(`salePriceIdr_${i}`), stockCap: optional(`stockCap_${i}`) })) }, id);
    } else if (s("type") === "hub") {
      await savePromoHub(scope, { enabled: f.has("enabled"), title: s("title"), subtitle: s("subtitle"), bannerMediaId: optional("bannerMediaId"), bannerCtaLabel: s("bannerCtaLabel"), bannerCtaHref: s("bannerCtaHref"), freeShipEnabled: f.has("freeShipEnabled"), freeShipThresholdIdr: n("freeShipThresholdIdr"), percentRounding: s("percentRounding"), featuredCollectionIds: f.getAll("featuredCollectionIds").map(Number) });
    } else return { error: "Jenis promo tidak valid.", values };
    revalidatePath("/seller/promotions");
    revalidatePath(`/s/${scope.storeSlug}/promo`);
    return { saved: true, ...(code ? { code } : {}) };
  } catch (err) {
    if (err instanceof z.ZodError) return { error: "Periksa aturan promo.", errors: Object.fromEntries(err.issues.map((i) => [String(i.path[0]), i.message])), values };
    return { error: userError(err), values };
  }
}
