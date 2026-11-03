import { describe, expect, it } from "vitest";

import type { RecoveryDigestView } from "../../contracts/p3-recovery.types";
import { harness } from "./terminal-fixture";

// spec §6.6 の図の値（見出し文は図の「（見出し文）」の所に置いた字）。U-T の unsatisfied と、beforeWindow の unit を 1 つ。
const head = (title: string, time: string, headline: string) => ({ headType: "VXSE53", operation: "normal" as const, title, headline,
  reportDateTime: `2026-11-03T${time}:00+09:00`, receivedAt: 0 });
const DIGEST: RecoveryDigestView = { units: [
  { unit: "U-T", beforeWindow: false, kind: "unsatisfied", reason: "fetchFailed" },
  { unit: "U-Q", beforeWindow: true, kind: "listed", heads: [head("震源・震度に関する情報", "06:12", "見出し 1"), head("震度速報", "04:40", "見出し 2"),
    head("震度速報", "02:31", "見出し 3")], omitted: { VXSE52: 2 } },
  { unit: "U-W", beforeWindow: false, kind: "listed", heads: [head("気象警報・注意報", "05:10", "見出し 4")], omitted: { VPWW54: 1 } },
] };

describe("P3-TO-T15 起動時のまとめ（spec §6.6、AC14）", () => {
  it("最初の digest だけを図の形で出し、digest の無い snapshot と 2 枚目以後は何も出さない", async () => {
    const h = harness();
    h.output.sink.digest(null);
    expect(h.lines).toEqual([]);
    h.output.sink.digest(DIGEST);
    h.output.sink.digest(DIGEST);
    expect(h.lines).toEqual([
      `━ 止まっていた間に出た情報（7 日前まで） ${"━".repeat(80 - 38 - 3)}`,
      "7 日より前の情報は取り直していません",
      "津波       取り直せませんでした",
      "地震       5 件",
      "  06:12  震源・震度に関する情報  見出し 1",
      "  04:40  震度速報                見出し 2",
      "  02:31  震度速報                見出し 3",
      "  ほか VXSE52 2 件",
      "気象警報   2 件",
      "  05:10  気象警報・注意報  見出し 4",
      "  ほか VPWW54 1 件",
    ]);
    await h.output.close();
  });
});
