import { Notice } from "@/components/notice";
import { portalCsrfToken } from "@/lib/auth-csrf";
import { CsrfField } from "@/lib/auth-csrf-form";
import { SubmitButton } from "@/components/submit-button";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { currentUser } from "@/lib/context";
import { db, previewInvitation } from "@bukalaris/db";
import Link from "next/link";
import { signOut } from "../../login/actions";
import { acceptAsCurrentUser } from "../actions";
import { NewAccountForm } from "./new-account-form";

export const metadata = { title: "Undangan toko — Bukalaris" };

const closed: Record<"invalid" | "accepted" | "revoked" | "expired", string> = {
  invalid: "Tautan undangan tidak dikenal. Periksa kembali tautan dari email Anda.",
  accepted: "Undangan ini sudah dipakai. Jika itu Anda, silakan masuk.",
  revoked: "Undangan ini sudah dibatalkan oleh pemilik toko.",
  expired: "Undangan ini sudah kedaluwarsa. Minta pemilik toko mengirim undangan baru.",
};

export default async function InvitePage({ params, searchParams }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  const { error } = await searchParams;
  const inv = await previewInvitation(db(), token);
  const user = await currentUser();
  const csrfToken = user ? await portalCsrfToken() : null;
  const roleLabel = inv.status === "pending" && inv.role === "owner" ? "pemilik" : "staf";

  return (
    <main className="flex flex-1 items-start justify-center p-4 sm:items-center">
      <Card className="w-full max-w-md">
        <CardContent className="grid gap-4">
          <h1 className="text-xl font-semibold">Undangan toko</h1>
          {inv.status !== "pending" ? (
            <>
              <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{closed[inv.status]}</p>
              <Link href="/login" className="inline-flex min-h-6 w-fit items-center rounded-sm py-1 text-sm underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">Ke halaman masuk</Link>
            </>
          ) : (
            <>
              <p className="text-sm">
                Anda diundang menjadi <span className="font-medium">{roleLabel}</span> toko{" "}
                <span className="font-medium">{inv.storeName}</span> untuk alamat <span className="font-medium">{inv.email}</span>.
              </p>
              <Notice error={error} />
              {user ? (
                user.email.toLowerCase() === inv.email ? (
                  <form action={acceptAsCurrentUser.bind(null, token)}>
                    <CsrfField token={csrfToken} />
                    <SubmitButton pendingText="Bergabung…">Gabung ke {inv.storeName}</SubmitButton>
                  </form>
                ) : (
                  <>
                    <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                      Anda sedang masuk sebagai {user.email}. Undangan ini ditujukan ke {inv.email}; keluar dulu lalu masuk dengan alamat tersebut.
                    </p>
                    <form action={signOut}>
                      <CsrfField token={csrfToken} />
                      <Button type="submit" variant="outline">Keluar</Button>
                    </form>
                  </>
                )
              ) : inv.hasAccount ? (
                <>
                  <p className="text-sm text-muted-foreground">Alamat ini sudah punya akun Bukalaris. Masuk untuk menerima undangan.</p>
                  <Link href={`/login?next=/invite/${encodeURIComponent(token)}`} className={buttonVariants()}>Masuk untuk menerima</Link>
                </>
              ) : (
                <NewAccountForm token={token} email={inv.email} />
              )}
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
