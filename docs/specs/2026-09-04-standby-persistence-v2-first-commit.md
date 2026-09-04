# standby persistence v2 canonical の先行 commit

- 日付: 2026-09-04
- 状態: 実装前仕様
- 作業基準 HEAD: `5c042c39323155e09a5110e71f2874ba04e70493`
- 優先度: P0

この文書は normative である。「必須」「禁止」「だけ」は実装・試験の受入条件を示す。

## 1. 背景

standby persistence は v2 を canonical snapshot、v1 を旧 binary 向け rollback mirror として保存する。
v2 だけが `telegramFoundation` を持つ一方、v1 projection は foundation を除外する
（`src/engine/display/standby-persistence.ts:1946-2013`）。従って v1 が新しい世代として先に公開され、
続く v2 rename が失敗すると、情報量の少ない v1 が旧 v2 canonical より優先される経路が生じる。

Pi の 2026-09-04 観測では両 mirror は logical generation 962 で一致しており、既発ではない。
ただし rename failure と rename 間の強制終了は通常の耐障害境界であり、writer protocol と loader の
source authority を発生前に一致させる。

## 2. 根因

- 両 source が usable かつ generated のとき、loader は logical generation が大きい source を無条件に選ぶ
  （`src/engine/display/standby-persistence.ts:1196-1239`）。従って v1=N / v2=N-1 では v1 が選ばれる。
- 同期 writer は v1 を rename してから v2 を rename し、後者の失敗を
  `partialCommit: "v1Only"` として返す（`standby-persistence.ts:2153-2188`）。
- 非同期 writer も同順序で、v1 rename 後に `partialCommit = "v1Only"` を設定する
  （`standby-persistence.ts:2280-2324`）。
- v1 migration は foundation を完全には再構築できず、VPWW56、tsunami、flood foundation を空で作る
  （`standby-persistence.ts:10689-10797`）。startup REST が一部を補えても、VTSE51/52 observations、
  VPWW56、旧 v2 にだけある tsunami `keyedActive` / flood data の復元は保証されない。

これは generation 比較の一般的な欠陥ではなく、v1 が rollback mirror であるのに、旧 writer の
partial commit を loader が canonical 更新として扱う protocol 不整合である。

## 3. 改修

### 3.1 writer は v2 → v1 の順で公開する

同期 `writeSyncResult()` と非同期 `writePending()` は、両 tmp file の write、file fsync、seq guard を
終えた後、必ず次の無 await 区間で公開する。

```ts
rename(v2TmpPath, v2Path);       // canonical を先に公開
partialCommit = "v2Only";
rename(v1TmpPath, persistPath);  // rollback mirror を後に公開
partialCommit = "unknown";
fsyncDirectory();
```

- 第一 rename (`renameV2`) の失敗は両 file 未更新なので `partialCommit: "none"` とする。
- 第二 rename (`renameV1`) の失敗は canonical だけ更新済みなので `partialCommit: "v2Only"` とする。
- directory fsync の失敗は両 rename が可視で durability だけ不確定なため `"unknown"` を維持する。
- 失敗時は同期・非同期とも同じ pending pair を保持し、二つの tmp path を best-effort cleanup する。
- 非同期経路は seq guard と二つの rename の間に await を入れない。現在の上書き防止条件
  （`standby-persistence.ts:2294-2305`）を順序反転後も維持する。

### 3.2 generated pair では v2 を canonical とする

両 read result が usable で、両方に valid `logicalGeneration` がある generated pair は、generation の
大小にかかわらず v2 を選ぶ。

| pair | selected source | `canonicalRewriteRequired` | diagnostic |
|---|---|---:|---|
| v2=N / v1=N、semantic equal | v2 | false | なし |
| v2=N / v1=N-1 | v2 | true | なし（新 writer の v2-only partial commit） |
| v2=N-1 / v1=N | v2 | true | migration conflict を一回 |
| v2=N / v1=N、semantic mismatch | v2 | true | 既存 `sameGenerationConflict` を一回 |

v1 > v2 は旧 writer による「rollback mirror 先行の partial commit」であり、v1 の大きい generation を
state authority にしない。この分岐では次を必須とする。

```ts
recordMigrationConflict("rollbackMirrorAheadOfCanonicalV2");
```

一回の load について `takeMigrationConflictCount() === 1` とし、warn detail も
`[standby-persistence] persistenceMigrationConflict: rollbackMirrorAheadOfCanonicalV2` に固定する。
同じ pair を generation mismatch と semantic mismatch の二件には数えない。選択した v2 を返し、
`canonicalRewriteRequired = true` とする。monitor は既存どおりこの flag を startup save の予約根拠にする
（`src/engine/monitor/monitor.ts:603-614`）。

v1=N / v2=N-1 の load 後も generation allocator の基準を選択 source の N-1 へ戻してはならない。現実装は
両入力の valid generation の最大値を `lastReservedLogicalGeneration` に保持し
（`src/engine/display/standby-persistence.ts:1341-1343`）、次の予約で一つ増やす（同 `:1416-1422`）。従って
canonical rewrite の次 generation は常に **両入力の max + 1**、この場合は exact N+1 とする。

### 3.3 markerless 旧 v1 互換を分離して残す

generated-pair 分岐を markerless compatibility と混ぜない。

- v1 と v2 の双方に `logicalGeneration` がある場合だけ §3.2 を適用する。
- 一方又は双方が markerless の既存 branch は残し、現在の savedAt 比較と v2 tie-break をその branch
  だけに適用する。
- `logicalGeneration` が present だが不正な source は markerless と再解釈せず、現在どおり invalid とする。
- valid v2 単独、valid v1 単独、salvage backup、fatal I/O の fallback 契約は変更しない。

### 3.4 旧 binary への rollback 互換

v2 を先に公開した短い区間では、旧 binary は v1=N-1 を読み、新 binary は v2=N を読む。旧 binary が
canonical v2 を理解しない以上、この非原子的 downgrade window は避けられず、直ちに rollback すると
最後の一世代の v1 表現まで戻る可能性がある。

それでも v1-first より安全である。v1-first は new binary 自身が v1=N を canonical と誤認して foundation
を失うが、v2-first は new binary の正本を守り、古い snapshot を読むのは明示的 downgrade 時だけである。
運用上、`v2Only` を検知した new binary は pending retry 又は次 save を完了してから旧 binary へ戻す。
v1 schema と旧 binary が読める完全な v1 snapshot の生成は変更しない。

### 3.5 対象ファイル

- `src/engine/display/standby-persistence.ts`
- `test/engine/display/standby-persistence.test.ts`
- startup rewrite を固定する必要がある場合だけ `test/engine/monitor/` 配下の persistence test

## 4. 受入条件（機械検証）

### 4.1 rename 順序と四つの失敗点

generation N-1、内容 `old` の正常 pair を事前配置し、generation N、内容 `new` の同じ pending pair を
書く fixture を同期・非同期で共有する。`fs.renameSync` は call ordinal ではなく destination path で失敗を
注入し、次の四ケースを独立 test にする。

| 経路 | 注入点 | failure contract | 失敗直後の disk |
|---|---|---|---|
| sync | 第一 `renameV2` | save result が `stage:"renameV2"`, `partialCommit:"none"`, `pendingRetained:true` | v2 / v1 とも N-1 `old` |
| sync | 第二 `renameV1` | save result が `stage:"renameV1"`, `partialCommit:"v2Only"`, `pendingRetained:true` | v2=N `new`、v1=N-1 `old` |
| async | 第一 `renameV2` | `lastFailure()` が同 stage、`partialCommit:"none"`, `pendingRetained:true` | v2 / v1 とも N-1 `old` |
| async | 第二 `renameV1` | `lastFailure()` が同 stage、`partialCommit:"v2Only"`, `pendingRetained:true` | v2=N `new`、v1=N-1 `old` |

全ケースで次も assertion する。

- rename spy の全 call から、成功試行の公開順が同期・非同期とも常に v2 → v1 である。
- 失敗直後に v2 / v1 用 tmp が双方存在せず、primary failure の stage / cause が cleanup に上書きされない。
- failure injection を解除し、同期は保持済み pending を `flush()`、非同期は `__test_writePending()` で
  retry する。新しい snapshot を schedule し直さず、同じ generation N と同じ canonical content が
  v2 / v1 projection の双方に出力される。
- retry 後は pending が消え、async `lastFailure()` は null、tmp は残らない。v2 を v1 shape へ射影した
  内容と disk v1 が semantic equal である。

### 4.2 partial commit からの load と rewrite

- 旧 v1-first writer の再現 test は、rich canonical v2=N-1 を配置し、v1=N の rename 後に
  `renameV2` が失敗した disk pair を作る。これは新 writer の第一 rename failure test と混ぜない。
- rich v2 には tsunami `keyedActive`、VTSE51 observations、VTSE52 observations、VPWW56 state、
  flood gate / active を全て seed する。別 `StandbyPersistence` instance の `loadWithResult()` は v2 を選び、
  `selectedLogicalGeneration` は N-1、`canonicalRewriteRequired` は true とする。
- 同 load は seeded five groups を値まで保持し、`takeMigrationConflictCount() === 1`、warn detail が
  §3.2 の固定文字列 exactly once であることを確認する。
- loaded state を次に正常 save し、さらに別 instance で reload する。rewrite 後の disk v2 generation、disk v1
  generation、reload の `selectedLogicalGeneration` を全て exact `N+1` とする。実 fixture の v2=8 / v1=9
  では三者とも文字列 `"10"` を期待し、選択 v2 の N-1 を再利用しない。tsunami `keyedActive` / VTSE51 /
  VTSE52 / VPWW56 / flood は save 前後で deep equal である。
- v2=N / v1=N-1 の generated pair は v2 を選び、rewrite required とする。migration conflict は増やさない。
- v2=N / v1=N の semantic-equal pair は v2 を選び、rewrite 不要を維持する。
- markerless v1 の savedAt compatibility test と、invalid present generation の fail-closed test は不変で通す。

## 5. 既存テストの変更

`test/engine/display/standby-persistence.test.ts:5380-5393` の「generation が大きい v1 を選ぶ」期待は、
旧 writer の partial commit を canonical selection として固定しているため書き換える。同じ v2=8 / v1=9
fixture で `selectedSource:"v2"`、`selectedLogicalGeneration:"8"`、`canonicalRewriteRequired:true`、
§3.2 の conflict count / fixed warn detail を期待する。続く canonical rewrite では、v2、v1、別 instance の
reload result がいずれも generation `"10"` になることを exact assertion する。

既存の async temp-write failure test（`standby-persistence.test.ts:5789-5811`）と同期・非同期の directory
fsync failure test（同 `:5815-5859`）は残し、§4.1 の rename 四ケースを追加する。各 spy は `afterEach`
だけに頼らず test 内の `finally` でも restore し、一意 tmp directory を使う。実装時は永続化・共有状態の
変更なので `npm run test:shuffle` を必須とする。

## 6. ロールバック

schema は不変であり、旧 binary は v1 mirror を読める。writer 順序だけを戻すことは、new binary が
v1-only partial commit を誤選択する根因を再導入するため禁止する。障害時は pending retry を維持した
new binary で v2/v1 pair を完結させ、両 mirror の generation と semantic content を確認してから旧 binary
へ戻す。loader の v2 authority を戻す場合も、v1>N pair の foundation 喪失を許容する別の明示的裁定を要する。

## 7. 要確認 B（見送り）
backup 再利用時の剪定は今回見送る。`standby-persistence.ts:2451-2459` の既存契約は変更しない。
