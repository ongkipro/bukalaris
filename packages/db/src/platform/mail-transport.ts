import { z } from "zod";
import { surfaceOriginsFromEnv } from "./host.ts";

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** The provider implementation owns SMTP/HTTP details; no credentials or raw provider responses cross this boundary. */
export type MailDeliveryResult = { status: "accepted" | "bounced" | "failed"; messageId: string };
export type MailEnvelope = { idempotencyKey: string; from: string; to: string; subject: string; text: string; html?: string };
export interface MailTransport {
  readonly provider: string;
  /** Must honour signal. Retries use the SAME idempotencyKey; ambiguous outcomes must throw, never report failed. */
  send(envelope: MailEnvelope, options: { signal: AbortSignal }): Promise<MailDeliveryResult>;
}

type Environment = Record<string, string | undefined>;
export type MailConfiguration = { mode: "local" } | { mode: "provider"; provider: string; from: string; timeoutMs: number };
const providerName = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const MAIL_TRANSPORT_TIMEOUT_MS_DEFAULT = 30_000;

export function requireMailConfiguration(env: Environment = process.env): MailConfiguration {
  const mode = env.MAIL_MODE ?? (env.NODE_ENV === "production" ? "provider" : "local");
  if (mode === "local") {
    // Explicit local production-build harness only. DEV_OUTBOX alone must never change delivery mode.
    if (env.NODE_ENV === "production") {
      // Every surface origin must be loopback: since T-70 BETTER_AUTH_URL is only a fallback and the real origins are the *_ORIGIN variables.
      const origins = Object.values(surfaceOriginsFromEnv(env as NodeJS.ProcessEnv));
      const loopback = (origin: string) => {
        try { const host = new URL(origin).hostname; return LOOPBACK_HOSTS.includes(host) || host.endsWith(".localhost"); } catch { return false; } // *.localhost is loopback by RFC 6761 (host-mode e2e)
      };
      if (env.MAIL_MODE !== "local" || !origins.every(loopback)) throw new Error("local mail is forbidden outside the explicit loopback harness");
    }
    return { mode };
  }
  if (mode !== "provider") throw new Error("MAIL_MODE must be local or provider");
  const provider = providerName.safeParse(env.MAIL_PROVIDER);
  const from = z.email().safeParse(env.MAIL_FROM);
  const timeoutMs = Number(env.MAIL_TRANSPORT_TIMEOUT_MS ?? MAIL_TRANSPORT_TIMEOUT_MS_DEFAULT);
  if (!provider.success || !from.success) throw new Error("MAIL_PROVIDER and MAIL_FROM are required for provider delivery (Q-16)");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAIL_TRANSPORT_TIMEOUT_MS_DEFAULT) throw new Error("MAIL_TRANSPORT_TIMEOUT_MS must be 1..30000 (below the job lease)");
  return { mode, provider: provider.data, from: from.data, timeoutMs };
}

export function requireLocalMailMode(env: Environment = process.env): void {
  if (requireMailConfiguration(env).mode !== "local") throw new Error("dev outbox is unavailable in provider mode");
}

let installed: MailTransport | null = null;
/** Bootstrap hook for the owner-selected server-only adapter. No provider is selected implicitly (Q-16). */
export function setMailTransport(transport: MailTransport | null): void { installed = transport; }
export function configuredMailTransport(config: MailConfiguration): MailTransport | null {
  if (config.mode === "local") return null;
  if (!installed || installed.provider !== config.provider) throw new Error("configured mail provider has no installed transport (Q-16); refusing to start");
  return installed;
}

/** Deterministic fake at the provider boundary; never installed automatically, including in production. */
export class FakeMailTransport implements MailTransport {
  readonly provider = "fake";
  readonly sent: MailEnvelope[] = [];
  private readonly result: MailDeliveryResult["status"];
  constructor(result: MailDeliveryResult["status"] = "accepted") { this.result = result; }
  async send(envelope: MailEnvelope, { signal }: { signal: AbortSignal }): Promise<MailDeliveryResult> {
    signal.throwIfAborted();
    this.sent.push({ ...envelope });
    return { status: this.result, messageId: `fake-${envelope.idempotencyKey}` };
  }
}
