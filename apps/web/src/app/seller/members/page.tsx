import { fieldClass, Notice } from "@/components/notice";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { sellerScope } from "@/lib/context";
import { can, listMembers } from "@bukalaris/db";
import { changeMemberAction } from "../actions";

export default async function MembersPage({ searchParams }: PageProps<"/seller/members">) {
  const { error, saved } = await searchParams;
  const scope = await sellerScope();
  const members = await listMembers(scope);
  const manage = can(scope, "members.manage");
  return (
    <section>
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
    </section>
  );
}
