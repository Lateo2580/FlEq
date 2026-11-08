import { fork, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Interface } from "node:readline";
import { Writable } from "node:stream";
import { Worker } from "node:worker_threads";

import chalk from "chalk";

import type { ClockReading, RuntimeUnitId, RuntimeUnitView } from "../../contracts/p2-shared-runtime.types";
import type { EewLogField, HostCommandPort, HostStatus } from "../../contracts/p3-cli-repl.types";
import type { DmdataConnectFailure } from "../../contracts/p3-dmdata-connect.types";
import type { OwnerReply } from "../../contracts/p3-execution-split.types";
import type { RecoveryDigestView } from "../../contracts/p3-recovery.types";
import type { TerminalControl, TerminalReport } from "../../contracts/p3-terminal-output.types";
import { muteActive } from "../cli/notification-gate";
import type { NotificationSettings } from "../cli/notification-gate";
import { desktopNotice, resolveRepoPath } from "../notification-delivery/adapter";
import { colorLevel, painter } from "./color";
import { createEewLog } from "./eew-log";
import { intensityLabel, intensityRank, jsonRecord, jsonString, localClock } from "./format";
import type { SummaryCounts, TerminalBatch, TerminalNotice, TerminalUnit } from "./format";
import { currentItems, promptFrame } from "./prompt-current";
import type { PromptItem, PromptMirror } from "./prompt-current";
import { createTipShuffler } from "./tips";
import { checkForUpdate } from "./update-check";
import type { UpdateCheck } from "./update-check";

// P3-TO-AC02（O02、D-WRITER・D-DROP）: main は材料と行を有界の列に積み、worker の手が空いたら頭からまとめて 1 回送るだけ。
// 整形と fs.writeSync(1, …) は writer の worker が行う。無いと SSH の向こうの端末が止まったとき main の write(2) が止まり、受信と通知が止まる。
// RES-01: 列は 1 本で上限は 1 MiB の 1 つ。worker への 1 回の送りは 64 KiB まで（1 単位がそれより大きければその 1 単位だけ）。
// DLV-02: 停止の後は列の残りを最長 1 秒書かせる。
const QUEUE_BYTES = 1024 * 1024, SEND_BYTES = 64 * 1024, CLOSE_MS = 1_000;
// DLV-01: 回線の状態を 1 秒ごとに読む（変化を知らせる口は無い、P3-DC2-AC08 (7)）。要約の区切りと tips の待ちも同じ tick で見る。
// Q-TO-C-3: 30 分で 3 回切れたら「回線が不安定です」にまとめ、30 分続けて繋がるまで切断の通知を出さない。
const TICK_MS = 1_000, UNSTABLE_MS = 30 * 60_000, DEFAULT_TIP_MINUTES = 30;
const CHILD_LOST = "端末へ書き出す子プロセスが止まったため、この端末には電文や返事を出しません";

type InputDone = Extract<OwnerReply, { kind: "inputDone" }>;
// AC01 (4): host の config の terminal。返信を受けて列に積むだけ（AC08 (1)）。digest は publishDisplay が snapshot ごとに渡す（AC14 (1)）。
// mirror は参照を置き換えるだけ（P3-TP-AC06 (3)）。項目は promptLabel の中で作る。
type TerminalSink = Readonly<{ inputDone(reply: InputDone): void; digest(view: RecoveryDigestView | null): void; mirror(views: PromptMirror): void }>;
// AC02 (5): 試験で差し替える writer。done を呼ぶまで次を送らない。
type TerminalWriter = (batch: TerminalBatch, done: () => void) => void;
type TerminalOutput = Readonly<{
  sink: TerminalSink;
  // readline の output（AC02 (4)）。write は readline の echo と prompt で、D-DROP で数えない。
  output: NodeJS.WritableStream;
  // 数える 1 行（REPL の返事・起動の後の行）。
  line(text: string): void;
  // 電文のブロックの後に書き直す prompt と入力中の文字を、積む時に readline から写す。
  bind(readline: Interface): void;
  // 【発注 2】host の起動の後に 1 回: 回線の読み・定期要約・tips の時計を始め、update check を 1 回だけ非同期で始める。
  attach(host: Pick<HostCommandPort, "status">): void;
  control: TerminalControl;
  close(): Promise<void>;
  // 試験の口（T06）: 列の配列がまだ参照している単位の数。
  held(): number;
  // 【発注 3】列が空で、worker へ送った単位の書き込みも終わっている（O(1)）。入力の行の書き直しを詰まった端末に積まないため（P3-CLI-AC23 (3)）。
  drained(): boolean;
}>;

// AC08 (1): 積む時に 1 回だけ見積もる（JSON にしない）。文字列は UTF-8 の byte、ほかの値と入れ物は 8 byte。
// TerminalReport は件数の上限（RES-02）があり、EEW の facts は 1 報分なので、1 単位の中を辿るだけで受信 1 回の仕事は有界。
function estimate(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value);
  if (value == null || typeof value !== "object") return 8;
  let total = 8;
  for (const [key, item] of Object.entries(value)) total += Buffer.byteLength(key) + estimate(item);
  return total;
}
const counted = (unit: TerminalUnit): boolean => unit.kind !== "echo";
type ShortReport = Extract<TerminalReport, { kind: "short" }>;
// P3-TL8-AC04 (1)・AC05 (2): 全国の集約通報の帯と表に出す値（段・Control/Status・表の行・読まなかった予報区の数）が同じか。行と名前の数に比例するだけ。
// 注意報だけの報は行の予報区が空なので Kind の名前の並びだけを比べる（AC03 (1)）。
function sameNational(before: ShortReport, now: ShortReport): boolean {
  const left = before.national, right = now.national;
  return left != null && right != null && before.level === now.level && before.head.status === now.head.status && left.others === right.others
    && left.rows.length === right.rows.length && left.rows.every((row, index) => {
      const other = right.rows[index];
      return row.label === other.label && row.areas.length === other.areas.length && row.areas.every((name, at) => name === other.areas[at]);
    });
}
// P3-TL8-AC04 (3): その入力が U-W の通知の intent を作ったか（返信の U-W の pendingIntents は 128 件まで）。鳴ったのに画面に何も出ない列を作らない。
const rang = (reply: InputDone): boolean =>
  reply.output.units.find((delta) => delta.unit === "U-W")?.pendingIntents?.some((intent) => intent.source.inputId === reply.settlement.inputId) === true;
// P3-TL9-AC02 (2)・D-CANCEL-SOURCE: 地震の取消の報だけ、同じ返信の U-Q の accepted の outcome から取り消した地震の震源名と発生時刻を取る（outcomes の数に比例、AC06 (3)）。
// 無いと worker は U-Q の記録を読めず、取消の行に震源名を書けない。facts は丸ごと積まず 2 つの字だけにする。
type Cancelled = Extract<TerminalUnit, { kind: "report" }>["cancelled"];
function cancelledOf(reply: InputDone, report: TerminalReport): Cancelled {
  const eventId = report.kind === "seismic" && report.head.infoType === "取消" ? report.head.eventId?.trim() : undefined;
  if (eventId == null) return undefined;
  for (const { unit, outcome } of reply.output.outcomes) {
    if (unit !== "U-Q" || outcome.kind !== "accepted") continue;
    const facts = outcome.subjects.find((subject) => jsonString(subject.facts.eventId) === eventId)?.facts;
    if (facts == null) continue;
    const summary = jsonRecord(facts.cancelledSummary), hypocenter = jsonRecord(facts.hypocenter);
    // U-Q の cancelledSummary と同じ切り方（64 字、サロゲート対を割らない）。
    const name = jsonString(summary?.hypocenterName) ?? jsonString(hypocenter?.name), head = name?.slice(0, 64) ?? null;
    return { name: head != null && /[\ud800-\udbff]$/.test(head) ? head.slice(0, -1) : head,
      originTimeRaw: jsonString(summary?.originTimeRaw) ?? jsonString(facts.originTimeRaw) ?? jsonString(hypocenter?.originTimeRaw) };
  }
  return undefined;
}

// 【発注 2】の口。どれも省けば出さない（試験と測定の起動）。cli.ts は起動の時に読んだ値を渡す。
type TerminalOptions = Readonly<{
  write?: TerminalWriter;
  clock?: () => ClockReading;
  // AC10 (4): cli.ts が通知の門と REPL に渡している object と同じもの（その場で読む）。
  notification?: Readonly<NotificationSettings>;
  // 切断の通知の口（既定は adapter の desktopNotice。試験で差し替える）。
  notify?: (title: string, body: string) => Promise<void>;
  // AC11 (2)・AC12 (2): 分。0 か無しは出さない（tips の既定は 30 分）。
  summaryInterval?: number;
  tipInterval?: number;
  random?: () => number;
  // AC17 (1)
  debug?: boolean;
  // AC15: 置き場は settingsPaths().directory の下の eew-logs（P3-TO-D-LOGDIR）。
  eewLog?: Readonly<{ directory: string; enabled: boolean; fields: Readonly<Partial<Record<EewLogField, boolean>>> }>;
  // AC13: 無しは確かめない。
  updateCheck?: Omit<UpdateCheck, "now">;
  // P3-TL7-AC04: 起動画面（spec §6.7）。classifications は求めた区分で、偽の dmdata（FLEQ_WS_URL）では null（区分の行を出さない）。
  startup?: Readonly<{ appName: string; version: string; testMode: string; classifications: readonly string[] | null }>;
}>;

// AC11 (3)・P3-TO-D-SUMMARY: 分野は §6.2 の 6 つ。U-M の地震の解説（VXSE56・VXSE60・VZSE40）は地震に数える。
const summaryKind = (unit: RuntimeUnitId, headType: string): "eew" | "quake" | "tsunami" | "nankai" | "volcano" | "weather" =>
  unit === "U-E" ? "eew" : unit === "U-Q" || (unit === "U-M" && /^V[XZ]SE/.test(headType)) ? "quake" : unit === "U-T" ? "tsunami"
    : unit === "U-N" ? "nankai" : unit === "U-V" ? "volcano" : "weather";
const unitOf = (report: TerminalReport): RuntimeUnitId => report.kind === "seismic" ? "U-Q" : report.kind === "tsunami" ? "U-T" : report.unit;
// 区切りは interval の分の境目（地方時の 0 時から数える、P3-TO-D-SUMMARY）。
function nextBoundary(afterMs: number, minutes: number): number {
  const at = new Date(afterMs);
  return new Date(at.getFullYear(), at.getMonth(), at.getDate(), 0, (Math.floor((at.getHours() * 60 + at.getMinutes()) / minutes) + 1) * minutes).getTime();
}
const hms = (ms: number): string => {
  const total = Math.floor(Math.max(0, ms) / 1000);
  return [Math.floor(total / 3600), Math.floor(total % 3600 / 60), total % 60].map((part) => String(part).padStart(2, "0")).join(":");
};
const uptime = (ms: number): string => {
  const total = Math.floor(Math.max(0, ms) / 1000);
  return `${String(Math.floor(total / 86400)).padStart(3, "0")}:${hms((total % 86400) * 1000)}`;
};

function createTerminalOutput(options: TerminalOptions = {}): TerminalOutput {
  const tty = process.stdout.isTTY === true;
  const clock = options.clock ?? (() => ({ wallTimeMs: Date.now(), monotonicMs: performance.now() }));
  const level = colorLevel(process.env.NO_COLOR, tty, chalk.level);
  // 送った・落とした枠は undefined にして単位の参照を残さない（残すと送り終えた材料が列の配列に溜まる）。
  const queue: ({ unit: TerminalUnit; bytes: number } | undefined)[] = [];
  let head = 0, bytes = 0, dropped = 0, inFlight = false, failed = false;
  let readline: Interface | null = null, idle: (() => void) | null = null, closing: Promise<void> | null = null;
  let pending: (() => void) | null = null;
  let worker: Worker | null = null, child: ChildProcess | null = null;
  let post: (batch: TerminalBatch) => void = () => {};
  let lastOutputMs = clock().monotonicMs;
  // P3-TL8-AC04 (4)(7)・D-MEMORY: 最後に積んだ全国の集約通報の参照（保存しない）。push の前に置き、push がその単位を落としたら消す。
  let national: ShortReport | null = null;
  const fail = () => {
    if (failed) return;
    // AC02 (2): worker が落ちても process は落とさず、受信も止めない。以後は積まずに数えるだけ。
    failed = true;
    inFlight = false;
    pending = null;
    for (let index = head; index < queue.length; index += 1) if (counted(queue[index]!.unit)) dropped += 1;
    queue.length = 0;
    head = 0;
    bytes = 0;
    idle?.();
  };
  const reply = () => { const done = pending; pending = null; done?.(); };
  // P3-TW-AC04: 起動の失敗・途中の消滅・IPC の切断をここに集める。知らせを main が書くと字の選択の WriteConsoleW で受信が止まり、
  // 切れた pipe の error で main が落ちるので、1 回限りの別の子に書かせる。
  const lostChild = () => {
    if (failed) return;
    fail();
    child?.kill();
    if (closing != null) return;
    try {
      spawn(process.execPath, ["-e", "process.stderr.write(process.argv[1])", `${CHILD_LOST}\n`], { stdio: ["ignore", "ignore", "inherit"] })
        .on("error", () => {}).unref();
    } catch { /* 諦める。知らせなしになる（P3-TW-D-FAIL） */ }
  };
  if (options.write == null && process.platform === "win32") {
    // P3-TW-D-WRITER・D-NONTTY: Windows は fd 1 が何でも子が書く（worker の fs.writeSync だと pipe で終われず、TTY は日本語が化ける）。
    try {
      const started = fork(resolveRepoPath("reconstruction/dist/src/terminal/writer-child.js"), [String(level)],
        { stdio: ["ignore", "inherit", "ignore", "ipc"], serialization: "advanced" });
      child = started;
      started.unref();
      started.channel?.unref();
      started.on("message", reply);
      started.on("error", lostChild);
      started.on("exit", lostChild);
      started.on("disconnect", lostChild);
      post = (batch) => { started.send(batch, (error) => { if (error != null) lostChild(); }); };
    } catch { lostChild(); }
  } else if (options.write == null) {
    const started = new Worker(resolveRepoPath("reconstruction/dist/src/terminal/writer-worker.js"),
      { workerData: { level } });
    worker = started;
    started.unref();
    started.on("message", reply);
    started.on("error", fail);
    started.on("exit", fail);
    post = (batch) => { started.postMessage(batch); };
  }
  const write: TerminalWriter = options.write ?? ((batch, done) => { pending = done; post(batch); });
  // 頭の index で読み、半分を越えて読んだら詰める（落とす・送るたびに配列の先頭を消すと全件の移し替えになる）。
  const compact = () => {
    if (head > 1024 && head * 2 > queue.length) { queue.splice(0, head); head = 0; }
  };
  const take = (): { unit: TerminalUnit; bytes: number } => {
    const item = queue[head]!;
    queue[head] = undefined;
    head += 1;
    bytes -= item.bytes;
    if (head === queue.length) { queue.length = 0; head = 0; }
    return item;
  };
  const kick = (): void => {
    if (inFlight) return;
    if (failed || head === queue.length) { idle?.(); return; }
    const units: TerminalUnit[] = [];
    let size = 0;
    while (head < queue.length && (units.length === 0 || size + queue[head]!.bytes <= SEND_BYTES)) {
      const item = take();
      units.push(item.unit);
      size += item.bytes;
    }
    compact();
    // AC04 (1): 桁数は送る時に読む（無ければ 80）。途中で端末の大きさが変われば次の送りから合う。
    const batch: TerminalBatch = { columns: process.stdout.columns || 80, dropped, units };
    dropped = 0;
    inFlight = true;
    write(batch, () => { inFlight = false; kick(); });
  };
  // D-DROP: 越えたら種類によらず古い単位から丸ごと落とす。上限より大きい 1 単位は積まずに落とす。echo と prompt は数えない。
  const push = (unit: TerminalUnit): void => {
    // P3-CLI-AC27 (2): tips の待ちの起点は数える単位だけが動かす（入力の echo と入力の行の書き直しは「何かを出した」に数えない）。
    if (counted(unit)) lastOutputMs = clock().monotonicMs;
    const size = failed ? 0 : estimate(unit);
    // P3-TL8-AC04 (6): 覚えた全国の集約通報の単位を落としたら覚えを消す（参照の比べ 1 回）。無いと画面に無い報と比べて次の同じ報を出さない。
    if (failed || size > QUEUE_BYTES) { if (counted(unit)) dropped += 1; if (unit.kind === "report" && unit.report === national) national = null; return; }
    while (bytes + size > QUEUE_BYTES) { const old = take().unit; if (counted(old)) dropped += 1; if (old.kind === "report" && old.report === national) national = null; }
    queue.push({ unit, bytes: size });
    bytes += size;
    compact();
    kick();
  };
  const promptOf = (): string | null => tty && readline != null ? readline.getPrompt() + readline.line : null;
  const output = new Writable({ decodeStrings: false, write(chunk: string | Buffer, _encoding, callback) {
    push({ kind: "echo", text: String(chunk) });
    callback();
  } });
  // readline は isTTY で行編集の形を、columns で折り返しを決める（process.stdout の値を返す）。
  Object.defineProperties(output, { isTTY: { value: tty }, columns: { get: () => process.stdout.columns }, rows: { get: () => process.stdout.rows } });
  const resize = () => { output.emit("resize"); };
  process.stdout.on("resize", resize);
  const notice = (item: TerminalNotice) => { push({ kind: "notice", notice: item, prompt: promptOf() }); };

  // ---- 定期要約（AC11、P3-TO-D-SUMMARY）: 分野ごとの件数と最大震度の 7 つの数だけを持つ（受信 1 回で O(1)） ----
  const created = clock();
  let counts = { eew: 0, quake: 0, tsunami: 0, nankai: 0, volcano: 0, weather: 0, maxInt: null as string | null };
  let summaryMinutes = options.summaryInterval ?? 0, nextSummaryMinutes = summaryMinutes, periodStart = created.wallTimeMs;
  let boundary: number | null = summaryMinutes > 0 ? nextBoundary(periodStart, summaryMinutes) : null;
  const summarize = (toMs: number) => {
    const done: SummaryCounts = { ...counts };
    notice({ kind: "summary", fromWallMs: periodStart, toWallMs: toMs, counts: done });
    counts = { eew: 0, quake: 0, tsunami: 0, nankai: 0, volcano: 0, weather: 0, maxInt: null };
    periodStart = toMs;
  };
  // 区切りを過ぎていたら前の時間の要約を出して区切りを進める（tick と数える前の両方で見る）。
  // 無いと tick の間（最長 1 秒）に区切りを過ぎた受信が前の時間に数えられる。
  const roll = (nowMs: number) => {
    if (boundary == null || nowMs < boundary) return;
    const ended = boundary;
    summarize(ended);
    summaryMinutes = nextSummaryMinutes;
    boundary = summaryMinutes > 0 ? nextBoundary(Math.max(ended, nowMs), summaryMinutes) : null;
  };
  // nowMs は受信 1 回で 1 回だけ読んだ時刻（読み直すと区切りの直前の受信が、報の後に区切りを越えて次の時間に数えられる）。
  const count = (unit: RuntimeUnitId, headType: string, maxInt: string | null, nowMs: number) => {
    roll(nowMs);
    counts[summaryKind(unit, headType)] += 1;
    const label = maxInt == null || maxInt === "" ? null : intensityLabel(maxInt);
    if (unit === "U-Q" && label != null && intensityRank(label) > (counts.maxInt == null ? -1 : intensityRank(counts.maxInt))) counts.maxInt = label;
  };

  // ---- tips（AC12） ----
  let tipMs = (options.tipInterval ?? DEFAULT_TIP_MINUTES) * 60_000;
  const tips = createTipShuffler(options.random);

  // ---- 回線（AC10） ----
  const settings = options.notification;
  const notify = options.notify ?? desktopNotice;
  let host: Pick<HostCommandPort, "status"> | null = null, status: HostStatus | null = null, timer: NodeJS.Timeout | null = null, closed = false;
  // P3-TL7-D-SESSION-ONCE: 区分の行は最初の確立で 1 回だけ。繋ぎ直しは §6.1 の回線の行が受け持つ。
  let sessionShown = false;
  const titled = tty && options.startup != null;
  let seenLost = 0, down = false, lostFrom: number | null = null, shownFailure: DmdataConnectFailure | null = null, received = false;
  let unstable = false, upSince: number | null = null, lastReportWallMs: number | null = null, attachedWallMs = created.wallTimeMs;
  // RET-02: 覚える切断の時刻は直近 3 つ（monotonic）。
  const losses: number[] = [];
  // P3-TO-D-CONN-NOTIFY（作者裁定 A）: 分野 connection が off か mute の間（rules によらない）は出さない。
  // 分野 connection の key（C18 の NotifyCategory）が無ければ on。
  const notifyAllowed = (now: ClockReading): boolean => {
    if (settings == null) return true;
    return settings.notify.connection !== false && !muteActive(settings, now.monotonicMs);
  };
  const lost = (fromWallMs: number | null, now: ClockReading) => {
    upSince = null;
    losses.push(now.monotonicMs);
    if (losses.length > 3) losses.shift();
    if (unstable) return;
    const third = losses.length === 3 && now.monotonicMs - losses[0] <= UNSTABLE_MS;
    if (third) unstable = true;
    if (!notifyAllowed(now)) return;
    notify("FlEq", third ? "回線が不安定です（30 分で 3 回切れました）" : `回線が切れました（${localClock(fromWallMs ?? now.wallTimeMs)} から受信できていません）`).catch(() => {});
  };
  const read = (now: ClockReading) => {
    if (host == null) return;
    const next = host.status();
    status = next;
    const { startup } = options, granted = next.classifications;
    if (!sessionShown && startup?.classifications != null && next.connection === "connected" && next.socketId != null && granted != null) {
      sessionShown = true;
      notice({ kind: "session", socketId: next.socketId, classifications: granted, missing: startup.classifications.filter((name) => !granted.includes(name)), testMode: startup.testMode });
    }
    // AC10 (5): 一度も受信していない間だけ、理由が変わったときに 1 回出す。
    if (next.lastFrameWallMs != null) received = true;
    else if (!received && next.lastFailure != null && next.lastFailure !== shownFailure) {
      shownFailure = next.lastFailure;
      notice({ kind: "failure", reason: next.lastFailure });
    }
    // AC10 (2): 増えた数だけ行を出す。時刻は切断の時点で固めた最後の受信（読む前に新しい接続の frame で上書きされうる lastFrameWallMs は使わない）。
    for (; seenLost < next.lostConnections; seenLost += 1) {
      down = true;
      lostFrom = next.lastLossFrameWallMs;
      notice({ kind: "lost", fromWallMs: next.lastLossFrameWallMs, noticedWallMs: now.wallTimeMs });
      lost(next.lastLossFrameWallMs, now);
    }
    if (next.connection === "connected") {
      if (down) { down = false; notice({ kind: "restored", fromWallMs: lostFrom, toWallMs: now.wallTimeMs }); }
      upSince ??= now.monotonicMs;
      if (unstable && now.monotonicMs - upSince >= UNSTABLE_MS) unstable = false;
    } else upSince = null;
  };
  const tick = () => {
    const now = clock();
    read(now);
    roll(now.wallTimeMs);
    // AC12 (2): 最後に何かを出してから間隔の分だけ何も出していないときに 1 つ。
    if (tipMs > 0 && now.monotonicMs - lastOutputMs >= tipMs) notice({ kind: "tip", text: tips.next() });
  };

  // ---- 入力の行の現況（P3-TERMINAL-PROMPT-001）: 最新の mirror の参照と、それから作った項目。受信の数によらず promptLabel の回数でだけ作り直す ----
  let mirror: PromptMirror | null = null, itemsMirror: PromptMirror | null = null, items: readonly PromptItem[] = [];
  // Q-TO6-COLOR: 色の水準は writer と同じ。TTY でなければ字を変えない。
  const paint = painter(tty ? level : 0);
  const itemMemo = new WeakMap<RuntimeUnitView, readonly PromptItem[]>();

  const eewLog = options.eewLog == null ? null : createEewLog({ ...options.eewLog, clock });
  const control: TerminalControl = {
    // 次の区切りから効く。止まっている間に入れたら今から数え始める。
    // 0 はその場で止め、数と区切りを捨てる（区切りに 1 行を出さない。P3-CLI-D-O3-SUMMARY-OFF=A）。
    setSummaryInterval(minutes) {
      nextSummaryMinutes = minutes;
      if (minutes === 0) {
        summaryMinutes = 0;
        boundary = null;
        counts = { eew: 0, quake: 0, tsunami: 0, nankai: 0, volcano: 0, weather: 0, maxInt: null };
        periodStart = clock().wallTimeMs;
        return;
      }
      if (boundary == null && minutes > 0) {
        const now = clock().wallTimeMs;
        counts = { eew: 0, quake: 0, tsunami: 0, nankai: 0, volcano: 0, weather: 0, maxInt: null };
        summaryMinutes = minutes;
        periodStart = now;
        boundary = nextBoundary(now, minutes);
      }
    },
    // P3-CLI-AC27 (1): 区切りを過ぎていれば、その区切りの 1 行を今の要約にして区切りを進める（期限の過ぎた区切りを残すと次の tick が空の 1 行を出す）。
    summaryNow() {
      const now = clock().wallTimeMs;
      if (boundary != null && now >= boundary) roll(now); else summarize(now);
    },
    setTipInterval(minutes) { tipMs = minutes * 60_000; },
    setEewLog(enabled, fields) { eewLog?.set(enabled, fields); },
    // 画面を消す制御の列も同じ書き出しの列に積む（直に書くと列の順を追い越す）。画面から消えた全国の集約通報の覚えも消す（P3-TL8-AC04 (6)）。
    clear() { national = null; push({ kind: "echo", text: "\x1b[2J\x1b[H" }); },
    // P3-TO-D-PROMPT: 文字を作るだけ（readline の prompt に当てるのは C18 の発注 3）。色は現況の項目と番号と切断の字と回線の印（Q-TO8-PULSE）で、太字は項目の区分の字だけ（Q-TO6-COLOR）。
    // readline は prompt の幅を制御の字を除いて数えるので、色の符号でカーソルはずれない。
    // P3-TL-AC10: ミュート中は後ろに足す（期限は repl.ts の muteStartLine と同じ換算）。切断中は 56 桁に入るよう繋ぎ直しの回数と期限と条件を外す。
    promptLabel(mode) {
      if (status == null) return "FlEq> ";
      const now = clock(), mute = settings?.mute;
      const muted = settings != null && mute != null && muteActive(settings, now.monotonicMs);
      if (mirror != null && mirror !== itemsMirror) { itemsMirror = mirror; items = currentItems(mirror, itemMemo); }
      const columns = process.stdout.columns || 80;
      if (down) {
        const from = lostFrom == null ? "--:--:--" : localClock(lostFrom), state = muted ? "ミュート中" : `繋ぎ直し ${status.failedAttempts} 回目`;
        return promptFrame(items, { full: `${from} から 切断中・${state}`, narrow: "切断中", spare: `切断中 ${from} から・${state}`, bare: null, role: "connLost", mark: null }, columns, now.wallTimeMs, paint);
      }
      const until = muted && mute.endsAtMonotonicMs != null ? ` ${localClock(now.wallTimeMs + (mute.endsAtMonotonicMs - now.monotonicMs)).slice(0, 5)} まで` : "";
      const mark = muted ? ` ミュート中${mute.rules.length > 0 ? "（条件つき）" : ""}${until}` : "";
      // live は印が ● の形（繋がっているか、時計の形で受信がある）。時刻を --:--:-- にするかはこれで決め、字形では決めない（P3-TL7-AC03 (2)）。
      const live = status.connection === "connected" || (mode !== "uptime" && received);
      const time = mode === "uptime" ? uptime(process.uptime() * 1000) : !live ? "--:--:--"
        : mode === "clock" ? localClock(now.wallTimeMs) : hms(now.wallTimeMs - (lastReportWallMs ?? attachedWallMs));
      // Q-TO8-PULSE: 旧築の 1 秒の tick の入れ替えを、時計の秒の偶奇で決める（タイマーと状態を持たない。入力の行の書き直しは repl.ts の 1 秒ごと）。
      const on = live && Math.floor(now.wallTimeMs / 1000) % 2 === 0, dot = on ? "●" : "○";
      return promptFrame(items, { full: `${dot} ${time}${mark}`, narrow: `${dot} ${time}`, spare: muted ? `${dot} ${time}${mark}` : null, bare: dot, role: null, mark: on ? "pulse" : "dim" }, columns, now.wallTimeMs, paint);
    },
  };

  // P3-TL7-AC04 (1)(2): 帯は host を起こす前に出す（旧築も契約の確かめの前）。端末の題名は旧築 src/ui/terminal-title.ts の OSC 2 で、close で戻す。
  if (options.startup != null) {
    if (titled) push({ kind: "echo", text: `\x1b]2;${options.startup.appName} v${options.startup.version}\x07` });
    notice({ kind: "banner", appName: options.startup.appName, version: options.startup.version });
  }
  let digestShown = false;
  return {
    sink: { inputDone(reply) {
      // AC08 (1): 返信の terminal の参照と、その返信の outcomes のうち U-E のもの（facts.report を持つ）を積むだけ。
      // P3-CLI-AC27 (1): 区切りを過ぎていれば、前の時間の要約を報より先に積む。時刻はこの 1 回だけ読む。
      const nowMs = clock().wallTimeMs;
      roll(nowMs);
      const prompt = promptOf();
      let shown: { unit: RuntimeUnitId; headType: string } | null = null, repeated: { unit: RuntimeUnitId; headType: string } | null = null;
      if (reply.terminal != null) {
        const report = reply.terminal, taken = { unit: unitOf(report), headType: report.head.headType };
        // P3-TL8-AC04: 全国の集約通報は最後に積んだ報と同じなら積まない（(3) その入力が通知の intent を作ったら比べない）。
        // 積む報は push の前に覚えにし（(7)）、取消と層の無い報は覚えを消す（(6)）。積まなかった報も定期要約に数える（(8)）。
        const nationwide = report.kind === "short" && report.head.headType === "VPWS50" ? report : null;
        if (nationwide != null && national != null && sameNational(national, nationwide) && !rang(reply)) repeated = taken;
        else {
          if (nationwide != null) national = nationwide.national == null ? null : nationwide;
          const cancelled = cancelledOf(reply, report);
          push({ kind: "report", report, prompt, ...cancelled == null ? {} : { cancelled } });
          shown = taken;
        }
        count(taken.unit, taken.headType, report.kind === "seismic" ? report.maxInt ?? report.maxIntCondition : null, nowMs);
      }
      for (const { unit, outcome } of reply.output.outcomes) {
        if (unit !== "U-E" || outcome.kind !== "accepted" || outcome.change === "deliveryOnly") continue;
        for (const subject of outcome.subjects) {
          if (subject.facts.report == null) continue;
          push({ kind: "eew", subject, prompt, nowMs });
          shown = { unit, headType: typeof subject.facts.family === "string" ? subject.facts.family : subject.source?.family ?? "VXSE" };
          count(unit, shown.headType, null, nowMs);
          eewLog?.record(subject);
        }
      }
      const { inputId } = reply.settlement;
      // P3-TO-D-UNREADABLE（作者裁定 A）: 何も出さなかった入力だけ、その入力の unreadable・unidentified のカードを返信の view から探す（views は変わった unit だけ）。
      let card: Readonly<{ unit: RuntimeUnitId; headType: string }> | null = null;
      if (shown == null && repeated == null) {
        for (const delta of reply.output.units) {
          const found = delta.view?.unreadableCards?.find((item) => item.inputId === inputId && item.kind !== "unknownType");
          if (found != null) { push({ kind: "unreadable", card: found, prompt }); card = { unit: delta.unit, headType: found.headType }; break; }
        }
      }
      if (shown != null) lastReportWallMs = nowMs;
      // AC17 (1): 出さない理由は取り直し（owner の recoveryInput は decode を持たない返信）か採らなかったか、全国の集約通報の前と同じ（P3-TL8-AC04 (8)）。
      if (options.debug === true) {
        // 返信が種類のコードを持たない入力（採らなかった入力・取り直し）は、種類のコードと unit を書かない（「不明」とは出さない）。
        const known = shown ?? repeated ?? card;
        const result = shown != null ? "出した" : repeated != null ? "出さない・前と同じ" : `出さない・${reply.decode == null ? "取り直し" : "採らなかった"}`;
        notice({ kind: "debug", text: known == null ? `debug: ${inputId}（${result}）` : `debug: ${known.headType} ${inputId}（${known.unit}、${result}）` });
      }
    }, digest(view) {
      // P3-TO-D-DIGEST: null から値になった最初の 1 回だけ。
      if (digestShown || view == null) return;
      digestShown = true;
      notice({ kind: "digest", digest: view });
    }, mirror(views) { mirror = views; } },
    output,
    control,
    line: (text) => { push({ kind: "line", text }); },
    held: () => queue.filter((item) => item != null).length,
    drained: () => !inFlight && head === queue.length,
    bind(next) {
      readline = next;
      next.once("close", () => { if (readline === next) readline = null; });
    },
    attach(next) {
      if (closed || host != null) return;
      host = next;
      attachedWallMs = clock().wallTimeMs;
      read(clock());
      // 時計は process の終わりを延ばさない（unref、close で止める）。
      timer = setInterval(tick, TICK_MS);
      timer.unref();
      // AC13 (2): 起動と受信を待たせず 1 回だけ。close の後に返った答えは出さない。
      if (options.updateCheck != null) {
        void checkForUpdate({ ...options.updateCheck, now: () => clock().wallTimeMs }).then((found) => {
          if (found != null && !closed) notice({ kind: "update", ...found });
        });
      }
    },
    // AC02 (6): 列の残りを最長 1 秒書かせる。返事が来なければ（worker が同期の write(2) の中で止まっている）待たずに終える。
    close() {
      closing ??= new Promise<void>((resolve) => {
        if (titled) push({ kind: "echo", text: "\x1b]2;\x07" });
        closed = true;
        if (timer != null) clearInterval(timer);
        process.stdout.off("resize", resize);
        // AC15 (1): 開いている EventID を「シャットダウン」で閉じ、同じ 1 秒の内で書き終わりを待つ。
        const logs = eewLog?.close() ?? Promise.resolve();
        let drained = false, logged = false, ended = false;
        const end = (finished: boolean) => {
          if (ended) return;
          ended = true;
          clearTimeout(deadline);
          idle = null;
          queue.length = 0;
          head = 0;
          bytes = 0;
          // P3-TW-D-CLOSE: 子の消滅を待たない（Windows の仕様が時刻を保証しない）。
          if (child != null) { child.kill(); resolve(); return; }
          if (worker == null) { resolve(); return; }
          worker.off("exit", fail);
          if (finished) { worker.terminate().then(() => resolve(), () => resolve()); return; }
          worker.unref();
          worker.terminate().catch(() => {});
          resolve();
        };
        const deadline = setTimeout(() => end(false), CLOSE_MS);
        const settle = () => { if (drained && logged) end(true); };
        void logs.then(() => { logged = true; settle(); });
        idle = () => { drained = true; settle(); };
        if (failed || (!inFlight && head === queue.length)) { drained = true; settle(); }
      });
      return closing;
    },
  };
}

export { createTerminalOutput, estimate };
export type { TerminalOptions, TerminalOutput, TerminalSink, TerminalWriter };
