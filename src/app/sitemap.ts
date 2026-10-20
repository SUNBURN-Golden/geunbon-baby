import type { MetadataRoute } from "next";
import { listModels } from "@/server/catalog";
import { live } from "@/server/live";
import { getSql } from "@/server/sql";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await live();
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const models = await listModels(await getSql());
  return [
    { url: base, changeFrequency: "daily", priority: 1 },
    { url: `${base}/models`, changeFrequency: "daily", priority: 0.8 },
    { url: `${base}/group-buys`, changeFrequency: "daily", priority: 0.8 },
    { url: `${base}/submit`, changeFrequency: "monthly", priority: 0.4 },
    { url: `${base}/legal`, changeFrequency: "yearly", priority: 0.3 },
    ...models.map((model) => ({
      url: `${base}/models/${model.slug}`,
      changeFrequency: "daily" as const,
      priority: 0.7,
    })),
  ];
}
