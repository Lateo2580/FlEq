# StandbyScreen stage 0 中央スタックの下側予算と二レーン・テロップ境界

> **裁定（2026-09-06 朝、ご主人）**: §3 の裁定点はすべて推奨案を採用。独立 DOC レビュー（Sol high、新規 read-only スレッド）2 巡で DOC-OK。


- 日付: 2026-09-06
- 状態: 再調査済み・実装前仕様（校正後 pre-gate とご主人裁定待ち）
- 作業基準 HEAD: `e9f40e5e22358670ba77a428dd74a5cfeb8bbc1a`
- 関連: `2026-09-06-capture-viewport-calibration.md`、`2026-09-05-standby-card-design-alignment.md`、`2026-09-05-standby-card-page-footer-contract.md`

## 1. 症状

ご主人の 2026-09-05 の観測では、preview `#standby-briefing` を 1280×720 として表示したとき、中央下段の「今日あった地震」（`RecentQuakes`）カード下端が二レーン・テロップ帯の上辺より下へ入り込んだ。

`#standby-briefing` は `display/frontend/src/preview/PreviewApp.svelte:245-248,334-335` の `briefingSnapshot` を、実 `StandbyScreen` と実 `Ticker` へ渡す preview 経路である（`:722-752`）。`briefingSnapshot` は共通 `standbySnapshot()` の既定値を継承するため、5件の `recentQuakes`、`stats=null`、接続済みを持つ（`display/frontend/src/preview/fixtures.ts:32-88,1084-1100`、`PreviewApp.svelte:378`）。LegacyImprovedMock の症状ではない。

ただし「ブラウザの窓または画像が 1280×720」と「CSS viewport の `window.innerWidth/innerHeight` が 1280×720」は同義ではない。従来 capture は `--window-size` だけで起動し、実 viewport を証明していなかった（`display/scripts/capture-legacy-standby.mjs:899-930,969-972`）。別 spec `2026-09-06-capture-viewport-calibration.md:3-15,133-155` の校正を、本症状の因果判定より先に完了させる。

本修正で禁止するのは、項目数削減、文字省略の追加、scroll/clip、負 margin、transform、z-index で内容を隠して見かけの侵入だけを消すことである。対象は StandbyScreen の親予算と中央固定クラスタの実高契約であり、カード意匠や page footer の改修とは分ける。

## 2. 根因（file:line）

### 2.1 ticker frame の token と実 border-box の乖離は現行根因ではない

1. `display/frontend/src/lib/theme.css:236-237` は `--ticker-row-h: 40px`、`--ticker-rows: 2` を定義する。全要素は `border-box` である（`:251-253`）。
2. 本番は `.screen-area.bottom` と `.ticker-frame.height` の双方を同じ `calc(var(--ticker-row-h) * var(--ticker-rows))` にする（`display/frontend/src/App.svelte:338-344,375-380`）。preview も同じである（`display/frontend/src/preview/PreviewApp.svelte:757-779,792-798`）。従って現行 CSS では `screenArea.bottom == tickerFrame.top`、frame 高は 80px である。
3. `Ticker` root は親の `width/height: 100%`、二つの `.ticker-row` は各 `--ticker-row-h` である（`display/frontend/src/components/Ticker.svelte:288-317,320-344`）。font fallback や内部 border が変わっても、固定された `.ticker-frame.getBoundingClientRect().height` 自体は 80px のままである。

従って、旧案の「ticker frame rect を測って既存 80px 予約と置き換える」だけでは値が変わらず、症状への修正は no-op である。ticker root/row の paint overflow は pre-gate で別途検査するが、現行コードから確定できる根因を frame token と実 frame rect の差とはしない。

### 2.2 確定根因は stage 0 の部分予算を solver が値付けしないこと

`StandbyScreen` は `.screen-area` 全高を占める（`display/frontend/src/components/StandbyScreen.svelte:2248`）。一方、stage 0 の時計は `.clock-landmark { position: fixed; inset: 0 }` と `.clock-wrap { top: 50% }` により ticker を含む viewport の中央へ固定され、下側の `.clock-below` は時計直下から絶対配置される（`:2285-2289`）。このため下側クラスタの使用可能高は `.legacy-layout` 全高ではなく、時計下端から Standby 下端（南海帯があればその上端）までの部分領域である。

現行 `readMeasurements()` は stats、RecentQuakes、connection の shelf 実高を取得する（`:1124-1128`）。その後に `boundaryTop` と `clockBottom` も読むが、下側内容が収まらない場合を次のように処理する（`:1132-1141`）。

```text
lowerCapacity = boundaryTop - clockBottom
belowContent  = statsHeight + recentHeight
freeLower     = max(0, lowerCapacity - belowContent)
clusterGap    = freeLower > 0 ? floor(freeLower / (itemCount + 1)) : 0
flowHeight    = belowContent + (itemCount - 1) * clusterGap
```

`belowContent > lowerCapacity` のとき `freeLower` を 0 に丸めても、`flowHeight` から内容実高は減らない。CSS 上の下端は少なくとも `clockBottom + belowContent` なので、超過量

```text
stageZeroLowerDeficit = belowContent - (boundaryTop - clockBottom)
```

だけ boundary より下へ出る。これは仮説ではなく、`:1139` の負値 clamp と `:1141,2289` の描画式から直接導ける。

同時に、`centerFixed()` は connection、stats、RecentQuakes を一つの高さへ合算し（`:739-749`）、`capacity` は `.legacy-layout` の全高である（`:751-757`）。`solverContext()` はその全高を左右中央へ共通に渡す（`:819-840`）。solver も固定中央高を中央列全高とだけ比較する（`display/frontend/src/lib/legacy-standby/solver.ts:93-120,463-478`）。従って「中央列全体には入るが、時計下側には入らない」構成を stage 0 の fit と誤認できる。`nextCenterClusterHidden()` も全高に対する unresolved を入力とするため（`StandbyScreen.svelte:1611-1621`、`display/frontend/src/lib/legacy-standby/center-cluster.ts:10-18`）、この部分領域だけの不足を見ない。

以上より根因は、**親が確保済みの ticker 上端境界は正しいが、stage 0 の時計上下に分割された実使用可能高と、子の実高を solver の stage 0 可否へ接続していない capacity-domain mismatch** である。

### 2.3 既存診断は失敗を検出するが、計画決定には戻さない

現行 geometry sweep は `.legacy-card` だけでなく、stats / RecentQuakes / connection の固定中央カードも対象にする（`StandbyScreen.svelte:1283-1289`）。各 rect を `standbyRect` に containment し（`:1300-1305`）、`data-geometry-violation-count` を公開する（`:2029-2033`）。capture は非0件を失敗させる（`display/scripts/capture-legacy-standby.mjs:724-735,947-963`）。従って「ticker overlap は gate 化されていない」という旧記述は誤りである。

不足しているのは、最終 DOM の generic gate ではなく、(a) stage 0 の部分予算を plan 決定へ戻すこと、(b) 対象 `#standby-briefing` を校正済み三 viewport で直接採る manifest、(c) `standby.bottom` と ticker の実 paint 上端の直接比較である。手動 preview、未校正 viewport、別 scenario、古い capture、settled 前採取のどれだったかは §3.1 の pre-gate で切り分ける。

### 2.4 真 720p での適用可否と同根範囲

近縁の `#standby-briefing-design-alignment` record は `inner=1280×720`、settled、stage 0 で、RecentQuakes 下端 620.2734375px を記録している（`display/tmp-capture/footer-after/design-alignment-records.json:6-31,44-68`）。現行 CSS の ticker 上端は 640px なので、この別 scenario は非侵入である。fixture が異なるためご主人の観測を否定する証拠にはしないが、対象 scenario の校正済み再現なしに「真 720p でも deficit が正」と断定もしない。

同根として本修正へ含めるのは、同じ `.clock-wrap` の上側に絶対配置される connection と、下側の stats / RecentQuakes だけである。上側にも `clockTop - standbyTop` の部分予算を設け、同じ stage 0 可否へ接続する。これらは同一 DOM・同一 solver 入力・同一 settle epoch を共有するためである。

BriefingCard、WeatherWarningForecastCard、VolcanoCard の absolute footer と WeatherAlertCard の zero-height footer は、各カード自身の自然高 / page probe / live shell 契約である（`docs/specs/2026-09-05-standby-card-page-footer-contract.md:18-28`）。中央時計の部分領域を使わず、同じ根因ではないため本修正へ含めない。既存 card/footer assertion は保護対象とする。

## 3. 変更

### 3.1 校正後 pre-gate と二つの終端

製品コードを変更する前に、`2026-09-06-capture-viewport-calibration.md` の calibrated browser-session / schema v2 / readiness 契約を受入済みにする。その経路へ既存 `#standby-briefing` を 1920×1080、1280×720、960×620 で追加し、同一 build・font・fixture・quake identity/order で各二回採る。最低限、次を同じ primary session の screenshot 前後で記録する。

- requested viewport、`window.innerWidth/innerHeight`、`documentElement.clientWidth/clientHeight`、DPR、browser metadata、font signature。
- `.preview-screen`、`.screen-area`、`.standby`、`.ticker-frame`、`.ticker`、二つの `.ticker-row`、stage 0 の `.clock-face`、stats / RecentQuakes / connection の shelf と active live rect。
- ticker root の `clientHeight/scrollHeight` と row rect union。`tickerOccupiedTop` は `min(tickerFrame.top, ticker root と paintable row の top)` とする。
- stage、compressed、placement、rotation、hidden list、measurement epoch / pass / settled / nonconverged、generic geometry violations。
- `lowerCapacityPx`、`lowerRequiredPx`、`lowerDeficitPx` は capture 側でも raw rect から独立再計算する。

pre-gate の終端を次の二つに分ける。

**N — 校正済み真 1280×720 で再現しない:** 二回とも `RecentQuakes.bottom <= tickerOccupiedTop + 1px`、overlap area 0、generic geometry violation 0、settled / converged、同一 quake 5件を満たす場合、製品実装へ進まない。本 spec 冒頭の状態を `closed（capture 校正後 non-repro）` に更新し、calibration run ID、二 record key、旧観測との差、実 CSS viewport を記録して閉じる。§5.2-N だけが完了条件であり、実装後 gate を要求しない。

**R — 校正済み真 1280×720 でも再現する:** `RecentQuakes.bottom > tickerOccupiedTop + 1px` かつ raw rect からの `lowerDeficitPx > 1` が二回一致する場合だけ、§3.2 以降を実装する。侵入は再現するが deficit が一致しない、ticker paint が frame 外へ出る、`standby.bottom != tickerOccupiedTop`、未 settled のいずれかなら根因が異なるため **blocked** とし、実装や期待値更新を行わない。

### 3.2 裁定点 1 — 予算の取り方

**選択肢 A — stage 0 の実使用可能領域を測る（推奨）**

frame 高を親から渡す新 API は作らない。`StandbyScreen` が同一 measurement pass で既に持つ viewport-relative rect と shelf 実高から、次を整数 CSS px へ丸めて計算する。`tickerOccupiedTop` は capture oracle であり、製品側の境界は自身の `standbyRect.bottom` を用いる。南海帯があれば従来どおりその上端を優先する。

```text
boundaryTop            = nankaiRect?.top ?? standbyRect.bottom
stageZeroLowerCapacity = max(0, round(boundaryTop - clockRect.bottom))
stageZeroLowerRequired = visible(statsHeight) + visible(recentHeight)
stageZeroLowerDeficit  = max(0, stageZeroLowerRequired - stageZeroLowerCapacity)

stageZeroUpperCapacity = max(0, round(clockRect.top - standbyRect.top))
stageZeroUpperRequired = connectionVisible ? connectionHeight + baselineGap : 0
stageZeroUpperDeficit  = max(0, stageZeroUpperRequired - stageZeroUpperCapacity)
stageZeroFixedFits     = both measurements confirmed
                         ? max(lowerDeficit, upperDeficit) <= 1
                         : unknown
```

`stageZeroFixedFits=true` では現行の余白式をそのまま使い、1080p を含む既存配置を動かさない。`false` では負の余白を 0 に丸めて stage 0 を合格させず、既存 ladder の最小 feasible stage（1→2→3）へ進める。stage 1 以上では時計が ticker へ handoff し、stats / RecentQuakes / connection は既存 `.center-card-region` の全高 solver へ入る（`StandbyScreen.svelte:2190-2219`）。この deficit だけを理由に `center-cluster-hidden` へ stats / RecentQuakes を追加してはならず、まず stage を上げる。全高でも不成立になった後の既存 r-f reduction 意味論は変更しない。

内容変更による stage 1→0 の回復は、上下双方に `2 * baselineGap + 0.01px` を超える余裕がある場合だけ許可し、既存 demotion hysteresis とそろえる（`StandbyScreen.svelte:1596-1600`）。viewport resize だけでは既存どおり committed stage を下げない（`:1824-1833`）。

**選択肢 B — 固定 token / breakpoint を見直す**

`--ticker-row-h`、`--ticker-rows`、720p 専用の中央最大高、時計 offset のいずれかを固定値で変える。現在の frame rect は token と同じなので、ticker token の変更は usable area と ticker 意匠を全画面で同時に変えるだけである。子の font、折返し、stats/connection 有無による実高を値付けできず、1080p にも波及するため不採用とする。

### 3.3 solver と settle の契約

`SolverContext` に `stageZeroFixedFits: boolean | null`（名称は同義なら可）を追加する。`null` は初回または未確認であり、暫定 stage 0 DOM を描いて測定してよいが settled commit は不可とする。自動 plan の stage 0 は、既存 `placementFits(sidePlacement, ctx)` に加えて `stageZeroFixedFits === true` の場合だけ選べる。manual/test ladder と stage 1〜3 の中央列全高計算は変えない。

stage 1 以上でも counterfactual stage 0 を再判定できるよう、opacity-zero で DOM に残る `.clock-face` rect は予算測定用には読む。衝突検査で stage 1 以上の ghost clock を除外する現契約（`StandbyScreen.svelte:1129-1132,1240-1255,1306-1309`）とは変数を分ける。

現行 convergence signature は stage、全高 capacity、Nankai 高、rotation、gap、card/probe measurements を持つが、clock / boundary / fixed child / cluster flow を持たない（`:1148-1153`）。同一 epoch の signature へ少なくとも次を追加する。

- `standbyTopPx`、`boundaryTopPx`、`clockTopPx`、`clockBottomPx`。
- `statsHeightPx`、`recentHeightPx`、`connectionHeightPx` と各 visibility。
- 上下 capacity / required / deficit、`stageZeroFixedFits`。
- `clusterGapPx`、`clusterFlowHeightPx`、`solvingCenterClusterHidden`。

これらは同一 `readMeasurements()` pass の整数 CSS px snapshot とし、二回同一 signature 後だけ terminal commit する。terminal commit は plan、hidden list、上記 budget snapshot、`data-measurement-epoch` を同時に latch/publish する。1px 未満の subpixel 揺れは丸め後同値として signature を変えず、新 epoch も開始しない。

親から `{boundaryPx,boundaryEpoch,confirmed}` を渡す方式、親 `ResizeObserver`、consumed parent epoch は導入しない。現 root では `standbyRect.bottom` が必要な実境界であり、親 ticker frame measurement は同値のためである。content/SSE、window resize、fonts ready は既に `requestSettle()` を開始する（`:1801-1839`）。stage/compressed による shelf 高の変化は同じ bounded settle 内で再読する（`:1557-1595`）。従って親通知の遅着や位置だけの変化に対する新たな stale epoch は作らない。

### 3.4 裁定点 2 — fluid 縮尺下限

**選択肢 A — 下限を変えない（推奨）**

`RecentQuakes` は `--type-body-s-fluid` と `--type-label-l-fluid` を使う（`display/frontend/src/components/RecentQuakes.svelte:61-73`）。時計は大表示を 92px / 21px に固定する（`display/frontend/src/components/Clock.svelte:23-45`）。本修正は予算の domain と stage 可否だけを直し、これらの token、computed typography、行 padding、折返し規則を変えない。§5.4 の完全一致で機械固定する。

**選択肢 B — 720p 用の fluid floor を下げる**

RecentQuakes または時計を縮めて stage 0 を保持する。情報密度と可読性を変える製品判断であり、今回の根因修正には不要である。採る場合は本 spec の A案と混ぜず、対象 token、最小 font/line-height、折返し、1280/1920/960 の before/after を持つ別 spec とご主人裁定を必要とする。

### 3.5 裁定点 3 — 1920×1080 の不変条件

**選択肢 A — 見た目と plan の差を 0 にする（推奨）**

1920×1080 の `#standby-briefing` は stage 0 budget が fit のままでなければならない。同一 browser build、font、fixture、時刻、page tick の before/after で screen/ticker/clock/RecentQuakes/Briefing の全 rect、cluster gap/flow、stage、compressed、placement、rotation、hidden listを完全一致させる。budget guard は fit 時に旧余白式へ入るため、許容差を設けず 0 CSS px とする。

**選択肢 B — 1080p の再配置を許容する**

新 measurement に合わせた数px移動または stage 変更を許す。問題 viewport 外の既定表示を変える理由がなく、capture noise を製品変更として固定する危険があるため不採用とする。

### 3.6 diagnostics、probe/live、期待表

`StandbyScreen` は settled snapshot と同時に、上下の boundary/capacity/required/deficit、clock rect、child shelf heights、cluster gap/flow、stage-zero fit を `data-*` へ公開する。capture は同じ値を raw rect から再計算し、1px を超える自己申告差を失敗させる。

RecentQuakes shelf と active live の双方は、fixture 由来の安定 quake identity を同じ順序で公開する。active live selector は stage 0 の `.clock-landmark` または stage 1+ の `.center-card-region` のどちらか一方に厳密に1個だけ存在させる。shelf/live は同じ `--center-width`、同じ compressed surface、同じ quake count/order、同じ computed token surfaceを使い、border-box 幅/高を1px以内で一致させる。

`capture-legacy-standby.mjs:811-829` の `TABLE_EXPECTATIONS`、`UTIL_EXPECTATIONS`、flood/tornado/design-alignment/footer/candidate/payload/pager/plan assertion は削除・緩和・一括更新しない。対象 `#standby-briefing` は独立 manifest / expectation として追加する。既存表に差が出た場合は、更新前に (1) 現期待、(2) 校正済み fresh base、(3) after、(4) rect/plan の実測差、(5) 本変更との因果、(6) ご主人の裁定を記録する。これを欠く期待値変更は不可とする。

### 3.7 禁止事項と逸脱

次を本修正の代替または便乗変更にしてはならない。

- RecentQuakes の5件削減、文言省略、ellipsis追加、scroll/clip、`overflow: hidden` の追加、負 margin、transform、raw-px offset、ticker を覆う z-index。
- `--type-*-fluid`、時計/RecentQuakes typography、`--ticker-row-h` / `--ticker-rows`、二レーン内容、カード footer/header/pager DOM の変更。
- target 以外の stage / placement / rotation / candidate / payload / pager 期待の緩和。
- `lowerDeficitPx <= 1`、ticker paint overflow、boundary 不一致、nonconverged を「同じ症状」とみなして実装を続けること。

## 4. 対象ファイル

実装経路 R の対象候補は次に限定する。

- `display/frontend/src/components/StandbyScreen.svelte` — 上下部分予算、counterfactual clock 測定、settle signature / diagnostics、stage 0 guard への入力。
- `display/frontend/src/lib/legacy-standby/solver.ts` — `stageZeroFixedFits` の tri-state と stage 0 選択条件。
- `display/frontend/src/lib/legacy-standby/__tests__/solver.test.ts` — true / false / unknown と最低 feasible stage の pure test。
- `display/frontend/src/components/RecentQuakes.svelte` — shelf/live identity 比較用の非表示意味を変えない `data-recent-quake-id` のみ。
- `display/frontend/src/components/__tests__/standby.test.ts` — deficit、上側 connection、hysteresis、signature、非隠蔽、terminal latch。
- `display/scripts/capture-legacy-standby.mjs` — 校正済み `#standby-briefing` manifest、ticker paint / target rect / probe-live / typography / plan assertion。
- `display/frontend/src/components/__tests__/capture-design-alignment.test.ts` — record schema、manifest、既存 assertion 保護、negative case。

`App.svelte`、`PreviewApp.svelte`、`Ticker.svelte`、`Clock.svelte`、`theme.css`、card footer/header component、parser、engine、wire、永続化、通知、CLI、pager/scheduler/partition 意味論は対象外である。`#standby-briefing` と parent/ticker の現 DOM/CSS は真実源として読むが、親 boundary prop や新 `ResizeObserver` は追加しない。

## 5. 受入条件

### 5.1 共通 pre-gate

校正済み primary session の 1920×1080、1280×720、960×620 `#standby-briefing` record は、次を満たさなければ branch 判定に使えない。

1. requested と `innerWidth/innerHeight`、`clientWidth/clientHeight` は各1px以内、DPR=1、browser/font/payload/quake identity は二反復で完全一致。
2. `document.fonts.status="loaded"`、stable sample 2回、screenshot 前後同一、`data-measurement-settled="true"`、`data-measurement-nonconverged="false"`。
3. `screenArea.bottom == standby.bottom == tickerFrame.top` は1px以内。ticker root / 二 row は frame に包含され、root `scrollHeight <= clientHeight + 1`、row union が frame 外へ出ない。
4. shelf/live の5 quake identity、count、order、active live selector、compressed surface、`--center-width` は一致。width/height は各1px以内。
5. capture が raw rect から再計算した capacity / required / deficit field は欠落せず、二反復で各1px以内。製品変更前には `data-stage-zero-*-px` はまだ存在しないため要求せず、経路Rの after だけ §5.3 で両者を比較する。

### 5.2-N 校正だけで解消した場合の完了条件

1280×720 の二反復で `recent.bottom <= tickerOccupiedTop + 1`、交差面積0、`lowerDeficitPx <= 1`、`data-geometry-violation-count=0` を満たす。1920×1080 も同じ target で ticker 交差0、generic geometry violation 0を記録する。960×620 は境界三者、overlap、probe/live を同時採取して狭幅回帰の証拠へ残すが、960単独の新しい問題は別項目として記録し、真1280×720で非再現の本specを製品実装へ戻す根拠にはしない。全待機カードの全面対応も条件にしない。

この branch では製品ファイル・solver・期待表の diff が0であること、本 spec の状態を `closed（capture 校正後 non-repro）` にしたこと、run ID / record key / 実 viewport / 旧観測との差を記載したことをもって完了とする。§5.3〜5.6 は **N/A（未実装のため要求しない）** とする。

### 5.2-R 真 720p でも再現した場合の実装開始条件

1280×720 の二反復で `recent.bottom > tickerOccupiedTop + 1`、交差面積正、`lowerDeficitPx > 1`、stage 0、同じ quake 5件、settled / converged をすべて満たす。raw rect と source 式が同じ deficit を1px以内で説明することを実装開始 gate とする。一項目でも欠ければ blocked である。

### 5.3 実装後 geometry と plan

経路 R の after は三 viewport すべてで次を機械判定する。

- `RecentQuakes.bottom <= tickerOccupiedTop + 1px`、交差面積 `0px²`。南海帯がある追加 fixture は `recent.bottom <= nankai.top + 1` かつ `nankai.bottom <= tickerOccupiedTop + 1`。
- `data-stage-zero-lower-deficit-px > 1` の target では stage 0 を選ばない。stage 1〜3 のうち、同じ measurement vector を入力した solver unit oracle が返す最小 feasible stage、placement、rotation と完全一致する。
- RecentQuakes 5件は可視で identity/order不変、`data-center-cluster-hidden` に `recent-quakes` を含めない。stats/connection がある同根 fixture も、部分 deficit だけを理由に hidden へ追加しない。
- `data-layout-unresolved="false"`、`data-measurement-nonconverged="false"`、`data-geometry-violation-count=0`、`data-card-overflow-count=0`、列 scroll / readable overflow /相互 overlap は0。
- 1280×720 / 960×620 で target の stage / compressed / placement / rotation が変わる場合、before 値、after の solver-oracle 値、`stage-zero-budget-deficit` 理由、ご主人の R3 裁定を新 target expectation に固定する。「stage 1以上」だけの緩い期待にはしない。

### 5.4 fluid 下限不変と probe/live の機械固定

1920×1080、1280×720、960×620 の before/after record に、次の二 map を保存し、key 欠落を許さず JSON の文字列値を完全一致させる。

1. **relevant token map**: `--type-body-s-fluid`、`--type-label-l-fluid`、`--type-display-weight`、`--type-label-weight-emphasized`、`--type-body-weight-emphasized`、`--num-weight`、`--font-ui`、`--font-num`、`--ticker-row-h`、`--ticker-rows`。
2. **computed typography map**: `.clock-face .time/.sec/.date` と shelf/live の `.recent-quakes`, `h2`, 各 `.row/.hypocenter/.stats` の `font-family`、`font-size`、`line-height`、`font-weight`、`letter-spacing`。加えて `.date` の `margin-top`、`h2` の四 margin、`.row` の四 padding、各 hypocenter の折返し行数を保存する。

同じ after record 内では shelf/live の `--space-1..5`、`--edge`、`--gap`、`--center-width` と上記 typography map も完全一致させる。stage change で compressed surface 自体が変わり得る 1280/960 の before/after spacing token は凍結対象にせず、surface 名と solver plan の裁定対象にする。文言、5件の identity/order、各 hypocenter の折返し行数は before/after 完全一致とする。

### 5.5 1080p freeze と既存契約保護

1920×1080 `#standby-briefing` の before/after は、次を完全一致させる。

- screen-area、ticker frame/root/rows、standby、clock face、RecentQuakes shelf/live、Briefing live の `x/y/width/height`（差 **0 CSS px**）。
- lower/upper capacity/required/deficit、cluster gap/flow、stage、measurement geometry stage、compressed、placement、rotation、hidden list、visible keys、omitted count、page identity。
- `RecentQuakes.bottom <= tickerOccupiedTop + 1px` と交差面積0。

既存 `TABLE_EXPECTATIONS` / `UTIL_EXPECTATIONS` の全通常 cell、floodWide、tornado fixture、design-alignment と page-footer suite を校正済み viewport で走らせ、before/after mismatch 0とする。card/footer、candidate、payload、pager、plan assertion の削除・skip・許容幅拡大は0件である。

### 5.6 unit / browser gate と実行

最低限、次を test で固定する。

- 正の余白、ちょうど fit、1px許容、2px deficit、clock/boundary 未確認、connection 上側 deficit、stats+Recent 下側 deficit。
- deficit では stage 0→最低 feasible stageへ進み、RecentQuakesを隠さないこと。回復は二 gap hysteresisを満たすまで stage 0へ戻らないこと。
- boundary、clock、stats/recent/connection 高、gap/flow、hidden listのいずれかが変われば同一 epoch 内で再収束し、同じ整数 snapshotで止まること。1px未満の揺れは epochを増やさないこと。
- terminal publish の budget snapshot / plan / hidden / measurement epoch が同一 commitであること。
- capture schema field欠落、probe/live identity違い、別 active live selector、computed typography/token差、ticker row overflow、target overlap、既存期待表差を各 negative test が非0にすること。

実装時は次をすべて成功させる。

```sh
npm run build
npm test
npm run test:shuffle
npm --prefix display run build
npm --prefix display run test
npm --prefix display run typecheck
```

さらに校正済み `capture-legacy-standby` で `#standby-briefing` の 1920×1080 / 1280×720 / 960×620 と既存全期待 matrixを実行する。viewport calibration が未受入、target pre-gate recordが二反復ない、または exact before buildを用意できない場合、経路 R は **blocked** とする。

## 6. 裁定ラベル（案）

### 6.1 製品裁定 R1〜R6

| Label | A | B | 推奨・理由 |
|---|---|---|---|
| R1 `calibrated-reproduction` | 真1280×720で非再現なら製品実装なしでclosed | 真1280×720でもdeficit再現なら実装経路R | 測定結果に従う条件分岐。A/Bを混ぜず§5.2-N/Rで別受入にする |
| R2 `stage-zero-budget-source` | 時計上下の実rect＋子shelf実高を同一passで測る | ticker/720p固定token・breakpointを変える | **A推奨**。現行ticker rect=tokenであり、Bは子実高を扱えない |
| R3 `deficit-behavior` | targetの1280/960だけ最低feasible stageへの変更を許可し、内容は保持 | stage 0を固定しfluid縮小で収める | **A推奨**。既存clock handoffを使い、隠蔽を増やさない。変更後planはexact expectation化する |
| R4 `fluid-floor` | typography/token/折返しを完全不変 | 720p専用floorを変更 | **A推奨**。根因は縮尺でなくcapacity domainである |
| R5 `fhd-freeze` | 1920×1080のrect差0、plan完全一致 | 1080pの移動・再配置を許可 | **A推奨**。fit branchは現式を保持できる |
| R6 `expectation-policy` | target assertionを追加し既存card/footer/candidate/payload/pager/plan表は保持 | 既存期待表も実測で更新 | **A推奨**。Bは旧期待・base/after差・因果・ご主人裁定を別途必須とする |

### 6.2 六要素の実装ラベル

- **対象**: 校正後も再現する場合の stage 0 時計上下部分予算、solver guard、同一 epoch の収束/diagnostics、RecentQuakes identity、三 viewport target capture。
- **許容変更**: §4 の7ファイル内で、§3のbudget/solver/diagnostic/assertionとそのtestだけ。target 1280/960 の exact plan差はR3-A裁定後に限る。
- **禁止変更**: §3.7、対象外ファイル、既存card/footer/candidate/payload/pager/plan assertionの削除・緩和、未裁定の期待表更新。
- **配送先（main → personal → Pi）**: calibrationを先に全配送し、経路Rならmainで§5を受入後、同一差分をpersonal、Piへ順に配送する。Piで実運用1920×1080と問題の1280×720を確認する。
- **ロールバック**: 本修正の単一製品commitを逆順にrevertし、calibration commitとcard design/footer commitは巻き戻さない。経路Nは製品commitがない。
- **受入条件**: 経路Nは§5.1＋§5.2-N、経路Rは§5.1＋§5.2-R＋§5.3〜5.6。両経路を同時に完了扱いにしない。

### 6.3 独立 DOC review 7指摘の採否

7件すべてを **a) 採用**する。b) 根拠を示して不採用とする指摘はない。

| # | 判定 | 改訂内容 |
|---:|---|---|
| 1 | **a) 採用** | 固定80px frame measurementを根因/修正から撤回し、stage 0部分予算の未接続と負値clampをfile:line・式で確定した（§2.1〜2.2）。 |
| 2 | **a) 採用** | generic containmentとcapture非0 gateの存在を明記し、欠落をplan feedbackとtarget-specific直接比較に限定した（§2.3）。 |
| 3 | **a) 採用** | stale settleの懸念を採用した。根因訂正により親measurement自体を撤回したため提示の親prop/epoch handshakeは非該当とし、Standby内のclock/boundary/child/flowをsignatureとterminal latchへ入れる（§3.3）。 |
| 4 | **a) 採用** | 校正のみでclosedとなるNと、実装を要求するRの受入条件を分離した（§3.1、§5.2-N/R）。 |
| 5 | **a) 採用** | 三viewportのrelevant token map、computed typography/padding/折返しをbefore/after完全一致にした（§5.4）。 |
| 6 | **a) 採用** | 960にもticker境界/overlap/probe-liveの採取を要求し、経路Rでは交差0をgate化した。quake identity/count/order、active selector、compressed surfaceもschema化した。ただし経路Nの閉鎖条件や全面対応へは拡張しない（§5.1〜5.4）。 |
| 7 | **a) 採用** | 既存card/footer/candidate/payload/pager/plan assertionを保護し、期待表変更の六情報と裁定を必須化した。R2/R3/R6にもB案を置き、1280/960 plan差をR3で裁定対象にした（§3.6、§6.1）。 |
