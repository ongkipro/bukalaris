import "server-only";
import { DomainError, issueSellerStepUp, limitStepUpAttempts, platformDb, recordSessionMfa, refundStepUpAttempt, type SellerProofBinding, type SellerScope } from "@bukalaris/db";
import { headers } from "next/headers";
import { authForHost } from "./auth";

/**
 * The seller's fresh second factor (IAM-9, D-19): the 6-digit code is verified by this surface's Better Auth instance against THIS request's session, the session is then
 * marked MFA-verified (the same record the verification hook writes), and a single-use proof bound to the scope's own session, the action and the subject is issued by the
 * database function that re-derives owner membership and the session's MFA freshness. The code is never stored; the session id never comes from a form (`scope.sessionId`).
 */
export async function stepUpWithCode(scope: SellerScope, code: string, binding: SellerProofBinding): Promise<string> {
  const h = await headers();
  const surface = authForHost(h.get("host"));
  const clean = code.replace(/\s/g, "");
  if (!surface || !scope.sessionId || !/^[0-9]{6}$/.test(clean)) throw new DomainError("reauth_required", "Masukkan kode verifikasi 6 angka dari aplikasi autentikator Anda.");
  await limitStepUpAttempts(scope); // every attempt counts, before the code is looked at (wave 3 review: no throttle existed for a logged-in session)
  try {
    await surface.auth.api.verifyTOTP({ body: { code: clean }, headers: h });
  } catch {
    throw new DomainError("reauth_required", "Kode verifikasi salah atau verifikasi dua langkah belum aktif. Aktifkan di Keamanan akun, lalu coba kode berikutnya.");
  }
  await refundStepUpAttempt(scope); // a correct code does not count against the lockout
  await recordSessionMfa(platformDb(), { sessionId: scope.sessionId, userId: scope.userId, method: "totp" });
  return issueSellerStepUp(scope, binding);
}
