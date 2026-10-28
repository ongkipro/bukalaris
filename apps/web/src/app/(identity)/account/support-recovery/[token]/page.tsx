import { SubmitButton } from "@/components/submit-button";
import { redeemSupportRecoveryAction } from "./actions";

export const metadata = { title: "Pemulihan akun — Bukalaris", robots: { index: false, follow: false } };

/**
 * Landing page of a support recovery link (AU-06). Opening the page changes nothing: the token is consumed only by the button, so a mail
 * scanner that prefetches the link cannot burn it. The page cannot tell a valid token from an invalid one before the button is pressed.
 */
export default async function SupportRecoveryPage({ params }: PageProps<"/account/support-recovery/[token]">) {
  const { token } = await params;
  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">Pemulihan akun</h1>
        <p className="mt-1 text-sm text-muted-foreground">Tim dukungan Bukalaris mengirim tautan ini atas permintaan Anda. Tekan tombol di bawah untuk melanjutkan mengatur kata sandi baru. Tautan hanya berlaku sekali.</p>
      </div>
      <form action={redeemSupportRecoveryAction.bind(null, token)}>
        <SubmitButton pendingText="Memeriksa…" className="w-full">Lanjutkan pemulihan</SubmitButton>
      </form>
    </>
  );
}
