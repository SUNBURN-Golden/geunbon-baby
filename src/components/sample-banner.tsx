import { getSampleState } from "@/server/catalog";
import { live } from "@/server/live";
import { getSql } from "@/server/sql";

export async function SampleBanner() {
  await live();
  let allSample = true;
  try {
    const state = await getSampleState(await getSql());
    allSample = state.allStoredPricesAreSample;
  } catch {
    allSample = true;
  }

  return (
    <div className="top-notice">
      <p>
        {allSample
          ? "지금 저장된 가격과 공구는 모두 샘플입니다. 실제 시세가 아닙니다."
          : "샘플로 표시된 금액은 실제 시세가 아닙니다."}{" "}
        근본은 거래 당사자가 아니며, 결제·계약은 각 판매처에서 이루어집니다.
      </p>
    </div>
  );
}
