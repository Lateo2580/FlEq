import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeMaxDisplaySeverity, computeMaxSoundLevel } from "../../../src/dmdata/weather-warning-level";
import {
  Vpws50StateHolder,
  type PersistedVpws50StateV2,
} from "../../../src/engine/messages/vpws50-state";
import type { ParsedWeatherWarning, WeatherItem } from "../../../src/types";
import { testTelegramMeta } from "../../helpers/telegram-meta";

/**
 * §4.13 実 Pi 状態の縮小 fixture による「復元 → 次報受理」統合テスト
 * (spec: 2026-09-07-vpws50-stale-current-lock.md（作業ノート、repo 外）)。
 *
 * fixture は Raspberry Pi の display-active-state-v2.json から telegramFoundation.vpws50
 * だけを取り出し、区域名・区域コード・官署名を合成値へ置換した匿名化コピー。
 * 縮小手順は test/fixtures/vpws50-stale-lock/README.md を見る。
 */

const FIXTURE_PATH = path.resolve(
  __dirname,
  "../../fixtures/vpws50-stale-lock/pi-stale-lock-state.json",
);

/** fixture の全国 base は 2026-08-30 13:00 で凍結している (実機の観測値)。 */
const FROZEN_BASE_AT = "2026-08-30T13:00:00+09:00";
/** 8 日後の定時報。実機が 8 日間拒否し続けた報に相当する。 */
const NEXT_REPORT_AT = "2026-09-07T13:00:00+09:00";
/** 不死化していた L4 の載っている区域 (福井市の匿名化先)。 */
const IMMORTAL_AREA_CODE = "9100001";

function loadFixture(): PersistedVpws50StateV2 {
  const parsed: PersistedVpws50StateV2 = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  return parsed;
}

/** 現況に土砂災害 L4 が載っているか。 */
function hasSedimentL4(holder: Vpws50StateHolder, areaCode: string): boolean {
  return (holder.getCurrentAreasForDisplay()?.kinds ?? []).some((kind) =>
    kind.kindShortName === "土砂災害"
    && kind.displaySeverity === "officialL4"
    && kind.areas.some((area) => area.areaCode === areaCode));
}

/** 明示解除を持たない小さな新報。従来判定では必ず abnormal_release_rate になる。 */
function nextReport(reportDateTime: string): ParsedWeatherWarning {
  const items: WeatherItem[] = [
    {
      areaName: "架空区域90",
      areaCode: "9900001",
      kinds: [{ name: "レベル３大雨警報", code: "03", severity: "warning" }],
      statuses: [],
    },
    {
      areaName: "架空区域91",
      areaCode: "9900002",
      kinds: [{ name: "大雨注意報", code: "10", severity: "advisory" }],
      statuses: [],
    },
  ];
  const layers = [{ type: "気象警報・注意報（府県予報区等）", items }];
  return {
    meta: testTelegramMeta(false),
    type: "VPWS50",
    infoType: "発表",
    title: "気象警報・注意報",
    reportDateTime,
    headline: null,
    publishingOffice: "気象庁",
    editorialOffice: "気象庁",
    controlTitle: "気象警報・注意報",
    layers,
    comments: [],
    maxSeverity: "warning",
    maxDisplaySeverity: computeMaxDisplaySeverity(layers),
    maxSoundLevel: computeMaxSoundLevel(layers),
    warningAreaCount: 1,
    advisoryAreaCount: 1,
    isTest: false,
  };
}

describe("§4.13 Pi の stale lock 状態からの回復", () => {
  it("復元直後は 8 日前の L4 土砂災害が現況に残る (不死化の再現)", () => {
    const holder = new Vpws50StateHolder();
    holder.restorePersistedState(loadFixture());
    expect(hasSedimentL4(holder, IMMORTAL_AREA_CODE)).toBe(true);
  });

  it("復元後に容量保護へ数えるのは base より新しい 3 件だけ (§3.3 ステップ 1)", () => {
    const holder = new Vpws50StateHolder();
    holder.restorePersistedState(loadFixture());
    // fixture の partialStreams は 4 件。うち 1 件だけが凍結 base より古い。
    expect(loadFixture().partialStreams).toHaveLength(4);
    expect(holder.activePartialSubjects()).toHaveLength(3);
    // stream 自体は所有現象の台帳なので 4 件とも残す (解除報の ownedPhenomena 復元に要る)
    expect(holder.exportPersistedState().partialStreams).toHaveLength(4);
  });

  it("同じ payload でも current が閾値内なら従来どおり abnormal_release_rate で拒否する", () => {
    const state = loadFixture();
    // current だけを新報の 10 分前へ動かす。payload は下の受理テストと同一。
    const fresh: PersistedVpws50StateV2 = {
      ...state,
      current: state.current == null ? null : {
        ...state.current,
        identity: { ...state.current.identity, reportDateTime: "2026-09-07T12:50:00+09:00" },
      },
    };
    const holder = new Vpws50StateHolder();
    holder.restorePersistedState(fresh);
    const preview = holder.previewUnsafe(nextReport(NEXT_REPORT_AT));
    expect(preview?.confidence).toBe("unsafe");
    expect(preview?.unsafeReason).toBe("abnormal_release_rate");
  });

  it("8 日ぶんの stale current は脱出して受理され、L4 が消えて state が縮む", () => {
    const holder = new Vpws50StateHolder();
    holder.restorePersistedState(loadFixture());
    expect(holder.exportPersistedState().current?.identity.reportDateTime).toBe(FROZEN_BASE_AT);
    const bytesBefore = JSON.stringify(holder.exportPersistedState()).length;

    const info = nextReport(NEXT_REPORT_AT);
    // 修正前はここが abnormal_release_rate だった (上の閾値内テストが同じ payload で固定している)。
    expect(holder.previewUnsafe(info)).toBeNull();

    const update = holder.diffAndUpdateWithDisplay(info, "resync", {
      reportDateTime: NEXT_REPORT_AT,
      serial: null,
    });
    expect(update.diff.confidence).toBe("confirmed");
    expect(update.diff.isStaleResync).toBe(true);

    // 不死化していた L4 土砂災害が消える
    expect(hasSedimentL4(holder, IMMORTAL_AREA_CODE)).toBe(false);

    const after = holder.exportPersistedState();
    expect(after.current?.identity.reportDateTime).toBe(NEXT_REPORT_AT);
    expect(after.history).toHaveLength(0);
    // 新 base より古い partial は落ち、実際に今日の警報を載せている 1 件だけが残る
    expect(holder.activePartialSubjects()).toHaveLength(1);
    expect(after.partialHistory).toBeUndefined();
    expect(after.restoredPartialSubjects).toBeUndefined();

    expect(JSON.stringify(after).length).toBeLessThan(bytesBefore);
  });

  it("受理後も base より新しい partial の警報は現況に残る", () => {
    const holder = new Vpws50StateHolder();
    holder.restorePersistedState(loadFixture());
    const survivor = holder.activePartialSubjects()
      .find((subject) => subject === "weather:VPWW55:架空第02気象台");
    expect(survivor).toBeDefined();

    holder.diffAndUpdateWithDisplay(nextReport(NEXT_REPORT_AT), "resync", {
      reportDateTime: NEXT_REPORT_AT,
      serial: null,
    });
    expect(holder.activePartialSubjects()).toEqual(["weather:VPWW55:架空第02気象台"]);
    const areaCodes = (holder.getCurrentAreasForDisplay()?.kinds ?? [])
      .flatMap((kind) => kind.areas.map((area) => area.areaCode));
    // 新報の 2 区域 + 生き残った partial の 2 区域
    expect(areaCodes).toContain("9900001");
    expect(areaCodes.length).toBeGreaterThan(2);
  });
});
