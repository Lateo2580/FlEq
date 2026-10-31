import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";

import { Command, CommanderError, InvalidArgumentError } from "commander";

import type { FleqSettings } from "../../contracts/p3-cli-repl.types";
import type { DmdataClassification, DmdataTestMode } from "../../contracts/p3-dmdata-connect.types";
import { exchange } from "../host/dmdata-rest";
import { startP2Host } from "../host/host";
import { createNotificationGate } from "./notification-gate";
import { muteStartLine, notificationSettingsFrom, runRepl } from "./repl";
import {
  appNameProblem, CLASSIFICATIONS, checkSettings, commitSettings, createContext, fieldOf, loadSettings, mask, parseClassifications,
  Refusal, SETTABLE_KEYS, settingsPaths, settingsUnchanged, showLines, TEST_MODES, valueFromText,
} from "./settings";
import type { Context, Loaded } from "./settings";

// P3-CLI-AC01〜AC09【発注 1】: 新築の起動・設定の下位コマンド・init。【発注 2】通常起動の REPL・通知の門（AC12〜AC19）。端末の電文の表示は発注 3。
// 検査は commander の argParser（引数）と settings.ts の checkSettings（設定）の 2 か所に置き、どれも副作用の前に済ませる（AC09）。

const DEFAULT_DISPLAY_PORT = 7789;
const DEFAULT_SUMMARY_MINUTES = 10;
// P3-CLI-RES-03: stop() の後に保存の列を待つ期限（置き値、AC18 (3)）。
const SAVE_WAIT_MS = 5_000;

type RunOptions = {
  apiKey?: string; classifications?: DmdataClassification[]; test?: DmdataTestMode; summaryInterval?: number | true;
  display?: true; displayPort?: number; displayBind?: string; displayToken?: string; debug?: true;
};

const out = (line: string) => { process.stdout.write(`${line}\n`); };
const fail = (line: string) => { process.stderr.write(`${line}\n`); };

// 版は root の package.json の 1 つだけ（P3-CLI-D-VERSION）。import は tsconfig の rootDir の外なので TS6059 で落ちる。adapter.ts と同じく __dirname から root を解く。
const repoRoot = (() => {
  for (let directory = __dirname; ; directory = dirname(directory)) {
    if (existsSync(join(directory, "reconstruction", "assets", "sounds"))) return directory;
    if (dirname(directory) === directory) return process.cwd();
  }
})();
function packageVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  if (parsed == null || typeof parsed !== "object" || !("version" in parsed) || typeof parsed.version !== "string") throw new Error("package.json has no version");
  return parsed.version;
}

// 引数の値の範囲は設定 file と同じ検査（settings.ts の欄）を通す。範囲を 2 か所に書かない。
const decimal = (flag: string, key: string, text: string): number => {
  const value = /^[0-9]+$/.test(text) ? Number(text) : NaN;
  const checked = checkSettings({ [key]: value });
  if (!checked.ok) throw new InvalidArgumentError(`${flag} は ${checked.reason}で指定してください`);
  return value;
};

function buildProgram(context: Context, settle: (task: () => Promise<number> | number) => Promise<void>): Command {
  const program = new Command();
  program.exitOverride();
  program
    .name("fleq")
    .description("Project DM-D.S.S (dmdata.jp) の地震・津波・EEW情報をリアルタイムで受信・表示するCLIツールです")
    .version(packageVersion())
    .option("-k, --api-key <key>", "dmdata.jp APIキーを指定します（環境変数 DMDATA_API_KEY でも指定できます）", (text: string) => {
      if (!checkSettings({ apiKey: text }).ok) throw new InvalidArgumentError("空白だけでない文字列を指定してください");
      return text;
    })
    .option("-c, --classifications <items>", `受信区分を指定します（カンマ区切り: ${CLASSIFICATIONS.join(",")}）`, (text: string) => {
      const items = parseClassifications(text);
      if (items == null) throw new InvalidArgumentError(`有効な値: ${CLASSIFICATIONS.join(", ")}`);
      return items;
    })
    .option("--test <mode>", 'テスト電文の扱いを指定します: "no" | "including" | "only"', (text: string) => {
      const mode = TEST_MODES.find((item) => item === text);
      if (mode == null) throw new InvalidArgumentError(`有効な値: ${TEST_MODES.join(", ")}`);
      return mode;
    })
    .option("--summary-interval [minutes]", "N分ごとに受信要約を表示 (デフォルト10分, 0で無効化)",
      (text: string) => text === "0" ? 0 : decimal("--summary-interval", "summaryInterval", text))
    .option("--display", "情報ディスプレイ (ブラウザ表示サーバ) を有効化します")
    .option("--display-port <port>", `情報ディスプレイのポート (デフォルト ${DEFAULT_DISPLAY_PORT})`, (text: string) => decimal("--display-port", "displayPort", text))
    .option("--display-bind <host>", "情報ディスプレイのバインド先 (今は 127.0.0.1 だけ)", (text: string) => {
      if (!checkSettings({ displayHost: text }).ok) throw new InvalidArgumentError("情報ディスプレイは、認証の仕組みができるまで 127.0.0.1 でしか開けません");
      return text;
    })
    .option("--display-token <token>", "情報ディスプレイのアクセストークン (127.0.0.1 の間は使われません)", (text: string) => {
      if (!checkSettings({ displayToken: text }).ok) throw new InvalidArgumentError("空でない文字列を指定してください");
      return text;
    })
    .option("--debug", "CLI 自身の設定の出どころを標準エラーへ表示します")
    .addHelpText("after", "\n  replay <fixtureId...>  保存してある電文を流して画面の出方を確かめる（開発者向け、このリポジトリの中で使う）")
    .action((options: RunOptions) => settle(() => startMonitor(options, context)));

  program.command("init").description("インタラクティブに初期設定を行います").action(() => settle(() => runInit(context)));
  const config = program.command("config").description("Configファイルの設定を管理します");
  config.command("show").description("現在の設定を表示します").action(() => settle(() => showConfig(context)));
  config.command("set <key> <value>").description("設定値を保存します").action((key: string, value: string) => settle(() => setConfig(context, key, value)));
  config.command("unset <key>").description("設定値を削除します").action((key: string) => settle(() => unsetConfig(context, key)));
  config.command("path").description("Configファイルのパスを表示します").action(() => settle(() => { out(settingsPaths().file); return 0; }));
  config.command("keys").description("設定可能なキー一覧を表示します").action(() => settle(() => { printKeys(); return 0; }));
  return program;
}

async function runCli(argv: readonly string[]): Promise<number> {
  let code = 0;
  const settle = async (task: () => Promise<number> | number) => {
    try { code = await task(); }
    catch (error) {
      if (!(error instanceof Refusal)) throw error;
      fail(error.message);
      code = 1;
    }
  };
  try { await buildProgram(createContext(), settle).parseAsync(argv, { from: "user" }); }
  catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    throw error;
  }
  return code;
}

// ── config ──

function checkKey(key: string): void {
  if (!SETTABLE_KEYS.includes(key)) throw new Refusal(`不明な設定キー: ${key}\n有効なキー: ${SETTABLE_KEYS.join(", ")}`);
}
// key と値の検査は設定ファイルの読みより先（AC03 (5)）。外れたら何も書かない。
function checkEntry(context: Context, key: string, value: unknown): void {
  const problem = key === "appName" && typeof value === "string" ? appNameProblem(value, context) : null;
  if (problem != null) throw new Refusal(`${key} に設定できない値です: ${problem}`);
  const checked = checkSettings({ [key]: value });
  if (!checked.ok) throw new Refusal(`${key} に設定できない値です: ${checked.reason}`);
}
function checkWhole(raw: unknown): FleqSettings {
  const checked = checkSettings(raw);
  if (!checked.ok) throw new Refusal(`${checked.key} に設定できない値です: ${checked.reason}`);
  return checked.settings;
}

// 出し方は REPL の config と同じ（settings.ts の showLines、P3-CLI-AC14 (4)）。
async function showConfig(context: Context): Promise<number> {
  const loaded = loadSettings(context);
  if (loaded.migration != null) await commitSettings(loaded, loaded.settings);
  showLines(loaded.settings).forEach(out);
  return 0;
}

async function setConfig(context: Context, key: string, text: string): Promise<number> {
  checkKey(key);
  const value = valueFromText(key, text);
  checkEntry(context, key, value);
  const loaded = loadSettings(context);
  await commitSettings(loaded, checkWhole({ ...loaded.settings, [key]: value }));
  out(`設定しました: ${key}`);
  return 0;
}

async function unsetConfig(context: Context, key: string): Promise<number> {
  checkKey(key);
  const loaded = loadSettings(context);
  await commitSettings(loaded, checkWhole(Object.fromEntries(Object.entries(loaded.settings).filter(([name]) => name !== key))));
  out(`削除しました: ${key}`);
  return 0;
}

function printKeys(): void {
  out("設定可能なキー:");
  for (const key of SETTABLE_KEYS) out(`${key}\n  ${fieldOf(key)?.description ?? ""}`);
}

// ── init ──

const CLASSIFICATION_LABELS: Readonly<Record<DmdataClassification, string>> = {
  "telegram.earthquake": "地震・津波に関する電文", "eew.forecast": "緊急地震速報（予報）", "eew.warning": "緊急地震速報（警報）",
  "telegram.volcano": "火山に関する電文", "telegram.weather": "気象に関する電文",
};
const TEST_MODE_LABELS: Readonly<Record<DmdataTestMode, string>> = {
  no: "テスト電文を受信しない", including: "テスト電文も受信する", only: "テスト電文だけ受信する",
};

const labelOf = (item: string): string => {
  const known = CLASSIFICATIONS.find((classification) => classification === item);
  return known == null ? item : CLASSIFICATION_LABELS[known];
};

// 契約確認は GET /contract を 1 回。失敗は既定値で続け、応答本文と例外は出さない（AC07 [3/5]）。
async function contractedClassifications(apiKey: string): Promise<string[] | null> {
  const answer = await exchange("GET", "/contract", apiKey, undefined);
  if (answer.kind !== "answered" || answer.status < 200 || answer.status >= 300) return null;
  let body: unknown;
  try { body = JSON.parse(answer.text); } catch { return null; }
  if (body == null || typeof body !== "object" || !("items" in body) || !Array.isArray(body.items)) return null;
  const valid: string[] = [];
  for (const item of body.items) {
    if (item != null && typeof item === "object" && "classification" in item && "isValid" in item && item.isValid === true
      && typeof item.classification === "string") valid.push(item.classification);
  }
  return valid;
}

async function runInit(context: Context): Promise<number> {
  const loaded = loadSettings(context);
  const existing = loaded.settings;
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (prompt: string) => new Promise<string>((answer) => readline.question(prompt, (text) => answer(text.trim())));
  try {
    out("fleq 初期設定\ndmdata.jp のAPIキーと受信設定を行います。Enter で既定値を採用します。\n");
    out("[1/5] dmdata.jp APIキー\n取得先: https://manager.dmdata.jp/control/apikey");
    if (existing.apiKey != null) out(`現在: ${mask(existing.apiKey)}`);
    let apiKey = existing.apiKey ?? "";
    for (;;) {
      const text = await ask("APIキー: ");
      if (text !== "") apiKey = text;
      if (apiKey !== "") break;
      out("APIキーは必須です。");
    }

    out("\n[2/5] 接続名（appName）\n今までの fleq やほかの端末と違う名前にします。");
    if (existing.appName != null) out(`現在: ${existing.appName}`);
    let appName = "";
    for (;;) {
      const text = await ask("接続名: ");
      const candidate = text !== "" ? text : existing.appName ?? "";
      const problem = appNameProblem(candidate, context);
      if (problem == null) { appName = candidate; break; }
      out(problem);
    }

    out("\n[3/5] 契約確認");
    const contracted = await contractedClassifications(apiKey);
    const contracted5 = CLASSIFICATIONS.filter((item) => contracted?.includes(item));
    if (contracted == null) out("契約の確認ができませんでした。既定値を使います");
    else if (contracted.length === 0) out("契約済みの区分が見つかりません。");
    else out(`契約済み: ${contracted.map(labelOf).join(", ")}`);

    out("\n[4/5] 受信区分\n番号をスペース区切りで入力します。");
    const defaults = existing.classifications ?? (contracted5.length > 0 ? contracted5 : CLASSIFICATIONS);
    CLASSIFICATIONS.forEach((item, index) => out(`${defaults.includes(item) ? "[x]" : "[ ]"} ${index + 1}. ${CLASSIFICATION_LABELS[item]}`));
    let classifications: readonly DmdataClassification[] = defaults;
    for (;;) {
      const text = await ask(`選択 [${defaults.map((item) => CLASSIFICATIONS.indexOf(item) + 1).join(" ")}]: `);
      if (text === "") break;
      const numbers = text.split(/\s+/);
      if (numbers.every((item) => /^[0-9]+$/.test(item) && Number(item) >= 1 && Number(item) <= CLASSIFICATIONS.length)) {
        classifications = [...new Set(numbers.map(Number))].sort((a, b) => a - b).map((number) => CLASSIFICATIONS[number - 1]);
        break;
      }
      out(`1〜${CLASSIFICATIONS.length} の番号をスペースで区切って入力してください`);
    }

    out("\n[5/5] テスト電文");
    const current = existing.testMode ?? "no";
    TEST_MODES.forEach((item, index) => out(`${item === current ? "→" : " "} ${index + 1}. ${TEST_MODE_LABELS[item]}`));
    let testMode: DmdataTestMode = current;
    for (;;) {
      const text = await ask(`選択 [${TEST_MODES.indexOf(current) + 1}]: `);
      if (text === "") break;
      const chosen = /^[0-9]+$/.test(text) ? TEST_MODES[Number(text) - 1] : undefined;
      if (chosen != null) { testMode = chosen; break; }
      out(`1〜${TEST_MODES.length} の番号で入力してください`);
    }

    out(`\n設定内容\nAPIキー: ${mask(apiKey)}\n接続名: ${appName}\n受信区分: ${classifications.map((item) => CLASSIFICATION_LABELS[item]).join(", ")}\nテスト電文: ${TEST_MODE_LABELS[testMode]}\n`);
    let save: boolean | null = null;
    while (save == null) {
      const text = (await ask("この内容で保存しますか? [Y/n]: ")).toLowerCase();
      save = text === "" || text === "y" || text === "yes" ? true : text === "n" || text === "no" ? false : null;
    }
    if (!save) { out("設定を保存せずに終了します。"); return 0; }
    // 対話の間に別の端末が保存していたら、古い内容で上書きしない（成功と返した変更が消えるため）。
    if (!settingsUnchanged(loaded)) throw new Refusal("設定ファイルが init の途中で変わりました。もう一度 fleq init を実行してください");
    await commitSettings(loaded, checkWhole({ ...existing, apiKey, appName, classifications, testMode }));
    out(`設定を保存しました。\nファイル: ${settingsPaths().file}\nfleq を実行して受信を始められます。`);
    return 0;
  } finally { readline.close(); }
}

// ── 通常起動 ──

type Sourced<T> = Readonly<{ value: T | undefined; source: string }>;
function pick<T>(...candidates: readonly (readonly [string, T | undefined])[]): Sourced<T> {
  const found = candidates.find(([, value]) => value !== undefined && (typeof value !== "string" || value.trim() !== ""));
  return found == null ? { value: undefined, source: "既定" } : { value: found[1], source: found[0] };
}

async function startMonitor(options: RunOptions, context: Context): Promise<number> {
  const loaded = loadSettings(context);
  const settings = loaded.settings;
  const paths = settingsPaths();
  const apiKey = pick(["引数", options.apiKey], ["環境変数", process.env.DMDATA_API_KEY], ["設定ファイル", settings.apiKey]);
  if (apiKey.value == null) {
    throw new Refusal("APIキーがありません。次のどれかで指定してください:\n  fleq init\n  fleq config set apiKey <key>\n  fleq --api-key <key>\n  DMDATA_API_KEY=<key> fleq");
  }
  if (settings.appName == null || appNameProblem(settings.appName, context) != null) {
    throw new Refusal("dmdata の接続名（appName）を、今までの fleq やほかの端末と違う名前で設定してください: fleq config set appName <名前>");
  }
  const appName = settings.appName;
  const classifications = pick(["引数", options.classifications], ["設定ファイル", settings.classifications]);
  const testMode = pick(["引数", options.test], ["設定ファイル", settings.testMode]);
  const display = pick(["引数", options.display], ["設定ファイル", settings.display]);
  const displayPort = pick(["引数", options.displayPort], ["設定ファイル", settings.displayPort]);
  const summaryInterval = pick(["引数", options.summaryInterval === true ? DEFAULT_SUMMARY_MINUTES : options.summaryInterval], ["設定ファイル", settings.summaryInterval]);
  const resolved = {
    classifications: classifications.value ?? CLASSIFICATIONS, testMode: testMode.value ?? "no", display: display.value === true,
    port: displayPort.value ?? DEFAULT_DISPLAY_PORT,
  };
  if (options.debug === true) {
    const secret = (name: string, set: boolean, source: string) => `${name} = ${set ? "****" : "(なし)"}（${source}）`;
    for (const line of [
      `設定ファイル: ${paths.file}`, secret("apiKey", true, apiKey.source), `appName = ${appName}（設定ファイル）`,
      `classifications = ${resolved.classifications.join(",")}（${classifications.source}）`, `testMode = ${resolved.testMode}（${testMode.source}）`,
      `display = ${resolved.display}（${display.source}）`, `displayPort = ${resolved.port}（${displayPort.source}）`,
      `summaryInterval = ${summaryInterval.value ?? "(なし)"}（${summaryInterval.source}）`,
      secret("displayToken", (options.displayToken ?? settings.displayToken) != null, options.displayToken != null ? "引数" : settings.displayToken != null ? "設定ファイル" : "既定"),
    ]) fail(`debug: ${line}`);
  }
  if (loaded.migration != null) await commitSettings(loaded, settings);
  // AC19 (4): 通知の設定は起動の前に 1 回読んだ設定から作り、REPL が変える。門はそれをその場で読む。
  const clock = () => ({ wallTimeMs: Date.now(), monotonicMs: performance.now() });
  const notification = notificationSettingsFrom(settings, clock);

  // 終了の listener は startP2Host の前に登録する。host の SIGINT の once は起動の途中で登録され、最初の接続の試みの最中の Ctrl+C では
  // host が自分で止まったまま正常に戻る（P3-CLI-D-SIGNAL）。無いと: 終了 code が要約の code にならず、待ちが終わらない。
  type Host = Awaited<ReturnType<typeof startP2Host>>;
  let host: Host | null = null;
  let repl: ReturnType<typeof runRepl> | null = null;
  let stopping: ReturnType<Host["stop"]> | null = null;
  let wake: () => void = () => {};
  const asked = new Promise<void>((resolve) => { wake = resolve; });
  let requested = false;
  const onSignal = () => {
    requested = true;
    if (host != null) stopping ??= host.stop();
    repl?.close();
    wake();
  };
  const signals: readonly NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, onSignal);
  try {
    try {
      host = await startP2Host({
        dmdata: { apiKey: apiKey.value, appName, classifications: resolved.classifications, testMode: resolved.testMode },
        stateDirectory: paths.state, diagnosticDirectory: paths.diag,
        displayPort: resolved.display ? resolved.port : null, notificationGate: createNotificationGate(notification, clock),
        clock, observe: null,
      });
    } catch (error) {
      const code: unknown = error != null && typeof error === "object" && "code" in error ? error.code : undefined;
      // shortcut: 認証の失敗は host の Error の message との照合で見分ける。host の失敗が型になったら置き換える。
      if (code === "EADDRINUSE") throw new Refusal(`情報ディスプレイのポート ${resolved.port} は使われています。--display-port で別の番号を指定してください`);
      if (error instanceof Error && error.message === "dmdata authentication rejected") throw new Refusal("dmdata の認証に失敗しました。APIキーを確かめてください");
      throw new Refusal("起動に失敗しました");
    }
    if (requested) stopping ??= host.stop();
    else {
      if (resolved.display) out(`情報ディスプレイ: http://127.0.0.1:${host.displayPort}/`);
      out(`受信を始めました（区分: ${resolved.classifications.join(",")}、テスト電文: ${resolved.testMode}）。help でコマンドの一覧、終了は quit か Ctrl+C`);
      const muted = muteStartLine(notification, clock);
      if (muted != null) out(muted);
      repl = runRepl({ host, settings: notification, savedMute: settings.mute, displayPort: resolved.port, clock, onClose: onSignal });
    }
    await asked;
    stopping ??= host.stop();
    const { code } = await stopping;
    // AC18 (3): stop() の後も保存の列が終わっていなければ 5 秒まで待つ。期限の内は rename の前の保存を残して終えない。
    let timer: NodeJS.Timeout | undefined;
    const saved = repl == null || await Promise.race([repl.idle().then(() => true), new Promise<false>((done) => { timer = setTimeout(() => done(false), SAVE_WAIT_MS); })]);
    clearTimeout(timer);
    if (saved) return code;
    // rename の後の directory の sync だけが残っていることもあるので、次の起動の状態を言い切らない。
    fail(`設定ファイル ${paths.file} に最後の変更を保存できたか確かめられません`);
    return code === 0 ? 1 : code;
  } finally {
    repl?.close();
    for (const signal of signals) process.off(signal, onSignal);
  }
}

export { runCli };
