import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import VolcanoCard from "../VolcanoCard.svelte";
import type { ActiveStandbyCardV1, DisplayVolcanoEventV1 } from "../../lib/protocol";

/**
 * 実機の VolcanoCard は connection.state.snapshot 経由で props を受け取る。
 * connection.svelte.ts の `$state` が深いリアクティブ Proxy を張るため、item と
 * その内部オブジェクトはすべて Proxy になる。structuredClone は Proxy を複製できず
 * DataCloneError を投げるので、初回描画がここで止まっていた。
 * 既存の volcano-card.test.ts は素の object を渡すため、この経路を踏めない。
 */

type VolcanoItem = Extract<ActiveStandbyCardV1, { kind: "volcano" }>;

function eruptionEvent(): DisplayVolcanoEventV1 {
  return {
    label: "噴火",
    craterName: "山頂火口",
    eventDateTime: "2026-07-21T09:05:00+09:00",
    plumeHeightM: 2500,
    plumeHeightUnknown: false,
    plumeDirection: "南東",
  };
}

/** 噴火警報のみ (summaryOnly 経路) */
function summaryItem(): VolcanoItem {
  return {
    kind: "volcano", surface: "corner-right", key: "volcano:active", sourceEventIds: ["volcano-1"],
    updatedAt: "2026-07-21T00:00:00.000Z", expiresAt: null, restored: false, severity: "critical",
    data: { volcanoes: [{ code: "V-1", name: "Mount Test", alertLevel: 4, latestEvent: eruptionEvent() }] },
  };
}

/** 降灰予報つき (ashfallOnly / group / area 経路) */
function ashfallItem(): VolcanoItem {
  return {
    kind: "volcano", surface: "corner-right", key: "volcano:active",
    sourceEventIds: ["alert-source", "ash-source-1"],
    updatedAt: "2026-07-21T00:00:00.000Z", expiresAt: null, restored: true, severity: "critical",
    data: {
      headerTone: "warning",
      volcanoes: [{
        code: "506",
        name: "桜島",
        alertLevel: 3,
        warningKind: "噴火警報（火口周辺）",
        targetKinds: [],
        alertClass: null,
        latestEvent: null,
        ashfall: {
          kind: "rapid",
          label: "降灰速報",
          eventId: "event-ash-1",
          sourceEventId: "ash-source-1",
          forecastEndsAt: "2026-08-31T03:00:00.000Z",
          forecastEndLabel: "2026年8月31日 12:00まで",
          groups: [{
            hazardClass: "ash",
            ashCode: "02",
            ashName: "多量",
            areas: [
              { identityKey: "code:46201", code: "46201", name: "鹿児島市", displayLabel: "鹿児島市（46201）" },
              { identityKey: "code:46206", code: "46206", name: "阿久根市", displayLabel: "阿久根市（46206）" },
            ],
            omittedAreaCount: 3,
          }],
          omittedGroupCount: 2,
          generation: 1,
        },
      }],
    },
  };
}

describe("VolcanoCard: Svelte リアクティブ Proxy を props に受けても描画できる", () => {
  it("噴火警報のみの item が $state Proxy でも例外なく描画される", () => {
    const item = $state(summaryItem());
    const { container } = render(VolcanoCard, { item });
    expect(container.querySelector(".volcano")?.textContent).toContain("Mount Test");
  });

  it("降灰予報つきの item が $state Proxy でも例外なく描画される", () => {
    const item = $state(ashfallItem());
    const { container } = render(VolcanoCard, { item });
    const text = container.querySelector(".volcano")?.textContent ?? "";
    expect(text).toContain("桜島");
    expect(text).toContain("鹿児島市");
  });

  it("Proxy 由来の値を複製しても元 item を書き換えない", () => {
    const item = $state(ashfallItem());
    const before = $state.snapshot(item);
    render(VolcanoCard, { item });
    expect($state.snapshot(item)).toEqual(before);
  });
});
