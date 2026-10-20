import { z } from "zod";
import { CATEGORIES, CHANNELS } from "@/lib/labels";

const slug = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "주소 이름은 영문 소문자와 숫자, 하이픈만 쓸 수 있습니다.");

const httpUrl = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }, "http 또는 https 링크만 입력할 수 있습니다.");

const optionalHttpUrl = z.union([z.literal(""), httpUrl]).optional().nullable();

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 YYYY-MM-DD 형식이어야 합니다.");

const category = z.enum(CATEGORIES.map((item) => item.value) as [string, ...string[]]);
const channel = z.enum(CHANNELS.map((item) => item.value) as [string, ...string[]]);

function emptyToNull(value: unknown) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export const brandInputSchema = z.object({
  slug,
  name: z.string().trim().min(1, "브랜드 영문 이름을 입력해 주세요.").max(80),
  nameKo: z.string().trim().min(1, "브랜드 한글 이름을 입력해 주세요.").max(80),
  country: z.preprocess(emptyToNull, z.string().max(40).nullable().optional()),
  websiteUrl: z.preprocess(emptyToNull, httpUrl.nullable().optional()),
  summary: z.string().trim().max(400).optional().default(""),
});

export const brandPatchSchema = brandInputSchema.partial().refine((value) => Object.keys(value).length > 0, {
  message: "수정할 값이 없습니다.",
});

export const modelInputSchema = z.object({
  brandId: z.uuid("브랜드를 선택해 주세요."),
  slug,
  name: z.string().trim().min(1, "모델 영문 이름을 입력해 주세요.").max(120),
  nameKo: z.string().trim().min(1, "모델 한글 이름을 입력해 주세요.").max(120),
  category,
  summary: z.string().trim().max(600).optional().default(""),
  featured: z.boolean().optional().default(false),
  sortOrder: z.number().int().min(0).max(9999).optional().default(0),
  kcMark: z.boolean().optional().default(false),
  importerName: z.preprocess(emptyToNull, z.string().max(120).nullable().optional()),
  domesticAs: z.boolean().optional().default(false),
  warrantyNote: z.preprocess(emptyToNull, z.string().max(200).nullable().optional()),
  checklistIsSample: z.boolean().optional().default(true),
});

export const modelPatchSchema = modelInputSchema.partial().refine((value) => Object.keys(value).length > 0, {
  message: "수정할 값이 없습니다.",
});

export const priceInputSchema = z
  .object({
    modelId: z.uuid("모델을 선택해 주세요."),
    channel,
    amountKrw: z.number().int().nonnegative().max(30_000_000),
    sourceName: z.string().trim().min(1, "출처 이름을 입력해 주세요.").max(120),
    sourceUrl: httpUrl,
    checkedOn: day,
    isSample: z.boolean().optional().default(true),
    confirmRealPrice: z.boolean().optional().default(false),
    note: z.preprocess(emptyToNull, z.string().max(500).nullable().optional()),
  })
  .superRefine((value, ctx) => {
    if (value.isSample === false && value.confirmRealPrice !== true) {
      ctx.addIssue({
        code: "custom",
        path: ["confirmRealPrice"],
        message: "실제 가격으로 저장하려면 확인 체크가 필요합니다.",
      });
    }
  });

export const pricePatchSchema = z
  .object({
    modelId: z.uuid().optional(),
    channel: channel.optional(),
    amountKrw: z.number().int().nonnegative().max(30_000_000).optional(),
    sourceName: z.string().trim().min(1).max(120).optional(),
    sourceUrl: httpUrl.optional(),
    checkedOn: day.optional(),
    isSample: z.boolean().optional(),
    confirmRealPrice: z.boolean().optional(),
    note: z.preprocess(emptyToNull, z.string().max(500).nullable().optional()),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "수정할 값이 없습니다." })
  .superRefine((value, ctx) => {
    if (value.isSample === false && value.confirmRealPrice !== true) {
      ctx.addIssue({
        code: "custom",
        path: ["confirmRealPrice"],
        message: "실제 가격으로 저장하려면 확인 체크가 필요합니다.",
      });
    }
  });

export const groupBuyInputSchema = z
  .object({
    modelId: z.uuid("모델을 선택해 주세요."),
    title: z.string().trim().min(1, "제목을 입력해 주세요.").max(140),
    sellerName: z.string().trim().min(1, "판매자 이름을 입력해 주세요.").max(80),
    instagramHandle: z.preprocess(emptyToNull, z.string().max(40).nullable().optional()),
    priceKrw: z.number().int().nonnegative().max(30_000_000).nullable().optional(),
    startsOn: day,
    endsOn: day,
    sourceUrl: httpUrl,
    isAd: z.boolean().optional().default(false),
    isSample: z.boolean().optional().default(true),
    confirmRealListing: z.boolean().optional().default(false),
    hasMailOrderRegistration: z.boolean().optional().default(false),
    hasCoolingOff: z.boolean().optional().default(false),
    isOfficialImport: z.boolean().optional().default(false),
    note: z.preprocess(emptyToNull, z.string().max(800).nullable().optional()),
  })
  .superRefine((value, ctx) => {
    if (value.endsOn < value.startsOn) {
      ctx.addIssue({ code: "custom", path: ["endsOn"], message: "종료일은 시작일보다 빠를 수 없습니다." });
    }
    if (value.isSample === false && value.confirmRealListing !== true) {
      ctx.addIssue({
        code: "custom",
        path: ["confirmRealListing"],
        message: "실제 공구로 저장하려면 확인 체크가 필요합니다.",
      });
    }
  });

export const groupBuyPatchSchema = z
  .object({
    modelId: z.uuid().optional(),
    title: z.string().trim().min(1).max(140).optional(),
    sellerName: z.string().trim().min(1).max(80).optional(),
    instagramHandle: z.preprocess(emptyToNull, z.string().max(40).nullable().optional()),
    priceKrw: z.number().int().nonnegative().max(30_000_000).nullable().optional(),
    startsOn: day.optional(),
    endsOn: day.optional(),
    sourceUrl: httpUrl.optional(),
    isAd: z.boolean().optional(),
    isSample: z.boolean().optional(),
    confirmRealListing: z.boolean().optional(),
    hasMailOrderRegistration: z.boolean().optional(),
    hasCoolingOff: z.boolean().optional(),
    isOfficialImport: z.boolean().optional(),
    note: z.preprocess(emptyToNull, z.string().max(800).nullable().optional()),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "수정할 값이 없습니다." })
  .superRefine((value, ctx) => {
    if (value.startsOn && value.endsOn && value.endsOn < value.startsOn) {
      ctx.addIssue({ code: "custom", path: ["endsOn"], message: "종료일은 시작일보다 빠를 수 없습니다." });
    }
    if (value.isSample === false && value.confirmRealListing !== true) {
      ctx.addIssue({
        code: "custom",
        path: ["confirmRealListing"],
        message: "실제 공구로 저장하려면 확인 체크가 필요합니다.",
      });
    }
  });

export const eventInputSchema = z
  .object({
    brandId: z.uuid("브랜드를 선택해 주세요."),
    title: z.string().trim().min(1, "행사 제목을 입력해 주세요.").max(140),
    summary: z.string().trim().max(400).optional().default(""),
    startsOn: day,
    endsOn: day,
    sourceUrl: z.preprocess(emptyToNull, httpUrl.nullable().optional()),
    isSample: z.boolean().optional().default(true),
    confirmRealEvent: z.boolean().optional().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.endsOn < value.startsOn) {
      ctx.addIssue({ code: "custom", path: ["endsOn"], message: "종료일은 시작일보다 빠를 수 없습니다." });
    }
    if (value.isSample === false && value.confirmRealEvent !== true) {
      ctx.addIssue({
        code: "custom",
        path: ["confirmRealEvent"],
        message: "실제 행사로 저장하려면 확인 체크가 필요합니다.",
      });
    }
  });

export const eventPatchSchema = z
  .object({
    brandId: z.uuid().optional(),
    title: z.string().trim().min(1).max(140).optional(),
    summary: z.string().trim().max(400).optional(),
    startsOn: day.optional(),
    endsOn: day.optional(),
    sourceUrl: z.preprocess(emptyToNull, httpUrl.nullable().optional()),
    isSample: z.boolean().optional(),
    confirmRealEvent: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "수정할 값이 없습니다." })
  .superRefine((value, ctx) => {
    if (value.startsOn && value.endsOn && value.endsOn < value.startsOn) {
      ctx.addIssue({ code: "custom", path: ["endsOn"], message: "종료일은 시작일보다 빠를 수 없습니다." });
    }
    if (value.isSample === false && value.confirmRealEvent !== true) {
      ctx.addIssue({
        code: "custom",
        path: ["confirmRealEvent"],
        message: "실제 행사로 저장하려면 확인 체크가 필요합니다.",
      });
    }
  });

export const groupBuySubmissionSchema = z
  .object({
    kind: z.literal("group_buy"),
    modelName: z.string().trim().min(1, "모델 이름을 입력해 주세요.").max(120),
    sellerName: z.string().trim().min(1, "판매자 이름을 입력해 주세요.").max(80),
    instagramHandle: z.string().trim().max(40).optional().default(""),
    priceKrw: z.number().int().positive().max(30_000_000).nullable().optional(),
    startsOn: day,
    endsOn: day,
    sourceUrl: httpUrl,
    hasMailOrderRegistration: z.boolean(),
    hasCoolingOff: z.boolean(),
    isOfficialImport: z.boolean(),
    isAd: z.boolean(),
    note: z.string().trim().max(1000).optional().default(""),
    contactEmail: z.string().trim().email("연락받을 이메일을 입력해 주세요."),
    company: z.string().optional().default(""),
  })
  .superRefine((value, ctx) => {
    if (value.endsOn < value.startsOn) {
      ctx.addIssue({ code: "custom", path: ["endsOn"], message: "종료일은 시작일보다 빠를 수 없습니다." });
    }
  });

export const tipSubmissionSchema = z.object({
  kind: z.literal("tip"),
  modelName: z.string().trim().min(1, "모델 이름을 입력해 주세요.").max(120),
  message: z.string().trim().min(4, "제보 내용을 조금 더 적어 주세요.").max(2000),
  sourceUrl: optionalHttpUrl,
  contactEmail: z.union([z.literal(""), z.string().trim().email("이메일 형식을 확인해 주세요.")]).optional(),
  company: z.string().optional().default(""),
});

export const submissionSchema = z.discriminatedUnion("kind", [groupBuySubmissionSchema, tipSubmissionSchema]);

export const newsletterSchema = z.object({
  email: z.string().trim().email("이메일 형식을 확인해 주세요.").max(200),
  source: z.string().trim().max(40).optional().default("web"),
  unsubscribe: z.boolean().optional().default(false),
  company: z.string().optional().default(""),
});

export const reviewSchema = z.object({
  status: z.enum(["pending", "approved", "rejected"]),
});

export const loginSchema = z.object({
  password: z.string().min(1, "비밀번호를 입력해 주세요."),
});
