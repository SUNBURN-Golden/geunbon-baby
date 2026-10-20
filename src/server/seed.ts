import { addDays, seoulToday } from "@/lib/dates";
import type { Sql } from "@/server/sql";
import {
  SAMPLE_NOTE,
  SAMPLE_SOURCE_PREFIX,
  seedBrands,
  seedEvents,
  seedGroupBuys,
  seedModels,
  seedQuotes,
} from "@/server/seed-data";

export async function seedIfEmpty(sql: Sql) {
  await sql.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [84218421]);
    const existing = await tx.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM brands");
    if (Number(existing[0]?.count ?? 0) > 0) return;

    const today = seoulToday();
    const brandIds = new Map<string, string>();
    for (const brand of seedBrands) {
      const id = crypto.randomUUID();
      brandIds.set(brand.slug, id);
      await tx.query(
        `INSERT INTO brands (id, slug, name, name_ko, country, website_url, summary)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, brand.slug, brand.name, brand.nameKo, brand.country, brand.websiteUrl, brand.summary],
      );
    }

    const modelIds = new Map<string, string>();
    for (const model of seedModels) {
      const id = crypto.randomUUID();
      modelIds.set(model.slug, id);
      await tx.query(
        `INSERT INTO models (
           id, brand_id, slug, name, name_ko, category, summary, featured, sort_order,
           kc_mark, importer_name, domestic_as, warranty_note, checklist_is_sample
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true)`,
        [
          id,
          brandIds.get(model.brandSlug),
          model.slug,
          model.name,
          model.nameKo,
          model.category,
          model.summary,
          model.featured,
          model.sortOrder,
          model.kcMark,
          model.importerName,
          model.domesticAs,
          model.warrantyNote,
        ],
      );
    }

    for (const quote of seedQuotes) {
      await tx.query(
        `INSERT INTO price_quotes (
           id, model_id, channel, amount_krw, source_name, source_url, checked_on, is_sample, note
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8)`,
        [
          crypto.randomUUID(),
          modelIds.get(quote.modelSlug),
          quote.channel,
          quote.amountKrw,
          "샘플 출처",
          `${SAMPLE_SOURCE_PREFIX}/prices/${quote.modelSlug}/${quote.channel}/${quote.daysAgo}`,
          addDays(today, -quote.daysAgo),
          SAMPLE_NOTE,
        ],
      );
    }

    for (const listing of seedGroupBuys) {
      await tx.query(
        `INSERT INTO group_buys (
           id, model_id, title, seller_name, instagram_handle, price_krw, starts_on, ends_on,
           source_url, is_ad, is_sample, has_mail_order_registration, has_cooling_off, is_official_import, note
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12,$13,$14)`,
        [
          crypto.randomUUID(),
          modelIds.get(listing.modelSlug),
          listing.title,
          listing.sellerName,
          listing.instagramHandle,
          listing.priceKrw,
          addDays(today, listing.startOffset),
          addDays(today, listing.endOffset),
          `${SAMPLE_SOURCE_PREFIX}/group-buys/${listing.modelSlug}`,
          listing.isAd,
          listing.hasMailOrderRegistration,
          listing.hasCoolingOff,
          listing.isOfficialImport,
          listing.note,
        ],
      );
    }

    for (const event of seedEvents) {
      await tx.query(
        `INSERT INTO brand_events (
           id, brand_id, title, summary, starts_on, ends_on, source_url, is_sample
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,true)`,
        [
          crypto.randomUUID(),
          brandIds.get(event.brandSlug),
          event.title,
          event.summary,
          addDays(today, event.startOffset),
          addDays(today, event.endOffset),
          event.sourceUrl,
        ],
      );
    }
  });
}
