// G0 発注 2（P4-GIS-ASSETS-001 AC06〜AC09）: 気象庁の GIS の zip 9 本から、層ごとの全体図用（overview）と zoom 用の形、
// 代表点と範囲、県の所属の表を作る。形は経緯度の GeoJSON のまま置き、投影は M0 の関数が当てる（P4-GIS-I-SHAPE-FORM=A）。
// manifest は書かない（読むだけ）。書いた file の sha256 と、manifest へ写す数を最後に JSON で標準出力に出す。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const assetsDir = join(repoRoot, "reconstruction/assets/gis");
const mapshaperDir = join(repoRoot, "node_modules/mapshaper");
const GEO_BOUNDS = [120, 20, 155, 46];
const REWIND_TOLERANCE = 1e-9; // P4-GIS-I-REWIND-TOLERANCE=A
const MIN_RATIO = { polygon: 0.5, polyline: 0.3 }; // AC07 (4)。線は間引くと海岸線が縮むので低い

const fail = (message) => {
  throw new Error(`[build-shapes] ${message}`);
};
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const round5 = (v) => Math.round(v * 1e5) / 1e5;
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// zip の中の名前だけを central directory から読む。UTF-8 の旗（bit 11）が無い entry の名前は cp932。
// build-known-codes.mjs の unzip は名前を UTF-8 として読み（cp932 の字が壊れる）、中身を全部展開するので、ここでは使わない
function zipEntryNames(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) fail("zip の end of central directory が無い");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) fail("zip の central directory が壊れている");
    const nameLen = buf.readUInt16LE(p + 28);
    const encoding = buf.readUInt16LE(p + 8) & 0x800 ? "utf-8" : "shift_jis";
    names.push(new TextDecoder(encoding, { fatal: true }).decode(buf.subarray(p + 46, p + 46 + nameLen)));
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return names;
}

// AC06 (2): sha256、.shp・.shx・.dbf が 1 つずつで名前が manifest の shapefileBaseName、.prj が無い
function checkArchive(id, source, archiveDir) {
  const buf = readFileSync(join(archiveDir, source.archive));
  const got = sha256(buf);
  if (got !== source.archiveSha256) fail(`${id}: ${source.archive} の sha256 ${got} が manifest と違う`);
  const files = zipEntryNames(buf).filter((n) => !n.endsWith("/"));
  const base = (n) => n.split("/").at(-1).replace(/\.[^.]*$/, "");
  for (const ext of [".shp", ".shx", ".dbf"]) {
    const hit = files.filter((n) => n.toLowerCase().endsWith(ext));
    if (hit.length !== 1) fail(`${id}: ${ext} が ${hit.length} 個`);
    if (base(hit[0]) !== source.shapefileBaseName) fail(`${id}: shapefile の名前 ${base(hit[0])} が ${source.shapefileBaseName} でない`);
  }
  if (files.some((n) => n.toLowerCase().endsWith(".prj"))) fail(`${id}: .prj がある（lock の archivePrjPolicy=absent）`);
}

// bin/mapshaper は stdout へ非同期に書いた直後に process.exit するので、macOS の pipe では 64 KiB で切れる。
// 同じ mapshaper.js を子の node の中で呼び、終わりを exitCode で返して stdout を流し切らせる（作業 file を書かない）
const RUNNER = `const m = require(${JSON.stringify(join(mapshaperDir, "mapshaper.js"))}); m.enableLogging(); m.runCommands(process.argv.slice(1), (e) => { if (e) process.exitCode = 1; });`;
function mapshaper(args) {
  const r = spawnSync(process.execPath, ["-e", RUNNER, ...args], { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.error != null || r.status !== 0) fail(`mapshaper ${args.join(" ")}\n${r.error ?? ""}\n${r.stderr}`);
  return { geojson: JSON.parse(r.stdout), log: r.stderr.split("\n").map((l) => l.trim()).filter((l) => l !== "") };
}

const DEPTH = { LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 };
const TYPES = { polygon: ["Polygon", "MultiPolygon"], polyline: ["LineString", "MultiLineString"] };
const positions = (g) => g.coordinates.flat(DEPTH[g.type] - 1);
// 線の部分（LineString は 1 つ、MultiLineString はその要素）
const lineParts = (g) => (g.type === "LineString" ? [g.coordinates] : g.coordinates);

// [西, 南, 東, 北]。頂点が多いので Math.min(...xs) の展開は使わない（引数の数の上限を超える）
function bbox(pos) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of pos) {
    if (x < b[0]) b[0] = x;
    if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x;
    if (y > b[3]) b[3] = y;
  }
  return b;
}

// 偶奇の規則で点が面の中にあるか（穴は輪を 2 回跨ぐので外）。AC07 (6)・AC09 (3) の内外の判定はこの 1 つ
function inside([x, y], geometries) {
  let odd = false;
  for (const g of geometries) {
    for (const ring of g.coordinates.flat(DEPTH[g.type] - 2)) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
      }
    }
  }
  return odd;
}

// 同じコードの地物のうち、key の面積が最大で点（xKey・yKey）が null でないものの点。findAnchorPoint は形がつぶれると null を返す（AC09 (2)）
function largestPoint(id, code, props, key, xKey, yKey) {
  const p = [...props].sort((a, b) => b[key] - a[key]).find((q) => q[xKey] != null && q[yKey] != null);
  if (p == null) fail(`${id}: ${code} の代表点が全部の地物で null`);
  return [p[xKey], p[yKey]];
}

const sameList = (label, got, want) => {
  const a = [...got].sort();
  const b = [...want].sort();
  if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${label}: build ${JSON.stringify(a)} と manifest ${JSON.stringify(b)} が違う`);
};

function writeOutput(rel, text, extra) {
  writeFileSync(join(repoRoot, rel), text);
  return { path: rel, sha256: sha256(text), bytes: Buffer.byteLength(text), ...extra };
}

// 1 層の 1 LOD。面積（線は長さ）を向きを直す前（a0）・-simplify の直前（src）・最後（out）で量り、地物の属性で運ぶ
function runLod(id, layer, lod, archiveDir, knownCodes) {
  const poly = layer.geometryType === "polygon";
  const args = layer.transform.args[lod];
  const at = args.indexOf("-simplify");
  if (at < 0) fail(`${id}: transform.args.${lod} に -simplify が無い`);
  const m = poly ? "this.area" : "this.length";
  const { geojson, log } = mapshaper([
    join(archiveDir, layer.source.archive), "encoding=utf8",
    "-each", `a0=${m}`,
    ...args.slice(0, at),
    "-each", poly ? `src=${m}, srcX=this.innerX, srcY=this.innerY` : `src=${m}`,
    ...args.slice(at),
    "-each", poly ? `out=${m}, outX=this.innerX, outY=this.innerY` : `out=${m}`,
    "-o", "-", "format=geojson", "precision=0.00001",
  ]);

  const field = layer.source.codeField;
  const kept = [];
  const excluded = [];
  const codes = new Set();
  for (const f of geojson.features) {
    const raw = f.properties?.[field];
    if (raw != null && typeof raw !== "string") fail(`${id} ${lod}: コードの欄 ${field} が字でない: ${JSON.stringify(raw)}`);
    const code = raw ?? "";
    if (code !== "") codes.add(code);
    if (knownCodes.has(code)) kept.push({ code, f });
    else excluded.push(`${code}\t${f.properties?.name ?? ""}`);
  }
  if (geojson.features.length !== layer.featureCount) fail(`${id} ${lod}: 地物 ${geojson.features.length} が manifest の featureCount ${layer.featureCount} と違う`);
  if (codes.size !== layer.distinctCodeCount) fail(`${id} ${lod}: コードの異なり ${codes.size} が manifest の distinctCodeCount ${layer.distinctCodeCount} と違う`);

  const listed = (kind) => layer.knownGapsAndExclusions.filter((e) => e.kind === kind);
  sameList(`${id} ${lod} の excludedFeature`, excluded, listed("excludedFeature").map((e) => `${e.sourceCode}\t${e.name}`));
  const keptCodes = new Set(kept.map((k) => k.code));
  sameList(`${id} ${lod} の gap`, [...knownCodes].filter((c) => !keptCodes.has(c)), listed("gap").map((e) => e.code));

  let vertexCount = 0;
  const sum = new Map(); // code -> [src, out]
  for (const { code, f } of kept) {
    const g = f.geometry;
    if (g == null || !TYPES[layer.geometryType].includes(g.type)) fail(`${id} ${lod}: ${code} の geometry が ${g?.type ?? "null"}`);
    const pos = positions(g);
    if (pos.length === 0) fail(`${id} ${lod}: ${code} の geometry が空`);
    for (const [x, y] of pos) {
      if (!(x >= GEO_BOUNDS[0] && x <= GEO_BOUNDS[2] && y >= GEO_BOUNDS[1] && y <= GEO_BOUNDS[3])) fail(`${id} ${lod}: ${code} の座標 ${x},${y} が範囲の外`);
    }
    vertexCount += pos.length;
    const s = sum.get(code) ?? [0, 0];
    sum.set(code, [s[0] + f.properties.src, s[1] + f.properties.out]);
  }
  const ratios = [...sum].map(([code, [src, out]]) => ({ code, ratio: out / src })).sort((a, b) => byCode(a.code, b.code));
  for (const r of ratios) if (!Number.isFinite(r.ratio)) fail(`${id} ${lod}: ${r.code} の比が数でない`);
  const below = ratios.filter((r) => r.ratio < MIN_RATIO[layer.geometryType]);
  sameList(`${id} ${lod} の reducedArea`, below.map((r) => r.code), listed("reducedArea").filter((e) => e.lod === lod).map((e) => e.code));
  const min = ratios.reduce((a, b) => (b.ratio < a.ratio ? b : a));

  kept.sort((a, b) => byCode(a.code, b.code)); // 同じコードの中は元の並び（sort は安定）
  const features = kept.map(({ code, f }) => ({ type: "Feature", properties: { code }, geometry: f.geometry }));
  const output = writeOutput(`reconstruction/assets/gis/shapes/${id}.${lod}.v1.json`, JSON.stringify({ type: "FeatureCollection", features }) + "\n", {
    codeCount: keptCodes.size,
    vertexCount,
  });
  const counts = new Map();
  for (const { code } of kept) counts.set(code, (counts.get(code) ?? 0) + 1);
  return {
    kept,
    keptCodes,
    output,
    log,
    below,
    areaRatioMin: { code: min.code, ratio: min.ratio },
    multiFeatureCodes: Object.fromEntries([...counts].filter(([, n]) => n > 1)),
    // P4-GIS-I-REWIND-TOLERANCE: 符号が変わるか相対差が 1e-9 を超えた地物（線は向きを直さないので空）
    rewound: kept.filter(({ f: { properties: p } }) => Math.sign(p.a0) !== Math.sign(p.src) || Math.abs(p.src - p.a0) / Math.abs(p.a0) > REWIND_TOLERANCE).map((k) => k.code),
  };
}

// AC07 (5): 間引く前の頂点に control point があるか
function checkControlPoints(id, layer, archiveDir) {
  const field = layer.source.codeField;
  const controls = layer.crsControlPoints;
  if (!Array.isArray(controls) || controls.length < 3) fail(`${id}: crsControlPoints が 3 つ無い`);
  const { geojson } = mapshaper([
    join(archiveDir, layer.source.archive), "encoding=utf8",
    "-filter", `${JSON.stringify(controls.map((c) => c.code))}.indexOf(${field}) > -1`,
    "-o", "-", "format=geojson",
  ]);
  for (const c of controls) {
    const pos = geojson.features.filter((f) => f.properties[field] === c.code && f.geometry != null).flatMap((f) => positions(f.geometry));
    const hit = pos.some(([x, y]) => Math.abs(x - c.coordinate[0]) <= c.tolerance && Math.abs(y - c.coordinate[1]) <= c.tolerance);
    if (!hit) fail(`${id}: control point ${c.code} ${c.coordinate} が間引く前の頂点に無い`);
  }
}

function buildLayer(id, layer, archiveDir, knownCodes, projection) {
  if (layer.expectedCodeCount !== knownCodes.size) fail(`${id}: 既知の集合 ${knownCodes.size} が manifest の expectedCodeCount ${layer.expectedCodeCount} と違う`);
  checkArchive(id, layer.source, archiveDir);
  checkControlPoints(id, layer, archiveDir);
  console.error(`[build-shapes] ${id} overview`);
  const overview = runLod(id, layer, "overview", archiveDir, knownCodes);
  console.error(`[build-shapes] ${id} zoom`);
  const zoom = runLod(id, layer, "zoom", archiveDir, knownCodes);
  sameList(`${id} の overview と zoom のコードの集合`, overview.keptCodes, zoom.keptCodes);

  // AC09 (2): 代表点と範囲は zoom から
  const byCodeZoom = Map.groupBy(zoom.kept, (k) => k.code);
  const multiPartLines = [];
  const anchors = [...byCodeZoom].sort(([a], [b]) => byCode(a, b)).map(([code, list]) => {
    let anchor;
    if (layer.geometryType === "polygon") {
      anchor = largestPoint(id, code, list.map((k) => k.f.properties), "out", "outX", "outY");
    } else {
      // 線は最長の部分の添字の中央の頂点
      const parts = list.flatMap((k) => lineParts(k.f.geometry));
      if (parts.length > 1) multiPartLines.push({ code, parts: parts.length });
      const len = (pts) => pts.slice(1).reduce((s, [x, y], i) => s + Math.hypot(x - pts[i][0], y - pts[i][1]), 0);
      const longest = parts.reduce((a, b) => (len(b) > len(a) ? b : a));
      anchor = longest[Math.floor(longest.length / 2)];
    }
    return { code, anchor: anchor.map(round5), bounds: bbox(list.flatMap((k) => positions(k.f.geometry))).map(round5) };
  });

  // AC09 (3): 面の代表点は overview の同じコードの形の中にも置く。外に出てよいのは manifest の anchorOutsideOverview だけ（P4-GIS-D-ANCHOR-OVERVIEW=A）
  if (layer.geometryType === "polygon") {
    const byCodeOverview = Map.groupBy(overview.kept, (k) => k.code);
    const outside = anchors.filter((a) => !inside(a.anchor, byCodeOverview.get(a.code).map((k) => k.f.geometry)));
    const allowed = layer.knownGapsAndExclusions.filter((e) => e.kind === "anchorOutsideOverview").map((e) => e.code);
    if (JSON.stringify(outside.map((a) => a.code).sort()) !== JSON.stringify([...allowed].sort())) {
      fail(`${id}: overview の形の外の代表点 ${JSON.stringify(outside)} が manifest の anchorOutsideOverview ${JSON.stringify(allowed)} と違う`);
    }
  }

  // AC09 (4): 離島の inset の判定の control point
  const anchorOf = new Map(anchors.map((a) => [a.code, a.anchor]));
  for (const { code, target } of layer.projectionTargetChecks) {
    const p = anchorOf.get(code);
    if (p == null) fail(`${id}: projectionTargetChecks の ${code} の代表点が無い`);
    const hit = projection.insets.find(({ geographicBounds: [w, s, e, n] }) => p[0] >= w && p[0] < e && p[1] >= s && p[1] < n)?.id ?? "main";
    if (hit !== target) fail(`${id}: ${code} の代表点 ${p} は ${hit} で、manifest の ${target} と違う`);
  }

  const anchorsOut = writeOutput(`reconstruction/assets/gis/shapes/${id}.anchors.v1.json`, JSON.stringify({ schemaVersion: 1, layer: id, anchors }) + "\n", {});
  return {
    zoomKept: zoom.kept,
    summary: {
      multiFeatureCodes: zoom.multiFeatureCodes,
      areaRatioMin: { overview: overview.areaRatioMin, zoom: zoom.areaRatioMin },
      reducedArea: { overview: overview.below, zoom: zoom.below },
      rewound: [...new Set(zoom.rewound)],
      multiPartLines,
      mapshaperLog: { overview: overview.log, zoom: zoom.log },
      outputs: { overview: overview.output, zoom: zoom.output, anchors: anchorsOut },
    },
  };
}

// AC07 (6): 向きを直した後・間引く前の区域の inner の点が、向きを直した後・間引く前の県の形のどれに入るか
function buildMembership(manifest, archiveDir, zoomKept, knownCityTable) {
  const pref = manifest.layers.pref;
  const prepare = pref.transform.args.zoom.slice(0, pref.transform.args.zoom.indexOf("-simplify"));
  const { geojson } = mapshaper([join(archiveDir, pref.source.archive), "encoding=utf8", ...prepare, "-o", "-", "format=geojson", "precision=0.0000001"]);
  const prefs = geojson.features.map((f) => ({ code: f.properties[pref.source.codeField], geometry: f.geometry, box: bbox(positions(f.geometry)) }));
  const locate = (id) =>
    [...Map.groupBy(zoomKept[id], (k) => k.code)].sort(([a], [b]) => byCode(a, b)).map(([code, list]) => {
      const p = largestPoint(id, code, list.map((k) => k.f.properties), "src", "srcX", "srcY");
      const hits = prefs.filter(({ box: [w, s, e, n], geometry }) => p[0] >= w && p[0] <= e && p[1] >= s && p[1] <= n && inside(p, [geometry]));
      if (hits.length !== 1) fail(`${id}: ${code} の点 ${p} が県 ${hits.length} 個に入る`);
      return { code, prefecture: hits[0].code };
    });
  const city = locate("city");
  const forecastLocalE = locate("forecastLocalE");
  for (const [label, rows] of [["city", city], ["forecastLocalE", forecastLocalE]]) {
    const used = new Set(rows.map((r) => r.prefecture));
    const empty = prefs.filter((p) => !used.has(p.code)).map((p) => p.code);
    if (empty.length > 0) fail(`${label} の入らない県 ${empty}`);
  }
  const localPref = new Map(forecastLocalE.map((r) => [r.code, r.prefecture]));
  const cityLocal = new Map(knownCityTable.map((c) => [c.code, c.forecastLocalE]));
  for (const r of city) {
    if (localPref.get(cityLocal.get(r.code)) !== r.prefecture) fail(`city ${r.code} の県 ${r.prefecture} が細分区域 ${cityLocal.get(r.code)} の県 ${localPref.get(cityLocal.get(r.code))} と違う`);
  }
  const output = writeOutput("reconstruction/assets/gis/area-membership.v1.json", JSON.stringify({ schemaVersion: 1, city, forecastLocalE }) + "\n", {});
  return { ...output, codeCount: { city: city.length, forecastLocalE: forecastLocalE.length } };
}

function buildShapes(archiveDir) {
  const version = readJson(join(mapshaperDir, "package.json")).version;
  if (version !== "0.7.49") fail(`mapshaper の版 ${version} が 0.7.49 でない（P4-GIS-I-DEP=A）`);
  const manifest = readJson(join(assetsDir, "manifest.json"));
  const known = readJson(join(assetsDir, "known-codes.v1.json"));
  const area = readJson(join(assetsDir, "area-codes.v1.json"));
  const tables = {
    pref: area.prefecture,
    forecastLocalE: known.forecastLocalE,
    city: known.city,
    tsunamiArea: known.tsunamiArea,
    weatherPrefecture: area.weatherPrefecture,
    weatherPrimary: area.weatherPrimary,
    weatherGroup: area.weatherGroup,
    weatherCity: area.weatherCity,
    floodCity: area.floodCity,
  };
  sameList("層", Object.keys(manifest.layers), Object.keys(tables));
  mkdirSync(join(assetsDir, "shapes"), { recursive: true });
  const layers = {};
  const zoomKept = {};
  for (const [id, layer] of Object.entries(manifest.layers)) {
    const r = buildLayer(id, layer, archiveDir, new Set(tables[id].map((t) => t.code)), manifest.projection);
    layers[id] = r.summary;
    if (id === "city" || id === "forecastLocalE") zoomKept[id] = r.zoomKept;
  }
  console.error("[build-shapes] membership");
  const membership = buildMembership(manifest, archiveDir, zoomKept, known.city);
  return { mapshaper: version, node: process.version, layers, membership };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] == null) fail("引数に archiveDir が要る");
  console.log(JSON.stringify(buildShapes(process.argv[2]), null, 2));
}
