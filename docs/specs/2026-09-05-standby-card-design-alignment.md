# 待機画面カードのデザイン言語再整合 spec

## 1. 症状

2026-08-25 以降に追加した BriefingCard の数値タイル、VPWP50 の WeatherWarningForecastCard、VPTA50 / VFVO54・55 の既存カード統合部に、[`display-design-system.md`](./display-design-system.md) と錨カード（WeatherAlertCard / LatestQuakeCard / TyphoonCard / VolcanoCard 本体）から外れた局所実装が残っている。

1. `display/frontend/src/components/BriefingCard.svelte:583-597` の記録的短時間大雨 stat grid は、`margin-inline: -var(--space-4)` 相当で本文の左右 gutter を相殺する。FHD 1920×1080 の preview `#standby-briefing` では、カード本文幅 574px、左右 padding 16px に対して grid 左端がカード端まで出ている。4 stat は auto-fit により 3+1 列となり、「時間幅」だけが二段目へ孤立する。ラベルと値の間隔も生値 `2px` である。
2. `display/frontend/src/components/TyphoonCard.svelte:233-247,325-375` の VPTA50 probability は、数値と `%` を通常の `<strong>` に連結している。`NumberUnit`、`--num-weight`、数値と単位のサイズ階層を使わないため、tier と数値 role に追従しない。同じ probability block の府県行間、peak、compact worst areaには生値 `2px` も残る。
3. `display/frontend/src/components/BriefingCard.svelte:581` の `.fact` は、theme に存在しない `--role-text` を参照する。宣言が無効になり、現在の色は親からの偶然の継承に依存する。
4. `display/frontend/src/components/BriefingCard.svelte:574` の `.source` は、theme に存在しない `--type-body-weight-regular` を参照する。宣言が無効になり、親 `.entry-label` の emphasized weight を継承して情報源と entry label の階層が消える。
5. `display/frontend/src/components/WeatherWarningForecastCard.svelte:146-150` は period 行間に生値 `2px` を使い、複数ページ時には共通 header の block padding を `calc(var(--space-2) - 3px)` まで削る。本文、header、pager が同時に密集し、4px spacing grid と header 共通契約から外れる。
6. `display/frontend/src/components/VolcanoCard.svelte:385-393,466` は `band === "muted"` でも container / on / band の三変数を注入する。最終表示は muted class に上書きされるが、「muted header は三変数と band を持たない」という構造契約に反する。
7. `display/frontend/src/components/LatestQuakeCard.svelte:403-412` と `QuakeReplayCard.svelte:144-153` は、special unknown と津波マークの意味色に primitive の `--c-raspberry` / `--c-jma-red` を直接使う。現色は正しくても role の再割当てに追従しない。

加えて、`docs/specs/display-design-system.md §5` のコンポーネントカタログには BriefingCard、WeatherWarningForecastCard、TyphoonCard の VPTA50 統合契約、VolcanoCard の VFVO54 / 55 統合契約がなく、実装レビュー時の照合先が欠けている。§5.1も BriefingCard / WeatherWarningForecastCard を候補一覧から落とし、engine配列順を描画順とする旧説明がfrontendの固定 `CARD_ORDER` と矛盾している。

## 2. 根因

個別の高さ・横幅予算を成立させる局所調整が、共通 token と component contract より優先されたことが根因である。

- BriefingCard では、旧 spec [`2026-08-28-briefing-fact-tiles.md`](./2026-08-28-briefing-fact-tiles.md) の「TyphoonCard の auto-fit / 9rem 下限を複製する」を狭い側カードへそのまま適用し、二列を維持するため本文 gutter を借りる実装時裁定を加えた。この裁定は報告されず、実機では余白不足と 3+1 配置を生んだ。
- VPTA50 / VPWP50 / VFVO54・55 は既存カードへ機能を足すことを優先し、NumberUnit、spacing、muted header の既存契約を統合部へ最後まで通さなかった。
- 存在しない token と primitive 直参照を禁止する静的 assertion、ならびに VPWP50 / VPTA50 を単独で目視できる preview が不足し、継承や CSS 上書きで見た目だけ成立する状態を検出できなかった。
- 実装時裁定を spec へ戻す手順がなく、仕様との差異が「一時的な実装判断」のまま残った。

本修正は表示言語の再整合に限定する。parser、engine の導出、wire、永続化、通知、ページ atom の identity / 順序 / 件数、header tone / severity の意味は変更しない。

## 3. 変更

### 3.1 BriefingCard の gutter、2×2 数値タイル、token spacing

対象: `display/frontend/src/components/BriefingCard.svelte:583-597`。

記録的短時間大雨の4 stat は、地点、雨量、時刻、時間幅の DOM 順を維持し、常に二列の 2×2 grid とする。`auto-fit` は使わない。grid は `.body` の `padding-inline: var(--space-4)` の内側に置き、負の margin で gutter を借りてはならない。

変更前:

```css
.briefing-fact-grid {
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr));
  gap: var(--space-1) var(--space-3);
  margin: var(--space-1) calc(-1 * var(--space-4)) 0;
}
.briefing-fact-stat { gap: 2px; }
```

変更後:

```css
.briefing-fact-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-1) var(--space-3);
  margin-top: var(--space-1);
}
.briefing-fact-stat { gap: var(--space-1); }
```

row / column gap は錨である TyphoonCard の stat grid と同じ `var(--space-1) var(--space-3)` を保つ。列下限は持たない。9rem 下限が二列に必要な幅をカード幅より大きくし、負の margin を呼び込んだためである。`minmax(0, 1fr)` で grid item の min-content 幅を列下限にせず、既存の `.briefing-fact-value { flex-wrap: wrap; overflow-wrap: anywhere; }` と `.briefing-fact-token { white-space: nowrap; }` で値側を実幅へ追従させる。

側列幅は `StandbyScreen.svelte:2248,2253-2262,2276-2282` を正本として計算する。preview の root computed font-size は16pxを前提とし、`17.5rem = 280px`、`36rem = 576px` である。viewport 幅を `W`、edge を `E`、列 gap を `G`、center 幅を `C` とすると、480px 上限に達しない三条件の card border-box 幅 `S` は次である。

```text
C = min(576px, W - 2E - 2G - 2 × 280px)
S = (W - 2E - 2G - C) / 2
stat 列幅 = (S - 左右 border 2px - 左右 body gutter - grid column-gap) / 2
```

| 条件 | `E` | `G` | `C` | card `S` | body gutter | grid gap | stat 1列 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1280px・通常段 | 32.00px | 12.80px | 576.00px | 307.20px | 16px × 2 | 12px | **130.60px** |
| 1280px・圧縮段 | 23.04px | 7.68px | 576.00px | 321.28px | 8px × 2 | 6px | **148.64px** |
| 960px・圧縮段 | 17.28px | 5.76px | 353.92px | 280.00px | 8px × 2 | 6px | **128.00px** |

1280px の通常段と圧縮段は同じ viewport 幅でも `--edge` / `--gap` と spacing token が異なる別条件である。高さ方向の solver が stage 2 以上へ入ったときだけ `.ladder-compressed` が成立する。単独カードの scenario は通常段、§3.8 の混雑 fixture は圧縮段を検証し、両者の値を混在させない。960px は圧縮後も `--side-readable-width: 17.5rem = 280px` が側列の下限になる。

現行 corpus / component fixture の構造化地点名で最長の `さいたま市` は全角5字である。値 font は1280pxで19px、960pxで15.36pxなので、保守的に全角1字=1emとしても95px / 76.8pxであり、三条件すべて一行で収まる。

parser 契約上、有効な一つの precipitation fact に前置「約」と後置「以上」は同時に現れない。幅の受入対象は実在する二値 `約100mm` と `120mm以上` に限定し、両方とも三条件で一行表示する。将来の有効値が列幅を超える場合は `.briefing-fact-value` の flex fragment 境界で補助語と不可分の NumberUnit を分けて折り返し、`NumberUnit` の数値と単位は同じ `.briefing-fact-token` 内で分断しない。地点名など一 fragment 自体が列幅を超えた場合だけ既存の `overflow-wrap: anywhere` で折り返し、ellipsis、clip、横 overflow、文字欠落は許さない。

旧 spec §3.1 の「auto-fit / 9rem 下限」は本節で上書きする。それ以外の fail-open、atomic page block、`NumberUnit`、data attribute、欠損 stat の省略規則は維持する。4 stat が揃う通常形だけでなく欠損時も二列定義は維持し、残る stat を DOM 順に詰める。実測が上記計算と1pxを超えて食い違う場合は gutter や二列を破らず、§3.11 の逸脱報告を先に行う。

### 3.2 TyphoonCard の VPTA50 probability を NumberUnit へ統一

対象: `display/frontend/src/components/TyphoonCard.svelte:228-247,313-375`。

full / compact の最大5日確率、府県一覧、worst area の全 probability 数値を `NumberUnit value={String(value)} unit="%"` で描画する。文字列の末尾へ `%` を直接連結せず、各値を同じ `.probability-number` role で包む。既存の hPa / m/s は RollingNumber と一体の明示済み例外なので変更しない。

変更前:

```svelte
<strong>{typhoon.probability.maxFiveDayProbability}%</strong>
<strong>{prefecture.fiveDayProbability}%</strong>
<strong>{typhoon.probability.worstArea.fiveDayProbability}%</strong>
```

変更後:

```svelte
<span class="probability-number"><NumberUnit value={String(typhoon.probability.maxFiveDayProbability)} unit="%" /></span>
<span class="probability-number"><NumberUnit value={String(prefecture.fiveDayProbability)} unit="%" /></span>
<span class="probability-number"><NumberUnit value={String(typhoon.probability.worstArea.fiveDayProbability)} unit="%" /></span>
```

compact の `5日以内 最大` 行と府県列も同じ構造へ分割する。可視テキスト、full 最大5府県、compact 最大3府県、`ほかN府県等`、worst area、peak 時刻は変えない。

変更前:

```css
.probability-maximum strong,
.probability-worst strong,
.probability-prefecture-list li strong {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.probability-prefecture-list { gap: 2px var(--space-3); }
.probability-peak { margin-top: 2px; }
.probability-worst--compact { margin-top: 2px; }
```

変更後:

```css
.probability-number {
  flex-shrink: 0;
  white-space: nowrap;
  font-size: max(14px, var(--type-body-l-fluid));
}
.probability--compact .probability-number {
  font-size: max(14px, var(--type-body-s-fluid));
}
.probability-prefecture-list { gap: var(--space-1) var(--space-3); }
.probability-peak { margin-top: var(--space-1); }
.probability-worst--compact { margin-top: var(--space-1); }
```

`tabular-nums` と `--num-weight` は `NumberUnit` の `.nu-value`、単位の通常 weight と縮小は `.nu-unit` を正本とする。TyphoonCard 側で同じ責務を重複定義しない。NumberUnit 化で同時に触る probability block 内の生値 `2px` はすべて `--space-1` へ寄せる。probability-only は引き続き muted header、combined は VPTW 由来 header tone とし、確率値から severity を導出しない。

### 3.3 BriefingCard `.fact` の未定義色 token を除去

対象: `display/frontend/src/components/BriefingCard.svelte:580-581`。

`.fact` は通常本文であり、独自の警報意味色を持たないため `--fg` を明示する。event / precipitation を含む本文の可読色を親継承へ委ねない。

変更前:

```css
.fact { color: var(--role-text); }
```

変更後:

```css
.fact { color: var(--fg); }
```

### 3.4 BriefingCard `.source` の weight role を修正

対象: `display/frontend/src/components/BriefingCard.svelte:573-574`。

情報源は entry label の補助情報なので baseline の body weight を使い、親の emphasized weight を明示的に打ち消す。

変更前:

```css
.source { font-weight: var(--type-body-weight-regular); }
```

変更後:

```css
.source { font-weight: var(--type-body-weight); }
```

### 3.5 WeatherWarningForecastCard の spacing と header 契約

対象: `display/frontend/src/components/WeatherWarningForecastCard.svelte:141-152`。

period の行間は `--space-1` とする。複数 atom の footer がある場合も header は共通 contract の `padding: var(--space-2) var(--space-4)` を保つ。footer の高さは既存の card bottom reserve `--card-page-indicator-block-size` だけで確保し、header から差し引かない。

変更前:

```css
.periods { display: grid; gap: 2px; }
.forecast-card.has-page-footer {
  padding-bottom: var(--card-page-indicator-block-size);
}
.forecast-card.has-page-footer .standby-card-header {
  padding-top: calc(var(--space-2) - 3px);
  padding-bottom: calc(var(--space-2) - 3px);
}
```

変更後:

```css
.periods { display: grid; gap: var(--space-1); }
.forecast-card.has-page-footer {
  padding-bottom: var(--card-page-indicator-block-size);
}
```

4 period を持つ最大 atom では、通常段で header が上下合計6px、三つの period 行間が合計6px増えるため、自然高は変更前より約12px増える。圧縮段では header が上下合計6px増え、`--space-1` は現行生値と同じ2pxなので、自然高は約6px増える。measurement shelf はこの実高を取り込むため probe / live の一致だけでは回帰検出にならない。§5.3 で、変更前後の最大 atom 高と1280×720 `max` fixture の stage、選抜、rotation、overflow を比較する。

旧 VPWP50 spec の **最大4期間/atom、pager anchor ごとの atom 構成、identity、入力順、全期間保持** は変更禁止とする。期間数の削減、ellipsis 以外の文字切詰め、追加分割、別 atom との併合、scroll 化で高さを吸収してはならない。許される変更は本節に示した `.periods` の token 化、footer 時 header override の削除、既存 bottom reserve の維持だけである。これで layout gate が収まらない、または変更前の選抜契約を保てない場合は実装を停止して §3.11 の報告を行う。

WeatherAlertCard / BriefingCard に既存 spec が認めた footer 時の高さ補償は本修正の対象外であり、横展開してはならない。対象地域と period は一つの atom に保ち、pager identity、continuation、ellipsis、`title`、accessible name は維持する。

### 3.6 VolcanoCard muted header の三変数を除去

対象: `display/frontend/src/components/VolcanoCard.svelte:385-393,466`。

TyphoonCard と同じく、muted のときは `headerStyle` を空文字列とする。通常 tone の場合だけ container / on / band の三変数を注入する。

変更前:

```ts
band === "muted"
  ? "--standby-header-container: var(--surface-standby); --standby-header-on: var(--fg); --standby-header-band: var(--surface-standby)"
  : advisoryStyle
```

変更後:

```ts
band === "muted"
  ? ""
  : advisoryStyle
```

`.standby-card-header--muted` が `background: transparent`、`color: var(--role-muted)`、`border-bottom: 0` を所有する。engine が供給する `headerTone` の優先、旧 snapshot の fallback、malformed tone warning、ashfall から独自 tone を導出しない規則は変えない。

### 3.7 quake 2カードの primitive 色を semantic role へ接続

対象: `display/frontend/src/components/LatestQuakeCard.svelte:403-412`、`display/frontend/src/components/QuakeReplayCard.svelte:144-153`。

special unknown は取消・不明の既存 semantic role `--role-cancel`、津波マークは `--role-tsunamiWarning` へ接続する。両 role は現在それぞれ `--c-raspberry`、`--c-jma-red` を参照するため現色を維持しつつ、将来の role 再割当てへ追従できる。

変更前:

```css
.int-chip.special-unknown,
.g-int.special-unknown { color: var(--c-raspberry); }
.tsunami-mark { color: var(--c-jma-red); }
```

変更後:

```css
.int-chip.special-unknown,
.g-int.special-unknown { color: var(--role-cancel); }
.tsunami-mark { color: var(--role-tsunamiWarning); }
```

震度8 / 9 の on-color `#000` / `#fff` は反転文字の明示的例外であり、本修正では変更しない。

### 3.8 Briefing 境界値 / VPWP50 / VPTA50 の専用 preview

対象: `display/frontend/src/preview/fixtures.ts`、`display/frontend/src/preview/PreviewApp.svelte`。

選抜や rotation に隠れず単独で目視できる次の4 scenario を、選択肢を残さず固定名で追加する。

- `#standby-briefing-design-alignment`: BriefingCard 1枚に、有効な別々の precipitation fact として `さいたま市 + 約100mm` と `美幌町 + 120mm以上` を入れる。両 fact は時刻と時間幅も持ち、4 stat の2×2と実在二値の行数を通常段で計測できる。parser 契約に存在しない両修飾同時の合成値は作らない。ページ分割される場合は card page tick で両 fact を捕捉する。
- `#standby-vpwp50-forecast`: `legacyImprovedWeatherWarningForecast` を単独の standby item として表示し、4 period を持つ複数 atom の header、period spacing、footer を観測できる。
- `#standby-vpta50-probability-muted`: VPTA50 probability-only の台風1件を表示する。最大値、府県一覧、worst area の NumberUnit と、transparent / `--role-muted` / bandなしの muted header を観測する。
- `#standby-vpta50-probability-normal`: VPTW 実況と VPTA50 probability を持つ同一台風1件を表示する。三箇所の NumberUnit と、VPTW だけから決まる通常の header 三組を観測する。

VPTA50 の二 scenario は同じ probability payload を使い、VPTW 実況の有無だけを変える。これにより、確率値ではなく VPTW が header tone を決めることを同値比較できる。

この4 scenario は単独カードなので通常段専用とし、1280×720で圧縮段の証拠には使わない。圧縮段には実 `StandbyScreen` の既存 `#standby-right-stack-budget` の構成方法と `legacyStandbyGateSnapshot("max")` の密度を再利用した固定 scenario `#standby-design-alignment-compressed` を追加する。`itemOf()` が同じ kind の先頭一件だけを候補化する契約に合わせ、solver candidate は次の9 kindを各一件だけ供給する。

| candidate kind | 固定 payload |
|---|---|
| `tsunami` | `tsunamiBanner` |
| `quake` | `latestQuakeStandbyCards` に `legacyImprovedExpandedLatestQuake` の展開地域を付ける既存 max payload |
| `weather` | `legacyImprovedMaxWeatherAlertsCompact` と canonical 展開元 `legacyImprovedMaxWeatherAlerts` |
| `weatherWarningForecast` | `legacyImprovedWeatherWarningForecast`。128 period / 32 atomで、最大 atom は4 period、複数 atom footerあり |
| `briefing` | `さいたま市 + 約100mm` と `美幌町 + 120mm以上` を別 fact にした §3.8 の境界 payload |
| `flood` | `legacyImprovedMaxItems` の `standbyItemsShowcase` 由来1 item、3河川 |
| `typhoon` | `legacyImprovedMaxItems` の2台風を持つ1 item。`TC2618` に `maxFiveDayProbability: 80`、`activePrefectureCount: 8`、東京都80 / 神奈川県70 / 千葉県60 / 埼玉県50 / 茨城県40 / 栃木県30、worst `東京地方 80` のVPTA50を統合 |
| `volcano` | `legacyImprovedMaxItems` の5火山を持つ1 item |
| `heat` | `legacyImprovedMaxItems` の30地域を持つ1 item |

rider / reserve は同じ max payload の `tornado`、`longPeriod`、`nankaiTrough` を各一件維持するが、これらを別の solver candidate と数えない。`heat` を含む同 kind の複製は追加しない。専用 scenario のために parser / wire fixtureを増やさない。

1280×720と960×620の期待 plan は、Chrome の真の viewport を `Emulation.setDeviceMetricsOverride` で設定し、`document.fonts.ready` 後かつ measurement settled で得た次の実測値へ固定する。両 viewport とも stage は厳密に3、`.ladder-compressed` は成立する。stage 2 以上という一般契約だけで表の不一致を許容しない。

| viewport | stage | compressed | side-left | side-right | center | rotation（canonical順） | Typhoon variant | omitted |
|---|---:|---|---|---|---|---|---|---:|
| 1280×720 | `3` | `true` | `tsunami,quake,weatherWarningForecast` | `briefing` | `weather` | `flood,typhoon,volcano,heat` | `compact` | `0` |
| 960×620 | `3` | `true` | `tsunami,quake` | 空 | 空 | `weather,weatherWarningForecast,briefing,flood,typhoon,volcano,heat` | `compact` | `0` |

capture は全対象を side measurement shelf で測る。1280×720では WeatherWarningForecastCard を左列、BriefingCard を右列の常時可視 side surface で捕捉し、4 rotation tickを進めてcompact TyphoonCardを捕捉する。960×620では7 rotation tickを進めて BriefingCard、WeatherWarningForecastCard、compact TyphoonCardをそれぞれ live rotation surface で捕捉する。base / after の stage、compressed、placement、rotation、variant、omitted は上表と完全一致させる。強制圧縮 prop / query、`gateFixture` の新値、本番 `StandbyScreen` APIは新設せず、各 scenario はURLから安定して選択できなければならない。

### 3.9 `display-design-system.md §5` のカタログ追記

対象: `docs/specs/display-design-system.md §5 コンポーネントカタログ` と `§5.1 待機画面カード拡充`。生成領域の §8 は編集しない。

次の4項目を追記し、実装後の class / token 名と一致させる。

- **BriefingCard**: 待機画面の気象防災速報／線状降水帯／記録的短時間大雨を、電文 entry 単位でページング表示するカード。`--surface-standby`、weather header 三組、`--space-*`、`--role-muted`、`--num-weight` に依存する。雨量は `NumberUnit` を使う不可分の 2×2 stat grid、線状降水帯は地点・状態・時刻を持つ atomic 行とする。複数 entry、対象地域の省略、ページ位置は本文から隠さず明示する。
- **WeatherWarningForecastCard**: VPWP50 の気象警報予測を、forecast label、対象地域、時期別 period として表示する待機カード。`--surface-standby`、weather header 三組、`--space-*`、`--role-muted`、既存 pager footer に依存する。対象地域と period は一ページ内で同じ atom に保ち、複数 atom 時だけ既存 indicator を表示する。表示上の ellipsis は許容するが、全文は `title` と accessible name に残す。footer があっても共通 header padding を縮めない。
- **TyphoonCard（VPTA50 統合）**: VPTW の台風実況に、VPTA50 の「暴風域に入る確率（5日以内）」を同一台風 block 内で追加表示する。`--surface-standby`、既存 weather header 三組、`--role-muted`、`--space-*`、`--num-weight`、`NumberUnit` に依存する。probability は header tone や severity を変更せず、probability-only は muted header のままとする。full は最大5府県、compact は最大3府県を表示し、残件は `ほかN府県等` として可視化する。
- **VolcanoCard（VFVO54 / 55 統合）**: 火山警報・噴火情報に加え、VFVO54 / 55 の降灰予報を火山ごとの補助 section として表示する待機カード。`--surface-standby`、既存 header 三組、`--role-weather*`、`--role-muted`、`--space-*` に依存する。降灰予報は区分→対象地域の階層を保ち、区分・地域・火山の省略をそれぞれ `ほかN…` で可視化する。engine が供給する header tone を優先し、降灰予報の内容・区分から独自の警報色・帯を導出しない。muted header は三変数と band を持たない。

既存の TyphoonCard / VolcanoCard 項目と重複する場合は、新項目を別名で並べず、既存項目へ上記統合契約を追記して一項目にまとめる。

`§5` の **StandbyScreen** 項目と `§5.1 待機画面カード拡充` は、旧文へ順序説明だけを継ぎ足さず、候補一覧、幅の正本、段階 solver を現実装へ全面同期する。カード一覧には WeatherWarningForecastCard と BriefingCard を加え、`weather`、`weatherWarningForecast`、`briefing`、`flood`、`typhoon`、`volcano` は center 移動可能、`heat` は右側候補、`tsunami` / `quake` は左側候補と記す。

幅の正本は `StandbyScreen.svelte` の `.standby` にある `--base-edge`、`--base-gap`、`--compressed-edge`、`--compressed-gap`、解決後の `--edge` / `--gap`、`--side-readable-width: 17.5rem`、`--center-width` とする。center は `min(36rem, calc(100vw - 2 × edge - 2 × gap - 2 × side-readable-width))`、side の measurement shelf と live track は同じ残幅の `min(30rem, calc((100% - 2 × edge - 2 × gap - center-width) / 2))` を使うと説明する。圧縮時は edge / gap と `--space-1`〜`--space-5` を `.standby.ladder-compressed` で切り替える。定義のない `--standby-card-width` を真実源とする旧説明は削除する。

solver は実高を入力に、次の `spill → center → 圧縮 → rotation` の順で説明する。Typhoon の full → compact は独立した最終段ではなく、各 geometry で次段へ進む前に試す variant fallback である。

1. **spill**: stage 0 では `tsunami` / `quake` を左、その他を右へ canonical 順に置く。右だけが溢れる場合は右列の canonical suffix を左へ移し、実高で収容を試す。
2. **center**: sideだけで収まらなければ、center eligible kind の組合せを実高で評価して stage 1 の配置を選ぶ。
3. **圧縮**: 通常 geometry の自動計画が rotation 到達相当になったとき、`.ladder-compressed` の実幅・spacingで stage 2 を下限に再計測・再計画する。stage 2 で解決すればその圧縮 plan を採る。
4. **rotation**: 圧縮しても解決しない場合は stage 3 とし、右側候補を有界探索で rotation slot へ送る。rotation key は canonical 順へ戻し、収容不能は omitted / failure count と `data-layout-unresolved` で診断する。`StandbyOverflowSummary` へ集約する経路は存在しない。

候補順の説明は `StandbyScreen.svelte:89,596-625` と `solver.ts:14-16,48-62` を正本に、次へ置換する。

```text
frontend は CARD_ORDER
tsunami → quake → weather → weatherWarningForecast → briefing → flood → typhoon → volcano → heat
を canonical kind 順として各候補へ order を付ける。solver は実高で spill、center、
圧縮、rotationを決め、candidateScoreの上昇は前回配置の安定化lockを解除する。
同じ列へ採用したカードとrotation keyの描画順はこのorderへ戻す。
engine の standbyItems 配列順は kind 間の描画順を変更しない。
```

既存の「engine 配列順が描画順の protocol 契約」「frontend は kind 固定順を保証しない」「severity降順 + 配列順tie-break」「描画順は常に配列順」は削除する。`StandbyOverflowSummary` 三段構えと `--standby-card-width` の説明も残さない。洪水の side / center 表示、rider、NankaiBadge、RestoredChip、critical standby のうち上記 solver と矛盾しない契約は維持し、FHD未満を未解決の既知制約とする旧記述は現行の実高solver・overflow診断へ置換する。§5 と §5.1 に相反する順序、幅、overflow契約を残さない。

### 3.10 残す raw spacing の境界

今回 token 化する raw spacing は BriefingCard `.briefing-fact-stat`、WeatherWarningForecastCard `.periods`、TyphoonCard probability block の三箇所群に限定する。監査対象6カードに既存する次の固定 geometry は、変更するとページ高・震度 chip・旧錨カードの見た目まで範囲が広がるため、本弾の対象外として現状維持する。

- TyphoonCard の非 probability 部: `.remark`、`.stat`、`.change-summary`、`.compact-summary` の2px、および RollingNumber と一体の `.stat-unit` 1px。
- VolcanoCard 本体: `.alert-meaning`、直近 event の `strong`、`.stat` の2px。
- LatestQuakeCard / QuakeReplayCard 本体: `.int-chip` の `2px 6px`、`.stat` / `.g-pref-groups` / `.g-omitted` の2px、`.groups li` の10px gapと3px block padding、LatestQuakeCard `.meta` の6px bottomと4pxの list / page-detail margin、page-detail高の `+ 4px`。LatestQuakeCard の rider左border 3px、QuakeReplayCard のfocus outline / offset 2pxも構造・focus geometryとして維持する。
- BriefingCard / WeatherWarningForecastCard / VolcanoCard の pager block-size `+ 4px` と `.card-page-indicator` 1px padding、BriefingCard に既存承認済みの footer 時 header `-3px` 補償、全カードの1px borderは、共通 pager / hairline geometry として対象外とする。

これらは raw spacing を一般に正当化する新規例外ではない。次回その selector の構造を変更するときに token 化を再監査する。上記以外の新しい raw px を本弾で追加してはならない。

### 3.11 実装時裁定と spec 逸脱の報告

実装中に実測値、既存 layout gate、型制約などから本 spec どおりに実装できないと判明した場合は、変更を入れる前に次を報告する。

1. 逸脱する節と規則。
2. 実測値または失敗した機械検証。
3. 採用したい代替案と、gutter、2×2、header、semantic role、情報欠落への影響。
4. spec 本文を同じ弾で更新するか、未解決として止めるか。

本改訂での適用事例として、§3.8 の期待 plan は CSS 見積りと高さ577pxの初期観測で起草されたが、真の1280×720 viewport実測で覆し、実測値を正として本文と受入条件を更新した。

実装時コメントだけで裁定を完結させてはならない。特に負の margin、raw px、未定義 token、primitive 直参照、共通 header の局所縮小は、明示承認なしに再導入しない。

## 4. 対象ファイル

実装対象:

- `display/frontend/src/components/BriefingCard.svelte`
- `display/frontend/src/components/WeatherWarningForecastCard.svelte`
- `display/frontend/src/components/TyphoonCard.svelte`
- `display/frontend/src/components/VolcanoCard.svelte`
- `display/frontend/src/components/LatestQuakeCard.svelte`
- `display/frontend/src/components/QuakeReplayCard.svelte`
- `display/frontend/src/preview/fixtures.ts`
- `display/frontend/src/preview/PreviewApp.svelte`
- `display/scripts/capture-legacy-standby.mjs`（§5 の固定 `design-alignment` suite、geometry report、base比較、非0終了 assertion を必須実装）
- `docs/specs/display-design-system.md`（§5カタログと§5.1。§8 generated 領域は変更禁止）

テスト対象:

- `display/frontend/src/components/__tests__/briefing-card.test.ts`
- `display/frontend/src/components/__tests__/weather-warning-forecast-card.test.ts`
- `display/frontend/src/components/__tests__/typhoon-card.test.ts`
- `display/frontend/src/components/__tests__/volcano-card.test.ts`
- `display/frontend/src/components/__tests__/latest-quake-card.test.ts`
- `display/frontend/src/components/__tests__/quake-replay-card.test.ts`
- preview / capture の既存テスト（新 scenario、fixture、report field、非0終了 assertion を検査する最小範囲）

変更対象外:

- parser、engine、wire protocol、永続化、通知、CLI
- `display/frontend/src/components/NumberUnit.svelte`
- `display/frontend/src/lib/theme.css`
- `display/frontend/src/lib/legacy-standby/solver.ts` と `StandbyScreen.svelte` の solver / stage API
- WeatherAlertCard / BriefingCard に既存の footer 時 header 補償
- `display/frontend/src/preview/LegacyImprovedMock.svelte` の凍結参照ミラー（新 preview scenario の成立に不可欠と判明した場合は §3.11 に従い先に報告する）

## 5. 受入条件

### 5.1 静的契約

否定条件はファイルごとに独立して0件を要求する。

```sh
! rg 'calc\(-1 \* var\(--space-4\)\)' display/frontend/src/components/BriefingCard.svelte
! rg 'grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 9rem\)' display/frontend/src/components/BriefingCard.svelte
! rg -- '--role-text|--type-body-weight-regular' display/frontend/src/components/BriefingCard.svelte
! rg '\.periods \{ display: grid; gap: 2px; \}' display/frontend/src/components/WeatherWarningForecastCard.svelte
! rg 'has-page-footer \.standby-card-header' display/frontend/src/components/WeatherWarningForecastCard.svelte
! rg -U '\.probability-prefecture-list\s*\{[^}]*gap: 2px var\(--space-3\)' display/frontend/src/components/TyphoonCard.svelte
! rg '\.probability-peak \{ margin-top: 2px' display/frontend/src/components/TyphoonCard.svelte
! rg -U '\.probability-worst--compact\s*\{[^}]*margin-top: 2px' display/frontend/src/components/TyphoonCard.svelte
! rg '(maxFiveDayProbability|fiveDayProbability)\}%' display/frontend/src/components/TyphoonCard.svelte
! rg -U '\.int-chip\.special-unknown,[^}]*--c-raspberry' display/frontend/src/components/LatestQuakeCard.svelte
! rg -U '\.tsunami-mark\s*\{[^}]*--c-jma-red' display/frontend/src/components/LatestQuakeCard.svelte
! rg -U '\.int-chip\.special-unknown,[^}]*--c-raspberry' display/frontend/src/components/QuakeReplayCard.svelte
! rg -U '\.tsunami-mark\s*\{[^}]*--c-jma-red' display/frontend/src/components/QuakeReplayCard.svelte
! rg -- '--standby-header-container: var\(--surface-standby\).*--standby-header-band: var\(--surface-standby\)' display/frontend/src/components/VolcanoCard.svelte
! rg 'engine が供給する候補配列の順序を描画順の protocol 契約' docs/specs/display-design-system.md
! rg 'frontend は kind による固定順を保証しない' docs/specs/display-design-system.md
! rg 'severity 降順 \+ 配列順 tie-break|描画順は常に配列順' docs/specs/display-design-system.md
! rg 'StandbyOverflowSummary' docs/specs/display-design-system.md
! rg -- '--standby-card-width' docs/specs/display-design-system.md
```

肯定条件は対象 selector / ファイルごとに分け、各コマンドが1件以上を返す。

```sh
rg -U '\.briefing-fact-grid\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[^}]*gap: var\(--space-1\) var\(--space-3\);[^}]*margin-top: var\(--space-1\);' display/frontend/src/components/BriefingCard.svelte
rg -U '\.briefing-fact-stat\s*\{[^}]*gap: var\(--space-1\);' display/frontend/src/components/BriefingCard.svelte
rg '\.fact \{ color: var\(--fg\); \}' display/frontend/src/components/BriefingCard.svelte
rg -U '\.source\s*\{[^}]*font-weight: var\(--type-body-weight\);' display/frontend/src/components/BriefingCard.svelte
rg '\.periods \{ display: grid; gap: var\(--space-1\); \}' display/frontend/src/components/WeatherWarningForecastCard.svelte
rg -U '\.probability-prefecture-list\s*\{[^}]*gap: var\(--space-1\) var\(--space-3\);' display/frontend/src/components/TyphoonCard.svelte
rg '\.probability-peak \{ margin-top: var\(--space-1\);' display/frontend/src/components/TyphoonCard.svelte
rg -U '\.probability-worst--compact\s*\{[^}]*margin-top: var\(--space-1\);' display/frontend/src/components/TyphoonCard.svelte
rg -U '\.int-chip\.special-unknown,[^}]*--role-cancel' display/frontend/src/components/LatestQuakeCard.svelte
rg -U '\.tsunami-mark\s*\{[^}]*--role-tsunamiWarning' display/frontend/src/components/LatestQuakeCard.svelte
rg -U '\.int-chip\.special-unknown,[^}]*--role-cancel' display/frontend/src/components/QuakeReplayCard.svelte
rg -U '\.tsunami-mark\s*\{[^}]*--role-tsunamiWarning' display/frontend/src/components/QuakeReplayCard.svelte
rg '"standby-briefing-design-alignment"' display/frontend/src/preview/PreviewApp.svelte
rg '"standby-vpwp50-forecast"' display/frontend/src/preview/PreviewApp.svelte
rg '"standby-vpta50-probability-muted"' display/frontend/src/preview/PreviewApp.svelte
rg '"standby-vpta50-probability-normal"' display/frontend/src/preview/PreviewApp.svelte
rg '"standby-design-alignment-compressed"' display/frontend/src/preview/PreviewApp.svelte
rg '^\- \*\*BriefingCard\*\*:' docs/specs/display-design-system.md
rg '^\- \*\*WeatherWarningForecastCard\*\*:' docs/specs/display-design-system.md
rg -U '^\- \*\*TyphoonCard[^\n]*VPTA50' docs/specs/display-design-system.md
rg -U '^\- \*\*VolcanoCard[^\n]*VFVO54 / 55' docs/specs/display-design-system.md
rg 'tsunami.*quake.*weather.*weatherWarningForecast.*briefing.*flood.*typhoon.*volcano.*heat' docs/specs/display-design-system.md
rg 'spill → center → 圧縮 → rotation' docs/specs/display-design-system.md
rg -- '--side-readable-width' docs/specs/display-design-system.md
rg -- '--center-width' docs/specs/display-design-system.md
```

Volcano の ternary は単なる `band === "muted"` の存在では判定しない。§5.2 の DOM test で muted の style 属性から三変数がすべて消えることを検査する。Typhoon の `NumberUnit` も文字列検索だけでなく、各 probability role の DOM test を正本とする。

### 5.2 component / DOM

- BriefingCard: 4 stat が `地点 → 雨量 → 時刻 → 時間幅` の DOM 順で同じ `data-briefing-precipitation-stat` にあり、既存 `NumberUnit`、欠損 fail-open、atomic page block を維持する。CSS source test は grid / stat の selector 単位で `minmax(0, 1fr)` と token gap を検査し、source の weight は `--type-body-weight`、`.fact` は `--fg` とする。
- TyphoonCard: full / compact の最大値、表示府県の全値、worst area の各 probability に `.probability-number > .nu-value + .nu-unit` 相当の一組があり、`.nu-unit` は `%`、`.nu-value` は `--num-weight` を使う。可視テキスト、5 / 3件上限、omitted count、peak、wire order、probability-only muted、probability 非依存の header tone は既存期待を維持する。probability block 三箇所の spacing は `--space-1` を source test で個別確認する。
- WeatherWarningForecastCard: single / multi atom の label、target、period、continuation、footer、accessible nameを維持する。全 atom は1〜4 period、既存128-period fixture は32 atomのままで、period key / identity / 順序 / 総数が変わらない。multi atom でも header の局所 padding override を持たない。
- VolcanoCard: muted header は muted class を持ち、style 属性が空または三変数を含まない。advisory / warning / red / emergency は対応する三変数を持つ。
- LatestQuakeCard / QuakeReplayCard: special unknown と津波マークの DOM / border / 可視文字を変えず、CSS source assertion は semantic role を期待する。

対象 vitest を個別に通す。

```sh
npm --prefix display test -- \
  frontend/src/components/__tests__/briefing-card.test.ts \
  frontend/src/components/__tests__/weather-warning-forecast-card.test.ts \
  frontend/src/components/__tests__/typhoon-card.test.ts \
  frontend/src/components/__tests__/volcano-card.test.ts \
  frontend/src/components/__tests__/latest-quake-card.test.ts \
  frontend/src/components/__tests__/quake-replay-card.test.ts
```

既存テストの期待値を変更する前に、変更対象 assertion、旧期待が表していた契約、新 spec により変わる理由を報告する。確定している変更は `latest-quake-card.test.ts` の `--c-raspberry` source assertion を `--role-cancel` へ替えるものだけである。ほかの text / count / snapshot 期待を変える必要が生じた場合も、先に理由を報告し、実装に合わせて黙って緩めてはならない。

### 5.3 browser capture と layout gate

`display/scripts/capture-legacy-standby.mjs` の拡張は任意ではなく必須とする。実装順は、(1) preview scenario / 混雑fixtureとcapture計測を先に追加、(2) 表示変更前のbase reportを採取、(3) component CSS / DOMを変更、(4) 同条件のafter reportを採取して比較、とする。

#### 必須 report field

- BriefingCard: card / `.body` / `.briefing-fact-grid` の rect・client / scroll size、body padding-inline、grid template columns・row gap・column gap・margin-inline、4 stat のrole / rect、各 `.briefing-fact-stat` gap、value のtext・rect・line count・overflow、NumberUnit fragmentのrect。各 fact の location、approximation、可視雨量を対応付け、実在値 `約100mm` / `120mm以上` を別々に記録する。parser 契約にない両修飾の合成fieldは作らない。
- WeatherWarningForecastCard: card / header / atom / footer / `.periods` のrect・client / scroll size、header四辺padding、period gap、period count / key、atom identity、atom-footer overlap、自然高。
- TyphoonCard: scenario名、display mode、header class / style / background / color / band幅、maximum / 各prefecture / worstのroleごとに `.probability-number`、`.nu-value`、`.nu-unit` のtext・rect・font-size・font-weight・font-variantとoverflow。
- layout: root computed font-size、`data-ladder-stage`、`data-measurement-geometry-stage`、`data-layout-unresolved`、順序付きvisible card key、順序付きrotation key、rotation omitted count、card / readable overflow key、measurement shelfとliveの対象card幅。圧縮fixtureではcandidate kind別件数、rider / reserve kind別件数と、§3.8で固定したpayload signature（forecast period / atom数、Briefing fact、flood河川数、Typhoon件数 / probability、volcano数、heat地域数）も記録する。

Typhoon の role object は baseline / after で同じschemaを持つ。表示変更前は既存 `strong` または確率を含む親nodeを `legacyNode` に記録し、`probabilityNumber` / `nuValue` / `nuUnit` はnullを許す。表示変更後は `legacyNode` を使って合格させず、三つの新nodeを非null必須とする。したがって「必須field」はJSON keyの存在を指し、変更前にはまだ存在しないDOMを捏造しない。

line count は対象 text node / fragment の `Range.getClientRects()` の異なるtop座標数で求める。全rectと計算値の許容差は1px、同一行判定のtop差は1px以内とする。必須fieldが欠ける、数値がfiniteでない、以下のassertionを一つでも外す場合、captureは例外を投げて非0終了する。JSONを出しただけ、screenshotを保存しただけでは受入にしない。

#### 幅・2×2・gutter matrix

1280×720通常段は単独 `#standby-briefing-design-alignment`、圧縮二条件は `#standby-design-alignment-compressed` を使う。前者は BriefingCard を右側列に置いて `.ladder-compressed` なし、後者は `data-ladder-stage=3`、`data-measurement-geometry-stage=3`、`.ladder-compressed` 成立を必須とする。standalone URLを圧縮証拠に流用せず、真の viewport を `Emulation.setDeviceMetricsOverride` で設定して `document.fonts.ready` と measurement settled を待つ。三条件ともroot computed font-sizeは16px、measurement shelfとliveのBriefingCard幅は1px以内で一致しなければならない。

| 条件 | card幅 | body padding-inline | grid row gap | grid column gap | stat列幅 | stat gap |
|---|---:|---:|---:|---:|---:|---:|
| 1280×720 通常 | 307.20px ±1px | 16px | 4px | 12px | 130.60px ±1px | 4px |
| 1280×720 圧縮 | 321.28px ±1px | 8px | 2px | 6px | 148.64px ±1px | 2px |
| 960×620 圧縮 | 280.00px ±1px | 8px | 2px | 6px | 128.00px ±1px | 2px |

各条件でgrid左端はbody border-box左端+padding-left、grid右端はbody border-box右端-padding-rightに1px以内で一致する。地点 / 雨量が第一行、時刻 / 時間幅が第二行、地点 / 時刻が左列、雨量 / 時間幅が右列で、3+1 / 1列は失敗とする。実在する `さいたま市`、`約100mm`、`120mm以上` は三条件ともvalue line count 1、各NumberUnitの数値+単位もline count 1とする。両修飾同時の合成値は受入対象にせず、captureにも生成しない。将来の有効値が折り返す場合の許容分割点は補助語と不可分なNumberUnitのfragment境界だけとし、NumberUnit内部の分断、clip、ellipsis、scroll overflow、文字欠落を認めない。

#### 圧縮 fixture のcandidateとplan

`#standby-design-alignment-compressed` のcandidate kind別件数は `tsunami=1, quake=1, weather=1, weatherWarningForecast=1, briefing=1, flood=1, typhoon=1, volcano=1, heat=1` と完全一致させる。rider / reserveは `tornado=1, longPeriod=1, nankaiTrough=1` とし、同 kind の二件目、特に `heat×2` は失敗とする。payload signature は§3.8の表と完全一致し、WeatherWarningForecastCard は単一atom化せず `legacyImprovedWeatherWarningForecast` の128 period / 32 atom / 最大4 periodと複数atom footerを維持する。

| viewport | stage / compressed | `data-placement-left` | `data-placement-right` | `data-placement-center` | `data-rotation-keys` | `data-typhoon-variant` | omitted |
|---|---|---|---|---|---|---|---:|
| 1280×720 | `3` / `true` | `tsunami,quake,weatherWarningForecast` | `briefing` | `weather` | `flood,typhoon,volcano,heat` | `compact` | `0` |
| 960×620 | `3` / `true` | `tsunami,quake` | 空文字 | 空文字 | `weather,weatherWarningForecast,briefing,flood,typhoon,volcano,heat` | `compact` | `0` |

両 viewport で上表を属性値として完全一致させ、`data-ladder-stage` / `data-measurement-geometry-stage` はともに3、`.ladder-compressed` はtrue、rotation omitted countは0とする。1280×720は4 tick、960×620は7 tickのactive key / positionを各 `data-rotation-keys` のcanonical順で一巡させる。1280では WeatherWarningForecastCardを左列、BriefingCardを右列で常時捕捉し、960では両cardをrotationで捕捉する。compact TyphoonCardは両viewportのrotationで捕捉する。各捕捉時のlive幅は対応するside measurement幅と1px以内で一致させ、base / after はstage、compressed、placement、rotation、variant、omittedを上表どおり完全一致させる。

#### VPWP50 の高さと max fixture 比較

通常段の `#standby-vpwp50-forecast` と圧縮段の `#standby-design-alignment-compressed` は、どちらも同じ `legacyImprovedWeatherWarningForecast`（128 period / 32 atom、最大4 period / atom）を使う。最大atomを捕捉した通常段はheader padding `8px 16px`、period gap 4px、圧縮段はheader padding `4px 8px`、period gap 2pxとし、両方で複数atom footerが存在しなければならない。footer / atom overlapは0、すべてのclient / scroll overflowは1px以内、period countは4、identity / key / 順序はbaseと同一とする。変更前baseに対する自然高差は通常段 `+12px ±1px`、圧縮段 `+6px ±1px` とする。

header復元は一般には選抜を変え得るため、既存の1280×720 `?nav=0&gateScenario=max#legacy-standby-gate` を表示変更の直前と直後に同じChrome・font・真のviewportで採取して比較する。加えて `#standby-design-alignment-compressed` も1280×720 / 960×620の双方でbase / after比較し、Briefing gridとVPTA probabilityの高さ変更を含めて次を完全一致させる。注記として、1280×720の実測ではbase / afterとも stage 3、左 `tsunami,quake,weatherWarningForecast`、右 `briefing`、中央 `weather`、rotation `flood,typhoon,volcano,heat` であり、header復元による配置変化は起きなかった。この同一性も受入値とし、比較自体は省略しない。

- `data-ladder-stage=3`、`data-measurement-geometry-stage=3`、`.ladder-compressed=true`
- side-left / side-right / center / rotationを区別したvisible card keyとその順序（圧縮fixtureは§5.3の期待表と完全一致）
- rotation keyとその順序、rotation omitted count 0
- 1280×720は4 tick、960×620は7 tickのactive key / position

after側はさらに `data-layout-unresolved=false`、measurement nonconverged=false、card / readable overflow 0、footer overlap 0を満たす。いずれかが変わった場合、期待表を更新して通してはならず、実装を停止して §3.11 の裁定を求める。

#### VPTA50 の二状態

`#standby-vpta50-probability-muted` と `#standby-vpta50-probability-normal` の両方をcaptureする。最大値、表示府県の全値、worst areaの全roleで `.nu-value` / `.nu-unit` が一組あり、unit textは `%`、valueのfont-weightは同じcard / tierで解決した `--num-weight` と一致し、wrapperのoverflowは0とする。通常二scenarioのfullはvalue 19px / unit 12px、圧縮scenarioのcompactは1280 / 960ともvalue 14px / unit 12pxを0.1px以内で満たす。mutedはstyleにheader三変数なし、transparent、`--role-muted`相当、band 0px、normalはVPTW由来の三変数とbandを持つ。両scenarioで同じ確率値がheader toneを変えないことをassertする。通常二scenarioでfull、圧縮scenarioは1280 / 960の両条件でrotation中のcompact TyphoonCardを捕捉し、いずれもmaximum / prefecture / worstの該当roleを検査する。

必須captureはbaseline manifestの記録 / 比較を含む次の一括gateから実行できるようにする。capture / fixture実装後、component表示変更前に一つ目を実行し、表示変更後に二つ目を実行する。

```sh
node display/scripts/capture-legacy-standby.mjs --suite design-alignment --report \
  --write-baseline /tmp/fleq-standby-design-alignment-base.json
node display/scripts/capture-legacy-standby.mjs --suite design-alignment --report \
  --baseline-report /tmp/fleq-standby-design-alignment-base.json
```

`--suite design-alignment` はcapture script内だけの固定manifestであり、previewへ同名の `gateFixture` や強制圧縮queryを渡さない。`--write-baseline` は必須fieldのkey・font ready・既存のgeneric containmentだけを検査して旧状態を記録し、変更後だけが満たすNumberUnit / token assertionは適用しない。`--baseline-report` 側は全assertionと比較を行う。baseline manifestはviewport、URL、font readiness、各report fieldを持ち、異なるviewport / scenarioの比較を拒否する。このsuiteは通常4 scenario、1280 / 960の `#standby-design-alignment-compressed`、1280の既存 `max`、必要なcard page / rotation tickを取りこぼさず、上記assertion違反時に非0終了する。実測が§3.1の計算と1pxを超えて食い違う場合は §3.11 に従う。

### 5.4 全体ゲート

```sh
npm run build
npm test
npm run display:build
npm run display:test
npm --prefix display run typecheck
npm --prefix display run docs:design:check
```

本変更は永続化・共有状態・module scope の可変状態を変更しないため `npm run test:shuffle` は必須にしない。それらへ実装範囲を広げる場合は §3.11 の報告後に対象へ追加し、`npm run test:shuffle` も通す。

## 6. 裁定ラベル

- **対象**: BriefingCard の下限なし2×2 grid / gutter / 誤 token、WeatherWarningForecastCard の token spacing / 共通 header、TyphoonCard の VPTA50 NumberUnitとprobability内spacing、VolcanoCard の muted header、LatestQuakeCard / QuakeReplayCard の意味色、主対象4カードのcatalog、StandbyScreen / §5.1 の実幅tokenと `spill → center → 圧縮 → rotation` solver説明、通常4 scenario、§3.8のdistinct-kind圧縮scenarioと真のviewport実測plan、必須capture suite / base比較 / 対象テスト。
- **許容変更**: §3 の DOM wrapper / CSS、固定名preview scenario、既存 max payloadを基礎にcandidate 9 kindとrider / reserve 3 kindを各一件だけ持つ混雑fixture、capture script内だけの `design-alignment` suite / payload signature / geometry report / 非0終了assertion / base比較と、§5を満たす対象テスト更新。spec逸脱や追加の既存期待値変更は、変更前に §3.11 の根拠を報告した場合だけ許容する。
- **禁止変更**: parser、engine、wire、永続化、通知、severity / header tone の意味、VPWP50の4期間/atom・identity・順序・総数、NumberUnit本体、theme token値、solver / stage API、preview / 本番の強制圧縮APIや `gateFixture` 新値、圧縮fixtureの同kind複製・単一atom forecast・両修飾同時の合成雨量、対象外カード、§8 generated領域、負margin・列下限・未定義token・semantic primitive直参照・§3.10以外のraw spacingの追加、design-systemに `StandbyOverflowSummary` / `--standby-card-width` の旧契約を残すこと。
- **配送先（main → personal → Pi）**: main で本弾を受入後、同一差分を personal、Pi の順に配送し、各段で §5 の該当 gate と実機 preview を確認する。
- **ロールバック**: 本弾の単一修正 commit を revert し、main → personal → Pi の順に再配送する。
- **受入条件**: §5 のselector別静的契約、対象vitest、実在二雨量だけを使う三幅条件、二つのVPTA状態、1280 / 960圧縮fixtureのstage 3・`.ladder-compressed`・固定placement、1280の4 rotation tick / 960の7 rotation tick、両viewportのcompact Typhoon、1280 `max` と圧縮scenarioのbase比較、全体gateをすべて満たし、未申告のspec逸脱がないこと。
