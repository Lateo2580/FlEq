# 緊急画面: layoutSettling 解除後に WeatherEmergencyPanel の panel geometry を必ず読み直す spec

> **裁定（2026-09-07 21:15、ご主人）**: §6 の 4 分岐はすべて A（settling 解除時の明示 re-read／helper は emergency.test.ts に追記／EmergencyScreen 実配線テストを含める／panelElement は現行 action のまま）。本 spec は実装 spec として有効。対応 Issue #18。
> **訂正（2026-09-07、実装後の実走で判明した測定事実に合わせる。製品挙動の緩和は含まない）**: §3.2 の C3 を「外形観測できない不変条件」へ、§4.2 の (e) を EmergencyScreen 実配線へ、§5.1 の赤の内訳を実測値へ訂正した。

> **対象 Issue**: [#18](https://github.com/Lateo2580/FlEq/issues/18)（`display: layoutSettling 解除後に WeatherEmergencyPanel の panel geometry が再読込されず change fit が旧寸法で確定し得る`）
> **基準 SHA**: Issue 本文は `a58a2f935b694cdbf26d0b054d3adfde9e9d040f`（VPWS50 change fit 探索の追加 commit）。本 spec は `65d6f9ba2c060836a9ebff0c0a36a53af9b7d8d8`（main, 2026-09-07）で全 file:line を実測し直した。
> **再現状況**: Issue と同じく静的レビュー由来である。**本 spec 起草時点でブラウザ実行による再現は行っていない**。§4 の回帰テストは「現行実装が落ちること」を先に確認してから受入テストへ昇格させる（§4.0）。
> **本 spec の範囲**: `WeatherEmergencyPanel` の panel border-box 測定の**受理タイミングだけ**を直す。DOM・CSS・design token・solver・fit 探索アルゴリズム・probe 予算・wire・永続化は変更しない。

## 1. 症状

緊急画面の grid レイアウトが変わった後、`WeatherEmergencyPanel` の VPWS50「今回の変更」欄の fit 探索が、**遷移前の panel 寸法を入力にしたまま確定し続ける**経路がある。

`EmergencyScreen` は grid track が変わってから遷移完了 + 80ms まで `layoutSettling=true` を保つ（`display/frontend/src/components/EmergencyScreen.svelte:161-166`）。`WeatherEmergencyPanel` の `readPanel()` はこの窓の測定をすべて破棄する（同 `WeatherEmergencyPanel.svelte:189`）。窓が閉じた時点で panel の border-box は既に安定しているため、**その後に ResizeObserver がもう一度発火する保証がない**。そして panel geometry には、窓が閉じたときの明示的な読み直し経路が存在しない。

Issue 本文の成立条件を、根因の観点で 2 系統に整理する。

### 1.1 系統 A — 旧寸法のまま fit が確定する（Issue の 1〜6）

1. VPWS50 `change` を持つ weather panel が表示され、`panelWidth` / `panelHeight` / `panelContentHeight` が確定して fit が決まっている。
2. EEW・津波・地震の増減や並び替えで `gridCols` / `gridRows` が変わる（`EmergencyScreen.svelte:145-146`）。
3. `layoutSettling=true` の窓（`SPRING_SPATIAL_QUICK_MS + 80`）の中で panel の幅・高さが新 geometry へ遷移する。
4. ResizeObserver callback は届くが `readPanel()` が settling を理由に捨てる。
5. `layoutSettling=false` へ戻るが、panel は既に安定しており新しい resize callback が来ない。
6. `settlingEpoch` の bump で change batch は作り直されるが、その入力である 3 つの panel 寸法は旧値のままである。

影響は Issue のとおり、遷移前の広い幅で測った候補高が実際の compact panel より低く見積もられ、`selectedChangeCount` を過大に選ぶことである。live 側では chip が折り返して change slot が想定より高くなり、対象地域領域を圧迫・clip し得る。

### 1.2 系統 B — panel geometry が一度も commit されない（Issue 末尾の「有効な panel geometry が一度も commit されていない場合」）

`.weather-panel` の外側 key は固定で、`activationKey` が変わっても div は作り直されない（`WeatherEmergencyPanel.svelte:773-780` のコメントと `EmergencyScreen.svelte:193` の `(p.key)`）。したがって panel が mount するのは **weather panel が新規に追加されたとき**だけである。

通常はその flush では親の settling `$effect` がまだ走っていないため、`use:observePanel` の初回 `readPanel()`（同 `206`）は `layoutSettling=false` で通る。問題は**割込み遷移**である。`EmergencyScreen.svelte:163-166` は新しい遷移のたびに fallback timer を張り直すので、前の遷移の窓が開いている最中に weather panel が追加され得る。このとき:

- 初回 `readPanel()` は `layoutSettling=true` で破棄される。
- `observeResize` の初回通知（geometry helper でも実 RO でも observe 後の非同期通知）も破棄される。
- `observePanel` の `update()` は token = `input.activationKey` にしか反応しない（同 `780`）ので、settling 解除では発火しない。

結果 `panelWidth` は `null` のままになる。`{#if changeVisible && panelWidth != null}`（同 `996`）が false なので change の reserve shell と候補 batch は DOM に出ず、`changeMeasurementKey` は `null`（同 `367-369`）、`changeMeasurementSettled` は永久に false（同 `645-650`）。`changeVisible` 中の対象地域 page の初期 jump はこの settled を待つため、**ページ初期選択も止まる**。

## 2. 根因（file:line）

### 2.1 受理ガードは 4 経路で共通、解除時 flush は 1 経路にしかない

`acceptsMeasurement()` は「退場中の旧 DOM を弾く token 一致」と「整定中の過渡値を採らない」を 1 つに畳んだ純関数である（`display/frontend/src/lib/weather-panel.ts:1291-1297`）。

```ts
// display/frontend/src/lib/weather-panel.ts:1291-1297
export function acceptsMeasurement(
  token: string,
  activationKey: string,
  layoutSettling: boolean,
): boolean {
  return !layoutSettling && token === activationKey;
}
```

`WeatherEmergencyPanel` でこのガードを通る測定は 5 つある。settling 解除後にどう復帰するかを、実際の action token と合わせて並べる。

| 測定 | 読み取り関数 | action token（`use:` の引数） | settling 解除後の復帰経路 |
|---|---|---|---|
| panel border-box | `readPanel` (188-201) | `input.activationKey`（780） | **無い（本件）** |
| where frame | `readWhereFrame` (269-276) | `input.activationKey`（864） | 明示 `$effect`（474-482） |
| reserve shell 高 | `measureReserve` の `record` (220-238) | `changeBatchKey`（1000） | token 変化 → `update()`（233-236） |
| change 候補高 | `measureChangeCandidate` の `record` (240-266) | `{batchKey, candidate}`（1060） | 同上（261-264） |
| reference body / area | `readReferenceBody` (403-420) / `readAreaGeometry` (427-437) | `referenceGeometrySourceKey` を含む token | `referenceGeometrySourceKey` が `layoutSettling` を含む（302）ため解除で token が変わり再 mount 相当 |

**ここが核心である。** reserve と候補は action token が `changeBatchKey` で、`changeBatchKey` は `settlingEpoch` を含む（354-366）。settling が解除されると `settlingEpoch` が +1 され（484-491）、`changeBatchKey` が変わり、Svelte action の `update()` が呼ばれて再測定される。where frame は `update()` を持たない（277-286 の返り値は `destroy` のみ）ので、代わりに 474-482 の明示 effect が置かれている。

panel geometry だけが**どちらにも属さない**。`observePanel` は `update()` を持つが（209-212）、その token は `input.activationKey` であって `changeBatchKey` ではない。`activationKey` は settling 解除では変わらない。そして 474-482 に相当する明示 flush も無い。

### 2.2 `readPanel` と `observePanel` の実体

```ts
// display/frontend/src/components/WeatherEmergencyPanel.svelte:188-201
function readPanel(node: HTMLElement, token: string): void {
  if (!acceptsMeasurement(token, input.activationKey, layoutSettling)) return;
  const rect = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  const verticalInsets = [
    style.borderTopWidth, style.borderBottomWidth,
    style.paddingTop, style.paddingBottom,
  ].reduce((sum, value) => sum + (Number.parseFloat(value) || 0), 0);
  panelWidth = finitePositiveOrNull(rect.width);
  panelHeight = finitePositiveOrNull(rect.height);
  panelContentHeight = finitePositiveOrNull(rect.height - verticalInsets);
}
```

```ts
// display/frontend/src/components/WeatherEmergencyPanel.svelte:203-218
function observePanel(node: HTMLElement, token: string) {
  let currentToken = token;
  panelElement = node;                                   // 205: state に保持されている
  readPanel(node, currentToken);                         // 206: mount 時 1 回
  const handle: MeasureHandle = observeResize(node, () => readPanel(node, currentToken));
  return {
    update(next: string): void {                         // 209: token = activationKey のみ
      currentToken = next;
      queueMicrotask(() => readPanel(node, currentToken));
    },
    destroy(): void {
      if (panelElement === node) panelElement = null;     // 214
      handle.destroy?.();
    },
  };
}
```

`panelElement` は `$state` として宣言され（174）、`observePanel` が設定・解除する（205・214）。**参照する側が存在しない**。`grep -n "panelElement"` の結果は 174・205・214 の 3 行だけである。参照先を持たない state がここに残っていること自体が、解除時 flush の欠落を示す痕跡になっている。

### 2.3 参照実装 — where frame の解除時 flush

```ts
// display/frontend/src/components/WeatherEmergencyPanel.svelte:474-482
// 整定解除時は ResizeObserver の次回通知を待たず、partition 非依存 frame を読み直す。
$effect(() => {
  const settling = layoutSettling;
  const activationKey = input.activationKey;
  const node = whereFrameEl;
  untrack(() => {
    if (!settling && node != null) readWhereFrame(node, activationKey);
  });
});

let previousLayoutSettling = false;
$effect(() => {                                          // 484-491
  const settling = layoutSettling;
  untrack(() => {
    if (previousLayoutSettling && !settling) settlingEpoch += 1;
    previousLayoutSettling = settling;
  });
});
```

宣言順が意味を持つ。`$effect` は宣言順に走るので、**geometry の commit（474-482）が `settlingEpoch` の bump（484-491）より先に起きる**。`whereFrameEl` は `bind:this`（864）で得ている点だけが panel と異なるが、`panelElement` は既に `observePanel` が同じ役割で保持している（2.2）。

### 2.4 参照実装 — QuakePanel の pending / flush 契約

```ts
// display/frontend/src/components/QuakePanel.svelte:218-226
function commitProbeMeasurement(id: string, measurement: ProbeMeasurement): void {
  if (layoutSettling) {
    pendingProbeMeasurements.set(id, measurement);   // 220: 捨てずに貯める
    return;
  }
  ...
}
```

```ts
// display/frontend/src/components/QuakePanel.svelte:249-274
const observer = new ResizeObserver((entries) => {
  ...
  if (layoutSettling) pendingProbeBox = { width, height };   // 254
  else { probeWidth = width; probeHeight = height; }
});
...
$effect(() => {                                              // 263-274
  if (layoutSettling) return;
  if (pendingProbeBox != null) { probeWidth = ...; probeHeight = ...; pendingProbeBox = null; }
  if (pendingProbeMeasurements.size > 0) { probeMeasurements = {...}; pendingProbeMeasurements.clear(); }
});
```

`pendingProbeBox` / `pendingProbeMeasurements` は `$state` ではない素の変数（同 `170-171`）で、貯める行為自体は再描画を起こさない。`EmergencyScreen.svelte:152` のコメントは「保留は `layoutSettling=false` を購読する `$effect` が同 tick で flush する (QuakePanel/TsunamiPanel)」と、この契約を規範として明記している。**`WeatherEmergencyPanel` の panel geometry だけがこの規範から外れている。**

### 2.5 fit 入力の依存関係

```ts
// display/frontend/src/components/WeatherEmergencyPanel.svelte:344-366
const changeBudget = $derived(
  panelContentHeight == null || reserveHeight == null ? null : panelContentHeight - reserveHeight,
);
const changeBatchKey = $derived(JSON.stringify([
  input.change?.changeKey ?? null, input.activationKey, compact,
  panelWidth, panelHeight, changeBudgetQuantized, reserveHeight,
  reserveFingerprint, changeFingerprint, fontEpoch, settlingEpoch,
]));
```

`changeMeasurementKey`（367-393）も同じ 3 寸法を identity に採る。`changeBatchKey` の変化は 493-506 の effect で候補高・`selectedChangeCount`・`changeMeasurementPass` を全リセットするので、**panel geometry が遅れて commit されると batch が二度リセットされ、fit pass を余分に消費する**。既存テスト（`emergency.test.ts:706-729`「identity reset・pending・同値 ResizeObserver は outer fit pass を余分に数えない」）が守っている性質と同じ系である。したがって修正は「読み直す」だけでなく「**`settlingEpoch` bump と同じ flush で 1 個の新 batchKey に畳む**」ところまでを契約にする必要がある。

### 2.6 本 spec で扱わないと確認したこと

- **reserve 高・候補高の staleness**: §2.1 の表のとおり、両者は action token が `changeBatchKey` なので settling 解除で自動的に再測定される。追加の flush は要らない。
- **`EmergencyScreen` の settling 窓の長さ**: `SPRING_SPATIAL_QUICK_MS + 80` と張り直し方式は Codex R1 / R6 の経緯を持つ確定仕様（`EmergencyScreen.svelte:134-140`・`149-153`）。触らない。
- **`acceptsMeasurement` の意味論**: token 一致と settling 排除を畳む設計はそのまま維持する。変えるのは「解除後に誰が読み直すか」だけである。

## 3. 変更

### 3.0 Phase 0 申告

**`docs/specs/display-design-system.md` / `theme.css` / header・footer 統一 spec / 錨カードの読み込みは不要**と判断する。理由は、本修正が DOM を 1 要素も増減させず、CSS を 1 行も変えず、design token を新たに参照しないためである。変更対象は `<script>` 内の測定受理タイミングとテストに限る。したがって使用トークン・倣う錨の file:line 申告は求めない。

ただし実装者は、`readPanel` が `getComputedStyle` から `borderTopWidth` / `borderBottomWidth` / `paddingTop` / `paddingBottom` を読んでいる（`WeatherEmergencyPanel.svelte:192-197`）ことを踏まえ、**`.weather-panel` の padding / border が transition 対象になっていないことを実装時点で確認する**こと。これは意匠の準拠ではなく、案 A と案 B の差が実害になるかどうかの事実確認である（§3.1）。

### 3.1 設計の選定 — 解除時の明示 re-read（推奨 A）

Issue が挙げた 2 案を比較する。

**案 A（推奨）: `panelElement` を購読し、`layoutSettling` が false になった effect で `readPanel(panelElement, input.activationKey)` を明示実行する。**

採用理由は 3 つある。

1. **同一ファイル内に既に錨がある。** where frame の解除時 flush（474-482）と一字一句同じ形になる。`panelElement` は §2.2 のとおり `observePanel` が既に保持しており、参照先が無いまま置かれている。案 A はその欠けた参照を埋めるだけで、新しい state を 1 つも増やさない。
2. **読む値が「解除時点の実 DOM」になる。** 案 B の pending buffer が保持するのは、settling 中に ResizeObserver が最後に届けた値である。これは遷移の途中で採られた過渡値であって、**最終 geometry である保証がない**。CSS transition の最後のフレームで RO が発火するとは限らず、`SPRING_SPATIAL_QUICK_MS + 80` の 80ms 余白はまさに「RO の最後の通知の後にも安定を待つ」ために置かれている（`EmergencyScreen.svelte:164-166`）。案 A は解除された瞬間に `getBoundingClientRect()` を新しく読むので、定義上その時点の最終値になる。
3. **系統 B（§1.2）を同じ 1 箇所で塞ぐ。** panel が settling 中に mount して初回読みも初回 RO 通知も破棄された場合、pending buffer には**何も入っていない**ので案 B は flush しても `panelWidth` が `null` のままになる。案 A は node さえあれば読むので復帰する。

**案 B: QuakePanel と同じ pending buffer + flush。** 他パネルとの実装の見た目は揃うが、上記 2・3 の弱点がある。QuakePanel でこの形が成立しているのは、測定対象が probe 用の隠しコンテナで grid transition の直接の被写体ではないためであり、`.weather-panel` そのものを測る本件へ機械的に写すのは適切でない。採るなら「解除時に pending が空なら実 DOM を読む」フォールバックを併せて必須にする、つまり案 A を内包する形になる。

**案 C（不採用）: `observePanel` の action token を `changeBatchKey` へ変える。** reserve・候補と同じ復帰経路に乗るが、`panelWidth` / `panelHeight` は `changeBatchKey` の**構成要素**なので、token を `changeBatchKey` にすると測定 → key 変化 → `update()` → 測定の循環になる。採らない。

### 3.2 契約

実装は次の 3 つを同時に満たすこと。**この 3 つが受入の意味論であり、§5 の機械的条件はこれを外から観測する形で書く。**

- **C1（過渡値を publish しない）**: `layoutSettling=true` の間は、ResizeObserver が何回発火しても `panelWidth` / `panelHeight` / `panelContentHeight` と、そこから導かれる `data-change-panel-*` / `changeBatchKey` / `changeMeasurementKey` が変化しないこと。現行の `acceptsMeasurement` ガード（189）をそのまま維持する。
- **C2（解除後に最終 geometry を必ず一度読む）**: `layoutSettling` が true → false へ遷移したとき、**追加の ResizeObserver 発火が一切無くても**、`panelElement` の現在の border-box から 3 寸法が読み直されること。`panelElement` が `null` のときは何もしない。
- **C3（順序: geometry commit が settlingEpoch bump より先）**: C2 の読み直しは `settlingEpoch` を +1 する effect（484-491）より**前**に走ること。これにより解除 1 回につき `changeBatchKey` は 1 個だけ新しくなり、493-506 の batch リセットが 1 回で済む。**C3 は外形観測できない不変条件である。** geometry commit と epoch bump はどちらの順でも同一 flush に畳まれるため二重リセットは発生せず、`data-change-measurement-pass`（batch ごとに 0 へ戻る非累積カウンタなので前後差は構造上 1 を超えない）にも `data-change-active-batch-key` のサンプリングにも差が現れない。したがって C3 は**テストではなく、effect の宣言位置（where frame flush effect の直後・batch リセット effect より前）とコメントで守る**。

実装上は、474-482 の where frame flush effect の直後・484 の `previousLayoutSettling` 宣言より前に、同じ形の effect を 1 つ足すのが最小である。where frame と 1 つの effect に相合してもよいが、その場合もコメントで両方の対象を明示すること。

### 3.3 変更しないもの

parser / router / formatter / notifier、engine 側の全ファイル、display protocol、`store.ts`、`EmergencyScreen.svelte` の settling 窓と張り直し方式、`weather-panel.ts` の `acceptsMeasurement` と fit 探索・partition solver、`changeBatchKey` / `changeMeasurementKey` の構成要素、`measureReserve` / `measureChangeCandidate` / `readReferenceBody` / `readAreaGeometry`、`QuakePanel` / `TsunamiPanel` / `EewPanel`、DOM 構造、CSS、theme token、`package.json` / `package-lock.json`。

`data-change-panel-width` / `-height` / `-content-height` は既に production の属性として出ている（`WeatherEmergencyPanel.svelte:790-792`）ので、診断属性の新設も行わない。

## 4. テスト

### 4.0 先に赤を確認する

新規ファイル `display/frontend/src/components/__tests__/weather-panel-geometry-flush.test.ts` を起こす。**実装より先にこのファイルを書き、現行 `65d6f9b` で §4.2 の (a)(d)(e)(f)(g) が落ちることを実走で確認してから実装に入る**こと（(b)(c) は §5.1 のとおり現行でも緑）。Issue も本 spec もブラウザ再現を伴わない静的レビュー由来なので、「そもそも現行が落ちる」ことの確認が根因確定の代わりになる。落ちなかった場合は実装に進まず、テストが条件を再現できていないか根因の見立てが違うかを報告する（blocked 扱い）。

### 4.1 使う helper と、既存テストとの違い

`emergency.test.ts:46-185` の `installWeatherGeometry()` をそのまま使う。新規ファイルからは import できないので、**同ファイル内へ複製せず、`emergency.test.ts` に追記する形を採るか、helper を `__tests__` 配下の共有モジュールへ切り出すか**を実装者が選ぶ。切り出す場合は `page-dots-test-utils.ts` が同ディレクトリの共有 helper の先例である。判断は §6 の分岐 2 に置く。

helper の要点は 3 つ。

- `rectOf()` は `.weather-panel` に対して現在の `panelWidth` / `panelHeight` を返す（同 `70-73`）。`setPanelSize(w, h)` でこの 2 値を差し替えられる（同 `167-170`）。
- `GeometryResizeObserver.observe()` は `notifyInitialResize !== false` のとき `queueMicrotask` で初回通知を届ける（同 `140`）。`notifyInitialResize: false` で初回通知を止められる。
- `fireAll()` は登録済み全 target へ通知を送る（同 `180-182`）。

**今回の肝は「`setPanelSize()` した後に `fireAll()` を呼ばない」ことである。** 既存の panel size 変更テスト（`emergency.test.ts:677-704`）は `setPanelSize` の直後に `fireAll()` を明示しており、「解除後に callback が来ない」という Issue の条件をまったく検証していない。`rectOf()` は `getBoundingClientRect` の実装そのものを差し替えているので、`fireAll()` を呼ばなくても**新しい寸法は DOM 側に反映済み**である。つまり `setPanelSize` → `fireAll` 無しで `layoutSettling=false` にしたとき新寸法が読めるかどうかが、そのまま C2 の判定になる。

`rendered.rerender({ ... layoutSettling: false ... })` は Svelte のフラッシュを起こすので、C2 が満たされていればこの時点で読み直しが走る。`settleWeatherLayout()`（`emergency.test.ts:186-191`）で 8 tick 回して収束させる。

### 4.2 ケース

いずれも `reducedMotionInput: true`、`input` は `weatherInput({ change: weatherChange() })` 系（`emergency.test.ts` の既存 factory）を使う。パネルは `rendered.container.querySelector<HTMLElement>(".weather-panel")!` で取る。

| # | ケース | 手順 | 期待 | 守る契約 |
|---|---|---|---|---|
| (a) | **解除後に RO 無しで新 geometry を読む**（Issue 案 1・2・4・5） | `panelWidth=1000, panelHeight=800`, `layoutSettling=false` で settle → `layoutSettling=true` へ rerender → `setPanelSize(520, 300)` → `fireAll()` を 1 回（settling 中の通知）→ `layoutSettling=false` へ rerender、**`fireAll()` を呼ばない** → `settleWeatherLayout()` | `data-change-panel-width` が `520`、`data-change-panel-height` が `300`、`data-change-panel-content-height` が 300 由来の値、`data-change-measurement-key` が settling 前の値と異なる、`data-change-batch-key` も異なる | C2 |
| (b) | **settling 中は過渡値を publish しない**（Issue 案 3） | (a) の途中、`layoutSettling=true` かつ `setPanelSize(520,300)` かつ `fireAll()` の直後に `flushSync()` して読む | `data-change-panel-width` が `1000` のまま、`data-change-panel-height` が `800` のまま、`data-change-measurement-key` が settling 前と同値 | C1 |
| (c) | **解除で fit pass を 2 個消費しない**（§2.5） | (a) と同じ手順で、解除の直前と `settleWeatherLayout()` 後の `data-change-measurement-pass` を比較 | 増分が 1 以下。かつ最終的に `data-change-measurement-settled` が `"true"` へ収束 | 現行でも緑。C3 の担保ではなく将来の誤実装ガード（§3.2 C3 のとおり C3 は外形観測できない） |
| (d) | **新 geometry の候補高で `selectedChangeCount` が再計算される**（Issue 案 6） | `changeCandidateHeight` を候補番号の関数として与え、`reserveHeight` と panel 高の組を「1000×800 では n=k、520×300 では n<k が最大 fitting」になるよう選ぶ。(a) の手順を踏む | `data-change-selected` が旧 geometry の値から新 geometry の値へ変わる。`data-change-measurement-settled` が `"true"` | C2 + fit の再計算 |
| (e) | **割込み遷移中に mount した panel が解除で初めて commit される**（§1.2 / 系統 B） | **`EmergencyScreen` 実配線で書く。** `reducedMotion=false` + fake timer。EEW 1 枚で render → settle → EEW+地震の 2 枚へ rerender して settling 窓を開く → `vi.advanceTimersByTime(100)` で窓が閉じる前に weather を足して 3 枚へ rerender（この mount で初回 `readPanel` も初回 RO 通知も破棄される）→ `data-change-panel-width` が未定義であることを確認 → `vi.advanceTimersByTime(SPRING_SPATIAL_QUICK_MS + 80 + 1)` で fallback timer に解除させる、**`fireAll()` を呼ばない** → settle | 解除前は `data-change-panel-width` が `undefined`（属性なし）、解除後は `1000`。かつ `data-change-measurement-settled` が `"true"` へ到達 | C2（初回 commit 欠落からの復帰） |
| (f) | **EmergencyScreen 経由の 1→2 枚遷移**（Issue 案 7） | `EmergencyScreen` を weather 1 枚で render → settle → panels に EEW を足して 2 枚へ rerender → `setPanelSize` で weather 側の寸法を compact 相当へ → `vi.advanceTimersByTime(SPRING_SPATIAL_QUICK_MS + 80 + 1)` で settling 窓を閉じる、**`fireAll()` を呼ばない** → settle | weather panel の `data-change-panel-width/height` が新値。`.panels[data-settling]` が `"false"` | C2 を実配線で |
| (g) | **main → side(compact) / side → main** | (f) と同じ形で、`compactOf()` の結果が変わる並び替え（weather を 0 番目から 1 番目へ、および戻す）を 2 ケース | 各遷移後に `data-change-panel-width/height` が新値へ追従 | C2 を実配線で |

(e) を単体 `render()` + `rerender()` で書いてはならない。`rendered.rerender()` は props を差し替えるので `use:observePanel` の `update()` が呼ばれ、その `queueMicrotask` が `readPanel` を実行してしまう（`WeatherEmergencyPanel.svelte:211`）。そのため修正前でも `panelWidth` が commit されてしまい、系統 B が再現しない。加えて `notifyInitialResize: false` は where 側の測定まで飢餓させ、`layoutState` が `pending` のままで `data-change-measurement-settled` が `"true"` に到達しない。**解除がプロップ更新ではなくタイマー由来である実配線でだけ、この経路が現れる。**

(e)(f)(g) は `emergency.test.ts` の既存 `EmergencyScreen` 描画テストの render 形（`data-testid={p.key}` で slot を取る形、`EmergencyScreen.svelte:196`）に倣う。`reducedMotion` は **false** にすること。true では `EmergencyScreen.svelte:154-157` が settling を即座に解除してしまい、窓が開かないので条件が再現しない。fake timer は既存の `settleFade()`（`emergency.test.ts:22-25`）と同じ流儀で進める。

### 4.3 「解除後に追加発火させない」の書き方

各ケースの解除ステップの後に、helper へ**発火回数のアサーションを足す**のではなく、`fireAll()` を呼ばないこと自体をテストの構造で保証する。実装者が後から `fireAll()` を足して緑にしてしまう事故を防ぐため、(a)(e)(f)(g) の解除ステップ直後に次のコメントを残す。

```
// C2: ここで geometry.fireAll() を呼んではいけない。
// 「解除後に ResizeObserver がもう一度来ない」ことが本テストの再現条件そのもの。
```

`installWeatherGeometry` に発火回数カウンタを足して「解除後の notify 回数が 0」を assert する案もあるが、helper の共有面を広げるので採らない。

### 4.4 維持する既存テスト

無変更で緑に保つ。

- `display/frontend/src/components/__tests__/emergency.test.ts`（3,770 行。特に `677-704` の activationKey 更新、`706-729` の余分な pass を数えない、`765-905` の再分割・page jump・nonconverged）
- `motion-wiring.test.ts` / `app-transition.test.ts` / `tsunami-panel.test.ts` / `eew-panel.test.ts` / `quake-map.test.ts`
- `capture-contract.test.ts` / `capture-design-alignment.test.ts` / `capture-center-stack-pregate.test.ts`
- `display/frontend/src/lib/__tests__/weather-panel.test.ts`（`1170-` の `acceptsMeasurement`）

### 4.5 実 Chrome gate（実走は親が担う）

Issue の案 8。`display/scripts/capture-legacy-standby.mjs` の headless 経路で、change surface / panel / 対象地域の overflow が 0 であること、probe と live の差が 1px 以内であることを再確認する。`--window-size` だけでは viewport 高が枠分（約 143px）減るため、`Emulation.setDeviceMetricsOverride` を attach 直後に掛け、report に `innerWidth` / `innerHeight` を含める（`capture-browser-session.mjs:39-43` の `deviceMetricsOverrideFor()`）。**子は `--assert-from` で records に対する assertion を検証するにとどめ、実走は親（Liebe）が担う。**

## 5. 受入条件

### 5.1 機械的に確認できるもの

```bash
# 1. 新規回帰テストが全件緑
/Users/sayue/dev/FlEq/display/node_modules/.bin/vitest run --root /Users/sayue/dev/FlEq/display \
  frontend/src/components/__tests__/weather-panel-geometry-flush.test.ts \
  --maxWorkers=2 --disable-console-intercept

# 2. display 全体のテストが緑
npm --prefix display test -- --maxWorkers=2

# 3. frontend の型検査 (svelte-check の警告・エラーとも 0)
npm --prefix display run typecheck

# 4. ビルドと root
npm --prefix display run build && npm run build && npm test
```

- §4.2 の (a)〜(g) が全件緑であること。
- **実装前に (a)(d)(e)(f)(g) が赤であったことを、実走出力とともに報告に含めること**（§4.0）。この 5 系統の赤が根因の証拠である。**(b)(c) は現行でも緑になる**ので、赤の要件から外す。(b) は現行が settling 中の測定を捨てており C1 を既に満たしているための「維持確認」、(c) は §3.2 C3 のとおり順序違反が外形観測できないための「将来の誤実装ガード」であり、どちらも根因の証拠には数えない。
- §4.4 の既存テストが 1 件も赤にならないこと。
- `grep -c "panelElement" display/frontend/src/components/WeatherEmergencyPanel.svelte` が 4 以上になること（現行 3 = 宣言・設定・解除のみ。参照が 1 つ以上増えたことの確認。案 B を採る場合はこの条件を pending buffer 変数名へ読み替える）。

### 5.2 配送 gate

main へ push 後、GitHub Actions（Test workflow）の緑を配送条件に含める。`gh run list --limit 1` で run id を取り、`gh run watch <id> --exit-status` で確認する。赤なら原因を切り分けて同じサイクル内で対処し、次サイクルへ持ち越さない。

§4.5 の実 Chrome gate は Pi 反映後に親が実走し、別途報告する。**本 spec の配送可否判定には §5.1 と §5.2 のみを使う。**

## 6. 判断分岐

### 分岐 1: 修正方式（推奨 A）

- **A（推奨）: 解除時の明示 re-read。** `panelElement` を購読する `$effect` を 474-482 の直後に足し、`readPanel(panelElement, input.activationKey)` を呼ぶ。同ファイルの where frame と同型で、新しい state を増やさず、読む値が解除時点の実 DOM になり、系統 B（settling 中 mount で一度も commit されない経路）も同じ 1 箇所で塞がる。§3.1 の理由 1〜3。
- **B: QuakePanel 型の pending buffer + flush。** `pendingPanelGeometry` を素の変数として持ち、settling 中は `readPanel` の結果をそこへ退避、解除 effect で flush する。他パネルと実装の見た目が揃うのが利点。欠点は 2 つで、(i) flush する値が遷移途中の RO 通知値であり最終 geometry の保証がない、(ii) settling 中 mount では buffer が空のままなので系統 B を塞げない。採るなら「buffer が空なら実 DOM を読む」フォールバックを必須条件に加える（実質 A を内包する）。

### 分岐 2: geometry helper の置き場（推奨 A）

- **A（推奨）: 新規ファイルを作らず `emergency.test.ts` に `describe` を 1 つ足す。** `installWeatherGeometry` / `settleWeatherLayout` / `weatherInput` / `weatherChange` の 4 つをそのまま使える。3,770 行のファイルがさらに伸びるのが代償だが、helper の重複ゼロで、既存の panel size テスト（677-704）の真隣に「fireAll を呼ばない版」が並ぶので対比が読み手に伝わる。
- **B: helper を `weather-geometry-test-utils.ts` へ切り出し、`weather-panel-geometry-flush.test.ts` を新設する。** 先例は `page-dots-test-utils.ts`。ファイル分割は綺麗になるが、`installWeatherGeometry` は `emergency.test.ts` 内の `weatherInput` などと暗黙に結合しており、切り出しの diff が本修正より大きくなる。切り出し自体が既存テスト全体への回帰リスクになる。

B を採る場合、§5.1 の 1 番目のコマンドのパスをそのファイルへ読み替える。A を採る場合は `emergency.test.ts` 全体を対象に実走する。

### 分岐 3: (f)(g) の EmergencyScreen 実配線テストを本 spec に含めるか（推奨 A）

- **A（推奨）: 含める。** Issue の案 7 が名指ししている。(a)〜(e) はすべて `WeatherEmergencyPanel` 単体へ prop で `layoutSettling` を渡す形なので、「`EmergencyScreen` の窓が実際にその prop を期待どおり開閉するか」は検証されない。`reducedMotion=false` と fake timer の組み合わせが要るぶん手間はあるが、系統 A の成立条件そのものを配線ごと固定できる。
- **B: (a)〜(e) の単体テストだけにする。** 実装量は減るが、`EmergencyScreen` 側の窓の長さや張り直し方式が将来変わったときに本件が無症状で再発する。採るなら `EmergencyScreen.svelte:161-166` に「この窓の中で panel geometry は捨てられ、解除時 effect が読み直す」旨のコメントを残すことを必須条件とする。

### 分岐 4: `panelElement` を `bind:this` へ揃えるか（推奨 A）

- **A（推奨）: `observePanel` の設定・解除（205・214）をそのまま使う。** 差分が effect 1 つで済む。action の `destroy` が `null` にするので、unmount 時の dangling も既に処理されている。
- **B: `whereFrameEl` と同じく `bind:this={panelElement}` を `.weather-panel` に足す。** 2 つの flush effect の見た目が完全に揃う。ただし action 側の代入（205・214）と `bind:this` の二重管理になり、どちらが真かが曖昧になる。揃えるなら action 側の代入を消す必要があり、diff が広がる。


## 裁定ラベル案

- **対象**: `display/frontend/src/components/WeatherEmergencyPanel.svelte` の `<script>` 内、474-491 付近の effect 群と `readPanel` / `observePanel`（188-218）。テストは §6 分岐 2 の裁定に従い `display/frontend/src/components/__tests__/emergency.test.ts` への追記、または `weather-panel-geometry-flush.test.ts` の新設と helper の切り出し。分岐 3 が B の場合は `display/frontend/src/components/EmergencyScreen.svelte:161-166` へのコメント追記を含む。
- **許容変更**: `layoutSettling` 解除時に `panelElement` から panel border-box を読み直す `$effect` の追加（`settlingEpoch` bump より前の位置）、それに伴う `panelElement` の参照追加、回帰テストの追加、テスト helper の切り出し（分岐 2 が B の場合のみ）。
- **禁止変更**: `acceptsMeasurement`（`weather-panel.ts:1291-1297`）とその呼び出し条件、`changeBatchKey` / `changeMeasurementKey` の構成要素、fit 探索・partition solver・probe 予算、`measureReserve` / `measureChangeCandidate` / `readReferenceBody` / `readAreaGeometry`、`EmergencyScreen` の settling 窓の長さと張り直し方式（分岐 3 の B で許すのはコメントのみ）、`QuakePanel` / `TsunamiPanel` / `EewPanel`、DOM 構造、CSS、theme token、engine 側の全ファイル、display protocol、`store.ts`、`package.json` / `package-lock.json`、永続化・通知・parser・router・formatter。
- **配送先**: main → personal → Pi。main で §5.1 の 4 コマンドを満たし GitHub Actions 緑（§5.2）を確認してから personal へ rebase 追従、その後 Pi へ反映する。§4.5 の実 Chrome gate は Pi 反映後に親が実走する。
- **ロールバック**: 本弾の単一実装 commit を revert し、main → personal → Pi の順に再配送する。DOM・CSS・wire・永続化のいずれも変更しないため data migration も再ビルド以外の後始末も不要。
- **受入条件**: §5.1 の 4 コマンドが全て成功し、§4.2 の (a)〜(g) が全件緑、実装前の (a)(d)(e)(f)(g) の赤が実走出力とともに報告されていること、§4.4 の既存テストが全件緑、`WeatherEmergencyPanel.svelte` 内の `panelElement` 参照が 1 つ以上増えていること、diff が「対象」に列挙したファイルの外へ出ていないこと。§4.5 は Pi 反映後の観測項目として別途報告する。
