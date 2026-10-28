import { ShellNotice } from "@/components/admin-shell";
import type { PlatformCapability } from "@bukalaris/db";

/** Denied state of an Owner console page (IAM-15): the operator is signed in but lacks the capability this page needs. */
export function AccessDenied({ capability }: { capability: PlatformCapability }) {
  return (
    <ShellNotice title="Akses ditolak.">
      Halaman ini butuh izin <code>{capability}</code>. Minta staf pengelola akses untuk memberikannya jika Anda memerlukannya.
    </ShellNotice>
  );
}
