import { Notice } from "@/components/notice";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { sellerScope } from "@/lib/context";
import { can, listChannels } from "@bukalaris/db";
import { revokeChannelAction } from "./actions";
import { CreateChannelForm } from "./create-channel-form";

const when = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" });
const STATE = { active: "Aktif", expired: "Kedaluwarsa", revoked: "Dicabut" } as const;

/** SC-21: headless channels and their private tokens (owner only, IAM-11). */
export default async function ChannelsPage({ searchParams }: PageProps<"/seller/channels">) {
  const { error, saved } = await searchParams;
  const scope = await sellerScope();
  if (!can(scope, "integrations.manage")) {
    return (
      <section>
        <h1 className="mb-1 text-2xl font-semibold">Channel</h1>
        <p role="alert" className="text-sm text-muted-foreground">Hanya pemilik toko yang dapat mengelola channel dan token API.</p>
      </section>
    );
  }
  const channels = await listChannels(scope);
  return (
    <section className="grid gap-6">
      <div>
        <h1 className="mb-1 text-2xl font-semibold">Channel</h1>
        <p className="text-sm text-muted-foreground">
          Storefront eksternal memanggil Storefront API dengan token channel dari backend-nya (jangan di browser). Token hanya memberi akses
          katalog terbit, keranjang dan handoff ke checkout Bukalaris untuk toko ini.
        </p>
      </div>
      <Notice error={error} saved={saved} />
      <CreateChannelForm />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Nama</TableHead>
            <TableHead>Origin + path kembali</TableHead>
            <TableHead>Token</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Aksi</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {channels.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-muted-foreground">Belum ada channel.</TableCell>
            </TableRow>
          )}
          {channels.map((c) => (
            <TableRow key={c.id} data-testid={`channel-${c.id}`}>
              <TableCell>{c.name}</TableCell>
              <TableCell className="font-mono text-xs break-all">{c.origin}{c.returnPath}</TableCell>
              <TableCell className="font-mono text-xs">blsk_{c.tokenPrefix}_…</TableCell>
              <TableCell>
                {STATE[c.state]}
                {c.state !== "revoked" && c.expiresAt && <span className="block text-xs text-muted-foreground">s/d {when.format(c.expiresAt)}</span>}
                {c.revokedAt && <span className="block text-xs text-muted-foreground">{when.format(c.revokedAt)}</span>}
              </TableCell>
              <TableCell className="text-right">
                {c.state !== "revoked" && (
                  <form action={revokeChannelAction.bind(null, c.id)}>
                    <Button type="submit" size="sm" variant="outline" aria-label={`Cabut ${c.name}`}>Cabut</Button>
                  </form>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
