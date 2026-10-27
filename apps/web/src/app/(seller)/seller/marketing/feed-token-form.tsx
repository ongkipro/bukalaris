"use client";

import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { useActionState } from "react";
import { createFeedTokenAction, type FeedTokenState } from "./actions";

/** Issue (or regenerate) the store's feed token; the two feed URLs are shown exactly once, in the action result. */
export function FeedTokenForm({ hasToken }: { hasToken: boolean }) {
  const [state, action, pending] = useActionState<FeedTokenState, FormData>(createFeedTokenAction, null);
  if (state?.urls) {
    return (
      <section role="status" aria-labelledby="feed-once" className="grid gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4">
        <h3 id="feed-once" className="font-medium">URL feed dibuat</h3>
        <p className="text-sm">
          Tempel URL ini di Commerce Manager (Meta) dan Merchant Center (Google) sebagai sumber data terjadwal. URL <strong>hanya ditampilkan sekali</strong>;
          jika hilang, buat ulang token lalu perbarui di kedua platform. Token lama berhenti bekerja seketika.
        </p>
        <dl className="grid gap-2 text-sm">
          <div className="grid gap-1">
            <dt className="text-muted-foreground">Meta (CSV)</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <code data-testid="feed-url-meta" className="min-w-0 flex-1 rounded-md bg-background p-2 text-xs break-all select-all">{state.urls.meta}</code>
              <CopyButton value={state.urls.meta} label="URL feed Meta" />
            </dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-muted-foreground">Google (RSS XML)</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <code data-testid="feed-url-google" className="min-w-0 flex-1 rounded-md bg-background p-2 text-xs break-all select-all">{state.urls.google}</code>
              <CopyButton value={state.urls.google} label="URL feed Google" />
            </dd>
          </div>
        </dl>
      </section>
    );
  }
  return (
    <form action={action} className="grid gap-2">
      {state?.error && (
        <p id="feed-error" role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">{state.error}</p>
      )}
      <Button
        type="submit"
        variant={hasToken ? "outline" : "default"}
        className="justify-self-start"
        disabled={pending}
        aria-busy={pending || undefined}
        aria-describedby={state?.error ? "feed-error" : undefined}
        onClick={(e) => {
          if (hasToken && !window.confirm("Buat ulang token feed? URL lama berhenti bekerja seketika dan harus diganti di Meta dan Google.")) e.preventDefault();
        }}
      >
        {pending ? "Membuat…" : hasToken ? "Buat ulang token feed" : "Buat token feed"}
      </Button>
    </form>
  );
}
