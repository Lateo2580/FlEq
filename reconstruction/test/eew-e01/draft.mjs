// P2-A10-AC01/AC08/AC15/AC16: manifest / trialSetup / initial-state の組み立て。予備測定の案（buildDraft → evidence/preliminary/）と、
// Q-PERF の凍結（freeze → evidence/）は同じ組み立てを通り、置き場と通知 probe・P 用の空け数の出どころだけが違う。
// 無いと、予備測定と本番が別の定数で動き、結果を見る前に固定した条件と runner の内部定数が食い違う。
//
// 凍結の口（統合担当が本番用を書き出す）:
//   node reconstruction/test/eew-e01/draft.mjs --freeze --id <manifestId> --room-partials <n> --room-forecast <n> \
//     --notification-probe desktop=<idle|unavailable>,sound=<idle|unavailable> [--out <dir>]
//   Chrome・Node（/opt/homebrew/opt/node@22）・OS・端末は実機から取る。--out の既定は evidence/。既存のファイルは上書きしない。
//   書く前に verifyFrozenManifest を通す（通らなければ何も書かない）。
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { arch, cpus, release, totalmem } from "node:os";
import { join } from "node:path";

import { E12_CONFIG_NOTE } from "./aux-measures.mjs";
import { AC15_SCENARIOS, C_CYCLE, E03_SERIES, E12_CLASSES, FIX, PARTIAL_HISTORY_UPDATES, REPO, RES07, WALL_ORIGIN_MS, fixtureId, fixtureText, loadN, replayLoad, sha256Hex } from "./frames.mjs";

import { sealSelfHash, verifyFrozenManifest } from "../../dist/src/measurement/eew-e01/frozen.js";

const N_WINDOW_FILE = join(process.env.HOME, "dev/fleq-corpus-p0/20260929-n-window/page1.json");
const EVIDENCE = "reconstruction/test/eew-e01/evidence";
export const SMOKE_FILE = `${EVIDENCE}/chrome-smoke-conditions.json`;
const FRAMES_FILE = "reconstruction/test/eew-e01/frames.mjs";
// 母集団ごとの初期化入力（製品の WS 入力として最初に流す）と、試行ごとの引き金。
export const INITIAL = {
  fixedBacklog: ["81_01_04_251222_VPWP50"],
  maxVpws50DecodeStarted: ["81_01_04_251222_VPWP50"],
  maxWeatherCheckpointEncodeStarted: ["15_18_01_250630_VPWS50", "81_01_04_251222_VPWP50"],
  maxForecastCheckpointSave: ["81_09_01_260605_VPWP50"],
  forecastDeadlineOverlap: [], // 試行ごとの引き金が U-F の状態を作る（先に入れた新しい報告があると、期限を合わせた引き金が古い報告として無視される）
};
const TRIGGER_FIXTURES = ["15_18_01_250630_VPWS50", "15_17_01_251222_VPWW55", "81_09_01_260605_VPWP50", "81_01_04_251222_VPWP50"];

// Q-PERF の値（wp3c-decisions.md と設計メモ §3、2026-09-30）。凍結すると manifest の hash に入る。
const Q = {
  formalPeriodMs: 1370,
  refPeriodMs: 3000,
  // 予備 prelim-20260929T122528 の実測（120 試行で subjects 1・範囲外 0）。範囲はその 2 倍。
  formalForecast: { subjects: 1, encodedBytes: 61113, allowed: { maxSubjects: 2, maxEncodedBytes: 131072 } },
  reference: { warmupPerRun: 10, samplesPerRun: 100, runCount: 1 },
  // Screenshot の無い paint の扱い（ご主人裁定の代行 2、契約の穴 §6 d）。型に場所が無いので formal.trigger の文字列で hash に入れる。
  paintEvidence: "paintEvidence=PipelineReporter STATE_PRESENTED_ALL; screenshot=corroborating",
  health: { loads: ["N", "P"], requestEveryMs: 1000, requestTimeoutMs: 5000, minSamplesPerRun: 1000, runCount: 3 },
  pSpeedup: 10,
};

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

const ref = (name) => ({ fixture: fixtureId(name), sha256: sha256Hex(fixtureText(name)) });

// initial-state の recipe（fixture・sha256・書き換え規則・件数）。規則の実装は frames.mjs で、その sha256 も recipe に固定する。
// room は P の再生が新しく足す U-W partial と U-F subject の数（予備は null = 未凍結）。
// 件数の確認は観測できるものだけ: /snapshot の activeCount（eew は EventID 単位、通常/訓練/試験）と保存済み checkpoint の件数
// （U-W の national・partials、U-F の subjects。U-E の checkpoint は current を持たないので U-E の subject 数は観測できない）。
function recipes(room) {
  const expect = (eew, r) => ({ snapshotActive: { eew, weatherCurrent: `${RES07.partials - (r?.partials ?? 0) + 1}/1/1`, weatherTimeseries: `${RES07.forecastSubjects - (r?.forecastSubjects ?? 0)}/0/0` },
    checkpoint: { "U-W.national": RES07.national.length, "U-W.partials": RES07.partials - (r?.partials ?? 0), "U-F.subjects": RES07.forecastSubjects - (r?.forecastSubjects ?? 0) } });
  return {
    rulesSource: { file: FRAMES_FILE, sha256: sha256Hex(readFileSync(join(REPO, FRAMES_FILE))) },
    nearCapacity: {
      function: "nearCapacityFrames({ mode, room })",
      source: "A8 RES-07（p2-snapshot-sse.json）の合法最大を cost.test.ts:155-165 と同じ作り方で製品入力から作る",
      fixtures: [FIX.vxse43, FIX.vxse45, FIX.vpws50, FIX.vpww57, FIX.vpwp50].map(ref),
      rules: [
        `U-E: VXSE43 ${FIX.vxse43} と VXSE45 ${FIX.vxse45} の EventID を ${20240417000000}+i（i=0..${RES07.eventIdsPerFamily - 1}）に替えて交互に送る（2 family × ${RES07.eventIdsPerFamily}）。時刻は動かさない`,
        `U-W national: VPWS50 ${FIX.vpws50} の最初の <Status>通常</Status> を ${RES07.national.join("・")} に替えて 3 件（frame の外側の運用も本文に揃える）`,
        `U-W partial: VPWW57 ${FIX.vpww57} の EditorialOffice を 官署i（i=0..partials-1）に替える`,
        `U-F: VPWP50 ${FIX.vpwp50} の EditorialOffice を 官署i（i=0..subjects-1）に替える。ReportDateTime は 17:00 のまま、validUntil は翌 03:00`,
        "cycleC: full と同じで、VXSE43 の EventID 20240417000511 だけを訓練の種（VXSE43 の EventID 20260930000000、Status 訓練）に替える",
        `half: U-E の EventID（i=0..${RES07.eventIdsPerFamily / 2 - 1}）・U-W partial（官署0..${RES07.partials / 2 - 1}）・U-F（官署0..${RES07.forecastSubjects / 2 - 1}）を full の半分、national は同じ 3 件（AC15 の保持量の対照）`,
        `full・half: U-W partial の官署ごとに、同じ報告の ReportDateTime を +k 秒（k=1..${PARTIAL_HISTORY_UPDATES}）に置いた更新を続けて送り、履歴を ${PARTIAL_HISTORY_UPDATES} 件作る（AC15 の指紋表に履歴 entry の形を載せる）`,
        "全て報告時刻を動かさない（host の壁時計起点 2026-06-05T18:00+09:00 は A8 試験の at と同じ）",
      ],
      pacing: "sendPaced: 未処理（送った数 − host の decode 観測数）を通常 32 件以下・EEW 8 件以下（予約枠）・VPWS50 は 0 件のときだけ送る（mailbox RES-03/04 で拒否させない）。送った後に expected の値を /snapshot と保存済み checkpoint で確かめ、違えば窓を Blocked（stateNotReproducible）",
      modes: {
        full: { room: null, expected: expect("512/0/0", null), usedBy: ["AC15"] },
        half: { room: null, expected: expect(`${RES07.eventIdsPerFamily / 2}/0/0`, { partials: RES07.partials / 2, forecastSubjects: RES07.forecastSubjects / 2 }), usedBy: ["AC15"] },
        leaveRoomForP: { room, expected: room == null ? null : expect("512/0/0", room), usedBy: ["E02-P", "E05-P"] },
        cycleC: { room: null, expected: expect("512/1/0", null), usedBy: ["E06"] },
      },
    },
    cycleC: {
      function: "cycleCFrames(c, cycleStartWallMs)",
      initialState: "nearCapacity cycleC（保持上限ちょうど、VXSE43 の 1 件が訓練の種）",
      periodMs: C_CYCLE.periodMs, warmupCycles: C_CYCLE.warmupCycles, cycles: 65,
      fixtures: [FIX.vpws50, FIX.vpww57, FIX.vxse43, FIX.vxse43Cancel, FIX.vpwp50].map(ref),
      inputs: [
        { offsetMs: C_CYCLE.offsetsMs[0], rule: `VPWS50 ${FIX.vpws50}（通常）の全時刻を充填時より (c+1)×60 秒後へ`, effect: "U-W national の更新（履歴は深さ 2 で最古の normal を押し出す。f65961cc）" },
        { offsetMs: C_CYCLE.offsetsMs[1], rule: `VPWP50 ${FIX.vpwp50} の EditorialOffice を ${C_CYCLE.forecastOffice}、全時刻を validUntil が周期の開始 + ${C_CYCLE.restoreValidForMs / 60_000} 分になるよう動かし、ReportDateTime を充填時 + (c+1)×60 秒 − 30 秒に置き直す`, effect: "前の周期で期限回収した U-F subject の入れ直し（周期 0 は更新）" },
        { offsetMs: C_CYCLE.offsetsMs[2], rule: `VPWW57 ${FIX.vpww57} の EditorialOffice を 官署{c}、ReportDateTime を充填時 + (c+1)×60 秒`, effect: "U-W partial の更新" },
        { offsetMs: C_CYCLE.offsetsMs[3], rule: `VXSE43 ${FIX.vxse43} の EventID を 20240417000000+c、Serial 2、全時刻を (c+1)×60 秒後へ、予測を c の偶奇で A/B（愛媛県東予 4→5-）`, effect: "U-E の更新" },
        { offsetMs: C_CYCLE.offsetsMs[4], rule: `VXSE43 ${FIX.vxse43}（Status 訓練）の EventID を 20260930000000+c+1`, effect: "U-E の追加。family 512 を超えるので製品が最古の非通常（前の周期の訓練 EventID の gate）を追い出す（eew.ts:366-381）" },
        { offsetMs: C_CYCLE.offsetsMs[5], rule: `VXSE43 取消 ${FIX.vxse43Cancel}（Status 訓練）の EventID を 20260930000000+c+1`, effect: "U-E の取消（同じ周期に足した訓練 EventID が current から消える）" },
        { offsetMs: C_CYCLE.offsetsMs[6], rule: `VPWP50 ${FIX.vpwp50} の EditorialOffice を ${C_CYCLE.forecastOffice}、全時刻を validUntil が周期の開始（host 壁時計）+ ${C_CYCLE.validUntilAfterStartMs / 1000} 秒になるよう動かし、ReportDateTime を充填時 + (c+1)×60 秒に置き直す`, effect: "U-F の更新と、周期の中の tick での期限回収" },
      ],
      constantRetention: "周期の終わり（58 秒）で、U-E は current・gate・family 予算、U-F は subjects 512・active 511、U-W は partials 128 が周期をまたいで同じ（E06 の傾きを保持量の目減りで偏らせない）",
      bound: `c < ${RES07.partials}（官署{c} が充填済みの範囲にある）`,
      expectedPerCycle: "診断 eewCapacityEvicted が 1 件（訓練 EventID の追加による容量退去。U-E の保持量が一定であることの観測値。eew の activeCount は event 単位で VXSE45 が残るため減らない）",
      cancelScope: "取消は訓練の区分でだけ起きる。通常の取消は C では走らない",
      established: "予備で 4 周期: 周期の終わりの /snapshot activeCount（eew・weatherTimeseries）と checkpoint の件数（U-W partials、U-F subjects）が一定、eew の contentRevision と U-W・U-F の checkpoint 世代が周期ごとに進む",
    },
    e03Series: {
      function: "e03Frame(k, startWallMs)",
      fixtures: [ref(E03_SERIES.fixture)], periodMs: E03_SERIES.periodMs, warmup: E03_SERIES.warmup, samples: E03_SERIES.samples, background: "N",
      rule: "k 番目は全時刻を平行移動し、ReportDateTime を floor((start + k × 1200ms) / 1 秒) の host 壁時計に置く（周期 > 1 秒なので厳密に増える）",
      note: "通常の national は履歴 2 件で上限（weather-current.ts:625-636）。空状態からでも 3 件目以降の VPWS50 は capacityExceeded の unavailable 更新になる",
    },
    ac15Scenarios: {
      function: "ac15Frame(scenario, index)",
      initialState: "nearCapacity full（保持上限ちょうど）と half（約半分）。同じシナリオを両方の充填から回す",
      retention: { ...AC15_SCENARIOS.retention,
        rule: `各シナリオ（区間の入力の unit と metadata）の measure（checkpoint 区間＝どの unit の encode・verify・encode 後の未計測区間の外で、指紋表のどれにも当たらない直列化（その他）・原始値（#string など、要素が原始値の配列を含む）・自 unit の要素・ambiguous の単件の、入力 1 件あたりの回数）ごとに、slope =（full の中央値 − half の中央値）/ ΔN が ${AC15_SCENARIOS.retention.maxSlopePerRetained} 回／保持 1 件を超えたら Fail（走査対象が保持量に比例＝当該 subject だけでない）。ただし差が雑音の床（2 回の実走それぞれの p95 − p50 の大きい方）以下なら Fail にしない。中央値か ΔN が取れなければ未確認。回数・差・傾きを報告する`,
        deltaRetained: "ΔN は全シナリオ共通で、3 unit の保持件数の差（充填の observed: U-E は /snapshot の eew の通常の activeCount＝EventID 数、U-W は checkpoint の partials 数、U-F は checkpoint の subjects 数）の最小（今の充填では U-W の 64）。unit ごとの差で割ると、保持の差が大きい別 unit の走査が薄まって通るため" },
      fixtures: [FIX.vxse43, FIX.vpww57, FIX.vpwp50].map(ref),
      warmup: AC15_SCENARIOS.warmup, samples: AC15_SCENARIOS.samples, intervalMs: AC15_SCENARIOS.intervalMs, metadataIntervalMs: AC15_SCENARIOS.metadataIntervalMs, order: AC15_SCENARIOS.scenarios,
      rules: {
        "U-E": `VXSE43 ${FIX.vxse43} の EventID 20240417000000、Serial を index+2、ReportDateTime を 23:14:59 + (index+1) 秒`,
        metadata: `frame ではなく投入側の WS 切断（server 側で socket を terminate）。host が connectionLost を流し RECONNECT_MS 5 秒後に再接続する（host.ts:228-231）。間隔 ${AC15_SCENARIOS.metadataIntervalMs}ms（予備の再接続所要より長い）。区間は切断の時刻（投入側 hrtime を host 時計へ写したもの）から次の区間の起点まで`,
        "U-W": `VPWW57 ${FIX.vpww57} の EditorialOffice を 官署0、ReportDateTime を 2020-06-22T23:00+09:00 + (index+1) 分`,
        "U-F": `VPWP50 ${FIX.vpwp50} の EditorialOffice を 官署0、ReportDateTime を 17:00 + (index+1) 秒`,
      },
      source: "p2-snapshot-sse.json:100 の 4 シナリオ（A8 cost.test.ts:182-191 と同じ入力）",
    },
  };
}

// stage: "preliminary"（evidence/preliminary/ の案）| "frozen"（evidence/ の本番）。
export function buildManifest({ stage, chromeVersion, nodeVersion, osVersion, device, periodMs = Q.formalPeriodMs, refPeriodMs = Q.refPeriodMs, id, room, notificationProbe }) {
  const dir = stage === "frozen" ? EVIDENCE : `${EVIDENCE}/preliminary`;
  const suffix = stage === "frozen" ? "" : ".draft";
  const smokeText = readFileSync(join(REPO, SMOKE_FILE), "utf8");
  const smoke = JSON.parse(smokeText);
  const n = loadN(N_WINDOW_FILE);
  const cLoad = replayLoad("C", { events: [FIX.vpws50, FIX.vpwp50, FIX.vpww57, FIX.vxse43, FIX.vxse43, FIX.vxse43Cancel, FIX.vpwp50].map((fixture, i) => ({ fixture, offsetMs: C_CYCLE.offsetsMs[i] })), windowMs: C_CYCLE.periodMs }, 1);
  const loads = { N: replayLoad("N", n, 1), P: replayLoad("P", n, Q.pSpeedup), C: cLoad };
  const recipe = recipes(room);

  const e12Fixtures = Object.values(E12_CLASSES).map((c) => c.fixture);
  const recipeFixtures = [recipe.nearCapacity, recipe.cycleC, recipe.e03Series, recipe.ac15Scenarios].flatMap((r) => r.fixtures.map((f) => f.fixture.replace("test__fixtures__", "")));
  const fixtureNames = [...new Set([...Object.values(INITIAL).flat(), ...TRIGGER_FIXTURES, FIX.vxse43, FIX.vxse45, ...recipeFixtures, ...e12Fixtures,
    ...loads.N.fixtureRefs.map((r) => r.replace("test__fixtures__", ""))])].sort();
  const fixtureSha256 = Object.fromEntries(fixtureNames.map((name) => [fixtureId(name), sha256Hex(fixtureText(name))]));

  const initialState = {
    schemaVersion: "p2-eew-initial-state-v1",
    populations: Object.fromEntries(Object.entries(INITIAL).map(([pop, names]) => [pop, names.map((name) => ({ fixture: fixtureId(name), sha256: fixtureSha256[fixtureId(name)] }))])),
    nWindow: { file: "page1.json (dmdata Telegram List v2, 2026-09-28 09:00-10:00 JST)", sha256: n.windowSha256, skipped: n.skipped },
    ...recipe,
  };
  const initialStateText = `${JSON.stringify(initialState, null, 2)}\n`;
  const trialSetup = {
    schemaVersion: "p2-eew-trial-setup-v1",
    initialStateRef: `${dir}/initial-state${suffix}.json`,
    initialStateSha256: sha256Hex(initialStateText),
    // 初期状態は checkpoint の復元ではなく製品入力で作る（U-W national 3 件だけで数 MB になり repo に置けない）。
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
      "weather の入力（初期化・引き金・通常負荷 N・P）は、全時刻を平行移動して報告時刻を投入時点の壁時計（秒）へ寄せて流す（期限が最初から過ぎて状態が空になるのを避ける）",
      "P・AC15・E06 の窓は、host の起動直後に initial-state の nearCapacity recipe（P は leaveRoomForP、AC15 は full、E06 は cycleC）の入力を製品の WS 入力として流し、recipe の expected（/snapshot の activeCount と保存済み checkpoint の件数）を確かめてから測定を始める。値が recipe と違えば、その窓を Blocked（stateNotReproducible）とする",
      "C・E03・AC15 の入力は initial-state の cycleC・e03Series・ac15Scenarios の規則（frames.mjs、sha256 は rulesSource）で作る",
      "E15（write 帰属）と publish 費用（PublishCostReport）は host を起動した全窓で host の JSON Lines から報告する（E01・E02 の窓は必ず出す）。manifest に置き場が無いのでここに書く",
    ],
    preventReplacementUntilPaintOrTimeout: [
      "次の試行の投入は、前の試行の入力の処理区間（その T2 から次の入力の T2 まで）に host が公開した版の T6 候補 mark が Chrome に現れ、その mark を含む frame の Commit を過ぎる（requestAnimationFrame 2 回）か、実投入から 10000ms が経つまで行わない。候補 mark の件数の増加だけでは進めない",
    ],
  };
  const trialSetupText = `${JSON.stringify(trialSetup, null, 2)}\n`;

  const contracts = contractTextsFor();
  const reference = (pop) => ({ load: "N", trigger: `population=${pop}; periodMs=${refPeriodMs}; 起点は host の観測（decode / checkpoint encode の開始）に対する投入側の実投入を後から照合する; ${Q.paintEvidence}`,
    stateRef: `${trialSetup.initialStateRef}#populations.${pop}`, stateSha256: trialSetup.initialStateSha256,
    targetOffsetMs: 1, acceptedOffsetRangeMs: [0, 5], ...Q.reference, stopCondition: { kind: "sampleCount", samples: Q.reference.samplesPerRun } });
  const differences = [];
  if (smoke.chrome.version !== chromeVersion) differences.push(`chrome.version: smoke ${smoke.chrome.version} / manifest ${chromeVersion}`);
  const manifest = {
    schemaVersion: "p2-eew-e01-manifest-v2", manifestId: id, manifestSha256: "0".repeat(64),
    contractSha256: Object.fromEntries(Object.entries(contracts).map(([cid, text]) => [cid, JSON.parse(text).meta.sha256])),
    trialSetupRef: `${dir}/trial-setup${suffix}.json`, trialSetupSha256: sha256Hex(trialSetupText),
    smokeConditionsSha256: smoke.conditionsSha256, smokeConditionDifferences: differences,
    measuredSseClients: 1, notificationProbe, loads,
    formal: {
      population: "fixedBacklog", load: "N",
      trigger: `population=fixedBacklog; periodMs=${periodMs}; 続報方式（同じ EventID の VXSE43 を Serial+1・予測 A/B 交互）を通常負荷 N の再生と同時に投入する; ${Q.paintEvidence}`,
      forecast: { subjects: Q.formalForecast.subjects, encodedBytes: Q.formalForecast.encodedBytes,
        saveCondition: "run 開始時に VPWP50 81_01_04 を 1 件入れ、以後 U-F は変更しない（保存は最初の tick で 1 回）",
        deadlineCondition: "U-F の validUntil は報告から 49 時間後で、測定中に期限は来ない", allowed: Q.formalForecast.allowed },
    },
    reference: { maxVpws50DecodeStarted: reference("maxVpws50DecodeStarted"), maxWeatherCheckpointEncodeStarted: reference("maxWeatherCheckpointEncodeStarted"),
      maxForecastCheckpointSave: reference("maxForecastCheckpointSave"), forecastDeadlineOverlap: reference("forecastDeadlineOverlap") },
    warmupPerRun: 100, samplesPerRun: 1000, runCount: 3, missingAfterMs: 10000, callbackDeadlineAfterInjectionMs: 10000,
    quantile: "nearestRank", clockProbeEveryMs: 30000, maxClockIntervalWidthMs: 5,
    health: Q.health,
    auxiliary: {
      E03: { loads: ["N"], minSamplesPerRun: E03_SERIES.samples, runCount: 3, condition: `N を再生しながら VPWS50 15_18_01 を ${E03_SERIES.periodMs}ms 周期で warm-up ${E03_SERIES.warmup}＋${E03_SERIES.samples} 件（initial-state の e03Series）。時刻は投入予定の host 壁時計へ平行移動。T2→dispatch 完了 p99≤1 秒、T1→T2 は別計数` },
      E05: { loads: ["N", "P"], minSamplesPerRun: null, runCount: 3, condition: "E02 と同じ窓。launcher の mem 行を 1 秒ごと。上限 N 300MiB・P 400MiB" },
      E06: { loads: ["C"], minSamplesPerRun: null, runCount: 1, condition: `保持上限ちょうど（nearCapacity cycleC）から C を 65 周期（initial-state の cycleC）。warm-up ${C_CYCLE.warmupCycles} 周期、定常開始（6 周期目の最初の入力の T0）から 60 分を 10 分 × 6 窓。RSS・heapUsed は mem 行（10 秒）、FD は lsof -n -P -p を 60 秒ごと。閾値は置かず報告` },
      E12: { loads: [], minSamplesPerRun: null, runCount: 3, condition: `小型 VXSE45 77_01_01 を ${E12_CLASSES.small.count} 件・${E12_CLASSES.small.intervalMs}ms（Serial +1）、大型 VPWP50 81_09_01 を ${E12_CLASSES.large.count} 件・${E12_CLASSES.large.intervalMs / 1000} 秒、最大 VPWS50 15_18_01 を ${E12_CLASSES.max.count} 件・${E12_CLASSES.max.intervalMs / 1000} 秒（weather は k 番目の全時刻を基準の壁時計 + k × 周期へ平行移動、frames.mjs e12Frames）。class ごとに旧新を別実行、空状態、同じ Node 22、--heap-prof。${E12_CONFIG_NOTE}` },
    },
    chrome: { version: chromeVersion, foregroundTab: true, viewportCssPx: [1440, 900], dpr: 2, motion: smoke.chrome.motion },
    nodeVersion, osVersion, device, geometrySha256: smoke.geometrySha256, fixtureSha256,
  };
  const manifestText = sealSelfHash(`${JSON.stringify(manifest, null, 2)}\n`, "manifestSha256");
  return { manifest: JSON.parse(manifestText), manifestText, trialSetupText, initialStateText, smokeText, contractTexts: contracts, nEvents: n };
}

// 予備測定の案。notificationProbe は run.mjs が実 run の probe 結果で入れ直して再封印する。P 用の空け数は予備で渡したとき（--room-*）だけ入る（無ければ null = 未凍結）。
export function buildDraft(args) {
  return buildManifest({ ...args, stage: "preliminary", room: args.room ?? null, notificationProbe: { desktop: "idle", sound: "idle" } });
}

// 凍結: 組み立て → verifyFrozenManifest → 既存ファイルを上書きせずに 3 つを書く。書いた path と manifest を返す。
export function freeze({ out, ...args }) {
  const counted = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
  if (!(counted(args.room?.partials, RES07.partials) && counted(args.room?.forecastSubjects, RES07.forecastSubjects)))
    throw new Error(`freeze: --room-partials（0..${RES07.partials}）と --room-forecast（0..${RES07.forecastSubjects}）、P が足す subject の数（予備で数えた値）が必要`);
  if (!["desktop", "sound"].every((k) => ["idle", "unavailable"].includes(args.notificationProbe?.[k]))) throw new Error("freeze: --notification-probe desktop=<idle|unavailable>,sound=<idle|unavailable>（real backend の凍結前スモークの結果）が必要");
  const built = buildManifest({ ...args, stage: "frozen" });
  verifyFrozenManifest({ manifestText: built.manifestText, trialSetupText: built.trialSetupText, smokeConditionsText: built.smokeText, contractTexts: built.contractTexts });
  const files = [["initial-state.json", built.initialStateText], ["trial-setup.json", built.trialSetupText], ["manifest.json", built.manifestText]];
  const existing = files.filter(([name]) => existsSync(join(out, name))).map(([name]) => name);
  if (existing.length > 0) throw new Error(`freeze: already exists in ${out}: ${existing.join(", ")}（凍結済みを上書きしない）`);
  for (const [name, text] of files) writeFileSync(join(out, name), text, { flag: "wx" });
  return { paths: files.map(([name]) => join(out, name)), manifest: built.manifest };
}

const NODE22 = "/opt/homebrew/opt/node@22/bin/node";
const run = (cmd, args) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args);
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.on("error", reject);
  child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} exited ${code}`))));
});

if (process.argv[1] != null && import.meta.filename === realpathSync(process.argv[1])) {
  const argv = process.argv.slice(2);
  const args = new Map();
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args.set(argv[i].slice(2), argv[i + 1]?.startsWith("--") || argv[i + 1] == null ? true : argv[++i]);
  if (!args.has("freeze") || typeof args.get("id") !== "string") {
    console.error("usage: node draft.mjs --freeze --id <manifestId> --room-partials <n> --room-forecast <n> --notification-probe desktop=<idle|unavailable>,sound=<idle|unavailable> [--out <dir>]");
    process.exit(2);
  }
  const int = (key) => (typeof args.get(key) === "string" ? Number(args.get(key)) : Number.NaN);
  const { chromeVersion } = await import("./chrome.mjs");
  const probe = Object.fromEntries(String(args.get("notification-probe") ?? "").split(",").map((kv) => kv.split("=")));
  const result = freeze({
    out: args.has("out") ? String(args.get("out")) : join(REPO, EVIDENCE), id: String(args.get("id")),
    chromeVersion: await chromeVersion(), nodeVersion: await run(NODE22, ["-p", "process.version"]),
    osVersion: `${release()} ${arch()}`, device: `${cpus()[0]?.model ?? "cpu"} x${cpus().length}, ${Math.round(totalmem() / 2 ** 30)}GiB`,
    room: { partials: int("room-partials"), forecastSubjects: int("room-forecast") }, notificationProbe: probe,
  });
  console.log(JSON.stringify({ written: result.paths, manifestId: result.manifest.manifestId, manifestSha256: result.manifest.manifestSha256 }));
}
