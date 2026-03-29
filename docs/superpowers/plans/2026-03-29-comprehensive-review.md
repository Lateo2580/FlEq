# FlEq 総合ヘルスチェック実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** v1.50.0以降の大規模変更と既存コードの総合レビューを Claude + Codex 協働で実施し、品質・パフォーマンス・ドキュメントの問題を修正する。

**Architecture:** 3つの観点（コード品質 → パフォーマンス → ドキュメント）を順に調査する。各観点で Claude が詳細レビュー、Codex がアーキテクチャ/セカンドオピニオンを独立に行い、結果を突き合わせてユーザー承認後に修正する。

**Tech Stack:** TypeScript, Vitest, Codex MCP

**設計ドキュメント:** `docs/superpowers/specs/2026-03-29-comprehensive-review-design.md`

---

## 調査対象ファイルマップ

### v1.50.0以降の新規・変更ファイル（重点レビュー）

| 領域 | ファイル群 | 行数目安 |
|------|----------|---------|
| presentation層 | `src/engine/presentation/events/*.ts` (8), `processors/*.ts` (9), `types.ts`, `diff-store.ts`, `diff-types.ts`, `level-helpers.ts` | ~1,100行 |
| filter言語 | `src/engine/filter/*.ts` (10) | ~760行 |
| template言語 | `src/engine/template/*.ts` (8) | ~640行 |
| filter-template統合 | `src/engine/filter-template/pipeline.ts` | ~50行 |
| minimap v2 | `src/ui/minimap/*.ts` (5) | ~300行 |
| summary | `src/ui/summary/*.ts` (6) | ~400行 |
| night overlay | `src/ui/night-overlay.ts` | ~50行 |
| statistics | `src/ui/statistics-formatter.ts`, `src/engine/messages/telegram-stats.ts` | ~200行 |
| tip shuffler | `src/ui/tip-shuffler.ts`, `src/ui/waiting-tips.ts` | ~200行 |

### 既存コード（リファクタ余地チェック）

| ファイル | 行数 | 注目ポイント |
|---------|------|------------|
| `src/ui/repl.ts` | 2,611行 | 肥大化。責務分割の余地 |
| `src/ui/earthquake-formatter.ts` | 954行 | 肥大化。表示ロジック集中 |
| `src/ui/formatter.ts` | 862行 | 共通ユーティリティ肥大化 |
| `src/types.ts` | 806行 | 型定義集中 |
| `src/engine/messages/message-router.ts` | 442行 | ルーティングロジック集中 |
| `src/dmdata/telegram-parser.ts` | ? | パーサ群 |
| `src/dmdata/rest-client.ts` | ? | REST API関数群 |

### テスト（44ファイル、v1.50.0以降追加分）

全テストファイルは `test/` 以下に対応する構造で配置。

---

## Phase 1: コード統合品質（最優先）

### Task 1: Claude — 新規コードの詳細レビュー

v1.50.0以降に追加・変更された全ファイルを精読し、統合上の問題を洗い出す。

**対象ファイル:**
- `src/engine/presentation/` 以下全ファイル
- `src/engine/filter/` 以下全ファイル
- `src/engine/template/` 以下全ファイル
- `src/engine/filter-template/pipeline.ts`
- `src/engine/messages/message-router.ts`, `telegram-stats.ts`, `summary-tracker.ts`
- `src/ui/minimap/` 以下全ファイル
- `src/ui/summary/` 以下全ファイル
- `src/ui/night-overlay.ts`, `src/ui/statistics-formatter.ts`
- `src/ui/tip-shuffler.ts`, `src/ui/waiting-tips.ts`
- `src/ui/formatter.ts`, `src/ui/earthquake-formatter.ts`, `src/ui/eew-formatter.ts`, `src/ui/volcano-formatter.ts`
- `src/ui/repl.ts`（新コマンド追加部分）
- `src/config.ts`, `src/types.ts`（変更部分）
- `src/engine/cli/cli.ts`, `src/engine/cli/cli-run.ts`（変更部分）
- `src/engine/monitor/monitor.ts`（変更部分）
- `src/engine/startup/config-resolver.ts`（変更部分）

**チェック観点:**

- [ ] **Step 1: 型整合性チェック**
  - PresentationEvent 型と各 from-*.ts の返却型が一致しているか
  - processors/*.ts が events/*.ts の出力を正しく消費しているか
  - filter/template の型定義が types.ts の AppConfig と整合しているか
  - 新しい config オプションが config.ts のバリデーション・デフォルト値に反映されているか

- [ ] **Step 2: エラーハンドリングチェック**
  - presentation層: 不正な電文データが渡された場合の挙動
  - filter/template: パース・コンパイルエラーの伝播パス
  - minimap/summary: データ欠損時のフォールバック
  - WebSocket切断→再接続時に新機能の状態がリセットされるか

- [ ] **Step 3: 未使用コード・デッドコード検出**
  - ミニマップ v1（12ブロック）の残存コード
  - リファクタで不要になった旧関数・旧エクスポート
  - 未参照の型定義

  ```bash
  # 未使用エクスポートの手がかり
  npx tsc --noEmit 2>&1 | head -50
  ```

- [ ] **Step 4: コーディング規約チェック**
  - `== null` vs `=== null || === undefined`
  - import スタイル（namespace vs named）の一貫性
  - `any` の使用箇所

  ```bash
  # any の検出
  grep -rn ': any' src/ --include='*.ts' | grep -v node_modules
  # === null の検出
  grep -rn '=== null' src/ --include='*.ts' | grep -v node_modules
  ```

- [ ] **Step 5: 発見リストを整理**
  - 各発見に severity（critical / warning / info）と対象ファイル:行番号を付与
  - 修正提案を添える

### Task 2: Claude — 既存コードのリファクタ余地チェック

v1.50.0以前から存在するコードの構造的な問題を洗い出す。

**対象ファイル:**
- `src/ui/repl.ts` (2,611行)
- `src/ui/earthquake-formatter.ts` (954行)
- `src/ui/formatter.ts` (862行)
- `src/types.ts` (806行)
- `src/engine/messages/message-router.ts` (442行)
- `src/dmdata/telegram-parser.ts`
- `src/dmdata/rest-client.ts`
- `src/dmdata/ws-client.ts`
- `src/engine/eew/eew-tracker.ts`
- `src/engine/notification/` 以下

**チェック観点:**

- [ ] **Step 1: ファイル肥大化の分析**
  - repl.ts: コマンド定義、コマンド実行ロジック、表示ロジックが混在していないか
  - earthquake-formatter.ts: 表示パターンごとの分割余地
  - formatter.ts: 共通ユーティリティの整理余地
  - types.ts: 型グループごとの分割余地

- [ ] **Step 2: 重複ロジックの検出**
  - formatter間（earthquake / eew / volcano）で共通化できるパターン
  - エラーハンドリングの重複
  - 色・スタイル適用の重複

- [ ] **Step 3: 責務の曖昧さ**
  - formatter.ts に表示ロジック以外の責務がないか
  - message-router.ts にルーティング以外の処理がないか
  - monitor.ts と repl.ts の境界

- [ ] **Step 4: 発見リストを整理**
  - リファクタ提案に工数見積もり（小/中/大）を付与
  - 「今回やるべき」vs「将来課題」を区分

### Task 3: Codex — アーキテクチャレビュー

`/codex-review` スキルでCodexに独立レビューを依頼する。Claude の発見は渡さない。

**依頼内容:**
- v1.50.0 (タグ) から HEAD までの差分に対するアーキテクチャレビュー
- チェック観点:
  1. 層間の依存方向（dmdata → engine → ui）が守られているか
  2. 各モジュールの責務は明確か
  3. 新機能が既存の設計原則を破っていないか
  4. テストの網羅性に穴がないか
  5. 既存コードで改善すべき構造的問題

- [ ] **Step 1: `/codex-review` を実行**
  - 差分スコープ: `git diff v1.50.0..HEAD -- src/ test/`
  - Claude の発見リストは含めない

- [ ] **Step 2: Codex の回答を記録**

### Task 4: 品質レビュー突き合わせ・ユーザー承認

- [ ] **Step 1: Claude と Codex の発見を並べて比較表を作成**
  - 両者が指摘した共通問題
  - Claude のみ / Codex のみの指摘
  - 矛盾する意見

- [ ] **Step 2: ユーザーに比較表を提示し、対応方針を決定**
  - 各発見に対して「修正する / 将来課題 / 対応不要」を判断してもらう

- [ ] **Step 3: 承認された修正の実施**
  - 修正ごとにテスト実行で回帰がないことを確認
  ```bash
  npm test
  ```
  - 修正ごとにコミット（Conventional Commits、日本語）

---

## Phase 2: パフォーマンス・安定性

### Task 5: Claude — パフォーマンス静的分析

**対象:** src/ 全体（新旧問わず）

- [ ] **Step 1: メモリリーク候補の調査**
  - イベントリスナーの登録と解除の対応
  - 蓄積し続けるデータ構造（Map, Array の肥大化）
  - setInterval / setTimeout の解除漏れ
  ```bash
  # イベントリスナー登録の検出
  grep -rn '\.on(' src/ --include='*.ts' | grep -v node_modules
  grep -rn 'setInterval\|setTimeout' src/ --include='*.ts' | grep -v node_modules
  ```

- [ ] **Step 2: 不要な再計算・冗長処理の調査**
  - ホットパス（電文受信→表示のメインループ）での無駄な処理
  - フォーマッタ内の文字列連結の効率性
  - minimap/summary の更新頻度と計算コスト

- [ ] **Step 3: lazy load の適切さ**
  - dynamic import が意図通りに機能しているか
  - 起動時に不要なモジュールが読み込まれていないか

- [ ] **Step 4: リソース解放の確認**
  - WebSocket切断時のクリーンアップ
  - シャットダウン時の全リソース解放パス
  - ファイルハンドル・プロセスの解放

- [ ] **Step 5: 発見リストを整理**
  - 各発見に影響度（高/中/低）と対象ファイル:行番号を付与

### Task 6: Codex — パフォーマンス・セカンドオピニオン

- [ ] **Step 1: `/codex-review` を実行**
  - Claude の発見リストを見せずに、パフォーマンス観点でのレビューを依頼
  - 特に: メモリ使用量、長時間稼働時の安定性、WebSocket再接続の堅牢性

- [ ] **Step 2: Codex の回答を記録**

### Task 7: パフォーマンスレビュー突き合わせ・ユーザー承認

- [ ] **Step 1: Claude と Codex の発見を並べて比較表を作成**

- [ ] **Step 2: ユーザーに比較表を提示し、対応方針を決定**

- [ ] **Step 3: 承認された修正の実施**
  - 修正ごとにテスト実行
  ```bash
  npm test
  ```
  - 修正ごとにコミット

---

## Phase 3: ドキュメント鮮度

### Task 8: Claude — ドキュメント ↔ コード突き合わせ

**対象ドキュメント:**
- `docs/specs/root.md` (412行) ↔ `src/index.ts`, `src/types.ts`, `src/config.ts`, `src/logger.ts`, `src/utils/`
- `docs/specs/dmdata.md` (533行) ↔ `src/dmdata/`
- `docs/specs/engine.md` (1,366行) ↔ `src/engine/`
- `docs/specs/ui.md` (652行) ↔ `src/ui/`
- `docs/cli-features.md` ↔ 各機能の実装
- `docs/display-reference.md` ↔ フォーマッタの出力
- `docs/telegram-flow.md` ↔ 電文処理フロー
- `.claude/rules/cli-config.md` ↔ `src/config.ts`, `src/engine/cli/`
- `.claude/rules/message-pipeline.md` ↔ `src/engine/messages/`, `src/engine/presentation/`
- `.claude/rules/ui-output.md` ↔ `src/ui/`

- [ ] **Step 1: specs/ 4ファイルの突き合わせ**
  - 各セクションに記述された関数・型・エクスポートが現コードに存在するか
  - v1.50.0以降に追加された機能（presentation, filter, template, minimap v2, summary, night, stats）が仕様書に記載されているか
  - 削除・変更された機能の記述が残っていないか

- [ ] **Step 2: ガイド・リファレンスの突き合わせ**
  - cli-features.md のコマンド・オプション説明が実装と一致するか
  - display-reference.md の表示サンプルが現在の出力と一致するか
  - telegram-flow.md のフロー図が現在のパイプラインと一致するか

- [ ] **Step 3: ルールファイルの突き合わせ**
  - message-pipeline.md のルーティング優先順位・パーサ対応表が現コードと一致するか
  - ui-output.md の規約が現コードで守られているか
  - cli-config.md の設定優先順位が実装と一致するか

- [ ] **Step 4: 乖離リストを整理**
  - 各乖離に「ドキュメント側を修正」vs「コード側に問題あり」を判定

### Task 9: Codex — ドキュメント乖離レビュー

- [ ] **Step 1: `/codex-review` を実行**
  - Claude の乖離リストを見せずに、ドキュメントの正確性レビューを依頼
  - 主要 specs/ ファイルと対応するソースコードを対象に

- [ ] **Step 2: Codex の回答を記録**

### Task 10: ドキュメントレビュー突き合わせ・修正

- [ ] **Step 1: Claude と Codex の発見を並べて比較表を作成**

- [ ] **Step 2: ユーザーに比較表を提示し、対応方針を決定**

- [ ] **Step 3: 承認されたドキュメント修正の実施**
  - 修正ごとにコミット

---

## Phase 4: 最終確認

### Task 11: 全体テスト・最終検証

- [ ] **Step 1: 全テスト実行**
  ```bash
  npm test
  ```

- [ ] **Step 2: TypeScript コンパイルチェック**
  ```bash
  npm run build
  ```

- [ ] **Step 3: 変更のまとめをユーザーに報告**
  - 修正一覧（コミット単位）
  - 残存する将来課題リスト
  - パフォーマンス改善の効果見込み
