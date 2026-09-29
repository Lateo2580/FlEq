// P2-A10-AC01: 予備測定用の manifest / trialSetup の案（draft）。値は Phase 0 の案が土台で、凍結は予備測定の後に統合担当が行う。
// 無いと、予備測定が「結果を見る前に固定した条件」ではなく runner の内部定数で動き、後から凍結する値と食い違う。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO, WALL_ORIGIN_MS, fixtureId, fixtureText, loadN, replayLoad, sha256Hex } from "./frames.mjs";

import { sealSelfHash } from "../../dist/src/measurement/eew-e01/frozen.js";

const N_WINDOW_FILE = join(process.env.HOME, "dev/fleq-corpus-p0/20260929-n-window/page1.json");
const EVIDENCE = "reconstruction/test/eew-e01/evidence";
export const SMOKE_FILE = `${EVIDENCE}/chrome-smoke-conditions.json`;
// 母集団ごとの初期化入力（製品の WS 入力として最初に流す）と、試行ごとの引き金。
export const INITIAL = {
  fixedBacklog: ["81_01_04_251222_VPWP50"],
  maxVpws50DecodeStarted: ["81_01_04_251222_VPWP50"],
  maxWeatherCheckpointEncodeStarted: ["15_18_01_250630_VPWS50", "81_01_04_251222_VPWP50"],
  maxForecastCheckpointSave: ["81_09_01_260605_VPWP50"],
  forecastDeadlineOverlap: [], // 試行ごとの引き金が U-F の状態を作る（先に入れた新しい報告があると、期限を合わせた引き金が古い報告として無視される）
};
const TRIGGER_FIXTURES = ["15_18_01_250630_VPWS50", "15_17_01_251222_VPWW55", "81_09_01_260605_VPWP50", "81_01_04_251222_VPWP50"];

const contractTexts = () => {
  const dir = join(REPO, "reconstruction/contracts");
  const byId = {};
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const text = readFileSync(join(dir, name), "utf8");
    const id = JSON.parse(text).contract?.contractId;
    if (id != null) byId[id] = text;
  }
  return byId;
};

export function contractTextsFor() {
  const all = contractTexts();
  const own = JSON.parse(all["P2-EEW-E01-001"]).contract.dependsOnContractIds;
  return Object.fromEntries(["P2-EEW-E01-001", ...own].map((id) => [id, all[id]]));
}

export function buildDraft({ chromeVersion, nodeVersion, osVersion, device, periodMs, refPeriodMs, id }) {
  const smokeText = readFileSync(join(REPO, SMOKE_FILE), "utf8");
  const smoke = JSON.parse(smokeText);
  const n = loadN(N_WINDOW_FILE);
  const loads = { N: replayLoad("N", n, 1), P: replayLoad("P", n, 10), C: replayLoad("C", n, 50) };

  const fixtureNames = [...new Set([...Object.values(INITIAL).flat(), ...TRIGGER_FIXTURES, "37_01_01_240613_VXSE43", "77_01_01_240613_VXSE45",
    ...loads.N.fixtureRefs.map((ref) => ref.replace("test__fixtures__", ""))])].sort();
  const fixtureSha256 = Object.fromEntries(fixtureNames.map((name) => [fixtureId(name), sha256Hex(fixtureText(name))]));

  const initialState = {
    schemaVersion: "p2-eew-initial-state-draft-v1",
    populations: Object.fromEntries(Object.entries(INITIAL).map(([pop, names]) => [pop, names.map((name) => ({ fixture: fixtureId(name), sha256: fixtureSha256[fixtureId(name)] }))])),
    nWindow: { file: "page1.json (dmdata Telegram List v2, 2026-09-28 09:00-10:00 JST)", sha256: n.windowSha256, skipped: n.skipped },
  };
  const initialStateText = `${JSON.stringify(initialState, null, 2)}\n`;
  const trialSetup = {
    schemaVersion: "p2-eew-trial-setup-v1",
    initialStateRef: `${EVIDENCE}/preliminary/initial-state.draft.json`,
    initialStateSha256: sha256Hex(initialStateText),
    initialCheckpoints: { "U-E": { ref: null, sha256: null }, "U-W": { ref: null, sha256: null }, "U-F": { ref: null, sha256: null } },
    clock: { wallTimeOriginMs: WALL_ORIGIN_MS, monotonicOrigin: "runNodeClock" },
    resetBeforeEachTrial: [
      "run ごとに新しい host 子プロセス・空の state directory・空の診断 directory で始める（毎試行の再起動はしない）",
      "run ごとに warm-up 用と正式用の EventID を 1 つずつ使い、各試行は同じ EventID の VXSE43 で Serial を 1 ずつ増やす",
      "続報の予測を A（元 fixture）と B（愛媛県東予の予測震度 4 を 5- に替える）に交互に変え、contentRevision を進める",
    ],
    prepareDirtyGeneration: [
      "各試行の VXSE43 を独立投入側から製品の WS 入力として送る。U-E の dirty 世代は製品の入力処理が作る",
      "初期化入力（initial-state の populations 参照）を run 開始時に同じ経路で送り、U-W / U-F の初期状態を作る",
      "weather の入力（初期化・引き金・通常負荷 N）は、全時刻を平行移動して報告時刻を投入時点の壁時計（秒）へ寄せて流す（期限が最初から過ぎて状態が空になるのを避ける）",
    ],
    preventReplacementUntilPaintOrTimeout: [
      "次の試行の投入は、前の試行の T6 候補 mark が Chrome に現れるか、実投入から 10000ms が経つまで行わない",
    ],
  };
  const trialSetupText = `${JSON.stringify(trialSetup, null, 2)}\n`;

  const contracts = contractTextsFor();
  const ref = (pop) => ({ load: "N", trigger: `population=${pop}; periodMs=${refPeriodMs}; 起点は host の観測（decode / checkpoint encode の開始）に対する投入側の実投入を後から照合する`,
    stateRef: `${trialSetup.initialStateRef}#populations.${pop}`, stateSha256: trialSetup.initialStateSha256,
    targetOffsetMs: 1, acceptedOffsetRangeMs: [0, 5], warmupPerRun: 5, samplesPerRun: 20, runCount: 1, stopCondition: { kind: "sampleCount", samples: 20 } });
  const differences = [];
  if (smoke.chrome.version !== chromeVersion) differences.push(`chrome.version: smoke ${smoke.chrome.version} / manifest ${chromeVersion}`);
  const manifest = {
    schemaVersion: "p2-eew-e01-manifest-v2", manifestId: id, manifestSha256: "0".repeat(64),
    contractSha256: Object.fromEntries(Object.entries(contracts).map(([cid, text]) => [cid, JSON.parse(text).meta.sha256])),
    trialSetupRef: `${EVIDENCE}/preliminary/trial-setup.draft.json`, trialSetupSha256: sha256Hex(trialSetupText),
    smokeConditionsSha256: smoke.conditionsSha256, smokeConditionDifferences: differences,
    measuredSseClients: 1, notificationProbe: { desktop: "idle", sound: "idle" }, loads,
    formal: {
      population: "fixedBacklog", load: "N",
      trigger: `population=fixedBacklog; periodMs=${periodMs}; 続報方式（同じ EventID の VXSE43 を Serial+1・予測 A/B 交互）を通常負荷 N の再生と同時に投入する`,
      forecast: { subjects: 1, encodedBytes: 61105, saveCondition: "run 開始時に VPWP50 81_01_04 を 1 件入れ、以後 U-F は変更しない（保存は最初の tick で 1 回）",
        deadlineCondition: "U-F の validUntil は報告から 49 時間後で、測定中に期限は来ない", allowed: { maxSubjects: 2, maxEncodedBytes: 131072 } },
    },
    reference: { maxVpws50DecodeStarted: ref("maxVpws50DecodeStarted"), maxWeatherCheckpointEncodeStarted: ref("maxWeatherCheckpointEncodeStarted"),
      maxForecastCheckpointSave: ref("maxForecastCheckpointSave"), forecastDeadlineOverlap: ref("forecastDeadlineOverlap") },
    warmupPerRun: 100, samplesPerRun: 1000, runCount: 3, missingAfterMs: 10000, callbackDeadlineAfterInjectionMs: 10000,
    quantile: "nearestRank", clockProbeEveryMs: 30000, maxClockIntervalWidthMs: 5,
    health: { loads: ["N", "P"], requestEveryMs: 1000, requestTimeoutMs: 1000, minSamplesPerRun: 1000, runCount: 3 },
    auxiliary: Object.fromEntries(["E03", "E05", "E06", "E12"].map((k) => [k, { loads: ["N"], minSamplesPerRun: null, runCount: null, condition: "WP3b が値を決める（WP3a は設定しない）" }])),
    chrome: { version: chromeVersion, foregroundTab: true, viewportCssPx: [1440, 900], dpr: 2, motion: smoke.chrome.motion },
    nodeVersion, osVersion, device, geometrySha256: smoke.geometrySha256, fixtureSha256,
  };
  const manifestText = sealSelfHash(`${JSON.stringify(manifest, null, 2)}\n`, "manifestSha256");
  return { manifest: JSON.parse(manifestText), manifestText, trialSetupText, initialStateText, smokeText, contractTexts: contracts, nEvents: n };
}
