// G0 発注 2（P4-GIS-ASSETS-001 AC07 (7)）: 県・気象・洪水の区域コードの表 area-codes.v1.json を作る。
// xlsx の読みは発注 1 の build-known-codes.mjs を使う（同じ読みを 2 本持たない、P4-GIS-I-AREA-CODE-HEADER）。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { collect as collectEntries, need, workbook } from "./build-known-codes.mjs";

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "../../assets/gis");

// 発注 1 の collect（同じコードの違う値で止め、昇順に並べる）に、名前が空なら止める確かめを足して行の形にする
function collect(label, entries) {
  return collectEntries(label, entries).map(([code, v]) => {
    if (v.name === "" || v.name == null) throw new Error(`${label} ${code} の名前が空`);
    return { code, ...v };
  });
}

// 旗の列は 0 か 1 だけ（空や別の字を 0 と読まない）
const flag = (label, col, row) => {
  const v = row[col];
  if (v !== "0" && v !== "1") throw new Error(`${label} の旗の列 ${col} が 0 でも 1 でもない: ${JSON.stringify(row)}`);
  return v === "1";
};

function buildAreaCodes(quakeXlsxPath, weatherXlsxPath) {
  const quake = workbook(readFileSync(quakeXlsxPath));
  const weather = workbook(readFileSync(weatherXlsxPath));

  const prefecture = collect("prefecture", quake("23", { B: "Name" }).map((r) => [need("sheet 23", "A", r, /^\d{2}$/), { name: r.B ?? "" }]));

  // 関係表の 1 行 = まとめた地域等（A・B）→ 一次細分区域等（C・D）→ 府県予報区等（E・F）
  const code = "コード\r\n(@code)";
  const name = "名称\r\n(@name)";
  const rel = weather("AreaForecastLocalM（関係表　警報・注意報", { B: name, C: code, D: name, E: code, F: name }, code);
  const label = "関係表";
  const weatherPrefecture = collect("weatherPrefecture", rel.map((r) => [need(label, "E", r, /^\d{6}$/), { name: r.F ?? "" }]));
  const weatherPrimary = collect("weatherPrimary", rel.map((r) => [need(label, "C", r, /^\d{6}$/), { name: r.D ?? "", prefecture: r.E }]));
  const weatherGroup = collect("weatherGroup", rel.map((r) => [need(label, "A", r, /^\d{6}$/), { name: r.B ?? "", primary: r.C }]));

  const city = weather("AreaInformationCity", {
    C: "@name",
    E: "属する「市町村等をまとめた地域等」\r\n(AreaForecastLocalMの@code値)",
    F: "\"気象警報・注意報\"及び\r\n\"気象特別警報報知\"で使用",
    K: "\"指定河川洪水予報\"で使用",
  }, "@code");
  const cityLabel = "AreaInformationCity";
  for (const r of city) need(cityLabel, "A", r, /^\d{7}$/);
  const weatherCity = collect("weatherCity", city.filter((r) => flag(cityLabel, "F", r)).map((r) => [r.A, { name: r.C ?? "", group: r.E ?? "" }]));
  const floodCity = collect("floodCity", city.filter((r) => flag(cityLabel, "K", r)).map((r) => [r.A, { name: r.C ?? "" }]));

  // 所属の指す先が表にあること（空も止める）
  const has = (rows) => new Set(rows.map((r) => r.code));
  const checks = [
    ["weatherPrimary.prefecture", weatherPrimary.map((r) => [r.code, r.prefecture]), has(weatherPrefecture)],
    ["weatherGroup.primary", weatherGroup.map((r) => [r.code, r.primary]), has(weatherPrimary)],
    ["weatherCity.group", weatherCity.map((r) => [r.code, r.group]), has(weatherGroup)],
  ];
  for (const [what, pairs, set] of checks) {
    for (const [c, to] of pairs) if (!set.has(to)) throw new Error(`${what} ${c} の所属 ${JSON.stringify(to)} が表に無い`);
  }

  const table = { schemaVersion: 1, prefecture, weatherPrefecture, weatherPrimary, weatherGroup, weatherCity, floodCity };
  const want = JSON.parse(readFileSync(join(assetsDir, "manifest.json"), "utf8")).areaCodes.expectedCodeCount;
  for (const k of Object.keys(want)) {
    if (table[k].length !== want[k]) throw new Error(`${k} の件数 ${table[k].length} が manifest の expectedCodeCount ${want[k]} と違う`);
  }
  return JSON.stringify(table) + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = buildAreaCodes(process.argv[2], process.argv[3]);
  writeFileSync(join(assetsDir, "area-codes.v1.json"), out);
  console.log(createHash("sha256").update(out).digest("hex"));
}
