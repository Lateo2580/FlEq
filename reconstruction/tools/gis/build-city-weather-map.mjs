// P4-GIS-CITY-MAP-001: 市区町村（地震津波関係 7 桁）→ 市町村等（気象警報等 7 桁）の対応表 city-weather-map.v1.json を作る。
// 同じコードの組は S1（AreaInformationCity）の同じ行で数え、残りは照合表 match.tsv の行だけを使う（P4-GCM-D-METHOD=A）。
// 名前の部分一致・コードの先頭一致・「のうち」の前後の割りで組を作らない（P4-GIS-AC10）。html は読まず、sha256 も見ない（P4-GCM-AC05）。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { collect, need, workbook } from "./build-known-codes.mjs";

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "../../assets/gis");
const sourceDir = join(assetsDir, "source/city-weather-map");

// 見出しの行を確かめて、残りの行を列の数ごとに返す（build-tsunami-region.mjs の tsv を写す。あちらは export を持たない）
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

// 組の集合を重複なしで比べ、違えば両方向の差を全部出して止める（P4-GCM-AC03 (3)・AC04 (5)）
function sameSet(what, leftLabel, left, rightLabel, right) {
  const dup = (keys) => keys.filter((k, i) => keys.indexOf(k) !== i);
  for (const [label, keys] of [[leftLabel, left], [rightLabel, right]]) {
    if (dup(keys).length > 0) throw new Error(`${what}: ${label} に同じ組が 2 行ある: ${JSON.stringify(dup(keys))}`);
  }
  const l = new Set(left);
  const r = new Set(right);
  const onlyLeft = left.filter((k) => !r.has(k));
  const onlyRight = right.filter((k) => !l.has(k));
  if (onlyLeft.length > 0 || onlyRight.length > 0) {
    throw new Error(`${what}: ${leftLabel} だけの組 ${JSON.stringify(onlyLeft)}、${rightLabel} だけの組 ${JSON.stringify(onlyRight)}`);
  }
}

// 相模原の 3 区（S1 の B 列「神奈川県相模原市のうち緑区」「…中央区」「…南区」）。cities と shapeCheck を一緒に差し替えても止まるように固定する（P4-GCM-AC04 (5)）
const sagamihara = ["1415100", "1415200", "1415300"];
const relations = new Set(["within", "part"]);
const bases = new Set(["コード表B列", "一覧表別表", "形"]);

function buildCityWeatherMap() {
  const known = JSON.parse(readFileSync(join(assetsDir, "known-codes.v1.json"), "utf8"));
  const area = JSON.parse(readFileSync(join(assetsDir, "area-codes.v1.json"), "utf8"));
  const entry = JSON.parse(readFileSync(join(assetsDir, "manifest.json"), "utf8")).cityWeatherMap;
  const want = entry.expectedCodeCount;

  // S1: 見出しの字は build-area-codes.mjs と同じ（P4-GCM-AC02）
  const sheet = workbook(readFileSync(join(assetsDir, "source/code-20261118/weather-area-codes.xlsx")));
  const s1 = sheet("AreaInformationCity", {
    B: "コードが示す地域等",
    C: "@name",
    F: "\"気象警報・注意報\"及び\r\n\"気象特別警報報知\"で使用",
    N: "@name",
  }, "@code");
  const label = "AreaInformationCity";
  const cell = new Map(collect(label, s1.map((r) => [need(label, "A", r, /^\d{7}$/), { b: (r.B ?? "").trim(), c: r.C ?? "", f: r.F, n: r.N ?? "" }])));
  for (const [code, v] of cell) if (v.f !== "0" && v.f !== "1") throw new Error(`${label} ${code} の F 列が 0 でも 1 でもない: ${JSON.stringify(v.f)}`);
  const quakeCodes = [...cell].filter(([, v]) => v.n !== "").map(([c]) => c);
  const weatherCodes = [...cell].filter(([, v]) => v.f === "1").map(([c]) => c);
  sameSet("S1 の N 列の行と known-codes の city", "S1", quakeCodes, "city", known.city.map((c) => c.code));
  sameSet("S1 の F=1 の行と area-codes の weatherCity", "S1", weatherCodes, "weatherCity", area.weatherCity.map((c) => c.code));
  const weatherSet = new Set(weatherCodes);
  const same = new Set(quakeCodes.filter((c) => weatherSet.has(c)));

  const transcription = tsv(join(sourceDir, "transcription.tsv"), ["名称", "区域"]);
  const expected = tsv(join(sourceDir, "expected-pairs.tsv"), ["地震コード", "気象コード", "関係", "根拠"]);
  const match = tsv(join(sourceDir, "match.tsv"), ["地震コード", "気象コード", "関係", "根拠", "地震の字", "気象の字"]);
  for (const [what, rows, n] of [["転記", transcription, want.transcriptionItems], ["期待の一覧", expected, want.expectedPairs], ["照合表", match, want.matchRows]]) {
    if (rows.length !== n) throw new Error(`${what}の行 ${rows.length} が manifest の ${n} と違う`);
  }
  const regionByName = new Map();
  for (const [name, region] of transcription) {
    if (regionByName.has(name)) throw new Error(`転記の名称 ${name} が 2 行ある`);
    regionByName.set(name, region);
  }

  // 照合表の行ごとに、コードの所属と字を原文（S1 のセルと転記）と照らす。組そのものは照合表に書いた字だけ（P4-GCM-AC03 (3)）
  const candidates = new Map();
  for (const [q, w, relation, basis, quakeText, weatherText] of match) {
    const at = `照合表の ${q} → ${w}`;
    if (!cell.has(q) || cell.get(q).n === "") throw new Error(`${at}: 地震コードが city に無い`);
    if (same.has(q)) throw new Error(`${at}: 地震コードが同じコードの行`);
    if (!weatherSet.has(w)) throw new Error(`${at}: 気象コードが weatherCity に無い`);
    if (same.has(w)) throw new Error(`${at}: 気象コードが同じコードの行`);
    if (!relations.has(relation)) throw new Error(`${at}: 関係 ${relation} は within・part のどれでもない`);
    if (!bases.has(basis)) throw new Error(`${at}: 根拠 ${basis} はコード表B列・一覧表別表・形のどれでもない`);
    if (quakeText !== cell.get(q).b) throw new Error(`${at}: 地震の字 ${quakeText} が S1 の B 列 ${cell.get(q).b} と違う`);
    const source = basis === "コード表B列" ? cell.get(w).b : regionByName.get(cell.get(w).c);
    if (source == null) throw new Error(`${at}: 気象の @name ${cell.get(w).c} が転記に無い`);
    if (weatherText !== source) throw new Error(`${at}: 気象の字 ${weatherText} が原文 ${source} と違う`);
    const list = candidates.get(q) ?? [];
    list.push({ code: w, relation });
    candidates.set(q, list);
  }
  for (const q of quakeCodes) if (!same.has(q) && !candidates.has(q)) throw new Error(`地震だけのコード ${q} が照合表に無い`);
  const key = (cols) => cols.slice(0, 4).join("\t");
  sameSet("照合表と期待の一覧", "照合表", match.map(key), "期待の一覧", expected.map(key));

  // 形で確かめた組（P4-GCM-AC04 (5)）: shapeCheck は根拠「形」の行と相模原の行の（地震, 気象, 根拠）にちょうど一致する
  const conflicts = entry.knownGapsAndExclusions.filter((e) => e.kind === "sourceConflict");
  if (conflicts.length !== 1) throw new Error(`manifest の sourceConflict が ${conflicts.length} 個（1 個のはず）`);
  sameSet("manifest の sourceConflict の cities と相模原の 3 区", "cities", conflicts[0].cities, "相模原", sagamihara);
  const shapeRows = match.filter(([q, , , basis]) => basis === "形" || sagamihara.includes(q)).map(([q, w, , basis]) => `${q}\t${w}\t${basis}`);
  const listed = entry.knownGapsAndExclusions.filter((e) => e.kind === "shapeCheck").map((e) => `${e.city}\t${e.weatherCity}\t${e.basis}`);
  sameSet("照合表の形で確かめた組と manifest の shapeCheck", "照合表", shapeRows, "shapeCheck", listed);

  const sort = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const rows = quakeCodes.map((city) => ({
    city,
    weatherCities: same.has(city) ? [{ code: city, relation: "same" }] : candidates.get(city).sort((a, b) => sort(a.code, b.code)),
  }));
  // 行の不変条件（P4-GCM-AC01 (3)）: same 1 つ・within 1 つ・part 2 つ以上のどれか
  for (const r of rows) {
    const kinds = new Set(r.weatherCities.map((c) => c.relation));
    const n = r.weatherCities.length;
    const ok = kinds.size === 1 && (kinds.has("part") ? n >= 2 : n === 1);
    if (!ok) throw new Error(`${r.city} の候補が不変条件に合わない: ${JSON.stringify(r.weatherCities)}`);
  }
  // 被覆（P4-GCM-AC01 (4)）: weatherCity の全コードがどれかの行の候補に出る
  const reached = new Set(rows.flatMap((r) => r.weatherCities.map((c) => c.code)));
  const unreached = weatherCodes.filter((c) => !reached.has(c));
  if (unreached.length > 0) throw new Error(`どの行の候補にも出ない weatherCity: ${JSON.stringify(unreached)}`);

  const count = (rel) => rows.filter((r) => r.weatherCities[0].relation === rel).length;
  const got = { rows: rows.length, same: count("same"), withinRows: count("within"), partRows: count("part") };
  for (const [k, n] of Object.entries(got)) if (n !== want[k]) throw new Error(`${k} ${n} が manifest の expectedCodeCount ${want[k]} と違う`);
  return JSON.stringify({ schemaVersion: 1, rows }) + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = buildCityWeatherMap();
  writeFileSync(join(assetsDir, "city-weather-map.v1.json"), out);
  console.log(createHash("sha256").update(out).digest("hex"));
}
