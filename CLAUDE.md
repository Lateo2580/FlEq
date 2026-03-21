# CLAUDE.md

## プロジェクト概要

dmdata.jp API を利用した地震・津波・緊急地震速報(EEW)リアルタイムモニタリング CLI ツール。
WebSocket 経由で電文を受信し、パース・色付き表示を行う。

## ビルド・実行

```bash
npm install          # 依存インストール
npm run build        # TypeScript コンパイル → dist/
npm start            # コンパイル済みアプリ実行
npm run start:lowmem # メモリ最適化モードで実行 (--optimize-for-size)
npm run dev          # ビルド + 実行
npm run dev:lowmem   # ビルド + メモリ最適化モードで実行
npm run clean        # dist/ 削除
npm test             # vitest でテスト実行
```

## 技術スタック

- TypeScript 5.7 (strict モード) / Node.js >= 18
- commander — CLI引数パース
- ws — WebSocket クライアント
- fast-xml-parser — XML電文パース
- chalk ^4 (CommonJS版) — ターミナル色付け
- dotenv — 環境変数読み込み
- node-notifier (optional) — デスクトップ通知

## ディレクトリ構成

```
src/
├── index.ts                    # エントリポイント (薄いブートストラップのみ)
├── types.ts                    # 共有型定義
├── config.ts                   # Configファイル管理 (読み書き・バリデーション)
├── logger.ts                   # ログレベル付きロガー
├── utils/
│   ├── intensity.ts            # 震度ランク変換 (intensityToRank)
│   └── secrets.ts              # APIキーマスク (maskApiKey)
├── engine/
│   ├── cli/
│   │   ├── cli.ts              # Commander CLI定義
│   │   ├── cli-init.ts         # インタラクティブ初期設定 (fleq init)
│   │   └── cli-run.ts          # CLIアクションハンドラ (起動バナー・契約チェック)
│   ├── startup/
│   │   ├── config-resolver.ts  # 設定解決 (CLI引数→環境変数→Config→デフォルト)
│   │   ├── tsunami-initializer.ts # 起動時の津波警報状態復元 (REST API)
│   │   ├── volcano-initializer.ts # 起動時の火山警報状態復元 (REST API)
│   │   └── update-checker.ts   # npm 最新バージョンチェック
│   ├── monitor/
│   │   ├── monitor.ts          # メインオーケストレーション (接続・受信委譲)
│   │   ├── shutdown.ts         # グレースフルシャットダウン処理
│   │   └── repl-coordinator.ts # REPL表示・接続状態の協調制御
│   ├── messages/
│   │   ├── message-router.ts   # 受信メッセージの分類・振り分け (全27種類)
│   │   ├── volcano-vfvo53-aggregator.ts # VFVO53 定時バッチ集約 (複数火山まとめ表示)
│   │   ├── tsunami-state.ts    # 津波警報状態管理 (プロンプト表示・detail コマンド)
│   │   └── volcano-state.ts    # 火山警報状態管理 (複数火山同時追跡・プロンプト・detail)
│   ├── eew/
│   │   ├── eew-tracker.ts      # EEW イベント追跡 (重複検出・状態管理・最終報処理)
│   │   └── eew-logger.ts       # EEW ログファイル記録 (イベント別ファイル出力)
│   └── notification/
│       ├── notifier.ts         # デスクトップ通知 (カテゴリ別ON/OFF)
│       ├── volcano-presentation.ts # 火山電文の表示/通知レベル判定
│       ├── node-notifier-loader.ts # node-notifier 遅延ロード (optional dependency)
│       └── sound-player.ts     # クロスプラットフォーム通知音再生
├── dmdata/
│   ├── rest-client.ts          # dmdata.jp REST API クライアント
│   ├── ws-client.ts            # WebSocket 接続管理 (再接続・ping-pong)
│   ├── connection-manager.ts   # 接続管理インターフェース (ConnectionManager)
│   ├── multi-connection-manager.ts # 複線接続管理 (primary + backup)
│   ├── endpoint-selector.ts    # エンドポイント選択・リージョン間フェイルオーバー
│   ├── telegram-parser.ts      # XML電文パーサ (gzip+base64デコード)
│   └── volcano-parser.ts       # 火山電文パーサ (10種類の火山電文に対応)
└── ui/
    ├── formatter.ts            # 共通ターミナル表示ユーティリティ (フレーム描画・テキスト処理)
    ├── eew-formatter.ts        # EEW 表示フォーマッタ
    ├── earthquake-formatter.ts # 地震・津波・テキスト・南海トラフ・長周期 表示フォーマッタ
    ├── volcano-formatter.ts    # 火山 表示フォーマッタ
    ├── theme.ts                # テーマシステム (カラーパレット・ロール定義)
    ├── repl.ts                 # REPL インタラクション
    ├── test-samples.ts         # 表示テスト用サンプルデータ
    └── waiting-tips.ts         # 待機中ヒント定義

docs/
├── display-reference.md        # 表示リファレンス
├── raspi500-setup-guide.md     # Raspberry Pi 500 セットアップガイド
└── specs/                      # 仕様書 (dmdata.md, engine.md, root.md, ui.md)

test/
├── setup.ts                    # vitest 共通セットアップ (node-notifier モック)
├── engine/
│   ├── cli-run.test.ts
│   ├── config.test.ts
│   ├── message-router.test.ts
│   ├── eew-tracker.test.ts
│   ├── eew-logger.test.ts
│   ├── notifier.test.ts
│   ├── sound-player.test.ts
│   ├── tsunami-initializer.test.ts
│   ├── tsunami-state.test.ts
│   ├── volcano-state.test.ts
│   ├── volcano-vfvo53-aggregator.test.ts
│   ├── volcano-presentation.test.ts
│   └── update-checker.test.ts
├── dmdata/
│   ├── endpoint-selector.test.ts
│   ├── multi-connection-manager.test.ts
│   ├── rest-client.test.ts
│   ├── telegram-parser.test.ts
│   ├── volcano-parser.test.ts
│   └── ws-client.test.ts
├── ui/
│   ├── formatter.test.ts
│   ├── volcano-formatter.test.ts
│   ├── repl.test.ts
│   └── theme.test.ts
├── fixtures/                   # XMLテストフィクスチャ
└── helpers/
    └── mock-message.ts
```

## アーキテクチャ

```
index.ts (bootstrap) → engine/cli/cli.ts (Commander定義)
  → engine/cli/cli-run.ts (契約チェック・起動バナー)    ← dynamic import
    → engine/startup/config-resolver.ts (設定解決)
    → engine/monitor/monitor.ts (WebSocket接続・受信委譲)
      → engine/startup/tsunami-initializer.ts (起動時の津波状態復元)
      → engine/startup/volcano-initializer.ts (起動時の火山警報状態復元)
      → engine/messages/message-router.ts (電文分類・振り分け)
        → engine/messages/volcano-vfvo53-aggregator.ts (VFVO53 バッチ集約)
        → dmdata/telegram-parser.ts (XML解析)
        → dmdata/volcano-parser.ts (火山電文解析)
        → ui/formatter.ts (共通表示)       ← ui/theme.ts (テーマ)
        → ui/eew-formatter.ts (EEW表示)
        → ui/earthquake-formatter.ts (地震・津波表示)
        → ui/volcano-formatter.ts (火山表示)
        → engine/eew/eew-tracker.ts (EEW追跡)
        → engine/eew/eew-logger.ts (EEWログ記録)
        → engine/notification/notifier.ts (デスクトップ通知)
          → engine/notification/node-notifier-loader.ts (optional依存の遅延ロード)
          → engine/notification/sound-player.ts (通知音再生)
      → engine/monitor/shutdown.ts (シャットダウン処理)
      → engine/monitor/repl-coordinator.ts (REPL協調)
      → ui/repl.ts (REPL インタラクション)             ← dynamic import
```

- `engine/cli/` — CLI定義・アクションハンドラ
- `engine/startup/` — 設定解決・アップデートチェック・津波状態復元
- `engine/monitor/` — オーケストレーション・シャットダウン・REPL協調
- `engine/messages/` — 電文分類・振り分け・津波状態管理・火山状態管理
- `engine/eew/` — EEW追跡・ログ記録
- `engine/notification/` — デスクトップ通知・通知音
- `dmdata/` — dmdata.jp との通信層 (REST, WebSocket, 電文パース)
- `ui/` — ユーザーインターフェース (ターミナル表示, REPL, テーマ)
- `utils/` — 汎用ユーティリティ (震度ランク変換, シークレットマスク)
- WebSocketManager がイベント駆動で onData / onConnected / onDisconnected を発火
- 指数バックオフによる自動再接続、Ping-Pong でヘルスチェック
- `createMessageHandler()` は `{ handler, eewLogger, notifier, tsunamiState, volcanoState }` を返す
- 遅延ロード: `cli/cli.ts` → `cli/cli-run.ts` / `cli/cli-init.ts`、`monitor/monitor.ts` → `ui/repl.ts` は dynamic import で必要時のみロード（メモリ最適化）
- テーマ: `ui/theme.ts` が `theme.json` (Configディレクトリ) を読み込み、CUD配色準拠のカラーパレット + 67のセマンティックロールで表示色を管理

## 電文タイプとルーティング

`message-router.ts` が受信電文を classification と head.type で振り分ける。

| 電文タイプ | 分類 | パーサ関数 | 表示関数 | 型 |
|-----------|------|-----------|---------|-----|
| VXSE43 | `eew.warning` | `parseEewTelegram` | `displayEewInfo` | `ParsedEewInfo` |
| VXSE44 | `eew.forecast` | `parseEewTelegram` | `displayEewInfo` | `ParsedEewInfo` |
| VXSE45 | `eew.forecast` | `parseEewTelegram` | `displayEewInfo` | `ParsedEewInfo` |
| VXSE51 | `telegram.earthquake` | `parseEarthquakeTelegram` | `displayEarthquakeInfo` | `ParsedEarthquakeInfo` |
| VXSE52 | `telegram.earthquake` | `parseEarthquakeTelegram` | `displayEarthquakeInfo` | `ParsedEarthquakeInfo` |
| VXSE53 | `telegram.earthquake` | `parseEarthquakeTelegram` | `displayEarthquakeInfo` | `ParsedEarthquakeInfo` |
| VXSE56 | `telegram.earthquake` | `parseSeismicTextTelegram` | `displaySeismicTextInfo` | `ParsedSeismicTextInfo` |
| VXSE60 | `telegram.earthquake` | `parseSeismicTextTelegram` | `displaySeismicTextInfo` | `ParsedSeismicTextInfo` |
| VXSE61 | `telegram.earthquake` | `parseEarthquakeTelegram` | `displayEarthquakeInfo` | `ParsedEarthquakeInfo` |
| VXSE62 | `telegram.earthquake` | `parseLgObservationTelegram` | `displayLgObservationInfo` | `ParsedLgObservationInfo` |
| VTSE41 | `telegram.earthquake` | `parseTsunamiTelegram` | `displayTsunamiInfo` | `ParsedTsunamiInfo` |
| VTSE51 | `telegram.earthquake` | `parseTsunamiTelegram` | `displayTsunamiInfo` | `ParsedTsunamiInfo` |
| VTSE52 | `telegram.earthquake` | `parseTsunamiTelegram` | `displayTsunamiInfo` | `ParsedTsunamiInfo` |
| VZSE40 | `telegram.earthquake` | `parseSeismicTextTelegram` | `displaySeismicTextInfo` | `ParsedSeismicTextInfo` |
| VYSE50 | `telegram.earthquake` | `parseNankaiTroughTelegram` | `displayNankaiTroughInfo` | `ParsedNankaiTroughInfo` |
| VYSE51 | `telegram.earthquake` | `parseNankaiTroughTelegram` | `displayNankaiTroughInfo` | `ParsedNankaiTroughInfo` |
| VYSE52 | `telegram.earthquake` | `parseNankaiTroughTelegram` | `displayNankaiTroughInfo` | `ParsedNankaiTroughInfo` |
| VYSE60 | `telegram.earthquake` | `parseNankaiTroughTelegram` | `displayNankaiTroughInfo` | `ParsedNankaiTroughInfo` |
| VZVO40 | `telegram.volcano` | `parseVolcanoTelegram` | `displayVolcanoInfo` | `ParsedVolcanoTextInfo` |
| VFVO50 | `telegram.volcano` | `parseVolcanoTelegram` | `displayVolcanoInfo` | `ParsedVolcanoAlertInfo` |
| VFVO51 | `telegram.volcano` | `parseVolcanoTelegram` | `displayVolcanoInfo` | `ParsedVolcanoTextInfo` |
| VFVO52 | `telegram.volcano` | `parseVolcanoTelegram` | `displayVolcanoInfo` | `ParsedVolcanoEruptionInfo` |
| VFSVii | `telegram.volcano` | `parseVolcanoTelegram` | `displayVolcanoInfo` | `ParsedVolcanoAlertInfo` |
| VFVO53 | `telegram.volcano` | `parseVolcanoTelegram` | `displayVolcanoInfo` | `ParsedVolcanoAshfallInfo` |
| VFVO54 | `telegram.volcano` | `parseVolcanoTelegram` | `displayVolcanoInfo` | `ParsedVolcanoAshfallInfo` |
| VFVO55 | `telegram.volcano` | `parseVolcanoTelegram` | `displayVolcanoInfo` | `ParsedVolcanoAshfallInfo` |
| VFVO56 | `telegram.volcano` | `parseVolcanoTelegram` | `displayVolcanoInfo` | `ParsedVolcanoEruptionInfo` |
| VFVO60 | `telegram.volcano` | `parseVolcanoTelegram` | `displayVolcanoInfo` | `ParsedVolcanoPlumeInfo` |

### ルーティング優先順位 (message-router.ts)

1. `eew.forecast` / `eew.warning` → EEW パス (EewTracker で重複検出、EewEventLogger でログ記録)
2. `telegram.volcano` → 火山パス (VolcanoStateHolder で状態追跡、VolcanoPresentation で表示/通知レベル判定)
3. `telegram.earthquake` + `VXSE56`/`VXSE60`/`VZSE40` → テキスト系パス
4. `telegram.earthquake` + `VXSE62` → 長周期地震動観測情報パス
5. `telegram.earthquake` + `VXSE*` → 地震情報パス
6. `telegram.earthquake` + `VTSE*` → 津波情報パス
7. `telegram.earthquake` + `VYSE*` → 南海トラフ地震関連情報パス
8. それ以外 → `displayRawHeader` (フォールバック)

### フレームレベル判定 (formatter.ts)

表示フレームは `FrameLevel` (`critical` / `warning` / `normal` / `info` / `cancel`) で切り替わる。

- **地震情報**: 震度6弱以上→critical、震度4以上→warning、取消→cancel、その他→normal
- **EEW**: 警報→critical、取消→cancel、予報→warning、最終報→NextAdvisory検出でログ終了・トラッカー終了
- **津波情報**: 大津波警報→critical、津波警報→warning、取消→cancel、その他→normal
- **テキスト情報**: 取消→cancel、その他→info
- **南海トラフ情報**: コード120→critical、コード130/111-113/210-219→warning、コード190/200→info
- **長周期地震動観測**: LgInt4→critical、LgInt3→warning、LgInt2→normal、その他→info
- **火山情報** (volcano-presentation.ts で判定):
  - 取消→cancel
  - VFVO56 噴火速報→critical
  - VFVO50 Lv4-5引上げ→critical、Lv2-3引上げ→warning、引下げ/解除→normal
  - VFVO50 Lv4-5継続(初見→critical、再通知→warning)、Lv2-3継続(初見→warning、再通知→normal)
  - VFVO52 爆発/噴火多発/噴煙≥3000m→warning、軽微→normal
  - VFVO54 降灰速報→warning、VFVO55 降灰詳細→normal、VFVO53 降灰定時→info
  - VFVO51 臨時→warning、通常→info
  - VFSVii 海上警報(Code31/36)→warning、海上予報(Code33)→normal
  - VFVO60 推定噴煙流向報→normal
  - VZVO40 お知らせ→info

## テスト

- テストフレームワーク: **vitest** (`npm test` で実行)
- 共通セットアップ: `test/setup.ts` で node-notifier のグローバルモックを提供
- テストフィクスチャ: `test/fixtures/` に実際の気象庁 XML 電文を配置
- フィクスチャ命名規則: `{分類番号}_{連番}_{日付}_{電文タイプ}.xml` (例: `32-35_01_02_240613_VXSE52.xml`)
- モックメッセージ: `test/helpers/mock-message.ts` の `createMockWsDataMessage(fixtureName)` でフィクスチャから `WsDataMessage` を構築
- フィクスチャ定数: `FIXTURE_VXSE53_ENCHI` 等の名前付き定数で参照 (mock-message.ts で export)
- 表示関数テスト: `vi.spyOn(console, "log")` で stdout をキャプチャし、出力内容を検証

## コーディング規約

- **ファイル名**: kebab-case (`telegram.ts`, `logger.ts`)
- **クラス / 型 / インターフェース**: PascalCase (`WebSocketManager`, `AppConfig`)
- **関数 / 変数**: camelCase (`parseEarthquakeTelegram`, `decodeBody`)
- **定数**: UPPER_SNAKE_CASE (`DEFAULT_CONFIG`, `API_BASE`)
- **import**: npm パッケージは named import (`import { Command } from "commander"`)、内部モジュールは namespace import (`import * as log from "../logger"`)
- **strict TypeScript**: `any` 型は使用しない
- **エラー処理**: try-catch + `err instanceof Error` ガード、null チェックは `== null`

## 設定

設定は以下の優先順位で解決される (上位が優先):

1. CLI オプション (`--api-key`, `-c`, `--test`, `--keep-existing`, `--close-others`, `--mode`, `--debug`)
2. 環境変数 `DMDATA_API_KEY` (APIキーのみ)
3. `.env` ファイル (APIキーのみ)
4. Configファイル (OS別: macOS `~/Library/Application Support/fleq/`, Linux `~/.config/fleq/`, Windows `%APPDATA%\fleq\`。`XDG_CONFIG_HOME` 設定時はそちら優先)
5. デフォルト値 (`DEFAULT_CONFIG`)

### Configファイル管理

```bash
fleq config show          # 現在の設定を表示
fleq config set <key> <value>  # 設定値をセット
fleq config unset <key>   # 設定値を削除
fleq config path          # Configファイルのパスを表示
fleq config keys          # 設定可能なキー一覧を表示
```

設定可能なキー: `apiKey`, `classifications`, `testMode`, `appName`, `maxReconnectDelaySec`, `keepExistingConnections`, `tableWidth`, `infoFullText`, `displayMode`, `promptClock`, `waitTipIntervalMin`, `sound`, `eewLog`, `maxObservations`, `backup`, `truncation`

通知設定はREPLの `notify` コマンドで管理する (カテゴリ別ON/OFF: eew, earthquake, tsunami, seismicText, nankaiTrough, lgObservation, volcano)

通知音設定 (`sound`) で通知音の有効/無効を切り替える。サウンドファイルは `assets/sounds/` に配置、OS標準サウンドへのフォールバックあり

EEWログ設定 (`eewLog`) はREPLの `eewlog` コマンドで管理する (ログ記録ON/OFF、記録項目の選択)

省略表示上限はREPLの `limit` コマンドで管理する (`limit <key> <N>` / `limit <key> default` / `limit reset`)

## リリースフロー

コードを変更した際は、以下の手順でバージョンを更新してからプッシュすること:

1. Conventional Commits 形式でコミットする (`feat:`, `fix:`, `refactor:` 等)
2. `npm run release` を実行（コミットタイプに応じて自動で patch/minor バージョンが上がる）
3. `git push --follow-tags` でコミットとタグをプッシュする

- **破壊的変更**がある場合: `npm run release:major`
- **新機能**の場合: 通常の `npm run release` で minor が上がる (`feat:`)
- **バグ修正**の場合: 通常の `npm run release` で patch が上がる (`fix:`)
