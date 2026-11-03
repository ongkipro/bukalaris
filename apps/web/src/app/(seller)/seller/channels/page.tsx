import { ConfirmSubmit } from "@/components/confirm-submit";
import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { sellerScope } from "@/lib/context";
import { tanggal } from "@/lib/format";
import { channelStateLabel, channelStateTone } from "@/lib/status";
import { can, listChannels } from "@bukalaris/db";
import { revokeChannelAction } from "./actions";
import { CreateChannelForm } from "./create-channel-form";

export const metadata = { title: "Channel — Bukalaris" };

/** SC-21: headless channels and their private tokens (owner only, IAM-11). */
export default async function ChannelsPage({ searchParams }: PageProps<"/seller/channels">) {
  const { error, saved } = await searchParams;
  const scope = await sellerScope();
  if (!can(scope, "integrations.manage")) {
    return (
      <section className="grid gap-6">
        <PageHeader title="Channel" />
        <p role="alert" className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Hanya pemilik toko yang dapat mengelola channel dan token API.</p>
      </section>
    );
  }
  const channels = await listChannels(scope);
  return (
    <section className="grid max-w-3xl gap-6">
      <PageHeader
        title="Channel"
        description="Storefront eksternal memanggil Storefront API dengan token channel dari backend-nya (jangan di browser). Token hanya memberi akses katalog terbit, keranjang dan handoff ke checkout Bukalaris untuk toko ini."
      />
      <Notice error={error} saved={saved} />
      <CreateChannelForm />
      {channels.length === 0 ? (
        <EmptyState title="Belum ada channel">Buat satu di atas untuk storefront eksternal pertama Anda; token muncul sekali setelah dibuat.</EmptyState>
      ) : (
        <Table>
          <caption className="sr-only">Daftar channel</caption>
          <TableHeader>
            <TableRow>
              <TableHead>Nama</TableHead>
              <TableHead>Origin + path kembali</TableHead>
              <TableHead>Token</TableHead>
              <TableHead>Status</TableHead>
              <TableHead numeric><span className="sr-only">Aksi</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {channels.map((c) => (
              <TableRow key={c.id} data-testid={`channel-${c.id}`}>
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell className="max-w-[12rem] break-all whitespace-normal sm:max-w-xs"><span className="font-mono text-xs">{c.origin}{c.returnPath}</span></TableCell>
                <TableCell><span className="font-mono text-xs">blsk_{c.tokenPrefix}_…</span></TableCell>
                <TableCell>
                  <StatusBadge label={channelStateLabel[c.state]} tone={channelStateTone[c.state]} />
                  {c.state !== "revoked" && c.expiresAt && <span className="mt-1 block text-xs text-muted-foreground">s/d {tanggal(c.expiresAt)}</span>}
                  {c.revokedAt && <span className="mt-1 block text-xs text-muted-foreground">{tanggal(c.revokedAt)}</span>}
                </TableCell>
                <TableCell numeric>
                  {c.state !== "revoked" && (
                    <form action={revokeChannelAction.bind(null, c.id)}>
                      <ConfirmSubmit size="sm" variant="outline" aria-label={`Cabut ${c.name}`} message={`Cabut channel "${c.name}"? Storefront yang memakai token ini langsung berhenti bekerja dan token tidak bisa dipulihkan.`}>
                        Cabut
                      </ConfirmSubmit>
                    </form>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
