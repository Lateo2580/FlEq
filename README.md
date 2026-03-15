# FlEq

Project DM-D.S.S (dmdata.jp) のAPIを利用して、地震・津波・緊急地震速報をリアルタイムにCLIで受信・表示するツールです。

## クイックスタート

FlEq を最短で使い始めるには、以下の手順を実行してください。

### 方法1: `fleq init` を使う（初回推奨）

対話形式で API キーや受信設定をまとめて行えます。

```bash
npm install -g fleq
fleq init
fleq
```

### 方法2: 手動で設定する

対話なしで設定したい場合は、API キーを保存してから起動します。

```bash
npm install -g fleq
fleq config set apiKey your_api_key_here
fleq
```

環境変数を使う場合は、以下でも起動できます。

```bash
export DMDATA_API_KEY=your_api_key_here
fleq
```

PowerShell:

```powershell
$env:DMDATA_API_KEY = "your_api_key_here"
fleq
```

初回は `telegram.earthquake,eew.forecast,eew.warning` を受信対象として起動します。
契約内容によっては一部の区分を受信できない場合があります。

## 対応情報

| 区分 | 分類名 | 内容 |
|------|--------|------|
| 地震・津波関連 | `telegram.earthquake` | 震度速報、震源情報、震源・震度情報、津波警報等 |
| 緊急地震速報（予報） | `eew.forecast` | EEW予報（要契約） |
| 緊急地震速報（警報） | `eew.warning` | EEW警報（要契約） |

## 必要条件

FlEq を利用するには、以下が必要です。

- Node.js 18 以上
- dmdata.jp のアカウント
- dmdata.jp で発行した API キー
- API キーに `socket.start` と、利用する区分に対応した `telegram.get.*` 権限

受信する情報の種類によって、必要な契約区分や権限が異なります。
たとえば、緊急地震速報（`eew.forecast` / `eew.warning`）の受信には、対応する契約が必要です。

API キーをまだ取得していない場合は、先に dmdata.jp でアカウント作成と API キー発行を行ってください。
対応 OS については下記の「対応OS」を参照してください。

## 対応OS

| OS | 対応状況 | 備考 |
|----|---------|------|
| macOS 10.13+ | 対応 | メイン開発・テスト環境 |
| Linux (x64 / ARM) | 対応 | Raspberry Pi 等の ARM デバイスでも動作 |
| Windows 10+ | 対応 | ConPTY 対応のターミナルを推奨 |

## インストール

### npm からインストール

```bash
npm install -g fleq
```

または単発実行もできます。

```bash
npx fleq --help
```

### ソースから実行

```bash
git clone https://github.com/Lateo2580/FlEq.git
cd FlEq
npm install
npm run build
```

## APIキーの設定

以下のいずれかの方法で設定してください。

**方法1: 環境変数**

bash / zsh:
```bash
export DMDATA_API_KEY=your_api_key_here
```

PowerShell:
```powershell
$env:DMDATA_API_KEY = "your_api_key_here"
```

CMD:
```cmd
set DMDATA_API_KEY=your_api_key_here
```

**方法2: Configに保存（推奨）**

グローバルインストール時はこちらが最も簡単です。
```bash
fleq config set apiKey your_api_key_here
```

保存先は `fleq config path` で確認できます（OSごとに異なります。詳細は「Config管理」を参照）。

**方法3: .envファイル**

カレントディレクトリの `.env` ファイルから読み込みます（ソースからの実行時に便利です）。
```
DMDATA_API_KEY=your-key-here
```

## 基本的な使い方

初めて使う場合は、次の順で進めると分かりやすいです。

### 1. 初期設定を行う

まずは API キーを設定します。初回は対話形式の `init` が簡単です。

```bash
fleq init
```

対話なしで設定する場合は、次のように API キーを保存できます。

```bash
fleq config set apiKey your_api_key_here
```

### 2. そのまま起動する

デフォルト設定で起動すると、以下の区分を受信します。

- `telegram.earthquake`
- `eew.forecast`
- `eew.warning`

```bash
fleq
```

契約内容によっては、一部の区分を受信できない場合があります。

### 3. 必要に応じて受信区分を指定する

受信したい区分だけを指定して起動できます。

```bash
fleq -c telegram.earthquake,eew.warning
```

### 4. 表示や動作を調整する

表示モードを切り替えたい場合:

```bash
fleq --mode compact
```

テスト電文も受信したい場合:

```bash
fleq --test including
```

デバッグログを表示したい場合:

```bash
fleq --debug
```

同一 API キーの既存 open socket を閉じてから接続したい場合:

```bash
fleq --close-others
```

### 5. 実行中は REPL コマンドを使える

起動中は `fleq>` プロンプトで各種コマンドを利用できます。

- `help`: コマンド一覧を表示
- `status`: 接続状態を確認
- `config`: 現在の設定を確認
- `quit`: 終了

詳しくは下記の「REPLコマンド」を参照してください。

## テスト

```bash
# テストを実行します
npm test

# ウォッチモードで実行します
npm run test:watch
```

- テストフレームワーク: Vitest
- テストファイル: 13件（計305テスト）
- フィクスチャ: `test/fixtures/` に実電文XML 62件
- モックヘルパー: `test/helpers/mock-message.ts`

## CLIオプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `-k, --api-key <key>` | dmdata.jp APIキー | 環境変数 `DMDATA_API_KEY` |
| `-c, --classifications <items>` | 受信区分（カンマ区切り） | `telegram.earthquake,eew.forecast,eew.warning` |
| `--test <mode>` | テスト電文: `no` / `including` / `only` | `no` |
| `--keep-existing` | 既存接続を維持します（互換オプション。現在はデフォルトです） | `true` |
| `--close-others` | 同一APIキーの既存 open socket を閉じてから接続します | `false` |
| `--mode <mode>` | 表示モード: `normal` / `compact` | `normal` |
| `--debug` | デバッグログ表示 | `false` |

## Config管理

永続設定はOS別のディレクトリに保存されます。`config` サブコマンドで管理できます。

| OS | デフォルトパス |
|----|---------------|
| macOS | `~/Library/Application Support/fleq/config.json` |
| Linux | `~/.config/fleq/config.json` |
| Windows | `%APPDATA%\fleq\config.json` |

環境変数 `XDG_CONFIG_HOME` が設定されている場合は、全OSで `$XDG_CONFIG_HOME/fleq/config.json` が優先されます。
旧バージョンで `~/.config/fleq/` や `~/.config/dmdata-monitor/` に保存された設定は、初回起動時に自動的に移行されます。

```bash
# 現在の設定を表示します
fleq config show

# 設定値を保存します
fleq config set <key> <value>

# 設定値を削除します
fleq config unset <key>

# Configファイルの保存先を表示します
fleq config path

# 設定可能キー一覧を表示します
fleq config keys
```

設定可能なキー:

| キー | 説明 |
|------|------|
| `apiKey` | dmdata.jp APIキー |
| `classifications` | 受信区分 (カンマ区切り: `telegram.earthquake,eew.forecast,eew.warning`) |
| `testMode` | テスト電文モード: `"no"` / `"including"` / `"only"` |
| `appName` | アプリケーション名 |
| `maxReconnectDelaySec` | 再接続の最大待機秒数 |
| `keepExistingConnections` | 同一APIキーの既存 open socket を維持するかどうか (`true` / `false`) |
| `tableWidth` | テーブル表示幅 (40〜200、デフォルト: 60) |
| `infoFullText` | お知らせ電文の全文表示 (`true` / `false`) |
| `displayMode` | 表示モード: `"normal"` / `"compact"` |
| `waitTipIntervalMin` | 待機中ヒント表示間隔（分, 0で無効、デフォルト: 30） |
| `eewLog` | EEWログ記録の有効/無効 (`true` / `false`) |
| `eewLogFields` | EEWログ記録項目の設定（オブジェクト形式） |

設定の優先順位（高い順）:

1. CLI オプション (`--api-key`, `--classifications`, `--test`, `--keep-existing`, `--close-others`)
2. 環境変数 `DMDATA_API_KEY`（APIキーのみ）
3. `.env` ファイル（APIキーのみ）
4. Configファイル（`fleq config path` で確認可能）
5. デフォルト値 (`DEFAULT_CONFIG`)

補足:

- Config保存時と既存Config読み込み時は、可能な範囲で `0600` パーミッションへ調整します（APIキー保護のためです）。
- 更新チェックを無効にしたい場合は `FLEQ_NO_UPDATE_CHECK=1` を設定してください。
- DMDATA 公式仕様に合わせ、REST API の認証は `Authorization: Basic ...` を使用します。
- DMDATA 公式では、同時接続数に余裕がない場合のみ `Socket Close v2` の利用が案内されています。通常運用では `--close-others` は不要です。

## 複数デバイスでの同時運用

同一アカウントの複数APIキーを使って、複数のデバイスで FlEq を同時に起動する場合は、**デバイスごとに異なる `appName` を設定**してください。

```bash
# デバイスA（例: Mac）
fleq config set appName fleq-mac

# デバイスB（例: Raspberry Pi）
fleq config set appName fleq-raspi
```

FlEq は起動時に前回セッションの残留ソケットをクリーンアップしますが、`appName` が同じだと他デバイスのソケットまで閉じてしまいます。デバイスごとに異なる `appName` を設定することで、自分のソケットのみがクリーンアップ対象となり、他デバイスの接続に影響しません。

## REPLコマンド

実行中に `fleq> ` プロンプトで以下のコマンドを利用できます。

`help` コマンドでカテゴリ別のコマンド一覧を表示できます。

### 情報
| コマンド | 説明 |
|----------|------|
| `help` / `?` | コマンド一覧を表示 |
| `history [N]` | 地震履歴を取得・表示（デフォルト10件、最新が一番下） |
| `colors` | カラーパレット・震度色の一覧を表示 |

### ステータス
| コマンド | 説明 |
|----------|------|
| `status` | WebSocket 接続状態を表示 |
| `config` | 現在の設定を表示 |
| `contract` | 契約区分一覧を表示 |
| `socket` | 接続中のソケット一覧を表示 |

### 設定
| コマンド | 説明 |
|----------|------|
| `notify` | 通知カテゴリのON/OFF状態を表示 |
| `notify <category> [on\|off]` | 指定カテゴリの通知をトグル/ON/OFF |
| `notify all:on` / `all:off` | 全カテゴリの通知を一括ON/OFF |
| `eewlog` | EEWログ記録の設定を表示 |
| `eewlog on` / `off` | EEWログ記録の有効/無効を切替 |
| `eewlog fields` | EEWログ記録項目の一覧表示 |
| `eewlog fields <field> [on\|off]` | 記録項目のトグル/ON/OFF |
| `tablewidth [N]` | テーブル幅の表示・変更（例: `tablewidth 80`） |
| `infotext [full/short]` | お知らせ電文の全文/省略切替 |
| `tipinterval [N]` | 待機中ヒント表示間隔（分）を表示・変更（0で無効） |
| `mode [normal/compact]` | 表示モード切替 |
| `clock [elapsed/now]` | プロンプト時計の切替 |
| `sound [on/off]` | 通知音のON/OFF切替 |
| `mute [duration]` | 通知を一時ミュート（例: `mute 30m`、`mute off` で解除） |

### 操作
| コマンド | 説明 |
|----------|------|
| `clear` | ターミナル画面をクリア |
| `retry` | WebSocket 再接続を手動試行 |
| `quit` / `exit` | アプリケーションを終了 |

## CLIバイナリとnpm scripts

- CLIバイナリ名: `fleq` (`package.json` の `bin` 設定)
- `npm run dev`: build + run
- `npm run dev:lowmem`: build + メモリ最適化モードで run（`--optimize-for-size`）
- `npm run start:lowmem`: メモリ最適化モードで run（Raspberry Pi 等の低メモリ環境向け）
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
├── engine/
│   ├── cli.ts                  # Commander CLI定義
│   ├── cli-init.ts             # インタラクティブ初期設定 (fleq init)
│   ├── cli-run.ts              # CLIアクションハンドラ (設定解決・起動バナー)
│   ├── monitor.ts              # メインオーケストレーション (接続・REPL・シャットダウン)
│   ├── message-router.ts       # 受信メッセージの振り分け (EEW/地震/津波)
│   ├── eew-tracker.ts          # EEW イベント追跡 (重複検出・状態管理・最終報処理)
│   ├── eew-logger.ts           # EEW ログファイル記録 (イベント別ファイル出力)
│   ├── notifier.ts             # デスクトップ通知 (カテゴリ別ON/OFF)
│   └── update-checker.ts       # npm 最新バージョンチェック
├── dmdata/
│   ├── rest-client.ts          # dmdata.jp REST API クライアント
│   ├── ws-client.ts            # WebSocket 接続管理 (再接続・ping-pong)
│   └── telegram-parser.ts      # XML電文パーサ (gzip+base64デコード)
└── ui/
    ├── formatter.ts            # ターミナル表示フォーマッタ
    ├── repl.ts                 # REPL インタラクション
    └── waiting-tips.ts         # 待機中ヒント定義
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
| `VZSE40` | `telegram.earthquake` | `parseSeismicTextTelegram` | `displaySeismicTextInfo` |
| `VXSE62` | `telegram.earthquake` | `parseLgObservationTelegram` | `displayLgObservationInfo` |
| `VYSE50` | `telegram.earthquake` | `parseNankaiTroughTelegram` | `displayNankaiTroughInfo` |
| `VYSE51` | `telegram.earthquake` | `parseNankaiTroughTelegram` | `displayNankaiTroughInfo` |
| `VYSE52` | `telegram.earthquake` | `parseNankaiTroughTelegram` | `displayNankaiTroughInfo` |
| `VYSE60` | `telegram.earthquake` | `parseNankaiTroughTelegram` | `displayNankaiTroughInfo` |

## 主な機能

- WebSocketによるリアルタイム受信
- gzip圧縮+base64エンコードされたXML電文の自動デコード
- 展開サイズ上限チェック（10MB）
- 震度に応じた色分け表示
- 緊急地震速報（警報/予報）の視覚的な強調表示
- PLUM法・仮定震源要素・既到達の検出と視覚的表示
- EEWイベントの同時追跡（EventID単位、重複報スキップ、取消対応）
- EEWイベントのログファイル記録（イベント別ファイル出力、差分表記対応、記録項目の選択可能）
- EEW最終報（NextAdvisory）の検出とログ・トラッカー自動終了
- EEW差分表記（前の値 → 新しい値 形式）
- テーブル幅設定（40〜200）とテキスト折り返し機能
- 表示モード切替（normal / compact）
- お知らせ電文の全文/省略切替
- 通知の一時ミュート機能（時間指定）
- 待機中ヒント表示（間隔設定可能、0で無効）
- インタラクティブ初期設定（`fleq init`）
- 南海トラフ地震関連情報（VYSE50-52/VYSE60）の表示
- 長周期地震動に関する観測情報（VXSE62）の表示
- 地震活動に関する情報（VZSE40）の表示
- EEWで主要動到達と推測される地域のリスト表示
- デスクトップ通知機能（カテゴリ別ON/OFF、REPLで管理。下記「デスクトップ通知」参照）
- 指数バックオフによる自動再接続
- ping-pongによる接続維持
- ハートビート監視（90秒）
- 既存ソケットの自動クリーンアップ
- Configファイルによる永続設定管理

## デスクトップ通知

`node-notifier` パッケージによるデスクトップ通知に対応しています（optional dependency）。

| OS | 通知バックエンド |
|----|----------------|
| macOS | Notification Center |
| Linux | `notify-send` (`libnotify`) |
| Windows | Windows Toast Notifications |

**Linux での注意事項:**

- デスクトップ環境では通常 `notify-send` がプリインストールされていますが、ない場合は手動インストールが必要です:
  ```bash
  # Debian / Ubuntu / Raspberry Pi OS
  sudo apt install libnotify-bin
  ```
- ヘッドレス環境（サーバー、SSH接続のみ）では通知を表示する手段がないため、通知機能は自動的に無効になります。アプリの動作には影響しません。
- `node-notifier` のインストールに失敗した場合でも、通知以外の機能は正常に動作します。

## ライセンス

MIT
