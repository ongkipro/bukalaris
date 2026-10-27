import "server-only";
import { db, feedItems, limitFeedFetch, resolveFeedToken, type FeedItem, type StorefrontScope } from "@bukalaris/db";

/**
 * Token-protected catalog feeds (T-40). The token in the path is the only credential: a bad,
 * revoked or foreign-format token and a suspended store all answer the same 404 with no body.
 * A valid token past its hourly budget gets 429 + Retry-After. Responses are cacheable only
 * briefly (stock changes) and never indexed.
 */
export async function feedResponse(
  token: string,
  contentType: string,
  render: (items: FeedItem[], scope: StorefrontScope) => string,
): Promise<Response> {
  const scope = await resolveFeedToken(db(), token);
  if (!scope) return new Response(null, { status: 404 });
  const retryAfter = await limitFeedFetch(db(), scope);
  if (retryAfter !== null) return new Response(null, { status: 429, headers: { "Retry-After": String(retryAfter) } });
  const { items } = await feedItems(scope);
  return new Response(render(items, scope), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=300",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
