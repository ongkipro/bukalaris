import { Card, CardContent } from "@/components/ui/card";

export const metadata = { title: "Akun — Bukalaris" };

/** Centered single-card shell shared by the account flows (AU-02, MFA). */
export default function AccountLayout({ children }: LayoutProps<"/account">) {
  return (
    <main className="flex flex-1 items-start justify-center p-4 sm:items-center">
      <Card className="w-full max-w-md">
        <CardContent className="grid gap-4">{children}</CardContent>
      </Card>
    </main>
  );
}
