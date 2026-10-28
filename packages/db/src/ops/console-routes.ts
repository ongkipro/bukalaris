import { FOUR_EYES_MATRIX, type PlatformCapability } from "./schema-ops.ts";

export type ConsoleRoute = { path: string; pageId: string; capabilities: readonly PlatformCapability[]; phase: "P1" | "P1.5" | "P2"; group: string; label?: string };
const approvalCaps = [...new Set(FOUR_EYES_MATRIX.filter((r) => r.active).map((r) => r.capability))];
/** Exact templates, never prefixes: new pages and mutation entrypoints are closed until classified. */
export const CONSOLE_ROUTES: readonly ConsoleRoute[] = [
  { path: "/admin", pageId: "SA-14", capabilities: ["dashboard.read"], phase: "P1", group: "Ringkasan", label: "Dashboard" },
  { path: "/admin/approvals", pageId: "SA-28", capabilities: approvalCaps, phase: "P1", group: "Ringkasan", label: "Persetujuan" },
  { path: "/admin/cases", pageId: "SA-20", capabilities: ["cases.read"], phase: "P1", group: "Ringkasan", label: "Kasus" },
  { path: "/admin/cases/[id]", pageId: "SA-20", capabilities: ["cases.read"], phase: "P1", group: "Ringkasan" },
  { path: "/admin/stores", pageId: "SA-02", capabilities: ["tenants.read"], phase: "P1", group: "Toko", label: "Daftar toko" },
  { path: "/admin/stores/new", pageId: "SA-03", capabilities: ["tenants.manage"], phase: "P1", group: "Toko", label: "Tambah toko" },
  { path: "/admin/stores/[id]", pageId: "SA-03", capabilities: ["tenants.read"], phase: "P1", group: "Toko" },
  { path: "/admin/stores/[id]/verification", pageId: "SA-16", capabilities: ["tenants.verify"], phase: "P1", group: "Toko" },
  { path: "/admin/stores/[id]/ledger", pageId: "SA-17", capabilities: ["finance.read"], phase: "P1", group: "Toko" },
  { path: "/admin/risk", pageId: "SA-18", capabilities: ["tenants.read"], phase: "P1", group: "Toko", label: "Risiko toko" },
  { path: "/admin/accounts", pageId: "SA-23", capabilities: ["accounts.read"], phase: "P1", group: "Akun pengguna", label: "Cari akun" },
  { path: "/admin/accounts/[kind]/[id]", pageId: "SA-24", capabilities: ["accounts.read"], phase: "P1", group: "Akun pengguna" },
  { path: "/admin/shipping", pageId: "SA-07", capabilities: ["shipping.manage"], phase: "P1", group: "Keuangan", label: "Ongkir" },
  { path: "/admin/payouts", pageId: "SA-08", capabilities: ["payouts.process", "refunds.process"], phase: "P1", group: "Keuangan", label: "Pencairan dan refund" },
  { path: "/admin/payouts/[kind]/[id]", pageId: "SA-08", capabilities: ["payouts.process", "refunds.process"], phase: "P1", group: "Keuangan" },
  { path: "/admin/money", pageId: "SA-26", capabilities: ["finance.read"], phase: "P1", group: "Keuangan", label: "Ringkasan keuangan" },
  { path: "/admin/money/cod-reconciliation", pageId: "SA-53", capabilities: ["payouts.reconcile", "payouts.process"], phase: "P1", group: "Keuangan", label: "Rekonsiliasi COD" },
  { path: "/admin/money/cod-reconciliation/[batchId]", pageId: "SA-53", capabilities: ["payouts.reconcile"], phase: "P1", group: "Keuangan" },
  { path: "/admin/billing", pageId: "SA-09", capabilities: ["billing.read"], phase: "P1", group: "Keuangan", label: "Langganan" },
  { path: "/admin/billing/invoices/[id]", pageId: "SA-10", capabilities: ["billing.read"], phase: "P1", group: "Keuangan" },
  { path: "/admin/settings", pageId: "SA-34", capabilities: ["settings.manage"], phase: "P1", group: "Platform", label: "Pengaturan platform" },
  { path: "/admin/settings/providers", pageId: "SA-35", capabilities: ["providers.read"], phase: "P1", group: "Platform", label: "Kesehatan provider" },
  { path: "/admin/logs", pageId: "SA-05", capabilities: ["logs.read"], phase: "P1", group: "Operasional", label: "Log System" },
  { path: "/admin/logs/[id]", pageId: "SA-06", capabilities: ["logs.read"], phase: "P1", group: "Operasional" },
  { path: "/admin/ops", pageId: "SA-36", capabilities: ["ops.read", "ops.jobs.manage"], phase: "P1", group: "Operasional", label: "Kesehatan sistem" },
  { path: "/admin/audit", pageId: "SA-37", capabilities: ["audit.read"], phase: "P1", group: "Operasional", label: "Audit" },
  { path: "/admin/issues", pageId: "SA-50", capabilities: ["ops.issues.manage"], phase: "P1", group: "Operasional", label: "Laporan masalah" },
  { path: "/admin/issues/[id]", pageId: "SA-50", capabilities: ["ops.issues.manage"], phase: "P1", group: "Operasional" },
  { path: "/admin/issues/export", pageId: "HTTP-23", capabilities: ["ops.issues.manage"], phase: "P1", group: "Operasional" },
  { path: "/admin/staff", pageId: "SA-38", capabilities: ["staff.read", "staff.manage"], phase: "P1", group: "Staf dan akses", label: "Staf dan izin" },
  { path: "/admin/staff/[id]", pageId: "SA-38", capabilities: ["staff.read", "staff.manage"], phase: "P1", group: "Staf dan akses" },
  { path: "/admin/staff/break-glass", pageId: "SA-38", capabilities: ["break_glass.approve"], phase: "P1", group: "Staf dan akses", label: "Akses darurat" },
  { path: "/admin/staff/access-reviews", pageId: "SA-39", capabilities: ["access.review"], phase: "P1", group: "Staf dan akses", label: "Review akses" },
  { path: "/admin/domains", pageId: "SA-19", capabilities: ["tenants.manage"], phase: "P2", group: "Toko", label: "Domain" },
  { path: "/admin/updates", pageId: "SA-51", capabilities: ["updates.write"], phase: "P1.5", group: "Platform", label: "Apa yang baru" },
];
export const consoleRoute = (template: string) => CONSOLE_ROUTES.find((r) => r.path === template);
export function resolveConsolePath(pathname: string) {
  const path = pathname.split(/[?#]/, 1)[0] ?? "";
  // Static templates win over dynamic detail routes (e.g. new and access-reviews).
  return CONSOLE_ROUTES.find((r) => r.path === path) ?? CONSOLE_ROUTES.find((r) => r.path.includes("[") && new RegExp(`^${r.path.replace(/\[[^\]]+\]/g, "[A-Za-z0-9_-]+")}$`).test(path));
}
export function consoleNavigation(caps: readonly PlatformCapability[]) {
  const groups = new Map<string, { href: string; label: string }[]>();
  for (const route of CONSOLE_ROUTES) {
    if (route.phase !== "P1" || !route.label || !route.capabilities.some((c) => caps.includes(c))) continue;
    const items = groups.get(route.group) ?? [];
    items.push({ href: route.path, label: route.label });
    groups.set(route.group, items);
  }
  return [...groups].map(([label, items]) => ({ label, items }));
}
