// G0 発注 1（P4-GIS-ASSETS-001 AC01〜AC02）: 地震火山関連コード表の xlsx から既知コードの表 known-codes.v1.json を作る。
// xlsx は zip の中の XML。依存を足さないため（P4-GIS-I-XLSX-NODEP）zip と sharedStrings・sheet の読みはこの file に閉じる。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(here, "../../assets/gis");

// zip の central directory から名前→中身を引く。xlsx は deflate（8）か無圧縮（0）だけ。
export function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("zip の end of central directory が無い");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip の central directory が壊れている");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + size);
    if (method !== 0 && method !== 8) throw new Error(`zip の圧縮方式 ${method} は読めない: ${name}`);
    files.set(name, method === 0 ? raw : inflateRawSync(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// & は最後に戻す（&amp;lt; を < にしない）
const decode = (s) =>
  s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// ふりがな（rPh）を落としてから <t> を連結する。落とさないと「一覧イチラン」のように読みが付く
export const siText = (si) =>
  decode([...si.replace(/<rPh\b.*?<\/rPh>/gs, "").matchAll(/<t\b[^>]*?(?:\/>|>(.*?)<\/t>)/gs)].map((m) => m[1] ?? "").join(""));

// sheet の XML → 値のある cell だけの行（{列: 字}）の並び。値のある cell が無い行は飛ばす
function sheetRows(xml, shared) {
  const rows = [];
  for (const r of xml.matchAll(/<row\b[^>]*?(?:\/>|>(.*?)<\/row>)/gs)) {
    const row = {};
    for (const c of (r[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
      if (c[2] == null) continue;
      const col = /\br="([A-Z]+)\d+"/.exec(c[1])?.[1];
      const t = /\bt="([^"]*)"/.exec(c[1])?.[1];
      const v = /<v>(.*?)<\/v>/s.exec(c[2])?.[1];
      let text;
      if (t === "inlineStr") text = siText(c[2]);
      else if (v == null) continue;
      else text = t === "s" ? shared[Number(v)] : decode(v);
      if (col == null || text == null || text === "") continue;
      row[col] = text;
    }
    if (Object.keys(row).length > 0) rows.push(row);
  }
  return rows;
}

// sheet 名は trim して引く（「82 」のように末尾に空白の入る名前がある）。A 列が headerA の見出しの行より後がデータ
// headerA は気象の区域コードの表の「@code」などのため（P4-GIS-I-AREA-CODE-HEADER）
export function sheetData(files, shared, sheetName, headers, headerA = "Code") {
  const wb = files.get("xl/workbook.xml")?.toString("utf8");
  const rels = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8");
  if (wb == null || rels == null) throw new Error("workbook.xml が無い");
  const sheet = [...wb.matchAll(/<sheet\b([^>]*?)\/>/g)].find((m) => decode(/\bname="([^"]*)"/.exec(m[1])?.[1] ?? "").trim() === sheetName);
  if (sheet == null) throw new Error(`sheet ${sheetName} が無い`);
  const rid = /\br:id="([^"]*)"/.exec(sheet[1])?.[1];
  const rel = [...rels.matchAll(/<Relationship\b([^>]*?)\/>/g)].find((m) => new RegExp(`\\bId="${rid}"`).test(m[1]));
  const target = /\bTarget="([^"]*)"/.exec(rel?.[1] ?? "")?.[1];
  const xml = files.get(`xl/${target}`)?.toString("utf8");
  if (xml == null) throw new Error(`sheet ${sheetName} の本体 ${target} が無い`);
  const rows = sheetRows(xml, shared);
  const h = rows.findIndex((r) => r.A === headerA);
  if (h < 0) throw new Error(`sheet ${sheetName} に ${headerA} の見出しが無い`);
  for (const [col, want] of Object.entries(headers)) {
    if (rows[h][col] !== want) throw new Error(`sheet ${sheetName} の ${col} 列の見出しが ${want} でない: ${rows[h][col]}`);
  }
  return rows.slice(h + 1);
}

// コードをキーに集める。同じコードが違う値を持てば止める（黙って後勝ちにしない）
function collect(label, entries) {
  const m = new Map();
  for (const [code, value] of entries) {
    const prev = m.get(code);
    if (prev !== undefined && JSON.stringify(prev) !== JSON.stringify(value)) {
      throw new Error(`${label} ${code} が違う値を持つ: ${JSON.stringify(prev)} と ${JSON.stringify(value)}`);
    }
    m.set(code, value);
  }
  return [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

const need = (label, col, row, re) => {
  if (!re.test(row[col] ?? "")) throw new Error(`${label} のコード列 ${col} が形に合わない: ${JSON.stringify(row)}`);
  return row[col];
};

const expectedCounts = () => JSON.parse(readFileSync(join(assetsDir, "manifest.json"), "utf8")).knownCodes.expectedCodeCount;

export function buildKnownCodes(xlsx) {
  const files = unzip(xlsx);
  const ssXml = files.get("xl/sharedStrings.xml")?.toString("utf8");
  if (ssXml == null) throw new Error("sharedStrings.xml が無い");
  const shared = [...ssXml.matchAll(/<si\b[^>]*?(?:\/>|>(.*?)<\/si>)/gs)].map((m) => siText(m[1] ?? ""));

  // sheet 24: A〜B が細分区域、D〜E が市区町村等で A がその所属の細分区域
  const rows24 = sheetData(files, shared, "24", { B: "Name", D: "Code", E: "Name" });
  const forecastLocalE = collect("forecastLocalE", rows24.map((r) => [need("sheet 24", "A", r, /^\d{3}$/), r.B ?? ""]));
  const cityRows = collect("city", rows24.map((r) => [need("sheet 24", "D", r, /^\d{7}$/), { name: r.E ?? "", forecastLocalE: r.A }]));

  // sheet 31: 備考が「津波予報区」で始まれば予報区、「結合表現」「領域表現」で始まれば結合表現・領域表現
  const rows31 = sheetData(files, shared, "31", { B: "Name" });
  const area = [];
  const group = [];
  for (const r of rows31) {
    const code = need("sheet 31", "A", r, /^\d{3}$/);
    const remark = r.D ?? "";
    if (remark.startsWith("津波予報区")) area.push([code, r.B ?? ""]);
    else if (remark.startsWith("結合表現") || remark.startsWith("領域表現")) {
      const members = /（構成する津波予報区([\d,]+)）/.exec(remark)?.[1].split(",");
      if (members == null || members.some((m) => !/^\d{3}$/.test(m))) throw new Error(`sheet 31 ${code} の備考から members を取れない: ${remark}`);
      group.push([code, { name: r.B ?? "", members }]);
    } else throw new Error(`sheet 31 ${code} の備考がどれにも当たらない: ${JSON.stringify(remark)}`);
  }
  const tsunamiArea = collect("tsunamiArea", area);
  const tsunamiAreaGroup = collect("tsunamiAreaGroup", group);
  // 名前の無いコードは止める（sharedStrings の添字が範囲外で cell が落ちた場合も、ここで空の名前になる）
  for (const [code, name] of [...forecastLocalE, ...cityRows.map(([c, v]) => [c, v.name]), ...tsunamiArea, ...tsunamiAreaGroup.map(([c, v]) => [c, v.name])]) {
    if (name === "") throw new Error(`名前が空のコード ${code}`);
  }
  const areaCodes = new Set(tsunamiArea.map(([c]) => c));
  for (const [code, g] of tsunamiAreaGroup) {
    for (const m of g.members) if (!areaCodes.has(m)) throw new Error(`tsunamiAreaGroup ${code} の members ${m} が tsunamiArea に無い`);
  }

  // 表の中の整合: city の所属が細分区域にあり、全細分区域に city が 1 つ以上ある
  const localCodes = new Set(forecastLocalE.map(([c]) => c));
  const used = new Set(cityRows.map(([, v]) => v.forecastLocalE));
  for (const u of used) if (!localCodes.has(u)) throw new Error(`city の所属 ${u} が forecastLocalE に無い`);
  for (const c of localCodes) if (!used.has(c)) throw new Error(`forecastLocalE ${c} に city が無い`);

  const table = {
    schemaVersion: 1,
    forecastLocalE: forecastLocalE.map(([code, name]) => ({ code, name })),
    city: cityRows.map(([code, v]) => ({ code, name: v.name, forecastLocalE: v.forecastLocalE })),
    tsunamiArea: tsunamiArea.map(([code, name]) => ({ code, name })),
    tsunamiAreaGroup: tsunamiAreaGroup.map(([code, v]) => ({ code, name: v.name, members: v.members })),
  };
  const want = expectedCounts();
  for (const k of Object.keys(want)) {
    if (table[k].length !== want[k]) throw new Error(`${k} の件数 ${table[k].length} が manifest の expectedCodeCount ${want[k]} と違う`);
  }
  return JSON.stringify(table) + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = buildKnownCodes(readFileSync(process.argv[2]));
  writeFileSync(join(assetsDir, "known-codes.v1.json"), out);
  console.log(createHash("sha256").update(out).digest("hex"));
}
