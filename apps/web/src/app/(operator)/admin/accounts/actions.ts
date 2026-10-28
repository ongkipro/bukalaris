"use server";

import { consoleActionOp } from "@/lib/console-gate";
import { userError, withError } from "@/lib/errors";
import { savedKey } from "@/lib/governance";
import { DomainError, executeMfaReset, requestMfaReset, revealAccountField, revokeUserSessions, searchAccounts, setIdentitySuspension, startSupportRecovery, type AccountSearchResult } from "@bukalaris/db";
import { redirect } from "next/navigation";

const text = (f: FormData, k: string) => String(f.get(k) ?? "");
const base = (f: FormData) => ({ caseRef: text(f, "caseRef").trim(), reasonCode: text(f, "reasonCode") || "operator_decision", reason: text(f, "reason"), idempotencyKey: text(f, "idempotencyKey") });
const back = (userId: string) => `/admin/accounts/seller/${userId}`;

export async function revokeSessionsAction(userId: string, f: FormData) {
  let error: string | undefined;
  let saved: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/accounts/[kind]/[id]", "accounts.support");
    saved = savedKey(await revokeUserSessions(op, userId, base(f)));
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back(userId), error) : `${back(userId)}?saved=${saved}`);
}

/** The link goes to the contact on file through the outbox. This action never receives, returns or redirects with it. */
export async function startRecoveryAction(userId: string, f: FormData) {
  let error: string | undefined;
  let saved: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/accounts/[kind]/[id]", "accounts.support");
    saved = savedKey(await startSupportRecovery(op, userId, base(f)));
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back(userId), error) : `${back(userId)}?saved=${saved}`);
}

export async function suspendAction(userId: string, suspend: boolean, f: FormData) {
  let error: string | undefined;
  let saved: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/accounts/[kind]/[id]", "accounts.suspend");
    saved = savedKey(await setIdentitySuspension(op, userId, { ...base(f), suspend }));
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back(userId), error) : `${back(userId)}?saved=${saved}`);
}

export async function requestMfaResetAction(userId: string, f: FormData) {
  let error: string | undefined;
  let saved: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/accounts/[kind]/[id]", "accounts.support");
    saved = savedKey(await requestMfaReset(op, userId, base(f)));
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back(userId), error) : `${back(userId)}?saved=${saved}`);
}

/** Only the requester can execute, after a different holder approved (the approvals inbox). */
export async function executeMfaResetAction(userId: string, supportActionId: number) {
  let error: string | undefined;
  let saved: string | undefined;
  try {
    const { op } = await consoleActionOp("/admin/accounts/[kind]/[id]", "accounts.support");
    saved = savedKey(await executeMfaReset(op, supportActionId));
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back(userId), error) : `${back(userId)}?saved=${saved}`);
}

/** The value is never carried in the redirect: the page shows it from the open reveal window. */
export async function revealAction(userId: string, f: FormData) {
  let error: string | undefined;
  try {
    // The page capability gates the entry; the service itself requires accounts.reveal or a valid break-glass grant for this exact target and case.
    const { op } = await consoleActionOp("/admin/accounts/[kind]/[id]", "accounts.read");
    const grant = Number(text(f, "breakGlassGrantId"));
    await revealAccountField(op, "seller", userId, { field: text(f, "field"), purposeCode: text(f, "purposeCode"), caseRef: text(f, "caseRef").trim(), reason: text(f, "reason"), breakGlassGrantId: Number.isSafeInteger(grant) && grant > 0 ? grant : undefined });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back(userId), error) : `${back(userId)}?saved=reveal`);
}

export type SearchState = { result: AccountSearchResult | null; problem: string | null; searched: boolean };

/**
 * SA-23 search as a POST (a server action), not a GET: contact text in a URL ends up in browser history, referrers and the proxy's access
 * log, which would defeat "the raw query is never logged". The masked result travels back in the action response only.
 */
export async function searchAccountsAction(_prev: SearchState, f: FormData): Promise<SearchState> {
  const { op } = await consoleActionOp("/admin/accounts", "accounts.read");
  try {
    return { result: await searchAccounts(op, { query: text(f, "q") }), problem: null, searched: true };
  } catch (err) {
    // Expected refusals are shown; the query text is never echoed into the message.
    if (err instanceof DomainError && ["query_invalid", "rate_limited"].includes(err.code)) return { result: null, problem: err.message, searched: true };
    throw err;
  }
}
