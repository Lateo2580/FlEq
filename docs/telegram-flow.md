# 電文受信から表示までのフロー

電文が dmdata.jp サーバーから届き、ターミナルに色付き表示されるまでの全過程を解説する。

## 全体像

```
dmdata.jp サーバー
  ↓ WebSocket (JSON)
WsDataMessage { body: "base64+gzip文字列", head: { type, ... }, ... }
  ↓ decodeBody()
XML 文字列 (気象庁フォーマット)
  ↓ parseXml()
JS オブジェクト (Report > Head + Body)
  ↓ parse*Telegram()
型付き構造体 (ParsedEarthquakeInfo, ParsedEewInfo, ...)
  ↓ display*Info()
RenderBuffer (マーキング付き行配列)
  ↓ flushWithRecap()
console.log → ターミナル (ANSI色付き)
```

---

## Phase 1: WebSocket 接続の確立

### 起点: `engine/monitor/monitor.ts` — `startMonitor()`

1. `createMessageHandler()` で電文ハンドラ一式を生成
   - 内包するオブジェクト: `EewTracker`, `EewEventLogger`, `Notifier`, `TsunamiStateHolder`, `VolcanoStateHolder`
2. `MultiConnectionManager` を生成し、3つのコールバックを登録
   - `onData` — 電文受信時
   - `onConnected` — 接続確立時
   - `onDisconnected` — 切断時
3. REPL を遅延ロード (`await import("../../ui/repl")`) し起動
4. 津波・火山の既存警報状態を REST API で復元 (`restoreTsunamiState`, `restoreVolcanoState`)
5. `manager.connect()` で WebSocket 接続を開始

### 接続処理: `dmdata/ws-client.ts` — `doConnect()`

1. `prepareAndStartSocket()` (REST API) で dmdata.jp に Socket Start リクエストを送信し、WebSocket URL + チケットを取得
2. `EndpointSelector` が URL を選択（リージョン間フェイルオーバー対応）
3. `new WebSocket(wsUrl, ["dmdata.v2"])` でプロトコル `dmdata.v2` を指定して接続
4. `open` イベントで `onConnected` コールバック発火、ハートビートタイマー (90秒) 開始

---

## Phase 2: メッセージ受信と振り分け

### WebSocket メッセージ着信: `dmdata/ws-client.ts` — `handleMessage()`

#### Step 2a: 正規化

`normalizeWsData()` が `WebSocket.Data` 型（string / Buffer / ArrayBuffer / Buffer[]）を UTF-8 文字列に統一する。

#### Step 2b: JSON パース

`JSON.parse(text)` でオブジェクト化。パース失敗時はエラーログを出して終了。

#### Step 2c: メッセージタイプ分岐

トップレベルの `type` フィールドで処理を分岐する。

| `type` | 処理 |
|--------|------|
| `"start"` | セッション情報の記録 (socketId, classifications) |
| `"ping"` | ハートビートリセット + `pong` 返送 |
| `"pong"` | デバッグログのみ |
| `"data"` | **電文処理へ** (`handleDataMessage`) |
| `"error"` | サーバーエラーログ出力 |

#### Step 2d: data メッセージの検証

`isWsDataMessage()` で `id`, `head`, `head.type` の存在を確認。不正な場合は警告ログを出して終了。

#### Step 2e: コールバック発火

検証を通過したら `events.onData(parsed)` を呼び出し、`monitor.ts` の `onData` コールバックへ制御を渡す。

---

## Phase 3: REPL 協調と電文ルーティング

### REPL 表示協調: `engine/monitor/repl-coordinator.ts` — `withReplDisplay()`

```typescript
onData: (msg) => {
  withReplDisplay(replHandler, () => routeMessage(msg));
}
```

1. `repl.beforeDisplayMessage()` — REPL のプロンプト入力行を一時的にクリア（電文表示と入力行が混ざらないように）
2. `routeMessage(msg)` を実行（電文処理本体）
3. `repl.afterDisplayMessage()` — プロンプトを再描画

エラーが発生しても `finally` で必ずプロンプトが復帰する。

### 電文ルーティング: `engine/messages/message-router.ts` — `handler()`

#### Step 3a: XML チェック

`msg.format !== "xml"` または `msg.head.xml` がない場合は `displayRawHeader()` でヘッダのみ表示して終了。

#### Step 3b: ルート判定

`classifyMessage(classification, headType)` が `classification` と `head.type` から8種のルートに分岐する。

| classification | head.type | Route |
|----------------|-----------|-------|
| `eew.forecast` / `eew.warning` | VXSE43/44/45 | `"eew"` |
| `telegram.volcano` | VFVO50〜VZVO40 | `"volcano"` |
| `telegram.earthquake` | VXSE56/VXSE60/VZSE40 | `"seismicText"` |
| `telegram.earthquake` | VXSE62 | `"lgObservation"` |
| `telegram.earthquake` | VXSE* | `"earthquake"` |
| `telegram.earthquake` | VTSE* | `"tsunami"` |
| `telegram.earthquake` | VYSE* | `"nankaiTrough"` |
| その他 | — | `"raw"` |

判定順序が重要で、`telegram.volcano` は `telegram.earthquake` より先に評価される。`telegram.earthquake` 内では `VXSE56`/`VXSE60`/`VZSE40` (テキスト系) → `VXSE62` (長周期) → `VXSE*` (地震) → `VTSE*` (津波) → `VYSE*` (南海トラフ) の順。

#### Step 3c: ルート別ハンドラ呼び出し

`switch (route)` で対応する `handle*()` 関数へ委譲する。

---

## Phase 4: XML デコードとパース

各ルートの `handle*` 関数の内部で共通の2段階処理が行われる。

### Step 4a: バイナリデコード — `dmdata/telegram-parser.ts` — `decodeBody()`

```
msg.body (文字列)
  → Base64デコード (msg.encoding === "base64" の場合)
  → gzip/zip 展開 (msg.compression に応じて)
  → UTF-8 文字列化
```

- 展開後サイズが **10MB** を超えると例外を投げる
- 圧縮なしの場合はそのまま UTF-8 変換

### Step 4b: XML パース — `dmdata/telegram-parser.ts` — `parseXml()`

`fast-xml-parser` で JS オブジェクトに変換する。パーサ設定:

| 設定 | 値 | 説明 |
|------|----|------|
| `ignoreAttributes` | `false` | XML 属性を保持する |
| `attributeNamePrefix` | `"@_"` | 属性名に `@_` プレフィックスを付ける |
| `textNodeName` | `"#text"` | テキストノードのキー名 |
| `isArray` | (関数) | `Pref`, `Area`, `City`, `Item`, `Station` 等のタグを常に配列化 |

`isArray` が重要で、単一要素でも配列として扱うことでパース結果の構造を統一している。

### Step 4c: 構造化データ抽出

パース後の JS オブジェクトから `dig()` ヘルパーで安全にプロパティを辿り、型付きオブジェクトに変換する。

`dig(obj, ...keys)` はネストされたプロパティに安全にアクセスし、途中で `null` / `undefined` に遭遇した場合は `undefined` を返す。

#### 地震電文の場合の抽出パス

```
Report > Head → title, infoType, reportDateTime, headline
Report > Body > Earthquake > Hypocenter > Area → 震源名, 座標
Report > Body > Earthquake > Magnitude → マグニチュード
Report > Body > Intensity > Observation > Pref > Area → 震度観測地域リスト
Report > Body > Comments > ForecastComment > Text → 津波コメント
```

#### 座標変換

座標は `"+35.7+139.8-10000/"` 形式で格納されている。`parseCoordinate()` で以下のように変換:

- `+35.7` → `N35.7` (北緯)
- `+139.8` → `E139.8` (東経)
- `-10000` → `10km` (深さ。メートル単位なら 1000 で割る)
- 深さ 0 → `"ごく浅い"`

---

## Phase 5: 追加ロジック（ルートごとの固有処理）

各ルートにはパースと表示の間に固有のロジックが挟まる。

### EEW パス — `handleEew()`

1. **重複検出**: `EewTracker.update(eewInfo)` が EventID + Serial で重複を判定
   - 重複報の場合 → デバッグログを出して **処理終了** (表示しない)
   - 非重複報の場合 → `isDuplicate: false` と共に `activeCount` (同時発生数), `diff` (前報との差分), `colorIndex` (表示色) を返す
2. **ログ記録**: `EewEventLogger.logReport()` がファイルに記録
3. **取消報処理**: `isCancelled === true` ならログをクローズ
4. **最終報処理**: `nextAdvisory` が存在し取消でなければ、ログクローズ + `eewTracker.finalizeEvent()` でイベント終了

### 津波パス — `handleTsunami()`

- VTSE41 (津波警報・注意報) の場合のみ `TsunamiStateHolder.update()` で内部状態を更新
- REPL プロンプトに津波警報の有無を反映するために使用される

### 火山パス — `handleVolcano()`

1. **表示/通知レベル判定**: `resolveVolcanoPresentation()` が火山の電文種別・レベル・過去の通知状態から `FrameLevel` と通知レベルを決定
2. **表示**: `displayVolcanoInfo()` に判定結果を渡す
3. **状態更新**: 表示後に `VolcanoStateHolder.update()` で状態更新

### その他のパス

地震・テキスト系・長周期・南海トラフの各パスはシンプルに「パース → 表示 → 通知」の3ステップ。パースが `null` を返した場合は `displayRawHeader()` にフォールバックする。

---

## Phase 6: ターミナル表示

各 `display*` 関数 (`ui/eew-formatter.ts`, `ui/earthquake-formatter.ts`, `ui/volcano-formatter.ts`) は共通の構造を持つ。

### Step 6a: RenderBuffer の構築

`createRenderBuffer()` で行バッファを作成する。各行には種別マーキングが付く:

| メソッド | 種別 | 用途 |
|----------|------|------|
| `push(line)` | `"normal"` | 通常の行 |
| `pushEmpty()` | `"normal"` | 空行 |
| `pushTitle(line)` | `"title"` | タイトル行 (recap 用) |
| `pushCard(line)` | `"card"` | 要約カード行 (recap 用) |
| `pushHeadline(line)` | `"headline"` | ヘッドライン行 (recap 用) |

### Step 6b: FrameLevel の判定

表示フレームの色と装飾を決定する `FrameLevel`:

| FrameLevel | 条件例 |
|------------|--------|
| `critical` | 震度6弱以上, EEW警報, 大津波警報, 噴火速報 |
| `warning` | 震度4以上, EEW予報, 津波警報, 噴火情報 |
| `normal` | 一般的な地震情報 |
| `info` | テキスト系情報, 降灰定時 |
| `cancel` | 取消電文 |

### Step 6c: フレーム描画

`formatter.ts` の描画関数群でフレームを組み立てる:

```
frameTop(level, width)       → 色付き上枠線 ━━━━━━━
frameLine(level, text, width) → ┃ テキスト内容        ┃
frameDivider(level, width)    → 色付き区切線 ─────────
frameBottom(level, width)     → 色付き下枠線 ━━━━━━━
```

- **テーマシステム** (`ui/theme.ts`) がセマンティックロール名 → 色の解決を行う
- **chalk** で ANSI エスケープシーケンスを付加

### Step 6d: 表示モード分岐

| モード | 挙動 |
|--------|------|
| `normal` | フル表示 (headline, 観測地域すべて) |
| `compact` | headline や観測地域を省略 |

### Step 6e: 省略 (truncation)

- 観測地域リストが `maxObservations` 設定値を超えた場合 → `「他 N 地域」` と省略表示
- 電文タイプ別の `truncation` 設定に基づく上限 (REPL の `limit` コマンドで変更可能)

### Step 6f: recap 機能 — `flushWithRecap()`

ターミナルの行数よりバッファの行数が多い場合、フレーム下部の直前に「▼ サマリー」セクションを自動挿入する。

```
┃ ... (大量の観測地域)                           ┃
┃────────────────────────────────────────────────┃
┃ ▼ サマリー                                     ┃
┃ [タイトル行の再掲]                              ┃
┃ [カード行の再掲]                                ┃
┃ [ヘッドライン行の再掲]                          ┃
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

スクロールしなくても要点が見えるようにする仕組み。

### Step 6g: 出力

最終的にすべて `console.log()` で stdout に書き出す。

---

## Phase 7: 通知

表示処理と並行して `Notifier` がデスクトップ通知を送信する。

1. **カテゴリ別 ON/OFF チェック** — `eew`, `earthquake`, `tsunami`, `seismicText`, `nankaiTrough`, `lgObservation`, `volcano` ごとに有効/無効を判定
2. **node-notifier の遅延ロード** — optional dependency のため `node-notifier-loader.ts` で動的インポート
3. **OS ネイティブ通知** — タイトル・メッセージを構築して通知を表示
4. **通知音** — `sound-player.ts` が設定に応じてクロスプラットフォームで再生 (`assets/sounds/` のサウンドファイル、OS標準サウンドへのフォールバックあり)

---

## 関連ファイル一覧

| Phase | ファイル | 役割 |
|-------|---------|------|
| 1 | `engine/monitor/monitor.ts` | 起動・オーケストレーション |
| 1 | `dmdata/rest-client.ts` | REST API (Socket Start) |
| 1 | `dmdata/ws-client.ts` | WebSocket 接続管理 |
| 1 | `dmdata/endpoint-selector.ts` | エンドポイント選択 |
| 2 | `dmdata/ws-client.ts` | メッセージ受信・振り分け |
| 3 | `engine/monitor/repl-coordinator.ts` | REPL 表示協調 |
| 3 | `engine/messages/message-router.ts` | 電文ルーティング |
| 4 | `dmdata/telegram-parser.ts` | XML デコード・パース (地震/EEW/津波等) |
| 4 | `dmdata/volcano-parser.ts` | XML デコード・パース (火山) |
| 5 | `engine/eew/eew-tracker.ts` | EEW 重複検出・状態管理 |
| 5 | `engine/eew/eew-logger.ts` | EEW ログ記録 |
| 5 | `engine/messages/tsunami-state.ts` | 津波警報状態管理 |
| 5 | `engine/messages/volcano-state.ts` | 火山警報状態管理 |
| 5 | `engine/notification/volcano-presentation.ts` | 火山表示/通知レベル判定 |
| 6 | `ui/formatter.ts` | 共通表示 (フレーム描画・recap) |
| 6 | `ui/eew-formatter.ts` | EEW 表示 |
| 6 | `ui/earthquake-formatter.ts` | 地震・津波・テキスト・南海トラフ・長周期 表示 |
| 6 | `ui/volcano-formatter.ts` | 火山 表示 |
| 6 | `ui/theme.ts` | テーマシステム (カラーパレット・ロール定義) |
| 7 | `engine/notification/notifier.ts` | デスクトップ通知 |
| 7 | `engine/notification/node-notifier-loader.ts` | node-notifier 遅延ロード |
| 7 | `engine/notification/sound-player.ts` | 通知音再生 |
