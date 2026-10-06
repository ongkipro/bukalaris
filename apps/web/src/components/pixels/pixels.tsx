import "server-only";
import { signalsFor } from "@/lib/signals";
import { SignalRuntime, type Match } from "./runtime";

/**
 * Pixel mount for storefront and hosted checkout pages (never seller/admin). Renders
 * nothing when the store has no enabled destination. Passes public ids only; the server
 * token never reaches the browser. `match` = hashed buyer fields for advanced matching at
 * init (confirmation page).
 */
export async function Pixels({ storeId, match }: { storeId: number; match?: Match }) {
  const config = await signalsFor(storeId);
  if (!config) return null;
  return (
    <>
      <SignalRuntime config={config} match={match} />
      {config.meta && (
        <noscript>
          {/* Official noscript fallback; `img-src` allows www.facebook.com (THIRD_PARTY). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img height={1} width={1} alt="" src={`https://www.facebook.com/tr?id=${encodeURIComponent(config.meta.pixelId)}&ev=PageView&noscript=1`} />
        </noscript>
      )}
    </>
  );
}
