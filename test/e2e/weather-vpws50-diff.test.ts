import { beforeAll, describe, it, expect } from "vitest";
import zlib from "node:zlib";
import { XMLBuilder } from "fast-xml-parser";
import { processWeather } from "../../src/engine/presentation/processors/process-weather";
import { weatherAlertsFromVpws50 } from "../../src/engine/display/weather-alert-view";
import { Vpws50StateHolder } from "../../src/engine/messages/vpws50-state";
import { Vpww56StateHolder } from "../../src/engine/messages/vpww56-state";
import { EewTracker } from "../../src/engine/eew/eew-tracker";
import { EewEventLogger } from "../../src/engine/eew/eew-logger";
import { TsunamiStateHolder } from "../../src/engine/messages/tsunami-state";
import { VolcanoStateHolder } from "../../src/engine/messages/volcano-state";
import { Vpwp50DetailCache } from "../../src/engine/messages/vpwp50-detail-cache";
import { TornadoDetailProvider } from "../../src/engine/messages/tornado-detail-provider";
import { TyphoonProbabilityStateHolder } from "../../src/engine/messages/typhoon-probability-state";
import { FloodForecastStateHolder } from "../../src/engine/messages/flood-forecast-state";
import { TelegramRevisionGate } from "../../src/engine/messages/telegram-revision-gate";
import {
  createMockWsDataMessage,
  FIXTURE_VPWS50_AGGREGATE,
} from "../helpers/mock-message";
import type { ProcessDeps } from "../../src/engine/presentation/processors/process-message";
import type { WsDataMessage } from "../../src/types";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * E2E chain: VPWS50 parser → process-weather → presentation
 *
 * Plan-R2: 人工 fixture は beforeAll で fast-xml-parser を使って動的生成する。
 * 固定 XML ファイルは作らず、areas/kinds の JS 表現から XMLBuilder で
 * VPWS50 構造を組み立てて gzip+base64 → WsDataMessage body に流し込む。
 *
 * 実 fixture (FIXTURE_VPWS50_AGGREGATE) → process-weather の chain は
 * 1 回目 (初回) / 2 回目 (変化なし格下げ) を見て、parser・state・presentation
 * の連携が崩れていないことを確認する。
 *
 * 動的 fixture を使うのは「昇格」「解除」「取消」の chain を見るため。
 * makeInfo() ベースのユニットテストでは state 単体しか見ないが、ここでは
 * parseWeatherWarning → state.diffAndUpdate → frameLevel 反映までを通す。
 */

interface SyntheticArea {
  areaName: string;
  areaCode: string;
  kinds: Array<{ name: string; code: string }>;
}

let upgradeMsgInitial: WsDataMessage;
let upgradeMsgAfter: WsDataMessage;
let releaseMsgInitial: WsDataMessage;
let releaseMsgAfter: WsDataMessage;
let cancelMsgInitial: WsDataMessage;
let cancelMsgMiddle: WsDataMessage;
let cancelMsgCancel: WsDataMessage;
let chainStep2Unchanged: WsDataMessage;
let chainStep3Upgrade: WsDataMessage;
let chainStep4Release: WsDataMessage;
let chainStep5Cancel: WsDataMessage;

function buildVpws50Xml(
  areas: SyntheticArea[],
  opts: { infoType?: string; reportDateTime?: string; serial?: string | null } = {},
): string {
  const items = areas.map((a) => ({
    Kind: a.kinds.map((k) => ({ Name: k.name, Code: k.code })),
    Areas: {
      "@_codeType": "気象情報／府県予報区・細分区域等",
      Area: [{ Name: a.areaName, Code: a.areaCode }],
    },
  }));

  const reportObj = {
    "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
    Report: {
      "@_xmlns": "http://xml.kishou.go.jp/jmaxml1/",
      "@_xmlns:jmx": "http://xml.kishou.go.jp/jmaxml1/",
      Control: {
        Title: "気象警報・注意報（Ｒ０６）（集約通報）",
        DateTime: "2026-06-05T06:18:00Z",
        Status: "通常",
        EditorialOffice: "気象庁本庁",
        PublishingOffice: "気象庁",
      },
      Head: {
        "@_xmlns": "http://xml.kishou.go.jp/jmaxml1/informationBasis1/",
        Title: "警戒・注意事項集約定時通報",
        ReportDateTime: opts.reportDateTime ?? "2026-06-05T15:18:00+09:00",
        TargetDateTime: opts.reportDateTime ?? "2026-06-05T15:18:00+09:00",
        EventID: "",
        InfoType: opts.infoType ?? "発表",
        Serial: opts.serial ?? "",
        InfoKind: "気象警報・注意報",
        InfoKindVersion: "1.5_0",
        Headline: {
          Text: "",
          Information: {
            "@_type": "気象警報・注意報（府県予報区等）",
            Item: items,
          },
        },
      },
      Body: {
        "@_xmlns": "http://xml.kishou.go.jp/jmaxml1/body/meteorology1/",
      },
    },
  };

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    suppressEmptyNode: false,
    format: false,
    processEntities: true,
  });
  return builder.build(reportObj);
}

function buildVpws50WsMessage(
  areas: SyntheticArea[],
  opts: { infoType?: string; reportDateTime?: string; id?: string; serial?: string | null } = {},
): WsDataMessage {
  const xml = buildVpws50Xml(areas, opts);
  const body = zlib.gzipSync(Buffer.from(xml, "utf-8")).toString("base64");
  return {
    type: "data",
    version: "2.0",
    classification: "telegram.weather",
    id: opts.id ?? "synthetic-vpws50",
    passing: [{ name: "test", time: "2026-06-05T15:18:00+09:00" }],
    head: {
      type: "VPWS50",
      author: "気象庁",
      time: opts.reportDateTime ?? "2026-06-05T15:18:00+09:00",
      test: false,
      xml: true,
    },
    xmlReport: {
      control: {
        title: "気象警報・注意報",
        dateTime: "2026-06-05T06:18:00Z",
        status: "通常",
        editorialOffice: "気象庁本庁",
        publishingOffice: "気象庁",
      },
      head: {
        title: "警戒・注意事項集約定時通報",
        reportDateTime: opts.reportDateTime ?? "2026-06-05T15:18:00+09:00",
        targetDateTime: opts.reportDateTime ?? "2026-06-05T15:18:00+09:00",
        eventId: opts.id ?? null,
        serial: opts.serial ?? null,
        infoType: opts.infoType ?? "発表",
        infoKind: "気象警報・注意報",
        infoKindVersion: "1.5_0",
        headline: null,
      },
    },
    format: "xml",
    compression: "gzip",
    encoding: "base64",
    body,
  };
}

beforeAll(() => {
  // 昇格: 神奈川県 (140000) を「大雨注意報 code=10」→「大雨警報 code=03」へ
  upgradeMsgInitial = buildVpws50WsMessage(
    [
      {
        areaName: "神奈川県",
        areaCode: "140000",
        kinds: [{ name: "大雨注意報", code: "10" }],
      },
    ],
    { id: "upgrade-1", reportDateTime: "2026-06-05T15:00:00+09:00" },
  );
  upgradeMsgAfter = buildVpws50WsMessage(
    [
      {
        areaName: "神奈川県",
        areaCode: "140000",
        kinds: [{ name: "大雨警報", code: "03" }],
      },
    ],
    { id: "upgrade-2", reportDateTime: "2026-06-05T15:30:00+09:00" },
  );

  // 解除: 茨城県 (080000) の雷注意報 (code=14) を次の電文で削除
  releaseMsgInitial = buildVpws50WsMessage(
    [
      {
        areaName: "茨城県",
        areaCode: "080000",
        kinds: [{ name: "雷注意報", code: "14" }],
      },
      {
        areaName: "千葉県",
        areaCode: "120000",
        kinds: [{ name: "大雨注意報", code: "10" }],
      },
    ],
    { id: "release-1", reportDateTime: "2026-06-05T15:00:00+09:00" },
  );
  releaseMsgAfter = buildVpws50WsMessage(
    [
      {
        areaName: "千葉県",
        areaCode: "120000",
        kinds: [{ name: "大雨注意報", code: "10" }],
      },
    ],
    { id: "release-2", reportDateTime: "2026-06-05T15:30:00+09:00" },
  );

  // 取消: 通常電文 → 別状態の通常電文 → 取消
  // → history pop が「empty-history clear」ではなく「正常 pop」経路を踏むよう
  //    2 本以上を流してから取消する (Task 8 review #2)
  cancelMsgInitial = buildVpws50WsMessage(
    [
      {
        areaName: "神奈川県",
        areaCode: "140000",
        kinds: [{ name: "大雨警報", code: "03" }],
      },
    ],
    { id: "cancel-1", reportDateTime: "2026-06-05T15:00:00+09:00" },
  );
  cancelMsgMiddle = buildVpws50WsMessage(
    [
      {
        areaName: "神奈川県",
        areaCode: "140000",
        kinds: [{ name: "大雨警報", code: "03" }],
      },
      {
        areaName: "千葉県",
        areaCode: "120000",
        kinds: [{ name: "大雨注意報", code: "10" }],
      },
    ],
    { id: "cancel-1b", reportDateTime: "2026-06-05T15:15:00+09:00" },
  );
  cancelMsgCancel = buildVpws50WsMessage(
    [
      {
        areaName: "神奈川県",
        areaCode: "140000",
        kinds: [{ name: "大雨警報", code: "03" }],
      },
      {
        areaName: "千葉県",
        areaCode: "120000",
        kinds: [{ name: "大雨注意報", code: "10" }],
      },
    ],
    { id: "cancel-2", reportDateTime: "2026-06-05T15:15:00+09:00", infoType: "取消" },
  );

  // chain 連続テスト用 (Task 8 review #1): 同一 state holder で 1→5 を回す
  // 1=初回 (upgradeMsgInitial 流用)、2=変化なし (upgradeMsgInitial 再受信)、
  // 3=昇格、4=解除 (神奈川削除)、5=取消 (rollback で 4 の直前=3 の snap に戻る)
  chainStep2Unchanged = buildVpws50WsMessage(
    [
      {
        areaName: "神奈川県",
        areaCode: "140000",
        kinds: [{ name: "大雨注意報", code: "10" }],
      },
    ],
    { id: "chain-2", reportDateTime: "2026-06-05T15:15:00+09:00" },
  );
  chainStep3Upgrade = buildVpws50WsMessage(
    [
      {
        areaName: "神奈川県",
        areaCode: "140000",
        kinds: [{ name: "大雨警報", code: "03" }],
      },
    ],
    { id: "chain-3", reportDateTime: "2026-06-05T15:30:00+09:00" },
  );
  chainStep4Release = buildVpws50WsMessage(
    [],
    { id: "chain-4", reportDateTime: "2026-06-05T15:45:00+09:00" },
  );
  chainStep5Cancel = buildVpws50WsMessage(
    [],
    { id: "chain-5", reportDateTime: "2026-06-05T15:45:00+09:00", infoType: "取消" },
  );
});

function fakeDeps(state: Vpws50StateHolder): ProcessDeps {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vpwp50-fakedeps-"));
  return {
    eewTracker: new EewTracker(),
    eewLogger: new EewEventLogger(),
    tsunamiState: new TsunamiStateHolder(),
    volcanoState: new VolcanoStateHolder(),
    vpws50State: state,
    vpww56State: new Vpww56StateHolder(),
    vpwp50Cache: new Vpwp50DetailCache({ persistRoot: tmpRoot }),
    tornadoDetailProvider: new TornadoDetailProvider(),
    typhoonProbabilityState: new TyphoonProbabilityStateHolder(),
    floodForecastState: new FloodForecastStateHolder(),
    revisionGate: new TelegramRevisionGate(),
  };
}

function requireWeatherOutcome(result: ReturnType<typeof processWeather>) {
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") throw new Error(`processWeather returned ${result.kind}`);
  return result.outcome;
}

describe("E2E: VPWS50 parser → process-weather → presentation (実 fixture)", () => {
  it("1 回目=初回現況、同一 identity の 2 回目=suppressed", () => {
    const state = new Vpws50StateHolder();
    const deps = fakeDeps(state);
    const msg = createMockWsDataMessage(FIXTURE_VPWS50_AGGREGATE);

    const out1 = requireWeatherOutcome(processWeather(msg, deps));
    expect(out1.presentation.weatherDiff?.isFirstReport).toBe(true);
    expect(out1.presentation.weatherDiff?.confidence).toBe("confirmed");
    // 初回は通常の severity ベース判定なので info に落ちない
    expect(out1.presentation.frameLevel).not.toBe("info");

    expect(processWeather(msg, deps)).toEqual({ kind: "suppressed" });
    // 大容量 VPWS50 fixture を 2 回 parse するため、並列負荷下で default 5s を超えうる
  }, 20000);
});

describe("E2E: VPWS50 parser → process-weather → presentation (動的人工 fixture)", () => {
  it("県名なし市町村の Area.Code を parser → state → standby wire まで保持する", () => {
    const reportDateTime = "2026-06-05T16:00:00+09:00";
    const msg = buildVpws50WsMessage(
      [{
        areaName: "宮崎市",
        areaCode: "4520100",
        kinds: [{ name: "大雨警報", code: "03" }],
      }],
      { id: "municipality-code", reportDateTime },
    );
    const state = new Vpws50StateHolder();

    requireWeatherOutcome(processWeather(msg, fakeDeps(state)));

    const alerts = weatherAlertsFromVpws50(state.getCurrentAreasForDisplay(), reportDateTime);
    expect(alerts[0]?.items[0]).toMatchObject({
      shownAreas: ["宮崎市"],
      shownAreaCodes: ["4520100"],
    });
  });

  it("昇格: 大雨注意報 (code=10) → 大雨警報 (code=03) で upgraded に乗る", () => {
    const state = new Vpws50StateHolder();
    const deps = fakeDeps(state);

    const out1 = requireWeatherOutcome(processWeather(upgradeMsgInitial, deps));
    expect(out1.presentation.weatherDiff?.isFirstReport).toBe(true);

    const out2 = requireWeatherOutcome(processWeather(upgradeMsgAfter, deps));
    const diff = out2.presentation.weatherDiff;
    expect(diff).not.toBeUndefined();
    expect(diff?.isUnchanged).toBe(false);
    expect(diff?.upgraded).toHaveLength(1);
    expect(diff?.upgraded[0].areaCode).toBe("140000");
    expect(diff?.upgraded[0].changes[0].prevSeverity).toBe("advisory");
    expect(diff?.upgraded[0].changes[0].newSeverity).toBe("warning");
    // 昇格は通常 severity ベース → frameLevel=warning
    expect(out2.presentation.frameLevel).toBe("warning");
  });

  it("解除: 雷注意報 (code=14) 削除で released に乗る", () => {
    const state = new Vpws50StateHolder();
    const deps = fakeDeps(state);

    processWeather(releaseMsgInitial, deps);
    const out2 = requireWeatherOutcome(processWeather(releaseMsgAfter, deps));
    const diff = out2.presentation.weatherDiff;
    expect(diff).not.toBeUndefined();
    expect(diff?.isUnchanged).toBe(false);
    expect(diff?.released).toHaveLength(1);
    expect(diff?.released[0].areaCode).toBe("080000");
    expect(diff?.released[0].changes[0].prevSeverity).toBe("advisory");
    expect(diff?.released[0].changes[0].newSeverity).toBeNull();
  });

  it("取消: 通常 2 本 → 取消 で history pop 経路 (empty-clear ではない) + frameLevel=cancel", () => {
    const state = new Vpws50StateHolder();
    const deps = fakeDeps(state);

    // 1 本目: 神奈川のみ → state set, history は空
    processWeather(cancelMsgInitial, deps);
    // 2 本目: 神奈川 + 千葉 → state 更新、history に 1 本目の snapshot が push
    processWeather(cancelMsgMiddle, deps);
    // 取消 → rollback で history pop (= 1 本目の snapshot に戻る)
    const out3 = requireWeatherOutcome(processWeather(cancelMsgCancel, deps));
    const diff = out3.presentation.weatherDiff;
    expect(diff).not.toBeUndefined();
    expect(diff?.isCancelRollback).toBe(true);
    // history pop 正常系: 取消後に「1 本目と同じ電文」を流すと変化なし扱い
    expect(out3.presentation.frameLevel).toBe("cancel");
    expect(out3.presentation.soundLevel).toBe("cancel");

    // pop で「1 本目」状態 (神奈川のみ) に戻り、古い 1 本目の再受信は抑制される。
    expect(state.getCurrentAreasForDisplay()?.totalAreas).toBe(1);
    expect(processWeather(cancelMsgInitial, deps)).toEqual({ kind: "suppressed" });
  });
});

describe("E2E: VPWS50 同一 state holder で 1→5 連続チェーン (Task 8 review #1)", () => {
  it("初回 → 変化なし → 昇格 → 解除 → 取消 の 5 ステップを通す", () => {
    const state = new Vpws50StateHolder();
    const deps = fakeDeps(state);

    // 1: 初回 (神奈川 大雨注意報)
    const step1 = requireWeatherOutcome(processWeather(upgradeMsgInitial, deps));
    expect(step1.presentation.weatherDiff?.isFirstReport).toBe(true);
    expect(step1.presentation.weatherDiff?.confidence).toBe("confirmed");

    // 2: 内容は変化なしだが identity は新しい報
    const step2 = requireWeatherOutcome(processWeather(chainStep2Unchanged, deps));
    expect(step2.presentation.weatherDiff?.isUnchanged).toBe(true);
    expect(step2.presentation.frameLevel).toBe("info");
    expect(step2.presentation.soundLevel).toBe("info");

    // 3: 昇格 (神奈川 注意報→警報)
    const step3 = requireWeatherOutcome(processWeather(chainStep3Upgrade, deps));
    const diff3 = step3.presentation.weatherDiff;
    expect(diff3?.upgraded).toHaveLength(1);
    expect(diff3?.upgraded[0].areaCode).toBe("140000");
    expect(diff3?.upgraded[0].changes[0].prevSeverity).toBe("advisory");
    expect(diff3?.upgraded[0].changes[0].newSeverity).toBe("warning");
    expect(step3.presentation.frameLevel).toBe("warning");

    // 4: 解除 (神奈川削除 - items 空)
    const step4 = requireWeatherOutcome(processWeather(chainStep4Release, deps));
    const diff4 = step4.presentation.weatherDiff;
    expect(diff4?.confidence).toBe("confirmed");
    expect(diff4?.released).toHaveLength(1);
    expect(diff4?.released[0].areaCode).toBe("140000");
    expect(diff4?.released[0].changes[0].prevSeverity).toBe("warning");

    // 5: 取消 (rollback で step 3 の snapshot に戻る = 神奈川 警報)
    const step5 = requireWeatherOutcome(processWeather(chainStep5Cancel, deps));
    expect(step5.presentation.weatherDiff?.isCancelRollback).toBe(true);
    expect(step5.presentation.frameLevel).toBe("cancel");
    expect(step5.presentation.soundLevel).toBe("cancel");

    // step 5 で step 3 の snap (神奈川 警報) に戻り、旧報の再受信は suppressed。
    expect(state.getCurrentAreasForDisplay()?.kinds[0].kindCode).toBe("03");
    expect(processWeather(chainStep3Upgrade, deps)).toEqual({ kind: "suppressed" });
  });
});
