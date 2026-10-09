// P3-C6-AC05（作者裁定 P3-C6-COAST-ASSET=A）: P3 の測定専用の最小海岸線資材。repo の中で作る模式図で、地理の形を持たない。
// 正規の津波予報区 GIS（N18、P4）ではなく、P4 の GIS・LOD・hit test・D-AC15・D-AC23 に使わない（D-P3-4）。
// canonical JSON の key 順・空白なしが coastSha256 の照合対象（A9 の canonicalGeometryJson と同じ作り）。

const COAST_SCHEMA_VERSION = "p3-tsunami-minimal-coast-v1";

export type CoastRect = readonly [number, number, number, number];

// 合成 template の 311・312 と、公開 fixture 32-39_11_02・32-39_11_09・32-39_11_11 の Body/Tsunami/Forecast/Item/Area/Code の和集合（51）。
const COAST_CODES = ["100", "101", "102", "111", "120", "200", "201", "202", "210", "220", "230", "250", "300", "310", "311", "312", "320",
  "321", "330", "340", "350", "360", "380", "390", "391", "400", "510", "521", "522", "530", "560", "570", "580", "590", "600", "601",
  "610", "701", "712", "730", "740", "750", "751", "760", "770", "771", "772", "773", "800", "801", "802"] as const;

// 32-39_12_02（訓練）だけに現れる 15 code は、資材に無い code の経路（AC07(2)）を確かめるために意図して入れない。
const KNOWN_EXCLUSIONS = ["110", "240", "341", "361", "370", "500", "520", "540", "550", "551", "700", "710", "711", "720", "731"];

// code の昇順に 3 列 × 17 行の格子へ、1 区域 100×16 CSS px の矩形を置く（図は 300×272 CSS px）。
const COAST_COLUMNS = 3, COAST_CELL_WIDTH = 100, COAST_CELL_HEIGHT = 16;
const COAST_SEGMENTS: readonly Readonly<{ code: string; rect: CoastRect }>[] = COAST_CODES.map((code, index) => ({ code,
  rect: [(index % COAST_COLUMNS) * COAST_CELL_WIDTH, Math.floor(index / COAST_COLUMNS) * COAST_CELL_HEIGHT, COAST_CELL_WIDTH, COAST_CELL_HEIGHT] }));

const COAST_RECT_BY_CODE: ReadonlyMap<string, CoastRect> = new Map(COAST_SEGMENTS.map((segment) => [segment.code, segment.rect]));

// P3TsunamiCoastAsset の canonical JSON。出力 hash は bytes の中に置けないので manifest と C6 の smoke 条件に置く。
function canonicalCoastJson(): string {
  return JSON.stringify({
    schemaVersion: COAST_SCHEMA_VERSION,
    provenance: {
      source: "repo内で生成した模式図（地理の形を持たない）。P3の測定専用。正規の津波予報区GIS（N18、P4）ではない",
      version: "p3-c6-schematic-1",
      retrievedAt: null,
      terms: "外部の資材を使わない",
      sourceArchiveSha256: null,
      toolVersion: "reconstruction/src/display/chrome-eew/coast.ts",
      toolArguments: [
        "codes=合成templateの311・312と公開fixture 32-39_11_02・32-39_11_09・32-39_11_11のBody/Tsunami/Forecast/Item/Area/Codeの和集合",
        "layout=codeの昇順・3列×17行・1区域100×16 CSS px・図300×272 CSS px",
      ],
      expectedCodeCount: 51,
      knownExclusions: KNOWN_EXCLUSIONS.map((code) => ({ code, reason: "32-39_12_02だけに現れる。資材に無いcodeの経路（AC07(2)）の確認用" })),
    },
    segments: COAST_SEGMENTS.map((segment) => ({ code: segment.code, rect: segment.rect })),
  });
}

export { canonicalCoastJson, COAST_RECT_BY_CODE, COAST_SEGMENTS };
