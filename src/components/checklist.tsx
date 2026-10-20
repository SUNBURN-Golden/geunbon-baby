import type { ModelWithBrand } from "@/lib/types";

export function Checklist({ model }: { model: ModelWithBrand }) {
  const rows = [
    {
      label: "KC마크",
      value: model.kcMark ? "있음으로 등록" : "없음으로 등록",
    },
    {
      label: "수입업자",
      value: model.importerName ?? "미기재",
    },
    {
      label: "국내 A/S · 보증",
      value: model.domesticAs ? model.warrantyNote ?? "있음으로 등록" : "없음으로 등록",
    },
  ];
  return (
    <section>
      <div className="section-head">
        <h2>정식수입 체크리스트</h2>
      </div>
      {model.checklistIsSample ? (
        <p className="note">
          아래 값은 샘플로 넣어 둔 자리입니다. 실제 KC 인증, 수입업자, 국내 보증을 확인한 결과가 아닙니다. 제품 라벨과
          판매처 고지를 직접 보세요.
        </p>
      ) : (
        <p className="note">등록된 참고 정보입니다. 구매 전에 판매처와 제품 라벨에서 다시 확인하세요.</p>
      )}
      <ul className="checklist">
        {rows.map((row) => (
          <li key={row.label}>
            <strong>{row.label}</strong>
            <span>{row.value}</span>
            {model.checklistIsSample ? <span className="pill sample">샘플</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
