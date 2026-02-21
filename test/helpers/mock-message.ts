import fs from "fs";
import path from "path";
import zlib from "zlib";
import { WsDataMessage } from "../../src/types";

/** フィクスチャディレクトリのパス */
const FIXTURES_DIR = path.resolve(__dirname, "../fixtures");

// ── フィクスチャパス定数 ──

/** VXSE51 震度速報 (最大4) */
export const FIXTURE_VXSE51_SHINDO = "32-35_08_03_100915_VXSE51.xml";

/** VXSE51 震度速報 (別パターン) */
export const FIXTURE_VXSE51_SHINDO_2 = "32-35_07_01_100915_VXSE51.xml";

/** VXSE51 取消報 */
export const FIXTURE_VXSE51_CANCEL = "32-35_10_01_220510_VXSE51.xml";

/** VXSE53 遠地地震 (フィジー Mj7.1) */
export const FIXTURE_VXSE53_ENCHI = "32-35_01_03_100514_VXSE53.xml";

/** VXSE53 遠地地震 取消報 */
export const FIXTURE_VXSE53_CANCEL = "32-39_05_12_100915_VXSE53.xml";

/** VXSE53 震源・震度情報 (訓練) */
export const FIXTURE_VXSE53_DRILL_1 = "32-35_01_03_240613_VXSE53.xml";

/** VXSE53 震源・震度情報 (訓練 別報) */
export const FIXTURE_VXSE53_DRILL_2 = "32-35_04_04_240613_VXSE53.xml";

/** VXSE44 EEW予報 Serial=10 */
export const FIXTURE_VXSE44_S10 = "36_01_10_240613_VXSE44.xml";

/** VXSE43 EEW警報 Serial=1 */
export const FIXTURE_VXSE43_WARNING_S1 = "37_01_01_240613_VXSE43.xml";

/** VXSE43 EEW警報 Serial=2 */
export const FIXTURE_VXSE43_WARNING_S2 = "37_01_02_240613_VXSE43.xml";

/** VXSE43 EEW警報 Serial=3 */
export const FIXTURE_VXSE43_WARNING_S3 = "37_01_03_240613_VXSE43.xml";

/** VXSE45 EEW地震動予報 Serial=1 初報 */
export const FIXTURE_VXSE45_S1 = "77_01_01_240613_VXSE45.xml";

/** VXSE45 EEW地震動予報 Serial=26 */
export const FIXTURE_VXSE45_S26 = "77_01_26_240613_VXSE45.xml";


/** VXSE45 EEW地震動予報 取消報 Serial=32 */
export const FIXTURE_VXSE45_CANCEL = "77_01_33_240613_VXSE45.xml";

/** VXSE52 震源に関する情報 */
export const FIXTURE_VXSE52_HYPO_1 = "32-35_01_02_240613_VXSE52.xml";

/** VXSE52 震源に関する情報 (別報) */
export const FIXTURE_VXSE52_HYPO_2 = "32-35_04_03_240613_VXSE52.xml";

/** VXSE52 震源に関する情報 */
export const FIXTURE_VXSE52_HYPO_3 = "32-35_06_02_100915_VXSE52.xml";

/** VXSE52 震源に関する情報 */
export const FIXTURE_VXSE52_HYPO_4 = "33_12_01_240613_VXSE52.xml";

/** VXSE56 地震活動情報 */
export const FIXTURE_VXSE56_ACTIVITY_1 = "32-35_09_01_191111_VXSE56.xml";

/** VXSE56 地震活動情報 (別報) */
export const FIXTURE_VXSE56_ACTIVITY_2 = "32-35_09_02_220316_VXSE56.xml";

/** VXSE60 地震回数情報 */
export const FIXTURE_VXSE60_1 = "32-35_03_01_100514_VXSE60.xml";

/** VXSE60 地震回数情報 取消 */
export const FIXTURE_VXSE60_CANCEL = "32-35_10_02_220510_VXSE60.xml";

/** VXSE61 震源要素更新 */
export const FIXTURE_VXSE61_1 = "32-35_03_02_240613_VXSE61.xml";

/** VXSE61 震源要素更新 取消 */
export const FIXTURE_VXSE61_CANCEL = "32-35_06_10_100915_VXSE61.xml";

/** VTSE41 津波警報・注意報 */
export const FIXTURE_VTSE41_WARN = "32-39_11_02_250206_VTSE41.xml";

/** VTSE41 津波警報・注意報 取消 */
export const FIXTURE_VTSE41_CANCEL = "38-39_03_01_210805_VTSE41.xml";

/** VTSE51 津波情報 */
export const FIXTURE_VTSE51_INFO = "32-39_11_03_250206_VTSE51.xml";

/** VTSE52 沖合の津波情報 */
export const FIXTURE_VTSE52_OFFSHORE = "61_11_01_250206_VTSE52.xml";

/** VXSE45 PLUM法のみ (仮定震源要素) */
export const FIXTURE_VXSE45_PLUM = "77_02_01_260101_VXSE45_PLUM.xml";

/** VXSE45 混合 (通常推定 + PLUM法地域) */
export const FIXTURE_VXSE45_MIXED = "77_02_02_260101_VXSE45_MIXED.xml";

/** VZSE40 地震・津波に関するお知らせ */
export const FIXTURE_VZSE40_NOTICE = "42_01_01_100514_VZSE40.xml";

/** VZSE40 地震・津波に関するお知らせ (取消) */
export const FIXTURE_VZSE40_CANCEL = "42_03_01_220402_VZSE40.xml";

/** VYSE50 南海トラフ地震臨時情報 (調査中 Code=111) */
export const FIXTURE_VYSE50_INVESTIGATION = "74_01_01_200512_VYSE50.xml";

/** VYSE50 南海トラフ地震臨時情報 (巨大地震警戒 Code=120) */
export const FIXTURE_VYSE50_ALERT = "74_01_04_200512_VYSE50.xml";

/** VYSE50 南海トラフ地震臨時情報 (巨大地震注意 Code=130) */
export const FIXTURE_VYSE50_CAUTION = "74_01_06_200512_VYSE50.xml";

/** VYSE50 南海トラフ地震臨時情報 (調査終了 Code=190) */
export const FIXTURE_VYSE50_CLOSED = "74_01_07_200512_VYSE50.xml";

/** VYSE50 南海トラフ地震臨時情報 (取消) */
export const FIXTURE_VYSE50_CANCEL = "74_03_01_220318_VYSE50.xml";

/** VYSE51 南海トラフ地震関連解説情報 (臨時 Code=210) */
export const FIXTURE_VYSE51_ADVISORY = "75_01_01_200512_VYSE51.xml";

/** VYSE52 南海トラフ地震関連解説情報 (定例 Code=200) */
export const FIXTURE_VYSE52_REGULAR = "75_01_04_200512_VYSE52.xml";

/** VXSE62 長周期地震動に関する観測情報 */
export const FIXTURE_VXSE62_LGOBS = "78_01_01_240613_VXSE62.xml";

/** VYSE60 北海道・三陸沖後発地震注意情報 */
export const FIXTURE_VYSE60_AFTERSHOCK = "80_01_01_240821_VYSE60.xml";

/** VXSE45 EEW地震動予報 最終報 (NextAdvisory付き) */
export const FIXTURE_VXSE45_FINAL = "77_01_30_260101_VXSE45_FINAL.xml";

/** フィクスチャXMLを読み込む (fixtures/ → selected_xml/ フォールバック) */
export function readFixture(filename: string): string {
  const primaryPath = path.join(FIXTURES_DIR, filename);
  if (fs.existsSync(primaryPath)) {
    return fs.readFileSync(primaryPath, "utf-8");
  }
  const fallbackPath = path.join(FIXTURES_DIR, "selected_xml", filename);
  return fs.readFileSync(fallbackPath, "utf-8");
}

/** XMLをgzip+base64エンコードする */
export function encodeXml(xml: string): string {
  const compressed = zlib.gzipSync(Buffer.from(xml, "utf-8"));
  return compressed.toString("base64");
}

/**
 * フィクスチャXMLから WsDataMessage を構築する。
 * overrides で任意のフィールドを上書き可能。
 */
export function createMockWsDataMessage(
  fixtureName: string,
  overrides?: Partial<WsDataMessage>
): WsDataMessage {
  const xml = readFixture(fixtureName);
  const body = encodeXml(xml);

  // ファイル名から type を推定
  const typeMatch = fixtureName.match(/(V[TXYZ]SE\d+)/);
  const type = typeMatch ? typeMatch[1] : "VXSE53";
  const classification = type === "VXSE43"
    ? "eew.warning"
    : (type === "VXSE44" || type === "VXSE45")
      ? "eew.forecast"
      : "telegram.earthquake";

  const base: WsDataMessage = {
    type: "data",
    version: "2.0",
    classification,
    id: "test-id-001",
    passing: [{ name: "test", time: new Date().toISOString() }],
    head: {
      type,
      author: "気象庁",
      time: new Date().toISOString(),
      test: false,
      xml: true,
    },
    xmlReport: {
      control: {
        title: "テスト電文",
        dateTime: new Date().toISOString(),
        status: "通常",
        editorialOffice: "気象庁本庁",
        publishingOffice: "気象庁",
      },
      head: {
        title: "テスト電文",
        reportDateTime: new Date().toISOString(),
        targetDateTime: new Date().toISOString(),
        eventId: null,
        serial: null,
        infoType: "発表",
        infoKind: "テスト",
        infoKindVersion: "1.0_0",
        headline: null,
      },
    },
    format: "xml",
    compression: "gzip",
    encoding: "base64",
    body,
  };

  return { ...base, ...overrides } as WsDataMessage;
}
