import { seller } from "@/lib/context";
import { redirect } from "next/navigation";

export default async function SellerHome() {
  const { ctx } = await seller();
  if (ctx.ok) redirect("/seller/products");
  return null; // the layout renders the denial
}
