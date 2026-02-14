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

## テスト

```bash
# テスト実行
npm test

# ウォッチモード
npm run test:watch
```

## Claude Code連携 (MCP Bridge)

Codex から Claude Code を呼び出すための MCP サーバーを同梱しています。

```bash
# Bridge 起動
npm run mcp:bridge
```

### ツール仕様

- Tool名: `ask_claude`
- 引数:
  - `prompt` (必須, string)
  - `cwd` (任意, string)
  - `timeoutMs` (任意, number)
  - `maxOutputChars` (任意, number)

### 環境変数

- `CLAUDE_BRIDGE_COMMAND` (default: `claude`)
- `CLAUDE_BRIDGE_ARGS_PREFIX` (default: `-p`)
- `CLAUDE_BRIDGE_ALLOWED_DIRS` (default: 現在ディレクトリ。複数は `:` 区切り)
- `CLAUDE_BRIDGE_TIMEOUT_MS` (default: `120000`)
- `CLAUDE_BRIDGE_MAX_OUTPUT_CHARS` (default: `20000`)

### Codex MCP設定例

```json
{
  "mcpServers": {
    "claude-bridge": {
      "command": "npm",
      "args": ["run", "mcp:bridge"],
      "cwd": "/Users/plaintall/Dev/FlEq"
    }
  }
}
```

- Vitest を使用
- テストファイル: 3件（計39テスト）
- フィクスチャ: `test/fixtures/` に実電文XML 14件
- モックヘルパー: `test/helpers/mock-message.ts`

```
test/
├── parser/
│   └── telegram.test.ts
├── display/
│   └── formatter.test.ts
├── eew/
│   └── tracker.test.ts
├── fixtures/
│   └── *.xml (14 files)
└── helpers/
    └── mock-message.ts
```

## CLIオプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `-k, --api-key <key>` | dmdata.jp APIキー | 環境変数 `DMDATA_API_KEY` |
| `-c, --classifications <items>` | 受信区分（カンマ区切り） | `telegram.earthquake` |
| `--test <mode>` | テスト電文: `no` / `including` / `only` | `no` |
| `--keep-existing` | 既存接続を維持 | `false` |
| `--debug` | デバッグログ表示 | `false` |

## Config管理

永続設定は `~/.config/dmdata-monitor/config.json` に保存されます。
`config` サブコマンドで管理できます。

```bash
# 現在の設定を表示
npm start -- config show

# 設定値をセット
npm start -- config set <key> <value>

# 設定値を削除
npm start -- config unset <key>

# Configファイルの保存先を表示
npm start -- config path

# 設定可能キー一覧を表示
npm start -- config keys
```

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
├── eew/
│   └── tracker.ts        # EEWイベント追跡（EventID管理・重複/取消検出・自動クリーンアップ）
├── config/
│   └── manager.ts        # 設定ファイル管理（読み書き・バリデーション）
├── repl/
│   └── handler.ts        # 対話コマンド（help/history/status/config等）
└── utils/
    └── logger.ts         # ロガー
```

## 主な機能

- WebSocketによるリアルタイム受信
- gzip圧縮+base64エンコードされたXML電文の自動デコード
- 震度に応じた色分け表示
- 緊急地震速報（警報/予報）の視覚的な強調表示
- EEWイベントの同時追跡（EventID単位、重複報スキップ、取消対応）
- 指数バックオフによる自動再接続
- ping-pongによる接続維持
- 既存ソケットの自動クリーンアップ
- Configファイルによる永続設定管理

## ライセンス

MIT
