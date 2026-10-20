import { SubmitForm } from "@/components/submit-form";

export const dynamic = "force-dynamic";

export const metadata = { title: "제보" };

export default function SubmitPage() {
  return (
    <section className="wrap section">
      <p className="kicker">호스트 · 독자</p>
      <h1 className="serif" style={{ fontSize: "clamp(36px, 6vw, 52px)", margin: "0 0 8px" }}>
        제보
      </h1>
      <p className="lede">
        공구 일정이나 가격 단서를 남겨 주세요. 저장만 되고 바로 공개되지 않습니다. 검토 뒤 관리자가 가격·공구를 직접
        등록합니다.
      </p>
      <SubmitForm />
    </section>
  );
}
