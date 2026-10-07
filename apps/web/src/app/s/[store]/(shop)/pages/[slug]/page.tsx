import { getPublishedPage } from "@bukalaris/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MarkdownLite } from "../../_components/markdown-lite";
import { storeShell } from "../../_lib";

export async function generateMetadata({ params }: PageProps<"/s/[store]/pages/[slug]">): Promise<Metadata> {
  const { store, slug } = await params;
  const { scope } = await storeShell(store);
  const p = await getPublishedPage(scope, slug);
  return { title: p ? `${p.title} — ${scope.storeName}` : scope.storeName };
}

export default async function CmsPage({ params }: PageProps<"/s/[store]/pages/[slug]">) {
  const { store, slug } = await params;
  const { scope } = await storeShell(store);
  const p = await getPublishedPage(scope, slug);
  if (!p) notFound();
  return (
    <article className="mx-auto grid w-full max-w-prose gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-balance @2xl:text-3xl">{p.title}</h1>
      <MarkdownLite body={p.body} />
    </article>
  );
}
