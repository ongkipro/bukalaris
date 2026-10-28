// T-48 entry gate applies to EVERY real provider call, including reads and sandbox. A boolean write switch is not rotation evidence.
export const MENGANTAR_ENTRY_GATE_MESSAGE = "Bukalaris Kirim: provider access is locked pending Partner Secret rotation and revocation evidence.";
export class MengantarEntryGateError extends Error {
  readonly code = "partner_secret_unrotated";
  constructor() { super(MENGANTAR_ENTRY_GATE_MESSAGE); this.name = "MengantarEntryGateError"; }
}
export function mengantarRotationRecorded(env: NodeJS.ProcessEnv = process.env, now = Date.now()): boolean {
  const value = env.MENGANTAR_PARTNER_SECRET_ROTATED_AT;
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= now && parsed > 0 && env.MENGANTAR_PARTNER_OLD_SECRET_REVOKED === "1";
}
export function requireMengantarEntryGate(env: NodeJS.ProcessEnv = process.env): void {
  if (!mengantarRotationRecorded(env)) throw new MengantarEntryGateError();
}
