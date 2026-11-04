import { Notice } from "@/components/notice";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoginForm } from "./login-form";

export const metadata = { title: "Masuk — Bukalaris" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next, error } = await searchParams;
  // Only internal destinations (no open redirect).
  const target =
    typeof next === "string" && /^\/(seller|admin|account\/security|invite\/[A-Za-z0-9_-]+)(\/[a-z0-9/-]*)?$/.test(next) ? next : "/seller";
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Masuk ke Bukalaris</CardTitle>
        </CardHeader>
        <CardContent>
          <Notice error={error} />
          <LoginForm next={target} />
        </CardContent>
      </Card>
    </main>
  );
}
