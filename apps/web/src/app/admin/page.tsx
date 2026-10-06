import { Notice } from "@/components/notice";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { operatorOrDeny } from "@/lib/context";
import { listStores } from "@bukalaris/db";
import Link from "next/link";
import { setStoreStatusAction } from "./actions";

export default async function AdminStoresPage({ searchParams }: PageProps<"/admin">) {
  const { error, saved } = await searchParams;
  const stores = await listStores(await operatorOrDeny());
  return (
    <section>
      <div className="mb-4 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Toko</h1>
        <Link href="/admin/stores/new" className={buttonVariants()}>Buat toko</Link>
      </div>
      <Notice error={error} saved={saved} />
      <ul className="grid gap-3">
        {stores.map((s) => {
          const next = s.status === "active" ? "suspended" : "active";
          return (
            <li key={s.id} className="grid gap-3 rounded-lg border p-4 md:grid-cols-[1fr_auto] md:items-center">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/admin/stores/${s.id}`} className="font-medium hover:underline">{s.name}</Link>
                  <Badge variant={s.status === "active" ? "default" : "destructive"}>
                    {s.status === "active" ? "Aktif" : "Ditangguhkan"}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  /{s.slug} · ID {s.id} · {s.products} produk
                </p>
              </div>
              <form action={setStoreStatusAction.bind(null, s.id, next)} className="flex flex-wrap items-center gap-2">
                <label htmlFor={`reason-${s.id}`} className="sr-only">Alasan untuk {s.name}</label>
                <Input id={`reason-${s.id}`} name="reason" required minLength={5} placeholder="Alasan (wajib, tercatat di audit)" className="w-64 max-w-full" />
                <Button type="submit" size="sm" variant={next === "suspended" ? "destructive" : "default"}>
                  {next === "suspended" ? "Tangguhkan" : "Aktifkan kembali"}
                </Button>
              </form>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
