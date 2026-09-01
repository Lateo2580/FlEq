import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parseTyphoonProbability, decideFallback } from "../../src/dmdata/typhoon-probability-parser";
import {
  createMockWsDataMessage,
  createMockWsDataMessageFromXml,
  FIXTURE_VPTA50_DAMREY,
  FIXTURE_VPTA50_JANGMI_GONE,
} from "../helpers/mock-message";
import { buildVpta50Synthetic } from "../helpers/build-vpta50-synthetic";

const BASE_XML = readFileSync(
  resolve(__dirname, "../fixtures/76_01_01_200630_VPTA50.xml"),
  "utf-8"
);

describe("parseTyphoonProbability — TyphoonName 抽出", () => {
  it("DAMREY の name を抽出できる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPTA50_DAMREY);
    const info = parseTyphoonProbability(msg);
    expect(info).not.toBeNull();
    expect(info!.name).toEqual({
      name: "DAMREY",
      nameKana: "ダムレイ",
      number: "2001",
      remark: null,
    });
  });
});

describe("parseTyphoonProbability — 取消", () => {
  it("取消電文は regions=[] / fallback=none で返る", () => {
    const cancelXml = buildVpta50Synthetic(BASE_XML, "cancel");
    const msg = createMockWsDataMessageFromXml(cancelXml, "VPTA50");
    const info = parseTyphoonProbability(msg);
    expect(info).not.toBeNull();
    expect(info!.infoType).toBe("取消");
    expect(info!.regions).toEqual([]);
    expect(info!.fallback).toBe("none");
  });
});

describe("parseTyphoonProbability — 日別積算", () => {
  it("DAMREY の regions は 375件", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPTA50_DAMREY);
    const info = parseTyphoonProbability(msg)!;
    expect(info.regions.length).toBe(375);
  });

  it("益田地区 (320023) の daily が [0, 0, 92, 92, 92]", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPTA50_DAMREY);
    const info = parseTyphoonProbability(msg)!;
    const masuda = info.regions.find(r => r.areaCode === "320023");
    expect(masuda).toBeDefined();
    expect(masuda!.daily).toEqual([0, 0, 92, 92, 92]);
    expect(masuda!.prefName).toBe("島根県");
    expect(masuda!.prefCode).toBe("320000");
  });

  it("JANGMI消滅 は全 region で daily が全 0", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPTA50_JANGMI_GONE);
    const info = parseTyphoonProbability(msg)!;
    for (const r of info.regions) {
      for (const v of r.daily) expect(v).toBe(0);
    }
  });
});

describe("parseTyphoonProbability — TimeSeriesInfo + peak", () => {
  it("timeDefines が 40件", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPTA50_DAMREY);
    const info = parseTyphoonProbability(msg)!;
    expect(info.timeDefines.length).toBe(40);
    expect(info.timeDefines[0].timeId).toBe(1);
    expect(info.timeDefines[0].duration).toBe("PT3H");
  });

  it("益田地区 の peak が step=21, value=87, time=2020-10-03T03:00:00+09:00", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPTA50_DAMREY);
    const info = parseTyphoonProbability(msg)!;
    const masuda = info.regions.find(r => r.areaCode === "320023")!;
    expect(masuda.peak.kind).toBe("value");
    if (masuda.peak.kind === "value") {
      expect(masuda.peak.step).toBe(21);
      expect(masuda.peak.value).toBe(87);
      expect(masuda.peak.time).toBe("2020-10-03T03:00:00+09:00");
    }
    expect(masuda.series40.length).toBe(40);
  });

  it("JANGMI消滅 は全 region で peak.kind='allZero'", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPTA50_JANGMI_GONE);
    const info = parseTyphoonProbability(msg)!;
    for (const r of info.regions) {
      expect(r.peak.kind).toBe("allZero");
    }
  });

  it("synthetic missingTimeSeries: 全 region で peak.kind='noData' reason=missingTimeDefines", () => {
    const xml = buildVpta50Synthetic(BASE_XML, "missingTimeSeries");
    const msg = createMockWsDataMessageFromXml(xml, "VPTA50");
    const info = parseTyphoonProbability(msg)!;
    expect(info.timeDefines.length).toBe(0);
    for (const r of info.regions) {
      expect(r.peak.kind).toBe("noData");
      if (r.peak.kind === "noData") expect(r.peak.reason).toBe("missingTimeDefines");
    }
  });
});

describe("parseTyphoonProbability — diagnostics", () => {
  const synthMsg = (xml: string) =>
    createMockWsDataMessageFromXml(xml, "VPTA50");

  it("synthetic duplicateCode: parserDiagnostics.duplicateCodes に記録", () => {
    const xml = buildVpta50Synthetic(BASE_XML, "duplicateCode");
    const info = parseTyphoonProbability(synthMsg(xml))!;
    expect(info.parserDiagnostics.duplicateCodes).toContain("011011");
  });

  it("synthetic monotonicityViolation: parserDiagnostics.dailyAnomalies に記録", () => {
    const xml = buildVpta50Synthetic(BASE_XML, "monotonicityViolation");
    const info = parseTyphoonProbability(synthMsg(xml))!;
    expect(info.parserDiagnostics.dailyAnomalies.some(a => a.areaCode === "011011")).toBe(true);
  });

  it("DAMREY 正常電文では dailyAnomalies=空", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPTA50_DAMREY);
    const info = parseTyphoonProbability(msg)!;
    expect(info.parserDiagnostics.dailyAnomalies).toEqual([]);
    expect(info.parserDiagnostics.sectionCodeCountMismatch).toBe(false);
  });
});

describe("parseTyphoonProbability — TimeDefine 並び替え防御", () => {
  it("reversedTimeDefines: 逆順でも peak.time が正しい timeId に対応する dateTime を返す", () => {
    const xml = buildVpta50Synthetic(BASE_XML, "reversedTimeDefines");
    const msg = createMockWsDataMessageFromXml(xml, "VPTA50");
    const info = parseTyphoonProbability(msg)!;
    // 正順の場合と同じく peak.time が正しい dateTime であること
    const masuda = info.regions.find(r => r.areaCode === "320023")!;
    expect(masuda).toBeDefined();
    expect(masuda.peak.kind).toBe("value");
    if (masuda.peak.kind === "value") {
      // step=21 → timeId=21 に対応する dateTime が返るはず
      // (正順パースと同じ結果になることを確認)
      const tdById = new Map(info.timeDefines.map(td => [td.timeId, td]));
      const expectedTd = tdById.get(masuda.peak.step);
      expect(expectedTd).toBeDefined();
      expect(masuda.peak.time).toBe(expectedTd!.dateTime);
    }
  });

  it("部分一致する timeId / refID を十進整数として救済しない", () => {
    const xml = BASE_XML
      .replace('timeId="1"', 'timeId="1x"')
      .replace('refID="1"', 'refID="1x"');
    const info = parseTyphoonProbability(createMockWsDataMessageFromXml(xml, "VPTA50"));
    expect(info).not.toBeNull();
    expect(info!.timeDefines.some((definition) => definition.timeId === 1)).toBe(false);
    expect(info!.parserDiagnostics.unknownAttributes).toContain("timeId=1x");
    expect(info!.parserDiagnostics.unknownAttributes)
      .toContain(`refID=1x (out of range 1..${info!.timeDefines.length})`);
  });
});

describe("parseTyphoonProbability — memory guard", () => {
  it("synthetic oversized (>5MB) は parser=null (raw fallback)", () => {
    const xml = buildVpta50Synthetic(BASE_XML, "oversized");
    const msg = createMockWsDataMessageFromXml(xml, "VPTA50");
    expect(parseTyphoonProbability(msg)).toBeNull();
  });

  it("DAMREY 正常電文 fallback='none'", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPTA50_DAMREY);
    expect(parseTyphoonProbability(msg)!.fallback).toBe("none");
  });

  it("decideFallback: regions=375, steps=40 → 'none'", () => {
    expect(decideFallback(375, 40, 1_000_000)).toBe("none");
  });

  it("decideFallback: regions=601 → 'compactOnly'", () => {
    expect(decideFallback(601, 40, 1_000_000)).toBe("compactOnly");
  });

  it("decideFallback: steps=61 → 'compactOnly'", () => {
    expect(decideFallback(375, 61, 1_000_000)).toBe("compactOnly");
  });

  it("decideFallback: bytes>5MB → 'raw'", () => {
    expect(decideFallback(375, 40, 5 * 1024 * 1024 + 1)).toBe("raw");
  });

  // refID は元の 1〜40 までなので追加 step は null のままだが、DTO は切り捨てない。
  it.each([
    [60, "none"],
    [61, "compactOnly"],
    [62, "compactOnly"],
  ] as const)("parser 統合: stepCount=%i を全件保持して fallback=%s", (stepCount, fallback) => {
    const additions = Array.from({ length: stepCount - 40 }, (_, i) =>
      `<TimeDefine timeId="${41 + i}">\n<DateTime>2020-10-05T15:00:00+09:00</DateTime>\n<Duration>PT3H</Duration>\n</TimeDefine>`,
    ).join("\n");
    const xml = BASE_XML.replace(
      `</TimeDefines>`,
      `${additions}\n</TimeDefines>`,
    );
    const msg = createMockWsDataMessageFromXml(xml, "VPTA50");
    const info = parseTyphoonProbability(msg);
    expect(info).not.toBeNull();
    expect(info!.timeDefines).toHaveLength(stepCount);
    expect(info!.regions.every((region) => region.series40.length === stepCount)).toBe(true);
    expect(info!.fallback).toBe(fallback);
  });
});
