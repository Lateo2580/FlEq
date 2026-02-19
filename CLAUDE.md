# CLAUDE.md

## プロジェクト概要

dmdata.jp API を利用した地震・津波・緊急地震速報(EEW)リアルタイムモニタリング CLI ツール。
WebSocket 経由で電文を受信し、パース・色付き表示を行う。

## ビルド・実行

```bash
npm install          # 依存インストール
npm run build        # TypeScript コンパイル → dist/
npm start            # コンパイル済みアプリ実行
npm run dev          # ビルド + 実行
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

## ディレクトリ構成

```
src/
├── index.ts                    # エントリポイント (薄いブートストラップのみ)
├── types.ts                    # 共有型定義
├── config.ts                   # Configファイル管理 (読み書き・バリデーション)
├── logger.ts                   # ログレベル付きロガー
├── cli/
│   ├── build-command.ts        # Commander CLI定義
│   └── run-command.ts          # CLIアクションハンドラ (設定解決・起動バナー)
├── app/
│   ├── start-monitor.ts        # メインオーケストレーション (接続・REPL・シャットダウン)
│   └── message-router.ts       # 受信メッセージの振り分け (EEW/地震/津波)
├── dmdata/
│   ├── rest-client.ts          # dmdata.jp REST API クライアント
│   ├── ws-client.ts            # WebSocket 接続管理 (再接続・ping-pong)
│   └── telegram-parser.ts      # XML電文パーサ (gzip+base64デコード)
├── features/
│   ├── eew-tracker.ts          # EEW イベント追跡 (重複検出・状態管理)
└── ui/
    ├── formatter.ts            # ターミナル表示フォーマッタ
    └── repl.ts                 # REPL インタラクション

test/
├── dmdata/
│   └── telegram-parser.test.ts
├── features/
│   └── eew-tracker.test.ts
├── ui/
│   └── formatter.test.ts
├── fixtures/                   # XMLテストフィクスチャ
└── helpers/
    └── mock-message.ts
```

## アーキテクチャ

```
index.ts (bootstrap) → cli/build-command.ts (Commander定義)
  → cli/run-command.ts (設定解決・契約チェック)
    → app/start-monitor.ts (WebSocket接続・REPL起動)
      → app/message-router.ts (電文振り分け)
        → dmdata/telegram-parser.ts (XML解析)
        → ui/formatter.ts (色付き表示)
        → features/eew-tracker.ts (EEW追跡)
```

- `cli/` — CLI定義と設定解決を担当、ランタイムロジックを持たない
- `app/` — アプリケーションのオーケストレーションとメッセージルーティング
- `dmdata/` — dmdata.jp との通信層 (REST, WebSocket, 電文パース)
- `features/` — ドメイン固有の機能 (EEW追跡)
- `ui/` — ユーザーインターフェース (ターミナル表示, REPL)
- WebSocketManager がイベント駆動で onData / onConnected / onDisconnected を発火
- 指数バックオフによる自動再接続、Ping-Pong でヘルスチェック

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
| VTSE41 | `telegram.earthquake` | `parseTsunamiTelegram` | `displayTsunamiInfo` | `ParsedTsunamiInfo` |
| VTSE51 | `telegram.earthquake` | `parseTsunamiTelegram` | `displayTsunamiInfo` | `ParsedTsunamiInfo` |
| VTSE52 | `telegram.earthquake` | `parseTsunamiTelegram` | `displayTsunamiInfo` | `ParsedTsunamiInfo` |

### ルーティング優先順位 (message-router.ts)

1. `eew.forecast` / `eew.warning` → EEW パス (EewTracker で重複検出)
2. `telegram.earthquake` + `VXSE56`/`VXSE60` → テキスト系パス
3. `telegram.earthquake` + `VXSE*` → 地震情報パス
4. `telegram.earthquake` + `VTSE*` → 津波情報パス
5. それ以外 → `displayRawHeader` (フォールバック)

### フレームレベル判定 (formatter.ts)

表示フレームは `FrameLevel` (`critical` / `warning` / `normal` / `info` / `cancel`) で切り替わる。

- **地震情報**: 震度6弱以上→critical、震度4以上→warning、取消→cancel、その他→normal
- **EEW**: 警報→critical、取消→cancel、予報→warning
- **津波情報**: 大津波警報→critical、津波警報→warning、取消→cancel、その他→normal
- **テキスト情報**: 取消→cancel、その他→info

## テスト

- テストフレームワーク: **vitest** (`npm test` で実行)
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

1. CLI オプション (`--api-key`, `-c`, `--test`, `--keep-existing`)
2. 環境変数 `DMDATA_API_KEY` (APIキーのみ)
3. `.env` ファイル (APIキーのみ)
4. Configファイル (`~/.config/fleq/config.json`)
5. デフォルト値 (`DEFAULT_CONFIG`)

### Configファイル管理

```bash
fleq config show          # 現在の設定を表示
fleq config set <key> <value>  # 設定値をセット
fleq config unset <key>   # 設定値を削除
fleq config path          # Configファイルのパスを表示
fleq config keys          # 設定可能なキー一覧を表示
```

設定可能なキー: `apiKey`, `classifications`, `testMode`, `appName`, `maxReconnectDelaySec`, `keepExistingConnections`

## リリースフロー

コードを変更した際は、以下の手順でバージョンを更新してからプッシュすること:

1. Conventional Commits 形式でコミットする (`feat:`, `fix:`, `refactor:` 等)
2. `npm run release` を実行（コミットタイプに応じて自動で patch/minor バージョンが上がる）
3. `git push --follow-tags` でコミットとタグをプッシュする

- **破壊的変更**がある場合: `npm run release:major`
- **新機能**の場合: 通常の `npm run release` で minor が上がる (`feat:`)
- **バグ修正**の場合: 通常の `npm run release` で patch が上がる (`fix:`)
