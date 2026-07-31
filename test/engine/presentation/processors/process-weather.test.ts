import { describe, it, expect, vi } from "vitest";
import { processWeather } from "../../../../src/engine/presentation/processors/process-weather";
import { processWeatherWarningTimeseries } from "../../../../src/engine/presentation/processors/process-weather-warning-timeseries";
import { toPresentationEvent } from "../../../../src/engine/presentation/events/to-presentation-event";
import { projectDisplayEvent, tickerPriority } from "../../../../src/engine/display/project-event";
import { renderSummaryLine } from "../../../../src/ui/summary";
import { stripAnsi } from "../../../../src/ui/formatter";
import { Vpws50StateHolder } from "../../../../src/engine/messages/vpws50-state";
import { Vpww56StateHolder } from "../../../../src/engine/messages/vpww56-state";
import { EewTracker } from "../../../../src/engine/eew/eew-tracker";
import { EewEventLogger } from "../../../../src/engine/eew/eew-logger";
import { TsunamiStateHolder } from "../../../../src/engine/messages/tsunami-state";
import { VolcanoStateHolder } from "../../../../src/engine/messages/volcano-state";
import { Vpwp50DetailCache } from "../../../../src/engine/messages/vpwp50-detail-cache";
import { FloodForecastStateHolder } from "../../../../src/engine/messages/flood-forecast-state";
import { TyphoonProbabilityStateHolder } from "../../../../src/engine/messages/typhoon-probability-state";
import { TelegramRevisionGate } from "../../../../src/engine/messages/telegram-revision-gate";
import { weatherCoreFrameLevel } from "../../../../src/ui/weather-core-entry";
import {
  createMockWsDataMessage,
  FIXTURE_VPWS50_AGGREGATE,
  FIXTURE_VPWP50_HIGH_SEVERITY,
  FIXTURE_VPWW55_OAME,
  FIXTURE_VPWW56_DOSHA,
  FIXTURE_VPWW57_KOCHO,
  FIXTURE_VPWW58_BOFU,
  FIXTURE_VPWW59_HARO,
  FIXTURE_VPWW60_OYUKI,
  FIXTURE_VPWW61_OTHER,
} from "../../../helpers/mock-message";
import type { ProcessDeps } from "../../../../src/engine/presentation/processors/process-message";
import type { WsDataMessage } from "../../../../src/types";
import { XMLBuilder } from "fast-xml-parser";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

vi.mock("../../../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

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

describe("processWeather - VPWS50 差分連携", () => {
  it("vpws50State 未指定なら weatherDiff=undefined", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWS50_AGGREGATE);
    const out = requireWeatherOutcome(processWeather(msg));
    expect(out.presentation.weatherDiff).toBeUndefined();
  });

  it("初回電文: isFirstReport=true, confidence=confirmed, frameLevel は通常 (info に落ちない)", () => {
    const state = new Vpws50StateHolder();
    const msg = createMockWsDataMessage(FIXTURE_VPWS50_AGGREGATE);
    const out = requireWeatherOutcome(processWeather(msg, fakeDeps(state)));
    expect(out.presentation.weatherDiff?.isFirstReport).toBe(true);
    expect(out.presentation.weatherDiff?.confidence).toBe("confirmed");
    // 初回は frameLevel は info ではない (weatherFrameLevel ベース)
    expect(out.presentation.frameLevel).not.toBe("info");
  });

  it("同一 identity の重複電文は suppressed", () => {
    const state = new Vpws50StateHolder();
    const msg = createMockWsDataMessage(FIXTURE_VPWS50_AGGREGATE);
    const deps = fakeDeps(state);
    processWeather(msg, deps);
    expect(processWeather(msg, deps)).toEqual({ kind: "suppressed" });
    // 大容量 VPWS50 fixture を 2 回 parse するため、並列負荷下で default 5s を超えうる
  }, 20000);

  it("新しい identity で内容不変なら isUnchanged=true, frameLevel/soundLevel=info", () => {
    const state = new Vpws50StateHolder();
    const kinds = [{ code: "03", name: "大雨警報" }];
    processWeather(buildVpws50Msg(kinds, {
      id: "unchanged-1",
      reportDateTime: "2026-06-12T15:00:00+09:00",
      serial: "1",
    }), fakeDeps(state));
    const out = requireWeatherOutcome(processWeather(buildVpws50Msg(kinds, {
      id: "unchanged-2",
      reportDateTime: "2026-06-12T15:30:00+09:00",
      serial: "2",
    }), fakeDeps(state)));
    expect(out.presentation.weatherDiff?.isUnchanged).toBe(true);
    expect(out.presentation.frameLevel).toBe("info");
    expect(out.presentation.soundLevel).toBe("info");
  });
});

// ── VPWS50 人工電文ビルダー (e2e/weather-vpws50-diff.test.ts の builder と同形) ──

function buildVpws50Msg(
  kinds: Array<{ code: string; name: string }>,
  opts: {
    id?: string;
    reportDateTime?: string;
    serial?: string | null;
    infoType?: string;
    type?: "VPWS50" | "VPWW56";
  } = {},
): WsDataMessage {
  const reportDateTime = opts.reportDateTime ?? "2026-06-12T15:00:00+09:00";
  const serial = opts.serial ?? null;
  const infoType = opts.infoType ?? "発表";
  const type = opts.type ?? "VPWS50";
  const reportObj = {
    "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
    Report: {
      "@_xmlns": "http://xml.kishou.go.jp/jmaxml1/",
      "@_xmlns:jmx": "http://xml.kishou.go.jp/jmaxml1/",
      Control: {
        Title: "気象警報・注意報（Ｒ０６）（集約通報）",
        DateTime: "2026-06-12T06:00:00Z",
        Status: "通常",
        EditorialOffice: "気象庁本庁",
        PublishingOffice: "気象庁",
      },
      Head: {
        "@_xmlns": "http://xml.kishou.go.jp/jmaxml1/informationBasis1/",
        Title: "警戒・注意事項集約定時通報",
        ReportDateTime: reportDateTime,
        TargetDateTime: reportDateTime,
        EventID: "",
        InfoType: infoType,
        Serial: serial ?? "",
        InfoKind: "気象警報・注意報",
        InfoKindVersion: "1.5_0",
        Headline: {
          Text: "",
          Information: {
            "@_type": "気象警報・注意報（府県予報区等）",
            Item: [
              {
                Kind: kinds.map((k) => ({ Name: k.name, Code: k.code })),
                Areas: {
                  "@_codeType": "気象情報／府県予報区・細分区域等",
                  Area: [{ Name: "神奈川県", Code: "140000" }],
                },
              },
            ],
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
  const xml = builder.build(reportObj) as string;
  const body = zlib.gzipSync(Buffer.from(xml, "utf-8")).toString("base64");
  return {
    type: "data",
    version: "2.0",
    classification: "telegram.weather",
    id: opts.id ?? "synthetic-vpws50",
    passing: [{ name: "test", time: reportDateTime }],
    head: {
      type,
      author: "気象庁",
      time: reportDateTime,
      test: false,
      xml: true,
    },
    xmlReport: {
      control: {
        title: "気象警報・注意報",
        dateTime: "2026-06-12T06:00:00Z",
        status: "通常",
        editorialOffice: "気象庁本庁",
        publishingOffice: "気象庁",
      },
      head: {
        title: "警戒・注意事項集約定時通報",
        reportDateTime,
        targetDateTime: reportDateTime,
        eventId: opts.id ?? null,
        serial,
        infoType,
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

describe("processWeather - VPWS50/VPWW56 単調性抑制", () => {
  const warningKinds = [{ code: "03", name: "大雨警報" }];
  const landslideKinds = [{ code: "49", name: "レベル４土砂災害危険警報" }];
  const manyWarningKinds = [
    { code: "03", name: "大雨警報" },
    { code: "04", name: "洪水警報" },
    { code: "05", name: "暴風警報" },
    { code: "06", name: "暴風雪警報" },
    { code: "07", name: "大雪警報" },
  ];

  it("VPWS50: 取消後の重複取消と古い発表を suppressed にする", () => {
    const deps = fakeDeps(new Vpws50StateHolder());
    const currentTime = "2026-07-19T10:00:00+09:00";
    const warning = buildVpws50Msg(warningKinds, {
      id: "vpws-current",
      reportDateTime: currentTime,
      serial: "2",
    });
    const cancellation = buildVpws50Msg(warningKinds, {
      id: "vpws-cancel",
      reportDateTime: currentTime,
      serial: "2",
      infoType: "取消",
    });
    const oldWarning = buildVpws50Msg(warningKinds, {
      id: "vpws-old",
      reportDateTime: "2026-07-19T09:00:00+09:00",
      serial: "1",
    });

    expect(processWeather(warning, deps).kind).toBe("ok");
    const cancelOutcome = requireWeatherOutcome(processWeather(cancellation, deps));
    expect(cancelOutcome.presentation.frameLevel).toBe("cancel");
    expect(deps.vpws50State.getCurrentAreasForDisplay()).toBeUndefined();
    expect(processWeather(cancellation, deps)).toEqual({ kind: "suppressed" });
    const differentCancellationPayload = buildVpws50Msg([{ code: "04", name: "洪水警報" }], {
      id: "vpws-cancel-different-payload",
      reportDateTime: currentTime,
      serial: "2",
      infoType: "取消",
    });
    expect(processWeather(differentCancellationPayload, deps)).toEqual({ kind: "suppressed" });
    expect(processWeather(oldWarning, deps)).toEqual({ kind: "suppressed" });
    expect(deps.vpws50State.getCurrentAreasForDisplay()).toBeUndefined();
  });

  it("VPWS50: 順不同取消と同時刻 Serial 逆転を suppressed にする", () => {
    const deps = fakeDeps(new Vpws50StateHolder());
    const currentTime = "2026-07-19T10:00:00+09:00";
    const current = buildVpws50Msg(warningKinds, {
      id: "vpws-serial-2",
      reportDateTime: currentTime,
      serial: "2",
    });
    expect(processWeather(current, deps).kind).toBe("ok");

    const outOfOrderCancellation = buildVpws50Msg(warningKinds, {
      id: "vpws-old-cancel",
      reportDateTime: "2026-07-19T09:00:00+09:00",
      serial: "1",
      infoType: "取消",
    });
    expect(processWeather(outOfOrderCancellation, deps)).toEqual({ kind: "suppressed" });

    const lowerSerial = buildVpws50Msg([{ code: "10", name: "大雨注意報" }], {
      id: "vpws-serial-1",
      reportDateTime: currentTime,
      serial: "1",
    });
    expect(processWeather(lowerSerial, deps)).toEqual({ kind: "suppressed" });
    expect(deps.vpws50State.getCurrentAreasForDisplay()?.kinds[0].kindCode).toBe("03");
  });

  it("VPWS50: 同一 revision の訂正を一度だけ受理し、通常報の同一 revision は拒否する", () => {
    const deps = fakeDeps(new Vpws50StateHolder());
    const reportDateTime = "2026-07-19T10:00:00+09:00";
    const announced = buildVpws50Msg(warningKinds, {
      id: "vpws-announced", reportDateTime, serial: "2",
    });
    const corrected = buildVpws50Msg([{ code: "10", name: "大雨注意報" }], {
      id: "vpws-corrected", reportDateTime, serial: "2", infoType: "訂正",
    });
    expect(processWeather(announced, deps).kind).toBe("ok");
    expect(processWeather(announced, deps)).toEqual({ kind: "suppressed" });
    const correction = requireWeatherOutcome(processWeather(corrected, deps));
    expect(correction.parsed.infoType).toBe("訂正");
    expect(deps.vpws50State.getCurrentAreasForDisplay()?.kinds[0].kindCode).toBe("10");
    expect(processWeather(corrected, deps)).toEqual({ kind: "suppressed" });
  });

  it("VPWS50: 取消済み revision の遅延訂正で snapshot を復活させない", () => {
    const deps = fakeDeps(new Vpws50StateHolder());
    const t1 = "2026-07-19T09:00:00+09:00";
    const t2 = "2026-07-19T10:00:00+09:00";
    expect(processWeather(buildVpws50Msg([{ code: "03", name: "大雨警報" }], {
      id: "vpws-a", reportDateTime: t1, serial: "1",
    }), deps).kind).toBe("ok");
    expect(processWeather(buildVpws50Msg([{ code: "04", name: "洪水警報" }], {
      id: "vpws-b", reportDateTime: t2, serial: "2",
    }), deps).kind).toBe("ok");
    expect(processWeather(buildVpws50Msg([{ code: "04", name: "洪水警報" }], {
      id: "vpws-b-cancel", reportDateTime: t2, serial: "2", infoType: "取消",
    }), deps).kind).toBe("ok");

    expect(processWeather(buildVpws50Msg([{ code: "10", name: "大雨注意報" }], {
      id: "vpws-b-late-correction", reportDateTime: t2, serial: "2", infoType: "訂正",
    }), deps)).toEqual({ kind: "suppressed" });
    expect(deps.vpws50State.getCurrentAreasForDisplay()?.kinds[0]).toMatchObject({
      kindCode: "03",
    });
  });

  it("VPWS50: unsafe 報は watermark を消費せず、同一 revision の正常再送を受理する", () => {
    const deps = fakeDeps(new Vpws50StateHolder());
    expect(processWeather(buildVpws50Msg(manyWarningKinds, {
      id: "vpws-safe-base", reportDateTime: "2026-07-19T09:00:00+09:00", serial: "1",
    }), deps).kind).toBe("ok");
    const unsafe = requireWeatherOutcome(processWeather(buildVpws50Msg([manyWarningKinds[0]], {
      id: "vpws-unsafe", reportDateTime: "2026-07-19T10:00:00+09:00", serial: "2",
    }), deps));
    expect(unsafe.presentation.weatherDiff).toMatchObject({
      confidence: "unsafe", unsafeReason: "abnormal_release_rate",
    });
    expect(deps.vpws50State.getCurrentAreasForDisplay()?.kinds).toHaveLength(5);

    const recovered = requireWeatherOutcome(processWeather(buildVpws50Msg(manyWarningKinds.slice(0, 2), {
      id: "vpws-safe-retry", reportDateTime: "2026-07-19T10:00:00+09:00", serial: "2",
    }), deps));
    expect(recovered.presentation.weatherDiff?.confidence).toBe("confirmed");
    expect(deps.vpws50State.getCurrentAreasForDisplay()?.kinds).toHaveLength(2);
  });

  it("VPWS50: stale な unsafe 報は表示・通知候補へ進めない", () => {
    const deps = fakeDeps(new Vpws50StateHolder());
    expect(processWeather(buildVpws50Msg(manyWarningKinds, {
      id: "vpws-current", reportDateTime: "2026-07-19T10:00:00+09:00", serial: "2",
    }), deps).kind).toBe("ok");
    expect(processWeather(buildVpws50Msg([manyWarningKinds[0]], {
      id: "vpws-stale-unsafe", reportDateTime: "2026-07-19T09:00:00+09:00", serial: "1",
    }), deps)).toEqual({ kind: "suppressed" });
    expect(deps.vpws50State.getCurrentAreasForDisplay()?.kinds).toHaveLength(5);
  });

  it("VPWS50: invalid Serial の unsafe 報は表示・通知候補へ進めない", () => {
    const deps = fakeDeps(new Vpws50StateHolder());
    expect(processWeather(buildVpws50Msg(manyWarningKinds, {
      id: "vpws-current", reportDateTime: "2026-07-19T10:00:00+09:00", serial: "2",
    }), deps).kind).toBe("ok");
    expect(processWeather(buildVpws50Msg([manyWarningKinds[0]], {
      id: "vpws-invalid-unsafe", reportDateTime: "2026-07-19T11:00:00+09:00", serial: "2A",
    }), deps)).toEqual({ kind: "suppressed" });
    expect(deps.vpws50State.getCurrentAreasForDisplay()?.kinds).toHaveLength(5);
  });

  it("VPWS50: unsafe 訂正は gate を commit せず、同一 revision の安全な訂正を受理する", () => {
    const deps = fakeDeps(new Vpws50StateHolder());
    const reportDateTime = "2026-07-19T10:00:00+09:00";
    expect(processWeather(buildVpws50Msg(manyWarningKinds, {
      id: "vpws-base", reportDateTime, serial: "2",
    }), deps).kind).toBe("ok");
    const unsafe = requireWeatherOutcome(processWeather(buildVpws50Msg([manyWarningKinds[0]], {
      id: "vpws-unsafe-correction", reportDateTime, serial: "2", infoType: "訂正",
    }), deps));
    expect(unsafe.presentation).toMatchObject({
      acceptedCorrection: false,
      weatherDiff: { confidence: "unsafe" },
    });
    expect(deps.vpws50State.getCurrentAreasForDisplay()?.kinds).toHaveLength(5);

    const recovered = requireWeatherOutcome(processWeather(buildVpws50Msg(manyWarningKinds.slice(0, 2), {
      id: "vpws-safe-correction", reportDateTime, serial: "2", infoType: "訂正",
    }), deps));
    expect(recovered.presentation).toMatchObject({
      acceptedCorrection: true,
      weatherDiff: { confidence: "confirmed" },
    });
    expect(deps.vpws50State.getCurrentAreasForDisplay()?.kinds).toHaveLength(2);
  });

  it("VPWW56: 取消後の重複取消と古い発表を suppressed にする", () => {
    const deps = fakeDeps(new Vpws50StateHolder());
    const currentTime = "2026-07-19T10:00:00+09:00";
    const warning = buildVpws50Msg(landslideKinds, {
      type: "VPWW56",
      id: "vpww-current",
      reportDateTime: currentTime,
      serial: "2",
    });
    const cancellation = buildVpws50Msg(landslideKinds, {
      type: "VPWW56",
      id: "vpww-cancel",
      reportDateTime: currentTime,
      serial: "2",
      infoType: "取消",
    });
    const oldWarning = buildVpws50Msg(landslideKinds, {
      type: "VPWW56",
      id: "vpww-old",
      reportDateTime: "2026-07-19T09:00:00+09:00",
      serial: "1",
    });

    expect(processWeather(warning, deps).kind).toBe("ok");
    expect(processWeather(cancellation, deps).kind).toBe("ok");
    expect(deps.vpww56State.getCurrentAreasForDisplay()).toBeUndefined();
    expect(processWeather(cancellation, deps)).toEqual({ kind: "suppressed" });
    expect(processWeather(oldWarning, deps)).toEqual({ kind: "suppressed" });
    expect(deps.vpww56State.getCurrentAreasForDisplay()).toBeUndefined();
  });

  it("VPWW56: 順不同取消と同時刻 Serial 逆転を suppressed にする", () => {
    const deps = fakeDeps(new Vpws50StateHolder());
    const currentTime = "2026-07-19T10:00:00+09:00";
    expect(processWeather(buildVpws50Msg(landslideKinds, {
      type: "VPWW56",
      id: "vpww-serial-2",
      reportDateTime: currentTime,
      serial: "2",
    }), deps).kind).toBe("ok");

    expect(processWeather(buildVpws50Msg(landslideKinds, {
      type: "VPWW56",
      id: "vpww-old-cancel",
      reportDateTime: "2026-07-19T09:00:00+09:00",
      serial: "1",
      infoType: "取消",
    }), deps)).toEqual({ kind: "suppressed" });
    expect(processWeather(buildVpws50Msg(landslideKinds, {
      type: "VPWW56",
      id: "vpww-serial-1",
      reportDateTime: currentTime,
      serial: "1",
    }), deps)).toEqual({ kind: "suppressed" });
    expect(deps.vpww56State.getCurrentAreasForDisplay()?.totalAreas).toBe(1);
  });
});

describe("displaySeverity ベースの frame/sound (Phase C)", () => {
  it("Code 49 (土砂災害警戒情報 = officialL4) は frame=critical / sound=warning (表示と音の分離)", () => {
    const outcome = requireWeatherOutcome(processWeather(createMockWsDataMessage(FIXTURE_VPWW56_DOSHA)));
    expect(outcome.presentation.frameLevel).toBe("critical");
    // 2026-06-12 目視ゲートでレビュー決定: critical 音は特別警報級のみ。
    // officialL4 は表示 critical のまま音だけ warning (意図された frame/sound 分離)
    expect(outcome.presentation.soundLevel).toBe("warning");
  });

  it("Code 03 (大雨警報 = officialL3) は warning (従来同等)", () => {
    const outcome = requireWeatherOutcome(processWeather(createMockWsDataMessage(FIXTURE_VPWW55_OAME)));
    expect(outcome.presentation.frameLevel).toBe("warning");
    expect(outcome.presentation.soundLevel).toBe("warning");
  });

  // VPWS50 の「新しい identity だが内容不変 → info (静音)」仕様は上の
  // isUnchanged テストおよび e2e/weather-vpws50-diff.test.ts で固定済み。

  it("VPWS50: 初回 Code 43 (officialL4) で frameLevel=critical / soundLevel=warning", () => {
    const deps = fakeDeps(new Vpws50StateHolder());
    const outcome = requireWeatherOutcome(processWeather(
      buildVpws50Msg([{ code: "43", name: "レベル４大雨危険警報" }], { id: "c43-1" }),
      deps,
    ));
    expect(outcome.presentation.weatherDiff?.isFirstReport).toBe(true);
    expect(outcome.presentation.frameLevel).toBe("critical");
    // 2026-06-12 レビュー決定: officialL4 は表示 critical のまま音だけ warning (frame/sound 分離)
    expect(outcome.presentation.soundLevel).toBe("warning");
  });

  // Phase C Task 3: 差分エンジンが DISPLAY_SEVERITY_RANK ベース化され、
  // 03 (officialL3) → 43 (officialL4) が upgraded として検出される (L4 昇格沈黙の解消)。
  it("VPWS50: 03→43 で diff.upgraded かつ frameLevel=critical / soundLevel=warning (Task 3 で有効化)", () => {
    const deps = fakeDeps(new Vpws50StateHolder());
    processWeather(
      buildVpws50Msg([{ code: "03", name: "大雨警報" }], {
        id: "u43-1",
        reportDateTime: "2026-06-12T15:00:00+09:00",
      }),
      deps,
    );
    const outcome = requireWeatherOutcome(processWeather(
      buildVpws50Msg([{ code: "43", name: "レベル４大雨危険警報" }], {
        id: "u43-2",
        reportDateTime: "2026-06-12T15:30:00+09:00",
      }),
      deps,
    ));
    expect(outcome.presentation.weatherDiff!.upgraded).toHaveLength(1);
    expect(outcome.presentation.frameLevel).toBe("critical");
    // 2026-06-12 レビュー決定: officialL4 は表示 critical のまま音だけ warning (frame/sound 分離)
    expect(outcome.presentation.soundLevel).toBe("warning");
  });
});

describe("表示色と優先度・音の分離 (無変化 VPWS50 の色揺れ修正)", () => {
  // 無変化 VPWS50 (isUnchanged && !shouldRecap) は静音化で frameLevel/soundLevel=info に落ちるが、
  // テロップ色 (displaySeverity → summary.role) は全国集約の最大 severity のまま安定させる。
  it("無変化 VPWS50: 色=集約 severity 据置 / 優先度=low / 音=info の 3 点契約", () => {
    const state = new Vpws50StateHolder();
    const kinds = [{ code: "03", name: "大雨警報" }]; // officialL3 → 集約 severity = warning
    const first = requireWeatherOutcome(processWeather(buildVpws50Msg(kinds, {
      id: "sep-1",
      reportDateTime: "2026-06-12T15:00:00+09:00",
    }), fakeDeps(state)));
    // 初回は通常 (warning)。frameLevel も displaySeverity も warning
    expect(first.presentation.frameLevel).toBe("warning");
    expect(first.presentation.displaySeverity).toBe("warning");

    const out = requireWeatherOutcome(processWeather(buildVpws50Msg(kinds, {
      id: "sep-2",
      reportDateTime: "2026-06-12T15:30:00+09:00",
    }), fakeDeps(state)));
    expect(out.presentation.weatherDiff?.isUnchanged).toBe(true);
    // 優先度・音は従来どおり静音化 (frameLevel=info → tickerPriority=low、soundLevel=info)
    expect(out.presentation.frameLevel).toBe("info");
    expect(out.presentation.soundLevel).toBe("info");
    // 色専用の集約 severity は info に降格せず warning のまま
    expect(out.presentation.displaySeverity).toBe("warning");

    const event = toPresentationEvent(out);
    expect(event.displaySeverity).toBe("warning");
    // tickerPriority は frameLevel 由来で low (割込まない)
    expect(tickerPriority(event)).toBe("low");
    // summary.role (テロップ色) は displaySeverity 由来で warning (灰化しない)
    const dto = projectDisplayEvent(event, "要約");
    expect(dto.summary.role).toBe("warning");
    expect(dto.frameLevel).toBe("info"); // frame は据置 (優先度・音の源)
  }, 20000);

  it("VPWW55-61 (差分経路を通らない) も displaySeverity=frameLevel で色は据置", () => {
    // 府県電文は VPWS50 の差分静音化を受けないため displaySeverity と frameLevel が一致する
    const outcome = requireWeatherOutcome(processWeather(createMockWsDataMessage(FIXTURE_VPWW55_OAME)));
    expect(outcome.presentation.displaySeverity).toBe(outcome.presentation.frameLevel);
    const dto = projectDisplayEvent(toPresentationEvent(outcome), "要約");
    expect(dto.summary.role).toBe(outcome.presentation.frameLevel);
  });
});

describe("VPWW55-61: 通知 frameLevel と表示 weatherCoreFrameLevel の整合 (Phase C)", () => {
  it("発表系 fixture 全件で presentation.frameLevel === weatherCoreFrameLevel", () => {
    // (Codex R3 P0-1) Code 49/48 (officialL4) を含む VPWW56/57 を必ず母集団に入れる。
    // 解除のみ電文は除外 (表示=cancel 色 / 通知=info 静音は意図された差、従来仕様)
    const fixtures = [
      FIXTURE_VPWW55_OAME,   // officialL3 (Code 03)
      FIXTURE_VPWW56_DOSHA,  // officialL4 (Code 49)
      FIXTURE_VPWW57_KOCHO,  // officialL4 (Code 48)
      FIXTURE_VPWW58_BOFU,   // nonLevelWarning (Code 05)
      FIXTURE_VPWW59_HARO,   // nonLevelWarning (Code 07)
      FIXTURE_VPWW60_OYUKI,  // nonLevelWarning (Code 06)
      FIXTURE_VPWW61_OTHER,  // nonLevelAdvisory (Code 14 等)
    ];
    for (const f of fixtures) {
      const outcome = requireWeatherOutcome(processWeather(createMockWsDataMessage(f)));
      expect(outcome.presentation.frameLevel).toBe(
        weatherCoreFrameLevel(outcome.parsed),
      );
    }
  });
});

describe("VPWP50 Code 41 (officialL4) の critical 波及 (Phase B 回帰)", () => {
  // high_severity fixture は土砂災害危険度 Property に Code 41 (officialL4) と
  // 大雨浸水危険度 Property に Code 50 (nonLevelSpecial) が共存する。
  // 表示代表 maxDisplaySeverity は rank 上位の officialL4 (Task 1 parser テストで固定)。
  // 音は 2026-06-12 共存エッジ解消 (集合ベース maxSoundLevel) により、
  // 共存時は特別警報側 (Code 50 = critical 音) が勝つ — L4 単独なら音は warning のまま。
  it("processWeatherWarningTimeseries → toPresentationEvent → renderSummaryLine が [緊急] (critical) になる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWP50_HIGH_SEVERITY);
    const outcome = processWeatherWarningTimeseries(msg);
    expect(outcome).not.toBeNull();
    // ① soundLevel は critical (41+50 共存 — 特別警報側の音が勝つ。修正前は
    //    maxDisplaySeverity=officialL4 経由で warning に潰れていた)
    expect(outcome!.presentation.soundLevel).toBe("critical");
    // (frameLevel = 表示は critical 据置であることを併記確認)
    expect(outcome!.presentation.frameLevel).toBe("critical");
    // ② renderSummaryLine の出力に critical トークン [緊急] が載る
    const event = toPresentationEvent(outcome!);
    expect(event.frameLevel).toBe("critical");
    const line = stripAnsi(renderSummaryLine(event, 120));
    expect(line).toContain("[緊急]");
  });
});
