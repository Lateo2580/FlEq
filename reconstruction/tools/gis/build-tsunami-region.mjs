// G0 発注 2（P4-GIS-ASSETS-001 AC11）: 気象庁の「津波予報区に対応する市町村対応表」の転記と照合表から、
// 市区町村（7 桁）→ 津波予報区の表 tsunami-region.v1.json を作る。PDF は読まない（転記は実装担当が 1 項目 1 行で書く）。
// 名前の部分一致・先頭一致で当てはめない。照合表の行だけを使う（P4-GIS-D-TSUNAMI-REGION=A、AC10）。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "../../assets/gis");
const sourceDir = join(assetsDir, "source/tsunami-shichouson");

// 見出しの行を確かめて、残りの行を列の数ごとに返す
function tsv(path, header) {
  const lines = readFileSync(path, "utf8").split("\n");
  if (lines.at(-1) !== "") throw new Error(`${path} の末尾に改行が無い`);
  lines.pop();
  if (lines[0] !== header.join("\t")) throw new Error(`${path} の見出しが ${header.join(" ")} でない: ${lines[0]}`);
  return lines.slice(1).map((line, i) => {
    const cols = line.split("\t");
    if (cols.length !== header.length || cols.some((c) => c === "")) throw new Error(`${path} の ${i + 2} 行目の列が足りない: ${line}`);
    return cols;
  });
}

function buildTsunamiRegion() {
  const known = JSON.parse(readFileSync(join(assetsDir, "known-codes.v1.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(assetsDir, "manifest.json"), "utf8"));
  const want = manifest.tsunamiRegion.expectedCodeCount;
  const transcription = tsv(join(sourceDir, "transcription.tsv"), ["津波予報区", "都道府県名", "市町村名"]);
  const match = tsv(join(sourceDir, "match.tsv"), ["都道府県名", "市町村名", "コード", "照合"]);
  if (transcription.length !== want.transcriptionItems) {
    throw new Error(`転記の項目 ${transcription.length} が manifest の ${want.transcriptionItems} と違う`);
  }

  const areaByName = new Map(known.tsunamiArea.map((a) => [a.name, a.code]));
  const names = new Set(transcription.map(([area]) => area));
  for (const n of names) if (!areaByName.has(n)) throw new Error(`転記の津波予報区 ${n} が既知の表に無い`);
  if (names.size !== areaByName.size) throw new Error(`転記の津波予報区 ${names.size} が既知の ${areaByName.size} と違う`);

  // 照合表: （都道府県名, 市町村名）→ 7 桁の並び、または除外の 1 行
  const cityName = new Map(known.city.map((c) => [c.code, c.name]));
  const byKey = new Map();
  const excludedRows = [];
  for (const [pref, name, code, how] of match) {
    if (code === "除外") excludedRows.push(`${pref}\t${name}`);
    else if (!cityName.has(code)) throw new Error(`照合表の ${pref} ${name} の ${code} が city に無い`);
    // 当てはめではなく、照合表に書いた「完全一致」の確かめ
    if (how === "完全一致" && cityName.get(code) !== name) throw new Error(`照合表の ${pref} ${name} は完全一致と書くが ${code} の名前は ${cityName.get(code)}`);
    const key = `${pref}\t${name}`;
    const list = byKey.get(key) ?? [];
    list.push(code);
    if (list.includes("除外") && list.length > 1) throw new Error(`照合表の ${pref} ${name} が除外とコードの両方を持つ`);
    if (new Set(list).size !== list.length) throw new Error(`照合表の ${pref} ${name} に同じコードが 2 行ある`);
    byKey.set(key, list);
  }

  const areasByCity = new Map();
  const used = new Set();
  for (const [area, pref, name] of transcription) {
    const key = `${pref}\t${name}`;
    const codes = byKey.get(key);
    if (codes == null) throw new Error(`転記の ${pref} ${name} が照合表に無い`);
    used.add(key);
    if (codes[0] === "除外") continue;
    for (const code of codes) {
      const set = areasByCity.get(code) ?? new Set();
      set.add(areaByName.get(area));
      areasByCity.set(code, set);
    }
  }
  for (const key of byKey.keys()) if (!used.has(key)) throw new Error(`照合表の行 ${key} が転記に無い`);
  const listed = manifest.tsunamiRegion.knownGapsAndExclusions.filter((e) => e.kind === "excludedRow").map((e) => `${e.prefecture}\t${e.name}`);
  if (JSON.stringify([...excludedRows].sort()) !== JSON.stringify([...listed].sort())) {
    throw new Error(`照合表の除外 ${JSON.stringify(excludedRows)} が manifest の excludedRow ${JSON.stringify(listed)} と違う`);
  }

  const sort = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const rows = [...areasByCity].sort(([a], [b]) => sort(a, b)).map(([city, set]) => ({ city, tsunamiAreas: [...set].sort(sort) }));
  for (const r of rows) if (r.tsunamiAreas.length > 2) throw new Error(`${r.city} の津波予報区が 3 つ以上: ${r.tsunamiAreas}`);
  if (rows.length !== want.rows) throw new Error(`表の行 ${rows.length} が manifest の ${want.rows} と違う`);
  return JSON.stringify({ schemaVersion: 1, rows }) + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = buildTsunamiRegion();
  writeFileSync(join(assetsDir, "tsunami-region.v1.json"), out);
  console.log(createHash("sha256").update(out).digest("hex"));
}
