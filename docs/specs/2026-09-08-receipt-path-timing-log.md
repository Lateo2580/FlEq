# 電文受理経路の所要時間計測ログ spec

> **状態**: 起草（2026-09-08）→ 独立レビュー反映（2026-09-09、ブロッカー 4・重要 7・軽微 6）
> → ご主人裁定 GO（2026-09-09）→ **実装済み（2026-09-09）**。§6 の分岐は推奨どおり A を採用。
> 実装で判明した訂正は §8 の改訂履歴にまとめ、該当節にも反映済み（消さずに残す）。
>
> **基準 SHA**: `b98caed5f677c61d554d7fe79a2a158c872b157f`（worktree `~/dev/fleq-layout`, branch main）。起草時の `d1474e3` からの `src/` 差分はゼロ（`git diff --stat d1474e3 b98caed -- src/` が空）。本 spec の file:line はすべてこの SHA で再確認済み。
>
> **目的は帰属の確定であって削減ではない。** 「どの区間が何 ms 食っているか」を実機の数字で確定させるまで、削減は一切しない。削減案は §7 に候補として並べるだけで、本 spec では実装しない。
>
> **前提の spec**: `docs/specs/2026-09-07-standby-sweep-hot-path.md`（Issue #13）。本 spec は同 spec の §5.2 B3「電文受理直後の sweep が Pi 実機で 300ms 未満」を**測れるようにする**もので、B3 の達成そのものは受入条件に入れない。

## 1. 症状

### 1.1 実機 A/B 観測（Raspberry Pi 500、2026-09-08）

`/healthz` を 100ms 間隔で叩きながら、旧 `160c29f` と新 `f3c8ddd` を交互に走らせた。

| 観測 | 内容 |
|---|---|
| 停止の発生 | **電文到着の直後に 10/10 通** |
| 停止 1 回の長さ | 280〜2,012ms（2,012ms は probe の timeout 上限で、実際はそれ以上） |
| 電文サイズとの相関 | **無い**（2,364 B の floodForecast で 1,558ms、254,211 B の weather で 2,011ms） |
| #13 段階 2＋4 の前後 | **どちらでも発生**（今日の配送で消えていない） |
| 停止の終端 | `events/` の JSON ファイル mtime とほぼ一致 |

停止終端と events ファイル mtime が一致することから、停止は **受理コールスタックそのもの**であって、3 秒 debounce 後の永続ファイル書き込みではない。

観測資材: scratchpad `pi-ab-A.txt` / `pi-ab-A-events.txt`、調査ノート `receipt-path-investigation.md`。

### 1.2 対応するファイルが無い停止

21:10:35 の 1,546ms 停止には対応する events ファイルが無い。`transactInternal` は capture・clone・`changedOwnerKeys`・`serializePair` ×2 を**判定より前**に済ませてから `rejected` を返す（`src/engine/display/standby-persistence-admission.ts:677-702`）ので、**抑制・却下された電文でもほぼ全コストを払う**。この仮説は本 spec の計測で確かめる。

### 1.3 直接計測が存在しない

2026-09-07 のベンチ（`bench-sweep.mjs`、Apple M5 / Node v26.8.1）は `sweepAll` 単体を測ったもので、**受理経路（`transactInternal` と serialize 群）を測った数字は一度も無い**。Pi 推定値はすべて sweep ベンチからの線形換算で、掛け率 4.6〜6.4 も sweep で得たものを流用している。帰属を推定で確定させない。

## 2. 現状（file:line、基準 SHA で再確認済み）

### 2.1 受理 1 通で走る同期処理の骨格

`weather:VPWS50` を例に取る（`src/engine/presentation/processors/process-weather.ts:26-41`）。

```text
ws-client.handleMessage            :430  JSON.parse(フレーム全文)
  normalizeTelegramMessage         :536
  structuredClone(acknowledgement) :544
message-router.handler             :1970  ← turn 入口
  createEnvelope                   :1904-1934  normalize 再実行 + structuredClone + deepFreeze + JSON.stringify
  if (serializerOwnerActive)       :1974-1977  再入電文はここで queue へ入り turn を開かない
  while (drain)                    :1988-2021
    withVptaRouterOwnerToken(...)  :1996-2005  ← 電文 1 通の実処理（内側に分岐 2 本）
      options.withStandbyDurableNotificationsSuppressed(() => processEnvelope(...))  :2001
      processEnvelope(current!)    :2003
  throwTurnErrors                  :2047  ← turn 出口
```

**drain ループ内の分岐 2 本は両方とも本番で通る。** `:1998-2000` の条件は `route === "typhoonProbability" || route === "weatherWarningTimeseries"` かつ `options?.withStandbyDurableNotificationsSuppressed != null` で、この option は本番配線でも `monitor.ts:995` から渡る。したがって **VPWP50 / VPTA50 は `:2001` を通り、`:2003` は通らない**。実機で観測された 21:11:35 の 2,012ms 停止は `weatherWarningTimeseries` なので、`:2003` だけに計測点を置くと**この電文の行が 1 行も出ない**。

### 2.2 `transactInternal` の区間（`standby-persistence-admission.ts:667-719`）

| 行 | 処理 | 状態全体を何回 |
|---|---|---|
| `:677` | `this.capture()` → `captureMutable()`（`:616-634`）: 7 owner の `cloneSnapshot()` ＋ `currentToken()` | deep clone ×1 |
| `:678` | `structuredClone(captured.domains)` | deep clone ×1 |
| `:681` | `reduce(draft)` | **下記の罠**を参照 |
| `:686` | `changedOwnerKeys(base, draft)`（`:446-451`）: 7 owner を base/draft 両方 `canonicalJson` | stringify ×2 |
| `:694` | `serializePair(draft, PREFLIGHT_ENVELOPE)` | 下表 |
| `:695` | `serializePair(captured.domains, PREFLIGHT_ENVELOPE)` — **base 側も毎回フル生成** | 下表 |
| `:696` | `preflight(draft, candidatePair)`（`:721-752`）。pair が渡るので `:739` の追加 serialize は起きない | stringify ×小 |
| `:715` | `commit(draft, changed)` | 参照差し替えのみ |

**早期 return は 8 本**: `:675`（`invalidTouchedOwners`）、`:683`（`reducerException`）、`:685`（reducer の `rejected`）、`:688`（`unexpectedOwnerMutation`）、`:702`（`admissionFailure`）、`:709`（`deferredDurabilityMismatch`）、`:712`（`logicalGenerationExhausted`）、`:714`（`staleVersion`）。`admit=` の設定を各 return に散らすと取りこぼすので、**出口 1 箇所に固定する**（§3.3 の P3i）。

**`:681` の罠（調査ノートからの訂正）**: 調査ノートは `process-weather.ts:32` と `:129` で `parseWeatherWarning` が 2 回走ると書いたが、理由の説明が正確ではなかった。`:129` は非 admission 経路に見えるが、**reducer の中（`:45`）で `processWeather(msg, {...})` を `persistenceAdmission` 無しの deps で呼ぶ**ため、`:128` の早期 return を通らず `:129` に到達する。したがって 2 回目の body decode ＋ XML parse は **`transactInternal` の `reduce(draft)` 区間の内側**で起きる。P3 の `red=` には電文サイズ比例分が混ざる。**この分離が計測設計で必要**（§3.3 の `redParse=`）。

### 2.3 `serializeStandbyAdmissionPair` 1 回の中身（`:412-419` → `:281-404`）

| 行 | 処理 |
|---|---|
| `:287,300,308,310,312,314,335,341` | `fromSnapshot` を 8 回（gate / standby / vpws50 / vpww56 / tsunami / volcano / flood / canonicalStandby）。各 `loadSnapshot` が `structuredClone` |
| `:288,302,309,311,313,336` | `assertLosslessOwnerSnapshot` を 6 回。1 回につき `cloneSnapshot()` ＋ `canonicalJson` ×2（`:262-271`） |
| `:343-344` | `canonicalJson(projection.volcanoes)` を 2 本作って比較 |
| `:359-401` | 各 holder の `exportPersistedState()`（vpws50 が最大） |
| `standby-persistence.ts:1575-1591 serializeProspectivePair` → `:1649-1655 serializeStatePair` → `:1640-1647 encodeStatePair` | `toV1(state)` ＋ `JSON.stringify(v2)` ＋ `JSON.stringify(v1)` ＋ `Buffer.from` ×2 |
| `standby-persistence.ts:1623-1638 assertSerializedPairLimits` | `standbyVolcanoSubtreeByteLengths` の `JSON.stringify` ×2（volcano subtree、小） |

**`serializeStandbyAdmissionPair` は本番でしか呼ばれない。** coordinator が実際に使う関数は `this.serializePair`（コンストラクタ `:585` で `deps.serializePair ?? defaultSerializePair`）で、既定の `defaultSerializePair`（`:272-279`）は `canonicalJson({ envelope, domains })` を 1 本作るだけの**別実装**であって `serializeStandbyAdmissionPair` を呼ばない。本番配線だけが `monitor.ts:372-373` で本物を注入する。**計測点を `:412` に置くと、テストでは 1 回も動かない**（§3.3 の P4）。

### 2.4 commit 後の 3 回目 serialize

`emitDurable()`（`:789`）→ monitor の durable callback（`src/engine/monitor/monitor.ts:664-667`）→ `scheduleLatestStandbyPersistence()`（同 `:410-423`）→ `scheduleCapturedStandbyPersistence()`（同 `:391-394`）→ `captureLatestStandbyPersistencePair()`（同 `:387-390`）→ `coordinator.captureSerializedPair()`（`standby-persistence-admission.ts:1102-1117`）→ **`serializePair` の 3 回目**（同 `:1108`）。

`monitor.ts:455-456` のコメントは「受信コールスタック上で同期 I/O を走らせない」と書くが、**同期 I/O は避けても同期シリアライズは避けていない**。実書き込みは `armTimer`（`standby-persistence.ts:2222-2230`、`SAVE_DEBOUNCE_MS = 3000`、同 `:764`）の 3 秒後。

**この経路は 1 電文で 2 回立ちうる。** `sweepAll` も `:1094` で自前の `emitDurable()` を呼ぶので、受理前 sweep が durable 変化を起こすと同じコールスタックで `captureSerializedPair` へ到達する。`save=` は加算で定義する（§3.4）。

**suppression 経路の出口が別**: `:2001` を通る VPWP50 / VPTA50 では durable 通知が抑止され、`scheduleLatestStandbyPersistence()` は suppression の出口（`monitor.ts:446-449`、`completesVpwp50Admission` のとき `:448`）で走る。`save=` の帰属もそこに合わせる。

### 2.5 sweep は受理の「前」に入る（調査ノートからの訂正）

調査ノート §1-D は「受理**後**の最初の sweep は必ず全経路」と書いた。正しくは以下の 2 つが別イベントとして存在する。

1. **受理前 sweep**: `sweepStandbyBeforeAdmission`（`:1125-1136`）が `transact` の直前に `sweepAll` を呼ぶ（`process-weather.ts:34`）。**同じ電文の受理コールスタック上**にある
2. **受理後 sweep**: 5 秒タイマー（`hub.ts:477-489`、`SWEEP_INTERVAL_MS` は `src/engine/display/constants.ts:24`）の次の周期。commit で owner version が進み `lastNoopSweep` の token が合わなくなる（`:854-857`）ので通常経路に落ちる。**別の event loop tick**

1 は電文行に載せられる。2 は載せられない。両方の帰属が要るので、**sweep 側にも独立した 1 行**を出す（§3.4）。

**`sweepAll` の成功出口は 3 つあり、上 2 つは戻り値が同一なので呼び出し側から区別できない。**

| 出口 | 行 | 意味 | 直前に置く経路マーカー |
|---|---|---|---|
| 事前判定ヒット | `:859-863` | capture に入らず即 return。最も安い | `:858` |
| 通常経路・変更ゼロ | `:1007-1011` | capture / scratch holder 再構築 / retain 群は払う。**`serializePair` は 0 回**（`:1004` の早期 return が `:1079-1080` より前） | `:1006` |
| 通常経路・変更あり | `:1095-1099` | 上に加えて base の 2 回目 capture ＋ `serializePair` ×2 | `:1093` |

`sweepPre=` は `precheck` / `nochange` / `full` / `skipped` の 4 値にする。「通常経路なら `serCalls` +2」は誤りで、**変更ありのときだけ +2**（§4.3）。

### 2.6 表示配信と `/healthz`

- `runDisplayPipeline`（`message-router.ts:1069`）→ `hub.ts:154-210 ingest` → `transport.broadcast` → `markStateDirty()`（`hub.ts:569-...`）
- debounce（`STATE_DEBOUNCE_MS = 500`、`constants.ts:25`）後のコールバック（`hub.ts:572-...`）で `buildStateSnapshot` ＋ 縮退ラダー。`tickerSyncPending` が立つとラダーを 2 本走らせうる（同 `:582-587`）
- **縮退結果はバイト数を返さない。** `SnapshotDegradeResult`（`src/engine/display/http-server.ts:561-565`）は `snapshot` と `level` だけを持つ。wire バイト数を出すには新しい `JSON.stringify` が要り、§3.5 の「hot path に stringify を追加しない」に抵触する。しかも `http-server.ts` は本 spec の対象ファイルではない。**`[perf-state]` に `bytes=` を出さない**
- `/healthz` ハンドラ自身は `clients.count()` を返すだけ（`src/engine/display/http-server.ts:88-91`）。**停止は純粋に event loop ブロック**であって、ハンドラのコストではない

## 3. 変更

### 3.0 Phase 0 申告

実装者は製品コードを触る前に、変更記録または実装メモへ次を宣言する。

- **倣う既存パターン**: `FLEQ_STANDBY_SWEEP_STRICT` の env フラグ作法（`src/engine/display/standby-persistence-admission.ts:536-540`）。**module load 時に 1 回だけ `process.env` を読み、以後は module スコープの `let` を見る**。テスト用に `__test_` 接頭辞の setter を対で置き、直前値を返す
- **倣うログ形式**: `key=value` を空白区切りで並べ、構造値は `JSON.stringify` で引用する（`src/engine/display/standby-state-store.ts:879` の `revision=${JSON.stringify(revision)}` と同形）。logger は `import * as log from "<相対パス>/logger"`（`src/logger.ts`、`debug`/`info`/`warn`/`error` を持つ）
- **倣う計測テスト**: `test/engine/display/standby-sweep-hot-path.test.ts:101` の `withCallCounters`（`JSON.stringify` / `structuredClone` を測定中だけ包み、呼び出し回数と最大バイト数を返す）。`try` / `finally` で必ず戻す実例は同ファイル `:212-228`
- **不変に保つ契約**: 受理結果（`kind` と `reason`）、永続化される v2/v1 バイト列、`DisplayMutation` と `PresentationEvent`、`durableChanged` の判定、`preflight` の byte/count 検査、`assertLosslessOwnerSnapshot` の全 owner 検査、atomic commit
- **申告する観測点**: §3.3 の表の全行について、実コードの現在の行番号を確認してから着手する

### 3.1 有効化フラグ

新規モジュール `src/engine/perf/receipt-timing.ts` を作る。

```ts
let enabled = process.env.FLEQ_PERF_RECEIPT === "1";
export function __test_setReceiptPerfEnabled(value: boolean): boolean { ... }  // 直前値を返す
export function receiptPerfEnabled(): boolean { return enabled; }
```

- **既定 off**。off のときのコストは `if (!enabled) return fn();` の分岐 1 回と、**`mark(seg, () => ...)` の呼び出し側が作るクロージャ 1 個**だけ。`performance.now()` を呼ばず、collector オブジェクトも文字列も作らない
- クロージャ 1 個の割り当ては受け入れる。これを消すには全観測点を `markStart` / `markEnd` の 2 呼び出しに割る必要があり、例外経路で `markEnd` を取りこぼす形になる。**取りこぼさない形（`try`/`finally` 内蔵の `mark`）を優先する**
- 環境変数は module load 時に 1 回だけ読む。実行中の `process.env` 変更は反映しない（`FLEQ_STANDBY_SWEEP_STRICT` と同じ）
- テストからの切替は `__test_setReceiptPerfEnabled` で行い、**必ず `try` / `finally` で戻す**

### 3.2 計測の伝播方式

受理経路は完全に同期で、`message-router.handler` の drain ループ（`:1988-2021`）が envelope を直列に処理する。よって **module スコープの collector 1 個**で足りる（分岐 2）。

**collector は 3 状態を取る**: `null` / `receipt` / `sweep`。

起草時に置いた署名は以下だった。

```ts
type Segment = "sweepPre" | "cap" | "draft" | "red" | "redParse" | "diff" | "serD" | "serB" | "pre" | "commit" | "save" | "state";
export function beginReceipt(meta: { id: string; type: string; route: string; bytes: number }): void;
export function beginSweep(): void;                       // 5 秒タイマー経由の sweepAll 用
export function mark<T>(seg: Segment, fn: () => T): T;    // collector が null なら素通し
export function countSerializePair(): void;
export function setAdmission(result: string): void;
export function setSweepPath(path: "precheck" | "nochange" | "full"): void;
export function endReceipt(): void;
export function endSweep(): void;
```

**実装した署名（訂正、`src/engine/perf/receipt-timing.ts`）**。

```ts
type Segment = "sweepPre" | "cap" | "draft" | "red" | "redParse" | "diff" | "serD" | "serB" | "pre" | "commit" | "save";
export function beginReceipt(id: string, type: string, route: string, bytes: number): void;
export function endReceipt(): void;
export function beginSweep(): void;
export function endSweep(): void;
export function beginTurn(): void;
export function endTurn(envelopes: number): void;
export function beginState(): void;
export function endState(level: number, ladders: number): void;
export function measureEnvelope<T extends { ordinal: number; byteLength: number }>(fn: () => T): T;
export function mark<T>(seg: Segment, fn: () => T): T;    // collector が null なら素通し
export function countSerializePair(): void;
export function setAdmissionResult(kind: string, reason?: string): void;
export function setSweepPath(path: "precheck" | "nochange" | "full", changedKeys: number, durable: boolean): void;
export function receiptPerfEnabled(): boolean;
export function __test_setReceiptPerfEnabled(value: boolean): boolean;
export function __test_setReceiptPerfClock(next: (() => number) | null): () => number;
```

訂正の理由。

- **`beginReceipt` は meta オブジェクトではなく位置引数**。`{ id, type, route, bytes }` の
  リテラルは off のときも毎回割り当てられ、§3.1 の「off では collector オブジェクトも
  文字列も作らない」に反する。位置引数なら off のコストは分岐 1 回に落ちる
- **`setAdmission` → `setAdmissionResult(kind, reason?)`**。`` `rejected:${reason}` `` の
  文字列連結を off でも払わないよう、連結を module の内側へ移した
- **`setSweepPath` は `changedKeys` / `durable` も受ける**。`[perf-sweep]` の
  `changedKeys=` / `durable=` は `sweepAll` の内側にしか無く、`standbySweep` が返す
  `DisplayMutation` からは取れない（`viewChanged` / `durableChanged` しか持たない）
- **`Segment` から `"state"` を外し、`beginState` / `endState` に分けた**。P7 は 500ms
  debounce 後の別 tick で collector が `null` なので、`mark` の経路には乗らない
- **`measureEnvelope` は戻り値から `ordinal` / `byteLength` を読む**。describe 用の
  クロージャを増やさないための構造的な型付け
- **turn は collector と別の module 変数**。`beginTurn` / `endTurn` は receipt の
  begin/end と入れ子になるので、同じ 1 変数には載せられない

- **`null` のとき `mark` は計測せず `fn()` を素通しする。** `transactInternal` は受理経路以外からも呼ばれる — startup 復元（`src/engine/startup/tsunami-initializer.ts:460`）、火山 REST repair（`src/engine/startup/volcano-initializer.ts:1137,1249`）、briefing critical の monitor 経路（`src/engine/monitor/monitor.ts:807`）。`null` を素通しにしないと、**これらの区間が直前の電文行へ誤って加算される**
- 同様に `sweepAll` も受理経路以外から呼ばれる（`monitor.ts:634` の startup sweep、`volcano-route-handler.ts:347` 経由の REST repair）。`beginSweep` を張るのは `hub.ts:483` の 5 秒タイマーだけ
- `mark` の入れ子は許す（`red` の中に `redParse`）。入れ子分は親から引かない。行の読み手が「`red` のうち `redParse` が内数」と読める形にする
- **再入は起きない前提だが、起きても壊さない**。`beginReceipt` が既存の未確定 collector を上書きするとき、**捨てた行を `[perf-receipt-lost] id=<...> reason=overwritten` として 1 行出す**。黙って捨てると計測点の取り付け漏れが露出しない
- `endReceipt` / `endSweep` は collector が無ければ何もしない。呼び出し側は `try` / `finally` で囲む

### 3.3 観測点

すべて計測とログのみ。**分岐・戻り値・引数・例外の伝播を変えない。**

| # | file:line（基準 SHA） | 区間キー | 測る内容 |
|---|---|---|---|
| P0 | `src/engine/messages/message-router.ts:1979` 直後 / `:2047` 直前 | turn | 1 turn の総所要と drain した envelope 数。**`:1974-1977` の再入 early return 経路では turn を開かない** |
| P0' | `message-router.ts:1996-2005`（`withVptaRouterOwnerToken(...)` の呼び出し**全体**を包む） | — | `beginReceipt` / `endReceipt` の境界。**電文 1 通 = 1 行**。`:2003` だけを包むと `:2001` を通る VPWP50 / VPTA50 の行が出ない（§2.1） |
| P1 | `message-router.ts:1904-1934`（`createEnvelope` の `try` 内） | — | **独立行 `[perf-env]`**。`createEnvelope` は `handler:1973` で turn 開始（`:1979`）より前に走り、再入電文（`:1975`）では**別電文の receipt の内側**で走る。電文行の区間にはできない（M1） |
| P2 | `src/engine/display/standby-persistence-admission.ts:1130`（`coordinator.sweepAll(nowMs)` を包む） | `sweepPre` | 受理**前** sweep の所要 |
| P2' | 同 `:858` / `:1006` / `:1093` | — | `setSweepPath("precheck" / "nochange" / "full")`。3 つの成功出口を区別する（§2.5） |
| P3a | 同 `:677` | `cap` | `capture()` |
| P3b | 同 `:678` | `draft` | `structuredClone(captured.domains)` |
| P3c | 同 `:681` | `red` | `reduce(draft)` 全体 |
| P3d | 同 `:686` | `diff` | `changedOwnerKeys` |
| P3e | 同 `:694` | `serD` | draft 側 `serializePair` |
| P3f | 同 `:695` | `serB` | base 側 `serializePair` |
| P3g | 同 `:696` | `pre` | `preflight` |
| P3h | 同 `:715` | `commit` | `commit(draft, changed)` |
| P3i | 同 `:667-719` の出口 **1 箇所** | — | `setAdmissionResult(...)`。早期 return が 8 本（`:675, 683, 685, 688, 702, 709, 712, 714`）あるので、各 return に散らさず `transactInternal` を薄いラッパで包んで戻り値から決める（本体は `transactInternalCore` へ改名）。**admission に入らない電文は `admit=none`** |
| P4 | 同 `:585`（コンストラクタで `this.serializePair` をラップ） | — | `countSerializePair()`。**`:412` の `serializeStandbyAdmissionPair` ではない**（§2.3）。ラップすれば呼び出し点 `:694` `:695` `:739` `:1079` `:1080` `:1108` の 6 箇所すべてを 1 箇所で数えられる |
| P5 | `src/engine/monitor/monitor.ts:387-390`（`captureLatestStandbyPersistencePair`） | `save` | commit 後の serialize。**加算**（§2.4、1 電文で 2 回立ちうる） |
| P6 | `src/engine/presentation/processors/process-weather.ts:129`（`parseWeatherWarning`） | `redParse` | reducer 内の 2 回目 body decode ＋ XML parse（§2.2 の罠）。**`red` の内数** |
| P7 | `src/engine/display/hub.ts:572` の debounce コールバック内（`:582-587` を包む） | `state` | `buildStateSnapshot` ＋ 縮退ラダーの所要、縮退段数、ラダーを 2 本走らせたか。**500ms debounce 後なので電文行には載らない。独立行**（§3.4） |
| P8 | `src/engine/display/hub.ts:483`（`this.deps.standbySweep?.(nowMs)` を包む） | — | `beginSweep` / `endSweep`。5 秒タイマー経由の sweep 1 回 = `[perf-sweep]` 1 行 |
| Q1 | `message-router.ts:1070`（`runDisplayPipeline` の薄いラッパから core を包む） | `disp` | 表示配信の総所要。**加算**（火山バッチ・reconcile で 1 電文に複数回立つ） |
| Q2 | 同 `:1100`（tap ループ全体。`if (outcomeTaps)` の**外**から包む） | `tapA` | `outcomeTaps` の実行（`runDisplayPipeline` 入口）。**`disp` の内数** |
| Q3 | 同 `:1299`（notifier 後の tap ループ。同じく `if` の外から包む） | `tapB` | `outcomeTaps` の実行（VPTA50 経路）。**`disp` の外**。加算 |
| Q4 | 同 `:1120`（`toPresentationEvent` ＋ `diffStore.apply`） | `pres` | PresentationEvent 変換と差分適用。**`disp` の内数** |
| Q5 | 同 `:1129`（ingest ＋ `publishStats` の `try` ブロック） | `ingest` | displaySink への流し込みと SSE broadcast。**`disp` の内数** |
| Q6 | `src/engine/presentation/processors/process-weather.ts:53` | `parse` | 受理経路 **1 回目**の XML parse。`sweepPre` より前・`transact` の外。`deps.parsed` 経由なら 0。**`redParse`（2 回目）とは別のキー** |
| Q7 | `src/engine/presentation/processors/process-message.ts:1108`（`processMessage` を薄いラッパにし本体を `processMessageCore` へ） | `dispatch` | route adapter 全体。weather 以外の domain の同型 parse を一括で拾う。**容器キーなので内数側**（`parse` と transact 系を丸ごと含む） |
| Q8 | `message-router.ts:1323` / `:1328` / `:1338` | `vptaPres` / `vptaDiff` / `vptaIng` | VPTA50 の表示 3 段。この経路は `runDisplayPipeline` を通らず `disp` / `pres` / `ingest` が立たない |
| Q9 | `message-router.ts:1923` | `eewIng` | EEW lifecycle-only の `displaySink.ingest`。同じく `disp` を通らない |

> **Q6〜Q9 は独立レビューの指摘で足した追補**（削減 spec §9.1a）。**Q6 が残差の主項**で、
> 141KB の電文で約 10 ms/KB。§8.3 の傾き 13.6 ms/KB と同じ直線に乗る。

> **Q1〜Q5 は削減 spec `2026-09-09-receipt-serialize-reduction.md` §9（段階 1.5）の観測点。**
> 起草時の行番号は基準 SHA `40b3e6c`（`:1070` / `:1079-1094` / `:1266-1283` / `:1096-1097` /
> `:1101-1136`）で、実装した `179df2e` でも router に差分は無かった。上の表の行番号は
> **計測ラッパを入れた後**の位置。
>
> **Q2 / Q3 の mark は `if (outcomeTaps)` の外に置く。** 内側に置くと tap 未配線の構成
> （公開 main）でキーごと消え、読み手が「0」と「計測点が無い」を取り違える。
> 外に置けば `tapA=0.0` / `tapB=0.0` が必ず出て、personal の `outcomeTaps` 実装が乗った
> ぶんだけ数字が増える形になる。**tap の実体名は main のコードにも計測にも書かない。**

> **P3i の訂正（実装時の実測）**: 起草時は「地震・EEW 等は `admit=none`」と書いたが、
> **地震（VXSE51）は `standby:quakeHost` で admission に入り `admit=committed serCalls=3` になる**。
> `admit=none` になるのは EEW（VXSE45）と、admission へ到達しない電文。
>
> 受入テストは 2 通りで固定した。(1) 本来の非 admission 経路 = **EEW（VXSE45）**。router の
> 実 `EewEventLogger` は作業ディレクトリの `eew-logs/` へ実書き込みして
> `test/engine/replay/replay-isolation.test.ts` を落とすので、隔離 sink を渡して流す。
> (2) **日付ゲートで弾かれた電文** = この fixture の VPWP50。これは
> `[telegram-date] reason=futureSkewExceeded` で弾かれた電文であって「admission に入って
> から抜けた通常経路」ではない。§1.2 の「events ファイルが無いのに停止した電文」に対応する
> ケースとして、弾かれても行が 1 行出ることだけを固定している。

**P6 の適用範囲**: `redParse` は weather 経路にしか無い。他の domain（津波・火山・洪水）の processor にも同型の二重 parse があるかは本 spec では調べない。行に `redParse=` が出ないのは「その経路には無い」ではなく「まだ計測点を置いていない」と読む。この但し書きを実装のコメントにも残す。

> **2026-09-09 更新（削減 spec §3.1 E の実装後）**: **受理経路の行から `redParse=` は消えた。**
> `processWeatherWithAdmission` が 1 回目の parse 結果を reducer 内の `processWeather` へ
> 渡すようになり、2 回目の body decode ＋ XML parse そのものが無くなったため。
> 以後 `redParse=` が立つのは `parsed` を渡さない経路（テスト・他 processor 経由）だけで、
> **受理行にこのキーが再び現れたら削減が外れた印**である
> （Pi 実測 VPWS50 115KB で 1,177.9ms が復活する）。受入は削減 spec の A6。

### 3.4 出力形式

**1 電文 1 行**。空白区切りの `key=value`。文字列値のうち可変長のもの（`id`）は先頭 16 文字に切る。

```
[perf-receipt] id=01JX7QK3M4P2 type=VPWS50 route=weather bytes=254211 admit=committed serCalls=3 total=1483 sweepPre=248/full cap=41 draft=58 red=203 redParse=61 diff=96 serD=104 serB=98 pre=12 commit=1 save=131
```

- 数値はすべて ms、小数第 1 位まで（`performance.now()` の差を `toFixed(1)`）
- `bytes=` は **`current.byteLength`**（drain 中の envelope の値）から取る。`createEnvelope` の `:1912` は別行（`[perf-env]`）の担当
- `sweepPre=<ms>/<precheck|nochange|full|skipped>`。**実装時の訂正**: 「区間キーが立たなかったらキーごと出さない」の規則が優先するので、`sweepStandbyBeforeAdmission` を通らない経路では `sweepPre` キー自体が出ない。`skipped` は「受理前 sweep は走ったが成功出口 3 つのどれにも到達しなかった」（`rejected` / `staleVersion`）を表す 4 値目として使う
- `admit=committed` / `admit=rejected:<reason>` / `admit=staleVersion` / `admit=none`。**却下でも行を出す**（分岐 4）
- `serCalls` は `this.serializePair` の呼び出し回数。**受理前 sweep 由来のぶんを含む**（同じコールスタックなので）。5 秒タイマーの sweep は別行
- `save=` は commit 後 serialize の**合計**。内訳が要るなら `saveTx=` / `saveSweep=` に分けてよい（実装者判断）
- 区間キーが立たなかった場合はそのキーごと出さない（値 0 と「未通過」を混同させない）
- `total` は P0' の begin/end の差。区間の和とは一致しない（計測していない隙間があるため）。**和が total に一致するとは書かない**

> **2026-09-09 更新（削減 spec §8.5 / §9.2、段階 1.5）**: **内数キーを `|` の右へまとめた。**
> 左が外数（加算して残差を出す対象）、右が内数（親の中に含まれる。足すと二重計上）。
> 内数が 1 つも立たない行では区切り記号ごと出さない。
>
> ```
> [perf-receipt] id=w1 type=VPWS50 route=weather bytes=140995 admit=committed serCalls=2
>   total=347.2 parse=272.7 sweepPre=6.0/nochange cap=0.0 draft=0.0 red=20.0 diff=2.4
>   serD=1.5 serB=0.0 pre=0.1 commit=4.0 disp=39.5
>   | dispatch=307.2 serIn=0.0 serEnc=1.4 tapA=0.0 pres=39.3 ingest=0.1
> ```
>
> 追補 Q6〜Q9 を入れた後の実測（Apple M5 / Node v26.8.1、`displaySink` 未配線）。
> 外数の和 346.2 に対して `total` 347.2 で、**残差は 1.0ms（0.3%）**。
>
> | 位置 | キー（この順で固定） |
> |---|---|
> | 外数（`\|` の左） | `parse` `sweepPre` `cap` `draft` `red` `diff` `serD` `serB` `pre` `commit` `save` `sched` `disp` `tapB` `vptaPres` `vptaDiff` `vptaIng` `eewIng` |
> | 内数（`\|` の右） | `dispatch`（`parse` ＋ transact 系を含む容器）／`redParse`（`red` の内数）／`serIn` `serEnc`（`serD`＋`serB`＋`save` の内数）／`tapA` `pres` `ingest`（`disp` の内数） |
>
> **`redParse` も内数側へ移した。** 削減 spec §8.5 の入れ子表が `red` の内数と明記して
> おり、外数側に残すと `red` と二重計上になる。§9.2 が名指ししたのは `serIn` / `serEnc`
> だけだが、同じ規約を `redParse` に適用しないと区切り記号の意味が壊れる。

turn / envelope 生成 / sweep / state は別行にする。

```
[perf-env] ordinal=1841 ms=112 bytes=254211
[perf-turn] envelopes=3 total=2140 heapDeltaMB=18.4
[perf-sweep] path=full total=214 serCalls=2 changedKeys=2 durable=true
[perf-state] total=54 level=3 ladders=2
[perf-receipt-lost] id=01JX7QK3M4P2 reason=overwritten
```

- `[perf-env]` は P1 で `createEnvelope` 1 回につき 1 行。`ordinal`（`message-router.ts:1919`）で電文行と突き合わせる
- `[perf-turn]` は P0 で 1 turn につき 1 行。`heapDeltaMB` は `process.memoryUsage().heapUsed` の turn 前後差。**turn 単位で 2 回だけ**呼ぶ（区間ごとには呼ばない。`memoryUsage()` 自体が数百 µs かかりうるため、分岐 7）
- `[perf-sweep]` は P8。受理前 sweep は `[perf-receipt]` の `sweepPre=` に載るので、こちらには出さない
- `[perf-state]` は P7。**`bytes=` は出さない**（§2.6、B4）
- `[perf-receipt-lost]` は §3.2 の未確定 collector 上書き時のみ。**この行が出たら計測点の取り付けが漏れている**

### 3.5 挙動不変の担保

- **`JSON.stringify` / `structuredClone` を追加しない。** ログ行の組み立ては数値の `toFixed` と文字列連結のみ。本 spec の行に構造値は無いので `JSON.stringify` は使わない
- **`Date.now()` を新たに読まない**。時計は `performance.now()`（分岐 6）
- **例外経路を変えない。** `mark` は `try` / `finally` で計測を閉じ、例外はそのまま再 throw する
- **off のとき `performance.now()` を 1 回も呼ばない**（受入 A1 が機械的に確認する）
- ログ出力は `log.info` に固定する（分岐 1）。off のときは呼ばれないので平時は無音

### 3.6 やらないこと

- **削減しない。** 全文比較の廃止・`serializePair` の共有・却下電文の早期 return・`basePair` の省略は §7 の候補に留め、本 spec では 1 行も実装しない
- 既定を on にしない
- ログをファイルへ直書きしない（stdout のみ。ファイル化は Pi 側の `tmux pipe-pane` が担う、§4.7）
- `src/engine/display/http-server.ts` を触らない（`[perf-state]` の `bytes=` を諦めた理由、§2.6）
- `SWEEP_INTERVAL_MS` / `STATE_DEBOUNCE_MS` / `SAVE_DEBOUNCE_MS` を変えない
- `perf_hooks` の `monitorEventLoopDelay` を常設しない（別軸の観測で、本 spec の帰属には不要）
- personal 側 `EventFileWriter` を触らない。**Pi は personal を動かしているので、tap 内の書き出しが同期なら受理コールスタックに I/O が乗る**が、その確認と計測は本 spec の許可範囲外（§5.3）
- 電文本文・subject 名・地域名をログに出さない（`id` 先頭 16 文字と `type` / `route` だけ）

## 4. テスト・観測手順

### 4.1 off のゼロコスト検証

`FLEQ_PERF_RECEIPT` 未設定（＝ `__test_setReceiptPerfEnabled(false)`）で電文 fixture を 1 通流し、次を assert する。

- **計測モジュールが捕捉した `performance.now` 参照**の呼び出しが 0 回。グローバルな `performance.now` を spy する形は使えない — **本番コードが既に別用途で使っている**（`src/engine/display/quake-extreme-store.ts:106`、`src/engine/display/hub.ts:139` の `monotonicNow` 既定値）。`receipt-timing.ts` が module スコープに保持した参照を注入可能にし、そこを数える
- `log.info` に `[perf-` で始まる行が 0 行

### 4.2 on の行フォーマット検証

`__test_setReceiptPerfEnabled(true)` で電文 1 通を流し、次を assert する。

- `[perf-receipt]` 行がちょうど 1 行
- 行が正規表現に合致する。キーの**集合と順序**を固定する（`id` `type` `route` `bytes` `admit` `serCalls` `total` の 7 つは必須、区間キーは順序のみ固定して省略可）
- 数値がすべて有限（`NaN` / `Infinity` が出ない）
- `admit` が `committed` / `rejected:<reason>` / `staleVersion` / `none` のいずれか
- **`:2001` 経路（`route` が `typhoonProbability` / `weatherWarningTimeseries`）でも 1 行出る**（B1 の回帰）
- `[perf-receipt-lost]` が 0 行

### 4.3 `serCalls` の実測固定

**本 spec の核。** ケースごとに `this.serializePair` の呼び出し回数を数え、値をテストに固定する。

| ケース | 予測値 | 実測値 | 内訳 |
|---|---|---|---|
| 受理 commit ＋ durable 変化あり | 3 | **3** | `transactInternal:694` `:695` ＋ `captureSerializedPair:1108` |
| 受理 commit ＋ durable 変化なし | 2 | **2** | `emitDurable` が呼ばれない |
| `admissionFailure` による却下 | 2 | **2** | serialize は判定より前 |
| reducer の `rejected` による却下 | 0 | **0** | `:685` で先に return する |
| 受理前 sweep が `precheck` | ＋0 | **＋0** | capture に入らない |
| 受理前 sweep が `nochange` | ＋0 | **＋0** | `:1004` の早期 return が `:1079-1080` より前 |
| 受理前 sweep が `full`（変更あり） | ＋2 | **＋2** | `sweepAll:1079` `:1080` |
| 受理前 sweep が `full` かつ durable 変化あり | ＋3 | **＋3** | 上に加えて `emitDurable:1094` → `monitor.ts:664→666→415→392→389` → `captureSerializedPair:1108` |

**予測 8 件はすべて実測と一致した。** 表の値は `test/engine/perf/receipt-timing.test.ts` の
期待値としてそのまま固定してある（deps 差し替えの計数と P4 カウンタの両方で assert、受入 A6）。

追加で実測した経路（表に無かったもの）。

| ケース | 実測値 | 備考 |
|---|---|---|
| `invalidTouchedOwners` による却下（`:675`） | **0** | capture より前に抜けるので区間キーが 1 つも立たない |
| `staleVersion`（`:714`） | **2** | serialize は判定より前 |
| 実 VPWS50 を router 経路で 1 通（`sweepPre=nochange`） | **3** | `admit=committed`。commit ＋ durable 変化ありの本線 |
| 実 VPTA50 を router 経路で 1 通 | **2** | `transactDeferred` なので `emitDurable` を通らず、3 回目は `onVptaAdmissionCompletion` 側 |

数え方は 2 通りを併用する。

1. coordinator の `deps.serializePair`（`standby-persistence-admission.ts:166-169`）をテストで差し替えて数える
2. P4 のカウンタ（`:585` のラッパ）

**両方を採り、一致することを assert する**（受入 A6）。1 は「テストが注入した関数が何回呼ばれたか」、2 は「計測点が何回動いたか」で、ズレたら計測点の位置が間違っている。

#### 4.3.1 削減 spec 段階 1 後の値（2026-09-09 実装で更新）

`docs/specs/2026-09-09-receipt-serialize-reduction.md` の段階 1（A: commit 後 body 再利用、
C: `changed.length === 0` の早期スキップ）を入れたあと、**本番配線**（`monitor.ts` が
`serializePairSplit` を渡す経路）の値は次に変わった。

> **`serCalls` の定義が変わった。** 段階 1 前は「1.4MB の pair を最初から作った回数」
> だったが、段階 1 後は **「中間表現（body）を build した回数」**である。
> 再利用が効いた `save` は `this.serializePair` を通らず encode だけを走らせるので、
> **1.4MB の `JSON.stringify` を 2 本実走しても `serCalls` には出ない**。
> encode 側の実費は `serEnc` 区間で見る。`serCalls` の減りを
> 「stringify が減った」と読み替えないこと。

| ケース | 段階 1 前 | 段階 1 後 | 理由 |
|---|---|---|---|
| 受理 commit ＋ durable 変化あり | 3 | **2** | `captureSerializedPair` が commit 済み body を再利用し `this.serializePair` を呼ばない |
| 受理 commit ＋ durable 変化なし（`changed` 非空） | 2 | 2 | `emitDurable` が呼ばれないのは従来どおり |
| 受理 commit ＋ `changed.length === 0` | 2 | **0** | `serD` / `serB` / `pre` を払わない（strict では従来どおり 2） |
| `admissionFailure` による却下 | 2 | 2 | serialize は判定より前 |
| reducer の `rejected` / `invalidTouchedOwners` | 0 | 0 | serialize より前に抜ける |
| `staleVersion` | 2 | 2 | serialize は判定より前 |
| 受理前 sweep が `precheck` / `nochange` | ＋0 | ＋0 | 変わらず |
| 受理前 sweep が `full`（変更あり） | ＋2 | ＋2 | `sweepAll` は body を保存も再利用もしない |
| 受理前 sweep が `full` かつ durable 変化あり | ＋3 | **＋3** | 同上。sweep の commit で token が動くので `captureSerializedPair` はフォールバックする |

**予測と実測の差（削減 spec §4.2 の訂正。消さずに残す）**: 上の表は削減 spec の予測どおり
実測で一致した。ただし **`deps.serializePair` だけを差し替えた coordinator（split 無し）では
body 再利用が働かない**ので、§4.3 本表（旧 harness）の値は 3 / 2 のまま変わらない。
これは意図した設計で、旧 dep は「domains 1 つ ＋ envelope 1 つ」しか受けられず、
再利用しても `serIn` 相当を省けないまま deps 差し替えの計数と `serCalls` がずれるだけになる。
`test/engine/perf/receipt-timing.test.ts` の A5 / A6 は旧 dep 経路の値を保ち、
段階 1 後の本番値は `test/engine/display/standby-serialize-reduction.test.ts` が固定する。

#### 4.3.2 削減 spec 段階 3-B 後の値（2026-09-09 実装で更新）

段階 3-B（base pair キャッシュ）を入れると、`transactInternalCore` の base 側は
前回 commit が残した PREFLIGHT_ENVELOPE 済み pair をそのまま使うので
`this.serializePair` を通らない。**`serB` 区間そのものが立たなくなる**。

> **キャッシュは本番配線（`serializePairSplit` dep がある構成）だけで効く。**
> 旧 dep（`deps.serializePair` のみ）の `defaultSerializePair` は `domains` を
> そのまま canonical JSON にするので owner snapshot の `version` 欄がバイト列に出る。
> `commit` の `replacePrevalidated` は draft の `version` 欄を採らず owner 自身の規則で
> 決め直すため、**draft のバイト列は commit 後の base のバイト列と一致しない**。
> したがって §4.3 本表（旧 harness）の値は 3 / 2 のまま変わらない。段階 1 A と同じ線引き。

| ケース | 段階 1 後 | 段階 3-B 後 | 理由 |
|---|---|---|---|
| 受理 commit ＋ durable 変化あり（**キャッシュヒット**） | 2 | **1** | base 側が `serializePair` を通らない。`serB` キーも立たない |
| 受理 commit ＋ durable 変化あり（**ミス**: 直前が commit でない） | 2 | 2 | 従来どおり base を serialize する |
| 受理 commit ＋ durable 変化なし（`changed` 非空・ヒット） | 2 | **1** | 同上 |
| 受理 commit ＋ `changed.length === 0` | 0 | 0 | serialize 経路に入らない（strict では 2） |
| `admissionFailure` / `staleVersion`（ヒット） | 2 | **1** | serialize は判定より前だが base はキャッシュから来る |
| reducer の `rejected` / `invalidTouchedOwners` | 0 | 0 | serialize より前に抜ける |
| 受理前 sweep が `precheck` / `nochange` | ＋0 | ＋0 | 変わらず |
| 受理前 sweep が `full`（変更あり） | ＋2 | ＋2 | `sweepAll` はキャッシュを読まないし書かない |
| 受理前 sweep が `full` かつ durable 変化あり | ＋3 | ＋3 | 同上 |
| **strict（`FLEQ_STANDBY_SWEEP_STRICT=1`）でのヒット** | — | **段階 1 後と同値** | 突き合わせのため base を serialize し直す |

**ミスする経路**（すべて `captured.token` の不一致で自動的に落ちる）: startup 復元・
`restorePrevalidated`・受理前 sweep が `full` で commit した直後・coordinator の外で
owner が動いた直後。`sweepAll` はキャッシュを書かないので、sweep が commit した次の
transact は必ずミスする。

**実測（開発機、状態 v2 = 2,020,996 B、`tornadoByOffice` を積む合成 transact 12 本の中央値）**

| | `serCalls` | `total` | `serD` | `serB` | `serIn` | `serEnc` |
|---|---|---|---|---|---|---|
| キャッシュ off | 2 | 82.4 | 26.0 | 25.7 | 47.7 | 5.5 |
| キャッシュ on | 1 | **56.9** | 26.0 | **キーごと消滅** | 24.2 | 3.6 |

`total` −25.5ms（−31%）。Pi 実機の窓 4 は削減 spec §9.9 の受入 D1 で採る。

### 4.4 挙動不変の検証

同一 fixture を off / on の両方で流し、次が完全一致することを assert する。

- 受理結果（`kind` と `reason`）
- `captureSerializedPair` が返す v2 / v1 のバイト列
- 全 owner の snapshot（`canonicalJson`）
- 発火した `DisplayMutation` / `PresentationEvent` の列

### 4.5 計測が hot path を重くしないことの検証

off / on で **1MB 超の `JSON.stringify` 呼び出し回数** と **1MB 超の `structuredClone` 呼び出し回数** が一致することを assert する。計測は `test/engine/display/standby-sweep-hot-path.test.ts:101` の `withCallCounters` を流用し、`try` / `finally` で必ず戻す（同ファイル `:212-228` が実例）。

### 4.6 既存回帰

- `npm run build`
- `npm test`
- `npm run test:shuffle`（module スコープの `enabled` と collector を触るので**必須**）
- `npm run typecheck:test`

### 4.7 Pi 観測手順（B 項目）

Pi のログは **tmux の scrollback にしか無い**。`start-fleq.sh` は stdout をリダイレクトせず、`history-limit` は 2000 行。観測窓の間だけファイルへ落とす。

**`tmux pipe-pane` は pane の全出力を複製する。** 電文本文は出さない設計でも、複製されるログには **ディスプレイのアクセストークン（`?token=...` を含む URL）** と **formatter が描く地域名・警報見出し**が入る。**生ファイルを Pi の外へ持ち出さない。**

```bash
# Pi 上。<session> と <pane> は実際の値に置き換える
tmux list-sessions
tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_current_command}'

# 1) 観測窓の開始（-o は既存 pipe があれば何もしない。付けないと二重に開く）
RAW=~/perf-raw-$(date +%Y%m%d-%H%M).log
tmux pipe-pane -o -t <session>:<window>.<pane> "cat >> $RAW"

# 2) FlEq を FLEQ_PERF_RECEIPT=1 で再起動する（起動方法は start-fleq.sh の実体に合わせる）

# 3) /healthz probe を同時に回す（別 pane）
#    100ms 間隔・電文 10 通が入る長さ。probe スクリプトは 9/07 と同じものを使う

# 4) 観測窓の終了
tmux pipe-pane -t <session>:<window>.<pane>     # 引数なしで停止

# 5) Pi 上で perf 行だけを抽出し、生ファイルは Pi 上で消す
grep '\[perf-' "$RAW" > ~/perf-receipt-$(date +%Y%m%d-%H%M).log
shred -u "$RAW" 2>/dev/null || rm -f "$RAW"

# 6) 抽出済みファイルだけを持ち帰る
```

- **持ち帰るのは手順 5 の抽出結果だけ。** 生ファイルは Pi 上で消す
- **Pi 側の恒久的な設定変更（`start-fleq.sh` へのリダイレクト追加・`history-limit` 拡大・systemd 化）はご主人裁定が要る**（分岐 5）。本手順は Pi の設定ファイルを 1 行も変えない

### 4.8 区間別中央値表の作り方

抽出したログの各行には **logger のプレフィックス（既定 `FlEq [○ --:--:--]> `、`src/logger.ts:33-37`。接続中は時刻入り）**が付く。集計前に `[perf-` より前を落とす。

```bash
sed -n 's/.*\(\[perf-receipt\] \)/\1/p' perf-receipt-*.log
```

電文 10 通ぶんの `[perf-receipt]` 行から、区間ごとの中央値表を作る。

| 区間 | 中央値 (ms) | 最大 (ms) | 備考 |
|---|---|---|---|
| `sweepPre` | | | `precheck` / `nochange` / `full` の回数も併記 |
| `cap` / `draft` / `red`（内 `redParse`） / `diff` / `serD` / `serB` / `pre` / `commit` | | | |
| `save` | | | commit 後（加算） |
| `total` | | | |
| `[perf-env] ms`（別行、`ordinal` で突き合わせ） | | | 電文サイズ比例 |
| `[perf-turn] total`（別行） | | | **B2 の分子**（§5.2） |

合わせて記録する: 稼働 SHA、Node バージョン、**その時点の v2 / v1 バイト数**、SSE 接続数、`serCalls` の分布、`[perf-receipt-lost]` の有無。

**v2 バイト数は必ず採る。** 9/07 時点で 1,394,092 bytes だったが、VPWS50 の history / partialHistory が再び伸びていれば全区間が線形に悪化する。サイズを添えない数字は次回と比較できない。

## 5. 受入条件

### 5.1 受入 A（機械的、CI 合否に使う）

| # | 条件 | 確認方法 |
|---|---|---|
| A1 | off で計測モジュールが捕捉した `performance.now` 参照の呼び出しが 0 回 | 4.1 |
| A2 | off で `[perf-` 行が 0 行 | 4.1 |
| A3 | on で電文 1 通につき `[perf-receipt]` がちょうど 1 行。**`:2001` 経路（VPWP50 / VPTA50）でも出る** | 4.2 |
| A4 | 行が固定の正規表現に合致し、必須 7 キーが揃い、数値がすべて有限 | 4.2 |
| A5 | `serCalls` が §4.3 の実測固定値と一致（全 8 ケース） | 4.3 |
| A6 | deps 差し替えで数えた serialize 回数と P4 のカウンタが一致 | 4.3 |
| A7 | off / on で受理結果・v2/v1 バイト列・全 owner snapshot・DisplayMutation 列が完全一致 | 4.4 |
| A8 | off / on で 1MB 超の `JSON.stringify` / `structuredClone` 呼び出し回数が一致 | 4.5 |
| A9 | 却下ケース（`admissionFailure` / reducer rejected / `staleVersion`）と非 admission 電文（`none`）でも行が 1 行出て `admit=` が正しい | 4.2 の拡張 |
| A10 | `sweepPre=` が 3 つの成功出口で `precheck` / `nochange` / `full` に正しく分かれる | 4.2 の拡張 |
| A11 | テストスイート全体を通して `[perf-receipt-lost]` が 0 行 | 4.2 |
| A12 | `npm run build` / `npm test` / `npm run test:shuffle` / `npm run typecheck:test` がすべて成功 | 実行ログ |

### 5.2 受入 B（Pi 実機、CI 合否には使わない）

| # | 条件 | 測定 |
|---|---|---|
| B1 | 電文 10 通の `[perf-receipt]` / `[perf-env]` / `[perf-turn]` 行を採取し、§4.8 の区間別中央値表を埋める | 4.7 |
| B2 | 同じ窓の `/healthz` 停止と **`[perf-turn] total`** を 1 対 1 で突き合わせ、**中央値が停止時間の中央値の 80% 以上を説明する**。満たせば帰属確定 | 4.7 |
| B3 | `serCalls` の実測分布が §4.3 の固定値と一致する（実機でも予測どおりか） | 4.7 |
| B4 | v2 / v1 バイト数・稼働 SHA・Node バージョン・SSE 接続数を併記する | 4.7 |

**B2 の分母と分子を揃える。** `/healthz` の停止は `ws-client.ts:430` の `JSON.parse` から始まり `createEnvelope`（`:1904-1934`）を含み、turn が閉じる（`:2047`）まで続く。したがって分子は `[perf-receipt] total` ではなく **`[perf-turn] total`**（P0、`:1979` 直後〜`:2047` 直前）にする。`[perf-receipt]` は turn 内の 1 通分でしかなく、drain で複数通が入った turn では停止の一部しか説明しない。`[perf-env]` は turn の外（`:1973`）なので分子に含まれず、残差として現れる。

**B2 が 80% に届かなかった場合**、残りは (i) `[perf-env]`（turn 開始前の envelope 生成）、(ii) `ws-client.ts:430` の `JSON.parse`（未計測）、(iii) `[perf-sweep]` / `[perf-state]` の別 tick、(iv) GC、(v) **personal 側 `EventFileWriter` の同期 I/O**（§5.3）、(vi) 計測点の隙間、のいずれか。**その場合は帰属未確定として報告し、削減 spec へ進まない。**

> **(iv) GC の切り分け**: `heapDeltaMB` で足りなければ、enabled のときだけ `new PerformanceObserver(...)` を `{ entryTypes: ["gc"] }` で購読し、turn 内の GC 合計時間を `[perf-turn] gcMs=` に足す。**購読は enabled のときだけ張り、off では `PerformanceObserver` を生成しない。** 本 spec の初回実装には含めず、B2 未達のときの追加手として置く。

### 5.3 スコープ外

- 削減の実装（§7 は候補の整理のみ）
- personal 側 `EventFileWriter` の同期性の確認と計測（許可 root 外。main には存在しない）
- `/healthz` 停止そのものの解消
- `ws-client.ts:430` の `JSON.parse` の計測（transport 層。turn の外）
- ブラウザ側の再計測負荷（#15）
- `vpwp50ProjectionRejected` の診断分離（#16）
- Pi の恒久的なログ基盤（systemd / journald 化）

## 6. 判断分岐

### 分岐 1: ログレベルを `log.info` にするか `log.debug` にするか

- **A（推奨）: `log.info`。** `FLEQ_PERF_RECEIPT=1` のときだけ呼ばれるので、既定 off の平時は無音。Pi で `debug` にすると他の debug ログが混ざり、`history-limit 2000` の scrollback がすぐ流れて観測窓を取り逃がす。フラグと出力レベルを 1 対 1 にすると「フラグを立てた＝この行だけが増える」が保証される
- **B: `log.debug`。** 既存の debug 群と同列に置けるが、実機観測のたびに全体のログレベルを下げる必要があり、混入した行を後から grep で分離する手間が増える

### 分岐 2: 計測 context の伝播方式

- **A（推奨）: module スコープの collector 1 個（3 状態）。** 受理経路は完全同期で、router の drain（`message-router.ts:1988-2021`）が envelope を直列化している。引数追加が 0 なので「挙動不変」の diff が小さく、レビューで挙動差を疑う箇所が減る。受理経路外からの呼び出しは `null` 状態の素通しで誤帰属を防ぐ（§3.2）
- **B: 引数で context を引き回す。** 型で伝播が保証されるが、`transactInternal` は reducer 経由で呼ばれるため coordinator の deps に計測 sink を足すことになり、**production 配線に測定用の口が常設される**。本 spec は一時的な計測なのでその負債は割に合わない
- **C: `AsyncLocalStorage`。** 非同期をまたげるが、受理経路は同期なので利点が無く、`als.run()` のオーバーヘッドが off のときも避けにくい

### 分岐 3: sweep の行を電文行に含めるか分けるか

- **A（推奨）: 受理前 sweep は `[perf-receipt]` の `sweepPre=` に載せ、5 秒タイマーの sweep は `[perf-sweep]` の独立行にする。** §2.5 のとおり両者は別の event loop tick なので、1 行に混ぜると「電文 1 通のコスト」の意味が壊れる。分けておけば「受理で 400ms、5 秒後にさらに 250ms」という時間分布がログから直接読める
- **B: 電文行だけを出す。** 行数は減るが、`lastNoopSweep` 失効による受理後の全経路 sweep が計上されず、`/healthz` 停止の一部が説明できないまま残る

### 分岐 4: 却下・抑制された電文でも行を出すか

- **A（推奨）: 出す（`admit=rejected:<reason>`）。** 21:10:35 の「events ファイルが無いのに 1,546ms 停止」を説明できるのはこの行だけ。§1.2 の仮説の検証がそのまま受入 A9 になる
- **B: 受理成功のみ。** 行数は減るが、観測された停止の一部が原因不明のまま残る

### 分岐 5: Pi のログ取得を一時的にするか恒久化するか

- **A（推奨）: 観測窓の間だけ `tmux pipe-pane`（§4.7）。Pi 側の設定ファイルを 1 行も変えない。** 本 spec の目的は 1 回の帰属確定であって、常時ログではない。ロールバックが「pipe-pane を止める」だけで済む。生ファイルは Pi 上で `grep` 抽出してから消す（トークンと地域名が混ざるため）
- **B（要ご主人裁定）: `start-fleq.sh` に恒久的な stdout リダイレクトを足す、または `history-limit` を拡大する。** 次回以降の観測が楽になるが、**Pi の稼働構成の変更**でありログローテーションと容量管理が新しく要る。microSD の書き込み寿命にも効く。しかも常時ログにはアクセストークンが混ざり続ける。本 spec の配送対象には含めず、必要になったら別件で裁定を仰ぐ

### 分岐 6: 時計を `performance.now()` にするか `Date.now()` にするか

- **A（推奨）: `performance.now()`。** 単調で小数 ms の分解能がある。区間が 1ms 未満のもの（`commit` など）が 0 に潰れない。NTP 同期による時計の飛びで負の区間が出ない。本番コードで既に使われている（`quake-extreme-store.ts:106`、`hub.ts:139`）ので新しい依存ではない
- **B: `Date.now()`。** 整数 ms なので短い区間が測れず、NTP 補正で負値が出うる

### 分岐 7: `heapUsed` をどこまで採るか

- **A（推奨）: `[perf-turn]` に turn 前後の 1 対だけ。** 9/07 のベンチでは 1 sweep あたり GC 30ms が計上されており、GC 圧の手掛かりは要る。ただし `process.memoryUsage()` は呼び出し自体が数百 µs かかりうるので、区間ごとに呼ぶと**計測が計測対象を歪める**。B2 が未達だったときの追加手として `PerformanceObserver` の gc 購読を §5.2 の脚注に置く
- **B: 区間ごとに採る。** 帰属は細かくなるが、区間が 10 個以上あるので計測オーバーヘッドが区間の実コストと同じ桁になる区間が出る
- **C: 採らない。** 最も軽いが、B2 が 80% に届かなかったときに GC を候補から外せない

## 7. 次 spec の候補（本 spec では実装しない）

**順位は本 spec の実測で確定する。現在の並びは効果順ではない。** 現時点の根拠では、**候補 2（3 回目 serialize の再利用）と候補 3（`changedOwnerKeys` の version 化）が候補 1 より上**。候補 2 は 1 電文につき確実に 1 回まるごと消え、候補 3 は sweep 側に実装（`changedOwnerKeysByVersion`、`:478`）が既にあって移植で済む。候補 1 は `changed.length === 0` のときにしか効かず、その頻度がまだ分かっていない。

1. **`transactInternal` の `basePair` を省く**（`:695`）。`basePair` は `durableChanged = changed.length > 0 && !pairEqual(basePair, candidatePair)`（`:707`）にしか使われない。`changed.length === 0` なら `durableChanged` は必ず false なので、その場合は `serD` / `serB` / `pre` の 3 つとも不要になりうる。`preflight` も base で既に通っている。**安全性の検討が要る**（`changed.length === 0` でも preflight を通す意味があるか）。**効果は「変更ゼロで終わる受理」の頻度次第**で、それは本 spec の `admit=` と `diff=` の分布から読める
2. **commit 後の 3 回目 serialize を candidate pair の再利用に置き換える**（`monitor.ts:387-390` → `standby-persistence-admission.ts:1108`）。`transactInternal` は commit する draft の pair を `candidatePair` として既に持っている。envelope（`logicalGeneration` / `savedAt`）が違うので単純な再利用はできないが、**envelope 部分だけを差し替える経路**があれば 1 回分まるごと消える。**durable 変化のたびに必ず 1 回**なので効果が安定している
3. **`changedOwnerKeys` の全文比較を version 比較へ**（`:686`）。#13 の分岐 5-A で「`unexpectedOwnerMutation` の安全網」を理由に意図的に残置した判断の再検討。sweep 側は既に `changedOwnerKeysByVersion`（`:478`）へ移行済みなので実装は存在する。**安全網を別の形で残せるか**が争点
4. **却下電文の早期 return**。reducer が `rejected` を返す経路（`:685`）は既に serialize 前に抜ける。残るのは `admissionFailure` 経路（`:696-702`）で、ここは preflight のために serialize が要る。**gate 却下がどちらの経路を通るか**を計測で確認してから判断する
5. **受理前 sweep と transact の統合**（`process-weather.ts:34` と `:41`）。同じコールスタックで capture を 2 回している。`sweepAll` の commit と `transact` の capture をまとめられれば 1 回分減る。**atomic commit の契約に触る**ので慎重に
6. **weather 経路の二重 parse を 1 回にする**（`process-weather.ts:32` と `:129`）。§2.2 の罠。reducer に parse 済みの結果を渡せば body decode ＋ XML parse が 1 回で済む。254KB の電文で効く。**電文サイズ比例分なので固定コストの本体ではない**が、大電文の上乗せは消える
7. **`assertLosslessOwnerSnapshot` の頻度削減**（`:262-271`、serialize 1 回につき 6 回）。1 回ごとに `cloneSnapshot()` ＋ `canonicalJson` ×2。**検証を落とすのではなく、頻度か対象を絞れるか**を検討する
8. **`basePair` を coordinator にキャッシュして持ち回る。** commit のたびに「今の状態の pair」を保持しておけば、次の `transactInternal` の `:695` が不要になる。候補 1 が「要らない場合に作らない」なのに対し、これは「毎回作らずに使い回す」。**安全性は候補 1 より重い** — `sweepAll` の commit（`:1093`）でもキャッシュを更新しなければならず、startup 復元（`restorePrevalidated`）と REST repair でも無効化が要る。キャッシュが 1 世代でも古いと `durableChanged` の判定が壊れ、**永続化の取りこぼしという最も静かな壊れ方**をする。候補 2 と設計が重なるので、どちらか一方に寄せる

---

## 8. 改訂履歴

### 2026-09-09 実装（`FLEQ_PERF_RECEIPT=1`）

観測点はすべて基準 SHA `b98caed` の行番号どおりに実在した。実装で入った訂正は以下。

1. **§3.2 の API 署名を訂正**（off のゼロコストを守るため位置引数化、`state` を `Segment`
   から分離、turn を別変数へ）。理由は §3.2 の「実装した署名」節に併記
2. **§3.3 P3i の「地震・EEW 等は `admit=none`」を訂正**。地震は admission に入る（実測）
3. **§3.4 の `sweepPre=.../skipped` の意味を訂正**。`skipped` は「sweep は走ったが成功出口に
   到達しなかった」。`sweepStandbyBeforeAdmission` を通らない経路ではキーごと出ない
4. **§4.3 の `serCalls` 予測 8 件はすべて実測と一致**。表を実測値として確定し、
   `invalidTouchedOwners` / `staleVersion` / 実 VPWS50 / 実 VPTA50 の 4 行を追加
5. **P1 の計測範囲を `createEnvelope` 全体にした**。`try` の内側だけを包むと本体を
   1 段深くインデントし直すことになるので、`buildEnvelope` へ改名して薄いラッパから
   `measureEnvelope` を呼ぶ形にした。`assertSerializerHealthy()` と
   `routerClock.nowMs()` のぶん（µs オーダー）が `[perf-env] ms=` に含まれる
6. **P7 の計測範囲は `hub.ts:582-587` のラダー 2 本**。`result` を `try` の外へ出し、
   `finally` から `endState(level, ladders)` を呼ぶ形に組み替えた（分岐・戻り値は不変）
7. **`setSweepPath` に guard を足した**（独立レビュー M1）。受理コールスタック上には
   `sweepStandbyBeforeAdmission` 以外の `sweepAll` もある
   （`volcano-route-handler.ts:186` / `:230` の `sweepStatefulFoundation`）。guard が無いと
   それらが `sweepPath` を上書きし、`sweepPre=<ms>/<path>` の ms と path が別々の sweep を
   指しうる。`mark("sweepPre")` の**内側にいる間だけ** true になるフラグを立て、
   `setSweepPath` はそれを要求する。**フィールド削除ではなく guard 化を選んだ理由**:
   削除すると死んだ状態は消えるが、誤帰属そのものは残る
8. **`endTurn` を `finally` へ移した**（独立レビュー M2）。drain の `finally` や flush
   ブロックから例外が抜ける経路で turn が閉じず、次の `beginTurn` が黙って上書きしていた。
   対として `[perf-turn-lost] reason=overwritten` を足した
9. **collector を捨てる経路をすべて lost 行に揃えた**。`beginSweep` が生きた receipt を
   潰す場合（`reason=sweepOverwrote`）と、closer の kind 違い（`reason=kindMismatch`）を
   黙って return せず 1 行残す
10. **`this.serializePair` のラッパで `this` を復元した**。元の `this.serializePair(...)` は
    `this` が coordinator に束縛されていたので `serializePair.call(this, ...)` に戻した。
    現行の注入実装はどれも `this` 非依存なので実害は無いが、束縛は変えない
11. **A8 に非空検査を足した**。1MiB 超が 0 件だと「0 === 0」の空検査になるので、off 側で
    1 回以上出ていることを先に assert する
12. **受入テストで Date を固定した**。`Vpws50StateHolder` は
   `lastSuccessfulFullDisplayAt` に `new Date()` を書く（`vpws50-state.ts:845` / `:882`、
   DI 無し）ので、同一入力の 2 回実行でも snapshot と serialize 結果がずれる。A7 / A8 は
   `vi.useFakeTimers({ toFake: ["Date"] })` で固定してから off / on を比較する。
   **計測とは無関係の既存の非決定性**で、本 spec では直さない

既存テストの期待値は 1 件も変更していない（`npm test` は 6944 → 6969 件へ増えただけ）。

### 実測した本線 1 行（Apple M5 / Node v26.8.1、fixture `15_18_01_250630_VPWS50.xml`）

fixture の実ファイルは **4,567,490 バイト**。行の `bytes=140995` はファイルサイズではなく
`envelope.byteLength`（正規化済み router snapshot を `JSON.stringify` した UTF-8 長）で、
別物として読む。

```
[perf-receipt] id=w1 type=VPWS50 route=weather bytes=140995 admit=committed serCalls=3
  total=610.9 sweepPre=6.0/nochange cap=0.0 draft=0.0 red=284.2 redParse=264.5
  diff=2.5 serD=2.5 serB=0.0 pre=0.1 commit=3.9
```

**`red=284.2` のうち `redParse=264.5`（93%）が reducer 内の 2 回目 body decode ＋ XML parse。**
§2.2 の罠が開発機でそのまま数字になった。ただしこれは空の owner 状態での測定であって、
Pi 実機の 1.4MB 状態では `cap` / `serD` / `serB` が支配的になりうる。**帰属の確定は §5.2 の
Pi 観測（B1〜B4）でのみ行う。§7 の順位はこの開発機の数字で決めない。**

---

## 裁定ラベル（6 要素）

```
対象:
  src/engine/perf/receipt-timing.ts                              （新規）
  src/engine/messages/message-router.ts                          （P0 / P0' / P1）
  src/engine/display/standby-persistence-admission.ts            （P2' / P3a-i / P4）
  src/engine/monitor/monitor.ts                                  （P5）
  src/engine/presentation/processors/process-weather.ts          （P6）
  src/engine/display/hub.ts                                      （P7 / P8）
  test/engine/perf/receipt-timing.test.ts                        （新規）
  docs/specs/2026-09-08-receipt-path-timing-log.md               （新規）

  （P2 は standby-persistence-admission.ts:1130 の sweepStandbyBeforeAdmission 内なので
    上記 6 ファイル以外に新しい対象は増えない）

許容変更:
  FLEQ_PERF_RECEIPT=1 で有効化される計測ログの追加（既定 off）
  上記 6 ファイルへの計測ラッパの挿入（分岐・戻り値・引数・例外伝播は不変）
  this.serializePair をコンストラクタ（:585）で計数ラップする
  上記を検証するテストの追加

禁止変更:
  受理結果・永続化バイト列・DisplayMutation / PresentationEvent・durableChanged 判定
  preflight の byte / count 検査、assertLosslessOwnerSnapshot の全 owner 検査
  atomic commit の契約
  SWEEP_INTERVAL_MS / STATE_DEBOUNCE_MS / SAVE_DEBOUNCE_MS
  src/engine/display/http-server.ts（[perf-state] の bytes= は出さない）
  §7 の削減候補（1 行も実装しない）
  既定 on 化
  hot path への JSON.stringify / structuredClone の追加
  電文本文・subject 名・地域名のログ出力
  package.json / package-lock.json
  data/runtime/ 配下の実データ
  Pi の start-fleq.sh / tmux 設定（分岐 5-A。恒久化は別裁定）

配送先: main → personal → Pi

ロールバック:
  main は該当 commit を git revert、personal は rebase 追従後に
  git push --force-with-lease private personal、Pi は
  git fetch origin personal && git reset --hard origin/personal で戻す。
  実機側は FLEQ_PERF_RECEIPT を外して再起動すれば計測は即無効になる（コード revert 不要）。
  tmux pipe-pane は引数なしの再実行で停止する。

受入条件: §5.1 の A1〜A12 を全件。§5.2 の B1〜B4 は Pi 観測窓で採取し、
  B2 は [perf-turn] total を分子として突き合わせ、80% 未満なら
  「帰属未確定」として報告し、削減 spec へ進まない。
  §4.3 の serCalls 予測値は実測で訂正し、訂正内容を spec に残す（消さない）。
  Pi の生ログは手順 4.7-5 で抽出してから Pi 上で消す（アクセストークン混入のため）。
```
