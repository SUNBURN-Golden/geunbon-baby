"use client";

import { useState } from "react";

const initial = {
  kind: "group_buy" as "group_buy" | "tip",
  modelName: "",
  sellerName: "",
  instagramHandle: "",
  priceKrw: "",
  startsOn: "",
  endsOn: "",
  sourceUrl: "",
  note: "",
  message: "",
  contactEmail: "",
  hasMailOrderRegistration: false,
  hasCoolingOff: false,
  isOfficialImport: false,
  isAd: false,
};

export function SubmitForm() {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  function set<K extends keyof typeof initial>(key: K, value: (typeof initial)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const company = String(new FormData(event.currentTarget).get("company") ?? "");
    const payload =
      form.kind === "group_buy"
        ? {
            kind: "group_buy" as const,
            modelName: form.modelName,
            sellerName: form.sellerName,
            instagramHandle: form.instagramHandle,
            priceKrw: form.priceKrw ? Number(form.priceKrw) : null,
            startsOn: form.startsOn,
            endsOn: form.endsOn,
            sourceUrl: form.sourceUrl,
            hasMailOrderRegistration: form.hasMailOrderRegistration,
            hasCoolingOff: form.hasCoolingOff,
            isOfficialImport: form.isOfficialImport,
            isAd: form.isAd,
            note: form.note,
            contactEmail: form.contactEmail,
            company,
          }
        : {
            kind: "tip" as const,
            modelName: form.modelName,
            message: form.message,
            sourceUrl: form.sourceUrl,
            contactEmail: form.contactEmail,
            company,
          };
    const response = await fetch("/api/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => null);
    setPending(false);
    if (!response.ok || !body?.ok) {
      setError(body?.error?.message ?? "제보를 저장하지 못했습니다.");
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <p className="form-success">
        검토 대기열에 저장했습니다. 바로 공개되지 않으며, 가격과 공구는 관리자가 확인한 뒤에만 등록합니다.
      </p>
    );
  }

  return (
    <form className="form" onSubmit={onSubmit}>
      <div className="filters" role="tablist" aria-label="제보 종류">
        <button className="button" type="button" aria-pressed={form.kind === "group_buy"} onClick={() => set("kind", "group_buy")}>
          공구 제보
        </button>
        <button className="button ghost" type="button" aria-pressed={form.kind === "tip"} onClick={() => set("kind", "tip")}>
          정보 제보
        </button>
      </div>
      <label className="honeypot" aria-hidden="true">
        회사
        <input tabIndex={-1} autoComplete="off" name="company" />
      </label>
      <label className="field">
        <span>모델 이름</span>
        <input value={form.modelName} onChange={(event) => set("modelName", event.target.value)} required />
      </label>
      {form.kind === "group_buy" ? (
        <>
          <div className="form-row">
            <label className="field">
              <span>판매자</span>
              <input value={form.sellerName} onChange={(event) => set("sellerName", event.target.value)} required />
            </label>
            <label className="field">
              <span>인스타그램</span>
              <input value={form.instagramHandle} onChange={(event) => set("instagramHandle", event.target.value)} placeholder="@handle" />
            </label>
          </div>
          <div className="form-row">
            <label className="field">
              <span>공구가 (원)</span>
              <input inputMode="numeric" value={form.priceKrw} onChange={(event) => set("priceKrw", event.target.value)} />
            </label>
            <label className="field">
              <span>출처 링크</span>
              <input type="url" value={form.sourceUrl} onChange={(event) => set("sourceUrl", event.target.value)} required />
            </label>
          </div>
          <div className="form-row">
            <label className="field">
              <span>시작일</span>
              <input type="date" value={form.startsOn} onChange={(event) => set("startsOn", event.target.value)} required />
            </label>
            <label className="field">
              <span>종료일</span>
              <input type="date" value={form.endsOn} onChange={(event) => set("endsOn", event.target.value)} required />
            </label>
          </div>
          <div className="checks">
            <label>
              <input type="checkbox" checked={form.hasMailOrderRegistration} onChange={(event) => set("hasMailOrderRegistration", event.target.checked)} />
              통신판매업 신고가 있다고 합니다
            </label>
            <label>
              <input type="checkbox" checked={form.hasCoolingOff} onChange={(event) => set("hasCoolingOff", event.target.checked)} />
              청약철회 7일을 안내한다고 합니다
            </label>
            <label>
              <input type="checkbox" checked={form.isOfficialImport} onChange={(event) => set("isOfficialImport", event.target.checked)} />
              정식수입이라고 합니다
            </label>
            <label>
              <input type="checkbox" checked={form.isAd} onChange={(event) => set("isAd", event.target.checked)} />
              유료 게재(광고)입니다
            </label>
          </div>
          <label className="field">
            <span>메모</span>
            <textarea value={form.note} onChange={(event) => set("note", event.target.value)} />
          </label>
          <label className="field">
            <span>연락 이메일</span>
            <input type="email" value={form.contactEmail} onChange={(event) => set("contactEmail", event.target.value)} required />
          </label>
        </>
      ) : (
        <>
          <label className="field">
            <span>내용</span>
            <textarea value={form.message} onChange={(event) => set("message", event.target.value)} required minLength={4} />
          </label>
          <label className="field">
            <span>출처 링크 (선택)</span>
            <input type="url" value={form.sourceUrl} onChange={(event) => set("sourceUrl", event.target.value)} />
          </label>
          <label className="field">
            <span>이메일 (선택)</span>
            <input type="email" value={form.contactEmail} onChange={(event) => set("contactEmail", event.target.value)} />
          </label>
        </>
      )}
      {error ? <p className="form-error">{error}</p> : null}
      <button className="button" type="submit" disabled={pending}>
        검토 대기열에 저장
      </button>
    </form>
  );
}
