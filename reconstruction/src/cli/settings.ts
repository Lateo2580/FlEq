import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { EewLogField, FleqSettings, LegacyNotifyCategory, MuteRule, PersistedMute } from "../../contracts/p3-cli-repl.types";
import type { DmdataClassification, DmdataTestMode } from "../../contracts/p3-dmdata-connect.types";

// P3-CLI-AC03・AC04・AC17: 新築の設定ファイルの場所・読み戻し・書き込み・今までの fleq の設定の移行・REPL の保存の列。
// 読み戻しは欄ごとに確かめて組み立てる。無いと: 壊れた値が黙って既定に戻り、受信区分が 5 区分へ広がる（P3-CLI-D-INVALID）。

class Refusal extends Error {}

const CLASSIFICATIONS: readonly DmdataClassification[] = [
  "telegram.earthquake", "eew.forecast", "eew.warning", "telegram.volcano", "telegram.weather",
];
const TEST_MODES: readonly DmdataTestMode[] = ["no", "including", "only"];
const NOTIFY_CATEGORIES: readonly LegacyNotifyCategory[] = [
  "eew", "earthquake", "tsunami", "seismicText", "nankaiTrough", "lgObservation", "volcano", "weather", "tornado",
  "briefing", "earlyWeather", "weatherWarningTimeseries", "climateInfo", "weatherExplanation", "heatAlert",
  "typhoonAnalysis", "typhoonProbability", "floodForecast",
];
const EEW_LOG_FIELDS: readonly EewLogField[] = [
  "hypocenter", "originTime", "coordinates", "magnitude", "forecastIntensity", "maxLgInt", "forecastAreas",
  "lgIntensity", "isPlum", "hasArrived", "diff", "maxIntChangeReason",
];
const MUTE_LEVELS: readonly MuteRule["level"][] = ["normal", "warning", "critical"];
// 18 分野×3 段（同じ組の重複なし、P3-CLI-RES-04）。
const MUTE_RULE_LIMIT = 54;
const APP_NAME_MAX_BYTES = 24;
const LEGACY_APP_NAME = "fleq";

// 設定の directory は使うたびに環境から解く（it ごとの vi.stubEnv を効かせるため、P3-CLI-AC03 (1)）。旧築の resolveConfigDir と同じ規則。
function configDirectory(name: string): string {
  const env = process.env;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, name);
  switch (process.platform) {
    case "darwin": return join(homedir(), "Library", "Application Support", name);
    case "win32": return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), name);
    default: return join(homedir(), ".config", name);
  }
}

function settingsPaths(): Readonly<{ directory: string; file: string; state: string; diag: string }> {
  const directory = configDirectory("fleq-next");
  return { directory, file: join(directory, "config.json"), state: join(directory, "state"), diag: join(directory, "diag") };
}
const legacyFile = () => join(configDirectory("fleq"), "config.json");

const isRecord = (value: unknown): value is Record<string, unknown> => value != null && typeof value === "object" && !Array.isArray(value);
const errorCode = (error: unknown): string => isRecord(error) && typeof error.code === "string" ? error.code : "UNKNOWN";
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";
const isInt = (value: unknown, low: number, high: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.find((item) => item === value);
const isClassification = (value: unknown): value is DmdataClassification => oneOf(CLASSIFICATIONS, value) != null;

type Out = { -readonly [K in keyof FleqSettings]: FleqSettings[K] };
const put = <K extends keyof Out>(out: Out, key: K, value: Out[K]): true => { out[key] = value; return true; };

function boolMap<K extends string>(names: readonly K[], value: unknown): Partial<Record<K, boolean>> | null {
  if (!isRecord(value)) return null;
  const result: Partial<Record<K, boolean>> = {};
  for (const [name, flag] of Object.entries(value)) {
    const known = oneOf(names, name);
    if (known == null || typeof flag !== "boolean") return null;
    result[known] = flag;
  }
  return result;
}

/** カンマ区切りの文字列を、前後の空白を除き、空の項を捨て、重複を最初の 1 つに寄せて配列にする（AC02 (10)）。 */
function splitList(text: string): string[] {
  return [...new Set(text.split(",").map((item) => item.trim()).filter((item) => item !== ""))];
}
/** 5 区分の字だけで 1 件以上なら配列、ほかは null。 */
function parseClassifications(text: string): DmdataClassification[] | null {
  const items = splitList(text);
  return items.length > 0 && items.every(isClassification) ? items : null;
}

type Context = Readonly<{ legacy(): LegacyRead }>;
type LegacyRead = Readonly<{ kind: "absent" }> | Readonly<{ kind: "unreadable" }> | Readonly<{ kind: "text"; text: string }>;

function readLegacy(): LegacyRead {
  try { return { kind: "text", text: readFileSync(legacyFile(), "utf8") }; }
  catch (error) { return errorCode(error) === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" }; }
}
/** 今までの fleq の設定の読みは 1 起動に 1 回（P3-CLI-RES-01）。appName の確かめと移行が同じ読みを使う。 */
function createContext(): Context {
  let cached: LegacyRead | null = null;
  return { legacy: () => cached ??= readLegacy() };
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}
/** 今までの fleq の設定の appName。file が無い・読めない・欄が無いときは fleq（P3-CLI-D-APPNAME）。 */
function legacyAppName(context: Context): string {
  const read = context.legacy();
  const parsed = read.kind === "text" ? parseJson(read.text) : undefined;
  return isRecord(parsed) && typeof parsed.appName === "string" ? parsed.appName : LEGACY_APP_NAME;
}

// 設定 file の読み戻しは形だけを見る。今までの fleq の側が後から同じ名前になっても、show・set・unset が止まらないため。
function appNameShape(value: string): string | null {
  if (value === "") return "接続名が空です";
  if (Buffer.byteLength(value, "utf8") > APP_NAME_MAX_BYTES) return "接続名は 24 バイトまでです（日本語は 1 字 3 バイト）";
  if (value === LEGACY_APP_NAME) return "今までの fleq と同じ接続名は使えません";
  return null;
}
/** appName の問題を 1 文で返す。問題が無ければ null。set・init・通常起動で使う（今までの fleq の設定との照合を含む）。 */
function appNameProblem(value: string, context: Context): string | null {
  return appNameShape(value) ?? (value === legacyAppName(context) ? "今までの fleq と同じ接続名は使えません" : null);
}

/** 設定ファイルの mute の欄を確かめて組み立てる（P3-CLI-AC17 (1)）。外れたら null。 */
function persistedMute(value: unknown): PersistedMute | null {
  if (!isRecord(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, "until") || !Object.hasOwn(value, "rules")) return null;
  const { until, rules } = value;
  if (until !== null && !(typeof until === "number" && Number.isSafeInteger(until) && until >= 0)) return null;
  if (!Array.isArray(rules) || rules.length > MUTE_RULE_LIMIT) return null;
  const checked: MuteRule[] = [];
  for (const rule of rules) {
    if (!isRecord(rule) || Object.keys(rule).length !== 2) return null;
    const category = oneOf(NOTIFY_CATEGORIES, rule.category), level = oneOf(MUTE_LEVELS, rule.level);
    if (category == null || level == null || checked.some((item) => item.category === category && item.level === level)) return null;
    checked.push({ category, level });
  }
  return { until, rules: checked };
}

type Field = Readonly<{ kind: "number" | "bool" | "list" | "string" | "map"; description: string; reason: string;
  check(value: unknown, out: Out): boolean }>;
const NOT_YET = "（今は保存だけで、まだ効きません）";
const BOOL = "true か false";
// 並びが config keys・show の並び。kind が map の notify・eewLogFields・mute は REPL の側の key（set・unset の対象外、AC03 (5)・AC17 (2)）。
const FIELDS: Readonly<Record<keyof FleqSettings, Field>> = {
  apiKey: { kind: "string", description: "dmdata.jp APIキー", reason: "空白だけでない文字列",
    check: (v, o) => typeof v === "string" && v.trim() !== "" && put(o, "apiKey", v) },
  appName: { kind: "string", description: "dmdata の接続名。今までの fleq やほかの端末と違う名前にします",
    reason: "UTF-8 で 1〜24 バイト、fleq 以外",
    check: (v, o) => typeof v === "string" && appNameShape(v) == null && put(o, "appName", v) },
  classifications: { kind: "list", description: `受信区分 (カンマ区切り: ${CLASSIFICATIONS.join(",")})`,
    reason: `次の 1 件以上をカンマで区切る: ${CLASSIFICATIONS.join(", ")}`,
    check: (v, o) => Array.isArray(v) && v.length > 0 && new Set(v).size === v.length && v.every(isClassification) && put(o, "classifications", v) },
  testMode: { kind: "string", description: 'テスト電文モード: "no" | "including" | "only"', reason: "no, including, only のどれか",
    check: (v, o) => { const mode = oneOf(TEST_MODES, v); return mode != null && put(o, "testMode", mode); } },
  display: { kind: "bool", description: "情報ディスプレイ (ブラウザ表示サーバ) の有効/無効 (true/false)", reason: BOOL,
    check: (v, o) => typeof v === "boolean" && put(o, "display", v) },
  displayPort: { kind: "number", description: "情報ディスプレイのポート (1〜65535、既定 7789)", reason: "1〜65535 の 10 進の整数",
    check: (v, o) => isInt(v, 1, 65535) && put(o, "displayPort", v) },
  displayHost: { kind: "string", description: "情報ディスプレイのバインド先 (今は 127.0.0.1 だけ)", reason: "127.0.0.1 だけ",
    check: (v, o) => v === "127.0.0.1" && put(o, "displayHost", v) },
  displayToken: { kind: "string", description: "情報ディスプレイの非 loopback 接続用アクセストークン", reason: "空でない文字列",
    check: (v, o) => nonEmpty(v) && put(o, "displayToken", v) },
  summaryInterval: { kind: "number", description: `定期受信要約の間隔 (分, 1〜1440)${NOT_YET}`, reason: "1〜1440 の 10 進の整数",
    check: (v, o) => isInt(v, 1, 1440) && put(o, "summaryInterval", v) },
  promptClock: { kind: "string", description: `プロンプト時計: "elapsed" (経過時間) | "clock" (現在時刻) | "uptime" (稼働時間)${NOT_YET}`,
    reason: "elapsed, clock, uptime のどれか",
    check: (v, o) => { const clock = oneOf(["elapsed", "clock", "uptime"] as const, v); return clock != null && put(o, "promptClock", clock); } },
  waitTipIntervalMin: { kind: "number", description: `待機中ヒント表示間隔 (分, 0で無効)${NOT_YET}`, reason: "0〜1440 の 10 進の整数",
    check: (v, o) => isInt(v, 0, 1440) && put(o, "waitTipIntervalMin", v) },
  sound: { kind: "bool", description: "通知音の有効/無効 (true/false)", reason: BOOL,
    check: (v, o) => typeof v === "boolean" && put(o, "sound", v) },
  eewLog: { kind: "bool", description: `EEWログ記録の有効/無効 (true/false)${NOT_YET}`, reason: BOOL,
    check: (v, o) => typeof v === "boolean" && put(o, "eewLog", v) },
  region: { kind: "string", description: "自宅の市区町村（例: 栃木県宇都宮市）。今は書いた文字をそのまま保存し、まだ効きません",
    reason: "空でない文字列",
    check: (v, o) => typeof v === "string" && v.trim() !== "" && put(o, "region", v.trim()) },
  regionScope: { kind: "string",
    description: "設定した地域の外の情報の出し方: all＝全部出して「設定した地域は対象外」を添える、regionOnly＝設定した地域の情報だけを出す（今は保存だけで、まだ効きません）",
    reason: "all か regionOnly",
    check: (v, o) => { const scope = oneOf(["all", "regionOnly"] as const, v); return scope != null && put(o, "regionScope", scope); } },
  notify: { kind: "map", description: "通知する分野ごとの on/off", reason: "分野の名前と true か false の組",
    check: (v, o) => { const map = boolMap(NOTIFY_CATEGORIES, v); return map != null && put(o, "notify", map); } },
  eewLogFields: { kind: "map", description: `EEW ログに記録する項目ごとの on/off${NOT_YET}`, reason: "項目の名前と true か false の組",
    check: (v, o) => { const map = boolMap(EEW_LOG_FIELDS, v); return map != null && put(o, "eewLogFields", map); } },
  mute: { kind: "map", description: "ミュートの終わりと条件（REPL の mute で変える）",
    reason: `until（null か 0 以上の整数）と rules（分野と ${MUTE_LEVELS.join("・")} の組の配列、重複なし、${MUTE_RULE_LIMIT} 件まで）の object`,
    check: (v, o) => { const mute = persistedMute(v); return mute != null && put(o, "mute", mute); } },
};
const fieldOf = (key: string): Field | undefined => Object.hasOwn(FIELDS, key) ? FIELDS[key as keyof FleqSettings] : undefined;
const SETTABLE_KEYS: readonly string[] = Object.entries(FIELDS).filter(([, field]) => field.kind !== "map").map(([key]) => key);
const ALL_KEYS: readonly string[] = Object.keys(FIELDS);

type Checked = Readonly<{ ok: true; settings: FleqSettings }> | Readonly<{ ok: false; key: string; reason: string }>;
/** 設定の値を欄ごとに確かめて組み立てる。set・unset・読み戻し・init の保存が通る 1 本の検査。 */
function checkSettings(raw: unknown): Checked {
  if (!isRecord(raw)) return { ok: false, key: "(全体)", reason: "JSON の object ではありません" };
  const out: Out = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = fieldOf(key);
    if (field == null) return { ok: false, key, reason: "知らない欄です" };
    if (!field.check(value, out)) return { ok: false, key, reason: field.reason };
  }
  return { ok: true, settings: out };
}

/** config set の値の文字列を欄の型に読む。読めない字は文字列のまま返し、欄の検査が理由つきで断る（AC03 (5)）。 */
function valueFromText(key: string, text: string): unknown {
  switch (fieldOf(key)?.kind) {
    case "number": return /^[0-9]+$/.test(text) ? Number(text) : text;
    case "bool": return text === "true" ? true : text === "false" ? false : text;
    case "list": return splitList(text);
    default: return text;
  }
}

type Migration = Readonly<{ from: string; copied: number; skipped: readonly string[] }>;
// bytes: 読んだときの設定 file の中身（無ければ null）。init が保存の直前に、途中で変わっていないかを bytes のまま照らす（不正な UTF-8 の違いを文字列化で見落とさないため）。
type Loaded = Readonly<{ settings: FleqSettings; migration: Migration | null; bytes: Buffer | null }>;

const unreadable = (file: string, checked: Extract<Checked, { ok: false }>) =>
  `設定ファイル ${file} の ${checked.key} が読めません: ${checked.reason}。直すか消してください`;

function readSettingsBytes(path: string): Buffer | null {
  try { return readFileSync(path); }
  catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new Refusal(`設定ファイル ${path} を読めません（${errorCode(error)}）`);
  }
}

// 旧築が読み込みで捨てていた要素は、移行でも同じく要素ごとに捨てる（P3-CLI-D-MIGRATE）。丸ごと検査にすると classifications の欄が落ちて 5 区分へ広がる。
function legacyValue(key: string, raw: unknown): unknown {
  if (key === "classifications") {
    const items = typeof raw === "string" ? splitList(raw) : Array.isArray(raw) ? [...new Set(raw)] : [];
    const kept = items.filter(isClassification);
    return kept.length > 0 ? kept : undefined;
  }
  if (key === "notify" || key === "eewLogFields") {
    if (!isRecord(raw)) return undefined;
    const names: readonly string[] = key === "notify" ? NOTIFY_CATEGORIES : EEW_LOG_FIELDS;
    const kept = Object.fromEntries(Object.entries(raw).filter(([name, flag]) => names.includes(name) && typeof flag === "boolean"));
    return Object.keys(kept).length > 0 ? kept : undefined;
  }
  return raw;
}
const MIGRATED_KEYS = new Set(["apiKey", "classifications", "testMode", "display", "displayHost", "summaryInterval", "promptClock",
  "waitTipIntervalMin", "notify", "sound", "eewLog", "eewLogFields"]);

function migrateLegacy(context: Context): Loaded {
  const none: Loaded = { settings: {}, migration: null, bytes: null };
  const read = context.legacy();
  if (read.kind === "absent") return none;
  const from = legacyFile();
  const parsed = read.kind === "text" ? parseJson(read.text) : undefined;
  if (!isRecord(parsed)) {
    process.stderr.write(`今までの fleq の設定 ${from} は読めないので写しません\n`);
    return none;
  }
  const out: Out = {};
  const skipped: string[] = [];
  let copied = 0;
  for (const [key, raw] of Object.entries(parsed)) {
    const value = legacyValue(key, raw);
    const field = MIGRATED_KEYS.has(key) ? fieldOf(key) : undefined;
    if (field != null && value !== undefined && field.check(value, out)) copied += 1; else skipped.push(key);
  }
  return { settings: out, migration: { from, copied, skipped }, bytes: null };
}

/** 設定を起動の前に 1 回読む。新しい file が無く今までの fleq の file があれば、移行の結果を組み立てる（書くのは commitSettings）。 */
function loadSettings(context: Context): Loaded {
  const { file } = settingsPaths();
  const bytes = readSettingsBytes(file);
  if (bytes == null) return migrateLegacy(context);
  const parsed = parseJson(bytes.toString("utf8"));
  const checked = checkSettings(parsed);
  if (!checked.ok) throw new Refusal(unreadable(file, checked));
  return { settings: checked.settings, migration: null, bytes };
}

type Reread = Readonly<{ kind: "read"; settings: FleqSettings | null }> | Readonly<{ kind: "unreadable"; message: string }>;
/** 実行中の非同期の読み（REPL の config と保存の読み直し、P3-CLI-AC17 (6)(7)）。移行は起こさない。file が無ければ settings は null。 */
async function rereadSettings(): Promise<Reread> {
  const { file } = settingsPaths();
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) {
    return errorCode(error) === "ENOENT" ? { kind: "read", settings: null } : { kind: "unreadable", message: `設定ファイル ${file} を読めません（${errorCode(error)}）` };
  }
  const checked = checkSettings(parseJson(text));
  return checked.ok ? { kind: "read", settings: checked.settings } : { kind: "unreadable", message: unreadable(file, checked) };
}

// P3-CLI-D-WRITE: 固定名の一時 file は、落ちた後の残りが以後の書き込みを断つ。fsync→rename→directory の sync は電源断で apiKey の file が空になるのを防ぐ。
// P3-CLI-D-O2-WRITE: 非同期の 1 つの手順（同期の fs は host の WS の callback を待たせる）。FileHandle.writeFile は全部を書くまで書くので、不完全な JSON を rename しない。
// 書けたら null、書けなければ error の code を返す。
async function writeSettings(settings: FleqSettings): Promise<string | null> {
  const { directory, file } = settingsPaths();
  const temporary = join(directory, `config.json.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  let renamed = false;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    renamed = true;
  } catch (error) {
    if (!renamed) await unlink(temporary).catch(() => { /* 作る前の失敗なら無い */ });
    return errorCode(error);
  }
  // rename の後の失敗は、file が新しい中身なので書けた扱いにする（code 1 は利用者に書けなかったと読み違えさせる）。
  if (process.platform !== "win32") {
    try { const handle = await open(directory, "r"); try { await handle.sync(); } finally { await handle.close(); } } catch { /* 書けた扱い */ }
  }
  return null;
}

/** 設定を書き、移行の結果が付いていれば同じ 1 回で書いて 1 行知らせる（P3-CLI-D-MIGRATE）。 */
async function commitSettings(loaded: Loaded, next: FleqSettings): Promise<void> {
  const failed = await writeSettings(next);
  if (failed != null) throw new Refusal(`設定ファイル ${settingsPaths().file} を書けません（${failed}）`);
  const { migration } = loaded;
  if (migration == null) return;
  const skipped = migration.skipped.length > 0 ? `（写さなかった key: ${migration.skipped.join(", ")}）` : "";
  process.stderr.write(`今までの fleq の設定 ${migration.from} から ${migration.copied} 件を写しました${skipped}\n`);
}

/** 読んだ後に設定 file が変わっていないか（無い file は無いままか）。 */
const settingsUnchanged = (loaded: Loaded): boolean => {
  const now = readSettingsBytes(settingsPaths().file);
  return now == null || loaded.bytes == null ? now === loaded.bytes : now.equals(loaded.bytes);
};

// ── show の出し方（config show と REPL の config が同じ文を出す、P3-CLI-AC14 (4)） ──

const mask = (value: string) => value.length <= 8 ? "****" : `${value.slice(0, 4)}****${value.slice(-4)}`;
const pad2 = (value: number) => String(value).padStart(2, "0");
const localMinute = (ms: number): string => {
  const at = new Date(ms);
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
};
const muteText = (mute: PersistedMute): string => `${mute.until == null ? "mute off" : localMinute(mute.until)} まで`
  + (mute.rules.length === 0 ? "" : `（条件: ${mute.rules.map((rule) => `${rule.category}:${rule.level}`).join(",")}）`);

/** config show の行（P3-CLI-AC03 (7)・AC17 (2)）。 */
function showLines(settings: FleqSettings): string[] {
  const lines = [`Config: ${settingsPaths().file}`];
  const entries = Object.entries(settings);
  if (entries.length === 0) lines.push("(設定なし)");
  for (const key of ALL_KEYS) {
    const found = entries.find(([name]) => name === key);
    if (found == null) continue;
    const [, value] = found;
    const shown = (key === "apiKey" || key === "displayToken") && typeof value === "string" ? mask(value)
      : key === "mute" && settings.mute != null ? muteText(settings.mute)
      : Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value);
    lines.push(`${key} = ${shown}`, `# ${fieldOf(key)?.description ?? ""}`);
  }
  return lines;
}

// ── REPL の保存の列（P3-CLI-D-O2-WRITE、P3-CLI-RES-02） ──

// REPL がこの起動で変えた欄だけ（AC17 (5) が唯一の列挙）。sound・mute は undefined が「変えていない」、mute の null は欄を消す。
type ReplOverlay = Readonly<{ notify: Readonly<Partial<Record<LegacyNotifyCategory, boolean>>>; sound?: boolean; mute?: PersistedMute | null }>;

function overlaid(base: FleqSettings, overlay: ReplOverlay): FleqSettings {
  const next: Out = { ...base };
  if (Object.keys(overlay.notify).length > 0) next.notify = { ...base.notify, ...overlay.notify };
  if (overlay.sound !== undefined) next.sound = overlay.sound;
  if (overlay.mute === null) delete next.mute;
  else if (overlay.mute !== undefined) next.mute = overlay.mute;
  return next;
}

/** 保存は 1 本の列で直列にし、走っている間の要求は「もう 1 回要る」の印に寄せる。終わった後に最新のメモリの値で 1 回だけ書く。 */
function createSettingsSaver(overlay: () => ReplOverlay): Readonly<{ request(): void; idle(): Promise<void> }> {
  const reply = (line: string) => { process.stdout.write(`${line}\n`); };
  let running: Promise<void> | null = null;
  let again = false;
  // 読み直して重ねるのは、別の端末の config set の欄を REPL の古い中身で消さないため。読めない・書けないときもメモリの値は戻さない。
  const once = async () => {
    const { file } = settingsPaths();
    const read = await rereadSettings();
    if (read.kind === "unreadable") { reply(`  設定ファイル ${file} を読めないので、この変更は保存しません（今の実行には効いています）`); return; }
    const failed = await writeSettings(overlaid(read.settings ?? {}, overlay()));
    if (failed != null) reply(`  設定ファイル ${file} を書けません（${failed}）。この変更は今の実行にだけ効いています`);
  };
  const request = () => {
    if (running != null) { again = true; return; }
    running = (async () => {
      try { do { again = false; await once(); } while (again); } finally { running = null; }
    })();
  };
  return { request, idle: async () => { while (running != null) await running; } };
}

export { appNameProblem, CLASSIFICATIONS, checkSettings, commitSettings, createContext, createSettingsSaver, fieldOf, loadSettings, mask,
  NOTIFY_CATEGORIES, parseClassifications, Refusal, rereadSettings, SETTABLE_KEYS, settingsPaths, settingsUnchanged, showLines, TEST_MODES, valueFromText };
export type { Context, Loaded, ReplOverlay };
