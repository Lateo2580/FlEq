// P3-TSUNAMI-E01-001（C6）の津波の入力と manifest の草案。runner（run.mjs）と解析が使う津波だけの規則をここに置く。
// frames.mjs は C4 の initial-state（rulesSource）が bytes の hash で固定しているので触らない。
//   草案（凍結しない）: node reconstruction/test/eew-e01/tsunami.mjs --draft --id <manifestId> [--out <path>] [--values <json>]
//     --values は予備測定（AC08）で固定した値の JSON（{ primeLeadMs, periodMs, triggerLeadMs, stop, preliminary }、どれも母集団 → 値。preliminary は
//     { successes, trials, msPerAttempt, source } で stopCondition をそこから計算する。machine は { chromeVersion, nodeVersion, osVersion, device } で、
//     凍結する機械〔Mac mini〕の実値を、草案を作る機械の値の代わりに入れる）。
//   C6 の smoke 条件の書き出し: node reconstruction/test/eew-e01/tsunami.mjs --smoke-conditions [--chrome-version <v>]（既存は上書きしない）
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { arch, cpus, release, totalmem } from "node:os";
import { join } from "node:path";

import { contractTextsFor, SEQUENCES_FILE } from "./draft.mjs";
import { REPO, WALL_ORIGIN_MS, fixtureId, fixtureText, sha256Hex, shiftTimestamps } from "./frames.mjs";

import { canonicalCoastJson } from "../../dist/chrome-eew/src/display/chrome-eew/coast.js";
import { canonicalGeometryJson } from "../../dist/chrome-eew/src/display/chrome-eew/geometry.js";
import { buildTsunamiPaint } from "../../dist/chrome-eew/src/display/chrome-eew/pure.js";
import { decodeMaterial } from "../../dist/src/decode-material/decode-material.js";
import { ingestXmlData } from "../../dist/src/ingress/ingress.js";
import { sealSelfHash } from "../../dist/src/measurement/eew-e01/frozen.js";
import { reduceTsunamiUnit, toTsunamiView } from "../../dist/src/units/tsunami/tsunami-unit.js";

export const C4_MANIFEST = "reconstruction/test/eew-e01/evidence/p3/manifest.json";
export const TSUNAMI_EVIDENCE = "reconstruction/test/eew-e01/evidence/p3-tsunami";
export const TSUNAMI_SMOKE_FILE = `${TSUNAMI_EVIDENCE}/chrome-smoke-conditions.json`;
export const T6_TSUNAMI = "fleq:p3:tsunami:T6-candidate";

// P3-C6-AC01: 5 つの遷移の prime → target の body（corpus の synthetic fixture、書き換えない）。
export const TEMPLATE_FIXTURES = {
  issued: { prime: "synthetic_VTSE41_e01_released", target: "synthetic_VTSE41_e01_311warning" },
  upgraded: { prime: "synthetic_VTSE41_e01_311warning", target: "synthetic_VTSE41_e01_311major" },
  expanded: { prime: "synthetic_VTSE41_e01_311major", target: "synthetic_VTSE41_e01_311major_312major" },
  released: { prime: "synthetic_VTSE41_e01_311major_312warning", target: "synthetic_VTSE41_e01_released" },
  downgraded: { prime: "synthetic_VTSE41_e01_311major_312warning", target: "synthetic_VTSE41_e01_311warning_312advisory" },
};
// warm-up の片付け（AC06(2)）に送る解除の報。
export const RELEASE_FIXTURE = "synthetic_VTSE41_e01_released";
// AC07(2) の公開 fixture（O09:14〜16 と、資材に無い code を持つ訓練の 32-39_12_02）と EEW の fixture。
export const PUBLIC_FIXTURES = ["32-39_11_02_250206_VTSE41", "32-39_11_09_250206_VTSE41", "32-39_11_11_250206_VTSE41", "32-39_12_02_250206_VTSE41",
  "37_01_01_240613_VXSE43", "77_01_01_240613_VXSE45"];

// P3-C6-TRIAL-RESET=A: template の body から 1 報を作る。変えるのは EventID（窓の EventID）と、Control の DateTime・Head の ReportDateTime・
// TargetDateTime（報ごとに 1 秒以上単調に進める日時）だけ。Body（区域・区分・高さ・到達予想）と Serial は変えない（VTSE41 の新旧は
// ReportDateTime と InfoType だけで決まり、Serial は効かない。tsunami-unit.ts）。
const jstSeconds = (ms) => `${new Date(ms + 9 * 3_600_000).toISOString().slice(0, 19)}+09:00`;
export function tsunamiReport(fixtureName, { eventId, reportAtMs }) {
  if (!Number.isInteger(reportAtMs) || reportAtMs % 1000 !== 0) throw new Error("tsunamiReport: reportAtMs must be on a second");
  const replaceOnce = (text, name, value) => {
    const pattern = new RegExp(`<${name}>[^<]*</${name}>`);
    if (!pattern.test(text)) throw new Error(`tsunamiReport: ${fixtureName} has no ${name}`);
    return text.replace(pattern, `<${name}>${value}</${name}>`);
  };
  let xml = fixtureText(fixtureName).toString("utf8");
  xml = replaceOnce(xml, "DateTime", `${new Date(reportAtMs).toISOString().slice(0, 19)}Z`);
  xml = replaceOnce(xml, "ReportDateTime", jstSeconds(reportAtMs));
  xml = replaceOnce(xml, "TargetDateTime", jstSeconds(reportAtMs));
  return replaceOnce(xml, "EventID", eventId);
}

// P3-C6-EEW-ORDER=A: EEW 同時の VXSE45 77_01_01。規則は C4 の eewVariant と同じ（EventID・Serial・全時刻の平行移動・予測 A/B）。
// 区域を持たない報なので、B は予測震度 3 を 4 に替えて contentRevision を進める。
const VXSE45_FIXTURE = "77_01_01_240613_VXSE45";
const VXSE45_REPORT_MS = Date.parse("2024-04-17T23:14:57+09:00");
const VXSE45_A = "<ForecastInt><From>3</From><To>3</To></ForecastInt>";
export function vxse45Variant({ eventId, serial, reportAtMs, variant }) {
  let xml = shiftTimestamps(fixtureText(VXSE45_FIXTURE).toString("utf8"), reportAtMs - VXSE45_REPORT_MS)
    .replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${eventId}</EventID>`).replace(/<Serial>\d+<\/Serial>/, `<Serial>${serial}</Serial>`);
  if (variant === "B") {
    if (!xml.includes(VXSE45_A)) throw new Error("VXSE45 variant B anchor not found");
    xml = xml.replace(VXSE45_A, VXSE45_A.replaceAll("3", "4"));
  }
  return xml;
}

// 塗りの期待（AC03(2) のページと同じ規則）。present は subject が view にあるか。
export function paintOf(forecasts, subject) {
  return { present: forecasts.some((s) => s.subject === subject), areas: buildTsunamiPaint(forecasts).areasBySubject.get(subject) ?? [] };
}

// ── C5 の reducer（reconstruction/dist）へ通す（P3-C6-SERIES-SOURCE=A。runner と解析は推測しない）──
const SAVED = { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null, savedAckAt: null, dirtySince: null };
export const emptyTsunamiState = () => ({ schemaVersion: "p3-tsunami-unit-v1", contentRevision: 0, forecasts: [], observations: [], intents: [], persistence: SAVED });
let decodeSeq = 0;
export function receiveTsunami(state, xml, atMs) {
  const entered = ingestXmlData({ inputId: `tsunami-draft-${++decodeSeq}`, inputSequence: 1, receivedAt: 0, origin: "replay", kind: "replay",
    headType: "VTSE41", body: Buffer.from(xml) });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return reduceTsunamiUnit(state, { kind: "receive", material: decoded.material, clock: { wallTimeMs: atMs, monotonicMs: 0 } });
}

const DRAFT_EVENT_ID = "20261009000000";
// 5 つの template を作る: 空の U-T に prime → target を通し、target の facts（series・areaTransitions）と、prime・target の後の view を
// ページと同じ塗りの規則にかけた値を期待にする。
export function buildTemplates() {
  const subject = `normal/VTSE41/${DRAFT_EVENT_ID}`;
  return Object.entries(TEMPLATE_FIXTURES).map(([transition, { prime, target }]) => {
    const primed = receiveTsunami(emptyTsunamiState(), tsunamiReport(prime, { eventId: DRAFT_EVENT_ID, reportAtMs: WALL_ORIGIN_MS }), WALL_ORIGIN_MS);
    const targeted = receiveTsunami(primed.state, tsunamiReport(target, { eventId: DRAFT_EVENT_ID, reportAtMs: WALL_ORIGIN_MS + 1000 }), WALL_ORIGIN_MS + 1000);
    const facts = targeted.outcomes.flatMap((o) => (o.kind === "accepted" ? o.subjects : [])).find((s) => s.subject === subject)?.facts;
    if (facts == null) throw new Error(`template ${transition}: the target was not adopted`);
    return {
      transition, expectedSeries: facts.series,
      expectedTransitions: facts.areaTransitions.map((t) => ({ areaCode: t.areaCode, from: t.from, to: t.to, transition: t.transition })),
      expectedPrimePaint: paintOf(toTsunamiView(primed.state).forecasts, subject), expectedPaint: paintOf(toTsunamiView(targeted.state).forecasts, subject),
      bodySha256: { prime: sha256Hex(fixtureText(prime)), target: sha256Hex(fixtureText(target)) },
    };
  });
}

// ── manifest の草案（P3-C6-AC01・AC10。凍結は AC08 の後に統合担当がする）──
const SERIES = ["escalation", "deescalation"];
const CONDITIONS = ["fixedBacklog", "maxVpws50ParseStarted", "maxWeatherCheckpointEncodeStarted", "eewTogether"];
const SERIES_TRANSITIONS = { escalation: ["issued", "upgraded", "expanded"], deescalation: ["released", "downgraded"] };
const INHERITS = { fixedBacklog: "fixedBacklog", maxVpws50ParseStarted: "maxVpws50ParseStarted", maxWeatherCheckpointEncodeStarted: "maxWeatherCheckpointEncodeStarted",
  eewTogether: "fixedBacklog" };
// 母集団 ID ↔ spec§7.5 の系列と条件 ↔ C4 の母集団 ↔ O09 の位置 ↔ 計画の行（AC01 の対応表）。trigger の文字列に入れて manifest の hash に固定する。
const O09_ROWS = { escalation: { fixedBacklog: "23・32・41", maxVpws50ParseStarted: "24・33・42", maxWeatherCheckpointEncodeStarted: "25・34・43", eewTogether: "26・35・44" },
  deescalation: { fixedBacklog: "50・59", maxVpws50ParseStarted: "51・60", maxWeatherCheckpointEncodeStarted: "52・61", eewTogether: "53・62" } };
const HOW = {
  fixedBacklog: "prime を周期の頭に送り、primeLeadMs 後に target を送る（通常負荷 N の再生と同時）",
  maxVpws50ParseStarted: "prime の primeLeadMs 後に最大 VPWS50 15_18_01（引き金）を送り、C4 と同じ自己較正（P3-C4-AC13(7)）で full parse 開始の 1ms 後に target を送る（prime は target の予測時刻ではなく引き金の送信の primeLeadMs 前。差は parse 開始までの数 ms で、differencesFromC4 の primeTiming）",
  maxWeatherCheckpointEncodeStarted: "prime の primeLeadMs 後に VPWW55（引き金）を送り、直近 10 試行の「引き金を含む U-W の encode 開始 − 実送信」の中央値（無い間は triggerLeadMs）の 1ms 後に target を送る（UWR の後の版の較正、Q-C6-IMPL-AMEND (10)。C4 は 1 秒の tick の予測）",
  eewTogether: "prime の primeLeadMs 後に VXSE45（窓ごとに 1 つの EventID、Serial+1・予想 A/B 交互）を送り、間を空けずに同じ WS で target を送る",
};
export const O09_POSITIONS = [13, 14, 15, 16, 17, 18, 23, 24, 25, 26, 32, 33, 34, 35, 41, 42, 43, 44, 50, 51, 52, 53, 59, 60, 61, 62];
// 窓の EventID（14 桁）: 2026100906 + 種別（1 津波・2 EEW）+ 母集団の番号 + 区分（0 warm-up・1 正式）+ run（warm-up は 0）。
export const windowEventId = (kind, populationIndex, phase, run) => `2026100906${kind}${populationIndex}${phase === "warmup" ? 0 : 1}${phase === "warmup" ? 0 : run}`;
const DEFAULT_PERIOD_MS = 3000;
export const DEFAULT_PRIME_LEAD_MS = 1500;
// Q-C6-IMPL-AMEND (10)・(11): 予備（Mac mini）の「引き金の送信 → U-W の encode 開始」の p50（25〜26ms）。較正の前の最初の 10 試行だけが使う。
const ENCODE_DELAY_FALLBACK_MS = 26;

// AC08・Q-C6-IMPL-AMEND (11): 予備の成立数・試行数・1 試行の所要から窓の stopCondition を決める（C4 の P3-C4-FREEZE-DECISIONS の (2) と同じ式）。
// maxAttempts＝100＋ceil(1,000÷Wilson 下限〔z＝1.96〕×1.1)、maxDurationMs＝ceil((60 秒＋1 試行の所要×maxAttempts)×1.25)。見込みの所要は
// 点推定の成立率で 60 秒＋1 試行の所要×(100＋1,000÷成立率)。
export function wilsonLower(successes, trials, z = 1.96) {
  const p = successes / trials;
  return (p + z * z / (2 * trials) - z * Math.sqrt((p * (1 - p)) / trials + z * z / (4 * trials * trials))) / (1 + z * z / trials);
}
export function stopFromPreliminary({ successes, trials, msPerAttempt }) {
  const lower = wilsonLower(successes, trials);
  const maxAttempts = 100 + Math.ceil((1000 / lower) * 1.1);
  return { maxAttempts, maxDurationMs: Math.ceil((60_000 + msPerAttempt * maxAttempts) * 1.25), wilsonLower: lower,
    expectedMs: Math.round(60_000 + msPerAttempt * (100 + 1000 / (successes / trials))) };
}

// stop か preliminary の無い母集団の stopCondition は C4 の凍結値の試行数を仮に置く（凍結の前に preliminary で決める）。
export function buildP3TsunamiManifest({ id, chromeVersion, nodeVersion, osVersion, device, primeLeadMs = {}, periodMs = {}, triggerLeadMs = {}, stop = {}, preliminary = {},
  smokeText = readFileSync(join(REPO, TSUNAMI_SMOKE_FILE), "utf8") }) {
  const c4Text = readFileSync(join(REPO, C4_MANIFEST), "utf8");
  const c4 = JSON.parse(c4Text);
  const smoke = JSON.parse(smokeText);
  const contracts = contractTextsFor("P3-TSUNAMI-E01-001");
  const templates = buildTemplates();
  const { schemaVersion: _s, manifestId: _i, manifestSha256: _h, inheritsManifestId: _p, populations: c4Populations, auxiliary: _a, o09Subset: _o,
    judgmentPlaces: _j, smokeConditionDifferences: _d, contractSha256: _c, smokeConditionsSha256: _sc, ...common } = c4;
  const differencesFromC4 = [{ path: "trial", c4: "1 試行 = EEW の続報 1 報", c6: "1 試行 = prime（初期状態へ置き換える報）→ target（標本）の 2 報",
    reason: "P3-C6-TRIAL-RESET=A。各試行を既知の初期状態から始める" }];
  const populations = {};
  SERIES.forEach((series, s) => CONDITIONS.forEach((condition, c) => {
    const key = `${series}:${condition}`;
    const index = s * CONDITIONS.length + c;
    const inherited = c4Populations[INHERITS[condition]];
    const period = periodMs[key] ?? DEFAULT_PERIOD_MS;
    const lead = condition === "maxWeatherCheckpointEncodeStarted" ? triggerLeadMs[key] ?? ENCODE_DELAY_FALLBACK_MS : null;
    if (condition === "maxVpws50ParseStarted") differencesFromC4.push({ path: `populations.${key}.primeTiming`, c4: "prime なし",
      c6: "prime を引き金（VPWS50）の送信の primeLeadMs 前に送る", reason: "AC06(4) の「target の予測時刻の primeLeadMs 前」との差。target は引き金の送信から自己較正の parse 遅延＋1ms 後なので、prime から target までは primeLeadMs＋数 ms になる（予測を待たずに prime を送れる）" });
    for (const [field, c4Value, c6Value] of [["periodMs", inherited.periodMs, period], ["triggerLeadMs", inherited.triggerLeadMs, lead]]) {
      if (c4Value !== c6Value) differencesFromC4.push({ path: `populations.${key}.${field}`, c4: String(c4Value), c6: String(c6Value),
        reason: field === "periodMs" ? "prime が入るので試行の周期は 3,000ms を既定とする（P3-C6-CONDITIONS=A）"
          : "C4 は 1 秒の tick の何 ms 前に引き金を送るか。C6 は UWR の後の版で、較正の予測が無い間の「引き金の送信 → encode 開始」の代わり（Q-C6-IMPL-AMEND (10)）" });
    }
    const measured = preliminary[key] == null ? null : stopFromPreliminary(preliminary[key]);
    if (measured != null) {
      const { successes, trials, msPerAttempt, source } = preliminary[key];
      differencesFromC4.push({ path: `populations.${key}.stopCondition`, c4: JSON.stringify(inherited.stopCondition),
        c6: JSON.stringify({ maxAttempts: measured.maxAttempts, maxDurationMs: measured.maxDurationMs }),
        reason: `この母集団の予備（${source}）: 成立 ${successes}/${trials}、Wilson 下限 ${measured.wilsonLower.toFixed(3)}、1 試行 ${msPerAttempt}ms。`
          + `maxAttempts＝100＋ceil(1,000÷下限×1.1)、maxDurationMs＝ceil((60 秒＋1 試行×maxAttempts)×1.25)。見込みの所要（点推定）は 1 窓 ${Math.round(measured.expectedMs / 60_000)} 分（Q-C6-IMPL-AMEND (11)）` });
    }
    const maxAttempts = stop[key]?.maxAttempts ?? measured?.maxAttempts ?? inherited.stopCondition.maxAttempts;
    const ids = (kind) => ({ warmup: windowEventId(kind, index, "warmup", 0), formalByRun: [1, 2, 3].map((run) => windowEventId(kind, index, "formal", run)) });
    populations[key] = {
      scope: "formal", load: inherited.load, periodMs: period,
      trigger: `population=${key}; spec=§7.5 ${series === "escalation" ? "発令系" : "解除系"}×${condition}; c4=${INHERITS[condition]}（p3-c4-formal-20261007）; `
        + `o09=${O09_ROWS[series][condition]}; plan=p3-order-plan.md:203; transitions=${SERIES_TRANSITIONS[series].join("→")}（試行ごとに順に回す）; ${HOW[condition]}`,
      stateRef: inherited.stateRef, stateSha256: inherited.stateSha256,
      stopCondition: { maxAttempts, maxDurationMs: stop[key]?.maxDurationMs ?? measured?.maxDurationMs ?? Math.ceil((60_000 + period * maxAttempts) * 1.25) },
      triggerLeadMs: lead, series, condition, inheritsC4Population: INHERITS[condition], transitions: SERIES_TRANSITIONS[series],
      establishment: condition === "fixedBacklog" ? { kind: "primeSettled" } : condition === "eewTogether" ? { kind: "primeSettledEewOrder" }
        : { kind: "primeSettledStartOffset", startOffset: inherited.establishment },
      primeLeadMs: primeLeadMs[key] ?? DEFAULT_PRIME_LEAD_MS, tsunamiEventIds: ids(1), eewEventIds: condition === "eewTogether" ? ids(2) : null,
    };
  }));
  const fixtureSha256 = { ...c4.fixtureSha256 };
  for (const name of [...new Set(Object.values(TEMPLATE_FIXTURES).flatMap((t) => [t.prime, t.target])), VXSE45_FIXTURE]) fixtureSha256[fixtureId(name)] = sha256Hex(fixtureText(name));
  const smokeConditionDifferences = smoke.chrome.version === chromeVersion ? [] : [`chrome.version: smoke ${smoke.chrome.version} / manifest ${chromeVersion}`];
  for (const [field, was, now] of [["chrome.version", c4.chrome.version, chromeVersion], ["nodeVersion", c4.nodeVersion, nodeVersion], ["osVersion", c4.osVersion, osVersion], ["device", c4.device, device]]) {
    if (was !== now) differencesFromC4.push({ path: field, c4: was, c6: now, reason: "機械の実値（凍結時に Mac mini の値で置き直す）" });
  }
  const manifest = {
    schemaVersion: "p3-tsunami-e01-manifest-v1", manifestId: id, manifestSha256: "0".repeat(64), ...common,
    contractSha256: Object.fromEntries(Object.entries(contracts).map(([cid, text]) => [cid, JSON.parse(text).meta.sha256])),
    smokeConditionsSha256: smoke.conditionsSha256, smokeConditionDifferences, chrome: { ...c4.chrome, version: chromeVersion }, nodeVersion, osVersion, device,
    fixtureSha256, inheritsManifestId: c4.manifestId, templates, populations, coastSha256: sha256Hex(canonicalCoastJson()), smokeConditionsRef: TSUNAMI_SMOKE_FILE,
    differencesFromC4,
    capacityExpectation: { status: "expectationOnly", inheritor: "P4 capacity contract",
      text: "P3-C5-E01-SERIES の capacityExpectation（期待値だけ、測定は P4 の容量契約、D-P3-6）: 他分野の縮退中（U-W が summary）は U-T を通常の full で配送し、T6 は通常と同じ。U-T 自身の意図的な予算超過では §8.1 の最小事実（運用区分・最高区分・大津波警報の有無と区域数）、緊急配置、省略表示、旧表示の除去を T6 の期待値とする（spec:1332）。通常合法最大での予報区別警報区分の配送欠落 0（E13a）は P4" },
    o09Subset: { sequenceId: "O09", sequencesSha256: JSON.parse(readFileSync(join(REPO, SEQUENCES_FILE), "utf8")).meta.sha256, positions: O09_POSITIONS },
    judgmentPlaces: { E01: "Pi backend＋実接続経路＋表示端末の Chrome（P5）。C6 の Mac mini の結果は P3 の津波 E01 の検収、Pi の予備確認は正式 Pass にしない" },
  };
  const manifestText = sealSelfHash(`${JSON.stringify(manifest, null, 2)}\n`, "manifestSha256");
  return { manifest: JSON.parse(manifestText), manifestText, c4Text, smokeText, contractTexts: contracts, coastJsonText: canonicalCoastJson(),
    sequencesText: readFileSync(join(REPO, SEQUENCES_FILE), "utf8"), fixtureTexts: templateFixtureTexts() };
}
export const templateFixtureTexts = () => Object.fromEntries([...new Set(Object.values(TEMPLATE_FIXTURES).flatMap((t) => [t.prime, t.target]))]
  .map((name) => [fixtureId(name), fixtureText(name).toString("utf8")]));

// P3TsunamiSmokeConditions（AC07・AC10）。A9 の chrome-smoke-conditions.json は A10・C4 の凍結 manifest が固定しているので書き換えない。
export function buildTsunamiSmokeConditions(chromeVersion) {
  const names = [...new Set(Object.values(TEMPLATE_FIXTURES).flatMap((t) => [t.prime, t.target]))].sort();
  const body = { schemaVersion: "p3-tsunami-chrome-smoke-conditions-v1", conditionsSha256: "0".repeat(64),
    chrome: { version: chromeVersion, foregroundTab: true, viewportCssPx: [1440, 900], dpr: 2, motion: "full" },
    geometrySha256: sha256Hex(canonicalGeometryJson()), coastSha256: sha256Hex(canonicalCoastJson()),
    fixtureSha256: Object.fromEntries(PUBLIC_FIXTURES.map((name) => [fixtureId(name), sha256Hex(fixtureText(name))])),
    templateBodySha256: Object.fromEntries(names.map((name) => [fixtureId(name), sha256Hex(fixtureText(name))])) };
  return sealSelfHash(`${JSON.stringify(body, null, 2)}\n`, "conditionsSha256");
}

if (process.argv[1] != null && import.meta.filename === realpathSync(process.argv[1])) {
  const argv = process.argv.slice(2);
  const args = new Map();
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args.set(argv[i].slice(2), argv[i + 1]?.startsWith("--") || argv[i + 1] == null ? true : argv[++i]);
  const { chromeVersion } = await import("./chrome.mjs");
  if (args.has("smoke-conditions")) {
    const path = join(REPO, TSUNAMI_SMOKE_FILE);
    if (existsSync(path)) throw new Error(`${TSUNAMI_SMOKE_FILE} exists; the C6 smoke conditions are not overwritten`);
    writeFileSync(path, buildTsunamiSmokeConditions(args.has("chrome-version") ? String(args.get("chrome-version")) : await chromeVersion()), { flag: "wx" });
    console.log(JSON.stringify({ written: TSUNAMI_SMOKE_FILE }));
  } else if (args.has("draft") && typeof args.get("id") === "string") {
    const { execFileSync } = await import("node:child_process");
    const values = args.has("values") ? JSON.parse(readFileSync(String(args.get("values")), "utf8")) : {};
    const { machine = {}, ...rest } = values;
    const built = buildP3TsunamiManifest({ ...rest, id: String(args.get("id")), chromeVersion: machine.chromeVersion ?? await chromeVersion(),
      nodeVersion: machine.nodeVersion ?? execFileSync("/opt/homebrew/opt/node@22/bin/node", ["-p", "process.version"], { encoding: "utf8" }).trim(),
      osVersion: machine.osVersion ?? `${release()} ${arch()}`, device: machine.device ?? `${cpus()[0]?.model ?? "cpu"} x${cpus().length}, ${Math.round(totalmem() / 2 ** 30)}GiB` });
    const out = args.has("out") ? String(args.get("out")) : join(REPO, TSUNAMI_EVIDENCE, "manifest.draft.json");
    writeFileSync(out, built.manifestText);
    console.log(JSON.stringify({ written: out, manifestId: built.manifest.manifestId, manifestSha256: built.manifest.manifestSha256 }));
  } else {
    console.error("usage: node tsunami.mjs --draft --id <manifestId> [--out <path>] | --smoke-conditions [--chrome-version <v>]");
    process.exit(2);
  }
}
