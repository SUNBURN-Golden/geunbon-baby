"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CATEGORIES, CHANNELS, channelLabel, formatDate, formatKrw } from "@/lib/labels";
import type { AdminPrice, Brand, BrandEvent, GroupBuy, ModelWithBrand, Submission, Subscriber } from "@/lib/types";

async function send(url: string, method: string, body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.ok) {
    throw new Error(json?.error?.message ?? "요청에 실패했습니다.");
  }
  return json.data;
}

function useSaver() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function run(action: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await action();
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "요청에 실패했습니다.");
    } finally {
      setPending(false);
    }
  }
  return { error, pending, run };
}

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      className="button ghost"
      type="button"
      onClick={async () => {
        await fetch("/api/admin/logout", { method: "POST" });
        router.push("/admin/login");
        router.refresh();
      }}
    >
      로그아웃
    </button>
  );
}

export function LoginForm({ hint, nextPath }: { hint: string | null; nextPath: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <form
      className="form"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        const password = String(new FormData(event.currentTarget).get("password") ?? "");
        const response = await fetch("/api/admin/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password }),
        });
        const body = await response.json().catch(() => null);
        setPending(false);
        if (!response.ok || !body?.ok) {
          setError(body?.error?.message ?? "로그인하지 못했습니다.");
          return;
        }
        window.location.assign(nextPath);
      }}
    >
      <label className="field">
        <span>비밀번호</span>
        <input name="password" type="password" required autoComplete="current-password" />
      </label>
      {hint ? <p className="note">개발 기본 비밀번호: {hint}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
      <button className="button" type="submit" disabled={pending}>
        로그인
      </button>
    </form>
  );
}

export function BrandManager({ brands }: { brands: Brand[] }) {
  const [editing, setEditing] = useState<Brand | null>(null);
  const { error, pending, run } = useSaver();
  return (
    <div>
      <div className="admin-list">
        {brands.map((brand) => (
          <article key={brand.id}>
            <strong>
              {brand.nameKo} · {brand.name}
            </strong>
            <p className="meta">/{brand.slug}</p>
            <div className="row-actions">
              <button className="button ghost" type="button" onClick={() => setEditing(brand)}>
                수정
              </button>
              <button
                className="button ghost"
                type="button"
                onClick={() =>
                  void run(async () => {
                    if (!window.confirm("브랜드와 연결된 모델, 가격, 공구가 함께 삭제됩니다.")) return;
                    await send(`/api/admin/brands/${brand.id}`, "DELETE");
                    if (editing?.id === brand.id) setEditing(null);
                  })
                }
              >
                삭제
              </button>
            </div>
          </article>
        ))}
      </div>
      <form
        key={editing?.id ?? "new"}
        className="form panel"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const body = {
            slug: String(form.get("slug") ?? ""),
            name: String(form.get("name") ?? ""),
            nameKo: String(form.get("nameKo") ?? ""),
            country: String(form.get("country") ?? ""),
            websiteUrl: String(form.get("websiteUrl") ?? ""),
            summary: String(form.get("summary") ?? ""),
          };
          void run(async () => {
            await send(editing ? `/api/admin/brands/${editing.id}` : "/api/admin/brands", editing ? "PATCH" : "POST", body);
            setEditing(null);
          });
        }}
      >
        <h2>{editing ? "브랜드 수정" : "브랜드 추가"}</h2>
        <div className="form-row">
          <label className="field">
            <span>슬러그</span>
            <input name="slug" defaultValue={editing?.slug ?? ""} required />
          </label>
          <label className="field">
            <span>영문 이름</span>
            <input name="name" defaultValue={editing?.name ?? ""} required />
          </label>
        </div>
        <div className="form-row">
          <label className="field">
            <span>한글 이름</span>
            <input name="nameKo" defaultValue={editing?.nameKo ?? ""} required />
          </label>
          <label className="field">
            <span>나라</span>
            <input name="country" defaultValue={editing?.country ?? ""} />
          </label>
        </div>
        <label className="field">
          <span>브랜드 사이트</span>
          <input name="websiteUrl" type="url" defaultValue={editing?.websiteUrl ?? ""} />
        </label>
        <label className="field">
          <span>소개</span>
          <textarea name="summary" defaultValue={editing?.summary ?? ""} />
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="row-actions">
          <button className="button" disabled={pending} type="submit">
            저장
          </button>
          {editing ? (
            <button className="button ghost" type="button" onClick={() => setEditing(null)}>
              새로 입력
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

export function ModelManager({ models, brands }: { models: ModelWithBrand[]; brands: Brand[] }) {
  const [editing, setEditing] = useState<ModelWithBrand | null>(null);
  const { error, pending, run } = useSaver();
  return (
    <div>
      <div className="admin-list">
        {models.map((model) => (
          <article key={model.id}>
            <strong>
              {model.brandNameKo} {model.nameKo}
            </strong>
            <p className="meta">/models/{model.slug}</p>
            <div className="row-actions">
              <button className="button ghost" type="button" onClick={() => setEditing(model)}>
                수정
              </button>
              <button
                className="button ghost"
                type="button"
                onClick={() =>
                  void run(async () => {
                    if (!window.confirm("모델과 가격, 공구가 삭제됩니다.")) return;
                    await send(`/api/admin/models/${model.id}`, "DELETE");
                  })
                }
              >
                삭제
              </button>
            </div>
          </article>
        ))}
      </div>
      <form
        key={editing?.id ?? "new"}
        className="form panel"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const body = {
            brandId: String(form.get("brandId") ?? ""),
            slug: String(form.get("slug") ?? ""),
            name: String(form.get("name") ?? ""),
            nameKo: String(form.get("nameKo") ?? ""),
            category: String(form.get("category") ?? ""),
            summary: String(form.get("summary") ?? ""),
            featured: form.get("featured") === "on",
            sortOrder: Number(form.get("sortOrder") ?? 0),
            kcMark: form.get("kcMark") === "on",
            importerName: String(form.get("importerName") ?? ""),
            domesticAs: form.get("domesticAs") === "on",
            warrantyNote: String(form.get("warrantyNote") ?? ""),
            checklistIsSample: form.get("checklistIsSample") === "on",
          };
          void run(async () => {
            await send(editing ? `/api/admin/models/${editing.id}` : "/api/admin/models", editing ? "PATCH" : "POST", body);
            setEditing(null);
          });
        }}
      >
        <h2>{editing ? "모델 수정" : "모델 추가"}</h2>
        <label className="field">
          <span>브랜드</span>
          <select name="brandId" defaultValue={editing?.brandId ?? brands[0]?.id}>
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.nameKo}
              </option>
            ))}
          </select>
        </label>
        <div className="form-row">
          <label className="field">
            <span>슬러그</span>
            <input name="slug" defaultValue={editing?.slug ?? ""} required />
          </label>
          <label className="field">
            <span>카테고리</span>
            <select name="category" defaultValue={editing?.category ?? "stroller"}>
              {CATEGORIES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-row">
          <label className="field">
            <span>영문 이름</span>
            <input name="name" defaultValue={editing?.name ?? ""} required />
          </label>
          <label className="field">
            <span>한글 이름</span>
            <input name="nameKo" defaultValue={editing?.nameKo ?? ""} required />
          </label>
        </div>
        <label className="field">
          <span>소개</span>
          <textarea name="summary" defaultValue={editing?.summary ?? ""} />
        </label>
        <label className="field">
          <span>정렬</span>
          <input name="sortOrder" type="number" defaultValue={editing?.sortOrder ?? 0} />
        </label>
        <div className="checks">
          <label>
            <input name="featured" type="checkbox" defaultChecked={editing?.featured ?? false} /> 홈에 노출
          </label>
          <label>
            <input name="kcMark" type="checkbox" defaultChecked={editing?.kcMark ?? false} /> KC마크 있음으로 등록
          </label>
          <label>
            <input name="domesticAs" type="checkbox" defaultChecked={editing?.domesticAs ?? false} /> 국내 A/S 있음으로 등록
          </label>
          <label>
            <input name="checklistIsSample" type="checkbox" defaultChecked={editing?.checklistIsSample ?? true} /> 체크리스트는
            샘플
          </label>
        </div>
        <label className="field">
          <span>수입업자</span>
          <input name="importerName" defaultValue={editing?.importerName ?? ""} />
        </label>
        <label className="field">
          <span>보증 메모</span>
          <input name="warrantyNote" defaultValue={editing?.warrantyNote ?? ""} />
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <button className="button" disabled={pending} type="submit">
          저장
        </button>
      </form>
    </div>
  );
}

export function PriceManager({ prices, models }: { prices: AdminPrice[]; models: ModelWithBrand[] }) {
  const [editing, setEditing] = useState<AdminPrice | null>(null);
  const { error, pending, run } = useSaver();
  return (
    <div>
      <p className="note">기본값은 샘플입니다. 실제 가격은 샘플 체크를 끄고, 확인 체크를 해야 저장됩니다.</p>
      <div className="admin-list">
        {prices.slice(0, 40).map((price) => (
          <article key={price.id}>
            <strong>
              {price.modelNameKo} · {channelLabel(price.channel)} · {formatKrw(price.amountKrw)}
            </strong>
            <p className="meta">
              {formatDate(price.checkedOn)} · {price.isSample ? "샘플" : "실제"} · {price.sourceName}
            </p>
            <div className="row-actions">
              <button className="button ghost" type="button" onClick={() => setEditing(price)}>
                수정
              </button>
              <button className="button ghost" type="button" onClick={() => void run(async () => send(`/api/admin/prices/${price.id}`, "DELETE"))}>
                삭제
              </button>
            </div>
          </article>
        ))}
      </div>
      <form
        key={editing?.id ?? "new"}
        className="form panel"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const body = {
            modelId: String(form.get("modelId") ?? ""),
            channel: String(form.get("channel") ?? ""),
            amountKrw: Number(form.get("amountKrw") ?? 0),
            sourceName: String(form.get("sourceName") ?? ""),
            sourceUrl: String(form.get("sourceUrl") ?? ""),
            checkedOn: String(form.get("checkedOn") ?? ""),
            isSample: form.get("isSample") === "on",
            confirmRealPrice: form.get("confirmRealPrice") === "on",
            note: String(form.get("note") ?? ""),
          };
          void run(async () => {
            await send(editing ? `/api/admin/prices/${editing.id}` : "/api/admin/prices", editing ? "PATCH" : "POST", body);
            setEditing(null);
          });
        }}
      >
        <h2>{editing ? "가격 수정" : "가격 추가"}</h2>
        <div className="form-row">
          <label className="field">
            <span>모델</span>
            <select name="modelId" defaultValue={editing?.modelId ?? models[0]?.id}>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.brandNameKo} {model.nameKo}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>구분</span>
            <select name="channel" defaultValue={editing?.channel ?? "official"}>
              {CHANNELS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-row">
          <label className="field">
            <span>금액 (원)</span>
            <input name="amountKrw" type="number" min={0} defaultValue={editing?.amountKrw ?? 0} required />
          </label>
          <label className="field">
            <span>확인일</span>
            <input name="checkedOn" type="date" defaultValue={editing?.checkedOn ?? ""} required />
          </label>
        </div>
        <label className="field">
          <span>출처 이름</span>
          <input name="sourceName" defaultValue={editing?.sourceName ?? "샘플 출처"} required />
        </label>
        <label className="field">
          <span>출처 링크</span>
          <input name="sourceUrl" type="url" defaultValue={editing?.sourceUrl ?? "https://example.com/sample/prices/manual"} required />
        </label>
        <label className="field">
          <span>메모</span>
          <input name="note" defaultValue={editing?.note ?? ""} />
        </label>
        <div className="checks">
          <label>
            <input name="isSample" type="checkbox" defaultChecked={editing?.isSample ?? true} /> 샘플 가격
          </label>
          <label>
            <input name="confirmRealPrice" type="checkbox" /> 샘플이 아닌 실제 확인 가격으로 저장합니다
          </label>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
        <button className="button" disabled={pending} type="submit">
          저장
        </button>
      </form>
    </div>
  );
}

export function GroupBuyManager({ listings, models }: { listings: GroupBuy[]; models: ModelWithBrand[] }) {
  const [editing, setEditing] = useState<GroupBuy | null>(null);
  const { error, pending, run } = useSaver();
  return (
    <div>
      <div className="admin-list">
        {listings.map((item) => (
          <article key={item.id}>
            <strong>
              {item.isAd ? "광고 · " : ""}
              {item.title}
            </strong>
            <p className="meta">
              {item.modelNameKo} · {item.isSample ? "샘플" : "실제"}
            </p>
            <div className="row-actions">
              <button className="button ghost" type="button" onClick={() => setEditing(item)}>
                수정
              </button>
              <button
                className="button ghost"
                type="button"
                onClick={() => void run(async () => send(`/api/admin/group-buys/${item.id}`, "DELETE"))}
              >
                삭제
              </button>
            </div>
          </article>
        ))}
      </div>
      <form
        key={editing?.id ?? "new"}
        className="form panel"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const price = String(form.get("priceKrw") ?? "");
          const body = {
            modelId: String(form.get("modelId") ?? ""),
            title: String(form.get("title") ?? ""),
            sellerName: String(form.get("sellerName") ?? ""),
            instagramHandle: String(form.get("instagramHandle") ?? ""),
            priceKrw: price ? Number(price) : null,
            startsOn: String(form.get("startsOn") ?? ""),
            endsOn: String(form.get("endsOn") ?? ""),
            sourceUrl: String(form.get("sourceUrl") ?? ""),
            isAd: form.get("isAd") === "on",
            isSample: form.get("isSample") === "on",
            confirmRealListing: form.get("confirmRealListing") === "on",
            hasMailOrderRegistration: form.get("hasMailOrderRegistration") === "on",
            hasCoolingOff: form.get("hasCoolingOff") === "on",
            isOfficialImport: form.get("isOfficialImport") === "on",
            note: String(form.get("note") ?? ""),
          };
          void run(async () => {
            await send(
              editing ? `/api/admin/group-buys/${editing.id}` : "/api/admin/group-buys",
              editing ? "PATCH" : "POST",
              body,
            );
            setEditing(null);
          });
        }}
      >
        <h2>{editing ? "공구 수정" : "공구 추가"}</h2>
        <label className="field">
          <span>모델</span>
          <select name="modelId" defaultValue={editing?.modelId ?? models[0]?.id}>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.nameKo}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>제목</span>
          <input name="title" defaultValue={editing?.title ?? ""} required />
        </label>
        <div className="form-row">
          <label className="field">
            <span>판매자</span>
            <input name="sellerName" defaultValue={editing?.sellerName ?? ""} required />
          </label>
          <label className="field">
            <span>인스타그램</span>
            <input name="instagramHandle" defaultValue={editing?.instagramHandle ?? ""} />
          </label>
        </div>
        <div className="form-row">
          <label className="field">
            <span>가격</span>
            <input name="priceKrw" type="number" defaultValue={editing?.priceKrw ?? ""} />
          </label>
          <label className="field">
            <span>출처</span>
            <input name="sourceUrl" type="url" defaultValue={editing?.sourceUrl ?? "https://example.com/sample/group-buys/manual"} required />
          </label>
        </div>
        <div className="form-row">
          <label className="field">
            <span>시작</span>
            <input name="startsOn" type="date" defaultValue={editing?.startsOn ?? ""} required />
          </label>
          <label className="field">
            <span>종료</span>
            <input name="endsOn" type="date" defaultValue={editing?.endsOn ?? ""} required />
          </label>
        </div>
        <div className="checks">
          <label>
            <input name="isSample" type="checkbox" defaultChecked={editing?.isSample ?? true} /> 샘플
          </label>
          <label>
            <input name="confirmRealListing" type="checkbox" /> 실제 공구로 저장
          </label>
          <label>
            <input name="isAd" type="checkbox" defaultChecked={editing?.isAd ?? false} /> 광고
          </label>
          <label>
            <input name="hasMailOrderRegistration" type="checkbox" defaultChecked={editing?.hasMailOrderRegistration ?? false} />{" "}
            통신판매업 신고
          </label>
          <label>
            <input name="hasCoolingOff" type="checkbox" defaultChecked={editing?.hasCoolingOff ?? false} /> 청약철회 7일
          </label>
          <label>
            <input name="isOfficialImport" type="checkbox" defaultChecked={editing?.isOfficialImport ?? false} /> 정식수입
          </label>
        </div>
        <label className="field">
          <span>메모</span>
          <textarea name="note" defaultValue={editing?.note ?? ""} />
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <button className="button" disabled={pending} type="submit">
          저장
        </button>
      </form>
    </div>
  );
}

export function EventManager({ events, brands }: { events: BrandEvent[]; brands: Brand[] }) {
  const [editing, setEditing] = useState<BrandEvent | null>(null);
  const { error, pending, run } = useSaver();
  return (
    <div>
      <div className="admin-list">
        {events.map((event) => (
          <article key={event.id}>
            <strong>{event.title}</strong>
            <p className="meta">{event.brandNameKo}</p>
            <div className="row-actions">
              <button className="button ghost" type="button" onClick={() => setEditing(event)}>
                수정
              </button>
              <button className="button ghost" type="button" onClick={() => void run(async () => send(`/api/admin/events/${event.id}`, "DELETE"))}>
                삭제
              </button>
            </div>
          </article>
        ))}
      </div>
      <form
        key={editing?.id ?? "new"}
        className="form panel"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const body = {
            brandId: String(form.get("brandId") ?? ""),
            title: String(form.get("title") ?? ""),
            summary: String(form.get("summary") ?? ""),
            startsOn: String(form.get("startsOn") ?? ""),
            endsOn: String(form.get("endsOn") ?? ""),
            sourceUrl: String(form.get("sourceUrl") ?? ""),
            isSample: form.get("isSample") === "on",
            confirmRealEvent: form.get("confirmRealEvent") === "on",
          };
          void run(async () => {
            await send(editing ? `/api/admin/events/${editing.id}` : "/api/admin/events", editing ? "PATCH" : "POST", body);
            setEditing(null);
          });
        }}
      >
        <h2>{editing ? "행사 수정" : "행사 추가"}</h2>
        <label className="field">
          <span>브랜드</span>
          <select name="brandId" defaultValue={editing?.brandId ?? brands[0]?.id}>
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.nameKo}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>제목</span>
          <input name="title" defaultValue={editing?.title ?? ""} required />
        </label>
        <label className="field">
          <span>설명</span>
          <textarea name="summary" defaultValue={editing?.summary ?? ""} />
        </label>
        <div className="form-row">
          <label className="field">
            <span>시작</span>
            <input name="startsOn" type="date" defaultValue={editing?.startsOn ?? ""} required />
          </label>
          <label className="field">
            <span>종료</span>
            <input name="endsOn" type="date" defaultValue={editing?.endsOn ?? ""} required />
          </label>
        </div>
        <label className="field">
          <span>링크</span>
          <input name="sourceUrl" type="url" defaultValue={editing?.sourceUrl ?? ""} />
        </label>
        <div className="checks">
          <label>
            <input name="isSample" type="checkbox" defaultChecked={editing?.isSample ?? true} /> 샘플
          </label>
          <label>
            <input name="confirmRealEvent" type="checkbox" /> 실제 행사로 저장
          </label>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
        <button className="button" disabled={pending} type="submit">
          저장
        </button>
      </form>
    </div>
  );
}

export function SubmissionManager({ submissions }: { submissions: Submission[] }) {
  const { error, pending, run } = useSaver();
  return (
    <div className="stack">
      <p className="note">승인해도 공개 목록에 자동으로 올라가지 않습니다. 가격과 공구는 각 관리 화면에서 직접 등록합니다.</p>
      {error ? <p className="form-error">{error}</p> : null}
      {submissions.length === 0 ? <p>대기 중인 제보가 없습니다.</p> : null}
      {submissions.map((item) => (
        <article key={item.id} className="panel">
          <p className="meta">
            {item.kind === "group_buy" ? "공구 제보" : "정보 제보"} · {item.status} · {item.contactEmail ?? "이메일 없음"}
          </p>
          <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{JSON.stringify(item.payload, null, 2)}</pre>
          <div className="row-actions">
            {(["approved", "rejected", "pending"] as const).map((status) => (
              <button
                key={status}
                className="button ghost"
                type="button"
                disabled={pending || item.status === status}
                onClick={() => void run(async () => send(`/api/admin/submissions/${item.id}`, "PATCH", { status }))}
              >
                {status === "approved" ? "승인" : status === "rejected" ? "거절" : "대기로"}
              </button>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}

export function SubscriberTable({ subscribers }: { subscribers: Subscriber[] }) {
  if (subscribers.length === 0) return <p>저장된 이메일이 없습니다.</p>;
  return (
    <div className="table-scroll">
      <table className="compare">
        <thead>
          <tr>
            <th>이메일</th>
            <th>출처</th>
            <th>저장 시각</th>
          </tr>
        </thead>
        <tbody>
          {subscribers.map((subscriber) => (
            <tr key={subscriber.id}>
              <td>{subscriber.email}</td>
              <td>{subscriber.source}</td>
              <td>{subscriber.createdAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
