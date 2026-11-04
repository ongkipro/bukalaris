import { CsrfField } from "@/lib/auth-csrf-form";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createLandingPageAction } from "../actions";

export const metadata = { title: "Buat landing page — Bukalaris" };

export default async function NewLandingPagePage({ searchParams }: PageProps<"/seller/landing-pages/new">) {
  const { error } = await searchParams;
  return (
    <section className="grid max-w-3xl gap-6">
      <PageHeader back={{ href: "/seller/landing-pages", label: "Semua landing page" }} title="Buat landing page" description="Mulai dari judul dan alamat; blok dan tampilan diatur di langkah berikutnya. Halaman tersimpan sebagai draf sampai Anda publikasikan." />
      <Notice error={error} />
      <form action={createLandingPageAction} className="grid gap-6">
        <CsrfField />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="title">Judul</Label>
            <Input id="title" name="title" required maxLength={200} placeholder="Promo Kaos Katun" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="slug">Slug URL</Label>
            <Input id="slug" name="slug" required maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="promo-kaos" aria-describedby="slug-help" />
            <p id="slug-help" className="text-xs text-muted-foreground">Alamat: /lp/&lt;slug&gt;. Huruf kecil, angka dan tanda hubung; nama rute toko (products, cart, …) tidak bisa dipakai.</p>
          </div>
        </div>
        <div>
          <SubmitButton>Buat dan lanjut mengedit</SubmitButton>
        </div>
      </form>
    </section>
  );
}
