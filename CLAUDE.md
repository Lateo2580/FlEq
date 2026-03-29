# CLAUDE.md

dmdata.jp の地震・津波・EEW・火山電文を受信して表示する TypeScript CLI。

## ビルド・実行

```bash
npm run build        # TypeScript コンパイル → dist/
npm test             # vitest でテスト実行
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

## テスト

- テストは **vitest** (`npm test`)
- `test/setup.ts` で node-notifier をグローバルモック済み

## コーディング規約

- **import**: 近傍ファイルの既存スタイルに合わせる。`logger` / `theme` 等は namespace import (`import * as log from ...`) が多い。内部 named import も広く使われている
- **null チェック**: `== null` を使う（`=== null || === undefined` ではなく）
- **`any` 禁止**: strict TypeScript

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

## Codex 併用ルール

| 変更規模 | Codex 利用 |
|---------|-----------|
| 小修正（typo、1-2行変更） | なし |
| 中規模（新機能、リファクタ） | 実装後に `/codex-review` |
| 高リスク（アーキテクチャ変更） | 実装前に `/codex-design` + 実装後に `/codex-review` |

- **独立性**: Claude の自己評価を Codex に見せない（盲点の多様性確保）
- **スコープ**: repo 全体ではなく diff 単位に絞る
- **形式**: file:line 付きの構造化出力を求める
- **最終判断**: 人間が採否を決める

## Obsidian 記録

- セッション内で区切りがついたら（バグ修正完了、機能実装完了、調査結論など）Obsidian にセッションログを記録する
- 些細な成果でも記録する。記録しすぎて困ることはない
- ボルトの場所・テンプレート・運用ルールは memory の `reference_obsidian_vault.md` を参照

## リリースフロー

- **方針**: 機能まとめリリース。日々のコミットは `git push` で積み、意味のあるまとまり（新機能追加・複数のUI改善など）が溜まったタイミングでリリースする。コミットごとにリリースしない
- **コミット**: Conventional Commits 形式 (`feat:`, `fix:`, `refactor:` 等)
- **リリース手順**: `npm run release` → `git push --follow-tags`。破壊的変更は `npm run release:major`
