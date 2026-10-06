// Correlation id shared by proxy.ts, log.ts and the error pages. No imports:
// proxy.ts must stay free of server-only modules.
export const REQUEST_ID_HEADER = "x-request-id";
/** Readable by the client error boundary so support gets the id even when rendering failed. Not HttpOnly on purpose; carries no authority. */
export const REQUEST_ID_COOKIE = "bl_rid";
const RE = /^[A-Za-z0-9_-]{8,64}$/;
/** An inbound id is kept only in a strict shape (never trusted for anything but correlation). */
export const validRequestId = (v: string | null | undefined): v is string => typeof v === "string" && RE.test(v);
