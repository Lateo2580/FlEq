# 実電文リプレイ注入基盤（最小版）

> **裁定（2026-09-06、ご主人）**: §3 の方式は推奨案を採用する。追加裁定 **3A** により、Phase 1 は VPBS50 2 電文（予測→発生）を実 router → CLI → display で確認する範囲だけに固定する。独立 DOC レビュー（Sol high、新規 read-only スレッド）2 巡は DOC-OK。


Status: Phase 1 approved / scope locked by decision 3A

## 1. 目的と非対象

### 1.1 目的

Phase 1 の目的は一つだけである。既存の `VPBS50_HJPNA202608270258.xml`（線状降水帯の直前予測）と `VPBS50_HJPNB202608270308.xml`（発生）を、dmdata WebSocket の `WsDataMessage` と同じ封筒へ無改変で包み、引数順に本番 message router 入口へ注入し、本番 formatter の CLI 出力と実 HTTP/SSE display が「予測 → 発生」の置換を示すことを再現・機械確認する。既存 helper も同じ対を実受信として扱っている（`test/helpers/mock-message.ts:354-356`）。

Phase 1 は汎用 fixture replay の提供を目的にしない。受け付けるのは明示した 2 本・2 通・この順序だけであり、3 通以上の列、別の VPBS50 組合せ、別 head type、route 横断の TTL 整合は Phase 2 以降で改めて設計・監査する。ただし、この 2 通が到達する本番 router/CLI/display 経路は迂回せず、隔離、仮想 business time、SSE 同期点、quiescence は Phase 1 の成立条件とする。

本機能はローカル fixture を同一マシン上の自画面へ流すだけであり、dmdata の受信電文を第三者へ再配信せず、外部へ listen もしない（loopback bind 固定）。dmdata 利用規約は「ユーザー以外に配信・報知」を二次利用と定義し、気象庁情報は特則がない限り二次利用可能とする一方、個人契約等での EEW 公開 API・第三者表示等には別の制限を置いている（[dmdata 利用規約](https://dmdata.jp/terms/)）。従って「loopback だから規約対象外」とは断定せず、最小版の利用を契約ユーザー本人のローカル確認に限定する。fixture、snapshot、transcript、capture の共有・配布、LAN bind、外部 API 化は機能外とし、EEW fixture を対象に加える段階で契約種別と最新規約を再確認する。

### 1.2 現状との関係

現在の画面確認は次の二系統である。

- preview は frontend 単体の固定 snapshot であり、capture script も preview URL を対象にする（`display/scripts/capture-legacy-standby.mjs:3-8, 16-21`）。
- production gate は engine と実 Svelte component を同一 Vitest process で結ぶが、実 HTTP/SSE server と CLI 起動は通らない（`display/vitest.phase6b-production.config.ts:5-18`、`display/frontend/src/components/__tests__/phase6b-production-render.ts:14-31`）。

replay はこの二つを置き換えない。preview は速い視覚回帰、production gate は決定的な test を維持し、その間に「実 XML → 実 router → 実 CLI/display」を置く。

### 1.3 非対象

- YAML/JSON を含む高機能なシナリオ言語、分岐、loop、assert DSL。
- 約 198 本の fixture 全網羅、全電文の replay 対応保証。
- GUI の再生ボタン、タイムライン操作、録画・共有機能。
- 既存 capture suite の移行、既存 preview / `npm run test:phase6b-production` の廃止。
- CI 全面統合。本最小版ではローカルの明示実行と、狭い自動 test を追加するに留める。
- 実 dmdata 接続、契約照会、REST 初期化・復元、更新確認、外部通知・音・外部送信。
- OS 時刻の変更、または XML 内 `ReportDateTime` 等を現在へ雑に書き換えること。
- Phase 1 での汎用 fixture replay、任意の VPBS50、3 通以上の入力、VPBS50 以外の route。adapter は上記 2 fixture に必要な Control/Head 抽出だけを実装し、汎用 registry、type plugin、scenario abstraction を先回りで作らない。入力の件数・path・SHA-256・head type を runtime 構築前に fail-closed で検証し、対象を増やすときは route 固有の clock/timer/副作用を別途監査する。

## 2. 現行構造

### 2.1 通常の受信経路

通常経路は次のとおりである。

```text
WebSocket raw JSON
  -> WebSocketManager.handleDataMessage
  -> MultiConnectionManager.handleData (重複排除)
  -> monitor の onData
  -> createMessageHandler(...).handler = routeMessage
  -> parser / processor / state / notifier / display sink
  -> InfoDisplayHub -> HTTP / SSE -> Svelte display
```

根拠となる現行箇所は以下である。

- WebSocket は受信時刻を採り、transport supplied `meta` を捨てて `normalizeTelegramMessage` を通す（`src/dmdata/ws-client.ts:527-547`）。
- multi-connection manager は ID 重複排除の後に `onData` へ渡す（`src/dmdata/multi-connection-manager.ts:252-270`）。
- monitor は manager の `onData` から REPL 表示の保護区間を通して `routeMessage(msg)` を呼ぶ（`src/engine/monitor/monitor.ts:1052-1058`）。
- router の公開入口は `handler: (msg: WsDataMessage) => void`（`src/engine/messages/message-router.ts:780-805`）であり、入口で再度正規化・deep freeze・route 分類・直列化する（`src/engine/messages/message-router.ts:1878-1904, 1944-1955`）。

従って「connection manager の後ろ」は、厳密には `monitor.ts` の `onData` callback の `routeMessage(msg)` 呼出し直前である。ここなら fixture 側で `WsDataMessage` を正しく作る責任を負い、通常の parser、revision gate、processor、CLI formatter、display sink をそのまま通せる。

### 2.2 通常起動に混ぜてはならない経路

通常 CLI は設定解決後に dmdata 契約を REST 照会する（`src/engine/cli/cli-run.ts:49-56, 70-98`）。monitor は display/REPL を先に起動した後、manager 接続、subscription acknowledgement、津波 restore、火山 REST repair、必要なら副回線起動まで実行する（`src/engine/monitor/monitor.ts:1176-1238`）。

このため `fleq --replay ...` のような通常 run の if 分岐は採らない。分岐漏れ一つで本番 API または本番 state に接続するためである。

永続 state は現在 `process.cwd()/data/runtime/` に複数本置かれている。少なくとも standby（`src/engine/monitor/monitor.ts:306-309`）、weather promotion（`src/engine/monitor/monitor.ts:669-674`）、daily quake（`src/engine/monitor/monitor.ts:689-696`）、quake display（`src/engine/monitor/monitor.ts:710-715`）、quake extreme（`src/engine/monitor/monitor.ts:727-730`）がある。さらに router は `Vpwp50DetailCache` を無条件生成し（`src/engine/messages/message-router.ts:822-828`）、その既定値は `process.cwd()/data/runtime/vpwp50-latest.json` と stale tmp cleanup を伴う（`src/engine/messages/vpwp50-detail-cache.ts:60-63, 180-189`）。replay はこれらの hard-coded root・cleanup を一つも使ってはならない。

同じ router 箇所では `EewEventLogger` と `Notifier` も無条件生成される。EEW logger の既定 root は `process.cwd()/eew-logs`（`src/engine/eew/eew-logger.ts:20-22`）、Notifier constructor は通常 config を読む（`src/engine/notification/notifier.ts:293-301`）うえ、送信時に node-notifier を遅延 load する（`src/engine/notification/notifier.ts:1148-1160`）。単に通知設定を false にするのではなく、replay dependency graph では実 instance 自体を生成しない必要がある。

### 2.3 封筒と表示の現在地

REST 生 XML を `WsDataMessage` 互換にする既存の先例は `toWsDataMessageFromRestBody()` で、`type: "data"`、`version: "2.0"`、`format: "xml"`、`compression: null`、`encoding: "utf-8"` を立てて `normalizeTelegramMessage` へ渡す（`src/engine/startup/telegram-adapter.ts:37-64`）。fixture replay はこの型・正規化規約を再利用するが、REST item は要求しない。fixture XML 自身の Control/Head から `head` / `xmlReport` を構成する小さな adapter を新設する。

display server は `/healthz` と `/events` (SSE) を既に提供する。SSE 接続直後の initial frame の event 名は **`snapshot`** であり、注入後の dirty-state 配信が **`state`** である（`src/engine/display/http-server.ts:115-127, 671-673`）。この二つを同一視してはならない。snapshot の `generatedAt` は store に渡す `nowMs` から作られる（`src/engine/display/state-store.ts:1233-1245`）。しかし runtime は現在 `Date.now()` で seed / display start 時刻を採り（`src/engine/display/runtime.ts:209-255`）、browser も `createClock()` と一部 ticker 操作で壁時計を使う（`display/frontend/src/App.svelte:33-57`、`display/frontend/src/components/Ticker.svelte:81-142`）。これが replay の時計整合で最も注意すべき点である。

## 3. 設計

### 3.1 裁定 1: 注入点

**選択肢 A — connection manager 直後の router 入口（推奨）**

専用 replay runtime が `fixture XML -> WsDataMessage -> routeMessage(msg)` を順番に呼ぶ。呼出し位置は現行 `monitor.ts` の `onData` callback と同じ意味の入口にする（`src/engine/monitor/monitor.ts:1056-1058`）。fixture envelope は production と同じ `normalizeTelegramMessage` を通し、router 内の再正規化・分類・直列化、parser、revision/persistence admission、CLI formatter、display sink はすべて本番経路を通る。

通らないのは WebSocket JSON parse、ping/heartbeat、subscription acknowledgement、multi-connection の 500 件 ID 重複排除だけである。これらは接続 transport の責務であり、ローカル XML replay の検証対象から外す。fixture ID は `<run-id>:<ordinal>:<sha256(xml)>` のように一意かつ入力から決定的に作り、同じ XML の二重指定も transport dedup に隠されず router へ届くようにする。

**選択肢 B — WebSocket message 層から注入**

raw JSON を偽 WebSocket へ流し、`WebSocketManager.handleDataMessage()` を通す。WS schema、`meta.receivedAtMs` の所有、heartbeat、multi-connection dedup まで通る。

これは transport の試験としては厚いが、偽 socket / acknowledgement / reconnect state を組む必要があり、最小版の「実 XML を画面へ」から大きく外れる。さらに通常 manager を生成すると REST/接続の隔離を誤りやすい。最小版では不採用とする。

**選択肢 C — parser または processor 以降へ直接注入**

前処理済みの parsed/presentation event を渡す。実装は小さいが、fixture XML の envelope、router 正規化、分類、revision gate を飛ばすため、今回欲しい置換検証を保証できない。不採用とする。

**実装境界**

Phase 1 では `startMonitor()` 全体や transport-neutral `monitor-core` を抽出しない。VPBS50 専用の小さな replay runner が、production の `createMessageHandler` と CLI formatter/display sink、既存 display runtime を直接 composition し、`inject(message)`、`flushReplayState()`、`snapshot()`、`stop()` の寿命をこの case に限って所有する。runner は `monitor.ts`、REST/WS client、connection manager を import せず、通常 `startMonitor()` も変更しない。従って本番 router 以降は通しながら、静的 dependency graph と runtime spy の双方で外部接続を 0 にできる。二つ目の route を追加して共通 seam が実証された段階でのみ、Phase 2 で monitor composition の汎用抽出を裁定する。

### 3.2 裁定 2: 仮想時計と frontend の整合

**選択肢 A — Clock の明示 DI（推奨）**

`ReplayClock` は epoch milliseconds を一つだけ持ち、各 fixture 注入前に XML の `ReportDateTime` へ advance する。欠損・不正・時刻逆行は CLI error とし、`--allow-time-regression` は作らない。XML 本体は一切書き換えない。`--interval` は人が遷移を見るための **wall-clock pacing** だけであり、business time には使わない。同じ入力なら pacing 値にかかわらず同じ final state になる。

clock と対になる小さな `ReplayScheduler` も DI する。これは Phase 1 の 2 通から実際に到達する correlator と display dirty state のためだけのもので、全 route の timer abstraction ではない。clock advance のたびに deadline、登録 ordinal の順で「現在の virtual time までに due になった callback」を同期 drain する。最終 flush は到達済み buffer と display dirty state を明示的に flush するが、将来の TTL まで時計を進めない。通常実行の default は `Date.now` / native timer のままとする。環境変数や process-wide fake timer は使わない。

Phase 1 の支配範囲は次で固定する。非 test source にある全ての `Date.now()` を機械的に置換せず、固定した VPBS50 2 通の実行で到達する state/timer だけを仮想時計へ入れる。この表は全 route の TTL 整合を保証するものではない。

| 箇所 | Phase 1 の分類 | 実装・理由 |
| --- | --- | --- |
| fixture envelope の receipt、router envelope の `ingressObservedAtMs`、router stats/admission | **仮想時計** | `WsDataMessage.meta.receivedAtMs` と router clock を同じ `ReplayClock` にする。router の現行 direct read（`src/engine/messages/message-router.ts:1878-1882`）も DI 対象。 |
| `SummaryWindowTracker` / `DailyQuakeCounter` | **仮想時計** | VPBS50 を含む全 outcome の共通経路で、router は現在時刻を省略して両者の `record()` を呼ぶ（`src/engine/messages/message-router.ts:1070-1073`）。replay では `DailyQuakeCounter` constructor、両 `record()`、両 `getSnapshot()` に必ず `ReplayClock.nowMs()` を渡し、optional 引数の `Date.now()` fallback（`src/engine/messages/summary-tracker.ts:33-34, 60-62`、`src/engine/messages/daily-quake-counter.ts:44-45, 54-56, 109-110`）を一度も通さない。 |
| 固定 2 通の VPBS50 parse/revision、briefing active state、当該 entry の TTL/sweep、persistence timestamp | **仮想時計** | 今回の business state に限定する。XML report time と receipt time の双方を無改変・明示管理する。periodic sweep は起動せず、この entry について clock advance 時と final flush 時だけ評価する。 |
| legacy counterpart correlator | **仮想時計 + ReplayScheduler** | VPBS50 path から到達し得る one-shot timer。現行 timer owner（`src/engine/messages/legacy-counterpart-correlator.ts:147`）へ clock/scheduler を渡し、final flush hook を持たせる。 |
| 固定 2 通で変化する display receipt、hub/store、SSE timestamp、state debounce/retry | **仮想時計 + ReplayScheduler** | `generatedAt`、当該 briefing の expiry、最終 `state` frame を同じ clock にする。hub の pending dirty/debounce/retry は native timer に残さず、`flushReplayState()` で明示 drain する。 |
| frontend の中央時計と、固定 2 通の briefing 表示に使う mode/expiry/date 導出 | **仮想時計** | protocol に `clock: { mode: "replay", now }` を追加し、App の business `now` を server から受ける。固定 case に現れない card 固有時計や全画面の TTL までは Phase 1 の保証対象にしない。 |
| HTTP listen/close、SSE heartbeat、`--interval` pacing、Ctrl-C 待ち | **wall clock 許容** | business state / canonical artifact に値を入れない I/O 制御だけに使う。SSE heartbeat は `ping` だけを送り、probe は比較対象から除外する。timeout は canonical JSON に含めない。 |
| CSS animation、`requestAnimationFrame`、ticker lane の移動、capture/font settle | **wall clock 許容** | 視覚的な進行だけに使用し、mode/expiry/date/final snapshot を決めない。capture を gate に上げる段階では browser/font を固定する。 |

Phase 2 以降へ送る clock 対象は次のとおりである。Phase 1 では「wall clock のまま replay 可能」とはせず、そもそも入力を受け付けない。

| Phase 2 以降の対象 | 送る理由 |
| --- | --- |
| 任意の VPBS50 列と、standby 全体の TTL/sweep | 固定 2 通以外の revision、取消、expiry をまだ検証しないため。 |
| VPWS50 recap timestamp | 現行 direct read（`src/engine/messages/vpws50-state.ts:753`）と route 固有 test が必要なため。 |
| volcano VFVO53 batch timer | batch deadline/scheduler（`src/engine/messages/volcano-vfvo53-aggregator.ts:127`）の DI が必要なため。 |
| HeatAlert の日付更新、その他 card/route の mode・expiry・timer | 現行 direct read（例: `display/frontend/src/components/HeatAlertCard.svelte:16-20`）を route ごとに棚卸しし、backend と一組で test する必要があるため。 |
| 全 route 共通の clock/scheduler abstraction、全 TTL 整合 | 二つ目以降の実例から共通境界を抽出し、未使用の抽象化を先回りで作らないため。 |

router は多くの統計/入場処理で `msg.meta.receivedAtMs` を優先する（例: `src/engine/messages/message-router.ts:1782-1862`）が、それだけでは足りない。display receipt clock（`src/engine/messages/message-router.ts:803-819`）、hub の `now` / `monotonicNow`、timer scheduler まで同じ replay control plane に載せる。

frontend は OS 時刻を変えない。server の additive clock field を表示 business time の真実源にし、通常 mode の browser wall clock は従来どおり保つ。Phase 1 で最も難しい点は、固定 briefing の backend TTL/expiry と frontend の日付・expiry を揃えつつ、animation と I/O の wall time を分離することである。この表の「wall clock 許容」は、その値が固定 case の canonical state または表示上の業務日時へ流入しないことを test で証明できる場合に限る。

wire は `DisplayStateSnapshotV1` に optional additive fields `clock: { mode: "replay"; now: string }` と `replay: { step: number; total: number; inputDigest: string }` を加える。通常 runtime は両 field を省略し、既存 client との互換を保つ。initial `snapshot` は step 0、各 inject 後は step を進め、final `state` は step === total とする。`inputDigest` は順序付き fixture bytes と head type から作るため run ごとに変わらない。

**選択肢 B — 環境変数で `Date.now()` を置換**

起動時に `FLEQ_REPLAY_NOW` を読み、各所が直接読む方式。変更量は小さく見えるが、読み忘れが silent に混ざり、browser に届かず、並列 test と通常起動に leak しやすい。不採用。

**選択肢 C — fixture 日時基準の相対 offset だけを envelope に付ける**

`receivedAtMs` だけ調整し、その他は壁時計のままにする方式。router が一部の TTL/表示生成時刻で壁時計を読んでいる現状では、同入力が同状態にならない。最小版には不十分であり不採用。

### 3.3 裁定 3: 隔離単位

**選択肢 A — 通常 CLI の flags で state/events/notify/display port を一括切替**

たとえば `fleq --replay --state-dir ... --no-notify --display-port ...` とする。既存の root command は通常設定、契約照会、更新確認を通るため、flag 漏れが危険である。各値が通常設定ファイルから fallback する余地も残る。不採用。

**選択肢 B — 専用 `fleq replay` subcommand（推奨）**

`fleq replay <prediction.xml> <occurrence.xml>` を root command とは別に定義する。Phase 1 は positional argument をちょうど 2 本に固定し、既知 path/SHA-256、`VPBS50` head type、時刻順を runtime 構築前に検査する。replay 専用 options は次だけに絞る。

```text
fleq replay <prediction.xml> <occurrence.xml>
  --state-dir <dir>       必須。空の専用 directory
  --display-port <port>   既定 0（OS が空き port を選ぶ）。7788 は常に拒否
  --interval <ms>         電文間の wall-clock 待ち。既定 1000、test は 0
  --hold                  外部 display client を待って注入し、終了後も保持
```

`--state-dir` は存在しない path または空 directory だけを許可し、起動時に replay marker を作る。marker は provenance 用であり、Phase 1 では既存 run の再利用を許可しない。通常の `data/runtime`、空でない directory、symbolic link は拒否する。artifact 名は `<state-dir>/final-state.json`、`<state-dir>/events.jsonl`、`<state-dir>/cli.txt` に固定し、任意出力 path を受ける `--snapshot-out` は設けない。すべての durable file と cache/tmp はその配下だけに作る。

`--display-port 7788` は bind 前に拒否する。port `0` の bind 後にも actual port を検査し、7788 なら message/router/display publish より前に server を close して port `0` で再試行する。3 回続けば副作用なしで失敗する。bind host は option にせず `127.0.0.1` 固定とする。

router が現在無条件生成する `Vpwp50DetailCache`、`EewEventLogger`、`Notifier` は injection point を追加する（`src/engine/messages/message-router.ts:822-828`）。replay は state-dir 配下を明示した cache と、attempt count だけを memory に記録する no-op EEW logger / no-op notifier を渡す。実 logger/notifier は constructor さえ呼ばない。cache の stale tmp cleanup も state-dir 内だけを対象にする。CLI の実 formatter stdout は残し、その mirror だけを固定 `cli.txt` へ書く。update check、音、desktop notification、EEW log、外部 events output は呼ばない。

`events.jsonl` は意味 record だけを次の順序・件数で固定する。input fixture path は checkout-relative、cache/artifact path は `<state-dir>`-relative の POSIX 表記とし、absolute path、dynamic port、wall-clock timestamp は書かない。

1. `replay.injected` 2 records: `ordinal`, fixture-relative path, fixture hash, head type, business time, router route。
2. `replay.final` 1 record: `step`, `total`, `inputDigest`, final snapshot hash, cache-touched relative paths、no-op EEW logger/notifier の attempt/suppressed counts。

従って最初の VPBS50 case の `events.jsonl` は **合計 3 records** である。ready/health/SSE ping/CLI diagnostics はここへ混ぜない。

REST client、WebSocket client、`MultiConnectionManager` は replay dependency graph に含めないことを module graph test で、constructor/connect/API call が 0 であることを spy で二重に確認する。

### 3.4 裁定 4: 電文列の与え方

**選択肢 A — 引数列挙 + `--interval` のみ（推奨）**

Phase 1 は CLI に書いた 2 引数の順をそのまま順序とし、1 本目を既知の予測 fixture、2 本目を既知の発生 fixture に固定する。XML 内の report time は fixture 本文に残し、clock policy は 3.2 の規則で決める。実行形は次だけである。

```sh
fleq replay \
  test/fixtures/VPBS50_HJPNA202608270258.xml \
  test/fixtures/VPBS50_HJPNB202608270308.xml \
  --state-dir .tmp/replay-linear-rain \
  --display-port 0 --hold
```

`--interval` は注入間の wall-clock pacing であって、business clock の相対 offset や XML 改変機能ではない。各注入の直前に business clock はその XML の `ReportDateTime` へ進む。Phase 1 は上記 checkout 内の 2 file だけを受け付け、directory 走査、glob、別 path の同名 file、任意ローカル XML は受け付けない。

**選択肢 B — 最小 scenario file**

YAML/JSON に fixtures と interval を書く。繰返しには便利だが、schema、読込元、相対 path、将来の assert 項目を決め始めると最小版を越える。初回の予測→発生は 2 引数で十分なので後回しにする。

Phase 1 では A のうち固定 2 引数だけを実装する。任意の引数列と最小 JSONL manifest の比較は Phase 2 へ送り、その時も DSL にはしない。

### 3.5 裁定 5: 検証の形

**選択肢 A — CLI 出力 snapshot のみ**

router と formatter の一部を見られるが、実 SSE/display、表示 port、frontend の時刻整合を証明できない。不採用。

**選択肢 B — display `/healthz` + SSE `snapshot`/`state` barrier（推奨）**

runner 自身が loopback HTTP client を持ち、server 起動後に次の barrier を必ず完了してから成功とする。

1. `GET /healthz` が 200 / `{ ok: true }` になるまで待つ。
2. runner 内部の probe client が `GET /events` へ接続し、最初の **`snapshot`** event（注入前、`replay.step === 0`）を受け取る。ここを `replay.ready` とする。
3. fixture を注入する。`--hold` のときだけ、internal probe とは別の外部 SSE client が 1 件接続するまで fixture step 1 を始めないため、人が予測→発生の遷移を見られる。
4. 最終注入後に `flushReplayState()` を呼ぶ。これは router/persistence の同期 work、due 済みの `ReplayScheduler` task、message buffer、hub の pending dirty/debounce/retry を bounded loop で drain し、将来の TTL へ時計を進めず、最終 **`state`** event を 1 回強制送信する。
5. internal probe が `state` event のうち `replay.step === total`、`inputDigest`、`seq` が flush result と一致する frame を受け取るまで待つ。その frame の JSON `snapshot` member を固定 `<state-dir>/final-state.json` として保存し、replay runtime の authoritative snapshot と canonical equality を確認する。

この内部 probe により、`--hold` なしで server がすぐ閉じても subprocess harness が観測競争を起こさない。また初回の空 `snapshot` を final state と誤認しない。外側の test harness は process exit 後に固定 artifact と transcript を検証できる。`/events` は既存 endpoint のままで、新たな HTTP snapshot endpoint は増やさない。

canonicalization は object key 順だけを正規化し、意味のある時刻・seq・fixture digest は除外しない。dynamic port、state-dir absolute path、wall-clock timeout 診断のように protocol/state に入れるべきでない値は、生成段階から final payload に混ぜない。

**選択肢 C — capture の二段 gate 化を同時に行う**

静止画まで自動化できるが、Chrome 起動、motion settle、baseline の決定を replay 基盤と同時に抱える。capture script は現在 preview 前提の独立 server を起動する（`display/scripts/capture-legacy-standby.mjs:1-72`）。最小版では後回しにし、replay URL を与えられることだけを接続点とする。

### 3.6 実行順と停止

1. CLI は 2 fixture の件数・既知 path/SHA-256・`VPBS50` head type・時刻順、state directory、port を validate する。この時点で入力差異、7788、non-loopback、通常 runtime root、API key/config fallback を拒否する。
2. fixture XML を UTF-8 で読み、XML envelope から Head/Control を取得して stable ID 付き `WsDataMessage` に包む。本文は無圧縮 UTF-8 とし、adapter と router の両方で `normalizeTelegramMessage` を通す。gzip/base64 の test helper を流用しない（helper は test convenience であり、`passing.time` に壁時計も使う。`test/helpers/mock-message.ts:627-680`）。
3. replay runtime を空の state root、state-dir 指定 cache、no-op EEW logger/notifier、`ReplayClock` / `ReplayScheduler` で組み立てる。REPL、通常 manager、REST startup、periodic business timer は起動しない。実 CLI 出力は production router の formatter 経路で stdout と固定 `cli.txt` に出す。
4. display server を loopback / dynamic port で起動する。actual port が 7788 なら publish 前に close/retry する。内部 client が `/healthz` と注入前 SSE `snapshot` を観測してから `replay.ready` URL を出す。`--hold` なら外部 SSE client をもう 1 件待つ。
5. fixture を引数順に一通ずつ処理する。XML report time へ clock を advance、due task drain、inject、`--interval` の wall wait、の順に行う。各 inject 後に `replay.injected` JSONL record（ordinal, fixture hash, business time, router route）を state dir に残す。
6. `flushReplayState()` で quiescence を確定し、内部 probe が対応する最終 SSE `state` を受け取る。その JSON の `snapshot` member を固定 `final-state.json` へ保存して replay runtime snapshot と比較し、state-dir 相対 path だけを持つ `replay.final` を `events.jsonl` の3行目に書く。
7. `--hold` なしなら display/runtime を orderly stop して exit 0。`--hold` なら Ctrl-C まで最終表示を維持し、終了時も専用 state dir だけを flush する。

## 4. 対象ファイル

追加裁定 3A 後の Phase 1 変更範囲である。命名と同居/分割は実装時に近傍の style に合わせるが、汎用化のためだけに file を増やさない。

| 区分 | 対象 | 役割 |
| --- | --- | --- |
| CLI | `src/engine/cli/cli.ts`、`src/engine/cli/cli-replay.ts`（新規） | root run と独立した固定 2 引数 command、隔離 validation、runner 起動、内部 HTTP/SSE probe、固定 artifact 出力。`cli-run.ts` を再利用しない。通常の display options は現在 root command にある（`src/engine/cli/cli.ts:62-80`）。 |
| VPBS50 replay | `src/engine/replay/vpbs50-envelope.ts`、`vpbs50-runner.ts`（新規、単一 file への同居可） | 既知 2 fixture の XML → 正規化済み `WsDataMessage`、stable ID、strict report time と、router/CLI/display の限定 composition。汎用 classification registry は作らない。 |
| replay control | `src/engine/replay/replay-clock.ts`、`replay-side-effects.ts`（新規、単一 file への同居可） | 固定 case で到達する clock/scheduler、state-dir root、no-op EEW logger/notifier、quiescence ownership。 |
| router | `src/engine/messages/message-router.ts` | 固定 path の ingress/statistics/display receipt clock、cache、EEW logger、notifier の DI。実三者は現在ここで無条件生成される（`src/engine/messages/message-router.ts:803-828`）。 |
| buffer | `src/engine/messages/legacy-counterpart-correlator.ts` | 固定 VPBS50 path の clock/scheduler と final flush hook。 |
| cache contract | `src/engine/messages/vpwp50-detail-cache.ts` | 既存 `persistRoot` を state-dir へ渡す契約の参照/test 対象。契約が足りる限り production file は変更せず、変更 file 数にも数えない。 |
| display backend | `src/engine/display/runtime.ts`, `hub.ts`, `types.ts`。`transport.ts` は原則参照/test 対象 | 固定 case の now handoff、explicit quiescence flush、SSE replay metadata。actual port は既存 `transport.port()`（`src/engine/display/transport.ts:109-111`）を runner が start 直後に検査して close/retry し、契約が足りる限り transport 自体は変更しない。hub は既に `deps.now` を受けられる（`src/engine/display/hub.ts:114-126`）。 |
| display frontend | `display/frontend/src/lib/clock.svelte.ts`, `lib/protocol.ts`, `App.svelte` | server business clock を固定 VPBS50 briefing の表示へ渡す。`HeatAlertCard` その他 route/card は変更しない。 |
| tests | `test/engine/replay/*.test.ts`、display/frontend 側の固定 case test | 既知 2 envelope、module graph/side-effect 隔離、到達 clock/quiescence、SSE barrier、final state、7788 explicit/actual guard を固定する。 |

対象外の既存 fixture XML、preview fixture、capture baseline をこの段階で変更しない。`monitor.ts` / `monitor-core` の汎用 composition 抽出、`VPWS50`・火山等の route owner、`HeatAlertCard`、全 TTL の frontend/backend 配線も Phase 2 以降であり、Phase 1 の対象ファイル数に含めない。

## 5. 受入条件

以下は人の目視ではなく、test または subprocess harness で機械的に確認する。

### 5.1 封筒と経路

- 既知の VPBS50 fixture 2 本から個別に作った値が `WsDataMessage` の必須 fields を満たし、`format === "xml"`、`compression === null`、`encoding === "utf-8"`、正規化済み `meta.receivedAtMs` を持つ。
- その message は router の public handler に 1 回渡り、route tap に 1 回だけ記録される。parser/processor を直接 call してはならない。
- VPBS50 の予測→発生 2 本を順序どおりに渡すと、final snapshot の briefing/standby entry は発生状態を示し、予測の stale entry を残さない。`events.jsonl` は `replay.injected` 2 records と `replay.final` 1 record の順で、合計 3 records になる。
- 引数 1/3 本、逆順、既知 path/SHA-256 と異なる VPBS50、`VPWS50`、火山、EEW は、state/cache/runtime を作る前に unsupported scenario として non-zero exit する。

### 5.2 隔離の証明

- replay subprocess を API key 未設定・network deny 環境で起動しても成功する。module graph に REST/WS/connection manager module が無く、`listContracts`、`fetchTelegramBody`、`listTelegrams`、`MultiConnectionManager`、`WebSocketManager` の constructor/connect/API call は 0 である。
- replay のすべての writable artifact/cache/tmp は指定した `<state-dir>` 内だけにある。通常の `data/runtime` 全体、`data/runtime/vpwp50-latest.json` とその tmp、`eew-logs`、通常 events 出力の存在・file list・hash・mtime を起動前後で比較し、不変である。
- production `Vpwp50DetailCache` の default path/cleanup、production `EewEventLogger`、production `Notifier` の constructor は 0 call である。replay cache が触れた path はすべて state-dir 相対表記で、no-op logger/notifier の attempt/suppressed count とともに `events.jsonl` の `replay.final` record で assertion できる。
- artifact は固定 `final-state.json` / `events.jsonl` / `cli.txt` と専用 runtime/cache files だけである。state-dir 外を指定できる output option は存在しない。
- bind host は `127.0.0.1` である。明示 `--display-port 7788` は bind 前に non-zero exit する。port allocator を test double で `7788 -> safePort` と返した場合は、7788 server を注入前に close し、safePort だけが ready になる。3 回 7788 なら無注入で失敗する。
- 7788 に sentinel server を置いて replay を起動しても、sentinel の connection/request/SSE receive count は 0 で、replay URL の actual port は 7788 ではない。

### 5.3 時刻と決定性

- XML bytes は起動前後で完全一致する。`ReportDateTime`、`EventID`、serial を rewrite しない。
- 同じ fixture sequence を別の空 state dir で 2 回実行し、一方は `--interval 0`、他方は非ゼロにする。canonical `final-state.json` と、相対 path だけを持つ全3 records の `events.jsonl` の SHA-256 が一致し、wall pacing や state-dir absolute path が business state に混入しない。
- snapshot の `generatedAt` と replay clock field、各 injected message の `meta.receivedAtMs` は、選んだ clock policy に従い一致する。固定 briefing と frontend 中央時計も同じ ISO/JST 時刻を読む unit/integration test を持つ。固定 case に現れない card/route の時刻はこの assertion に含めない。
- VPBS50 outcome でも `SummaryWindowTracker.record/getSnapshot` と `DailyQuakeCounter` constructor/record/getSnapshot が受け取る時刻はすべて replay clock と一致し、時刻省略 fallback を spy で 0 call と確認する。
- host の時刻を変更せずに過去 fixture を実行しても、TTL が直ちに失効して空表示にならない。business clock を最終電文時刻で止めた snapshot が残る。
- final `flushReplayState()` 後は router queue、due `ReplayScheduler` tasks、message buffers、persistence reservation、hub dirty/debounce/retry が空である。同じ clock のまま 2 回目の flush を呼んでも snapshot hash/seq は不変で、新しい SSE `state` event を送らない。
- wall clock を 2 種類の大きく異なる値へ stub して同じ run を行っても canonical state は一致する。固定 2 通から到達する経路で、3.2 の「wall clock 許容」以外の direct read が起きた場合は test を失敗させる。この条件を未到達 route 全体の Clock 対応済み宣言には使わない。

### 5.4 CLI と実 display

- `fleq replay ... --display-port 0` は ready URL、actual port、final snapshot path を stdout に明示する。
- runner 内部の `GET <url>/healthz` は 200 と `{ "ok": true }` を返し、その後に SSE 接続を開始する。
- `GET <url>/events` の最初の event は注入前の `snapshot` / step 0 である。注入はこの受信後にしか始まらない。
- final 比較対象は「最初の state」ではなく、`step === total`、`inputDigest`、`seq` が flush result と一致する注入後の `state` event である。その JSON の `snapshot` member が `final-state.json` および replay runtime snapshot と canonical equality になる。これを「実 display server へ届いた」機械的証拠とする。
- 最小 VPBS50 case の `snapshot` / `state` は SSE size ladder の縮退 level 0 で送られ、wire の snapshot member と replay runtime snapshot が同形である。
- `--hold` 実行では internal probe 以外の SSE client 接続後に初回 inject し、browser が予測→発生の両 step と最終 state を受け取れる。最小版の capture は手動でよいが、将来 gate 化するときは browser executable/version、viewport、font assets、reduced-motion、settle 条件を固定する。

## 6. 段階

### Phase 1 — 裁定 3A: 固定 VPBS50 2 通

`fleq replay` は既知の予測・発生 fixture をこの順にちょうど 2 本だけ受ける。VPBS50 専用 envelope/runner、実 router/CLI/display、専用 state root へ明示 DI した `Vpwp50DetailCache`、DI した no-op EEW logger/notifier、loopback dynamic port と actual-7788 guard、到達範囲だけの clock/scheduler、SSE 注入前 `snapshot` barrier・注入後 correlated `state`、冪等 quiescence flush を一体で実装・test する。固定 pair の CLI transcript と発生へ置換された final state を機械確認できた時点で完了とし、通常 `fleq`、preview、production gate は変えない。

### Phase 2 — 汎用化と route ごとの Clock 拡張

任意のローカル fixture、任意の VPBS50 列、3 通以上の列を初めて検討し、引数列または最小 manifest を裁定する。追加する route ごとに backend/frontend の business clock、TTL、scheduler、永続化、副作用を棚卸しし、まず VPBS50 の取消・更新、次に VPWS50 recap、HeatAlert 等を個別に仮想時計へ入れる。二つ目の route で共通化の根拠が得られた場合だけ、transport-neutral monitor composition や汎用 fixture envelope を抽出する。

### Phase 3 — 代表シナリオ追加

地震、津波、火山、気象警報などから、置換・取消・寿命判定を代表する少数の列を追加する。火山 batch 等の route 固有 timer は各 scenario と同時に DI/test し、全 TTL 整合を route 横断で宣言するのはこの棚卸し完了後とする。capture の二段 gate、全 capture suite 移行、CI 全面統合は別裁定・別 spec とする。

## 7. 裁定ラベル

### 7.1 一括裁定する 6 要素

採択済みの方式と追加裁定 3A の境界を、実装 issue の acceptance heading にそのまま使える形で固定する。

| Label | 決めること | 採択内容 |
| --- | --- | --- |
| R1 `ingress` | 注入点 | A: connection manager 直後の `routeMessage` 入口 |
| R2 `clock` | business time の所有と frontend handoff | A: 明示 Clock DI + protocol の replay clock field。ただし Phase 1 は固定 2 通から到達する owner だけ |
| R3 `isolation` | state/cache/events/logger/notifier/port の境界 | B: 専用 `fleq replay`、state dir 必須、loopback + guarded port 0、実 sinks 無生成 |
| R4 `input` | 電文列の記法 | A/3A: 既知の予測・発生 fixture を順序固定の 2 引数 + optional wall pacing `--interval`。任意列は Phase 2 |
| R5 `verification` | 最小の end-to-end gate | B: `/healthz` + 注入前 SSE `snapshot` barrier + 注入後 final `state` compare |
| R6 `first-case` | 最初に固定する業務ケース | **3A 採択**: VPBS50 線状降水帯の予測→発生 2 fixture だけ。XML 無改変、汎用 replay・他 route・全 TTL は Phase 2 以降 |

### 7.2 独立 DOC レビュー指摘の反映方針

方針記号は `a` = 指摘どおり修正、`b` = 根拠を示して不採用、とする。今回の 11 件はすべて `a` とした。

| ID / severity | 方針 | 反映内容 |
| --- | --- | --- |
| D1 / High: initial SSE event 名 | **a** | initial は `snapshot`、注入後は `state` と訂正した（§2.3, §3.5, §5.4）。 |
| D2 / High: subprocess 観測 race | **a** | runner 内部 SSE probe の接続・initial `snapshot` 受信を inject 前 barrier にした。`--hold` は外部 client も待つ（§3.5, §3.6）。 |
| D3 / High: `Vpwp50DetailCache` 隔離 | **a** | default constructor/path/cleanup を禁止し、state-dir 指定 cache を DI する。通常 root の file list/hash/mtime も検査する（§2.2, §3.3, §5.2）。 |
| D4 / High: EEW logger / Notifier 隔離 | **a** | 両者を DI port 化し、replay では実 constructor を呼ばない no-op sink にする（§3.3, §4, §5.2）。 |
| D5 / High: Clock DI 到達範囲 | **a** | Phase 1 固定 2 通の virtual clock/scheduler、共通 owner の `SummaryWindowTracker` / `DailyQuakeCounter`、wall clock 許容を表で分離した。VPWS50/火山/HeatAlert 等は 3A に従い Phase 2 以降の要監査項目として列挙した（§3.2, §5.3）。 |
| D6 / High: `--snapshot-out` 越境 | **a** | option を削除し、`<state-dir>/final-state.json` 固定にした（§3.3, §5.2）。 |
| D7 / Medium: port 0 が 7788 | **a** | bind 後 actual port も検査し、注入前 close/retry、3 回で失敗する（§3.3, §3.6, §5.2）。 |
| D8 / Medium: REST/WS import graph | **a** | Phase 1 専用 runner を `monitor.ts` から独立させ、replay graph から REST/WS import を除く。module graph と runtime spy の二段で証明し、汎用 core 抽出自体は 3A により Phase 2 へ送る（§3.1, §3.3, §5.2）。 |
| D9 / Medium: quiescence 不足 | **a** | manual scheduler と冪等 `flushReplayState()`、最終 `state` correlation を必須にした（§3.2, §3.5, §5.3）。 |
| D10 / Medium: 見積りが楽観的 | **a** | 隔離、到達 clock/scheduler、quiescence/SSE、固定 case の frontend 配線を残し、3A で外した汎用 core・他 route・全 TTL を除いて再積算した（§4, 「概算」）。 |
| D11 / Medium: 規約の断定 | **a** | 対象外と断定せず、本人・loopback 限定、共有機能外、EEW 追加時の再確認に修正した（§1.1）。 |

### 7.3 再レビュー残点の反映方針

| ID / severity | 方針 | 反映内容 |
| --- | --- | --- |
| RD1 / Medium: 共通 clock owner | **a** | `SummaryWindowTracker` と `DailyQuakeCounter` の constructor/record/snapshot を replay clock に固定し、fallback 0 call を受入条件にした（§3.2, §5.3）。 |
| RD2 / Medium: `events.jsonl` count/path | **a** | `replay.injected` 2 + `replay.final` 1 の全3 records、fixture は checkout-relative・cache/artifact は state-dir-relative、固定順を schema と受入条件にした（§3.3, §3.6, §5.1--5.3）。 |
| RD3 / Low: file-count 上限 | **a** | 3A 後の対象表を再集計し、同居/分割と既存 transport 契約の再利用を含む production 12--15 files とした。既存 `Vpwp50DetailCache` は変更不要なら参照/test 対象のみで、変更数に含めない（§4, 「概算」）。 |

### 7.4 追加裁定の反映方針

| ID | 方針 | 反映内容 |
| --- | --- | --- |
| Decision 3A / Phase 1 scope | **a** | Phase 1 を既知 VPBS50 2 通の実 router → CLI → display E2E に固定した。汎用 fixture replay、任意列、全 TTL、VPWS50/火山等の route Clock、汎用 monitor core を Phase 2 以降へ移し、隔離・7788 guard・SSE barrier・quiescence は Phase 1 に残した（§1, §3, §4, §6, §7）。 |

## 概算

追加裁定 3A の Phase 1 は production code **12--15 files**（新規 3--5、既存 9--10）と test **4--6 files**、合計 **16--21 files / 約 900--1,500 行**を見込む。新規 file 数の幅は envelope/runner と clock/side-effects を同居させるか、既存 file 数の幅は `transport.port()` 契約を無変更で再利用できるかで生じる。増分の中心は固定 2 通 runner、cache/logger/notifier DI、共通 owner を含む到達 clock、actual-7788 guard、hub quiescence/SSE probe、固定 briefing だけの frontend clock handoff である。汎用 fixture replay、monitor core 抽出、任意 VPBS50、全 TTL、VPWS50 recap、HeatAlert、火山 batch、EEW route は含めず Phase 2 以降で別途見積もる。
