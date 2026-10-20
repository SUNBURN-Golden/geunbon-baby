import { CHANNELS, type Category, type Channel, type WindowStatus } from "@/lib/labels";
import { daysInMonth, listingStatus, seoulToday } from "@/lib/dates";
import type {
  AdminPrice,
  Brand,
  BrandDetail,
  BrandEvent,
  GroupBuy,
  HistoryPoint,
  HomePayload,
  ModelCard,
  ModelDetail,
  ModelWithBrand,
  PriceQuote,
  SampleState,
} from "@/lib/types";
import { DomainError } from "@/server/errors";
import { compareDeal, latestByChannel, lowestComparable } from "@/server/pricing";
import type { Sql } from "@/server/sql";

type Row = Record<string, unknown>;

function bool(value: unknown) {
  return value === true || value === "t" || value === "true" || value === 1 || value === "1";
}

function num(value: unknown) {
  return typeof value === "number" ? value : Number(value);
}

function text(value: unknown) {
  return value == null ? "" : String(value);
}

function nullable(value: unknown) {
  if (value == null) return null;
  const stringValue = String(value);
  return stringValue.length ? stringValue : null;
}

function missing(message: string) {
  throw new DomainError(404, "not_found", message);
}

function mapBrand(row: Row): Brand {
  return {
    id: text(row.id),
    slug: text(row.slug),
    name: text(row.name),
    nameKo: text(row.nameKo),
    country: nullable(row.country),
    websiteUrl: nullable(row.websiteUrl),
    summary: text(row.summary),
  };
}

function mapModel(row: Row): ModelWithBrand {
  return {
    id: text(row.id),
    brandId: text(row.brandId),
    slug: text(row.slug),
    name: text(row.name),
    nameKo: text(row.nameKo),
    category: text(row.category) as Category,
    summary: text(row.summary),
    featured: bool(row.featured),
    sortOrder: num(row.sortOrder),
    kcMark: bool(row.kcMark),
    importerName: nullable(row.importerName),
    domesticAs: bool(row.domesticAs),
    warrantyNote: nullable(row.warrantyNote),
    checklistIsSample: bool(row.checklistIsSample),
    brandSlug: text(row.brandSlug),
    brandName: text(row.brandName),
    brandNameKo: text(row.brandNameKo),
    brandWebsite: nullable(row.brandWebsite),
  };
}

function mapQuote(row: Row): PriceQuote {
  return {
    id: text(row.id),
    modelId: text(row.modelId),
    channel: text(row.channel) as Channel,
    amountKrw: num(row.amountKrw),
    sourceName: text(row.sourceName),
    sourceUrl: text(row.sourceUrl),
    checkedOn: text(row.checkedOn),
    isSample: bool(row.isSample),
    note: nullable(row.note),
  };
}

function mapGroupBuy(row: Row, today: string): GroupBuy {
  const startsOn = text(row.startsOn);
  const endsOn = text(row.endsOn);
  return {
    id: text(row.id),
    modelId: text(row.modelId),
    modelSlug: text(row.modelSlug),
    modelName: text(row.modelName),
    modelNameKo: text(row.modelNameKo),
    brandName: text(row.brandName),
    brandNameKo: text(row.brandNameKo),
    title: text(row.title),
    sellerName: text(row.sellerName),
    instagramHandle: nullable(row.instagramHandle),
    priceKrw: row.priceKrw == null ? null : num(row.priceKrw),
    startsOn,
    endsOn,
    status: listingStatus(startsOn, endsOn, today),
    sourceUrl: text(row.sourceUrl),
    isAd: bool(row.isAd),
    isSample: bool(row.isSample),
    hasMailOrderRegistration: bool(row.hasMailOrderRegistration),
    hasCoolingOff: bool(row.hasCoolingOff),
    isOfficialImport: bool(row.isOfficialImport),
    note: nullable(row.note),
  };
}

function mapEvent(row: Row, today: string): BrandEvent {
  const startsOn = text(row.startsOn);
  const endsOn = text(row.endsOn);
  return {
    id: text(row.id),
    brandId: text(row.brandId),
    brandSlug: text(row.brandSlug),
    brandName: text(row.brandName),
    brandNameKo: text(row.brandNameKo),
    title: text(row.title),
    summary: text(row.summary),
    startsOn,
    endsOn,
    status: listingStatus(startsOn, endsOn, today),
    sourceUrl: nullable(row.sourceUrl),
    isSample: bool(row.isSample),
  };
}

const brandSelect = `id, slug, name, name_ko AS "nameKo", country, website_url AS "websiteUrl", summary`;

const modelSelect = `
  m.id, m.brand_id AS "brandId", m.slug, m.name, m.name_ko AS "nameKo", m.category, m.summary,
  m.featured, m.sort_order AS "sortOrder", m.kc_mark AS "kcMark", m.importer_name AS "importerName",
  m.domestic_as AS "domesticAs", m.warranty_note AS "warrantyNote", m.checklist_is_sample AS "checklistIsSample",
  b.slug AS "brandSlug", b.name AS "brandName", b.name_ko AS "brandNameKo", b.website_url AS "brandWebsite"
`;

const quoteSelect = `
  id, model_id AS "modelId", channel, amount_krw AS "amountKrw", source_name AS "sourceName",
  source_url AS "sourceUrl", to_char(checked_on, 'YYYY-MM-DD') AS "checkedOn", is_sample AS "isSample", note
`;

const groupBuySelect = `
  g.id, g.model_id AS "modelId", m.slug AS "modelSlug", m.name AS "modelName", m.name_ko AS "modelNameKo",
  b.name AS "brandName", b.name_ko AS "brandNameKo", g.title, g.seller_name AS "sellerName",
  g.instagram_handle AS "instagramHandle", g.price_krw AS "priceKrw",
  to_char(g.starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(g.ends_on, 'YYYY-MM-DD') AS "endsOn",
  g.source_url AS "sourceUrl", g.is_ad AS "isAd", g.is_sample AS "isSample",
  g.has_mail_order_registration AS "hasMailOrderRegistration", g.has_cooling_off AS "hasCoolingOff",
  g.is_official_import AS "isOfficialImport", g.note
`;

function columnEntries(input: Record<string, unknown>, columns: Record<string, string>) {
  const entries: Array<[string, unknown]> = [];
  for (const [key, column] of Object.entries(columns)) {
    if (Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined) {
      entries.push([column, input[key]]);
    }
  }
  return entries;
}

async function updateRow(
  sql: Sql,
  table: string,
  id: string,
  input: Record<string, unknown>,
  columns: Record<string, string>,
  returning: string,
  missingMessage: string,
) {
  const entries = columnEntries(input, columns);
  if (entries.length === 0) throw new DomainError(400, "invalid_input", "수정할 값이 없습니다.");
  const sets = entries.map(([column], index) => `${column} = $${index + 2}`);
  const params = [id, ...entries.map(([, value]) => value)];
  const rows = await sql.query(
    `UPDATE ${table} SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING ${returning}`,
    params,
  );
  if (!rows[0]) missing(missingMessage);
  return rows[0];
}

export async function listBrands(sql: Sql) {
  const rows = await sql.query(`SELECT ${brandSelect} FROM brands ORDER BY name`);
  return rows.map(mapBrand);
}

export async function getBrandBySlug(sql: Sql, slug: string): Promise<BrandDetail | null> {
  const rows = await sql.query(`SELECT ${brandSelect} FROM brands WHERE slug = $1`, [slug]);
  if (!rows[0]) return null;
  const models = await listModelCards(sql, { brandSlug: slug });
  return { ...mapBrand(rows[0]), models };
}

export async function listModels(sql: Sql, filter: { brandSlug?: string; category?: string; featured?: boolean } = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.brandSlug) {
    params.push(filter.brandSlug);
    where.push(`b.slug = $${params.length}`);
  }
  if (filter.category) {
    params.push(filter.category);
    where.push(`m.category = $${params.length}`);
  }
  if (filter.featured != null) {
    params.push(filter.featured);
    where.push(`m.featured = $${params.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await sql.query(
    `SELECT ${modelSelect} FROM models m JOIN brands b ON b.id = m.brand_id ${clause} ORDER BY m.sort_order, m.name`,
    params,
  );
  return rows.map(mapModel);
}

export async function listModelCards(
  sql: Sql,
  filter: { brandSlug?: string; category?: string; featured?: boolean } = {},
): Promise<ModelCard[]> {
  const models = await listModels(sql, filter);
  if (models.length === 0) return [];
  const params = models.map((model) => model.id);
  const placeholders = params.map((_, index) => `$${index + 1}`).join(", ");
  const rows = await sql.query(
    `SELECT model_id AS "modelId", channel, amount_krw AS "amountKrw",
            to_char(checked_on, 'YYYY-MM-DD') AS "checkedOn", is_sample AS "isSample",
            source_name AS "sourceName"
     FROM price_quotes WHERE model_id IN (${placeholders})`,
    params,
  );
  const grouped = new Map<string, HistoryPoint[]>();
  for (const row of rows) {
    const modelId = text(row.modelId);
    const point: HistoryPoint = {
      channel: text(row.channel) as Channel,
      amountKrw: num(row.amountKrw),
      checkedOn: text(row.checkedOn),
      isSample: bool(row.isSample),
      sourceName: text(row.sourceName),
    };
    grouped.set(modelId, [...(grouped.get(modelId) ?? []), point]);
  }
  return models.map((model) => {
    const history = grouped.get(model.id) ?? [];
    return {
      slug: model.slug,
      name: model.name,
      nameKo: model.nameKo,
      category: model.category,
      summary: model.summary,
      featured: model.featured,
      brandName: model.brandName,
      brandNameKo: model.brandNameKo,
      brandSlug: model.brandSlug,
      lowest: lowestComparable(history),
      deal: compareDeal(history),
    };
  });
}

export async function getModelDetail(sql: Sql, slug: string): Promise<ModelDetail | null> {
  const models = await sql.query(`SELECT ${modelSelect} FROM models m JOIN brands b ON b.id = m.brand_id WHERE m.slug = $1`, [
    slug,
  ]);
  if (!models[0]) return null;
  const model = mapModel(models[0]);
  const quoteRows = await sql.query(
    `SELECT ${quoteSelect} FROM price_quotes WHERE model_id = $1 ORDER BY checked_on ASC, created_at ASC`,
    [model.id],
  );
  const quotes = quoteRows.map(mapQuote);
  const history: HistoryPoint[] = quotes.map((quote) => ({
    channel: quote.channel,
    amountKrw: quote.amountKrw,
    checkedOn: quote.checkedOn,
    isSample: quote.isSample,
    sourceName: quote.sourceName,
  }));
  const latest = latestByChannel(quotes);
  const comparison = CHANNELS.map((item) => ({
    channel: item.value,
    quote: latest.get(item.value) ?? null,
  }));
  const groupBuys = await listGroupBuys(sql, { modelId: model.id });
  return {
    model,
    comparison,
    history,
    deal: compareDeal(history),
    groupBuys,
    allPricesSample: history.every((point) => point.isSample),
  };
}

export async function listGroupBuys(
  sql: Sql,
  filter: { status?: WindowStatus; month?: string; on?: string; modelId?: string } = {},
) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (filter.modelId) {
    params.push(filter.modelId);
    where.push(`g.model_id = $${params.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await sql.query(
    `SELECT ${groupBuySelect}
     FROM group_buys g
     JOIN models m ON m.id = g.model_id
     JOIN brands b ON b.id = m.brand_id
     ${clause}`,
    params,
  );
  const today = seoulToday();
  let items = rows.map((row) => mapGroupBuy(row, today));
  if (filter.status) items = items.filter((item) => item.status === filter.status);
  if (filter.month && /^\d{4}-\d{2}$/.test(filter.month)) {
    const start = `${filter.month}-01`;
    const end = `${filter.month}-${String(daysInMonth(filter.month)).padStart(2, "0")}`;
    items = items.filter((item) => item.startsOn <= end && item.endsOn >= start);
  }
  if (filter.on && /^\d{4}-\d{2}-\d{2}$/.test(filter.on)) {
    items = items.filter((item) => item.startsOn <= filter.on! && item.endsOn >= filter.on!);
  }
  const rank: Record<WindowStatus, number> = { ongoing: 0, upcoming: 1, ended: 2 };
  return items.sort((a, b) => rank[a.status] - rank[b.status] || a.startsOn.localeCompare(b.startsOn) || a.title.localeCompare(b.title));
}

export async function listEvents(sql: Sql) {
  const today = seoulToday();
  const rows = await sql.query(
    `SELECT e.id, e.brand_id AS "brandId", b.slug AS "brandSlug", b.name AS "brandName", b.name_ko AS "brandNameKo",
            e.title, e.summary, to_char(e.starts_on, 'YYYY-MM-DD') AS "startsOn",
            to_char(e.ends_on, 'YYYY-MM-DD') AS "endsOn", e.source_url AS "sourceUrl", e.is_sample AS "isSample"
     FROM brand_events e JOIN brands b ON b.id = e.brand_id`,
  );
  const rank: Record<WindowStatus, number> = { ongoing: 0, upcoming: 1, ended: 2 };
  return rows
    .map((row) => mapEvent(row, today))
    .sort((a, b) => rank[a.status] - rank[b.status] || a.startsOn.localeCompare(b.startsOn));
}

export async function getSampleState(sql: Sql): Promise<SampleState> {
  const rows = await sql.query<{
    priceCount: number | string;
    realPriceCount: number | string;
    groupBuyCount: number | string;
    realGroupBuyCount: number | string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM price_quotes) AS "priceCount",
       (SELECT COUNT(*) FROM price_quotes WHERE is_sample = false) AS "realPriceCount",
       (SELECT COUNT(*) FROM group_buys) AS "groupBuyCount",
       (SELECT COUNT(*) FROM group_buys WHERE is_sample = false) AS "realGroupBuyCount"`,
  );
  const priceCount = num(rows[0]?.priceCount ?? 0);
  const realPriceCount = num(rows[0]?.realPriceCount ?? 0);
  const groupBuyCount = num(rows[0]?.groupBuyCount ?? 0);
  const realGroupBuyCount = num(rows[0]?.realGroupBuyCount ?? 0);
  return {
    priceCount,
    realPriceCount,
    groupBuyCount,
    realGroupBuyCount,
    allStoredPricesAreSample: realPriceCount === 0 && realGroupBuyCount === 0,
  };
}

export async function getHome(sql: Sql): Promise<HomePayload> {
  const [featured, groupBuys, events, sample] = await Promise.all([
    listModelCards(sql, { featured: true }),
    listGroupBuys(sql),
    listEvents(sql),
    getSampleState(sql),
  ]);
  return {
    featured,
    groupBuys: groupBuys.filter((item) => item.status !== "ended").slice(0, 6),
    events,
    sample,
  };
}

const brandColumns = {
  slug: "slug",
  name: "name",
  nameKo: "name_ko",
  country: "country",
  websiteUrl: "website_url",
  summary: "summary",
};

export async function createBrand(sql: Sql, input: Record<string, unknown>) {
  const rows = await sql.query(`INSERT INTO brands (id, slug, name, name_ko, country, website_url, summary) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${brandSelect}`, [
    crypto.randomUUID(),
    input.slug,
    input.name,
    input.nameKo,
    input.country ?? null,
    input.websiteUrl ?? null,
    input.summary ?? "",
  ]);
  return mapBrand(rows[0]);
}

export async function updateBrand(sql: Sql, id: string, input: Record<string, unknown>) {
  const row = await updateRow(sql, "brands", id, input, brandColumns, brandSelect, "브랜드를 찾을 수 없습니다.");
  return mapBrand(row);
}

export async function deleteBrand(sql: Sql, id: string) {
  const rows = await sql.query("DELETE FROM brands WHERE id = $1 RETURNING id", [id]);
  if (!rows[0]) missing("브랜드를 찾을 수 없습니다.");
  return { deleted: true };
}

const modelColumns = {
  brandId: "brand_id",
  slug: "slug",
  name: "name",
  nameKo: "name_ko",
  category: "category",
  summary: "summary",
  featured: "featured",
  sortOrder: "sort_order",
  kcMark: "kc_mark",
  importerName: "importer_name",
  domesticAs: "domestic_as",
  warrantyNote: "warranty_note",
  checklistIsSample: "checklist_is_sample",
};

export async function createModel(sql: Sql, input: Record<string, unknown>) {
  const rows = await sql.query(
    `INSERT INTO models (
       id, brand_id, slug, name, name_ko, category, summary, featured, sort_order,
       kc_mark, importer_name, domestic_as, warranty_note, checklist_is_sample
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id`,
    [
      crypto.randomUUID(),
      input.brandId,
      input.slug,
      input.name,
      input.nameKo,
      input.category,
      input.summary ?? "",
      input.featured ?? false,
      input.sortOrder ?? 0,
      input.kcMark ?? false,
      input.importerName ?? null,
      input.domesticAs ?? false,
      input.warrantyNote ?? null,
      input.checklistIsSample ?? true,
    ],
  );
  return getModelById(sql, text(rows[0].id));
}

async function getModelById(sql: Sql, id: string) {
  const rows = await sql.query(`SELECT ${modelSelect} FROM models m JOIN brands b ON b.id = m.brand_id WHERE m.id = $1`, [id]);
  if (!rows[0]) missing("모델을 찾을 수 없습니다.");
  return mapModel(rows[0]);
}

export async function updateModel(sql: Sql, id: string, input: Record<string, unknown>) {
  await updateRow(sql, "models", id, input, modelColumns, "id", "모델을 찾을 수 없습니다.");
  return getModelById(sql, id);
}

export async function deleteModel(sql: Sql, id: string) {
  const rows = await sql.query("DELETE FROM models WHERE id = $1 RETURNING id", [id]);
  if (!rows[0]) missing("모델을 찾을 수 없습니다.");
  return { deleted: true };
}

export async function listPrices(sql: Sql): Promise<AdminPrice[]> {
  const rows = await sql.query(
    `SELECT q.id, q.model_id AS "modelId", m.slug AS "modelSlug", m.name_ko AS "modelNameKo",
            q.channel, q.amount_krw AS "amountKrw", q.source_name AS "sourceName", q.source_url AS "sourceUrl",
            to_char(q.checked_on, 'YYYY-MM-DD') AS "checkedOn", q.is_sample AS "isSample", q.note
     FROM price_quotes q JOIN models m ON m.id = q.model_id
     ORDER BY q.checked_on DESC, m.sort_order, q.channel`,
  );
  return rows.map((row) => ({
    ...mapQuote(row),
    modelSlug: text(row.modelSlug),
    modelNameKo: text(row.modelNameKo),
  }));
}

export async function createPrice(sql: Sql, input: Record<string, unknown>) {
  const id = crypto.randomUUID();
  await sql.query(
    `INSERT INTO price_quotes (id, model_id, channel, amount_krw, source_name, source_url, checked_on, is_sample, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      input.modelId,
      input.channel,
      input.amountKrw,
      input.sourceName,
      input.sourceUrl,
      input.checkedOn,
      input.isSample ?? true,
      input.note ?? null,
    ],
  );
  const rows = await listPrices(sql);
  const created = rows.find((row) => row.id === id);
  if (!created) missing("가격을 찾을 수 없습니다.");
  return created;
}

const priceColumns = {
  modelId: "model_id",
  channel: "channel",
  amountKrw: "amount_krw",
  sourceName: "source_name",
  sourceUrl: "source_url",
  checkedOn: "checked_on",
  isSample: "is_sample",
  note: "note",
};

export async function updatePrice(sql: Sql, id: string, input: Record<string, unknown>) {
  await updateRow(sql, "price_quotes", id, input, priceColumns, "id", "가격을 찾을 수 없습니다.");
  const rows = await listPrices(sql);
  const updated = rows.find((row) => row.id === id);
  if (!updated) missing("가격을 찾을 수 없습니다.");
  return updated;
}

export async function deletePrice(sql: Sql, id: string) {
  const rows = await sql.query("DELETE FROM price_quotes WHERE id = $1 RETURNING id", [id]);
  if (!rows[0]) missing("가격을 찾을 수 없습니다.");
  return { deleted: true };
}

export async function createGroupBuy(sql: Sql, input: Record<string, unknown>) {
  const id = crypto.randomUUID();
  await sql.query(
    `INSERT INTO group_buys (
       id, model_id, title, seller_name, instagram_handle, price_krw, starts_on, ends_on, source_url,
       is_ad, is_sample, has_mail_order_registration, has_cooling_off, is_official_import, note
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      id,
      input.modelId,
      input.title,
      input.sellerName,
      input.instagramHandle ?? null,
      input.priceKrw ?? null,
      input.startsOn,
      input.endsOn,
      input.sourceUrl,
      input.isAd ?? false,
      input.isSample ?? true,
      input.hasMailOrderRegistration ?? false,
      input.hasCoolingOff ?? false,
      input.isOfficialImport ?? false,
      input.note ?? null,
    ],
  );
  const created = (await listGroupBuys(sql)).find((item) => item.id === id);
  if (!created) missing("공구를 찾을 수 없습니다.");
  return created;
}

const groupBuyColumns = {
  modelId: "model_id",
  title: "title",
  sellerName: "seller_name",
  instagramHandle: "instagram_handle",
  priceKrw: "price_krw",
  startsOn: "starts_on",
  endsOn: "ends_on",
  sourceUrl: "source_url",
  isAd: "is_ad",
  isSample: "is_sample",
  hasMailOrderRegistration: "has_mail_order_registration",
  hasCoolingOff: "has_cooling_off",
  isOfficialImport: "is_official_import",
  note: "note",
};

export async function updateGroupBuy(sql: Sql, id: string, input: Record<string, unknown>) {
  await updateRow(sql, "group_buys", id, input, groupBuyColumns, "id", "공구를 찾을 수 없습니다.");
  const updated = (await listGroupBuys(sql)).find((item) => item.id === id);
  if (!updated) missing("공구를 찾을 수 없습니다.");
  return updated;
}

export async function deleteGroupBuy(sql: Sql, id: string) {
  const rows = await sql.query("DELETE FROM group_buys WHERE id = $1 RETURNING id", [id]);
  if (!rows[0]) missing("공구를 찾을 수 없습니다.");
  return { deleted: true };
}

export async function createEvent(sql: Sql, input: Record<string, unknown>) {
  const id = crypto.randomUUID();
  await sql.query(
    `INSERT INTO brand_events (id, brand_id, title, summary, starts_on, ends_on, source_url, is_sample)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, input.brandId, input.title, input.summary ?? "", input.startsOn, input.endsOn, input.sourceUrl ?? null, input.isSample ?? true],
  );
  const created = (await listEvents(sql)).find((item) => item.id === id);
  if (!created) missing("행사를 찾을 수 없습니다.");
  return created;
}

const eventColumns = {
  brandId: "brand_id",
  title: "title",
  summary: "summary",
  startsOn: "starts_on",
  endsOn: "ends_on",
  sourceUrl: "source_url",
  isSample: "is_sample",
};

export async function updateEvent(sql: Sql, id: string, input: Record<string, unknown>) {
  await updateRow(sql, "brand_events", id, input, eventColumns, "id", "행사를 찾을 수 없습니다.");
  const updated = (await listEvents(sql)).find((item) => item.id === id);
  if (!updated) missing("행사를 찾을 수 없습니다.");
  return updated;
}

export async function deleteEvent(sql: Sql, id: string) {
  const rows = await sql.query("DELETE FROM brand_events WHERE id = $1 RETURNING id", [id]);
  if (!rows[0]) missing("행사를 찾을 수 없습니다.");
  return { deleted: true };
}
