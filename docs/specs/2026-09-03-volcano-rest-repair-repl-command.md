# 火山 REST repair の REPL 手動実行コマンド仕様

- 日付: 2026-09-03
- 状態: 独立レビュー反映済み v1.1（2026-09-03）。実装は別セッション
- 作業基準 HEAD: `2734d08`（`~/dev/fleq-layout`, branch `main`）
- 上位仕様: `docs/specs/2026-08-31-vfvo54-ashfall-slice.md`（以下「slice spec」）§16 REST repair と startup
- 設計の入力: Vault `Artifacts/2026-09-03-fleq-vfvo54-carryover-investigation.md` §4 および §9「§4 REPL rest」項
- 裁定済み: ashfall は force 対象に含めるが既定外＋警告／監査は log のみ／backup 失敗は fail-closed
- 裁定済み（2026-09-03 独立レビュー反映）: 副回線ガードは不要（§11）／クールダウン 60,000 ms（§12）／`startupNowMs` → `nowMs` 改名（§10）／`all` の commit は二段階（§5.5）
- 裁定待ち: なし

この文書は normative である。「必須」「禁止」「だけ」は実装・試験の受入条件を示す。slice spec §16 の不変条件はすべて継承し、本書はそれを緩めない。

## 1. 目的と非目標

### 1.1 目的

`repairState.vfvo50Repairable` / `ashfallRepairable` が false であっても、運用者が REPL から火山 REST repair を強制実行できるようにする。

2026-09-02 の Pi 事故（memory `project_vfvo54_hotfix`）では、永続ファイルが「正しく読めた古い世代」であったため `repairable` が立たず、起動時 repair が一度も走らなかった。`repairable` は `standby-persistence.ts` のロード時破損／移行検出だけが立てるフラグであり（`src/engine/display/standby-persistence.ts:7327-7328, 7440-7461, 10009-10062`）、「読めるが古い」状態を検出しない。復旧手段が「ファイルを壊して再起動する」しか無い現状を、手動 force で置き換える。

### 1.2 非目標

- **`restoreVolcanoState` の復活禁止**。`src/engine/startup/volcano-initializer.ts` にあった legacy `restoreVolcanoState`（旧 `:1387`、一覧 item の `item.body`〔実 API に存在しないキー〕に依存する死んだ経路、`item.body` 分岐は旧 `:1409-1412`、呼び出し元なし）は `08f3965` で削除済みである。本コマンドはこれを一切使わない。削除済みの legacy 経路を復活・再配線・部分流用するいずれも禁止する。
- **`repairable` フラグの書き戻し禁止**。force 実行のために `vfvo50Repairable` / `ashfallRepairable` を true に書いてから既存経路を走らせる実装は禁止する。target は外から渡す（§3.1）。
- **永続 schema 不変**。`PersistedStandbyStateV2` / `VolcanoRepairStateV1` およびその deep 形状に field を足さない。監査は log だけに置く（裁定済み）。移行セットが不要であることが本コマンドを 1 委譲に収めるための前提である（memory `feedback_schema_change_needs_migration`）。
- **proof ロジック不変**。`crossSetConsistent`・coverage 境界・fingerprint・`acceptedAtMs` の算出・`orderHistoricalBeforeDedupe` を変更しない。
- 起動時 repair の挙動を変えない。本コマンドが追加するのは「別の入口」だけである。
- VFVO53・eruption の replay は対象外（slice spec §16.2 を継承）。

## 2. 用語

| 語 | 定義 |
|---|---|
| force repair | `repairable` フラグに関係なく target を指定して `repairVolcanoState()` を実行すること |
| target | `"vfvo50"` または `"ashfall"`。`ashfall` は VFVO54 と VFVO55 の両 endpoint を指す |
| journal | `VolcanoRepairJournal`（`volcano-initializer.ts:185`）。REST await 中の primary WS ingress を記録し、commit 時の rebase 根拠になる |
| ack | `WsSubscriptionAcknowledgement`。journal は生成時の ack を固定し、`validateAcknowledgement()` で世代一致を検査する（`:241-248`） |
| shared journal | `monitor.ts:825` の `let volcanoRepairJournal: VolcanoRepairJournal \| null`。`onPrimaryTransportData`（`:827-829`）が記録先として参照する唯一の変数 |
| invocation now | 本コマンド 1 回の実行に対して一度だけ取得する `Date.now()`。coverage 起点と replay 分類時計に使う（§10） |
| manual backup | 実行直前に v1/v2 mirror を退避したファイル。拡張子 `.manual-backup` |

## 3. 現行実装との接続点（実コード確認済み）

### 3.1 実行本体

`repairVolcanoState(options)`（`volcano-initializer.ts:1313-1379`）。

- target は `:1322` で `volcanoRepairTargets(options.coordinator.snapshot().repair)` から導出する。**ここだけが `repairable` を読む**。
- commit 本体 `commitVfvo50Proof`（`:1112`）と `commitAshfallProof`（`:1215`）は `repairable` を読まない。読むのは書き込み側の `scratch.repair.vfvo50Repairable = false`（`:1207`）／`ashfallRepairable = false`（`:1284`）だけである。
- したがって force は「target を外から渡す」ことだけで成立し、フラグ操作を必要としない。

### 3.2 journal の所有と live ingress

- 生成は `monitor.ts:930` で ack 取得後、`targets.length > 0` のときだけ。
- 記録は `MultiConnectionManager` の `onPrimaryTransportData`（`monitor.ts:827-829`）。`multi-connection-manager.ts:254` は `transport != null` のときだけ発火し、transport が渡るのは primary の `onData`（`:82`）だけである。副回線の `onData`（`:222`）は transport を渡さない。
- **副回線は火山電文を受けない**。`startBackup()` は `config.classifications` を `EEW_CLASSIFICATIONS`（`eew.forecast` / `eew.warning`）で filter した区分だけで副回線 `WebSocketManager` を張る（`multi-connection-manager.ts:197-244`、filter は `:204-206`）。積集合が空なら副回線自体が起動しない（`:208-211`）。したがって「副回線だけが受けた VFVO54/VFVO55/VFVO50」という状態は構造的に発生しない。journal の欠落経路として副回線を考慮する必要はない。
  - 将来、副回線が火山区分を購読する設計に変わるときは、transport identity を含む journal 設計（どの回線の受信を誰が記録するか）ごと再検討する。本書の journal 前提はその変更で無効化される。
- 切断時 `onDisconnected` が `failAll("subscriptionDisconnected")`（`monitor.ts:851`）。
- 起動時 repair 完了後 `volcanoRepairJournal = null`（`monitor.ts:956`）。

### 3.3 REPL 側

- コマンド定義 `src/ui/repl-handlers/command-definitions.ts:308-320`（`volcanorepair`、サブコマンド `status` / `accept` / `clear` / `acknowledge-domain`）。
- ハンドラ `src/ui/repl-handlers/operation-handlers.ts:266-317`。同期関数。`ctx.volcanoRepairAdministration` が null なら「利用できません」。
- interface `VolcanoRepairAdministration`（`src/engine/messages/volcano-transaction-coordinator.ts:352-357`）は 2 メソッドのみ。
- `monitor.ts:909` は `volcanoTransactionCoordinator` を**そのまま** administration として `ReplHandler` に渡している。`VolcanoTransactionCoordinator` が構造的に interface を満たすためであり、composition root で別オブジェクトを渡すことに障害はない。
- `src/ui/repl.ts:176-190` は handler の戻り値が Promise なら await して `commandRunning` を解除する。**async handler は既にサポート済み**であり、REPL 側の非同期対応は不要である。

### 3.4 backup

- `StandbyPersistence.writeSalvageBackup(sourcePath, bytes)`（`standby-persistence.ts:2330-2382`）は private で、呼び出し元は `backupRepairSources()`（`:2288`）だけ。入力は `this.repairSources`（`:1059`）＝**ロード時に破損／oversized と判定された source の bytes** に限られる（`:1975, 2002, 2005, 2036`）。健全なファイルを任意タイミングで退避する公開 API は存在しない。
- 保存先名は `${base}.${timestamp}.${suffix}.salvage-backup`（`:2353`）。この `suffix` は **`EEXIST` 衝突回避の連番**であって種別ラベルではない。調査ドキュメント §4 の「`writeSalvageBackup` の suffix 引数化で共用する案」はこの点で成立しない（§7.3 に代案）。
- dedup 走査（`:2337-2346`）は `name.startsWith(base + ".") && name.endsWith(".salvage-backup")` で行う。
- mirror path は `persistPath`（v1）と `standbyPersistenceV2Path(persistPath)`（v2、`:440-443`）。`persistPath` は private field（`:1076`）。

### 3.5 破壊性の非対称

- **VFVO50 commit は非破壊**。`protectedSubjects`（`:1156-1166`）と `retainActiveSubjects`（`:1196-1200`）により、窓外の alert・VFVO50 以外の provenance を持つ alert は温存される。
- **ashfall commit は破壊的**。`for (composite) if (composite.ashfall != null) scratch.holder.clearAshfall(...)`（`:1256`）で全件消し、gate も `key.startsWith("volcano:volcanoAshfall:")` を全削除（`:1259-1261`）してから 7 日窓を replay する。窓外・REST 取得漏れの ashfall は**戻らない**。

## 4. コマンド仕様

### 4.1 構文

```
volcanorepair rest [vfvo50|ashfall|all] [--dry-run] [--confirm <reason...>]
```

- 第 1 引数（target）は省略可。既定は `vfvo50`。
- `all` は `["vfvo50", "ashfall"]` と等価。
- target token は小文字化して比較する。未知 token は使い方表示で終わる（実行しない）。
- **`--confirm` は option 終端である**。`--confirm` より後の token はすべて reason 本文として扱い、option としては解釈しない。`--confirm` 以降の全 token を空白 1 個で join した文字列が reason になる。
  - したがって `--dry-run` は `--confirm` **より前**にのみ書ける。`--confirm` 以降に `--dry-run` という token が現れた場合は**使い方表示で終わる**（reason に紛れ込ませない。`rest --confirm 再現手順 --dry-run` を「dry-run のつもりだったが本実行される」と誤読する事故を型で潰す）。
  - `--confirm` 以降の `--dry-run` 検出は完全一致でのみ行う。`--dry-run=1` のような token は reason 本文として通す。
- `--dry-run` 指定時は `--confirm` を要求しない。指定されていれば reason として log に載せる。
- `--dry-run` 以外では `--confirm <reason>` が必須。reason が空文字（`--confirm` の後が無い、または空白のみ）なら使い方表示で終わる。検証規則は既存 `accept` / `clear` / `acknowledge-domain` と同一とする（`operation-handlers.ts:295-300` の「action・fingerprint・reason のいずれかが空なら使い方表示」と同じ形）。
- 受理する順序は `[target] [--dry-run] [--confirm <reason...>]` の 1 通りだけである。`rest --dry-run --confirm r` は受理、`rest --confirm r --dry-run` は usage error。両方をテストで固定する（§14.1 #4a / #4b）。
- 既存サブコマンド `status` / `accept` / `clear` / `acknowledge-domain` の構文と挙動は変更しない。`rest` は排他的な新サブコマンドである。

### 4.2 ashfall 指定時の警告

target に `ashfall` が含まれる場合、実行前に必ず次を表示する（`--dry-run` でも表示する）。

```
  警告: ashfall force は現在の降灰 slice と gate を全削除してから 7 日窓を replay します。
        窓外・REST 取得漏れの降灰情報は復元されません。
```

VFVO50 単独の場合はこの警告を出さない（§3.5 のとおり非破壊であるため）。

### 4.3 出力

- 開始時: target 一覧・dry-run か否か・manual backup の結果（作成 or 既存再利用、ファイル名）。
- 終了時: target ごとに `committed` / `proved`（dry-run）/ `failed(reason)`。dry-run では加えて historical 件数と journal 件数を表示する。
- 中止時: §5 の失敗理由をそのまま 1 行で表示する。

### 4.4 監査 log（永続化しない）

commit の成否にかかわらず、`log.info` へ 1 行を出す。形式は既存 `[volcano-repair]`（`volcano-transaction-coordinator.ts:347`）に合わせる。

```
[volcano-repair] manual rest repair mode=<dryRun|commit> targets=<...> reason=<...> backup=<...> result=<target:kind,...> runtimeVersion=<before>-><after>
```

reason は 160 文字で切り詰める（journal の failure reason と同じ上限 `:234` に揃える）。永続 state には一切書かない。

## 5. 実行の状態機械

各状態は同期区間か await を明示する。遷移失敗時の戻り先はすべて `idle` であり、その時点までに行った副作用の巻き戻しは §5.9 に従う。

```
idle
 └─(A) 引数検証・実行前ガード ─fail→ idle（使い方表示 / busy / cooldown / unavailable / notConnected）
 └─ok→ journalInstalled
       └─(B) manual backup ─fail→ idle（backupFailed）
       └─ok→ backupDone
             └─(C) 全 target を prove（await）─fail→ finalizing（failed(reason) / ackChanged）
             └─ok→ proved
                   └─(D) dry-run なら commit を行わず→ finalizing（proved）
                   └─(D') ack 最終検査 → 成功 proof を await 無しで順に commit（同期）→ committing
                         └─ok / rejected → finalizing
                               └─(E) 派生状態再計算・persistence 予約・journal 解除 → idle
```

(C) と (D') の分離が本コマンド固有の commit policy である（§5.5）。起動時経路はこの二段階化の対象外であり、既存の逐次挙動を保つ。

### 5.1 (A) idle → journalInstalled

同期区間で次を順に行う。1 つでも満たさなければ journal を install せずに終わる。

1. `ctx.volcanoRepairAdministration?.restRepair` が未提供なら `unavailable`（「この構成では利用できません」）。
2. 引数検証（§4.1）。不正なら使い方表示。
3. `monitor` 側 adapter が `volcanoRepairJournal != null` または `volcanoRestRepairInFlight === true` を見たら `busy`。**この検査と `volcanoRestRepairInFlight = true` の代入は同一の同期区間で行う**（await を挟まない）。起動時 repair 進行中もこの検査で弾かれる。
4. クールダウン検査（§12）。`cooldown` は **manual backup より前**に判定する。cooldown で拒否された試行はファイルを 1 本も作らない。
5. `manager.getSubscriptionAcknowledgement()` が null なら `notConnected`。`waitForSubscriptionAcknowledgement()` を await してはならない（未接続時に無期限に待つため）。
6. `new VolcanoRepairJournal(ack, targets)` を生成し、shared 変数 `volcanoRepairJournal` へ代入する。ここが **ack 世代の固定点**である。ctor が throw した場合（ack 不正）は `notConnected` として扱う。

以降、`onPrimaryTransportData` が到着電文をこの journal に記録する。

### 5.2 (B) journalInstalled → backupDone

`--dry-run` でも backup を行う。dry-run が「壊さない」ことの証明は §8 の不変条件で行うが、backup を省くと dry-run と本実行で経路が分岐しテスト対象が増えるため、経路は 1 本に保つ。

- backup が失敗したら `backupFailed` で中止する（裁定済み: fail-closed）。REST を 1 リクエストも発行しない。
- backup 中も journal は記録を続ける。backup が遅い／再試行で長引く場合、journal が 512 件／4MiB を超えると当該 target の proof が失敗する（slice spec §16.3）。これは安全側の縮退であり、上限を緩めない。

### 5.3 (C) backupDone → proved

`repairVolcanoState({ apiKey, nowMs, coordinator, journal, getAcknowledgement, targets, dryRun, commitPolicy: "twoPhase" })` を await する。

- 各 target の proof は `proveVolcanoTypeCoverage` 内で `validateAcknowledgement()` を 4 箇所（`:665, 672, 685, 725`）通す。install 後に ack が変われば `subscriptionGenerationChanged` を throw し、`failAll` により以降の target も失敗する。これが「install 後の ack 変更は fail-closed」の実装点である。
- REPL 表示では reason `subscriptionGenerationChanged` を `ackChanged` として表示する。
- proof は target ごとに独立に失敗しうる。ashfall は VFVO54・VFVO55 の両方が成功した場合だけ commit 候補になる。
- **手動入口では、この (C) 区間で全 target の prove を先に完走させ、commit は 1 つも行わない**。理由は §5.5。

### 5.4 (D) dry-run: proved → finalizing

`dryRun === true` のとき `commitVfvo50Proof` / `commitAshfallProof` を**呼ばない**。target 結果は `{ kind: "proved", historicalCount, journalCount }` とする。

### 5.5 (D') 二段階 commit（手動入口専用の commit policy）

#### 5.5.1 現行の逐次挙動と、その問題

`repairVolcanoState`（`volcano-initializer.ts:1313-1379`）は現状こう走る。

1. `proveVolcanoTypeCoverage(VFVO50)` を await
2. `commitVfvo50Proof` を同期実行（`:1337-1342`）
3. `proveVolcanoTypeCoverage(VFVO54)` を await（`:1350-1355`）
4. `proveVolcanoTypeCoverage(VFVO55)` を await（`:1356-1361`）
5. `commitAshfallProof` を同期実行（`:1362-1367`）

手順 2 の commit は手順 3〜4 の **await より前**に確定する。したがって ashfall の proof 中に ack 世代が変わると、`failAll` で ashfall だけが失敗し、**VFVO50 は committed のまま残る**。`all` 指定は「両 target を同じ ack 世代の証拠で一括修復する」という運用意図なので、この片側 commit は仕様として受け入れない。

起動時経路では repairable が両方立っている状況自体が事故後の縮退であり、片側だけでも通ることに救済価値がある。**起動時の逐次挙動は変えない**。

#### 5.5.2 手動入口の規則

`commitPolicy: "twoPhase"` を渡したときだけ次に切り替える。

1. **prove phase**: 対象の全 head type（`all` なら VFVO50・VFVO54・VFVO55 の 3 本）を await して proof を集める。commit は行わない。
2. **ack 最終検査**: 全 await 完了後に `journal.validateAcknowledgement(getAcknowledgement())` をもう一度通す。false なら全 target を `ackChanged` で失敗させ、commit を 1 つも行わない。
3. **commit phase**: **await を一切挟まず**、prove に成功した target だけを順に commit する（VFVO50 → ashfall）。この区間は同期であり、間に live mutation も ack 変更も割り込めない。
4. commit phase 内で片方が `rejected` / `staleVersion` を返しても、他方の commit は行う。`coordinator.transact` は target ごとに独立した transaction なので、これは「証拠は同世代、適用は独立」であり片側 commit の問題には当たらない。

- prove phase で失敗した target は commit 候補から外れ、その target の結果は `failed(reason)` になる。**他 target の commit は妨げない**（proof 失敗は当該 head type に閉じた事象であり、ack 世代の破れとは別種である）。ack 世代が破れた場合だけが全 target 失敗である。
- commit 関数（`commitVfvo50Proof` / `commitAshfallProof`）の中身は変更しない。変更するのは `repairVolcanoState` 内の**呼び出し順序**だけである。
- `bodyCache`（`:1326`）は prove phase 全体で 1 つのままとする。二段階化で REST 呼び出し量は増えない。
- `coordinator.transact` の version 検査（`volcano-transaction-coordinator.ts:191-197`）は commit phase でも最終防衛線として残る。

### 5.6 (E) finalizing → idle

`finally` 区間で必ず次を行う。

1. `volcanoRepairJournal = null`（**解除**）。
2. `volcanoRestRepairInFlight = false`。**`volcanoRestRepairInFlight = true` を代入した後に到達しうる全ての離脱経路**（`notConnected` / journal ctor throw / `backupFailed` / prove throw / commit throw / 全 target 失敗 / REPL 中断）で false へ戻ることが受入条件である。false へ戻らない経路が 1 つでも残ると、以後すべての実行が `busy` で永久に拒否される（プロセス再起動でしか解けない）。
3. `dryRun !== true` かつ少なくとも 1 target が `committed` のときだけ、起動時と同じ式で派生状態を再計算する（`monitor.ts:958-960`）。

```ts
volcanoRepairState = volcanoTransactionCoordinator.snapshot().repair;
volcanoFoundationAuthoritative = !volcanoRepairState.vfvo50Repairable
  && volcanoRepairState.unrecoverableAlertOmissions.length === 0;
scheduleLatestStandbyPersistence();
```

4. dry-run または全 target 失敗のときは上記 3 を行わない（§8）。

`finally` は例外経路（proof の throw、commit の throw、REPL の中断）でも必ず通る。`repl.ts:178-189` の `.catch().finally()` は handler の外側であり、journal 解除を REPL に依存させてはならない。解除は adapter 自身の `try/finally` で行う。

### 5.7 失敗理由の一覧

| reason | 契機 | runtime への影響 |
|---|---|---|
| `unavailable` | administration 未提供／`restRepair` 未実装 | なし |
| `busy` | shared journal が非 null、または in-flight フラグ | なし |
| `cooldown` | 直前の REST 発行から §12 の間隔未満 | なし（backup も未作成） |
| `notConnected` | ack が null、または ack が journal ctor の検査に落ちる | なし |
| `backupFailed` | manual backup が §7 の成功条件を満たさない | なし（REST 未発行） |
| `ackChanged` | install 後、または commit 直前の最終検査で subscription generation / transportId / socketId が変化 | なし（全 target fail-closed。片側 commit も起きない — §5.5） |
| `failed(<reason>)` | proof / commit の既存 reason をそのまま透過 | なし（target 単位 fail-closed） |

`failed` の `<reason>` は既存識別子をそのまま使う。新設しない。代表例: `historicalPageLimitExceeded`、`historicalItemLimitExceeded`、`historicalBodyUnavailable:forbidden`、`historicalBodyUnavailable:fetchLimitExceeded`、`transportInconsistency`、`sameTimeGroupOrderingUnproven`、`vfvo50ReplayRejected`、`vfvo50OmissionMutation`、`vfvo50RepairOnlyCoverageMissing`、`ashfallReplayRejected`、`ashfallSourceCapacityExceeded`、`staleVersion`。

### 5.8 concurrent 実行

- REPL は `commandRunning` で入力を直列化するが（`repl.ts`）、shutdown・display・signal 経路からの同時到達を排除しない。ガードは §5.1 手順 3 の同期フラグだけを真実源とする。
- 2 本目は必ず `busy` を返す。待ち行列・再試行・キューイングは実装しない。

### 5.9 巻き戻し

- journal install 後に失敗した場合、install 自体の副作用は「その間の live 電文を記録した」ことだけであり、journal は破棄されるので runtime に影響しない。
- manual backup ファイルは失敗時も削除しない（`writeSalvageBackup` と同じく、この試行で `wx` 作成した未完了ファイルだけは unlink する `:2372-2377`）。
- commit が `rejected` / `staleVersion` の場合、`coordinator.transact` は runtime を変更しない。追加の巻き戻しは不要である。

## 6. journal 所有権

### 6.1 責務

`monitor.ts` の composition root に、shared 変数を閉じ込めた adapter を 1 つ置く。

```ts
const volcanoRestRepairAdapter = {
  async restRepair(request: VolcanoRestRepairRequest): Promise<VolcanoRestRepairResult> {
    if (volcanoRepairJournal != null || volcanoRestRepairInFlight) return { kind: "busy" };
    const nowMs = Date.now();                    // invocation now（§10）— 以後再取得しない
    const remaining = volcanoRestRepairCooldownUntilMs - nowMs;   // §12.3
    if (remaining > 0) return { kind: "cooldown", remainingMs: remaining };
    volcanoRestRepairInFlight = true;            // ここまで同期
    let restIssued = false;                      // cooldown 時計を進める条件（§12.3）
    try {
      const ack = manager?.getSubscriptionAcknowledgement() ?? null;
      if (ack == null) return { kind: "notConnected" };
      volcanoRepairJournal = new VolcanoRepairJournal(ack, request.targets);
      // manual backup（§7）— 失敗なら backupFailed で return（REST 未発行）
      // repairVolcanoState（§5.3, commitPolicy: "twoPhase"）
      //   loadPage / loadBody を 1 回でも呼んだら restIssued = true
    } finally {
      volcanoRepairJournal = null;
      volcanoRestRepairInFlight = false;
      if (restIssued) volcanoRestRepairCooldownUntilMs = Date.now() + VOLCANO_REST_REPAIR_COOLDOWN_MS;
    }
  },
};
```

- shared 変数 `volcanoRepairJournal` の宣言（`monitor.ts:825`）と `onPrimaryTransportData`（`:827-829`）は変更しない。
- `volcanoRestRepairInFlight` と `volcanoRestRepairCooldownUntilMs` は adapter と同じ closure に閉じ込める。`monitor.ts` の外から参照できる形で export しない。
- `restIssued` の判定は `repairVolcanoState` の戻り値に含めるか、`loadPage` / `loadBody` を wrap した counter で取る。どちらでもよいが「REST を 1 本も出していない試行では false」であることが受入条件である（§14.2 #24-26）。
- adapter は `monitor.ts` の外へ出さない。`volcano-initializer.ts` や `operation-handlers.ts` が shared 変数へ直接触れることを禁止する。
- REPL へ渡すのは `VolcanoRepairAdministration` を満たしつつ `restRepair` を持つ合成オブジェクトである。`monitor.ts:909` の `volcanoTransactionCoordinator` 直渡しを、`{ status: ..., resolveOperationalV2AlertOmission: ..., restRepair: ... }` へ置き換える。coordinator の 2 メソッドは bind して委譲する。

### 6.2 起動時 repair との排他

起動時経路（`monitor.ts:926-956`）は次の順で走る。

1. `manager.connect()` を await。
2. targets があれば ack を await し journal を生成（`:930`）。
3. `restoreTsunamiState` を await。
4. `repairVolcanoState` を await（`:944`）。
5. `volcanoRepairJournal = null`（`:956`）。

REPL は `replHandler.start()`（`monitor.ts:922`）の後に入力を受け付けるため、手順 2〜5 の間にコマンドが到達しうる。そのとき shared 変数は非 null なので §5.1 手順 3 が `busy` を返す。手順 1〜2 の間（journal が null で ack もまだ）は `notConnected` を返す。いずれも安全側である。

起動時経路が `catch` に落ちた場合（`monitor.ts:978-979`）も `volcanoRepairJournal = null` が実行されるため、以後の REPL 実行は妨げられない。

### 6.3 install 後の ack 変更

- `VolcanoRepairJournal.validateAcknowledgement()`（`:241-248`）が `subscriptionGeneration` / `transportId` / `socketId` の 3 値一致を見る。不一致で `failAll` する。
- 切断は `onDisconnected` の `failAll("subscriptionDisconnected")` が先に立つ（`monitor.ts:851`）。`onDisconnected` は adapter の外から非同期に発火するので、fail-closed の成立は「adapter が commit 前に journal 状態を見る」ことに依存する。§5.5.2 手順 2 の最終検査がその観測点である。
- 再接続で ack 世代が上がった場合も 3 値検査で落ちる。**再 install して続行してはならない**。ack をまたいだ journal は「REST await 中の live mutation を全て見た」ことを証明できない。
- ack 変更が起きた実行でも `finally`（§5.6）は必ず通り、journal 解除と in-flight 解除が行われる。fail-closed は「その実行を失敗させる」ことであって「adapter を塞ぐ」ことではない。

## 7. manual backup

### 7.1 公開 API

`StandbyPersistence` に public メソッドを 1 つ追加する。

```ts
backupCurrentMirrors(label: "manual"): VolcanoManualBackupResult;

type VolcanoManualBackupResult =
  | { kind: "backedUp"; files: { source: "v2" | "v1"; path: string; reused: boolean }[] }
  | { kind: "failed"; reason: "noMirrorPresent" | "readFailed" | "writeFailed"; source?: "v2" | "v1"; detail: string };
```

- 対象は `standbyPersistenceV2Path(this.persistPath)`（v2）と `this.persistPath`（v1）の 2 本。順序は v2 → v1 に固定する（reader の選択順 `:1147-1148` に合わせる）。
- 各 mirror について `fs.readFileSync` する。`ENOENT` は **不存在**として記録し失敗にしない。それ以外の read error は `readFailed` で即中止する。
- `this.repairSources` を使わない。破損 source の bytes ではなく **現在ディスク上の bytes** を退避する。
- 両 mirror の read を**すべて終えてから** write に入る。`noMirrorPresent` は 1 本も write していない状態で確定させる（第 1 段実装 7919a60 の挙動を規範化）。
- write が途中で失敗した場合（v2 成功・v1 失敗など）、作成済みの `.manual-backup` は**削除せず残して** `writeFailed` を返す。backup は多い分に害がなく、`.salvage-backup` 側が部分成功を残す既存挙動と揃える。
- 呼び出しは同期。debounce 中の pending write とは競合しうるが、退避対象は「今ディスクにあるもの」であり、pending が後で上書きするのは正常である。

### 7.2 存在パターン 4 通り

| v2 | v1 | 可否 | 成功条件 |
|---|---|---|---|
| あり | あり | 実行可 | **両方**の backup が成功（新規作成 or 同一 sha256 の既存再利用） |
| なし | あり | 実行可 | v1 の backup が成功 |
| あり | なし | 実行可 | v2 の backup が成功 |
| なし | なし | **実行不可** | `noMirrorPresent` で fail-closed |

- 「存在する両 mirror の完全 backup 成功」が実行条件である。片方不存在は正当なケースとして許可する（v1 rollback 前・v2 生成前の過渡状態が実在する）。
- 両方不存在は fresh-empty 起動直後にありうるが、そのとき force repair する運用上の理由が無く、かつロールバック先が存在しない。裁量を残さず fail-closed とする。`--allow-missing-mirror` のような escape hatch を設けない。

### 7.3 `writeSalvageBackup` との共用

調査ドキュメントの「`suffix` 引数化」案は採らない（§3.4）。代わりに **拡張子を引数化**する。

```ts
private writeBackupFile(sourcePath: string, bytes: Buffer, extension: "salvage-backup" | "manual-backup"): { path: string; reused: boolean }
private writeSalvageBackup(sourcePath: string, bytes: Buffer): void  // writeBackupFile(..., "salvage-backup") へ委譲
```

- dedup 走査（`:2337-2346`）は **同じ extension のファイルだけ**を対象にする。`manual-backup` が既存の `salvage-backup` と同一 sha256 だからといって作成を省略してはならない（種別の証拠が混ざる）。逆も同じ。
- ファイル名は `${base}.${timestamp}.${collisionIndex}.${extension}`。`collisionIndex` は既存の `EEXIST` 回避連番の意味を維持する。
- 書き込み手順は現行と同一とする: `wx` で作成（`:2354-2361`）、部分書き込みループ（`:2363-2367`）、`fs.fsyncSync(fd)`（`:2368`）、`close`、`fsyncBackupDirectory(directory)`（`:2372`）。この 4 点を欠いた実装を認めない。抽出後もこの順序を変えない。
- **directory fsync が OS 非対応の場合**は既存 `fsyncBackupDirectory`（`:2385-2405`）の挙動をそのまま継承する: `EINVAL` / `ENOTSUP` / `EOPNOTSUPP` なら初回だけ debug log を出して `directoryFsyncSupported = false` を記録し、以後 skip して**成功扱いにする**。それ以外の error は throw して `writeFailed` へ伝播させる。manual backup 固有の分岐を足さない。この縮退は「directory entry の耐久性が保証されない環境では file fsync までで妥協する」という既存判断であり、本コマンドがそれを厳格化も緩和もしない。
- 既存の同一 sha256 backup を再利用した場合は `reused: true` を返し、`path` に既存ファイルを載せる。
- `writeSalvageBackup` の既存呼び出し元 `backupRepairSources()` の挙動・診断カウンタ（`persistenceSalvageBackupBlocked` / `Recovered`）は変更しない。manual backup はこれらのカウンタを増減させない。

### 7.4 backup と REST の順序

manual backup は §5 の状態機械のとおり **journal install の後・最初の REST リクエストの前**に完了していなければならない。backup 失敗時に REST を 1 リクエストも出さないことが受入条件である。

## 8. dry-run 不変条件

### 8.0 不変条件の適用範囲

不変条件は「**`--dry-run` コマンド自身が runtime と永続ファイルを変更しない**」ことに限定する。プロセス全体の静止を主張しない。次の 2 つは不変条件の**対象外**である。

1. **同時 ingress**: dry-run 実行中に到着した WS 電文は `routeMessage` を通って runtime を変更し、`scheduleLatestStandbyPersistence()` を呼びうる。これは dry-run の副作用ではなく、平常運転の継続である。
2. **実行前から予約済みの persistence write**: dry-run 開始時点で debounce 待ちの write が存在すれば、実行中に flush されてファイルが書き換わる。これも dry-run が起こしたものではない。

したがって §8.1 の表は **ingress を停止した隔離環境**（adapter 単体テスト、または REST/WS を stub した monitor テスト）で検査する。実機での sha256 比較は §15 の受入条件でのみ用い、その有効性は「静穏状態である」という前提に依存する（§8.2）。

### 8.1 検査項目

`--dry-run` 実行は次のすべてを変更しない。テストは実行前後の値を比較して検査する。

| 対象 | 検査方法 |
|---|---|
| runtimeVersion | `coordinator.snapshot().runtimeVersion` が実行前後で一致（`volcano-transaction-coordinator.ts:149-153`） |
| holder | `coordinator.snapshot().holder` の canonical JSON が一致（composites・sourceEventIds を含む） |
| gate | `snapshot().gate.exportDurableEntries()` の canonical JSON が一致 |
| repair state | `snapshot().repair` の canonical JSON が一致。特に `vfvo50Repairable` / `ashfallRepairable` / `unrecoverableAlertOmissions` |
| 予約 persistence | `scheduleLatestStandbyPersistence()` が **0 回**呼ばれる。`StandbyPersistence.schedule()` の spy 呼び出し回数で検査する |
| 派生フラグ | `volcanoFoundationAuthoritative` が変化しない |
| 永続ファイル | 永続ディレクトリの **snapshot 比較**。実行前後で directory listing を取り、許容差分は `.manual-backup` 拡張子の新規ファイルのみ。既存の全ファイル（v1/v2 mirror、既存 `.salvage-backup`）は sha256 が一致し、新規作成・削除・改名が 1 件も無いこと |

dry-run が唯一許す副作用は次の 3 つだけである。

1. manual backup ファイルの作成（§7）。**新規作成されるのは `.manual-backup` 拡張子のファイルだけ**であり、それ以外の名前のファイルが増えていれば試験は赤とする。
2. REST GET リクエストの発行（読み取りのみ）。
3. log 出力。

`journal` オブジェクトの内部状態（記録された live 電文）は実行終了時に破棄されるため、runtime の不変には数えない。

### 8.2 実機での検証可能性

Pi 受入（§15 #10）の「実行前後で永続ファイル 2 本の sha256 が一致」は、**電文が到着せず debounce 予約も無い静穏状態でのみ成立する**。降灰・警報の入電中や、実行直前に state が dirty だった場合は sha256 が変わりうるが、それは dry-run の違反ではない。

実機で差分を観測したときは、まず `[standby-persistence]` の write log と入電 log を突き合わせ、同時 ingress 由来かどうかを切り分ける。切り分けられない場合は「dry-run が壊した」と断定せず、隔離環境の §14.4 テストが緑であることを根拠にする。

## 9. force の破壊性

### 9.1 VFVO50: 非破壊

`commitVfvo50Proof`（`:1112-1213`）は次を温存する。

- `protectedSubjects`（`:1156-1166`）: gate 上の非 VFVO50 provenance を持つ subject と、holder 上で `alert.sourceFamily !== "VFVO50"` の composite。ループ内 `if (protectedSubjects.has(subject)) continue`（`:1180`）で replay 対象から外す。
- `retainActiveSubjects`（`:1196-1200`）: gate の active な alert / eruption / ashfall subject を holder に残す。
- `mergeBaselineSourceIds`（`:1201`）: 既存 `sourceEventIds` を退避してから merge。
- `unrecoverableAlertOmissions` の変化は `vfvo50OmissionMutation` で reject（`:1204-1206`）。

したがって「窓外の alert が消える」ことはない。VFVO50 force の主な効果は、窓内の最新 alert 状態で slice を再構築し `vfvo50Repairable` を false にすることである。

### 9.2 ashfall: 破壊的

`commitAshfallProof`（`:1215-1288`）は transaction 冒頭で次を行う。

```ts
for (const composite of scratch.holder.snapshot().composites) {
  if (composite.ashfall != null) scratch.holder.clearAshfall(composite.volcanoCode);
}
gateSnapshot.states = gateSnapshot.states.filter((entry) => !entry.key.startsWith("volcano:volcanoAshfall:"));
scratch.gate.replacePrevalidated(gateSnapshot);
```

- 降灰 slice と ashfall gate を **全件削除**してから、7 日窓の historical + journal tail を replay する。
- REST が取り漏らした ashfall、7 日窓より古い ashfall、live ingress で入ったが journal に無い ashfall は復元されない。
- `expireRevisionFamily("volcano", "volcanoAshfall", nowMs, VOLCANO_ASHFALL_RETENTION_MS)`（`:1274-1279`）が invocation now を基準に gate を expire し、続く `coupleVolcanoGateAndHolder(scratch, nowMs)`（`:1280`）が holder を gate の active subject へ合わせて sweep する（§10.2）。

### 9.3 警告文

§4.2 の警告文を normative とする。文言を変える場合も「全削除してから replay する」「窓外は復元されない」の 2 点を落とさない。`--dry-run` でも表示する（dry-run で確認してから本実行する運用を前提にするため）。

## 10. 時計: invocation now

### 10.1 パラメータ

`repairVolcanoState` の `startupNowMs` を `nowMs` へ**改名する（決定 2026-09-03）**。起動時経路は `startupNowMs`（`monitor.ts:250` で一度取得する値）をそのまま渡し、REPL 経路は `Date.now()` を **コマンド 1 回につき一度だけ**取得して渡す。実行中に `Date.now()` を再取得する箇所を作らない。

改名対象は `volcano-initializer.ts` の該当 field と `commitVfvo50Proof`（`:1112-1116`）/ `commitAshfallProof`（`:1215-1220`）/ `coupleVolcanoGateAndHolder`（`:1100-1103`）/ `proveVolcanoTypeCoverage` の引数名、および test の参照である（`grep -c startupNowMs` = 56、うち `standby-persistence.ts` 系と `monitor.ts` の起動時 local 変数は別文脈なので対象外）。

改名を行う理由: 同じ field に「起動時刻」と「コマンド実行時刻」の 2 意味を持たせると、§10.2 の挙動差が名前から見えなくなる。CLAUDE.md「型で守る」の趣旨に沿って名前を実態へ合わせる。

### 10.2 coverage 起点と tombstone 期限への影響

`coverageStartMs = nowMs - familyRetentionMs`（`checkedCoverageStart`、slice spec §16.4）。

- 起動から `d` 経過後に force すると、coverage 窓は `d` だけ前へ動く。ashfall なら `[now-7d, now]`、VFVO50 なら `[now - VOLCANO_ALERT_TOMBSTONE_RETENTION_MS, now]`。
- **これは意図した挙動である**。retention の定義が「現在からの保持期間」だからであり、起動時刻に固定すると稼働時間が延びるほど窓が過去へ取り残される。
- 影響: ashfall force を起動から 7 日以上経ってから実行すると、起動時に replay された最古の item が窓外になる。§9.2 の全削除と組み合わさるため、**古い降灰は消える**。§4.2 の警告文はこの帰結も含意する。
- `repairReplayTimesValid(item.normalizedInput, expiryNowMs)`（VFVO50 は `:1168-1172`、ashfall は `:1265-1269`）は journal 収録 item には item 自身の `receivedAtMs`、historical item には `nowMs` を渡す。invocation now が進むと historical item の分類時計が進み、期限切れ判定が現実に即す。この点は両 target 共通である。

#### 10.2.1 VFVO50 と ashfall で `nowMs` の効き方が違う

実コードを読むと、`nowMs` の作用範囲は target ごとに非対称である。実装・試験はこの差を混同してはならない。

**VFVO50 commit（`commitVfvo50Proof` `:1112-1213`）**

- `nowMs` を使うのは **coverage 窓の起点**（`proveVolcanoTypeCoverage` の `coverageStartMs = nowMs - VOLCANO_ALERT_TOMBSTONE_RETENTION_MS`）と、historical item の `repairReplayTimesValid` 分類時計（`:1168-1172`）だけである。
- **`expireRevisionFamily` を呼ばない**。`coupleVolcanoGateAndHolder`（したがって `holder.sweep(nowMs)`）も呼ばない。呼ぶのは `retainActiveSubjects`（`:1196-1200`）と `mergeBaselineSourceIds`（`:1201`）だけである。
- したがって「`nowMs` が進んだせいで既存の alert gate entry や holder composite が expire する」ことは **起きない**。VFVO50 で `nowMs` が変えるのは「REST でどこまで遡って証明するか」の境界だけである。§9.1 の非破壊性はこの事実に支えられている。

**ashfall commit（`commitAshfallProof` `:1215-1288`）**

- coverage 起点（`nowMs - VOLCANO_ASHFALL_RETENTION_MS`）と分類時計（`:1265-1269`）に加えて、
- `scratch.gate.expireRevisionFamily("volcano", "volcanoAshfall", nowMs, VOLCANO_ASHFALL_RETENTION_MS)`（`:1274-1279`）で **gate entry の tombstone/holder expiry** を進め、
- `coupleVolcanoGateAndHolder(scratch, nowMs)`（`:1280`）が `holder.retainActiveSubjects(...)` ＋ `holder.sweep(nowMs)`（`:1100-1109`）を実行する。
- つまり ashfall では `nowMs` が **coverage 境界と gate/holder の有効期限の両方**を動かす。§9.2 の全削除と合わせて、「古い降灰が消える」帰結はここから来る。
- gate と holder の結合検査は同一時計で行われるため、slice spec §14.3 の coupling 不変は保たれる。

### 10.3 実測が要る点

起動完了後に `repairVolcanoState` を走らせた実績はゼロである。実装後、Pi で次を実測して spec へ追記する。

1. `--dry-run` の historical 件数が起動時ログの件数と整合するか（窓移動分の差を除いて）。
2. VFVO50 force 後に火山件数（Pi 実測 8 件）が減らないこと。
3. ashfall force 後に、force 前に表示されていた降灰カードが復元されること。

## 11. 副回線と journal（ガード不要の確認）

### 11.1 結論

**副回線ガードは実装しない（決定 2026-09-03、独立レビュー指摘をご主人が採用）。** 起草時に想定した「副回線だけが受けた火山電文が journal から漏れ、ashfall commit の全削除で失われる」危険は、実コード上**発生しない**。

### 11.2 根拠

`MultiConnectionManager.startBackup()`（`multi-connection-manager.ts:197-244`）は副回線の購読区分を次で決める。

```ts
const backupClassifications = this.config.classifications.filter(
  (c): c is Classification => EEW_CLASSIFICATIONS.includes(c)
);
if (backupClassifications.length === 0) { /* 起動しない */ }
```

- `EEW_CLASSIFICATIONS` は `eew.forecast` / `eew.warning` の 2 区分だけである（`:204-206`）。
- 副回線 `WebSocketManager` はこの区分だけで `connect()` する（`:216-240`）。火山区分（`telegram.earthquake` 系の VFVO50/54/55 が乗る区分）は購読しない。
- したがって副回線経由で火山電文が `handleData` に入ることはなく、「runtime には反映されているが journal に無い火山電文」という状態は構造的に作れない。

`handleData`（`:253-254`）が `transport == null` のとき `onPrimaryTransportData` を呼ばないのは事実だが、その経路を通る電文は EEW だけであり、火山 journal の完全性には影響しない。

### 11.3 削除したもの

- 失敗理由 `backupLineActive`（§5.7 から削除）
- 実行前ガードとしての副回線検査（§5.1 から削除）
- `MultiConnectionManager` への `isBackupActive()` 追加（§13 から削除）。なお public な `isBackupRunning()` は既に `:192` に存在するので、仮にガードが要ったとしても新規 API 追加は不要だった
- 停止／再開案（旧 §11.3 案 B）とその判断節

### 11.4 将来の再検討条件

副回線が火山区分を購読する設計へ変わったら、本節の前提は無効になる。そのときは「どの回線の受信を誰が journal に記録するか」＝ **transport identity を含む journal 設計ごと**再検討する。ガードを 1 つ足して済ませてはならない（`onPrimaryTransportData` は名前のとおり primary 専用の記録点であり、複数回線を前提にした構造ではない）。

## 12. REST 呼び出し量とクールダウン

### 12.1 既存の上限（実コード確認済み）

| 上限 | 値 | 位置 |
|---|---:|---|
| `VOLCANO_REPAIR_MAX_PAGES` | 128 | `volcano-initializer.ts:65, 589, 638` |
| `VOLCANO_REPAIR_PAGE_LIMIT` | 100 | `:593`（slice spec §16.4） |
| `VOLCANO_REPAIR_MAX_ITEMS_PER_TYPE` | 12,800 | `:66, 616` |
| `VOLCANO_REPAIR_MAX_BODY_FETCHES` | 256 / repair | `:69, 709` |
| body cache | repair 1 回にスコープ | `:1326`（`bodyCache` は `repairVolcanoState` のローカル） |

調査ドキュメント §4 の「REST 呼び出し量…連打クールダウンは未設計」は、**1 回あたりの上限については未設計ではない**。未設計なのは「連打」＝複数回実行の間隔だけである。

最悪ケース: `all` 指定で 3 head type × 128 page = 384 list request ＋ body 256 request = 640 request。実運用（Pi 実測: 火山 8 件、7 日窓）では list 各 1〜2 page・body 数件に収まる。

### 12.2 クールダウンの要否

**必要と判断する**。理由は 2 つ。

1. `busy` ガードは同時実行しか防がない。連続実行（1 本目完了 → 即 2 本目）は素通りする。
2. body 取得の cache は repair 1 回スコープなので、2 回目は同じ id を再取得する。slice spec §16.4.1 の「同じ id へ短期間に繰り返しリクエストしない」に反する。

### 12.3 規則

- `VOLCANO_REST_REPAIR_COOLDOWN_MS` = **60,000 ms**（決定 2026-09-03）。process 内のメモリ変数だけで管理し、永続化しない。再起動でリセットされてよい。
- **時計を進めるのは、REST request を 1 本以上発行した試行だけである**（決定 2026-09-03）。クールダウンが守っているのは dmdata への request 圧であり、request を出していない試行がそれを消費する理由が無い。
  - 進める: prove phase に入って `loadPage` / `loadBody` を 1 回以上呼んだ実行（dry-run を含む、成否・commit 有無を問わない）。記録するのは**その実行の終了時刻**である。
  - 進めない: `usage error` / `unavailable` / `busy` / `cooldown` / `notConnected`（= preflight failure）と `backupFailed`。これらは REST を 1 本も出していない（§7.4 の fail-closed により backup 失敗時は REST 未発行が保証される）。
- **判定順序**: クールダウン検査は §5.1 手順 4 に置き、**manual backup（§5.2）より前**に行う。cooldown で拒否された試行はバックアップファイルを 1 本も作らない。
- 拒否時は `busy` の亜種 `cooldown` を返し、残り秒数を表示する。
- クールダウンは REPL adapter のスコープに置く（`monitor.ts` の composition root）。`repairVolcanoState` 自体には持たせない。
- 起動時 repair はクールダウンの対象外であり、クールダウン時計を開始もしない。

## 13. 対象ファイルと規模

| ファイル | 変更内容 | 概算 |
|---|---:|---:|
| `src/engine/startup/volcano-initializer.ts` | `repairVolcanoState` に `targets?` / `dryRun?` / `commitPolicy?` 追加、二段階 commit（§5.5）、`startupNowMs` → `nowMs` 改名、結果に `proved` と件数 | +55 / 改名 |
| `src/engine/messages/volcano-transaction-coordinator.ts` | `VolcanoRepairAdministration` に optional `restRepair?` と request/result 型を追加 | +25 |
| `src/engine/monitor/monitor.ts` | adapter 実装（ガード・cooldown・ack・backup・journal install/uninstall・派生再計算）、`ReplHandler` へ合成オブジェクトを渡す | +80 |
| `src/engine/display/standby-persistence.ts` | `backupCurrentMirrors()` 追加、`writeBackupFile()` へ抽出 | +45 |
| `src/ui/repl-handlers/operation-handlers.ts` | `rest` サブコマンドの解析（`--confirm` 終端）・警告・await・表示 | +60 |
| `src/ui/repl-handlers/command-definitions.ts` | `rest` サブコマンド定義、handler を async 対応（戻り値を返す） | +8 |
| `src/ui/repl-handlers/types.ts` | 型追従（既存 optional field のまま） | +2 |
| `docs/specs/2026-08-31-vfvo54-ashfall-slice.md` | §16 に「手動 force の入口」を 1 段落追記、§18 対象ファイルへの追記 | +15 |
| test（4〜5 ファイル） | §14 | +300〜350 |

src 約 265 行、テスト込み 600〜700 行。**実装を 2 委譲に分割する（決定 2026-09-03）**。

- **委譲 1**: `standby-persistence.ts` の `writeBackupFile()` 抽出と `backupCurrentMirrors()` 追加、および §14.5 の耐久性試験（#33-41）。`volcano-initializer.ts` / `monitor.ts` / REPL を触らない。
- **委譲 2**: `volcano-initializer.ts` の二段階 commit と `nowMs` 改名、`monitor.ts` の adapter、REPL 配線、§14.1-14.4・14.6 のテスト。委譲 1 の成果物を前提にする。

## 14. 必須テスト

番号ごとに `it` が 1 つ以上対応することを受入条件とする（§15 #5）。

### 14.1 引数解析と入口ガード（`test/ui/command-definitions.test.ts` / `test/ui/repl.test.ts`）

1. `rest` 省略時の既定 target が `["vfvo50"]` である。
2. `rest ashfall` / `rest all` が target を正しく解決し、ashfall を含むとき警告文を出力する。
3. `rest` に未知 token（例 `vfvo51`）を渡すと使い方表示のみで `restRepair` を呼ばない。
4. `--confirm` 無しの非 dry-run が使い方表示のみで `restRepair` を呼ばない。
5. `--confirm` の reason が空白のみのとき使い方表示のみで `restRepair` を呼ばない。
6. `--dry-run` は `--confirm` 無しで `restRepair` を呼ぶ。
7. `rest all --dry-run --confirm 動作確認` が受理され、`dryRun === true` / `reason === "動作確認"` で `restRepair` に渡ること（順序：option が `--confirm` より前）。
8. `rest all --confirm 動作確認 --dry-run` が**使い方表示のみで終わり** `restRepair` を呼ばないこと（`--confirm` は option 終端。§4.1）。
9. `rest all --confirm 手順 --dry-run=1` は受理され、reason が `"手順 --dry-run=1"` になること（完全一致でのみ usage error にする）。
10. `ctx.volcanoRepairAdministration` が null、または `restRepair` 未提供のとき「利用できません」を出し例外を出さない。
11. handler が Promise を返し、`repl.ts` が await して `commandRunning` を解除する（`repl.ts:176-190` の既存 async 経路の回帰）。
12. 既存 `status` / `accept` / `clear` / `acknowledge-domain` の挙動が変わらない（回帰）。

### 14.2 状態機械の遷移（`test/engine/monitor/` または adapter 単体テスト）

13. shared journal が非 null のとき `busy` を返し、journal を差し替えない。
14. in-flight フラグが立っているとき（1 本目が await 中）2 本目が `busy` を返す。
15. ack が null のとき `notConnected` を返し、`waitForSubscriptionAcknowledgement` を呼ばない。
16. 成功経路で journal が install され、`onPrimaryTransportData` 相当の呼び出しが記録されること。
17. **manual backup の実行中に到着した primary 電文が journal に記録され、その後の commit に反映されること**。backup を遅延させた stub で、backup 完了前に `onPrimaryTransportData` を 1 件発火し、commit 後の holder にその mutation が現れることを検査する（journal install が backup より前である §5 の順序を固定する）。
18. `finally` で journal が null に戻ること（成功・proof 失敗・commit reject・throw の 4 経路）。
19. **`finally` で `volcanoRestRepairInFlight` が false に戻ること**。in-flight を true にした後に到達しうる全経路を列挙して検査する: 成功 / proof 失敗 / commit reject / throw / `notConnected` / journal ctor throw / `backupFailed`。各経路の直後に 2 本目を実行して `busy` にならないことで確認する（§5.6）。
20. **`onDisconnected` 後の fail-closed と解除**。prove の await 中に `monitor.ts:851` の `onDisconnected` 相当（`journal.failAll("subscriptionDisconnected")`）を発火させると、当該実行が失敗し commit が 1 つも行われず、かつ `finally` で journal と in-flight の両方が解除されること。解除後に次の実行が受理されること。
21. commit 成功後に `volcanoRepairState` / `volcanoFoundationAuthoritative` が起動時と同じ式で再計算され、`schedule()` が 1 回だけ呼ばれること。
22. 全 target 失敗時に `schedule()` が 0 回であること。
23. クールダウン中の再実行が `cooldown` を返し、REST を発行せず、`.manual-backup` ファイルも 1 本も作らないこと（判定順序 §12.3）。
24. **preflight failure がクールダウン時計を進めないこと**。`notConnected` で拒否された直後に、接続を回復させて即座に実行すると `cooldown` にならず受理されること。
25. **backup failure がクールダウン時計を進めないこと**。`backupFailed` の直後に backup を成功させて即座に実行すると `cooldown` にならず受理されること。
26. REST を 1 本以上発行した実行（dry-run を含む）は終了時刻を記録し、直後の再実行が `cooldown` になること。

### 14.3 force の経路と二段階 commit（`test/engine/volcano-initializer.test.ts`）

27. `repairable` が両方 false でも `targets: ["vfvo50"]` を渡せば VFVO50 proof が走り commit されること。
28. `targets: ["ashfall"]` で VFVO54・VFVO55 の両 proof が走り、片方失敗なら commit しないこと。
29. `targets: ["vfvo50","ashfall"]` で target が独立に成功／失敗すること。
30. **`all` の ack 変更境界（二段階化の核心）**。`commitPolicy: "twoPhase"` で `targets: ["vfvo50","ashfall"]` を実行し、**VFVO54 の proof await 中に ack の `subscriptionGeneration` を変える**と、両 target が `ackChanged` で失敗し、**VFVO50 も commit されない**こと（`runtimeVersion` が実行前後で不変）。同じ条件を `commitPolicy` 無し（起動時挙動）で走らせると VFVO50 だけ committed になることも併せて固定し、二段階化の差分を明示する。
31. `commitPolicy: "twoPhase"` の commit phase が await を挟まないこと。prove 完了後に ack を変えても、commit phase 直前の最終検査（§5.5.2 手順 2）以降は commit が完走すること。
32. `commitPolicy: "twoPhase"` で VFVO50 の proof が失敗しても、ashfall の proof と commit は行われること（proof 失敗は当該 head type に閉じる。ack 世代の破れとは別種）。
33. **起動時経路の回帰**。`commitPolicy` を渡さない呼び出しでは従来どおり VFVO50 commit → VFVO54 prove → VFVO55 prove → ashfall commit の順で走ること（呼び出し順序を spy で固定）。
34. force commit 後も `unrecoverableAlertOmissions` が byte-for-byte 不変であること（`vfvo50OmissionMutation` の回帰）。
35. VFVO50 force が非破壊であること: 窓外 alert・非 VFVO50 provenance の alert・既存 `sourceEventIds` が保持される。
36. ashfall force が破壊的であること: force 前に存在した窓外 ashfall が消え、窓内が replay される（§9.2 の明文化を試験で固定する）。
37. `nowMs` を起動時刻ではなく実行時刻で渡したとき、coverage 窓が移動して古い item が除外されること。
38. **ashfall tombstone expiry の境界**（`expireRevisionFamily(..., nowMs, VOLCANO_ASHFALL_RETENTION_MS)` `:1274-1279`）。`lastUpdatedMs === nowMs - VOLCANO_ASHFALL_RETENTION_MS` ちょうどの ashfall gate entry は**保持**され、そこから 1 ms 超過した entry は**削除**されること。`coupleVolcanoGateAndHolder`（`:1280`）を経て holder 側も同じ境界で追従すること。
39. **VFVO50 commit は gate family を expire しないこと**。`commitVfvo50Proof` に大きく進んだ `nowMs` を渡しても、既存の `volcanoAlert` gate entry と holder composite が expire・sweep されないこと（`expireRevisionFamily` / `coupleVolcanoGateAndHolder` が呼ばれないことを spy で確認）。`nowMs` が VFVO50 で変えるのは coverage 起点と分類時計だけである（§10.2.1）。
40. `targets` に空配列・重複・未知値を渡すと実行前に拒否されること。

### 14.4 dry-run 不変（`test/engine/volcano-initializer.test.ts` ＋ adapter）

41. dry-run で `commitVfvo50Proof` / `commitAshfallProof` が呼ばれないこと（spy）。
42. dry-run 前後で runtimeVersion・holder・gate・repair state の canonical JSON が一致すること。
43. dry-run で `schedule()` が 0 回であること。
44. **ingress を停止した隔離環境で、永続ディレクトリの snapshot 差分が `.manual-backup` の新規ファイルだけであること**。WS ingress を注入せず REST を stub した状態で、実行前後に directory listing ＋各ファイルの sha256 を取り、(a) 既存ファイルの sha256 が全件一致、(b) 削除・改名が 0 件、(c) 新規ファイルは `.manual-backup` 拡張子のみ、を検査する（§8.0 / §8.1）。
45. dry-run が historical 件数と journal 件数を返すこと。

### 14.5 manual backup（`test/engine/display/standby-persistence*.test.ts`）

46. v2/v1 両方存在 → 2 本の `.manual-backup` が作成され、内容が source と byte 一致すること。
47. v2 のみ存在 → 1 本作成し `backedUp` を返すこと。
48. v1 のみ存在 → 1 本作成し `backedUp` を返すこと。
49. 両方不存在 → `noMirrorPresent` で失敗すること。
50. 同一内容で 2 回呼ぶと 2 本目は `reused: true` で新規作成しないこと（sha256 dedup）。
51. 既存の `.salvage-backup` と同一 sha256 でも `.manual-backup` は新規作成されること（種別を跨いで dedup しない）。
52. write 失敗（`wx` が EEXIST 以外で throw）時に `writeFailed` を返し、この試行で作成した未完了ファイルを残さないこと。
53. read 失敗（EACCES 等）時に `readFailed` を返すこと。ENOENT は失敗にしないこと。
54. **`fs.openSync` が flag `"wx"` で呼ばれること**（spy で第 2 引数を検査）。既存ファイルを上書きする flag（`w` / `w+`）に退行していないことを固定する。
55. **`fs.fsyncSync(fd)` が `fs.closeSync(fd)` より前に呼ばれること**（spy の呼び出し順序を検査）。file fsync を省いた実装を通さない。
56. **directory fsync が呼ばれること**。`fs.openSync(directory, "r")` ＋ `fs.fsyncSync` が backup 完了時に実行されること。加えて (a) directory fsync が `EINVAL` / `ENOTSUP` / `EOPNOTSUPP` を throw する環境では **`backedUp` を返して成功扱いにする**こと、(b) それ以外の error（例 `EIO`）では `writeFailed` へ伝播すること（§7.3 の OS 非対応時の扱い）。
57. `backupRepairSources()` の既存挙動と診断カウンタ（`persistenceSalvageBackupBlocked` / `Recovered`）が不変であること（回帰）。

### 14.6 backup fail-closed（adapter）

58. `backupCurrentMirrors` が失敗したとき `backupFailed` を返し、`loadPage` / `loadBody` が **1 回も呼ばれない**こと。
59. backup 失敗時も journal と in-flight フラグが `finally` で解除されること（#19 と重複してよいが、backup 経路として独立に固定する）。

### 14.7 全体

60. `npm run test:shuffle` が緑であること。共有状態（shared journal・in-flight フラグ・クールダウン時計）を触るため必須とする。


## 15. 受入条件

すべて機械的に確認できる形で書く。

1. `npm run build` が成功する。
2. `npm test` が緑である。
3. `npm run test:shuffle` が緑である。
4. `npm run test:phase6b-production` の結果が本変更の前後で同一である（本変更で新たな赤を増やさない。既存赤 2 件は別件）。
5. §14 のテスト 60 件が存在し緑である。番号ごとに `it` が 1 つ以上対応する。
6. `grep -n "restoreVolcanoState" src/` が 0 件である（`08f3965` で削除済み。非目標 §1.2 の機械的確認）。
7. `grep -n "Repairable = true" src/` が 0 件である（`repairable` 書き戻しの禁止）。
8. `grep -n "backupLineActive\|isBackupActive" src/` が 0 件である（§11 の削除決定の機械的確認）。
9. `git diff` に `PersistedStandbyStateV2` / `VolcanoRepairStateV1` の型定義変更が含まれない。
10. `git diff` に `src/dmdata/multi-connection-manager.ts` の変更が含まれない（§11 決定により対象外）。
11. `git diff` に `crossSetConsistent` / `checkedCoverageStart` / `orderHistoricalBeforeDedupe` の本体変更が含まれない。`commitVfvo50Proof` / `commitAshfallProof` の本体変更も含まれない（`startupNowMs` → `nowMs` の引数名変更を除く。二段階化は `repairVolcanoState` 内の呼び出し順序だけで実現する — §5.5.2）。

### 15.1 Pi 実機（静穏状態で実施する）

以下は電文入電の無い静穏状態で実施する。入電中の結果は判定に使わない（§8.2）。

12. `volcanorepair rest --dry-run` が target・件数・backup 結果を表示して返る。
13. 上記実行の前後で、**`detail volcano` の出力が一致する**。`volcanorepair status` は operational-v2 provenance 欠損しか表示せず（`operation-handlers.ts:275-292`）、repair の効果を観測できないので判定に使わない。テスト環境では `coordinator.snapshot()` の canonical JSON 比較（§14.4 #42）を正とし、実機ではその代理として `detail volcano` を使う。
14. 上記実行の前後で、永続ディレクトリの差分が `.manual-backup` の新規ファイルのみである（既存ファイルの sha256 が全件一致）。
15. `volcanorepair rest --confirm test` の後、**存在する各 mirror について** 同一 sha256 の `.manual-backup` が存在する（新規作成でも既存再利用でもよい）。
16. 上記実行後、火山カード件数が実行前より減らない（VFVO50 非破壊の確認）。
17. 実行直後の再実行が `cooldown` を返す。
18. WS 未接続状態で実行すると `notConnected` を返し、その直後に接続を回復して実行すると `cooldown` にならず受理される（§12.3 の「REST 発行試行だけが時計を進める」の実機確認）。
19. 実行後のログに `[volcano-repair] manual rest repair` が 1 行だけ出る。

## 16. 決定事項（旧・保留事項）

すべて 2026-09-03 に決定済み。保留はゼロ。

| # | 項目 | 決定 | 反映先 |
|---|---|---|---|
| 1 | 副回線稼働時の扱い | **不要と判定（決定 2026-09-03、独立レビュー推奨をご主人が採用）**。ガード・`isBackupActive()`・停止/再開案・失敗理由 `backupLineActive` をすべて削除 | §11 / §5.1 / §5.7 / §13 |
| 2 | クールダウン | **60,000 ms。時計を進めるのは REST request を 1 本以上発行した試行だけ（決定 2026-09-03、独立レビュー推奨をご主人が採用）** | §12.3 |
| 3 | `startupNowMs` → `nowMs` 改名 | **改名する（決定 2026-09-03、独立レビュー推奨をご主人が採用）** | §10.1 |
| 4 | ashfall 警告文 | **本書 §4.2 の文言のまま。`--dry-run` でも出す（決定 2026-09-03、独立レビュー推奨をご主人が採用）** | §4.2 / §9.3 |
| 5 | 実装単位 | **2 分割（決定 2026-09-03、独立レビュー推奨をご主人が採用）**。委譲 1 = backup API と耐久性試験、委譲 2 = adapter・REPL・二段階 proof/commit | §13 |
| 6 | `all` の commit policy | **二段階化する（決定 2026-09-03、独立レビュー推奨をご主人が採用）**。手動入口専用。起動時の逐次挙動は不変 | §5.5 |
| 7 | `--confirm` の解析 | **option 終端とする（決定 2026-09-03、独立レビュー推奨をご主人が採用）**。以降の `--dry-run` は usage error | §4.1 |
| 8 | dry-run 不変条件の範囲 | **コマンド自身の変更に限定（決定 2026-09-03、独立レビュー推奨をご主人が採用）**。同時 ingress と実行前予約済み write は対象外 | §8.0 |


## 17. 調査ドキュメントとの差分（実コード確認で判明）

本書起草時に実コードを読んで、Vault `2026-09-03-fleq-vfvo54-carryover-investigation.md` §4 の記述と食い違った点。

1. **REST 呼び出し量は「未設計」ではない**。§4 未確認欄は「REST 呼び出し量（最大 128 ページ・body 256 件）。連打クールダウンは未設計」と書くが、1 repair あたりの上限は `VOLCANO_REPAIR_MAX_PAGES=128`（`volcano-initializer.ts:65`）・`VOLCANO_REPAIR_MAX_BODY_FETCHES=256`（`:69`）・`VOLCANO_REPAIR_MAX_ITEMS_PER_TYPE`（`:616`）として実装済みである。未設計なのは実行間隔だけ（§12）。
2. **`writeSalvageBackup` の `suffix` は種別ラベルではない**。`:2353` の `suffix` は `EEXIST` 衝突回避の連番であり、「suffix 引数化で共用する案」はそのままでは成立しない。共用するなら拡張子の引数化になる（§7.3）。加えて dedup 走査（`:2337-2346`）が拡張子で絞っているため、拡張子を引数化しないと種別を跨いだ誤 dedup が起きる。
3. **副回線の危険は存在しない（本書 v1.0 の誤りを v1.1 で訂正）**。§4 未確認欄は「副回線稼働中は `onPrimaryTransportData` が primary のみ journal に流す差」と書き、本書 v1.0 はそれを「実データ喪失」まで拡大解釈して実行ガード（`backupLineActive`）を要求した。**どちらも誤りである**。`multi-connection-manager.ts:204-206` の `EEW_CLASSIFICATIONS` filter により副回線は `eew.forecast` / `eew.warning` しか購読せず、火山電文を 1 件も受けない。したがって「journal に残らない火山電文」は発生せず、ガードは不要である（§11）。訂正の詳細は §18-1。
4. **`restoreVolcanoState` の行番号（起草時点）**。§4 と §1 は `volcano-initializer.ts:1409-1412` を挙げるが、起草時点で関数定義は `:1387`、`item.body` 分岐は `:1409-1412` であった（§1 の記述の方が正確）。呼び出し元なしは確認済み。**この legacy 関数自体は `08f3965` で削除済み**であり、上記行番号は削除前の履歴上の位置を指す（§1.2 参照）。
5. **`repl.ts` の async 対応行**。§4 は `repl.ts:180-197` とするが、Promise 判定と `.finally()` は `:177-190` である（1 画面差、実害なし）。
6. **`monitor.ts` の行番号**。§4 は journal 配線を `:832-975` とするが、shared 変数宣言は `:827`、`onPrimaryTransportData` は `:829-831`、journal 生成は `:944`、解除は `:957`、派生再計算は `:958-960` である。
7. **規模見積もり**。§4 は「src 約 200 行」と見積もるが、`nowMs` 改名（§10.1）と二段階 commit（§5.5）を含めると src 約 265 行になる。`isBackupActive` の追加は §11 の決定により不要になった。

## 18. 独立レビュー（2026-09-03）での訂正

v1.0 起草時の誤りと、レビュー指摘を実コードで裏取りした結果。

1. **副回線ガードは不要だった**（§11）。v1.0 §11 は「副回線が受けた火山電文が journal に入らない」を前提に fail-closed ガードを要求したが、副回線の購読区分は `EEW_CLASSIFICATIONS` で filter される（`multi-connection-manager.ts:204-206`）ため火山電文を受けない。前提が成立していなかった。加えて、仮にガードが要ったとしても public `isBackupRunning()` が既に `:192` に存在し、v1.0 §11.2 が提案した `isBackupActive()` の新規追加も不要だった（**二重の誤り**）。
2. **`all` の片側 commit を見落としていた**（§5.5）。`repairVolcanoState`（`:1313-1379`）は VFVO50 の prove→commit を先に完了させてから ashfall を prove する。v1.0 §5.3 の「ack が変われば両 target が失敗する」は**成り立たない**——VFVO50 は既に committed である。手動 `all` に二段階 commit policy を導入して訂正した。起動時の逐次挙動は救済価値があるため変えない。
3. **`--confirm` が option 終端でなかった**（§4.1）。v1.0 は「`--dry-run` と `--confirm` の順序は自由」としたが、その規則だと `rest --confirm 手順 --dry-run` の解釈が曖昧になり、dry-run のつもりの入力が本実行される。`--confirm` を終端に固定して訂正した。
4. **`nowMs` の効き方が target で非対称だった**（§10.2.1）。v1.0 §10.2 は VFVO50 と ashfall をまとめて「invocation now を使う」と書いたが、`commitVfvo50Proof`（`:1112-1213`）は `expireRevisionFamily` も `coupleVolcanoGateAndHolder` も呼ばない。`nowMs` が gate/holder の有効期限を動かすのは ashfall（`:1274-1280`）だけである。分けて記述した。
5. **dry-run 不変条件が広すぎた**（§8.0）。v1.0 の表は「実行前後で永続ファイルの sha256 が一致」を無条件に要求していたが、同時 ingress と実行前から予約済みの debounce write がそれを破りうる。不変条件を「コマンド自身が変更しない」に限定し、検査を ingress 停止の隔離環境へ移した。実機 sha256 比較は静穏状態限定の代理指標として残した。
6. **cooldown が REST を出していない試行でも進んでいた**（§12.3）。v1.0 は「成否を問わず終了時刻を記録」としたが、`notConnected` や `backupFailed` は REST を 1 本も出さない。それらが 60 秒の待機を課すのは、cooldown が守っている request 圧と無関係である。REST 発行試行だけが時計を進めるよう訂正し、判定順序を backup より前に固定した。
7. **Pi 受入 #10 が効果を観測できなかった**（§15.1 #13）。`volcanorepair status` は operational-v2 provenance 欠損しか表示しない（`operation-handlers.ts:275-292`）ので、repair 前後で出力が一致しても dry-run の無害性の証拠にならない。`detail volcano`（`command-definitions.ts:45, 53`）へ置き換えた。
8. **行番号の系統的なずれ**。v1.0 の `monitor.ts` 参照（`:827` / `:829-831` / `:944` / `:957` / `:913` / `:940-957` / `:977-979`）は実コードと 1〜14 行ずれていた（実際は `:825` / `:827-829` / `:930` / `:956` / `:909` / `:926-956` / `:978-979`）。`volcano-initializer.ts` にも数件のずれがあった（`:1206`→`:1207`、`:1324`→`:1326`、`:1256`→`:1257`、`:1258-1260`→`:1259-1261`、`:1155-1165`→`:1156-1166`）。本書 v1.1 で本文の参照をすべて実コードへ合わせた。**なお本書ヘッダの作業基準 HEAD `2734d08` と、検証に用いた checkout（`5f3aa4d`、`2734d08` の子孫）で当該 3 ファイルに差分は無い**（`git diff --stat 2734d08 HEAD -- <3 files>` が空）。ずれは base 差ではなく起草時の転記誤りである。
