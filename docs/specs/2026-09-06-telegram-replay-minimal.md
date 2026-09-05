# 実電文リプレイ注入基盤（最小版）

> **裁定（2026-09-06 朝、ご主人）**: §3 の裁定点はすべて推奨案を採用。独立 DOC レビュー（Sol high、新規 read-only スレッド）2 巡で DOC-OK。


Status: draft / decision required

## 1. 目的と非対象

### 1.1 目的

ローカルにある実 XML fixture を、dmdata WebSocket で受ける `WsDataMessage` と同じ封筒へ包み、通常の message router とその後段の engine、CLI 表示、実 display へ順番に注入する。これにより、実電文の発令を待たずに、少数の電文列が最終状態をどう置換するかを手元で再現・観察できるようにする。

最初の利用者は、VPBS50 の線状降水帯「直前予測 → 発生」置換である。候補 fixture は既存の `VPBS50_HJPNA202608270258.xml`（予測）と `VPBS50_HJPNB202608270308.xml`（発生）であり、既存 helper も同じ対を実受信として扱っている（`test/helpers/mock-message.ts:354-356`）。最小版はこの 2 通を、実 router と実 display で確認できればよい。

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
- Phase 1 での VPBS50 以外の処理。envelope は汎用形を保ってよいが、CLI は head type allowlist を `VPBS50` に固定し、未対応 type は runtime 構築前に fail-closed で拒否する。対象を増やす前に、その route 固有の clock/timer/副作用を別途監査する。

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

`startMonitor()` の中に閉じている composition を、REST/WS import を持たない transport-neutral な `monitor-core` へ薄く抽出する。core factory は `inject(message)`、`flushReplayState()`、`snapshot()`、`stop()` を返す。通常 path の `monitor.ts` だけが `MultiConnectionManager` / REST 初期化群を import・生成して `inject` に委譲し、replay path は core だけを import する。これにより「constructor/connect/API call が 0」だけでなく、replay の静的 dependency graph に REST/WS module が無いことも module graph test で固定する。router 単体を外部から叩く構造にはせず、CLI formatter、display、persistence、shutdown の寿命は core が所有する。

### 3.2 裁定 2: 仮想時計と frontend の整合

**選択肢 A — Clock の明示 DI（推奨）**

`ReplayClock` は epoch milliseconds を一つだけ持ち、各 fixture 注入前に XML の `ReportDateTime` へ advance する。欠損・不正・時刻逆行は CLI error とし、`--allow-time-regression` は作らない。XML 本体は一切書き換えない。`--interval` は人が遷移を見るための **wall-clock pacing** だけであり、business time には使わない。同じ入力なら pacing 値にかかわらず同じ final state になる。

clock と対になる `ReplayScheduler` も DI する。clock advance のたびに deadline、登録 ordinal の順で「現在の virtual time までに due になった callback」を同期 drain する。最終 flush は message aggregator / correlator と display dirty state を明示的に flush するが、将来の TTL まで時計を進めない。通常実行の default は `Date.now` / native timer のままとする。環境変数や process-wide fake timer は使わない。

Phase 1 の支配範囲は次で固定する。非 test source にある全ての `Date.now()` を機械的に置換する計画ではない。代わりに VPBS50 path と、その path から到達可能な state/timer を仮想時計へ入れ、未監査 route は allowlist で拒否する。

| 箇所 | Phase 1 の分類 | 実装・理由 |
| --- | --- | --- |
| fixture envelope の receipt、router envelope の `ingressObservedAtMs`、router stats/admission | **仮想時計** | `WsDataMessage.meta.receivedAtMs` と router clock を同じ `ReplayClock` にする。router の現行 direct read（`src/engine/messages/message-router.ts:1878-1882`）も DI 対象。 |
| `SummaryWindowTracker` / `DailyQuakeCounter` | **仮想時計** | VPBS50 を含む全 outcome の共通経路で、router は現在時刻を省略して両者の `record()` を呼ぶ（`src/engine/messages/message-router.ts:1070-1073`）。replay では `DailyQuakeCounter` constructor、両 `record()`、両 `getSnapshot()` に必ず `ReplayClock.nowMs()` を渡し、optional 引数の `Date.now()` fallback（`src/engine/messages/summary-tracker.ts:33-34, 60-62`、`src/engine/messages/daily-quake-counter.ts:44-45, 54-56, 109-110`）を一度も通さない。 |
| VPBS50 parse/revision、briefing active state、standby TTL/sweep、persistence timestamp | **仮想時計** | 今回の business state。XML report time と receipt time の双方を無改変・明示管理する。periodic sweep は止め、clock advance 時と final flush 時だけ実行する。 |
| legacy counterpart correlator | **仮想時計 + ReplayScheduler** | VPBS50 path から到達し得る one-shot timer。現行 timer owner（`src/engine/messages/legacy-counterpart-correlator.ts:147`）へ clock/scheduler を渡し、final flush hook を持たせる。 |
| display receipt、hub/store、transport が生成する SSE timestamp、state debounce/retry/sweep | **仮想時計 + ReplayScheduler** | `generatedAt`、expiry、最終 `state` frame を同じ clock にする。hub の debounce/retry は native timer を使わず、`flushReplayState()` で明示 drain する。 |
| frontend の中央/帯時計、mode/expiry/date 導出、HeatAlert の日付更新 | **仮想時計** | protocol に `clock: { mode: "replay", now }` を追加し、`createClock()` と `HeatAlertCard` の `now` をそこから受ける。replay mode の日次 4 時 reload は無効化する（HeatAlert の現行 direct read は `display/frontend/src/components/HeatAlertCard.svelte:16-20`）。 |
| VPWS50 recap timestamp | **Phase 1 非対応・fail-closed** | business state に影響する現行 direct read（`src/engine/messages/vpws50-state.ts:753`）がある。DI と test を追加するまで `VPWS50` を allowlist に入れない。wall clock のまま replay することは許可しない。 |
| volcano VFVO53 batch timer | **Phase 1 非対応・fail-closed** | batch deadline/scheduler（`src/engine/messages/volcano-vfvo53-aggregator.ts:127`）を DI するまで volcano type を許可しない。wall clock のまま replay することは許可しない。 |
| HTTP listen/close、SSE heartbeat、`--interval` pacing、Ctrl-C 待ち | **wall clock 許容** | business state / canonical artifact に値を入れない I/O 制御だけに使う。SSE heartbeat は `ping` だけを送り、probe は比較対象から除外する。timeout は canonical JSON に含めない。 |
| CSS animation、`requestAnimationFrame`、ticker lane の移動、capture/font settle | **wall clock 許容** | 視覚的な進行だけに使用し、mode/expiry/date/final snapshot を決めない。capture を gate に上げる段階では browser/font を固定する。 |

router は多くの統計/入場処理で `msg.meta.receivedAtMs` を優先する（例: `src/engine/messages/message-router.ts:1782-1862`）が、それだけでは足りない。display receipt clock（`src/engine/messages/message-router.ts:803-819`）、hub の `now` / `monotonicNow`、timer scheduler まで同じ replay control plane に載せる。

frontend は OS 時刻を変えない。server の additive clock field を表示 business time の真実源にし、通常 mode の browser wall clock は従来どおり保つ。最も難しい点は、backend の TTL/expiry と frontend の日付・expiry を揃えつつ、animation と I/O の wall time を分離することである。この表の「wall clock 許容」は、その値が canonical state または表示上の業務日時へ流入しないことを test で証明できる場合に限る。

wire は `DisplayStateSnapshotV1` に optional additive fields `clock: { mode: "replay"; now: string }` と `replay: { step: number; total: number; inputDigest: string }` を加える。通常 runtime は両 field を省略し、既存 client との互換を保つ。initial `snapshot` は step 0、各 inject 後は step を進め、final `state` は step === total とする。`inputDigest` は順序付き fixture bytes と head type から作るため run ごとに変わらない。

**選択肢 B — 環境変数で `Date.now()` を置換**

起動時に `FLEQ_REPLAY_NOW` を読み、各所が直接読む方式。変更量は小さく見えるが、読み忘れが silent に混ざり、browser に届かず、並列 test と通常起動に leak しやすい。不採用。

**選択肢 C — fixture 日時基準の相対 offset だけを envelope に付ける**

`receivedAtMs` だけ調整し、その他は壁時計のままにする方式。router が一部の TTL/表示生成時刻で壁時計を読んでいる現状では、同入力が同状態にならない。最小版には不十分であり不採用。

### 3.3 裁定 3: 隔離単位

**選択肢 A — 通常 CLI の flags で state/events/notify/display port を一括切替**

たとえば `fleq --replay --state-dir ... --no-notify --display-port ...` とする。既存の root command は通常設定、契約照会、更新確認を通るため、flag 漏れが危険である。各値が通常設定ファイルから fallback する余地も残る。不採用。

**選択肢 B — 専用 `fleq replay` subcommand（推奨）**

`fleq replay <fixture.xml> [fixture.xml ...]` を root command とは別に定義する。replay 専用 options は次だけに絞る。

```text
fleq replay <fixture.xml> [fixture.xml ...]
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

最小版は CLI に書いた順をそのまま順序とする。XML 内の report time は fixture 本文に残し、clock policy は 3.2 の規則で決める。初回は次のように実行する。

```sh
fleq replay \
  test/fixtures/VPBS50_HJPNA202608270258.xml \
  test/fixtures/VPBS50_HJPNB202608270308.xml \
  --state-dir .tmp/replay-linear-rain \
  --display-port 0 --hold
```

`--interval` は注入間の wall-clock pacing であって、business clock の相対 offset や XML 改変機能ではない。各注入の直前に business clock はその XML の `ReportDateTime` へ進む。fixture path は checkout 内の `test/fixtures/` または引数で明示したローカル XML に限り、directory 走査・glob 展開はしない。

**選択肢 B — 最小 scenario file**

YAML/JSON に fixtures と interval を書く。繰返しには便利だが、schema、読込元、相対 path、将来の assert 項目を決め始めると最小版を越える。初回の予測→発生は 2 引数で十分なので後回しにする。

最小版では A だけを実装する。3 本以上の代表シナリオを手で回す段階で、引数列を losslessly 表せる JSONL manifest を検討する。その時も DSL にはしない。

### 3.5 裁定 5: 検証の形

**選択肢 A — CLI 出力 snapshot のみ**

router と formatter の一部を見られるが、実 SSE/display、表示 port、frontend の時刻整合を証明できない。不採用。

**選択肢 B — display `/healthz` + SSE `snapshot`/`state` barrier（推奨）**

runner 自身が loopback HTTP client を持ち、server 起動後に次の barrier を必ず完了してから成功とする。

1. `GET /healthz` が 200 / `{ ok: true }` になるまで待つ。
2. runner 内部の probe client が `GET /events` へ接続し、最初の **`snapshot`** event（注入前、`replay.step === 0`）を受け取る。ここを `replay.ready` とする。
3. fixture を注入する。`--hold` のときだけ、internal probe とは別の外部 SSE client が 1 件接続するまで fixture step 1 を始めないため、人が予測→発生の遷移を見られる。
4. 最終注入後に `flushReplayState()` を呼ぶ。これは router/persistence の同期 work、due 済みの `ReplayScheduler` task、message buffer、hub の pending dirty/debounce/retry を bounded loop で drain し、将来の TTL へ時計を進めず、最終 **`state`** event を 1 回強制送信する。
5. internal probe が `state` event のうち `replay.step === total`、`inputDigest`、`seq` が flush result と一致する frame を受け取るまで待つ。その frame の JSON `snapshot` member を固定 `<state-dir>/final-state.json` として保存し、core の authoritative snapshot と canonical equality を確認する。

この内部 probe により、`--hold` なしで server がすぐ閉じても subprocess harness が観測競争を起こさない。また初回の空 `snapshot` を final state と誤認しない。外側の test harness は process exit 後に固定 artifact と transcript を検証できる。`/events` は既存 endpoint のままで、新たな HTTP snapshot endpoint は増やさない。

canonicalization は object key 順だけを正規化し、意味のある時刻・seq・fixture digest は除外しない。dynamic port、state-dir absolute path、wall-clock timeout 診断のように protocol/state に入れるべきでない値は、生成段階から final payload に混ぜない。

**選択肢 C — capture の二段 gate 化を同時に行う**

静止画まで自動化できるが、Chrome 起動、motion settle、baseline の決定を replay 基盤と同時に抱える。capture script は現在 preview 前提の独立 server を起動する（`display/scripts/capture-legacy-standby.mjs:1-72`）。最小版では後回しにし、replay URL を与えられることだけを接続点とする。

### 3.6 実行順と停止

1. CLI は fixture 引数、`VPBS50` allowlist、state directory、port を validate する。この時点で 7788、non-loopback、通常 runtime root、API key/config fallback を拒否する。
2. fixture XML を UTF-8 で読み、XML envelope から Head/Control を取得して stable ID 付き `WsDataMessage` に包む。本文は無圧縮 UTF-8 とし、adapter と router の両方で `normalizeTelegramMessage` を通す。gzip/base64 の test helper を流用しない（helper は test convenience であり、`passing.time` に壁時計も使う。`test/helpers/mock-message.ts:627-680`）。
3. replay runtime を空の state root、state-dir 指定 cache、no-op EEW logger/notifier、`ReplayClock` / `ReplayScheduler` で組み立てる。REPL、通常 manager、REST startup、periodic business timer は起動しない。実 CLI 出力は production router の formatter 経路で stdout と固定 `cli.txt` に出す。
4. display server を loopback / dynamic port で起動する。actual port が 7788 なら publish 前に close/retry する。内部 client が `/healthz` と注入前 SSE `snapshot` を観測してから `replay.ready` URL を出す。`--hold` なら外部 SSE client をもう 1 件待つ。
5. fixture を引数順に一通ずつ処理する。XML report time へ clock を advance、due task drain、inject、`--interval` の wall wait、の順に行う。各 inject 後に `replay.injected` JSONL record（ordinal, fixture hash, business time, router route）を state dir に残す。
6. `flushReplayState()` で quiescence を確定し、内部 probe が対応する最終 SSE `state` を受け取る。その JSON の `snapshot` member を固定 `final-state.json` へ保存して core snapshot と比較し、state-dir 相対 path だけを持つ `replay.final` を `events.jsonl` の3行目に書く。
7. `--hold` なしなら display/runtime を orderly stop して exit 0。`--hold` なら Ctrl-C まで最終表示を維持し、終了時も専用 state dir だけを flush する。

## 4. 対象ファイル

実装時に想定する最小変更範囲。命名は実装時に近傍の style に合わせる。

| 区分 | 対象 | 役割 |
| --- | --- | --- |
| CLI | `src/engine/cli/cli.ts` | `replay` subcommand を root run から独立して登録する。通常の display options は現在 root command にある（`src/engine/cli/cli.ts:62-80`）。 |
| CLI | `src/engine/cli/cli-replay.ts`（新規） | 引数/allowlist/隔離 validation、runner 起動、内部 HTTP/SSE probe、固定 artifact 出力。`cli-run.ts` を再利用しない。 |
| envelope | `src/engine/replay/fixture-envelope.ts`（新規） | XML → 正規化済み `WsDataMessage`、stable ID、classification 推定、strict report time。 |
| clock | `src/engine/replay/replay-clock.ts`, `replay-scheduler.ts`（新規） | 明示的に advance する clock、due task の順序付き drain、wall pacing との分離。 |
| composition | `src/engine/monitor/monitor-core.ts`（新規）、`monitor.ts` | REST/WS-free core を抽出し、通常 transport と local inject が同じ router/display composition を使う。通常接続の入口は現状 `startMonitor`（`src/engine/monitor/monitor.ts:284-307`）。 |
| router | `src/engine/messages/message-router.ts` | ingress/statistics/display receipt clock、scheduler、cache、EEW logger、notifier の DI。実三者は現在ここで無条件生成される（`src/engine/messages/message-router.ts:803-828`）。 |
| buffer | `src/engine/messages/legacy-counterpart-correlator.ts` | VPBS50 path の clock/scheduler と final flush hook。 |
| cache/side effects | `src/engine/messages/vpwp50-detail-cache.ts`、`src/engine/replay/replay-side-effects.ts`（新規） | cache root を state-dir へ向け、no-op EEW logger/notifier を提供する。前者は現行 `persistRoot` をそのまま利用できる場合は参照・test 対象のみ。 |
| persistence | `src/engine/monitor/monitor-core.ts` と関係する persistence constructors | `process.cwd()/data/runtime` 直書きを injected state root に集約する。 |
| display backend | `src/engine/display/runtime.ts`, `hub.ts`, `transport.ts`, protocol | now/monotonic clock/scheduler、explicit quiescence flush、actual port 7788 guard、replay metadata。hub 自体は既に `deps.now` を受けられる（`src/engine/display/hub.ts:114-126`）。 |
| display frontend | `display/frontend/src/lib/clock.svelte.ts`, `App.svelte`, `components/HeatAlertCard.svelte`, protocol mirror | server business clock の受領、expiry/date への配線、replay 中の日次 reload 抑止。 |
| tests | `test/engine/replay/*.test.ts`、display 側の最小 test | envelope、module graph/side-effect 隔離、clock/scheduler/quiescence、SSE barrier、2 XML final state、7788 explicit/actual guard を固定する。 |

対象外の既存 fixture XML、preview fixture、capture baseline をこの段階で変更しない。

## 5. 受入条件

以下は人の目視ではなく、test または subprocess harness で機械的に確認する。

### 5.1 封筒と経路

- allowlist 内の VPBS50 fixture XML 1 本から作った値が `WsDataMessage` の必須 fields を満たし、`format === "xml"`、`compression === null`、`encoding === "utf-8"`、正規化済み `meta.receivedAtMs` を持つ。
- その message は router の public handler に 1 回渡り、route tap に 1 回だけ記録される。parser/processor を直接 call してはならない。
- VPBS50 の予測→発生 2 本を順序どおりに渡すと、final snapshot の briefing/standby entry は発生状態を示し、予測の stale entry を残さない。`events.jsonl` は `replay.injected` 2 records と `replay.final` 1 record の順で、合計 3 records になる。
- `VPWS50`、火山、EEW を含む VPBS50 以外の fixture は、state/cache/runtime を作る前に unsupported type として non-zero exit する。

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
- snapshot の `generatedAt` と replay clock field、各 injected message の `meta.receivedAtMs` は、選んだ clock policy に従い一致する。frontend の日付・時計表示も同じ ISO/JST 時刻を読む unit/integration test を持つ。
- VPBS50 outcome でも `SummaryWindowTracker.record/getSnapshot` と `DailyQuakeCounter` constructor/record/getSnapshot が受け取る時刻はすべて replay clock と一致し、時刻省略 fallback を spy で 0 call と確認する。
- host の時刻を変更せずに過去 fixture を実行しても、TTL が直ちに失効して空表示にならない。business clock を最終電文時刻で止めた snapshot が残る。
- final `flushReplayState()` 後は router queue、due `ReplayScheduler` tasks、message buffers、persistence reservation、hub dirty/debounce/retry が空である。同じ clock のまま 2 回目の flush を呼んでも snapshot hash/seq は不変で、新しい SSE `state` event を送らない。
- wall clock を 2 種類の大きく異なる値へ stub して同じ run を行っても canonical state は一致する。3.2 の「wall clock 許容」以外で direct read が起きた場合は test を失敗させる。

### 5.4 CLI と実 display

- `fleq replay ... --display-port 0` は ready URL、actual port、final snapshot path を stdout に明示する。
- runner 内部の `GET <url>/healthz` は 200 と `{ "ok": true }` を返し、その後に SSE 接続を開始する。
- `GET <url>/events` の最初の event は注入前の `snapshot` / step 0 である。注入はこの受信後にしか始まらない。
- final 比較対象は「最初の state」ではなく、`step === total`、`inputDigest`、`seq` が flush result と一致する注入後の `state` event である。その JSON の `snapshot` member が `final-state.json` および core snapshot と canonical equality になる。これを「実 display server へ届いた」機械的証拠とする。
- 最小 VPBS50 case の `snapshot` / `state` は SSE size ladder の縮退 level 0 で送られ、wire の snapshot member と core snapshot が同形である。
- `--hold` 実行では internal probe 以外の SSE client 接続後に初回 inject し、browser が予測→発生の両 step と最終 state を受け取れる。最小版の capture は手動でよいが、将来 gate 化するときは browser executable/version、viewport、font assets、reduced-motion、settle 条件を固定する。

## 6. 段階

### Phase 1 — 最小版

`fleq replay`、XML envelope adapter、専用 state root/cache、loopback dynamic display port、no-op EEW logger/notifier、明示 clock/scheduler、quiescence flush、SSE `snapshot`/`state` barrier を実装する。対象は VPBS50 の予測→発生 2 本のみで、他 type は fail-closed にする。通常 `fleq`、preview、production gate の仕様は変えない。

### Phase 2 — 線状降水帯ケースを定着

予測→発生の snapshot expectation を専用 integration test として固定し、`--interval` の有無を検証する。実 display URL を使う小さな capture recipe を docs に足す。ここでも scenario DSL は追加しない。

### Phase 3 — 代表シナリオ追加

地震、津波、火山、気象警報などから、置換・取消・寿命判定を代表する少数の引数列を追加する。3 本以上で引数列の可読性が限界になった場合だけ、引数列を lossless に保存する最小 JSONL manifest を裁定する。CI/capture 全面統合はその後に別 spec とする。

## 7. 裁定ラベル（案）

### 7.1 一括裁定する 6 要素

朝の一括裁定用。各ラベルは実装 issue の acceptance heading にそのまま使える。

| Label | 決めること | 提案 |
| --- | --- | --- |
| R1 `ingress` | 注入点 | A: connection manager 直後の `routeMessage` 入口 |
| R2 `clock` | business time の所有と frontend handoff | A: 明示 Clock DI + protocol の replay clock field |
| R3 `isolation` | state/cache/events/logger/notifier/port の境界 | B: 専用 `fleq replay`、state dir 必須、loopback + guarded port 0、実 sinks 無生成 |
| R4 `input` | 電文列の記法 | A: fixture 引数順 + wall pacing の optional `--interval` のみ |
| R5 `verification` | 最小の end-to-end gate | B: `/healthz` + 注入前 SSE `snapshot` barrier + 注入後 final `state` compare |
| R6 `first-case` | 最初に固定する業務ケース | VPBS50 線状降水帯の予測→発生、2 fixture、XML は無改変 |

### 7.2 独立 DOC レビュー指摘の反映方針

方針記号は `a` = 指摘どおり修正、`b` = 根拠を示して不採用、とする。今回の 11 件はすべて `a` とした。

| ID / severity | 方針 | 反映内容 |
| --- | --- | --- |
| D1 / High: initial SSE event 名 | **a** | initial は `snapshot`、注入後は `state` と訂正した（§2.3, §3.5, §5.4）。 |
| D2 / High: subprocess 観測 race | **a** | runner 内部 SSE probe の接続・initial `snapshot` 受信を inject 前 barrier にした。`--hold` は外部 client も待つ（§3.5, §3.6）。 |
| D3 / High: `Vpwp50DetailCache` 隔離 | **a** | default constructor/path/cleanup を禁止し、state-dir 指定 cache を DI する。通常 root の file list/hash/mtime も検査する（§2.2, §3.3, §5.2）。 |
| D4 / High: EEW logger / Notifier 隔離 | **a** | 両者を DI port 化し、replay では実 constructor を呼ばない no-op sink にする（§3.3, §4, §5.2）。 |
| D5 / High: Clock DI 到達範囲 | **a** | Phase 1 の virtual clock/scheduler、共通 owner の `SummaryWindowTracker` / `DailyQuakeCounter`、unsupported fail-closed、wall clock 許容を表で分離した（§3.2, §5.3）。 |
| D6 / High: `--snapshot-out` 越境 | **a** | option を削除し、`<state-dir>/final-state.json` 固定にした（§3.3, §5.2）。 |
| D7 / Medium: port 0 が 7788 | **a** | bind 後 actual port も検査し、注入前 close/retry、3 回で失敗する（§3.3, §3.6, §5.2）。 |
| D8 / Medium: REST/WS import graph | **a** | transport-neutral core を別 module へ抽出し、replay graph から REST/WS import を除く。module graph と runtime spy の二段で証明する（§3.1, §3.3, §5.2）。 |
| D9 / Medium: quiescence 不足 | **a** | manual scheduler と冪等 `flushReplayState()`、最終 `state` correlation を必須にした（§3.2, §3.5, §5.3）。 |
| D10 / Medium: 見積りが楽観的 | **a** | cache/sinks/scheduler/core extraction/frontend 配線と対象ファイル表の字面を含む規模へ更新した（「概算」）。 |
| D11 / Medium: 規約の断定 | **a** | 対象外と断定せず、本人・loopback 限定、共有機能外、EEW 追加時の再確認に修正した（§1.1）。 |

### 7.3 再レビュー残点の反映方針

| ID / severity | 方針 | 反映内容 |
| --- | --- | --- |
| RD1 / Medium: 共通 clock owner | **a** | `SummaryWindowTracker` と `DailyQuakeCounter` の constructor/record/snapshot を replay clock に固定し、fallback 0 call を受入条件にした（§3.2, §5.3）。 |
| RD2 / Medium: `events.jsonl` count/path | **a** | `replay.injected` 2 + `replay.final` 1 の全3 records、fixture は checkout-relative・cache/artifact は state-dir-relative、固定順を schema と受入条件にした（§3.3, §3.6, §5.1--5.3）。 |
| RD3 / Low: file-count 上限 | **a** | 対象ファイル表の既知最大19 files を包含する 18--20 files へ概算を更新した。既存 `Vpwp50DetailCache` は変更不要なら参照/test 対象のみと注記した（§4, 「概算」）。 |

## 概算

VPBS50 2 電文だけへ fail-closed に絞っても、Phase 1 は production code **18--20 files**（新規 6 前後、既存 12--14）と test **6--8 files**、計およそ **1,600--2,400 行**を見込む。対象ファイル表の字面上の既知最大は新規6 + 既存13 = 19 files であり、この範囲に収まる。増分の中心は transport-neutral core 抽出、cache/logger/notifier DI、共通 owner を含む clock + scheduler、hub quiescence/SSE probe、frontend business-clock 配線である。VPWS50 recap、火山 batch、EEW 等の replay 対応はこの見積りに含めない。
