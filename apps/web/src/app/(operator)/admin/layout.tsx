import { signOut } from "@/app/(identity)/login/actions";
import { AdminShell, ShellNotice } from "@/components/admin-shell";
import { ReportIssue } from "@/components/report-issue";
import { operator } from "@/lib/context";
import { consoleNavigation } from "@bukalaris/db";
import { reportIssueAction } from "./issue-actions";

export const metadata = { title: { default: "Owner Console — Bukalaris", template: "%s — Bukalaris Owner" } };

// The navigation is derived from the route registry (docs/04 ARCH-5, `packages/db/src/ops/console-routes.ts`) and the
// operator's capabilities, re-read on every request: a group appears only with a permitted child, and dormant (P2, P1.5)
// items never appear. It decides only what is shown; every page and action runs the console gate itself.
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const { user, op, caps } = await operator();
  return (
    <AdminShell
      tone="platform"
      brand="Owner"
      home="/admin"
      email={user.email}
      signOut={signOut}
      navLabel="Owner console"
      groups={op ? consoleNavigation(caps) : []}
      actions={op && caps.includes("ops.issues.report") ? <ReportIssue surface="owner" submit={reportIssueAction} /> : undefined}
      context={op && <span className="rounded-md border border-current/30 px-2 py-0.5 text-xs">Owner console</span>}
    >
      {op ? children : <ShellNotice title="Akses ditolak.">Halaman ini khusus staf Owner console.</ShellNotice>}
    </AdminShell>
  );
}
