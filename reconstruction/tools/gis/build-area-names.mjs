// P4-SHELL-TYPES-001（P4-ST-D-NAMES、AC06 (1)）: G0 の名前の表 10 本から、画面が区域名を引く reconstruction/src/display/screen/area-names.ts を作る。
// wire は Code だけを運び、ブラウザへ名前の表を届ける経路は /display/<名前>.js だけなので、表を module の字にする。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(here, "../../assets/gis");
const outPath = join(here, "../../src/display/screen/area-names.ts");

// 出力の表の順（AC06 (1)）。最初の 9 つは manifest の layers の鍵、最後は津波予報区の結合表現
const LAYERS = ["pref", "forecastLocalE", "city", "tsunamiArea", "weatherPrefecture", "weatherPrimary", "weatherGroup", "weatherCity", "floodCity"];
const ORDER = [...LAYERS, "tsunamiAreaGroup"];

const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// 表の中は Code の字の順。localeCompare は環境で順が変わるので、字のまま比べる
function entries(name, rows) {
  if (!Array.isArray(rows)) throw new Error(`名前の表 ${name} が配列でない`);
  const seen = new Set();
  const list = rows.map((row) => {
    const code = row?.code, value = row?.name;
    if (typeof code !== "string" || typeof value !== "string") throw new Error(`${name} の行の code か name が字でない: ${JSON.stringify(row)}`);
    if (value === "") throw new Error(`${name} ${code} の名前が空`);
    // 表をまたぐ同じ Code は正しい入力（細分区域と津波予報区など）。重なりを止めるのは同じ表の中だけ
    if (seen.has(code)) throw new Error(`${name} の中で Code ${code} が重なる`);
    seen.add(code);
    return [code, value];
  });
  return list.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function buildAreaNames() {
  const read = (name) => JSON.parse(readFileSync(join(assetsDir, name), "utf8"));
  const known = read("known-codes.v1.json"), area = read("area-codes.v1.json"), manifest = read("manifest.json");
  // 名前の表の鍵（pref は area-codes の prefecture）と manifest の layers の鍵 9 つが同じ組であることを確かめる
  const nameKeys = [...Object.keys(known), ...Object.keys(area)].filter((key) => key !== "schemaVersion" && key !== "tsunamiAreaGroup")
    .map((key) => (key === "prefecture" ? "pref" : key));
  if (!sameSet(Object.keys(manifest.layers ?? {}), LAYERS) || !sameSet(nameKeys, LAYERS) || !("tsunamiAreaGroup" in known))
    throw new Error(`manifest の layers ${JSON.stringify(Object.keys(manifest.layers ?? {}))} と名前の表 ${JSON.stringify(nameKeys)} の組が合わない`);
  const source = { ...known, ...area, pref: area.prefecture };
  const tables = ORDER.map((name) => `  ${name}: {${entries(name, source[name]).map(([code, value]) => `${JSON.stringify(code)}:${JSON.stringify(value)}`).join(",")}},`);
  return [
    "// 生成物（P4-SHELL-TYPES-001 AC06）。手で直さない。node reconstruction/tools/gis/build-area-names.mjs で G0 の名前の表から作り直す。",
    'import type { ShellAreaLayer } from "../../../contracts/p4-shell-types.types";',
    "",
    'const TABLES: Readonly<Record<ShellAreaLayer | "tsunamiAreaGroup", Readonly<Record<string, string>>>> = {',
    ...tables,
    "};",
    "",
    "// 引くのは指定の表の own key だけ。表に無いコードと継承したキーは null で、別の表を自動に引き直さない（AC06 (2)）",
    'function areaName(table: ShellAreaLayer | "tsunamiAreaGroup", code: string): string | null {',
    "  const names = TABLES[table];",
    "  return Object.hasOwn(names, code) ? names[code] : null;",
    "}",
    "",
    "export { areaName };",
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = buildAreaNames();
  writeFileSync(outPath, out);
  console.log(createHash("sha256").update(out).digest("hex"), Buffer.byteLength(out));
}

export { buildAreaNames };
