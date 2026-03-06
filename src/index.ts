#!/usr/bin/env node

process.env.DOTENV_CONFIG_QUIET = "true";
import dotenv from "dotenv";
dotenv.config();
import { buildProgram } from "./cli/build-command";

const program = buildProgram();
program.parseAsync().catch((err: unknown) => {
  console.error(
    `致命的エラー: ${err instanceof Error ? err.message : err}`
  );
  process.exit(1);
});
