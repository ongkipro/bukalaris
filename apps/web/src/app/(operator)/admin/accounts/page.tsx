import { PageHeader } from "@/components/page-header";
import { consoleGate } from "@/lib/console-gate";
import { AccessDenied } from "../access-denied";
import { SearchForm } from "./search-form";

export const metadata = { title: "Cari akun" };

export default async function AccountsPage() {
  const g = await consoleGate("/admin/accounts");
  if (!g.ok) return <AccessDenied capability={g.capability} />;
  return (
    <section className="grid gap-6">
      <PageHeader title="Cari akun" description="Cari anggota tim seller dengan email, nomor ponsel atau ID akun. Hasilnya disamarkan; kueri Anda dikirim sebagai POST dan tidak disimpan di URL, log atau audit." />
      <SearchForm />
    </section>
  );
}
