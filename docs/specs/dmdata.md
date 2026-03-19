# dmdata モジュール仕様書

dmdata.jp との通信層を担う3ファイルの仕様。REST API クライアント、WebSocket 接続管理、電文パーサで構成される。

---

## rest-client.ts

### 概要

dmdata.jp REST API v2 のクライアント。契約確認・ソケット管理・地震履歴取得など、WebSocket 接続の前段階で必要な HTTP 操作を集約する。Node.js 標準の `https` モジュールを直接使い、外部 HTTP ライブラリへの依存を排除している。

設計意図として、WebSocket 接続前のソケット管理（既存ソケットのクリーンアップ、同時接続上限の回避）を `prepareAndStartSocket()` に一元化し、呼び出し側が複雑な前処理を意識しなくて済むようにしている。

### エクスポート API

#### `listContracts(apiKey: string): Promise<string[]>`

契約一覧を取得し、有効な（`isValid === true`）区分の `classification` 文字列配列を返す。

#### `listEarthquakes(apiKey: string, limit?: number): Promise<GdEarthquakeListResponse>`

地震履歴を取得する。`limit` のデフォルトは `10`。

#### `listSockets(apiKey: string): Promise<SocketListResponse>`

ステータスが `open` の既存ソケット一覧を取得する。

#### `closeSocket(apiKey: string, socketId: number): Promise<void>`

指定ソケットを DELETE で閉じる。失敗時はエラーを throw せず `log.warn` で記録する。

#### `startSocket(config: AppConfig): Promise<SocketStartResponse>`

`POST /v2/socket` で WebSocket 接続用チケットを取得する。リクエストボディには `classifications`, `test`, `appName`, `formatMode: "raw"` を含む。

#### `prepareAndStartSocket(config: AppConfig, previousSocketId?: number): Promise<SocketStartResponse>`

既存ソケットのクリーンアップを行ってから `startSocket()` を呼ぶ。ソケット管理のメインエントリポイント。動作は `config.keepExistingConnections` と `previousSocketId` の組み合わせで分岐する:

| `keepExistingConnections` | `previousSocketId` | 動作 |
|---|---|---|
| `false` | - | 同一 `appName` のオープンソケットをすべて閉じる |
| `true` | あり | 指定の旧ソケットのみ閉じる（再接続時） |
| `true` | なし | 同一 `appName` の残留ソケットをクリーンアップ（初回起動時） |

ソケットを閉じた場合、`awaitSocketCleanup()` でサーバー側の削除反映を待ってから新規作成する。これにより、反映前に新規ソケットを作成して同時接続上限を超過し、他デバイスが切断される問題を防ぐ。

### 内部ロジック

#### `request(method, url, apiKey, body?): Promise<unknown>`

すべての API 呼び出しの基盤。`https.request` を Promise でラップし、以下を処理する:

- Basic 認証ヘッダーの付与（`apiKey:` を base64 エンコード、パスワード部分は空）
- `Content-Type: application/json` / `Accept: application/json` ヘッダー
- 15秒のリクエストタイムアウト (`REQUEST_TIMEOUT_MS`)
- 204 No Content の正常扱い
- Content-Type の JSON チェック
- HTTP ステータスコード検証（2xx 以外はエラー）
- レスポンス JSON のパースとエラーメッセージ抽出

#### `getKeepAliveAgent(): https.Agent`

TLS ハンドシェイクを再利用する keep-alive エージェントを遅延初期化で提供する。モジュールレベルの `keepAliveAgent` 変数にキャッシュされ、全リクエストで共有される。

#### `awaitSocketCleanup(apiKey, closedIds): Promise<void>`

ソケット削除のサーバー反映をポーリングで確認する。最大5回 (`SOCKET_CLEANUP_MAX_RETRIES`)、500ms間隔 (`SOCKET_CLEANUP_RETRY_INTERVAL_MS`) でリトライし、閉じた ID がすべて消えるのを待つ。確認できなくても警告を出して続行する。

### 依存関係

- **インポート元**: `https` (Node.js 標準), `../types` (`AppConfig`, `SocketStartResponse`, `SocketListResponse`, `ContractListResponse`, `GdEarthquakeListResponse`), `../logger`
- **接続先**: `ws-client.ts` の `WebSocketManager` から `prepareAndStartSocket()` が呼ばれる

### 設計ノート

- `https` モジュールを直接使用し、`node-fetch` や `axios` に依存しない。依存を最小限に抑え、CLI ツールの軽量性を維持するための選択。
- 認証方式は dmdata.jp 推奨の Basic 認証（ユーザー名に API キー、パスワードは空文字列）。
- `closeSocket()` はエラーを throw しない設計。既にサーバー側で閉じられている場合（404）など、クリーンアップ中のエラーは致命的でないため。
- `prepareAndStartSocket()` は `appName` でフィルタリングし、他デバイス（異なる appName）のソケットを誤って閉じないようにしている。

---

## endpoint-selector.ts

### 概要

WebSocket エンドポイントの選択・フェイルオーバーを担うクラス。サーバー再起動時のダウンタイムを最小化するため、切断時に別リージョンへの再接続を誘導する。

dmdata.jp は東京 (`ws-tokyo.api.dmdata.jp`) と大阪 (`ws-osaka.api.dmdata.jp`) の 2 リージョン構成で、個別サーバー (`ws001`〜`ws004`) も存在する。`EndpointSelector` は失敗ホストのクールダウン管理とリージョン間フェイルオーバーを行う。

### エクスポート API

#### `EndpointSelector` (class)

##### `recordConnected(wsUrl: string): void`

接続成功時に呼ぶ。URL からホスト名を抽出して記録する。

##### `recordDisconnected(): void`

切断時に呼ぶ。直前の接続先ホストを失敗記録に追加し、クールダウンを設定する。

##### `resolveUrl(originalUrl: string): string`

Socket Start レスポンスの URL を受け取り、必要に応じてホスト名を差し替える。

- 返却ホストがクールダウン中、または直前の失敗ホストと同じ → 反対リージョンに差し替え
- 反対リージョンもクールダウン中 → 元の URL をそのまま返す
- それ以外 → そのまま返す

### 内部ロジック

#### リージョンマッピング

| ホスト | リージョン |
|---|---|
| `ws001.api.dmdata.jp`, `ws002.api.dmdata.jp`, `ws-tokyo.api.dmdata.jp` | tokyo |
| `ws003.api.dmdata.jp`, `ws004.api.dmdata.jp`, `ws-osaka.api.dmdata.jp` | osaka |
| `ws.api.dmdata.jp`, その他 | tokyo (デフォルト) |

#### クールダウン

- 初期値: 120秒 (`INITIAL_COOLDOWN_MS`)
- 時間窓 (10分) 内に同一ホストが再度失敗 → クールダウンを 2.5 倍に延長
- 上限: 900秒 (`MAX_COOLDOWN_MS`)
- 期限切れの失敗記録は `resolveUrl()` 呼び出し時に自動削除

#### ホスト差し替え

URL のホスト名のみを差し替え、パス・クエリパラメータ（ticket 等）は保持する。

### 依存関係

- **インポート元**: `../logger`
- **利用元**: `ws-client.ts` の `WebSocketManager` がインスタンスを保持

---

## ws-client.ts

### 概要

dmdata.jp WebSocket API v2 の接続管理クラス。接続・切断・再接続・Ping-Pong によるヘルスチェックを担う。イベント駆動設計で、受信データの処理は呼び出し側に委譲する。

`WebSocketManager` は接続のライフサイクル全体を管理し、障害発生時には指数バックオフで自動再接続を行う。古いソケットのイベント遅延到着に対するガード（`this.ws !== socket` チェック）により、接続の切り替え時の競合状態を防止している。再接続時は `EndpointSelector` によるリージョン間フェイルオーバーで、失敗ホストを回避して別リージョンのサーバーへ接続する。

### エクスポート API

#### `WsManagerStatus` (interface)

```typescript
{
  connected: boolean;
  socketId: number | null;
  reconnectAttempt: number;
  heartbeatDeadlineAt: number | null;
}
```

#### `WsManagerEvents` (interface)

```typescript
{
  onData: (msg: WsDataMessage) => void;
  onConnected: () => void;
  onDisconnected: (reason: string) => void;
}
```

#### `WebSocketManager` (class)

##### `constructor(config: AppConfig, events: WsManagerEvents)`

設定とイベントハンドラを受け取って初期化する。この時点では接続は開始しない。

##### `connect(): Promise<void>`

接続を開始する。`shouldRun` フラグを `true` に設定し、`doConnect()` を呼ぶ。

##### `getStatus(): WsManagerStatus`

現在の接続状態を返す。`connected` は WebSocket の `readyState` が `OPEN` かどうかで判定する。

##### `close(): void`

接続を明示的に停止する。`shouldRun` を `false` に設定し、タイマーをクリアし、WebSocket を close code `1000` で閉じる。再接続は行われない。

### 内部ロジック

#### 接続フロー

1. `doConnect()` が `prepareAndStartSocket()` を呼び、WebSocket URL（チケット付き）を取得
2. `EndpointSelector.resolveUrl()` で URL のホスト名を必要に応じて差し替え（失敗ホスト回避）
3. `ws` パッケージでサブプロトコル `dmdata.v2` を指定して接続
4. `open` イベントで `reconnectAttempt` をリセットし、`EndpointSelector.recordConnected()` でホストを記録、ハートビートを開始、`onConnected` を発火
5. `message` イベントで `handleMessage()` を呼ぶ

#### メッセージ処理 (`handleMessage`)

受信データを JSON パースし、`type` フィールドで分岐する:

| `type` | 処理 |
|---|---|
| `start` | `socketId` を記録、区分をログ出力 |
| `ping` | ハートビートリセット、Pong を返送 |
| `pong` | デバッグログのみ |
| `data` | ハートビートリセット、`onData` イベント発火 |
| `error` | サーバーエラーをログ出力 |

各メッセージタイプにはランタイム型ガード関数（`isWsDataMessage`, `isWsStartMessage`, `isWsPingMessage`）があり、必須フィールドの存在を検証する。

#### ハートビート (`resetHeartbeat`)

サーバーからの ping または data 受信時にタイマーをリセットする。90秒間 (`HEARTBEAT_TIMEOUT_MS`) ping を受信しなければ、close code `4000` で接続を切断し、再接続に移行する。

#### 再接続 (`scheduleReconnect`)

指数バックオフ方式: `2^(attempt-1)` 秒を基本遅延とし、`config.maxReconnectDelaySec` を上限とする。加えて 0〜1秒のランダムジッター (`RECONNECT_JITTER_MS`) を加算する。`shouldRun` が `false` の場合はスケジュールしない。重複タイマーの防止チェックあり。

#### 切断・エラー処理

`close` / `error` イベントでは以下を行う:

1. タイマーのクリア
2. `ws` を `null` に設定
3. `previousSocketId` に現在の `socketId` を退避（再接続時の旧ソケットクローズ用）
4. `EndpointSelector.recordDisconnected()` で失敗ホストを記録
5. `onDisconnected` イベント発火
6. `scheduleReconnect()` で再接続をスケジュール

#### `normalizeWsData(raw: WebSocket.Data): string`

`WebSocket.Data` は `string | Buffer | ArrayBuffer | Buffer[]` のいずれかになり得るため、すべてのケースを `string` に変換するユーティリティ。static メソッドとして定義。

### 依存関係

- **インポート元**: `ws` (WebSocket クライアント), `../types` (`AppConfig`, `WsDataMessage`, `WsStartMessage`, `WsPingMessage`), `./rest-client` (`prepareAndStartSocket`), `./endpoint-selector` (`EndpointSelector`), `../logger`
- **接続先**: `engine/monitor/monitor.ts` から `WebSocketManager` がインスタンス化される

### 設計ノート

- 古いソケットのイベント遅延到着に対して `this.ws !== socket` でガードしている。再接続で新しいソケットが作られた後に、古いソケットの `close` や `message` が到着するケースへの対策。
- `previousSocketId` を保持することで、再接続時に `prepareAndStartSocket()` が旧ソケットだけを閉じられるようにしている。
- サーバーエラーメッセージの形式が2パターン（オブジェクト形式 `{ error: { message, code } }` と文字列形式 `{ error: "...", code: 4808 }`）あるため、`logServerError()` で両方に対応。
- `WebSocketManager` は `ConnectionManager` インターフェースを実装しており、`MultiConnectionManager` や `shutdown.ts` から抽象的に扱える。

---

## connection-manager.ts

### 概要

WebSocket 接続管理の共通インターフェース定義。単一接続 (`WebSocketManager`) と複線接続 (`MultiConnectionManager`) の両方がこのインターフェースを実装する。

### エクスポート API

#### `ConnectionManager` (interface)

```typescript
{
  connect(): Promise<void>;
  getStatus(): WsManagerStatus;
  close(): void;
}
```

シンプルに 3 メソッドのみを公開する。`WsManagerEvents` はコンストラクタ引数であり、インターフェースには含めない。

### 依存関係

- **インポート元**: `./ws-client` (`WsManagerStatus`)
- **利用元**: `ws-client.ts`, `multi-connection-manager.ts`, `engine/monitor/shutdown.ts`, `ui/repl.ts`, `engine/monitor/monitor.ts`

---

## multi-connection-manager.ts

### 概要

複線接続管理。primary (通常回線) に加え、backup (EEW 副回線) を動的に起動/停止できる `ConnectionManager` 実装。backup からの受信は `msg.id` で重複排除した上で、同じ `onData` イベントに委譲する。

dmdata.jp の同時接続上限は 2 本。Raspberry Pi 500 などでの常時稼働を想定し、通常は 1 本で運用しつつ、EEW の受信冗長性を高めたい場合に副回線を追加起動する。

### エクスポート API

#### `MultiConnectionManager` (class implements ConnectionManager)

##### `connect(): Promise<void>`

primary の接続を開始する。

##### `getStatus(): WsManagerStatus`

primary の接続状態を返す。

##### `close(): void`

primary と backup の両方を停止する。

##### `getAllSocketIds(): number[]`

全ソケットの ID を配列で返す。シャットダウン時の API クローズで使用される。

##### `getBackupStatus(): WsManagerStatus | null`

backup の接続状態を返す。未起動時は `null`。

##### `isBackupRunning(): boolean`

backup が起動中かどうかを返す。

##### `startBackup(): Promise<StartBackupResult>`

EEW 副回線を起動する。戻り値で起動結果を返す (`"started"` / `"already_running"` / `"no_eew_contract"`)。config の `classifications` から EEW 区分 (`eew.forecast`, `eew.warning`) との積集合を取り、該当する区分がなければ `"no_eew_contract"` を返して起動しない。

backup 用の config は以下をオーバーライドする:
- `classifications`: EEW 区分のみ
- `appName`: `${config.appName}-backup` (primary と区別)
- `keepExistingConnections`: `true` (primary を維持するため)

##### `stopBackup(): void`

EEW 副回線を停止する。

### 内部ロジック

#### 重複排除 (`handleData`)

`msg.id` による FIFO window (最大 500 件、古い id を先頭から削除)。primary と backup の両方からの `onData` がここを経由し、重複する電文は排除される。dmdata の `id` はグローバルユニークなので、`msg.id` 単独で十分。

#### backup イベント

backup の `onConnected` / `onDisconnected` はログのみ (`log.info` / `log.warn`)。monitor の `disconnectedAt` やプロンプトの接続状態には影響させない。

#### stale backup cleanup

`startBackup()` 内で `prepareAndStartSocket()` が `appName-backup` の既存ソケットを自動クリーンアップする (既存ロジックで対応済み)。

### 依存関係

- **インポート元**: `../types` (`AppConfig`, `WsDataMessage`, `Classification`), `./connection-manager` (`ConnectionManager`), `./ws-client` (`WebSocketManager`, `WsManagerStatus`, `WsManagerEvents`), `../logger`
- **接続先**: `engine/monitor/monitor.ts` から `MultiConnectionManager` がインスタンス化される

### 設計ノート

- config clone はスプレッドコピー (`{ ...this.config, ... }`) で行い、元の config を汚染しない。
- backup の classifications を `this.config.classifications` との積集合にすることで、契約していない区分を指定してしまうリスクを排除。
- `SEEN_IDS_MAX = 500` は dmdata の通常トラフィック量に対して十分な余裕を持たせた値。EEW は最大でも数十件/分程度のため、500 件で古いエントリが削除されても問題ない。

---

## telegram-parser.ts

### 概要

dmdata.jp から受信した電文（XML 形式）をデコード・パースし、アプリケーションで使用する型付きオブジェクトに変換する。電文タイプごとに専用のパース関数を提供する。

body フィールドは base64 + gzip で圧縮されている場合があるため、まずデコード・展開してから XML パースを行う。XML 構造は気象庁 XML フォーマットに準拠しており、名前空間プレフィックス（`jmx:`, `jmx_eb:` 等）の有無が電文によって異なるため、複数のパスを試行してノードを探索する設計になっている。

### エクスポート API

#### `decodeBody(msg: WsDataMessage): string`

`WsDataMessage` の `body` フィールドをデコードして XML 文字列を返す。

- `msg.encoding` が `"base64"` の場合は base64 デコード、それ以外は UTF-8 として扱う
- `msg.compression` が `"gzip"` の場合は `zlib.gunzipSync`、`"zip"` の場合は `zlib.unzipSync` で展開
- 展開後のサイズが 10MB (`MAX_DECOMPRESSED_BYTES`) を超えた場合はエラーを throw

#### `parseXml(xmlStr: string): Record<string, unknown>`

XML 文字列を `fast-xml-parser` でパースし、JavaScript オブジェクトとして返す。

#### `parseEarthquakeTelegram(msg: WsDataMessage): ParsedEarthquakeInfo | null`

地震関連電文（VXSE51/52/53/61）をパースする。震源情報、震度観測、津波コメントを抽出する。

#### `parseEewTelegram(msg: WsDataMessage): ParsedEewInfo | null`

緊急地震速報電文（VXSE43/44/45）をパースする。震源情報、予測震度地域、仮定震源要素の検出、最終報判定（`NextAdvisory`）を行う。

#### `parseTsunamiTelegram(msg: WsDataMessage): ParsedTsunamiInfo | null`

津波電文（VTSE41/51/52）をパースする。津波予報区ごとの予測（種別、最大波高、第一波到達時刻）、観測データ、推計データ、震源情報を抽出する。

#### `parseSeismicTextTelegram(msg: WsDataMessage): ParsedSeismicTextInfo | null`

地震活動テキスト電文（VXSE56/VXSE60/VZSE40）をパースする。構造化データを持たないテキスト主体の電文のため、`Body > Text` を `bodyText` として抽出する。

#### `parseNankaiTroughTelegram(msg: WsDataMessage): ParsedNankaiTroughInfo | null`

南海トラフ関連電文（VYSE50/51/52/60）をパースする。`EarthquakeInfo` ノードの有無で発表電文と取消電文を判別する。`InfoSerial`（情報番号の名称とコード）がある場合は抽出する。

#### `parseLgObservationTelegram(msg: WsDataMessage): ParsedLgObservationInfo | null`

長周期地震動観測情報（VXSE62）をパースする。震源情報、最大震度、最大長周期地震動階級、長周期地震動階級カテゴリ、地域ごとの観測値、コメント、詳細 URI を抽出する。

### 内部ロジック

#### XML パーサ設定

`fast-xml-parser` の `XMLParser` をモジュールレベルでシングルトン生成する。設定:

- `ignoreAttributes: false` — XML 属性を保持
- `attributeNamePrefix: "@_"` — 属性名に `@_` プレフィックス
- `textNodeName: "#text"` — テキストノードのキー名
- `isArray` — `Pref`, `Area`, `City`, `IntensityStation`, `Item`, `Kind`, `Category`, `ForecastInt`, `Observation`, `Station`, `Estimation` は常に配列として扱う（要素が1つでも配列化することで、下流の処理を統一する）

#### ヘルパー関数群

##### `dig(obj, ...keys): unknown`

ネストされたオブジェクトを安全に掘り下げるユーティリティ。途中で `null` / `undefined` に遭遇すると `undefined` を返す。XML の深い階層構造を簡潔にアクセスするために頻用される。

##### `str(val): string`

`null` / `undefined` を空文字列に変換する。それ以外は `String()` で文字列化する。

##### `first<T>(val: T | T[]): T`

配列なら先頭要素、そうでなければそのまま返す。`isArray` 設定との組み合わせで、単一要素の配列を透過的に処理する。

#### 震源情報の抽出 (`extractEarthquake`)

`Earthquake` ノードから `OriginTime`, `Hypocenter > Area > Name`, 座標, マグニチュードを抽出する。座標文字列とマグニチュードは名前空間プレフィックスの有無（`jmx_eb:Coordinate` / `Coordinate`, `jmx_eb:Magnitude` / `Magnitude`）の両方を試行する。

#### 座標パース (`parseCoordinate`)

気象庁 XML の座標形式 `"+35.7+139.8-10000/"` をパースする。深さはメートル単位（1000以上）とキロメートル単位の両方に対応し、`depthKm >= 1000` の場合は1000で割る。深さが0の場合は `"ごく浅い"` と表現する。

#### 仮定震源要素の検出

EEW 電文で震源が確定していない場合の検出を2段階で行う:

1. **Condition フィールド**: `Earthquake > Condition` に「仮定震源要素」を含むか（`isAssumedHypocenterCondition`）
2. **フォールバックパターン**: マグニチュード1.0 かつ 深さ10km で、`maxIntChangeReason` が 9 または PLUM法地域が存在する場合（`isAssumedHypocenterFallbackPattern`）

いずれかが真なら `isAssumedHypocenter: true` となる。

#### PLUM法・主要動到達の検出

EEW 予測地域の `Condition` フィールドから以下を検出する:

- `isPlumAreaCondition`: 「PLUM法」を含むか
- `hasArrivedAreaCondition`: 「既に主要動到達」を含むか

いずれも NFKC 正規化と空白除去 (`normalizeConditionText`) を適用してから判定する。

#### 津波情報の抽出

津波電文では以下の3種類のデータを抽出する:

- **予報 (Forecast)**: `Tsunami > Forecast > Item` から津波予報区ごとの種別・最大波高・第一波到達時刻
- **観測 (Observation)**: `Tsunami > Observation > Item > Station` から観測点ごとの到達時刻・初動・最大波高状態
- **推計 (Estimation)**: `Tsunami > Estimation > Item` から推計対象地域ごとの最大波高・第一波情報

#### 長周期地震動観測の抽出 (`extractLgObservationDetails`)

`Intensity > Observation` から最大震度、最大長周期地震動階級、長周期地震動階級カテゴリを取得し、`Pref > Area` を走査して `MaxLgInt` を持つ地域のみを `areas` に格納する。

### 依存関係

- **インポート元**: `zlib` (Node.js 標準), `fast-xml-parser` (`XMLParser`), `../types` (`WsDataMessage`, `ParsedEarthquakeInfo`, `ParsedEewInfo`, `ParsedTsunamiInfo`, `ParsedSeismicTextInfo`, `ParsedNankaiTroughInfo`, `ParsedLgObservationInfo`, `LgObservationArea`, `TsunamiForecastItem`, `TsunamiObservationStation`, `TsunamiEstimationItem`), `../logger`
- **接続先**: `engine/messages/message-router.ts` から各パース関数が呼ばれる

### 設計ノート

- XML の名前空間プレフィックス (`jmx:`, `jmx_eb:`, `jmx_seis:`) の有無が電文によって異なるため、`dig()` で複数パスを試行する設計になっている。`Report` ノードの検索でも `Report`, `jmx:Report`, `jmx_seis:Report` の3パターンを試す。
- `isArray` 設定で特定タグを常に配列化することで、XML の「要素が1つだとオブジェクト、複数だと配列」という挙動の揺れを吸収している。これにより下流のコードで `Array.isArray` チェックを省略できる。
- すべてのパース関数は try-catch で囲み、パースエラー時は `null` を返す設計。呼び出し側でエラーハンドリングの負担を軽減し、1つの電文のパース失敗がアプリ全体を停止させないようにしている。
- 展開後サイズの上限 (`MAX_DECOMPRESSED_BYTES = 10MB`) は、悪意のある圧縮爆弾やメモリ枯渇に対する防御。`zlib.gunzipSync` の `maxOutputLength` オプションと展開後の再チェックの二重ガードで保護している。
