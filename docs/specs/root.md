# ルートモジュール仕様書

本書はプロジェクトルート直下の共有モジュール群 (`src/index.ts`, `src/types.ts`, `src/config.ts`, `src/logger.ts`, `src/utils/secrets.ts`, `src/utils/intensity.ts`) の設計と仕様を記述する。

---

## src/index.ts

### 概要

アプリケーションのエントリポイント。CLI ツールとしての起動に必要な最小限のブートストラップのみを担い、ロジックは一切持たない。環境変数の読み込み (`dotenv`) と Commander プログラムの構築・実行を行い、未捕捉エラー時にはメッセージを出力してプロセスを終了する。

薄いエントリポイントとすることで、テスト時に `engine/cli.ts` 以下を個別にインポート・テストしやすくしている。

### エクスポートAPI

エクスポートなし。`#!/usr/bin/env node` シバン付きの実行スクリプト。

### 内部ロジック

1. `process.env.DOTENV_CONFIG_QUIET = "true"` を設定し、`.env` ファイルが存在しない場合の警告を抑制
2. `dotenv.config()` で `.env` ファイルから環境変数を読み込み
3. `buildProgram()` で Commander プログラムを構築
4. `program.parseAsync()` で CLI 引数をパースし、対応するアクションを実行
5. `catch` で致命的エラーを捕捉し、`err instanceof Error` ガードでメッセージを取り出してから `process.exit(1)` で終了

### 依存関係

| インポート元 | 用途 |
|---|---|
| `dotenv` | `.env` ファイルの読み込み |
| `./engine/cli` | `buildProgram()` — Commander プログラム定義 |

### 設計ノート

- `dotenv.config()` はトップレベルで同期的に呼び出される。これにより、以降のすべてのモジュールが `process.env` 経由で環境変数を参照できる。
- `DOTENV_CONFIG_QUIET` は dotenv の import 前に設定する必要があるため、`process.env` への直接代入で行っている。
- `parseAsync()` を使うことで、Commander のアクションハンドラが非同期関数であっても正しく await される。

---

## src/types.ts

### 概要

プロジェクト全体で共有される型定義と定数を集約するモジュール。dmdata.jp API のレスポンス型、WebSocket メッセージ型、パース済み電文型、アプリケーション設定型を定義する。外部依存を持たず、純粋な型・インターフェース・定数のみで構成される。

### エクスポートAPI

#### 型エイリアス

| 名前 | 定義 | 説明 |
|---|---|---|
| `DisplayMode` | `"normal" \| "compact"` | 表示モード |
| `PromptClock` | `"elapsed" \| "clock"` | プロンプト時計モード |
| `EewLogField` | `"hypocenter" \| "originTime" \| "coordinates" \| "magnitude" \| "forecastIntensity" \| "maxLgInt" \| "forecastAreas" \| "lgIntensity" \| "isPlum" \| "hasArrived" \| "diff" \| "maxIntChangeReason"` | EEW ログ記録項目 |
| `NotifyCategory` | `"eew" \| "earthquake" \| "tsunami" \| "seismicText" \| "nankaiTrough" \| "lgObservation"` | 通知カテゴリ |
| `NotifySettings` | `Record<NotifyCategory, boolean>` | 通知設定 (カテゴリごとの ON/OFF) |
| `Classification` | `"telegram.earthquake" \| "eew.forecast" \| "eew.warning"` | dmdata.jp API の分類区分 |
| `WsMessage` | `WsStartMessage \| WsPingMessage \| WsPongMessage \| WsDataMessage \| WsErrorMessage` | WebSocket メッセージの判別共用体 |

#### インターフェース — アプリケーション設定

| 名前 | 説明 |
|---|---|
| `AppConfig` | アプリケーション設定の完全型。`apiKey` を必須フィールドとして含む |
| `ConfigFile` | Configファイルの型。`AppConfig` の全フィールドを省略可能にした部分型 |

`AppConfig` の主要フィールド:

| フィールド | 型 | 説明 |
|---|---|---|
| `apiKey` | `string` | dmdata.jp APIキー |
| `classifications` | `Classification[]` | 受信する分類区分 |
| `testMode` | `"no" \| "including" \| "only"` | テスト電文の扱い |
| `appName` | `string` | Socket Start 時に送信するアプリケーション名 |
| `maxReconnectDelaySec` | `number` | 再接続の最大待機秒数 |
| `keepExistingConnections` | `boolean` | 既存 open socket の維持 |
| `tableWidth` | `number \| null` | テーブル表示幅 (`null` でターミナル幅自動追従) |
| `infoFullText` | `boolean` | お知らせ電文の全文表示 |
| `displayMode` | `DisplayMode` | 表示モード |
| `promptClock` | `PromptClock` | プロンプト時計モード |
| `waitTipIntervalMin` | `number` | 待機中ヒント表示間隔 (分) |
| `notify` | `NotifySettings` | 通知設定 |
| `sound` | `boolean` | 通知音の有効/無効 |
| `eewLog` | `boolean` | EEW ログ記録の有効/無効 |
| `eewLogFields` | `Record<EewLogField, boolean>` | EEW ログ記録項目 |

#### インターフェース — dmdata.jp API レスポンス

| 名前 | 説明 |
|---|---|
| `ContractListResponse` | Contract List API レスポンス |
| `ContractItem` | 契約情報の各アイテム |
| `SocketStartResponse` | Socket Start API レスポンス (`ticket`, `websocket.url` 等を含む) |
| `SocketListResponse` | Socket List API レスポンス |
| `SocketListItem` | ソケット情報の各アイテム |

#### インターフェース — WebSocket メッセージ

| 名前 | `type` フィールド | 説明 |
|---|---|---|
| `WsStartMessage` | `"start"` | 接続開始メッセージ |
| `WsPingMessage` | `"ping"` | Ping メッセージ |
| `WsPongMessage` | `"pong"` | Pong メッセージ |
| `WsDataMessage` | `"data"` | データ電文メッセージ (XML本文を含む) |
| `WsErrorMessage` | `"error"` | エラーメッセージ |

`WsDataMessage` は `xmlReport` フィールドに `control` (発表元情報) と `head` (タイトル・イベントID・情報種別等) を含み、`body` フィールドに gzip+base64 エンコードされた XML 電文本体を格納する。

#### インターフェース — 地震履歴 API

| 名前 | 説明 |
|---|---|
| `GdEarthquakeListResponse` | 地震履歴 API レスポンス |
| `GdEarthquakeItem` | 地震履歴の各アイテム (震源・マグニチュード・最大震度) |

#### インターフェース — パース済み電文

| 名前 | 対応電文 | 説明 |
|---|---|---|
| `ParsedEarthquakeInfo` | VXSE51/52/53/61 | パース済み地震情報 (震源・震度・津波コメント) |
| `ParsedEewInfo` | VXSE43/44/45 | パース済み緊急地震速報 (予測震度・警報フラグ・PLUM法判定) |
| `ParsedTsunamiInfo` | VTSE41/51/52 | パース済み津波情報 (予報区域・観測局・推定) |
| `ParsedSeismicTextInfo` | VXSE56/60, VZSE40 | パース済みテキスト系地震情報 |
| `ParsedNankaiTroughInfo` | VYSE50/51/52/60 | パース済み南海トラフ関連情報 |
| `ParsedLgObservationInfo` | VXSE62 | パース済み長周期地震動観測情報 |
| `TsunamiForecastItem` | — | 津波予報区域の警報情報 |
| `TsunamiObservationStation` | — | 沖合津波観測局情報 |
| `TsunamiEstimationItem` | — | 沖合津波推定情報 |
| `LgObservationArea` | — | 長周期地震動観測地域 |

#### 定数

| 名前 | 型 | 説明 |
|---|---|---|
| `DEFAULT_CONFIG` | `Omit<AppConfig, "apiKey">` | デフォルト設定値。`apiKey` 以外の全フィールドの初期値を定義 |

`DEFAULT_CONFIG` の主要な初期値:
- `classifications`: 全3区分 (`telegram.earthquake`, `eew.forecast`, `eew.warning`)
- `testMode`: `"no"`
- `appName`: `"fleq"`
- `maxReconnectDelaySec`: `60`
- `keepExistingConnections`: `true`
- `tableWidth`: `null` (自動)
- `notify`: 全カテゴリ `true`
- `eewLogFields`: 全項目 `true`

### 内部ロジック

型定義のみのため、ランタイムロジックは `DEFAULT_CONFIG` の定数定義のみ。

### 依存関係

外部依存なし。他のすべてのモジュールから参照される基盤モジュール。

### 設計ノート

- `AppConfig` と `ConfigFile` を分離することで、「完全な設定」と「部分的な設定ファイル」を型レベルで区別している。`ConfigFile` の省略可能フィールドは `DEFAULT_CONFIG` とマージされて `AppConfig` になる。
- `WsMessage` は判別共用体 (discriminated union) として `type` フィールドでナローイングできる。
- パース済み電文型は電文タイプごとに分割し、各パーサ関数の戻り値型として使われる。共通フィールド (`type`, `infoType`, `title`, `reportDateTime`, `headline`, `publishingOffice`, `isTest`) は全型に存在するが、基底インターフェースの継承ではなく各型で直接定義している。

---

## src/config.ts

### 概要

Configファイル (`config.json`) の読み書き・バリデーション・マイグレーションを管理するモジュール。OS 別のパス解決、旧バージョンからの自動マイグレーション、フィールド単位のバリデーション、CLI の `fleq config` サブコマンド向けの表示関数を提供する。

APIキーを含むため、ファイル権限を `0600` (所有者のみ読み書き)、ディレクトリ権限を `0700` で管理するセキュリティ対策を施している。

### エクスポートAPI

#### クラス

```typescript
class ConfigError extends Error
```

設定値の不正時にスローされるエラー。`name` プロパティは `"ConfigError"`。

#### 関数

| シグネチャ | 説明 |
|---|---|
| `resolveConfigDir(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, homedir?: string): string` | OS・環境変数からConfigディレクトリのパスを解決する純粋関数。テスト時にパラメータを差し替え可能 |
| `getConfigDir(): string` | 現在のプロセス環境でのConfigディレクトリを返す (`resolveConfigDir()` のショートハンド) |
| `getConfigPath(): string` | Configファイル (`config.json`) のフルパスを返す |
| `loadConfig(): ConfigFile` | Configファイルを読み込み、バリデーション済みの `ConfigFile` を返す。ファイル不在時は空オブジェクト |
| `saveConfig(config: ConfigFile): void` | `ConfigFile` をJSON形式でConfigファイルに書き込む (権限 `0600`) |
| `setConfigValue(key: string, value: string): void` | 設定値を1件セットしてファイルに保存。無効なキーや値の場合は `ConfigError` をスロー |
| `unsetConfigValue(key: string): void` | 設定値を1件削除してファイルに保存。無効なキーの場合は `ConfigError` をスロー |
| `printConfig(): void` | 現在の設定をコンソールに整形表示 (APIキーはマスク) |
| `printConfigKeys(): void` | 設定可能なキー一覧と説明をコンソールに表示 |

#### 定数

| 名前 | 型 | 説明 |
|---|---|---|
| `VALID_CLASSIFICATIONS` | `Classification[]` | 有効な分類区分の一覧 |
| `VALID_EEW_LOG_FIELDS` | `EewLogField[]` | 有効な EEW ログ記録項目の一覧 |

### 内部ロジック

#### Configディレクトリ解決 (`resolveConfigDir`)

以下の優先順位でパスを決定する:

1. 環境変数 `XDG_CONFIG_HOME` が設定されている場合: `$XDG_CONFIG_HOME/fleq`
2. macOS (`darwin`): `~/Library/Application Support/fleq`
3. Windows (`win32`): `%APPDATA%/fleq` (フォールバック: `~/AppData/Roaming/fleq`)
4. その他 (Linux等): `~/.config/fleq`

#### マイグレーション (`migrateConfigIfNeeded`)

新パスにConfigファイルが存在しない場合、以下の順で旧パスを探索し、見つかればコピーする:

1. `~/.config/fleq/config.json` — macOS/Windows でレガシーパスに保存されていた場合 (現在のConfigディレクトリと同一パスなら候補から除外)
2. `~/.config/dmdata-monitor/config.json` — 旧アプリ名

`fs.constants.COPYFILE_EXCL` フラグにより、別プロセスが先にファイルを作成した場合の競合を防止する。

#### バリデーション (`validateConfig`)

`loadConfig()` 内で呼ばれる内部関数群 (`applyApiKey`, `applyClassifications`, `applyTestMode` 等) がフィールドごとに型・値域チェックを行う:

- `apiKey`: 空でない文字列
- `classifications`: 文字列の場合はカンマ区切りでパース、配列の場合は各要素を `VALID_CLASSIFICATIONS` と照合
- `testMode`: `"no"`, `"including"`, `"only"` のいずれか
- `maxReconnectDelaySec`: 正の数値
- `tableWidth`: 40 以上 200 以下の数値
- `waitTipIntervalMin`: 0 以上 1440 以下の整数
- `notify`: オブジェクト内の各キーが有効な `NotifyCategory` かつ値が `boolean`
- `eewLogFields`: オブジェクト内の各キーが有効な `EewLogField` かつ値が `boolean`
- 真偽値フィールド (`keepExistingConnections`, `infoFullText`, `sound`, `eewLog`): `typeof value === "boolean"`

無効な値は無視されて結果の `ConfigFile` に含まれない (エラーにはならない)。一方、`setConfigValue()` では無効な値で `ConfigError` をスローする。

#### 設定値の表示 (`printConfig`)

`CONFIG_KEYS` レコードに定義されたキー順で設定を表示する。`apiKey` の値のみ `secretUtils.maskApiKey()` でマスクされる。

### 依存関係

| インポート元 | 用途 |
|---|---|
| `fs`, `path`, `os` | ファイルシステム操作、パス解決、ホームディレクトリ取得 |
| `./types` | `ConfigFile`, `Classification`, `DisplayMode`, `PromptClock`, `NotifyCategory`, `EewLogField` |
| `./utils/secrets` | `maskApiKey()` — APIキーのマスク表示 |
| `./logger` | `log.info()`, `log.warn()` — マイグレーション結果のログ出力 |

### 設計ノート

- `resolveConfigDir()` は引数にデフォルト値を持つ純粋関数として設計されており、テスト時に `platform`, `env`, `homedir` を差し替えてクロスプラットフォームのパス解決をテストできる。
- バリデーションを `applyXxx` 関数群に分割することで、各フィールドの検証ロジックが独立し、新設定項目の追加が容易になっている。
- `loadConfig()` はバリデーション失敗時に空オブジェクトを返すフォールトトレラント設計。ユーザーがConfigファイルを手動編集して壊した場合でもアプリケーションが起動可能。
- `setConfigValue()` は read-modify-write パターンで既存の設定を保持しつつ1フィールドのみ更新する。
- ファイル権限の強制 (`hardenConfigPermissions`) は `chmod` が利用可能なプラットフォームでのみ効果がある。Windows では失敗しても警告に留める。

---

## src/logger.ts

### 概要

ログレベル付きのターミナル出力ロガー。chalk によるカラーリング、動的に差し替え可能なプレフィックスビルダー、REPL プロンプトとの干渉を防ぐための出力前後フックを備える。

通常のログ出力 (`debug`, `info`, `warn`, `error`) に加え、重要な地震情報や EEW 向けの強調表示関数 (`alert`, `eewWarning`, `eewForecast`) を提供する。

### エクスポートAPI

#### 列挙型

```typescript
enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}
```

#### 関数

| シグネチャ | 説明 |
|---|---|
| `setLogLevel(level: LogLevel): void` | 現在のログレベルを設定。指定レベル以上のメッセージのみ出力される |
| `setLogPrefixBuilder(builder: (() => string) \| null): void` | ログ行のプレフィックスビルダーを設定。REPL から接続状態・経過時間に応じたプレフィックスを動的に差し替えるために使用 |
| `setLogHooks(hooks: { beforeLog: () => void; afterLog: () => void } \| null): void` | ログ出力前後のフックを設定。REPL プロンプト行のクリアと再描画に使用 |
| `debug(msg: string, ...args: unknown[]): void` | DEBUGレベルのログ出力 (灰色) |
| `info(msg: string, ...args: unknown[]): void` | INFOレベルのログ出力 (白色) |
| `warn(msg: string, ...args: unknown[]): void` | WARNレベルのログ出力 (黄色) |
| `error(msg: string, ...args: unknown[]): void` | ERRORレベルのログ出力 (赤色) |
| `alert(msg: string): void` | 重要地震情報向け強調出力 (赤背景白文字太字) |
| `eewWarning(msg: string): void` | EEW警報向け強調出力 (黄背景黒文字太字) |
| `eewForecast(msg: string): void` | EEW予報向け出力 (シアン背景黒文字) |

### 内部ロジック

#### 状態管理

モジュールレベル変数として以下の3つの状態を保持する:

- `currentLevel: LogLevel` — 現在のログレベル (初期値 `LogLevel.INFO`)
- `prefixBuilder: (() => string) | null` — プレフィックス生成関数 (初期値 `null`)
- `logHooks: { beforeLog, afterLog } | null` — 出力前後フック (初期値 `null`)

#### 出力フロー

1. ログレベルを `currentLevel` と比較し、出力対象でなければ即座にリターン
2. `logHooks` が設定されている場合、`beforeLog()` を呼び出し (REPL プロンプト行をクリア)
3. `getPrefix()` でプレフィックス文字列を取得 (`prefixBuilder` があればそれを呼び出し、なければデフォルトの `FlEq [○ --:--:--]> `)
4. chalk でカラーリングしたメッセージを `console.log()` で出力
5. `logHooks` が設定されている場合、`afterLog()` を呼び出し (REPL プロンプトを再描画)

#### 強調表示関数

`alert`, `eewWarning`, `eewForecast` はログレベルに関係なく常に出力される。これらはプレフィックスを付与せず、メッセージ全体をスタイリングする。

### 依存関係

| インポート元 | 用途 |
|---|---|
| `chalk` | ターミナルカラーリング |

### 設計ノート

- namespace import (`import * as log from "./logger"`) で利用される前提で設計されており、呼び出し側では `log.info()`, `log.warn()` のように読みやすい形で使える。
- `prefixBuilder` と `logHooks` による動的差し替えは、ロガーが REPL モジュールに依存しないようにするための逆方向の依存注入パターン。REPL がロガーにフックを注入することで、ログ出力と readline プロンプトの描画が干渉しない。
- `alert`, `eewWarning`, `eewForecast` がログレベルを無視するのは、緊急性の高い地震情報はユーザーのログレベル設定に関係なく必ず表示すべきという設計判断による。
- 可変引数 `...args: unknown[]` は `console.log` にそのまま渡され、オブジェクトの inspect 表示等に利用できる。

---

## src/utils/secrets.ts

### 概要

APIキー等の秘密情報をログや画面表示時にマスクするためのユーティリティモジュール。先頭と末尾の一部のみを表示し、中間部分を `****` に置換する。

### エクスポートAPI

| シグネチャ | 説明 |
|---|---|
| `maskApiKey(apiKey: string): string` | APIキーの先頭4文字と末尾4文字を残し、中間を `****` に置換して返す。全長が8文字以下の場合は `****` のみを返す |

### 内部ロジック

定数:
- `VISIBLE_EDGE_LENGTH = 4` — 先頭・末尾それぞれの可視文字数
- `MASK_PLACEHOLDER = "****"` — マスク文字列

処理:
1. `apiKey.length <= VISIBLE_EDGE_LENGTH * 2` (8文字以下) の場合、マスク文字列のみを返す (先頭・末尾を表示すると全文が露出するため)
2. それ以外の場合、`apiKey.substring(0, 4) + "****" + apiKey.substring(apiKey.length - 4)` を返す

例: `"abcdefghijklmnop"` → `"abcd****mnop"`

### 依存関係

外部依存なし。`config.ts` の `printConfig()` から参照される。

### 設計ノート

- 短いキーに対する完全マスクは、部分表示により全体が推測可能になることを防ぐセキュリティ対策。
- 独立したユーティリティモジュールとして切り出すことで、将来的に他の秘密情報のマスクにも再利用可能。

---

## src/utils/intensity.ts

### 概要

気象庁震度階級の文字列表現を数値ランクに変換するユーティリティモジュール。震度のソート・比較に使用される。

### エクスポートAPI

| シグネチャ | 説明 |
|---|---|
| `intensityToRank(intensity: string): number` | 震度文字列をソート・比較用の数値 (1〜9) に変換する。不明な値は `0` を返す |

### 内部ロジック

内部定数 `INTENSITY_RANK` に震度文字列と数値の対応を定義する:

| 震度文字列 | 数値ランク |
|---|---|
| `"1"` | 1 |
| `"2"` | 2 |
| `"3"` | 3 |
| `"4"` | 4 |
| `"5-"`, `"5弱"` | 5 |
| `"5+"`, `"5強"` | 6 |
| `"6-"`, `"6弱"` | 7 |
| `"6+"`, `"6強"` | 8 |
| `"7"` | 9 |

入力文字列から空白文字を除去 (`replace(/\s+/g, "")`) した上でルックアップを行い、テーブルに存在しない値は `0` を返す (`?? 0`)。

### 依存関係

外部依存なし。`ui/formatter.ts` 等の表示モジュールから参照される。

### 設計ノート

- 気象庁の震度階級は `"5弱"` / `"5-"` のように複数の表記が存在する。XML 電文では `"5-"` / `"5+"` 形式、日本語表示では `"5弱"` / `"5強"` 形式が使われるため、両方の表記を同じランクにマッピングしている。
- 空白除去は XML パーサが余分な空白を含む場合への防御的処理。
- Nullish coalescing (`?? 0`) により、未知の震度文字列でもエラーにならず最低ランクとして扱われる。
