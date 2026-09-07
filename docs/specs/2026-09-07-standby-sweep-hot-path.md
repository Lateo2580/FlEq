# 待機時 sweep ホットパス修正 spec（GitHub Issue #13）

> **裁定（2026-09-07 19:45、ご主人）**: §6 の 5 分岐はすべて A（述語方式／owner version 比較／CI は回数ベースのみ／配送は段階 1＋3 を先に・2＋4 は次便／transactInternal の全文比較は残す）。本 spec は実装 spec として有効。対応 Issue #13。

> **訂正履歴（2026-09-07、段階 1＋3 実装時）**: §3 冒頭の段階別見積もりを実測へ (a) 訂正、§3.1 の実装方式と受入 A5 を choke point 方式へ (b) 改訂、A9 / §4.4 を N/A と明記。

> **前提**: 本 spec は Issue #13 のうち **Node 側の周期停止**だけを扱う。ブラウザ側の再計測負荷は #15、`vpwp50ProjectionRejected` の診断分離は #16 の担当で、本 spec の受入条件には含めない。Issue の完了条件「CLI 改善だけで完了とせず、ディスプレイの受信反映遅延と描画負荷を別々に再確認する」はレーン全体の条件として残す。
>
> **基準 SHA**: `7aabcf251e5776b3aec3f0913bb623a5604036bc`（branch personal）。Issue の静的調査基準 `a58a2f9` から `standby-persistence-admission.ts` / `vpws50-state.ts` / `standby-state-store.ts` の該当箇所に変更はない。

## 1. 症状

### 1.1 実機（Raspberry Pi 500、稼働 SHA `7aabcf2`・Node v22.22.3・連続稼働 22.5h）

`/healthz` を 100ms 間隔・120 秒間叩いた実測。

| 指標 | 値 |
|---|---|
| 停止（応答遅延）の発生 | **5 秒ごとに 24 回** |
| 停止 1 回の長さ | 1,034〜1,421ms |
| p50 / p99 | 1ms / 1,283ms |
| リクエスト失敗 | 0 |
| SSE 接続数 | 0（無客でも停止する） |
| node 生涯平均 CPU / RSS | 47% / 780MB |
| 永続 v2 / v1 | 7,083,368 / 287,176 bytes |
| v2 の内訳 | `telegramFoundation.vpws50.state` 5.9MB（history 2.17MB×8 件・partialHistory 3.07MB×127 subject・partialStreams 0.39MB・current 0.27MB） |
| 待機中の永続ファイル書き込み | 無し（mtime 不変） |

停止周期 5 秒は `SWEEP_INTERVAL_MS`（`src/engine/display/constants.ts:24`）と一致する。ご主人の観測「約 4 秒動作 → 約 2 秒停止」および Chrome の「このページの応答がありません」と同じ時間帯に発生している。

### 1.2 ベンチ（Pi 実状態ファイルの作業コピー、Apple M5 / Node v26.8.1）

`StandbyPersistenceAdmissionCoordinator.sweepAll()` の **no-op 1 回が 219.5ms**（10 回すべて `kind="committed"` / `durableChanged=false` / `changedKeys=[]`）。Pi 実測 1.0〜1.4 秒と 5〜6 倍で整合する。

| 内訳 | 時間 |
|---|---|
| `Vpws50StateHolder.cloneSnapshot` の `structuredClone` ×2 | 54ms |
| `changedOwnerKeys` の `canonicalJson` ×2（base/draft 全 owner） | 37ms |
| `structuredClone(captured.domains)`（draft 生成） | 30ms |
| `Vpws50StateHolder.fromSnapshot` の clone | 27ms |
| `refreshOwnerVersion()` の `JSON.stringify(exportPersistedState())` ×4 | 26ms |
| `exportPersistedState` ×8 | 22ms |
| `retainActiveSubjects` の前後 stringify | 13ms |
| GC | 30ms |

1 sweep あたり `JSON.stringify` 48 回（うち 1MB 超が 8 回・計 47.2MB）、`structuredClone` 1,459 回（うち 6MB 級 4 回）。

history と partialHistory を空にすると 219.5ms → 37.9ms になる（82% が履歴 2 本）。**ただし履歴は取消時の `rollback` / `restorePrevious` に必要で削れない**（`src/engine/messages/vpws50-state.ts:1077,1126`）。本 spec はデータを削らず、仕組みを直す。

計測資材は scratchpad の `bench-sweep.mjs` / `bench-stages.mjs` / `bench-sweep-lib.mjs`。`dist/` を require するので `npm run build` 済みが前提で、状態は `bench-state/` の作業コピーを使い `data/runtime/` には触れない。

## 2. 根因（file:line）

### 2.1 表示 on で同じ重い処理が 60 秒周期から 5 秒周期へ移る

`DisplayHub.startTimers()` は `SWEEP_INTERVAL_MS` の各周期で `this.deps.standbySweep?.(nowMs)` を呼ぶ（`src/engine/display/hub.ts:472-489`）。SSE 無客でも止まらない。配線先は `sweepStandbyFoundation`（`src/engine/monitor/monitor.ts:749-758`）で、中身は `persistenceAdmission.sweepAll(nowMs)` そのもの。

monitor 単独側の同じ関数は 60 秒周期（`src/engine/monitor/monitor.ts:761-767`）で、display controller が `setStandbyDirty` の有無で 60 秒タイマーを止める／再開する（同 `:1035,1041-1044`）。つまりタイマー二重起動ではなく、**同一処理の周期が 12 倍になる**構造。

### 2.2 `version()` が定数時間ではなく全状態の再 export ＋ JSON 化

`Vpws50StateHolder` は owner version を「保存状態全体の JSON 指紋」で判定する（`src/engine/messages/vpws50-state.ts:653-684`）。

```ts
private refreshOwnerVersion(): void {
  const next = JSON.stringify(this.exportPersistedState());
  if (this.ownerFingerprint != null && this.ownerFingerprint !== next) this.ownerVersion += 1;
  this.ownerFingerprint = next;
}
version(): number { this.refreshOwnerVersion(); return this.ownerVersion; }
```

`version()` / `cloneSnapshot()` / `loadSnapshot()` の三経路すべてがこれを通る。同型の指紋方式が 5 owner にある。

| owner | 指紋方式の位置 |
|---|---|
| `Vpws50StateHolder` | `src/engine/messages/vpws50-state.ts:655-684` |
| `Vpww56StateHolder` | `src/engine/messages/vpww56-state.ts:67-95` |
| `TsunamiStateHolder` | `src/engine/messages/tsunami-state.ts:100-152` |
| `FloodForecastStateHolder` | `src/engine/messages/flood-forecast-state.ts:108-147` |
| `StandbyStateStore` | `src/engine/display/standby-state-store.ts:401-455`（`snapshotData()` の全状態 `structuredClone` ＋ `JSON.stringify`） |

**同じリポジトリ内に O(1) 版の先例が二つある。** `TelegramRevisionGate` は `version()` が `return this.ownerVersion` だけで、各 mutation 経路が `this.ownerVersion += 1` する（`src/engine/messages/telegram-revision-gate.ts:1124-1126` と `:701,1485,1509,1523,1562,1602,1755`）。`VolcanoStateHolder` も同じ（`src/engine/messages/volcano-state.ts:355` と `:467,508,527,558,568,583,604,622,644,681,705,731,820`）。本 spec の 3.1 はこの既存パターンを残る 5 owner へ揃える作業であって、新方式の発明ではない。

`StandbyPersistenceAdmissionCoordinator.currentToken()` は 7 owner 全部の `version()` を読む（`src/engine/display/standby-persistence-admission.ts:482-495`）。`capture()` は snapshot 取得後にさらに `currentToken()` を呼ぶ（同 `:497-512`）ので、VPWS50 の全状態処理が capture 1 回で 2 度重なる。

### 2.3 no-op 判定より前に全状態の複製・再構築・全文比較が終わっている

`sweepAll()`（`src/engine/display/standby-persistence-admission.ts:686-895`）の順序。

```text
capture()                            全 7 owner の cloneSnapshot ＋ currentToken   :690
structuredClone(captured.domains)    draft をもう一度まるごと複製                  :691
fromSnapshot ×7                      scratch holder 再構築                         :692,712,729,733,735,754,770
retain / sweep / maintain            期限・gate 整合の実処理（ここは O(entries)）  :694-800
cloneSnapshot ×6                     draft へ書き戻し                              :711,722,752,768,776,801,802
changedOwnerKeys(base, draft)        全 owner を前後それぞれ canonicalJson         :803
changed.length === 0 なら return                                                    :863-869
```

`changedOwnerKeys` は `OWNER_ORDER` 全件を `canonicalJson` で突き合わせる（同 `:440-445`）。`canonicalJson` は Map/Set を配列化しながら `JSON.stringify` する（同 `:248-254`）。VPWS50 の 5.9MB が base/draft の 2 回通る。

`changed.length === 0` の早期 return は v1/v2 pair のシリアライズ（同 `:874-875`）より前にあるので、「無変更でも毎回ファイルを書く」という問題ではない。**残っているのは snapshot 複製・holder 再構築・JSON 全文比較の CPU**。

### 2.4 `retainActiveSubjects` が変更検出を stringify 前後比較でやっている

```ts
retainActiveSubjects(subjectKeys: readonly string[]): boolean {
  const before = JSON.stringify(this.exportPersistedState());
  ...
  return before !== JSON.stringify(this.exportPersistedState());
}
```

（`src/engine/messages/vpws50-state.ts:915-937`）。中で行う操作は `Map.delete` / `Set.delete` / フィールドの null 化だけで、**実削除の有無は削除操作の戻り値から正確に取れる**。5.9MB の stringify を 2 回する理由がない。

`sweepAll` の flood にも同型がある（`src/engine/display/standby-persistence-admission.ts:783-786` の `floodBefore` / `canonicalJson` 前後比較）。

### 2.5 draft の二重コピー

`capture()` は `cloneSnapshot()` 経由ですでに複製済みの snapshot を返す（`src/engine/messages/vpws50-state.ts:665-668` ほか）。それを `sweepAll` / `transactInternal` がさらに `structuredClone` して draft を作る（`src/engine/display/standby-persistence-admission.ts:691,552`）。base を pristine に保つためだが、**no-op 経路では base は一度も使われない**。base が要るのは `changedOwnerKeys` の比較基準（`:803,560`）、`basePair` の生成（`:875,569`）、`changedField` の前後比較（`:825-828`）で、いずれも「変更があった」と分かった後の話。

### 2.6 待機中に本当に必要な仕事は「期限到来」と「入力変化」だけ

`sweepAll` が行う仕事は 3 系統に分けられる。

1. **時計駆動**: gate の lifecycle 期限（`src/engine/messages/telegram-revision-gate.ts:1570-1604`、`acceptedAtMs + retention` 比較）、`VolcanoStateHolder.sweep`（`src/engine/messages/volcano-state.ts:631-646`、`eventExpiresAtMs` / `forecastEndsAtMs`）、`StandbyStateStore.sweep`（`src/engine/display/standby-state-store.ts:2609-2723`、`targetDateEndMs` / `expiresAtMs` / `ashfallExpiresAtMs` / `alertExpiresAtMs` ほか）、`maintainTyphoonProbabilitySubjects`（同 `:839-855`）、`maintainWeatherWarningForecastSubjects`（同 `:581-597`）、`RevisionGuard.sweep`（`src/engine/display/revision-guard.ts:71-84`、**wall clock と monotonic の二系統**）、`FloodForecastStateHolder.sweep`（`src/engine/messages/flood-forecast-state.ts:252-265`、`lastSeenMs + TTL`）
2. **入力駆動**: gate の active subject 集合に holder を追従させる結合（`retainActiveSubjects` 群、`replaceVolcanoDerived`、`retainCanonicalFloodEvents`）。gate が変わらなければ結果は変わらない
3. **冪等な整合**: `reconcileLegacyFloodEvents()` など。前回 sweep で既に適用済みなら再実行しても何も起きない

したがって **「期限が来ていない」かつ「前回 sweep 以降どの owner も変化していない」なら、sweep の出力は前回と同一**である。これが 3.3 の事前判定の健全性根拠であり、§4 の差分テストで機械的に検証する対象でもある。

## 3. 変更

段階は独立に配送できる粒度で切る。

**症状（5 秒ごとの 1.2 秒停止）を消す最小経路は 段階 1 → 段階 3。** 待機中の no-op で `capture()` 自体をしなくなるのは段階 3 の事前判定であり、段階 3 は段階 1 の O(1) token（判定 3 の `currentToken()` 比較）を前提とする。段階 1 を入れずに段階 3 だけを配送してはならない。

**段階 2 / 段階 4 は、電文受理直後の sweep と実変更ありの sweep（および live admission）を軽くする改善**で、no-op の停止そのものは消さない。§1.2 のベンチ内訳で段階ごとに数えるとこうなる。

| 段階 | no-op から消える項目 | Mac M5 での目安 |
|---|---|---|
| 段階 1 | `refreshOwnerVersion()` の `JSON.stringify(exportPersistedState())` ×4 | −26ms（**実測 −15.6ms**: 226.6 → 211.0ms。下の訂正を見る） |
| 段階 4 | draft の `structuredClone` 30ms ＋ `changedOwnerKeys` の `canonicalJson` 37ms | −67ms |
| 段階 1＋4 の後に残る | capture の `cloneSnapshot` ×2（54ms）・`fromSnapshot` clone（27ms）・`retainActiveSubjects`（13ms） | **約 100ms** |

Mac 219.5ms が Pi 実測 1.0〜1.4 秒に対応する（4.6〜6.4 倍）ので、**段階 1＋4 だけでは Pi の停止は約 0.5 秒残る**。半減はするが症状は消えない。no-op で capture に入らない段階 3 が入って初めて実質ゼロになる。

**(a) 実測による訂正（2026-09-07、段階 1＋3 実装時）**: 段階 1 単独の効果は見積もり −26ms に対し**実測 −15.6ms**（同一機・同一状態で base を再ビルドして比較。clean wall median 226.6ms → 211.0ms）。3.1 の choke point 方式では `sweepAll` の通常経路が scratch holder に対して指紋を払うため、読み取り経路から消えたぶんの一部が書き込み側へ移る。段階 2 で正確な boolean へ置き換えれば取り戻せる。一方で**段階 1＋3 の合計は見積もりを大きく上回り、no-op は 226.6ms → 0.1ms**（1MB 超の `JSON.stringify` 8 回 → 0 回、`structuredClone` 4 回 → 0 回）。

なお §1.2 の内訳は attribution であって直和ではない。`exportPersistedState` は `cloneSnapshot` と `refreshOwnerVersion` の内側から呼ばれるため、行を単純に足し引きすると二重計上になる。上表の目安値もそのつもりで読む。

### 3.0 Phase 0 申告

実装者は製品コードを触る前に、変更記録または実装メモへ次を宣言する。

- **倣う既存パターン**: `TelegramRevisionGate.version()`（`src/engine/messages/telegram-revision-gate.ts:1124-1126`）と `VolcanoStateHolder.version()`（`src/engine/messages/volcano-state.ts:355`）の incremental owner version。新しい version 方式を発明しない
- **対象 owner**: `Vpws50StateHolder` / `Vpww56StateHolder` / `TsunamiStateHolder` / `FloodForecastStateHolder` / `StandbyStateStore` の 5 つ。gate と volcano holder の version 方式は変更しない
- **不変に保つ契約**: atomic commit（失敗時に owner を汚さない）、`preflight` の byte / count 検査、pair serializer が durable 判定の権威であること（`src/engine/display/standby-persistence-admission.ts:577-581`）、`assertLosslessOwnerSnapshot` の全 owner 検査（同 `:256-264,282-334`）、復元契約（`restorePrevalidated` `:673-684`）
- **列挙する mutation 経路**: 3.1 の表に挙げた全メソッドを実コードで確認し、漏れがあれば表を更新してから着手する

### 3.1 段階 1: owner version を O(1) にする

5 owner の `refreshOwnerVersion()` / `refreshVersion()` を廃止し、`version()` は保持値を返すだけにする。

**段階 1 で行うのは「指紋計算を読み取り経路から mutation 入口へ移す」ことである。** 指紋（旧実装と同じ集合の JSON 化）は private の `mutationFingerprint()` に残し、mutation 入口を包む単一の choke point `bumpIfChanged()` だけがそれを呼ぶ。`version()` / `cloneSnapshot()` / `loadSnapshot()` からは呼ばない。`TelegramRevisionGate.decide` が `mutationFingerprint()` の前後比較で条件付き bump している形（`src/engine/messages/telegram-revision-gate.ts:490-493`）と同じで、新方式ではない。

この方式では **mutation 1 回あたり保存状態の `JSON.stringify` が 2 回残る**。ただしそれは電文受理・復元の経路であって、**待機時の no-op sweep からは完全に消える**（no-op は mutation を 1 つも起こさない）。JSON を経由しない正確な boolean への置換 — `Map.delete` / `Set.delete` の戻り値、`Map.size` の前後比較 — は段階 2 の仕事とする。既に正確な boolean を持っているメソッド（`Vpww56StateHolder.retainActiveSubjects`、`FloodForecastStateHolder.sweep` / `rollback` / `retainActiveEventIds`）は段階 1 の時点でそれを流用してよい。

**不変条件（双方向）**:

- **前進**: 保存状態（`exportPersistedState()` 相当 / `snapshotData()` 相当）が変わったなら `version()` は必ず進む
- **不動**: 保存状態が変わらないなら `version()` は進んではならない

後者は Issue のコメントには書かれていないが、本 spec では必須にする。過剰に version を進めると 3.3 の事前判定が毎周期「変化あり」と誤判定して効かなくなり、3.4 の owner 比較が毎周期 spurious commit を起こすため。choke point 方式はこの双方向条件をメソッドごとの手作業ではなく**構造で**保証する。

**例外は復元契約だけ**: `replacePrevalidated()` / `loadSnapshot(snapshot, commit)` は指紋が変わらなくても `commit ? ownerVersion + 1 : snapshot.version` とする。gate（同 `:1194`）と `VolcanoStateHolder`（`src/engine/messages/volcano-state.ts:391`）の既存挙動そのもので、3.3 の「復元は事前判定でスキップされない」要求とも一致する。A5 のテストではこれを `restore` 種別として分離し、契約を個別に固定する。

**読み取り入口でも保存状態を変えうるものは choke point を通す**: `StandbyStateStore.floodLegacyEventIds()` は内部で `reconcileLegacyFloodEvents()` を呼び `legacyFloodEventIds` を縮めうる。旧実装では次の `version()` が指紋差から拾っていたが、O(1) version では取りこぼしになる。

#### 3.1.1 `Vpws50StateHolder` の mutation 経路

`src/engine/messages/vpws50-state.ts` の実測列挙（private を含む。`__test_` 接頭辞の試験用フックも保存状態を変えるので対象）。

| 行 | メソッド | 可視性 |
|---|---|---|
| 678 | `loadSnapshot` | private（`fromSnapshot` / `replacePrevalidated` の実体） |
| 728 | `diffAndUpdateInternal` | private（`diffAndUpdate` `:702-718` / `diffAndUpdateWithDisplay` `:719` の実体） |
| 790 | `mergePartialWithDisplay` | public |
| 832 | `clearPartial` | public |
| 841 | `restorePreviousPartial` | public |
| 862 | `clearEmergencyPartialAreas` | public |
| 893 | `retainActivePartialSubjects` | public |
| 915 | `retainActiveSubjects` | public |
| 943 | `trimPartialSubjects` | private（上記から呼ばれる） |
| 958 | `partialTransition` | private（`lastSuccessfulFullDisplayAt` を書く `:972`） |
| 1077 | `rollback` | public |
| 1126 | `restorePrevious` | public |
| 1194 | `restorePersistedState` | public |
| 1331 | `__test_setLastSuccessfulFullDisplayAt` | public（試験用） |

**罠**: `lastSuccessfulFullDisplayAt` は `exportPersistedState()` に載る保存状態でありながら（`:1190`）、`diffAndUpdateInternal` の中の表示判定（`:756-773`）や `partialTransition`（`:972`）から書かれる。読み取り系メソッド（`getCurrentAreasForDisplay` `:1312`、`getCurrentIdentity` `:1316`、`previewUnsafe` `:1050`、`activePartialSubjects` `:939`）は状態を変えないことを確認済みなので、bump 対象から外してよい。

#### 3.1.2 `StandbyStateStore` の mutation 経路

`src/engine/display/standby-state-store.ts` の public 側の実測列挙。

| 行 | メソッド |
|---|---|
| 456 | `loadSnapshot`（private、`fromSnapshot` `:446` / `replacePrevalidated` `:452` の実体） |
| 498 | `applyEvent` |
| 581 | `maintainWeatherWarningForecastSubjects` |
| 604 | `reconcileWeatherWarningForecastGateBindings` |
| 733 | `applyTyphoonProbabilityCommand` |
| 794 | `reconcileTyphoonProbabilityCommand` |
| 822 | `reconcileTyphoonProbabilitySubject` |
| 839 | `maintainTyphoonProbabilitySubjects` |
| 861 | `applyBriefingCardEvent` |
| 1646 | `reconcileBriefingCard` |
| 1951 | `applyWeatherAlerts` |
| 1993 | `restoreCanonicalVpws50Alerts` |
| 2010 | `restoreCanonicalFloods` |
| 2024 | `retainCanonicalFloodEvents`（`this.floods` 経由で変える） |
| 2047 | `restoreCanonicalVpww56Alerts` |
| 2403 | `replaceVolcanoDerived` |
| 2444 | `seedVolcanoAlerts` |
| 2509 | `restoreCanonicalVolcanoes` |
| 2609 | `sweep` |
| 3038 | `restoreActiveState` |

`snapshotItems`（`:2724`）と `exportActiveState`（`:2898`）は読み取り専用であることを確認済み。`onChange` / `onDurable`（`:3274,3278`）はリスナ登録で保存状態ではない。

**この表は着手前の確認用であって、正しさの根拠にはしない。** 漏れの検出は 3.1.3 のテストが担う。

#### 3.1.3 漏れを機械的に検出するテスト

owner ごとに、`version()` を進めるべき / 進めるべきでないの双方向を確認する。

1. 大容量の合法状態を積んだ holder を用意する
2. 各 mutating メソッドについて、実行前後で「旧実装と同じ指紋」（`JSON.stringify(exportPersistedState())` / `snapshotData()` の canonical 化）と `version()` を採る
3. **指紋が変わったのに version が進んでいなければ失敗**（取りこぼし検出）
4. **version が進んだのに指紋が変わっていなければ失敗**（過剰 bump 検出）

引数の作り方はメソッドごとに異なるので、対象メソッド名を明示した表駆動テストにする。表に載っていないメソッドが増えたときに気づけるよう、**クラスの mutating メソッド集合を実装から取り出して表と突き合わせる網羅チェック**を同じテストに置く（`Object.getOwnPropertyNames(Klass.prototype)` を使い、表にない名前があれば失敗させる）。

### 3.2 段階 2: `retainActiveSubjects` の変更検出を実削除ベースにする

`Vpws50StateHolder.retainActiveSubjects`（`src/engine/messages/vpws50-state.ts:915-937`）の前後 stringify をやめ、実際に消したか / null 化したかを boolean で積む。

- `this.partialStreams.delete(k)` / `this.partialHistory.delete(k)` / `this.restoredPartialSubjects.delete(k)` の戻り値
- `current` 系は `this.current != null || this.currentMessageId != null || this.currentIdentity != null || this.history.length > 0 || this.lastSuccessfulFullDisplayAt != null` を先に見てから null 化
- `trimPartialSubjects()`（`:943-956`）も削除の有無を返すようにして合成する

同型の前後比較は `sweepAll` の flood にもある（`src/engine/display/standby-persistence-admission.ts:783-786`）。`FloodForecastStateHolder.retainActiveEventIds` / `sweep` が変更 boolean を返すようにして、`canonicalJson` 前後比較を消す。`sweep` はすでに `this.events.size` の前後比較（`src/engine/messages/flood-forecast-state.ts:252-256`）なので、`retainActiveEventIds` 側を揃えるだけで済む可能性が高い。実装時に確認する。

`Vpww56StateHolder` / `TsunamiStateHolder` に同型の stringify 前後比較があれば同じ扱いにする。無ければ N/A と明記する。

### 3.3 段階 3: capture より前の安価な事前判定

`sweepAll` の冒頭で、`capture()` に入る前に「今回やるべき仕事があるか」を判定する。

```text
sweepAll(nowMs):
  1. nowMs の妥当性検査（現状 :687-689 のまま）
  2. lastSweep が無い → 通常経路
  3. currentToken() != lastSweep.token → 通常経路        // 入力駆動（O(1)、段階 1 前提）
  4. nowMs < lastSweep.atMs → 通常経路                    // 時計の巻き戻し
  5. いずれかの owner が hasDueSweepWork(nowMs) → 通常経路 // 時計駆動（O(entries)、JSON 不使用）
  6. どれにも当たらなければ capture せず
     { kind: "committed", value: { changedKeys: [], durableChanged: false }, token: lastSweep.token }
  ...
  通常経路の最後（committed で返す直前）に lastSweep = { atMs: nowMs, token: <確定 token> } を記録
```

**`hasDueSweepWork(nowMs)` は「次回期限のキャッシュ」ではなく「その場で条件を評価する述語」にする。** 各 owner の sweep 条件をそのまま鏡写しにした O(entries) の走査で、JSON も clone も使わない。理由は §6 の分岐 1 に書く。

owner ごとの述語が鏡写すべき条件。

| owner | 参照する条件（file:line） |
|---|---|
| `TelegramRevisionGate` | `states` の `acceptedAtMs + (cancelled ? tombstoneRetentionMs : activeRetentionMs)`、`transientStates` の `acceptedAtMs + retentionMs`（`src/engine/messages/telegram-revision-gate.ts:1576-1599`）。family policy は `ALL_REVISION_FAMILY_POLICIES` のうち `COORDINATED_SWEEP_FAMILIES` に含まれるものだけ（`src/engine/display/standby-persistence-admission.ts:214-216,694-710`） |
| `VolcanoStateHolder` | `composites` の `eruption.eventExpiresAtMs` / `ashfall.forecastEndsAtMs`（`src/engine/messages/volcano-state.ts:634-641`） |
| `StandbyStateStore` | `heatAlerts.targetDateEndMs` / `typhoons.expiresAtMs` / `typhoonProbabilities.expiresAtMs` / `volcanoes.{eventExpiresAtMs, ashfallExpiresAtMs, alertExpiresAtMs}` と**「活性 alert が無く期限も無い entry は即削除」の条件**（`src/engine/display/standby-state-store.ts:2656-2661`、これは時計に依らず即時 due） / `tornadoByOffice.expiresAtMs` / `longPeriodByEvent.expiresAtMs` / `quakeHost.expiresAtMs` / `nankaiTrough.expiresAtMs` / `weatherAlerts.expiresAtMs` / `weatherWarningForecasts` の period `endsAt` / `pruneBriefingLifecycle` の期限 / `RevisionGuard.sweep`（`src/engine/display/revision-guard.ts:71-84`、**wall clock `forgetAtMs` と monotonic `expiresAtMonotonicMs` の二系統を両方**） / `this.floods.sweep` の `lastSeenMs + TTL` |
| `FloodForecastStateHolder` | `events` の `lastSeenMs + FLOOD_FORECAST_HISTORY_TTL_MS`（`src/engine/messages/flood-forecast-state.ts:259-264`） |
| `Vpws50StateHolder` / `Vpww56StateHolder` / `TsunamiStateHolder` | 自前の時計駆動 sweep を持たない（gate の active subject に追従するだけ）。述語は常に false でよいが、**そう判断した根拠をコード上のコメントで示す** |

**キャッシュしない**。述語は毎周期その場で評価する。Pi の実状態でも走査対象は gate states（数百）＋ partial subject 127 ＋ volcano ≤128 ＋ store の各 Map（いずれも件数は小さい）で、5.9MB という「値の大きさ」は走査コストに乗らない。

`maintainTyphoonProbabilitySubjects` / `maintainWeatherWarningForecastSubjects` は時計と gate subject の両方に依存するが（`src/engine/display/standby-state-store.ts:841-849,587-593`）、gate subject 集合の変化は必ず gate の owner version 変化を伴う（`src/engine/messages/telegram-revision-gate.ts:1602` ほか）ので、判定 3 で捕まる。

**事前判定が無効化される条件**（すべて判定 3 の token 比較で自動的に捕まる。実装で個別に書く必要はないが、テストでは個別に確認する）:

- live 受理（gate `decide` / holder の `diffAndUpdate` 等 → owner version 前進）
- 復元（`restorePrevalidated` → `compositionVersion += 1`、`src/engine/display/standby-persistence-admission.ts:683`）
- 取消（gate の tombstone 化 → owner version 前進）
- 他の transaction による commit（`commit()` の `compositionVersion += 1`、同 `:660`）

時計の巻き戻し（NTP 同期前の Pi）は判定 4 で捕まる。時計が前へ飛んだ場合は判定 5 の述語が期限到来を検出する。

**責務境界の注記**: 同じ 5 秒タイマーの中で、`sweepAll` とは別経路の処理が 3 つ動いている（`src/engine/display/hub.ts:482-487`）。

```ts
let dirty = this.store.sweep(nowMs, sweepWeatherPromotions);   // DisplayStateStore（:482）
dirty = (this.deps.standbySweep?.(nowMs).viewChanged ?? false) || dirty;  // ← 本 spec の対象（:483）
dirty = this.sweepTicker(nowMs) || dirty;                      // テロップ期限（:484）
dirty = this.observeFrontendBuildId() || dirty;                // buildId 観測（:487）
```

`this.store` は `DisplayStateStore` であって `StandbyStateStore` ではない。事前判定は `standbySweep` の内側（`sweepAll`）だけを対象とし、**他の 3 つは呼び出し回数も内容も変えない**。§1.1 の停止 1.0〜1.4 秒はベンチで `sweepAll` 単体 219.5ms（Pi 換算 1.0〜1.4 秒）に対応づいているので、これら 3 つは主因ではない。段階 3 配送後の実機再計測（§4.8）で停止が残った場合、次に見るのはこの 3 経路になる。本 spec の受入条件には含めない。

### 3.4 段階 4: base の遅延取得と owner 比較の O(1) 化

#### 3.4.1 draft の二重コピーをやめる

`capture()` が返す snapshot はすでに複製済み（`Vpws50StateHolder.cloneSnapshot` は `structuredClone(this.exportPersistedState())`、`src/engine/messages/vpws50-state.ts:665-668`）。よって **capture の結果をそのまま draft に使い、base は必要になった時点で 2 回目の capture で取る**。

- scratch holder（`fromSnapshot` で作った別インスタンス）への mutation は実 owner を変えない
- `StandbyStateStore.fromSnapshot` で作った scratch store は `changeListeners` / `durableListeners` を引き継がないので、`sweep` 内の `notify` も実 owner 側へ波及しない（`src/engine/display/standby-state-store.ts:397-398,456-497`）
- coordinator の `volcanoRuntimeVersion` / `repairState` は draft 側の値を書き換えるだけで実体は不変（`src/engine/display/standby-persistence-admission.ts:724-727`）

したがって「draft を作って変更した後の 2 回目 `capture()`」は 1 回目と同一の内容になる。これを base として使う。no-op 経路では 2 回目の capture が発生しない。

`token` は 1 回目の capture の値を使い続ける（stale 判定 `:887` の意味を変えない）。

#### 3.4.2 `changedOwnerKeys` を owner version 比較にする（`sweepAll` 限定）

`sweepAll` の `changedOwnerKeys(captured.domains, draft)`（`src/engine/display/standby-persistence-admission.ts:803`）を、`captured.token.ownerVersions` と draft 側 snapshot の version 値の比較に置き換える。base の全文が要らなくなる。

- 各 owner snapshot は `version` フィールドを持つ（`Vpws50StateSnapshot` / `StandbyStateStoreSnapshot` ほか）
- `volcanoHolderAndRepair` だけは `runtimeVersion` を使う（`:504-508,724-727`）
- 正しさは段階 1 の双方向不変条件に依存する。**段階 1 なしにこの段階を配送してはならない**

**`transactInternal`（`:541-593`）の `changedOwnerKeys` は変更しない。** live admission の頻度は Pi 実測で約 107 秒に 1 回で、その経路のコストは pair serializer が支配する。そのうえ `:561-563` の `unexpectedOwnerMutation` 検査は「reducer が想定外の owner を触っていない」という安全網なので、version 比較へ置き換えると reducer の bump 漏れが検出できなくなる。全文比較のまま残す。

#### 3.4.3 検証用の strict モード

`sweepAll` が算出した owner 変更集合を、テスト時だけ従来の `canonicalJson` 全文比較と突き合わせて不一致で throw する経路を用意する（既定 off、テスト専用フラグ）。既存テスト全体を strict モードで 1 度回して差が出ないことを確認する。

### 3.5 やらないこと（Issue の制約）

- `SWEEP_INTERVAL_MS` を一律に延長して終わらせない（`src/engine/display/constants.ts:24` は据え置き）。表示の期限切れ・警報昇格の降格も同じタイマーを使う
- `async` を付けるだけの回避をしない
- 永続化を無効化しない、状態ファイルを消さない、保存上限（`STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE`、同 `:19`）を再び狭めない
- VPWS50 の history / partialHistory を削らない（取消時の `rollback` / `restorePrevious` に必要）
- display on/off の切替と `startStandbySweep` / `stopStandbySweep` の配線（`src/engine/monitor/monitor.ts:761-774,1041-1044`）は変更しない

## 4. テスト

### 4.1 大容量の合法状態を作る helper

Pi の実状態ファイルは実電文由来なのでリポジトリに置けない。**合成の大容量合法状態**を作る helper をテスト側に用意する。

- VPWS50: current（全国）＋ history 8 件 ＋ partialStreams / partialHistory を 127 subject。`exportPersistedState()` の JSON が **5MB 以上**になること自体をテストで assert する（helper が痩せたら性能テストが意味を失うため）
- 生成物は既存の型検査（`assertLosslessOwnerSnapshot`、`src/engine/display/standby-persistence-admission.ts:256-264`）と `preflight` の byte 上限を通ること
- 生成は決定的にする（乱数を使うならシード固定）。`npm run test:shuffle` で順序が変わっても壊れない

### 4.2 no-op 計測（回数ベース）

大容量状態・期限未到来・入力変化なしで `sweepAll` を連続実行し、以下を assert する。

- 戻り値が `kind: "committed"` / `changedKeys: []` / `durableChanged: false`
- **1MB 超の `JSON.stringify` 呼び出し回数が 0**
- **1MB 超の `structuredClone` 呼び出し回数が 0**
- `serializePair` の呼び出し回数が 0（coordinator の deps 経由で差し替えて数える、同 `:166-169`）

回数の採り方はベンチ（scratchpad `bench-stages.mjs`）と同じく、`JSON.stringify` / `structuredClone` を測定中だけ包む。ラップは `try` / `finally` で必ず戻す。

### 4.3 事前判定の差分テスト（最重要）

3.3 の事前判定が仕事を取りこぼさないことを、**参照実装との差分**で確認する。

- 「常に通常経路を通る」参照実装（事前判定を無効化した `sweepAll`）を用意する
- 期限が散らばった状態（gate の active / tombstone、volcano の噴火・降灰、store の各 `expiresAtMs`、briefing lifecycle、`RevisionGuard` の wall / monotonic 両系統、flood の TTL）を組み、**期限をまたぐ多数の時刻**で両者を実行する
- 各時刻で `changedKeys`（集合として）・`durableChanged`・実行後の全 owner snapshot（`canonicalJson`）が一致することを assert する
- 時刻列は境界値を含める: 各期限の直前 / ちょうど / 直後、および期限を飛び越す大ジャンプ

これは §2.6 の健全性根拠（「期限未到来かつ入力不変なら出力は前回と同一」）を機械的に検証するものなので、**述語の書き漏れは必ずこのテストで落ちる**。

### 4.4 イベントループ遅延 — **N/A**

当初は `perf_hooks` の `monitorEventLoopDelay` でヒストグラムを採る想定だったが、§6 の分岐 3-A で「壁時計は CI の合否に使わない」と決めた時点で、このテストが守るものは残らない。**同じ情報は §5.2 の bench（`bench-sweep.mjs` の壁時計 median と 1MB 超呼び出し回数）が before / after で与える**ので、専用テストは作らない。

### 4.5 期限到来・取消・restore 後の更新

事前判定が入っても、必要な owner だけが正しく更新されることを確認する。

- gate の lifecycle 期限が到来した周期で、該当 family の `changedKeys` が出て、無関係な owner が変更されないこと
- 取消（tombstone 化）の直後の sweep で holder / standby が gate の active subject 集合へ追従すること
- `restorePrevalidated` 直後の sweep が事前判定でスキップされず、通常経路を通ること（`compositionVersion` 前進の確認）
- 時計が巻き戻った直後の sweep が通常経路を通ること
- VPWS50 の取消 → `rollback` / `restorePrevious` が history を使って復元できること（履歴を削っていないことの回帰）

### 4.6 display on/off の反復

`startStandbySweep` / `stopStandbySweep` と display controller の `setStandbyDirty` を反復し（`src/engine/monitor/monitor.ts:761-774,1041-1044`）、sweep タイマーの多重起動も停止漏れも無いことを確認する。既存の `test/engine/display/standby-wiring.test.ts` に置くのが自然。

### 4.7 既存回帰

- `npm run build`
- `npm test`
- `npm run test:shuffle`（owner version は module スコープではないが、holder 状態と永続化を触るので必須）
- `npm run typecheck:test`

### 4.8 実機再計測

Pi で `/healthz` を 100ms 間隔・120 秒間叩き、§1.1 と同じ表を取り直す。稼働 SHA・Node バージョン・v2 バイト数・SSE 接続数を併記する。**本番状態は消さない**（作業コピーで検証する）。

## 5. 受入条件

### 5.1 機械的に確認できるもの

| # | 条件 | 確認方法 |
|---|---|---|
| A1 | no-op `sweepAll` で 1MB 超の `JSON.stringify` 呼び出しが 0 回 | 4.2 のテスト |
| A2 | no-op `sweepAll` で 1MB 超の `structuredClone` 呼び出しが 0 回 | 4.2 のテスト |
| A3 | no-op `sweepAll` で `serializePair` 呼び出しが 0 回 | 4.2 のテスト |
| A4 | 事前判定あり / なしで `changedKeys`・`durableChanged`・全 owner snapshot が全時刻で一致 | 4.3 の差分テスト |
| A5 | 各 owner の mutating メソッドについて「指紋変化 ⟺ version 前進」が双方向で成立（復元契約の `replacePrevalidated` は `restore` 種別として分離し、`commit ? +1 : snapshot.version` を個別に固定） | 3.1.3 のテスト |
| A6 | 5 owner すべてで、表に載っていない prototype メソッドが存在しない（`Object.getOwnPropertyNames` と表の突き合わせ。private 内部ヘルパも分類して載せる） | 3.1.3 の網羅チェック |
| A7 | 大容量状態 helper の VPWS50 `exportPersistedState()` JSON が 5MB 以上 | 4.1 のテスト |
| A8 | 期限到来・取消・restore・時計巻き戻しの各ケースで通常経路が走る | 4.5 のテスト |
| A9 | **N/A**（段階 1＋3 は `startStandbySweep` / `stopStandbySweep` の配線を変更しない。`src/engine/monitor/monitor.ts:760-773` は null guard で多重起動を構造的に防いでおり、既存 `test/engine/display/standby-wiring.test.ts:2715-2823` が start / stop / shutdown を押さえている。新規テストは作らない） | — |
| A10 | `npm run build` / `npm test` / `npm run test:shuffle` / `npm run typecheck:test` がすべて成功 | 実行ログ |
| A11 | **段階 4 の項**。段階 1＋3 の配送では、代わりに 3.1.3 のテストが旧実装と同じ指紋を突き合わせて version 不変条件を固定する | 3.1.3 のテスト |

### 5.2 性能（環境依存のため CI 合否には使わない）

**期待値は段階ごとに分ける。** B1 / B2 は段階 3 まで入って初めて成立する条件で、段階 1 単独の配送に課してはならない。

| # | 条件 | 成立する段階 | 測定 |
|---|---|---|---|
| B0 | 大容量合成状態で no-op `sweepAll` 1 回が **200ms 未満**（Mac M5 / Node v26.8.1、現状 219.5ms） | 段階 1 | scratchpad `bench-stages.mjs` 相当をローカル実走 |
| B1 | 同上で **20ms 未満** | 段階 1＋3 | 同上 |
| B2 | Pi 実機で `/healthz` を 100ms 間隔・120 秒間叩いた p99 停止が **50ms 未満**（現状 1,283ms）、失敗 0 | 段階 1＋3 | 4.8 の実機再計測 |
| B3 | 電文受理直後の sweep（通常経路 = capture する経路）が Pi 実機で **300ms 未満** | 段階 1＋2＋3＋4 | 実機ログの所要時間計測 |

段階 1＋4 だけを配送した中間状態では、no-op が Mac で約 100ms・Pi で約 0.5 秒に留まる（§3 冒頭の表）。**これは B2 を満たさないので、その状態で「症状解消」と報告しない。**

すべて**同じ状態量・同じ手順で before / after を採る**こと。after だけを載せない。

### 5.3 スコープ外（本 spec の受入条件に入れない）

- Chrome の「このページの応答がありません」の解消（#15 側で別に確認する）
- ディスプレイの受信反映遅延（同上）
- `vpwp50ProjectionRejected` の診断分離（#16）
- Pi のロード時に観測された volcano salvage `discarded=109 retained=8 reason=invalid-entry` と `persistenceMigrationConflict: sameGenerationConflict`（別件、要調査）

## 6. 判断分岐

### 分岐 1: 事前判定を「述語」にするか「次回期限キャッシュ」にするか

- **A（推奨）: owner ごとの `hasDueSweepWork(nowMs)` 述語をその場で評価する。** 各 sweep の条件を鏡写しにした O(entries) の走査で、キャッシュも無効化条件も持たない。**キャッシュの無効化漏れという最も壊れやすい部分が構造的に存在しない**のが理由。Pi の実状態でも走査対象は件数が小さく（gate states 数百・partial subject 127・volcano ≤128）、5.9MB という値の大きさは走査コストに乗らない。`RevisionGuard` の wall / monotonic 二系統（`src/engine/display/revision-guard.ts:73-77`）も、述語なら「その場で両方見る」だけで済む
- **B: 全 owner の次回期限の最小値をキャッシュし、owner version が変わったときだけ再計算する。** 走査コストは下がるが、monotonic 系の期限を wall clock の最小値へ畳む変換が必要になり、無効化条件の列挙（live 受理・restore・取消・時計変更）を実装側で正しく維持し続ける負担が残る。走査コストが実測で問題になった場合にのみ移る

### 分岐 2: `sweepAll` の owner 変更検出を version 比較にするか、mutation boolean の合成にするか

- **A（推奨）: `captured.token.ownerVersions` と draft snapshot の version 比較（3.4.2）。** 判定ロジックが 1 か所に集約され、段階 1 で確立した不変条件がそのまま正しさの根拠になる。`sweepAll` 内に「どの操作がどの owner を変えるか」の知識を二重に持たない
- **B: `sweepAll` がすでに計算している変更 boolean（`:709,723,730,737,756,775,786,787,788,792,798`）を owner 単位に合成する。** version 方式に依存しないが、`standby.applyWeatherAlerts`（`:744,760`）や `standby.replaceVolcanoDerived`（`:731`）の波及を手で正しく畳む必要があり、`sweepAll` の実装が変わるたびに合成式を追従させる負債が残る。`durableChanged` だけでは view のみの変化を取りこぼす点も注意が要る

### 分岐 3: 性能の受入条件を CI に載せるか

- **A（推奨）: CI の合否は「回数ベース」（A1〜A3）だけにし、壁時計（B0〜B3）はローカルと実機での確認に留める。** GitHub Actions の ubuntu-latest は共有ランナーで、過去に重い fixture が 5 秒 timeout で連続赤になり `vitest testTimeout` を 30 秒へ広げた経緯がある（`.claude/rules/personal-branch-operations.md`）。壁時計を合否に使うと flaky を作り、配送チェーンごと止まる
- **B: 壁時計にも緩い上限（例: 大容量 no-op 200ms）を置いて CI で守る。** 退行を早く捕まえられるが、ランナー変動で赤くなる

### 分岐 4: 配送をどこで切るか

- **A（推奨）: 段階 1＋段階 3 を先に配送して症状を消し、段階 2＋段階 4 を次の配送に回す。** 待機中の no-op で `capture()` に入らなくなるのは段階 3 であり、段階 1 はその前提（O(1) token）。この 2 つが揃って初めて B1 / B2 が満たせる。ベンチ内訳で数えると、段階 1（−26ms）＋段階 4（−67ms）では約 100ms が残り、Pi 換算で約 0.5 秒の停止が続く（§3 冒頭の表）。一方、段階 3 が入れば no-op は `capture` も `fromSnapshot` も `retainActiveSubjects` も通らない。段階 2＋段階 4 の効果は「電文受理直後の 1 回」と実変更ありの sweep、live admission に限られ（Pi 実測で約 107 秒に 1 回）、後便で足しても症状解消は遅れない
- **B: 4 段階をまとめて 1 配送にする。** 実機再計測が 1 回で済むが、退行したときの切り分け単位が粗くなる。段階 3 の事前判定は取りこぼしのリスクが本 spec で最も高い変更なので、他 3 段階と混ぜると原因の切り分けが難しくなる
- **C: 段階 1＋段階 4 を先に出す。** diff は小さいが Pi の停止が約 0.5 秒残るため、ご主人の観測症状は解消しない。中間配送としての価値は低い

### 分岐 5: `transactInternal` の全文比較を残すか

- **A（推奨）: 残す（3.4.2 に記載のとおり）。** `unexpectedOwnerMutation` 検査（`src/engine/display/standby-persistence-admission.ts:561-563`）は reducer の想定外変更を捕まえる安全網で、version 比較にすると bump 漏れの reducer を通してしまう。live admission は低頻度でコストは pair serializer が支配する
- **B: `sweepAll` と揃えて version 比較にする。** live admission も軽くなるが、上記の安全網が弱くなる。実機で live admission の停止が問題として観測されてから判断する

---

## 裁定ラベル案（6 要素）

```
対象:
  src/engine/messages/vpws50-state.ts
  src/engine/messages/vpww56-state.ts
  src/engine/messages/tsunami-state.ts
  src/engine/messages/flood-forecast-state.ts
  src/engine/display/standby-state-store.ts
  src/engine/display/standby-persistence-admission.ts
  test/ 配下の新規・既存テスト
  docs/specs/2026-09-07-standby-sweep-hot-path.md

許容変更:
  owner version を incremental 方式へ置換（既存の gate / volcano holder と同方式）
  retainActiveSubjects 系の変更検出を実削除ベースへ置換
  sweepAll に capture 前の事前判定を追加
  sweepAll の base を遅延取得にし、owner 変更検出を version 比較へ置換
  上記を検証するテストの追加

禁止変更:
  SWEEP_INTERVAL_MS（constants.ts:24）の値
  STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE ほか byte / count 上限
  VPWS50 の history / partialHistory の保持件数・保持内容
  永続ファイルの schema / envelope / migration
  transactInternal の changedOwnerKeys 全文比較（分岐 5-A）
  display on/off と startStandbySweep / stopStandbySweep の配線
  package.json / package-lock.json
  data/runtime/ 配下の実データ
  実電文由来の状態ファイルのリポジトリへの追加

配送先: main → personal → Pi

ロールバック:
  main は該当 commit を git revert、personal は rebase 追従後に
  git push --force-with-lease private personal、Pi は
  git fetch origin personal && git reset --hard origin/personal で戻す

受入条件: §5.1 の A1〜A11 を全件。§5.2 は配送する段階に対応する行だけを課す
  （段階 1 のみ = B0 / 段階 1＋3 = B1・B2 / 全段階 = B3）。
  いずれも before / after を同じ状態量・同じ手順で測定する
```
