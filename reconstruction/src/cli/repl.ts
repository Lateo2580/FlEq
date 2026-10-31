import { createInterface } from "node:readline";

import type { ClockReading } from "../../contracts/p2-shared-runtime.types";
import type { FleqSettings, HostCommandPort, HostStatus, LegacyNotifyCategory, MuteRule, PersistedMute, ReplCommand, ReplParse } from "../../contracts/p3-cli-repl.types";
import { muteActive, notifyEnabled } from "./notification-gate";
import type { NotificationSettings } from "./notification-gate";
import { createSettingsSaver, NOTIFY_CATEGORIES, rereadSettings, showLines } from "./settings";

// P3-CLI-AC12・AC14・AC15・AC18: 標準入力の REPL。1 行は parseReplLine の 1 か所で ReplCommand に変え（B12）、行き先は CLI の通知の設定と
// host の command port の 2 つだけ（P3-CLI-D-O2-COMMAND）。返事の文は今までの fleq の文を色なしで写す（P3-CLI-D-O2-TEXT）。

const DAY_MS = 86_400_000;
// P3-CLI-RES-03: openDisplay・closeDisplay の待ち（置き値）。
const COMMAND_DEADLINE_MS = 5_000;

// 旧築 NOTIFY_CATEGORY_LABELS（notifier.ts）。並びは notify の一覧の並び。
const LABELS: Readonly<Record<LegacyNotifyCategory, string>> = {
  eew: "緊急地震速報", earthquake: "地震情報", tsunami: "津波情報", seismicText: "地震活動テキスト", nankaiTrough: "南海トラフ関連",
  lgObservation: "長周期地震動", volcano: "火山情報", weather: "気象警報・注意報", tornado: "竜巻注意情報", briefing: "気象防災速報",
  earlyWeather: "早期天候情報", weatherWarningTimeseries: "気象警報・注意報時系列", climateInfo: "天候情報", weatherExplanation: "気象解説情報",
  heatAlert: "熱中症警戒アラート", typhoonAnalysis: "台風解析・予報情報", typhoonProbability: "台風の暴風域に入る確率", floodForecast: "洪水予報",
};
// 旧築 CATEGORY_ALIASES（info-handlers.ts）。
const CATEGORY_ALIASES: ReadonlyMap<string, LegacyNotifyCategory> = new Map<string, LegacyNotifyCategory>([
  ["eq", "earthquake"], ["tsu", "tsunami"], ["st", "seismicText"], ["nt", "nankaiTrough"], ["lgob", "lgObservation"], ["wwt", "weatherWarningTimeseries"],
  ["ew", "earlyWeather"], ["ci", "climateInfo"], ["we", "weatherExplanation"], ["ha", "heatAlert"], ["ta", "typhoonAnalysis"],
]);
const MUTE_LEVELS: readonly MuteRule["level"][] = ["normal", "warning", "critical"];
// AC15 (3): H 表の音の名前。
const LEVEL_WORDS: Readonly<Record<MuteRule["level"], string>> = { normal: "普通の音以上", warning: "警報の音以上", critical: "最も重い音" };

type Group = "info" | "status" | "settings" | "operation";
const GROUP_LABELS: Readonly<Record<Group, string>> = { info: "情報", status: "ステータス", settings: "設定", operation: "操作" };
type Entry = Readonly<{ name: string; kind: ReplCommand["kind"]; group: Group; description: string; detail?: string; alias?: string;
  subcommands?: Readonly<Record<string, string>> }>;
// 旧築 command-definitions.ts の 12 入口（並びも旧築の定義の順）。mute の詳細と下位操作は AC12 (3) の形（AC14 (1)）。
const ENTRIES: readonly Entry[] = [
  { name: "help", kind: "help", group: "info", description: "コマンドの詳細を表示 (例: help notify)",
    detail: "help <command>: コマンドの詳細を表示\n  help <command> <sub>: サブコマンドの詳細を表示\n  一覧は commands コマンドで表示できます。" },
  { name: "commands", kind: "commands", group: "info", description: "コマンド一覧を表示 (例: commands settings)", alias: "cmds",
    detail: "引数なし: 全コマンドをカテゴリ別に一覧表示\n  commands <category>: カテゴリで絞り込み (info / status / settings / operation)\n  commands <query>: 名前・説明で検索" },
  { name: "?", kind: "help", group: "info", description: "help のエイリアス" },
  { name: "status", kind: "status", group: "status", description: "WebSocket 接続状態を表示", alias: "stat",
    detail: "現在の WebSocket 接続状態、SocketID、再接続試行回数を表示します。" },
  { name: "config", kind: "config", group: "status", description: "現在の設定を表示", alias: "conf", detail: "Configファイルに保存された設定を一覧表示します。" },
  { name: "notify", kind: "notify", group: "settings", description: "通知設定の表示・切替 (例: notify eew on)", alias: "noti",
    detail: `引数なし: 現在の通知設定を一覧表示\n  notify <category>: トグル切替\n  notify <category> on: 有効にする\n  notify <category> off: 無効にする\n  notify all:on / all:off: 一括操作\n  カテゴリ: ${NOTIFY_CATEGORIES.join(", ")}`,
    subcommands: { "<category>": "トグル切替 / on / off", "all:on": "全カテゴリを有効にする", "all:off": "全カテゴリを無効にする" } },
  { name: "sound", kind: "sound", group: "settings", description: "通知音の ON/OFF 切替", alias: "snd",
    detail: "sound: 現在の状態を表示\n  sound on: 通知音を有効にする\n  sound off: 通知音を無効にする",
    subcommands: { on: "通知音を有効にする", off: "通知音を無効にする" } },
  { name: "mute", kind: "mute", group: "settings", description: "通知を一時ミュート (例: mute 30m)",
    detail: "mute: 時間の制限なしでミュート (mute off まで)\n  mute <duration>: 指定時間ミュート (例: 30m, 1h, 90s)\n  mute [<duration>] <category>:<normal|warning|critical>[,...]: 条件に当たる通知だけ鳴らしてミュート\n  mute off: ミュート解除",
    subcommands: { "<duration>": "指定時間ミュート (例: 30m, 1h)", "<category>:<level>": "条件に当たる通知だけ鳴らしてミュート", off: "ミュート解除" } },
  { name: "retry", kind: "retry", group: "operation", description: "WebSocket 再接続を試行", detail: "切断中の場合に手動で再接続を試みます。" },
  { name: "display", kind: "display", group: "operation", description: "情報ディスプレイの状態表示 / 起動 / 停止",
    detail: "display: サーバの稼働状態・ポート・接続クライアント数を表示\n  display on: ディスプレイサーバを起動\n  display off: ディスプレイサーバを停止",
    subcommands: { on: "ディスプレイサーバを起動", off: "ディスプレイサーバを停止" } },
  { name: "quit", kind: "quit", group: "operation", description: "アプリケーションを終了" },
  { name: "exit", kind: "quit", group: "operation", description: "quit のエイリアス" },
];
// 一覧・候補に出さない別名の入口（旧築と同じ）。
const HIDDEN = new Set(["?", "exit"]);

const MUTE_USAGE = "  使い方: mute / mute <時間> / mute [<時間>] <category>:<normal|warning|critical>[,...] / mute off（時間の例: 30m, 1h, 90s）";
const NOTIFY_USAGE = "  使い方: notify <category> [on|off] / notify all:on / notify all:off";

const out = (line: string) => { process.stdout.write(`${line}\n`); };
const invalid = (message: string): ReplParse => ({ kind: "invalid", message });
const command = (parsed: ReplCommand): ReplParse => ({ kind: "command", command: parsed });

function entryOf(word: string): Entry | undefined {
  const lower = word.toLowerCase();
  return ENTRIES.find((entry) => entry.name === lower) ?? ENTRIES.find((entry) => entry.alias === lower);
}
function categoryOf(word: string): LegacyNotifyCategory | null {
  const lower = word.toLowerCase();
  return NOTIFY_CATEGORIES.find((category) => category.toLowerCase() === lower) ?? CATEGORY_ALIASES.get(lower) ?? null;
}

// 旧築 src/ui/repl.ts の levenshtein と同じ（typo の候補）。
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length];
}
function suggestion(word: string): string | null {
  let best: string | null = null, bestDistance = 3;
  for (const entry of ENTRIES) {
    if (HIDDEN.has(entry.name)) continue;
    const found = distance(word.toLowerCase(), entry.name);
    if (found < bestDistance) { bestDistance = found; best = entry.name; }
  }
  return best;
}

// 旧築 settings-handlers.ts の parseDuration の書式に 24 時間の上限を足した（P3-CLI-D-O2-MUTE）。桁の多い数は Infinity になり上限で断る。
function durationOf(text: string): number | string {
  const match = /^(\d+)(s|m|h)$/.exec(text);
  if (match == null) return "  無効な時間指定です。例: 30m, 1h, 90s";
  const ms = Number(match[1]) * (match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000);
  if (!(ms > 0)) return "  無効な時間指定です。例: 30m, 1h, 90s";
  if (ms > DAY_MS) return "  ミュートは 24 時間（24h・1440m・86400s）までです。";
  return ms;
}
// <分野>:<段>[,…]。同じ組の重複は最初の 1 つに寄せる。空の項を含む区切りの誤りは null。
function rulesOf(text: string): MuteRule[] | null {
  const rules: MuteRule[] = [];
  for (const item of text.split(",")) {
    const parts = item.split(":");
    const category = parts.length === 2 ? categoryOf(parts[0]) : null;
    const level = parts.length === 2 ? MUTE_LEVELS.find((candidate) => candidate === parts[1].toLowerCase()) : undefined;
    if (category == null || level == null) return null;
    if (!rules.some((rule) => rule.category === category && rule.level === level)) rules.push({ category, level });
  }
  return rules;
}

function parseNotify(args: readonly string[]): ReplParse {
  if (args.length === 0) return command({ kind: "notify", action: { kind: "show" } });
  const lower = args[0].toLowerCase();
  if (args.length === 1 && (lower === "all:on" || lower === "aon")) return command({ kind: "notify", action: { kind: "all", enabled: true } });
  if (args.length === 1 && (lower === "all:off" || lower === "aoff")) return command({ kind: "notify", action: { kind: "all", enabled: false } });
  const category = categoryOf(args[0]);
  if (category == null) return invalid(`  不明なカテゴリ: ${args[0]} (有効: ${NOTIFY_CATEGORIES.join(", ")})`);
  const action = args[1]?.toLowerCase();
  // 旧築は on・off でない語を toggle にしたが、無効な入力で状態を変えない（AC12 (4)）。
  if (args.length > 2 || (action != null && action !== "on" && action !== "off")) return invalid(NOTIFY_USAGE);
  return command({ kind: "notify", action: { kind: "category", category, enabled: action == null ? "toggle" : action === "on" } });
}

function parseMute(args: readonly string[]): ReplParse {
  const on = (durationMs: number | null, rules: readonly MuteRule[]) => command({ kind: "mute", action: { kind: "on", durationMs, rules } });
  if (args.length === 0) return on(null, []);
  if (args.length === 1 && args[0].toLowerCase() === "off") return command({ kind: "mute", action: { kind: "off" } });
  // 条件の後の長さ（順の誤り）と引数の多すぎは使い方の文。
  if (args.length > 2 || (args.length === 2 && args[0].includes(":"))) return invalid(MUTE_USAGE);
  if (args.length === 1 && args[0].includes(":")) {
    const rules = rulesOf(args[0]);
    return rules == null ? invalid(MUTE_USAGE) : on(null, rules);
  }
  const duration = durationOf(args[0]);
  if (typeof duration === "string") return invalid(duration);
  if (args.length === 1) return on(duration, []);
  const rules = rulesOf(args[1]);
  return rules == null ? invalid(MUTE_USAGE) : on(duration, rules);
}

/** REPL の 1 行を typed command にする（P3-CLI-AC12 (2)〜(4)）。変えられない行は旧築の文の 1 行を持つ invalid。 */
function parseReplLine(line: string): ReplParse {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "empty" };
  const [word, ...args] = trimmed.split(/\s+/);
  const entry = entryOf(word);
  if (entry == null) {
    const candidate = suggestion(word);
    return invalid(candidate == null ? `  不明なコマンド: ${word} (help で一覧を表示)` : `  不明なコマンド: ${word} — もしかして: ${candidate}`);
  }
  switch (entry.kind) {
    case "help": return command({ kind: "help", topic: args[0] ?? null, sub: args[1] ?? null });
    case "commands": return command({ kind: "commands", query: args.length === 0 ? null : args.join(" ") });
    case "status": case "config": case "retry": case "quit": return command({ kind: entry.kind });
    case "notify": return parseNotify(args);
    case "sound": {
      const lower = args[0]?.toLowerCase();
      if (args.length === 0) return command({ kind: "sound", enabled: null });
      return args.length === 1 && (lower === "on" || lower === "off") ? command({ kind: "sound", enabled: lower === "on" }) : invalid("  on または off を指定してください。");
    }
    case "mute": return parseMute(args);
    case "display": {
      const lower = args[0]?.toLowerCase();
      if (args.length === 0) return command({ kind: "display", action: "status" });
      return args.length === 1 && (lower === "on" || lower === "off") ? command({ kind: "display", action: lower }) : invalid("  使い方: display / display on / display off");
    }
  }
}

// ── 返事の文（P3-CLI-AC14） ──

// 旧築 settings-handlers.ts の formatDuration。
function formatDuration(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `${totalSec}秒`;
  const min = Math.floor(totalSec / 60), sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}分${sec}秒` : `${min}分`;
  const hour = Math.floor(min / 60), remMin = min % 60;
  return remMin > 0 ? `${hour}時間${remMin}分` : `${hour}時間`;
}
const rulesText = (rules: readonly MuteRule[]): string => rules.map((rule) => `${LABELS[rule.category]}（${LEVEL_WORDS[rule.level]}）`).join("、");
const remaining = (mute: NonNullable<NotificationSettings["mute"]>, now: ClockReading): string =>
  mute.endsAtMonotonicMs == null ? "mute off まで" : `残り ${formatDuration(mute.endsAtMonotonicMs - now.monotonicMs)}`;

function helpLines(topic: string | null, sub: string | null): string[] {
  if (topic == null) return ["", "  help <command> — コマンドの詳細を表示", "  commands       — コマンド一覧を表示", "", "  例: help notify, commands settings", ""];
  const entry = entryOf(topic);
  if (entry == null) return [`  不明なコマンド: ${topic}`];
  const subcommands = entry.subcommands;
  if (sub != null && subcommands != null) {
    const key = Object.keys(subcommands).find((name) => name.toLowerCase() === sub.toLowerCase());
    return key == null ? [`  不明なサブコマンド: ${topic} ${sub}`] : ["", `  ${topic} ${key} — ${subcommands[key]}`, ""];
  }
  const lines = ["", `  ${topic} — ${entry.description}`];
  if (entry.detail != null) lines.push("", ...entry.detail.split("\n").map((line) => `  ${line}`));
  if (subcommands != null) {
    const names = Object.keys(subcommands).sort();
    lines.push("", ...names.map((name, index) => `      ${index < names.length - 1 ? "├─" : "└─"} ${name.padEnd(10)}${subcommands[name]}`));
  }
  lines.push("");
  return lines;
}

function commandsLines(query: string | null, values: Readonly<Record<string, string>>): string[] {
  const listed = ENTRIES.filter((entry) => !HIDDEN.has(entry.name));
  const row = (entry: Entry, value: string | undefined) => `    ${entry.subcommands != null ? "+ " : "  "}${entry.name.padEnd(14)}${entry.description}`
    + (entry.alias != null ? ` (${entry.alias})` : "") + (value != null ? ` [${value}]` : "");
  const lower = query?.toLowerCase();
  const group = query == null ? null : (Object.keys(GROUP_LABELS) as Group[]).find((name) => name === lower || GROUP_LABELS[name] === query) ?? null;
  if (query != null && group == null) {
    const matches = listed.filter((entry) => entry.name.includes(lower ?? "") || entry.description.toLowerCase().includes(lower ?? ""))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (matches.length === 0) return [`  "${query}" に一致するコマンドはありません`];
    return ["", `  検索結果: "${query}"`, "  help <command> で各コマンドの詳細を表示", "", ...matches.map((entry) => row(entry, undefined)), ""];
  }
  const lines = ["", "  利用可能なコマンド:", "  help <command> で各コマンドの詳細を表示"];
  for (const name of group == null ? (["info", "status", "settings", "operation"] as const) : [group]) {
    lines.push("", `  [${GROUP_LABELS[name]}]`);
    for (const entry of listed.filter((item) => item.group === name).sort((a, b) => a.name < b.name ? -1 : 1)) lines.push(row(entry, values[entry.name]));
  }
  lines.push("", "  + = サブコマンドあり (help <command> で詳細表示)", "  カテゴリ絞り込み: commands <category> / 検索: commands <query>", "");
  return lines;
}

function statusLines(status: HostStatus): string[] {
  const lines = ["", "  WebSocket 接続状態:", `  状態: ${status.connection === "connected" ? "接続中" : "切断"}`];
  if (status.socketId != null) lines.push(`  SocketID: ${status.socketId}`);
  if (status.failedAttempts > 0) lines.push(`  再接続試行: #${status.failedAttempts}`);
  lines.push("");
  return lines;
}

const RETRY_TEXT: Readonly<Record<ReturnType<HostCommandPort["reconnect"]>, string>> = {
  connected: "  既に接続中です。", started: "  再接続を試行中...", connecting: "  接続を試しています。",
  draining: "  受信の待ちを片付けてから繋ぎ直します。", stopping: "  終了しています。",
};

// ── 通知の設定（P3-CLI-AC15 (1)・AC19 (4)） ──

/** 起動の前に 1 回読んだ設定から通知の設定を作る。保存の mute は、終わりを過ぎていれば解けた扱い、残りが 24 時間を超えれば 24 時間にする（時計が戻ったときに上限を越えて続けない）。 */
function notificationSettingsFrom(settings: FleqSettings, clock: () => ClockReading): NotificationSettings {
  const now = clock(), saved = settings.mute;
  const mute = saved == null ? null : saved.until == null ? { endsAtMonotonicMs: null, until: null, rules: saved.rules }
    : saved.until > now.wallTimeMs ? { endsAtMonotonicMs: now.monotonicMs + Math.min(saved.until - now.wallTimeMs, DAY_MS), until: saved.until, rules: saved.rules } : null;
  return { notify: { ...settings.notify }, sound: settings.sound ?? true, mute, version: 0 };
}

/** 起動し直した後に mute が続いていることを知らせる 1 行（AC19 (3)）。mute でなければ null。 */
function muteStartLine(settings: Readonly<NotificationSettings>, clock: () => ClockReading): string | null {
  const now = clock(), mute = settings.mute;
  if (mute == null || !muteActive(settings, now.monotonicMs)) return null;
  let text = "ミュート中です（mute off まで）。";
  if (mute.endsAtMonotonicMs != null) {
    const at = new Date(now.wallTimeMs + (mute.endsAtMonotonicMs - now.monotonicMs));
    text = `ミュート中です（${at.getMonth() + 1}月${at.getDate()}日 ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")} まで。解除は mute off）。`;
  }
  return mute.rules.length === 0 ? text : `${text}次に当たる通知は鳴ります: ${rulesText(mute.rules)}。`;
}

type ReplOptions = Readonly<{
  host: HostCommandPort;
  // 門と同じ object。REPL はここを書き換え、門は次の試行から読む（AC13 (4)）。
  settings: NotificationSettings;
  // 起動の前に読んだ設定ファイルの mute（終わりを過ぎていたら起動の後に欄を消す、AC15 (1)）。
  savedMute: PersistedMute | undefined;
  // display on で開く port（引数＞設定＞7789、P3-CLI-D-O2-DISPLAY）。
  displayPort: number;
  clock: () => ClockReading;
  // readline の close（quit・exit・Ctrl+C・Ctrl+D・標準入力の終わり）。CLI の 1 つの終了の要求へつなぐ（P3-CLI-D-O2-QUIT）。
  onClose: () => void;
}>;

/** REPL を起こす。close は readline を閉じ（以後の行は実行しない）、idle は保存の列が空になるのを待つ。 */
function runRepl(options: ReplOptions): Readonly<{ close(): void; idle(): Promise<void> }> {
  const { host, settings, clock } = options;
  // AC17 (5): この起動で REPL が変えた欄だけを保存で重ねる。
  const changed: { notify: Partial<Record<LegacyNotifyCategory, boolean>>; sound?: boolean; mute?: PersistedMute | null } = { notify: {} };
  const saver = createSettingsSaver(() => changed);
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  // AC15 (1): mute ごとに世代を進め、古い timer は今の mute を解かない。
  let generation = 0;
  let timer: NodeJS.Timeout | null = null;

  const arm = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
    generation += 1;
    const ends = settings.mute?.endsAtMonotonicMs;
    if (ends == null) return;
    const mine = generation;
    timer = setTimeout(() => {
      timer = null;
      if (mine !== generation) return;
      settings.mute = null;
      changed.mute = null;
      saver.request();
    }, Math.max(0, ends - clock().monotonicMs));
    timer.unref();
  };
  const changeNotify = (categories: readonly LegacyNotifyCategory[], enabled: boolean) => {
    for (const category of categories) { settings.notify[category] = enabled; changed.notify[category] = enabled; }
    settings.version += 1;
    saver.request();
  };

  const mute = (action: Extract<ReplCommand, { kind: "mute" }>["action"]) => {
    settings.version += 1;
    if (action.kind === "off") {
      settings.mute = null;
      changed.mute = null;
      arm();
      saver.request();
      out("  ミュートを解除しました。");
      return;
    }
    const now = clock(), { durationMs, rules } = action;
    settings.mute = { endsAtMonotonicMs: durationMs == null ? null : now.monotonicMs + durationMs, until: durationMs == null ? null : now.wallTimeMs + durationMs, rules };
    changed.mute = { until: settings.mute.until, rules };
    arm();
    saver.request();
    out(durationMs == null ? "  通知をミュートしました (mute off まで)。" : `  通知を ${formatDuration(durationMs)} ミュートしました。`);
    // AC15 (3)（spec:3108）: mute の on の返事の後に、何が鳴り何が鳴らないかを 1 行。
    out(rules.length === 0 ? "  ミュートの間は、通知も音も出ません。" : `  ミュートの間も、次に当たる通知は鳴ります: ${rulesText(rules)}。`);
  };

  const notifyLines = (): string[] => {
    const now = clock(), active = settings.mute != null && muteActive(settings, now.monotonicMs) ? settings.mute : null;
    const lines = ["", "  通知設定:"];
    if (active != null) lines.push(`  (ミュート中: ${remaining(active, now)}${active.rules.length === 0 ? "" : `、条件: ${rulesText(active.rules)}`})`);
    lines.push("");
    for (const category of NOTIFY_CATEGORIES) {
      const alias = [...CATEGORY_ALIASES].find(([, value]) => value === category)?.[0];
      lines.push(`  ${category.padEnd(14)}${LABELS[category]}  ${notifyEnabled(settings, category) ? "ON" : "OFF"}${alias != null ? ` (${alias})` : ""}`);
    }
    lines.push("", NOTIFY_USAGE, "");
    return lines;
  };
  // 旧築 getCurrentSettingValues の notify・sound・mute の 3 つ（AC14 (2)）。
  const currentValues = (): Record<string, string> => {
    const now = clock(), active = settings.mute != null && muteActive(settings, now.monotonicMs) ? settings.mute : null;
    const on = NOTIFY_CATEGORIES.filter((category) => notifyEnabled(settings, category)).length;
    return { notify: `${on}/${NOTIFY_CATEGORIES.length} ON${active != null ? ", ミュート中" : ""}`, sound: settings.sound ? "ON" : "OFF",
      mute: active == null ? "なし" : remaining(active, now) };
  };

  // P3-CLI-D-O2-COMMAND: 期限を過ぎた command は 1 行出して次の行へ進み、後から来た結果は出さない。
  const late = Symbol("late");
  const within = async <T>(task: Promise<T>, line: string, show: (result: T) => string[]) => {
    let deadline: NodeJS.Timeout | undefined;
    const result = await Promise.race([task, new Promise<typeof late>((done) => { deadline = setTimeout(() => done(late), COMMAND_DEADLINE_MS); })]);
    clearTimeout(deadline);
    for (const text of result === late ? [`  時間内に終わりませんでした: ${line}`] : show(result)) out(text);
  };

  const run = async (parsed: ReplCommand, line: string): Promise<void> => {
    switch (parsed.kind) {
      case "help": helpLines(parsed.topic, parsed.sub).forEach(out); return;
      case "commands": commandsLines(parsed.query, currentValues()).forEach(out); return;
      case "status": statusLines(host.status()).forEach(out); return;
      case "config": {
        // AC14 (4): 読むだけで、移行も書き込みも起こさない。
        const read = await rereadSettings();
        if (read.kind === "unreadable") out(read.message); else showLines(read.settings ?? {}).forEach(out);
        return;
      }
      case "notify": {
        const action = parsed.action;
        if (action.kind === "show") { notifyLines().forEach(out); return; }
        if (action.kind === "all") {
          changeNotify(NOTIFY_CATEGORIES, action.enabled);
          out(action.enabled ? "  全通知を有効にしました" : "  全通知を無効にしました");
          return;
        }
        const { category } = action, current = notifyEnabled(settings, category);
        if (action.enabled === current) { out(`  ${LABELS[category]} (${category}): 既に ${current ? "ON" : "OFF"} です`); return; }
        const next = action.enabled === "toggle" ? !current : action.enabled;
        changeNotify([category], next);
        out(`  ${LABELS[category]} (${category}): ${next ? "ON" : "OFF"}`);
        return;
      }
      case "sound":
        if (parsed.enabled == null) { out(`  通知音: ${settings.sound ? "ON" : "OFF"}`); out("  使い方: sound on / sound off"); return; }
        settings.sound = parsed.enabled;
        changed.sound = parsed.enabled;
        settings.version += 1;
        saver.request();
        out(`  通知音を ${parsed.enabled ? "ON" : "OFF"} にしました。`);
        return;
      case "mute": mute(parsed.action); return;
      case "retry": out(RETRY_TEXT[host.reconnect()]); return;
      case "display": {
        if (parsed.action === "status") {
          const display = host.status().display;
          (display == null ? ["  情報ディスプレイは停止中です"] : ["  情報ディスプレイ: 稼働中", `  ポート: ${display.port}`, `  接続クライアント: ${display.clients}`]).forEach(out);
          return;
        }
        if (parsed.action === "on") {
          await within(host.openDisplay(options.displayPort), line, (result) => [
            result.kind === "opened" ? `  情報ディスプレイを起動しました (ポート ${result.port})` : result.kind === "alreadyOpen" ? "  情報ディスプレイは既に稼働中です"
              : result.kind === "portInUse" ? `  情報ディスプレイのポート ${options.displayPort} は使われています`
              : result.kind === "failed" ? "  情報ディスプレイの起動に失敗しました" : "  終了しています。"]);
          return;
        }
        await within(host.closeDisplay(), line, (result) => [result === "closed" ? "  情報ディスプレイを停止しました" : "  情報ディスプレイは起動していません"]);
        return;
      }
      case "quit": readline.close(); return;
    }
  };

  // AC12 (1)(6): readline に SIGINT の listener を付けない（Ctrl+C は close になる、P3-CLI-D-O2-QUIT）。
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  readline.setPrompt("FlEq> ");
  // AC12 (5): 行は届いた順に 1 つずつ実行し、終了の要求の後の行は実行しない。
  readline.on("line", (line: string) => {
    chain = chain.then(async () => {
      if (closed) return;
      const parsed = parseReplLine(line);
      if (parsed.kind === "invalid") out(parsed.message);
      else if (parsed.kind === "command") await run(parsed.command, line.trim());
      if (!closed) readline.prompt();
    });
  });
  readline.on("close", () => {
    if (closed) return;
    closed = true;
    options.onClose();
  });
  // 起動のときに終わりを過ぎていた mute は、起動の後に欄を消す（AC15 (1)）。
  if (options.savedMute != null && settings.mute == null) { changed.mute = null; saver.request(); }
  arm();
  readline.prompt();
  return {
    close: () => { if (!closed) readline.close(); },
    idle: saver.idle,
  };
}

export { muteStartLine, notificationSettingsFrom, parseReplLine, runRepl };
