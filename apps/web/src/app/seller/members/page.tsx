import { ConfirmSubmit } from "@/components/confirm-submit";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { sellerScope } from "@/lib/context";
import { tanggal } from "@/lib/format";
import { invitationStatusLabel, invitationStatusTone, roleLabel } from "@/lib/status";
import { can, listInvitations, listMembers } from "@bukalaris/db";
import { changeMemberAction, inviteMemberAction, revokeInvitationAction } from "../actions";

export const metadata = { title: "Anggota toko — Bukalaris" };

export default async function MembersPage({ searchParams }: PageProps<"/seller/members">) {
  const { error, saved } = await searchParams;
  const scope = await sellerScope();
  const members = await listMembers(scope);
  const manage = can(scope, "members.manage");
  const invitations = manage ? await listInvitations(scope) : [];
  return (
    <section className="grid gap-8">
      <div className="grid gap-6">
        <PageHeader
          title="Anggota toko"
          description={manage ? "Pemilik mengelola toko dan anggotanya; staf mengelola katalog, stok dan pesanan. Toko wajib punya minimal satu pemilik." : "Hanya pemilik yang dapat mengubah anggota."}
        />
        <Notice error={error} saved={saved} />
        <Table>
          <caption className="sr-only">Anggota toko</caption>
          <TableHeader>
            <TableRow>
              <TableHead>Nama</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Peran</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => (
              <TableRow key={m.userId}>
                <TableCell className="font-medium">{m.name}</TableCell>
                <TableCell className="text-muted-foreground">{m.email}</TableCell>
                <TableCell>
                  {manage ? (
                    <form action={changeMemberAction.bind(null, m.userId)} className="flex items-center gap-2">
                      <label htmlFor={`role-${m.userId}`} className="sr-only">Peran {m.name}</label>
                      <NativeSelect id={`role-${m.userId}`} name="role" defaultValue={m.role} className="w-44">
                        <option value="owner">{roleLabel.owner}</option>
                        <option value="staff">{roleLabel.staff}</option>
                        <option value="remove">Hapus dari toko</option>
                      </NativeSelect>
                      <ConfirmSubmit
                        size="sm"
                        variant="outline"
                        message={`Hapus ${m.name} (${m.email}) dari toko? Akses ke Seller Admin toko ini dicabut saat itu juga.`}
                        onlyWhen={{ field: "role", equals: "remove" }}
                      >
                        Terapkan
                      </ConfirmSubmit>
                    </form>
                  ) : (
                    roleLabel[m.role]
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {manage && (
        <section aria-labelledby="undang" className="grid gap-4">
          <div>
            <h2 id="undang" className="text-lg font-semibold">Undang anggota</h2>
            <p className="text-sm text-muted-foreground">Tautan undangan dikirim ke email, berlaku 7 hari dan hanya bisa dipakai sekali.</p>
          </div>
          <form action={inviteMemberAction} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
            <div className="grid gap-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input id="invite-email" name="email" type="email" autoComplete="off" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="invite-role">Peran</Label>
              <NativeSelect id="invite-role" name="role" defaultValue="staff" className="sm:w-36">
                <option value="staff">{roleLabel.staff}</option>
                <option value="owner">{roleLabel.owner}</option>
              </NativeSelect>
            </div>
            <SubmitButton pendingText="Mengirim…">Kirim undangan</SubmitButton>
          </form>

          <h3 className="text-sm font-medium">Undangan tertunda</h3>
          {invitations.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Tidak ada undangan tertunda.</p>
          ) : (
            <Table>
              <caption className="sr-only">Undangan tertunda</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Peran</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Berlaku sampai</TableHead>
                  <TableHead><span className="sr-only">Aksi</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invitations.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>{i.email}</TableCell>
                    <TableCell>{roleLabel[i.role]}</TableCell>
                    <TableCell>
                      <StatusBadge label={invitationStatusLabel[i.status]} tone={invitationStatusTone[i.status]} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <time dateTime={i.expiresAt.toISOString()}>{tanggal(i.expiresAt)}</time>
                    </TableCell>
                    <TableCell numeric>
                      <form action={revokeInvitationAction.bind(null, i.id)}>
                        <SubmitButton size="sm" variant="outline" aria-label={`Batalkan undangan ${i.email}`} pendingText="Membatalkan…">Batalkan</SubmitButton>
                      </form>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      )}
    </section>
  );
}
