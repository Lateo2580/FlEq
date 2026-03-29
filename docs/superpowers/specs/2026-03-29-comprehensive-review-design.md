# FlEq 総合ヘルスチェック設計

## 概要

v1.50.0以降の大規模変更（Phase 0〜7 + 火山統合 + ミニマップv2）を中心に、既存コードも含めた総合的なコードレビュー・リファクタリング検証・ドキュメント整合確認を行う。

## 比較レンジ（固定）

- **基準**: `git diff v1.50.0..HEAD -- src/ test/`
- **除外パス**: `docs/site/`, `docs/superpowers/`, `.claude/commands/`, `node_modules/`
- **レビュー基準HEAD**: 実行開始時に `git rev-parse HEAD` で記録し、全フェーズで同一レンジを使用する

## 目的

1. v1.50.0以降の変更が既存コードと正しく統合されているか検証する
2. パフォーマンス・安定性に劣化がないか確認する
3. ドキュメントが現状のコードと一致しているか確認する
4. 既存コードのリファクタリング余地を洗い出す

## 調査対象

### 重点（v1.50.0以降の変更）

| フェーズ | 変更内容 | 主な影響ファイル |
|---------|---------|---------------|
| Phase 0 | 電文統計表示 | engine/messages/, ui/statistics-formatter |
| Phase 1 | PresentationEvent共通層 | engine/presentation/ |
| Phase 2 | フィルタ・テンプレート言語 | engine/filter/, engine/template/, ui/repl |
| Phase 3 | compact表示 | ui/ |
| Phase 4 | DiffStore・フォーカスモード | engine/presentation/ |
| Phase 5 | 定期サマリー | ui/summary/ |
| Phase 6 | ナイトモード | ui/night-overlay |
| Phase 7 | ASCIIミニマップ → v2(47県) | ui/minimap/ |
| 統合 | 火山パイプライン | dmdata/volcano-parser, engine/messages/, ui/volcano-formatter |
| インフラ | Claude Code harness整備 | .claude/, CLAUDE.md |

### 副次（既存コード）

v1.50.0以前からあるコード全体に対するリファクタリング余地の検証。

**対象選定基準**（以下のいずれかを満たすファイル）:
- 行数上位（500行超）
- 変更頻度上位（v1.50.0差分で多くの箇所が変更されたファイル）
- 依存の要所（多くのファイルから import されているモジュール）
- 複雑度上位（ネスト深度、分岐数が多い関数を含むファイル）

## 体制：Claude + Codex 協働

### 役割分担

観点別に分担し、同じ差分を異なる視点で独立にレビューする。

| 観点 | Claude（詳細レビュー） | Codex（アーキテクチャレビュー） |
|-----|----------------------|------------------------------|
| コード品質 | 差分精読・型整合性・エラーハンドリング・未使用コード・規約遵守・既存コードの匂い | 層間依存方向・責務分離・設計原則との乖離・テスト網羅性・既存ホットスポットの構造的問題 |
| パフォーマンス | 静的分析 + 実行時観測（メモリ/CPU、再接続、バックプレッシャー） | Claudeの発見に対するセカンドオピニオン + 長時間稼働安定性 |
| ドキュメント | specs/ ↔ コード突き合わせ、ガイド・ルールの鮮度確認 | 乖離リストのレビュー・見落とし指摘 |

### 連携プロトコル

1. Claudeが先に調査し発見リストを作成する
2. Codexに同じ差分を渡して独立レビューを依頼する（Claudeの発見は渡さない — 盲点の多様性確保）
3. 両者の結果をユーザーに提示し、対応方針を決定する
4. 承認された修正を実施する

### 共通レビュー入力（独立性と比較可能性の両立）

Claude/Codex両者に以下の共通条件を与える：
- **差分レンジ**: `git diff v1.50.0..HEAD -- src/ test/`（固定）
- **除外パス**: `docs/site/`, `docs/superpowers/`, `.claude/commands/`, `node_modules/`
- **出力フォーマット**: `severity (critical/warning/info) | file:line | issue | suggestion`
- **観点チェックリスト**: 各フェーズのチェック観点一覧（ただし相手の発見は共有しない）

### 突き合わせテーブル定義

比較表の必須列:

| 列 | 内容 |
|----|------|
| issue | 指摘内容 |
| severity | critical / warning / info |
| source | Claude / Codex / 両者 |
| disposition | 修正する / 将来課題 / 対応不要 |
| verification | 検証方法（テスト名、コマンド等） |

**フェーズ進行条件**: critical が全て disposition 決定済みであること。warning は保留可だが理由を記録する。

### 原則

- Claudeの自己評価をCodexに見せない（CLAUDE.md: 独立性ルール）
- レビューは差分単位に絞る（CLAUDE.md: スコープルール）
- 最終判断は人間が行う（CLAUDE.md: 最終判断ルール）

## 作業フロー

各観点について以下のサイクルを回す：

```
Claude調査 → Codex独立レビュー → 突き合わせ → ユーザー承認 → 修正実施
```

### 優先順位

1. **コード統合品質**（最優先）
2. **パフォーマンス・安定性**
3. **ドキュメント鮮度**

## 観点別チェックリスト

### 観点1: コード統合品質

**Claude（詳細レビュー）：**

- 型整合性: 新しい型（PresentationEvent等）と既存型の接続に不整合がないか
- エラーハンドリング: 新コードのエラーパスが既存のエラー処理パターンに従っているか
- 未使用コード: v2リファクタで不要になった旧コードが残っていないか
- import整合性: namespace import / named import がファイルごとに一貫しているか
- null チェック: `== null` 規約が守られているか
- 既存コードの匂い: 肥大化したファイル、責務の曖昧な関数、重複ロジック等

**Codex（アーキテクチャレビュー）：**

- 層間の依存方向が正しいか（dmdata → engine → ui の一方向）
- 各モジュールの責務が明確か
- 新機能が既存の設計原則を破っていないか
- テストの網羅性に穴がないか

### 観点2: パフォーマンス・安定性

**Claude：**

- 不要な再計算・冗長なループ
- メモリリーク候補（イベントリスナー未解除、蓄積し続けるデータ構造）
- lazy load が適切に使われているか
- WebSocket再接続・エラー時のリソース解放
- 既存コードのパフォーマンス改善余地
- 実行時観測: メモリ使用量推移、CPU負荷、再接続後の安定性

**Codex：**

- Claudeの発見リストに対するセカンドオピニオン
- 見落としている観点の指摘
- 長時間稼働時の安定性に関する追加観点

### 観点3: セキュリティ・堅牢性

**Claude：**

- APIキー等の秘密情報がログに露出しないか（secrets.ts のマスク処理）
- 異常電文・未知種別の電文に対するフォールバック挙動
- API エラー・レート制限時の再試行ロジック
- 入力バリデーション（filter/template DSL の悪意あるパターン）

### 観点4: 互換性

**Claude：**

- 設定ファイルの後方互換性（config マイグレーション）
- CLI オプション・出力形式の互換性
- TTY / 非TTY 環境での動作
- Node.js バージョン対応範囲

### 観点3: ドキュメント鮮度

**Claude：**

- `docs/specs/` 4ファイル（root.md, dmdata.md, engine.md, ui.md）と実コードの突き合わせ
- `docs/cli-features.md`, `docs/display-reference.md`, `docs/telegram-flow.md` の現状確認
- `.claude/rules/` 3ファイル（cli-config.md, message-pipeline.md, ui-output.md）の記述確認

**Codex：**

- 乖離リストのレビュー・見落とし指摘

## 成果物

- **issue台帳**: 全指摘の統合一覧（issue, severity, source, disposition, verification, 関連コミット）
- **修正コミット**: 承認された修正（Conventional Commits形式、日本語）
- **ドキュメント更新**: 乖離が見つかった仕様書・ガイドの修正
- **将来課題リスト**: 今回対応しない保留項目と理由の記録
