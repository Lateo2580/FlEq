#!/usr/bin/env bash
# PostToolUse hook: Session-log ファイル作成時に MOC-Sessions.md を自動更新
set -euo pipefail

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
cat >"$tmp"

node - "$tmp" <<'NODE'
const fs = require("fs");
const path = require("path");

const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const filePath = input.tool_input?.file_path;
if (!filePath) process.exit(0);

const normalized = filePath.replace(/\\/g, "/");

// Session-log ディレクトリへの書き込みかチェック
const sessionLogDir = "C:/Users/meiri/Obsidian/Liebe/Session-log/";
if (!normalized.startsWith(sessionLogDir)) process.exit(0);

// ファイル名からメタ情報を抽出 (YYYY-MM-DD-slug.md)
const basename = path.basename(normalized, ".md");
const match = basename.match(/^(\d{4})-(\d{2})-(\d{2})-(.+)$/);
if (!match) process.exit(0);

const [, year, month, day, slug] = match;
const monthSection = `## ${year}-${month}`;
const datePrefix = `${year}-${month}-${day}`;

// ファイル内容から Goal セクションのテキストを抽出してタイトルに使う
let title = slug.replace(/-/g, " ");
try {
  const content = fs.readFileSync(filePath, "utf8");
  const goalMatch = content.match(/^## Goal\s*\n+(.+)/m);
  if (goalMatch && !goalMatch[1].startsWith("<!--")) {
    title = goalMatch[1].trim();
  } else {
    // Goal が空ならタイトル行から取る
    const h1Match = content.match(/^# Session Log — (.+)/m);
    if (h1Match) {
      title = h1Match[1].trim();
    }
  }
} catch { /* ファイル読み取り失敗はスラグをフォールバック */ }

// MOC-Sessions.md を読み込む
const mocPath = "C:/Users/meiri/Obsidian/Liebe/MOC-Sessions.md";
let moc;
try {
  moc = fs.readFileSync(mocPath, "utf8");
} catch {
  process.exit(0);
}

// 既にリンクが存在するかチェック
if (moc.includes(`[[${basename}`)) process.exit(0);

// 月セクションを探して末尾に追記
const lines = moc.split("\n");
let insertIndex = -1;
let sectionFound = false;

for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith(monthSection)) {
    sectionFound = true;
    let lastEntryIndex = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].startsWith("## ")) {
        break;
      }
      if (lines[j].startsWith("- [[")) {
        lastEntryIndex = j;
      }
    }
    insertIndex = lastEntryIndex === -1 ? i + 1 : lastEntryIndex + 1;
    break;
  }
}

// セクションがなければファイル末尾に新セクション追加
if (!sectionFound) {
  lines.push("");
  lines.push(monthSection);
  lines.push("");
  insertIndex = lines.length - 1;
}

// リンク行を挿入
const linkLine = `- [[${basename}|${datePrefix}: ${title}]]`;
lines.splice(insertIndex, 0, linkLine);

fs.writeFileSync(mocPath, lines.join("\n"), "utf8");
NODE
