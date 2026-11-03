"use client";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";

// "Lapor masalah" (UX-22 "Issue reporting", T-62 slice 5). Everything this component sends is listed in the dialog before it
// is sent. The server (reportConsoleIssue) validates against a versioned schema, drops unknown keys, resolves the page id from
// the route registry and scrubs text; nothing here is trusted. No screenshot or attachment exists in Phase 1 (D-18).

type RequestEntry = { requestId: string; pathname: string; method: string; status: number; durationMs: number; outcome: "ok" | "failed" };
type ActionEntry = { name: string; code: string };
type ErrorEntry = { name: string; message: string };
type Diagnostics = { requests: RequestEntry[]; actions: ActionEntry[]; errors: ErrorEntry[] };
type Result = { ok: true; id: number } | { ok: false; message: string; field?: "description" | "category" | "severity" };
export type ReportIssueSubmit = (payload: unknown) => Promise<Result>;

const CATEGORIES = [
  ["no_response", "Tombol atau fungsi tidak merespons"],
  ["wrong_result", "Hasilnya salah"],
  ["error_message", "Muncul pesan error"],
  ["page_broken", "Halaman rusak"],
  ["other", "Lainnya"],
] as const;
const SEVERITIES = [
  ["low", "Rendah"],
  ["medium", "Sedang"],
  ["high", "Tinggi"],
  ["blocking", "Menghambat pekerjaan saya"],
] as const;

const keep = <T,>(list: T[], item: T, max: number) => {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
};

/** One buffer per page load, installed once: same-origin fetches (pages, server actions) and client errors, no URLs, bodies or headers. */
function diagnostics(): Diagnostics {
  const w = window as unknown as { __blDiag?: Diagnostics };
  if (w.__blDiag) return w.__blDiag;
  const d: Diagnostics = { requests: [], actions: [], errors: [] };
  w.__blDiag = d;
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const started = performance.now();
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const actionId = headers.get("next-action");
    const track = url.origin === location.origin;
    try {
      const res = await original(input, init);
      if (track) {
        const requestId = res.headers.get("x-request-id");
        const ok = res.status < 400;
        if (requestId && /^[A-Za-z0-9_-]{1,128}$/.test(requestId)) keep(d.requests, { requestId, pathname: url.pathname, method, status: res.status, durationMs: Math.round(performance.now() - started), outcome: ok ? "ok" : "failed" }, 20);
        if (actionId && !ok) keep(d.actions, { name: `action:${actionId.slice(0, 12)}`, code: String(res.status) }, 10);
      }
      return res;
    } catch (err) {
      if (track && actionId) keep(d.actions, { name: `action:${actionId.slice(0, 12)}`, code: "network" }, 10);
      throw err;
    }
  };
  window.addEventListener("error", (e) => keep(d.errors, { name: e.error instanceof Error ? e.error.name : "Error", message: String(e.message).slice(0, 500) }, 10));
  window.addEventListener("unhandledrejection", (e) => keep(d.errors, { name: e.reason instanceof Error ? e.reason.name : "UnhandledRejection", message: String(e.reason instanceof Error ? e.reason.message : e.reason).slice(0, 500) }, 10));
  return d;
}

type Pickable = { label: string; controlId?: string; role: string; name: string };
const ROLE_OF: Record<string, string> = { A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox" };
/** Interactive controls on the page, by accessible name only: never an input value, a data cell or a query string. */
function collectControls(): Pickable[] {
  const out: Pickable[] = [];
  const nodes = document.querySelectorAll<HTMLElement>("header a, header button, main a[href], main button, main input:not([type=hidden]), main select, main textarea");
  for (const el of nodes) {
    if (el.closest("dialog") || el.closest("td") || el.closest("[data-report-skip]")) continue;
    const labelled = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement ? el.labels?.[0]?.textContent : null;
    const isField = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
    const name = (el.getAttribute("aria-label") ?? labelled ?? (isField ? "" : el.textContent) ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!name) continue;
    const role = el instanceof HTMLInputElement ? (el.type === "checkbox" ? "checkbox" : el.type === "radio" ? "radio" : "textbox") : (ROLE_OF[el.tagName] ?? "control");
    const id = el.dataset.controlId;
    out.push({ label: `${name} (${role})`, controlId: id && /^[a-z][a-z0-9_.-]{0,79}$/.test(id) ? id : undefined, role, name });
    if (out.length >= 80) break;
  }
  return out;
}

export function ReportIssue({ submit, surface }: { submit: ReportIssueSubmit; surface: "owner" }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const requestId = useRef<string>("");
  const [description, setDescription] = useState("");
  const [include, setInclude] = useState(true);
  const [controls, setControls] = useState<Pickable[]>([]);
  const [picked, setPicked] = useState("");
  const [state, setState] = useState<{ kind: "idle" | "sending" | "done" | "error"; message?: string; field?: string; id?: number }>({ kind: "idle" });
  const [tech, setTech] = useState<Diagnostics>({ requests: [], actions: [], errors: [] });
  const uid = useId();

  useEffect(() => {
    diagnostics();
  }, []);

  function open() {
    if (!requestId.current) requestId.current = crypto.randomUUID();
    setControls(collectControls());
    const d = diagnostics();
    setTech({ requests: [...d.requests], actions: [...d.actions], errors: [...d.errors] });
    if (state.kind === "done") setState({ kind: "idle" });
    dialog.current?.showModal();
  }
  function close() {
    dialog.current?.close();
    trigger.current?.focus();
  }

  async function onSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const control = picked === "" ? undefined : controls[Number(picked)];
    const payload = {
      schemaVersion: 1,
      clientRequestId: requestId.current,
      surface,
      pathname: location.pathname,
      category: form.get("category"),
      severity: form.get("severity"),
      description,
      ...(control ? { controlId: control.controlId, controlRole: control.role, controlName: control.name } : {}),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      recentRequests: include ? tech.requests : [],
      failedActions: include ? tech.actions : [],
      recentClientErrors: include ? tech.errors : [],
      partial: !include,
    };
    setState({ kind: "sending" });
    let result: Result;
    try {
      result = await submit(payload);
    } catch {
      result = { ok: false, message: "Laporan belum terkirim. Teks Anda tetap tersimpan; coba lagi." };
    }
    if (result.ok) {
      setState({ kind: "done", id: result.id });
      setDescription("");
      setPicked("");
      requestId.current = "";
      formEl.reset();
      close();
    } else setState({ kind: "error", message: result.message, field: result.field });
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={open}
        data-control-id="shell.report-issue"
        className="inline-flex h-7 items-center rounded-lg bg-secondary px-2.5 text-[0.8rem] font-medium text-secondary-foreground outline-none hover:bg-secondary/80 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        Lapor masalah
      </button>
      <span aria-live="polite" className="text-xs">
        {state.kind === "done" ? `Laporan #${state.id} terkirim` : ""}
      </span>
      <dialog
        ref={dialog}
        aria-labelledby={`${uid}-title`}
        data-report-skip
        className="m-auto w-[calc(100vw-1rem)] max-w-lg rounded-lg border bg-background p-0 text-foreground backdrop:bg-black/50 max-h-[calc(100dvh-1rem)] overflow-y-auto"
      >
        <form onSubmit={onSubmit} className="grid gap-4 p-4" aria-describedby={state.kind === "error" ? `${uid}-error` : undefined}>
          <h2 id={`${uid}-title`} className="text-lg font-semibold">
            Lapor masalah
          </h2>
          <fieldset className="grid gap-1.5">
            <legend className="text-sm font-medium">Apa yang bermasalah?</legend>
            {CATEGORIES.map(([value, label], i) => (
              <label key={value} className="flex min-h-6 cursor-pointer items-center gap-2 py-0.5 text-sm">
                <input type="radio" name="category" value={value} required={i === 0} className="size-4" /> {label}
              </label>
            ))}
          </fieldset>
          <fieldset className="grid gap-1.5">
            <legend className="text-sm font-medium">Seberapa parah?</legend>
            {SEVERITIES.map(([value, label], i) => (
              <label key={value} className="flex min-h-6 cursor-pointer items-center gap-2 py-0.5 text-sm">
                <input type="radio" name="severity" value={value} required={i === 0} className="size-4" /> {label}
              </label>
            ))}
          </fieldset>
          <div className="grid gap-1.5">
            <Label htmlFor={`${uid}-description`}>Deskripsi</Label>
            <Textarea
              id={`${uid}-description`}
              name="description"
              required
              minLength={5}
              maxLength={2000}
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              aria-invalid={state.field === "description" ? true : undefined}
              aria-describedby={`${uid}-hint ${uid}-count${state.field === "description" ? ` ${uid}-error` : ""}`}
            />
            <p id={`${uid}-hint`} className="text-xs text-muted-foreground">
              Jangan menulis data pribadi, kata sandi, atau token.
            </p>
            <p id={`${uid}-count`} className="text-xs text-muted-foreground tabular-nums">
              {description.length}/2000
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${uid}-control`}>Kontrol yang terdampak (opsional)</Label>
            <NativeSelect id={`${uid}-control`} value={picked} onChange={(e) => setPicked(e.target.value)}>
              <option value="">Tidak dipilih</option>
              {controls.map((c, i) => (
                <option key={i} value={String(i)}>
                  {c.label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <details className="rounded-lg border p-3 text-sm">
            <summary className="cursor-pointer font-medium">Data teknis yang akan dikirim</summary>
            <label className="mt-2 flex items-center gap-2">
              <input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} /> Sertakan permintaan terakhir dan error terakhir
            </label>
            <pre className="mt-2 max-h-40 overflow-auto text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
              {JSON.stringify(include ? { halaman: "dipetakan oleh server dari rute", viewport: "lebar dan tinggi jendela", permintaan: tech.requests, aksi_gagal: tech.actions, error_klien: tech.errors } : { halaman: "dipetakan oleh server dari rute", viewport: "lebar dan tinggi jendela" }, null, 1)}
            </pre>
          </details>
          {state.kind === "error" && (
            <p id={`${uid}-error`} role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {state.message}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={close}>
              Batal
            </Button>
            <Button type="submit" disabled={state.kind === "sending"}>
              {state.kind === "sending" ? "Mengirim…" : "Kirim laporan"}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
