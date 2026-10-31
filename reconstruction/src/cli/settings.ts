import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { EewLogField, FleqSettings, LegacyNotifyCategory } from "../../contracts/p3-cli-repl.types";
import type { DmdataClassification, DmdataTestMode } from "../../contracts/p3-dmdata-connect.types";

// P3-CLI-AC03・AC04: 新築の設定ファイルの場所・読み戻し・書き込み・今までの fleq の設定の移行。
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

type Field = Readonly<{ kind: "number" | "bool" | "list" | "string" | "map"; description: string; reason: string;
  check(value: unknown, out: Out): boolean }>;
const NOT_YET = "（今は保存だけで、まだ効きません）";
const BOOL = "true か false";
// 並びが config keys・show の並び。notify・eewLogFields は REPL の側の key（set・unset の対象外、AC03 (5)）。
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
  sound: { kind: "bool", description: `通知音の有効/無効 (true/false)${NOT_YET}`, reason: BOOL,
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
  notify: { kind: "map", description: `通知する分野ごとの on/off${NOT_YET}`, reason: "分野の名前と true か false の組",
    check: (v, o) => { const map = boolMap(NOTIFY_CATEGORIES, v); return map != null && put(o, "notify", map); } },
  eewLogFields: { kind: "map", description: `EEW ログに記録する項目ごとの on/off${NOT_YET}`, reason: "項目の名前と true か false の組",
    check: (v, o) => { const map = boolMap(EEW_LOG_FIELDS, v); return map != null && put(o, "eewLogFields", map); } },
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
  if (!checked.ok) throw new Refusal(`設定ファイル ${file} の ${checked.key} が読めません: ${checked.reason}。直すか消してください`);
  return { settings: checked.settings, migration: null, bytes };
}

// P3-CLI-D-WRITE: 固定名の一時 file は、落ちた後の残りが以後の書き込みを断つ。fsync→rename→directory の sync は電源断で apiKey の file が空になるのを防ぐ。
function writeSettings(settings: FleqSettings): void {
  const { directory, file } = settingsPaths();
  const temporary = join(directory, `config.json.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  let renamed = false;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const handle = openSync(temporary, "wx", 0o600);
    try { writeFileSync(handle, `${JSON.stringify(settings, null, 2)}\n`); fsyncSync(handle); } finally { closeSync(handle); }
    renameSync(temporary, file);
    renamed = true;
  } catch (error) {
    if (!renamed) { try { unlinkSync(temporary); } catch { /* 作る前の失敗なら無い */ } }
    throw new Refusal(`設定ファイル ${file} を書けません（${errorCode(error)}）`);
  }
  // rename の後の失敗は、file が新しい中身なので書けた扱いにする（code 1 は利用者に書けなかったと読み違えさせる）。
  if (process.platform !== "win32") {
    try { const handle = openSync(directory, "r"); try { fsyncSync(handle); } finally { closeSync(handle); } } catch { /* 書けた扱い */ }
  }
}

/** 設定を書き、移行の結果が付いていれば同じ 1 回で書いて 1 行知らせる（P3-CLI-D-MIGRATE）。 */
function commitSettings(loaded: Loaded, next: FleqSettings): void {
  writeSettings(next);
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

export { ALL_KEYS, appNameProblem, CLASSIFICATIONS, checkSettings, commitSettings, createContext, fieldOf, loadSettings,
  parseClassifications, Refusal, SETTABLE_KEYS, settingsPaths, settingsUnchanged, TEST_MODES, valueFromText };
export type { Context, Loaded };
