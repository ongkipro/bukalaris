import { fieldClass, Notice } from "@/components/notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { sellerScope } from "@/lib/context";
import { can, listInvitations, listMembers } from "@bukalaris/db";
import { changeMemberAction, inviteMemberAction, revokeInvitationAction } from "../actions";

const fmt = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" });

export default async function MembersPage({ searchParams }: PageProps<"/seller/members">) {
  const { error, saved } = await searchParams;
  const scope = await sellerScope();
  const members = await listMembers(scope);
  const manage = can(scope, "members.manage");
  const invitations = manage ? await listInvitations(scope) : [];
  return (
    <section className="space-y-8">
      <div>
        <h1 className="mb-1 text-2xl font-semibold">Anggota toko</h1>
        <p className="mb-4 text-sm text-muted-foreground">
          {manage ? "Toko wajib punya minimal satu pemilik." : "Hanya pemilik yang dapat mengubah anggota."}
        </p>
        <Notice error={error} saved={saved} />
        <Table>
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
                <TableCell>{m.name}</TableCell>
                <TableCell>{m.email}</TableCell>
                <TableCell>
                  {manage ? (
                    <form action={changeMemberAction.bind(null, m.userId)} className="flex items-center gap-2">
                      <label htmlFor={`role-${m.userId}`} className="sr-only">Peran {m.name}</label>
                      <select id={`role-${m.userId}`} name="role" defaultValue={m.role} className={`${fieldClass} w-auto`}>
                        <option value="owner">Pemilik</option>
                        <option value="staff">Staf</option>
                        <option value="remove">Hapus dari toko</option>
                      </select>
                      <Button type="submit" size="sm" variant="outline">Terapkan</Button>
                    </form>
                  ) : m.role === "owner" ? "Pemilik" : "Staf"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {manage && (
        <div className="grid gap-4">
          <div>
            <h2 className="text-lg font-semibold">Undang anggota</h2>
            <p className="text-sm text-muted-foreground">Tautan undangan dikirim ke email, berlaku 7 hari dan hanya bisa dipakai sekali.</p>
          </div>
          <form action={inviteMemberAction} className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
            <div className="grid gap-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input id="invite-email" name="email" type="email" autoComplete="off" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="invite-role">Peran</Label>
              <select id="invite-role" name="role" defaultValue="staff" className={`${fieldClass} sm:w-auto`}>
                <option value="staff">Staf</option>
                <option value="owner">Pemilik</option>
              </select>
            </div>
            <Button type="submit">Kirim undangan</Button>
          </form>

          <h3 className="text-sm font-medium">Undangan tertunda</h3>
          {invitations.length === 0 ? (
            <p className="text-sm text-muted-foreground">Tidak ada undangan tertunda.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Peran</TableHead>
                  <TableHead>Berlaku sampai</TableHead>
                  <TableHead><span className="sr-only">Aksi</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invitations.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>{i.email}</TableCell>
                    <TableCell>{i.role === "owner" ? "Pemilik" : "Staf"}</TableCell>
                    <TableCell className={i.status === "expired" ? "text-destructive" : undefined}>
                      {i.status === "expired" ? "Kedaluwarsa" : fmt.format(i.expiresAt)}
                    </TableCell>
                    <TableCell>
                      <form action={revokeInvitationAction.bind(null, i.id)}>
                        <Button type="submit" size="sm" variant="outline" aria-label={`Batalkan undangan ${i.email}`}>Batalkan</Button>
                      </form>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      )}
    </section>
  );
}
