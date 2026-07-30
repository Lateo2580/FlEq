import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import AdmZip from "adm-zip";
import {
  geoConicConformal,
  geoIdentity,
  geoMercator,
  geoPath,
} from "d3-geo";

const scriptPath = fileURLToPath(import.meta.url);
const displayRoot = resolve(dirname(scriptPath), "..");
const repoRoot = resolve(displayRoot, "..");
const lockPath = join(displayRoot, "maps", "quake", "source.lock.json");
const projectionPath = join(displayRoot, "maps", "quake", "insets.v1.json");
const outputRoot = join(displayRoot, "frontend", "public", "maps", "quake");
const cacheRoot = join(displayRoot, "maps", ".cache");
const licensePath = join(repoRoot, "docs", "licenses", "jma-forecast-area-gis.md");
const mapshaperBin = join(displayRoot, "node_modules", "mapshaper", "bin", "mapshaper");
const OUTPUT_FILES = {
  AreaForecastLocalE: "area-forecast-local-e.v1.json",
  AreaInformationCity_quake: "area-information-city-quake.v1.json",
};
const MANIFEST_FILE = "manifest.json";
const NOTICE_FILE = "NOTICE.txt";
const GEO_BOUNDS = [120, 20, 155, 46];

function fail(message) {
  throw new Error(`[quake-map-assets] ${message}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function canonicalJson(value) {
  function stringify(current) {
    if (Array.isArray(current)) return `[${current.map(stringify).join(",")}]`;
    if (current != null && typeof current === "object") {
      return `{${Object.keys(current)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stringify(current[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(current);
  }
  return `${stringify(value)}\n`;
}

function validateConfig(lock, config) {
  if (lock.schemaVersion !== 1) fail("source.lock.json schemaVersion must be 1");
  if (lock.projection?.name !== "JGD2011" || lock.projection?.epsg !== 6668) {
    fail("source projection must be locked to JGD2011 / EPSG:6668");
  }
  if (lock.projection?.archivePrjPolicy !== "absent") {
    fail("archivePrjPolicy must explicitly match the supplied archives");
  }
  if (!Array.isArray(lock.inputs) || lock.inputs.length !== 2) fail("exactly two source inputs are required");
  if (config.schemaVersion !== 1 || typeof config.projectionInsetsVersion !== "string" || config.projectionInsetsVersion === "") {
    fail("invalid projection/inset config");
  }
  if (!Array.isArray(config.viewBox) || config.viewBox.length !== 4 || !config.viewBox.every(Number.isFinite)) {
    fail("viewBox must contain four finite numbers");
  }
  if (!Number.isInteger(config.pathDigits) || config.pathDigits < 0 || config.pathDigits > 6) {
    fail("pathDigits must be an integer from 0 to 6");
  }
  if (!Array.isArray(config.insets) || config.insets.length === 0) fail("at least one inset is required");
  for (let index = 0; index < config.insets.length; index += 1) {
    const inset = config.insets[index];
    if (typeof inset.id !== "string" || inset.id === "" || typeof inset.label !== "string" || inset.label === "") {
      fail(`invalid inset identity at index ${index}`);
    }
    for (const [field, length] of [["geographicBounds", 4], ["frame", 4], ["labelPosition", 2]]) {
      if (!Array.isArray(inset[field]) || inset[field].length !== length || !inset[field].every(Number.isFinite)) {
        fail(`invalid inset ${inset.id} ${field}`);
      }
    }
    if (inset.geographicBounds[0] >= inset.geographicBounds[2]
      || inset.geographicBounds[1] >= inset.geographicBounds[3]
      || inset.frame[2] <= 0
      || inset.frame[3] <= 0) {
      fail(`inset ${inset.id} must have positive geographic and display bounds`);
    }
    for (let otherIndex = index + 1; otherIndex < config.insets.length; otherIndex += 1) {
      const other = config.insets[otherIndex];
      const [a0, a1, a2, a3] = inset.geographicBounds;
      const [b0, b1, b2, b3] = other.geographicBounds;
      if (Math.max(a0, b0) < Math.min(a2, b2) && Math.max(a1, b1) < Math.min(a3, b3)) {
        fail(`inset geographic bounds overlap: ${inset.id} / ${other.id}`);
      }
    }
  }
  if (!Array.isArray(config.referencePoints)
    || config.referencePoints.length === 0
    || !config.referencePoints.every(
      (point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite),
    )) {
    fail("projection referencePoints are required");
  }
}

function validateArchive(input, lock) {
  const archivePath = join(displayRoot, "maps", "source", input.archive);
  if (!existsSync(archivePath)) fail(`missing source archive: ${input.archive}`);
  const actualHash = sha256File(archivePath);
  if (actualHash !== input.sha256) {
    fail(`SHA-256 mismatch for ${input.archive}: expected ${input.sha256}, got ${actualHash}`);
  }

  const zip = new AdmZip(archivePath);
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
  const shiftJisDecoder = new TextDecoder("shift_jis", { fatal: true });
  const decodedNames = entries.map((entry) => shiftJisDecoder.decode(entry.rawEntryName));
  const shapefileEntries = [];
  for (const extension of [".shp", ".shx", ".dbf"]) {
    const matches = decodedNames.filter((name) => name.toLowerCase().endsWith(extension));
    if (matches.length !== 1) fail(`${input.archive} must contain exactly one ${extension} entry`);
    shapefileEntries.push(matches[0].slice(0, -extension.length));
  }
  if (new Set(shapefileEntries).size !== 1) {
    fail(`${input.archive} .shp/.shx/.dbf entries do not share one basename`);
  }
  if (shapefileEntries[0] !== input.shapefileBaseName) {
    fail(`${input.archive} shapefile basename mismatch: expected ${input.shapefileBaseName}, got ${shapefileEntries[0]}`);
  }
  const prjEntries = decodedNames.filter((name) => name.toLowerCase().endsWith(".prj"));
  if (lock.projection.archivePrjPolicy === "absent" && prjEntries.length !== 0) {
    fail(`${input.archive} unexpectedly contains .prj; review the locked CRS before rebuilding`);
  }
  return archivePath;
}

function runMapshaper(input, archivePath, workRoot) {
  const outputPath = join(workRoot, `${input.dataset}.geojson`);
  const result = spawnSync(process.execPath, [
    mapshaperBin,
    archivePath,
    "-simplify", "0.1%", "keep-shapes",
    "-clean",
    "-filter-fields", `${input.codeField},name`,
    "-o", `format=geojson`, "precision=0.0000001", outputPath,
  ], {
    cwd: displayRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(`mapshaper failed for ${input.dataset}\n${result.stdout}\n${result.stderr}`);
  }
  if (!existsSync(outputPath)) fail(`mapshaper did not create ${outputPath}`);
  return readJson(outputPath);
}

function createProjection(spec) {
  if (spec.type === "conicConformal") {
    return geoConicConformal()
      .parallels(spec.parallels)
      .rotate(spec.rotate)
      .center(spec.center)
      .scale(spec.scale)
      .translate(spec.translate);
  }
  if (spec.type === "mercator") {
    return geoMercator()
      .center(spec.center)
      .scale(spec.scale)
      .translate(spec.translate);
  }
  fail(`unsupported projection type: ${spec.type}`);
}

function pointInBounds([longitude, latitude], [minLongitude, minLatitude, maxLongitude, maxLatitude]) {
  return longitude >= minLongitude
    && longitude < maxLongitude
    && latitude >= minLatitude
    && latitude < maxLatitude;
}

function validateSourcePoint(point) {
  if (!Array.isArray(point) || point.length < 2 || !point.slice(0, 2).every(Number.isFinite)) {
    fail(`invalid source coordinate: ${JSON.stringify(point)}`);
  }
  if (!pointInBounds(point, GEO_BOUNDS)) {
    fail(`source coordinate is outside locked JGD2011 geographic bounds: ${JSON.stringify(point)}`);
  }
}

function createReferenceProjectPoint(config, usage) {
  const main = createProjection(config.mainProjection);
  const insets = config.insets.map((inset) => ({
    ...inset,
    project: createProjection(inset.projection),
  }));
  return (point) => {
    validateSourcePoint(point);
    const inset = insets.find((candidate) => pointInBounds(point, candidate.geographicBounds));
    const key = inset?.id ?? "main";
    usage.set(key, (usage.get(key) ?? 0) + 1);
    const projected = (inset?.project ?? main)(point);
    if (projected == null || !projected.every(Number.isFinite)) {
      fail(`projection failed for ${JSON.stringify(point)}`);
    }
    if (inset != null) {
      const [x, y, width, height] = inset.frame;
      if (projected[0] < x || projected[0] > x + width || projected[1] < y || projected[1] > y + height) {
        fail(`${inset.id} point projects outside its frame: ${JSON.stringify(point)} -> ${JSON.stringify(projected)}`);
      }
    }
    return projected;
  };
}

function projectionReferencePoints(config) {
  const projectA = createReferenceProjectPoint(config, new Map());
  const projectB = createReferenceProjectPoint(config, new Map());
  const [viewX, viewY, viewWidth, viewHeight] = config.viewBox;
  return config.referencePoints.map((source) => {
    const first = projectA(source).map((value) => Number(value.toFixed(config.pathDigits)));
    const second = projectB(source).map((value) => Number(value.toFixed(config.pathDigits)));
    if (first.join(",") !== second.join(",")) fail(`projection is not deterministic for ${JSON.stringify(source)}`);
    if (first[0] < viewX || first[0] > viewX + viewWidth || first[1] < viewY || first[1] > viewY + viewHeight) {
      fail(`projection reference point is outside viewBox: ${JSON.stringify(source)} -> ${JSON.stringify(first)}`);
    }
    return { source, projected: first };
  });
}

function geometryPoints(geometry) {
  const points = [];
  function visit(value) {
    if (!Array.isArray(value)) fail(`invalid geometry coordinates: ${JSON.stringify(value)}`);
    if (value.length >= 2 && value.slice(0, 2).every(Number.isFinite)) {
      points.push(value);
      return;
    }
    for (const child of value) visit(child);
  }
  visit(geometry.coordinates);
  if (points.length === 0) fail("geometry contains no coordinates");
  return points;
}

function projectionTargetForGeometry(geometry, config) {
  const points = geometryPoints(geometry);
  const longitudes = points.map((point) => point[0]);
  const latitudes = points.map((point) => point[1]);
  const center = [
    (Math.min(...longitudes) + Math.max(...longitudes)) / 2,
    (Math.min(...latitudes) + Math.max(...latitudes)) / 2,
  ];
  return config.insets.find((inset) => pointInBounds(center, inset.geographicBounds))?.id ?? "main";
}

function createFixedProjectPoint(config, targetId, usage) {
  const inset = config.insets.find((candidate) => candidate.id === targetId);
  if (targetId !== "main" && inset == null) fail(`unknown projection target: ${targetId}`);
  const project = createProjection(inset?.projection ?? config.mainProjection);
  return (point) => {
    validateSourcePoint(point);
    usage.set(targetId, (usage.get(targetId) ?? 0) + 1);
    const projected = project(point);
    if (projected == null || !projected.every(Number.isFinite)) {
      fail(`projection failed for ${JSON.stringify(point)}`);
    }
    if (inset != null) {
      const [x, y, width, height] = inset.frame;
      if (projected[0] < x || projected[0] > x + width || projected[1] < y || projected[1] > y + height) {
        fail(`${inset.id} point projects outside its frame: ${JSON.stringify(point)} -> ${JSON.stringify(projected)}`);
      }
    }
    return projected;
  };
}

function projectGeometry(geometry, projectPoint) {
  if (geometry == null) fail("feature geometry is null");
  if (geometry.type === "Polygon") {
    return {
      type: "Polygon",
      coordinates: geometry.coordinates.map((ring) => ring.map(projectPoint)),
    };
  }
  if (geometry.type === "MultiPolygon") {
    return {
      type: "MultiPolygon",
      coordinates: geometry.coordinates.map(
        (polygon) => polygon.map((ring) => ring.map(projectPoint)),
      ),
    };
  }
  fail(`unsupported geometry type: ${geometry.type}`);
}

function validateCrsControlPoints(input, geoJson) {
  const controls = input.crsControlPoints;
  if (!Array.isArray(controls) || controls.length < 3) {
    fail(`${input.dataset} must lock at least three CRS control points`);
  }
  for (const control of controls) {
    const feature = geoJson.features.find(
      (candidate) => candidate.properties?.[input.codeField] === control.code,
    );
    if (feature == null) fail(`${input.dataset} CRS control code is missing: ${control.code}`);
    const matched = geometryPoints(feature.geometry).some(
      ([longitude, latitude]) => Math.abs(longitude - control.coordinate[0]) <= control.tolerance
        && Math.abs(latitude - control.coordinate[1]) <= control.tolerance,
    );
    if (!matched) {
      fail(`${input.dataset} CRS control point mismatch for ${control.code}; input datum/version may differ`);
    }
  }
}

function validateGeoJson(input, geoJson) {
  if (geoJson?.type !== "FeatureCollection" || !Array.isArray(geoJson.features) || geoJson.features.length === 0) {
    fail(`${input.dataset} did not produce a non-empty FeatureCollection`);
  }
  const codePattern = new RegExp(input.codePattern);
  const allowedEmptyNames = new Set(input.emptyCodeFeatureAllowlist?.names ?? []);
  const foundEmptyNames = new Set();
  const codedFeatures = [];
  for (const [index, feature] of geoJson.features.entries()) {
    const properties = feature?.properties;
    if (properties == null || !Object.hasOwn(properties, input.codeField) || !Object.hasOwn(properties, "name")) {
      fail(`${input.dataset} feature ${index} is missing ${input.codeField} or name`);
    }
    const code = properties[input.codeField];
    if (code === "") {
      if (typeof properties.name !== "string" || !allowedEmptyNames.has(properties.name)) {
        fail(`${input.dataset} has an unreviewed empty-code feature: ${JSON.stringify(properties.name)}`);
      }
      foundEmptyNames.add(properties.name);
      continue;
    }
    if (typeof code !== "string" || !codePattern.test(code)) {
      fail(`${input.dataset} feature ${index} has invalid string code: ${JSON.stringify(code)}`);
    }
    codedFeatures.push(feature);
  }
  const missingAllowedNames = [...allowedEmptyNames].filter((name) => !foundEmptyNames.has(name));
  if (missingAllowedNames.length > 0) {
    fail(`${input.dataset} empty-code allowlist entries were not found: ${missingAllowedNames.join(", ")}`);
  }
  validateCrsControlPoints(input, geoJson);
  return {
    geoJson: { ...geoJson, features: codedFeatures },
    excludedEmptyCodeFeatureCount: foundEmptyNames.size,
  };
}

function pathNumbers(path) {
  return [...path.matchAll(/-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi)].map((match) => Number(match[0]));
}

function validateProjectedAsset(asset, input, manifestStats) {
  if (asset.schemaVersion !== 1 || asset.projectionInsetsVersion === "") fail(`${input.dataset} has invalid schema metadata`);
  const codes = Object.keys(asset.pathsByCode);
  if (codes.length !== manifestStats.codeCount || new Set(codes).size !== codes.length) {
    fail(`${input.dataset} code count mismatch`);
  }
  const [viewX, viewY, viewWidth, viewHeight] = asset.viewBox;
  for (const code of codes) {
    const path = asset.pathsByCode[code];
    if (typeof path !== "string" || path === "") fail(`${input.dataset}/${code} has an empty path`);
    if (/NaN|Infinity/.test(path)) fail(`${input.dataset}/${code} contains a non-finite path value`);
    const numbers = pathNumbers(path);
    if (numbers.length === 0 || numbers.length % 2 !== 0 || !numbers.every(Number.isFinite)) {
      fail(`${input.dataset}/${code} has an invalid SVG path`);
    }
    for (let index = 0; index < numbers.length; index += 2) {
      const x = numbers[index];
      const y = numbers[index + 1];
      if (x < viewX || x > viewX + viewWidth || y < viewY || y > viewY + viewHeight) {
        fail(`${input.dataset}/${code} projects outside viewBox at ${x},${y}`);
      }
    }
  }
  for (const inset of asset.insets) {
    const [x, y, width, height] = inset.frame;
    const [labelX, labelY] = inset.labelPosition;
    if (x < viewX || y < viewY || x + width > viewX + viewWidth || y + height > viewY + viewHeight) {
      fail(`${input.dataset}/${inset.id} frame is outside viewBox`);
    }
    if (labelX < x || labelX > x + width || labelY < y || labelY > y + height) {
      fail(`${input.dataset}/${inset.id} label is outside its frame`);
    }
  }
}

function buildAsset(input, geoJson, config) {
  const validated = validateGeoJson(input, geoJson);
  geoJson = validated.geoJson;
  const usage = new Map([["main", 0], ...config.insets.map((inset) => [inset.id, 0])]);
  const byCode = new Map();
  const projectionTargets = new Map();
  for (const feature of geoJson.features) {
    const code = feature.properties[input.codeField];
    const targetId = projectionTargetForGeometry(feature.geometry, config);
    const existingTarget = projectionTargets.get(code);
    if (existingTarget != null && existingTarget !== targetId) {
      fail(`${input.dataset}/${code} spans multiple feature projection targets`);
    }
    projectionTargets.set(code, targetId);
    const projectedFeature = {
      type: "Feature",
      properties: null,
      geometry: projectGeometry(feature.geometry, createFixedProjectPoint(config, targetId, usage)),
    };
    const group = byCode.get(code) ?? [];
    group.push(projectedFeature);
    byCode.set(code, group);
  }
  for (const inset of config.insets) {
    if ((usage.get(inset.id) ?? 0) === 0) fail(`${input.dataset} has no projected points in inset ${inset.id}`);
  }

  const generator = geoPath(geoIdentity()).digits(config.pathDigits);
  const pathsByCode = {};
  for (const code of [...byCode.keys()].sort()) {
    const path = generator({ type: "FeatureCollection", features: byCode.get(code) });
    if (path == null || path === "") fail(`${input.dataset}/${code} generated an empty path`);
    pathsByCode[code] = path;
  }
  const asset = {
    schemaVersion: 1,
    projectionInsetsVersion: config.projectionInsetsVersion,
    dataset: input.dataset,
    codeType: input.codeField,
    viewBox: config.viewBox,
    pathsByCode,
    insets: config.insets.map(({ id, label, frame, labelPosition }) => ({
      id,
      label,
      frame,
      labelPosition,
    })),
  };
  const stats = {
    featureCount: geoJson.features.length,
    codeCount: Object.keys(pathsByCode).length,
    excludedEmptyCodeFeatureCount: validated.excludedEmptyCodeFeatureCount,
    insetPointCounts: Object.fromEntries([...usage.entries()].filter(([key]) => key !== "main")),
    projectionTargets,
  };
  if (stats.codeCount !== input.expectedCodeCount) {
    fail(`${input.dataset} code count changed: expected ${input.expectedCodeCount}, got ${stats.codeCount}`);
  }
  for (const check of input.projectionTargetChecks ?? []) {
    const actual = projectionTargets.get(check.code);
    if (actual !== check.target) {
      fail(`${input.dataset}/${check.code} projection target changed: expected ${check.target}, got ${actual ?? "missing"}`);
    }
  }
  validateProjectedAsset(asset, input, stats);
  return { asset, stats };
}

function noticeText(lock, config) {
  return `# 気象庁「予報区等 GIS データ」加工物

出典: 気象庁「予報区等 GIS データ」を加工して作成

- 取得元: ${lock.sourcePageUrl}
- 取得日: ${lock.retrievedAt}
- 利用条件: 気象庁ホームページ利用規約（政府標準利用規約に準拠） https://www.jma.go.jp/jma/kishou/info/coment.html
- 対象: AreaForecastLocalE / AreaInformationCity_quake
- 加工: mapshaper 0.7.49 simplify 0.1% + keep-shapes + clean（nameは空code allowlist検証時だけ保持し、生成物はcode別pathのみ）、d3-geo 3.1.1固定投影、沖縄・先島・小笠原等のbuild-time inset、コード別SVG path集約
- 座標系: JGD2011 (EPSG:6668)
- projectionInsetsVersion: ${config.projectionInsetsVersion}

入力archiveには .prj が含まれないため、buildはlockされたJGD2011宣言、archive構成、属性型、経緯度boundsを検証する。

上流配布物が消失し、同一SHA-256のarchiveを正規配布元から再取得できない場合、コミット済みJSONを表示・配布上の真実源とする。
`;
}

function buildOutputs(lock, config, workRoot) {
  const assetOutputs = [];
  for (const input of lock.inputs) {
    const archivePath = validateArchive(input, lock);
    const geoJson = runMapshaper(input, archivePath, workRoot);
    const { asset, stats } = buildAsset(input, geoJson, config);
    const bytes = Buffer.from(canonicalJson(asset));
    if (bytes.length > input.sizeBudgetBytes) {
      fail(`${input.dataset} exceeds size budget: ${bytes.length} > ${input.sizeBudgetBytes}`);
    }
    assetOutputs.push({
      input,
      file: OUTPUT_FILES[input.dataset],
      bytes,
      sha256: sha256Bytes(bytes),
      ...stats,
    });
  }

  const manifest = {
    schemaVersion: 1,
    projectionInsetsVersion: config.projectionInsetsVersion,
    projectionReferencePoints: projectionReferencePoints(config),
    generator: {
      mapshaperVersion: "0.7.49",
      d3GeoVersion: "3.1.1",
      simplify: "0.1%",
      keepShapes: true,
      clean: true,
      geoJsonCoordinatePrecision: 7,
      pathDigits: config.pathDigits,
      normalizedJson: true,
    },
    sourceArchives: lock.inputs.map((input) => ({
      dataset: input.dataset,
      url: input.url,
      retrievedAt: lock.retrievedAt,
      sha256: input.sha256,
      archived: false,
      archivePrj: lock.projection.archivePrjPolicy,
      crs: `${lock.projection.name} (EPSG:${lock.projection.epsg})`,
    })),
    assets: assetOutputs.map((output) => ({
      dataset: output.input.dataset,
      file: output.file,
      sha256: output.sha256,
      bytes: output.bytes.length,
      featureCount: output.featureCount,
      codeCount: output.codeCount,
      excludedEmptyCodeFeatureCount: output.excludedEmptyCodeFeatureCount,
      insetPointCounts: output.insetPointCounts,
      sizeBudgetBytes: output.input.sizeBudgetBytes,
    })),
    upstreamLossPolicy: "If the upstream archive disappears and no official source provides the identical SHA-256, the committed generated JSON is the display and distribution source of truth.",
  };
  return [
    ...assetOutputs.map((output) => ({ file: output.file, bytes: output.bytes })),
    { file: MANIFEST_FILE, bytes: Buffer.from(canonicalJson(manifest)) },
    { file: NOTICE_FILE, bytes: Buffer.from(noticeText(lock, config)) },
  ];
}

function writeOutputs(outputs) {
  mkdirSync(outputRoot, { recursive: true });
  for (const output of outputs) writeFileSync(join(outputRoot, output.file), output.bytes);
}

function checkOutputs(outputs) {
  for (const output of outputs) {
    const path = join(outputRoot, output.file);
    if (!existsSync(path)) fail(`generated output is missing: ${output.file}`);
    const actual = readFileSync(path);
    if (!actual.equals(output.bytes)) {
      fail(`${output.file} is stale or non-deterministic; run npm run maps:quake:build`);
    }
  }
  if (!existsSync(licensePath)) fail("docs/licenses/jma-forecast-area-gis.md is missing");
}

async function main() {
  const mode = process.argv[2];
  if ((mode !== "--write" && mode !== "--check") || process.argv.length !== 3) {
    fail("usage: node scripts/build-quake-map-assets.mjs --write|--check");
  }
  const lock = readJson(lockPath);
  const config = readJson(projectionPath);
  validateConfig(lock, config);
  mkdirSync(cacheRoot, { recursive: true });
  const workRoot = mkdtempSync(join(cacheRoot, "build-"));
  try {
    const outputs = buildOutputs(lock, config, workRoot);
    if (mode === "--write") writeOutputs(outputs);
    else checkOutputs(outputs);
    const manifest = JSON.parse(outputs.find((output) => output.file === MANIFEST_FILE).bytes.toString("utf8"));
    for (const asset of manifest.assets) {
      console.log(`${asset.dataset}: ${asset.codeCount} codes / ${asset.featureCount} features / ${asset.bytes} bytes / sha256 ${asset.sha256}`);
    }
    console.log(`${mode === "--write" ? "wrote" : "verified"} ${outputs.length} deterministic outputs (${config.projectionInsetsVersion})`);
  } finally {
    const resolvedWork = resolve(workRoot);
    const resolvedCache = resolve(cacheRoot);
    if (!resolvedWork.startsWith(`${resolvedCache}\\`) && !resolvedWork.startsWith(`${resolvedCache}/`)) {
      fail(`refusing to remove unexpected work path: ${resolvedWork}`);
    }
    rmSync(resolvedWork, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? "") === resolve(scriptPath)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
