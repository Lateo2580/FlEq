#!/usr/bin/env bash
set -euo pipefail

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
cat >"$tmp"

rel_path="$(node - "$tmp" <<'NODE'
const fs = require("fs");
const path = require("path");

const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const filePath = input.tool_input?.file_path;
if (!filePath) process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const rel = path.relative(projectDir, path.resolve(filePath)).replace(/\\/g, "/");

if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
  process.stdout.write(rel);
}
NODE
)"

basename="${rel_path##*/}"

case "${basename:-}" in
  .env|.env.*|.npmrc|*.pem|*.key|credentials|credentials.*)
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"秘密情報を含む可能性のあるファイルだ。直接編集は禁止されている。"}}'
    ;;
esac
