import { ConfirmSubmit } from "@/components/confirm-submit";
import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { consoleGate } from "@/lib/console-gate";
import { allowed } from "@/lib/context";
import { storeStatusLabel, storeStatusTone } from "@/lib/status";
import { listStores } from "@bukalaris/db";
import Link from "next/link";
import { AccessDenied } from "../access-denied";
import { setStoreStatusAction } from "./actions";

export const metadata = { title: "Toko" };

export default async function AdminStoresPage({ searchParams }: PageProps<"/admin/stores">) {
  const g = await consoleGate("/admin/stores");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  const { error, saved } = await searchParams;
  const stores = await allowed(listStores(g.op));
  if (stores === undefined) return <AccessDenied capability="tenants.read" />;
  return (
    <section className="grid gap-6">
      <PageHeader
        title="Toko"
        description="Semua toko di platform. Menangguhkan toko menutup Seller Admin dan storefront-nya sampai diaktifkan kembali; setiap perubahan tercatat di audit dengan alasannya."
        action={<Link href="/admin/stores/new" className={buttonVariants()}>Buat toko</Link>}
      />
      <Notice error={error} saved={saved} />
      {stores.length === 0 ? (
        <EmptyState title="Belum ada toko" action={<Link href="/admin/stores/new" className={buttonVariants({ variant: "outline" })}>Buat toko pertama</Link>}>
          Toko dibuat oleh operator untuk pemilik yang sudah punya akun.
        </EmptyState>
      ) : (
        <ul className="grid gap-3">
          {stores.map((s) => {
            const next = s.status === "active" ? "suspended" : "active";
            return (
              <li key={s.id} className="grid gap-3 rounded-lg border p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/admin/stores/${s.id}`} className="font-medium underline-offset-4 hover:underline">{s.name}</Link>
                    <StatusBadge label={storeStatusLabel[s.status]} tone={storeStatusTone[s.status]} />
                  </div>
                  <p className="text-sm text-muted-foreground tabular-nums">
                    /{s.slug} · ID {s.id} · {s.products} produk
                  </p>
                </div>
                <form action={setStoreStatusAction.bind(null, s.id, next)} className="flex flex-wrap items-center gap-2">
                  <label htmlFor={`reason-${s.id}`} className="sr-only">Alasan untuk {s.name}</label>
                  <Input id={`reason-${s.id}`} name="reason" required minLength={5} maxLength={500} placeholder="Alasan (wajib, tercatat di audit)" className="w-64 max-w-full" />
                  {next === "suspended" ? (
                    <ConfirmSubmit variant="destructive" message={`Tangguhkan toko "${s.name}"? Seller Admin dan storefront /${s.slug} langsung tertutup untuk pembeli sampai diaktifkan kembali.`}>
                      Tangguhkan
                    </ConfirmSubmit>
                  ) : (
                    <SubmitButton pendingText="Mengaktifkan…">Aktifkan kembali</SubmitButton>
                  )}
                </form>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
