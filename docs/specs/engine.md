# engine/ モジュール仕様書

本文書は `src/engine/` 配下の9ファイルについて、エクスポートAPI・内部ロジック・依存関係・設計意図を記述する。

---

## cli.ts

### 概要

Commander ベースの CLI 定義を担うエントリ構成ファイル。`buildProgram()` が返す `Command` オブジェクトが `index.ts` から呼ばれ、サブコマンド群を含む CLI ツリー全体を構築する。メインアクション（モニタ起動）と `init` コマンドは dynamic import で遅延ロードし、起動時のメモリフットプリントを抑える設計。

### エクスポートAPI

```ts
function buildProgram(): Command
```

Commander の `Command` インスタンスを生成・返却する。以下のコマンド体系を定義する。

| コマンド | 説明 |
|---------|------|
| `fleq` (デフォルト) | モニタ起動。`cli-run.ts` の `runMonitor()` を dynamic import で呼び出す |
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
| `--debug` | デバッグログ表示（デフォルト `false`） |

### 内部ロジック

- `package.json` から `version` を `require()` で同期読み込みし、`program.version()` に渡す。
- `config` サブコマンドの `set` / `unset` は `ConfigError` を catch して `log.error()` + `process.exit(1)` とする。それ以外の例外は再スローする。
- デフォルトアクションと `init` アクションは `async action` 内で `await import(...)` を使い、実行時まで対象モジュールをロードしない。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `commander` | `Command` クラス |
| `../config` | `setConfigValue`, `unsetConfigValue`, `printConfig`, `printConfigKeys`, `getConfigPath`, `ConfigError` |
| `../logger` | ログ出力 |
| `./cli-run` | `RunMonitorOptions` 型（型のみ import）、`runMonitor` 関数（dynamic import） |
| `./cli-init` | `runInit` 関数（dynamic import） |

### 設計ノート

- Commander のアクションハンドラ内で dynamic import を使うことで、`fleq config show` のような軽量コマンドが `ws` や `fast-xml-parser` などの重い依存を読み込まずに済む。
- `RunMonitorOptions` は `import type` で型のみインポートし、ランタイムバンドルに影響しない。

---

## cli-init.ts

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
| `../config` | `loadConfig`, `saveConfig`, `VALID_CLASSIFICATIONS`, `getConfigPath` |
| `../dmdata/rest-client` | `listContracts`（契約確認 API） |
| `../types` | `Classification`, `ConfigFile` |
| `../utils/secrets` | `maskApiKey`（API キーマスク表示） |
| `../logger` | ログ出力 |

### 設計ノート

- readline を直接使用している理由は、`inquirer` 等の対話ライブラリを追加依存に含めず軽量に保つため。
- 無効入力時はエラー終了せず既定値にフォールバックする寛容な設計。
- `finally` ブロックで `rl.close()` を保証し、標準入力のリーク防止。

---

## cli-run.ts

### 概要

デフォルトコマンド（モニタ起動）のアクションハンドラ。CLI オプション・環境変数・Config ファイル・デフォルト値の4層を優先順位に従って解決し、`AppConfig` を構築してから `startMonitor()` へ渡す。起動バナー表示・契約確認・テーマ読み込み・フォーマッタ初期化もここで行う。

### エクスポートAPI

```ts
interface RunMonitorOptions {
  apiKey?: string;
  classifications?: string;
  test?: string;
  keepExisting?: boolean;
  closeOthers?: boolean;
  mode?: string;
  debug: boolean;
}

async function runMonitor(opts: RunMonitorOptions): Promise<void>
function resetTerminalTitle(): void
```

- `runMonitor` — 設定解決・バリデーション・起動シーケンスの実行。
- `resetTerminalTitle` — ターミナルタイトルをデフォルトにリセット（ANSI OSC シーケンス）。シャットダウン時に `monitor.ts` から呼ばれる。

### 内部ロジック

#### 設定解決の優先順位（上位が優先）

| 設定項目 | CLI | 環境変数 | Config | デフォルト |
|---------|-----|---------|--------|-----------|
| `apiKey` | `--api-key` | `DMDATA_API_KEY` | `fileConfig.apiKey` | — |
| `classifications` | `-c` | — | `fileConfig.classifications` | `DEFAULT_CONFIG.classifications` |
| `testMode` | `--test` | — | `fileConfig.testMode` | `DEFAULT_CONFIG.testMode` |
| `keepExistingConnections` | `--close-others` で `false` / `--keep-existing` で `true` | — | `fileConfig.keepExistingConnections` | `DEFAULT_CONFIG.keepExistingConnections` |
| `displayMode` | `--mode` | — | `fileConfig.displayMode` | `DEFAULT_CONFIG.displayMode` |

`--close-others` が `true` の場合、他のオプションに関わらず `keepExistingConnections` は `false` になる。

#### classifications のバリデーション

CLI からのカンマ区切り文字列をトークン分割し、`VALID_CLASSIFICATIONS` に含まれないものは警告ログの上で除外する。有効な区分が0件なら `process.exit(1)`。

#### 起動シーケンス

1. ログレベル設定（`--debug` 時）
2. Config ファイル読み込み
3. 各設定項目の解決・バリデーション
4. `AppConfig` オブジェクト構築
5. バナータイトル表示（`appName` + `VERSION`）
6. ターミナルタイトル設定
7. 契約状況チェック（`listContracts()`）— 未契約区分は除外、全滅なら `process.exit(1)`、API エラー時は警告のみで続行
8. テーマ読み込み（`loadTheme()`）— 警告があればログ出力
9. フォーマッタ初期化（`setFrameWidth`, `setInfoFullText`, `setDisplayMode`）
10. 起動バナー表示（`printBanner`）
11. 更新チェック（`checkForUpdates`、非ブロッキング）
12. `startMonitor(config)` 呼び出し

#### 内部関数

| 関数 | 説明 |
|------|------|
| `setTerminalTitle(title)` | ANSI OSC エスケープシーケンスでターミナルタイトルを設定（TTY 時のみ） |
| `printBanner(config)` | 受信区分・テストモード・表示モードをログ出力 |

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `chalk` | 色付き出力 |
| `../types` | `AppConfig`, `Classification`, `ConfigFile`, `DEFAULT_CONFIG` |
| `../config` | `loadConfig`, `getConfigPath`, `VALID_CLASSIFICATIONS` |
| `../dmdata/rest-client` | `listContracts` |
| `./monitor` | `startMonitor` |
| `../ui/formatter` | `setFrameWidth`, `setInfoFullText`, `setDisplayMode` |
| `../ui/theme` | `loadTheme` |
| `./update-checker` | `checkForUpdates` |
| `../logger` | ログ出力 |

### 設計ノート

- 契約確認の失敗は致命的エラーにしない。API が一時的に利用できないケースでも起動を試みる。
- `resetTerminalTitle` を export しているのは、`monitor.ts` のシャットダウン処理から呼び出すため。循環参照を回避する方向（monitor が cli-run を import）で依存が流れている。

---

## monitor.ts

### 概要

アプリケーションのメインオーケストレーションを担う。`WebSocketManager` による接続管理、メッセージルーティング、REPL 起動、グレースフルシャットダウンを統合する。`startMonitor()` が呼ばれると、プロセス終了まで制御を保持する。

### エクスポートAPI

```ts
async function startMonitor(config: AppConfig): Promise<void>
```

WebSocket 接続・REPL 起動・シグナルハンドラ登録を行い、リアルタイム受信を開始する。

### 内部ロジック

#### 初期化フロー

1. `createMessageHandler()` でメッセージルーター・EEW ロガー・通知インスタンスを取得
2. EEW ログ設定を `config` から反映（`setEnabled`, `setFields`）
3. `WebSocketManager` を構築し、3つのコールバックを登録:
   - `onData` — メッセージルーターを呼び出し（REPL 表示制御付き）
   - `onConnected` — 再接続時の切断期間通知、接続状態の REPL 反映
   - `onDisconnected` — 切断時刻記録、REPL 状態更新
4. REPL ハンドラを dynamic import で遅延ロードし、先に起動（接続中もコマンド入力可能）
5. シグナルハンドラ登録（`SIGINT`, `SIGTERM`, 非 Windows なら `SIGHUP`）
6. `manager.connect()` でバックグラウンド接続開始

#### REPL 表示制御

`withReplDisplay()` ヘルパーが REPL のプロンプト表示を一時退避・復帰させる。メッセージ表示中はプロンプトを消し、表示後に復帰する。エラーが発生しても `finally` で復帰を保証する。

#### 再接続時の切断期間通知

`disconnectedAt` タイムスタンプを使い、再接続成功時に `gapStart 〜 gapEnd` の期間を警告表示する。この期間に受信できなかった電文がある可能性をユーザーに知らせる。

#### グレースフルシャットダウン

`shutdown()` は以下を順次実行する:

1. 二重呼び出し防止（`shuttingDown` フラグ）
2. EEW ログの全イベントクローズ + flush
3. REPL 停止
4. REST API 経由でソケットクローズ（3秒タイムアウト、失敗は無視）
5. `WebSocketManager.close()` でローカル WebSocket 切断
6. ターミナルタイトルリセット
7. `process.exit(0)`

ソケットクローズの API 呼び出しと `manager.close()` は並行実行される。API 経由のクローズはタイムアウトやネットワークエラーを無視し、次回起動時のクリーンアップに委ねる。

#### 内部関数

| 関数 | 説明 |
|------|------|
| `withReplDisplay(repl, action)` | REPL プロンプト退避→アクション実行→復帰 |
| `updateReplConnectionState(repl, connected)` | REPL の接続状態とプロンプトを更新 |

#### 定数

| 定数 | 値 | 説明 |
|------|-----|------|
| `SOCKET_CLOSE_TIMEOUT_MS` | `3000` | シャットダウン時のソケットクローズ API タイムアウト |

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `chalk` | 色付き出力 |
| `../types` | `AppConfig` |
| `../dmdata/ws-client` | `WebSocketManager` |
| `../dmdata/rest-client` | `closeSocket` |
| `./message-router` | `createMessageHandler` |
| `./cli-run` | `resetTerminalTitle` |
| `../ui/formatter` | `formatTimestamp` |
| `../ui/repl` | `ReplHandler`（型 import + dynamic import） |
| `../logger` | ログ出力 |

### 設計ノート

- REPL を接続完了前に起動するのは、接続中でもユーザーが `status` や `help` コマンドを使えるようにするため。
- `closeSocketViaApi` は `Promise.race` でタイムアウトを実装。シャットダウンが無限に待機することを防ぐ。
- `ReplHandler` の型を `import type` で静的インポートしつつ、クラス本体は `await import()` で遅延ロードする二段構え。型安全性とメモリ最適化を両立している。

---

## message-router.ts

### 概要

WebSocket 経由で受信した `WsDataMessage` を、電文の `classification` と `head.type` に基づいて適切なパーサ・表示関数・通知処理にルーティングするファクトリ関数を提供する。`createMessageHandler()` は内部状態（`EewTracker`, `EewEventLogger`, `Notifier`）を閉包に持つハンドラ関数を返す。

### エクスポートAPI

```ts
interface MessageHandlerResult {
  handler: (msg: WsDataMessage) => void;
  eewLogger: EewEventLogger;
  notifier: Notifier;
}

function createMessageHandler(): MessageHandlerResult
```

- `handler` — 受信メッセージをルーティングする関数。
- `eewLogger` — EEW ログ設定の変更用に外部公開。
- `notifier` — 通知設定の変更用に外部公開。

### 内部ロジック

#### ルーティング優先順位

1. **XML 以外** — `displayRawHeader()` でヘッダのみ表示
2. **`eew.forecast` / `eew.warning`** — EEW パス
   - `parseEewTelegram()` でパース
   - `EewTracker.update()` で重複検出・差分計算
   - 重複報はスキップ（デバッグログのみ）
   - `EewEventLogger.logReport()` でログ記録
   - 取消報なら `closeEvent("取消")`
   - 最終報（`nextAdvisory` あり）なら `closeEvent("最終報")` + `finalizeEvent()`
   - `displayEewInfo()` で表示、`notifier.notifyEew()` で通知
3. **`telegram.earthquake` + `VXSE56` / `VXSE60` / `VZSE40`** — テキスト系
   - `parseSeismicTextTelegram()` → `displaySeismicTextInfo()` → `notifier.notifySeismicText()`
4. **`telegram.earthquake` + `VXSE62`** — 長周期地震動観測
   - `parseLgObservationTelegram()` → `displayLgObservationInfo()` → `notifier.notifyLgObservation()`
5. **`telegram.earthquake` + `VXSE*`** — 地震情報
   - `parseEarthquakeTelegram()` → `displayEarthquakeInfo()` → `notifier.notifyEarthquake()`
6. **`telegram.earthquake` + `VTSE*`** — 津波情報
   - `parseTsunamiTelegram()` → `displayTsunamiInfo()` → `notifier.notifyTsunami()`
7. **`telegram.earthquake` + `VYSE*`** — 南海トラフ関連
   - `parseNankaiTroughTelegram()` → `displayNankaiTroughInfo()` → `notifier.notifyNankaiTrough()`
8. **それ以外** — `displayRawHeader()` フォールバック

全パスで共通して、パース失敗時は `displayRawHeader()` にフォールバックする。

#### EEW パスの状態管理

`EewTracker` の `onCleanup` コールバックに `eewLogger.closeEvent(eventId, "タイムアウト")` を設定し、10分間更新がないイベントのログを自動クローズする。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../types` | `WsDataMessage` |
| `../dmdata/telegram-parser` | 各種パーサ関数 |
| `../ui/formatter` | 各種表示関数、`displayRawHeader` |
| `./eew-tracker` | `EewTracker` |
| `./eew-logger` | `EewEventLogger` |
| `./notifier` | `Notifier` |
| `../logger` | ログ出力 |

### 設計ノート

- ファクトリ関数パターンを採用し、`EewTracker` 等の状態をクロージャに閉じ込めることで、テスト時にインスタンスを独立して生成できる。
- `eewLogger` と `notifier` を戻り値に含めるのは、REPL や monitor から設定変更するため。ルーティング関数自体は純粋なディスパッチに徹している。
- `headType.startsWith("VXSE")` によるプレフィックスマッチは、将来新しい VXSE 系電文タイプが追加された場合にも自動的に地震情報パスに入る拡張性を持つ。ただし `VXSE56`, `VXSE60`, `VXSE62` は先に個別マッチで分岐するため、意図しないルーティングにはならない。

---

## eew-tracker.ts

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

既知の EventID に対し、受信した報数が `lastSerial` 以下であれば重複と判定する。取消報は報数に関わらず重複としない。EventID が空の場合は常に新規扱い。

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
interface EewEvent {
  eventId: string;
  lastSerial: number;
  isWarning: boolean;
  isCancelled: boolean;
  isFinalized: boolean;
  lastUpdate: Date;
  previousInfo?: ParsedEewInfo;
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
| `../types` | `ParsedEewInfo` |
| `../utils/intensity` | `intensityToRank`（震度文字列の順序比較） |

### 設計ノート

- `finalizeEvent()` でエントリを即座に削除しないのは、最終報の後に遅延到着した重複報を正しくスキップするため。10分後の `cleanup()` で自然消滅する。
- `isWarning` は論理和で更新される（一度でも警報が発出されたら `true` を維持）。
- `Map<string, EewEvent>` による O(1) ルックアップで、同時多発地震のシナリオでもパフォーマンスを維持する。

---

## eew-logger.ts

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
| `../types` | `ParsedEewInfo`, `EewLogField` |
| `./eew-tracker` | `EewDiff`, `EewUpdateResult` |
| `../logger` | ログ出力 |

### 設計ノート

- Promise チェーンによる書き込み直列化は、ロックファイルやキューイングライブラリを使わない軽量な実装。同一イベントへの書き込み順序のみ保証し、異なるイベント間は並行して書き込む。
- `flush()` はシャットダウン時とテスト時に使用。失敗は呼び出し側で無視される（`monitor.ts` の `catch {}`）。
- ログフォーマットはプレーンテキストで、JSON ではない。人間が直接読むことを重視した設計。

---

## notifier.ts

### 概要

デスクトップ通知と通知音の発報を管理するクラス。電文タイプ別の通知メソッドを持ち、カテゴリ別の ON/OFF・一時ミュート・通知音の有効/無効を制御する。設定変更時は自動的に Config ファイルへ永続化する。

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
}
```

#### 定数

| 定数 | 説明 |
|------|------|
| `NOTIFY_CATEGORY_LABELS` | 通知カテゴリ（`eew`, `earthquake`, `tsunami`, `seismicText`, `nankaiTrough`, `lgObservation`）と日本語ラベルの対応 |

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

- 第1報（`result.isNew === true`）
- 予報から警報への切り替え（`previousInfo.isWarning === false` → `info.isWarning === true`）
- 取消報（`result.isCancelled === true`）
- 最終報（`info.nextAdvisory != null`）

続報は通知を送らず、ターミナル表示のみ行う設計。

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

`send(title, message, level?)` が以下を行う:

1. ミュート中なら即座に return
2. `node-notifier` でデスクトップ通知を送信（`sound: false`、通知音は別途制御）
3. `assets/icons/icon.png` が存在すればアイコンとして使用
4. `soundEnabled` かつ `level` 指定があれば `playSound(level)` を呼び出し
5. 通知送信エラーはデバッグログのみ

#### 設定の永続化

`persist()` は `loadConfig()` → 設定上書き → `saveConfig()` の流れで Config ファイルに書き込む。エラー時は `log.warn()` のみ。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `path`, `fs` | アイコンパス解決・存在確認 |
| `../types` | `NotifyCategory`, `NotifySettings`, 各種パース済み型, `DEFAULT_CONFIG` |
| `../config` | `loadConfig`, `saveConfig` |
| `./eew-tracker` | `EewUpdateResult` |
| `./sound-player` | `playSound`, `SoundLevel` |
| `./node-notifier-loader` | `loadNodeNotifier`, `NodeNotifierLike` |
| `../utils/intensity` | `intensityToRank` |
| `../logger` | ログ出力 |

### 設計ノート

- `node-notifier` の遅延ロードは、ライブラリが存在しない環境（minimal インストール等）でもアプリが起動できるようにするため。
- ミュート機構は時刻ベースで実装されており、タイマーは使わない。`isMuted()` 呼び出し時に期限切れを検出して自動解除するため、メモリリークの心配がない。
- 通知音の制御は `sound: false` で node-notifier のネイティブ音を無効化し、`playSound()` で独自にレベル別の音を鳴らす二段構え。

---

## update-checker.ts

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
| `../logger` | ログ出力 |
| `../config` | `getConfigDir`（キャッシュ保存先） |

### 設計ノート

- 外部ライブラリ（`update-notifier` 等）を使わず Node.js 標準の `https` モジュールで実装し、依存を最小化している。
- `checkForUpdates` が void を返す設計は意図的。起動フローをブロックしないことが最優先であり、更新通知は best-effort。
- キャッシュの書き込み失敗もサイレントに処理し、次回起動時に再チェックする設計。
- `isNewerVersion` と `isUpdateCheckDisabled` を export しているのはテスト容易性のため。
