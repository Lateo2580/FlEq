# FlEq 総合ヘルスチェック実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** v1.50.0以降の大規模変更と既存コードの総合レビューを Claude + Codex 協働で実施し、品質・パフォーマンス・ドキュメントの問題を修正する。

**Architecture:** 4つの観点（コード品質 → パフォーマンス・安定性 → セキュリティ・互換性 → ドキュメント）を順に調査する。各観点で Claude が詳細レビュー、Codex がアーキテクチャ/セカンドオピニオンを独立に行い、結果を突き合わせてユーザー承認後に修正する。

**Tech Stack:** TypeScript, Vitest, Codex MCP

**設計ドキュメント:** `docs/superpowers/specs/2026-03-29-comprehensive-review-design.md`

---

## 比較レンジ（固定）

```bash
# 実行開始時に記録
REVIEW_HEAD=$(git rev-parse HEAD)
echo "Review HEAD: $REVIEW_HEAD"

# 全フェーズ共通の差分レンジ
git diff v1.50.0..${REVIEW_HEAD} -- src/ test/

# 除外パス
# docs/site/, docs/superpowers/, .claude/commands/, node_modules/
```

## 共通レビュー入力

Claude/Codex両者に以下の共通条件を与える:
- **差分レンジ**: `git diff v1.50.0..HEAD -- src/ test/`
- **除外パス**: `docs/site/`, `docs/superpowers/`, `.claude/commands/`, `node_modules/`
- **出力フォーマット**: `severity (critical/warning/info) | file:line | issue | suggestion`

## 突き合わせテーブル定義

| 列 | 内容 |
|----|------|
| issue | 指摘内容 |
| severity | critical / warning / info |
| source | Claude / Codex / 両者 |
| disposition | 修正する / 将来課題 / 対応不要 |
| verification | 検証方法（テスト名、コマンド等） |

**フェーズ進行条件**: critical が全て disposition 決定済みであること。warning は保留可だが理由を記録する。

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
| 火山パイプライン | `src/dmdata/volcano-parser.ts`, `src/ui/volcano-formatter.ts`, `src/engine/presentation/events/from-volcano.ts`, `src/engine/presentation/processors/process-volcano.ts` | ~250行 |
| DiffStore | `src/engine/presentation/diff-store.ts`, `src/engine/presentation/diff-types.ts` | ~150行 |
| Claude harness | `.claude/rules/*.md`, `.claude/settings.json` | 設定ファイル群 |

### 既存コード（リファクタ余地チェック）

**対象選定基準**（以下のいずれかを満たすファイル）:
- 行数上位（500行超）
- 変更頻度上位（v1.50.0差分で多くの箇所が変更されたファイル）
- 依存の要所（多くのファイルから import されているモジュール）
- 複雑度上位（ネスト深度、分岐数が多い関数を含むファイル）

| ファイル | 行数 | 選定理由 |
|---------|------|---------|
| `src/ui/repl.ts` | 2,611行 | 行数上位・変更頻度上位・複雑度上位 |
| `src/ui/earthquake-formatter.ts` | 954行 | 行数上位 |
| `src/ui/formatter.ts` | 862行 | 行数上位・依存の要所 |
| `src/types.ts` | 806行 | 行数上位・依存の要所 |
| `src/engine/messages/message-router.ts` | 442行 | 依存の要所・変更頻度上位 |
| `src/dmdata/telegram-parser.ts` | 要計測 | 依存の要所 |
| `src/dmdata/rest-client.ts` | 要計測 | 依存の要所 |
| `src/dmdata/ws-client.ts` | 要計測 | 依存の要所・複雑度上位 |
| `src/engine/eew/eew-tracker.ts` | 要計測 | 複雑度上位 |
| `src/config.ts` | 要計測 | 依存の要所・変更頻度上位 |

```bash
# 対象選定の補助: 行数上位ファイル
find src/ -name '*.ts' -exec wc -l {} + | sort -rn | head -20

# 対象選定の補助: v1.50.0以降の変更量上位
git diff --stat v1.50.0..HEAD -- src/ | sort -t'|' -k2 -rn | head -20

# 対象選定の補助: import 被参照数上位
for f in src/**/*.ts; do echo "$(grep -rl "$(basename $f .ts)" src/ --include='*.ts' | wc -l) $f"; done | sort -rn | head -20
```

### テスト（44ファイル、v1.50.0以降追加分）

全テストファイルは `test/` 以下に対応する構造で配置。

---

## Phase 1: コード統合品質（最優先）

### Task 1: Claude — 新規コードの詳細レビュー

v1.50.0以降に追加・変更された全ファイルを精読し、統合上の問題を洗い出す。

**対象ファイル:**
- `src/engine/presentation/` 以下全ファイル（events/, processors/, types.ts, diff-store.ts, diff-types.ts, level-helpers.ts）
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
- `src/dmdata/volcano-parser.ts`（火山パイプライン）
- `src/config.ts`, `src/types.ts`（変更部分）
- `src/engine/cli/cli.ts`, `src/engine/cli/cli-run.ts`（変更部分）
- `src/engine/monitor/monitor.ts`（変更部分）
- `src/engine/startup/config-resolver.ts`（変更部分）
- `.claude/rules/*.md`, `.claude/settings.json`（Claude harness）

**チェック観点:**

- [ ] **Step 1: 型整合性チェック**
  - PresentationEvent 型と各 from-*.ts の返却型が一致しているか
  - processors/*.ts が events/*.ts の出力を正しく消費しているか
  - filter/template の型定義が types.ts の AppConfig と整合しているか
  - 新しい config オプションが config.ts のバリデーション・デフォルト値に反映されているか
  - DiffStore の型と PresentationEvent の関係が正しいか

- [ ] **Step 2: エラーハンドリングチェック**
  - presentation層: 不正な電文データが渡された場合の挙動
  - filter/template: パース・コンパイルエラーの伝播パス
  - minimap/summary: データ欠損時のフォールバック
  - 火山パイプライン: volcano-parser のエラーパスが message-router に正しく伝播するか
  - WebSocket切断→再接続時に新機能の状態（DiffStore, SummaryModel, TelegramStats）がリセットされるか

- [ ] **Step 3: 未使用コード・デッドコード検出**
  - ミニマップ v1（12ブロック）の残存コード
  - リファクタで不要になった旧関数・旧エクスポート
  - 未参照の型定義

  ```bash
  npx tsc --noEmit 2>&1 | head -50
  ```

- [ ] **Step 4: コーディング規約チェック**
  - `== null` vs `=== null || === undefined`
  - import スタイル（namespace vs named）の一貫性
  - `any` の使用箇所

  ```bash
  grep -rn ': any' src/ --include='*.ts' | grep -v node_modules
  grep -rn '=== null' src/ --include='*.ts' | grep -v node_modules
  ```

- [ ] **Step 5: 発見リストを整理**
  - 出力フォーマット: `severity (critical/warning/info) | file:line | issue | suggestion`
  - 修正提案を添える

### Task 2: Claude — 既存コードのリファクタ余地チェック

v1.50.0以前から存在するコードの構造的な問題を洗い出す。

**対象ファイル:** 上記「既存コード」テーブルの全ファイル。

**対象選定の実行:**

- [ ] **Step 0: 対象ファイルの確定**
  ```bash
  # 行数上位
  find src/ -name '*.ts' -exec wc -l {} + | sort -rn | head -20
  # 変更量上位
  git diff --stat v1.50.0..HEAD -- src/ | sort -t'|' -k2 -rn | head -20
  ```
  テーブルに記載の「要計測」ファイルの行数を確定し、選定基準に照らして対象を最終決定する。

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
  - ws-client.ts の接続管理と再接続ロジックの分離

- [ ] **Step 4: 発見リストを整理**
  - リファクタ提案に工数見積もり（小/中/大）を付与
  - 「今回やるべき」vs「将来課題」を区分
  - 出力フォーマット: `severity | file:line | issue | suggestion`

### Task 3: Codex — アーキテクチャレビュー

Codexに独立レビューを依頼する。Claude の発見は渡さない。

**共通入力:**
- 差分レンジ: `git diff v1.50.0..HEAD -- src/ test/`
- 出力フォーマット: `severity (critical/warning/info) | file:line | issue | suggestion`

**依頼内容:**
- v1.50.0からHEADまでの差分 + 既存ホットスポット（repl.ts, formatter.ts, earthquake-formatter.ts, types.ts, message-router.ts, ws-client.ts）に対するアーキテクチャレビュー
- チェック観点:
  1. 層間の依存方向（dmdata → engine → ui）が守られているか
  2. 各モジュールの責務は明確か
  3. 新機能が既存の設計原則を破っていないか
  4. テストの網羅性に穴がないか
  5. 既存ホットスポットの構造的問題と改善提案

- [ ] **Step 1: Codex にレビューを依頼**
  - 差分スコープ: `git diff v1.50.0..HEAD -- src/ test/`
  - 既存ホットスポットファイルの現在の内容も対象に含める
  - Claude の発見リストは含めない

- [ ] **Step 2: Codex の回答を記録**

### Task 4: 品質レビュー突き合わせ・ユーザー承認

- [ ] **Step 1: Claude と Codex の発見を突き合わせテーブルに統合**

  | issue | severity | source | disposition | verification |
  |-------|----------|--------|-------------|--------------|
  | (指摘内容) | critical/warning/info | Claude/Codex/両者 | (ユーザー決定) | (検証方法) |

- [ ] **Step 2: ユーザーに比較表を提示し、対応方針を決定**
  - 各発見に対して「修正する / 将来課題 / 対応不要」を判断してもらう
  - **フェーズ進行条件**: critical が全て disposition 決定済み

- [ ] **Step 3: 承認された修正の実施**
  - 修正ごとに必要なテストを追加
  - 修正ごとにテスト実行で回帰がないことを確認
  ```bash
  npm test
  ```
  - 修正ごとにコミット（Conventional Commits、日本語）

---

## Phase 2: パフォーマンス・安定性

### Task 5: Claude — パフォーマンス分析（静的 + 実行時）

**対象:** src/ 全体（新旧問わず）

#### 静的分析

- [ ] **Step 1: メモリリーク候補の調査**
  - イベントリスナーの登録と解除の対応
  - 蓄積し続けるデータ構造（Map, Array の肥大化）
  - setInterval / setTimeout の解除漏れ
  ```bash
  grep -rn '\.on(' src/ --include='*.ts' | grep -v node_modules
  grep -rn 'setInterval\|setTimeout' src/ --include='*.ts' | grep -v node_modules
  grep -rn '\.removeListener\|\.off(' src/ --include='*.ts' | grep -v node_modules
  grep -rn 'clearInterval\|clearTimeout' src/ --include='*.ts' | grep -v node_modules
  ```

- [ ] **Step 2: 不要な再計算・冗長処理の調査**
  - ホットパス（電文受信→表示のメインループ）での無駄な処理
  - フォーマッタ内の文字列連結の効率性
  - minimap/summary の更新頻度と計算コスト

- [ ] **Step 3: lazy load の適切さ**
  - dynamic import が意図通りに機能しているか
  - 起動時に不要なモジュールが読み込まれていないか

- [ ] **Step 4: リソース解放の確認**
  - WebSocket切断時のクリーンアップ（ws-client.ts, connection-manager.ts）
  - シャットダウン時の全リソース解放パス（monitor.ts の shutdown）
  - ファイルハンドル・プロセスの解放
  - DiffStore/SummaryModel/TelegramStats のクリーンアップ

#### 実行時観測

- [ ] **Step 5: メモリ使用量の確認**
  - 起動直後の RSS/heapUsed を記録
  - 可能であれば `--expose-gc` + `process.memoryUsage()` でベースラインを計測
  ```bash
  node --expose-gc -e "
    global.gc();
    const before = process.memoryUsage();
    require('./dist/index.js');
    setTimeout(() => {
      global.gc();
      const after = process.memoryUsage();
      console.log('RSS:', Math.round(after.rss/1024/1024), 'MB');
      console.log('Heap:', Math.round(after.heapUsed/1024/1024), 'MB');
    }, 3000);
  "
  ```

- [ ] **Step 6: WebSocket再接続の堅牢性確認**
  - ws-client.ts / connection-manager.ts の再接続ロジックをコードレビュー
  - 再接続時に新機能の状態がリセット/復元されるか確認
  - バックプレッシャー（電文の受信速度が処理速度を上回る場合）の対策確認

- [ ] **Step 7: 発見リストを整理**
  - 各発見に影響度（高/中/低）と対象ファイル:行番号を付与
  - 出力フォーマット: `severity | file:line | issue | suggestion`

### Task 6: Codex — パフォーマンス・セカンドオピニオン

**共通入力:**
- 差分レンジ: `git diff v1.50.0..HEAD -- src/ test/`
- 出力フォーマット: `severity (critical/warning/info) | file:line | issue | suggestion`

- [ ] **Step 1: Codex にレビューを依頼**
  - Claude の発見リストを見せずに、パフォーマンス・安定性観点でのレビューを依頼
  - 特に: メモリ使用量、長時間稼働時の安定性、WebSocket再接続の堅牢性、バックプレッシャー

- [ ] **Step 2: Codex の回答を記録**

### Task 7: パフォーマンスレビュー突き合わせ・ユーザー承認

- [ ] **Step 1: Claude と Codex の発見を突き合わせテーブルに統合**

- [ ] **Step 2: ユーザーに比較表を提示し、対応方針を決定**
  - **フェーズ進行条件**: critical が全て disposition 決定済み

- [ ] **Step 3: 承認された修正の実施**
  - 修正ごとに必要なテストを追加
  - 修正ごとにテスト実行
  ```bash
  npm test
  ```
  - 修正ごとにコミット

---

## Phase 3: セキュリティ・互換性

### Task 8: Claude — セキュリティ・堅牢性チェック

- [ ] **Step 1: 秘密情報の取り扱い確認**
  - `src/utils/secrets.ts` のマスク処理が全ログ出力パスで適用されているか
  - APIキーが平文でログ・エラーメッセージに含まれないか
  ```bash
  grep -rn 'apiKey\|api_key\|token\|secret\|password' src/ --include='*.ts' | grep -v node_modules
  ```

- [ ] **Step 2: 異常入力への堅牢性**
  - 壊れた電文XML（不正なUTF-8、切り詰められたデータ）への対応
  - 未知の電文種別（head.type が想定外）のフォールバック
  - filter/template DSL への悪意あるパターン（深いネスト、巨大な入力）

- [ ] **Step 3: API エラー・レート制限**
  - dmdata REST API のエラーレスポンス（429, 5xx等）への対応
  - 再試行ロジックの妥当性（指数バックオフ等）
  - 認証トークン期限切れ時の再認証フロー

- [ ] **Step 4: 発見リストを整理**
  - 出力フォーマット: `severity | file:line | issue | suggestion`

### Task 9: Claude — 互換性チェック

- [ ] **Step 1: 設定ファイルの後方互換性**
  - config.ts のマイグレーションロジックが v1.50.0 以前の設定を正しく移行するか
  - 新しい設定項目にデフォルト値が設定されているか
  - config バリデーションが不正な値を適切に拒否するか

- [ ] **Step 2: CLI オプション・出力形式の互換性**
  - 新しいCLIオプション（--filter, --template, --compact 等）が既存オプションと競合しないか
  - 出力形式の変更が既存ユーザーの期待を壊さないか

- [ ] **Step 3: 環境互換性**
  - TTY / 非TTY 環境での chalk カラー出力の挙動
  - Windows / macOS / Linux でのパス処理（config.ts のOS別パス）
  - package.json の engines フィールドと実際の Node.js 互換性

- [ ] **Step 4: 発見リストを整理**
  - 出力フォーマット: `severity | file:line | issue | suggestion`

### Task 10: セキュリティ・互換性の突き合わせ・ユーザー承認

- [ ] **Step 1: 発見を突き合わせテーブルに統合**
  - セキュリティ指摘は severity を1段上げて評価

- [ ] **Step 2: ユーザーに提示し、対応方針を決定**
  - **フェーズ進行条件**: critical が全て disposition 決定済み

- [ ] **Step 3: 承認された修正の実施**
  - 修正ごとにテスト追加・実行
  ```bash
  npm test
  ```
  - 修正ごとにコミット

---

## Phase 4: ドキュメント鮮度

### Task 11: Claude — ドキュメント ↔ コード突き合わせ

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
  - v1.50.0以降に追加された機能（presentation, filter, template, minimap v2, summary, night, stats, DiffStore, 火山パイプライン）が仕様書に記載されているか
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
  - 出力フォーマット: `severity | file:line | issue | suggestion`

### Task 12: Codex — ドキュメント乖離レビュー

**共通入力:**
- 差分レンジ: `git diff v1.50.0..HEAD -- src/ test/`
- 対象ドキュメント: `docs/specs/*.md`
- 出力フォーマット: `severity (critical/warning/info) | file:line | issue | suggestion`

- [ ] **Step 1: Codex にレビューを依頼**
  - Claude の乖離リストを見せずに、ドキュメントの正確性レビューを依頼
  - 主要 specs/ ファイルと対応するソースコードを対象に

- [ ] **Step 2: Codex の回答を記録**

### Task 13: ドキュメントレビュー突き合わせ・修正

- [ ] **Step 1: Claude と Codex の発見を突き合わせテーブルに統合**

- [ ] **Step 2: ユーザーに比較表を提示し、対応方針を決定**

- [ ] **Step 3: 承認されたドキュメント修正の実施**
  - 修正ごとにコミット

---

## Phase 5: 最終確認

### Task 14: 全体テスト・最終検証

- [ ] **Step 1: 全テスト実行**
  ```bash
  npm test
  ```

- [ ] **Step 2: TypeScript コンパイルチェック**
  ```bash
  npm run build
  ```

- [ ] **Step 3: 修正後のドキュメント再照合**
  - Phase 1〜3 の修正で新たなドキュメント乖離が生じていないか確認
  - 修正で変更したファイルに対応する specs/ セクションが正確か検証
  - 完了条件: 主要仕様書・ガイドが現実装と一致

- [ ] **Step 4: issue台帳の最終整理**
  - 全指摘の disposition が記入されていることを確認
  - 将来課題リストを作成（保留項目と理由）

- [ ] **Step 5: 変更のまとめをユーザーに報告**
  - 修正一覧（コミット単位）
  - issue台帳（全指摘の対応状況）
  - 残存する将来課題リスト
  - パフォーマンス改善の効果見込み
