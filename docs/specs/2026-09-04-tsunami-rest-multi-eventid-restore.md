# 津波 VTSE41 REST の複数 EventID 復元

- 日付: 2026-09-04
- 状態: 実装前仕様（裁定済み: A / A、独立 DOC review 3巡反映済み）
- 作業基準 HEAD: `85b581354143d7a34b6222656e1e350849712af7`
- 優先度: P0

この文書は normative である。「必須」「禁止」「だけ」は実装・試験の受入条件を示す。

## 1. 背景

VTSE41 の revision family は EventID ごとに独立した subject である。別 EventID の無警報報は既存
EventID を解除しない（`src/engine/messages/revision-family-registry.ts:823-844`）。holder も
`keyedForecasts` と `eventInfos` を EventID ごとに保持し、canonical persistence は複数 EventID の
`keyedActive` を保存する（`src/engine/messages/tsunami-state.ts:93-98, 192-195, 331-369`、
`docs/specs/telegram-foundation.md:1275-1288`）。

ところが startup REST restore は `limit: 1` の一覧先頭だけを本文取得・適用する
（`src/engine/startup/tsunami-initializer.ts:37-45`）。停止中に EventID A の取消又は全解除の後で EventID B
が発表された場合、最新の B だけでは A の終端を再生できず、永続化済み A が残る。逆に holder が空のまま
停止中に A、B と発表された場合も、A は復元されない。

本変更は新しい津波 state schema を導入しない。既存の EventID keyed holder、revision gate、
`processTsunami()` を、bounded な履歴を検証してから一括 replay する startup repair として使う。

## 2. 根因

- `restoreTsunamiState()` は page 化せず `items[0]` だけを処理し、一つの EventID しか見ない
  （`tsunami-initializer.ts:37-48`）。
- 現行 persistence は、部分取消又は unkeyed 続報により holder の active revision より non-cancel gate
  watermark が新しい状態を正当とする。`tsunamiActiveMatchesGate()` はその非対称性を検証するが、
  `standby-persistence.ts` の private 実装に閉じている
  （`src/engine/display/standby-persistence.ts:5682-5726`、
  `test/engine/telegram-foundation/phase3b-tsunami.test.ts:2068`）。startup が subject と `cancelled:false`
  だけを見ると破損を通し、holder と gate の revision 完全一致を要求すると正当な部分取消 state を拒否する。
- REST window 内に baseline と結合する anchor item を要求しなければ、persisted A があるのに一覧が空でも
  「新報なし」と誤認し、停止中 coverage を証明できない。
- `restoreStateOnDuplicate` は `getLastInfo() == null` という holder 全体条件である。gate-only A/B から A を
  再構成すると `lastInfo` が non-null になり、B は duplicate のまま復元されない
  （`src/engine/presentation/processors/process-tsunami.ts:171-184`、
  `src/engine/messages/tsunami-state.ts:192-195`）。さらに gate-only anchor が部分取消又は unkeyed 通常報なら、
  duplicate replay 自体が canonical `eventInfos` を作らないため、anchor より前の reconstructible base が必要である
  （`process-tsunami.ts:175-184`、`tsunami-state.ts:342-366`、
  `test/engine/telegram-foundation/phase3b-tsunami.test.ts:2225-2283`）。
- 複数 item を直ちに `processTsunami()` へ渡すと、途中の body/parse/revision rejection より前の item だけが
  commit され得る。また `processTsunami()` の `suppressed` は duplicate/stale だけでなく
  `invalidRevision`、`capacityExceeded`、`cancelTargetMismatch` も含む
  （`process-tsunami.ts:171-186, 237-255`、
  `src/engine/messages/telegram-revision-gate.ts:911-927, 994-1011`）。
- EventID ごとの revision conflict 検証と実 replay の transport 順は別問題である。EventID group を辞書順に
  replay すると、最後に更新された `eventInfos` entry を envelope にする aggregate `lastInfo` が live 受信時と変わる
  （`src/engine/messages/tsunami-state.ts:357-366, 489-493`）。同一受信時刻・同一 EventID の tie だけは、persistence と
  同じ `発表 < 訂正 < 取消` を使う必要がある（`standby-persistence.ts:5908-5926`）。
- gate の commit は candidate の `receivedAtMs` で全 family sweep を起動する
  （`telegram-revision-gate.ts:705-709, 1758-1781`）。遠未来の REST 時刻を replay すると、無関係な
  tombstone/transient を早期失効させ得る。
- primary ingress は REST より先に接続されるが、現 restore は起動時に一回だけである
  （`src/engine/monitor/monitor.ts:1153-1170`）。journal を持たない REST snapshot が一時的に不安定なだけで
  restore を終えると、古い A が process lifetime 中残る。
- retry timer の clear だけでは await 中 attempt を無効化できない。shutdown の最終 persistence 保存後に REST が
  resolve して commit すると、その mutation は保存されない。また初回 retry を直ちに arm すると、直後の火山 startup
  repair と bounded REST scan が重なる（`monitor.ts:1164-1186`、`src/engine/monitor/shutdown.ts:108-138`）。

## 3. 改修

### 3.1 一 attempt の固定時計と上限

`restoreTsunamiState()` は一回の bounded attempt だけを担当し、結果を structured result で返す。monitor の
retry controller はこの結果だけを見て再予約する。

```ts
export type TsunamiRestoreBodyFailureReason =
  | "forbidden" | "notFound" | "contentType" | "tooLarge" | "network";

export type TsunamiRestoreFailureReason =
  | "invalidRestoreClock"
  | "listUnavailable"
  | "listResponseInvalid"
  | "pageSizeExceeded"
  | "pageLimitExceeded"
  | "itemLimitExceeded"
  | "duplicateItemId"
  | "invalidCursorToken"
  | "cursorTokenLoop"
  | "listOrderInvalid"
  | "listItemInvalid"
  | "bodyUnavailable"
  | "bodyFetchLimitExceeded"
  | "bodyIdentityMismatch"
  | "parseFailed"
  | "replayTimeInvalid"
  | "unorderedReplayRevision"
  | "equalRevisionPayloadConflict"
  | "baselineGateMismatch"
  | "baselineOutsideRestoreWindow"
  | "coverageMissingPersistedEvent"
  | "coverageMissingGateOnlyBase"
  | "coverageMissingNewEventBase"
  | "headStabilityLimitExceeded"
  | "tsunamiReplayRejected"
  | "admissionRejected"
  | "staleVersion";

export type TsunamiRestoreFailure =
  | { reason: "bodyUnavailable"; bodyReason: TsunamiRestoreBodyFailureReason }
  | { reason: "admissionRejected"; admissionReason: string }
  | { reason: Exclude<
      TsunamiRestoreFailureReason,
      "bodyUnavailable" | "admissionRejected"
    > };

export type TsunamiRestoreAttemptResult =
  | { kind: "complete"; changed: boolean; active: ParsedTsunamiInfo | null }
  | { kind: "noData"; changed: false }
  | { kind: "abandoned"; changed: false }
  | ({ kind: "incomplete"; changed: false; retryable: boolean } & TsunamiRestoreFailure);

export const TSUNAMI_RESTORE_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
export const TSUNAMI_RESTORE_PAGE_LIMIT = 100;
export const TSUNAMI_RESTORE_MAX_PAGES_PER_SCAN = 128;
export const TSUNAMI_RESTORE_MAX_ITEMS_PER_SCAN = 256;
export const TSUNAMI_RESTORE_MAX_BODY_FETCHES_PER_ROUND = 256;
export const TSUNAMI_RESTORE_MAX_STABILITY_ROUNDS = 4;
export const TSUNAMI_RESTORE_MAX_BODY_FETCHES_PER_ATTEMPT = 1_024;
```

上の union は閉じた normative list とし、実装が ad-hoc な文字列を返すことを禁止する。`bodyReason` は
`reason:"bodyUnavailable"` の場合だけ必須である。`kind:"abandoned"` は §3.7 の stop/generation invalidation 専用で、
failure、warn、attempt exhaustion のいずれにも数えない。

production は attempt entry で `Date.now()` を一度だけ読み、全 scan、body 検証、coverage、replay に同じ
`nowMs` を渡す。test は `now: () => number` を attempt options に注入し、処理中に壁時計を再読しないことを
spy で固定する。`nowMs`、`nowMs - lookback` は safe integer かつ Date 範囲内でなければ
`invalidRestoreClock` として replay 前に失敗する。background retry は別 attempt なので、その entry で新しい
`nowMs` を一度だけ取る。

page/item/body/round の上限は各 attempt でリセットする。各 full-window scan は最大128 request、各 round は
before/after の二 scan と最大256 body request、attempt 全体は最大4 round、すなわち list 1,024 request と
body 1,024 request を絶対上限とする。上限到達後に追加 request を発行してはならない。

### 3.2 full-window pagination と stability round

`fetchTsunamiRestoreWindow(nowMs)` は一覧を必ず query object で呼ぶ。各 page に
`type:"VTSE41"`、`limit:TSUNAMI_RESTORE_PAGE_LIMIT`、`formatMode:"raw"`、`xmlReport:true` を明示し、
opaque `nextToken` だけを次 page の `cursorToken` へ無加工で渡す。`listTelegrams()` は既にこの契約を持つため
REST client の API 変更は不要である（`src/dmdata/rest-client.ts:233-305`）。

各 full-window scan は次を検証し、括弧内の固定 reason で失敗する。

- response shape は `status:"ok"` の item 配列である（`listResponseInvalid`）。page size、page count、window 内
  item count は各上限内である（順に `pageSizeExceeded`、`pageLimitExceeded`、`itemLimitExceeded`）。
- item は一意で非空の id、VTSE41 type、非空 EventID、valid reportDateTime/infoType、URL を持つ。Serial は numeric
  valid、又は family policy が許す missing（`raw == null || raw === ""`）なら有効とする。非空 raw が numeric valid
  でない場合だけ `listItemInvalid` とする。VTSE41 は正常報・取消とも missing を許す
  （`src/engine/messages/revision-family-registry.ts:823-844`）。
- `strictRestReceivedTimeMs(item.head.time)` は safe integer/Date 範囲内で、page 内・page 境界とも
  newest-first である（invalid item は `listItemInvalid`、単調性違反は `listOrderInvalid`）。`receivedTime` は順序軸に
  使わない。
- item id の重複は `duplicateItemId`、空又は非 string nextToken は `invalidCursorToken`、既出 nextToken は
  `cursorTokenLoop` とする。

coverage start ちょうどの item は含める。開始時刻より古い sentinel を確認した page、又は nextToken が無い
page でだけ scan を完了する。window 内 item を全部保持し、古い sentinel は replay input に含めない。

各 stability round は必ず次の三段を最初から実行する。

```text
before = fetchTsunamiRestoreWindow(nowMs)                 // 全 page
staged = fetchAndValidateAllBodies(before, nowMs)         // 全 relevant body
after  = fetchTsunamiRestoreWindow(nowMs)                 // 再び全 page
```

`orderedIdentity(window)` は、検証済み item を `head.time` 降順、同時刻は id の code-unit 昇順へ canonical sort した
`(id, url, head.time epoch, EventID, reportDateTime raw/epoch, serial presence/raw/numeric, infoType)` 配列である。
`orderedIdentity(before) !== orderedIdentity(after)` なら staged body/parse 結果を全て破棄し、次 round の before
pagination からやり直す。先頭 page だけの再取得、前 round の pagination union 又は parsed item の再利用は禁止する。
一致した round だけが coverage/replay へ進む。4 round 全てが不一致なら
`headStabilityLimitExceeded` とし、§3.7 の background retry へ渡す。

before、body、after のどこで list throw、`status:"error"`、途中 page error が起きても当該 round は commit せず
attempt を `listUnavailable` で終える。primary WebSocket ingress は停止しない。

### 3.3 body identity、replay clock、決定的順序

before の全 item を Telegram Data v1 から `id` と `url` で取得する。body failure、parse-failed、又は本文と
list head の type/EventID/reportDateTime/serial/infoType 不一致は staged 全体を捨てる。Serial は list/body の
numeric valid 同士なら presence/raw/numeric を exact 比較し、policy が許す `null` / `""` は一つの missing marker に
normalize して両側 missing を一致とする。片側だけ missing は `bodyIdentityMismatch` とする。本文が成功した item も
後続失敗より前に holder/gate へ適用してはならない。
`TelegramBodyResult.kind === "failed"` は `bodyUnavailable` と元の `bodyReason`、request budget 超過は
`bodyFetchLimitExceeded`、parse-failed は `parseFailed`、その他の list/body identity 不一致は
`bodyIdentityMismatch` とする。

各 parsed item は replay 前に火山 repair と同じ clock predicate を満たさなければならない
（`src/engine/startup/volcano-initializer.ts:780-794`）。

```ts
Number.isSafeInteger(receivedAtMs)
  && Math.abs(receivedAtMs) <= 8_640_000_000_000_000
  && receivedAtMs <= nowMs + FUTURE_REPORT_DATETIME_SKEW_MS
  && reportDateTimeMs != null
  && Number.isSafeInteger(reportDateTimeMs)
  && Math.abs(reportDateTimeMs) <= 8_640_000_000_000_000
  && reportDateTimeMs <= receivedAtMs + FUTURE_REPORT_DATETIME_SKEW_MS
```

境界ちょうどは許可し、+1ms は `replayTimeInvalid` とする。この検査が全 item で完了するまで
`processTsunami()` を一度も呼ばない。これにより replay の `gate.decide()` が遠未来 receivedAtMs で他 family を
sweep することを防ぐ。

revision conflict の検証だけを EventID ごとに行う。同一 EventID の各 item pair を shared
`compareTsunamiRevisionIdentity()` で比較し、一組でも unordered なら `unorderedReplayRevision` とする。同じ
ReportDateTime で両 Serial が missing なら policy に従い equal、片側だけ missing は unordered である。同一 revision・
同一 InfoType の semantic payload が異なる二 item は、id で勝者を決めず `equalRevisionPayloadConflict` とする。

実 replay は EventID group を連結せず、選択済み staged item 全体を次の total order で oldest-to-newest に並べる。

1. `receivedAtMs` 昇順。
2. 同一 `receivedAtMs` で EventID が異なる場合は、id の code-unit 昇順だけで決定化する。
3. 同一 `receivedAtMs`・同一 EventID の場合だけ、`reportDateTimeThenSerial` 昇順、同 revision は
   persistence と同じ `発表 < 訂正 < 取消`、最後に id の code-unit 昇順とする。

従って transport 上で取消後に遅着した古い続報は取消より後に replay され、revision gate の `stale` で抑止される。
revision 順へ並べ替えて取消より前へ移すことは禁止する。baseline 後の部分取消、unkeyed 続報を含む同 EventID の
全検証済み報を normal/correction/terminal に絞らず replay 対象にする。
EventID ごとの「最新報又は終端報」は、候補一件を先に選ぶのではなく、この global replay 後に gate が保持する最後の
accepted revision/terminal decision として確定する。

### 3.4 共有 gate binding、REST anchor、coverage

`standby-persistence.ts:5682-5726` の `tsunamiActiveMatchesGate()` と、同 revision comparator / InfoType
precedence を `src/engine/messages/tsunami-persistence-identity.ts`（新規）へ切り出す。persistence と initializer
は同じ exported helper を使い、private 複製を禁止する。helper は次の現行契約を変えない。

```ts
export function tsunamiActiveMatchesGate(
  active: ParsedTsunamiInfo,
  gateEntry: PersistedTelegramRevisionGateEntryV2,
): boolean;
export function compareTsunamiRevisionIdentity(
  incoming: TelegramRevision,
  current: TelegramRevision,
):
  "newer" | "equal" | "older" | "unordered";
export function tsunamiInfoTypePrecedence(
  infoType: TelegramRevision["infoType"]["value"],
): 0 | 1 | 2;
```

- exact EventID subject の non-cancel gate は holder と同 revision、又は `reportDateTimeThenSerial` で holder
  以上なら結合できる。後者は部分取消・照合不能取消・unkeyed 通常続報で gate だけ進む正当な状態である。
- 同一日時で Serial が片側だけ欠落する組は unordered。legacy `tsunami:current` fallback は persistence reader
  だけが使い、startup canonical coverage の anchor には使わない。

attempt entry で holder と `revisionGate.exportDurableEntries()` の baseline を read-only capture する。同時に、その時点の
VTSE41 projection を commit epoch として capture する。projection は holder snapshot の
`currentLevel`、`lastInfo`、`keyedForecasts`、`eventInfos`、`legacyRestoredInfo`（配列順を含む）と、gate snapshot の
`tsunami:VTSE41:*` 全 state entry、及び `domain:"tsunami", revisionFamily:"VTSE41"` の全 transient entry とそれに対応する
`transientSemanticKeys` を切り出した構造である。entry と `semanticKeys` の配列順も identity に含め、sort で差を隠しては
ならない。holder の `observationGroups`、他 revision family、owner/version counter、warning latch は含めない。
coverage target は、(a) `getPersistedKeyedActive()` の各 EventID と shared helper で結合した exact non-cancel
gate、及び (b) holder にまだ無い exact non-cancel VTSE41 gate（gate-only reconstruction）の和集合である。
holder が gate と結合できない、同 subject に複数 baseline gate がある、又は cancelled gate と holder が
同居する場合は `baselineGateMismatch` とする。

各 coverage target には、stable before/after window と本文の双方で検証済みの REST anchor item を一件必須とする。
baseline の `acceptedAtMs` が coverage start 未満なら、anchor 探索前に `baselineOutsideRestoreWindow` とする。
anchor は baseline gate の次を全て exact に一致させる。

- EventID と canonical `stateSubjectKey = tsunami:<EventID>`。
- reportDateTime の raw/epoch、Serial の canonical identity（numeric は presence/raw/numeric exact、policy 許可の
  `null` / `""` は missing marker）、InfoType の raw/value。
- `strictRestReceivedTimeMs(item.head.time) === gate.acceptedAtMs`。

holder-backed target は anchor 自体と、`receivedAtMs >= gate.acceptedAtMs` の同 EventID の全検証済み報を、
ReportDateTime の新旧を問わず replay set に入れる。従って取消後に transport 上で遅着した古い続報も入力へ残り、
§3.3 の受信順で取消より後に replay されて `stale` になる。persisted holder/gate があるのに anchor が無ければ、
REST が空の場合を含め `coverageMissingPersistedEvent` で fail-closed とする。「一覧に新報が無いから baseline が
最新」と推定することは禁止する。

gate-only target は anchor の存在だけで complete にしてはならず、target ごとに次のいずれか一方を証明する。

1. **direct base**: anchor 自体が non-cancel の full keyed snapshot 又は全解除であり、baseline gate の semantic
   payload と一致する。その baseline gate を seed した空 holder へ duplicate replay した結果、
   `hasPersistedEvent(eventId) === true` になる。全解除は aggregate `lastInfo` が null でも canonical `eventInfos` が
   存在するため、この条件を満たす。
2. **isolated base trace**: window 内で anchor 以前の full keyed snapshot 又は全解除を reconstructible base とし、
   base から anchor までの同 EventID の全 item（部分取消、unkeyed 通常報を含む）を欠落なく replay set に加える。
   transactional scratch holder は最新 baseline holder の clone、scratch gate は当該 gate-only subject の baseline entry
   だけを clone snapshot から一時的に除いたものとする。全 EventID 共通の §3.3 global order で scratch へ replay し、
   anchor input は、capture 済み baseline entry を seed した別の read-only gate に対する
   `matchesCurrentAcceptedPayload(anchorInput) === true` も満たさなければならない。これにより revision tuple が同じでも
   baseline の最後に受理した semantic payload と異なる anchor を拒否する。そのうえで、anchor 到達直後に生成された gate の
   `(EventID, reportDateTime raw/epoch, Serial canonical identity, InfoType raw/value, acceptedAtMs, cancelled:false)` が
   baseline gate と exact に一致し、かつ `hasPersistedEvent(eventId) === true` なら proof 成功とする。その場で生成 entry
   だけを capture 済み baseline entry へ戻してから、同 subject の anchor 後 item を続ける。これは baseline の durable/
   semantic metadata を保存しつつ、holder mutation だけを live 相当の global transport order で再構成するためである。

複数 gate-only trace と、その後の全 EventID の replay set は一つの §3.3 global `receivedAtMs` order へ合成し、
EventID 辞書順に連結しない。scratch gate から除くのは isolated proof 対象の exact VTSE41 subject だけで、他 family、
holder-backed target、direct-base target は baseline のまま保持する。direct/isolated のどちらも成立しない部分取消又は unkeyed anchor は
`coverageMissingGateOnlyBase` とし、empty holder のまま complete にすることを禁止する。isolated proof 中の
parse/revision rejection も §3.5 と同じ batch failure であり、proof だけを部分採用しない。

baseline に無い新規 EventID は、§3.3 の total order でその EventID 内の最初の item が次のいずれかなら
coverage を開始できる。

- InfoType が発表又は訂正で、forecast が非空、全 item の Area.Code / Kind.Code が non-blank な full snapshot。
- forecast 空の全取消、又は全 forecast item が keyable かつ active level を一つも持たない全解除。

最初の reconstructible base より前に部分取消、unkeyed 通常続報、又は keyless item が一件でもある場合は
`coverageMissingNewEventBase` とし、その後に full snapshot があっても batch 全体を commit しない。

REST が空で、holder にも exact non-cancel VTSE41 gate にも baseline が無い場合だけ `kind:"noData"` の正常
no-op とする。取消 tombstone だけの baseline は active coverage target に数えない。REST が空で persisted
holder 又は gate-only non-cancel baseline がある場合は必ず `coverageMissingPersistedEvent` である。

### 3.5 EventID 単位 duplicate reconstruction と replay rejection

`TsunamiStateHolder` に canonical `eventInfos` だけを調べる `hasPersistedEvent(eventId: string): boolean` を追加する。
`processTsunami()` の `restoreStateOnDuplicate` は `getLastInfo() == null` をやめ、valid EventID があり
`!hasPersistedEvent(eventId)` のときだけ、non-cancel duplicate/semanticDuplicate payload を再構成する。これにより
gate-only A/B は A 復元後も B を独立に復元できる。取消 payload は従来どおり active state に使わない。

replay は各 item の `onRevisionDecision` を内部配列へ捕捉し、外部 callback を item ごとに呼ばない。

```ts
const result = processTsunami(staged.msg, {
  tsunamiState: scratchState,
  revisionGate: scratchGate,
  restoreStateOnDuplicate: true,
  onRevisionDecision: (decision) => { observedDecision = decision; },
  persistenceAdmission: undefined,
});
```

- `result.kind === "ok"` は accepted decision が一件ある場合だけ成功とする。
- `result.kind === "suppressed"` で許容する decision.kind は `duplicate`、`semanticDuplicate`、`stale` だけとする。
- decision 不在、`parse-failed`、`capacityExceeded`、`invalidMeta`、`invalidRevision`、
  `cancelTargetMismatch` その他の suppression は `tsunamiReplayRejected` とする。

一件でも拒否なら reducer/非 admission scratch を破棄し、batch 全体を状態不変で終える。取消は既存の
EventID 限定 `clearAccepted()`、通常報と全解除は `applyAccepted()` を通す
（`process-tsunami.ts:251-255`）。別 EventID を cross-clear する補正は禁止する。

replay 後・commit 前に全 gate-only target の coverage token を再検査する。direct base は
`hasPersistedEvent(eventId)`、isolated base trace は exact baseline gate entry が scratch へ再装着済みで、かつ
`hasPersistedEvent(eventId)` であることを必須とする。一つでも満たさなければ `coverageMissingGateOnlyBase` として scratch
全体を捨てる。duplicate が suppressed だったという事実だけを postcondition に使ってはならない。

### 3.6 一括 commit と live ingress の順序

list/body の全 await、stability、clock、coverage が成功した後だけ同期 replay/commit を行う。
`persistenceAdmission` がある通常 startup は
`transact("tsunami:VTSE41", ["telegramRevisionGate", "tsunamiState"], ...)` を一回だけ使う。transaction が
await 後の最新 composition を capture する。ただし reducer の最初に、draft の VTSE41 projection と §3.4 の attempt-entry
commit epoch を structural exact 比較する。差があれば scratch の生成・replay より前に予約済み内部 reason
`tsunamiRestoreStaleEpoch` で reducer を reject し、外側では retryable な `staleVersion` へ写像する。無関係な holder field と
他 revision family はこの比較対象にしない。一致した場合だけ draft から作った scratch holder/gate へ全 item を replay し、
全成功時だけ両 snapshot を draft へ戻す。item ごとの transaction は禁止する。

admission 無しでは、全 await 後に最新 holder/gate snapshot と version を capture し、その VTSE41 projection を
attempt-entry commit epoch と replay 前に structural exact 比較する。差があれば replay せず `staleVersion` とする。一致時だけ
scratch へ全 item を replayする。commit 直前に両 version が一致する場合だけ `replacePrevalidated()` で二 ownerを置換する。
一方でも変化した場合と admission の `staleVersion`、上記の `tsunamiRestoreStaleEpoch` は
`kind:"incomplete", reason:"staleVersion"` として scratch を捨て、retryable とする。
従って REST 待機中の live B は古い REST batch に負けず、次 retry はその B を含む最新 snapshot へ rebase する。

coordinator が `kind:"rejected"` を返した場合、予約済み `tsunamiRestoreStaleEpoch` だけは上記どおり `staleVersion` とし、
それ以外の `invalidTouchedOwners`、`reducerException`、`unexpectedOwnerMutation`、serialization/preflight failure、
`logicalGenerationExhausted` その他の reason は全て
`kind:"incomplete", reason:"admissionRejected", admissionReason:<coordinator reason>, retryable:false` へ写像する。
元 reason を捨てること、未知の coordinator reason を ad-hoc な top-level reason に昇格することは禁止する。

gate accepted revision が一件以上ある場合だけでなく、accepted がゼロでも EventID 単位 duplicate reconstruction
で holder snapshot が変わった場合は durable change とする。commit 後の `onAcceptedRevision` は batch につき
exactly 一回、無変更なら0回である。item ごとの callback、失敗 batch の callbackは禁止する。production monitorは
coordinator の `onDurable` を persistence scheduling authority とし、initializer へ重複する callbackを渡さない。

成功 return は batch 後の active `lastInfo` 又は null を持つ `kind:"complete"`、空 baseline/空 REST は
`kind:"noData"` とする。全 failure は理由、page/item/body/round 数、未 coverage EventID を一回 warn し、例外を
startup まで伝播させない。§3.7 の stop/generation 不一致は failure ではなく `kind:"abandoned"` とし、warn しない。

### 3.7 background retry

monitor は retry controller を shutdown handler より先に生成し、その controller 経由で初回 attempt を現在の位置で
await する。retryable incomplete なら primary ingress、REPL、後続 startup を止めず、非重複の background retry を
一件だけ pending にする。既定値は次に確定する。

```ts
export const TSUNAMI_RESTORE_MAX_ATTEMPTS = 8; // 初回1 + background 7
export const TSUNAMI_RESTORE_RETRY_BASE_MS = 5_000;
export const TSUNAMI_RESTORE_RETRY_MAX_MS = 300_000;
// background ordinal 1..7: 5s, 10s, 20s, 40s, 80s, 160s, 300s
```

jitter は入れない。一 instance に `inFlight`、timer handle、`stopped`、単調増加 `generation` を一つずつ持ち、attempt
完了後にだけ次 timer を作る。各 attempt は開始時 generation を capture し、全 list/body `await` の直後、throw の
catch 後、次 request の直前、及び transaction/`replacePrevalidated()` の直前に
`!stopped && capturedGeneration === generation` を照合する。不一致なら staged data を捨てて `abandoned` とし、
commit、callback、warn、次 timer 予約を全て禁止する。

`stop()` は初回だけ `stopped = true`、generation increment、timer clear、pending retry 破棄を同期実行し、二回目以降は
no-op とする。in-flight HTTP を abort できなくても待たず、後で resolve/reject した attempt は上の latch により
`abandoned` になる。
`ShutdownContext` に `stopTsunamiRestoreRetry` を追加し、shutdown handler は最終 persistence 保存
`stopStandbySweep()` より前、かつ自身の最初の async await より前にこれを呼ぶ。これにより最終保存後の mutation を
禁止する（`src/engine/monitor/shutdown.ts:108-138`）。

初回 attempt が retryable に失敗しても timer はまだ作らない。monitor は火山 startup repair block が resolve/reject
して cleanup まで終わった `finally` で `enableBackgroundRetries()` を一度呼び、その時点から ordinal 1 の5秒を数えて
初めて arm する。火山 target が無い場合も同じ lifecycle point で enable する。shutdown 済みなら enable は no-op
である。共有 mutex は採用しない。競合するのは startup の一箇所だけであり、明示した phase ordering の方が steady
state に lock lifecycle を持ち込まず、停止時の ownership も controller 一つに閉じるためだ
（`src/engine/monitor/monitor.ts:1164-1188`）。

timer callback 中の二重起動要求は無視し、同時 REST scan を作らない。timer は `unref()` する。complete/noData/
non-retryable failure で停止し、8回目の retryable failure 後は
`[tsunami-restore] retryExhausted attempts=8 reason=<reason>` を exactly 一回 warn して停止する。各 retry は新しい
attempt、時計、page/body budget で全 window を読み直し、前 attempt の staged state を再利用しない。

`retryable` は次表だけから導出し、call site が上書きしてはならない。

| failure reason / detail | `retryable` |
| --- | --- |
| `listUnavailable`（throw、`status:"error"`、途中 page、before/after scan） | `true` |
| `bodyUnavailable` + `network` / `notFound` / `contentType` | `true` |
| `headStabilityLimitExceeded` | `true` |
| `coverageMissingPersistedEvent`（window 内 baseline anchor 欠落。空 REST を含む） | `true` |
| `staleVersion` | `true` |
| `bodyUnavailable` + `forbidden` / `tooLarge` | `false` |
| `invalidRestoreClock`, `listResponseInvalid`, `pageSizeExceeded`, `pageLimitExceeded`, `itemLimitExceeded` | `false` |
| `duplicateItemId`, `invalidCursorToken`, `cursorTokenLoop`, `listOrderInvalid`, `listItemInvalid` | `false` |
| `bodyFetchLimitExceeded`, `bodyIdentityMismatch`, `parseFailed`, `replayTimeInvalid` | `false` |
| `unorderedReplayRevision`, `equalRevisionPayloadConflict` | `false` |
| `baselineGateMismatch`, `baselineOutsideRestoreWindow`, `coverageMissingGateOnlyBase`, `coverageMissingNewEventBase` | `false` |
| `tsunamiReplayRejected` | `false` |
| `admissionRejected`（`admissionReason` の値を問わない） | `false` |

### 3.8 対象ファイル

- `src/engine/startup/tsunami-initializer.ts` — attempt result、full-window round、body/clock/coverage、replay、atomic commit。
- `src/engine/startup/tsunami-restore-retry.ts`（新規）— timer 注入可能な非重複 retry controller と上限/backoff。
- `src/engine/monitor/monitor.ts` — 初回 attempt、火山 repair 後の retry enable、shutdown wiring。coordinator 利用時の
  重複 persistence callback を渡さない。
- `src/engine/monitor/shutdown.ts` — 最終 persistence 保存より前の retry controller stop。
- `src/engine/messages/tsunami-persistence-identity.ts`（新規）— active/gate binding、revision comparator、
  InfoType precedence の共有 helper。
- `src/engine/display/standby-persistence.ts` — private helper を共有 module へ移し、既存 reader semantics を維持する。
- `src/engine/messages/tsunami-state.ts` — `hasPersistedEvent(eventId)`。
- `src/engine/presentation/processors/process-tsunami.ts` — duplicate reconstruction を EventID 単位へ変更する。
- `test/engine/tsunami-initializer.test.ts` — §5 の attempt/coverage/replay regression。
- `test/engine/monitor/tsunami-rest-restore-retry.test.ts`（新規）— injected timer/clock による retry の決定的試験。
- `test/engine/monitor/shutdown.test.ts` — retry stop が最終 persistence 保存より前になる順序試験。
- `test/engine/telegram-foundation/phase3b-tsunami.test.ts` — shared binding 抽出後の部分取消/unkeyed persistence 回帰。
- `src/dmdata/rest-client.ts` — 変更不要。既存 cursorToken 契約をそのまま使う。
- `docs/specs/telegram-foundation.md` — schema/persistence semantics 不変のため変更しない。実装が意味を変える場合だけ
  §12.1（同 `:1275-1288`）へ coverage 説明を追記する。

## 4. 判断分岐（裁定済み）

### 4.1 ご主人裁定 A（確定）: lookback 7日

`TSUNAMI_RESTORE_LOOKBACK_MS` は7日とし、VTSE41 family の既存 tombstone/capacity horizon
`FAMILY_CAPACITY_TOMBSTONE_RETENTION_MS` とそろえる
（`src/engine/messages/revision-family-registry.ts:149, 823-844`）。これは active state の有効期限ではない。
window 外 baseline は不完全診断へ進み、有限 window を根拠に警報を消さない。

### 4.2 ご主人裁定 A（確定）: coverage 不明は状態不変

anchor 欠落、window 外 baseline、baseline gate 不一致、gate-only/new EventID の reconstructible base 不足を
「継続中」とも「解除済み」とも断定しない。batch 全体を fail-closed とし、holder/gate/callback を不変にして理由を
診断する。既存 active は結果的に画面へ残るが、REST 確認済みとは扱わない。

### 4.3 不採用案

- lookback 30日: 長期停止 coverage は増えるが、本文 request・起動時間・上限到達率を運用実測なく広げるため不採用。
- item 数だけの window: 電文集中度で時間 coverage が変わり、停止区間を説明できないため不採用。
- coverage 不足 EventID を継続中とみなし他 Event だけ commit: 停止中の終端を落とす元の故障を残すため不採用。
- coverage 不足 EventID を削除: 終端報なしに実警報を解除するため不採用。

## 5. 受入条件（機械検証）

全 case は attempt entry の固定 now、holder/gate snapshot、callback 回数、list/body call 列、warn reason を assert する。
失敗 case は二 owner snapshot の before/after を deep equal とする。

1. 空 holder/gate から A/B とも active を復元する。A の EventID を B より code-unit 辞書順で後、B を REST transport
   上の最新にし、`getLastInfo().meta.eventId` と `reportDateTime` が B、keyed snapshot が A/B 両方であることを assert する。
2. persisted A の exact anchor 後に A 全取消、及び別 case の A 全解除を replay し A を消す。B 同居時は B を残す。
3. A 全取消後、ReportDateTime が古い A 続報を新しい `receivedAtMs` で遅着させる。受信順 replay で続報を `stale` とし、
   A の取消 tombstone と終端状態を維持する。
4. A 全取消後の真正に新しい ReportDateTime の A 発表は、新 lifecycle として A を再開する。
5. persisted A より古い続報は `stale` として許容し、新しい persisted A を上書きしない。
6. REST await 中の live mutation と commit epoch を admission 有/無の両方で固定する。
   - gate-only A の isolated proof 中に同一 EventID の live A を前進させる。初回は replay/commit/callback なしの
     `staleVersion` とし、retry は新しい A の exact anchor を含む最新 composition へ rebase して、live watermark を巻き戻さない。
   - 古い新規 REST A の body await 中に、それより後着の live B（別 EventID）を受理する。初回は replay/commit/callback
     なしの `staleVersion` とし、retry は B の exact anchor を含む安定 window から成功させる。keyed snapshot は A/B を持ち、
     `lastInfo` は後着 B のままで、古い A へ戻らない。
7. 二 page 境界で同一 query と cursorToken、全 page newest-first、before/body/after の call 順を固定する。
8. 同一 `head.time`・同一 EventID・同一 revision の発表/訂正/取消を、id 辞書順と逆順の input で各々与える。
   両 case とも `発表 < 訂正 < 取消` となり、id 順に依存せず取消が最終状態になる。
   さらに A/B を同一 `head.time`、EventID の code-unit 順と item id の code-unit 順が逆になる値で作り、input 順を
   A→B / B→A の二通りにする。両方で item id 順だけが tie-break となり、同一の keyed snapshot と `lastInfo` になる。
9. `test/engine/tsunami-initializer.test.ts:891-893` の実採取全解除 fixture（`serial.raw === null`）をそのまま使い、
   list scan validation、body identity validation、replay の三段を通って complete になる。空文字 Serial も同じ policy、
   非空 invalid Serial は `listItemInvalid` になる。
10. 空 REST + 空 holder/non-cancel gate なしは `noData`、空 REST + persisted A 又は gate-only A は
    `coverageMissingPersistedEvent` で状態不変とする。
11. list throw、`status:"error"`、途中 page error、before scan error、after full-scan error を独立 case にし、
    `listUnavailable`、no-commit、retryable を固定する。
12. before/after 不一致では staged を捨てて次 round を full pagination から開始する。一 round 目不安定、二 round 目安定で
    exactly 一回 commit する case と、4 round 不安定後に background retry が成功して process lifetime 中 exactly 一回
    commit する case を持つ。
13. gate-only A/B と空 holder へ A/B の full keyed duplicate anchor を global 受信順で replay し、両方の
    `hasPersistedEvent` を true にする。accepted decision が0でも holder change と callback exactly 一回を assert する。
    gate-only 全解除 anchor も `lastInfo === null` だけで失敗させず、canonical EventID state を復元する。
14. gate-only の部分取消 anchor と unkeyed 通常 anchor を別 case にする。window 内 reconstructible base からの isolated
   trace が baseline gate identity を再現する場合だけ scratch 内に canonical state を再構成して成功し、base 無し又は postcondition
   不成立なら `coverageMissingGateOnlyBase`、全 snapshot/callback 不変とする。同じ reportDateTime・Serial・InfoType だが
   取消対象が異なる REST body の fixture も加え、baseline-seeded gate の `matchesCurrentAcceptedPayload()` 不一致を
   `baselineGateMismatch` として fail-closed にし、holder/gate/callback を不変とする。
15. 二件目以降の body failure、body/list identity mismatch、parse failure、重複 id、token loop、page/item/body/round
    limit、unordered revision、equal-revision payload conflict を各 union reason に対応させ、全て batch no-commit とする。
    body failure は `bodyReason` も assert し、§3.7 の全 reason/detail 行を table-driven test で固定する。
16. replay で `capacityExceeded`、`invalidRevision`、`cancelTargetMismatch` を一件ずつ発生させ、
    `tsunamiReplayRejected`、holder/gate/callback 不変を固定する。`duplicate` / `semanticDuplicate` / `stale` だけは許容する。
17. invalid now、unsafe integer、receivedAtMs/reportDateTime の future skew +1ms は replay 前に拒否し、VTSE41 を含む
    gate snapshot 全体を完全不変とする。clock-valid の境界ちょうど case は、replay 時点で未期限の無関係 family entry を
    seed して不変を assert する。valid replay による期限済み他 family entry の正規 sweep まで不変とはしない。
18. persisted holder より新しい non-cancel gate を部分取消と unkeyed 続報で各々作り、shared
    `tsunamiActiveMatchesGate()` が結合を許可し、その gate tuple に exact 一致する REST anchor から holder-backed
    coverage する。holder/gate 完全一致を要求しないことを固定する。
19. 新規 EventID の full keyed normal/correction、全取消、全解除を base として受理する。先行部分取消又は unkeyed
    続報がある case は、後続 full snapshot があっても `coverageMissingNewEventBase` で no-commit とする。
20. retry controller は fake timer で5/10/20/40/80/160/300秒、最大8 attempt、in-flight 中の非重複、success 時 cancel、
    non-retryable 即停止、`retryExhausted` exactly once を固定する。
21. 初回 retryable failure 後も火山 startup repair の deferred promise が pending の間は timer/scan が0件である。repair の
    resolve と reject を各々行い、cleanup 後に5秒 timer を一件だけ arm してから full-window retry を開始する。
22. body fetch を deferred にした in-flight attempt 中に shutdown する。`stopTsunamiRestoreRetry` が最終 persistence 保存
    より前に一度呼ばれ、body resolve/reject 後も holder/gate snapshot、callback、warn、timer/再予約が全て不変である。
23. coordinator の `kind:"rejected"` を注入する。`admissionReason` に元 reason を保持した non-retryable
    `admissionRejected`、holder/gate の no-commit、callback 0回、top-level warn reason が常に `admissionRejected` であることを
    assert する。予約済み `tsunamiRestoreStaleEpoch` は別 case で `staleVersion` になることも固定する。

## 6. テスト変更

`test/engine/tsunami-initializer.test.ts:245-267` の「最新の VTSE41 一件」と
`listTelegrams("test-key", { type:"VTSE41", limit:1 })` exact assertion は書き換える。これは最新一件が全 EventID の
現況を表すという、今回除去する誤契約を固定しているためだ。既存の本文 id/url、persisted watermark、実採取全解除、
admission live-race は削除せず、structured result と multi-event batch へ期待を更新する。

同 file の helper は `createResponse(items, nextToken?)`、item 別 body/deferred promise、固定 now を扱えるようにする。
§5.1-19、23 を同 file に追加し、list/body mock の未消費 call も assert する。

`test/engine/telegram-foundation/phase3b-tsunami.test.ts:2068` 以降の部分取消 round-trip と unkeyed 続報 case は、shared
helper 抽出後も holder より新しい non-cancel gate を salvage することを維持する。新しい
`test/engine/monitor/tsunami-rest-restore-retry.test.ts` は timer/attempt runner/now/volcano phase latch を注入し、
§5.12/20-22 を実時間 sleep なしで検証する。`test/engine/monitor/shutdown.test.ts` は retry stop と最終保存の呼出順を
固定する。

実装は永続化・共有 owner・module scope の retry state を触るため、`npm run build`、`npm test` に加えて
`npm run test:shuffle` を必須とする。

## 7. ロールバック

persistence schema、revision family policy、REST wire format は不変である。障害時は monitor の retry controller を
`stop()` して generation を無効化し、multi-event attempt と EventID 単位 duplicate reconstruction を同じ change set で
戻せる。ただし単一 latest item へ戻すと停止中の別 EventID 終端を復元できない既知欠陥を再導入するため、通常の運用回避には
使わない。

body/coverage/stability 失敗時は persisted active を手動削除しない。固定 reason と retry exhaustion を観測し、7日 window 又は
256 item/body 上限の不足を実測した場合は、上限変更を別の裁定・spec で行う。
