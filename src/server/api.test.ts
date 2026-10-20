import { beforeAll, describe, expect, it } from "vitest";
import { priceInputSchema, submissionSchema } from "@/lib/schemas";
import { GET as getModel } from "@/app/api/models/[slug]/route";
import { POST as postNewsletter } from "@/app/api/newsletter/route";
import { POST as postSubmission } from "@/app/api/submissions/route";
import { POST as postLogin } from "@/app/api/admin/login/route";
import { POST as postAdminCollection } from "@/app/api/admin/[resource]/route";
import { GET as getHome } from "@/app/api/home/route";
import { createMemoryDatabase, setSqlForTests, type Sql } from "@/server/sql";
import { getModelDetail, getSampleState } from "@/server/catalog";

let sql: Sql;

beforeAll(async () => {
  sql = await createMemoryDatabase();
  setSqlForTests(sql);
});

function jsonRequest(url: string, body: unknown, cookie?: string) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("seeded catalog", () => {
  it("keeps every seeded price and listing marked as a sample placeholder", async () => {
    const prices = await sql.query<{ is_sample: boolean; source_url: string; source_name: string }>(
      "SELECT is_sample, source_url, source_name FROM price_quotes",
    );
    expect(prices.length).toBeGreaterThan(40);
    for (const price of prices) {
      expect(price.is_sample).toBe(true);
      expect(price.source_url.startsWith("https://example.com/sample/prices/")).toBe(true);
      expect(price.source_name).toContain("샘플");
    }
    const listings = await sql.query<{ is_sample: boolean; seller_name: string; source_url: string; title: string }>(
      "SELECT is_sample, seller_name, source_url, title FROM group_buys",
    );
    for (const listing of listings) {
      expect(listing.is_sample).toBe(true);
      expect(listing.seller_name).toContain("샘플");
      expect(listing.title).toContain("샘플");
      expect(listing.source_url.startsWith("https://example.com/sample/group-buys/")).toBe(true);
    }
    const state = await getSampleState(sql);
    expect(state.allStoredPricesAreSample).toBe(true);
    expect(state.realPriceCount).toBe(0);
  });

  it("builds the Tripp Trapp comparison, sample badge, and checklist", async () => {
    const detail = await getModelDetail(sql, "stokke-tripp-trapp");
    expect(detail).not.toBeNull();
    expect(detail?.comparison.map((row) => row.channel)).toEqual([
      "group_buy",
      "official",
      "parallel_import",
      "overseas",
      "used",
    ]);
    expect(detail?.comparison.every((row) => row.quote?.isSample)).toBe(true);
    expect(detail?.deal).toMatchObject({
      percentOff: 18,
      currentChannel: "group_buy",
      currentKrw: 359000,
      basedOnSample: true,
    });
    expect(detail?.model.checklistIsSample).toBe(true);
    expect(detail?.model.importerName).toContain("샘플");
    expect(detail?.groupBuys.some((item) => item.isOfficialImport && item.hasCoolingOff && item.hasMailOrderRegistration)).toBe(
      true,
    );

    const fox = await getModelDetail(sql, "bugaboo-fox-5");
    expect(fox?.deal?.percentOff).toBe(15);
    const priam = await getModelDetail(sql, "cybex-priam");
    expect(priam?.deal).toBeNull();
    const bouncer = await getModelDetail(sql, "babybjorn-bouncer-bliss");
    expect(bouncer?.deal).toBeNull();
  });
});

describe("public api", () => {
  it("returns the home feed and a model document", async () => {
    const homeResponse = await getHome();
    const home = await homeResponse.json();
    expect(home.ok).toBe(true);
    expect(home.meta.pricesAreSample).toBe(true);
    expect(home.meta.notAParty).toBe(true);
    expect(home.data.featured.some((model: { slug: string }) => model.slug === "stokke-tripp-trapp")).toBe(true);

    const response = await getModel(new Request("http://localhost/api/models/stokke-tripp-trapp"), {
      params: Promise.resolve({ slug: "stokke-tripp-trapp" }),
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.deal.percentOff).toBe(18);
    expect(body.meta.linkOutOnly).toBe(true);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("stores a tip and a newsletter address, and rejects unsafe links", async () => {
    expect(submissionSchema.safeParse({ kind: "tip", modelName: "트립트랩", message: "짧은", sourceUrl: "javascript:alert(1)" }).success).toBe(
      false,
    );
    const submission = await postSubmission(
      jsonRequest("http://localhost/api/submissions", {
        kind: "group_buy",
        modelName: "트립트랩",
        sellerName: "샘플 제보",
        instagramHandle: "",
        priceKrw: 350000,
        startsOn: "2026-11-01",
        endsOn: "2026-11-07",
        sourceUrl: "https://example.com/sample/tip",
        hasMailOrderRegistration: true,
        hasCoolingOff: true,
        isOfficialImport: false,
        isAd: false,
        note: "검토 전",
        contactEmail: "host@example.com",
      }),
    );
    expect(submission.status).toBe(201);
    const stored = await sql.query("SELECT status FROM submissions");
    expect(stored).toEqual([{ status: "pending" }]);

    const newsletter = await postNewsletter(
      jsonRequest("http://localhost/api/newsletter", { email: "Reader@Example.com", source: "home" }),
    );
    expect(newsletter.status).toBe(201);
    const duplicate = await postNewsletter(
      jsonRequest("http://localhost/api/newsletter", { email: "reader@example.com", source: "home" }),
    );
    const duplicateBody = await duplicate.json();
    expect(duplicateBody.data.status).toBe("exists");
  });

  it("requires an admin session before a price can be saved as real", async () => {
    const anonymous = await postAdminCollection(jsonRequest("http://localhost/api/admin/prices", { amountKrw: 1 }), {
      params: Promise.resolve({ resource: "prices" }),
    });
    expect(anonymous.status).toBe(401);

    const rejected = await postLogin(jsonRequest("http://localhost/api/admin/login", { password: "nope" }));
    expect(rejected.status).toBe(401);

    const login = await postLogin(jsonRequest("http://localhost/api/admin/login", { password: "test-admin-password" }));
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0];
    expect(cookie?.startsWith("geunbon_session=")).toBe(true);
    expect(setCookie).not.toMatch(/;\s*Secure\b/);
    const httpsLogin = await postLogin(
      new Request("http://localhost/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
        body: JSON.stringify({ password: "test-admin-password" }),
      }),
    );
    expect(httpsLogin.headers.get("set-cookie")).toMatch(/;\s*Secure\b/);

    const models = await sql.query<{ id: string }>("SELECT id FROM models WHERE slug = 'stokke-tripp-trapp'");
    const realWithoutConfirm = priceInputSchema.safeParse({
      modelId: models[0].id,
      channel: "official",
      amountKrw: 410000,
      sourceName: "확인한 출처",
      sourceUrl: "https://example.com/real",
      checkedOn: "2026-10-20",
      isSample: false,
    });
    expect(realWithoutConfirm.success).toBe(false);

    const created = await postAdminCollection(
      jsonRequest(
        "http://localhost/api/admin/prices",
        {
          modelId: models[0].id,
          channel: "official",
          amountKrw: 410000,
          sourceName: "확인한 출처",
          sourceUrl: "https://example.com/real",
          checkedOn: "2026-10-20",
          isSample: false,
          confirmRealPrice: true,
          note: "테스트에서만 실제 가격으로 저장",
        },
        cookie,
      ),
      { params: Promise.resolve({ resource: "prices" }) },
    );
    expect(created.status).toBe(201);
    const state = await getSampleState(sql);
    expect(state.realPriceCount).toBe(1);
    expect(state.allStoredPricesAreSample).toBe(false);
  });
});
