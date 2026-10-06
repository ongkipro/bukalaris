"use server";

import { sellerScope } from "@/lib/context";
import { createPage, updatePage } from "@bukalaris/db";
import { run, text } from "../_run";

const fields = (f: FormData) => ({ title: text(f, "title"), slug: text(f, "slug"), body: text(f, "body"), status: text(f, "status") });

export async function createPageAction(f: FormData) {
  const scope = await sellerScope();
  await run("/seller/pages/new", (id) => `/seller/pages/${id}?saved=1`, () => createPage(scope, fields(f)));
}

export async function updatePageAction(pageId: number, f: FormData) {
  const scope = await sellerScope();
  const back = `/seller/pages/${pageId}`;
  await run(back, () => `${back}?saved=1`, () => updatePage(scope, pageId, fields(f)));
}
