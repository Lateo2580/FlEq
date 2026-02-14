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


/** VXSE45 EEW地震動予報 Serial=1 初報 */
export const FIXTURE_VXSE45_S1 = "77_01_01_240613_VXSE45.xml";

/** VXSE45 EEW地震動予報 Serial=26 */
export const FIXTURE_VXSE45_S26 = "77_01_26_240613_VXSE45.xml";


/** VXSE45 EEW地震動予報 取消報 Serial=32 */
export const FIXTURE_VXSE45_CANCEL = "77_01_33_240613_VXSE45.xml";

/** フィクスチャXMLを読み込む */
export function readFixture(filename: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, filename), "utf-8");
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
  const typeMatch = fixtureName.match(/(VXSE\d+)/);
  const type = typeMatch ? typeMatch[1] : "VXSE53";

  const base: WsDataMessage = {
    type: "data",
    version: "2.0",
    classification: type.startsWith("VXSE4") || type.startsWith("VXSE5")
      ? "eew.forecast"
      : "telegram.earthquake",
    id: "test-id-001",
    passing: [{ name: "test", time: new Date().toISOString() }],
    head: {
      type,
      author: "気象庁",
      time: new Date().toISOString(),
      test: false,
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
