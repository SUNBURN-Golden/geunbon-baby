import { describe, expect, it } from "vitest";
import { addDays, listingStatus, seoulToday } from "@/lib/dates";
import type { HistoryPoint } from "@/lib/types";
import { compareDeal, median } from "@/server/pricing";

function point(partial: Partial<HistoryPoint> & Pick<HistoryPoint, "channel" | "amountKrw">): HistoryPoint {
  return {
    checkedOn: "2026-10-01",
    isSample: true,
    sourceName: "샘플",
    ...partial,
  };
}

describe("compareDeal", () => {
  it("uses the median official price and ignores used and overseas lows", () => {
    const deal = compareDeal([
      point({ channel: "official", amountKrw: 429000, checkedOn: "2026-04-01" }),
      point({ channel: "official", amountKrw: 429000, checkedOn: "2026-06-01" }),
      point({ channel: "official", amountKrw: 449000, checkedOn: "2026-08-01" }),
      point({ channel: "official", amountKrw: 449000, checkedOn: "2026-10-01" }),
      point({ channel: "group_buy", amountKrw: 399000, checkedOn: "2026-09-01" }),
      point({ channel: "group_buy", amountKrw: 359000, checkedOn: "2026-10-18" }),
      point({ channel: "parallel_import", amountKrw: 389000, checkedOn: "2026-10-10" }),
      point({ channel: "overseas", amountKrw: 10000, checkedOn: "2026-10-18" }),
      point({ channel: "used", amountKrw: 10000, checkedOn: "2026-10-18" }),
    ]);

    expect(median([429000, 429000, 449000, 449000])).toBe(439000);
    expect(deal).toMatchObject({
      baselineKrw: 439000,
      currentKrw: 359000,
      currentChannel: "group_buy",
      percentOff: 18,
      basedOnSample: true,
    });
  });

  it("hides the badge without two official points or a 5 percent gap", () => {
    expect(compareDeal([point({ channel: "official", amountKrw: 100000 })])).toBeNull();
    expect(
      compareDeal([
        point({ channel: "official", amountKrw: 100000, checkedOn: "2026-01-01" }),
        point({ channel: "official", amountKrw: 100000, checkedOn: "2026-02-01" }),
        point({ channel: "group_buy", amountKrw: 97000, checkedOn: "2026-03-01" }),
      ]),
    ).toBeNull();
  });

  it("marks a real comparison when none of the inputs are samples", () => {
    const deal = compareDeal([
      point({ channel: "official", amountKrw: 200000, checkedOn: "2026-01-01", isSample: false }),
      point({ channel: "official", amountKrw: 200000, checkedOn: "2026-02-01", isSample: false }),
      point({ channel: "official", amountKrw: 100000, checkedOn: "2026-03-01", isSample: false }),
    ]);
    expect(deal?.basedOnSample).toBe(false);
    expect(deal?.percentOff).toBeGreaterThanOrEqual(5);
  });
});

describe("dates", () => {
  it("uses the Seoul calendar and classifies a listing window", () => {
    expect(seoulToday(new Date("2026-10-20T14:59:00Z"))).toBe("2026-10-20");
    expect(seoulToday(new Date("2026-10-20T15:00:00Z"))).toBe("2026-10-21");
    expect(addDays("2026-10-20", -3)).toBe("2026-10-17");
    expect(listingStatus("2026-10-21", "2026-10-28", "2026-10-20")).toBe("upcoming");
    expect(listingStatus("2026-10-14", "2026-10-28", "2026-10-20")).toBe("ongoing");
    expect(listingStatus("2026-09-01", "2026-09-10", "2026-10-20")).toBe("ended");
  });
});
