# 火山 REST repair の REPL 手動実行コマンド仕様

- 日付: 2026-09-03
- 状態: 起草直後、独立レビュー前（実装は別セッション）
- 作業基準 HEAD: `2734d08`（`~/dev/fleq-layout`, branch `main`）
- 上位仕様: `docs/specs/2026-08-31-vfvo54-ashfall-slice.md`（以下「slice spec」）§16 REST repair と startup
- 設計の入力: Vault `Artifacts/2026-09-03-fleq-vfvo54-carryover-investigation.md` §4 および §9「§4 REPL rest」項
- 裁定済み: ashfall は force 対象に含めるが既定外＋警告／監査は log のみ／backup 失敗は fail-closed
- 裁定待ち: §11 の副回線同時稼働時の扱い（A: fail-closed 既定 / B: 副回線を一時停止）、§12 のクールダウン既定値

この文書は normative である。「必須」「禁止」「だけ」は実装・試験の受入条件を示す。slice spec §16 の不変条件はすべて継承し、本書はそれを緩めない。

## 1. 目的と非目標

### 1.1 目的

`repairState.vfvo50Repairable` / `ashfallRepairable` が false であっても、運用者が REPL から火山 REST repair を強制実行できるようにする。

2026-09-02 の Pi 事故（memory `project_vfvo54_hotfix`）では、永続ファイルが「正しく読めた古い世代」であったため `repairable` が立たず、起動時 repair が一度も走らなかった。`repairable` は `standby-persistence.ts` のロード時破損／移行検出だけが立てるフラグであり（`src/engine/display/standby-persistence.ts:7327-7328, 7440-7461, 10009-10062`）、「読めるが古い」状態を検出しない。復旧手段が「ファイルを壊して再起動する」しか無い現状を、手動 force で置き換える。

### 1.2 非目標

- **`restoreVolcanoState` の流用禁止**。`src/engine/startup/volcano-initializer.ts:1387` の legacy `restoreVolcanoState` は呼び出し元が存在せず、一覧 item の `item.body`（実 API に存在しないキー）に依存する死んだ経路である（`:1409-1412`）。本コマンドはこれを一切使わない。復活・再配線・部分流用のいずれも禁止する。
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
| shared journal | `monitor.ts:827` の `let volcanoRepairJournal: VolcanoRepairJournal \| null`。`onPrimaryTransportData`（`:829-831`）が記録先として参照する唯一の変数 |
| invocation now | 本コマンド 1 回の実行に対して一度だけ取得する `Date.now()`。coverage 起点と replay 分類時計に使う（§10） |
| manual backup | 実行直前に v1/v2 mirror を退避したファイル。拡張子 `.manual-backup` |

## 3. 現行実装との接続点（実コード確認済み）

### 3.1 実行本体

`repairVolcanoState(options)`（`volcano-initializer.ts:1313-1379`）。

- target は `:1322` で `volcanoRepairTargets(options.coordinator.snapshot().repair)` から導出する。**ここだけが `repairable` を読む**。
- commit 本体 `commitVfvo50Proof`（`:1112`）と `commitAshfallProof`（`:1215`）は `repairable` を読まない。読むのは書き込み側の `scratch.repair.vfvo50Repairable = false`（`:1206`）／`ashfallRepairable = false`（`:1284`）だけである。
- したがって force は「target を外から渡す」ことだけで成立し、フラグ操作を必要としない。

### 3.2 journal の所有と live ingress

- 生成は `monitor.ts:944` で ack 取得後、`targets.length > 0` のときだけ。
- 記録は `MultiConnectionManager` の `onPrimaryTransportData`（`monitor.ts:829-831`）。`multi-connection-manager.ts:254` は `transport != null` のときだけ発火し、transport が渡るのは primary の `onData`（`:82`）だけである。副回線の `onData`（`:222`）は transport を渡さない。
- 切断時 `onDisconnected` が `failAll("subscriptionDisconnected")`（`monitor.ts:851`）。
- 起動時 repair 完了後 `volcanoRepairJournal = null`（`monitor.ts:957`）。

### 3.3 REPL 側

- コマンド定義 `src/ui/repl-handlers/command-definitions.ts:308-320`（`volcanorepair`、サブコマンド `status` / `accept` / `clear` / `acknowledge-domain`）。
- ハンドラ `src/ui/repl-handlers/operation-handlers.ts:266-317`。同期関数。`ctx.volcanoRepairAdministration` が null なら「利用できません」。
- interface `VolcanoRepairAdministration`（`src/engine/messages/volcano-transaction-coordinator.ts:352-357`）は 2 メソッドのみ。
- `monitor.ts:913` は `volcanoTransactionCoordinator` を**そのまま** administration として `ReplHandler` に渡している。`VolcanoTransactionCoordinator` が構造的に interface を満たすためであり、composition root で別オブジェクトを渡すことに障害はない。
- `src/ui/repl.ts:177-190` は handler の戻り値が Promise なら await して `commandRunning` を解除する。**async handler は既にサポート済み**であり、REPL 側の非同期対応は不要である。

### 3.4 backup

- `StandbyPersistence.writeSalvageBackup(sourcePath, bytes)`（`standby-persistence.ts:2330-2382`）は private で、呼び出し元は `backupRepairSources()`（`:2288`）だけ。入力は `this.repairSources`（`:1059`）＝**ロード時に破損／oversized と判定された source の bytes** に限られる（`:1975, 2002, 2005, 2036`）。健全なファイルを任意タイミングで退避する公開 API は存在しない。
- 保存先名は `${base}.${timestamp}.${suffix}.salvage-backup`（`:2353`）。この `suffix` は **`EEXIST` 衝突回避の連番**であって種別ラベルではない。調査ドキュメント §4 の「`writeSalvageBackup` の suffix 引数化で共用する案」はこの点で成立しない（§7.3 に代案）。
- dedup 走査（`:2337-2346`）は `name.startsWith(base + ".") && name.endsWith(".salvage-backup")` で行う。
- mirror path は `persistPath`（v1）と `standbyPersistenceV2Path(persistPath)`（v2、`:440-443`）。`persistPath` は private field（`:1076`）。

### 3.5 破壊性の非対称

- **VFVO50 commit は非破壊**。`protectedSubjects`（`:1155-1165`）と `retainActiveSubjects`（`:1196-1200`）により、窓外の alert・VFVO50 以外の provenance を持つ alert は温存される。
- **ashfall commit は破壊的**。`for (composite) if (composite.ashfall != null) scratch.holder.clearAshfall(...)`（`:1256`）で全件消し、gate も `key.startsWith("volcano:volcanoAshfall:")` を全削除（`:1258-1260`）してから 7 日窓を replay する。窓外・REST 取得漏れの ashfall は**戻らない**。

## 4. コマンド仕様

### 4.1 構文

```
volcanorepair rest [vfvo50|ashfall|all] [--dry-run] [--confirm <reason...>]
```

- 第 1 引数（target）は省略可。既定は `vfvo50`。
- `all` は `["vfvo50", "ashfall"]` と等価。
- target token は小文字化して比較する。未知 token は使い方表示で終わる（実行しない）。
- `--dry-run` と `--confirm` の順序は自由。`--confirm` 以降の残り全 token を空白 1 個で join した文字列が reason になる。
- `--dry-run` 指定時は `--confirm` を要求しない。指定されていても無視せず reason として log に載せる。
- `--dry-run` 以外では `--confirm <reason>` が必須。reason が空文字なら使い方表示で終わる。検証規則は既存 `accept` / `clear` / `acknowledge-domain` と同一とする（`operation-handlers.ts:296-301` の「action・fingerprint・reason のいずれかが空なら使い方表示」と同じ形）。
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
 └─(A) 引数検証・実行前ガード ─fail→ idle（使い方表示 / busy / unavailable / notConnected / backupLineActive）
 └─ok→ journalInstalled
       └─(B) manual backup ─fail→ idle（backupFailed）
       └─ok→ backupDone
             └─(C) proveVolcanoTypeCoverage（await）─fail→ finalizing（failed(reason) / ackChanged）
             └─ok→ proving
                   └─(D) dry-run なら commit を行わず→ finalizing（proved）
                   └─(D') commitXProof（同期）→ committing
                         └─ok / rejected → finalizing
                               └─(E) 派生状態再計算・persistence 予約・journal 解除 → idle
```

### 5.1 (A) idle → journalInstalled

同期区間で次を順に行う。1 つでも満たさなければ journal を install せずに終わる。

1. `ctx.volcanoRepairAdministration?.restRepair` が未提供なら `unavailable`（「この構成では利用できません」）。
2. 引数検証（§4.1）。不正なら使い方表示。
3. `monitor` 側 adapter が `volcanoRepairJournal != null` または `volcanoRestRepairInFlight === true` を見たら `busy`。**この検査と `volcanoRestRepairInFlight = true` の代入は同一の同期区間で行う**（await を挟まない）。起動時 repair 進行中もこの検査で弾かれる。
4. `manager.getSubscriptionAcknowledgement()` が null なら `notConnected`。`waitForSubscriptionAcknowledgement()` を await してはならない（未接続時に無期限に待つため）。
5. 副回線ガード（§11）。
6. `new VolcanoRepairJournal(ack, targets)` を生成し、shared 変数 `volcanoRepairJournal` へ代入する。ここが **ack 世代の固定点**である。ctor が throw した場合（ack 不正）は `notConnected` として扱う。

以降、`onPrimaryTransportData` が到着電文をこの journal に記録する。

### 5.2 (B) journalInstalled → backupDone

`--dry-run` でも backup を行う。dry-run が「壊さない」ことの証明は §8 の不変条件で行うが、backup を省くと dry-run と本実行で経路が分岐しテスト対象が増えるため、経路は 1 本に保つ。

- backup が失敗したら `backupFailed` で中止する（裁定済み: fail-closed）。REST を 1 リクエストも発行しない。
- backup 中も journal は記録を続ける。backup が遅い／再試行で長引く場合、journal が 512 件／4MiB を超えると当該 target の proof が失敗する（slice spec §16.3）。これは安全側の縮退であり、上限を緩めない。

### 5.3 (C) backupDone → proving

`repairVolcanoState({ apiKey, nowMs, coordinator, journal, getAcknowledgement, targets, dryRun })` を await する。

- 各 target の proof は `proveVolcanoTypeCoverage` 内で `validateAcknowledgement()` を 4 箇所（`:665, 672, 685, 725`）通す。install 後に ack が変われば `subscriptionGenerationChanged` を throw し、`failAll` により両 target が失敗する。これが「install 後の ack 変更は fail-closed」の実装点である。
- REPL 表示では reason `subscriptionGenerationChanged` を `ackChanged` として表示する。
- target ごとに独立に失敗しうる（`:1342-1348, 1370-1376`）。ashfall は VFVO54・VFVO55 の両方が成功した場合だけ commit へ進む。

### 5.4 (D) dry-run: proving → finalizing

`dryRun === true` のとき `commitVfvo50Proof` / `commitAshfallProof` を**呼ばない**。target 結果は `{ kind: "proved", historicalCount, journalCount }` とする。

### 5.5 (D') proving → committing

`dryRun !== true` のとき既存の commit 関数をそのまま呼ぶ。commit 関数の中身は変更しない。`coordinator.transact` の version 検査（`volcano-transaction-coordinator.ts:191-197`）が rebase の最終防衛線である。

### 5.6 (E) finalizing → idle

`finally` 区間で必ず次を行う。

1. `volcanoRepairJournal = null`（**解除**）。
2. `volcanoRestRepairInFlight = false`。
3. `dryRun !== true` かつ少なくとも 1 target が `committed` のときだけ、起動時と同じ式で派生状態を再計算する（`monitor.ts:958-960`）。

```ts
volcanoRepairState = volcanoTransactionCoordinator.snapshot().repair;
volcanoFoundationAuthoritative = !volcanoRepairState.vfvo50Repairable
  && volcanoRepairState.unrecoverableAlertOmissions.length === 0;
scheduleLatestStandbyPersistence();
```

4. dry-run または全 target 失敗のときは上記 3 を行わない（§8）。

`finally` は例外経路（proof の throw、commit の throw、REPL の中断）でも必ず通る。`repl.ts:177-190` の `.catch().finally()` は handler の外側であり、journal 解除を REPL に依存させてはならない。解除は adapter 自身の `try/finally` で行う。

### 5.7 失敗理由の一覧

| reason | 契機 | runtime への影響 |
|---|---|---|
| `unavailable` | administration 未提供／`restRepair` 未実装 | なし |
| `busy` | shared journal が非 null、または in-flight フラグ | なし |
| `notConnected` | ack が null、または ack が journal ctor の検査に落ちる | なし |
| `backupLineActive` | 副回線稼働中（§11 案 A） | なし |
| `backupFailed` | manual backup が §7 の成功条件を満たさない | なし（REST 未発行） |
| `ackChanged` | install 後に subscription generation / transportId / socketId が変化 | なし（fail-closed） |
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
    volcanoRestRepairInFlight = true;            // ここまで同期
    try {
      const ack = manager?.getSubscriptionAcknowledgement() ?? null;
      if (ack == null) return { kind: "notConnected" };
      // 副回線ガード（§11）
      volcanoRepairJournal = new VolcanoRepairJournal(ack, request.targets);
      // manual backup（§7）→ repairVolcanoState（§5.3）
    } finally {
      volcanoRepairJournal = null;
      volcanoRestRepairInFlight = false;
    }
  },
};
```

- shared 変数 `volcanoRepairJournal` の宣言（`monitor.ts:827`）と `onPrimaryTransportData`（`:829-831`）は変更しない。
- adapter は `monitor.ts` の外へ出さない。`volcano-initializer.ts` や `operation-handlers.ts` が shared 変数へ直接触れることを禁止する。
- REPL へ渡すのは `VolcanoRepairAdministration` を満たしつつ `restRepair` を持つ合成オブジェクトである。`monitor.ts:913` の `volcanoTransactionCoordinator` 直渡しを、`{ status: ..., resolveOperationalV2AlertOmission: ..., restRepair: ... }` へ置き換える。coordinator の 2 メソッドは bind して委譲する。

### 6.2 起動時 repair との排他

起動時経路（`monitor.ts:940-957`）は次の順で走る。

1. `manager.connect()` を await。
2. targets があれば ack を await し journal を生成（`:944`）。
3. `restoreTsunamiState` を await。
4. `repairVolcanoState` を await（`:948`）。
5. `volcanoRepairJournal = null`（`:957`）。

REPL は `replHandler.start()`（`monitor.ts:922`）の後に入力を受け付けるため、手順 2〜5 の間にコマンドが到達しうる。そのとき shared 変数は非 null なので §5.1 手順 3 が `busy` を返す。手順 1〜2 の間（journal が null で ack もまだ）は `notConnected` を返す。いずれも安全側である。

起動時経路が `catch` に落ちた場合（`monitor.ts:977-979`）も `volcanoRepairJournal = null` が実行されるため、以後の REPL 実行は妨げられない。

### 6.3 install 後の ack 変更

- `VolcanoRepairJournal.validateAcknowledgement()`（`:241-248`）が `subscriptionGeneration` / `transportId` / `socketId` の 3 値一致を見る。不一致で `failAll` する。
- 切断は `onDisconnected` の `failAll("subscriptionDisconnected")` が先に立つ。
- 再接続で ack 世代が上がった場合も 3 値検査で落ちる。**再 install して続行してはならない**。ack をまたいだ journal は「REST await 中の live mutation を全て見た」ことを証明できない。

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
- 書き込み手順は現行と同一とする: `wx` で作成、部分書き込みループ、`fs.fsyncSync(fd)`、`close`、`fsyncBackupDirectory(directory)`。この 4 点を欠いた実装を認めない。
- 既存の同一 sha256 backup を再利用した場合は `reused: true` を返し、`path` に既存ファイルを載せる。
- `writeSalvageBackup` の既存呼び出し元 `backupRepairSources()` の挙動・診断カウンタ（`persistenceSalvageBackupBlocked` / `Recovered`）は変更しない。manual backup はこれらのカウンタを増減させない。

### 7.4 backup と REST の順序

manual backup は §5 の状態機械のとおり **journal install の後・最初の REST リクエストの前**に完了していなければならない。backup 失敗時に REST を 1 リクエストも出さないことが受入条件である。

## 8. dry-run 不変条件

`--dry-run` 実行は次のすべてを変更しない。テストは実行前後の値を比較して検査する。

| 対象 | 検査方法 |
|---|---|
| runtimeVersion | `coordinator.snapshot().runtimeVersion` が実行前後で一致（`volcano-transaction-coordinator.ts:149-153`） |
| holder | `coordinator.snapshot().holder` の canonical JSON が一致（composites・sourceEventIds を含む） |
| gate | `snapshot().gate.exportDurableEntries()` の canonical JSON が一致 |
| repair state | `snapshot().repair` の canonical JSON が一致。特に `vfvo50Repairable` / `ashfallRepairable` / `unrecoverableAlertOmissions` |
| 予約 persistence | `scheduleLatestStandbyPersistence()` が **0 回**呼ばれる。`StandbyPersistence.schedule()` の spy 呼び出し回数で検査する |
| 派生フラグ | `volcanoFoundationAuthoritative` が変化しない |
| 永続ファイル | v1/v2 mirror の mtime と sha256 が一致（manual backup ファイルの新規作成は許可する） |

dry-run が唯一許す副作用は次の 3 つだけである。

1. manual backup ファイルの作成（§7）。
2. REST GET リクエストの発行（読み取りのみ）。
3. log 出力。

`journal` オブジェクトの内部状態（記録された live 電文）は実行終了時に破棄されるため、runtime の不変には数えない。

## 9. force の破壊性

### 9.1 VFVO50: 非破壊

`commitVfvo50Proof`（`:1112-1213`）は次を温存する。

- `protectedSubjects`（`:1155-1165`）: gate 上の非 VFVO50 provenance を持つ subject と、holder 上で `alert.sourceFamily !== "VFVO50"` の composite。ループ内 `if (protectedSubjects.has(subject)) continue`（`:1180`）で replay 対象から外す。
- `retainActiveSubjects`（`:1196-1200`）: gate の active な alert / eruption / ashfall subject を holder に残す。
- `mergeBaselineSourceIds`（`:1201`）: 既存 `sourceEventIds` を退避してから merge。
- `unrecoverableAlertOmissions` の変化は `vfvo50OmissionMutation` で reject（`:1203-1205`）。

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
- `expireRevisionFamily(..., nowMs, VOLCANO_ASHFALL_RETENTION_MS)`（`:1276-1281`）が invocation now を基準に gate を expire する（§10）。

### 9.3 警告文

§4.2 の警告文を normative とする。文言を変える場合も「全削除してから replay する」「窓外は復元されない」の 2 点を落とさない。`--dry-run` でも表示する（dry-run で確認してから本実行する運用を前提にするため）。

## 10. 時計: invocation now

### 10.1 パラメータ

`repairVolcanoState` の `startupNowMs` を `nowMs` へ改名する。起動時経路は `startupNowMs`（`monitor.ts` で一度取得する値）をそのまま渡し、REPL 経路は `Date.now()` を **コマンド 1 回につき一度だけ**取得して渡す。改名対象は `volcano-initializer.ts` の該当 field と `commitVfvo50Proof` / `commitAshfallProof` / `proveVolcanoTypeCoverage` の引数名、および test の参照である（`grep -c startupNowMs` = 56、うち `standby-persistence.ts` 系は別文脈なので対象外）。

改名を行う理由: 同じ field に「起動時刻」と「コマンド実行時刻」の 2 意味を持たせると、§10.2 の挙動差が名前から見えなくなる。CLAUDE.md「型で守る」の趣旨に沿って名前を実態へ合わせる。

### 10.2 coverage 起点と tombstone 期限への影響

`coverageStartMs = nowMs - familyRetentionMs`（`checkedCoverageStart`、slice spec §16.4）。

- 起動から `d` 経過後に force すると、coverage 窓は `d` だけ前へ動く。ashfall なら `[now-7d, now]`、VFVO50 なら `[now - VOLCANO_ALERT_TOMBSTONE_RETENTION_MS, now]`。
- **これは意図した挙動である**。retention の定義が「現在からの保持期間」だからであり、起動時刻に固定すると稼働時間が延びるほど窓が過去へ取り残される。
- 影響: ashfall force を起動から 7 日以上経ってから実行すると、起動時に replay された最古の item が窓外になる。§9.2 の全削除と組み合わさるため、**古い降灰は消える**。§4.2 の警告文はこの帰結も含意する。
- `repairReplayTimesValid(item.normalizedInput, expiryNowMs)`（`:1170-1173, 1265-1268`）は journal 収録 item には item 自身の `receivedAtMs`、historical item には `nowMs` を渡す。invocation now が進むと historical item の分類時計が進み、期限切れ判定が現実に即す。
- `expireRevisionFamily(..., nowMs, ...)`（`:1276-1281`）と `coupleVolcanoGateAndHolder(scratch, nowMs)`（`:1282`）も同様に invocation now を使う。gate と holder の結合検査は同一時計で行われるため、slice spec §14.3 の coupling 不変は保たれる。

### 10.3 実測が要る点

起動完了後に `repairVolcanoState` を走らせた実績はゼロである。実装後、Pi で次を実測して spec へ追記する。

1. `--dry-run` の historical 件数が起動時ログの件数と整合するか（窓移動分の差を除いて）。
2. VFVO50 force 後に火山件数（Pi 実測 8 件）が減らないこと。
3. ashfall force 後に、force 前に表示されていた降灰カードが復元されること。

## 11. 副回線稼働時の扱い（裁定待ち）

### 11.1 危険

`config.backup` が有効なとき、副回線 `WebSocketManager` の `onData`（`multi-connection-manager.ts:222`）は transport を渡さないため `onPrimaryTransportData` が発火せず、**journal に記録されない**。しかし `handleData` は dedupe を通れば `routeMessage` へ流すので runtime state は変化する。

したがって「primary が取り逃がし副回線だけが受けた VFVO54」は、runtime に反映されているのに journal から見えない。ashfall commit は §9.2 で全削除してから journal + REST だけを replay するため、**その電文は消える**。

起動時経路ではこの危険が構造的に無い。副回線の起動は repair 完了後（`monitor.ts:971-978`）だからである。REPL force は起動後に走るので、この保護が失われる。

### 11.2 案 A（既定・推奨）

副回線が稼働中なら `backupLineActive` で fail-closed とする。`MultiConnectionManager` に public `isBackupActive(): boolean` を追加して判定する（現状 `this.backup` は private、`:220`）。

- 利点: 実装が小さく、危険が構造的に排除される。
- 欠点: 副回線を常用する構成では本コマンドが使えない。

### 11.3 案 B

コマンドが副回線を停止（`stopBackup()`）→ repair → `finally` で再開（`startBackup()`）する。

- 利点: 副回線構成でも force できる。
- 欠点: repair 中（数秒〜数十秒）EEW 冗長性が失われる。再開失敗時の扱いが増える。`stopBackup` 前に副回線が受信済みで primary 未着の電文は依然 journal に無い（停止しても遡れない）ため、危険を**完全には**消せない。

### 11.4 判断

**推奨は A**。B は危険を完全には消せないうえ冗長性を犠牲にする。A で不足が実測されてから B を別裁定とする。この節はご主人裁定が付くまで実装に進めない。

## 12. REST 呼び出し量とクールダウン

### 12.1 既存の上限（実コード確認済み）

| 上限 | 値 | 位置 |
|---|---:|---|
| `VOLCANO_REPAIR_MAX_PAGES` | 128 | `volcano-initializer.ts:65, 589, 638` |
| `VOLCANO_REPAIR_PAGE_LIMIT` | 100 | `:593`（slice spec §16.4） |
| `VOLCANO_REPAIR_MAX_ITEMS_PER_TYPE` | 12,800 | `:66, 616` |
| `VOLCANO_REPAIR_MAX_BODY_FETCHES` | 256 / repair | `:69, 709` |
| body cache | repair 1 回にスコープ | `:1324`（`bodyCache` は `repairVolcanoState` のローカル） |

調査ドキュメント §4 の「REST 呼び出し量…連打クールダウンは未設計」は、**1 回あたりの上限については未設計ではない**。未設計なのは「連打」＝複数回実行の間隔だけである。

最悪ケース: `all` 指定で 3 head type × 128 page = 384 list request ＋ body 256 request = 640 request。実運用（Pi 実測: 火山 8 件、7 日窓）では list 各 1〜2 page・body 数件に収まる。

### 12.2 クールダウンの要否

**必要と判断する**。理由は 2 つ。

1. `busy` ガードは同時実行しか防がない。連続実行（1 本目完了 → 即 2 本目）は素通りする。
2. body 取得の cache は repair 1 回スコープなので、2 回目は同じ id を再取得する。slice spec §16.4.1 の「同じ id へ短期間に繰り返しリクエストしない」に反する。

### 12.3 規則

- 直前の `rest` 実行（dry-run を含む、成否を問わない）の**終了時刻**から `VOLCANO_REST_REPAIR_COOLDOWN_MS` 未満の再実行は `busy` の亜種 `cooldown` で拒否し、残り秒数を表示する。
- 既定値は **60,000 ms**（裁定待ち）。process 内のメモリ変数だけで管理し、永続化しない。再起動でリセットされてよい。
- クールダウンは REPL adapter のスコープに置く（`monitor.ts` の composition root）。`repairVolcanoState` 自体には持たせない。
- 起動時 repair はクールダウンの対象外であり、クールダウン時計を開始もしない。

## 13. 対象ファイルと規模

| ファイル | 変更内容 | 概算 |
|---|---:|---:|
| `src/engine/startup/volcano-initializer.ts` | `repairVolcanoState` に `targets?` / `dryRun?` 追加、`startupNowMs` → `nowMs` 改名、結果に `proved` と件数 | +30 / 改名 |
| `src/engine/messages/volcano-transaction-coordinator.ts` | `VolcanoRepairAdministration` に optional `restRepair?` と request/result 型を追加 | +25 |
| `src/engine/monitor/monitor.ts` | adapter 実装（ガード・ack・backup・journal install/uninstall・派生再計算・クールダウン）、`ReplHandler` へ合成オブジェクトを渡す | +80 |
| `src/engine/display/standby-persistence.ts` | `backupCurrentMirrors()` 追加、`writeBackupFile()` へ抽出 | +45 |
| `src/dmdata/multi-connection-manager.ts` | `isBackupActive()` 追加（§11 案 A） | +4 |
| `src/ui/repl-handlers/operation-handlers.ts` | `rest` サブコマンドの解析・警告・await・表示 | +60 |
| `src/ui/repl-handlers/command-definitions.ts` | `rest` サブコマンド定義、handler を async 対応（戻り値を返す） | +8 |
| `src/ui/repl-handlers/types.ts` | 型追従（既存 optional field のまま） | +2 |
| `docs/specs/2026-08-31-vfvo54-ashfall-slice.md` | §16 に「手動 force の入口」を 1 段落追記、§18 対象ファイルへの追記 | +15 |
| test（4〜5 ファイル） | §14 | +300〜350 |

src 約 250 行、テスト込み 550〜600 行。**委譲 1 本**に収まるが、`monitor.ts` の adapter と `standby-persistence.ts` の backup API は独立に検証できるので、実装単位を 2 つに割ってよい。

## 14. 必須テスト

### 14.1 引数解析と入口ガード（`test/ui/command-definitions.test.ts` / `test/ui/repl.test.ts`）

1. `rest` 省略時の既定 target が `["vfvo50"]` である。
2. `rest ashfall` / `rest all` が target を正しく解決し、ashfall を含むとき警告文を出力する。
3. `rest` に未知 token（例 `vfvo51`）を渡すと使い方表示のみで `restRepair` を呼ばない。
4. `--confirm` 無しの非 dry-run が使い方表示のみで `restRepair` を呼ばない。
5. `--confirm` の reason が空白のみのとき使い方表示のみで `restRepair` を呼ばない。
6. `--dry-run` は `--confirm` 無しで `restRepair` を呼ぶ。
7. `ctx.volcanoRepairAdministration` が null、または `restRepair` 未提供のとき「利用できません」を出し例外を出さない。
8. handler が Promise を返し、`repl.ts` が await して `commandRunning` を解除する（既存 async 経路の回帰）。
9. 既存 `status` / `accept` / `clear` / `acknowledge-domain` の挙動が変わらない（回帰）。

### 14.2 状態機械の遷移（`test/engine/monitor/` または adapter 単体テスト）

10. shared journal が非 null のとき `busy` を返し、journal を差し替えない。
11. in-flight フラグが立っているとき（1 本目が await 中）2 本目が `busy` を返す。
12. ack が null のとき `notConnected` を返し、`waitForSubscriptionAcknowledgement` を呼ばない。
13. 成功経路で journal が install され、`onPrimaryTransportData` 相当の呼び出しが記録されること。
14. `finally` で journal が null に戻ること（成功・proof 失敗・commit reject・throw の 4 経路）。
15. install 後に ack の `subscriptionGeneration` が変わると `ackChanged` で全 target 失敗し、runtime が不変であること。
16. commit 成功後に `volcanoRepairState` / `volcanoFoundationAuthoritative` が起動時と同じ式で再計算され、`schedule()` が 1 回だけ呼ばれること。
17. 全 target 失敗時に `schedule()` が 0 回であること。
18. クールダウン中の再実行が `cooldown` を返し、REST を発行しないこと（§12）。
19. 副回線稼働中は `backupLineActive` を返し、journal を install しないこと（§11 案 A 採用時）。

### 14.3 force の経路（`test/engine/volcano-initializer.test.ts`）

20. `repairable` が両方 false でも `targets: ["vfvo50"]` を渡せば VFVO50 proof が走り commit されること。
21. `targets: ["ashfall"]` で VFVO54・VFVO55 の両 proof が走り、片方失敗なら commit しないこと。
22. `targets: ["vfvo50","ashfall"]` で target が独立に成功／失敗すること。
23. force commit 後も `unrecoverableAlertOmissions` が byte-for-byte 不変であること（`vfvo50OmissionMutation` の回帰）。
24. VFVO50 force が非破壊であること: 窓外 alert・非 VFVO50 provenance の alert・既存 `sourceEventIds` が保持される。
25. ashfall force が破壊的であること: force 前に存在した窓外 ashfall が消え、窓内が replay される（§9.2 の明文化を試験で固定する）。
26. `nowMs` を起動時刻ではなく実行時刻で渡したとき、coverage 窓が移動して古い item が除外されること。
27. `targets` に空配列・重複・未知値を渡すと実行前に拒否されること。

### 14.4 dry-run 不変（`test/engine/volcano-initializer.test.ts` ＋ adapter）

28. dry-run で `commitVfvo50Proof` / `commitAshfallProof` が呼ばれないこと（spy）。
29. dry-run 前後で runtimeVersion・holder・gate・repair state の canonical JSON が一致すること。
30. dry-run で `schedule()` が 0 回であること。
31. dry-run で永続ファイル 2 本の sha256 が不変であること（manual backup の新規作成は許可）。
32. dry-run が historical 件数と journal 件数を返すこと。

### 14.5 manual backup（`test/engine/display/standby-persistence*.test.ts`）

33. v2/v1 両方存在 → 2 本の `.manual-backup` が作成され、内容が source と byte 一致すること。
34. v2 のみ存在 → 1 本作成し `backedUp` を返すこと。
35. v1 のみ存在 → 1 本作成し `backedUp` を返すこと。
36. 両方不存在 → `noMirrorPresent` で失敗すること。
37. 同一内容で 2 回呼ぶと 2 本目は `reused: true` で新規作成しないこと（sha256 dedup）。
38. 既存の `.salvage-backup` と同一 sha256 でも `.manual-backup` は新規作成されること（種別を跨いで dedup しない）。
39. write 失敗（`wx` が EEXIST 以外で throw）時に `writeFailed` を返し、この試行で作成した未完了ファイルを残さないこと。
40. read 失敗（EACCES 等）時に `readFailed` を返すこと。ENOENT は失敗にしないこと。
41. `backupRepairSources()` の既存挙動と診断カウンタが不変であること（回帰）。

### 14.6 backup fail-closed（adapter）

42. `backupCurrentMirrors` が失敗したとき `backupFailed` を返し、`loadPage` / `loadBody` が **1 回も呼ばれない**こと。
43. backup 失敗時も journal が `finally` で解除されること。

### 14.7 全体

44. `npm run test:shuffle` が緑であること。共有状態（shared journal・in-flight フラグ・クールダウン時計）を触るため必須とする。

## 15. 受入条件

すべて機械的に確認できる形で書く。

1. `npm run build` が成功する。
2. `npm test` が緑である。
3. `npm run test:shuffle` が緑である。
4. `npm run test:phase6b-production` の結果が本変更の前後で同一である（本変更で新たな赤を増やさない。既存赤 2 件は別件）。
5. §14 のテスト 44 件が存在し緑である。番号ごとに `it` が 1 つ以上対応する。
6. `grep -n "restoreVolcanoState" src/engine/monitor/ src/ui/` が 0 件である（非目標 §1.2 の機械的確認）。
7. `grep -n "Repairable = true" src/` が 0 件である（`repairable` 書き戻しの禁止）。
8. `git diff` に `PersistedStandbyStateV2` / `VolcanoRepairStateV1` の型定義変更が含まれない。
9. `git diff` に `crossSetConsistent` / `checkedCoverageStart` / `orderHistoricalBeforeDedupe` / `commitVfvo50Proof` の本体変更が含まれない（`startupNowMs` → `nowMs` の引数名変更を除く）。
10. Pi 実機: `volcanorepair rest --dry-run` が target・件数・backup 結果を表示して返り、実行前後で `volcanorepair status` の出力と永続ファイル 2 本の sha256 が一致する。
11. Pi 実機: `volcanorepair rest --confirm test` の後、**存在する各 mirror について** 同一 sha256 の `.manual-backup` が存在する（新規作成でも既存再利用でもよい）。
12. Pi 実機: 上記実行後、火山カード件数が実行前より減らない（VFVO50 非破壊の確認）。
13. Pi 実機: 実行直後の再実行が `cooldown` を返す。
14. Pi 実機: 実行後のログに `[volcano-repair] manual rest repair` が 1 行だけ出る。

## 16. 保留事項

| # | 内容 | 既定 | 決めるべき人 |
|---|---|---|---|
| 1 | 副回線稼働時の扱い（§11） | A: `backupLineActive` で fail-closed | ご主人 |
| 2 | クールダウン既定値（§12.3） | 60,000 ms | ご主人 |
| 3 | `startupNowMs` → `nowMs` 改名の可否（§10.1） | 改名する | 独立レビュー |
| 4 | ashfall 警告文の文言（§4.2） | 本書の文言 | ご主人 |
| 5 | 実装単位を 1 委譲にするか 2 分割するか（§13） | 2 分割（backup API / adapter+REPL） | Liebe |

## 17. 調査ドキュメントとの差分（実コード確認で判明）

本書起草時に実コードを読んで、Vault `2026-09-03-fleq-vfvo54-carryover-investigation.md` §4 の記述と食い違った点。

1. **REST 呼び出し量は「未設計」ではない**。§4 未確認欄は「REST 呼び出し量（最大 128 ページ・body 256 件）。連打クールダウンは未設計」と書くが、1 repair あたりの上限は `VOLCANO_REPAIR_MAX_PAGES=128`（`volcano-initializer.ts:65`）・`VOLCANO_REPAIR_MAX_BODY_FETCHES=256`（`:69`）・`VOLCANO_REPAIR_MAX_ITEMS_PER_TYPE`（`:616`）として実装済みである。未設計なのは実行間隔だけ（§12）。
2. **`writeSalvageBackup` の `suffix` は種別ラベルではない**。`:2353` の `suffix` は `EEXIST` 衝突回避の連番であり、「suffix 引数化で共用する案」はそのままでは成立しない。共用するなら拡張子の引数化になる（§7.3）。加えて dedup 走査（`:2337-2346`）が拡張子で絞っているため、拡張子を引数化しないと種別を跨いだ誤 dedup が起きる。
3. **副回線の危険は「`onPrimaryTransportData` の差」より重い**。§4 未確認欄は「副回線稼働中は `onPrimaryTransportData` が primary のみ journal に流す差」と書くが、`multi-connection-manager.ts:222, 254` を読むと副回線経由の電文は runtime には反映され journal には残らない。ashfall force の全削除（`:1256-1260`）と組み合わさると**実データ喪失**になる。単なる「差」ではなく実行ガードが要る（§11）。
4. **`restoreVolcanoState` の行番号**。§4 と §1 は `volcano-initializer.ts:1409-1412` を挙げるが、関数定義は `:1387`、`item.body` 分岐は `:1409-1412` である（§1 の記述の方が正確）。呼び出し元なしは確認した。
5. **`repl.ts` の async 対応行**。§4 は `repl.ts:180-197` とするが、Promise 判定と `.finally()` は `:177-190` である（1 画面差、実害なし）。
6. **`monitor.ts` の行番号**。§4 は journal 配線を `:832-975` とするが、shared 変数宣言は `:827`、`onPrimaryTransportData` は `:829-831`、journal 生成は `:944`、解除は `:957`、派生再計算は `:958-960` である。
7. **規模見積もり**。§4 は「src 約 200 行」と見積もるが、`isBackupActive` の追加（§11）と `nowMs` 改名（§10.1）を含めると src 約 250 行になる。
