# Claude Harness 設計書

FlEq における Claude Code 制御の設計方針と実装詳細。

## 3層アーキテクチャ

| 層 | 責務 | 判断基準 |
|----|------|---------|
| **CLAUDE.md** | 常設の制約・設計原則 | 説明文で伝えられるなら CLAUDE.md |
| **Skills** | 特定タスクの手順・チェックリスト | 条件付きの作業手順なら Skill |
| **Hooks** | 機械的な自動ガード | 毎回同じ条件で自動判定できるなら Hook |

### 補助層

| 層 | 責務 | 判断基準 |
|----|------|---------|
| **Rules** (`.claude/rules/`) | パス固有の制約・手順 | 特定ファイル群を触るときだけ必要なら Rule |
| **Commands** (`.claude/commands/`) | 繰り返しワークフローの定型化 | 毎回同じ手順を踏むなら Command |

### 責務の境界

- リリース前だけ必要なものは Hook ではなく npm scripts / CI に置く
- Hook は短時間・決定的・副作用最小を原則とする
- Skills はイベント駆動ではなく、該当タスク開始時に読み込まれる
- Rules はコンテキスト最適化のため、CLAUDE.md からパス固有情報を分離する

## Hook 一覧

### PreToolUse: dist/ + package-lock.json 直編集ガード

| 項目 | 値 |
|------|-----|
| イベント | `PreToolUse` |
| 対象ツール | `Edit`, `MultiEdit`, `Write` |
| スクリプト | `.claude/hooks/guard-generated-files.sh` |
| timeout | 10秒 |
| 判定 | `dist/` 配下または `package-lock.json` への編集を deny |

**目的**: `dist/` は `npm run build` の生成物、`package-lock.json` は `npm install` の生成物であり、直接編集すると不整合が起きる。

### PreToolUse: 秘密ファイルガード

| 項目 | 値 |
|------|-----|
| イベント | `PreToolUse` |
| 対象ツール | `Edit`, `MultiEdit`, `Write` |
| スクリプト | `.claude/hooks/guard-secret-files.sh` |
| timeout | 10秒 |
| 判定 | `.env*`, `.npmrc`, `*.pem`, `*.key`, `credentials*` への編集を deny |

**目的**: 秘密情報を含む可能性のあるファイルへの誤書き込みを防止する。

### 不採用とした Hook

| 候補 | 不採用理由 |
|------|-----------|
| PostToolUse (tsc --noEmit) | Edit のたびに数秒の待ち時間が発生し、開発体験を損なう |
| UserPromptSubmit (TODO通知) | Skills の責務。Hook で通知すると Skill との重複が生じる |
| Notification (ビルド失敗) | PostToolUse の結果として Claude に返す方が自然 |
| PostToolUse (npm test) | 頻繁な実行は開発体験を損なう。明示的に実行する |

## Rules 一覧

| Rule | 対象パス | 内容 |
|------|---------|------|
| `message-pipeline.md` | `src/dmdata/**`, `src/engine/messages/**`, `src/engine/presentation/**`, `test/` 対応パス | ルーティング優先順位、パーサ対応表、フレームレベル判定、テスト規約 |
| `ui-output.md` | `src/ui/**`, `src/engine/presentation/**`, `test/` 対応パス | 表示変更時の docs 同期、compact モード対応、chalk バージョン制約 |
| `cli-config.md` | `src/config.ts`, `src/engine/cli/**`, `test/` 対応パス | 設定優先順位、CLI オプション追加時の同期 |

**設計方針**: CLAUDE.md は常時読み込まれるため、パス固有の詳細情報は Rules に分離してコンテキスト消費を抑える。

## Commands 一覧

| Command | 引数 | 概要 |
|---------|------|------|
| `/codex-review` | `[scope]` | Codex に変更差分をレビューさせる。Claude の自己評価は渡さない |
| `/codex-design` | `<topic>` | Codex に設計のセカンドオピニオンを求める（対話モード） |
| `/pre-release` | なし | リリース前チェックリスト（test → build → docs同期 → review） |

## Codex 併用ルール

| 変更規模 | Codex 利用 |
|---------|-----------|
| 小修正（typo、1-2行変更） | なし |
| 中規模（新機能、リファクタ） | 実装後に `/codex-review` |
| 高リスク（アーキテクチャ変更） | 実装前に `/codex-design` + 実装後に `/codex-review` |

**原則**:
- **独立性**: Claude の自己評価を Codex に見せない（盲点の多様性確保）
- **スコープ**: repo 全体ではなく diff 単位に絞る
- **形式**: file:line 付きの構造化出力を求める
- **最終判断**: 人間が採否を決める

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
  settings.json            # 共有設定: hooks (git 管理)
  settings.local.json      # 個人設定: permissions, outputStyle (gitignore)
  hooks/
    guard-generated-files.sh  # dist/ + package-lock.json 編集ガード
    guard-secret-files.sh     # 秘密ファイル編集ガード
  rules/
    message-pipeline.md       # 電文パイプラインルール
    ui-output.md              # UI/表示ルール
    cli-config.md             # CLI/設定ルール
  commands/
    codex-review.md           # Codex レビューコマンド
    codex-design.md           # Codex 設計相談コマンド
    pre-release.md            # リリース前チェックリスト

~/.claude/
  settings.json           # グローバル: deny リスト, model, plugins
  skills/
    Codex/                # Codex CLI 連携スキル
    add-telegram-type/    # 電文追加手順スキル
```

## 変更方針

- Hook の追加・変更は、まず `settings.local.json` で検証し、安定したら `settings.json` に昇格
- Hook の追加時は「短時間・決定的・副作用最小」の3原則を満たすか確認する
- 重い検証（npm test, npm run build）を Hook に入れたくなったら、開発体験への影響を先に検証する
- Rules は 3〜5 本を目安とし、増やしすぎない（ノイズになる）
- Commands は繰り返し使うワークフローのみ定型化する
