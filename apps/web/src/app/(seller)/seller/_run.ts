import "server-only";
import { userError, withError } from "@/lib/errors";
import { redirect } from "next/navigation";

export const text = (f: FormData, k: string) => String(f.get(k) ?? "");

/** Run a mutation; on an expected failure go back with a message, otherwise to `done`. */
export async function run(back: string, done: (result: unknown) => string, op: () => Promise<unknown>) {
  let result: unknown;
  let error: string | undefined;
  try {
    result = await op();
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError(back, error) : done(result));
}
