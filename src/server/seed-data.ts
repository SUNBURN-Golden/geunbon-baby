import type { Category, Channel } from "@/lib/labels";

export const SAMPLE_NOTE = "플레이스홀더 금액입니다. 실제 판매가가 아닙니다.";
export const SAMPLE_SOURCE_PREFIX = "https://example.com/sample";

export const seedBrands = [
  {
    slug: "stokke",
    name: "Stokke",
    nameKo: "스토케",
    country: "노르웨이",
    websiteUrl: "https://www.stokke.com",
    summary: "트립트랩과 익스플로리로 오래 회자되는 노르웨이 브랜드입니다.",
  },
  {
    slug: "bugaboo",
    name: "Bugaboo",
    nameKo: "부가부",
    country: "네덜란드",
    websiteUrl: "https://www.bugaboo.com",
    summary: "폭스와 버터플라이로 알려진 네덜란드 유모차 브랜드입니다.",
  },
  {
    slug: "babybjorn",
    name: "BabyBjörn",
    nameKo: "베이비뵨",
    country: "스웨덴",
    websiteUrl: "https://www.babybjorn.com",
    summary: "바운서 블리스로 대표되는 스웨덴 브랜드입니다.",
  },
  {
    slug: "cybex",
    name: "CYBEX",
    nameKo: "사이벡스",
    country: "독일",
    websiteUrl: "https://www.cybex-online.com",
    summary: "프리암, 사이로나처럼 유모차와 카시트를 함께 다루는 독일 브랜드입니다.",
  },
  {
    slug: "nuna",
    name: "Nuna",
    nameKo: "뉴나",
    country: "네덜란드",
    websiteUrl: "https://www.nuna.com",
    summary: "트리브, 믹스 계열 유모차로 거래가 많은 브랜드입니다.",
  },
  {
    slug: "joie",
    name: "Joie",
    nameKo: "조이",
    country: "영국",
    websiteUrl: "https://www.joiebaby.com",
    summary: "아이스핀 360 등 카시트로 자주 비교되는 브랜드입니다.",
  },
  {
    slug: "egg",
    name: "egg",
    nameKo: "에그",
    country: "영국",
    websiteUrl: "https://www.eggstrollers.com",
    summary: "egg3로 알려진 영국 유모차입니다.",
  },
  {
    slug: "d-throne",
    name: "D.THRONE",
    nameKo: "디쓰론",
    country: "한국",
    websiteUrl: null,
    summary: "국내에서 프리미엄 유모차로 거래되는 디쓰론입니다.",
  },
  {
    slug: "doona",
    name: "Doona",
    nameKo: "두나",
    country: "이스라엘",
    websiteUrl: "https://www.doona.com",
    summary: "카시트와 유모차를 오가는 두나 플러스로 알려진 브랜드입니다.",
  },
  {
    slug: "britax",
    name: "Britax",
    nameKo: "브라이택스",
    country: "영국",
    websiteUrl: "https://www.britax.com",
    summary: "듀얼픽스 계열 카시트로 비교되는 브랜드입니다.",
  },
] as const;

type SeedModel = {
  brandSlug: string;
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
};

export const seedModels: SeedModel[] = [
  {
    brandSlug: "stokke",
    slug: "stokke-tripp-trapp",
    name: "Tripp Trapp",
    nameKo: "트립트랩",
    category: "high_chair",
    summary: "접이식 하이체어의 기준으로 오래 거래되는 모델입니다. 신생아 세트와 본체가 따로 오가는 경우가 많습니다.",
    featured: true,
    sortOrder: 10,
    kcMark: true,
    importerName: "샘플 · 수입업자명",
    domesticAs: true,
    warrantyNote: "샘플 · 국내 보증 안내 자리",
  },
  {
    brandSlug: "stokke",
    slug: "stokke-xplory-x",
    name: "Xplory X",
    nameKo: "익스플로리 X",
    category: "stroller",
    summary: "높은 시트 포지션으로 기억되는 스토케 유모차입니다.",
    featured: true,
    sortOrder: 20,
    kcMark: true,
    importerName: "샘플 · 수입업자명",
    domesticAs: true,
    warrantyNote: "샘플 · 국내 보증 안내 자리",
  },
  {
    brandSlug: "bugaboo",
    slug: "bugaboo-fox-5",
    name: "Fox 5",
    nameKo: "폭스 5",
    category: "stroller",
    summary: "부가부 프리미엄 라인의 대표 디럭스 유모차입니다.",
    featured: true,
    sortOrder: 30,
    kcMark: true,
    importerName: "샘플 · 수입업자명",
    domesticAs: true,
    warrantyNote: "샘플 · 국내 A/S 안내 자리",
  },
  {
    brandSlug: "bugaboo",
    slug: "bugaboo-butterfly",
    name: "Butterfly",
    nameKo: "버터플라이",
    category: "compact_stroller",
    summary: "기내용으로 자주 비교되는 부가부 휴대용 유모차입니다.",
    featured: true,
    sortOrder: 40,
    kcMark: false,
    importerName: null,
    domesticAs: false,
    warrantyNote: null,
  },
  {
    brandSlug: "babybjorn",
    slug: "babybjorn-bouncer-bliss",
    name: "Bouncer Bliss",
    nameKo: "바운서 블리스",
    category: "bouncer",
    summary: "베이비뵨을 대표하는 바운서입니다. 패브릭과 프레임이 나뉘어 거래되기도 합니다.",
    featured: true,
    sortOrder: 50,
    kcMark: true,
    importerName: "샘플 · 수입업자명",
    domesticAs: true,
    warrantyNote: "샘플 · 국내 A/S 안내 자리",
  },
  {
    brandSlug: "cybex",
    slug: "cybex-priam",
    name: "Priam",
    nameKo: "프리암",
    category: "stroller",
    summary: "사이벡스 상위 유모차 라인입니다. 시트와 프레임 구성에 따라 가격 폭이 큽니다.",
    featured: false,
    sortOrder: 60,
    kcMark: true,
    importerName: "샘플 · 수입업자명",
    domesticAs: false,
    warrantyNote: "샘플 · 보증 조건 미기재",
  },
  {
    brandSlug: "cybex",
    slug: "cybex-sirona-t",
    name: "Sirona T",
    nameKo: "사이로나 T",
    category: "car_seat",
    summary: "회전형으로 비교되는 사이벡스 카시트입니다.",
    featured: false,
    sortOrder: 70,
    kcMark: false,
    importerName: null,
    domesticAs: false,
    warrantyNote: null,
  },
  {
    brandSlug: "nuna",
    slug: "nuna-triv-next",
    name: "TRIV next",
    nameKo: "트리브 넥스트",
    category: "stroller",
    summary: "접힘과 승차감으로 자주 비교되는 뉴나 유모차입니다.",
    featured: false,
    sortOrder: 80,
    kcMark: true,
    importerName: null,
    domesticAs: true,
    warrantyNote: "샘플 · 국내 A/S 안내 자리",
  },
  {
    brandSlug: "nuna",
    slug: "nuna-mixx-next",
    name: "MIXX next",
    nameKo: "믹스 넥스트",
    category: "stroller",
    summary: "뉴나 상위 유모차 라인으로 거래되는 모델입니다.",
    featured: false,
    sortOrder: 90,
    kcMark: true,
    importerName: null,
    domesticAs: true,
    warrantyNote: "샘플 · 국내 A/S 안내 자리",
  },
  {
    brandSlug: "joie",
    slug: "joie-i-spin-360",
    name: "i-Spin 360",
    nameKo: "아이스핀 360",
    category: "car_seat",
    summary: "360도 회전형으로 비교되는 조이 카시트입니다.",
    featured: false,
    sortOrder: 100,
    kcMark: true,
    importerName: "샘플 · 수입업자명",
    domesticAs: true,
    warrantyNote: "샘플 · 국내 보증 안내 자리",
  },
  {
    brandSlug: "egg",
    slug: "egg-egg3",
    name: "egg3",
    nameKo: "에그3",
    category: "stroller",
    summary: "영국 egg 유모차의 3세대 모델로 불리는 제품입니다.",
    featured: true,
    sortOrder: 110,
    kcMark: false,
    importerName: null,
    domesticAs: false,
    warrantyNote: null,
  },
  {
    brandSlug: "d-throne",
    slug: "d-throne",
    name: "D.THRONE",
    nameKo: "디쓰론",
    category: "stroller",
    summary: "국내 프리미엄 유모차로 공구와 중고가 함께 오가는 모델입니다.",
    featured: true,
    sortOrder: 120,
    kcMark: true,
    importerName: "샘플 · 국내 유통",
    domesticAs: true,
    warrantyNote: "샘플 · 국내 A/S 안내 자리",
  },
  {
    brandSlug: "doona",
    slug: "doona-plus",
    name: "Doona+",
    nameKo: "두나 플러스",
    category: "travel_system",
    summary: "카시트에서 유모차로 바뀌는 형태로 거래되는 모델입니다.",
    featured: true,
    sortOrder: 130,
    kcMark: true,
    importerName: "샘플 · 수입업자명",
    domesticAs: true,
    warrantyNote: "샘플 · 국내 보증 안내 자리",
  },
  {
    brandSlug: "britax",
    slug: "britax-dualfix-i-size",
    name: "Dualfix i-Size",
    nameKo: "듀얼픽스 아이사이즈",
    category: "car_seat",
    summary: "회전형 아이사이즈 카시트로 비교되는 브라이택스 모델입니다.",
    featured: false,
    sortOrder: 140,
    kcMark: false,
    importerName: null,
    domesticAs: false,
    warrantyNote: null,
  },
];

export type SeedQuote = {
  modelSlug: string;
  channel: Channel;
  amountKrw: number;
  daysAgo: number;
};

export const seedQuotes: SeedQuote[] = [];

function series(slug: string, channel: Channel, amounts: number[], startDaysAgo: number, step: number) {
  amounts.forEach((amountKrw, index) => {
    seedQuotes.push({ modelSlug: slug, channel, amountKrw, daysAgo: startDaysAgo - index * step });
  });
}

function spot(slug: string, channel: Channel, amountKrw: number, daysAgo: number) {
  seedQuotes.push({ modelSlug: slug, channel, amountKrw, daysAgo });
}

function table(slug: string, prices: Record<Channel, number>) {
  spot(slug, "group_buy", prices.group_buy, 3);
  spot(slug, "official", prices.official, 2);
  spot(slug, "parallel_import", prices.parallel_import, 5);
  spot(slug, "overseas", prices.overseas, 8);
  spot(slug, "used", prices.used, 11);
}

series("stokke-tripp-trapp", "official", [429000, 429000, 449000, 449000], 180, 60);
series("stokke-tripp-trapp", "group_buy", [399000, 359000], 40, 39);
spot("stokke-tripp-trapp", "parallel_import", 389000, 4);
spot("stokke-tripp-trapp", "overseas", 312000, 6);
spot("stokke-tripp-trapp", "used", 185000, 9);

series("bugaboo-fox-5", "official", [1890000, 1890000, 1990000, 1990000], 180, 60);
spot("bugaboo-fox-5", "group_buy", 1640000, 2);
spot("bugaboo-fox-5", "parallel_import", 1720000, 5);
spot("bugaboo-fox-5", "overseas", 1490000, 7);
spot("bugaboo-fox-5", "used", 980000, 12);

series("cybex-priam", "official", [1200000, 1200000, 1250000, 1250000], 160, 50);
spot("cybex-priam", "group_buy", 1190000, 3);
spot("cybex-priam", "parallel_import", 1200000, 8);
spot("cybex-priam", "overseas", 980000, 10);
spot("cybex-priam", "used", 720000, 15);

series("doona-plus", "official", [790000, 790000, 850000, 850000], 150, 45);
spot("doona-plus", "group_buy", 690000, 2);
spot("doona-plus", "parallel_import", 720000, 6);
spot("doona-plus", "overseas", 640000, 9);
spot("doona-plus", "used", 430000, 14);

table("stokke-xplory-x", {
  group_buy: 1420000,
  official: 1590000,
  parallel_import: 1350000,
  overseas: 1180000,
  used: 790000,
});
table("bugaboo-butterfly", {
  group_buy: 690000,
  official: 790000,
  parallel_import: 640000,
  overseas: 520000,
  used: 380000,
});
table("babybjorn-bouncer-bliss", {
  group_buy: 249000,
  official: 280000,
  parallel_import: 220000,
  overseas: 190000,
  used: 90000,
});
table("cybex-sirona-t", {
  group_buy: 790000,
  official: 890000,
  parallel_import: 740000,
  overseas: 610000,
  used: 420000,
});
table("nuna-triv-next", {
  group_buy: 1090000,
  official: 1190000,
  parallel_import: 990000,
  overseas: 860000,
  used: 540000,
});
table("nuna-mixx-next", {
  group_buy: 1290000,
  official: 1390000,
  parallel_import: 1180000,
  overseas: 990000,
  used: 680000,
});
table("joie-i-spin-360", {
  group_buy: 420000,
  official: 490000,
  parallel_import: 390000,
  overseas: 310000,
  used: 180000,
});
table("egg-egg3", {
  group_buy: 1690000,
  official: 1890000,
  parallel_import: 1550000,
  overseas: 1320000,
  used: 890000,
});
table("d-throne", {
  group_buy: 890000,
  official: 980000,
  parallel_import: 820000,
  overseas: 700000,
  used: 450000,
});
table("britax-dualfix-i-size", {
  group_buy: 650000,
  official: 720000,
  parallel_import: 600000,
  overseas: 510000,
  used: 280000,
});

export const seedGroupBuys = [
  {
    modelSlug: "stokke-tripp-trapp",
    title: "샘플 · 트립트랩 가을 공구",
    sellerName: "샘플셀러 그린룸",
    instagramHandle: "sample_greenroom",
    priceKrw: 359000,
    startOffset: -6,
    endOffset: 6,
    isAd: false,
    hasMailOrderRegistration: true,
    hasCoolingOff: true,
    isOfficialImport: true,
    note: "샘플 데이터입니다. 실제 공구가 아닙니다.",
  },
  {
    modelSlug: "bugaboo-fox-5",
    title: "샘플 · 광고 라벨 예시 — 폭스 5",
    sellerName: "샘플셀러 브레스",
    instagramHandle: "sample_brass",
    priceKrw: 1640000,
    startOffset: -2,
    endOffset: 9,
    isAd: true,
    hasMailOrderRegistration: true,
    hasCoolingOff: false,
    isOfficialImport: false,
    note: "유료 게재 라벨을 보여 주기 위한 샘플입니다. 실제 광고 계약이 아닙니다.",
  },
  {
    modelSlug: "stokke-xplory-x",
    title: "샘플 · 익스플로리 X 주말 공구",
    sellerName: "샘플셀러 노트",
    instagramHandle: "sample_note",
    priceKrw: 1420000,
    startOffset: -1,
    endOffset: 4,
    isAd: false,
    hasMailOrderRegistration: true,
    hasCoolingOff: true,
    isOfficialImport: false,
    note: "샘플 데이터입니다.",
  },
  {
    modelSlug: "bugaboo-butterfly",
    title: "샘플 · 버터플라이 오픈 예정",
    sellerName: "샘플셀러 포켓",
    instagramHandle: "sample_pocket",
    priceKrw: 690000,
    startOffset: 5,
    endOffset: 12,
    isAd: false,
    hasMailOrderRegistration: false,
    hasCoolingOff: true,
    isOfficialImport: false,
    note: "샘플 데이터입니다.",
  },
  {
    modelSlug: "doona-plus",
    title: "샘플 · 두나 플러스 진행 공구",
    sellerName: "샘플셀러 리프",
    instagramHandle: "sample_leaf",
    priceKrw: 690000,
    startOffset: -3,
    endOffset: 8,
    isAd: false,
    hasMailOrderRegistration: true,
    hasCoolingOff: true,
    isOfficialImport: true,
    note: "샘플 데이터입니다.",
  },
  {
    modelSlug: "egg-egg3",
    title: "샘플 · 에그3 다음 달 공구",
    sellerName: "샘플셀러 라운지",
    instagramHandle: "sample_lounge",
    priceKrw: 1690000,
    startOffset: 10,
    endOffset: 16,
    isAd: true,
    hasMailOrderRegistration: false,
    hasCoolingOff: false,
    isOfficialImport: false,
    note: "예정된 광고 라벨 샘플입니다. 실제 일정이 아닙니다.",
  },
  {
    modelSlug: "babybjorn-bouncer-bliss",
    title: "샘플 · 블리스 지난 공구",
    sellerName: "샘플셀러 아카이브",
    instagramHandle: "sample_archive",
    priceKrw: 249000,
    startOffset: -40,
    endOffset: -28,
    isAd: false,
    hasMailOrderRegistration: true,
    hasCoolingOff: true,
    isOfficialImport: true,
    note: "종료된 샘플 일정입니다.",
  },
  {
    modelSlug: "d-throne",
    title: "샘플 · 디쓰론 이번 주 공구",
    sellerName: "샘플셀러 한강",
    instagramHandle: "sample_hangang",
    priceKrw: 890000,
    startOffset: -1,
    endOffset: 3,
    isAd: false,
    hasMailOrderRegistration: true,
    hasCoolingOff: false,
    isOfficialImport: true,
    note: "샘플 데이터입니다.",
  },
];

export const seedEvents = [
  {
    brandSlug: "stokke",
    title: "샘플 · 스토케 가을 팝업",
    summary: "실제 행사가 아닙니다. 홈의 브랜드 일정 자리를 채우는 샘플입니다.",
    startOffset: -2,
    endOffset: 12,
    sourceUrl: `${SAMPLE_SOURCE_PREFIX}/events/stokke-popup`,
  },
  {
    brandSlug: "bugaboo",
    title: "샘플 · 부가부 프리뷰",
    summary: "예정된 브랜드 일정처럼 보이게 만든 샘플입니다.",
    startOffset: 8,
    endOffset: 11,
    sourceUrl: `${SAMPLE_SOURCE_PREFIX}/events/bugaboo-preview`,
  },
  {
    brandSlug: "cybex",
    title: "샘플 · 사이벡스 지난 아카이브",
    summary: "종료된 일정 표시를 위한 샘플입니다.",
    startOffset: -30,
    endOffset: -20,
    sourceUrl: `${SAMPLE_SOURCE_PREFIX}/events/cybex-archive`,
  },
];
