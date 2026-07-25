# engine/ モジュール仕様書

本文書は `src/engine/` 配下のファイルについて、エクスポートAPI・内部ロジック・依存関係・設計意図を記述する。

---

## cli/cli.ts

### 概要

Commander ベースの CLI 定義を担うエントリ構成ファイル。`buildProgram()` が返す `Command` オブジェクトが `index.ts` から呼ばれ、サブコマンド群を含む CLI ツリー全体を構築する。メインアクション（モニタ起動）と `init` コマンドは dynamic import で遅延ロードし、起動時のメモリフットプリントを抑える設計。

### エクスポートAPI

```ts
function buildProgram(): Command
```

Commander の `Command` インスタンスを生成・返却する。以下のコマンド体系を定義する。

| コマンド | 説明 |
|---------|------|
| `fleq` (デフォルト) | モニタ起動。`cli-run.ts` の `runMonitor()` を dynamic import で呼び出す。設定解決は `config-resolver.ts` に委譲 |
| `fleq init` | インタラクティブ初期設定。`cli-init.ts` の `runInit()` を dynamic import で呼び出す |
| `fleq config show` | 現在の設定を表示 |
| `fleq config set <key> <value>` | 設定値を保存 |
| `fleq config unset <key>` | 設定値を削除 |
| `fleq config path` | Config ファイルのパスを表示 |
| `fleq config keys` | 設定可能なキー一覧を表示 |

デフォルトコマンドの CLI オプション:

| オプション | 説明 |
|-----------|------|
| `-k, --api-key <key>` | dmdata.jp API キー |
| `-c, --classifications <items>` | 受信区分（カンマ区切り） |
| `--test <mode>` | テスト電文の扱い (`"no"` / `"including"` / `"only"`) |
| `--keep-existing` | 既存 WebSocket 接続を維持（互換オプション、現在はデフォルト） |
| `--close-others` | 同一 API キーの既存 open socket を閉じてから接続 |
| `--mode <mode>` | 表示モード (`"normal"` / `"compact"`) |
| `--filter <expr>` | 条件式で電文を絞り込む（複数指定で AND 結合） |
| `--template <template>` | 電文の1行要約テンプレートを指定（`@` でファイル読込） |
| `--focus <expr>` | 条件に一致しない電文を dim 表示に落とす |
| `--summary-interval [minutes]` | N分ごとに受信要約を表示（デフォルト10分、`0` で無効化） |
| `--night` | ナイトモードを有効にする |
| `--debug` | デバッグログ表示（デフォルト `false`） |

### 内部ロジック

- `package.json` から `version` を `require()` で同期読み込みし、`program.version()` に渡す。
- `config` サブコマンドの `set` / `unset` は `ConfigError` を catch して `log.error()` + `process.exit(1)` とする。それ以外の例外は再スローする。
- デフォルトアクションと `init` アクションは `async action` 内で `await import(...)` を使い、実行時まで対象モジュールをロードしない。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `commander` | `Command` クラス |
| `../../config` | `setConfigValue`, `unsetConfigValue`, `printConfig`, `printConfigKeys`, `getConfigPath`, `ConfigError` |
| `../../logger` | ログ出力 |
| `./cli-run` | `RunMonitorOptions` 型（型のみ import）、`runMonitor` 関数（dynamic import） |
| `./cli-init` | `runInit` 関数（dynamic import） |
| `../startup/config-resolver` | 設定解決ロジック（dynamic import 経由で `cli-run.ts` から利用） |

### 設計ノート

- Commander のアクションハンドラ内で dynamic import を使うことで、`fleq config show` のような軽量コマンドが `ws` や `fast-xml-parser` などの重い依存を読み込まずに済む。
- `RunMonitorOptions` は `import type` で型のみインポートし、ランタイムバンドルに影響しない。

---

## cli/cli-init.ts

### 概要

`fleq init` コマンドの実装。readline ベースのインタラクティブウィザードで、API キー入力・契約確認・受信区分選択・テストモード選択の4ステップを対話的に進め、結果を Config ファイルに保存する。

### エクスポートAPI

```ts
async function runInit(): Promise<void>
```

インタラクティブ初期設定を実行する。既存の Config ファイルがあれば現在値をデフォルトとして提示する。

### 内部ロジック

#### ウィザードの流れ

1. **[1/4] API キー入力** — 既存設定があればマスク表示。空入力で既存値を維持。未設定かつ空入力なら `process.exit(1)`。
2. **[2/4] 契約確認** — `listContracts()` で dmdata.jp API から契約済み区分を取得・表示。失敗時は警告のみで続行。
3. **[3/4] 受信区分選択** — 複数選択ヘルパー `askMultiChoice()` を使用。デフォルト値の優先順位: 既存 Config > 契約済み区分 > 全区分。
4. **[4/4] テストモード選択** — 単一選択ヘルパー `askSingleChoice()` を使用。
5. **確認・保存** — 設定内容を一覧表示し Y/n で確認。承認されれば `saveConfig()` で永続化。

#### 内部ヘルパー関数

| 関数 | シグネチャ | 説明 |
|------|-----------|------|
| `askText` | `(rl, prompt) => Promise<string>` | テキスト入力。trim 済みの文字列を返す |
| `askConfirm` | `(rl, prompt) => Promise<boolean>` | Y/n 確認。空入力は `true`（デフォルト Yes） |
| `askSingleChoice` | `<T>(rl, options, defaultValue) => Promise<T>` | 番号による単一選択（1-indexed） |
| `askMultiChoice` | `(rl, options, defaultValues) => Promise<Classification[]>` | 番号によるスペース/カンマ区切り複数選択 |
| `classificationLabel` | `(value) => string` | 区分値から日本語ラベルを返す |
| `testModeLabel` | `(value) => string` | テストモード値から日本語ラベルを返す |

#### 定数

| 定数 | 説明 |
|------|------|
| `CLASSIFICATION_OPTIONS` | 区分選択肢のメタデータ配列（`telegram.earthquake`, `eew.forecast`, `eew.warning`） |
| `TEST_MODE_OPTIONS` | テストモード選択肢のメタデータ配列（`no`, `including`, `only`） |

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `readline` | 対話入力 |
| `chalk` | 色付き出力 |
| `../../config` | `loadConfig`, `saveConfig`, `VALID_CLASSIFICATIONS`, `getConfigPath` |
| `../../dmdata/rest-client` | `listContracts`（契約確認 API） |
| `../../types` | `Classification`, `ConfigFile` |
| `../../utils/secrets` | `maskApiKey`（API キーマスク表示） |
| `../../logger` | ログ出力 |

### 設計ノート

- readline を直接使用している理由は、`inquirer` 等の対話ライブラリを追加依存に含めず軽量に保つため。
- 無効入力時はエラー終了せず既定値にフォールバックする寛容な設計。
- `finally` ブロックで `rl.close()` を保証し、標準入力のリーク防止。

---

## cli/cli-run.ts

### 概要

デフォルトコマンド（モニタ起動）のアクションハンドラ。CLI オプション・環境変数・Config ファイル・デフォルト値の4層を優先順位に従って解決し、`AppConfig` を構築してから `startMonitor()` へ渡す。設定解決ロジックは `startup/config-resolver.ts` に委譲。起動バナー表示・契約確認・テーマ読み込み・フォーマッタ初期化もここで行う。Filter/Template/Focus のコンパイルは `PipelineController` を通じて行い、コントローラごと `startMonitor()` に渡す。

### エクスポートAPI

```ts
interface RunMonitorOptions {
  apiKey?: string;
  classifications?: string;
  test?: string;
  keepExisting?: boolean;
  closeOthers?: boolean;
  mode?: string;
  filter?: string[];
  template?: string;
  focus?: string;
  summaryInterval?: number;
  night?: boolean;
  debug: boolean;
}

async function runMonitor(opts: RunMonitorOptions): Promise<void>
```

- `runMonitor` — 設定解決・バリデーション・起動シーケンスの実行。

### 内部ロジック

#### 設定解決の優先順位（上位が優先）

| 設定項目 | CLI | 環境変数 | Config | デフォルト |
|---------|-----|---------|--------|-----------|
| `apiKey` | `--api-key` | `DMDATA_API_KEY` | `fileConfig.apiKey` | — |
| `classifications` | `-c` | — | `fileConfig.classifications` | `DEFAULT_CONFIG.classifications` |
| `testMode` | `--test` | — | `fileConfig.testMode` | `DEFAULT_CONFIG.testMode` |
| `keepExistingConnections` | `--close-others` で `false` / `--keep-existing` で `true` | — | `fileConfig.keepExistingConnections` | `DEFAULT_CONFIG.keepExistingConnections` |
| `displayMode` | `--mode` | — | `fileConfig.displayMode` | `DEFAULT_CONFIG.displayMode` |
| `promptClock` | — | — | `fileConfig.promptClock` | `DEFAULT_CONFIG.promptClock` |
| `sound` | — | — | `fileConfig.sound` | `DEFAULT_CONFIG.sound` |

`--close-others` が `true` の場合、他のオプションに関わらず `keepExistingConnections` は `false` になる。

#### classifications のバリデーション

CLI からのカンマ区切り文字列をトークン分割し、`VALID_CLASSIFICATIONS` に含まれないものは警告ログの上で除外する。有効な区分が0件なら `process.exit(1)`。

#### 起動シーケンス

1. ログレベル設定（`--debug` 時）
2. 設定解決（`resolveConfig(opts)` で `AppConfig` 構築）
3. バナータイトル表示（`appName` + `VERSION`）
4. ターミナルタイトル設定
5. 契約状況チェック（`listContracts()`）— 未契約区分は除外、全滅なら `process.exit(1)`、API エラー時は警告のみで続行
6. テーマ読み込み（`loadTheme()`）— 警告があればログ出力
7. ナイトモード設定（`config.nightMode` が `true` なら `setNightMode(true)`）
8. フォーマッタ初期化（`setFrameWidth`, `setInfoFullText`, `setDisplayMode`, `setMaxObservations`, `setTruncation`）
9. Filter / Template / Focus コンパイル — `PipelineController` を構築し、`setFilter()` / `setTemplate()` / `setFocus()` で各式をコンパイル
10. summaryInterval の解決（CLI `--summary-interval` > Config > デフォルト、`0` で無効化）
11. 起動バナー表示（`printBanner`）
12. 更新チェック（`checkForUpdates`、非ブロッキング）
13. `startMonitor(config, pipelineController)` 呼び出し

#### 内部関数

| 関数 | 説明 |
|------|------|
| `printBanner(config)` | 受信区分・テストモード・表示モードをログ出力 |

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `chalk` | 色付き出力 |
| `fs`, `os` | テンプレートファイル読込、ホームディレクトリ解決 |
| `../../types` | `AppConfig`, `Classification` |
| `../../dmdata/rest-client` | `listContracts` |
| `../monitor/monitor` | `startMonitor` |
| `../../ui/formatter` | `setFrameWidth`, `setInfoFullText`, `setDisplayMode`, `setMaxObservations`, `setTruncation` |
| `../../ui/theme` | `loadTheme`, `setNightMode` |
| `../../ui/terminal-title` | `setTerminalTitle` |
| `../startup/config-resolver` | `resolveConfig` |
| `../startup/update-checker` | `checkForUpdates` |
| `../filter-template/pipeline-controller` | `PipelineController` |
| `../../logger` | ログ出力 |

### 設計ノート

- 契約確認の失敗は致命的エラーにしない。API が一時的に利用できないケースでも起動を試みる。
- ターミナルタイトル操作（`setTerminalTitle` / `resetTerminalTitle`）は `ui/terminal-title.ts` の共通モジュールに分離されている。かつて monitor 側が cli-run から `resetTerminalTitle` を逆 import する値参照循環があったが、この分離で解消された。
- `PipelineController` を構築して `startMonitor()` に渡す。filter/focus はエラー時 `process.exit(1)`、template はエラー時に警告のみで通常表示にフォールバックする。`compileFilter` / `compileTemplate` の直接呼び出しは不要になり、コントローラの `setFilter()` / `setTemplate()` / `setFocus()` 経由でコンパイルされる。

---

## monitor/monitor.ts

### 概要

アプリケーションのメインオーケストレーションを担う。`MultiConnectionManager` による接続管理（主回線＋副回線）、メッセージルーティング、REPL 起動、定期要約タイマー (`SummaryTimerControl`)、グレースフルシャットダウンを統合する。シャットダウンロジックは `monitor/shutdown.ts` に、REPL 連携は `monitor/repl-coordinator.ts` に分離されている。`startMonitor()` が呼ばれると、プロセス終了まで制御を保持する。`PipelineController` を受け取り、`getPipeline()` で取得した同一参照を router に渡す。また `createDisplayAdapter()` で UI アダプターを生成し、`DisplayCallbacks` として router に注入する。

### エクスポートAPI

```ts
interface SummaryTimerControl {
  start(intervalMinutes: number): void;
  stop(): void;
  isRunning(): boolean;
  showNow(): void;
}

async function startMonitor(config: AppConfig, pipelineController?: PipelineController): Promise<void>
```

- `SummaryTimerControl` — REPL から定期要約タイマーを制御するためのインターフェース。`start()` で指定分間隔のタイマーを開始し、`stop()` で停止する。`showNow()` は即時要約表示。
- `startMonitor` — WebSocket 接続・REPL 起動・シグナルハンドラ登録を行い、リアルタイム受信を開始する。`pipelineController` が渡された場合、`getPipeline()` で取得したオブジェクト参照を `createMessageHandler({ pipeline, display })` に引き渡す。`PipelineController` 自体は REPL に渡され、REPL からの filter/template/focus 変更が同一参照を通じて router に反映される。

### 内部ロジック

#### 初期化フロー

1. `createDisplayAdapter()` で `DisplayCallbacks` 実装を生成（`ui/display-adapter.ts` を遅延ロード）
1a. `pipelineController.getPipeline()` で pipeline 参照を取得し、`createMessageHandler({ pipeline, display })` でメッセージルーター・EEW ロガー・通知・統計・要約トラッカーインスタンスを取得
2. EEW ログ設定を `config` から反映（`setEnabled`, `setFields`）
3. `MultiConnectionManager` を構築し、3つのコールバックを登録:
   - `onData` — メッセージルーターを呼び出し（REPL 表示制御付き）
   - `onConnected` — 再接続時の切断期間通知、接続状態の REPL 反映
   - `onDisconnected` — 切断時刻記録、REPL 状態更新
4. シャットダウンハンドラを生成（`stopSummaryTimer` コールバック含む）
5. REPL ハンドラを dynamic import で遅延ロードし、先に起動（接続中もコマンド入力可能）
6. シグナルハンドラ登録（`SIGINT`, `SIGTERM`, 非 Windows なら `SIGHUP`）
7. 定期要約タイマー (`SummaryTimerControl`) を生成し、REPL に注入。`config.summaryInterval` が設定済みなら自動起動
8. 津波・火山状態の起動時復元 (`restoreTsunamiState`, `restoreVolcanoState`)
9. `manager.connect()` でバックグラウンド接続開始
10. `config.backup` が有効なら `manager.startBackup()` で副回線を起動（失敗は警告のみ）

#### monitor が所有する display 状態

display runtime は REPL の `display on/off` で作り直されるため、**セッションをまたいで生き続けるべき状態は monitor 本体が所有する**。現在 2 つある。

| 状態 | 所有インスタンス | 注入経路 |
|------|-----------------|---------|
| standby active-state | `StandbyStateStore` + `StandbyPersistence` | `DisplaySeedSources.standbyItems` / `standbySweep` |
| 気象警報の昇格 lifecycle | `WeatherPromotionStore` + `WeatherPromotionPersistence` | `DisplaySeedSources.weatherPromotions` |

昇格 lifecycle を monitor 所有にしているのは、昇格の時計が「電文を受理してからの壁時計経過」であって display セッションの都合ではないため。`display off` → `on` で runtime ごと作り直しても時計が途切れない。`DisplayStateStore` は注入が無ければ自前のインスタンスを生成する (埋込利用・既存テスト互換)。

起動時はどちらも「永続ファイルを `load()` → `restore()` → sweep」の順で立ち上げ、以後は store の `onDurable` 通知を受けて `schedule()` で保存を予約する。受信コールスタック上でも sweep 上でも同期 I/O を走らせない。書き切りはシャットダウン経路のフック (`stopStandbySweep` / `flushWeatherPromotion`) が担う。

どちらの状態も **`displaySink.ingest` で更新する**。`displaySink` は router へ渡す遅延 sink で、hub の有無に関わらず必ず通るため、`display off` 中でも受信が反映される。standby は `standbyStore.applyEvent()`、昇格は `applyWeatherPromotionOnIngest()` を呼ぶ。**昇格を hub 側で更新してはいけない** — 理由は `display/weather-promotion.ts` 節の「受理経路」を参照。

#### REPL 表示制御

`withReplDisplay()` ヘルパーが REPL のプロンプト表示を一時退避・復帰させる。メッセージ表示中はプロンプトを消し、表示後に復帰する。エラーが発生しても `finally` で復帰を保証する。

#### 再接続時の切断期間通知

`disconnectedAt` タイムスタンプを使い、再接続成功時に `gapStart 〜 gapEnd` の期間を警告表示する。この期間に受信できなかった電文がある可能性をユーザーに知らせる。

#### グレースフルシャットダウン

シャットダウンロジックは `monitor/shutdown.ts` に委譲されている。`createShutdownHandler()` で生成された冪等なハンドラが `SIGINT`/`SIGTERM` で呼ばれる。詳細は `monitor/shutdown.ts` セクションを参照。

#### 内部関数

`withReplDisplay` と `updateReplConnectionState` は `monitor/repl-coordinator.ts` からインポートして使用する。

#### 定期要約タイマー

`createSummaryTimerControl()` 内部関数で `SummaryTimerControl` を生成する。`setInterval` (`.unref()` 付き) で定期的に `SummaryWindowTracker.getSnapshot()` を取得し、`formatSummaryInterval()` で整形して表示する。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `chalk` | 色付き出力 |
| `../../types` | `AppConfig` |
| `../../dmdata/multi-connection-manager` | `MultiConnectionManager` |
| `../messages/message-router` | `createMessageHandler` |
| `../startup/tsunami-initializer` | `restoreTsunamiState` |
| `../startup/volcano-initializer` | `restoreVolcanoState` |
| `../../ui/terminal-title` | `resetTerminalTitle` |
| `../../ui/formatter` | `formatTimestamp` |
| `../../ui/summary-interval-formatter` | `formatSummaryInterval` |
| `../messages/summary-tracker` | `SummaryWindowTracker`, `WINDOW_MINUTES` |
| `../../ui/repl` | `ReplHandler`（型 import + dynamic import） |
| `../../ui/display-adapter` | `createDisplayAdapter`（dynamic import） |
| `../filter-template/pipeline-controller` | `PipelineController` 型 |
| `./shutdown` | `createShutdownHandler`, `registerShutdownSignals` |
| `./repl-coordinator` | `withReplDisplay`, `updateReplConnectionState` |
| `../../logger` | ログ出力 |

### 設計ノート

- REPL を接続完了前に起動するのは、接続中でもユーザーが `status` や `help` コマンドを使えるようにするため。
- `closeSocketViaApi` は `Promise.race` でタイムアウトを実装。シャットダウンが無限に待機することを防ぐ。
- `ReplHandler` の型を `import type` で静的インポートしつつ、クラス本体は `await import()` で遅延ロードする二段構え。型安全性とメモリ最適化を両立している。

---

## messages/message-router.ts

### 概要

WebSocket 経由で受信した `WsDataMessage` を、電文の `classification` と `head.type` に基づいて適切なパーサ・表示関数・通知処理にルーティングするファクトリ関数を提供する。`createMessageHandler()` は内部状態（`EewTracker`, `EewEventLogger`, `Notifier`）を閉包に持つハンドラ関数を返す。UI 表示は `DisplayCallbacks` インターフェース経由で行い、`ui/` への直接 import を持たない。火山電文は `VolcanoRouteHandler` に委譲する。

### エクスポートAPI

```ts
interface MessageHandlerOptions {
  pipeline?: FilterTemplatePipeline;
  display?: DisplayCallbacks;
}

interface MessageHandlerResult {
  handler: (msg: WsDataMessage) => void;
  eewLogger: EewEventLogger;
  notifier: Notifier;
  tsunamiState: TsunamiStateHolder;
  volcanoState: VolcanoStateHolder;
  vpws50State: Vpws50StateHolder;
  vpwp50Cache: Vpwp50DetailCache;
  stats: TelegramStats;
  summaryTracker: SummaryWindowTracker;
  flushAndDisposeVolcanoBuffer: () => void;
}

function createMessageHandler(options?: MessageHandlerOptions): MessageHandlerResult
```

- `MessageHandlerOptions` — `pipeline` フィールドで `FilterTemplatePipeline`（filter/template/focus）を注入可能。未指定時は `{ filter: null, template: null, focus: null }` がデフォルト。`display` フィールドで `DisplayCallbacks` を注入し、UI 表示を委譲する。

- `handler` — 受信メッセージをルーティングする関数。
- `eewLogger` — EEW ログ設定の変更用に外部公開。
- `notifier` — 通知設定の変更用に外部公開。
- `tsunamiState` — 津波警報状態の保持・detail コマンド用に外部公開。
- `volcanoState` — 火山警報状態の保持・detail コマンド用に外部公開。
- `stats` — 電文統計 (`TelegramStats`) インスタンス。REPL の `stats` コマンド等に利用。
- `summaryTracker` — 受信要約ウィンドウトラッカー (`SummaryWindowTracker`)。定期要約・REPL `summary` コマンドに利用。
- `flushAndDisposeVolcanoBuffer` — VFVO53 バッファの flush + タイマー破棄。シャットダウン時に呼び出す。

### 内部ロジック

#### ルーティング優先順位

0. **（最優先・classification 非依存）`IGNORED_HEAD_TYPES`** (VPWW53/54, VPNO50, VPOA50, VPZJ50, VPCJ50, VPFJ50, VMCJ50-52, VXWW50) — `ignore` ルート。表示・通知・統計をすべてスキップ（配信終了予定 + 既存電文と内容重複のため）
1. **XML 以外** — `displayRawHeader()` でヘッダのみ表示
2. **`eew.forecast` / `eew.warning`** — EEW パス
   - `parseEewTelegram()` でパース
   - `EewTracker.update()` で重複検出・差分計算
   - 重複報はスキップ（デバッグログのみ）
   - `EewEventLogger.logReport()` でログ記録
   - 取消報なら `closeEvent("取消")`
   - 最終報（`nextAdvisory` あり）なら `closeEvent("最終報")` + `finalizeEvent()`
   - 正常な outcome は共通フローで `recordStats()` → `dispatchNotify()` → `runDisplayPipeline()` の順に処理する。通知は filter 非適用で、表示の filter 結果に影響されない
3. **`telegram.volcano`** — `VolcanoRouteHandler.handle()` に全委譲
   - パース・キャッシュ・VFVO53 集約・通知・表示を一元管理
   - 統計記録のみ router 側で実行
   - 詳細は `messages/volcano-route-handler.ts` セクションを参照
4. **`telegram.earthquake` + `VXSE56` / `VXSE60` / `VZSE40`** — テキスト系
   - `parseSeismicTextTelegram()` → `displaySeismicTextInfo()` → `notifier.notifySeismicText()`
5. **`telegram.earthquake` + `VXSE62`** — 長周期地震動観測
   - `parseLgObservationTelegram()` → `displayLgObservationInfo()` → `notifier.notifyLgObservation()`
6. **`telegram.earthquake` + `VXSE*`** — 地震情報
   - `parseEarthquakeTelegram()` → `displayEarthquakeInfo()` → `notifier.notifyEarthquake()`
7. **`telegram.earthquake` + `VTSE*`** — 津波情報
   - `parseTsunamiTelegram()` → `displayTsunamiInfo()` → `notifier.notifyTsunami()`
8. **`telegram.earthquake` + `VYSE*`** — 南海トラフ関連
   - `parseNankaiTroughTelegram()` → `displayNankaiTroughInfo()` → `notifier.notifyNankaiTrough()`
9. **`telegram.weather` + `VPWW55-61` / `VPWS50`** — 気象警報・注意報 (`weather` ルート)
10. **`telegram.weather` + `VPHW50` / `VPHW51`** — 竜巻注意情報 (`tornado` ルート)
11. **`telegram.weather` + `VPBS50`** — 気象防災速報 (`briefing` ルート)
12. **`telegram.weather` + `VPAW51`** — 早期天候情報 (`earlyWeather` ルート)
13. **`telegram.weather` + `VPWP50`** — 気象警報・注意報時系列情報 (`weatherWarningTimeseries` ルート)
14. **`telegram.weather` + `VPZI50` / `VPCI50`** — 全般/地方天候情報 (`climateInfo` ルート)
15. **`telegram.weather` + `VPCJ51` / `VPZJ51` / `VPFJ51` / `VMCJ53-55`** — 気象解説情報 (地方/全般/府県 + 潮位版) (`weatherExplanation` ルート)
16. **`telegram.weather` + `VPFT50`** — 熱中症警戒アラート (`heatAlert` ルート)
17. **`telegram.weather` + `VPTW60-62`** — 台風解析・予報情報 (`typhoonAnalysis` ルート)
18. **`telegram.weather` + `VPTA50`** — 台風の暴風域に入る確率 (`typhoonProbability` ルート)
19. **`telegram.weather` + `VXKO50-89` / `VXSU50-59`** — 指定河川洪水予報・水位周知河川 (`floodForecast` ルート)
20. **それ以外** — `displayRawHeader()` フォールバック

気象系ルート (9-19) は EEW/地震系と同じ共通フロー `processMessage()` → `recordStats()` → `dispatchNotify()` → `runDisplayPipeline()` で処理される。詳細なルーティング表とフレームレベル判定は `.claude/rules/message-pipeline.md` を参照。

全パスで共通して、パース失敗時は `displayRawHeader()` にフォールバックする。

#### runDisplayPipeline()

`runDisplayPipeline(outcome, displayFn)` は表示の共通パイプラインを一元的に実行する内部関数。以下の6ステップを順に処理する:

1. **toPresentationEvent** — `ProcessOutcome` / `VolcanoBatchOutcome` を統一的な `PresentationEvent` に変換
2. **diffStore** — `PresentationDiffStore.apply()` で前回との差分情報を付与
3. **filter** — `shouldDisplay(event, pipeline)` で `FilterTemplatePipeline.filter` に基づきフィルタリング
4. **summaryTracker** — `SummaryWindowTracker.record()` で受信要約に記録（表示/非表示を問わず）
5. **focus** — `pipeline.focus` が設定されていて条件に一致しない場合、`display.renderSummaryLine()` で dim 表示の1行要約にフォールバック
6. **template** — `renderTemplate(event, pipeline)` でカスタムテンプレート出力。テンプレート未設定なら `display.getDisplayMode()` で compact モード判定を経て `displayFn()` を呼び出す

戻り値は `boolean`: `true` なら表示済み（呼び出し元でフォールバック表示不要）、`false` ならフィルタで非表示。通知は filter 非適用のため、`runDisplayPipeline` の前に `dispatchNotify` で実行される。

#### EEW パスの状態管理

`EewTracker` の `onCleanup` コールバックに `eewLogger.closeEvent(eventId, "タイムアウト")` を設定し、10分間更新がないイベントのログを自動クローズする。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../../types` | `WsDataMessage` |
| `../eew/eew-tracker` | `EewTracker` |
| `../eew/eew-logger` | `EewEventLogger` |
| `../notification/notifier` | `Notifier` |
| `./tsunami-state` | `TsunamiStateHolder` |
| `./volcano-state` | `VolcanoStateHolder` |
| `./telegram-stats` | `TelegramStats`, `routeToCategory` |
| `./summary-tracker` | `SummaryWindowTracker` |
| `./volcano-route-handler` | `VolcanoRouteHandler` |
| `./display-callbacks` | `DisplayCallbacks` 型 |
| `../presentation/processors/process-message` | `processMessage`, `ProcessDeps` |
| `../presentation/events/to-presentation-event` | `toPresentationEvent` |
| `../presentation/diff-store` | `PresentationDiffStore` |
| `../presentation/types` | `ProcessOutcome`, `VolcanoBatchOutcome`, `PresentationEvent` |
| `../filter-template/pipeline` | `shouldDisplay`, `renderTemplate`, `FilterTemplatePipeline` |
| `chalk` | dim 表示 |

**注:** `ui/` への直接 import は一切ない。表示は `DisplayCallbacks` 経由で行う。

### 設計ノート

- ファクトリ関数パターンを採用し、`EewTracker` 等の状態をクロージャに閉じ込めることで、テスト時にインスタンスを独立して生成できる。
- `eewLogger` と `notifier` を戻り値に含めるのは、REPL や monitor から設定変更するため。ルーティング関数自体は純粋なディスパッチに徹している。
- `headType.startsWith("VXSE")` によるプレフィックスマッチは、将来新しい VXSE 系電文タイプが追加された場合にも自動的に地震情報パスに入る拡張性を持つ。ただし `VXSE56`, `VXSE60`, `VXSE62` は先に個別マッチで分岐するため、意図しないルーティングにはならない。
- `DisplayCallbacks` を注入することで engine→ui の逆方向依存を解消。router は UI の実装詳細を知らない。

---

## eew/eew-tracker.ts

### 概要

複数の緊急地震速報 (EEW) イベントを `EventID` 単位で追跡し、重複報の検出・キャンセル状態管理・報間の差分計算・カラーインデックス割り当てを行うステートフルなトラッカー。

### エクスポートAPI

```ts
interface EewDiff {
  previousMagnitude?: string;
  previousDepth?: string;
  previousMaxInt?: string;
  hypocenterChange?: boolean;
}

interface EewUpdateResult {
  isNew: boolean;
  isDuplicate: boolean;
  isCancelled: boolean;
  /** VXSE45 受信済みイベントで VXSE43/44 が抑制されたか */
  isSuppressed: boolean;
  /** このイベントで初めて警報が発出されたか (非抑制の報のみ) */
  isUpgradeToWarning: boolean;
  activeCount: number;
  diff?: EewDiff;
  previousInfo?: ParsedEewInfo;
  colorIndex: number;
}

class EewTracker {
  constructor(options?: { onCleanup?: (eventId: string) => void });
  update(info: ParsedEewInfo): EewUpdateResult;
  finalizeEvent(eventId: string): void;
  getActiveCount(): number;
}
```

- `update()` — EEW 情報を受け取り、内部状態を更新して判定結果を返す。
- `finalizeEvent()` — 最終報受信後にイベントを終了扱いにする。エントリは保持するが `activeCount` からは除外する。
- `getActiveCount()` — キャンセル済み・終了済みでないアクティブイベント数を返す。

### 内部ロジック

#### 重複報の判定

同一 EventID かつ同一 `head.type`（VXSE43/44/45）内で、受信した報数が `lastSerial` 以下であれば重複と判定する。異なる type 間ではシリアル番号は独立管理される。取消報は報数に関わらず重複としない。EventID が空の場合は常に新規扱い。

#### VXSE45 優先と VXSE43/44 抑制

`EewTracker` 単体では、`hasSeen45 === true`（VXSE45 を受信済み）のイベントに後着する VXSE43/44 を `isSuppressed: true` と判定する。ただし:

- シリアル状態 (`byType` の `lastSerial`) と `lastUpdate` は抑制時も更新する（再到着の新規扱いを防止）
- 取消報・最終報のライフサイクル処理（`closeEvent`/`finalizeEvent`）は抑制時も実行する
- `hasWarningIssued` は非抑制の報でのみ更新する（抑制された警報で昇格フラグを消費しない）

ただし `processEew()` は VXSE44 を tracker 更新前に常時抑制する。VXSE44 は EventID の受信状況にかかわらず表示・通知・統計に進まず、取消報・最終報の場合だけ `EewEventLogger` と `EewTracker.finalizeEvent()` による終端処理を直接行う。したがって、実際の表示経路で VXSE45 未受信時にも表示されうるのは VXSE43 のみである。

#### 警報昇格判定

イベント単位の `hasWarningIssued` フラグで判定する。`!isSuppressed && !hasWarningIssued && info.isWarning` の場合に `isUpgradeToWarning: true` を返す。`hasWarningIssued` は非抑制の報でのみ OR 累積で更新される。

#### 差分計算 (`computeDiff`)

前回の `ParsedEewInfo` と今回の情報を比較し、以下の変化を検出する:

- **マグニチュード** — 数値パース後に比較
- **深さ** — `parseDepthKm()` で km 数値を抽出して比較
- **最大予測震度** — `getMaxForecastIntensity()` で全地域の最大値を求めて比較（配列順に依存しない）
- **震源地名** — 文字列比較

いずれかに変化があれば `EewDiff` を返す。変化なしなら `undefined`。

#### カラーインデックス

同時並行する複数 EEW イベントを視覚的に区別するため、アクティブ（未キャンセル・未終了）イベントが使用していない最小インデックスを割り当てる。`nextColorIndex()` が呼ばれるたびに未使用の最小 index を返す。

#### 自動クリーンアップ

`update()` 呼び出し時に `cleanup()` を実行し、最終更新から10分（`CLEANUP_THRESHOLD_MS = 600000`）以上経過したイベントを Map から削除する。削除時に `onCleanup` コールバックが呼ばれ、対応する EEW ログの自動クローズに使われる。

#### 内部型

```ts
/** head.type 別のシリアル状態 */
interface EewTypeState {
  lastSerial: number;
  previousInfo?: ParsedEewInfo;
}

interface EewEvent {
  eventId: string;
  /** head.type (VXSE43/44/45) 別のシリアル・前回情報 */
  byType: Map<string, EewTypeState>;
  /** VXSE45 を受信済みか (true → VXSE43/44 を抑制) */
  hasSeen45: boolean;
  /** このイベントで警報が発出されたか (非抑制の報でのみ更新) */
  hasWarningIssued: boolean;
  isCancelled: boolean;
  isFinalized: boolean;
  lastUpdate: Date;
  colorIndex: number;
}
```

#### 内部関数

| 関数 | 説明 |
|------|------|
| `parseDepthKm(depth)` | 深さ文字列から数値(km)を抽出 |
| `getMaxForecastIntensity(areas)` | 予測震度リストから最大震度を取得（`intensityToRank` で比較） |
| `computeDiff(prev, curr)` | 2つの EEW 情報から差分を計算 |

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../../types` | `ParsedEewInfo` |
| `../../utils/intensity` | `eewPessimisticIntensity`（予測震度範囲の悲観側を選択）、`intensityToRank`（震度文字列の順序比較） |

### 設計ノート

- `finalizeEvent()` でエントリを即座に削除しないのは、最終報の後に遅延到着した重複報を正しくスキップするため。10分後の `cleanup()` で自然消滅する。
- `hasWarningIssued` は非抑制の報でのみ論理和で更新される。抑制された VXSE43 の警報で昇格フラグを消費しないことで、後続の VXSE45 警報で正しく `isUpgradeToWarning` が発火する。
- `byType: Map<string, EewTypeState>` により、VXSE43/44/45 のシリアル番号と差分計算が type 別に独立管理される。差分は同一 type 内の連続更新でのみ計算し、type 切り替え時は diff なし。
- `Map<string, EewEvent>` による O(1) ルックアップで、同時多発地震のシナリオでもパフォーマンスを維持する。

---

## eew/eew-logger.ts

### 概要

EEW イベントごとにテキスト形式のログファイルを作成し、各報の情報を逐次追記するロガー。非同期ファイル I/O を使い、書き込み順序をイベント単位の Promise チェーンで保証する。

### エクスポートAPI

```ts
class EewEventLogger {
  constructor(logDir?: string);
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  setFields(fields: Record<EewLogField, boolean>): void;
  getFields(): Record<EewLogField, boolean>;
  toggleField(field: EewLogField): boolean;
  logReport(info: ParsedEewInfo, result: EewUpdateResult): void;
  closeEvent(eventId: string, reason: string): void;
  closeAll(): void;
  getLogDir(): string;
  flush(): Promise<void>;
}
```

| メソッド | 説明 |
|---------|------|
| `setEnabled` / `isEnabled` | ログ記録の有効/無効制御 |
| `setFields` / `getFields` / `toggleField` | 記録対象フィールドの管理 |
| `logReport` | 報の記録。新規イベントならファイル作成、既存なら追記 |
| `closeEvent` | イベント終了行を追記し、追跡から除去 |
| `closeAll` | 全アクティブイベントを「シャットダウン」理由でクローズ |
| `flush` | 全書き込み Promise の完了を待機 |
| `getLogDir` | ログディレクトリパスを返す |

### 内部ロジック

#### ファイル管理

- ログディレクトリのデフォルトは `process.cwd()/eew-logs/`。
- ファイル名: `eew_{sanitizedEventId}_{YYYYMMDD_HHmmss}.log`
- `activeFiles` Map で `eventId → filePath` を管理。
- `ensureLogDir()` でディレクトリが存在しなければ再帰的に作成。

#### 書き込み順序保証

`writeChains` Map で `eventId → Promise<void>` を管理し、同一イベントへの書き込みを直列化する。`enqueueWrite()` が前の Promise に `.then()` で連結し、競合状態を防ぐ。書き込み自体は `fs.promises.appendFile()` による非同期 I/O。書き込みエラーは `log.error()` で報告するのみで、例外はスローしない。

#### ログファイルのフォーマット

ヘッダ:
```
=== 緊急地震速報 EventID: {eventId} ===
記録開始: {localTime}
```

各報ブロック:
```
--- 第{serial}報 ({予報|警報|取消}) {HH:mm:ss} ---
震源: {hypocenterName}
  発生: {originTime}
  座標: {latitude} {longitude}
M{magnitude}  深さ{depth}
変化:  [{diff}]
震度変化理由: {label} [{code}]
最大予測震度: {topIntensity}
最大予測長周期階級: {maxLgInt}
  注記: {Lx=長周期階級, P=PLUM, A=主要動到達}
  震度{intensity}: {area1}, {area2}, ...
```

終了行:
```
--- 記録終了 ({reason}) {HH:mm:ss} ---
```

#### フィールド制御

`fields` レコードで各フィールドの出力有無を制御する。対応するフィールドの一覧:

`hypocenter`, `originTime`, `coordinates`, `magnitude`, `forecastIntensity`, `maxLgInt`, `forecastAreas`, `lgIntensity`, `isPlum`, `hasArrived`, `diff`, `maxIntChangeReason`

`originTime` と `coordinates` は `hypocenter` が無効の場合も非表示になる（親子関係）。`maxLgInt` も `forecastIntensity` が無効なら非表示。

#### 地域名への注記付与

`formatAreaName()` で地域名に `{Lx,P,A}` 形式のフラグを付与する:
- `Lx` — 長周期地震動階級
- `P` — PLUM 法による推定
- `A` — 主要動到達済み

凡例行は該当フラグが存在する場合のみ出力される（`needsAreaLegend()` で判定）。

#### EventID のサニタイズ

`sanitizeEventId()` で英数字・ハイフン・アンダースコア以外を `_` に置換し、64文字に切り詰める。パストラバーサル防止。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `fs`, `path` | ファイル I/O |
| `../../types` | `ParsedEewInfo`, `EewLogField` |
| `./eew-tracker` | `EewDiff`, `EewUpdateResult` |
| `../../logger` | ログ出力 |

### 設計ノート

- Promise チェーンによる書き込み直列化は、ロックファイルやキューイングライブラリを使わない軽量な実装。同一イベントへの書き込み順序のみ保証し、異なるイベント間は並行して書き込む。
- `flush()` はシャットダウン時とテスト時に使用。失敗は呼び出し側で無視される（`monitor/shutdown.ts` の `catch {}`）。
- ログフォーマットはプレーンテキストで、JSON ではない。人間が直接読むことを重視した設計。

---

## notification/notifier.ts

### 概要

デスクトップ通知と通知音の発報を管理するクラス。電文タイプ別の通知メソッドを持ち、カテゴリ別の ON/OFF・一時ミュート・通知音の有効/無効を制御する。カテゴリが OFF でも soundLevel が `critical` の通知は発報するが、`cancel` は貫通対象外である。設定変更時は自動的に Config ファイルへ永続化する。

### エクスポートAPI

```ts
const NOTIFY_CATEGORY_LABELS: Record<NotifyCategory, string>

class Notifier {
  constructor();
  mute(durationMs: number): void;
  unmute(): void;
  isMuted(): boolean;
  muteRemaining(): number;
  toggleCategory(cat: NotifyCategory): boolean;
  setAll(enabled: boolean): void;
  getSettings(): NotifySettings;
  getSoundEnabled(): boolean;
  setSoundEnabled(enabled: boolean): void;
  notifyEew(info: ParsedEewInfo, result: EewUpdateResult): void;
  notifyEarthquake(info: ParsedEarthquakeInfo): void;
  notifyTsunami(info: ParsedTsunamiInfo): void;
  notifySeismicText(info: ParsedSeismicTextInfo): void;
  notifyNankaiTrough(info: ParsedNankaiTroughInfo): void;
  notifyLgObservation(info: ParsedLgObservationInfo): void;
  notifyVolcano(info: ParsedVolcanoInfo, presentation: VolcanoPresentation): void;
  notifyVolcanoBatch(batch: { items: { volcanoName: string }[] }, presentation: VolcanoPresentation): void;
  notifyWeatherWarning(info: ParsedWeatherWarning, soundLevelOverride?: SoundLevel): void;
  notifyTornadoAdvisory(info: ParsedTornadoAdvisory, soundLevelOverride?: SoundLevel): void;
  notifyWeatherBriefing(info: ParsedWeatherBriefing, soundLevelOverride?: SoundLevel): void;
  notifyEarlyWeather(info: ParsedEarlyWeatherInfo): void;
  notifyWeatherWarningTimeseries(info: ParsedWeatherWarningTimeseriesInfo): void;
  notifyClimateInfo(info: ParsedClimateInfo): void;
  notifyWeatherExplanation(info: ParsedWeatherExplanation): void;
  notifyHeatAlert(info: ParsedHeatAlertInfo, soundLevelOverride?: SoundLevel): void;
}
```

#### 定数

| 定数 | 説明 |
|------|------|
| `NOTIFY_CATEGORY_LABELS` | 通知カテゴリ（`eew`, `earthquake`, `tsunami`, `seismicText`, `nankaiTrough`, `lgObservation`, `volcano`, `weather`, `tornado`, `briefing`, `earlyWeather`, `weatherWarningTimeseries`, `climateInfo`, `weatherExplanation`, `heatAlert`）と日本語ラベルの対応（15カテゴリ）。`climateInfo` のラベルは VPZI50/VPCI50 共通の総称「天候情報」 |

#### ミュート制御

| メソッド | 説明 |
|---------|------|
| `mute(durationMs)` | 指定ミリ秒間、全通知をミュート |
| `unmute()` | ミュートを即時解除 |
| `isMuted()` | ミュート中か判定（期限切れなら自動解除） |
| `muteRemaining()` | ミュート残り時間 (ms)。非ミュート時は `0` |

#### 設定管理

| メソッド | 説明 |
|---------|------|
| `toggleCategory(cat)` | カテゴリの ON/OFF を切り替え、新しい状態を返す。永続化する |
| `setAll(enabled)` | 全カテゴリを一括 ON/OFF。永続化する |
| `getSettings()` | 現在の `NotifySettings` のコピーを返す |
| `getSoundEnabled()` / `setSoundEnabled(enabled)` | 通知音の有効/無効を管理。永続化する |

### 内部ロジック

#### EEW 通知の発火条件

`notifyEew()` は以下のいずれかの場合のみ通知を送信する:

- 第1報（**eventId 単位で Notifier から見て初回の通知**。`info.eventId` が `null` の場合は `result.isNew` にフォールバック）
- 警報昇格（`result.isUpgradeToWarning === true`、イベント単位で非抑制の初回警報）
- 取消報（`result.isCancelled === true`）
- 最終報（`info.nextAdvisory != null`）

抑制された報（`result.isSuppressed === true`）は通知しない。続報は通知を送らず、ターミナル表示のみ行う設計。

##### eventId 単位の初回通知判定

第1報の判定は EewTracker の `result.isNew` ではなく、Notifier 自身が保持する `notifiedEewEventIds: Map<eventId, timestamp>` で行う。これは「上流（`processEew` / VXSE43/44/45 の到着順や抑制ロジック）の挙動変更で `isNew` が `false` になっても、第1報通知の発火を取りこぼさない」ための安全網。

- 通知発火時に `eventId` を Map に記録（タイムスタンプは cleanup 用）
- 10 分 TTL で古いエントリを cleanup（EewTracker の `CLEANUP_THRESHOLD_MS` と整合）
- 取消通知時は `eventId` を Map から削除し、同一 `eventId` の再発に対して再度初回扱いとする

なお、過去 `2f0907e` で `VXSE44` が `eewTracker.update()` を経由してしまい、続く `VXSE45` 第1報が `isNew=false` となって通知音が発火しないバグがあった（VXSE44 の早期 return で修正済）。本安全網は同種のバグへの再発防止策。

#### サウンドレベル判定

各電文タイプで `SoundLevel`（`"critical"` / `"warning"` / `"normal"` / `"info"` / `"cancel"`）を判定する:

| 電文タイプ | 判定ロジック |
|-----------|-------------|
| EEW | 警報→`critical`、予報→`warning`、取消→`cancel` |
| 地震情報 | 最大震度4以上→`warning`、その他→`normal` |
| 津波情報 | 津波に関する警報・注意報含む→`critical`、解除のみ→`warning`、その他→`normal` |
| 長周期地震動 | 階級3-4→`critical`、階級1-2→`warning`、その他→`normal` |
| テキスト情報 | 常に `info` |
| 南海トラフ | 常に `warning` |

#### node-notifier の遅延ロード

`getNotifier()` で初回呼び出し時にのみ `nodeNotifierLoader.loadNodeNotifier()` を実行する。読み込み失敗時は `null` を返し、以降の通知はサイレントに失敗する。

#### 通知送信

`send(title, message, category, level?)` が以下を行う:

1. `dispatchNotify` と各通知メソッドの内容由来の抑制判定後に呼ばれる
2. カテゴリが OFF の場合は return。ただし `level === "critical"` は全カテゴリ共通で通過する（`cancel` は通過しない）
3. ミュート中なら即座に return
4. `node-notifier` でデスクトップ通知を送信（`sound: false`、通知音は別途制御）
5. `assets/icons/icon.png` が存在すればアイコンとして使用
6. `soundEnabled` かつ `level` 指定があれば `playSound(level)` を呼び出し
7. 通知送信エラーはデバッグログのみ

#### 内部メソッド

| メソッド | 説明 |
|---------|------|
| `earthquakeSoundLevel(info)` | 地震情報のサウンドレベルを判定 (震度4以上→`warning`、他→`normal`) |
| `tsunamiSoundLevel(info)` | 津波情報のサウンドレベルを判定 (警報・注意報含む→`critical`、解除のみ→`warning`、他→`normal`) |
| `lgObservationSoundLevel(info)` | 長周期地震動のサウンドレベルを判定 (階級3-4→`critical`、階級1-2→`warning`、他→`normal`) |
| `findMaxForecastInt(info)` | EEW の予測震度地域リストから最大予測震度を `intensityToRank()` で比較して返す。地域がない場合は `"不明"` |

#### 設定の永続化

`persist()` は `loadConfig()` → 設定上書き → `saveConfig()` の流れで Config ファイルに書き込む。`notify` と `sound` を同時に永続化する。エラー時は `log.warn()` のみ。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `path`, `fs` | アイコンパス解決・存在確認 |
| `../../types` | `NotifyCategory`, `NotifySettings`, 各種パース済み型, `DEFAULT_CONFIG` |
| `../../config` | `loadConfig`, `saveConfig` |
| `../eew/eew-tracker` | `EewUpdateResult` |
| `./sound-player` | `playSound`, `SoundLevel` |
| `./node-notifier-loader` | `loadNodeNotifier`, `NodeNotifierLike` |
| `../../utils/intensity` | `intensityToRank` |
| `../../logger` | ログ出力 |

### 設計ノート

- `node-notifier` の遅延ロードは、ライブラリが存在しない環境（minimal インストール等）でもアプリが起動できるようにするため。
- ミュート機構は時刻ベースで実装されており、タイマーは使わない。`isMuted()` 呼び出し時に期限切れを検出して自動解除するため、メモリリークの心配がない。
- 通知音の制御は `sound: false` で node-notifier のネイティブ音を無効化し、`playSound()` で独自にレベル別の音を鳴らす二段構え。

---

## startup/update-checker.ts

### 概要

npm registry から最新バージョンを取得し、現在のバージョンより新しければコンソールに通知するユーティリティ。起動をブロックしないよう完全に非同期で動作し、エラーは全て黙って無視する。24時間キャッシュで registry へのアクセス頻度を抑制する。

### エクスポートAPI

```ts
function isUpdateCheckDisabled(env?: NodeJS.ProcessEnv): boolean
function isNewerVersion(current: string, latest: string): boolean
function checkForUpdates(packageName: string, currentVersion: string): void
```

| 関数 | 説明 |
|------|------|
| `isUpdateCheckDisabled` | 環境変数 `FLEQ_NO_UPDATE_CHECK` が `1`/`true`/`yes`/`on` なら `true` |
| `isNewerVersion` | semver 比較。`latest` が `current` より新しければ `true`。不正形式は `false` |
| `checkForUpdates` | 非同期で更新チェックを実行し、新バージョンがあればコンソール通知。戻り値は `void`（Promise を返さない） |

### 内部ロジック

#### キャッシュ機構

キャッシュファイルは Config ディレクトリ（`getConfigDir()` が返すパス）に `.update-check` として保存される。

```ts
interface UpdateCheckCache {
  lastCheck: number;      // Unix timestamp (ms)
  latestVersion: string;  // 最新バージョン文字列
}
```

- `readCache()` — ファイル読み込み・JSON パース・型チェック。不正ならnull。
- `writeCache()` — JSON 形式で書き込み。ディレクトリ未作成なら `mode: 0o700` で作成。
- チェック間隔: 24時間（`CHECK_INTERVAL_MS = 86400000`）。キャッシュが有効期間内ならキャッシュの値で判定し、registry にはアクセスしない。

#### npm registry へのアクセス

`fetchLatestVersion()` が `https://registry.npmjs.org/{packageName}/latest` へ GET リクエストを送信する。

- タイムアウト: 3秒（`REQUEST_TIMEOUT_MS`）
- レスポンスの `version` フィールドを抽出
- HTTP エラー・タイムアウト・パースエラーは reject

#### バージョン比較

`normalizeVersion()` で `v` プレフィックスを除去し `[major, minor, patch]` タプルに変換。`isNewerVersion()` で major → minor → patch の順に比較。

#### `checkForUpdates` のフロー

1. `isUpdateCheckDisabled()` なら即 return
2. キャッシュが有効（24時間以内）ならキャッシュのバージョンで判定、通知して return
3. `fetchLatestVersion()` を fire-and-forget で呼び出し:
   - 成功: キャッシュ更新 → 新バージョンなら通知
   - 失敗: デバッグログのみ

`checkForUpdates` は Promise を返さない（`.then().catch()` で内部処理）ため、呼び出し元をブロックしない。

#### 通知表示

```
[WARN] Update available: v{current} → v{latest}  npm install -g {packageName}@latest
```

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `https` | npm registry への HTTPS リクエスト |
| `fs`, `path` | キャッシュファイルの読み書き |
| `chalk` | 通知メッセージの色付け |
| `../../logger` | ログ出力 |
| `../../config` | `getConfigDir`（キャッシュ保存先） |

### 設計ノート

- 外部ライブラリ（`update-notifier` 等）を使わず Node.js 標準の `https` モジュールで実装し、依存を最小化している。
- `checkForUpdates` が void を返す設計は意図的。起動フローをブロックしないことが最優先であり、更新通知は best-effort。
- キャッシュの書き込み失敗もサイレントに処理し、次回起動時に再チェックする設計。
- `isNewerVersion` と `isUpdateCheckDisabled` を export しているのはテスト容易性のため。

---

## notification/node-notifier-loader.ts

### 概要

`node-notifier` パッケージの遅延ロードとテスト時のオーバーライドを提供するユーティリティモジュール。`notifier.ts` が直接 `require("node-notifier")` せず、このモジュール経由でアクセスすることで、テスト時にモックを差し込みやすくしている。

### エクスポートAPI

```ts
type NodeNotifierLike = Pick<typeof NodeNotifier, "notify">

function setNodeNotifierOverride(notifier: NodeNotifierLike | null | undefined): void
function loadNodeNotifier(): NodeNotifierLike | null
```

| シグネチャ | 説明 |
|---|---|
| `NodeNotifierLike` | `node-notifier` の `notify` メソッドのみを持つ型 |
| `setNodeNotifierOverride(notifier)` | テスト用のオーバーライドを設定する。`undefined` でリセット |
| `loadNodeNotifier()` | オーバーライドが設定されていればそれを返し、なければ `require("node-notifier")` で動的ロードする。読み込み失敗時は `null` |

### 内部ロジック

- `nodeNotifierOverride` モジュール変数でオーバーライドを保持する。`undefined`（未設定）と `null`（明示的に無効化）を区別する。
- `loadNodeNotifier()` はオーバーライドが `undefined` でない場合はオーバーライド値をそのまま返す（`null` 含む）。`undefined` の場合のみ `require()` を試行する。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `node-notifier` | 型のみインポート (`import type`)。実体は `require()` で遅延ロード |

### 設計ノート

- オーバーライドパターンにより、テスト時にグローバルな `jest.mock()` や `vi.mock()` を使わずに通知モックを差し込める。
- `null` と `undefined` を区別する三値設計。`setNodeNotifierOverride(null)` で「通知を無効化」、`setNodeNotifierOverride(undefined)` で「オーバーライド解除」を表現する。

---

## notification/sound-player.ts

### 概要

通知音の再生を担うユーティリティモジュール。カスタム効果音ファイル（`assets/sounds/`）を優先的に再生し、存在しなければ OS ネイティブのシステムサウンドにフォールバックする。Windows / macOS / Linux の3プラットフォームに対応し、再生は fire-and-forget で行う。

### エクスポートAPI

```ts
const SOUND_LEVELS: readonly ["critical", "warning", "normal", "info", "cancel"]
type SoundLevel = "critical" | "warning" | "normal" | "info" | "cancel"
function isSoundLevel(value: string): value is SoundLevel
function playSound(level: SoundLevel): void
```

| シグネチャ | 説明 |
|---|---|
| `SOUND_LEVELS` | 有効なサウンドレベルのタプル定数。`SoundLevel` 型の導出元 |
| `SoundLevel` | 通知音レベルの型 (`"critical"` / `"warning"` / `"normal"` / `"info"` / `"cancel"`) |
| `isSoundLevel(value)` | 文字列が有効な `SoundLevel` かを判定する型ガード |
| `playSound(level)` | 指定レベルの通知音を再生する。エラーはデバッグログのみで例外をスローしない |

### 内部ロジック

#### カスタム効果音

`assets/sounds/` ディレクトリに `{level}.mp3` または `{level}.wav` を配置すると、システムサウンドより優先して再生される。`findCustomSound()` が `.mp3` → `.wav` の優先順で探索する。

#### プラットフォーム別再生

| プラットフォーム | カスタム音 | システムサウンド |
|---|---|---|
| Windows | PowerShell + WPF `MediaPlayer` (mp3/wav 対応) | PowerShell + `SoundPlayer` (`%SYSTEMROOT%\Media\*.wav`) |
| macOS | `afplay` コマンド | `afplay` (`/System/Library/Sounds/*.aiff`) |
| Linux | mp3: `ffplay`、wav: `paplay` → `aplay` フォールバック | `canberra-gtk-play` → BEL 文字フォールバック |

#### システムサウンドマッピング

| レベル | Windows | macOS | Linux (canberra) |
|---|---|---|---|
| `critical` | Windows Critical Stop.wav | Sosumi.aiff | dialog-error |
| `warning` | Windows Exclamation.wav | Basso.aiff | dialog-warning |
| `normal` | Windows Notify Calendar.wav | Glass.aiff | message-new-instant |
| `info` | Windows Notify Email.wav | Tink.aiff | dialog-information |
| `cancel` | Windows Recycle.wav | Pop.aiff | bell (BEL 文字) |

#### BEL 文字フォールバック

Linux で canberra-gtk-play が使えない場合、`\x07` (BEL) を stdout に書き込んでターミナルベルを鳴らす。`cancel` レベルは canberra を経由せず直接 BEL にフォールバックする。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `child_process` | `execFile`, `exec` — 外部コマンドによるサウンド再生 |
| `fs`, `path` | カスタム効果音ファイルの探索 |
| `../../logger` | デバッグログ出力 |

### 設計ノート

- 全再生関数はコールバックベースで非同期実行し、Promise を返さない fire-and-forget 設計。通知音の再生失敗がアプリケーションの動作に影響しない。
- Windows ではカスタム音に WPF `MediaPlayer` (mp3 対応)、システム音に WinForms `SoundPlayer` (wav のみ) を使い分けている。
- `SOUND_LEVELS` を `as const` タプルとし、`SoundLevel` 型を `typeof SOUND_LEVELS[number]` で導出することで、定数と型の一貫性を保証している。

---

## startup/tsunami-initializer.ts

### 概要

起動時に dmdata.jp REST API から最新の VTSE41 電文を取得し、津波警報状態 (`TsunamiStateHolder`) を復元する。WebSocket 接続が確立される前に実行され、接続前に発表済みの津波警報をプロンプトに表示できるようにする。

エラー発生時は警告ログのみ出力し、アプリケーションの起動を妨げない設計。

### エクスポート API

#### `restoreTsunamiState(apiKey: string, tsunamiState: TsunamiStateHolder): Promise<ParsedTsunamiInfo | null>`

最新の VTSE41 電文を `GET /v2/telegram?type=VTSE41&limit=1&formatMode=raw` で取得し、パース後に `tsunamiState.update()` を呼ぶ。

- 警報状態が復元された場合: パース済みの `ParsedTsunamiInfo` を返す
- 警報なし（取消報、津波予報のみ、電文なし）の場合: `null` を返す
- API エラー・パースエラー: `null` を返し、例外は throw しない

内部で `TelegramListItem` を `WsDataMessage` 互換オブジェクトに変換し、既存の `parseTsunamiTelegram()` をそのまま利用する。

### 依存関係

- **インポート元**: `../../types` (`ParsedTsunamiInfo`), `../../dmdata/rest-client` (`listTelegrams`), `../../dmdata/telegram-parser` (`parseTsunamiTelegram`), `../messages/tsunami-state` (`TsunamiStateHolder`), `./telegram-adapter` (`toWsDataMessage`), `../../logger`
- **接続先**: `engine/monitor/monitor.ts` の `startMonitor()` から WebSocket 接続前に呼ばれる

### 設計ノート

- `TelegramListItem` → `WsDataMessage` 変換は `startup/telegram-adapter.ts` の共有 `toWsDataMessage()` で行う (volcano-initializer と共用)。`type: "data"`, `version: "2.0"`, `passing: []` を補完する。
- VTSE41 が取消報の場合は `tsunamiState.update()` 内部で `clear()` されるため、呼び出し側で判定する必要がない。
- REST API 呼び出しは起動時の 1 回のみ。以降は WebSocket 経由のリアルタイム更新に任せる。

---

## startup/volcano-initializer.ts

### 概要

起動時に dmdata.jp REST API から直近の VFVO50 電文履歴 (窓 = 100 件) を取得し、古い順に replay して火山警報状態 (`VolcanoStateHolder`) を復元する。WebSocket 接続が確立される前に実行され、接続前に発表済みの複数火山の警報をプロンプトに表示できるようにする。

エラー発生時は警告ログのみ出力し、アプリケーションの起動を妨げない設計。

### エクスポート API

#### `restoreVolcanoState(apiKey: string, volcanoState: VolcanoStateHolder): Promise<void>`

直近の VFVO50 電文を `GET /v2/telegram?type=VFVO50&limit=100&formatMode=raw` (`VOLCANO_RESTORE_WINDOW = 100`) で取得し、`head.time` 昇順の安定ソート後に 1 件ずつ `volcanoState.update()` へ replay する。解除・取消・レベル1 復帰の削除は `update()` の既存分岐が replay 中に自然に適用されるため、復元専用の状態判定ロジックは持たない。

- 個別電文の body 欠落・パース失敗: デバッグログを出して skip し、残りの replay を続行
- 警報状態が復元された場合: ログ出力 (`火山警報状態を復元しました (N 火山 / M 電文を replay)`)
- 警報なし（解除・平常・電文なし）の場合: デバッグログのみ
- API エラー: 警告ログを出力し、例外は throw しない
- 既知の制約: 窓 (直近 100 件) より古い長期継続警報は復元されない (見逃し側の fail。詳細は設計文書の復元方針表を参照)

内部で `TelegramListItem` を `WsDataMessage` 互換オブジェクトに変換し、既存の `parseVolcanoTelegram()` をそのまま利用する。

### 依存関係

- **インポート元**: `../../dmdata/rest-client` (`listTelegrams`), `../../dmdata/volcano-parser` (`parseVolcanoTelegram`), `../messages/volcano-state` (`VolcanoStateHolder`), `./telegram-adapter` (`toWsDataMessage`), `../../logger`
- **接続先**: `engine/monitor/monitor.ts` の `startMonitor()` から WebSocket 接続前に呼ばれる (津波状態復元の直後)

### 設計ノート

- `TelegramListItem` → `WsDataMessage` 変換は `startup/telegram-adapter.ts` の共有 `toWsDataMessage()` で行う (tsunami-initializer と共用)。`type: "data"`, `version: "2.0"`, `passing: []` を補完する。
- `volcanoState.update()` は `kind === "alert"` かつ `volcanoCode` が非空の場合のみ状態を更新するため、呼び出し側でのフィルタリングは不要。
- REST API 呼び出しは起動時の 1 回のみ。以降は WebSocket 経由のリアルタイム更新に任せる。

---

## startup/config-resolver.ts

### 概要

CLI 引数 → 環境変数 → .env → Config ファイル → デフォルト値の4層優先順位に従って設定を解決し、`AppConfig` を構築するモジュール。`cli-run.ts` から設定解決ロジックを抽出し、単一責務化したもの。

### エクスポートAPI

```ts
interface ResolverOptions {
  apiKey?: string;
  classifications?: string;
  test?: string;
  keepExisting?: boolean;
  closeOthers?: boolean;
  mode?: string;
}

function resolveConfig(opts: ResolverOptions): AppConfig
```

- `ResolverOptions` — CLI オプションのうち設定解決に必要なフィールド。`RunMonitorOptions` から `debug` を除いたサブセット。
- `resolveConfig` — 設定を解決して `AppConfig` を返す。致命的なバリデーションエラー (API キー未設定、有効な区分なし、無効なテストモード/表示モード) 時は `process.exit(1)` する。

### 内部ロジック

#### 優先順位解決

| 設定項目 | CLI引数 | 環境変数 | Configファイル | デフォルト |
|---------|---------|---------|---------------|-----------|
| apiKey | `opts.apiKey` | `DMDATA_API_KEY` | `fileConfig.apiKey` | なし (必須) |
| classifications | `opts.classifications` (カンマ区切り) | — | `fileConfig.classifications` | `DEFAULT_CONFIG.classifications` |
| testMode | `opts.test` | — | `fileConfig.testMode` | `DEFAULT_CONFIG.testMode` |
| displayMode | `opts.mode` | — | `fileConfig.displayMode` | `DEFAULT_CONFIG.displayMode` |
| keepExistingConnections | `opts.keepExisting` / `opts.closeOthers` | — | `fileConfig.keepExistingConnections` | `DEFAULT_CONFIG.keepExistingConnections` |

#### バリデーション

- `classifications` の各トークンを `VALID_CLASSIFICATIONS` と照合し、不正な値は警告ログで通知して除外する。有効な区分が0件の場合は `process.exit(1)`。
- `testMode` は `"no"` / `"including"` / `"only"` のみ許可。
- `displayMode` は `"normal"` / `"compact"` のみ許可。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../../types` | `AppConfig`, `Classification`, `ConfigFile`, `DEFAULT_CONFIG` |
| `../../config` | `loadConfig`, `getConfigPath`, `VALID_CLASSIFICATIONS` |
| `../../logger` | ログ出力 |
| `chalk` | エラーメッセージの色付け |

### 設計ノート

- `process.exit(1)` を内包しているため、単体テスト時は `process.exit` のモックが必要。将来的に `ConfigResolutionError` を throw する形に変更してテスタビリティを向上させることも検討可能。
- `closeOthers` フラグは `keepExistingConnections` の否定形として処理される。両フラグが同時指定された場合、`closeOthers` が優先される。

---

## monitor/shutdown.ts

### 概要

グレースフルシャットダウンの処理を `monitor.ts` から分離したモジュール。シャットダウンハンドラの生成とシグナル登録を担う。

### エクスポートAPI

```ts
interface ShutdownContext {
  apiKey: string;
  manager: ConnectionManager;
  eewLogger: EewEventLogger;
  getReplHandler: () => ReplHandlerType | null;
  resetTerminalTitle: () => void;
  flushAndDisposeVolcanoBuffer?: () => void;
  stopSummaryTimer?: () => void;
  stopDisplayRuntime?: () => Promise<void>;
  stopStandbySweep?: () => void;
  flushDetailCaches?: () => void;
  flushWeatherPromotion?: () => void;
}

function createShutdownHandler(ctx: ShutdownContext): () => Promise<void>
function registerShutdownSignals(shutdown: () => Promise<void>): void
```

- `ShutdownContext` — シャットダウンに必要な依存をまとめたインターフェース。`manager` は `ConnectionManager` インターフェース型（`MultiConnectionManager` の基底）。`resetTerminalTitle` はコールバック注入で CLI 層への逆依存を回避。`stopSummaryTimer` は定期要約タイマーの停止コールバック。
- 末尾 4 つは monitor 所有の状態を書き切るためのフック。`stopDisplayRuntime` は SSE クライアント切断 + HTTP サーバ close、`stopStandbySweep` は standby sweep の停止と active-state の最終保存、`flushDetailCaches` は VPWP50 詳細 cache、`flushWeatherPromotion` は気象警報の昇格 lifecycle を書き切る。
- `createShutdownHandler` — 冪等なシャットダウン関数を生成する。内部フラグで二重実行を防止。
- `registerShutdownSignals` — `SIGINT`, `SIGTERM` (+ 非 Windows では `SIGHUP`) にシャットダウンハンドラを登録する。

### 内部ロジック

シャットダウン時の処理順序:
1. 定期要約タイマーの停止 (`stopSummaryTimer()`)
2. VFVO53 バッファの flush + タイマー破棄 (`flushAndDisposeVolcanoBuffer()`)
3. EEW ログの全イベントをクローズ (`eewLogger.closeAll()`)
4. EEW ログのフラッシュ (失敗は無視)
5. 情報ディスプレイ runtime の停止 (`stopDisplayRuntime()`、失敗はシャットダウンを妨げない)
6. standby sweep の停止 + active-state の最終保存 (`stopStandbySweep()`)
7. VPWP50 詳細 cache の書き切り (`flushDetailCaches()`)
8. 気象警報の昇格 lifecycle の書き切り (`flushWeatherPromotion()`)
9. REPL の停止
10. API 経由でソケットをクローズ (3秒タイムアウト、失敗は無視。`MultiConnectionManager` の場合は全ソケットを並列クローズ)
11. `ConnectionManager.close()` でローカル WebSocket 切断
12. ターミナルタイトルのリセット
13. `process.exit(0)`

5 が 6 より先なのは、`controller.stop()` が display off 用の standby sweep を再開するため。再開後に確実に停止・最終保存する順序にしている。永続化フック (6〜8) はいずれも「予約を捨ててから現在状態を同期で書く」形で、debounce 待ちの予約より現在状態の方が新しいことを前提にする。

`closeSocketViaApi` は内部関数で、`Promise.race` によるタイムアウト制御を行う。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../../dmdata/connection-manager` | `ConnectionManager` 型 |
| `../../dmdata/rest-client` | `closeSocket` API 呼び出し |
| `../eew/eew-logger` | `EewEventLogger` 型 |
| `../../ui/repl` | `ReplHandler` 型 (type import) |
| `../../logger` | ログ出力 |

### 設計ノート

- `resetTerminalTitle` を `ShutdownContext` のコールバックとして注入することで、`shutdown.ts` から `cli/cli-run.ts` への直接依存を排除している。依存の流れは `monitor.ts` → `shutdown.ts` の一方向のみ。
- `getReplHandler` をコールバックにしているのは、REPL ハンドラが遅延ロードされ、シャットダウンハンドラ生成時点では未初期化のため。

---

## monitor/repl-coordinator.ts

### 概要

REPL の表示状態と接続状態の協調制御を `monitor.ts` から分離したモジュール。電文表示時のプロンプト割り込み防止と、接続状態変更時のプロンプト再描画を担う。

### エクスポートAPI

```ts
function withReplDisplay(repl: ReplHandlerType | null, action: () => void): void
function updateReplConnectionState(repl: ReplHandlerType | null, connected: boolean): void
```

- `withReplDisplay` — `beforeDisplayMessage()` / `afterDisplayMessage()` で action を囲み、電文表示中のプロンプト干渉を防ぐ。例外発生時はエラーログを出力し、`afterDisplayMessage()` は `finally` で保証される。
- `updateReplConnectionState` — REPL の接続状態を更新し、プロンプトを再描画する。`repl` が `null` の場合は何もしない。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../../ui/repl` | `ReplHandler` 型 (type import) |
| `../../logger` | エラーログ出力 |

### 設計ノート

- 両関数とも `repl` が `null` の場合を安全に処理する。REPL が未初期化の状態でも呼び出し可能。
- `withReplDisplay` は例外を握りつぶしてログに記録する設計。電文処理のエラーがアプリケーション全体をクラッシュさせないためのガード。

---

## messages/tsunami-state.ts

### 概要

津波警報の状態を保持し、REPL プロンプトへの警報レベル表示と `detail` コマンドによる詳細表示を提供するモジュール。`PromptStatusProvider` と `DetailProvider` の両インターフェースを実装する。

### エクスポートAPI

```ts
function detectTsunamiAlertLevel(kinds: string[]): TsunamiAlertLevel | null

class TsunamiStateHolder implements PromptStatusProvider, DetailProvider<"tsunami"> {
  readonly category: "tsunami";
  readonly emptyMessage: string;
  getLevel(): TsunamiAlertLevel | null;
  update(info: ParsedTsunamiInfo): void;
  clear(): void;
  getPromptStatus(): PromptStatusSegment | null;
  getDetail(): DetailSnapshotOf<"tsunami"> | null;
}
```

- `detectTsunamiAlertLevel` — forecast の kind 一覧から最大警報レベル (大津波警報 > 津波警報 > 津波注意報) を判定する。該当なしの場合は `null`。
- `TsunamiStateHolder` — VTSE41 (津波警報・注意報) の状態を管理するクラス。

### 内部ロジック

#### 状態更新 (`update`)

- 取消報 (`infoType === "取消"`) → 状態クリア
- 警報レベルなし (津波予報のみ) → 状態クリア
- 警報レベルあり → `currentLevel` と `lastInfo` を更新

#### プロンプト表示 (`getPromptStatus`)

警報レベルの raw text と専用テーマロール (`tsunamiMajor` / `tsunamiWarning` / `tsunamiAdvisory`) を返す。色付けは REPL が UI 境界で適用する。`priority: 10` で他のステータスより高優先度。

#### 詳細スナップショット (`getDetail`)

保持中の `ParsedTsunamiInfo` を `{ kind: "tsunami", info }` として返す。状態がなければ `null`。holder 自身は描画を行わない。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../../types` | `ParsedTsunamiInfo`, `PromptStatusProvider`, `PromptStatusSegment`, `PromptStatusRole`, `DetailProvider`, `DetailSnapshotOf` |
| `../../utils/tsunami-kind` | 最大警報レベルの解決 |

### 設計ノート

- `PromptStatusProvider` と `DetailProvider` の両方を実装することで、プロンプト表示と detail コマンドの両方に対応。`message-router.ts` で `createMessageHandler()` の戻り値として公開される。
- 警報レベルの優先度は `LEVEL_PRIORITY` 定数で管理し、最大優先度のレベルを採用する。

---

## messages/volcano-vfvo53-aggregator.ts

### 概要

VFVO53（降灰予報・定時）をバッファリングし、複数火山分をまとめて1フレームとして表示・通知するための集約モジュール。定時で一斉に届く複数火山の VFVO53 が個別に処理されることによる通知音連発・ログ大量出力を防ぐ。

### エクスポートAPI

```ts
interface Vfvo53BatchItems {
  reportDateTime: string;
  isTest: boolean;
  items: ParsedVolcanoAshfallInfo[];
}

interface FlushOptions {
  notify: boolean;
}

class VolcanoVfvo53Aggregator {
  constructor(
    emitSingle: (info: ParsedVolcanoInfo) => void,
    emitBatch: (batch: Vfvo53BatchItems, opts: FlushOptions) => void,
    opts?: { quietMs?: number; maxWaitMs?: number; maxItems?: number },
  );
  handle(info: ParsedVolcanoInfo): void;
  flushAndDispose(): void;
}
```

### バッファリング戦略

| パラメータ | デフォルト値 | 説明 |
|-----------|-------------|------|
| `quietMs` | 8000ms | 電文到着が途切れてからの待機時間 |
| `maxWaitMs` | 90000ms | 最初の電文到着からの最大待機時間 |
| `maxItems` | 20 | バッファ内の最大火山数 |

- **バッチキー**: `reportDateTime + isTest` で同一発表サイクルをグルーピング
- 到着が続く間は `quietMs` でタイマーリセット（ただし `maxWaitMs` を超えない）
- 同一火山は `volcanoCode` で上書き保持（訂正/重複対応）
- flush reason をデバッグログに出力

### 電文種別ごとの処理

| 電文 | 処理 |
|------|------|
| VFVO53 定時（取消以外） | バッファリング |
| VFVO53 取消 | 即時 `emitSingle` + バッファから同 `volcanoCode` を除去 |
| その他の火山電文 | pending バッファを `notify: false` で flush → `emitSingle` |

### flush 条件

- `quiet`: quiet window 満了
- `maxWait`: 最大待機時間到達
- `maxItems`: バッファ上限到達（即時）
- `interrupt`: 非 VFVO53 電文の割り込み（`notify: false`）
- `newBatchKey`: バッチキー不一致
- `dispose`: `flushAndDispose()` 呼び出し

### 設計ノート

- 単発（1件のみ）の場合は `emitSingle` にフォールバックし、既存の単発表示を維持
- `flushAndDispose()` で flush + タイマー破棄。シャットダウン時に monitor → shutdown 経由で呼ばれる
- dispose 後は全電文を `emitSingle` に直接委譲（バッファリングしない）
- コンストラクタ引数でタイマー値を上書き可能（テスト用）

---

## messages/volcano-state.ts

### 概要

火山警報の状態を保持し、複数火山の同時追跡に対応するモジュール。`PromptStatusProvider` と `DetailProvider` の両インターフェースを実装する。火山コード (`volcanoCode`) をキーとする Map で各火山のアラートエントリを管理し、再通知判定にも利用される。

### エクスポートAPI

```ts
class VolcanoStateHolder implements PromptStatusProvider, DetailProvider<"volcano"> {
  readonly category: "volcano";
  readonly emptyMessage: string;
  update(info: ParsedVolcanoInfo): void;
  isRenotification(info: ParsedVolcanoAlertInfo): boolean;
  clear(): void;
  size(): number;
  getEntry(volcanoCode: string): VolcanoAlertEntry | undefined;
  getPromptStatus(): PromptStatusSegment | null;
  getDetail(): DetailSnapshotOf<"volcano"> | null;
}
```

### 内部ロジック

#### 状態更新 (`update`)

- `kind !== "alert"` → 無視（eruption, ashfall 等は状態追跡しない）
- 取消報 (`infoType === "取消"`) → エントリ削除
- 解除 (`action === "release"`) → エントリ削除
- レベル1 + 継続 → エントリ削除（通常状態に戻った）
- それ以外 → エントリを upsert

#### 再通知判定 (`isRenotification`)

既存エントリと `alertLevel`, `alertLevelCode`, `action` が全て同一の場合 `true`。`volcano-presentation.ts` がフレームレベルの初見/再通知の切り替えに使用する。

#### プロンプト表示 (`getPromptStatus`)

全エントリから最も高い `alertLevel` のエントリを選び、色付け前の `{火山名} Lv{N}` と `frameCritical` / `frameWarning` / `frameNormal` role を返す。色付けは REPL が適用する。`priority: 20`。

#### 詳細スナップショット (`getDetail`)

各エントリから火山名・警戒レベル・レベルコード・警報種別だけを射影し、`{ kind: "volcano", entries }` を返す。描画は UI formatter に委ねる。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../../types` | `ParsedVolcanoInfo`, `ParsedVolcanoAlertInfo`, `PromptStatusProvider`, `PromptStatusRole`, `DetailProvider`, `DetailSnapshotOf` |

### 設計ノート

- 津波の `TsunamiStateHolder` が単一状態を管理するのに対し、`VolcanoStateHolder` は複数火山の同時追跡を Map で実現する（同時に複数の火山が活動することが実運用であり得る）。
- `size()`, `getEntry()` はテスト専用API。

---

## messages/flood-forecast-state.ts

### 概要

指定河川洪水予報 (VXKO50-89) / 水位周知河川に関する情報 (VXSU50-59) の状態を保持し、station 単位の dedup と差分 reasons 抽出を行うモジュール。`EventID` をキーとして各 EventID のスナップショット (station digests / headline / mainItemCode / mainText) を Map で管理する。

VXSU50 (水位周知河川) は内部スキーマで分岐し、state holder への登録はスキップする (parser が `schema === "vxsu50"` を返し、processor 側で early return)。

### エクスポートAPI

```ts
interface FloodForecastDiffResult {
  /** 差分の理由配列 (空なら通知抑制候補) */
  reasons: string[];
  /** 同 EventID で前回あった station が今回消えたもの (Acceptance criteria の station 削除検知用) */
  removedStations: string[];
  /** state holder に新規登録されたか (初回受信 → true) */
  isNewEvent: boolean;
}

class FloodForecastStateHolder {
  diffAndUpdate(info: ParsedFloodForecastInfo): FloodForecastDiffResult;
  rollback(eventId: string): void;
  clear(): void;
  size(): number;
}
```

### 内部ロジック

#### `diffAndUpdate(info)`

1. EventID で既存スナップショットを引く (なければ初回 = `isNewEvent: true`)
2. `buildStationDigests(info.stations)` で station ごとのダイジェスト (`kindCode + headlineLevel + observedLevel + condition` 等) を生成
3. 既存と差分比較し、station 単位の追加/変更/削除を `reasons` / `removedStations` に展開
4. スナップショットを upsert

#### `rollback(eventId)`

取消電文を受信したとき、対象 EventID のスナップショットを削除する。直後に同一 EventID で新規発表が来た場合、`diffAndUpdate` で正しく初回扱い (`["new"]`) となる。

#### 取消・訂正・Headline-only・新規 EventID の bypass

`processFloodForecast` 側で 4 ケースを判定して `diffAndUpdate` を呼ばずに bypass する (state を書き換えずに presentation だけ出す):
- 取消電文 (`infoType === "取消"`)
- 訂正電文 (`infoType` に「訂正」を含む)
- Headline-only (Body 空、Headline のみ)
- 新規 EventID (state holder に未登録)

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../../types` | `ParsedFloodForecastInfo`, `FloodStation`, `FloodHeadline` |

### 設計ノート

- `Vpws50StateHolder` の rich diff と異なり、本クラスは station digest ベースの単純 dedup のみ (rank 系の昇格判定は行わない)。
- スナップショットは `EventID` 単位なので、複数河川の同時警報追跡にも対応可能。
- VXSU50 (水位周知河川) は schema が異なり、observed series を持たないため state holder への登録はスキップする (現状は内部 schema 分岐で対応、Phase 2 で shared state holder への組み込み検討)。

---

## messages/vpww56-state.ts

### 概要

VPWW56 (土砂災害警戒情報) の発表中エリアを保持する state holder。`Vpws50StateHolder` と異なり rich diff / history は持たず、present/absent のみを扱う。

VPWW56 は府県予報区ごとに別の地方気象台が発表するため、view は**発表官署 (`publishingOffice`) 単位で保持し、参照時に union して返す**。全体 1 view 置換にすると別官署の続報が既存官署の警報を消してしまうため、この単位を採る。単調性ガード (report identity の watermark) も官署ごとに独立させる。

### エクスポートAPI

```ts
type Vpww56StateUpdateResult =
  | { kind: "updated" }
  | { kind: "suppressed" };

/** view を失った官署エントリを保持し続ける猶予 (6 時間) */
const VPWW56_DORMANT_RETENTION_MS: number;
/** view を持たない官署エントリの上限 (128) */
const VPWW56_MAX_DORMANT_OFFICES: number;

class Vpww56StateHolder {
  update(info: ParsedWeatherWarning, identity?: WeatherReportIdentity): Vpww56StateUpdateResult;
  /** 全発表官署の現況を union した単一 view。発表中の地域が無ければ undefined */
  getCurrentAreasForDisplay(): Vpws50CurrentAreasForDisplay | undefined;
  /** 保持中の官署エントリ数 (猶予中のものを含む)。掃除の検証・診断用 */
  trackedOfficeCount(): number;
}
```

### 内部ロジック

#### 官署キー

`ParsedWeatherWarning.publishingOffice` をそのままキーに使う。parser は envelope (`xmlReport.control.publishingOffice`) を XML 本体の `Control.PublishingOffice` より優先する。`project-event.ts` のテロップ groupKey `weather:${type}:${publishingOffice}` と同じ値を見ており、粒度が一致する。

#### `update(info, identity)`

- **取消**: 該当官署のエントリが無い、または identity が当該官署の current report と一致しなければ `suppressed`。一致すれば**その官署の view だけ**を undefined にする。watermark は残し、遅着した古い報を弾き続ける
- **発表**: 当該官署の watermark より新しい identity のときだけ受理する (初回は `reportDateTime` が parse 可能なことが条件)。受理したら view を組み直し、current identity と watermark を進める
- 発表中 Kind がゼロになった続報 (解除 Kind のみ) は `buildView` が undefined を返すため、取消と同じくその官署の view が空になる

#### union

view を持つ官署を走査し、kindCode でグループを併合する。`totalAreas` は全官署横断の areaCode 集合サイズ。府県予報区は官署ごとに排他だが、越境発表が来ても地域を二重に並べないよう areaCode で dedup する。kinds は displaySeverity 降順、同 rank では kindCode 昇順で並べ、官署をまたいでも順序を決定的にする。union 結果はキャッシュし `update()` で無効化する。

#### dormant エントリの掃除

view を失ったエントリだけを 2 段で掃除する。基準時刻は壁時計ではなく**受理済み報の最新 `reportDateTime` (ストリーム時計)** を使う。

1. watermark がストリーム時計から `VPWW56_DORMANT_RETENTION_MS` 以上遅れたエントリを削除
2. 生き残った dormant が `VPWW56_MAX_DORMANT_OFFICES` を超えたら watermark の古い順に破棄

view を持つエントリは経過時間によらず掃除しない (発表中の警報を落とさない)。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../../types` | `ParsedWeatherWarning`, `Vpws50CurrentAreasForDisplay`, `Vpws50DisplayKindGroup` |
| `../../dmdata/weather-warning-level` | `resolvePhenomenonFamily`, `resolveDisplaySeverity`, `DISPLAY_SEVERITY_RANK` |
| `./vpws50-state` | `compareWeatherReportIdentity`, `weatherReportIdentityEquals`, `shortKindName`, `WeatherReportIdentity` |

### 設計ノート

- 出力形は `Vpws50StateHolder.buildCurrentAreasForDisplay` と同じ (`Vpws50CurrentAreasForDisplay`)。`specialAreas` / `warningAreas` / `advisoryAreas` は気象カードで未使用のため 0 を置く (rank は `displaySeverity` 由来、VPWW56 は土砂災害単一種別で 3 段カウントの意味が薄い)。
- VPWS50 は本 holder に入らない。`processWeather` が `msg.head.type === "VPWW56"` で門番しており、全国集約の VPWS50 は `Vpws50StateHolder` (rich diff 持ち) の担当。「全国集約は 1 本に畳む / 府県気象台は官署別」の非対称は、この 2 つの holder の役割分担そのもの。
- **キーは官署名のみ**なので、将来 VPWW55/57-61 を同じ holder に相乗りさせると同一官署の複数カテゴリが互いを上書きする。その際はキーを `(head.type, publishingOffice)` に揃えること。
- ストリーム時計は受理された報でしか進まないため、電文が長時間途絶えると dormant エントリは残る。上限 128 で頭打ちになるので漏出はしないが、時間経過だけで必ず消えるわけではない。

---

## presentation/flood-forecast-aggregate.ts

### 概要

`parseFloodForecast` が返す `stations` 配列を河川単位にグループ化する純粋関数モジュール。formatter (`displayFloodForecastInfo`) から呼ばれる。

engine→ui 境界遵守のため、`aggregateByRiver` は presentation event 層 (`from-flood-forecast.ts`) からは呼ばず、formatter 内で呼ぶ。

### エクスポートAPI

```ts
interface RiverSection {
  riverName: string;      // 河川名 (例: "○○川" / "○○川 (+1)")
  riverCode: string;
  stations: FloodStation[];
  maxLevel: FloodLevel;   // この河川群の最大警戒レベル
}

function aggregateByRiver(stations: FloodStation[]): RiverSection[]
```

### 内部ロジック

- station の `riverCode` (なければ `riverName`) をキーにグループ化
- 同一河川の複数 station が異なる順序で来ても安定にソート (`riverCode` 昇順)
- 各 river の `maxLevel` を `criteria` ベースで集計

### 設計ノート

- 純粋関数なので state を持たず、formatter 側で常に呼べる。
- `aggregate-by-prefecture` (VPTA50) と同様、engine/presentation 配下に置く境界判断 (formatter は ui/ なので、aggregate を ui/ に置くと型循環が発生する)。

---

## presentation/weather-severity-pyramid.ts

### 概要

VPWP50 の時系列警報を表示用の severity entry に正規化する純粋モジュール。UI 依存を持たず、engine 側の detail cache と ticker、および UI formatter から利用する。

### エクスポート API

| API | 用途 |
|---|---|
| `flattenEntries(info)` | 時系列警報を `WeatherSeverityEntry[]` に平坦化 |
| `partitionBySeverity(entries)` | special / warning / advisory / unknown に分割 |
| `formatSeriesWindows`, `formatPeakBySeries`, `formatCriteriaTimeBySeries` | 時系列の表示文字列を生成 |
| `summarizeAdvisoryByPhenomenon` | 注意報を現象別に集約 |

### 依存関係

| インポート元 | 用途 |
|---|---|
| `../../types` | VPWP50 入力型と表示 severity 型 |
| `../../dmdata/weather-warning-timeseries-significancy` | 警報 code の分類 |
| `../../dmdata/weather-warning-level` | 表示 severity の解決 |

利用元は `messages/vpwp50-detail-cache.ts`、`display/ticker-sentence.ts`、`ui/weather-warning-timeseries-formatter.ts`。UI から engine/presentation を参照する方向は許容する。

---
## presentation/volcano-presentation.ts

### 概要

火山電文の表示フレームレベル (`FrameLevel`)、通知音レベル (`SoundLevel`)、通知本文要約 (`summary`) を一元的に判定するモジュール。判定は `ParsedVolcanoInfo` の `kind` と各フィールド、および `VolcanoStateHolder` の再通知判定を組み合わせて行う。

### エクスポートAPI

```ts
interface VolcanoPresentation {
  frameLevel: FrameLevel;
  soundLevel: SoundLevel;
  summary: string;
}

function resolveVolcanoPresentation(
  info: ParsedVolcanoInfo,
  volcanoState: VolcanoStateHolder,
): VolcanoPresentation
```

### 判定ロジック

1. **全種別共通**: `infoType === "取消"` → cancel / cancel
2. **VFVO56 (噴火速報)**: critical / critical
3. **VFVO50 (噴火警報)**:
   - 引上げ Lv4-5 → critical / critical、Lv2-3 → warning / warning
   - 引下げ / 解除 → normal / normal
   - 継続 Lv4-5 (初見→critical、再通知→warning) / normal
   - 継続 Lv2-3 (初見→warning / normal、再通知→normal / info)
   - Lv1 継続 → normal / info
4. **VFSVii**: Code 31/36 → warning / warning、Code 33 → normal / normal
5. **VFVO52**: 爆発(51) / 噴火多発(56) / 噴煙≥3000m → warning / normal、軽微 → normal / info
6. **VFVO54**: warning / warning
7. **VFVO55**: normal / normal
8. **VFVO53**: info / info
9. **VFVO51 臨時**: warning / normal、通常 → info / info
10. **VFVO60**: normal / info
11. **VZVO40**: info / info

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../../types` | `ParsedVolcanoInfo` 各種, `FrameLevel` |
| `../notification/sound-player` | `SoundLevel` |
| `../messages/volcano-state` | `VolcanoStateHolder` |

---

## presentation/types.ts

### 概要

presentation レイヤーの中核型定義。電文処理結果 (`ProcessOutcome`) とフィルタ/テンプレート向けの統一イベント (`PresentationEvent`) を定義する。ドメイン判別共用体により、各電文タイプの型安全なルーティングと共通処理の両立を実現する。

### エクスポートAPI

#### PresentationDomain

```ts
type PresentationDomain =
  | "eew" | "earthquake" | "seismicText" | "lgObservation"
  | "tsunami" | "volcano" | "nankaiTrough" | "raw";
```

8つの電文ドメインを識別するリテラル型。

#### ProcessOutcome 系

```ts
interface ProcessOutcomeBase {
  domain: PresentationDomain;
  msg: WsDataMessage;
  headType: string;
  statsCategory: StatsCategory;
  stats: { shouldRecord: boolean; eventId?: string | null; maxIntUpdate?: { eventId: string; maxInt: string; headType: string } };
  presentation: { frameLevel: FrameLevel; soundLevel?: SoundLevel; notifyCategory?: NotifyCategory };
}

interface EewOutcome extends ProcessOutcomeBase { domain: "eew"; parsed: ParsedEewInfo; state: {...}; eewResult: EewUpdateResult; }
interface EarthquakeOutcome extends ProcessOutcomeBase { domain: "earthquake"; parsed: ParsedEarthquakeInfo; state?: {...}; }
interface SeismicTextOutcome extends ProcessOutcomeBase { domain: "seismicText"; parsed: ParsedSeismicTextInfo; }
interface LgObservationOutcome extends ProcessOutcomeBase { domain: "lgObservation"; parsed: ParsedLgObservationInfo; }
interface TsunamiOutcome extends ProcessOutcomeBase { domain: "tsunami"; parsed: ParsedTsunamiInfo; state: {...}; }
interface VolcanoOutcome extends ProcessOutcomeBase { domain: "volcano"; parsed: ParsedVolcanoInfo; volcanoPresentation: VolcanoPresentation; state: {...}; }
interface VolcanoBatchOutcome extends ProcessOutcomeBase { domain: "volcano"; parsed: ParsedVolcanoAshfallInfo[]; isBatch: true; volcanoPresentation: VolcanoPresentation; batchReportDateTime: string; batchIsTest: boolean; }
interface NankaiTroughOutcome extends ProcessOutcomeBase { domain: "nankaiTrough"; parsed: ParsedNankaiTroughInfo; }
interface RawOutcome extends ProcessOutcomeBase { domain: "raw"; parsed: null; }

type ProcessOutcome = EewOutcome | EarthquakeOutcome | SeismicTextOutcome | LgObservationOutcome | TsunamiOutcome | VolcanoOutcome | VolcanoBatchOutcome | NankaiTroughOutcome | RawOutcome;
```

- `ProcessOutcomeBase` — 全ドメイン共通フィールド。`statsCategory` はルーティング由来のカテゴリ（パース失敗→raw フォールバック時も元カテゴリを保持）。`presentation` にフレームレベル・サウンドレベル・通知カテゴリを格納。
- 各ドメイン固有 Outcome — `domain` リテラルによる判別共用体。`parsed` に型安全なパース済みデータを保持。
- `VolcanoBatchOutcome` — VFVO53 バッチ集約専用。`isBatch: true` リテラルで単発と区別。

#### PresentationEvent

```ts
interface PresentationEvent {
  // 識別: id, classification, domain, type, subType?
  // 共通メタ: infoType, title, headline, reportDateTime, publishingOffice, isTest
  // レベル: frameLevel, soundLevel?, notifyCategory?
  // 状態フラグ: isCancellation, isWarning?, isFinal?, isAssumedHypocenter?, isRenotification?
  // イベント追跡: eventId?, serial?, volcanoCode?, volcanoName?
  // 震源情報: originTime?, hypocenterName?, latitude?, longitude?, depth?, magnitude?
  // 強度: maxInt?, maxIntRank?, maxLgInt?, maxLgIntRank?, forecastMaxInt?, forecastMaxIntRank?, alertLevel?
  // 付帯情報: nextAdvisory?, warningComment?, bodyText?
  // 地域集約: areaNames, forecastAreaNames, municipalityNames, observationNames, areaCount, forecastAreaCount, municipalityCount, observationCount, areaItems
  // filter 用: tsunamiKinds?, infoSerialCode?
  // 原本: raw (ParsedTelegramUnion)
  // 状態スナップショット: stateSnapshot? (EventStateSnapshot)
}
```

50以上のフィールドを持つフラットな構造体。`raw` に元のパース済みオブジェクトを保持する。

**アクセス制限（表示専用ポリシー対応）**:
- **filter エンジン**: 全フィールドにドットパスでアクセス可能。
- **template エンジン**: `raw` フィールドへの参照、および配列インデックス参照 `[N]` は禁止（`src/engine/template/parser.ts` でパースエラー）。表示カスタマイズ用途は維持しつつ、生 XML データへの直接アクセスや 1 行機械可読出力での再配信足場化を防ぐ。

#### 補助型

| 型 | 説明 |
|---|---|
| `PresentationAreaItem` | 地域情報の個別項目（`name`, `code?`, `kind?`, `maxInt?`, `maxLgInt?`, `flags?`） |
| `EventStateSnapshot` | eew/tsunami/volcano の状態スナップショット判別共用体 |
| `ParsedTelegramUnion` | 全パース済み型の和（`null` 含む） |

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../../types` | `FrameLevel`, `NotifyCategory`, `WsDataMessage`, 各種パース済み型 |
| `../notification/sound-player` | `SoundLevel` |
| `../eew/eew-tracker` | `EewDiff`, `EewUpdateResult` |
| `./volcano-presentation` | `VolcanoPresentation` |
| `../messages/telegram-stats` | `StatsCategory` |

### 設計ノート

- `ProcessOutcome` は processor が生成し、router が消費する中間表現。`PresentationEvent` は filter/template が消費するフラットな最終表現。二段構えにすることで、processor は型安全なドメイン固有データを扱いつつ、filter/template は統一的なフィールドアクセスを実現する。
- `statsCategory` をパース失敗時にも保持する設計は、raw フォールバック時に統計カテゴリを正確に記録するため。

---

## presentation/diff-store.ts

### 概要

`PresentationEvent` の前回値との差分を検出・保持するストア。EEW・津波・火山の3ドメインについて、同一キーの連続イベント間の差分を `PresentationDiff` として付与する。TTL ベースの自動クリーンアップで長時間稼働時のメモリ蓄積を防止する。

### エクスポートAPI

```ts
type PresentationEventWithDiff = PresentationEvent & { diff?: PresentationDiff };

class PresentationDiffStore {
  constructor(ttlMs?: number);
  apply(event: PresentationEvent): PresentationEventWithDiff;
  remove(diffKey: string): void;
  clear(): void;
}
```

- `apply()` — イベントを受け取り、前回との差分を検出して `diff` プロパティ付きで返す。初回 or 対象外ドメインの場合は diff なし。
- `remove()` — 指定 diffKey のエントリを削除。
- `clear()` — テスト用: ストア全体をクリア。

### 内部ロジック

#### diffKey 解決

| ドメイン | diffKey | 条件 |
|---------|---------|------|
| eew | `eew:{eventId}` | eventId 必須 |
| tsunami | `tsunami:vtse41` | VTSE41 のみ |
| volcano | `volcano:{volcanoCode}` | VFVO50 かつ volcanoCode 必須 |
| その他 | `null` (差分追跡対象外) | — |

#### ドメイン別差分検出

| ドメイン | 比較フィールド | significance |
|---------|---------------|-------------|
| EEW | `magnitude`, `forecastMaxInt`/`maxInt`, `hypocenterName` | magnitude/maxInt=major, hypocenterName=minor |
| 津波 | `areaCount` | major |
| 火山 | `alertLevel` | major |

#### TTL・プルーニング

- デフォルト TTL: 30分 (`DEFAULT_TTL_MS = 1800000`)
- プルーニング間隔: `apply()` 50回ごとに実行 (`PRUNE_INTERVAL = 50`)
- `updatedAt` タイムスタンプで TTL 超過エントリを削除

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `./types` | `PresentationEvent` |
| `./diff-types` | `PresentationDiff`, `PresentationDiffField` |

### 設計ノート

- EEW は `eventId` 単位、津波は VTSE41 固定キー、火山は `volcanoCode` 単位でそれぞれ差分を追跡する。地震情報は各報が独立しているため差分追跡の対象外。
- `apply()` 呼び出し回数ベースのプルーニングはタイマーを使わないため、GC フレンドリーで `.unref()` 管理が不要。

---

## presentation/diff-types.ts

### 概要

差分情報の型定義。

### エクスポートAPI

```ts
interface PresentationDiffField {
  key: string;
  previous: string | number | boolean | null;
  current: string | number | boolean | null;
  significance: "major" | "minor";
}

interface PresentationDiff {
  changed: boolean;
  summary: string[];    // e.g. ["M5.0→5.4", "6弱→6強"]
  fields: PresentationDiffField[];
}
```

- `significance` — `"major"` は表示上目立たせるべき変化、`"minor"` は補助的な変化。

### 依存関係

なし（純粋な型定義ファイル）。

---

## presentation/level-helpers.ts

### 概要

6ドメインの `frameLevel` 判定関数と `soundLevel` 判定関数を一元管理するヘルパーモジュール。processor から呼ばれ、`ProcessOutcome.presentation` に設定するレベルを返す。火山は `volcano-presentation.ts` に委譲されるため、ここには含まれない。

### エクスポートAPI

#### frameLevel 関数

| 関数 | 判定ロジック |
|------|-------------|
| `eewFrameLevel(info)` | 取消→cancel、警報→critical、予報→warning |
| `earthquakeFrameLevel(info)` | 取消→cancel、震度6弱以上→critical、震度4以上→warning、他→normal |
| `tsunamiFrameLevel(info)` | 取消→cancel、大津波警報→critical、津波警報→warning、他→normal |
| `seismicTextFrameLevel(info)` | 取消→cancel、他→info |
| `nankaiTroughFrameLevel(info)` | 取消→cancel、Code120→critical、Code130/111-113/210-219→warning、Code190/200→info、他→warning |
| `lgObservationFrameLevel(info)` | 取消→cancel、階級4以上→critical、3以上→warning、2以上→normal、他→info |

#### soundLevel 関数

| 関数 | 判定ロジック |
|------|-------------|
| `eewSoundLevel(info)` | 警報→critical、予報→warning |
| `earthquakeSoundLevel(info)` | 震度4以上→warning、他→normal |
| `tsunamiSoundLevel(info)` | 津波関連(解除以外)→critical、解除→warning、他→normal |
| `seismicTextSoundLevel(_info)` | 常に info |
| `nankaiTroughSoundLevel(info)` | Code120→critical、他→warning |
| `lgObservationSoundLevel(info)` | 階級3-4→critical、階級1-2→warning、他→normal |

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../../types` | `FrameLevel`, 各種パース済み型 |
| `../notification/sound-player` | `SoundLevel` |
| `../../utils/intensity` | `intensityToRank` |

### 設計ノート

- `volcano-presentation.ts` のレベル判定は再通知判定など `VolcanoStateHolder` 依存のロジックが含まれるため、ステートレスな本モジュールには含めない。
- `seismicTextSoundLevel` は引数を使わない (`_info`) が、他の関数とのシグネチャ統一のために受け取る。

---

## presentation/events/to-presentation-event.ts

### 概要

`ProcessOutcome` を `PresentationEvent` に変換するルーター。`domain` フィールドで分岐し、対応するドメイン別コンバータに委譲する。

### エクスポートAPI

```ts
function toPresentationEvent(outcome: ProcessOutcome): PresentationEvent
```

### 内部ロジック

`switch (outcome.domain)` で8ドメインに分岐:

| domain | コンバータ |
|--------|-----------|
| `eew` | `fromEewOutcome` |
| `earthquake` | `fromEarthquakeOutcome` |
| `seismicText` | `fromSeismicTextOutcome` |
| `lgObservation` | `fromLgObservationOutcome` |
| `tsunami` | `fromTsunamiOutcome` |
| `volcano` | `fromVolcanoOutcome` |
| `nankaiTrough` | `fromNankaiTroughOutcome` |
| `raw` | `fromRawOutcome` |

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../types` | `ProcessOutcome`, `PresentationEvent` |
| `./from-eew` 〜 `./from-raw` | 7つのドメイン別コンバータ |

### 設計ノート

- 全ドメインを網羅する switch 文で TypeScript の exhaustiveness checking が効く設計。新ドメイン追加時にコンパイルエラーで気づける。

---

## presentation/events/from-*.ts (19ファイル)

### 概要

ドメイン固有の `ProcessOutcome` を `PresentationEvent` のフラット構造に展開するコンバータ群。各ファイルが1つのドメインを担当する。

### ファイル一覧と変換概要

| ファイル | 入力型 | 特筆事項 |
|---------|--------|----------|
| `from-eew.ts` | `EewOutcome` | 予測地域から最大予測震度 (`forecastMaxInt`) を算出、`stateSnapshot` に EEW 状態を設定 |
| `from-earthquake.ts` | `EarthquakeOutcome` | 観測地域の震度一覧を `areaItems` に展開、`maxIntRank` を `intensityToRank` で算出 |
| `from-tsunami.ts` | `TsunamiOutcome` | forecast の `kind` を `tsunamiKinds` に集約、`stateSnapshot` に津波状態を設定 |
| `from-volcano.ts` | `VolcanoOutcome` / `VolcanoBatchOutcome` | `isBatch` フラグで単発/バッチを分岐、バッチ時は `subType: "ashfallBatch"` を設定 |
| `from-seismic-text.ts` | `SeismicTextOutcome` | `bodyText` のみを展開する軽量コンバータ |
| `from-lg-observation.ts` | `LgObservationOutcome` | `maxLgInt`, `maxLgIntRank`, 観測地域を `observationNames`/`areaItems` に展開 |
| `from-nankai-trough.ts` | `NankaiTroughOutcome` | `infoSerialCode`, `bodyText`, `nextAdvisory` を展開 |
| `from-weather.ts` | `WeatherOutcome` | 気象警報・注意報 (VPWW55-61/VPWS50) |
| `from-tornado.ts` | `TornadoOutcome` | 竜巻注意情報 (VPHW50/51) |
| `from-briefing.ts` | `BriefingOutcome` | 気象防災速報 (VPBS50) |
| `from-early-weather.ts` | `EarlyWeatherOutcome` | 早期天候情報 (VPAW51) |
| `from-weather-warning-timeseries.ts` | `WeatherWarningTimeseriesOutcome` | 気象警報・注意報時系列情報 (VPWP50) |
| `from-climate-info.ts` | `ClimateInfoOutcome` | 全般/地方天候情報 (VPZI50/VPCI50)。`controlTitle` を搭載し VPZI50/VPCI50 の表示出し分けに使用 |
| `from-weather-explanation.ts` | `WeatherExplanationOutcome` | 気象解説情報 (VPCJ51/VPZJ51/VPFJ51/VMCJ53-55) |
| `from-heat-alert.ts` | `HeatAlertOutcome` | 熱中症警戒アラート (VPFT50) |
| `from-typhoon-analysis.ts` | `TyphoonAnalysisOutcome` | 台風解析・予報情報 (VPTW60/61/62) |
| `from-typhoon-probability.ts` | `TyphoonProbabilityOutcome` | 台風の暴風域に入る確率 (VPTA50) |
| `from-flood-forecast.ts` | `FloodForecastOutcome` | 指定河川洪水予報・水位周知河川 (VXKO50-89/VXSU50-59)。Headline-only/取消の dedup bypass 4 ケース、`raw` に observed series + inundation areas を保持 |
| `from-raw.ts` | `RawOutcome` | フォールバック用の最小変換。`parsed: null`、`isCancellation: false` 固定 |

### 共通パターン

全コンバータは以下の共通フィールドを `xmlReport` / `msg.head` から設定する:

- `id` ← `msg.id`
- `classification` ← `msg.classification`
- `infoType` / `title` / `headline` ← `xmlReport.head.*`
- `reportDateTime` / `publishingOffice` ← `xmlReport.head.reportDateTime` / `xmlReport.control.publishingOffice`
- `isTest` ← `msg.head.test`
- `frameLevel` / `soundLevel` / `notifyCategory` ← `outcome.presentation.*`
- 地域配列は未使用ドメインでは空配列 `[]`、カウントは `0`

### 依存関係

全ファイル共通:
- `../types` — ドメイン固有 Outcome 型, `PresentationEvent`, `PresentationAreaItem`

一部ファイルで追加:
- `../../../utils/intensity` — `intensityToRank` (`from-earthquake.ts`, `from-eew.ts`, `from-lg-observation.ts`)

---

## presentation/processors/process-message.ts

### 概要

ルートに応じたドメイン別 processor を呼び出し、`ProcessOutcome` を返すディスパッチャ。パース失敗時は `RawOutcome` にフォールバックする。EEW の重複報は `null` を返して表示・統計を抑制する。

### エクスポートAPI

```ts
interface ProcessDeps {
  eewTracker: EewTracker;
  eewLogger: EewEventLogger;
  tsunamiState: TsunamiStateHolder;
  volcanoState: VolcanoStateHolder;
}

function processMessage(msg: WsDataMessage, route: string, deps: ProcessDeps): ProcessOutcome | null
```

- `ProcessDeps` — processor が必要とする状態管理オブジェクト群。
- `processMessage()` — `route` 文字列でルーティングし、対応する `processXxx()` を呼び出す。

### 内部ロジック

| route | 処理 | フォールバック |
|-------|------|-------------|
| `eew` | `processEew()` → `ok`/`duplicate`/`suppressed`/`parse-failed` の4分岐 | duplicate/suppressed→null（表示・通知・統計なし）、parse-failed→raw (shouldRecord=false) |
| `earthquake` | `processEarthquake()` | raw |
| `seismicText` | `processSeismicText()` | raw |
| `lgObservation` | `processLgObservation()` | raw |
| `tsunami` | `processTsunami()` | raw |
| `nankaiTrough` | `processNankaiTrough()` | raw |
| default | — | raw |

**注:** `volcano` ルートは `VolcanoRouteHandler` が直接処理するため、`processMessage()` には到達しない。

`routeToCategory(route)` で統計カテゴリを取得し、raw フォールバック時にも元カテゴリを保持する。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../../../types` | `WsDataMessage` |
| `../types` | `ProcessOutcome` |
| `../../eew/eew-tracker` | `EewTracker` 型 |
| `../../eew/eew-logger` | `EewEventLogger` 型 |
| `../../messages/tsunami-state` | `TsunamiStateHolder` 型 |
| `../../messages/volcano-state` | `VolcanoStateHolder` 型 |
| `../../messages/telegram-stats` | `routeToCategory` |
| `./process-eew` 〜 `./process-raw` | 8つのドメイン別 processor |

### 設計ノート

- 火山は `VolcanoRouteHandler` が一元的に処理するため、`processMessage()` には火山ケースがない。
- EEW の重複報・抑制報で `null` を返す設計は、これらが表示・通知・統計に影響しないようにするため。

---

## presentation/processors/process-eew.ts

### 概要

EEW 電文を処理し、パース・重複検出・ログ記録・最終報/取消処理を行う processor。

### エクスポートAPI

```ts
type EewProcessResult =
  | { kind: "ok"; outcome: EewOutcome }
  | { kind: "duplicate" }
  | { kind: "suppressed" }
  | { kind: "parse-failed" };

function processEew(msg: WsDataMessage, eewTracker: EewTracker, eewLogger: EewEventLogger): EewProcessResult
```

### 内部ロジック

1. `parseEewTelegram(msg)` でパース（失敗→`parse-failed`）
2. VXSE44 は `eewTracker.update()` の前に常時抑制して `suppressed` を返す。取消報・最終報の場合だけ、`EewEventLogger.closeEvent()` と `eewTracker.finalizeEvent()` による終端処理を直接行う
3. VXSE44 以外は `eewTracker.update(eewInfo)` で重複判定（重複→`duplicate`）
4. tracker による抑制（`result.isSuppressed`）ではログ記録と終端処理のみ実行して `suppressed` を返す
5. 非抑制報は `eewLogger.logReport()` でログ記録する
6. 取消報 → `eewLogger.closeEvent("取消")`
7. 最終報 → `eewLogger.closeEvent("最終報")` + `eewTracker.finalizeEvent()`
8. `EewOutcome` を構築して返す

**抑制時の終端処理**: `isSuppressed` でも取消・最終報のライフサイクル処理（`closeEvent`/`finalizeEvent`）は実行する。表示・通知のみスキップする。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../../../types` | `WsDataMessage` |
| `../types` | `EewOutcome` |
| `../../../dmdata/telegram-parser` | `parseEewTelegram` |
| `../../eew/eew-tracker` | `EewTracker` |
| `../../eew/eew-logger` | `EewEventLogger` |
| `../level-helpers` | `eewFrameLevel`, `eewSoundLevel` |
| `../../../logger` | デバッグログ |

---

## presentation/processors/process-earthquake.ts 〜 process-raw.ts (18ファイル)

### 概要

ドメイン別の processor 群。パース → レベル判定 → Outcome 構築の流れが共通。パース失敗時は `null` を返す（EEW 以外）。

### ファイル一覧

| ファイル | 電文タイプ | 特筆事項 |
|---------|-----------|----------|
| `process-earthquake.ts` | VXSE51/52/53/61 | `maxIntUpdate` を stats に設定（eventId + maxInt + headType） |
| `process-tsunami.ts` | VTSE41/51/52 | VTSE41 のみ `tsunamiState.update()` を実行、更新前後のレベルを `state` に記録 |
| `process-volcano.ts` | VFVO50-56/60等 | `processVolcano()` は削除済み。`buildVolcanoOutcome()` のみをエクスポートし、`VolcanoRouteHandler` から使用される |
| `process-seismic-text.ts` | VXSE56/VXSE60/VZSE40 | statsCategory は `"earthquake"`（routeToCategory 準拠） |
| `process-lg-observation.ts` | VXSE62 | statsCategory は `"earthquake"`（routeToCategory 準拠） |
| `process-nankai-trough.ts` | VYSE50/51/52/60 | — |
| `process-weather.ts` | VPWW55-61/VPWS50 | VPWS50 は `vpws50State` で差分管理。unsafe 昇格時は `presentation.soundLevel` を上書き |
| `process-tornado.ts` | VPHW50/51 | — |
| `process-briefing.ts` | VPBS50 | — |
| `process-early-weather.ts` | VPAW51 | — |
| `process-weather-warning-timeseries.ts` | VPWP50 | `vpwp50Cache` に詳細を保存（REPL `detail` 用） |
| `process-climate-info.ts` | VPZI50/VPCI50 | frameLevel は一律 `normal`（取消は `cancel`） |
| `process-weather-explanation.ts` | VPCJ51/VPZJ51/VPFJ51/VMCJ53-55 | frameLevel は一律 `normal`（取消は `cancel`） |
| `process-heat-alert.ts` | VPFT50 | `resolveHeatAlertLevels` で frame/sound を pair 解決 |
| `process-typhoon-analysis.ts` | VPTW60/61/62 | `resolveTyphoonAnalysisLevels` で frame/sound を pair 解決。frame は一律 `normal`（取消は `cancel`） |
| `process-typhoon-probability.ts` | VPTA50 | `resolveTyphoonProbabilityLevels` で frame/sound を pair 解決。`typhoonProbabilityState` で連続ゼロ抑制 (`suppressNotify`) |
| `process-flood-forecast.ts` | VXKO50-89/VXSU50-59 | `floodForecastState.diffAndUpdate()` で station 単位 dedup + reasons 抽出。dedup bypass 4 ケース: 取消 (`rollback` のみ) / 訂正 / Headline-only (`rawStations` 空) / VXSU schema。通常 VXKO は新規 EventID でも `diffAndUpdate` に通して `new` reason を出す。`state.rollback()` で取消後の再復帰に備える |
| `process-raw.ts` | フォールバック | `statsCategory` を引数で受け取り、元ルートのカテゴリを保持。frameLevel 固定 `"info"` |

### 共通パターン

```ts
function processXxx(msg: WsDataMessage, ...deps): XxxOutcome | null {
  const info = parseXxxTelegram(msg);
  if (!info) return null;
  return {
    domain: "xxx",
    msg,
    headType: msg.head.type,
    statsCategory: "...",
    parsed: info,
    stats: { shouldRecord: true, eventId: ... },
    presentation: { frameLevel: xxxFrameLevel(info), soundLevel: xxxSoundLevel(info), notifyCategory: "xxx" },
  };
}
```

### 依存関係（共通）

- `../../../types` — `WsDataMessage`
- `../types` — ドメイン固有 Outcome 型
- `../../../dmdata/telegram-parser` or `volcano-parser` — パーサ
- `../level-helpers` — frameLevel/soundLevel 関数

---

## filter/types.ts

### 概要

フィルタエンジンの全型定義。トークン・AST・フィールドレジストリ・コンパイル済み述語の型を一元管理する。

### エクスポートAPI

#### トークン

```ts
type TokenKind =
  | "ident" | "string" | "number" | "boolean" | "null"
  | "op" | "lparen" | "rparen" | "lbracket" | "rbracket" | "comma"
  | "and" | "or" | "not"
  | "eof";

interface FilterToken { kind: TokenKind; value: string; pos: number; }
```

14種のトークンカインド（`eof` 含む）。

#### AST

```ts
type FilterAST = OrNode | AndNode | NotNode | ComparisonNode | TruthyNode;
type CompOp = "=" | "!=" | "<" | "<=" | ">" | ">=" | "~" | "!~" | "in" | "contains";
type ValueNode =
  | { kind: "path"; segments: string[]; pos: number }
  | { kind: "string"; value: string; pos: number }
  | { kind: "number"; value: number; pos: number }
  | { kind: "boolean"; value: boolean; pos: number }
  | { kind: "null"; pos: number }
  | { kind: "list"; items: ValueNode[]; pos: number };
```

- 5種の AST ノード: `or`, `and`, `not`, `comparison`, `truthy`
- 10種の比較演算子: `=`, `!=`, `<`, `<=`, `>`, `>=`, `~` (正規表現マッチ), `!~` (正規表現否定), `in` (リスト包含), `contains` (配列/文字列包含)

#### フィールドレジストリ

```ts
type FilterKind = "string" | "number" | "boolean" | "string[]" | "number[]" | "enum:frameLevel" | "enum:intensity" | "enum:lgInt";
interface FilterField<T = unknown> { kind: FilterKind; aliases: string[]; get: (event: PresentationEvent) => T | null | undefined; supportsOrder?: boolean; }
```

#### コンパイル済み

```ts
type FilterPredicate = (event: PresentationEvent) => boolean;
```

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../presentation/types` | `PresentationEvent` |

---

## filter/compile-filter.ts

### 概要

フィルタ式文字列を受け取り、4段パイプラインを通して `FilterPredicate` を返す公開 API。

### エクスポートAPI

```ts
function compileFilter(expr: string): FilterPredicate
```

### 内部ロジック

```
tokenize(expr) → parse(tokens, expr) → typeCheck(ast, expr) → compile(ast)
```

各ステージでエラーが発生した場合:
- `FilterSyntaxError` — 構文エラー（位置情報付き）
- `FilterFieldError` — 未知フィールド（候補表示付き）
- `FilterTypeError` — 型不整合

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `./tokenizer` | `tokenize` |
| `./parser` | `parse` |
| `./type-checker` | `typeCheck` |
| `./compiler` | `compile` |
| `./types` | `FilterPredicate` |

---

## filter/tokenizer.ts

### 概要

フィルタ式文字列を `FilterToken[]` にトークナイズする。

### エクスポートAPI

```ts
function tokenize(source: string): FilterToken[]
```

### 内部ロジック

13種のトークンカインド (+ EOF) を認識する:

| カテゴリ | 対応 |
|---------|------|
| キーワード | `and`, `or`, `not`, `true`, `false`, `null`, `in`, `contains` |
| 演算子 | `!=`, `<=`, `>=`, `!~`, `=`, `<`, `>`, `~`（長い順にマッチ） |
| 括弧/ブラケット/カンマ | `(`, `)`, `[`, `]`, `,` |
| 文字列リテラル | 単引用符/二重引用符。バックスラッシュエスケープ対応 |
| 数値リテラル | 負数 (`-123`) と浮動小数 (`3.14`) に対応 |
| 識別子 | ドットパス (`areaNames.0.name`) を含むアルファベット+数字+ドット |

出力の末尾に `eof` トークンを付与する。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `./types` | `FilterToken`, `TokenKind` |
| `./errors` | `FilterSyntaxError` |

---

## filter/parser.ts

### 概要

`FilterToken[]` を `FilterAST` に構文解析する再帰下降パーサ。

### エクスポートAPI

```ts
function parse(tokens: FilterToken[], source: string): FilterAST
```

### 内部ロジック

#### 文法（優先度: OR < AND < NOT < primary）

```
expr    → or
or      → and ("or" and)*
and     → unary ("and" unary)*
unary   → "not" unary | primary
primary → "(" or ")" | value [compOp value]
value   → ident | string | number | boolean | null | "[" value ("," value)* "]"
```

- 比較演算子がなければ `truthy` ノード（フィールドの存在判定）
- `MAX_DEPTH = 32` でネストの深さを制限（DoS 防止）
- 括弧と NOT でネスト深度をカウント

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `./types` | `FilterToken`, `FilterAST`, `ValueNode`, `CompOp` |
| `./errors` | `FilterSyntaxError` |

---

## filter/type-checker.ts

### 概要

AST を走査し、フィールド参照の存在確認と演算子の型整合を検証する静的チェッカー。

### エクスポートAPI

```ts
function typeCheck(ast: FilterAST, source: string): void
```

### 内部ロジック

| チェック内容 | エラー型 |
|------------|---------|
| パスが `FILTER_FIELDS` に存在するか | `FilterFieldError`（候補一覧付き） |
| enum:intensity/lgInt に数値リテラルを比較していないか | `FilterTypeError` |
| 順序比較 (`<`, `>` 等) で `supportsOrder` が `true` か | `FilterTypeError` |
| 正規表現 (`~`, `!~`) の右辺が有効な正規表現か | `FilterTypeError` |
| 正規表現の ReDoS リスク検出（入れ子の量指定子） | `FilterTypeError` |
| `in` の右辺がリスト `[...]` か | `FilterTypeError` |
| `contains` の左辺が `string[]`/`number[]`/`string` か、右辺がリテラルか | `FilterTypeError` |

#### ReDoS 検出

`isRedosRisk()` 内部関数で `(+|*|?|}))(+|*|?|{)` パターンを検出する簡易チェック。入れ子の量指定子（例: `(a+)+`）をブロックする。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `./types` | `FilterAST`, `ValueNode`, `CompOp` |
| `./field-registry` | `resolveField`, `fieldNames` |
| `./errors` | `FilterTypeError`, `FilterFieldError` |

---

## filter/compiler.ts

### 概要

`FilterAST` を `FilterPredicate` にコンパイルする。各 AST ノードを対応するクロージャに変換し、実行時のフィールド取得とランク変換を組み込む。

### エクスポートAPI

```ts
function compile(ast: FilterAST): FilterPredicate
```

### 内部ロジック

| AST ノード | コンパイル結果 |
|-----------|--------------|
| `or` | `predicates.some(p => p(event))` |
| `and` | `predicates.every(p => p(event))` |
| `not` | `!predicate(event)` |
| `truthy` | 値が `null`/`false`/`""`/`0` でなければ `true` |
| `comparison` | 演算子ごとの比較ロジック |

#### 比較演算子の処理

- `=`, `!=` — 厳密等価 (`===`)。null は常に `false`。
- `<`, `<=`, `>`, `>=` — enum 型の場合は `rankFn` で数値ランクに変換してから比較。
- `~`, `!~` — 右辺が文字列リテラルなら **コンパイル時に `RegExp` をキャッシュ**する最適化。
- `in` — `Array.includes()` でリスト包含判定。
- `contains` — 配列なら `Array.includes()`、文字列なら `String.includes()`。

#### ランク変換関数

`getRankFn()` が FilterKind に応じてランク変換関数を返す:
- `enum:frameLevel` → `toFrameLevelRank`
- `enum:intensity` → `toIntensityRank`
- `enum:lgInt` → `toLgIntRank`

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `./types` | `FilterAST`, `ValueNode`, `CompOp`, `FilterPredicate` |
| `../presentation/types` | `PresentationEvent` |
| `./field-registry` | `resolveField` |
| `./rank-maps` | `toFrameLevelRank`, `toIntensityRank`, `toLgIntRank` |

### 設計ノート

- 正規表現のコンパイル時キャッシュは、同一フィルタが多数のイベントに適用されるため重要な最適化。
- `makeGetter()` がフィールドレジストリから `get` 関数を取得し、AST の ValueNode をクロージャに変換する。リテラルノードは定数関数を返す。

---

## filter/field-registry.ts

### 概要

`PresentationEvent` のフィールドをフィルタエンジンに公開するレジストリ。フィールド名・エイリアス・型・getter 関数・順序比較対応の有無を管理する。

### エクスポートAPI

```ts
const FILTER_FIELDS: Record<string, FilterField>
function resolveField(name: string): FilterField | null
function fieldNames(): string[]
```

### フィールド一覧 (28エントリ)

| フィールド名 | エイリアス | 型 | 順序比較 |
|-------------|----------|-----|---------|
| `domain` | — | string | — |
| `type` | `headType` | string | — |
| `subType` | — | string | — |
| `classification` | — | string | — |
| `id` | — | string | — |
| `infoType` | — | string | — |
| `frameLevel` | `level` | enum:frameLevel | Yes |
| `isCancellation` | `isCancelled` | boolean | — |
| `isWarning` | — | boolean | — |
| `isFinal` | — | boolean | — |
| `isTest` | — | boolean | — |
| `isRenotification` | — | boolean | — |
| `eventId` | — | string | — |
| `serial` | — | string | — |
| `volcanoCode` | — | string | — |
| `volcanoName` | — | string | — |
| `hypocenterName` | `hypocenter` | string | — |
| `depth` | — | number | Yes |
| `magnitude` | `mag` | number | Yes |
| `maxInt` | — | enum:intensity | Yes |
| `maxLgInt` | — | enum:lgInt | Yes |
| `forecastMaxInt` | — | enum:intensity | Yes |
| `alertLevel` | — | number | Yes |
| `title` | — | string | — |
| `headline` | — | string | — |
| `areaNames` | — | string[] | — |
| `forecastAreaNames` | — | string[] | — |
| `municipalityNames` | — | string[] | — |
| `observationNames` | — | string[] | — |
| `areaCount` | — | number | — |
| `tsunamiKinds` | — | string[] | — |

`depth` は `"10km"` → `10` に数値変換、`magnitude` は文字列→数値変換を getter 内で行う。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../presentation/types` | `PresentationEvent` |
| `./types` | `FilterField`, `FilterKind` |

### 設計ノート

- エイリアス (`headType` → `type`, `level` → `frameLevel` 等) はユーザーの直感的な入力に対応するためのもの。
- `resolveField()` はまず正規名で O(1) ルックアップし、見つからなければエイリアスを線形探索する。フィールド数が少ないため線形探索で十分。

---

## filter/rank-maps.ts

### 概要

enum 型フィールドの順序比較用ルックアップテーブルと変換関数。

### エクスポートAPI

```ts
const FRAME_LEVEL_RANK: Record<string, number>  // cancel=0, info=1, normal=2, warning=3, critical=4
const INTENSITY_RANK: Record<string, number>     // "1"=1 ... "5-"/"5弱"=5, "5+"/"5強"=6, "6-"/"6弱"=7, "6+"/"6強"=8, "7"=9
const LG_INT_RANK: Record<string, number>        // "0"=0, "1"=1, "2"=2, "3"=3, "4"=4

function toFrameLevelRank(value: string): number | null
function toIntensityRank(value: string): number | null
function toLgIntRank(value: string): number | null
```

- `INTENSITY_RANK` は `"5-"` と `"5弱"` の両表記に対応（同ランク値）。`toIntensityRank()` は空白を除去してからルックアップする。
- 未知の値はすべて `null` を返す。

### 依存関係

なし（純粋なデータ定義）。

---

## filter/errors.ts

### 概要

フィルタパイプラインのエラー型3種。

### エクスポートAPI

```ts
class FilterSyntaxError extends Error {
  readonly source: string;
  readonly position: number;
  format(): string;  // 位置付きフォーマット済みエラー表示
}

class FilterTypeError extends Error {}

class FilterFieldError extends Error {
  readonly fieldName: string;
  readonly availableFields: string[];
  format(): string;  // 候補表示付きエラーメッセージ
}
```

- `FilterSyntaxError.format()` — `^` ポインタ付きの位置表示を生成。
- `FilterFieldError.format()` — 使えるフィールド名の先頭6件を候補として表示。

### 依存関係

なし。

---

## template/types.ts

### 概要

テンプレートエンジンの全型定義。AST ノード・式・述語・フィルタ・レンダラ・トークンの型を一元管理する。

### エクスポートAPI

#### AST ノード

```ts
type TemplateNode = TextNode | InterpolationNode | IfBlockNode;

interface TextNode { kind: "text"; value: string; }
interface InterpolationNode { kind: "interpolation"; expr: TemplateExpr; filters: TemplateFilterCall[]; }
interface IfBlockNode { kind: "if"; test: TemplatePredicate; body: TemplateNode[]; elseBody?: TemplateNode[]; }
```

#### 式

```ts
type TemplateExpr =
  | { kind: "path"; segments: (string | number)[] }
  | { kind: "literal"; value: string | number | boolean | null };
```

#### 述語

```ts
type TemplatePredicate =
  | { kind: "truthy"; expr: TemplateExpr }
  | { kind: "compare"; op: "eq" | "ne" | "gt" | "ge" | "lt" | "le"; left: TemplateExpr; right: TemplateExpr };
```

#### フィルタ・レンダラ

```ts
interface TemplateFilterCall { name: string; args: TemplateExpr[]; }
type TemplateRenderer = (event: PresentationEvent) => string;
```

#### トークン

```ts
type TemplateTokenKind = "text" | "open" | "close" | "pipe" | "colon" | "if_open" | "else" | "endif" | "eof";
interface TemplateToken { kind: TemplateTokenKind; value: string; pos: number; }
```

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../presentation/types` | `PresentationEvent` |

---

## template/compile-template.ts

### 概要

テンプレート文字列をコンパイルし `TemplateRenderer` を返す公開 API。

### エクスポートAPI

```ts
function compileTemplate(template: string): TemplateRenderer
```

### 内部ロジック

```
parseTemplate(template) → compileTemplateNodes(nodes)
```

2段パイプライン: パース → コンパイル。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `./parser` | `parseTemplate` |
| `./compiler` | `compileTemplateNodes` |
| `./types` | `TemplateRenderer` |

---

## template/tokenizer.ts

### 概要

テンプレート文字列を `TemplateToken[]` にトークナイズする。制御フロー構文 (`{{#if}}`, `{{else}}`, `{{/if}}`) と補間構文 (`{{ expr | filter }}`) を認識する。

### エクスポートAPI

```ts
function tokenizeTemplate(source: string): TemplateToken[]
```

### 内部ロジック

| 認識パターン | トークン列 |
|-------------|-----------|
| `{{#if condition}}` | `if_open`, `text`(条件), `close` |
| `{{else}}` | `else` |
| `{{/if}}` | `endif` |
| `{{ expr \| filter:arg }}` | `open`, `text`(式), `pipe`, `text`(フィルタ名), `colon`, `text`(引数), `close` |
| プレーンテキスト | `text` |

- 補間内の文字列リテラル（`"..."` / `'...'`）はバックスラッシュエスケープ対応。
- 末尾に `eof` トークンを付与。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `./types` | `TemplateToken` |

---

## template/parser.ts

### 概要

`TemplateToken[]` を `TemplateNode[]` に構文解析する再帰下降パーサ。

### エクスポートAPI

```ts
function parseTemplate(source: string): TemplateNode[]
```

内部で `tokenizeTemplate()` を呼び出してからパースする。

### 内部ロジック

#### 構文要素

- **テキスト** — `{{ }}` の外側のプレーンテキスト
- **補間** — `{{ expr | filter1 | filter2:arg1:arg2 }}`。パイプ `|` でフィルタチェーン、コロン `:` でフィルタ引数を区切る
- **if ブロック** — `{{#if pred}}...{{else}}...{{/if}}`。`{{else}}` は省略可能
- **ネスト制限** — `MAX_DEPTH = 32`

#### 式のパース (`parseExpr`)

| 入力 | 解釈 |
|-----|------|
| `"text"` / `'text'` | 文字列リテラル（エスケープ復元付き） |
| `-?[0-9]+(.[0-9]+)?` | 数値リテラル |
| `true` / `false` / `null` | ブーリアン / null リテラル |
| その他 | パス（ドット記法を `string[]` に分割） |

#### パスセグメント分割

`foo.bar.baz` → `["foo", "bar", "baz"]`。

**表示専用ポリシー（dmdata.jp 再配信ポリシー対応）による制限**:
- ブラケット記法 `[N]` (配列インデックス参照) は禁止。検出時はパースエラー。
- 先頭セグメントが `raw` のパス（生 XML データへの直接参照）も禁止。

これらの制限により、テンプレート機構は「表示カスタマイズ」用途に限定され、機械可読 1 行出力で電文の主要要素を全て吐き出す再配信足場として転用されることを防ぐ。

#### 述語のパース (`parsePredicate`)

`field op value` 形式なら `compare` ノード、そうでなければ `truthy` ノード。対応演算子: `=`, `!=`, `>`, `>=`, `<`, `<=`。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `./tokenizer` | `tokenizeTemplate` |
| `./types` | `TemplateNode`, `TemplateExpr`, `TemplatePredicate`, `TemplateFilterCall`, `TemplateToken` |

---

## template/compiler.ts

### 概要

`TemplateNode[]` を `TemplateRenderer` にコンパイルする。

### エクスポートAPI

```ts
function compileTemplateNodes(nodes: TemplateNode[]): TemplateRenderer
```

### 内部ロジック

#### ノード別レンダリング

| ノード | 処理 |
|-------|------|
| `text` | そのまま結合 |
| `interpolation` | `resolveExpr()` → フィルタパイプライン → `stringify()` |
| `if` | `evaluatePredicate()` → body or elseBody をレンダリング |

#### stringify

- `null` / `undefined` → `""`
- 配列 → `join("\n")` （表示専用ポリシー対応により、改行区切り。1 行に並べる機械可読出力の主経路を塞ぐ目的。完全な迂回防止は保証しない）
- その他 → `String(value)`

なお、フィルタ内部の `toString` でも同様に配列を改行区切りで文字列化する（`filters.ts`）。これにより `|upper` や `|replace` 等の文字列系フィルタを通しても配列が 1 行にならないようにしている。`replace` フィルタは引数に改行文字を含めることを禁止（改行 join を打ち消せないようにするため）。

#### 述語評価

- `truthy` — `null`, `false`, `""`, `0` は偽。その他は真。
- `compare` — `Number()` で変換後に数値比較。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `./types` | `TemplateNode`, `TemplateExpr`, `TemplatePredicate`, `TemplateFilterCall`, `TemplateRenderer` |
| `../presentation/types` | `PresentationEvent` |
| `./field-accessor` | `getFieldValue` |
| `./filters` | `applyFilter` |

---

## template/field-accessor.ts

### 概要

`PresentationEvent` からドットパスで値を取得するユーティリティ。

### エクスポートAPI

```ts
function getFieldValue(event: PresentationEvent, segments: string[]): unknown
```

`segments` 配列の各要素をキーとして順にオブジェクトを走査する。途中で `null` / `undefined` に到達したら `undefined` を返す。

**表示専用ポリシー対応 (二重防御)**: 配列インデックス参照は parser 側で禁止しているが、`segments[0] === "raw"` のケースは本関数でも `undefined` を返して拒否する。parser を経由せず直接呼び出された場合の保険。

### 使用例

- `["title"]` → `event.title`
- `["earthquake", "magnitude"]` → `event.earthquake.magnitude`

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../presentation/types` | `PresentationEvent` |

---

## template/filters.ts

### 概要

テンプレートフィルタの実装。7つの組み込みフィルタを提供する（`join` は表示専用ポリシー対応で削除済み）。

### エクスポートAPI

```ts
function applyFilter(name: string, value: unknown, args: FilterArgs): unknown
```

未知のフィルタ名の場合は値をそのまま返す。

### フィルタ一覧

| フィルタ | 引数 | 説明 |
|---------|------|------|
| `default` | `(fallback)` | `null`/`""` の場合にフォールバック値を返す |
| `truncate` | `(limit)` | 文字列を指定文字数で切り詰める |
| `pad` | `(width)` | `padEnd()` で指定幅に右パディング |
| `date` | `(format?)` | 日付文字列をフォーマット。`"HH:mm"` (デフォルト), `"HH:mm:ss"`, `"MM/DD HH:mm"` |
| `replace` | `(search, replacement)` | 文字列置換（`split().join()` で全置換） |
| `upper` | — | 大文字変換 |
| `lower` | — | 小文字変換 |

### 依存関係

なし（純粋な文字列処理関数）。

---

## filter-template/pipeline.ts

### 概要

filter・template・focus の3つの nullable コンポーネントを束ねるパイプラインインターフェースと、表示判定・テンプレート適用のヘルパー関数を提供する。

### エクスポートAPI

```ts
interface FilterTemplatePipeline {
  filter: FilterPredicate | null;
  template: TemplateRenderer | null;
  focus: FilterPredicate | null;
}

function shouldDisplay(event: PresentationEvent, pipeline: FilterTemplatePipeline): boolean
function renderTemplate(event: PresentationEvent, pipeline: FilterTemplatePipeline): string | null
```

- `FilterTemplatePipeline` — 3フィールドすべて nullable。未設定の場合は対応する処理をスキップする。
- `shouldDisplay()` — `pipeline.filter` が `null` なら常に `true`。非 null ならフィルタ述語を適用。
- `renderTemplate()` — `pipeline.template` が `null` なら `null`（デフォルト表示を使う合図）。非 null ならテンプレートを適用して文字列を返す。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../presentation/types` | `PresentationEvent` |
| `../filter/types` | `FilterPredicate` |
| `../template/types` | `TemplateRenderer` |

### 設計ノート

- `focus` は `shouldDisplay()` では使わない。focus の適用は `message-router.ts` の `runDisplayPipeline` 内で行われ、条件不一致時は dim 表示にフォールバックする。
- インターフェースのみの薄いモジュールにすることで、filter と template の実装に依存せず、テスト時に容易にモック可能。

---

## filter-template/pipeline-controller.ts

### 概要

`FilterTemplatePipeline` の状態を管理するコントローラクラス。REPL はこの API 経由でのみ pipeline を変更する。`getPipeline()` は常に同一オブジェクト参照を返すため、`message-router` 側に渡した pipeline と常に同期する。

### エクスポートAPI

```ts
class PipelineController {
  constructor()

  getPipeline(): FilterTemplatePipeline

  getFilterExpr(): string | null
  setFilter(expr: string): void
  clearFilter(): void

  getTemplateExpr(): string | null
  setTemplate(expr: string): void
  clearTemplate(): void

  getFocusExpr(): string | null
  setFocus(expr: string): void
  clearFocus(): void

  static fromExpressions(opts: { filter?: string | null; template?: string | null; focus?: string | null }): PipelineController
}
```

- `getPipeline()` — 内部の `FilterTemplatePipeline` オブジェクト参照を返す。router に渡した参照と同一であるため、`setFilter()` 等の変更が即座に router 側に反映される。
- `setFilter(expr)` — `compileFilter(expr)` でコンパイルし、pipeline の `filter` フィールドを更新する。無効な式の場合は例外を投げる。
- `setTemplate(expr)` — `compileTemplate(expr)` でコンパイルし、pipeline の `template` フィールドを更新する。
- `setFocus(expr)` — `compileFilter(expr)` でコンパイルし、pipeline の `focus` フィールドを更新する。無効な式の場合は例外を投げる。
- `clear*()` — 対応フィールドを `null` にリセットする。
- `get*Expr()` — 現在設定されている式文字列を返す（未設定時は `null`）。
- `fromExpressions()` — 式文字列から `PipelineController` を構築する静的ファクトリ。`null` / `undefined` のフィールドはスキップされる。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../filter/compile-filter` | `compileFilter` |
| `../template/compile-template` | `compileTemplate` |
| `../filter/types` | `FilterPredicate` 型 |
| `../template/types` | `TemplateRenderer` 型 |
| `./pipeline` | `FilterTemplatePipeline` 型 |

### 設計ノート

- `getPipeline()` が同一オブジェクト参照を返す設計により、REPL と router が同じ pipeline を共有できる。REPL 側で `setFilter()` を呼ぶと、次回の `runDisplayPipeline()` で即座に反映される。
- `cli-run.ts` は `new PipelineController()` + `setFilter()` / `setTemplate()` / `setFocus()` で構築し、`startMonitor()` に渡す。以前の `compileFilter()` / `compileTemplate()` 直接呼び出しは不要になった。
- REPL (`settings-handlers.ts`) は `pipelineController.setFilter(expr)` / `pipelineController.clearFilter()` 等のメソッドで pipeline を変更する。直接の `pipeline.filter = ...` ミューテーションは行わない。

---

## messages/display-callbacks.ts

### 概要

engine→ui の逆方向依存を解消するための表示コールバックインターフェース。engine 層はこのインターフェースを通じてのみ表示を行い、`ui/` モジュールへの直接 import を持たない。実装は `ui/display-adapter.ts` の `createDisplayAdapter()` で提供される。

### エクスポートAPI

```ts
interface DisplayCallbacks {
  displayOutcome(outcome: ProcessOutcome): void;
  displayRawHeader(msg: WsDataMessage): void;
  displayVolcano(info: ParsedVolcanoInfo, presentation: VolcanoPresentation): void;
  displayVolcanoBatch(batch: Vfvo53BatchItems, presentation: VolcanoPresentation): void;
  getDisplayMode(): string;
  renderSummaryLine(event: PresentationEvent): string;
}
```

- `displayOutcome()` — `ProcessOutcome` の `domain` フィールドに基づいてドメイン別の display 関数を呼び出す。火山以外の全ドメインをカバーする。
- `displayRawHeader()` — XML でない電文のヘッダのみ表示。
- `displayVolcano()` — 火山単発電文の表示。`VolcanoRouteHandler` から呼ばれる。
- `displayVolcanoBatch()` — 火山バッチ電文の表示。
- `getDisplayMode()` — 現在の表示モード (`"normal"` / `"compact"`) を返す。`runDisplayPipeline` 内で compact 判定に使用。
- `renderSummaryLine()` — `PresentationEvent` を1行サマリーに変換する。focus 不一致時の dim 表示や compact モードで使用。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../../types` | `WsDataMessage`, `ParsedVolcanoInfo` |
| `../presentation/types` | `ProcessOutcome`, `VolcanoBatchOutcome`, `PresentationEvent` |
| `../presentation/volcano-presentation` | `VolcanoPresentation` |
| `./volcano-vfvo53-aggregator` | `Vfvo53BatchItems` |

### 設計ノート

- 型のみの薄いインターフェースモジュール。実装は `ui/display-adapter.ts` に分離することで、engine 層が ui 層の具体的な表示関数に依存しない。
- `getDisplayMode()` と `renderSummaryLine()` を含めることで、`runDisplayPipeline` が compact/focus 判定時に必要とする UI 機能もインターフェース経由でアクセスできる。

---

## messages/volcano-route-handler.ts

### 概要

火山電文のルーティング処理を一元管理するハンドラクラス。火山は VFVO53 アグリゲータによるバッチ集約があるため、他ドメインの `processMessage()` → outcome → display の線形フローとは異なる。このハンドラがパース → メッセージキャッシュ → VFVO53 集約 → 通知 → 表示の全工程を担当する。

### エクスポートAPI

```ts
type DisplayPipelineFn = (
  outcome: ProcessOutcome | VolcanoBatchOutcome,
  displayFn: () => void,
) => boolean;

interface VolcanoRouteHandlerDeps {
  volcanoState: VolcanoStateHolder;
  notifier: Notifier;
  runDisplayPipeline: DisplayPipelineFn;
  display?: DisplayCallbacks;
}

class VolcanoRouteHandler {
  constructor(deps: VolcanoRouteHandlerDeps)
  handle(msg: WsDataMessage): ParsedVolcanoInfo | null
  flushAndDispose(): void
}
```

- `handle()` — 火山電文を処理する。パース成功なら `ParsedVolcanoInfo` を返す（統計記録用）、失敗なら `null`。
- `flushAndDispose()` — 保留中の VFVO53 バッファを flush してリソースを破棄する。シャットダウン時に呼び出す。
- `DisplayPipelineFn` — `message-router.ts` の `runDisplayPipeline` を注入するための型。
- `VolcanoRouteHandlerDeps` — コンストラクタで必要な依存群。`display` は `DisplayCallbacks` で表示を委譲する。

### 内部ロジック

#### 処理フロー

1. `pruneMsgCache()` で期限切れキャッシュを削除（TTL 10分）
2. `parseVolcanoTelegram(msg)` でパース（失敗→`null` 返却）
3. メッセージを `msgCache` にキャッシュ（volcanoCode をキー）
4. `VolcanoVfvo53Aggregator.handle()` に委譲

#### アグリゲータコールバック

- **単発表示** (`emitSingle`) — `buildVolcanoOutcome()` で outcome 構築 → `resolveVolcanoPresentation()` → `volcanoState.update()` → `notifier.notifyVolcano()` → `runDisplayPipeline()` → `display.displayVolcano()`
- **バッチ表示** (`emitBatch`) — `resolveVolcanoBatchPresentation()` → `notifier.notifyVolcanoBatch()` → `VolcanoBatchOutcome` 構築 → `runDisplayPipeline()` → `display.displayVolcanoBatch()`

#### メッセージキャッシュ

`Map<volcanoCode, { msg, cachedAt }>` で直近の `WsDataMessage` を保持する。`buildVolcanoOutcome()` に元メッセージを渡すために必要。TTL は10分で、`handle()` 呼び出し時に期限切れエントリを自動削除する。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../../types` | `WsDataMessage`, `ParsedVolcanoInfo` |
| `../../dmdata/volcano-parser` | `parseVolcanoTelegram` |
| `./volcano-vfvo53-aggregator` | `VolcanoVfvo53Aggregator`, `FlushOptions`, `Vfvo53BatchItems` |
| `./volcano-state` | `VolcanoStateHolder` |
| `../notification/notifier` | `Notifier` |
| `../presentation/volcano-presentation` | `resolveVolcanoPresentation`, `resolveVolcanoBatchPresentation` |
| `../presentation/processors/process-volcano` | `buildVolcanoOutcome` |
| `../presentation/types` | `VolcanoBatchOutcome`, `ProcessOutcome` |
| `./display-callbacks` | `DisplayCallbacks` 型 |

### 設計ノート

- 火山電文は VFVO53 バッファリングのため線形パイプラインに乗らない。この複雑さを `VolcanoRouteHandler` に封じ込めることで、`message-router.ts` をシンプルに保つ。
- `message-router.ts` はこのハンドラの `handle()` を呼ぶだけで、火山の処理詳細を知らない。統計記録のみ router 側の責務。
- `display` を optional にしているのは、テスト時に表示なしでロジックを検証できるようにするため。

---

## messages/telegram-stats.ts

### 概要

本日 (JST) の電文受信統計を管理するクラス。headType 別の受信カウント、EEW イベント数、地震イベントの代表最大震度を追跡する。0 時 JST で自動的にロールオーバー (受動チェック、タイマー不使用) する。REPL の `stats` コマンドや要約表示で利用される。

### エクスポートAPI

```ts
type StatsCategory =
  | "eew" | "earthquake" | "tsunami" | "volcano" | "nankaiTrough"
  | "weather" | "tornado" | "briefing" | "earlyWeather" | "weatherWarningTimeseries"
  | "climateInfo" | "weatherExplanation" | "heatAlert" | "other";

function routeToCategory(route: string): StatsCategory

interface StatsRecord { headType: string; category: StatsCategory; eventId?: string | null; }
interface StatsSnapshot {
  startTime: Date;
  countByType: Map<string, number>;
  categoryByType: Map<string, StatsCategory>;
  eewEventCount: number;
  earthquakeMaxIntByEvent: Map<string, string>;
  totalCount: number;
}

class TelegramStats {
  constructor(startTime?: Date);
  record(rec: StatsRecord, now?: number): void;
  updateMaxInt(eventId: string, maxInt: string, headType: string, now?: number): void;
  totalCount(now?: number): number;
  getSnapshot(now?: number): StatsSnapshot;
}
```

- `StatsCategory` — 14カテゴリ。`seismicText` と `lgObservation` は `"earthquake"` に集約される。気象系 8 ルート (`weather` 〜 `heatAlert`) はルート名がそのままカテゴリになる。
- `routeToCategory()` — ルート文字列から統計カテゴリに変換するマッピング関数。
- `TelegramStats.record()` — headType カウント加算。EEW の場合は eventId を Set に追加。呼び出し冒頭でロールオーバーを判定する。
- `TelegramStats.updateMaxInt()` — 地震イベントの代表最大震度を更新。headType 優先度: VXSE53 (3) > VXSE61 (2) > VXSE51 (1)。同一優先度以上の報で上書きする。呼び出し冒頭でロールオーバーを判定する。
- `TelegramStats.getSnapshot()` — 表示用の読み取り専用スナップショットを返す。呼び出し冒頭でロールオーバーを判定する。

### 内部ロジック

#### 日次ロールオーバー (`daily-quake-counter.ts` と同型)

`dayKey` (JST 暦日キー `YYYY-MM-DD`) を保持し、`record()` / `updateMaxInt()` / `totalCount()` / `getSnapshot()` の冒頭で `rolloverIfNeeded(now)` を受動チェックする。タイマーは使わない。暦日が変わっていれば `countByType` / `eewEventIds` / `earthquakeMaxIntByEvent` をクリアし、`startTime` をロールオーバー検知時刻へ更新する。`categoryByType` (headType → category の固定マッピング) はロールオーバー対象外 (毎日再学習する必要がないため)。

#### FIFO エビクション

Set/Map のサイズ上限 `MAX_EVENT_ENTRIES = 1000`。超過時はバッチ削除 (`EVICT_BATCH_SIZE = 100`) で古いエントリを除去する。挿入順 (Map/Set のイテレーション順) で先頭から削除することで FIFO を実現。

#### 最大震度の優先度

`MAX_INT_PRIORITY` マッピング: `VXSE53` (震源震度情報) が最も信頼性が高い (`priority: 3`)。より高い priority の報が到着すれば上書きされるが、低い priority では上書きされない。

### 依存関係

なし（自己完結）。

### 設計ノート

- `clear()` メソッドは意図的に提供していない。リセットは日次ロールオーバー (JST 0 時) が自動で行うため、明示的な clear API は不要。
- `StatsSnapshot` は Map のコピーを返すことで、呼び出し元が安全にイテレーションできる。

---

## messages/summary-tracker.ts

### 概要

直近30分間のスライディングウィンドウで受信統計を追跡するクラス。1分粒度のリングバッファで電文数・ドメイン別内訳・最大震度を記録し、sparkline データを生成する。定期要約 (`SummaryTimerControl`) と REPL `summary` コマンドで利用される。

### エクスポートAPI

```ts
interface MinuteBucket {
  minuteStartMs: number;
  received: number;
  matched: number;
  byDomain: Partial<Record<PresentationDomain, number>>;
  maxIntRank: number;
  maxIntStr: string | null;
}

interface SummaryWindowSnapshot {
  totalReceived: number;
  totalMatched: number;
  byDomain: Record<string, number>;
  maxIntSeen: string | null;
  sparklineData: number[];
}

const WINDOW_MINUTES = 30;

class SummaryWindowTracker {
  record(event: PresentationEvent, matched: boolean, now?: number): void;
  getSnapshot(now?: number): SummaryWindowSnapshot;
  clear(): void;
}
```

- `record()` — イベントを記録する。`matched` はフィルタ通過の有無。バケット単位で `received` / `matched` / `byDomain` / `maxInt` を集計。
- `getSnapshot()` — 現在のスナップショットを取得。残存バケットから集計値を算出し、30スロットの `sparklineData` (古い順) を生成する。
- `clear()` — バケットを全削除。

### 内部ロジック

#### リングバッファ

- `WINDOW_MINUTES = 30` 分のスライディングウィンドウ。
- `MinuteBucket` をタイムスタンプを分の開始に丸めた値 (`minuteStartMs`) をキーとして管理。
- `pruneOld()` で窓の外に出たバケットを除去（`record()` / `getSnapshot()` の冒頭で実行）。

#### sparklineData 生成

30スロットの配列を生成し、各スロットに対応する分バケットの `received` 値を設定。バケットが存在しないスロットは `0`。古い方がインデックス0。

#### maxInt 追跡

バケット単位で `intensityToRank()` を使って最大震度ランクを記録。`getSnapshot()` で残存バケット全体から最大値を再計算するため、30分窓で自然に減衰する。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../../utils/intensity` | `intensityToRank` |
| `../presentation/types` | `PresentationDomain`, `PresentationEvent` |

### 設計ノート

- `TelegramStats` が当日 (JST) の累計を管理するのに対し、`SummaryWindowTracker` は直近30分のウィンドウ統計を管理する。両者は独立して動作し、異なるユースケース（stats コマンド vs summary コマンド）に対応する。
- `now?` パラメータはテスト用。本番では `Date.now()` が使われる。

---

## display/weather-promotion.ts

### 概要

気象警報 (VPWS50 / VPWW56) を情報ディスプレイの主役パネルへ昇格させるかを判定する classifier。判定は**集合ベース**で、1 source 分の気象カード view の全 item を走査して最大昇格レベルを採る。rank 1 点代表 (`maxDisplaySeverity`) や `alert.role` は使わない — L4 (rank 90) と特別警報級 `nonLevelSpecial` (rank 85) が共存したとき L5 相当が潰れないようにするため (`computeMaxSoundLevel` と同じ考え方)。

昇格レベルの対応は `display/protocol.ts` の `displayWeatherPromotionLevel()` が持ち、engine と frontend で同一の判定を使う。**L5 相当 = `officialL5` ∪ `nonLevelSpecial`、L4 相当 = `officialL4`**。それ以外は昇格対象外。

### エクスポートAPI

```ts
const WEATHER_PROMOTION_SOURCES: readonly DisplayWeatherSourceV1[]; // ["vpws50", "vpww56"]

interface WeatherPromotionClassification {
  level: DisplayWeatherPromotionLevelV1;  // 4 | 5
  /** 昇格対象 item の集合を表す安定キー。変化したら generation を更新する */
  signature: string;
}

/** null = 昇格対象なし (L3 以下のみ) */
function classifyWeatherPromotion(alerts: DisplayWeatherAlertV1[]): WeatherPromotionClassification | null;
```

### 内部ロジック

全 alert の全 item を走査し、`displayWeatherPromotionLevel()` が非 null を返した item だけを集める。最大値が `level`、`{level}|{displaySeverity}|{kind}|{areaName}` を並べてソートしたものが `signature` になる。未知の `displaySeverity` は昇格判定から除外し、`log.warn` だけ出す (見落としを黙って昇格させない)。

### 昇格 lifecycle (`display/weather-promotion-store.ts` 側)

classifier は判定だけを行い、状態遷移は別モジュールの `WeatherPromotionStore` が持つ。`DisplayStateStore` は record を直接持たず、判定・降格 sweep・参照をこのストアへ委譲する。

- **record は `active | demoted` の discriminated union**。`demoted` は主役パネルからの降格だけを意味し、警報自体は継続しているので `level` を保持する
- **source は完全に独立**。時計・世代・判定のいずれも共有しない。カードは両 source をまとめて再射影するが、昇格の時計を動かすのは受信した source だけ
- **昇格時計は engine 受理時の `nowMs`**。電文の `updatedAt` / `reportDateTime` は判定に使わない
- **confirmed な更新でのみ昇格する**。VPWS50 の unsafe 報 (layer 不在等で state を更新しないまま outcome が通る報) は再昇格契機にしない
- **降格は 30 分**（`WEATHER_PROMOTION_DEMOTE_MIN`）。`SWEEP_INTERVAL_MS` (5 秒) 駆動なので契約は「30 分 + 最大 5 秒」。sweep は `active → demoted` の遷移だけを行う
- **解除 (当該 source の L4/L5 相当 item が消える) は record 削除 = 即終了**。demote を経由しない
- **generation watermark は record 削除後も source 別に保持**する。500ms debounce 内の「解除 → 再発表」で同じ generation に戻さないため。内容が同じ続報は generation 据置で 30 分だけ再開し、変化 (L4→L5・地域追加・L5→L4) は watermark から新しい generation を採る
- **generation は signature の増減方向を問わず更新する**（確定事項）。上位遷移だけでなく **L5 地域の削減など縮退方向でも上がる**。判定は「signature が前回と一致するか」の一点で、方向を見ない。Phase 2 で generation を再アニメーションの契機に使う場合、縮退でも再アニメーションが起きることを前提にすること

### wire への投影

- snapshot トップレベルに `weatherPromotion?` と `weatherL5Active?` を置く。各 alert 内ではなくトップレベルなのは、VPWS50 が rank 別に同 source の alert を複数持つため
- **`demoted` は wire 上 null へ投影する** (`weatherPromotionForWire()`)。フロントは期限計算を一切せず「null でなければ主役パネル」とだけ解釈する。昇格状態の権威は engine 側にある
- `weatherL5Active` は night-dim 用。パネル降格後も警報解除まで true (`isWeatherL5Active()`)
- `deriveSeverityTier()` は demoted を含む record の `level` から L5 = `critical` / L4 = `alert` を採る。**降格後も解除まで tier を維持する** (津波の demote と同方針)
- `restoredItems?` は昇格根拠の控え。**live な `weatherAlerts` に当該 source が無く、かつ控えが空でないときだけ**載る (`promotionEntryForWire()`)。当該 source の電文を 1 通受理すれば `weatherAlerts` が権威になり、控えは wire から消える。詳細は「昇格根拠の控え」節

### テロップ保護

昇格中は当該 source の気象テロップを TTL から保護する。`demoted` は保護対象に含めない (降格後もテロップが残り続けるため)。

- VPWS50: `activeAlertKeys()` が完全一致キー `weather:vpws50` を返す
- VPWW56: テロップ groupKey が `weather:VPWW56:${publishingOffice}` と官署別に分かれる一方、昇格状態は `Vpww56StateHolder` が全官署を union した view に対して 1 つだけ持つため、保護すべきキーを列挙できない。`activeAlertKeyPrefixes()` が接頭辞 `weather:VPWW56:` を返して**まとめて保護**する。既に解除された官署のテロップも巻き添えで保護されるが、`recentTicker` は受信済み電文の履歴であって現況表示ではないため保護側に倒している

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../../logger` | 未知 `displaySeverity` の warn |
| `./protocol` | `displayWeatherPromotionLevel`, `isDisplayWeatherSeverity` |
| `./types` | `DisplayWeatherAlertV1`, `DisplayWeatherPromotionLevelV1`, `DisplayWeatherSourceV1` |

### 設計ノート

- **通知音は変えない**。critical 音 = 特別警報そのもののみ、という既存原則 (`.claude/rules/message-pipeline.md` のフレームレベル判定節) は維持し、主役パネル昇格と通知音判定を結合しない。
- **待機画面の `WeatherAlertCard` は変更しない**。昇格は主役パネル側の機構で、気象カードの表示契約には触れない。
- `DisplayWeatherSeverityV1` に severity を追加すると `WEATHER_PROMOTION_LEVEL` の網羅 Record が compile error になる (追加時に昇格可否の判断を強制する)。
- `display/state-store.ts` 全体の仕様は本書では未記述 (本節は classifier と、それが参加する昇格 lifecycle の契約のみを扱う)。状態機械と永続化の API は `display/weather-promotion-store.ts` / `display/weather-promotion-persistence.ts` の各節を参照。

### 所有者と永続化 (`display/weather-promotion-persistence.ts`)

`WeatherPromotionStore` は **display runtime ではなく monitor 本体が所有する** (standby active-state と同じ所有形)。昇格の時計は「電文を受理してからの壁時計経過」であって display セッションの都合ではないため、REPL の `display off` → `on` で runtime ごと作り直されても lifecycle を途切れさせない。monitor が `DisplaySeedSources.weatherPromotions` で runtime へ注入し、`DisplayStateStore` は注入が無ければ自前のインスタンスを持つ (埋込利用・既存テスト互換)。

保存先は `data/runtime/weather-promotion-v1.json` (gitignore 済み)。作法は `standby-persistence.ts` に揃える。

- **書き込み契機は `WeatherPromotionStore.onDurable`**。昇格・再開・降格・解除で通知し、monitor が `schedule()` を呼ぶ。受信コールスタック上でも 5 秒 sweep 上でも同期 I/O を走らせない (debounce 3 秒 → 非同期で tmp write + rename)
- **tmp 名は書き込みごとに一意**にし、内容を確定した順の通し番号 (`seq`) で順序を保証する。rename 済みの最大 seq より小さい書き込みは rename せず tmp を捨てる。shutdown の同期保存が、進行中の非同期保存に後から上書きされるのを防ぐ (`dispose()` は進行中の書き込みを待てないため、待機ではなく順序で解決する)
- **records が全 null (全解除) の状態も必ず書く**。書かないと前回の active が残り、次の再起動で解除済みの昇格が復活する
- **終了時は `dispose()` → `save()`**。予約済み (debounce 待ち) より現在状態の方が常に新しい。`ShutdownContext.flushWeatherPromotion` が `flushDetailCaches` の直後で呼ぶ
- **`savedAt` は呼び出し側の `nowMs` から作る**。ストア・永続化層では `Date.now()` を呼ばない (`DisplayStateStore` の「クラス内で Date.now() を呼ばない」不変条件を持ち込む)

### 再起動復元

**残り時間だけを復元する** (再起動による延命を作らない)。判定は初回 sweep ではなく復元時に一度で行う — sweep 任せだと最大 5 秒ぶん active が見え、その間に接続したクライアントの初期 snapshot に載るため。

- 既に 30 分経過済みの `active` → `demoted` として格納する。**record は消さない** (警報自体は継続しうるので `level` が tier と `weatherL5Active` に効き続ける)
- `promotedAtMs` が許容誤差を超えて未来 → **record を破棄する** (`demoted` にもしない)。RTC を持たない Pi では NTP 同期前に保存時刻が未来になりうるが、そのとき「30 分経ったか」も「まだ有効か」も判定できない。`demoted` で残すと主役パネルだけ消えて `critical` tier と `weatherL5Active` が無期限に固定される最悪の縮退になるため、判定不能なら捨てる。警報が継続していれば VPWS50 の定期再掲ですぐ再昇格する。許容誤差は sweep 1 周期 (`WEATHER_PROMOTION_CLOCK_SKEW_TOLERANCE_MS` = `SWEEP_INTERVAL_MS`) で、これ以内のズレは通常運転と区別できないため未来扱いしない
- **`savedAt` 自体が未来のファイルは record だけ破棄し、`generations` (watermark) は復元する**。`promotedAtMs` を持たない `demoted` record は record 単位の未来判定では守れないため、record の破棄はファイル層 (`load`) で行う。一方 watermark は時刻と無関係なので残す — ファイルごと捨てると次の昇格が `generation` 1 に戻り、「generation を再利用しない」契約が壊れる
- `promotedAtMs` は有限であることに加え **Date が扱える範囲 (絶対値 8.64e15) であること**を検証する。有限でも範囲外の値 (`1e20` 等) は日時整形で `RangeError` になり、restore は load の try/catch の外にあるため起動ごと落ちる。monitor 側の restore 呼び出しも try/catch で二重に守る
- それ以外の `active` は `promotedAtMs` を据え置く (残り時間が減った状態で復元される)
- `generation` は必ず維持する。watermark は保存 watermark と**保存値 record** の `generation` の大きい方を採る (復元後の record ではない) ので、上記の未来判定で record を破棄しても generation は逆行しない
- **破損・version 不一致・`savedAt` 不正は破棄して起動を続ける** (warn/debug のみ)。検証は **source 単位**で、片方が壊れてももう片方は生かす。`signature` 欠落の record は破棄する — 欠けると復元後の「同内容の続報」判定が効かず generation が無駄に進むため
- **保存から `WEATHER_PROMOTION_MAX_RESTORE_AGE_MS` (24 時間) 以上経ったデータは丸ごと破棄する**。気象警報の view 自体は起動時に復元されない (`src/engine/startup/` にあるのは津波・火山の REST replay だけで、`Vpws50StateHolder` / `Vpww56StateHolder` は空から始まる) ため、`demoted` record は電文が届くまで tier と `weatherL5Active` を保持し続ける。継続中の警報なら VPWS50 の定期再掲ですぐ上書きされるので、「1 日確認が取れないものは主張しない」を上限に据える

### 昇格根拠の控え (view スナップショット)

気象カードの view は起動時に復元されないため、`active` を復元した直後は `weatherPromotion` が非 null なのに `weatherAlerts` が空、という窓ができる (最初の VPWS50/VPWW56 受信まで)。主役パネルの中身は `weatherAlerts` から組むので、そのままでは「昇格しているのに描く中身が無い」状態になる。

これを塞ぐため、**昇格の根拠になった item を record 自身が控えとして持つ**。

- 控えは `WeatherPromotionRecord` の discriminated union の**中**に置く (`items`)。トップレベルの別フィールドにしないのは、**record を捨てる操作がそのまま控えの破棄になる**ようにするため。「record は消えたのに控えだけ残る」を型の上で書けなくしている
- 保存するのは **L4/L5 相当の item だけ**。L3 以下は主役パネルに出ないので控える意味がない (classifier が `displayWeatherPromotionLevel()` で非 null を返した item だけを集める)
- 受理のたびに最新の view で上書きする。控えが現況から遅れない
- 空の `items` は**破損として record ごと破棄する**。復元しても「昇格しているのに中身が無い」状態を作るだけなので、残す価値がない

**wire には `DisplayWeatherPromotionEntryV1.restoredItems?` として載る。ただし live な `weatherAlerts` に当該 source が無いときだけ**。当該 source の電文を 1 通でも受理すれば `weatherAlerts` が権威になり、控えは wire から消える (`promotionEntryForWire()`)。

**`weatherAlerts` には一切 seed しない。** 控えを `weatherAlerts` に流し込めばフロントは何も変えずに済むが、そうすると**再起動直後に待機画面の気象カードが前回の警報で点灯する** — 従来は空だった場所に表示が出るので、`WeatherAlertCard` の挙動変更になってしまう。控えはあくまで主役パネルの空表示を防ぐためのもので、現況そのものではない。この不変条件はテストで固定してある。

### 受理経路 (どこで `apply` を呼ぶか)

昇格の更新は **monitor の `displaySink.ingest`** から `applyWeatherPromotionOnIngest()` 経由で行う。**hub 側では更新しない。**

display は表示の都合であって「電文を受理した」という事実とは無関係なので、受理経路を hub に置くと `display off` の間だけ新規昇格・続報・解除・L4→L5 がすべて失われる (`displaySink` は hub の有無に関わらず必ず通る)。更新経路をこの 1 か所に一本化しているため、二重適用も構造的に起きない。

`DisplayStateStore.applyWeatherSource()` は `WeatherPromotionStore.apply()` への委譲として残っているが、**production からの呼び出し元は無く**、現在はテストが lifecycle を直接回すための窓口になっている。

### display on 時の再開 (`resume`)

降格 sweep は hub の 5 秒タイマー駆動なので `display off` 中は止まる。そのため `display on` の直後、既に 30 分を過ぎた `active` が初回 sweep まで最大 5 秒そのまま見えてしまう。runtime の起動時 seed で `resumeWeatherPromotions()` を通し、この窓を塞ぐ。

**やるのは経過判定だけ** (`restore` と同じ `reviveRecord()` を共有する)。受信更新は上記のとおり display の on/off に関わらず `displaySink` が行うので、off 中の新規昇格・続報・解除は `resume` に来る時点で反映済み。したがって view と record を突き合わせる reconcile は不要で、**`resume` は view を一切参照しない**。

結果として「view から昇格させない」原則 (昇格の根拠は confirmed な電文の受理であり、起動時 seed は受理ではない) も自動的に守られる。

---

## display/weather-promotion-store.ts

### 概要

気象警報の昇格 lifecycle を持つ状態機械。`DisplayStateStore` ではなく **monitor が所有する** (`monitor/monitor.ts` の「monitor が所有する display 状態」節を参照)。時刻は全メソッドで `nowMs` 注入で、クラス内で `Date.now()` を呼ばない。

遷移の契約 (source 独立・confirmed のみ・30 分 + 最大 5 秒の降格・解除は即削除・generation watermark) は `display/weather-promotion.ts` 節の「昇格 lifecycle」に記述する。本節は API と、そこに書ききれない復元判定の内部ロジックを扱う。

### エクスポートAPI

```ts
// items = 昇格の根拠になった item の控え (L4/L5 相当のみ)。union の中に置くことで
// record を捨てる操作がそのまま控えの破棄になる (「片方だけ生き残る」を型で書けなくする)
type WeatherPromotionRecord =
  | { state: "active";  level: 4 | 5; promotedAtMs: number; generation: number; signature: string; items: DisplayWeatherAlertItemV1[] }
  | { state: "demoted"; level: 4 | 5;                       generation: number; signature: string; items: DisplayWeatherAlertItemV1[] };

/** 永続化・復元の受け渡し形 (シリアライズ可能な素直な構造)。wire プロトコルには載らない */
interface WeatherPromotionPersistedV1 {
  records: Record<DisplayWeatherSourceV1, WeatherPromotionRecord | null>;
  /** record 削除後も保持する source 別 generation watermark */
  generations: Record<DisplayWeatherSourceV1, number>;
}

class WeatherPromotionStore {
  /** 永続化が必要な変化 (昇格・再開・降格・解除) の通知先。null で解除 */
  onDurable(listener: (() => void) | null): void;
  get(source: DisplayWeatherSourceV1): WeatherPromotionRecord | null;
  /** 1 source 分の気象カード view から昇格状態を更新する。confirmed な更新でだけ呼ぶ */
  apply(source: DisplayWeatherSourceV1, view: DisplayWeatherAlertV1[], nowMs: number): boolean;
  /** active → demoted の遷移だけを行う (record 削除は解除受理の責務) */
  sweepDemote(nowMs: number): boolean;
  export(): WeatherPromotionPersistedV1;
  restore(state: WeatherPromotionPersistedV1, nowMs: number): void;
  /** display on 時の経過判定だけを行う。view は参照しない */
  resume(nowMs: number): boolean;
}
```

`apply` / `sweepDemote` / `resume` の戻り値は「state snapshot の再配信が必要な変化があったか」。いずれも変化したときだけ `onDurable` を通知する。

### 内部ロジック

#### 経過判定 (`restore` / `resume` 共有)

`active` record は経過時間で 3 通りに分かれる。判定を初回 sweep に任せず復元・再開の時点で一度行う理由は `display/weather-promotion.ts` 節の「再起動復元」「display on 時の再開」を参照。

両者は `reviveRecord()` を共有する。上から順に判定する (条件は互いに排他)。

| 条件 | 結果 |
|------|------|
| 経過が `-WEATHER_PROMOTION_CLOCK_SKEW_TOLERANCE_MS` 未満 (`promotedAtMs` が未来) | **`null` = record 破棄** + `log.warn` |
| 経過が 30 分超 | `demoted` として格納 (record は消さない) |
| それ以外 | `promotedAtMs` を据え置く (残り時間が減った状態) |

`demoted` record は経過判定を通さずそのまま格納する (`promotedAtMs` を持たないため)。

1 行目で `demoted` に落とさず破棄するのは、時計が信用できない状態では「30 分経ったか」も「まだ有効か」も判定できないため。`demoted` で残すと主役パネルだけ消えて `critical` tier と `weatherL5Active` が無期限に固定される最悪の縮退になる。警報が継続していれば次の定期再掲で再昇格する。

**watermark は破棄された場合も維持する** — `restore()` は復元後の record ではなく**保存値**の `generation` と保存 watermark の大きい方を採るので、record を捨てても generation は逆行しない。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../../logger` | `promotedAtMs` が未来で record を破棄したときの warn |
| `./constants` | `WEATHER_PROMOTION_DEMOTE_MIN`, `WEATHER_PROMOTION_CLOCK_SKEW_TOLERANCE_MS` |
| `./types` | `DisplayWeatherAlertV1`, `DisplayWeatherPromotionLevelV1`, `DisplayWeatherSourceV1` |
| `./weather-promotion` | `classifyWeatherPromotion`, `WEATHER_PROMOTION_SOURCES` |

### 設計ノート

- 永続化 I/O は持たない。`export()` / `restore()` という素の受け渡し形だけを公開し、ファイル操作は `weather-promotion-persistence.ts` に閉じる。テストで実 I/O を用意せずに lifecycle を回せる。
- `signature` を record に持たせているのは、復元後に同内容の続報が来たとき `generation` を無駄に進めないため。永続化層は `signature` 欠落の record を破棄する。

---

## display/weather-promotion-persistence.ts

### 概要

昇格 lifecycle をローカル JSON (`data/runtime/weather-promotion-v1.json`、gitignore 済み) へ保存・復元する。作法は `display/standby-persistence.ts` に揃えてある — debounce 予約 → tmp write + rename、終了時は `dispose()` → `save()` で書き切る。

**同期保存と非同期保存が混在する**ため、順序保証のための seq guard を持つ (後述)。同じ構造を持つ永続化層が他に 2 つあり、いずれも同じ方式に揃えてある (「同じ方式を適用した他の永続化層」節)。

津波・火山のような dmdata REST replay は使えない。`promotedAtMs` は engine の受理時刻、`generation` は engine 内部のカウンタで、**どちらも電文からは再構成できない**ため、ローカルスナップショット以外に選択肢がない。

### エクスポートAPI

```ts
interface PersistedWeatherPromotionV1 extends WeatherPromotionPersistedV1 {
  version: 1;
  savedAt: string;
}

class WeatherPromotionPersistence {
  constructor(persistPath: string, debounceMs?: number);  // 既定 3000ms
  /** version 不一致・破損・欠落・古すぎるデータは null。起動は妨げない */
  load(nowMs: number): WeatherPromotionPersistedV1 | null;
  /** debounceMs 後に 1 回だけ非同期で書く。最新状態で上書きし書き込み回数は増やさない */
  schedule(state: WeatherPromotionPersistedV1, nowMs: number): void;
  /** 同期で書く (シャットダウン経路) */
  save(state: WeatherPromotionPersistedV1, nowMs: number): void;
  /** 予約済みを同期で書き切る。予約が無ければ何もしない */
  flush(): void;
  /** 予約を捨てる (ディスク上の内容は触らない) */
  dispose(): void;
  /** テスト用: 予約済みの書き込みを debounce を待たずに実行する (テストを実時間に依存させない) */
  __test_writePending(): Promise<void>;
}
```

`savedAt` は呼び出し側の `nowMs` から作る (`envelope()`)。永続化層でも `Date.now()` を呼ばず、テストの決定性を保つ。

### 内部ロジック

#### 書き込みと順序保証 (seq guard)

`schedule()` は pending を最新で上書きして 1 本だけタイマーを張る (`armTimer` は多重張りを防ぎ、`timer.unref?.()` で保存予約だけではプロセスを生かさない)。発火後は `writing` フラグで再入を防ぐ。

書き込みは**単調増加する `seq` で順序を保証する**。`seq` は「内容を確定した時点」で採る (`envelope()` を作るとき) — 書き込み開始時に採ると、`schedule()` → 同期 `save()` の順で呼ばれたときに古い内容の方が大きい `seq` を持ち、順序が逆転する。tmp ファイル名も `{basename}.{seq}.tmp` と seq 固有にして、並行する書き込み同士が同じ tmp を奪い合わないようにする。

`renamedSeq` は「実際に rename まで到達した最大 seq」で、自分の `seq` がこれより小さければ rename せずに tmp を捨てる。

**非同期書き込みでは `writeFile` までを非同期で行い、seq guard と `rename` は同期 (`fs.renameSync`) で不可分に実行する。** 両者の間に `await` を挟むと、guard 通過後・rename 完了前に同期保存 (`save()` / `flush()`) が割り込み、そのあと古い rename が完了して**旧内容で上書きし `renamedSeq` も逆行**する。重い書き込みは非同期のまま、判定と確定だけを同期で閉じる形にしている。

#### `load(nowMs)` の破棄条件

上から順に判定する (warn / debug ログのみで、いずれの場合も起動は妨げない)。

1. ファイルが存在しない → `null`
2. top-level が object でない → `null`
3. `version` が `PERSIST_SCHEMA_VERSION` (**2**) と不一致 → `null` (schema 世代交代として debug ログのみ)。v1 は record が `items` (昇格根拠の控え) を持たず、復元すると「昇格しているのに中身が無い」状態になるため読まずに捨てる
4. `savedAt` が parse 不能 → `null`
5. `nowMs - savedAt` が `WEATHER_PROMOTION_MAX_RESTORE_AGE_MS` (24 時間) 超 → `null`
6. `savedAt - nowMs` が `WEATHER_PROMOTION_CLOCK_SKEW_TOLERANCE_MS` 超 (**保存時刻が未来**) → **record だけ破棄し `generations` は返す**

6 が record 単位ではなくファイル単位なのは、`savedAt` 自体が未来なら時計が信用できず record の古さを判定できないため。特に `demoted` は `promotedAtMs` を持たないので record 単位の未来判定では守れず、放置すると tier と `weatherL5Active` を無期限に固定しうる。

一方で **`generations` (watermark) は時刻と無関係なので必ず残す**。ここでファイルごと捨てると次の昇格が `generation` 1 に戻り、「generation を再利用しない」契約が壊れる。

#### tmp 残骸の掃除

`load()` は `{basename}.*.tmp` にマッチする残骸を削除する。rename 前に強制終了すると seq 固有名の tmp が残るため (Pi は電源断が起こりうる)。掃除の失敗は無視して起動を続ける。

#### 検証の粒度

`sanitizePersisted()` は **source 単位**で検証し、片方が壊れていてももう片方は生かす (standby persistence の domain 単位破棄と同じ考え方)。`sanitizeRecord()` は `null` (記録なし = 正常) と `undefined` (不正データ = この source を破棄) を区別する。`state` / `level` / `generation` / `signature` のいずれかが不正なら破棄し、`active` はさらに `promotedAtMs` の有限性と Date 可搬範囲を要求する。

`items` (昇格根拠の控え) は record の一部として検証する。**壊れていても空でも record ごと破棄する** — 控えだけを落として record を残すと「昇格しているのに中身が無い」状態が復活してしまい、`items` を union の中に置いた意味が消えるため。

`generation` は `Number.isFinite` ではなく **`Number.isSafeInteger`** で検証する。safe integer を超えた値は `++` しても増えず、generation の更新が止まってしまうため。`generations` は record の `generation` を下回らないよう補正する (復元後の generation 逆行防止)。

### 同じ方式を適用した他の永続化層

上記の書き込み順序の設計 (seq guard・seq 固有 tmp・guard と `rename` の同期実行・`load()` での残骸掃除) は、**同じ構造を持つ次の 2 つにも同一の方式で適用してある**。

| ファイル | 保存対象 |
|---------|---------|
| `display/standby-persistence.ts` | standby active-state |
| `messages/vpwp50-detail-cache.ts` | VPWP50 詳細 cache の latest |

**なぜ必要だったか**: どちらも「debounce した非同期保存」と「終了時の同期保存」が**同じ固定 `.tmp` を共有**していて、`dispose()` は進行中の非同期書き込みを待たない。そのため古い非同期書き込みが新しい同期保存の**後に** rename し、**正常終了時の最終状態が直前の非同期書き込みに巻き戻る**。standby は再起動時に復元される状態なので、巻き戻ると次回起動の表示に影響する。**同期と非同期が同じ tmp を使う形は再生産しないこと。**

3 つの実装で違うのは、順序保証そのものではなく各層の元の API 形だけ。

- `standby-persistence.ts` は `save()` が public (シャットダウン経路が直接呼ぶ) なので、同期保存の入口が `save()` と `flush()` の 2 つある
- `vpwp50-detail-cache.ts` は同期保存の入口が `flush()` だけで、`save()` 相当は private (`saveToDisk`)
- `weather-promotion-persistence.ts` は `savedAt` を呼び出し側の `nowMs` から作るため、`schedule` / `save` が `nowMs` を受け取る

いずれも `__test_writePending()` を持つ。debounce タイマーの発火を実時間で待つとテストが時間依存になるため、予約済みの書き込みをタイマー抜きで実行する窓口をテスト用に開けてある。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `node:fs` / `node:path` | ファイル I/O・パス組み立て |
| `../../logger` | 破棄・失敗の warn / debug |
| `./constants` | `WEATHER_PROMOTION_MAX_RESTORE_AGE_MS` |
| `./types` | `DisplayWeatherSourceV1` |
| `./weather-promotion` | `WEATHER_PROMOTION_SOURCES` |
| `./weather-promotion-store` | `WeatherPromotionPersistedV1`, `WeatherPromotionRecord` (type import) |

### 設計ノート

- **`records` が全 null (全解除) の状態も必ず書く**。書かないと前回の `active` がディスクに残り、次の再起動で解除済みの昇格が復活する。`flush()` の「予約が無ければ何もしない」は空書き防止であって、全 null の保存を省く意味ではない。
- 24 時間の足切りは、気象警報の view が起動時に復元されないことへの次善策。詳細は `display/weather-promotion.ts` 節の「再起動復元」を参照。
- 強制電源断では直前 debounce 窓 (3 秒) ぶんを失う。継続中の警報なら次の電文で復旧するため、microSD の書き込み削減を優先している (`standby-persistence.ts` と同じトレードオフ)。

---

## display/weather-alert-view.ts

### 概要

state holder の現況 view (`Vpws50CurrentAreasForDisplay`) を表示プロトコルの `weatherAlerts` へ変換する。VPWS50 / VPWW56 の 2 系統ぶん。

**`runtime.ts` から切り出してある**のは、monitor が display runtime の有無に関わらず昇格判定用の view を組む必要があるため。`runtime.ts` を import すると transport (HTTP サーバ) まで巻き込んで遅延ロード設計を壊すので、変換だけをこの軽量モジュールに置く。`runtime.ts` は既存の import 経路を保つため両関数を re-export する。

### エクスポートAPI

```ts
function weatherAlertsFromVpws50(
  view: Vpws50CurrentAreasForDisplay | undefined,
  updatedAt: string,
): DisplayWeatherAlertV1[];

function weatherAlertsFromVpww56(
  view: Vpws50CurrentAreasForDisplay | undefined,
  updatedAt: string,
): DisplayWeatherAlertV1[];
```

`updatedAt` は呼び出し側が供給する (電文受理時は `dto.reportDateTime`、起動時 seed は起動時刻の ISO)。

### 内部ロジック

`weatherRankOf()` が `displaySeverity` から意味ベースの `DisplayWeatherRank` を導出する (`officialL5` / `nonLevelSpecial` → `emergency`、`officialL4` / `officialL3` / `nonLevelWarning` → `warning`、それ以外 → `advisory`)。frame level とは別軸である点に注意。

VPWS50 は rank ごとのバケツ (気象特別警報 / 気象警報 / 気象注意報) に分けて alert を組む。**`advisory` rank は気象カードに載せない** (注意報はテロップに任せる)。空バケツは含めない。VPWW56 は単一ラベル「土砂災害警戒情報」で 1 件を組み、同じく advisory 相当は除外する。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../../types` | `DisplaySeverity`, `Vpws50CurrentAreasForDisplay` |
| `../../dmdata/weather-warning-level` | `formatLevelLabel` |
| `./types` | `DisplayWeatherAlertV1`, `DisplayWeatherAlertItemV1`, `DisplayWeatherRank` |

### 設計ノート

- transport を巻き込まない軽量モジュールに保つことが分離の目的そのものなので、ここから `runtime.ts` / `hub.ts` / `http-server.ts` を import しないこと。

---

## display/weather-promotion-ingest.ts

### 概要

気象電文の受理から昇格状態を更新する 1 関数だけのモジュール。monitor の `displaySink.ingest` から呼ぶ。設計理由 (なぜ hub ではなく monitor か) は `display/weather-promotion.ts` 節の「受理経路」を参照。

`monitor.ts` 内の匿名関数のままだと実配線をテストで直接突けないため、独立モジュールに切り出してある。

### エクスポートAPI

```ts
interface WeatherPromotionViewSources {
  vpws50: () => Vpws50CurrentAreasForDisplay | undefined;
  vpww56: () => Vpws50CurrentAreasForDisplay | undefined;
}

function applyWeatherPromotionOnIngest(
  store: WeatherPromotionStore,
  views: WeatherPromotionViewSources,
  event: PresentationEvent,
  nowMs: number,
): boolean;
```

view は関数で受け取る (呼び出し時点の最新を読むため)。戻り値は `WeatherPromotionStore.apply()` のもの (state 再配信が必要な変化があったか)。

### 内部ロジック

1. `event.type` が `VPWS50` / `VPWW56` のいずれでもなければ何もせず `false`
2. `event.weatherConfidence === "unsafe"` (state を更新しないまま outcome が通った報) なら `false`
3. 対応する source の view を `weather-alert-view.ts` で `weatherAlerts` に変換し、`store.apply(source, alerts, nowMs)` を呼ぶ

`nowMs` は engine の受理時刻。電文の `updatedAt` / `reportDateTime` は判定に使わない。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../presentation/types` | `PresentationEvent` (type import) |
| `../../types` | `Vpws50CurrentAreasForDisplay` (type import) |
| `./weather-alert-view` | `weatherAlertsFromVpws50`, `weatherAlertsFromVpww56` |
| `./weather-promotion-store` | `WeatherPromotionStore` (type import) |

### 設計ノート

- 更新経路をこのモジュール 1 か所に閉じているため、二重適用は構造的に起きない。hub 側に同等の呼び出しを足さないこと。
