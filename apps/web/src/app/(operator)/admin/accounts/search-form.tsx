"use client";

import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import Link from "next/link";
import { useActionState } from "react";
import { searchAccountsAction, type SearchState } from "./actions";

const INITIAL: SearchState = { result: null, problem: null, searched: false };

/** The search box and its masked results. The query goes out as a POST body and is never kept in a URL or echoed back. */
export function SearchForm() {
  const [state, action] = useActionState(searchAccountsAction, INITIAL);
  const { result, problem } = state;
  return (
    <>
      <form action={action} role="search" className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="grid gap-1.5">
          <Label htmlFor="q">Email, nomor ponsel atau ID akun</Label>
          <Input id="q" name="q" type="search" minLength={3} maxLength={254} required autoComplete="off" spellCheck={false} />
        </div>
        <SubmitButton pendingText="Mencari…">Cari</SubmitButton>
      </form>
      {problem && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">{problem}</p>}
      {result && (
        <>
          <p className="rounded-lg border bg-muted/30 px-3 py-2 text-sm text-muted-foreground" data-testid="buyer-note">
            {result.buyerResults === "needs_case_and_purpose" ? "Hasil pembeli butuh kasus terbuka dan tujuan pada pencarian itu sendiri; tanpa itu hanya akun seller yang dicari." : "Akun pembeli belum tersedia."}
          </p>
          {result.hits.length === 0 ? (
            <EmptyState title="Tidak ada akun yang cocok">Periksa ejaan atau coba ID akun. Akun staf Owner console tidak muncul di sini.</EmptyState>
          ) : (
            <ul className="divide-y rounded-lg border text-sm" aria-label="Hasil pencarian">
              {result.hits.map((h) => (
                <li key={`${h.kind}-${h.id}`} className="grid gap-1 p-3 sm:grid-cols-[6rem_minmax(0,1fr)_auto] sm:items-center sm:gap-4">
                  <Badge variant="outline" className="w-fit">Seller</Badge>
                  <span className="flex flex-wrap items-center gap-2 min-w-0 break-words" data-testid="hit">
                    <span>{h.maskedName} <span className="text-muted-foreground">· {h.maskedEmail} · {h.memberships} toko{h.status === "suspended" ? " · ditangguhkan" : ""}</span></span>
                    <StatusBadge label={h.status === "suspended" ? "Ditangguhkan" : "Aktif"} tone={h.status === "suspended" ? "destructive" : "success"} />
                  </span>
                  <Link href={`/admin/accounts/${h.kind}/${h.id}`} className="font-medium underline underline-offset-4">Buka rekam</Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
