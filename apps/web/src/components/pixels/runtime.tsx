"use client";

import type { BrowserSignals, SignalEventName } from "@bukalaris/db";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

// Browser leg of the ad signals (T-38, PR-20). Each pixel is initialised ONCE per page
// load (module state survives client-side navigation; `fbq('init')` is never repeated for
// a Purchase), advanced matching goes into that init when the page knows the buyer, and
// every funnel event carries the `event_id` the server leg uses. Scripts are injected by
// this (nonce-trusted) bundle, which `'strict-dynamic'` allows; hosts are also listed in
// lib/security-headers.ts THIRD_PARTY as the fallback. Nothing here runs in seller/admin.

export type Match = { ph62?: string; phE164?: string; fn?: string; ln?: string };
export type Item = { id: string; quantity: number; price: number };
type Fn = (...args: unknown[]) => void;
type Queued = Fn & { callMethod?: Fn; queue: unknown[]; push: unknown; loaded: boolean; version: string };
declare global {
  interface Window {
    fbq?: Queued;
    _fbq?: Queued;
    ttq?: Record<string, unknown> & { track: Fn; page: Fn; identify: Fn; load: Fn };
    TiktokAnalyticsObject?: string;
    gtag?: Fn;
    dataLayer?: unknown[];
  }
}

export const CLICK_COOKIE = "bl_click";
const CLICK_IDS = ["fbclid", "ttclid", "gclid", "gbraid", "wbraid"] as const;
const UTM = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
/** EEA + UK + Switzerland: Google consent defaults denied there (PR-20 "Consent"; no banner in Indonesia v1). */
const CONSENT_DENIED_REGIONS = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "IS", "LI", "NO", "GB", "CH",
];
const GA_EVENT: Record<SignalEventName, string> = { ViewContent: "view_item", AddToCart: "add_to_cart", InitiateCheckout: "begin_checkout", Purchase: "purchase" };

const inited = { meta: new Set<string>(), tiktok: new Set<string>(), google: new Set<string>() };
let config: BrowserSignals | null = null;
let clickCaptured = false;

function loadScript(src: string) {
  const s = document.createElement("script");
  s.async = true;
  s.src = src;
  document.head.appendChild(s);
}

/** Landing capture: last ad click wins, 30 days, first-party. Only when the URL carries an ad id or utm. */
function captureClick() {
  if (clickCaptured) return;
  clickCaptured = true;
  const q = new URLSearchParams(location.search);
  const click: Record<string, unknown> = {};
  for (const k of CLICK_IDS) {
    const v = q.get(k);
    if (v && /^[A-Za-z0-9_.:-]{1,255}$/.test(v)) click[k] = v;
  }
  const utm: Record<string, string> = {};
  for (const k of UTM) {
    const v = q.get(k);
    if (v) utm[k.slice(4)] = v.slice(0, 200);
  }
  if (Object.keys(click).length === 0 && Object.keys(utm).length === 0) return;
  if (Object.keys(utm).length) click.utm = utm;
  click.t = Date.now();
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${CLICK_COOKIE}=${encodeURIComponent(JSON.stringify(click))}; Max-Age=${30 * 24 * 3600}; Path=/; SameSite=Lax${secure}`;
}

/** Idempotent: initialise every enabled pixel exactly once per page load. */
export function ensureInit(cfg: BrowserSignals, match?: Match) {
  config = cfg;
  captureClick();
  if (cfg.meta && !inited.meta.has(cfg.meta.pixelId)) {
    inited.meta.add(cfg.meta.pixelId);
    if (!window.fbq) {
      // Official base code (https://developers.facebook.com/docs/meta-pixel/get-started), written out.
      const n = function (this: unknown, ...args: unknown[]) {
        if (n.callMethod) n.callMethod(...args);
        else n.queue.push(args);
      } as unknown as Queued;
      n.queue = [];
      n.push = n;
      n.loaded = true;
      n.version = "2.0";
      window.fbq = n;
      window._fbq ??= n;
      loadScript("https://connect.facebook.net/en_US/fbevents.js");
    }
    const am = match && (match.ph62 || match.fn || match.ln) ? { ...(match.ph62 ? { ph: match.ph62 } : {}), ...(match.fn ? { fn: match.fn } : {}), ...(match.ln ? { ln: match.ln } : {}) } : undefined;
    if (am) window.fbq("init", cfg.meta.pixelId, am);
    else window.fbq("init", cfg.meta.pixelId);
  }
  if (cfg.tiktok && !inited.tiktok.has(cfg.tiktok.pixelId)) {
    inited.tiktok.add(cfg.tiktok.pixelId);
    if (!window.ttq) {
      // Official base code (TikTok Events Manager snippet), written out.
      const t = "ttq";
      window.TiktokAnalyticsObject = t;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vendor queue stub shape
      const ttq: any = [];
      ttq.methods = ["page", "track", "identify", "instances", "debug", "on", "off", "once", "ready", "alias", "group", "enableCookie", "disableCookie", "holdConsent", "revokeConsent", "grantConsent"];
      ttq.setAndDefer = (target: unknown[] & Record<string, unknown>, method: string) => {
        target[method] = (...args: unknown[]) => target.push([method, ...args]);
      };
      for (const m of ttq.methods) ttq.setAndDefer(ttq, m);
      ttq.instance = (id: string) => {
        const e = ttq._i[id] ?? [];
        for (const m of ttq.methods) ttq.setAndDefer(e, m);
        return e;
      };
      ttq.load = (id: string, opts?: Record<string, unknown>) => {
        const r = "https://analytics.tiktok.com/i18n/pixel/events.js";
        ttq._i = ttq._i ?? {};
        ttq._i[id] = [];
        ttq._i[id]._u = r;
        ttq._t = ttq._t ?? {};
        ttq._t[id] = Date.now();
        ttq._o = ttq._o ?? {};
        ttq._o[id] = opts ?? {};
        loadScript(`${r}?sdkid=${id}&lib=${t}`);
      };
      window.ttq = ttq;
    }
    window.ttq!.load(cfg.tiktok.pixelId);
  }
  if (cfg.google && !inited.google.has(cfg.google.tagId)) {
    inited.google.add(cfg.google.tagId);
    if (!window.gtag) {
      // Official snippet (https://developers.google.com/tag-platform/gtagjs/install) with Consent Mode v2 defaults
      // placed before config, per https://developers.google.com/tag-platform/security/guides/consent.
      window.dataLayer = window.dataLayer ?? [];
      window.gtag = function () {
        // eslint-disable-next-line prefer-rest-params
        window.dataLayer!.push(arguments);
      };
      window.gtag("consent", "default", { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "denied", region: CONSENT_DENIED_REGIONS });
      window.gtag("consent", "default", { ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted", analytics_storage: "granted" });
      loadScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(cfg.google.tagId)}`);
      window.gtag("js", new Date());
    }
    window.gtag("config", cfg.google.tagId);
  }
}

export function pageView() {
  if (config?.meta && window.fbq) window.fbq("track", "PageView");
  if (config?.tiktok && window.ttq) window.ttq.page();
}

/** Fire one funnel event on every enabled destination with the shared `event_id`. */
export function fire(name: SignalEventName, eventId: string, data: { items: Item[]; value: number; orderId?: string }, match?: Match) {
  if (!config) return;
  const ids = data.items.map((i) => i.id);
  if (config.meta && window.fbq) {
    window.fbq(
      "track",
      name,
      {
        value: data.value,
        currency: "IDR",
        content_type: "product",
        content_ids: ids,
        contents: data.items.map((i) => ({ id: i.id, quantity: i.quantity, item_price: i.price })),
        ...(name === "InitiateCheckout" || name === "Purchase" ? { num_items: data.items.reduce((n, i) => n + i.quantity, 0) } : {}),
        ...(data.orderId ? { order_id: data.orderId } : {}),
      },
      { eventID: eventId },
    );
  }
  if (config.tiktok && window.ttq) {
    if (match?.phE164) window.ttq.identify({ phone_number: match.phE164 });
    window.ttq.track(
      name,
      {
        contents: data.items.map((i) => ({ content_id: i.id, content_type: "product", quantity: i.quantity, price: i.price })),
        content_type: "product",
        value: data.value,
        currency: "IDR",
        ...(data.orderId ? { order_id: data.orderId } : {}),
      },
      { event_id: eventId },
    );
  }
  if (config.google && window.gtag) {
    const items = data.items.map((i) => ({ id: i.id, google_business_vertical: "retail", quantity: i.quantity, price: i.price }));
    if (name === "Purchase" && config.google.label && data.orderId) {
      if (match?.phE164) window.gtag("set", "user_data", { sha256_phone_number: match.phE164 });
      window.gtag("event", "conversion", { send_to: `${config.google.tagId}/${config.google.label}`, value: data.value, currency: "IDR", transaction_id: data.orderId });
    } else if (name !== "Purchase") {
      window.gtag("event", GA_EVENT[name], { send_to: config.google.tagId, value: data.value, currency: "IDR", items });
    }
  }
}

/** Mounted once per page (storefront layout, checkout pages): init + PageView per route. */
export function SignalRuntime({ config: cfg, match }: { config: BrowserSignals; match?: Match }) {
  const pathname = usePathname();
  useEffect(() => {
    ensureInit(cfg, match);
    pageView();
  }, [cfg, match, pathname]);
  return null;
}

/** Server-issued ids already fired in this page session (a remount must not re-fire a Purchase). */
const fired = new Set<string>();

/**
 * One funnel event. ViewContent/AddToCart ids are minted here; InitiateCheckout uses the
 * server-issued `checkout:<cart id>` so the multi-step (full-load) checkout page reports one
 * event per cart; all three are reported to `/api/signals` so the server leg shares the id.
 * The Purchase id (`purchase:<order>`) is server-issued and already enqueued (no report).
 */
export function SignalEvent({
  config: cfg,
  store,
  name,
  items,
  value,
  eventId,
  orderId,
  match,
  serverLeg = true,
}: {
  config: BrowserSignals;
  store: string;
  name: SignalEventName;
  items: Item[];
  value: number;
  eventId?: string;
  orderId?: string;
  match?: Match;
  /** false for the Purchase: the server enqueued its leg in the order transaction. */
  serverLeg?: boolean;
}) {
  // One fire per mounted instance (Strict Mode re-runs effects on the same instance), and
  // never twice for a server-issued id.
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current || (eventId && fired.has(eventId))) return;
    sent.current = true;
    if (eventId) fired.add(eventId);
    const id = eventId ?? crypto.randomUUID();
    ensureInit(cfg, match);
    fire(name, id, { items, value, ...(orderId ? { orderId } : {}) }, match);
    if (!serverLeg) return;
    void fetch("/api/signals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      keepalive: true,
      body: JSON.stringify({ store, event: name, eventId: id, items: items.map((i) => ({ id: i.id, quantity: i.quantity })), url: location.href }),
    }).catch(() => {});
  }, [cfg, store, name, items, value, eventId, orderId, match, serverLeg]);
  return null;
}
