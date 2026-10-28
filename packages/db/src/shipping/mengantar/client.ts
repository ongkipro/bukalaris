import { MENGANTAR_ENTRY_GATE_MESSAGE, mengantarRotationRecorded } from "./gate.ts";
import type { z } from "zod";
import {
  areaListSchema,
  createOrderResponseSchema,
  envelopeSchema,
  orderLookupSchema,
  pickupAddressListSchema,
  rateMapSchema,
  receiverScoreSchema,
  type MengantarArea,
} from "./schemas.ts";

// Server-only Mengantar client (PR-5, T-34). The API key sits in the URL path,
// so every URL is redacted before it can reach a log or an error message, and
// this module must never be imported by browser code. Write operations spend
// balance / dispatch couriers: they throw unless MENGANTAR_WRITE_ENABLED=1
// (docs/TASKS.md provider rule; the flag is never set in this repository).

const DEFAULT_BASE = "https://api-public.mengantar.com";
const DEFAULT_TIMEOUT_MS = 8_000;
const READ_ATTEMPTS = 2; // one retry for idempotent reads on network error, timeout, 429 or 5xx

/** Replace the key segment of a keyed URL (and any other occurrence of the key) with a placeholder. */
export function redactUrl(url: string, apiKey?: string): string {
  let out = url.replace(/\/api\/public\/[^/?#]+/, "/api/public/**redacted**");
  if (apiKey) out = out.replaceAll(apiKey, "**redacted**");
  return out;
}

export type MengantarErrorCode =
  | "network"
  | "timeout"
  | "http"
  | "provider" // success:false envelope
  | "invalid_shape"
  | "write_disabled"
  | "entry_gate"; // Partner Secret rotation is not recorded (T-48 entry gate): no request of any kind leaves this process

export class MengantarError extends Error {
  readonly code: MengantarErrorCode;
  readonly status: number;
  /** Provider body with the key redacted; never contains the URL. */
  readonly body: unknown;
  /** Machine code from the provider body when present (e.g. COURIER_DISABLED, X001). */
  readonly providerCode?: string;
  constructor(code: MengantarErrorCode, message: string, status = 0, body?: unknown, providerCode?: string) {
    super(message);
    this.name = "MengantarError";
    this.code = code;
    this.status = status;
    this.body = body;
    this.providerCode = providerCode;
  }
}

export class MengantarWriteDisabledError extends MengantarError {
  constructor(operation: string) {
    super("write_disabled", `Mengantar write operation "${operation}" is disabled (MENGANTAR_WRITE_ENABLED is not 1).`);
    this.name = "MengantarWriteDisabledError";
  }
}

export type ClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Defaults to `process.env.MENGANTAR_WRITE_ENABLED === "1"`. Tests never set it. */
  writeEnabled?: boolean;
  /** Called per attempt with the redacted URL only. */
  onRequest?: (info: { method: string; url: string; attempt: number }) => void;
};

export type EstimateInput = {
  originAreaId: string;
  destinationAreaId: string;
  /** Whole kilograms, >= 1. */
  weightKg: number;
  /** COD value (goods + shipping); when set the account estimate includes `codFee`. */
  codAmount?: number;
};

type Query = Record<string, string | number | boolean | undefined>;

export class MengantarClient {
  readonly #apiKey: string;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #writeEnabled: boolean;
  readonly #onRequest?: ClientOptions["onRequest"];

  constructor(opts: ClientOptions) {
    if (!opts.apiKey) throw new Error("MengantarClient: apiKey is required");
    this.#apiKey = opts.apiKey;
    this.#base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#writeEnabled = opts.writeEnabled ?? process.env.MENGANTAR_WRITE_ENABLED === "1";
    this.#onRequest = opts.onRequest;
  }

  get writeEnabled(): boolean {
    return this.#writeEnabled;
  }

  // ── Reads (allowed against the real account) ─────────────────────────────

  /** Area search; `_id` of a row is the area id for estimates and pickup origins. */
  async searchArea(keyword: string): Promise<MengantarArea[]> {
    const k = keyword.trim();
    if (k.length < 3) return [];
    return this.#get(this.#keyed("/address/search", { keyword: k }), areaListSchema);
  }

  /** Registered pickup addresses of the platform account (`PICKUP_AUTOFILL` = area id). */
  listOrigins() {
    return this.#get(this.#keyed("/address"), pickupAddressListSchema);
  }

  /** Account estimate for all couriers: `GET /order/estimate?courier=all`. Keys are courier estimate keys. */
  estimateAll(p: EstimateInput) {
    return this.#get(
      this.#keyed("/order/estimate", {
        origin_id: p.originAreaId,
        destination_id: p.destinationAreaId,
        courier: "all",
        weight: Math.max(1, Math.round(p.weightKg)),
        COD_AMOUNT: p.codAmount,
      }),
      rateMapSchema,
    );
  }

  /** Raw 3PL tariff without account promos: `GET /api/order/allEstimate3PL` (no key in the path). */
  estimate3pl(p: Omit<EstimateInput, "codAmount">) {
    return this.#get(
      `${this.#base}/api/order/allEstimate3PL${qs({
        origin_id: p.originAreaId,
        destination_id: p.destinationAreaId,
        weight: Math.max(1, Math.round(p.weightKg)),
      })}`,
      rateMapSchema,
    );
  }

  /** Receiver delivery/RTS history for a phone number (T-35 input). */
  getReceiverScore(phone: string) {
    return this.#get(this.#keyed("/getReceiverScoreByNumberUser", { search: phone }), receiverScoreSchema);
  }

  /**
   * Order lookup / tracking (T-39): `GET /order?order_id=…` or `?tracking_id=…`. The shape of
   * `data` is UNVERIFIED (list or single object); `mengantar/booking.ts` normalises it.
   */
  getOrder(ref: { providerOrderId?: string | null; trackingNumber?: string | null }) {
    const query = ref.providerOrderId ? { order_id: ref.providerOrderId } : { tracking_id: ref.trackingNumber ?? undefined };
    return this.#get(this.#keyed("/order", query), orderLookupSchema);
  }

  // ── Writes (disabled unless MENGANTAR_WRITE_ENABLED=1) ───────────────────

  /** Returns the whole response body (`batch_id` and `errors` live beside `data`), parsed loosely. */
  async createOrder(payload: { courier: string; pickup: Record<string, unknown>; orders: Record<string, unknown>[] }) {
    return createOrderResponseSchema.parse(await this.#write("createOrder", "POST", this.#keyed("/order"), payload, true));
  }
  upsertOrigin(input: Record<string, unknown>) {
    return this.#write("upsertOrigin", "POST", this.#keyed("/address"), input);
  }
  deleteAddress(id: string) {
    return this.#write("deleteAddress", "DELETE", this.#keyed("/address"), { id });
  }
  addPickupTime(input: { address_id: string; date: string; time: string }) {
    return this.#write("addPickupTime", "POST", this.#keyed("/time"), input);
  }
  payUnpaid(batchId: string, courier?: string) {
    return this.#write("payUnpaid", "POST", this.#keyed("/order/pay-unpaid"), { batch_id: batchId, ...(courier && { courier }) });
  }
  addDropshipper(input: { name: string; phone: string }) {
    return this.#write("addDropshipper", "POST", this.#keyed("/dropshippers"), input);
  }
  deleteOrders(ids: string[], courier?: string) {
    return this.#write("deleteOrders", "DELETE", this.#keyed("/order"), { ids, ...(courier && { courier }) });
  }
  deleteBatch(id: string, courier?: string) {
    return this.#write("deleteBatch", "DELETE", this.#keyed("/batch"), { id, ...(courier && { courier }) });
  }

  // ── Internals ────────────────────────────────────────────────────────────

  #keyed(path: string, query: Query = {}): string {
    return `${this.#base}/api/public/${this.#apiKey}${path}${qs(query)}`;
  }

  #redact(s: string) {
    return redactUrl(s, this.#apiKey);
  }

  async #write(operation: string, method: string, url: string, body: unknown, raw = false): Promise<unknown> {
    if (!this.#writeEnabled) throw new MengantarWriteDisabledError(operation);
    return this.#request(method, url, { body, attempts: 1, raw });
  }

  async #get<T>(url: string, schema: z.ZodType<T>): Promise<T> {
    const data = await this.#request("GET", url, { attempts: READ_ATTEMPTS });
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new MengantarError("invalid_shape", `Mengantar response shape mismatch: ${parsed.error.issues[0]?.path.join(".") || "(root)"}`, 200, this.#sanitize(data));
    }
    return parsed.data;
  }

  /** Returns the envelope's `data` (or the whole body when there is no envelope, or when `raw`). */
  async #request(method: string, url: string, opts: { body?: unknown; attempts: number; raw?: boolean }): Promise<unknown> {
    if (!mengantarRotationRecorded()) throw new MengantarError("entry_gate", MENGANTAR_ENTRY_GATE_MESSAGE);
    let last: MengantarError | undefined;
    for (let attempt = 1; attempt <= opts.attempts; attempt++) {
      this.#onRequest?.({ method, url: this.#redact(url), attempt });
      try {
        return await this.#once(method, url, opts.body, opts.raw === true);
      } catch (err) {
        if (!(err instanceof MengantarError)) throw err;
        last = err;
        const retryable = err.code === "network" || err.code === "timeout" || err.status === 429 || err.status >= 500;
        if (!retryable || attempt === opts.attempts) throw err;
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
    throw last!;
  }

  async #once(method: string, url: string, body: unknown, raw: boolean): Promise<unknown> {
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method,
        headers: { Accept: "application/json", ...(body !== undefined && { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (e) {
      const timeout = e instanceof Error && e.name === "TimeoutError";
      throw new MengantarError(timeout ? "timeout" : "network", timeout ? `Mengantar timed out after ${this.#timeoutMs} ms` : `Mengantar request failed: ${this.#redact(e instanceof Error ? e.message : String(e))}`);
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      /* non-JSON body stays a string */
    }
    const env = envelopeSchema.safeParse(parsed);
    const envelope = env.success ? env.data : undefined;
    if (!res.ok || envelope?.success === false) {
      const message = envelope?.errorsFront || envelope?.message || `HTTP ${res.status}`;
      throw new MengantarError(res.ok ? "provider" : "http", `Mengantar: ${this.#redact(message)}`, res.status, this.#sanitize(parsed), detectCode(envelope));
    }
    return !raw && envelope && "data" in envelope ? envelope.data : parsed;
  }

  /** Body for errors/evidence: JSON round-trip with the key removed; never includes the URL. */
  #sanitize(body: unknown): unknown {
    if (body === undefined) return undefined;
    try {
      return JSON.parse(this.#redact(JSON.stringify(body)));
    } catch {
      return typeof body === "string" ? this.#redact(body) : undefined;
    }
  }
}

function qs(params: Query): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

function detectCode(env: z.infer<typeof envelopeSchema> | undefined): string | undefined {
  if (!env) return undefined;
  if (typeof env.code === "string") return env.code;
  const m = `${JSON.stringify(env.errors ?? "")} ${env.message ?? ""}`.match(/\bX00[0-3]\b/);
  return m?.[0];
}
