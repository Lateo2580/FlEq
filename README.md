# FlEq

[dmdata.jp](https://dmdata.jp/) の API を利用して、地震・津波・緊急地震速報（EEW）・火山情報をリアルタイムに CLI で受信・表示するツールです。

npm パッケージ名: `@sayue_ltr/fleq` / CLI コマンド名: `fleq`

## 主な機能

- WebSocket によるリアルタイム受信（自動再接続・複線接続対応）
- 地震・津波・EEW・火山情報を震度やレベルに応じた色分けで表示
- 緊急地震速報の同時追跡・ログ記録・差分表記
- デスクトップ通知・通知音（カテゴリ別 ON/OFF）
- REPL による実行中の設定変更・状態確認
- CUD 配色準拠のテーマシステム（カスタマイズ可能）
- Raspberry Pi 等の低メモリ環境でも動作

## 出力例

<!-- TODO: スクリーンショットまたは compact モードの出力例を追加 -->

表示フォーマットの詳細は [表示リファレンス](docs/display-reference.md) を参照してください。

## はじめる前に

FlEq を使うには、以下の準備が必要です。

1. **Node.js 18 以上**をインストールする
2. [dmdata.jp](https://dmdata.jp/) でアカウントを作成する
3. dmdata.jp の管理画面で **API キーを発行**する
4. API キーに **`socket.start` 権限**と、受信したい区分に対応する **`telegram.get.*` 権限**を付与する

受信する情報の種類によっては、dmdata.jp の有料契約が必要です。
詳しくは [dmdata.jp](https://dmdata.jp/) の料金・契約ページを確認してください。

### 対応 OS

| OS | 備考 |
|----|------|
| macOS 10.13+ | メイン開発・テスト環境 |
| Linux (x64 / ARM) | Raspberry Pi 等の ARM デバイスでも動作 |
| Windows 10+ | ConPTY 対応のターミナルを推奨 |

## 受信区分と内容

| 区分 | 分類名 | 内容 |
|------|--------|------|
| 地震・津波関連 | `telegram.earthquake` | 震度速報、震源情報、震源・震度情報、津波警報等 |
| 緊急地震速報（予報） | `eew.forecast` | EEW 予報 |
| 緊急地震速報（警報） | `eew.warning` | EEW 警報 |
| 火山関連 | `telegram.volcano` | 噴火警報、噴火速報、降灰予報、火山の状況に関する解説情報等 |

## インストール

```bash
npm install -g @sayue_ltr/fleq
```

単発実行もできます。

```bash
npx @sayue_ltr/fleq --help
```

## セットアップ

### 方法 1: `fleq init` を使う（初回推奨）

対話形式で API キーや受信設定をまとめて行えます。

```bash
fleq init
fleq
```

### 方法 2: 手動で設定する

```bash
fleq config set apiKey your_api_key_here  # ← 自分のAPIキーに置き換え
fleq
```

環境変数でも設定できます。

bash / zsh:
```bash
export DMDATA_API_KEY=your_api_key_here  # ← 自分のAPIキーに置き換え
```

PowerShell:
```powershell
$env:DMDATA_API_KEY = "your_api_key_here"  # ← 自分のAPIキーに置き換え
```

CMD:
```cmd
set DMDATA_API_KEY=your_api_key_here  &REM ← 自分のAPIキーに置き換え
```

カレントディレクトリの `.env` ファイルからも読み込めます（ソースからの実行時に便利です）。
```
DMDATA_API_KEY=your-key-here  # ← 自分のAPIキーに置き換え
```

## よく使う起動例

```bash
# デフォルト設定で起動（全4区分を受信）
fleq

# 地震・火山情報だけ受信（EEW契約なしの場合に便利）
fleq -c telegram.earthquake,telegram.volcano

# コンパクト表示で起動
fleq --mode compact

# テスト電文も含めて受信
fleq --test including

# デバッグログを表示
fleq --debug

# 同一APIキーの既存ソケットを閉じてから接続
fleq --close-others
```

デフォルトの受信区分は `telegram.earthquake,eew.forecast,eew.warning,telegram.volcano` です。
契約内容によっては一部の区分を受信できない場合があります。

## CLI オプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `-k, --api-key <key>` | dmdata.jp API キー | 環境変数 `DMDATA_API_KEY` |
| `-c, --classifications <items>` | 受信区分（カンマ区切り） | `telegram.earthquake,eew.forecast,eew.warning,telegram.volcano` |
| `--test <mode>` | テスト電文: `no` / `including` / `only` | `no` |
| `--keep-existing` | 既存接続を維持（互換オプション。現在はデフォルト動作） | `true` |
| `--close-others` | 同一 API キーの既存ソケットを閉じてから接続 | `false` |
| `--mode <mode>` | 表示モード: `normal` / `compact` | `normal` |
| `--debug` | デバッグログ表示 | `false` |

## 設定

### Config ファイル

永続設定は OS 別のディレクトリに保存されます。

| OS | デフォルトパス |
|----|---------------|
| macOS | `~/Library/Application Support/fleq/config.json` |
| Linux | `~/.config/fleq/config.json` |
| Windows | `%APPDATA%\fleq\config.json` |

環境変数 `XDG_CONFIG_HOME` が設定されている場合は、全 OS で `$XDG_CONFIG_HOME/fleq/config.json` が優先されます。
旧バージョンで `~/.config/fleq/` や `~/.config/dmdata-monitor/` に保存された設定は、初回起動時に自動的に移行されます。

```bash
fleq config show          # 現在の設定を表示
fleq config set <key> <value>  # 設定値を保存
fleq config unset <key>   # 設定値を削除
fleq config path          # Config ファイルの保存先を表示
fleq config keys          # 設定可能キー一覧を表示
```

### `config set` で操作できるキー

| キー | 説明 |
|------|------|
| `apiKey` | dmdata.jp API キー |
| `classifications` | 受信区分（カンマ区切り） |
| `testMode` | テスト電文モード: `"no"` / `"including"` / `"only"` |
| `appName` | アプリケーション名（複数デバイス運用時に変更。後述） |
| `maxReconnectDelaySec` | 再接続の最大待機秒数 |
| `keepExistingConnections` | 既存ソケットを維持するかどうか (`true` / `false`) |
| `tableWidth` | テーブル表示幅 (40〜200、デフォルト: 60) |
| `infoFullText` | お知らせ電文の全文表示 (`true` / `false`) |
| `displayMode` | 表示モード: `"normal"` / `"compact"` |
| `promptClock` | プロンプト時計: `"elapsed"` (経過時間) / `"clock"` (現在時刻) |
| `waitTipIntervalMin` | 待機中ヒント表示間隔（分、0 で無効、デフォルト: 30） |
| `sound` | 通知音の有効/無効 (`true` / `false`) |
| `eewLog` | EEW ログ記録の有効/無効 (`true` / `false`) |
| `maxObservations` | 観測点の最大表示件数 (1〜999 / `"off"` で全件表示) |
| `backup` | EEW 副回線の有効/無効 (`true` / `false`) |
| `truncation` | 省略表示の上限設定（`truncation.<key> <N>` で個別設定。`fleq config keys` で詳細を確認） |

> **補足:** `eewLogFields`（EEW ログの記録項目）と通知カテゴリ設定は、REPL の `eewlog fields` / `notify` コマンドで管理します。

### 設定の優先順位（高い順）

1. CLI オプション (`--api-key`, `--classifications`, `--test`, `--keep-existing`, `--close-others`)
2. 環境変数 `DMDATA_API_KEY`（API キーのみ）
3. `.env` ファイル（API キーのみ）
4. Config ファイル（`fleq config path` で確認可能）
5. デフォルト値

### 補足

- Config 保存時と読み込み時は、可能な範囲で `0600` パーミッションへ調整します（API キー保護のため）。Windows では POSIX パーミッションが実効的でないため、ファイルシステムの ACL に依存します。
- **更新チェック:** 起動時に npm registry へ HTTP リクエストを送信し、新しいバージョンの有無を確認します。接続できない場合は GitHub Releases API にフォールバックします。チェック結果は 24 時間キャッシュされます。無効にするには環境変数 `FLEQ_NO_UPDATE_CHECK=1` を設定してください。
- DMDATA 公式仕様に合わせ、REST API の認証は `Authorization: Basic ...` を使用します。
- 通常運用では `--close-others` は不要です（DMDATA 公式は、同時接続数に余裕がない場合のみ Socket Close v2 の利用を案内しています）。

## 複数デバイスで使う場合

同一アカウントの複数 API キーを使って複数デバイスで FlEq を同時に起動する場合は、**デバイスごとに異なる `appName` を設定**してください。

```bash
# デバイスA（例: Mac）
fleq config set appName fleq-mac

# デバイスB（例: Raspberry Pi）
fleq config set appName fleq-raspi
```

FlEq は起動時に前回セッションの残留ソケットをクリーンアップしますが、`appName` が同じだと他デバイスのソケットまで閉じてしまいます。デバイスごとに異なる `appName` を設定することで、自分のソケットのみがクリーンアップ対象になります。

Raspberry Pi での常時稼働については [Raspberry Pi 500 セットアップガイド](docs/raspi500-setup-guide.md) も参照してください。

## REPL コマンド

実行中に `fleq> ` プロンプトで以下のコマンドを利用できます。`help` コマンドでカテゴリ別の一覧を表示できます。

### 情報
| コマンド | 説明 |
|----------|------|
| `help` / `?` | コマンド一覧を表示 |
| `history [N]` | 地震履歴を取得・表示（デフォルト 10 件、最新が一番下） |
| `colors` | カラーパレット・震度色の一覧を表示 |
| `detail [tsunami\|volcano]` | 直近の津波情報または火山警報状態を再表示 |

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
| `notify` | 通知カテゴリの ON/OFF 状態を表示 |
| `notify <category> [on\|off]` | 指定カテゴリの通知をトグル/ON/OFF |
| `notify all:on` / `all:off` | 全カテゴリの通知を一括 ON/OFF |
| `eewlog` | EEW ログ記録の設定を表示 |
| `eewlog on` / `off` | EEW ログ記録の有効/無効を切替 |
| `eewlog fields` | EEW ログ記録項目の一覧表示 |
| `eewlog fields <field> [on\|off]` | 記録項目のトグル/ON/OFF |
| `tablewidth [N\|auto]` | テーブル幅の表示・変更（`auto` でターミナル幅に自動追従） |
| `infotext [full/short]` | お知らせ電文の全文/省略切替 |
| `tipinterval [N]` | 待機中ヒント表示間隔（分）を表示・変更（0 で無効） |
| `mode [normal/compact]` | 表示モード切替 |
| `clock [elapsed/now]` | プロンプト時計の切替（`now` は Config 上の `"clock"` に対応） |
| `sound [on/off]` | 通知音の ON/OFF 切替 |
| `theme` | カラーテーマの表示・管理（`theme path` / `theme show` / `theme reset` / `theme reload` / `theme validate`） |
| `mute [duration]` | 通知を一時ミュート（例: `mute 30m`、`mute off` で解除） |
| `fold [N\|off]` | 観測点の表示件数制限（例: `fold 10`、`fold off` で全件表示） |
| `limit` | 省略表示の上限設定を一覧表示 |
| `limit <key> <N>` | 上限値を変更（1〜999） |
| `limit <key> default` | デフォルト値に戻す |
| `limit reset` | 全項目をデフォルトに戻す |

### 操作
| コマンド | 説明 |
|----------|------|
| `test sound [level]` | サウンドテスト（レベル: critical, warning, normal, info, cancel） |
| `test table [type] [番号]` | 表示形式テスト |
| `backup [on/off]` | EEW 副回線の状態表示・起動/停止 |
| `clear` | ターミナル画面をクリア |
| `retry` | WebSocket 再接続を手動試行 |
| `quit` / `exit` | アプリケーションを終了 |

## 通知

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
- ヘッドレス環境（サーバー、SSH 接続のみ）では通知を表示する手段がないため、通知機能は自動的に無効になります。アプリの動作には影響しません。
- `node-notifier` のインストールに失敗した場合でも、通知以外の機能は正常に動作します。

## FAQ / トラブルシューティング

**Q: `fleq` コマンドが見つからない**
A: グローバルインストールが完了しているか確認してください。`npm install -g @sayue_ltr/fleq` を再実行し、`npm bin -g` のパスが環境変数 `PATH` に含まれているか確認してください。

**Q: API キーを設定したのに接続できない**
A: API キーに必要な権限が付与されているか確認してください。最低限 `socket.start` と、受信する区分に対応する `telegram.get.*` 権限が必要です。dmdata.jp の管理画面で確認できます。

**Q: EEW が受信できない**
A: `eew.forecast` / `eew.warning` の受信には dmdata.jp の対応する契約が必要です。

**Q: 他のデバイスで FlEq を起動したら、既存の接続が切れた**
A: デバイスごとに異なる `appName` を設定してください。詳しくは「複数デバイスで使う場合」を参照してください。

**Q: Linux でデスクトップ通知が表示されない**
A: `notify-send` がインストールされているか確認してください（`sudo apt install libnotify-bin`）。SSH 接続のみのヘッドレス環境では通知は利用できませんが、本体の動作には影響しません。

## 関連ドキュメント

- [表示リファレンス](docs/display-reference.md) — 電文タイプ別の表示フォーマット一覧
- [Raspberry Pi 500 セットアップガイド](docs/raspi500-setup-guide.md) — Raspberry Pi での常時稼働セットアップ
- [内部仕様書](docs/specs/) — アーキテクチャ・電文ルーティング・UI 仕様等の開発者向けドキュメント
- [ソースコード](https://github.com/Lateo2580/FlEq) — ビルド・開発方法は `npm run dev` / `npm test` 等。詳細はリポジトリを参照

## アンインストール

```bash
npm uninstall -g @sayue_ltr/fleq
```

Config ファイルを削除する場合は、`fleq config path` で表示されたディレクトリを手動で削除してください。

## 出典

テストで使用しているフィクスチャデータ (`test/fixtures/`) は、気象庁防災情報 XML のサンプルデータを加工して作成しています。

> 気象庁「防災情報 XML フォーマット 技術資料」 (https://xml.kishou.go.jp/tec_material.html) を加工して作成

## ライセンス

MIT
