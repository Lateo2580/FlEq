# dmdata-monitor

Project DM-D.S.S (dmdata.jp) のAPIを利用して、地震・津波・緊急地震速報をリアルタイムにCLIで受信・表示するツールです。

## 対応情報

| 区分 | 分類名 | 内容 |
|------|--------|------|
| 地震・津波関連 | `telegram.earthquake` | 震度速報、震源情報、震源・震度情報、津波警報等 |
| 緊急地震速報（予報） | `eew.forecast` | EEW予報（要契約） |
| 緊急地震速報（警報） | `eew.warning` | EEW警報（要契約） |

## 必要条件

- Node.js 18以上
- dmdata.jp のAPIキー（`socket.start` および該当区分の `telegram.get.*` 権限が必要）

## セットアップ

```bash
git clone <repository-url>
cd dmdata-monitor
npm install
npm run build
```

## APIキーの設定

以下のいずれかの方法で設定してください。

**方法1: 環境変数**
```bash
export DMDATA_API_KEY=your_api_key_here
```

**方法2: .envファイル**
```bash
cp .env.example .env
# .env を編集してAPIキーを設定
```

**方法3: コマンドラインオプション**
```bash
npm start -- --api-key your_api_key_here
```

## 使い方

```bash
# 地震・津波情報を受信（デフォルト）
npm start

# 複数の区分を受信
npm start -- -c telegram.earthquake,eew.warning

# テスト電文も含めて受信
npm start -- --test including

# デバッグログを表示
npm start -- --debug

# 既存のWebSocket接続を維持
npm start -- --keep-existing
```

## CLIオプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `-k, --api-key <key>` | dmdata.jp APIキー | 環境変数 `DMDATA_API_KEY` |
| `-c, --classifications <items>` | 受信区分（カンマ区切り） | `telegram.earthquake` |
| `--test <mode>` | テスト電文: `no` / `including` / `only` | `no` |
| `--keep-existing` | 既存接続を維持 | `false` |
| `--debug` | デバッグログ表示 | `false` |

## アーキテクチャ

```
src/
├── index.ts              # エントリポイント・CLI定義
├── types.ts              # 型定義
├── api/
│   └── client.ts         # dmdata.jp REST API クライアント
├── websocket/
│   └── manager.ts        # WebSocket接続管理（自動再接続・ping-pong）
├── parser/
│   └── telegram.ts       # XML電文パーサー（gzip+base64デコード含む）
├── display/
│   └── formatter.ts      # ターミナル表示（色付き整形出力）
└── utils/
    └── logger.ts         # ロガー
```

## 主な機能

- WebSocketによるリアルタイム受信
- gzip圧縮+base64エンコードされたXML電文の自動デコード
- 震度に応じた色分け表示
- 緊急地震速報（警報/予報）の視覚的な強調表示
- 指数バックオフによる自動再接続
- ping-pongによる接続維持
- 既存ソケットの自動クリーンアップ

## ライセンス

MIT
