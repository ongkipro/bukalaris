import { createHmac, timingSafeEqual } from "node:crypto";
import { PaymentContractError } from "./contract.ts";

function signingSecret(secret: string | undefined): string {
  if (!secret || Buffer.byteLength(secret) < 32 || !secret.trim()) throw new PaymentContractError("configuration", "AutoLaris callback signing configuration missing or invalid");
  return secret;
}
export function callbackToken(reffId: string, secret: string | undefined = process.env.AUTOLARIS_CALLBACK_SECRET): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(reffId)) throw new PaymentContractError("identity", "invalid payment reference");
  return `${reffId}.${createHmac("sha256", signingSecret(secret)).update(`pay-callback:v1:${reffId}`).digest("hex").slice(0, 32)}`;
}
export function verifyCallbackToken(token: string | null, secret: string | undefined = process.env.AUTOLARIS_CALLBACK_SECRET): string {
  const key = signingSecret(secret); // fail closed even if both config and token are missing
  const match = token?.match(/^([A-Za-z0-9_-]{1,64})\.([a-f0-9]{32})$/);
  if (!match) throw new PaymentContractError("binding", "invalid signed reference");
  const expected = Buffer.from(callbackToken(match[1]!, key).split(".")[1]!, "hex");
  if (!timingSafeEqual(expected, Buffer.from(match[2]!, "hex"))) throw new PaymentContractError("binding", "invalid signed reference");
  return match[1]!;
}
