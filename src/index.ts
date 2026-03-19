#!/usr/bin/env node

process.env.DOTENV_CONFIG_QUIET = "true";
import dotenv from "dotenv";
dotenv.config();

// ── トゥルーカラー強制 ──
// chalk の自動検出では Windows PowerShell や一部ターミナルで
// トゥルーカラー (level 3) を検出できず、RGB 値が 256 色に
// ダウングレードされて色味がずれることがある。
// 何らかの色サポートがある場合はトゥルーカラーに引き上げる。
import chalk from "chalk";
if (chalk.level > 0 && chalk.level < 3) {
  chalk.level = 3;
}

import { buildProgram } from "./engine/cli/cli";

const program = buildProgram();
program.parseAsync().catch((err: unknown) => {
  console.error(
    `致命的エラー: ${err instanceof Error ? err.message : err}`
  );
  process.exit(1);
});
