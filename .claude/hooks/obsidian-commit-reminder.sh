#!/usr/bin/env bash
# PostToolUse hook: git commit 成功時に Obsidian 記録リマインド
set -euo pipefail

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
cat >"$tmp"

node - "$tmp" <<'NODE'
const fs = require("fs");

const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const cmd = input.tool_input?.command || "";
const exitCode = input.tool_response?.exitCode;

// git commit が成功した場合のみ発火（amend, dry-run 含む）
if (/\bgit\s+commit\b/.test(cmd) && exitCode === 0) {
  const out = {
    decision: "continue",
    additionalContext:
      "git commit を検出した。Obsidian にセッションログを記録していなければ /wrap-up を実行すること。"
  };
  process.stdout.write(JSON.stringify(out));
}
NODE
