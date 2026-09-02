import readline from "readline";
import chalk from "chalk";
import { playSound, isSoundLevel, SOUND_LEVELS } from "../../engine/notification/sound-player";
import type { TestTableEntry } from "../test-samples";
import * as log from "../../logger";
import type { ReplContext } from "./types";
import { hasBackupSupport } from "./info-handlers";

/** test table 電文タイプ名のエイリアス (短縮形 → 正式名) */
const TABLE_TYPE_ALIASES: Record<string, string> = {
  eq: "earthquake",
  tsu: "tsunami",
  st: "seismicText",
  nt: "nankaiTrough",
  lgob: "lgObservation",
  vc: "volcano",
  wt: "weather",
  tnd: "tornado",
  brf: "briefing",
  ew: "earlyWeather",
  ci: "climateInfo",
  we: "weatherExplanation",
  ha: "heatAlert",
  ta: "typhoonAnalysis",
  tp: "typhoonProbability",
};

/** test table の電文タイプ名を解決する (case-insensitive + エイリアス) */
function resolveTestTableType(
  tables: Record<string, TestTableEntry>,
  input: string,
): string | null {
  const lower = input.toLowerCase();
  for (const key of Object.keys(tables)) {
    if (key.toLowerCase() === lower) return key;
  }
  return TABLE_TYPE_ALIASES[lower] ?? null;
}

// ── コマンドハンドラ ──

export async function handleTest(ctx: ReplContext, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? "";

  if (sub === "") {
    const testEntry = ctx.commands["test"];
    console.log();
    console.log(chalk.cyan.bold("  test サブコマンド:"));
    if (testEntry.subcommands) {
      for (const [name, sc] of Object.entries(testEntry.subcommands)) {
        console.log(chalk.white(`    ${name.padEnd(14)}`) + chalk.gray(sc.description));
      }
    }
    console.log();
    console.log(chalk.gray("  詳細: help test <subcommand>"));
    console.log();
    return;
  }

  const subLower = sub.toLowerCase();
  if (subLower === "sound" || subLower === "snd") {
    handleTestSound(parts.slice(1).join(" "));
    return;
  }

  if (subLower === "table" || subLower === "tbl") {
    await handleTestTable(parts.slice(1).join(" "));
    return;
  }

  console.log(chalk.yellow(`  不明なサブコマンド: ${sub}`) + chalk.gray(" (sound / table)"));
}

function handleTestSound(args: string): void {
  const level = args.trim().toLowerCase();

  if (level === "") {
    console.log();
    console.log(chalk.cyan.bold("  利用可能なサウンドレベル:"));
    for (const l of SOUND_LEVELS) {
      console.log(chalk.white(`    ${l}`));
    }
    console.log();
    console.log(chalk.gray("  使い方: test sound <level>"));
    console.log();
    return;
  }

  if (!isSoundLevel(level)) {
    console.log(chalk.yellow(`  不明なサウンドレベル: ${level}`));
    console.log(chalk.gray(`  有効な値: ${SOUND_LEVELS.join(", ")}`));
    return;
  }

  console.log(chalk.gray(`  サウンドテスト: ${level} を再生中...`));
  playSound(level);
}

async function handleTestTable(args: string): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const type = parts[0] ?? "";
  const variantArg = parts[1];

  // 約 1,500 行のサンプル定義を REPL 起動時に常駐させないため、実行時に読み込む
  const { TEST_TABLES } = await import("../test-samples");

  if (type === "") {
    console.log();
    console.log(chalk.cyan.bold("  利用可能な電文タイプ:"));
    const aliasReverse: Record<string, string[]> = {};
    for (const [alias, canonical] of Object.entries(TABLE_TYPE_ALIASES)) {
      (aliasReverse[canonical] ??= []).push(alias);
    }
    for (const [key, entry] of Object.entries(TEST_TABLES)) {
      const count = entry.variants.length;
      const aliases = aliasReverse[key];
      const aliasText = aliases != null ? ` (${aliases.join(", ")})` : "";
      const nameCol = `${key}${aliasText}`;
      console.log(
        chalk.white(`    ${nameCol.padEnd(24)}`) +
          chalk.gray(`${entry.label}`) +
          chalk.gray(` (${count}件)`),
      );
    }
    console.log();
    console.log(chalk.gray("  使い方: test table <type> [番号]"));
    console.log();
    return;
  }

  const resolvedType = resolveTestTableType(TEST_TABLES, type);
  const entry = resolvedType != null ? TEST_TABLES[resolvedType] : undefined;
  if (entry == null) {
    console.log(chalk.yellow(`  不明な電文タイプ: ${type}`));
    console.log(
      chalk.gray(`  有効な値: ${Object.keys(TEST_TABLES).join(", ")}`),
    );
    return;
  }

  if (variantArg == null) {
    console.log();
    console.log(chalk.cyan.bold(`  ${entry.label} バリエーション:`));
    for (const [i, v] of entry.variants.entries()) {
      console.log(chalk.white(`    ${String(i + 1).padEnd(4)}`) + chalk.gray(v.label));
    }
    console.log();
    console.log(chalk.gray(`  使い方: test table ${resolvedType} <番号>`));
    console.log();
    return;
  }

  const variantNum = parseInt(variantArg, 10);
  if (isNaN(variantNum) || variantNum < 1 || variantNum > entry.variants.length) {
    console.log(
      chalk.yellow(`  不明な番号: ${variantArg} (1〜${entry.variants.length})`),
    );
    return;
  }

  const variant = entry.variants[variantNum - 1];
  console.log(
    chalk.gray(`  表示テスト: ${entry.label} #${variantNum} ${variant.label}`),
  );
  variant.run();
}

export function handleClear(): void {
  if (process.stdout.isTTY) {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
  } else {
    console.clear();
  }
}

export async function handleBackup(ctx: ReplContext, args: string): Promise<void> {
  if (!hasBackupSupport(ctx.wsManager)) {
    console.log(chalk.yellow("  この構成では副回線は利用できません"));
    return;
  }

  const sub = args.trim().toLowerCase();
  if (sub === "") {
    if (ctx.wsManager.isBackupRunning()) {
      const bs = ctx.wsManager.getBackupStatus();
      console.log(
        chalk.white("  副回線: ") +
          (bs?.connected ? chalk.green.bold("接続中") : chalk.yellow("再接続中"))
      );
      if (bs?.socketId != null) {
        console.log(chalk.white("  SocketID: ") + chalk.white(String(bs.socketId)));
      }
    } else {
      console.log(chalk.white("  副回線: ") + chalk.gray("未起動"));
    }
    return;
  }

  if (sub === "on") {
    const result = await ctx.wsManager.startBackup();
    if (result !== "started") {
      return;
    }
    ctx.updateConfig((c) => { c.backup = true; });
    ctx.config.backup = true;
    return;
  }

  if (sub === "off") {
    ctx.wsManager.stopBackup();
    ctx.updateConfig((c) => { c.backup = false; });
    ctx.config.backup = false;
    return;
  }

  console.log(chalk.yellow("  使い方: backup / backup on / backup off"));
}

export async function handleRetry(ctx: ReplContext): Promise<void> {
  const status = ctx.wsManager.getStatus();
  if (status.connected) {
    console.log(chalk.gray("  既に接続中です。"));
    return;
  }

  console.log(chalk.gray("  再接続を試行中..."));
  try {
    await ctx.wsManager.connect();
  } catch (err) {
    log.error(`再接続に失敗しました: ${err instanceof Error ? err.message : err}`);
  }
}

export async function handleDisplay(ctx: ReplContext, args: string): Promise<void> {
  const sub = args.trim().toLowerCase();

  if (sub === "") {
    const status = ctx.displayController.status();
    if (!status.running) {
      console.log(chalk.gray("  情報ディスプレイは停止中です"));
      return;
    }
    console.log(chalk.white("  情報ディスプレイ: ") + chalk.green.bold("稼働中"));
    console.log(chalk.white("  ポート: ") + chalk.white(String(status.port)));
    console.log(chalk.white("  接続クライアント: ") + chalk.white(String(status.clientCount)));
    return;
  }

  if (sub === "on") {
    const result = await ctx.displayController.start();
    console.log((result.ok ? chalk.green : chalk.yellow)(`  ${result.message}`));
    return;
  }

  if (sub === "off") {
    const result = await ctx.displayController.stop();
    console.log((result.ok ? chalk.gray : chalk.yellow)(`  ${result.message}`));
    return;
  }

  console.log(chalk.yellow("  使い方: display / display on / display off"));
}

export function handleVolcanoRepair(ctx: ReplContext, args: string): void {
  const administration = ctx.volcanoRepairAdministration;
  if (administration == null) {
    console.log(chalk.yellow("  火山修復管理はこの構成では利用できません"));
    return;
  }
  const parts = args.trim().split(/\s+/u).filter(Boolean);
  const subcommand = parts.shift()?.toLowerCase() ?? "status";
  const status = administration.status();
  if (subcommand === "status") {
    if (status.length === 0) {
      console.log(chalk.gray("  未解決の operational-v2 provenance 欠損はありません"));
      return;
    }
    console.log(chalk.cyan.bold("  火山 provenance 修復待ち:"));
    for (const item of status) {
      const target = item.scope === "domain" ? "domain" : `code=${item.volcanoCode ?? "?"}`;
      const comparison = item.lastKnownComparison == null
        ? "comparison=unknown"
        : `report=${item.lastKnownComparison.revision.reportDateTime.raw ?? "?"} serial=${item.lastKnownComparison.revision.serial.raw ?? "-"}`;
      console.log(chalk.white(`    ${target} ${comparison}`));
      console.log(chalk.gray(`      fingerprint=${item.omissionFingerprint}`));
      console.log(chalk.gray(`      actions=${item.actions.join(",")} version=${item.expectedRuntimeVersion}`));
    }
    return;
  }
  const action = subcommand === "accept" ? "acceptCurrent" as const
    : subcommand === "clear" ? "clearCurrent" as const
      : subcommand === "acknowledge-domain" ? "acknowledgeDomainLoss" as const
        : null;
  const fingerprint = parts.shift() ?? "";
  const reason = parts.join(" ");
  if (action == null || fingerprint === "" || reason === "") {
    console.log(chalk.yellow("  使い方: volcanorepair status | accept/clear/acknowledge-domain <fingerprint> <reason...>"));
    return;
  }
  const current = status.find((item) => item.omissionFingerprint === fingerprint);
  if (current == null) {
    console.log(chalk.yellow("  指定 fingerprint は現在の未解決一覧にありません"));
    return;
  }
  const result = administration.resolveOperationalV2AlertOmission({
    omissionFingerprint: fingerprint,
    action,
    reason,
    expectedRuntimeVersion: current.expectedRuntimeVersion,
  });
  if (result.kind === "committed") {
    console.log(chalk.green(`  火山 provenance 修復を記録しました (${result.resolutionId})`));
    return;
  }
  console.log(chalk.yellow(`  火山 provenance 修復は適用されませんでした (${result.kind})`));
}

export async function handleQuit(ctx: ReplContext): Promise<void> {
  ctx.stop();
  await ctx.onQuit();
}
