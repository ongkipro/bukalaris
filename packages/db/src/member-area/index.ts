// Reserved non-public member-area module structure (T-112, ADR-0016 section 7 item 27).
// Holds NO tables, NO pages and NO handlers in the first release. Its paths are reserved in
// `platform/host.ts` and answer 404 on every host; absent from navigation, sitemap, feeds and API docs.
// Making any part of the member area reachable is a separate scheduled task (T-119, deferred).

export const RESERVED_MEMBER_AREA_PATHS = [
  "/member",
  "/members",
  "/buyer/members",
  "/seller/memberships",
] as const;
