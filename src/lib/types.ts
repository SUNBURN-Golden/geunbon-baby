import type { Category, Channel, WindowStatus } from "@/lib/labels";

export type Brand = {
  id: string;
  slug: string;
  name: string;
  nameKo: string;
  country: string | null;
  websiteUrl: string | null;
  summary: string;
};

export type Model = {
  id: string;
  brandId: string;
  slug: string;
  name: string;
  nameKo: string;
  category: Category;
  summary: string;
  featured: boolean;
  sortOrder: number;
  kcMark: boolean;
  importerName: string | null;
  domesticAs: boolean;
  warrantyNote: string | null;
  checklistIsSample: boolean;
};

export type ModelWithBrand = Model & {
  brandSlug: string;
  brandName: string;
  brandNameKo: string;
  brandWebsite: string | null;
};

export type PriceQuote = {
  id: string;
  modelId: string;
  channel: Channel;
  amountKrw: number;
  sourceName: string;
  sourceUrl: string;
  checkedOn: string;
  isSample: boolean;
  note: string | null;
};

export type AdminPrice = PriceQuote & {
  modelSlug: string;
  modelNameKo: string;
};

export type HistoryPoint = {
  channel: Channel;
  amountKrw: number;
  checkedOn: string;
  isSample: boolean;
  sourceName: string;
};

export type Deal = {
  baselineKrw: number;
  currentKrw: number;
  currentChannel: Channel;
  percentOff: number;
  basedOnSample: boolean;
};

export type GroupBuy = {
  id: string;
  modelId: string;
  modelSlug: string;
  modelName: string;
  modelNameKo: string;
  brandName: string;
  brandNameKo: string;
  title: string;
  sellerName: string;
  instagramHandle: string | null;
  priceKrw: number | null;
  startsOn: string;
  endsOn: string;
  status: WindowStatus;
  sourceUrl: string;
  isAd: boolean;
  isSample: boolean;
  hasMailOrderRegistration: boolean;
  hasCoolingOff: boolean;
  isOfficialImport: boolean;
  note: string | null;
};

export type BrandEvent = {
  id: string;
  brandId: string;
  brandSlug: string;
  brandName: string;
  brandNameKo: string;
  title: string;
  summary: string;
  startsOn: string;
  endsOn: string;
  status: WindowStatus;
  sourceUrl: string | null;
  isSample: boolean;
};

export type Submission = {
  id: string;
  kind: "group_buy" | "tip";
  status: "pending" | "approved" | "rejected";
  payload: Record<string, unknown>;
  contactEmail: string | null;
  createdAt: string;
  reviewedAt: string | null;
};

export type Subscriber = {
  id: string;
  email: string;
  source: string;
  createdAt: string;
};

export type SampleState = {
  priceCount: number;
  realPriceCount: number;
  groupBuyCount: number;
  realGroupBuyCount: number;
  allStoredPricesAreSample: boolean;
};

export type ModelCard = {
  slug: string;
  name: string;
  nameKo: string;
  category: Category;
  summary: string;
  featured: boolean;
  brandName: string;
  brandNameKo: string;
  brandSlug: string;
  lowest: { channel: Channel; amountKrw: number; isSample: boolean } | null;
  deal: Deal | null;
};

export type ComparisonRow = {
  channel: Channel;
  quote: PriceQuote | null;
};

export type ModelDetail = {
  model: ModelWithBrand;
  comparison: ComparisonRow[];
  history: HistoryPoint[];
  deal: Deal | null;
  groupBuys: GroupBuy[];
  allPricesSample: boolean;
};

export type HomePayload = {
  featured: ModelCard[];
  groupBuys: GroupBuy[];
  events: BrandEvent[];
  sample: SampleState;
};

export type BrandDetail = Brand & {
  models: ModelCard[];
};
