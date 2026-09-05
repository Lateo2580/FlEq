# 線状降水帯 BriefingCard — 発生による直前予測 entry 置換（裁定待ちドラフト）

> **裁定（2026-09-06 朝、ご主人）**: §3 の裁定点はすべて推奨案を採用。独立 DOC レビュー（Sol high、新規 read-only スレッド）2 巡で DOC-OK。


- 状態: **裁定待ち（独立 DOC review 必須修正 8 点と再レビュー残点 3 点を反映済み）**
- 起源: 2026-09-05 の実機観測。同一地域の VPBS50「3 時間以内に発生のおそれ」と「発生」が BriefingCard に同時に残った。
- 対象: `VPBS50` の **BriefingCard 表示 projection** に限る、`linearRainPredicted` → `linearRainObserved` の地域単位の置換と、その遅着防止状態。
- 既存仕様との関係: [`2026-08-28-briefing-card-overhaul.md`](./2026-08-28-briefing-card-overhaul.md:32) の raw EventID、transport dedup、ticker・通知・CLI、VPOA50 相関、取消 TTL、`ReportDateTime + Serial` 比較を維持する。この文書は同 spec の表示用 semantic subject 規則（同:43-74）へ加える狭い改訂であり、全面置換ではない。

## 1. 症状

同一 `EditorialOffice`・同一 `Area.Code` について、直前予測（「3 時間以内に線状降水帯発生のおそれ」）の entry と、後から発表された発生の entry が並ぶ。ご主人が求める可視状態は、発生対象になった地域では予測を消し、発生だけを残すことだ。

VPBS50 の実 fixture はこの規則に必要な入力を持つ。発生は `線状降水帯発生` / `linearRainObserved`、直前予測は `線状降水帯直前` / `linearRainPredicted` として parser が分け、各地域を `Name` と `Code` で運ぶ（`src/dmdata/briefing-parser.ts:50-64`, `src/dmdata/briefing-parser.ts:159-169`, `src/dmdata/briefing-parser.ts:438-509`）。Pi corpus でも富山の発生 `西部/160020` と予測 `東部/160010, 西部/160020`、石川の発生 `加賀/170010, 能登/170020` と予測 `能登/170020` が確認できる（`test/engine/display/briefing-corpus-0827.test.ts:20-87`）。

この corpus は予測が発生より後の実例も含む。ゆえに「同じ地域なら常に発生が予測を消す」とはせず、厳密な revision 比較で発生が新しい場合に限る。

## 2. 根因（コード・corpus 確認済み）

- 現行の semantic key は `card:vpbs:semantic:${phenomenonKind}:${editorialOffice}` である（`src/engine/display/standby-state-store.ts:3132-3145`）。予測と発生は別 `phenomenonKind` のため、同一地域でも必ず別 key になる。
- candidate は既知 tag がちょうど一つならその kind の key を作る（同:3456-3473）。その後の lifecycle は candidate 自身の semantic key の watermark と entry だけを比較・更新し（同:903-917, 920-972）、対になる `linearRainPredicted` を検索・縮退する規則を持たない。
- BriefingCard は structured VPBS50 では target region と event fact を表示する。region は `entry.targetAreas`、event fact は `summary.items[].facts` から独立して描画されるため（`display/frontend/src/components/BriefingCard.svelte:323-340, 495-506`）、地域の部分置換では両方を同じ code 集合で縮退しなければ、消した地域が fact だけに残る。
- critical lifecycle は semantic watermark、entry、raw alias を別々に保持する（`src/engine/display/standby-state-store.ts:379-389, 2760-2845`）。`briefingCritical` は entries / cancellations / watermarks / rawAliases を保存・検証する（`src/engine/display/standby-persistence.ts:300-393, 4721-4846`）。従って画面上の予測を消すだけでは、再起動後の遅着予測を防げない。

## 3. 変更

### 3.1 用語と適格性

`O` を到着した **発生** candidate、`P` を同一 `EditorialOffice` の既存 **予測** semantic entry とする。地域集合は `targetAreas[].code` の非空文字列を重複除去した集合とし、地域名で照合してはならない。

watermark の適格性と、既存 `P` を縮退・削除する適格性を分離する。

1. **watermark 適格な `O`**: 非取消、kind がただ一つの `linearRainObserved`、`InfoType` が `発表` または `訂正`、strict `ReportDateTime + numeric Serial`、非空 `EditorialOffice` を持つ。加えて、現行 observed subject の semantic watermark、raw provenance、raw alias を含む通常 lifecycle 判定を通り、初回作成または strictly newer な更新として candidate 自身が正式に accepted / upsert されていなければならない。`codes(O)` は非空 code だけを地域別に採用し、既存 `P` の有無や revision は watermark 適格性へ含めない。
2. **置換適格な `P`**: kind がただ一つの `linearRainPredicted`、strict revision、非空 `EditorialOffice` を持つ semantic entry である。summary は `structured`、item は `linearRainPredicted` 一つだけ、全 event fact の `areaCode` は非空であり、fact code 集合と非空 target code 集合が完全一致しなければならない。
3. **既存 `P` の置換条件**: `O.revision > P.revision` の場合だけ `P` を縮退・削除する。`P` が不在、`P` が同値・newer・unordered、または `P` の fact invariant が不成立でも、正式受理済み `O` の非空 code に対する watermark は作る。

従って、空 store に `O(A,t=11)` が先着しても `A@t=11` の watermark を作り、後着する `P(A,t=10)` を抑止する。一方、rejected / equal replay / same-revision payload conflict の `O` は正式受理ではなく、watermark と `P` の双方を一切変えない。

unknown / mixed kind、raw-headline fallback、空官署、VPOA50 の `O` は fail-open とし、本規則の watermark も置換も行わない。`O` の空 code はその code だけを無視する。置換不適格な `P` は表示を維持するが、独立に適格な `O` の watermark 作成は妨げない。既存 entry の `phenomenonKind` を変えない原則（`docs/specs/2026-08-28-briefing-card-overhaul.md:54-72`）も維持する。

### 3.2 裁定 1 — 対象地域の一致範囲

`I = codes(P) ∩ codes(O)` とする。

#### 案 A: 完全一致だけ entry 全体を削除

`codes(P) === codes(O)` のときだけ予測 entry を消し、部分一致・包含・非重複は何もしない。

- 利点: entry を縮退しない。
- 欠点: 実観測の「予測 {東部, 西部} → 発生 {西部}」で西部の予測が残り、症状を解けない。

#### 案 B: code 差集合へ縮退（推奨）

- `I = ∅`（非重複）: `P` を維持する。
- 完全一致: `P` を削除する。
- `codes(O) ⊂ codes(P)` または部分一致: `P` を `codes(P) − I` へ縮退し、残存 target code 集合に含まれる event fact だけを残す。`O` はそのまま全地域を表示する。
- `codes(P) ⊂ codes(O)`: `P` を削除し、`O` の追加地域もそのまま表示する。

これは一つの予測 entry が複数地域を持つ実 XML に対し、置換対象外の地域を消さない唯一の案だ。structured VPBS50 は headline を表示しない経路なので（`display/frontend/src/components/BriefingCard.svelte:323-340`）、`targetAreas` と event facts を同時に code 差集合へ射影しても可視文言の偽りを生まない。target と fact は別 XML 経路で、fact code は nullable であるため（`src/dmdata/briefing-parser.ts:263-274`, `src/engine/display/standby-state-store.ts:3323-3337`）、両 code 集合が一致しない `P` と raw-headline fallback は entry 全体を fail-open で維持し、部分射影しない。

#### 案 C: 交差したら予測 entry 全体を削除

- 利点: 実装は小さい。
- 欠点: 予測だけが残る地域まで消し、誤抑制になる。

### 3.3 裁定 2 — 発生後に遅着した古い予測

#### 案 A: entry の既存 watermark だけを使う

予測 subject の watermark と比べる。発生が予測 subject を消した後は、発生 revision を予測 subject の watermark に流用する。

- 利点: state field を増やさない。
- 欠点: watermark の意味（その semantic subject が受理した revision）を壊し、地域単位にできない。

#### 案 B: 発生による地域別 replacement watermark を追加（推奨）

`linearRainForecastReplacementWatermarks` を engine の表示専用 state として追加する。key は `EditorialOffice + Area.Code`、値は発生側の strict revision と expiry である。§3.1 の watermark 適格な `O` を正式受理した後、既存 `P` がなくても、`codes(O)` の各 code に、その code の既存値より strictly newer な revision だけを記録する。expiry は現行 semantic watermark と同じ `acceptedNowMs + BRIEFING_CARD_TTL_MS` とする。

予測 candidate を適用する前に、その target code ごとにこの watermark と比較する。candidate revision が watermark 以下の code は projection から除外する。全 code が除外された candidate は entry を作らず、既存のより新しい state を変更しない。strict revision が watermark より新しい code は通常どおり通す。

`ReportDateTime` を先、同値なら numeric `Serial` を後に比較する既存の意味（`docs/specs/2026-08-28-briefing-card-overhaul.md:66-72`）をそのまま使う。equal observed replay と同値 payload conflict は observed lifecycle 自体が no-op / rejected なので、replacement watermark の revision・expiry、`P`、generation を変えない。これにより、再起動の前後を問わず古い予測で発生後の状態へ戻らない。

#### 案 C: 受信順だけで抑止

- 利点: 実装が小さい。
- 欠点: WebSocket の遅着・再送・再起動で順序が失われるため採用しない。

### 3.4 裁定 3 — 発生側の取消・訂正・期限切れ

#### 案 A: 取消・訂正・期限切れで予測を復活する

発生 entry の取消、訂正、または TTL 終了時に、先に縮退した予測を戻す。

- 利点: 「発生が消えたら予測を戻す」という見かけの対称性がある。
- 欠点: 予測は過去の可能性情報であり、元の raw state を復元する contract もない。取消 10 分 TTL と通常 TTL の組合せで古い予測を誤復活させる。

#### 案 B: 予測を復活しない（推奨）

- 発生取消は既存の cancel 対象解決と 10 分 TTL のままとし（`src/engine/display/standby-state-store.ts:1160-1300`）、replacement watermark を短縮・削除しない。
- 発生訂正は、strictly newer で正式受理された訂正に列挙された非空 code だけ、revision と expiry を `acceptedNowMs + BRIEFING_CARD_TTL_MS` へ前進させる。訂正から外れた code の watermark は revision も expiry も更新せず、古い予測も復活させない。
- 発生 entry または cancel entry が期限切れになっても、replacement watermark は独立して full briefing TTL まで残し、その後は通常の prune で消す。

発生後の予測再表示は、次節の新しい予測だけで起こる。これが「取消は過去の予測への巻戻しではない」と、遅着保護を両立する。

#### 案 C: 取消時だけ復活する

- 欠点: 取消電文だけで過去の forecast payload を再生する根拠がなく、A と同じ stale resurrection を作る。

### 3.5 裁定 4 — 同地域の新しい予測を妨げない

#### 案 A: replacement watermark の expiry まで、同地域の予測を全抑止

- 利点: 重複は起きにくい。
- 欠点: 新しい事象の予測まで隠す。

#### 案 B: strict revision が watermark より新しければ通す（推奨）

後の `ReportDateTime`、または同時刻でより大きい numeric `Serial` を持つ予測は、同一地域・同一官署でも通常の `linearRainPredicted` subject として表示する。複数地域の candidate は code ごとに異なる floor と比較し、通る地域と対応 fact だけで一つの projection を作る。全地域が blocked なら、既存 prediction entry、prediction semantic watermark、replacement watermark、generation を一切変えない。

#### 案 C: `EventID` が違えば通す

- 欠点: VPBS50 EventID は続報・再送でも変わり得るため、時刻順序の保護にならない。

### 3.6 裁定 5 — critical 永続化・watermark・raw alias・再起動

#### 案 A: replacement watermark を memory のみで持つ

- 利点: persistence schema を変えない。
- 欠点: 再起動後に遅着した古い予測を抑止できない。

#### 案 B: `briefingCritical` の additive durable slice として保存する（推奨）

`PersistedBriefingCriticalStateV1` に optional `linearRainForecastReplacementWatermarks` を追加する。各要素は `editorialOffice`, `areaCode`, `revision`, `expiresAtMs` を持つ。writer/reader は既存 entries・cancellations・watermarks・rawAliases と同様に、strict revision・非空 key・上限・一意性・canonical sort を検証する（`src/engine/display/standby-persistence.ts:4721-4838`）。旧 snapshot で field 欠落は空集合として読み、空集合は writer でも field を省略する。

store の snapshot / clone / restore / prune / durable fingerprint に同 state を含める。admission coordinator は store field の変化を既存 `standby:briefingCritical` durable key として保存する（`src/engine/display/standby-persistence-admission.ts:221-240, 852-860）。raw alias は raw EventID lineage の canonical 化専用であり、replacement watermark に流用・共通化しない。既存 raw alias と既存 semantic watermark の意味も変えない。

上限は新定数 `BRIEFING_LINEAR_RAIN_FORECAST_REPLACEMENT_MAX_AREAS = 512` とする。これは既存 semantic watermarks 512、raw identity union 512（`src/engine/display/standby-registry.ts:17-19`, `src/engine/display/standby-persistence.ts:4587-4589`）とは **共有・合算しない独立上限** である。同じ `(EditorialOffice, Area.Code)` の更新は新規枠を消費しない。§3.8 の事前 maintenance prune で expired key を物理削除した **post-prune baseline の map size** と、`O` が必要とする全新規 key を commit 前に数える。expired key を map に残したまま計数対象からだけ除外してはならない。合計が 512 を一件でも超える場合は replacement side-effect bundle 全体を no-op にし、既存 watermark の一部更新、`P` の一部縮退、新規 key の一部追加を禁止する。

容量不足でも、安全上重要な正式受理済み observed entry 自体は通常 lifecycle の結果として一回だけ表示・永続化する。予測 entry は変更せず、replacement watermark は一件も追加・更新せず、capacity diagnostic を一回記録する。observed lifecycle 自体の容量不足などで `O` が rejected なら、observed entry を含む全 mutation を行わない。

all-domain capacity manifest には独立最大数 512 と pair byte 実測を追加する。既存 raw alias と semantic watermark の意味・上限は変えない。

#### 案 C: raw EventID alias を全 VPBS50 の共通 identity に拡張する

- 欠点: card-only projection を transport / raw identity 基盤の再設計へ膨張させる。禁止する。

### 3.7 裁定 6 — カード以外の表示面

#### 案 A: ticker・通知・CLI も発生時に予測を削除する

- 利点: すべての画面の見かけを揃えられる。
- 欠点: 各面は raw event identity / TTL の別契約であり、過去通知・CLI 出力を表示 projection の都合で改変することになる。

#### 案 B: BriefingCard だけを変更する（推奨）

`StandbyStateStore` の browser-card projection とその durable state だけを変更する。ticker、通知、CLI、transport dedup、raw EventID、revision gate、VPOA50→VPBS50 reconcile は既存契約を維持する。`applyBriefingCardEvent` が「browser-card projection only」であることとも一致する（`src/engine/display/standby-state-store.ts:846-850`）。

### 3.8 observed 受理と置換副作用の原子性

`O` の処理は maintenance と candidate transaction の二段として扱う。candidate transaction は prospective state 上で計画し、外部から一つの commit としてだけ観測可能にする。適用順を次で固定する。

1. `applyBriefingCardEvent` は現行どおり candidate lifecycle の判定・適用前に `pruneBriefingLifecycle(nowMs)` を実行する（`src/engine/display/standby-state-store.ts:858-861`）。これは candidate とは論理的に独立した maintenance mutation で、expired entry / watermark を物理削除する。明示的 `sweep` も同じ expiry 規則を使う。以後の容量計算と不変性比較は、この **post-prune state** を baseline とする。
2. candidate shape と nested capacity を検証し、現行の raw provenance / alias 分岐、observed semantic watermark、revision / payload conflict 判定を使って observed lifecycle の prospective result を作る。
3. observed lifecycle が rejected / older / unchanged / equal replay / same-revision payload conflict なら、その plan を破棄する。この candidate による entry、既存 `P`、全 replacement watermark、view/durable generation、callback は post-prune baseline から完全不変とする。事前 prune が state を変えた場合、public mutation result と callback は maintenance 分だけを正しく報告してよい。
4. observed lifecycle が正式受理なら、`O` entry、必要な replacement watermark、`O.revision > P.revision` を満たす全 `P` 差集合を同じ prospective state に作る。§3.6 の replacement 容量を満たす場合だけ三者を一 commit する。
5. replacement 容量だけが不足する場合は、同じ transaction で通常の `O` entry だけを commit し、replacement side-effect bundle は全-or-nothing で捨てる。中間状態や地域ごとの部分 commit は作らない。

これにより、受理済み `O(A,t=12)` がある状態へ遅着 `O(B,t=11)` や同 revision conflict が来ても、表示中の `P(B,t=10)` と durable state は変わらない。

### 3.9 replacement watermark の TTL 境界

- 有効区間は `nowMs < expiresAtMs` とする。`expiresAtMs - 1` では古い予測を抑止し、`nowMs === expiresAtMs` では次の candidate より先の maintenance prune、または明示的 `sweep` が物理削除する。
- equal observed replay は revision、expiry、entry、generation を更新しない。
- strictly newer として正式受理された発生・訂正だけが、列挙した code の revision と expiry を前進させる。
- 訂正で列挙されなくなった code の expiry は延長しない。
- expiry は過去の entry を復元しない。expiry 時点以後に到着した、candidate 自身の TTL 内にある新しい予測は通常経路を通る。

### 3.10 独立 DOC review 指摘の採否

1. **a) 採用。** watermark 適格性と既存 `P` の置換適格性を §3.1 で分離し、`O` 先着を §5 で固定する。
2. **a) 採用。** 正式受理後だけ副作用を作る単一 commit と、rejected candidate 完全不変を §3.8 で固定する。
3. **a) 採用。** 地域別に異なる floor を一 candidate が踏む試験を §5 に追加する。
4. **a) 採用。** 独立上限 512、非合算、事前予約、容量不足時の replacement 全-or-nothing と observed fail-open を §3.6 に固定する。
5. **a) 採用。** target / fact code 集合一致を `P` の適格条件とし、不一致 fail-open を §3.1–3.2 に固定する。
6. **a) 採用。** watermark-only update / no-op / prune の admission changed-key 試験を §5 に追加する。
7. **a) 採用。** `operational-v1-anonymized.json` の load → restore → export → dual-write → reload / v1 fallback を §5 に追加する。
8. **a) 採用。** expiry 前後、equal replay、newer update、訂正で外れた code の非延長を §3.9 と §5 に固定する。

### 3.11 独立 DOC 再レビュー残点の採否

1. **a) 採用。** expired key は candidate 前の maintenance prune で物理削除し、容量と candidate 不変性はいずれも post-prune baseline を基準にする。
2. **a) 採用。** card mutation の単体検査は `applyBriefingCardEvent`、store callback 回数の検査だけは通知 owner である `applyEvent` を通す。OS 通知は非対象とする。
3. **a) 採用。** operational fixture 往復の同値対象を snapshot 全体ではなく、v2 / v1 それぞれの `briefingCritical` slice に限定する。

## 4. 対象ファイル

- `src/engine/display/standby-registry.ts` — replacement watermark の独立上限 512。
- `src/engine/display/standby-state-store.ts` — observed → predicted の地域差集合 projection、replacement watermark の apply / prune / snapshot / restore。
- `src/engine/display/standby-persistence.ts` — additive persistence type、reader / writer invariant、canonical validation。
- `src/engine/display/standby-persistence-admission.ts` — new store state を `standby:briefingCritical` の変更検出へ加える。
- `test/engine/display/standby-state-store.test.ts` — lifecycle、地域集合、revision 境界、restart の unit tests。
- `test/engine/display/standby-persistence.test.ts` — replacement watermark の writer / reader / malformed / limit / canonical-order tests。
- `test/engine/display/standby-wiring.test.ts` — admission changed-key、watermark-only prune、all-domain maximum の tests。
- `test/fixtures/standby-persistence/standby-all-domain-capacity-expectations.json` — replacement watermark 512 件を含む count maximum と byte 実測。
- `test/fixtures/standby-persistence/operational-v1-anonymized.json` — **変更しない read-only migration fixture**。新 field 欠落の実データ復元に使う。
- `test/engine/display/briefing-corpus-0827.test.ts` — 実 VPBS50 の kind・code が規則入力として保たれる corpus assertion。現 corpus は発生→予測の時系列なので、置換そのものは synthetic event で検証する。
- 必要時のみ `display/frontend/src/components/__tests__/briefing-card.test.ts` — 部分置換の engine wire で、予測から除いた地域が target region / event fact の両方に残らない DOM assertion。

parser、presentation event、protocol DTO、ticker、notifier、CLI、raw alias identity の変更は対象外とする。既存 `it` 名の変更は提案しない。新規の状態遷移 test は意図を表す新しい `it` とし、既存 corpus acceptance 名を改名しない。

## 5. 受入条件（機械検証）

card mutation の単体テストは `StandbyStateStore.applyBriefingCardEvent` を通し、同一 `EditorialOffice`、非空 `Area.Code`、strict revision を持つ synthetic VPBS50 を使う。ただし `onChange` / `onDurable` callback の回数検査だけは、通知 owner である外側の `StandbyStateStore.applyEvent` を通す（`src/engine/display/standby-state-store.ts:845-850, 3066-3087`）。ここでいう callback は store 内の change / durable callback だけで、OS 通知・notifier は本 spec の非対象である。時刻 `tN` は strict revision の `ReportDateTime` 順を表す。各検証は card snapshot、store snapshot、durable export、restore 後の snapshot と generation を必要範囲で読む。

1. **`O` 先着**: 空 store → `O(A,t=11)` → `P(A,t=10)` の順に適用すると、`O` 受理時点で `A@t=11` watermark が作られ、後着した `P` entry / fact は 0 件のままである。
2. **完全一致**: `P(A,t=10)` → `O(A,t=11)` で予測 entry / fact は 0 件、発生 entry / fact は 1 件になり、`A@t=11` watermark を保存する。
3. **部分一致**: `P({A,B},t=10)` → `O({A,C},t=11)` で、予測 entry は `{B}` と `B` fact だけ、発生 entry は `{A,C}` とその facts だけを持つ。`A` の予測 fact、`B` の発生 fact、`C` の予測 fact は 0 件である。frontend DOM でも同じ region / fact 不在を確認する。
4. **包含・非重複・官署境界**: `P(A)` → `O({A,B})` は `P` を全削除する。`P({A,B})` と `O(C)` は `P` の表示 payload を byte-for-byte 維持する。別 `EditorialOffice` の同 code も維持する。
5. **target / fact invariant**: `P` が `{target:A,B; facts:A,B,X,null}`、fact code 欠落、または target / fact code 集合不一致なら `P` を一切縮退しない。正式受理済み `O` の watermark は独立して作る。整合した `P` では残存 target code に含まれる facts だけを残す。
6. **observed の正式受理と原子性**: expired state がない前提で、`O(A,t=12)` 受理済み、`P(B,t=10)` 表示中に遅着 `O(B,t=11)` を与える。`applyBriefingCardEvent` では candidate result が rejected となり、`P(B)`、replacement watermarks、observed entry、全 durable state、view/durable generation が post-prune baseline から完全不変である。同じ scenario を `onChange` / `onDurable` callback を登録した `applyEvent` 経由でも実行し、callback 増分がともに 0 であることを確認する。`O(A,t=12)` と同 revision・payload conflict を `B` 付きで与えた場合も warn 一回以外は同じ不変性を満たす。
7. **watermark と `P` revision の分離**: `P(A,t=12)` の後に、observed subject としては正式受理される `O(A,t=11)` を与えると、newer な `P` は不変だが `A@t=11` watermark は作られる。その後の `P(A,t=10)` は抑止され、`P(A,t=13)` は通る。unordered `O`、unknown / mixed kind、raw-headline fallback、空官署は watermark も置換も行わない。空 code はその code だけを無視する。
8. **地域別 floor**: `O(B,t=11)`、続いて `O(A,t=13)` から watermark `A=t13, B=t11` を作る。`P({A,B},t=12)` は `{B}` と `B` fact だけを表示し、続く `P({A,B},t=14)` は `{A,B}` と両 fact を表示する。全 code が floor 以下の candidate は、既存 prediction entry、prediction semantic watermark、replacement watermark、全 generation を変えない。
9. **raw lineage 非依存**: 部分置換後、同じ raw EventID と別 raw EventID の双方で旧 prediction revision を遅着させ、削除済み地域を戻さない。raw alias と replacement watermark の identity namespace は共有しない。
10. **取消・訂正**: 発生取消は予測を復活させず、cancel 10 分 TTL と replacement watermark の 120 分 TTL を独立して保つ。strictly newer な発生訂正は列挙 code の revision / expiry だけを前進させ、訂正から外れた code の revision / expiry を変えず、古い予測を復活させない。
11. **TTL 境界**: expiry `E` の `E-1ms` では古い予測を抑止し、`sweep(E)` と `applyBriefingCardEvent(..., E)` の事前 maintenance の双方で watermark を物理 prune する。equal observed replay は revision / expiry / generation を変えず、strictly newer observed は列挙 code の revision / expiry を前進させる。`E` 以後、candidate 自身が未期限切れの strictly newer prediction が通常経路を通ることを確認し、単に古い candidate の TTL 切れだけで緑にしない。
12. **容量と事前 prune**: active replacement watermark 511 件から新規 1 件、512 件から既存 1 件の更新、512 件から新規 1 件を試みる境界と、一つの複数地域 `O` が 512 をまたぐ場合を検証する。加えて、物理 map 512 件のうち一件が `nowMs` で expired の状態へ新規一件を要する `O` を `applyBriefingCardEvent` で与え、事前 maintenance が expired 一件を物理削除してから新規一件を commit し、最終物理件数が 512、途中も 513 にならないことを確認する。上限内は全 key と全 `P` 差集合を一 commit し、post-prune baseline から513件目を要する場合は observed entry だけを通常 commit、既存 replacement watermark と全 `P` は完全不変、diagnostic は一回である。semantic watermark / raw union 各 512 件との非合算も検証する。rejected candidate と同時に事前 prune だけが成立する場合は、candidate state は post-prune baseline から不変で、public mutation / callback は prune 分だけを報告する。
13. **restart**: 発生で予測を置換した durable state を export → 新 store へ restore → 古い予測を適用しても、再起動前と同じ card を保つ。watermark-only state でも同じ結果とする。
14. **persistence validator**: 新 field の round trip、field 欠落の empty fallback、重複 `(editorialOffice, areaCode)`、空 key、不正 revision / expiry、512/513 境界、非 canonical order を writer failure または reader repair として固定する。空配列は canonical write で省略する。all-domain maximum fixture は replacement watermark 512 件を数え、v1/v2 pair の byte 値を実測更新し、max-admissible は lossless reload、count-maximum は byte guard による atomic rejection を維持する。
15. **実 operational-v1 migration**: 変更しない `test/fixtures/standby-persistence/operational-v1-anonymized.json:23-65` を既存 harness（`test/engine/display/standby-persistence.test.ts:4128-4184`）で `load → restore → export → dual-write → reload` する。欠落した新 field は空で、canonical output でも省略され、既存 `briefingCritical` entry / watermark を一件も失わない。pointer assertion でそれらを確認したうえで、`reloadedStore.exportActiveState().briefingCritical` は `writtenV2.briefingCritical` と、`fallbackStore.exportActiveState().briefingCritical` は `writtenV1.briefingCritical` と完全一致する。v2 foundation、writer 管理の `logicalGeneration`、snapshot 全体の同値は要求しない。
16. **admission**: replacement watermark だけの追加・更新で `durableChanged=true`、changed key は `standby:briefingCritical` だけとなる。rejected / equal no-op は durable key を出さず、watermark-only `sweep(E)` は同 keyを一回出す。direct export の試験だけで代用しない。
17. **実 corpus**: 発生・予測とも parser → processor → store の structured summary に到達し、`Area.Code` と event fact `areaCode` が一致することを確認する（既存の `acceptance: $fixture keeps structured lead, condition, chips, and atomic event facts`、`test/engine/display/briefing-corpus-0827.test.ts:105-123` を維持）。
18. **全体 gate**: `npm run build`、`npm test`、`npm run test:shuffle`、`npm run typecheck:test` を通す。state / persistence を触るため shuffle は必須とする。

## 6. 裁定ラベル（案）

| 要素 | 案 |
| --- | --- |
| 対象 | VPBS50 BriefingCard の `linearRainPredicted` を、strictly newer な `linearRainObserved` が同一 `EditorialOffice + Area.Code` で置換する表示 projection と durable replacement watermark。 |
| 許容変更 | `standby-state-store` の Briefing lifecycle、`briefingCritical` の additive persistence / validation / restore / prune、同域の unit・persistence・DOM tests。 |
| 禁止変更 | raw EventID / transport dedup / revision gate の共通化、ticker・通知・CLI の identity/TTL、VPOA50 相関、parser の語彙解釈、既存 phenomenonKind の変更、取消での旧予測復活。 |
| 配送先 | **main → personal → Pi**。main で §5 の全 gate と migration / admission を受入後、同一差分を personal、Pi の順に配送する。各段で persistence backup、起動 restore、旧予測遅着と新予測通過を確認する。Pi 実機確認は main acceptance の代替にしない。 |
| ロールバック | 本変更の単一 commit を revert し、main → personal → Pi の順に再配送する。旧 reader は additive field を無視し、新 reader は欠落を空集合として読む。保存済み watermark は表示 projection にしか作用しない。 |
| 受入条件 | §5 の 1–18。特に正式受理後だけの原子的 commit、部分一致で非対象地域を消さないこと、restart 後の遅着旧予測で逆戻りしないこと、地域別 floor、新しい strictly newer 予測、operational-v1 migration、admission changed-key を満たすこと。 |
