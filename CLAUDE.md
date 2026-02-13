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
├── index.ts              # エントリポイント・CLI定義
├── types.ts              # 型定義
├── api/client.ts         # dmdata.jp REST API クライアント
├── websocket/manager.ts  # WebSocket 接続管理 (再接続・ping-pong)
├── parser/telegram.ts    # XML電文パーサ (gzip+base64デコード)
├── display/formatter.ts  # ターミナル表示フォーマッタ
└── utils/logger.ts       # ログレベル付きロガー
```

## アーキテクチャ

CLI (Commander) → AppConfig 生成 → WebSocketManager → API Client で接続確立
→ 受信メッセージを Parser でデコード・パース → Display で色付き表示

- WebSocketManager がイベント駆動で onData / onConnected / onDisconnected を発火
- 指数バックオフによる自動再接続、Ping-Pong でヘルスチェック

## コーディング規約

- **ファイル名**: kebab-case (`telegram.ts`, `logger.ts`)
- **クラス / 型 / インターフェース**: PascalCase (`WebSocketManager`, `AppConfig`)
- **関数 / 変数**: camelCase (`parseEarthquakeTelegram`, `decodeBody`)
- **定数**: UPPER_SNAKE_CASE (`DEFAULT_CONFIG`, `API_BASE`)
- **import**: npm パッケージは named import (`import { Command } from "commander"`)、内部モジュールは namespace import (`import * as log from "./utils/logger"`)
- **strict TypeScript**: `any` 型は使用しない
- **エラー処理**: try-catch + `err instanceof Error` ガード、null チェックは `== null`

## 設定

API キーは以下の優先順位で解決される:

1. CLI オプション `--api-key <key>`
2. 環境変数 `DMDATA_API_KEY`
3. `.env` ファイル
