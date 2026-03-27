# Claude Harness 設計書

FlEq における Claude Code 制御の設計方針と実装詳細。

## 3層アーキテクチャ

| 層 | 責務 | 判断基準 |
|----|------|---------|
| **CLAUDE.md** | 常設の制約・設計原則 | 説明文で伝えられるなら CLAUDE.md |
| **Skills** | 特定タスクの手順・チェックリスト | 条件付きの作業手順なら Skill |
| **Hooks** | 機械的な自動ガード | 毎回同じ条件で自動判定できるなら Hook |

### 責務の境界

- リリース前だけ必要なものは Hook ではなく npm scripts / CI に置く
- Hook は短時間・決定的・副作用最小を原則とする
- Skills はイベント駆動ではなく、該当タスク開始時に読み込まれる

## Hook 一覧

### PreToolUse: dist/ 直編集ガード

| 項目 | 値 |
|------|-----|
| イベント | `PreToolUse` |
| 対象ツール | `Edit`, `MultiEdit`, `Write` |
| スクリプト | `.claude/hooks/guard-generated-files.sh` |
| timeout | 10秒 |
| 判定 | `dist/` 配下への編集を deny |

**目的**: `dist/` は `npm run build` の生成物であり、直接編集すると次回ビルドで上書きされる。`src/` を編集させることで、ソースと生成物の乖離を防ぐ。

**実装**: stdin から hook 入力 JSON を読み取り、`tool_input.file_path` のプロジェクト内相対パスが `dist/` で始まる場合に deny レスポンスを返す。

### 不採用とした Hook

| 候補 | 不採用理由 |
|------|-----------|
| PostToolUse (tsc --noEmit) | Edit のたびに数秒の待ち時間が発生し、開発体験を損なう |
| UserPromptSubmit (TODO通知) | Skills の責務。Hook で通知すると Skill との重複が生じる |
| Notification (ビルド失敗) | PostToolUse の結果として Claude に返す方が自然 |

## Skills 一覧

### プロジェクト固有

| Skill | 概要 | 配置 |
|-------|------|------|
| `add-telegram-type` | 新規電文タイプ追加の全パイプライン手順 | `~/.claude/skills/add-telegram-type/` |

### 汎用 (Superpowers プラグイン)

brainstorming, writing-plans, executing-plans, test-driven-development, systematic-debugging, requesting-code-review, verification-before-completion 等。

## 設定ファイル構成

```
.claude/
  settings.local.json    # プロジェクト固有: permissions, hooks, outputStyle
  hooks/
    guard-generated-files.sh  # dist/ 編集ガード

~/.claude/
  settings.json           # グローバル: deny リスト, model, plugins
  skills/
    Codex/                # Codex CLI 連携スキル
    add-telegram-type/    # 電文追加手順スキル
```

## 変更方針

- Hook の追加・変更は、まず `settings.local.json` で検証し、安定したら必要に応じて `settings.json` に昇格
- 不変条件（dist/ 編集禁止など）が確立したら、チーム共有の `settings.json` への移動を検討
- Hook の追加時は「短時間・決定的・副作用最小」の3原則を満たすか確認する
- 重い検証（npm test, npm run build）を Hook に入れたくなったら、開発体験への影響を先に検証する
