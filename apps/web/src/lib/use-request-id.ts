"use client";

import { useSyncExternalStore } from "react";
import { REQUEST_ID_COOKIE } from "./request-id";

const RE = new RegExp(`(?:^|; )${REQUEST_ID_COOKIE}=([A-Za-z0-9_-]{8,64})`);
const subscribe = () => () => {};
/** The id is written by proxy.ts as a short-lived cookie so it survives a failed render (error boundaries are client-side). */
export function useRequestId() {
  return useSyncExternalStore(subscribe, () => document.cookie.match(RE)?.[1] ?? null, () => null);
}
