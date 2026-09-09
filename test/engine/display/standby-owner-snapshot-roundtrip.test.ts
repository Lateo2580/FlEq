/**
 * owner snapshot の往復無損失テスト (spec §9.12 / 段階 3-D の D-ii)。
 *
 * `standby-persistence-admission.ts` の `assertLosslessOwnerSnapshot` は
 * 段階 3-D で strict 便 (`FLEQ_STANDBY_SWEEP_STRICT=1`) 限定になった。本番で外れる
 * 実行時保証を、ここで owner ごとの単体テストとして固定する。
 *
 * 固定する契約は 1 つだけ:
 *
 *     Owner.fromSnapshot(s).cloneSnapshot() ≡ s   (canonical JSON で一致)
 *
 * これが破れると、段階 1 A の body 再利用が「commit 後の base」と食い違うバイト列を
 * 再利用しうる (spec §3.3「D と A の相互作用」)。破れ方は静かなので、
 * 入力は空スナップショットではなく**中身のある合法状態**で採る。
 *
 * volcano は元から `assertLosslessOwnerSnapshot` の対象外 (`:352-366` は code 集合の
 * 重複・対応・上限を見るインライン検査で往復比較ではない) だが、A のバイト同一性は
 * 同じ往復性に乗っているので同じ機会に固定する。
 */
import { describe, it, expect } from "vitest";
import {
  StandbyPersistenceAdmissionCoordinator,
  type StandbyPersistenceDomainSnapshots,
} from "../../../src/engine/display/standby-persistence-admission";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { Vpws50StateHolder } from "../../../src/engine/messages/vpws50-state";
import { Vpww56StateHolder } from "../../../src/engine/messages/vpww56-state";
import { TsunamiStateHolder } from "../../../src/engine/messages/tsunami-state";
import { VolcanoStateHolder } from "../../../src/engine/messages/volcano-state";
import { FloodForecastStateHolder } from "../../../src/engine/messages/flood-forecast-state";
import { TelegramRevisionGate } from "../../../src/engine/messages/telegram-revision-gate";
import { createTelegramMeta } from "../../../src/dmdata/telegram-meta";
import { canonicalizeLegacyTsunamiInfo } from "../../../src/dmdata/tsunami-legacy-adapter";
import type { ParsedTsunamiInfo, TsunamiObservationStation } from "../../../src/types";
import { buildLargeVpws50Snapshot } from "../../helpers/standby-sweep-large-state";
import {
  buildDeadlineScatteredDomains,
  DEADLINE_BASE_MS,
} from "../../helpers/standby-sweep-deadline-state";

/** `standby-persistence-admission.ts` の同名関数と同じ正規化 (Map / Set を展開する)。 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => {
    if (child instanceof Map) return { $map: [...child] };
    if (child instanceof Set) return { $set: [...child] };
    return child;
  });
}

/**
 * 期限をばらけさせた合法 domains。telegramRevisionGate / standbyStateStore /
 * volcanoHolderAndRepair / floodForecastState の 4 owner に中身が入る。
 */
function scatteredDomains(): StandbyPersistenceDomainSnapshots {
  const coordinator = new StandbyPersistenceAdmissionCoordinator({
    owners: {
      telegramRevisionGate: new TelegramRevisionGate(() => undefined),
      standbyStateStore: new StandbyStateStore(),
      vpws50State: new Vpws50StateHolder(),
      vpww56State: new Vpww56StateHolder(),
      tsunamiState: new TsunamiStateHolder(),
      volcanoState: new VolcanoStateHolder(),
      floodForecastState: new FloodForecastStateHolder(),
    },
  });
  return buildDeadlineScatteredDomains(
    structuredClone(coordinator.capture().domains) as StandbyPersistenceDomainSnapshots,
  );
}

function tsunamiInfo(infoType: "発表" | "取消"): ParsedTsunamiInfo {
  const reportDateTime = "2026-09-07T00:00:00+09:00";
  return canonicalizeLegacyTsunamiInfo({
    meta: createTelegramMeta({
      messageId: `${infoType}:${reportDateTime}`,
      eventId: "tsunami-roundtrip",
      type: "VTSE41",
      reportDateTime,
      serial: null,
      infoType,
      receivedAtMs: Date.parse(reportDateTime),
      status: "通常",
      isTest: false,
    }),
    type: "VTSE41",
    infoType,
    title: "津波警報・注意報・予報",
    reportDateTime,
    headline: null,
    publishingOffice: "気象庁",
    forecast: infoType === "取消" ? [] : [{
      areaCode: "210",
      areaName: "岩手県",
      kindCode: "51",
      kind: "津波警報",
      maxHeightDescription: "3m",
      firstHeight: "到達中と推測",
    }],
    warningComment: "",
    isTest: false,
  });
}

function observationStation(name: string, code: string): TsunamiObservationStation {
  return {
    areaName: "岩手県",
    areaCode: "210",
    stationCode: code,
    name,
    sensor: "検潮所",
    arrivalTime: "2026-09-07T00:10:00+09:00",
    initial: "押し",
    maxHeightCondition: "",
    maxHeightValue: "0.3m",
    maxHeight: {
      raw: "0.3",
      value: 0.3,
      condition: null,
      description: "0.3m",
      presence: "value",
    },
  };
}

describe("owner snapshot の往復無損失 (段階 3-D / D-ii)", () => {
  it("telegramRevisionGate", () => {
    const snapshot = scatteredDomains().telegramRevisionGate;
    expect(snapshot.states.length).toBeGreaterThan(0);
    const restored = TelegramRevisionGate.fromSnapshot(snapshot).cloneSnapshot();
    expect(canonicalJson(restored)).toBe(canonicalJson(snapshot));
  });

  it("standbyStateStore", () => {
    const snapshot = scatteredDomains().standbyStateStore;
    expect(snapshot.data.volcanoes.size + snapshot.data.heatAlerts.size)
      .toBeGreaterThan(0);
    const restored = StandbyStateStore.fromSnapshot(snapshot).cloneSnapshot();
    expect(canonicalJson(restored)).toBe(canonicalJson(snapshot));
  });

  it("vpws50State", () => {
    const snapshot = buildLargeVpws50Snapshot(DEADLINE_BASE_MS);
    const restored = Vpws50StateHolder.fromSnapshot(snapshot).cloneSnapshot();
    expect(canonicalJson(restored)).toBe(canonicalJson(snapshot));
  });

  it("vpww56State", () => {
    const view = {
      totalAreas: 1,
      specialAreas: 0,
      warningAreas: 1,
      advisoryAreas: 0,
      kinds: [{
        kindCode: "03",
        kindShortName: "大雨",
        kindName: "大雨警報",
        displaySeverity: "nonLevelWarning" as const,
        officialAlertLevel: null,
        areas: [{ areaName: "検査区域", areaCode: "1000005" }],
      }],
    };
    const snapshot = {
      version: 3,
      state: {
        generation: 1 as const,
        streams: [
          { generation: 1 as const, subjectKey: "weather:VPWW56:官署A", view },
          { generation: 1 as const, subjectKey: "weather:VPWW56:官署B", view },
        ],
        pendingSubjects: ["weather:VPWW56:官署C"],
      },
    };
    const restored = Vpww56StateHolder.fromSnapshot(snapshot).cloneSnapshot();
    expect(canonicalJson(restored)).toBe(canonicalJson(snapshot));
  });

  it("tsunamiState", () => {
    const seeded = new TsunamiStateHolder();
    seeded.applyAccepted(tsunamiInfo("発表"));
    seeded.applyAcceptedObservations("VTSE51", [
      observationStation("宮古", "0001"),
      observationStation("大船渡", "0002"),
    ]);
    const snapshot = seeded.cloneSnapshot();
    expect(snapshot.observationGroups.VTSE51).toHaveLength(2);
    const restored = TsunamiStateHolder.fromSnapshot(snapshot).cloneSnapshot();
    expect(canonicalJson(restored)).toBe(canonicalJson(snapshot));
  });

  it("floodForecastState", () => {
    const snapshot = scatteredDomains().floodForecastState;
    expect(snapshot.events.length).toBeGreaterThan(0);
    const restored = FloodForecastStateHolder.fromSnapshot(snapshot).cloneSnapshot();
    expect(canonicalJson(restored)).toBe(canonicalJson(snapshot));
  });

  /**
   * volcano だけは「holder が出した snapshot」を入力にする。
   *
   * `snapshot()` の `composites` は `RuntimeComposite` をそのまま clone するので、
   * 型 `VolcanoCompositeV2` に無い runtime 専用の `restored` 欄が composite の中へ
   * 漏れて出る (`volcano-state.ts:361`)。復元側 (`:379-386`) は composite 内の
   * `restored` を読まずトップレベルの `restored` 配列だけを見るので、
   * **手書きの合法 snapshot は不動点にならない** (漏れた欄が往復で足される)。
   * 他 owner と違って `assertLosslessOwnerSnapshot` の対象外なのは、この非対称が
   * あるためである。admission が実際に渡すのは `captureMutable()` 経由で
   * `snapshot()` が作ったものなので、固定すべき契約はこちらの形になる。
   */
  it("volcanoHolderAndRepair (assertLosslessOwnerSnapshot の対象外だが A の前提)", () => {
    const seeded = VolcanoStateHolder.fromSnapshot(
      scatteredDomains().volcanoHolderAndRepair.holder,
    );
    const snapshot = seeded.snapshot();
    expect(snapshot.composites.length).toBeGreaterThan(0);
    expect(snapshot.restored.length).toBeGreaterThan(0);
    const restored = VolcanoStateHolder.fromSnapshot(snapshot).snapshot();
    expect(canonicalJson(restored)).toBe(canonicalJson(snapshot));
  });
});
