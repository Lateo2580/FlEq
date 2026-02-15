# dmdata-monitor

Project DM-D.S.S (dmdata.jp) のAPIを利用して、地震・津波・緊急地震速報をリアルタイムにCLIで受信・表示するツールです。

## 現在の状態（2026-02-15 時点）

- バージョン: `0.1.16`
- デフォルトブランチ: `main`
- テスト: 3ファイル / 65テスト（`npm test` で全件成功）
- XMLフィクスチャ: `test/fixtures/*.xml` に 43件

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
git clone git@github.com:Lateo2580/FlEq.git
cd FlEq
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
cat > .env <<'EOF'
DMDATA_API_KEY=your-key-here
EOF
```

**方法3: Configに保存**
```bash
npm start -- config set apiKey your_api_key_here
```

## 使い方

```bash
# デフォルト区分を受信（telegram.earthquake,eew.forecast,eew.warning）
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

- テストフレームワーク: Vitest
- テストファイル: 3件（計65テスト）
- フィクスチャ: `test/fixtures/` に実電文XML 43件
- モックヘルパー: `test/helpers/mock-message.ts`

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

## CLIオプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `-k, --api-key <key>` | dmdata.jp APIキー | 環境変数 `DMDATA_API_KEY` |
| `-c, --classifications <items>` | 受信区分（カンマ区切り） | `telegram.earthquake,eew.forecast,eew.warning` |
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

設定可能なキー:

| キー | 説明 |
|------|------|
| `apiKey` | dmdata.jp APIキー |
| `classifications` | 受信区分 (カンマ区切り: `telegram.earthquake,eew.forecast,eew.warning`) |
| `testMode` | テスト電文モード: `"no"` / `"including"` / `"only"` |
| `appName` | アプリケーション名 |
| `maxReconnectDelaySec` | 再接続の最大待機秒数 |
| `keepExistingConnections` | 既存のWebSocket接続を維持するか (`true` / `false`) |

設定の優先順位（高い順）:

1. CLI オプション (`--api-key`, `--classifications`, `--test`, `--keep-existing`)
2. 環境変数 `DMDATA_API_KEY`
3. Configファイル (`~/.config/dmdata-monitor/config.json`)
4. デフォルト値 (`DEFAULT_CONFIG`)

補足:

- Config保存時は `0600` パーミッションで書き込みます（APIキー保護）。

## REPLコマンド

実行中に `fleq> ` プロンプトで以下のコマンドを利用できます。

| コマンド | 説明 |
|----------|------|
| `help` | コマンド一覧を表示 |
| `history [N]` | 地震履歴を取得・表示（デフォルト10件） |
| `status` | WebSocket 接続状態を表示 |
| `config` | 現在の設定を表示 |
| `contract` | 契約区分一覧を表示 |
| `socket` | 接続中のソケット一覧を表示 |
| `quit` / `exit` | アプリケーションを終了 |

## CLIバイナリとnpm scripts

- CLIバイナリ名: `fleq` (`package.json` の `bin` 設定)
- `npm run dev`: build + run
- `npm run clean`: `dist/` を削除
- `npm run release`: バージョン更新（Conventional Commitsに基づく）
- `npm run release:minor`: minor リリース
- `npm run release:major`: major リリース

## アーキテクチャ

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
│   └── mcp-bridge.ts           # MCP連携ブリッジ (実験的)
└── ui/
    ├── formatter.ts            # ターミナル表示フォーマッタ
    └── repl.ts                 # REPL インタラクション
```

## 対応電文タイプ（実装ベース）

| 電文タイプ | 分類 | パーサ関数 | 表示関数 |
|-----------|------|-----------|---------|
| `VXSE43` | `eew.warning` | `parseEewTelegram` | `displayEewInfo` |
| `VXSE44` | `eew.forecast` | `parseEewTelegram` | `displayEewInfo` |
| `VXSE45` | `eew.forecast` | `parseEewTelegram` | `displayEewInfo` |
| `VXSE51` | `telegram.earthquake` | `parseEarthquakeTelegram` | `displayEarthquakeInfo` |
| `VXSE52` | `telegram.earthquake` | `parseEarthquakeTelegram` | `displayEarthquakeInfo` |
| `VXSE53` | `telegram.earthquake` | `parseEarthquakeTelegram` | `displayEarthquakeInfo` |
| `VXSE56` | `telegram.earthquake` | `parseSeismicTextTelegram` | `displaySeismicTextInfo` |
| `VXSE60` | `telegram.earthquake` | `parseSeismicTextTelegram` | `displaySeismicTextInfo` |
| `VXSE61` | `telegram.earthquake` | `parseEarthquakeTelegram` | `displayEarthquakeInfo` |
| `VTSE41` | `telegram.earthquake` | `parseTsunamiTelegram` | `displayTsunamiInfo` |
| `VTSE51` | `telegram.earthquake` | `parseTsunamiTelegram` | `displayTsunamiInfo` |
| `VTSE52` | `telegram.earthquake` | `parseTsunamiTelegram` | `displayTsunamiInfo` |

## 主な機能

- WebSocketによるリアルタイム受信
- gzip圧縮+base64エンコードされたXML電文の自動デコード
- 展開サイズ上限チェック（10MB）
- 震度に応じた色分け表示
- 緊急地震速報（警報/予報）の視覚的な強調表示
- EEWイベントの同時追跡（EventID単位、重複報スキップ、取消対応）
- 指数バックオフによる自動再接続
- ping-pongによる接続維持
- ハートビート監視（90秒）
- 既存ソケットの自動クリーンアップ
- Configファイルによる永続設定管理

## ライセンス

MIT
