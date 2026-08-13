# 緊急画面: VPWS50 続報の変更内容表示（案 C）

> Status: implementation-ready specification
>
> Decision date: 2026-08-13
>
> Scope: VPWS50 の確定済み続報差分を engine から常設情報ディスプレイの緊急気象パネルへ渡し、短時間だけ構造化して表示する。現況の警報 state、昇格判定、画面モード、通知音の意味は変更しない。

## §根因と目的

### 1. 根因

千葉県レベル5大雨特別警報の運用では、続報受信のたび緊急画面へ遷移・再点灯する一方、画面が示すのは現況だけであった。そのため利用者は「どこが、追加・解除・悪化・緩和・種別変更のどれなのか」を前報との比較なしに判断できなかった。

案 A により `Vpws50StateHolder` は地域コードと現象キーごとの前後値を持ち、`computeDiff` は追加、昇格、降格、解除を `Vpws50AreaChange` と `Vpws50KindTransition` で返す（`src/engine/messages/vpws50-state.ts:236-308`、`src/types.ts:1232-1295`）。しかし現行の display wire は、昇格中 source の `trigger`、`addedAreas`、`activationKey` だけを `weatherPromotion` に載せる（`src/engine/display/protocol.ts:563-619`、`src/engine/display/state-store.ts:126-151`）。`addedAreas` は追加地域の下線用であり、解除・降格・L4→L5・種別変更の説明にはならない。

### 2. 目的

1. 確定した VPWS50 続報の「変更内容」を、現況とは別の短命 DTO として engine→display wire へ追加する。
2. 緊急気象パネルで、現況を常に主情報として残したまま、今回の変更を読めるようにする。
3. Raspberry Pi の無操作常設運用で読めることを第一級とし、タッチ・マウス・hover を必須にしない。
4. 再起動、接続し直し、旧 server との混在で、期限切れの差分を再表示しない。

### 3. 最上位安全要件

**過去の変更内容を、現在の避難判断または現在発表中の警報として誤認させてはならない。**

- 現況は既存 `weatherAlerts` / `weatherPromotion` を唯一の権威とする。変更内容 DTO から現況を復元・補完・昇格判定してはならない。
- 変更内容には必ず `今回の変更` と明示し、現況一覧とは別 surface に置く。解除済み地域を現況一覧へ混ぜない。
- DTO は engine が定めた絶対時刻 `expiresAt` を過ぎたら表示しない。frontend の表示・再接続・アニメーションによって寿命を延長してはならない。
- 新しい確定続報、取消ロールバック、unsafe、再起動のいずれでも、古い変更内容を持ち越さない。

根拠: `weatherPromotion` は demoted を null へ投影し、frontend は null / 非 null だけで主役表示を判断する契約である（`src/engine/display/protocol.ts:606-618`）。変更内容も engine の投影結果を権威とし、frontend が独自に寿命を延長しない。

### 4. 非目標

- VPWW56、竜巻、洪水、地震、津波の差分表示へ一般化しない。本仕様は VPWS50 のみである。
- 緊急画面を差分だけで新規表示・延命しない。`weatherPromotion` が null で気象主役パネルが無い場合、変更内容だけの気象パネルを作らない。
- CLI formatter、通知音、`Vpws50Diff` の通知向け意味、既存の「新規発表／更新発表」バッジを置き換えない。
- 全変更の長期監査・履歴閲覧は扱わない。これは短期の運用補助であり、履歴機能ではない。

## §設計

### 1. 所有境界

`Vpws50StateHolder` は前後 snapshot を比較して差分を作る責務を維持する。`process-weather` は VPWS50 の計算結果を `WeatherOutcome.presentation.weatherDiff` に保持するが（`src/engine/presentation/processors/process-weather.ts:139-159, 193-201`）、現行では VPWS50 分岐で `weatherStateMutationAccepted` が true にならず、`fromWeatherOutcome` も confidence だけを `PresentationEvent` へ写して diff 本体を落としている（`src/engine/presentation/processors/process-weather.ts:40-43, 166-177`、`src/engine/presentation/events/from-weather.ts:52-59`）。案 C はこの欠落配線を補い、**gate 通過済みの authoritative diff** だけを display 用 transient store へ投影する。

```text
VPWS50 accepted revision
  -> Vpws50StateHolder (市町村 x 現象の diff)
  -> WeatherOutcome.presentation.weatherDiff
  -> PresentationEvent.weatherDiff
  -> InfoDisplayHub.ingest()
  -> WeatherChangeDisplayStore (短命・非永続)
  -> DisplayStateStore.snapshot()
  -> SSE DisplayStateSnapshotV1.weatherChange
  -> WeatherEmergencyPanel (現況とは別の「今回の変更」)
```

`WeatherChangeDisplayStore` は `DisplayStateStore` が所有し、`InfoDisplayHub.ingest()` から適用する。monitor 所有や durable seed にはしない。authoritative flag が true の accepted VPWS50 event は create / replace / accepted-unchanged clear の入力とし、flag が false の unsafe VPWS50 event は clear 専用入力とする。suppressed は event 自体が無いため no-op である。根拠: ingest の `stateChanged` と hub の定期 sweep を同じ所有境界で dirty 化でき、display off / runtime 再生成をまたぐ古い差分も保持しないためである。

根拠: state holder の diff は processor を通じて presentation 層へ渡る経路であり、display 用に parser や frontend が独自比較すると revision gate と異なる前報を比較してしまうためである。

### 2. 受理条件と置換規則

`WeatherChangeDisplayStore` が新しい DTO を作ってよいのは、次をすべて満たすときだけとする。

1. source は VPWS50 である。
2. revision gate を通過し、`weatherStateMutationAccepted` が true である。
3. `weatherDiff.confidence === "confirmed"` である。
4. 初回報ではない。
5. 追加・解除・悪化・緩和・種別変更のいずれかが 1 件以上ある。

入力経路ごとの動作は次で固定する。

- **accepted changed**: gate 通過・authoritative mutation 済みで表示対象差分がある。新 DTO を作り、旧 DTO を原子的に置換する。
- **accepted unchanged**: gate は通過して state mutation は成立したが diff が空である。旧 DTO を直ちに clear する。新しい権威報が「変更なし」と確定した後に前報の差分を残さないためである。定期 recap でも同じ扱いとし、寿命を延長しない。
- **gate で suppressed**: `revisionGate.evaluate/decide` が棄却した重複報・未受理訂正などで、processor は `suppressed` を返し `PresentationEvent` も発生しない（`src/engine/presentation/processors/process-weather.ts:92-98, 130-136`）。store へ到達しないため **no-op** とし、既存 DTO を clear も延長もしない。
- **unsafe**: gate の確定 mutation 前に unsafe と判定された報。fail-open 表示とは分離し、既存 DTO を直ちに clear する。
- **初回 accepted / 取消ロールバック**: 比較根拠が無い、または rollback diff を推測できないため clear する。

同一現象・同一地域の変化は 1 DTO item に正規化し、二重に列挙しない。最終的な item 分類の優先順位は `released` / `added`、`upgraded` / `downgraded`、`kindChanged` の順とする。前二者は片側しか存在しない状態、昇降格は危険度の変化、種別変更は危険度が同じまま表示種別が変わった状態だからである。

- `added`: 前報に同じ地域コード・現象キーが無く、現報にある。
- `released`: 前報にあり、現報に無い。
- `upgraded`: 同じ地域コード・現象キーで display severity rank が上がった。L4→L5 はこの分類に含め、前後レベルを item の `before` / `after` で必ず示す。
- `downgraded`: 同じ地域コード・現象キーで display severity rank が下がった。L5→L4 はこの分類に含める。
- `kindChanged`: 上記以外で、同じ地域コード・現象キーの表示種別（kind code または表示ラベル）が変わった。DTO 分類と診断ログには code-only の変化も残すが、利用者向け行は前後の表示ラベルが異なる場合だけ描く。ラベルが同じなら `大雨 → 大雨` のような無意味な表示を抑制する。

根拠: 現行 `computeDiff` は display severity の差だけを昇降格とし、code だけの変化を無変更としている（`src/engine/messages/vpws50-state.ts:246-269`）。案 C は「種別変更」を可視化するため、この最後の無変更経路を明示的に分離する必要がある。

取消ロールバックは差分 item を推測して表示せず、現在の DTO を直ちに clear する。根拠のない「解除」表示より無表示を採るためである。`restorePrevious()` が現在は空の change arrays を返す契約であることとも整合する（`src/engine/messages/vpws50-state.ts:423-493`）。

### 3. 寿命と複数続報

- DTO の寿命は engine 受理時刻から **60,000ms** とする。`issuedAt` と `expiresAt` は ISO 8601 の絶対時刻で wire に載せ、`Date.parse(expiresAt) - Date.parse(issuedAt) === 60_000` を必須 invariant とする。
- 新しい確定続報で新しい DTO ができた時点で、前 DTO は残り時間にかかわらず**原子的に置換**する。待ち行列、履歴、前回との差分との併記は持たない。
- accepted unchanged は表示中 DTO を clear し、gate suppressed は no-op とする。どちらも延長・再点灯しない。
- unsafe、取消ロールバック、DTO 作成対象外の初回報は表示中 DTO を clear する。
- ingest による record の作成・置換・clear は `DisplayStateStore.applyEvent()` の戻り値を changed にし、hub を dirty にする。表示内容の変化を次の別イベントまで送信待ちにしない。
- `DisplayStateStore.sweep(nowMs)` は change store の絶対 TTL を**常に** sweep する。`sweepWeatherPromotions` が false となる SSE 無客区間でも停止させない（hub timer は `src/engine/display/hub.ts:298-315`、store sweep は `src/engine/display/state-store.ts:737`）。期限 clear は changed を返し、hub が `markStateDirty()` して `weatherChange: null` を配信する。
- `DisplayStateStore.snapshot(seq, nowMs)` 自体も `nowMs >= expiresAtMs` なら必ず `weatherChange: null` を投影する。sweep tick 前、遅延 callback、手動 snapshot のいずれでも期限切れを wire に戻さない。
- frontend は既存の毎秒更新 `clock.now` を失効の発火契機として使う。`App.svelte` は `clock.now.getTime()` を `deriveEmergencyPanels(state, nowMs)` へ渡し、`derive.ts` は同じ `nowMs` を `buildWeatherEmergencyInput(snapshot, nowMs)` へ渡す。投影関数は `expiresAt <= nowMs` なら change 部分だけを `null` にする。snapshot 更新が無くても時計 tick だけで再投影され、期限を初めて跨いだ tick で surface が消える。現行 clock は 1,000ms 周期で更新される（`display/frontend/src/lib/clock.svelte.ts:1-14`）ため、表示上の失効遅延上限は 1 tick 未満とする。engine snapshot と frontend の二重失効判定は、SSE 遅延や engine の clear snapshot 未達でも古い表示を残さないためである。

wire の時刻整合性は `generatedAt` を基準に次をすべて満たすこととする。満たさない DTO は frontend が clear する。

1. 3 時刻が parse 可能で有限である。
2. `expiresAt - issuedAt === 60_000ms` である。
3. `generatedAt - 60_000ms < issuedAt <= generatedAt + 5_000ms` である。
4. `generatedAt < expiresAt <= generatedAt + 65_000ms` である。

`issuedAt > generatedAt + 5,000ms` または `expiresAt > generatedAt + 65,000ms` を「未来へ大きく外れた時刻」と定義する。engine 内の同一注入時計から作る値なので通常は `issuedAt <= generatedAt` であり、5 秒は serialization / scheduler 境界だけを許す防御幅である。

60 秒は、無操作画面で一度内容を読める長さを確保しながら、現況と取り違えうる過去情報を長居させない上限である。置換を採るのは、複数続報の差分を積むと、どの変更が現在へ至る経路かを読み手が誤認するためである。

### 4. 既存の昇格装飾との関係

`weatherPromotion.trigger` と `addedAreas` は既存どおり維持する。前者は新規／更新バッジ、後者は現況地域名の下線であり、案 C の DTO と混ぜない。

- `activationKey` は既存の再点灯演出だけに使う。パネル全体の watermark で、source の解除・降格では変わらない（`src/engine/display/protocol.ts:613-619`）。
- 変更内容 DTO は `WeatherChangeDisplayStore` instance の構築時に `crypto.randomUUID()` で一度作る `bootId` と instance-local の単調増加 counter を連結した `changeKey = "<bootId>:<counter>"` を持つ。counter 単独は禁止する。process 再起動だけでなく同一 process 内の display runtime 再生成でも新しい `bootId` になる。frontend はこの値が変わったときだけ変更 surface を差し替える。
- `addedAreas` を wire 予算縮退で優先して残す既存処理（`src/engine/display/http-server.ts:180-212`）は残す。案 C の DTO は別予算を持ち、`addedAreas` の代替にしない。

根拠: 現在の frontend は「今回点灯を起こした source」だけから追加地域装飾を合成し、古い装飾を持ち越さない（`display/frontend/src/lib/weather-panel.ts` の `buildWeatherEmergencyInput`）。変更内容まで同じ鍵に載せると、source ごとの昇格 lifecycle と電文ごとの差分 lifecycle が混線する。

## §DTO/状態機械

### 1. additive protocol

`DisplayStateSnapshotV1` の top level に、次の optional field を追加する。

```text
weatherChange?: DisplayWeatherChangeV1 | null
```

既存の protocol は engine と frontend の同期対象であり、双方の `protocol.ts` が全文一致を検査する（`display/frontend/src/lib/protocol.ts:1-8`）。この field は version 1 のまま追加する。旧 server は field を欠落させ、frontend は欠落を `null` と解釈する。新 server は、record が無い場合も `weatherChange: null` を送る。

根拠: `weatherPromotion` も optional top-level field として旧 server を null 扱いにしている（`src/engine/display/protocol.ts:809-822`）。全 snapshot で欠落値を前回値へ merge しないことで、server 再起動後の消去を保証する。

### 2. DTO の論理形

`DisplayWeatherChangeV1` は次の情報を持つ。これは display 用の値であり、`Vpws50Diff` をそのまま wire へ露出する型ではない。

| field | 内容 |
|---|---|
| `source` | 固定値 `"vpws50"`。他 source の意味を推測しない。 |
| `changeKey` | store instance ごとに一意な `bootId` と単調 counter の連結。process 再起動・runtime 再生成をまたいで同じ値を再発行しない表示差替えキー。 |
| `reportDateTime` | 今回の VPWS50 の発表時刻。`issuedAt` と混同しない。 |
| `issuedAt` / `expiresAt` | engine 受理時刻と 60 秒後。frontend は `expiresAt` を延長しない。 |
| `changes` | 下記 `DisplayWeatherChangeItemV1[]`。空配列の DTO は送らない。 |
| `omitted` | 予算で wire から畳んだ**利用者表示対象 item**の件数をカテゴリ別に持つ。前後ラベルが同一の code-only `kindChanged` は数えない。0 のカテゴリは省略可。 |

各 `DisplayWeatherChangeItemV1` は `areaCode`、`areaName`、`phenomenonKey`、`kind`、`before`、`after` を持つ。

- `kind`: `"added" | "released" | "upgraded" | "downgraded" | "kindChanged"`。
- `before` / `after`: それぞれ存在しない側を `null` にする。存在する側は表示用種別名、kind code、display severity、official alert level を持つ。
- `before` と `after` の表示用種別名は、それぞれ前報・現報から取得する。現行 transition は現報側の `kindShortName` と code/severity 前後値を持つため（`src/types.ts:1232-1244`）、種別変更を分類するために state snapshot / transition へ前報側の表示名も追加する。前後ラベルが同一の code-only `kindChanged` は DTO に残してよいが、frontend の利用者向け行へ投影しない。

DTO に `areaCode` と `phenomenonKey` を残すのは表示名の一致で差分を同定しないためである。現行 snapshot も地域コードと現象キーで state を持つ（`src/engine/messages/vpws50-state.ts:30-42, 195-224`）。

wire では内部の `WeatherSeverity`、`ResolutionSource`、未加工 XML、snapshot history を出さない。表示と監査に必要な前後の表示意味だけを載せ、payload と frontend の責務を有界に保つ。

### 3. engine 状態機械

```text
[empty]
  | accepted changed, confirmed, non-first
  v
[live(changeKey, expiresAt)]
  | accepted changed, confirmed
  v
[live(new changeKey, new expiresAt)]       // 前 DTO を原子的に置換
  | gate suppressed                         // store へ届かない
  v
[live]                                     // no-op、延長しない
  | accepted unchanged / expiresAt / unsafe / rollback / restart / first report
  v
[empty]
```

`DisplayStateStore.snapshot(seq, nowMs)` は live record があり、かつ `nowMs < expiresAtMs` のときだけ DTO を投影し、それ以外は `null` を投影する。既存 snapshot は `weatherAlerts` と `weatherPromotion` をここで集約している（`src/engine/display/state-store.ts:977-994`）ため、同じ snapshot 境界へ置く。

### 4. frontend 状態機械

```text
[none]
  | snapshot has valid, unexpired weatherChange AND VPWS50 contribution exists
  v
[shown(changeKey)]
  | same changeKey
  v
[shown]                                    // timer を更新しない
  | newer changeKey
  v
[shown(new changeKey)]                     // 旧内容を残さず置換
  | field absent/null, clock.now >= expiresAt, VPWS50 contribution absent
  v
[none]
```

frontend は localStorage、sessionStorage、URL、component module scope に change DTO や残り寿命を保存しない。時刻比較に失敗した DTO は `none` とする。根拠不足で古い変更を出すより無表示を採る。

snapshot 内の DTO の存在自体を唯一の frontend state とする。`store.ts` は full `snapshot` と定期 `state` のどちらも `state.snapshot` へ全置換しており（`display/frontend/src/lib/store.ts:78-113`）、change DTO を別 state へ merge・キャッシュしない。snapshot の `weatherChange` が存在すれば validation と期限判定後に表示し、欠落または null なら非表示とする。

reducer に change epoch や「最後に表示した changeKey」を追加しない。panel 局所の key 記憶は同一 DTO のアニメーション再発火抑止だけに使い、表示内容の生存判定には使わない。旧 process の snapshot が切断中に画面へ残っても `clock.now` で期限失効し、新 process の DTO は store-instance UUID を含む `bootId:counter` なので旧 key と衝突せず、DTO 欠落 snapshot は全置換によって即非表示になる。この3条件で安全性が閉じるため、full-snapshot reset epoch は導入しない。

## §表示規則

### 1. 現況と変更内容の視覚分離

`WeatherEmergencyPanel` の既存「何が／どうする／対象地域・区分」は**現況**として残す。主見出しの警戒レベル、行動文、対象地域の意味を変更内容で上書きしない。既存パネルは現況の対象地域をページングし、追加地域を強調する設計である（`display/frontend/src/components/WeatherEmergencyPanel.svelte`、`display/frontend/src/lib/weather-panel.ts:1-57`）。

有効な DTO がある場合だけ、現況タイルの下に独立した `今回の変更` surface を出す。

- ラベルは常に `今回の変更` とする。`現在`、`対象地域`、`避難対象` のような現況と読める語を使わない。
- surface は現況一覧とは別の背景・細い境界・見出しを持つが、主見出しより低い視覚階層にする。
- 各行は `地域名 — 種別: 前 → 後` の順とし、追加は `追加: 後`、解除は `解除: 前` と明記する。L4→L5 / L5→L4 は矢印の両側にレベルと種別を表示する。
- 変更 surface の見出しまたは先頭ラベルに `気象警報（VPWS50）の今回の変更` と source を明示する。現行パネルは VPWS50 / VPWW56 を一枚へ合成するため（`display/frontend/src/lib/weather-panel.ts:237-310, 324-354`）、source を示さない差分は VPWW56 の変化と誤認されうる。
- 前後の利用者向け表示ラベルが同じ `kindChanged` は行にも要約件数にも出さない。診断 DTO が存在しても、表示可能な item が 0 件なら変更 surface 全体を出さない。
- 解除 item は変更 surface にだけ置く。現況の `weatherAlerts`、現況の件数、現況の地域ページへ混入させない。
- `expiresAt` を利用者へ秒数表示しない。表示寿命を残り時間として強調すると、古い差分を読むことが現況判断より重要に見えるためである。

根拠: 現在の `weatherAlerts` は display state snapshot の現況入力である（`src/engine/display/protocol.ts:811-824`）。解除済みの data をそこへ加えると、現発表中と誤認させる。

### 2. 無操作 Pi 運用

変更 surface は表示だけで完結させる。

- hover、クリック、タップ、スクロール、長押しを読むための必須操作にしない。
- 表示中の item は静止させる。自動スクロールの途中で読み手が行を見失う設計にしない。
- 新 DTO の到着時だけ、変更 surface の内容を短い fade で差し替える。`prefers-reduced-motion` では duration を 0 にするが、内容とラベルは省略しない。
- `aria-live="polite"` は変更 surface の見出しと要約の一度の更新に限る。個々の地域名を連続読み上げさせない。

根拠: 現行 `WeatherEmergencyPanel` は `prefers-reduced-motion` の購読値を使い、fade duration だけを 0 にして内容を残す（`display/frontend/src/components/WeatherEmergencyPanel.svelte:249-252, 283-287`）。購読実装も reduced 時にページ送りを止めず、アニメーション状態だけを返す（`display/frontend/src/lib/page-cycler.svelte.ts:101-111`）。Pi の常設画面でも同じ原則を使う。

### 3. 大量変更時の縮退

変更 surface の個別行は **最大 4 件**まで表示する。5 件以上では、個別行の下にカテゴリ別の明示要約を置く。例: `悪化 8件（表示 2件）・解除 17件（表示 1件）`。

個別表示の優先順は次とする。

1. `upgraded`（L4→L5 を先頭）
2. `added`
3. `kindChanged`
4. `downgraded`
5. `released`

同カテゴリ内は現報の出現順を保つ。種別・地域名をソートして電文順を壊さない。解除・緩和を黙って捨てるのではなく、必ず要約件数へ含める。

単純な優先順 slice は禁止する。表示可能カテゴリ数が個別行上限以下なら、各カテゴリ最低 1 件の代表枠を先に予約し、残枠を上記優先順へ配る。カテゴリ数が上限を超える場合は、`upgraded` と `released` が共存すれば normal / compact の双方でそれぞれ最低 1 件を最優先予約し、残枠へ他カテゴリを優先順に 1 件ずつ配る。compact の上限 2 件で 3 カテゴリ以上が共存する場合は `upgraded` 1 件と `released` 1 件を表示し、その他はカテゴリ別要約へ送る。normal で全 5 カテゴリが共存する場合も同じく両者を予約し、残り 2 枠を `added`、表示可能な `kindChanged`、`downgraded` の順へ配る。`upgraded` または `released` が無い場合は、存在カテゴリを優先順で 1 件ずつ round-robin し、上限外を要約へ送る。

wire 縮退は frontend 上限より前に単純 slice してはならない。full DTO は全 item とカテゴリ別総数を保持し、SSE byte budget による縮退でも同じ代表枠予約アルゴリズムを使う。`omitted` は「元のカテゴリ別総数 − wire に残した件数」で計算する。frontend は wire に残った item と `omitted` を合算して要約し、wire 縮退と画面上限のどちらでもカテゴリ消失を隠さない。

4 件は、既存の現況領域を圧迫せず、FHD と 720p の compact slot で 1 行ずつ読める上限である。全件ページングを追加しないのは、60 秒だけの過去情報を読むために現況を隠したり、Pi に操作を要求したりしないためである。DTO wire 側にも同じ順序とカテゴリ別 `omitted` を持たせ、SSE 予算超過時に内容が消えたことを frontend が隠さない。

### 4. compact と panel 不在

- `compact` slot では、個別行を最大 2 件、カテゴリ要約を 1 行に縮退する。現況の警戒レベルと行動文を削らない。
- `WeatherEmergencyPanel` が render されていない場合は DTO を描かない。他の緊急パネルへ差分を差し込まない。
- L5 が全解除されて気象昇格が null となった場合、変更 DTO だけで気象緊急パネルを残してはならない。
- `weatherPromotion.vpws50 == null`、または panel input に live / restored の VPWS50 contribution が 1 件も無い場合は、VPWW56 が active でも VPWS50 change surface を隠す。VPWS50 全解除後に VPWW56 だけで残る合成パネルへ、解除済み source の短命情報を帰属させないためである。
- VPWS50 と VPWW56 がともに active の場合、または VPWS50 差分直後に VPWW56 が再点灯した場合は、VPWS50 contribution が存在する限り source 明示付き surface を表示し、VPWW56 の `activationKey` 変化で change TTL・`changeKey`・内容を更新しない。

根拠: 現行 frontend は昇格 source が無ければ weather panel を出さず、source があるなら中身の同期中でも panel を畳まない（`display/frontend/src/lib/weather-panel.ts` の `buildWeatherEmergencyInput`）。案 C はこの画面モードの権威を変更しない。

## §永続化

### 1. 非永続の原則

`WeatherChangeDisplayStore` の live record、instance-local counter、`bootId`、`changeKey`、`issuedAt`、`expiresAt`、個別 changes、縮退件数は**一切永続化しない**。store 再構築時は新しい `bootId` と empty record で開始する。

VPWS50 state の current snapshot と history は、revision 判定・現在状態の復元のために永続化される（`src/engine/messages/vpws50-state.ts:496-533`）。案 C はそこから過去 diff を再計算して表示してはならない。復元した snapshot に対する次の新規 accepted revision だけが、新しい change DTO を作れる。

根拠: snapshot history は状態の正しさのためのデータであり、いつ利用者がその差分を読んだかを保証しない。再起動後に再計算すると、数分・数時間前の変化を「今回の変更」と偽る。

### 2. restore / reconnect 契約

- display runtime の durable state、promotion persistence、standby persistence へ change DTO を追加しない。既存 `WeatherPromotionPersistedV1` は昇格 record と watermark のための構造であり（`src/engine/display/weather-promotion-store.ts:122-145`）、案 C の保存先ではない。
- engine / display runtime 再起動後、新しい accepted VPWS50 をまだ ingest していない最初の full snapshot は `weatherChange: null` を送る。再起動後すでに新報を受理した場合は、その process で作った有効な新 DTO を送ってよい。
- frontend は full `snapshot` / 定期 `state` の受信時に snapshot 全体を置換し、その snapshot 内の `weatherChange` だけを正とする。欠落、`null`、期限切れ、形の不正はすべて非表示とし、直前 snapshot の DTO を別 state に保持しない。
- frontend の再読込・SSE 再接続では、新 server が送る unexpired DTO だけを表示する。frontend が接続時刻から 60 秒を再計算してはならない。
- frontend と engine の時計差で `expiresAt` が既に過去なら表示しない。§設計 3 の `generatedAt` 数値範囲から外れた未来時刻も clear する。
- display off で runtime / hub が停止したときは transient store を seed へ書き出さない。60 秒以上経過後に display on して作られる新 store は empty であり、off 前の DTO を復活させない。

## §テスト計画

### 1. state / presentation

- 市町村単位で、追加、解除、L4→L5、L5→L4、同 rank の種別変更がそれぞれ 1 item になること。
- 同じ地域・現象の kind code 変更が、追加と解除の二重 item にならないこと。
- 前後の表示名・display severity・official alert level が DTO の `before` / `after` と一致すること。
- accepted unchanged は既存 DTO を clear、gate suppressed の重複報・未受理訂正は no-op、unsafe / 初回 / 取消ロールバックは clear となることを別々に検証する。
- VPWS50 の accepted authoritative mutation だけ `weatherStateMutationAccepted === true` となり、`WeatherOutcome.presentation.weatherDiff` が `PresentationEvent.weatherDiff` へ同一内容で転送され、suppressed / unsafe は authoritative ingest されないこと。
- 正常な続報が旧 DTO を原子的に置換し、60,000ms で clear すること。時計は注入し、wall clock に依存しない。
- ingest の create / replace / clear が hub を dirty にし、次の state snapshot へ即時反映されること。
- SSE client 0 件でも change sweep は停止せず、期限到達で dirty になること。`snapshot(nowMs)` を sweep 前に直接呼んでも期限切れが `null` になること。
- display off 後 60,000ms 以上経過して display on しても、off 前の DTO が復活しないこと。
- `expiresAt - issuedAt === 60_000ms`、`issuedAt` と `expiresAt` が `generatedAt` の許容範囲内にあること。future 境界 `+5,000ms` / `+65,000ms` は受理し、それを 1ms 超えた値は拒否すること。past 側は `issuedAt = generatedAt - 59,999ms` を受理し、`-60,000ms` は expiry 済みとして拒否すること。

既存 `test/engine/messages/vpws50-state*.test.ts` は市町村粒度の diff を扱うため、案 A と同じ fixture を使って前後値を検証する。

### 2. wire / transport

- engine と frontend の `protocol.ts` に同一 DTO 定義があり、既存 protocol sync test が通ること。
- old-server 相当の field 欠落を frontend が `null` と解釈すること。
- 新 server は live record が無い snapshot で明示的に `null` を送ること。
- snapshot 縮退で change DTO の優先 item と `omitted` 要約が整合し、payload 予算を超えても field が途中で壊れないこと。
- upgraded 4 件以上と released 1 件以上が共存する fixture で、wire 縮退後も双方の代表が最低 1 件残ること。単純 slice を使わず、全カテゴリ総数から `omitted` を算出すること。
- `weatherPromotion.addedAreas` の既存保護・下線強調が回帰しないこと。

`http-server` の縮退は現在 weatherAlerts の地域列を段階的に削る（`src/engine/display/http-server.ts:214-274`）。変更 DTO はこの縮退ラダーに独立した一段を持ち、構造の途中切断ではなく item 数縮退だけを許す。

### 3. frontend

- 現況の対象地域と `今回の変更` が同時に存在し、解除地域が現況側に現れないこと。
- L4→L5、L5→L4、追加、解除、表示ラベルが変わる種別変更が日本語ラベルと前後値で読めること。code-only で前後ラベルが同じ `kindChanged` は DTO に残っても行・要約・surface を出さないこと。
- `changeKey` が同じ incremental snapshot では再アニメーション・寿命延長をしないこと。新しい key では旧行を残さず差し替えること。
- 異なる engine process / store instance が同じ counter 値を発行しても `bootId` が異なり、key が衝突しないこと。旧 process の DTO を表示中に切断を挟んでも、旧 snapshot は `clock.now` の期限 tick で消え、新 process の full snapshot に DTO が無ければ snapshot 全置換だけで非表示になり、DTO があれば新 key の内容へ置換されること。
- fake clock を `expiresAt - 1ms` から `expiresAt` へ進め、snapshot・SSE message を一切更新しなくても `deriveEmergencyPanels` の再投影だけで change surface が消えること。気象現況パネル自体は `weatherPromotion` が active なら残ること。
- `expiresAt` 到達、field 欠落、`null`、不正時刻、panel 非表示、SSE 再接続で非表示になること。
- normal / compact で上限を超えた変更がカテゴリ別件数として明示され、悪化と解除の共存時に双方の個別代表が残り、現況の主情報も残ること。
- VPWS50 全解除後に VPWW56 だけ active なら change surface を隠すこと。VPWS50 差分直後に VPWW56 が点灯しても VPWS50 contribution が残る間は source 明示付きで表示し、TTL を延長しないこと。両 source active では VPWS50 の差分だけを VPWS50 明示付きで表示すること。
- `prefers-reduced-motion` でも変更内容が残り、演出だけが止まること。pointer/hover を発火しなくても全内容が読めること。

`display/frontend/src/lib/__tests__/weather-panel.test.ts`、`display/frontend/src/lib/__tests__/derive.test.ts`、`display/frontend/src/lib/__tests__/store.test.ts`、`display/frontend/src/components/__tests__/emergency.test.ts` に、時刻付き純関数投影、snapshot 全置換、DOM 表示を分けて追加する。期限発火テストは fake clock を使い、snapshot 更新なしで `nowMs` だけを跨がせる。

### 4. 実機・画面検証

- Raspberry Pi の通常解像度と 1280×720 相当で、現況一覧と 4 件／2 件縮退の変更 surface が重ならず、クリップされないこと。
- 続報を 60 秒内に連続投入し、常に最新 DTO だけが見えること。
- engine 再起動、frontend reload、SSE reconnect の各後に、再起動前の変更内容が 1 フレームも現れないこと。
- 悪化と解除が同じ続報に含まれる fixture で、双方の代表地域が見え、現況と過去変化を見誤らない文言・優先順になっていること。

## §実装の変更単位

実装は次の依存順とする。各単位が通るまで次へ進まない。

### 1. VPWS50 diff の種別変更情報

対象: `src/engine/messages/vpws50-state.ts`、`src/types.ts`、`src/engine/presentation/types.ts`、対応 unit test。

- 前後 snapshot から、同じ地域コード・現象キーの kind code / 表示名変化を検出できるようにする。
- transition が前後の表示値を完全に持ち、`kindChanged` と昇降格を一意に分類できるようにする。
- `PresentationEvent` に display 内部転送用の optional `weatherDiff?: Vpws50Diff` を追加する。これは engine 内部型であり、display wire DTO そのものではない。

完了条件: 5 種類の差分（追加、解除、L4→L5、L5→L4、種別変更）の unit test が緑で、既存の同一再掲判定が変わらず、code-only の種別変更に前後ラベルが保持される。

### 2. transient change store と presentation 接続

対象: `process-weather.ts`、`events/from-weather.ts`、display hub / `DisplayStateStore` 所有の transient state、対応 unit test。

- VPWS50 の gate accepted 後、state holder mutation が成立した分岐で `weatherStateMutationAccepted = true` を設定する。現行で true になる VPWW56 分岐だけに閉じない。unsafe、suppressed、holder mutation が成立しない経路は true にしない。
- `fromWeatherOutcome` で `outcome.presentation.weatherDiff` を `PresentationEvent.weatherDiff` へそのまま転送する。現行の `weatherConfidence` だけの配線では change ingest に不足する。
- `InfoDisplayHub.ingest()` / `DisplayStateStore.applyEvent()` から VPWS50 event と内部 diff を change store へ渡す。authoritative flag が true の event だけが DTO を create / replace でき、unsafe event は flag が false でも旧 DTO の clear 制御として受ける。monitor の promotion ingest だけに接続しない。
- accepted changed / accepted unchanged / gate suppressed / unsafe / rollback / 初回を §設計 2 の規則どおり apply し、60,000ms TTL と単一 record 置換を実装する。
- store instance ごとの UUID `bootId` と単調 counter から `changeKey` を作る。
- ingest 変更を dirty にし、change sweep を `sweepWeatherPromotions` と独立して hub timer へ接続する。`snapshot(nowMs)` にも期限 guard を置く。
- durable state の export / restore に field を足さない。

完了条件: authoritative flag と diff が processor → PresentationEvent → hub → store まで欠落せず届き、注入時計で全状態遷移・無客 sweep・snapshot guard を再現でき、再起動相当の新規 instance が新 `bootId` かつ empty になる。

### 3. protocol と snapshot / SSE 縮退

対象: engine / frontend 両方の `protocol.ts`、`DisplayStateStore`、`http-server`、protocol sync / http-server test。

- additive field と DTO の runtime validation を同時に追加する。
- snapshot ごとの置換・明示 `null`、`generatedAt` に対する数値時刻検証、item 予算とカテゴリ別 `omitted` を実装する。
- wire 縮退にカテゴリ代表枠を設け、upgraded / released 共存時は双方を最低 1 件残す。単純 slice は禁止する。
- full payload と縮退 payload のどちらでも JSON が有効で、優先 item と要約が一致するようにする。

完了条件: protocol sync、engine snapshot、SSE budget の test が緑で、旧 field 欠落を受ける frontend fixture が緑である。

### 4. frontend 投影と表示

対象: `display/frontend/src/lib/store.ts`、`display/frontend/src/lib/derive.ts`、`display/frontend/src/lib/weather-panel.ts`、`display/frontend/src/App.svelte`、`WeatherEmergencyPanel.svelte`、frontend tests。

- `store.ts` は snapshot 全置換を維持し、change DTO 専用 state、reset epoch、既知 key を追加しない。snapshot 内の DTO の存在だけを権威とする。
- `deriveEmergencyPanels(state, nowMs)` と `buildWeatherEmergencyInput(snapshot, nowMs)` に注入時刻を必須で渡し、DTO の validation と `expiresAt <= nowMs` の絶対期限判定を純関数で行う。
- `App.svelte` は既存の `clock.now.getTime()` を `deriveEmergencyPanels`、`deriveMode`、`deriveTickerLines` へ同じ `nowMs` として渡す。`deriveMode(state, nowMs)` と `deriveTickerLines(state, nowMs)` も内部で同じ時刻を `deriveEmergencyPanels` へ渡し、時刻引数の無い別経路を残さない。1,000ms の clock tick だけで期限切れ surface が再投影されるようにする。
- panel 局所の `changeKey` 記憶はアニメーション抑止に限定し、DTO の保持・期限・snapshot reset を所有させない。
- 現況と変更内容を別 surface に描き、VPWS50 source 明示、VPWS50 contribution visibility gate、normal / compact のカテゴリ代表枠と要約を実装する。
- 同一ラベルの code-only `kindChanged` は利用者向け投影から抑制する。
- reduced-motion と ARIA の規則を実装し、pointer-only 導線を作らない。

完了条件: DOM test が全 5 分類、code-only 表示抑制、解除の現況非混入、2 source の帰属、snapshot 全置換、snapshot 更新なしの clock-only expire、reconnect、縮退、reduced-motion を検証する。

### 5. 統合・実機受入

対象: end-to-end fixture、Pi preview / screenshot 検証。

- 連続続報、engine restart、frontend reload のシナリオを通す。
- 720p と通常 Pi 解像度で overflow を検査する。

完了条件: §acceptance を満たし、コード変更なら `npm run build`、`npm test`、永続化・共有状態に触れるため `npm run test:shuffle` がすべて成功する。

## §acceptance

1. VPWS50 の追加、解除、L4→L5、L5→L4、種別変更を、地域・種別・前後値を含む構造化 DTO として engine→display に送れる。
2. 現況の気象警報表示と `今回の変更` が視覚的に区別され、解除地域は現況一覧に混入しない。
3. 変更内容だけで緊急画面を開始・維持しない。現在の気象主役表示の権威は既存 `weatherPromotion` のままである。
4. 最新の accepted changed は前の変更内容を即時置換し、accepted unchanged は clear する。gate suppressed は寿命を延長しない。
5. accepted unchanged は clear、gate suppressed は no-op、unsafe は clear となり、未受理報が旧 DTO の状態を変えない。
6. change DTO は engine で受理から正確に 60,000ms で失効し、frontend は `expiresAt` を初めて跨ぐ clock tick（最大 1,000ms 未満）で snapshot 更新なしに消す。SSE 無客、display off/on、sweep 前 snapshot を含めて、それ以後は描画しない。
7. Pi でタッチ・マウス・hover なしに読める。大量変更はカテゴリ代表枠と明示要約へ縮退し、悪化と解除の共存時に双方を最低 1 件示し、現況を隠さない。
8. VPWS50 / VPWW56 合成時も source を明示し、VPWS50 contribution が無い画面へ VPWS50 の変更を表示しない。同一ラベルの code-only 種別変更は利用者向けに出さない。
9. 再起動、復元、reload、SSE reconnect のどの経路でも、再起動前・期限切れ・不正な変更内容を蘇らせない。store-instance UUID を含む `bootId:counter`、snapshot 全置換、clock-driven expiry で閉じ、frontend の reset epoch は持たない。
10. 旧 server の field 欠落は安全に無表示へ縮退し、既存の trigger / addedAreas / activationKey の動作を変えない。

## 実機評価後調整

- normal 4 件・compact 2 件の個別表示上限と、代表枠確保後のカテゴリ内地域表示順は、Pi 実機での読了時間と連続続報の頻度を測定してのみ調整する。60,000ms TTL とカテゴリ最低代表枠は本仕様の確定値であり、実機評価後調整へ含めない。
- `今回の変更` surface の色・border・文字サイズは、既存 design token の範囲で実機コントラストを確認して決める。新規の意味色は実機評価前に導入しない。
- 種別変更の前後名称は実電文 fixture で確認する。ただし、表示名が同一の code-only 変更を利用者向けに出さない裁定は確定事項であり、実機評価後調整へ戻さない。
