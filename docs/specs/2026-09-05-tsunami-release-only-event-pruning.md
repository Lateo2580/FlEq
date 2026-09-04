# 津波 VTSE41 全解除のみ EventID の非保持と一回限り剪定

- 日付: 2026-09-05
- 状態: 実装前仕様（ご主人裁定済み: コード修正＋既存データの一回限り剪定〔案 a〕）
- 作業基準 HEAD: `69497d8b5f60c49934f360bd0cbd8e7ab4f7bc0a`
- 優先度: P0
- 上位仕様: `docs/specs/2026-09-04-tsunami-rest-multi-eventid-restore.md`（以下「指摘5 spec」）

この文書は normative である。「必須」「禁止」「だけ」は実装・試験の受入条件を示す。本書は指摘5 spec の
全解除 base に関する holder postcondition と、`docs/specs/telegram-foundation.md` §12.1 の津波 holder/gate
一対一 invariant に対する限定 carve-out だけを置き換える。pagination、body identity、revision order、coverage target／
window、batch commit、retry の契約と、persistence の JSON shape／schema version は変更しない。

## 1. 背景

Pi 実機の `telegramFoundation.tsunami.keyedActive` に、次の VTSE41 が一件だけ残った。

- `InfoType=発表`、`ReportDateTime=2026-07-28T18:10:00+09:00`、EventID `20260728162718`。
- headline は「津波注意報を解除しました。」、warningComment は「現在、大津波警報・津波警報・津波注意報を
  発表している沿岸はありません。」。
- `level=null`、forecast は一件で `Area.Code=712`、`Kind.Code=60`、`Kind.Name=津波注意報解除`。
- VTSE51/52 観測はともに0件。
- gate は `tsunami:20260728162718`、`cancelled:false`、`acceptedAtMs=1785229800000`。この時刻は REST list の
  `head.time=2026-07-28T09:10:00.000Z` と一致する。

この list/body は既存 fixture に保存済みである。list の identity は
`test/fixtures/rest/telegram-list-vtse41-real.json:8-39`、body の headline、EventID、InfoType、forecast、
warningComment は `test/fixtures/rest/telegram-body-vtse41-real.xml:10-21, 23-38, 56-60` で確認できる。

2026-09-03 の backup 2本はいずれも keyed/gate が0件だった。2026-09-04 21:13 配送の起動時に、旧
`restoreTsunamiState()` の `limit:1` が dmdata 上で最新のこの全解除報を最初の EventID snapshot として replay し、
holder に release-only envelope、gate に non-cancel watermark を作ったと考えるのが観測と一致する。現行の指摘5後
restore は7日 window 外の gate-only baseline を `baselineOutsideRestoreWindow` として fail-closed にする
（`src/engine/startup/tsunami-initializer.ts:284-288, 418-420`）。そのため画面には出ないが、誤った holder payload
だけが永続化され続ける。現行 Pi の起動ログは
`[tsunami-restore] incomplete reason=baselineOutsideRestoreWindow pages=2 items=0 bodies=0 rounds=1` である。

本変更の目的は、全解除のみの VTSE41 を「警報 state」ではなく「その EventID の既知の空状態」として扱うことだ。
revision gate は遅延した古い警報報を拒否するため残し、holder とその `keyedActive` projection だけを空にする。

## 2. 根因

### 2.1 level 判定と holder 所有判定が分離されていない

`normalizeTsunamiKind()` は名称に「解除」を含む item を警報ラベルへ canonicalize せず、
`resolveTsunamiLevel()` は解除のみの配列を `null` にする（`src/utils/tsunami-kind.ts:16-29, 42-47`）。これは
CLI/display の level 判定には正しい。しかし `level === null` には Code 71 の「津波予報（若干の海面変動）」も含まれるため、
その条件を holder 非保持の判定へ流用してはならない。

### 2.2 `applyAccepted()` は全解除を通常の full keyed snapshot として保存する

`TsunamiStateHolder.applyAccepted()` は forecast item を EventID + Area.Code + Kind.Code で key 化し、全 item が
keyed なら同 EventID の旧 item を削除した後、incoming item をすべて `keyedForecasts` と `eventInfos` に格納する
（`src/engine/messages/tsunami-state.ts:348-383`）。Code 60 を除外する分岐はない。

従って、既存 keyed がある場合には `:366-373` の full-snapshot 置換が旧警報 item を消し、`:493-508` の
`rebuildActiveState()` が aggregate level/lastInfo を空にする。この部分だけが従来の「全解除畳み込み」として効く。
一方、holder が空で全解除がその EventID の最初の報なら、消す旧 item が無いまま Code 60 item と envelope を新規格納する。
また既存 EventID の場合も release item 自体は残るため、畳み込み後の holder は論理的には空になっていない。

`getPersistedKeyedActive()` は level を見ず `eventInfos` の全値を返す
（`src/engine/messages/tsunami-state.ts:192-195`）。`activeEventIds()` だけは active level のある EventID に絞る
（同 `:439-445`）ので、表示・容量判断と persistence の間に非対称が生じる。

### 2.3 live と REST duplicate replay が同じ漏れ口を通る

`processTsunami()` は gate の `decide()` を先に commit し（`src/engine/presentation/processors/process-tsunami.ts:255-258`）、
VTSE41 の非取消を例外なく `applyAccepted()` へ渡す（同 `:267-275`）。従って live の初見全解除も gate と holder の
両方へ入る。

REST の gate-only duplicate reconstruction も、valid EventID の non-cancel duplicate/semanticDuplicate なら
`applyAccepted()` を呼ぶ（同 `:187-205`）。指摘5実装はさらに、gate-only anchor replay 後の
`hasPersistedEvent(eventId)` を一律必須にしている
（`src/engine/startup/tsunami-initializer.ts:339-379`）。このため「全解除は既知の空状態」という意味を表すためだけに
release-only envelope を holder へ作る契約になっている。

### 2.4 永続 reader が release-only envelope を正当な active と認める

`isKeyedTsunamiActive()` は非取消、valid EventID、forecast 非空、全 item keyable だけを要求し、Code 60 を除外しない
（`src/engine/display/standby-persistence.ts:5788-5800`）。reader は EventID ごとの最新 revision を選び gate と結合した後、
その値を `keyedActive` として返す（同 `:5881-5929, 6241-6284`）。Pi の payload はこの全条件を満たす。

これは schema 破損ではなく、旧 writer/restore が当時の契約どおり生成した「現在は不要な正規 payload」である。
したがってコード修正だけでは既存ファイルから消えず、load migration が必要になる。

## 3. 改修

### 3.1 release-only 判定を一か所へ集約する

`src/utils/tsunami-kind.ts` に次の純関数を追加し、holder、REST coverage、persistence reader/writer が共用する。

```ts
export function isTsunamiReleaseOnlyForecast(
  forecast: readonly Pick<TsunamiForecastItem, "kindCode">[] | null | undefined,
): boolean {
  const items = forecast ?? [];
  return items.length > 0
    && items.every((item) => item.kindCode?.trim() === "60");
}
```

判定は forecast 非空かつ全 item の `Kind.Code` が trim 後に厳密に `"60"` の場合だけ true とする。名称の
「解除」、headline、warningComment、`resolveTsunamiLevel() === null` を根拠にしてはならない。これにより次を分離する。

- Code 60 だけ: release-only。holder 非保持。
- Code 60 と 51/52/53/62 の混在: 一部解除＋警報継続。従来どおり full snapshot として保持。
- Code 71 だけ: 無警報だが津波予報として意味がある。従来どおり保持。
- forecast 空: InfoType=取消又は別の空報契約であり、本 predicate では release-only にしない。
- kindCode 欠落・未知 code: release-only と推測しない。既存の keyless/fail-open 契約を維持する。

parser の既知 VTSE41 code は `51, 52, 53, 60, 62, 71` である
（`src/dmdata/telegram-parser.ts:244`）。本変更で parser schema や未知 code 診断は変えない。

### 3.2 holder は release-only EventID を空へ畳む

`TsunamiStateHolder.applyAccepted()` は valid EventID を取り出した直後、key map を作る前に release-only を判定する。
true の場合は、その EventID に属する `keyedForecasts` をすべて削除し、`eventInfos.delete(eventId)` を行い、
`rebuildActiveState()` と `clearObservationsIfInactive()` を呼んで return する。

```ts
const eventId = tsunamiEventId(info);
if (eventId != null && isTsunamiReleaseOnlyForecast(info.forecast)) {
  this.removeEvent(eventId); // keyedForecasts と eventInfos だけを EventID 限定で削除
  this.rebuildActiveState();
  this.clearObservationsIfInactive();
  return;
}
```

`removeEvent()` は private helper とし、InfoType=取消の `clearAccepted()` と重複する EventID 限定削除を共通化してよい。
ただし取消の部分対象処理は変えない。別 EventID の item/envelope を削除すること、release item を tombstone として
holder に格納すること、全 holder を `clearActive()` することは禁止する。

この invariant は live、REST accepted replay、REST duplicate reconstruction、`restorePersistedState()` の全入口で成立する。
`getPersistedKeyedActive()` は変更後も `eventInfos` projection のままでよいが、その返り値に release-only entry が一件も
含まれないことを class invariant とする。

`processTsunami()` の順序は変えない。gate を先に受理し、その後 holder を空へ畳み、最後に
`onTsunamiRevisionDecision` を呼ぶ。結果は `kind:"ok"` のままなので revision persistence、統計、必要な解除通知を失わない。
`displaySnapshot` も現行の aggregate 選択を維持する（`process-tsunami.ts:293-333`）。active EventID B が同居すれば B の
カードを維持し、他に active が無ければ `projectDisplayEvent()` が `resolveTsunamiLevel()==null` で emergency を作らない
（`src/engine/display/project-event.ts:270-299`）。DisplayStateStore は emergency の無い VTSE41 で既存カードを消し、空なら
新規カードを作らない（`src/engine/display/state-store.ts:787-826`）。

### 3.3 指摘5 coverage と gate-only・全解除 base の整合

指摘5 spec の「reconstructible base」は「必ず canonical `eventInfos` を一件作る base」ではなく、
「その EventID の holder state を履歴の先頭から一意に決められる base」と読み替える。全解除は holder の既知の空状態を
一意に作れるため、引き続き reconstructible base である。gate は non-cancel revision watermark のまま残る。

`src/engine/startup/tsunami-initializer.ts` の boolean `base()` は、少なくとも次の tagged result に置き換える。

```ts
type ReconstructibleBaseKind =
  | "activeSnapshot"
  | "wholeCancellation"
  | "releaseOnly";
```

- `activeSnapshot`: 発表/訂正、forecast 非空、全 item keyable、かつ release-only ではない。
- `wholeCancellation`: InfoType=取消かつ forecast 空。
- `releaseOnly`: 発表/訂正、forecast 非空、全 item keyable、かつ §3.1 predicate が true。

gate-only direct base の semantic payload/gate exact 一致検査は維持する。duplicate replay 直後の holder postcondition だけを
base kind ごとに分ける。

- `activeSnapshot`: `hasPersistedEvent(eventId) === true`。
- `releaseOnly`: `hasPersistedEvent(eventId) === false`。

gate-only coverage target は exact non-cancel gate だけなので、`wholeCancellation` は direct gate-only target にはならない。
これは baseline に無い新規 EventID の base、又は isolated trace 内の lifecycle 境界としてだけ使い、replay 後の holder は空、
gate は cancelled とする。

従って Pi 形の gate-only release anchor は、baseline gate の payload fingerprint と exact revision/acceptedAtMs が一致し、
replay 後も同じ gate が存在し holder が空なら proof 成功である。空 holder に release-only sentinel envelope を再作成しては
ならない。baseline gate だけが既にある direct duplicate の場合、projection は変化しないため
`complete, changed:false`、外部 callback 0回が正しい。

isolated base trace でも release-only は「空 holder から開始できる」base として認める。ただし、その後の partial cancellation
又は unkeyed normal anchor だけから active item を捏造してはならない。anchor 到達時の exact gate proofに加え、replay prefix
から一意に得られる holder postcondition（空又は canonical active）を coverage token に保持する。release-only 後に full active
snapshot が無く、partial/unkeyed anchor だけが続く trace は holder が空のままでも、それが replay の正しい結果であり、
`hasPersistedEvent()` を無条件に要求しない。一方、欠落した active item を必要とする trace は従来どおり
`coverageMissingGateOnlyBase` とする。

新規 EventID の最初の item が release-only の場合も coverage を開始できる。replay は gate を新設し、holder は空にする。
これは指摘5 spec §3.4 の全解除 anchor/base 許可を維持し、同 §3.5 の「全 gate-only target は eventInfos を持つ」という
誤った postconditionだけを廃止する。7日 window、anchor 必須、`baselineOutsideRestoreWindow`、batch fail-closed は変えない。

coverage target の集合自体も変えない。永続化後の `PersistedTelegramRevisionGateEntryV2` は revision、semantic key、
`cancelled`、`acceptedAtMs` 等だけを持ち、最後に受理した VTSE41 の forecast 又は release-only provenance を持たない
（`src/engine/messages/telegram-revision-gate.ts:238-250, 1683-1708, 1795-1797`）。従って migration が payload を剪定して canonical
rewrite した次回起動では、その gate-only entry が全解除由来か、active snapshot の欠落又は部分永続化由来かを判別できない。
opaque fingerprint である `semanticKeys` から Kind.Code を逆算することも禁止する。

このため「最後の受理が release-only だった gate-only baseline」を coverage target から除外してはならない。全 non-cancel
gate-only entry を除外すると、実際には active state が欠落した subject まで complete と誤認し、指摘5 spec §4.2 の
fail-closed 原則に反する。同一 load 中だけ得られる剪定元 payload の知識で一時除外しても、rewrite 後の再起動で結果が変わるため
採用しない。除外を可能にする durable release-only provenance の追加は別の semantic schema migration であり、本変更には含めない。

Pi のように gate の `acceptedAtMs` が7日 window 外なら、剪定後も restore は
`incomplete, reason:"baselineOutsideRestoreWindow", retryable:false` とする
（`src/engine/startup/tsunami-initializer.ts:70-74, 284-288`）。retry controller は非 retryable result を再試行しない
（`src/engine/startup/tsunami-restore-retry.ts:68-87`）ため、診断は process startup ごとに一行、background retry と
`retryExhausted` は0回である。この診断は coverage provenance を証明できない事実を示すため抑止しないが、holder/card は空を保つ。

### 3.4 既存 `keyedActive` の一回限り load migration

`sanitizeTsunamiFoundation()` の reader 経路で、各 EventID の revision ordering と gate coupling を検証し、最新 candidate を
一件選んだ**後**に、その retained candidate が release-only かを検査する。release-only retained candidate は
`keyedActive` から除去するが、対応する exact VTSE41 gate entry は `cancelled:false` のまま保持する。

filter を `retainNewestKeyedTsunamiActive()` より前へ置いてはならない。同じ EventID に古い警報 snapshot と新しい全解除 snapshot
が同居する raw input で、先に全解除を除くと古い警報が最新 active として復活するためだ。処理順は次に固定する。

```text
構造検証 → EventID ごとの最新 revision 選択 → gate coupling 検証
        → retained release-only の holder projection 除去 → gate compaction/保持
```

除去した subject を `rejectedActiveSubjects` に加えてはならない。これは gate coupling 不良ではなく holder policy migration
だからであり、`salvageableVtse41Candidates` から gate を巻き添え削除しない。Code 60 以外の candidate、legacyActive、
VTSE51/52 observations、別 EventID は変更しない。deprecated scalar `active` は最終 `keyedActive` から再射影されるため、
該当 EventID しか無ければ `null` になる（現行射影は `standby-persistence.ts:6332-6343`）。

schema version と migration marker は追加しない。判定対象そのものが書き戻し後に消えるため冪等であり、二回目 load は
剪定0件になる。writer 側の `normalizeTsunamiFoundationForWrite()` にも同じ invariant を適用し、canonical writer が
release-only keyed input を受けた場合は silent write せず既存の writer-state invariant error で拒否する
（現行 count 検査は `standby-persistence.ts:6055-6073`）。

剪定時は closed `SalvageReason` に `"release-only-active"` を追加し、affected source ごとに既存 salvage 集約を使って
次の一行だけを出す。Pi fixture では exactly 一行、`discarded=1 retained=0` とする。

```text
[standby-persistence] salvage source=display-active-state-v2.json domain=foundation.tsunami unit=eventId discarded=1 retained=0 reason=release-only-active
```

同じ source の他の tsunami repair が同時にある場合も一行へ集約する。successful canonical rewrite 後の再起動ではこの行を
再出力しない。backup/rewrite failure の既存診断行は別物であり、この「剪定ログ一行」制約には数えない。

### 3.5 backup、両 mirror、`logicalGeneration`

剪定は正当だった旧 payload を破棄するため、affected raw source の `.salvage-backup` を必須とする。既存
`repairSources` に原 bytes と metric を登録し、backup が成功するまで canonical rewrite を禁止する
（`src/engine/display/standby-persistence.ts:2024-2081, 2137-2144, 2346-2386`）。新しい manual backup API や
全 mirror backup は追加しない。現行 v1 rollback mirror は `telegramFoundation` を持たず
（同 `:1955-1964`）、剪定対象 payload が存在する affected source は v2 だからだ。

load が返す runtime state は直ちに剪定済みとし、backup が一時失敗しても CLI/display に release-only holder を復元しない。
raw v2 は backup 成功と canonical rewrite まで変更しない。失敗中は既存の retry/backoff と unhealthy 診断に委ね、次回 load も
同じ入力を冪等に剪定する。

canonical rewrite は monitor の既存 startup dirty 集約を使う
（`src/engine/monitor/monitor.ts:640-658`）。新しい snapshot は `reserveSerializationEnvelope()` で現在読めた v1/v2 の最大
generation より一つ大きい `logicalGeneration` を一度だけ予約する
（`standby-persistence.ts:1348-1352, 1414-1431`）。sanitize 中に generation を変更してはならない。

writer は同じ generation/savedAt の v2 と v1 を組み、v2 temp、v1 temp の順で書いて fsync し、v2、v1 の順で rename する
（同 `:1625-1639, 2162-2197`）。v2 は `keyedActive=[]` と gate-only entry を持つ。v1 は津波 foundation を持たない既存
rollback projectionのままだが、v2 と同じ新 generation に更新する。従って「両 mirror」は内容の二重保持ではなく、同一
logical snapshot pair として一回だけ書き戻すことを意味する。

### 3.6 Pi fixture の固定方法

復元/migration test は synthetic な「解除」という名称だけで済ませず、既存の
`test/fixtures/rest/telegram-list-vtse41-real.json` と `test/fixtures/rest/telegram-body-vtse41-real.xml` を使う。
actual parser で body を parse し、list `head.time` を `receivedAtMs/acceptedAtMs` に用いる。次を assert する。

```ts
expect(release.meta.eventId.value).toBe("20260728162718");
expect(release.meta.reportDateTime.raw).toBe("2026-07-28T18:10:00+09:00");
expect(release.forecast).toHaveLength(1);
expect(release.forecast![0]).toMatchObject({ areaCode: "712", kindCode: "60" });
expect(release.warningComment).toBe(
  "現在、大津波警報・津波警報・津波注意報を発表している沿岸はありません。",
);
expect(Date.parse(realItem.head.time)).toBe(1785229800000);
```

旧 version が生成した raw state は、actual parse 結果を `keyedActive:[release]` に直接注入し、同じ payload を gate へ一度
`processTsunami()` して得た exact non-cancel gate を付けて作る。変更後の holder API を使って誤 state を生成しようとしては
ならない（正しく空へ畳まれるため）。

## 4. 対象ファイル

### 4.1 production

- `src/utils/tsunami-kind.ts`（現 `:1-48`）— release-only forecast predicate の唯一の定義。
- `src/engine/messages/tsunami-state.ts`（現 `:296-390, 393-430, 493-508`）— restore/live 共通の EventID 限定畳み込み。
- `src/engine/startup/tsunami-initializer.ts`（現 `:236-247, 259-310, 339-381`）— tagged base と gate-only postcondition。
- `src/engine/display/standby-persistence.ts`（現 `:969-1096, 5788-5929, 5958-6074, 6126-6356`）— reader migration、
  writer invariant、剪定ログ、backup/rewrite 連携。

`src/engine/presentation/processors/process-tsunami.ts` は現 `:187-205, 255-275, 293-333` の gate→holder→callback と
displaySnapshot 順序を維持し、production の意味変更は不要である。コメント変更は可だが判定の二重実装は禁止する。
`src/engine/monitor/monitor.ts`、persistence の JSON shape／schema version、revision family policy、REST client、parser は変更しない。

### 4.2 normative documentation

- `docs/specs/telegram-foundation.md`（現 `:1262-1288`）— §12.1 に Code 60 only の holder 非保持と exact
  non-cancel gate-only 正規形を、津波 one-to-one invariant の唯一の carve-out として追記する。

### 4.3 tests

- `test/utils/tsunami-kind.test.ts`
- `test/engine/tsunami-state.test.ts`
- `test/engine/presentation/processors/process-tsunami.test.ts`
- `test/engine/tsunami-initializer.test.ts`
- `test/engine/telegram-foundation/phase3b-tsunami.test.ts`
- `test/engine/display/standby-persistence.test.ts`
- `test/engine/monitor/tsunami-rest-restore-retry.test.ts`
- `test/engine/display/project-event.test.ts` 又は既存 DTO/state-store 経路を通す同等の display integration test

新しい XML/JSON fixture は追加しない。既存 Pi 実データ fixture を再利用する。

## 5. 判断分岐（追加裁定なし）

ご主人裁定「コード修正＋既存データの一回限り剪定（案 a）」から、gate 保持、holder 非保持、load migration、affected v2
source の salvage backup、marker を持たない冪等 rewrite まで一意に決まる。追加でご主人裁定を要する項目はない。

追加検討の「release-only gate-only baseline を coverage target から除外する」は不採用と確定する。§3.3 のとおり、marker を
持たない rewrite 後の gate だけでは全解除由来を証明できず、無差別な除外は fail-closed 原則を破るためだ。推奨は現行の
7日 window と coverage target を維持し、窓外では一 startup 一回の非 retryable `baselineOutsideRestoreWindow` を診断することだ。
gate TTL、retry policy、診断抑止、durable provenance 追加へ範囲を広げない。残存する運用上の懸念は、無期限の gate が
family capacity で退場するまで、この診断が起動ごとに再発し得ることだけである。retry storm や解除カードの再表示は生じない。

## 6. 受入条件（機械検証）

1. 空 holder/gate へ live の release-only VTSE41 を一件流す。`processTsunami().kind === "ok"`、gate は exact EventID で
   `cancelled:false`、holder は `getPersistedKeyedActive()=[]`、`getLastInfo()/getDetail()/getPromptStatus()` は null とする。
2. REST の新規 EventID release-only 一件を stable scan/body/replay する。result は `complete, changed:true, active:null`、
   holder は空、gate は一件とする。list/body identity と missing Serial policy は現行どおり通す。
3. 空 holder + 既存 exact non-cancel gate へ同じ release-only REST anchor を duplicate replay する。result は
   `complete, changed:false, active:null`、gate snapshot は同一、`hasPersistedEvent(eventId)===false`、callback 0回とする。
4. gate-only baseline の exact anchor を unkeyed normal report とし、window 内でそれ以前に release-only base だけを置く。
   full active snapshot を一件も含めず isolated trace を replay し、`complete, changed:false, active:null`、holder 空、gate snapshot
   byte-equal、callback 0回とする。これは「release-only base が既知の空 holder を証明する」経路を直接固定する試験である。
5. 同じ EventID の警報 snapshot 後に release-only を流す。旧 keyed item/envelope は0件になり gate は release revisionへ進む。
   別 EventID B が同居する case では B の holder/card/level を維持する。
6. release gate 後に古い警報を新しい transport time で遅着させても gate が `stale` として抑止し、holder を復活させない。
7. Code 60 + 62 の混在 report は release-only と判定せず従来どおり保持する。Code 71 only、forecast 空、kindCode 欠落、
   名称だけ「解除」を含む unknown code も誤剪定しない。
8. `restorePersistedState()` へ release-only keyed payload を直接渡しても defense-in-depth で holder は空になる。
9. Pi fixture を注入した v2 load は release-only keyed 一件だけを剪定し、exact gate と空の VTSE51/52 を維持する。
   source は `salvageable`、`canonicalRewriteRequired=true`、§3.4 の剪定ログ exactly 一行とする。
10. Pi fixture と同じ EventID に「古い警報 candidate + 新しい release-only candidate」を raw `keyedActive` として与える。
   最新選択後に両 holder candidate が消え、古い警報が復活しないことを assert する。
11. backup 前の write は `stage:"salvageBackup"` で失敗し raw v1/v2 を不変に保つ。backup 成功後の一回の canonical save は
    両 mirror を同じ N+1 generation へ進め、v2 の keyed は空・gate は残存とする。
12. rewrite 後に新しい `StandbyPersistence` で reload する。剪定0件、source `valid`、
    `canonicalRewriteRequired=false`、追加 backup/剪定ログなし、holder/gate の round-trip が同一である。
13. §12 の二回目 reload 後、Pi gate より古い ReportDateTime の警報を Pi gate より新しい transport time で投入する。
    result は `suppressed`、観測 decision は `stale`、holder は空、`JSON.stringify(exportDurableEntries())` と raw v2 bytes は
    投入前後で byte-equal、`onTsunamiRevisionDecision`／canonical-save callback は0回とする。
14. canonical writer に release-only keyed input を直接与えると validation failure になり、silent に不整合 snapshot を書かない。
15. 指摘5の active gate-only A/B、active snapshot 起点の部分取消/unkeyed isolated trace、holder-backed release replay、new EventID full active、
    empty REST、staleVersion、batch no-commit の既存試験を維持する。全解除に対する postcondition だけを本書どおり更新する。
16. Pi fixture の canonical rewrite 後、次回 startup restore は holder/card を空のまま
    `incomplete, reason:"baselineOutsideRestoreWindow", retryable:false, changed:false` とする。incomplete warn は exactly 一行、
    background attempt と `retryExhausted` は0回とする。provenance が永続化されないため complete／ログ無しを期待してはならない。
17. actual release outcome を `fromTsunamiOutcome()` → `projectDisplayEvent()` → `DisplayStateStore.applyEvent()` へ通す。
    active が無い場合は emergency/tsunami card を新規作成せず、既存同 EventID card は消える。CLI の prompt/detail にも
    解除カードを残さない。timeline/stat/解除通知の既存仕様は抑止しない。
18. persistence、共有 owner、module 間 predicate を触るため、`npm run build`、`npm test`、`npm run test:shuffle` が全て成功する。

## 7. テスト変更

`test/utils/tsunami-kind.test.ts:67-99` に Code 60 only、60+62、71 only、空、欠落、unknown の table test を追加する。
名称による判定を期待値に含めない。

`test/engine/tsunami-state.test.ts:529-671` は従来の level null だけでなく `getPersistedKeyedActive()` と
`hasPersistedEvent()` が false であることを追加する。特に「注意報→解除」と「初見解除」を別 case にし、
`:579-606` の部分解除＋継続、Code 71 persistence は残す。

`test/engine/presentation/processors/process-tsunami.test.ts:28-70` に live 初見解除の gate-only result と、警報→解除→遅延警報拒否を
追加する。gate callback が呼ばれ、holder が空であることを同時に固定する。

`test/engine/tsunami-initializer.test.ts:275-287` の実 Pi fixture test は complete だけでなく holder 空・gate 残存まで検査する。
同 `:369-380` の「gate-only full release reconstructs canonical EventID state」は、canonical event を作る期待を削除し、
`complete, changed:false`、holder 空、gate不変、callback 0へ更新する。同 `:801-819` の new EventID full-release は
`hasPersistedEvent()===false` を期待する。さらに同 `:382-407` の active snapshot 起点 isolated case は残したまま、
release-only base → unkeyed normal exact anchor、full active snapshot なしの独立 case を追加し、`complete, changed:false`、
holder 空、gate の serialized snapshot byte-equal、callback 0を assert する。

`test/engine/telegram-foundation/phase3b-tsunami.test.ts:1052-1101` の Code 71/forecast empty 回帰を残し、その近傍へ
release-only は keyed に出ないが gate は残る processor→persistence→restart case を追加する。同 `:2068-2223` の部分取消と
holder より新しい non-cancel gate の round-trip は変更しない。

`test/engine/display/standby-persistence.test.ts` に Pi raw v2 migration、最新候補選択順、剪定ログ、salvage backup barrier、
N→N+1 両 mirror rewrite、二回目 load no-op を一つの bounded suite として追加する。二回目 reload で復元した holder/gate へ
古い警報を新しい transport time で投入し、`stale` suppression、holder 空、gate/file bytes 不変、persistence callback 0まで
同じ suite で直接検証する。既存の pair round-trip は
`test/engine/display/standby-persistence.test.ts:5485-5557`、backup barrier は production
`standby-persistence.ts:2137-2144, 2346-2386` を参照する。

`test/engine/monitor/tsunami-rest-restore-retry.test.ts:55-63` の non-retryable case に
`baselineOutsideRestoreWindow` を加える。Pi fixture の rewrite/reload 後を入力に、initializer の incomplete warn exactly 一行、
attempt 一回、timer 0、`retryExhausted` 0を固定する。診断自体を mock で消す試験にはしない。

display は `test/engine/display/project-event.test.ts:932-963` と
`test/engine/display/state-store.test.ts:668-701` の既存「emergency null ならカードなし/削除」を actual Pi release outcome から
到達する integration case で補強する。unit の DTO 手書き期待だけで完了扱いにしない。

## 8. ロールバック

persistence の JSON shape／schema version、wire format、revision family policy は変わらないため、コードは predicate、holder branch、
coverage token、reader migration と `docs/specs/telegram-foundation.md` §12.1 の semantic carve-out を同じ change set で戻せる。
ただしコードだけを戻しても、一度 canonical rewrite 済みの release-only
`keyedActive` は自動復元されない。これは意図した剪定であり、gate watermark は残る。

旧 payload の完全な再現が必要な場合だけ、停止中に affected v2 の `.salvage-backup` を運用者が明示復元する。v1 は津波
foundation を持たないため、剪定 payload の証拠源にはならない。backup を確認せず raw persistence を上書き・削除すること、
gate entry まで手作業で消すことは禁止する。

backup 又は canonical pair write に失敗した rollout は「migration 完了」と扱わない。runtime holder は安全側の空を維持するが、
raw v2 は旧内容のままなので次回起動で migration が再試行される。実装 rollback 後にその旧 raw 又は backup を読むと旧挙動が
再発し得るため、復旧判断では app version と persistence generation を対にして確認する。
