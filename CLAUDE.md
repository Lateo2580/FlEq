# CLAUDE.md

dmdata.jp の地震・津波・EEW・火山電文を受信して表示する TypeScript CLI。

@AGENTS.md

ビルド・テストコマンド、コーディング規約、完了条件は `AGENTS.md`（Claude / Codex 共有）を参照。

## 実行

```bash
npm run dev          # ビルド + 実行
npm run dev:lowmem   # ビルド + メモリ最適化モードで実行 (--optimize-for-size)
npm run start:lowmem # メモリ最適化モードで実行
```

## アーキテクチャ（責務マップ）

| ディレクトリ | 責務 |
|-------------|------|
| `engine/cli/` | CLI 定義・起動ハンドラ |
| `engine/startup/` | 設定解決・起動時初期化 (津波/火山状態復元) |
| `engine/monitor/` | 実行中オーケストレーション・シャットダウン・REPL 協調 |
| `engine/messages/` | 電文ルーティング・津波/火山状態管理 |
| `engine/eew/` | EEW 追跡・ログ記録 |
| `engine/notification/` | デスクトップ通知・通知レベル判定・通知音 |
| `dmdata/` | dmdata.jp 通信 (REST, WebSocket) とパーサ |
| `ui/` | formatter / REPL / テーマ |

新しい電文対応は原則 **parser → router → formatter → notifier → test** の順で追加する。電文ルーティング・パーサ対応表・フレームレベル判定の詳細は `.claude/rules/message-pipeline.md` を参照。

## 実装上の注意

- 遅延ロード: `cli.ts → cli-run.ts / cli-init.ts`、`monitor.ts → repl.ts` は dynamic import（メモリ最適化）

## Claude Harness Policy

- `CLAUDE.md` は常設の制約・設計原則を置く（「憲法」）
- Skills は特定タスクの手順とチェックリストを置く
- Hooks は機械的に判定できる自動ガードだけを置く
- 重い検証やリリース判定は Hook に寄せず、npm scripts / CI に残す
- Hook は短時間・決定的・副作用最小を原則とする
- パス固有のルールは `.claude/rules/` に配置
- 詳細設計は `docs/specs/claude-harness.md` を参照

## レビュー方針

- コードレビューはサブエージェントではなく **Codex MCP に依頼**する
- Superpowers が生成した specs/plans は作業完了後 `C:/Users/meiri/Dev/Superpowers_Archive/` に移動し、`docs/superpowers/` を削除する

## Codex 併用ルール（分担表 v1, 2026-07-14）

| 用途 | モデル |
|---|---|
| 日常相談・探索・コード読解 | Terra medium |
| 中間 diff レビュー（フェーズ末含む） | Terra high |
| 定型実装の委譲 | Luna medium/high |
| 難しい範囲限定実装 | Sol medium/high |
| 最終全体レビュー・セキュリティ・見解衝突 | 新規スレッドの Sol high |

- **独立レビューは必ず新規 codex 呼び出し + read-only**。実装に使ったスレッドを流用しない
- **独立性**: Claude の自己評価を Codex に見せない（盲点の多様性確保）
- **実装委譲時は作業契約を必須とする**: 目的・完了条件・対象/非対象範囲・allowed_paths・base_oid 固定・禁止 git 操作・成果物は patch のみ（`git diff --binary --no-ext-diff`）。検証不能時は blocked 報告を認める（成功扱いにしない）
- 委譲環境は使い捨て clone で用意し、依存準備は `npm ci --ignore-scripts` を標準とする
- 委譲の段階導入・意味的手直し率の判定閾値は運用側メモ（memory `reference_model_division_v1`）を参照
- **スコープ**: repo 全体ではなく diff 単位に絞る
- **形式**: file:line 付きの構造化出力・確信度を求める。スタイルのみの指摘は不要と伝える
- **最終判断**: 人間が採否を決める

## Obsidian 記録

- セッション内で区切りがついたら（バグ修正完了、機能実装完了、調査結論など）Obsidian にセッションログを記録する
- 些細な成果でも記録する。記録しすぎて困ることはない
- ボルトの場所・テンプレート・運用ルールは memory の `reference_obsidian_vault.md` を参照

## リリースフロー

- **方針**: 機能まとめリリース。日々のコミットは `git push` で積み、意味のあるまとまり（新機能追加・複数のUI改善など）が溜まったタイミングでリリースする。コミットごとにリリースしない
- **コミット**: Conventional Commits 形式 (`feat:`, `fix:`, `refactor:` 等)
- **リリース手順**: `npm run release` → `git push --follow-tags`。破壊的変更は `npm run release:major`
