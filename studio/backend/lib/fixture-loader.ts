import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import type { WsDataMessage } from "../../../src/types";

const FIXTURES_DIR = path.resolve(__dirname, "../../../test/fixtures");

const TYPE_REGEX =
  /(V[TXYZ]SE\d+|VFVO\d+|VFSVii|VZVO\d+|VPWW\d+|VPWP\d+|VPWS\d+|VPHW\d+|VPBS\d+|VPAW\d+|VPZI\d+|VPCJ\d+|VPZJ\d+|VPFJ\d+|VPFW\d+|VPFD\d+|VPCI\d+|VMCJ\d+|VXKO\d+|VXSU\d+)/;

// weather 系統 telegram type 一覧 (Phase 1a は VPWW のみ実利用、登録は段階拡大)
// VXKO/VXSU は洪水・水位系 (router 上は telegram.weather に分類される) のため、ここにも含める
const WEATHER_TYPE_PREFIXES = ["VPWW", "VPWP", "VPWS", "VPHW", "VPBS", "VPAW", "VPZI", "VPCJ", "VPZJ", "VPFJ", "VPFW", "VPFD", "VXKO", "VXSU"];

// Studio 一覧に出す系統 (registry に entry がある weather + 地震 + 津波 + 火山)。
// classifyType には使わない — VXSE は eew/earthquake、VTSE は telegram.earthquake、
// VFVO/VFSVii/VZVO は telegram.volcano に分類される必要があるため WEATHER_TYPE_PREFIXES
// へは足さない (Phase 1 津波はここが漏れて一覧に出ていなかった。Phase 2 で解消)
const STUDIO_LISTED_PREFIXES = [...WEATHER_TYPE_PREFIXES, "VXSE", "VTSE", "VFVO", "VFSVii", "VZVO", "VYSE", "VZSE"];

export interface FixtureSummary {
  id: string;          // ファイル名 (例: "15_17_01_251222_VPWW55.xml")
  type: string;        // 電文タイプ (例: "VPWW55")
  label: string;       // UI 表示用ラベル
}

/** ファイル名から電文タイプを推定する (weather-registry の entry 判定もこれを使う) */
export function inferType(filename: string): string | null {
  const m = filename.match(TYPE_REGEX);
  return m == null ? null : m[1];
}

function classifyType(type: string): WsDataMessage["classification"] {
  if (WEATHER_TYPE_PREFIXES.some((p) => type.startsWith(p))) {
    return "telegram.weather";
  }
  if (type.startsWith("VFVO") || type.startsWith("VFSV") || type.startsWith("VZVO")) {
    return "telegram.volcano";
  }
  if (type === "VXSE43") return "eew.warning";
  if (type === "VXSE44" || type === "VXSE45") return "eew.forecast";
  return "telegram.earthquake";
}

export function loadFixture(filename: string): WsDataMessage | null {
  // HTTP 由来の fixtureId をそのまま path.join するため、
  // パス区切りや ".." を含む名前は拒否する (fixtures 外への到達を防ぐ)
  if (filename !== path.basename(filename) || filename.includes("..")) return null;
  try {
    let xmlPath = path.join(FIXTURES_DIR, filename);
    if (!fs.existsSync(xmlPath)) {
      xmlPath = path.join(FIXTURES_DIR, "selected_xml", filename);
    }
    if (!fs.existsSync(xmlPath)) return null;

    const xml = fs.readFileSync(xmlPath, "utf-8");
    const body = zlib.gzipSync(Buffer.from(xml, "utf-8")).toString("base64");

    const type = inferType(filename) ?? "VXSE53";
    const classification = classifyType(type);

    const nowIso = new Date().toISOString();
    return {
      type: "data",
      version: "2.0",
      classification,
      id: `studio-${filename}`,
      passing: [{ name: "studio", time: nowIso }],
      head: {
        type,
        author: "気象庁",
        time: nowIso,
        test: false,
        xml: true,
      },
      xmlReport: {
        control: {
          title: "Studio preview",
          dateTime: nowIso,
          status: "通常",
          editorialOffice: "気象庁本庁",
          publishingOffice: "気象庁",
        },
        head: {
          title: "Studio preview",
          reportDateTime: nowIso,
          targetDateTime: nowIso,
          eventId: null,
          serial: null,
          infoType: "発表",
          infoKind: "Studio",
          infoKindVersion: "1.0_0",
          headline: null,
        },
      },
      format: "xml",
      compression: "gzip",
      encoding: "base64",
      body,
    };
  } catch {
    return null;
  }
}

export function listWeatherFixtures(): FixtureSummary[] {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  const direct = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".xml"));
  // Phase 4a: VYSE 全 fixture と VZSE40 / VXSE62 は selected_xml/ 配下のみのため一覧走査を拡張。
  // id は basename 必須 (loadFixture の path guard :48 が selected_xml/ 形式を拒否し、
  // :52 の fallback により basename で解決が成立する)。衝突時は直下優先
  // (loadFixture の解決順と一致)。直下 / selected_xml の basename 重複なしは
  // fixture-loader.test.ts の invariant で固定する
  const selectedDir = path.join(FIXTURES_DIR, "selected_xml");
  const selected = fs.existsSync(selectedDir)
    ? fs.readdirSync(selectedDir).filter((f) => f.endsWith(".xml"))
    : [];
  const seen = new Set(direct);
  const files = [...direct, ...selected.filter((f) => !seen.has(f))];
  const result: FixtureSummary[] = [];
  for (const f of files) {
    const type = inferType(f);
    if (type == null) continue;
    if (!STUDIO_LISTED_PREFIXES.some((p) => type.startsWith(p))) continue;
    result.push({
      id: f,
      type,
      label: `${type} — ${f.replace(/\.xml$/, "")}`,
    });
  }
  result.sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
  return result;
}
