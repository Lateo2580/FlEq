# 電文受理経路のシリアライズ削減 spec（GitHub Issue #19 削減便）

> **状態**: 起草（2026-09-09）→ 独立レビュー反映（2026-09-09、High 6・Medium 8・Low 2）
> → **段階 1 実装済み（2026-09-09、裁定 10-A で分岐 2 = A 採択、C を含む）**。
> 段階 2・3 は未着手（§3.2 / §3.3、受入 B2 / B3 の Pi 実測待ち）。
>
> ## 改訂履歴
>
> - 2026-09-09 起草 → 独立レビュー 18 指摘反映
> - 2026-09-09 **段階 1（M1 / M2 / A / C / E）実装完了**。分岐 2 はご主人裁定 10-A で
>   A（C を実装、strict で従来検査を残す）。§7 段階 1 の対象ファイルのみ変更。
>   実装記録は §8 へ。段階 2・3 の裁定ラベルは引き続き空欄（配送不可）
>
> **基準 SHA**: `40b3e6ca340e2affdd41b188d758eaf9e620354e`（worktree `~/dev/fleq-layout`, branch main）。
> 本 spec の file:line はすべてこの SHA で実コードを開いて確認した。
> 直前の 2 commit は `592e5d2`（計測ログ #19）と `40b3e6c`（VPWP50 二分探索）で、
> `standby-persistence-admission.ts` の行番号は計測ラッパのぶん
> `2026-09-08-receipt-path-timing-log.md` の値から下へずれている。
>
> **前提の spec**: `docs/specs/2026-09-08-receipt-path-timing-log.md`（帰属確定・実装済み）と
> `docs/specs/2026-09-07-standby-sweep-hot-path.md`（Issue #13、owner version の双方向不変条件）。
> 本 spec は前者の §7 に並べた削減候補のうち、実測で効果が確定したものだけを実装する。
>
> **方針（ご主人、2026-09-09）**: FlEq はのちに全面再構成する。本 spec は局所最適化に
> 深入りせず、**Pi の受理停止を最小の変更で半分以下にする**ことだけを狙う。
> 永続化方式の置換・状態分割・受理の非同期化は再構成に送り、§7 に材料として残す。

## 1. 症状（実測、削減の出発点）

### 1.1 Pi 500 実測（2026-09-09 08:06〜08:27、稼働 SHA `592e5d2`、`FLEQ_PERF_RECEIPT=1`）

`[perf-receipt]` 35 行。うち `admit=committed` が 15 行、`admit=none` が 20 行
（VPWW53 / VPWW54 / VXWW50 / VPFJ5x。admission に入らず `total` は 0.0〜45.3ms）。
**停止を作っているのは committed の 15 行だけ**である。

| 区間 | 中央値 (ms) | 最大 (ms) | 備考 |
|---|---|---|---|
| `sweepPre` | 0.6 | 196.4 | 15 行中 13 行が `precheck`（#13 段階 3 が効いている） |
| `cap` | 61.1 | 83.5 | 7 owner の `cloneSnapshot` ＋ `currentToken` |
| `draft` | 46.9 | 49.0 | `structuredClone(captured.domains)` |
| `red` | 220.1 | 1359.1 | reducer 全体 |
| └ `redParse` | 18.0 | 1177.9 | `red` の内数。VPWS50 115KB で 1,177.9 |
| `diff` | 48.1 | 50.1 | `changedOwnerKeys` の全文比較 |
| `serD` | 314.0 | 325.4 | draft 側 `serializePair` |
| `serB` | 304.1 | 319.4 | base 側 `serializePair` |
| `pre` | 3.3 | 4.4 | `preflight`（pair 渡し済みなので追加 serialize なし） |
| `commit` | 11.4 | 78.5 | n=13。`changed.length === 0` の 2 行では立たない |
| `save` | 355.9 | 373.0 | n=13。commit 後の 3 回目 serialize |
| **残差** | **191.7** | 1646.1 | `total` − 全区間の和。**未計測**。最大値は中央値と別の現象（§1.2 (ii)） |
| `total` | **1631.5** | 3776.0 | |

`serCalls` の分布: 3 が 13 行、2 が 2 行、0 が 20 行。生ログは scratchpad `pi-perf-lines.txt`。

### 1.2 3 つの読みどころ

**(i) `serializePair` 3 回が 974ms（中央値の 60%）。** `serD` ＋ `serB` ＋ `save` で、
1 通あたり 1.4MB の永続状態を 3 回まるごと作り直している。

**(ii) 残差 191.7ms は帰属していない。** 中央値の 12% がどの区間キーにも載っていない。
`[perf-receipt]` の窓は `withVptaRouterOwnerToken(...)` 全体（`message-router.ts:2011-2028`）
なので、残差には少なくとも次が入る。

- `standbyPersistence.scheduleSerializedPair(pair)`（`monitor.ts:396`）→
  `validateCapturedPair`（`standby-persistence.ts:1657-1697`）。**`save=` の mark は
  `captureLatestStandbyPersistencePair` だけを包む**（`monitor.ts:390-393`）ので、
  この検証は 1 区間も計測されていない
- `runDisplayPipeline`（`message-router.ts:1070`）以降の表示配信・統計・通知

§2.4 のとおり `validateCapturedPair` は 1.4MB の `JSON.parse` ×2 と `JSON.stringify` ×3 を
払うので**中央値の**残差の主項である可能性が高いが、**これは推定であって計測ではない**。
段階 1 で計測点を足して確定させる（§3.1 の M1）。

**残差の最大値 1,646.1ms は中央値とは別の現象である。** この最大値は `serCalls=2` の
VPWS50 行に出ており、その行は `changed.length === 0` → `durableChanged = false` →
`emitDurable` が呼ばれない（`:752`）ので、**`scheduleSerializedPair` も
`validateCapturedPair` も走っていない**。大電文行の残差は `runDisplayPipeline` 以降の
表示配信か GC のどちらかで、**段階 1〜3 のどの候補も効かない**。§1.1 の表で
中央値と最大値を同じ現象として読まない。

**(iii) 大電文の 3.7 秒は別の主犯。** `admit=committed serCalls=2` の VPWS50 2 行
（`total` 3776.0 / 3738.1）は、`red=1359.1` のうち `redParse=1177.9` が reducer 内の
2 回目 XML parse で、かつ `changed.length === 0` なのに `serD` ＋ `serB` を 615ms 払っている。
**この 2 行は中央値には現れないが、実機の体感停止としては最悪ケース**である。

### 1.3 目標

| 指標 | 現在 | 目標 | 到達段階 |
|---|---|---|---|
| committed の `total` 中央値 | 1,631.5ms | **800ms 以下** | 段階 3（B ＋ 必要なら D） |
| `save` 中央値 | 355.9ms | `serEnc` のみ（capture ＋ `serIn` が消える） | 段階 1 |
| VPWS50 大型の `red` | 1,359.1ms | 300ms 未満 | 段階 1 |
| VPWS50 大型の `total` | 3,776.0ms | **2,000ms 前後** | 段階 1 |

**VPWS50 大型に 1,200ms は置かない。** この行の残差 1,646.1ms は §1.2 (ii) のとおり
`sched` ではなく表示配信か GC で、段階 1〜3 のどれも効かない。段階 1 で
`redParse`（1,177.9）と `serD` ＋ `serB`（615.6）が消えて約 1,983ms になるのが下限で、
**それ以上の目標は残差の帰属が付くまで置かない**。

**段階 1 だけでは中央値 800ms に届かない。** §3.1 末尾の算術で段階 1 後は
`1,257.6 + serEnc`（serEnc は未測定、Pi で 50〜100ms 台の見込み）＝ **約 1,310〜1,360ms**。
段階 2 で約 1,120〜1,210ms、段階 3 の B で約 760〜900ms。
**B 単独では 800ms を割らない可能性がある**ので、段階 3 は B を必須・D を条件付きにする
（§3.3）。受入条件は段階ごとに分けて課す（§5.2）。

## 2. 現状（file:line、基準 SHA で確認済み）

### 2.1 `serializePair` は 1 通で 3 回、すべて同じ内容を作り直す

`this.serializePair` は本番配線では `serializeStandbyAdmissionPair`
（`monitor.ts:373-374` → `standby-persistence-admission.ts:413-420`）で、内側は 2 段。

1. `standbyAdmissionSerializationInput(domains)`（`:282-406`）— **owner snapshot から
   scratch holder を組み直す段**
2. `persistence.serializeProspectivePair(projection, foundation, envelope)`
   （`standby-persistence.ts:1575-1590`）— **JSON 化する段**

3 回の呼び出し点と入力。

| # | 呼び出し点 | 入力 domains | envelope |
|---|---|---|---|
| 1 | `:726` `serD` | `draft` | `PREFLIGHT_ENVELOPE` |
| 2 | `:729` `serB` | `captured.domains` | `PREFLIGHT_ENVELOPE` |
| 3 | `:1147` `save`（`captureSerializedPair`） | **commit 直後の `this.capture().domains`** | 実 envelope |

**3 は 1 と同じ内容である。** ただしその根拠は「commit したから」ではなく
**owner の往復性**にある。`commit`（`:789-821`）は各 owner の
`replacePrevalidated(domains[owner])` を呼ぶだけで、たとえば
`Vpws50StateHolder.replacePrevalidated` は `loadSnapshot(snapshot, true)`
（`vpws50-state.ts:735`）である。その直後の `capture()` は同じ holder の
`cloneSnapshot()` を返すので、**`loadSnapshot` → `cloneSnapshot` の往復が
canonical 同一を保つこと**が 3 ≡ 1 の必要十分条件になる。

**この往復を実行時に検査しているのが `assertLosslessOwnerSnapshot`**（`:263-271`）である。
serialize のたびに 6 owner ぶん走っており（§2.2）、A のバイト同一性はこの検査に
支えられている。段階 3 の D はまさにこの検査を既定 off にする案なので、
**A と D は相互作用する**（§3.3 D）。

**volcano owner だけ往復検査が無い。** `:315-333` は `VolcanoStateHolder.fromSnapshot` の
あと code 集合の重複と対応だけを見ており、`cloneSnapshot()` との canonical 比較を
していない（他 6 owner は `:289, 303, 310, 312, 314, 337` で比較している）。
Pi 実測 15 通はすべて `route=weather` で volcano owner を動かしていないので、
**volcano を変える transact での A の健全性は一度も観測されていない**（受入 A1 の必須 fixture）。

違うのは envelope だけで、`save` は `capture()`（約 55ms）＋ `serializePair`（約 300ms）を
まるごともう一度払っている。

### 2.2 `standbyAdmissionSerializationInput` の中身（`:282-406`）

| 種別 | 回数 | 行 |
|---|---|---|
| `fromSnapshot`（各 `loadSnapshot` が `structuredClone`） | 8 | `:288, 301, 309, 311, 313, 315, 336, 342` |
| `assertLosslessOwnerSnapshot`（1 回につき `cloneSnapshot()` ＋ `canonicalJson` ×2） | 6 | `:289, 303, 310, 312, 314, 337` |
| `exportPersistedState()` | 5 | `:359, 366, 383` ほか |
| `canonicalJson(projection.volcanoes)` 比較 | 2 | `:344-345` |
| `structuredClone(domains.volcanoHolderAndRepair.repair)` | 1 | `:382` |

`assertLosslessOwnerSnapshot`（`:263-271`）は 1 回で `canonicalJson` を 2 本作る。
6 回で **12 本**。VPWS50 owner が 1.4MB の大半を占めるので、そのうち 2 本が支配的なはず。
**この内訳は未計測**（§3.1 の M2 で採る）。

### 2.3 envelope が再利用を阻んでいる

`PREFLIGHT_ENVELOPE`（`:249-253`）は
`logicalGeneration: "18446744073709551615"` / `savedAt: "+275760-09-13T00:00:00.000Z"` の
**最大長固定値**で、`preflight` のバイト上限検査（`:775-776`）を最悪ケースで通すためにある。

実 envelope は `reserveSerializationEnvelope()`（`standby-persistence.ts:1429-1438`）が
返す実 generation と実 ISO 時刻で、**必ず PREFLIGHT より短い**。

したがって「transact の serialize を実 envelope でやって save でそのまま使う」ことはできない。
preflight の保守性（最長 envelope で上限を測る）が壊れる。**再利用は envelope 適用より
前の中間表現で行う必要がある**（§3.2 の A）。

### 2.4 `validateCapturedPair` が受理コールスタックでバイト列を作り直す

`scheduleCapturedStandbyPersistence`（`monitor.ts:394-397`）は
`captureLatestStandbyPersistencePair()` のあと `scheduleSerializedPair(pair)`
（`standby-persistence.ts:1450-1459`）を呼び、その冒頭が `validateCapturedPair`
（`:1657-1697`）である。中身。

| 行 | 処理 | 対象 |
|---|---|---|
| `:1660-1661` | `Buffer.from(pair.v2)` / `Buffer.from(pair.v1)` | 1.4MB / 0.29MB のコピー |
| `:1666-1667` | `toString("utf8")` ＋ `JSON.parse` を v2 / v1 の両方 | **parse 2 本** |
| `:1672-1673` | `JSON.stringify(parsedV2)` / `JSON.stringify(parsedV1)` ＋ `Buffer.from` ＋ `Buffer.compare` | **stringify 2 本**（canonical 検査） |
| `:1691` | `this.toV1(v2)` ＋ `JSON.stringify` ＋ `Buffer.from` ＋ `Buffer.compare` | **v1 を 3 回目に作り直す** |
| `:1695` | `assertSerializedPairLimits` → `standbyVolcanoSubtreeByteLengths` の stringify ×2 | volcano subtree（小） |

**検証しているのは、同じ event loop tick で coordinator 自身が作ったバイト列**である。
この境界検査は「外部から渡された pair を writer が信用しない」ための設計で、
`saveSerializedPair`（`:1461`）と共有されている。

### 2.5 weather 経路の二重 parse（`process-weather.ts`）

```text
processWeatherWithAdmission  :27
  parseWeatherWarning(msg)        :33   ← 1 回目（sweep の nowMs を取るためだけに使う）
  coordinator.transact(...)       :42
    reducer 内 processWeather(msg, { persistenceAdmission: undefined })  :46
      processWeather              :125
        deps?.persistenceAdmission != null → false   :129
        parseWeatherWarning(msg)  :136  ← 2 回目。`red` の内数（`redParse`）
```

`parseWeatherWarning` は body decode（base64 → gunzip）＋ XML parse を伴う。
115KB の VPWS50 で **1,177.9ms**。1 回目の結果（`parsed`）は `:35` の
`parsed.meta.receivedAtMs` にしか使われず、**その後 捨てられている**。

`process-weather.ts` の中に `info.*` / `parsed.*` への代入は 1 つも無い（grep 済み）。
ただし `info` は outcome の `parsed:` フィールド（`:222` / `:330`）として router の外へ
出るので、**外側で変異されないことは本 spec の実装時に確認する**（§4.3）。

### 2.6 `changed.length === 0` でも serialize を 2 回払う

`transactInternalCore`（`:693-754`）の順序。

```text
:715  changed = changedOwnerKeys(captured.domains, draft)   ← 全 owner の canonical 比較
:719  changed に想定外 owner があれば rejected
:726  candidatePair = serializePair(draft, PREFLIGHT_ENVELOPE)     ← changed が空でも走る
:729  basePair      = serializePair(captured.domains, ...)          ← 同上
:731  admissionFailure = preflight(draft, candidatePair)
:737  admissionFailure != null なら rejected
:742  durableChanged = changed.length > 0 && !pairEqual(basePair, candidatePair)
:743  if (deferDurable && reduced.durableChanged !== durableChanged) → rejected: deferredDurabilityMismatch
:746  if (durableChanged && !canReserveLogicalGeneration()) → rejected: logicalGenerationExhausted
:749  if (!tokenEquals(captured.token, currentToken())) → staleVersion
:750  if (changed.length > 0) commit(draft, changed)
```

`:743` の `deferredDurabilityMismatch` は **VPTA50 / VPWP50 の `transactDeferred`
（`:666-675`）が乗っている契約**で、reducer の durable 申告と実測が食い違えば却下する。
早期スキップを設計するとき、この検査を飛ばしてはならない（§3.1 C）。

`changed.length === 0` なら `durableChanged` は **論理的に必ず false** で、commit も走らない。
それでも `serD` ＋ `serB` ＋ `pre` を払う。§1.1 の VPWS50 2 行がこれに当たり、
**1 行あたり 615ms が確実に無駄**である。

`changed.length === 0` は「全 owner が canonical 同一」を意味する
（`changedOwnerKeys` `:447-452` は `OWNER_ORDER` 全件を `canonicalJson` で突き合わせる）。
`serializePair` は domains と envelope の純関数なので、このとき
`candidatePair` と `basePair` はバイト列として同一になる。

## 3. 変更

### 3.0 Phase 0 申告

実装者は製品コードを触る前に、変更記録または実装メモへ次を宣言する。

- **倣う既存パターン**: `FLEQ_STANDBY_SWEEP_STRICT` の env フラグ作法
  （`standby-persistence-admission.ts:536-540` 付近。module load 時に 1 回だけ
  `process.env` を読み、`__test_` 接頭辞の setter を対で置く）。新しいフラグ機構を発明しない
- **倣う計測**: `src/engine/perf/receipt-timing.ts` の `mark(seg, fn)`。
  区間キーを足すときは `Segment` union に足すだけで、off のコストを増やさない
- **倣う検証テスト**: `test/engine/display/standby-sweep-hot-path.test.ts:101` の
  `withCallCounters`（1MB 超の `JSON.stringify` / `structuredClone` 回数）と、
  `test/engine/perf/receipt-timing.test.ts` の `serCalls` 固定
- **不変に保つ契約**: 受理結果（`kind` と `reason`）、**永続化される v2/v1 バイト列**、
  `DisplayMutation` / `PresentationEvent`、`durableChanged` の値、
  `preflight` の byte / count 検査、`assertLosslessOwnerSnapshot` の全 owner 検査、
  atomic commit、`logicalGeneration` の単調性と「予約した generation は再利用しない」
- **申告する観測点**: §2 の表の全 file:line を実コードで再確認してから着手する

### 3.1 段階 1（🌙自走OK 候補）: 3 回目 serialize の再利用・無変更時のスキップ・二重 parse の解消

段階 1 は 3 つの独立した変更と 2 つの計測点からなる。すべて **バイト列不変**が示せる。

#### M1: `scheduleSerializedPair` の所要を計測する

`monitor.ts:394-397` の `standbyPersistence.scheduleSerializedPair(pair)` を
`receiptPerf.mark("sched", ...)` で包む。`Segment` に `"sched"` を足す。

§1.2 (ii) の残差 191.7ms の主項が `validateCapturedPair` かどうかは推定でしかない。
**段階 2 の対象を決める前にこれを確定させる。**

#### M2: `serializePair` の内訳を 2 区間に割る

A の実装で `serializeStandbyAdmissionPair` が 2 段に分かれるので、その境界に
`serIn` と `serEnc` の 2 区間を置く。段階 3 で B（base pair キャッシュ）と
D（lossless assert）のどちらに寄せるかは、この内訳で決める。

**割り目の位置（2026-09-09 実装で確定、起草時の記述を訂正）**。

| 区間 | 含むもの | 実装 |
|---|---|---|
| `serIn` | `standbyAdmissionSerializationInput`（scratch holder 再構築 ＋ 6 owner の lossless assert ＋ `exportPersistedState`）**と `toV2`** | `standbyAdmissionSerializeSplit` の `build` → `buildProspectiveV2` |
| `serEnc` | envelope の spread ＋ `toV1` ＋ `JSON.stringify` ×2 ＋ `Buffer.from` ×2 ＋ 上限検査 | 同 `encode` → `encodeProspectivePair` |

起草時に `serEnc` を「toV2 / toV1 / stringify ×2」と書いたのは誤りで、`:361` の
「`save` は `serEnc` だけ残る」と自己矛盾していた。**`toV2` は `serIn` 側でなければ
A が成立しない** — 再利用する body は `toV2` の出力そのものだからである。

**段階 3 の D 判定はこの割り目に依存する。** D は `assertLosslessOwnerSnapshot` を
既定 off にする案で、その検査は `serIn` の内側にある。受入 B3 が
「`serIn` が `serEnc` より大きいか」を見るとき、`serIn` には `toV2` も入っている
ことを勘定に入れる（`serIn` が大きくても、その大半が `toV2` なら D の効果は薄い）。

#### A: commit 後の 3 回目 serialize を中間表現の再利用に置き換える

**envelope 適用の手前で割る**（§2.3 の制約）。

1. `standby-persistence.ts` の `serializeProspectivePair`（`:1575-1590`）を 2 つに割る。

   ```text
   buildProspectiveV2(state, foundation) : PersistedStandbyStateV2Body   ← envelope 抜き
   encodeProspectivePair(body, envelope)
     : { v2: Uint8Array; v1: Uint8Array; v2Object; v1Object }             ← 既存の後半そのまま
   ```

   **`v2Object` / `v1Object` は段階 2 の F が使う**。
   `assertSerializedPairLimits`（`standby-persistence.ts:1623-1637`）は
   `standbyVolcanoSubtreeByteLengths(v2, v1)` を呼ぶので **v1 オブジェクトも要る**。
   バイト列だけ返すと段階 2 の trusted 経路が volcano subtree 検査のために
   `JSON.parse` をやり直すことになり、削減の目的を自分で潰す。

   **ただし段階 1 の実装ではこの 2 つを返していない**（2026-09-09）。段階 1 に読み手が
   おらず、`CLAUDE.md` の「足す前に引く」に従って未使用の戻り値を置かなかった。
   **段階 2 の実装時にここを足す**のが F の最初の一手になる（`encodeProspectivePair` の
   内側では `encodeStatePair` が両オブジェクトを既に持っているので、足すのは戻り値だけ）。

   `serializeProspectivePair` は 2 つを順に呼ぶ薄いラッパとして残す（既存呼び出し点の
   シグネチャを変えない）。envelope は現在も `{ ...this.toV2(...), logicalGeneration, savedAt }`
   の形で最後に被せているだけ（`:1583-1587`）なので、この分割はリファクタリングであって
   バイト列を変えない。

2. `serializeStandbyAdmissionPair`（`standby-persistence-admission.ts:413-420`）も同型に割り、
   `standbyAdmissionSerializationInput` ＋ `buildProspectiveV2` までの結果を
   **`StandbyProspectiveBody`** として返せるようにする。

3. `transactInternalCore` は `serD`（`:726`）で body を作り、commit に成功したら
   **`{ token, body }` を coordinator の 1 世代フィールドへ保存**する。
   token は commit 後の `this.currentToken()`（`:751`）。

4. `captureSerializedPair`（`:1141-1156`）は、**まず `this.currentToken()` を保存済み
   `{ token, body }` の token と `tokenEquals` で突き合わせる**。一致すれば
   `capture()` を呼ばずに `encodeProspectivePair(body, envelope)` だけを走らせ、
   返す token には保存済みのものを使う。**一致しなければ従来どおり `this.capture()` ＋
   `serializePair(captured.domains, envelope)` にフォールバックする。**

   判定を `capture()` の**前**に置くのが要点。`this.capture().token` で判定すると
   ヒット時も `cap` 約 55ms を払い続ける。`currentToken()` は 7 owner の `version()` を
   読むだけで clone を伴わない（#13 段階 1 で O(1) 化済み）。

**フォールバックが要る経路**（すべて token 不一致で自動的にミスする）。

| 経路 | 状況 |
|---|---|
| `sweepAll` の `emitDurable`（`:1133`） | **本 spec では `sweepAll` は body を保存しない**（決定、§4.2 の `serCalls` 表と対）。sweep が commit すると owner version が進むのでミスし、従来経路で serialize する |
| VPWP50 / VPTA50 の suppression 出口（`monitor.ts:449-452`） | 出口の直前に `reconcileWeatherWarningForecastGateBindings`（`monitor.ts:442-444`）が standbyStore を変異させる。**この経路では A は効かない見込み** |
| startup 復元・REST repair・briefing critical（`monitor.ts:1220, 1237` ほか） | transact を通らない、または別 token |
| shutdown flush | 同上 |

**正しさの根拠は 2 つある。**

1. **往復性**: §2.1 のとおり `replacePrevalidated` → `cloneSnapshot` が canonical 同一を
   保つこと。実行時にこれを担保しているのが `assertLosslessOwnerSnapshot`（6 owner）で、
   **volcano owner だけ検査が無い**（§2.1）。受入 A1 は volcano を変える transact を
   必須 fixture に含める
2. **鮮度**: token 一致 ⟹ commit 直後から保存状態が動いていない。#13 段階 1 の
   双方向不変条件（`standby-owner-version-invariants.test.ts` が固定）に依存する

**token の volcano 成分についての注記**: `currentToken()`（`:605-618`）の
`volcanoHolderAndRepair` は owner の `version()` ではなく coordinator 自身が持つ
`volcanoRuntimeVersion`（`:568`、初期化 `:585`、加算は `commit` の `:814` と
`restorePrevalidated` の `:843` のみ）である。したがって
**「coordinator を経由しない volcano holder の変異」は token に現れない**。
「token は漏れない」という断定は他 6 owner にしか成り立たない。
coordinator の外から holder を直接変異させる経路が無いことは現行の配線で保たれているが、
**A の正しさがその配線に依存していること**をコードのコメントに残す。

**保存する body は 1 世代のみ**。`commit` に到達しなかった transact（8 本の早期 return）では
保存しない。`restorePrevalidated` / `rollback` は token を変えるので、明示的な無効化は
不要だが、**保存フィールドを `null` に落とす明示的な無効化を `commit` 以外の全出口に置かない**
（token 判定に一本化する。無効化点の列挙は漏れる、token は漏れない）。

**試験用の再利用無効化 setter を置く**: `__test_setStandbyBodyReuseEnabled(value): boolean`
（直前値を返す、`FLEQ_STANDBY_SWEEP_STRICT` の `__test_` 作法に倣う）。
受入 A1 は「再利用が効いた経路」と「フォールバックした経路」の**両方**でバイト列を比べるので、
テストから再利用を off にできないと後者を安定して作れない。

**効果**: `save` 355.9ms のうち `capture()`（約 55ms）＋ `serIn` が消える。`serEnc` だけ残る。
中央値で **−250〜−330ms**（`serEnc` の実測が M2 で出るまで幅で書く）。

#### C: `changed.length === 0` のとき serialize を 3 つともスキップする

`transactInternalCore`（`:715` の直後）に早期分岐を足す。

```text
changed.length === 0 のとき:
  candidatePair / basePair を作らない（serD / serB / pre をスキップ）
  durableChanged = false
  if (deferDurable && reduced.durableChanged !== false)
      → rejected: deferredDurabilityMismatch    ← :743 の契約を必ず残す
  if (!tokenEquals(captured.token, currentToken())) → staleVersion   ← :749 を必ず残す
  commit しない（現行と同じ。:750 の条件がそのまま false）
  committed を返す
```

**`deferredDurabilityMismatch` を飛ばしてはならない。** §2.6 のとおり VPTA50 / VPWP50 の
`transactDeferred` がこの契約に乗っており、reducer が `durableChanged: true` を申告しつつ
`changed` が空だったケースは**現行でも `rejected` になる**。早期分岐でこの検査を
落とすと `rejected` → `committed` に変わる。受入 A7 で固定する。

**正しさの根拠**: §2.6 のとおり `changed.length === 0` ⟹ 全 owner が canonical 同一 ⟹
commit しない ⟹ owner 状態が 1 bit も変わらない ⟹ この transact が新たな上限違反や
不整合を作ることはない。`durableChanged` は現行でも必ず false。

**変わるのは「検出」であって「状態」ではない。** 現行はこの経路でも serialize と
`preflight` を走らせるので、**base に既にある違反をこの transact が検出して `rejected` を
返す**。C 後は検出せず `committed` を返す。消える検出は byte 超過だけではない。

| 消える検出 | 出所 |
|---|---|
| `volcanoCompositeCapacityExceeded` / `volcanoSourceCapacityExceeded` / `volcanoFamilyCapacityExceeded` / `volcanoSubtreeBytesExceeded` | `preflight`（`:760-785`） |
| `v2FileBytesExceeded` / `v1FileBytesExceeded` | `preflight`（`:775-776`）。ただし `serializeStatePair`（`standby-persistence.ts:1649-1655`）が同じ上限で先に throw するので、**実際にはほぼ `candidateSerializationFailed` になる** |
| `candidateSerializationFailed`（`:732-735` の catch） | serializer が投げる不変条件群: `telegram revision gate writer invariant failed`（`:298`）／`<owner> owner snapshot is not lossless`（`:269`）／`standby volcano mirror coupling mismatch`（`:346`）／`unmapped durable revision gate entry`（`:354`）／`serializeStatePair` の byte 上限 |

つまり C は「壊れた base を、何も変えない電文が通報する」経路を 1 本閉じる。
これは (c) 製品緩和に当たるので**分岐 2 でご主人裁定に回す**。
推奨 A では strict モード（`FLEQ_STANDBY_SWEEP_STRICT=1`）のときだけ従来どおり
serialize して検査し、不一致で throw する経路を残す。

**「`captureSerializedPair` が代わりに捕まえる」は成り立たない**（起草時の誤り）。
`changed.length === 0` → `durableChanged = false` → `emitDurable`（`:752`）が呼ばれない →
`captureSerializedPair`（`:1141`）に到達しない。しかも durable callback は
`try` / `catch` ＋ `log.warn` で握られる（`:823-833`）ので、到達しても throw は
受理経路へ伝播しない。**実際に違反を検出するのは「次に何かを変える transact」だけ**である。

**効果**: 中央値には現れない（15 行中 2 行）。該当行で **−615ms**。

#### E: weather 経路の二重 parse を 1 回にする

`WeatherProcessDeps`（`:20-24`）は `Pick<ProcessDeps, ...>` なので、**`parsed?` を Pick の
キー一覧に足すことはできない**（`ProcessDeps` に存在しないキーは Pick できない）。
交差型にする。

```ts
type WeatherProcessDeps = Pick<ProcessDeps, "vpws50State" | ... | "persistenceAdmission">
  & { parsed?: NonNullable<ReturnType<typeof parseWeatherWarning>> };
```

`src/engine/presentation/processors/process-message.ts` は対象外のまま（`ProcessDeps` を
変えないので `processWeather(msg, deps)` の既存呼び出しは構造的にそのまま通る）。

`processWeatherWithAdmission`（`:27`）が reducer 内の `processWeather` 呼び出し（`:46`）へ
`:33` の結果を渡す。`processWeather`（`:125`）の `:136` は
`deps?.parsed ?? perf.mark("redParse", () => parseWeatherWarning(msg))` にする。

- `parsed` が渡された経路では `redParse` キーが立たなくなる。
  **これは受入条件で明示的に固定する**（キーが消えたことを「計測点が壊れた」と読まないため）
- `processWeather` を `persistenceAdmission` 無しで呼ぶ既存の全経路（テスト・他 processor）は
  `parsed` を渡さないので従来どおり parse する。**public シグネチャの意味は変わらない**

**共有の安全性**: §2.5 のとおり `process-weather.ts` 内に `parsed` への代入は無いが、
outcome の `parsed:` フィールドとして router の外へ出る。実装時に §4.3 の deepFreeze
テストで「outcome の `parsed` が誰にも変異されない」ことを確認してから配送する。
確認できなければ分岐 3-B（`structuredClone` して渡す）へ落とす。

**効果**: `redParse` 中央値 18.0ms が消える。VPWS50 大型で **−1,178ms**。

#### 段階 1 の見積もり

中央値の算術を明示する。`save` は消えるのではなく `serEnc` に縮む。

```text
段階 1 後の中央値 = 1,631.5 − save 355.9 + serEnc − redParse 18.0
                  = 1,257.6 + serEnc
```

`serEnc`（toV1 ＋ `JSON.stringify` ×2 ＋ `Buffer.from` ×2）は**未測定**。M2 で採る。
Pi の 1.4MB / 0.29MB に対して 50〜100ms 台と見込む。

| 行の種別 | 現在 | 段階 1 後（見込み） |
|---|---|---|
| committed 中央値 | 1,631.5 | **1,310〜1,360**（`serEnc` = 50〜100 のとき） |
| VPWS50 大型（`serCalls=2`） | 3,776.0 | **1,983**（残差 1,646.1 は残る、§1.2 (ii)） |

**`serEnc` が 42ms 以下でない限り 1,300ms は割らない。** 受入 B5 の閾値はこれに合わせる
（§5.2）。起草時に書いた「1,180〜1,260」は `serEnc` を勘定に入れ忘れた約 100ms の楽観で、
独立レビュー L-1 の指摘により訂正した。

### 3.2 段階 2: `validateCapturedPair` の再検証を trusted 経路へ

**M1 の実測で残差の主項が `validateCapturedPair` だと確定したときだけ実施する。**
確定しなければ段階 2 は残差の実際の主項へ差し替える（§5.2 の B2 が判定する）。

`scheduleSerializedPair`（`standby-persistence.ts:1450-1459`）に、
**coordinator が同じ tick で生成した pair であることを呼び出し側が保証する経路**を足す。

```text
scheduleSerializedPair(pair, trust?: { envelope })
  trust が無い → 従来どおり validateCapturedPair（既存の全呼び出し点の挙動は不変）
  trust がある → 軽い検査だけ:
    - v2 / v1 の byteLength 上限（現行 :1662-1665 と同じ）
    - envelope の logicalGeneration が this.lastReservedLogicalGeneration と一致
      （呼び出し側が持っている値で判定するので JSON.parse が要らない）
    - assertSerializedPairLimits の volcano subtree 検査は **v2 と v1 の両オブジェクト**を
      要求する (standbyVolcanoSubtreeByteLengths(v2, v1)) ので、A の
      encodeProspectivePair が返す v2Object / v1Object をそのまま渡して parse を回避する
  FLEQ_STANDBY_SWEEP_STRICT=1 のときは trust があっても従来の
    validateCapturedPair を走らせ、結果が一致しなければ throw する
```

trusted を渡すのは `monitor.ts:394-397` の `scheduleCapturedStandbyPersistence` だけ。
`saveSerializedPair`（`:1461`）と、外部から pair を受ける他の経路は従来どおり。

**落とす検査と残す検査を明示する。**

| 検査 | trusted で | 理由 |
|---|---|---|
| byte 上限 | **残す** | 安く、writer の最終防衛線 |
| generation 予約済み | **残す**（parse せず envelope から） | 二重書き込みの防止 |
| volcano subtree 上限 | **残す**（body から） | 上限契約 |
| canonical 再 stringify 比較 | 落とす（strict のみ） | 直前に自分が `JSON.stringify` で作ったバイト列 |
| v1 が v2 の忠実な射影か（`toV1` 再構築比較） | 落とす（strict のみ） | 同じ `toV1` で同じ tick に作った |
| schema 検査（version === 2 / 1） | 落とす（strict のみ） | 型で保証された経路のみが trusted を渡す |

**byte 上限と volcano subtree 上限は serialize 側で既に立っている。**
`serializeStatePair`（`standby-persistence.ts:1649-1655`）が `encodeStatePair` の直後に
`assertSerializedPairLimits` を同じバイト列へ実行しており、trusted 経路の再検査は
**二度目**である。それでも残すのは writer の最終防衛線としての意味であって、
新しい情報を得るためではない（分岐 4-A の根拠）。

**効果**: 残差 191.7ms のうち `validateCapturedPair` 相当分。M1 の実測次第で **−150〜−190ms**。

### 3.3 段階 3: base pair の削減

**M2 の内訳（`serIn` / `serEnc`）を見てから、B と D のどちらを主にするか決める。**
段階 3 の起草時点では B を推す（`serB` を丸ごと消せるので内訳に依存しない）。

#### B: base body を token 付きでキャッシュする

A で `{ token, body }` を保存する機構ができているので、**同じフィールドを `serB` からも引く**。

`transactInternalCore` の `:729`（base 側 `serializePair`）を次に置き換える。

```text
captured.token が保存済み { token, body } と一致 → その body を encode して basePair にする
一致しない → 従来どおり serializePair(captured.domains, PREFLIGHT_ENVELOPE)
```

キャッシュは「前回この coordinator が commit した状態の body」なので、**受理が連続する
定常状態ではほぼ必ずヒットする**。ヒットしないのは startup 直後・sweep が commit した直後・
REST repair 直後・VPWP50 suppression 出口の直後。

**`sweepAll`（`:1117-1118`）の serialize 2 回は B の対象外である。** A と同じ決定で
`sweepAll` は body を保存も再利用もしない（§3.1 A のフォールバック表と対）。
`sweepAll` は既に #13 段階 4 で base を遅延取得しており、受理前 sweep が `full` に
落ちる頻度は Pi 実測 15 通中 0 回（`precheck` 13・`nochange` 2）なので、
**削減の対象として優先度が低い**。§4.2 の `serCalls` 表もこの決定に揃える。

**「1 世代古いキャッシュ」は起こらない**。token は commit 後に更新し、判定は
`tokenEquals` の全 owner version 一致。古い body が残っていても token が違うのでミスする。
`durableChanged` の判定（`:742`）は `pairEqual(basePair, candidatePair)` なので、
**キャッシュが誤って新しいものを返すと durable 変化を取りこぼす**——これが最も静かな壊れ方で、
そのために strict 検証を必須にする。

**strict 検証経路（必須）**: `FLEQ_STANDBY_SWEEP_STRICT=1` のとき、キャッシュヒット時も
実際に `serializePair(captured.domains, PREFLIGHT_ENVELOPE)` を走らせ、
バイト列が一致しなければ throw する。#13 段階 4 の strict と同じ形で、
**CI の Test workflow は既に strict 便を持っている**（`fb67852`）。

**効果**: `serB` 304.1ms が定常状態で消える。ヒット率は Pi 観測で採る。

#### D: `assertLosslessOwnerSnapshot` を既定 off の検証に落とす

`standbyAdmissionSerializationInput`（`:282-406`）の 6 箇所の
`assertLosslessOwnerSnapshot` を、`FLEQ_STANDBY_SWEEP_STRICT=1` と
テスト環境でのみ走る形にする。**検査そのものは消さない。**

これは「owner snapshot が holder を往復して同一に戻るか」の不変条件検査で、
**owner 実装のバグを捕まえるためのもの**であって、実データの検証ではない。
既存テストは strict 便で毎回全件を通す。

**M2 で `serIn` が `serEnc` より大きいと分かった場合のみ実施する。**
B の後に残る `serD` 1 回にしか効かないので、効果は D 単独で **−100〜−150ms** の見込み
（未測定）。

##### D と A の相互作用（重要）

**D は A の実行時保証を外す。** §2.1 のとおり A のバイト同一性（3 ≡ 1）は
`replacePrevalidated` → `cloneSnapshot` の往復性に依存し、その往復を**実行時に**
確かめているのが `assertLosslessOwnerSnapshot` である。D で既定 off にすると、
本番では往復性が一度も検査されないまま A が body を再利用することになる。

したがって **D を実施するなら、A のバイト同一性を strict 便以外でも担保する設計が
別途要る**。取りうる形を挙げる（採用は D の実装時に決め、本 spec では決めない）。

| 案 | 内容 | 費用 |
|---|---|---|
| D-i | 再利用時だけ `assertLosslessOwnerSnapshot` を残す（`serD` の初回生成では落とす） | 検査 6 回が再利用経路に戻るので D の効果が半減する |
| D-ii | 往復性を owner ごとの単体テストで固定し、本番では検査しない | 費用ゼロ。ただし「本番データ特有の形」での破れを捕まえられない |
| D-iii | 再利用の代わりに `serEnc` だけ 2 回走らせる（body は共有せず `serIn` の結果を共有する） | A の効果は保つが実装が増える |

**D-ii を暫定の推奨とする**（#13 が owner version の双方向不変条件を
`standby-owner-version-invariants.test.ts` で固定したのと同じ型）。ただし
**volcano owner には往復テストが現状無い**（§2.1）ので、D の前提として
volcano の往復テストを足す。

#### 段階 3 の見積もり

段階 1 後を `1,257.6 + serEnc`（`serEnc` = 50〜100 で 1,310〜1,360）として積む。

| 行の種別 | 段階 1 後 | 段階 2 後（−`sched` 150〜190） | 段階 3 後（B のみ、−`serB` 304.1） |
|---|---|---|---|
| committed 中央値 | 1,310〜1,360 | **1,120〜1,210** | **816〜906** |

**B 単独では 800ms を割らない見込みである。** 目標に届かせるには D が要る
（`serD` の `serIn` ぶんで −100〜−150）。したがって受入 B7 は
「900ms 以下、800ms を割らなければ D を実施」とする（§5.2）。
D の実施には §3.3 の「D と A の相互作用」の設計判断が先に要る。

## 4. テスト

### 4.1 バイト列同一の固定（段階 1 A の核）

同一 fixture を改修前後で流し、`scheduleSerializedPair` に渡る v2 / v1 の**バイト列が
完全一致**することを assert する。

- `Vpws50StateHolder` は `lastSuccessfulFullDisplayAt` に `new Date()` を書く。
  **箇所は 5 つ**（`vpws50-state.ts:845` / `:882` / `:1149` / `:1301` / `:1343`、いずれも DI 無し）
  なので、**`vi.useFakeTimers({ toFake: ["Date"] })` で固定してから比較する**
  （計測 spec §8 の 12 と同じ既知の非決定性。本 spec では直さない）
- 再利用が効いた経路と、フォールバックした経路の両方で採る。
  後者は `__test_setStandbyBodyReuseEnabled(false)` で作る（§3.1 A）
- **volcano owner を変える transact を必須 fixture に含める**（§2.1 の A-2）。
  volcano owner だけ `assertLosslessOwnerSnapshot` による往復検査が無く、
  Pi 実測 15 通も全部 `route=weather` だったので、A の健全性が一度も観測されていない

### 4.2 `serCalls` の期待値更新

計測 spec §4.3 の実測固定表を、本 spec の段階ごとに更新する。

| ケース | 現在 | 段階 1 後 | 段階 3（B）後 |
|---|---|---|---|
| 受理 commit ＋ durable 変化あり | 3 | **2** | **1** |
| 受理 commit ＋ durable 変化なし（`changed` 非空） | 2 | 2 | **1** |
| 受理 commit ＋ `changed.length === 0` | 2 | **0** | 0 |
| `admissionFailure` による却下 | 2 | 2 | 1 |
| reducer の `rejected` による却下 | 0 | 0 | 0 |
| `invalidTouchedOwners` による却下 | 0 | 0 | 0 |
| `staleVersion` | 2 | 2 | 1 |
| 受理前 sweep が `full`（変更あり） | ＋2 | ＋2 | ＋2 |
| 受理前 sweep が `full` かつ durable 変化あり | ＋3 | **＋3** | ＋3 |

**最終行が段階 1 でも ＋3 のままなのは、`sweepAll` が body を保存しないと決めたから**
（§3.3 B）。sweep の `emitDurable`（`:1133`）から入る `captureSerializedPair` は
token 不一致でフォールバックし、従来どおり 1 回 serialize する。
起草時に「＋3 → ＋2」と書いたのは、A のフォールバック表と矛盾していた
（独立レビュー B-2）。**`sweepAll` を対象に含めるなら両方を同時に直す。**

**予測値は実測で訂正し、訂正内容を spec に残す**（消さない）。
数え方は計測 spec §4.3 と同じ 2 通り（deps 差し替えと P4 カウンタ）を併用し、
一致することを assert する。

**`serCalls` の意味が段階 1 で変わった（2026-09-09、実装で確定）。**

段階 1 前の `serCalls` は「1.4MB の pair を最初から作った回数」だった。段階 1 後は
**「中間表現（body）を build した回数」**である。再利用が効いた `save` は
`this.serializePair` を通らず `encode` だけを走らせるので、**1.4MB の `JSON.stringify` を
2 本実走しても `serCalls` には出ない**。

したがって段階 1 後の `serCalls=2` は「1.4MB の stringify が 2 回」ではなく
「build が 2 回・encode が 3 回」を意味する。encode 側の実費は `serEnc` 区間で見る。
deps 差し替えの計数（受入 A3）も `build` を数えるので両者は一致する。
この定義変更は計測ログ spec §4.3.1 にも書いた。

**この意味変更を読み違えると段階 3 の見積もりを外す。** B（base pair キャッシュ）は
`serB` の build と encode を**両方**消すが、D は build 側にしか効かない。
`serCalls` の減り方だけを見て「stringify が減った」と読まないこと。

### 4.3 E の共有安全性

- `parseWeatherWarning` の結果を `deepFreeze` してから
  `processWeatherWithAdmission` を流し、**例外が出ないこと**を assert する
  （reducer 経路と outcome 消費経路の両方で変異が無いことの機械的証明）
- fixture は VPWS50 全国報・VPWS50 地域先行報・VPWW56 の 3 系統
- `parsed` を渡した経路で `redParse` キーが `[perf-receipt]` に出ないことを assert する

### 4.4 C の挙動固定

- `changed.length === 0` で終わる transact が `committed` / `durableChanged: false` を返し、
  `serCalls` が 0 であること
- **`transactDeferred` で reducer が `durableChanged: true` を申告しつつ `changed` が空の
  ケースが、C の前後で同じく `rejected: deferredDurabilityMismatch` になること**
  （§3.1 C の擬似コードが `:743` を残していることの回帰。VPTA50 / VPWP50 の契約）
- `staleVersion`（`:749`）が C の早期分岐でも従来どおり返ること
- 同じ入力を strict モードで流すと従来どおり serialize され、
  検査結果が一致すること（不一致で throw する経路が空回りでないことを、
  base を意図的に壊した fixture で確認する）。**fixture は byte 超過ではなく
  `candidateSerializationFailed` 系にする** — `serializeStatePair` が同じ上限で先に
  throw するので `v2FileBytesExceeded` にはほぼ到達しない（§3.1 C の表）

**strict の実効的な検出は 2 本だけである**（2026-09-09 実装で確定）。

1. serializer が投げる不変条件群（`candidateSerializationFailed` 系）
2. `preflight` の失敗（volcano 4 種の上限・`validateCandidate`）

起草時の擬似コードは 3 本目として `pairEqual(basePair, candidatePair)` の比較も
想定していたが、**これは恒真で到達不能**なので実装から落とした。`changedOwnerKeys` が
全 owner の canonical 全文一致を確かめた後にしかこの分岐へ来ず、`serializePair` は
domains と envelope の純関数なので、両者は必ず同じバイト列になる。
受入 A8 は上の 2 本をそれぞれ固定する（対で「strict off なら committed で素通りする」
ことも確かめ、C が (c) 製品緩和であることを可視にしておく）。

### 4.5 B のキャッシュ健全性（段階 3）

- **ヒット**: 連続 2 通の受理で 2 通目の `serB` が 0 回になること
- **ミス（必須の 4 経路）**: sweep が commit した直後 / `restorePrevalidated` の直後 /
  REST repair の直後 / VPWP50 suppression 出口の直後で、それぞれ従来どおり
  base を serialize すること
- **strict**: キャッシュを意図的に 1 世代古い body で汚染し、strict で throw すること
  （strict が空回りでないことの証明。#13 A11 の (d)(e) と同じ型）
- **取りこぼし検出**: 「owner version は進まないが保存状態は変わる」holder を模して、
  strict が throw すること

### 4.6 hot path を重くしないことの検証

段階ごとに、1 通の受理で 1MB 超の `JSON.stringify` / `structuredClone` / `JSON.parse` の
呼び出し回数を数え、**段階を進めるたびに単調減少すること**を assert する。
`withCallCounters`（`standby-sweep-hot-path.test.ts:101`）を流用し、`JSON.parse` を
数える枝を足す。

### 4.7 既存回帰

- `npm run build`
- `npm test`
- `npm run test:shuffle`（coordinator に module ではなくインスタンスの状態を足すが、
  永続化と共有状態を触るので**必須**）
- `npm run typecheck:test`
- `FLEQ_STANDBY_SWEEP_STRICT=1 npm test`（B / C / D は strict 経路が正しさの根拠）

### 4.8 Pi 観測（同じ窓を採り直す）

計測 spec §4.7 の手順をそのまま使う（`tmux pipe-pane` で観測窓の間だけ採り、
Pi 上で `grep '\[perf-` 抽出してから生ファイルを消す。アクセストークンと地域名が混ざる）。

**前回と同じ条件を揃える**: 稼働 SHA・Node バージョン・**v2 / v1 バイト数**・SSE 接続数・
committed 行数・`serCalls` 分布・`[perf-receipt-lost]` の有無。
v2 サイズが動いていれば全区間が線形に変わるので、**サイズを添えない数字は前回と比較できない**。

**常駐 heap の増分も採る（段階 1 で追加）。** A は commit 済み v2 body を次の commit まで
coordinator に持たせる（Pi で約 1.4MB、1 世代のみ）。分割前は `serD` の直後から
GC 対象だった。Pi は `--optimize-for-size` 運用なので、次を併記する。

- `[perf-turn]` の `heapDeltaMB`（turn 前後差）の中央値と最大
- 観測窓の始点と終点で `process.memoryUsage().heapUsed` を 1 回ずつ（窓全体の常駐増分）

**判定**: 1 世代しか持たないので上限は body 1 つぶんである。窓全体の常駐増分が
v2 バイト数を大きく超えて伸び続けるなら、それは A ではなく別の漏れなので報告する。

## 5. 受入条件

### 5.1 受入 A（機械的、CI 合否に使う）

| # | 条件 | 段階 | 確認 |
|---|---|---|---|
| A1 | `scheduleSerializedPair` に渡る v2 / v1 バイト列が改修前後で完全一致（再利用経路・フォールバック経路の両方） | 1 | 4.1 |
| A2 | `serCalls` が §4.2 の段階別期待値と一致（全 9 ケース） | 1/3 | 4.2 |
| A3 | deps 差し替えの計数と P4 カウンタが一致 | 1 | 4.2 |
| A4 | 受理結果（`kind` / `reason`）・`durableChanged`・全 owner snapshot・`DisplayMutation` / `PresentationEvent` 列が改修前後で完全一致 | 全 | 4.1 / 4.4 |
| A5 | `deepFreeze` した `parsed` で weather 3 fixture が例外なく流れる | 1 | 4.3 |
| A6 | `parsed` を渡した経路で `redParse` キーが出ない。渡さない経路では出る | 1 | 4.3 |
| A7 | `changed.length === 0` の transact が `committed` / `durableChanged: false` / `serCalls: 0`。**かつ `transactDeferred` で reducer が durable を申告した `changed` 空のケースは C の前後とも `rejected: deferredDurabilityMismatch`、`staleVersion` も従来どおり返る** | 1 | 4.4 |
| A8 | C の strict 経路が、`candidateSerializationFailed` 系に壊した base fixture で throw する（空回りでない） | 1 | 4.4 |
| A8' | volcano owner を変える transact で受入 A1 のバイト同一性が成立する | 1 | 4.1 |
| A9 | 1 通あたりの 1MB 超 `JSON.stringify` / `structuredClone` / `JSON.parse` 回数が段階ごとに単調減少 | 全 | 4.6 |
| A10 | trusted 経路と従来経路で、pending に載るバイト列が同一 | 2 | 4.1 |
| A11 | B のキャッシュが 4 つのミス経路で必ずフォールバックする | 3 | 4.5 |
| A12 | B の strict がキャッシュ汚染と owner 取りこぼしの両方で throw する | 3 | 4.5 |
| A13 | `npm run build` / `npm test` / `npm run test:shuffle` / `npm run typecheck:test` / `FLEQ_STANDBY_SWEEP_STRICT=1 npm test` がすべて成功 | 全 | 4.7 |
| A14 | 既存テストの期待値変更が `serCalls` 固定表（§4.2）と `redParse` キーの有無だけであること。それ以外の期待値を変えた場合は理由を実装メモに書く | 全 | diff |
| A15 | **main へ push したあと GitHub Actions（Test workflow）が緑**。`gh run list --limit 1` で run id を取り `gh run watch <id> --exit-status` で確認する。赤なら同じサイクル内で対処し、次サイクルへ持ち越さない | 全 | `.claude/rules/personal-branch-operations.md` |

### 5.2 受入 B（Pi 実機、CI 合否には使わない）

**段階ごとに課す行を分ける。** 段階 1 に段階 3 の目標を課してはならない。

| # | 条件 | 段階 |
|---|---|---|
| B0 | §4.8 の窓で committed 10 行以上を採り、§1.1 と同じ形式の区間別中央値表を埋める | 各段階 |
| B1 | `save` キーが committed 行から消える（再利用が効いた行）。フォールバック行では残り、その頻度を報告する | 1 |
| B2 | **`sched` の中央値を採り、§1.2 (ii) の残差の主項が `validateCapturedPair` かを確定する。** 確定しなければ段階 2 の対象を差し替える | 1 |
| B3 | `serIn` / `serEnc` の中央値を採り、段階 3 で B と D のどちらを主にするか決める | 1 |
| B4 | **観測窓に VPWS50 大型（`bytes` 10 万超）の行が採れた場合**、その行の `red` が 300ms 未満。採れなければ N/A と明記し、次の窓へ持ち越す | 1 |
| B5 | committed の `total` 中央値が **1,400ms 以下**。**かつ相対条件**: `save` キーの消失（または `serEnc` への縮小）が `total` の減少にそのまま反映されている（`旧 total − 新 total ≧ 旧 save − 新 save + 旧 redParse`） | 1 |
| B6 | committed の `total` 中央値が **1,250ms 以下** | 2 |
| B7 | committed の `total` 中央値が **900ms 以下**、`serB` が定常行から消える。**800ms を割らなければ D を実施する**（§3.3 D、D と A の相互作用の節を先に読む） | 3 |
| B8 | 同じ窓の `/healthz` 停止 p99 と `[perf-turn] total` の中央値を併記する。**停止が `total` の改善に追随していなければ帰属が別にある**として報告する | 各段階 |
| B9 | 稼働 SHA・Node バージョン・v2/v1 バイト数・SSE 接続数・`[perf-receipt-lost]` の有無を併記する | 各段階 |

**B5 の閾値の出所**: §3.1 末尾の算術で段階 1 後は `1,257.6 + serEnc`。
起草時の「1,300ms 以下」は `serEnc ≦ 42ms` を要求しており、Pi の 1.4MB / 0.29MB に対して
**達成不能に近い**（独立レビュー L-2）。1,400ms へ緩め、**代わりに相対条件を足した**。
絶対値は状態サイズに左右されるが、相対条件は「A と E が実際に効いたか」を直接見る。
`serEnc` の実測（B3）が出たあと、次の窓では絶対閾値を `1,257.6 + 実測 serEnc + 50ms` へ
締め直す。

### 5.3 スコープ外

- 永続化の頻度・タイミングの変更（分岐 6。(c) 製品緩和なのでご主人裁定）
- 受理の非同期化 / worker 化（§7）
- 永続化の差分書き込み・schema 変更（§7）
- VPWS50 の `history` / `partialHistory` の削減（#13 で「削れない」と確定済み）
- weather 以外の domain の二重 parse 調査（§7）
- ブラウザ側の再計測負荷（#15）・`vpwp50ProjectionRejected` の診断分離（#16）
- Pi の恒久的なログ基盤（計測 spec 分岐 5-B、別裁定）

## 6. 判断分岐

### 分岐 1: A の envelope の扱い

- **A（推奨）: envelope 適用の手前で割り、body を再利用する（§3.1 A）。**
  `serializeProspectivePair` は既に `{ ...this.toV2(...), logicalGeneration, savedAt }` の形で
  envelope を最後に被せているだけなので、割り目が自然な位置にある。
  **バイト列が完全に同一であることを機械的に assert できる**（受入 A1）のが決め手。
  `preflight` は `PREFLIGHT_ENVELOPE` のまま最悪ケースで測り続けられる
- **B: transact の serialize を実 envelope で 1 回にして save でそのまま使う。**
  呼び出しが 1 回減って一番単純に見えるが、**`preflight` が最長 envelope で
  バイト上限を測る保守性を失う**（§2.3）。実 envelope は必ず短いので、
  上限ぎりぎりの候補が preflight を通ったあとで writer 側の上限に当たりうる。却下
- **C: バイト列の envelope フィールドだけを文字列置換する。**
  最速だが、JSON のキー順・エスケープ・出現位置に依存する。schema が動いた瞬間に
  静かに壊れる。却下

### 分岐 2: C で「壊れた base の検出が 1 本減る」ことを許すか（**(c) 製品緩和。ご主人裁定**）

**変わるのは検出であって状態ではない。** `changed.length === 0` の transact は
owner を 1 bit も変えないので、C は新しい破損を作らない。消えるのは
「壊れた base を、何も変えない電文が通報する」経路 1 本である。

**消える検出の範囲は byte 超過だけではない**（§3.1 C の表）。`preflight` の
volcano 4 種（composite / source / family / subtree 上限）と、serializer が投げる
不変条件群（gate writer invariant／owner snapshot is not lossless／volcano mirror
coupling mismatch／unmapped durable revision gate entry）の `candidateSerializationFailed`
も一緒に消える。起草時に「byte 超過だけ」と書いたのは範囲を狭く見積もった誤り。

- **A（推奨）: 許す。ただし strict モード（`FLEQ_STANDBY_SWEEP_STRICT=1`）では従来どおり
  serialize して検査し、不一致で throw する。** この経路が検出するのは
  **base が既に壊れている**ことだけで、検出しても状態は良くならない（`rejected` を返して
  電文を捨てるだけ）。対価は受理経路の 615ms で、実測 15 通中 2 通がこれを払っていた。
  strict 便は CI に恒久追加済み（`fb67852`）なので、破損の検出能力はテストに残る
- **B: 許さない（C を実装しない）。** 現行の却下挙動がそのまま保たれる。
  中央値には効かないので配送判断としては小さい差だが、
  **VPWS50 大型行の 615ms が残る**（3,776 → 2,598 にしかならない）

**「`captureSerializedPair` が代わりに捕まえる」は成り立たない**（起草時の誤り、§3.1 C）。
`durableChanged = false` なので `emitDurable`（`:752`）が呼ばれず、
`captureSerializedPair`（`:1141`）に到達しない。しかも durable callback は
`try` / `catch` ＋ `log.warn`（`:823-833`）で握られる。
**実際に違反を検出するのは「次に何かを変える transact」だけ**である。

### 分岐 3: E で `parsed` をどう渡すか

- **A（推奨）: 同じオブジェクトを渡す。** `process-weather.ts` に代入が無いことは
  確認済みで、§4.3 の deepFreeze テストが機械的に固定する。コストゼロ
- **B: `structuredClone` して渡す。** 変異の心配が消えるが、115KB の parse 結果を
  clone する（parse 1,178ms よりは安いが数十 ms は乗る）。
  **deepFreeze テストが通らなかった場合のフォールバックとして用意する**
- **C: 1 回目の parse をやめ、`sweepStandbyBeforeAdmission` の `nowMs` を別経路で取る。**
  parse 回数は同じく 1 回になるが、`nowMs` の出所が変わるので sweep の期限判定の
  意味が動く。受理前 sweep が「電文の受信時刻」で期限を切る契約を壊す。却下

### 分岐 4: 段階 2 の trusted 経路で落とす検査の範囲

- **A（推奨）: canonical 再 stringify 比較と v1 射影の再構築比較だけを落とし、
  byte 上限・generation 予約・volcano subtree は残す（§3.2 の表）。**
  落とす 2 つは「自分が同じ tick に作ったバイト列を、自分で作り直して見比べる」もので、
  防いでいるのは coordinator の実装バグだけ。それは strict 便と単体テストの領分。
  **残す 3 つも新しい情報を得ているわけではない** — `serializeStatePair`
  （`standby-persistence.ts:1649-1655`）が `encodeStatePair` の直後に
  `assertSerializedPairLimits` を同じバイト列へ実行済みで、byte 上限と volcano subtree は
  **serialize 側で既に立っている**。それでも残すのは writer の最終防衛線としての意味
- **B: `validateCapturedPair` を丸ごと落とす。** 効果は大きいが、byte 上限と
  generation 予約は writer の最終防衛線で、これが抜けると
  「上限超過のファイルを書く」「同じ generation を二重に書く」が通る。却下
- **C: 触らない。** 残差 191.7ms が残る。B2 の実測で残差の主項が
  `validateCapturedPair` でなかった場合は自動的にこれになる

### 分岐 5: 段階 3 を B（base pair キャッシュ）にするか D（lossless assert）にするか

- **A（推奨）: B を主、D を従。** B は `serB` 304.1ms を丸ごと消すので、
  `serIn` / `serEnc` の内訳がどうであっても効く。D は B の後に残る `serD` 1 回にしか
  効かず、効果が内訳依存。**M2（B3）の実測で `serIn` が支配的で、かつ B 後の中央値が
  800ms を割らないときだけ D を足す**。
  **D は A の実行時保証を外す**（§3.3 の「D と A の相互作用」）ので、
  D を足すなら往復性を別の形で担保する設計を先に決める。この順序を逆にしない
- **B: D を主、B をやらない。** キャッシュを持たないので状態が増えず、
  無効化の心配が構造的に無い。ただし効果が未測定で、
  中央値 800ms に届く保証が無い
- **C: 両方やらない（段階 2 で止める）。** 中央値は約 1,000ms に留まる。
  再構成が近いなら合理的な選択肢——**この判断は §7 の再構成時期に依存する**

### 分岐 6: 永続化予約を受理コールスタックから外すか（**(c) 製品緩和。ご主人裁定**）

現在は `scheduleLatestStandbyPersistence()` が**予約の時点でバイト列を固定**し、
3 秒 debounce のあとで書く（`standby-persistence.ts` の `armTimer`、`SAVE_DEBOUNCE_MS = 3000`）。

- **A: dirty フラグだけ立て、debounce 発火時に capture ＋ serialize する。**
  受理コールスタックから `save` ＋ `sched` が**まるごと消える**（現在の中央値で −548ms）。
  ただし保存されるのは「3 秒後の状態」になり、**永続化の意味が変わる**。
  3 秒間の複数電文が 1 回の serialize に畳まれるのは望ましいが、
  (i) 予約時に通っていた上限検査が発火時に落ちて保存されない、
  (ii) shutdown flush の経路が serialize を持つ必要がある、
  (iii) `logicalGeneration` の予約タイミングが変わる、が新しく要る
- **B（推奨）: 今回はやらない。** 本 spec は「最小の変更で半減」なので、
  永続化の意味が変わる変更は範囲外。§7 の再構成材料へ送る。
  段階 1〜3 で中央値 800ms を切れる見込みがあるので、これ無しで目標に届く

### 分岐 7: 受入 B を段階ごとに分けるか

- **A（推奨）: 分ける（§5.2 の B5 / B6 / B7）。** 段階 1 だけで 800ms に届かないことは
  §3 の見積もりで先に分かっているので、段階 1 の配送に達成不能な条件を課さない。
  #13 spec が B0〜B3 を段階別にしたのと同じ型
- **B: 全段階に 800ms を課す。** 段階 1 と 2 が「未達」として報告され続け、
  配送の可否判断が濁る

## 7. 再構成に送る材料（本 spec では触らない）

本 spec は局所削減で 1.6 秒を 0.8 秒台（D まで入れて 0.7 秒台）にするだけで、
**構造は 1 つも直さない**。
全面再構成のときに見るべき事実を列挙する。

- **1.4MB の永続状態を電文 1 通あたり丸ごと 3 回 JSON 化し、2 回 JSON.parse している。**
  段階 1〜3 でこれを 1 回の JSON 化に減らすが、**「毎通、全状態を JSON 化する」設計自体は残る**。
  差分書き込み・追記ログ・binary encoding のいずれも検討されていない
- **v2 / v1 の二重 envelope。** `toV1(v2)` が serialize で 1 回、`validateCapturedPair` で
  もう 1 回走る（`standby-persistence.ts:1971`）。v1 は後方互換のための鏡で、
  **公開 main の読み手が v1 を必要としなくなった時点で消せる**
- **`assertLosslessOwnerSnapshot` が serialize 1 回につき 6 回、`canonicalJson` を 12 本作る**
  （`:263-271`、`:289 303 310 312 314 337`）。owner snapshot と holder の往復が
  lossless であることは型で表現できるはずのもので、実行時に毎回確かめる設計になっている。
  **しかも 7 owner のうち volcano だけ検査が無い**（`:315-333` は code 集合の重複と対応の
  検査のみ）。「毎回確かめる」と「1 つだけ確かめない」が同居している
- **`currentToken()` の volcano 成分だけ出所が違う。** 他 6 owner は holder の `version()` を
  読むが、volcano は coordinator 自身の `volcanoRuntimeVersion`（`:568`）で、
  `commit`（`:814`）と `restorePrevalidated`（`:843`）でしか進まない。
  **coordinator を経由しない volcano holder の変異は token に現れない**。
  owner version の権威を 1 箇所に揃えるべき
- **reducer と admission の二重 parse。** weather 経路は本 spec で直すが、
  **津波・火山・洪水の processor に同型があるかは調べていない**。
  `processX(msg, deps)` が `deps.persistenceAdmission` の有無で自分を呼び直す
  という構造そのものが二重 parse を生む
- **`capture()` が 7 owner の deep clone、`draft` でもう 1 回 clone。**
  1 通あたり `cap` 61ms ＋ `draft` 47ms。owner を immutable にすれば両方消える
- **`changedOwnerKeys` の全文比較（`diff` 48ms）が `transactInternal` に残っている。**
  #13 分岐 5-A で `unexpectedOwnerMutation` の安全網として意図的に残した。
  reducer が触れる owner を型で制約できれば安全網ごと不要になる
- **受理が完全同期で event loop を占有する。** `[perf-turn]` がそのまま `/healthz` の
  停止になる。worker thread か、状態を持たない純関数への分離が要る
- **VPWS50 の `partialHistory` 127 subject が状態の大半を占める。** 取消時の
  `rollback` / `restorePrevious` に必要で削れない（#13 §1.2）が、
  **永続化と別の格納先に置く**なら受理経路のコストから外せる
- **`heapDeltaMB` が 1 通あたり 50〜75MB。** GC 圧が停止に乗っている可能性があるが、
  計測 spec §5.2 の脚注（`PerformanceObserver` の gc 購読）は未実施

## 8. 段階 1 の実装記録（2026-09-09）

### 8.1 入った変更

| 項目 | 実装 |
|---|---|
| M1 `sched` | `monitor.ts` の `scheduleCapturedStandbyPersistence` が `scheduleSerializedPair` を `receiptPerf.mark("sched", ...)` で包む |
| M2 `serIn` / `serEnc` | coordinator が serializer を 2 段で持ち、それぞれを `mark` する。**`serD` / `serB` / `save` の内数**で 1 電文ぶんを合算する |
| A body 再利用 | `serializeProspectivePair` を `buildProspectiveV2` ＋ `encodeProspectivePair` へ分割（段階 1 ではバイト列だけ返す、§3.1 A-1）。coordinator は commit 成功時に `{ token, body }` を 1 世代だけ保持し、`captureSerializedPair` が `currentToken()` 一致時に `capture()` を**呼ばずに** encode だけ走らせる |
| C 早期スキップ | `changed.length === 0` で `serD` / `serB` / `pre` を払わず committed を返す。`deferredDurabilityMismatch` と `staleVersion` は保持。strict では従来どおり serialize + preflight を走らせ、失敗を throw で露出させる（実効検出は 2 本、§4.4） |
| E 二重 parse 解消 | `WeatherProcessDeps` を交差型にし `parsed?` を追加。`processWeatherWithAdmission` が reducer へ渡す |

**A の有効化は新しい dep `serializePairSplit` に紐づく。** 旧 `serializePair` dep だけを
渡した coordinator（既存テストの大半）は従来どおり `capture()` ＋ 全体 serialize を払う。
旧 dep は「domains 1 つ ＋ envelope 1 つ」しか受けられず、そこで再利用しても `serIn` 相当を
省けないまま「deps 差し替えの計数」と `serCalls` がずれるだけになるため（受入 A3 が壊れる）。
本番配線（`monitor.ts`）は `standbyAdmissionSerializeSplit(standbyPersistence)` を渡す。

試験用フラグは `__test_setStandbyBodyReuseEnabled(value): boolean`（既定 on、直前値を返す）。

### 8.2 受入 A の結果

| # | 結果 | 根拠 |
|---|---|---|
| A1 | 合格 | `standby-serialize-reduction.test.ts`。weather 3 通の v2 / v1 が再利用経路とフォールバック経路で完全一致。writer の `validateCapturedPair` も両経路で通す |
| A2 | 合格 | §4.2 の 9 ケースのうち本番配線で作れる 7 ケースを固定（durable 変化あり 2 / `changed` 空 0 / 再利用 off 3 / `admissionFailure` 2 / `staleVersion` 2 / sweep `full` ＋2 / sweep `full` ＋ durable ＋3）。reducer `rejected` と `invalidTouchedOwners` の 0 は `receipt-timing.test.ts` が既に固定済み |
| A3 | 合格 | 中間表現を作った回数（deps 差し替え）と `serCalls` が一致 |
| A4 | 合格 | owner snapshot 指紋が再利用の有無で一致。受理結果・`durableChanged` も一致 |
| A5 | 合格 | `process-weather-parsed-reuse.test.ts`。deepFreeze した `parsed` で VPWS50 全国報 / VPWW55 地域先行報 / VPWW56 が例外なく流れ、**parse は 1 通 1 回** |
| A6 | 合格 | 受理経路の行に `redParse=` が出ない。`parsed` を渡さない `processWeather` では従来どおり出る |
| A7 | 合格 | `changed` 空が committed / `durableChanged: false` / `serCalls: 0`。`transactDeferred` の durable 申告付きは `rejected: deferredDurabilityMismatch`、`staleVersion` も従来どおり |
| A8 | 合格 | strict の実効検出 2 本（serializer 例外＝`candidateSerializationFailed` 系、`preflight` 失敗）をそれぞれ固定。同じ入力が strict off では committed で素通りすることも対で確かめる |
| A8' | 合格 | VFVO50 を `VolcanoRouteHandler` で流し、volcano owner を動かす transact でもバイト列と owner snapshot が一致 |
| A9 | 合格 | 1MB 超の `JSON.stringify` / `structuredClone` / `JSON.parse` が再利用ありで再利用なしを上回らない |
| A13 | 合格 | `npm run build` / `npm test` / `FLEQ_STANDBY_SWEEP_STRICT=1 npm test` / `npm run test:shuffle` / `npm run typecheck:test` すべて成功（304 file / 7,004 test） |
| A14 | 合格 | 既存期待値の変更は `receipt-timing.test.ts` の区間キー一覧（`serIn` / `serEnc` / `sched` 追加）と P6 の `redParse` 有無だけ |
| A15 | 未実施 | main への push 後に確認する |

### 8.3 開発機の `[perf-receipt]`（Pi ではない。傾向確認用）

同一 VPWS50 fixture（141KB）を本番配線の router へ 1 通、`sweepPre=nochange` の行。

| 区間 | 再利用 off（before 相当） | 再利用 on（after） |
|---|---|---|
| `serCalls` | 3 | **2** |
| `serIn`（1 電文の合算） | 34.8ms | **18.4ms** |
| `serEnc`（同） | 1.8ms | 2.0ms |
| `save` | 22.6ms | **1.0ms** |
| `sched` | 2.8ms | 2.9ms |
| `[perf-turn] heapDeltaMB` | -40.6 | 68.1 |

**この「before」は A のぶんだけを外した近似で、E のぶんは含まない。** `parsed` の受け渡しは
実行時に切れないため。同機での `parseWeatherWarning` 単体は 286.3ms（Pi の `redParse` 中央値
18.0ms / 最大 1,177.9ms に対応する処理）で、E はこれを丸ごと 1 回ぶん消す。

**`heapDeltaMB` は turn 単位の差分で GC の位置に大きく振れるため、この 2 行から
常駐の増減は読めない。** A が持たせる body 1 世代（約 1.4MB）の常駐影響は
受入 B の Pi 観測（§4.8 の常駐 heap 項目）で採る。

`sched` は開発機で 2.8ms しか立たなかった。Pi の残差 191.7ms の主項が
`validateCapturedPair` かどうかは**開発機の数字では判定できない**（状態サイズが違う）。
受入 B2 は Pi 実測で採る。

---

## 裁定ラベル（段階 1、🌙自走OK 候補）

```
対象:
  src/engine/display/standby-persistence.ts          （serializeProspectivePair の 2 分割）
  src/engine/display/standby-persistence-admission.ts（A の body 保存・再利用、C の早期スキップ、
                                                        __test_setStandbyBodyReuseEnabled）
  src/engine/monitor/monitor.ts                      （M1 の sched mark）
  src/engine/presentation/processors/process-weather.ts（E の parsed 受け渡し）
  src/engine/perf/receipt-timing.ts                  （Segment に sched / serIn / serEnc を追加）
  test/ 配下の新規・既存テスト
  docs/specs/2026-09-09-receipt-serialize-reduction.md（新規）
  docs/specs/2026-09-08-receipt-path-timing-log.md   （§4.3 の serCalls 固定表と
                                                        §3.4 の redParse キーの但し書きを更新）

  （src/engine/presentation/processors/process-message.ts は対象外。ProcessDeps を
    変えず WeatherProcessDeps を交差型にするので、既存呼び出しは構造的にそのまま通る）

許容変更:
  serializeProspectivePair を buildProspectiveV2 + encodeProspectivePair に分割し、
    serializeProspectivePair は両者を呼ぶラッパとして残す。
    encodeProspectivePair は v2/v1 のバイト列と v2Object/v1Object を返す
  commit 成功時に { token, body } を coordinator の 1 世代フィールドへ保存し、
    captureSerializedPair が currentToken() 一致時のみ再利用する
    （判定は capture() の前。不一致は従来経路へフォールバック）
  試験用の再利用無効化 setter __test_setStandbyBodyReuseEnabled(value): boolean を足す
    （直前値を返す。受入 A1 のフォールバック経路を安定して作るために必要）
  changed.length === 0 のとき serD / serB / pre をスキップし committed を返す
    （:743 の deferredDurabilityMismatch と :749 の staleVersion は必ず残す。
      strict モードでは従来どおり serialize して検査する経路を残す）
  WeatherProcessDeps を Pick<ProcessDeps, ...> & { parsed?: ... } の交差型にし、
    reducer 内の processWeather へ parsed を渡す
  FLEQ_PERF_RECEIPT の Segment に sched / serIn / serEnc を追加する
  上記を検証するテストの追加（volcano owner を変える transact の fixture を含む）

禁止変更:
  永続化される v2 / v1 のバイト列（受入 A1 で完全一致を固定する）
  受理結果（kind / reason）・durableChanged の値・DisplayMutation / PresentationEvent
  preflight の byte / count 検査と PREFLIGHT_ENVELOPE の値
  assertLosslessOwnerSnapshot の全 owner 検査（段階 3 の D まで触らない）
  validateCapturedPair（段階 2 まで触らない）
  base pair のキャッシュ（段階 3 の B まで実装しない）
  logicalGeneration の単調性と「予約した generation は再利用しない」契約
  永続化の頻度・タイミング（SAVE_DEBOUNCE_MS / armTimer / dirty フラグ化。分岐 6-B）
  SWEEP_INTERVAL_MS / STATE_DEBOUNCE_MS
  atomic commit の契約
  package.json / package-lock.json
  data/runtime/ 配下の実データ
  Pi の start-fleq.sh / tmux 設定

配送先: main → personal → Pi

ロールバック:
  main は該当 commit を git revert、personal は rebase 追従後に
  git push --force-with-lease private personal、Pi は
  git fetch origin personal && git reset --hard origin/personal で戻す。

受入条件: §5.1 の A1〜A9・A13・A14・A15 を全件
  （A8' を含む。A10〜A12 は段階 2 / 3 の項なので N/A）。
  A15 は main への push 後に GitHub Actions（Test workflow）の緑を
  gh run watch <id> --exit-status で確認し、赤なら同じサイクル内で対処する。
  §5.2 は B0〜B5・B8・B9 を Pi 観測窓で採る。B4 は VPWS50 大型の行が
  採れなかった場合 N/A と明記する。B5（中央値 1,400ms 以下 かつ 相対条件）が
  未達なら「見積もり外れ」として報告し、段階 2 へ進まずに原因を先に切り分ける。
  §4.2 の serCalls 予測値は実測で訂正し、訂正内容を本 spec と
  docs/specs/2026-09-08-receipt-path-timing-log.md §4.3 の両方に残す（消さない）。
  Pi の生ログは計測 spec §4.7 の手順 5 で抽出してから Pi 上で消す。
```

**分岐 2 の裁定が済むまでこのラベルは完成していない。** C は (c) 製品緩和に当たり、
`.claude/rules/autonomous-cycle.md` の「空欄が 1 つでもあれば配送不可」に該当する。
**分岐 2 が B（C を実装しない）に裁定された場合**、対象から C の記述を落とし、
§1.3 の VPWS50 大型の目標を 2,598ms へ、§4.2 の「`changed.length === 0` → 0」の行を
2 のままへ直す。A と E と M1 / M2 だけなら (c) 該当は無く、そのまま 🌙自走OK になる。

## 裁定ラベル（段階 2・段階 3）

段階 2 は **B2 の実測で残差の主項が `validateCapturedPair` と確定してから**、
段階 3 は **B3 の実測で B / D の主従が決まってから**、それぞれ本節を埋める。
現時点で空欄があるので **配送不可**（`.claude/rules/autonomous-cycle.md` の 6 要素規則）。
