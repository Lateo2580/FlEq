# 待機画面カード header 統一 spec（改訂）

## 1. 症状

ご主人の実機観察では、待機画面の色帯を持つカード見出しが、共通のデザイン言語を使いながらも、カードごとに上角の丸み、見出し帯の高さ、padding、line-height、色 token の参照方法、時刻表示の構造が微妙に異なる。

主な差は以下だ。

- HeatAlertCard は外殻が `overflow: visible` で、色帯の上角がカード外殻の角丸で clip されない。
- LatestQuakeCard、QuakeReplayCard、TsunamiStandbyBanner は `padding: 8px 16px` を直書きし、圧縮段階でも header 高が縮まない。
- WeatherAlertCard / BriefingCard は page footer 表示時に header 高を意図的に補償する。
- severity から container / on / band token への接続が、inline style・親 class・header class などに分散している。

対象は色帯 header を持つ以下の10カードとする。

- WeatherAlertCard
- BriefingCard
- HeatAlertCard
- FloodCard
- FloodWideCard
- TyphoonCard
- VolcanoCard
- LatestQuakeCard
- QuakeReplayCard
- TsunamiStandbyBanner

`RecentQuakes` の muted `h2` は色帯 header ではないため対象外とする。

## 2. 現状の方言一覧

| 軸 | 正系 | 方言 |
|---|---|---|
| DOM 構造 | outer → header → title + trailing metadata | `.card-header`、`.banner-header`、素の `header`、title 文字列直置きが混在 |
| 角丸・clip | 外殻 `border-radius: var(--radius-standby)` と `overflow: hidden` | HeatAlertCard のみ `overflow: visible` |
| 高さ | `padding: var(--space-2) var(--space-4)`、`line-height: 1.18`、title token による自然高 | quake 2種・津波は `8px 16px` 直値。Weather / Briefing は footer 時のみ意図的縮小 |
| 色 token | container / on / band の三組を header contract に渡す | inline function、親 `band-*`、header tone class、quake二値 class |
| title / 付属要素 | title と trailing metadata を分離した flex 行 | Heat は独自 `.date`、Flood / quake は metadata なし、Tsunami は狭幅 stamp 制御あり |

## 3. 変更

### 3.1 共通 header 契約

大掛かりな component 化は行わず、共通 CSS class 方式を採る。

header root に `.standby-card-header`、title に `.standby-card-header__title`、chip / stamp / date の親に `.standby-card-header__meta` を付与する。子 component への class 属性転送には依存しない。

```svelte
<header class="standby-card-header" style="…severity variables…">
  <span class="standby-card-header__title">見出し</span>
  <span class="standby-card-header__meta">
    {#if restored}<RestoredChip />{/if}
    <UpdatedStamp iso={updatedAt} />
  </span>
</header>
```

HeatAlertCard は `UpdatedStamp` の代わりに既存 target date を meta wrapper 内へ置く。stamp / date がないカードは meta wrapper 自体を省略できる。

DOM 上の順序は `title → meta` とし、meta 内の順序は `RestoredChip → stamp/date` とする。title は ellipsis 対象だが、meta は `flex-shrink: 0` とし、chip と trailing metadata を title が侵食してはならない。

```css
.standby-card-header {
  display: flex;
  align-items: center;
  min-width: 0;
  padding: var(--space-2) var(--space-4);
  font-size: var(--type-title-s-fluid);
  font-weight: var(--type-title-weight-emphasized);
  line-height: 1.18;
  background: var(--standby-header-container);
  color: var(--standby-header-on);
  border-bottom: var(--header-band-width) solid var(--standby-header-band);
}

.standby-card-header__title {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.standby-card-header__meta {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  min-width: 0;
  margin-left: auto;
}

/* theme.css は global stylesheet のため :global を使わない */
.standby-card-header__meta .updated-stamp {
  margin-left: 0;
}
```

外殻は `border-radius: var(--radius-standby)` と `overflow: hidden` を持ち、header 自身へ個別の上角 radius は付けない。既存の意味 token は置換せず、各カードの severity 判定結果を `--standby-header-container`、`--standby-header-on`、`--standby-header-band` の三組へ渡す。

#### muted 変種

Typhoon の `headerTone === null` は `.standby-card-header--muted` を付与する。

```css
.standby-card-header--muted {
  background: transparent;
  color: var(--role-muted);
  border-bottom: 0;
}
```

muted 変種は container / on / band 三組を持たず、背景はカード surface をそのまま見せる。`border-bottom: 0` により band 分の高さも残してはならない。padding、font-size、font-weight、line-height、title / meta flex 構造は通常 contract と同一とする。

### 3.2 severity と token 三組の対応表

| カード | severity / 分岐 | container | on | band |
|---|---|---|---|---|
| WeatherAlertCard | `weatherEmergency` | `--header-weatherEmergency-container` | `--header-weatherEmergency-on` | `--header-band-weatherEmergency` |
|  | `weatherWarning` | `--header-weatherWarning-container` | `--header-weatherWarning-on` | `--header-band-weatherWarning` |
|  | `weatherAdvisory` | `--header-weatherAdvisory-container` | `--header-weatherAdvisory-on` | `--header-band-weatherAdvisory` |
| BriefingCard | `critical` | `--header-weatherEmergency-container` | `--header-weatherEmergency-on` | `--header-band-weatherEmergency` |
|  | `warning` | `--header-weatherWarning-container` | `--header-weatherWarning-on` | `--header-band-weatherWarning` |
|  | `info` / `cancel` | `--header-weatherAdvisory-container` | `--header-weatherAdvisory-on` | `--header-band-weatherAdvisory` |
| HeatAlertCard | 通常 alert | `--header-weatherWarning-container` | `--header-weatherWarning-on` | `--header-band-weatherWarning` |
|  | special / critical | `--header-weatherEmergency-container` | `--header-weatherEmergency-on` | `--header-band-weatherEmergency` |
| FloodCard | `band-red` | `--header-tsunamiWarning-container` | `--header-tsunamiWarning-on` | `--header-band-tsunamiWarning` |
|  | `band-emergency` | `--header-weatherEmergency-container` | `--header-weatherEmergency-on` | `--header-band-weatherEmergency` |
|  | `band-flooding` | **例外: `#000`** | **例外: `var(--c-yellow)`** | **例外: `#fff`** |
| FloodWideCard | `band-red` | `--header-tsunamiWarning-container` | `--header-tsunamiWarning-on` | `--header-band-tsunamiWarning` |
|  | `band-emergency` | `--header-weatherEmergency-container` | `--header-weatherEmergency-on` | `--header-band-weatherEmergency` |
|  | `band-flooding` | **例外: `#000`** | **例外: `var(--c-yellow)`** | **例外: `#fff`** |
| TyphoonCard | `advisory` | `--header-weatherAdvisory-container` | `--header-weatherAdvisory-on` | `--header-band-weatherAdvisory` |
|  | `warning` | `--header-weatherWarning-container` | `--header-weatherWarning-on` | `--header-band-weatherWarning` |
|  | `emergency` | `--header-weatherEmergency-container` | `--header-weatherEmergency-on` | `--header-band-weatherEmergency` |
|  | `headerTone === null` | **muted 変種: transparent** | **`--role-muted`** | **なし、`border-bottom: 0`** |
| VolcanoCard | `band-advisory` | `--header-weatherAdvisory-container` | `--header-weatherAdvisory-on` | `--header-band-weatherAdvisory` |
|  | `band-warning` | `--header-weatherWarning-container` | `--header-weatherWarning-on` | `--header-band-weatherWarning` |
|  | `band-red` | `--header-tsunamiWarning-container` | `--header-tsunamiWarning-on` | `--header-band-tsunamiWarning` |
|  | `band-emergency` | `--header-weatherEmergency-container` | `--header-weatherEmergency-on` | `--header-band-weatherEmergency` |
| LatestQuakeCard | 通常 | `--header-quakeWarning-container` | `--header-quakeWarning-on` | `--header-band-quakeWarning` |
|  | `maxSeverityRank >= 7` | `--header-quakeCritical-container` | `--header-quakeCritical-on` | `--header-band-quakeCritical` |
| QuakeReplayCard | 通常 | `--header-quakeWarning-container` | `--header-quakeWarning-on` | `--header-band-quakeWarning` |
|  | `maxSeverityRank >= 7` | `--header-quakeCritical-container` | `--header-quakeCritical-on` | `--header-band-quakeCritical` |
| TsunamiStandbyBanner | `majorWarning` | `--header-tsunamiMajor-container` | `--header-tsunamiMajor-on` | `--header-band-tsunamiMajor` |
|  | `warning` | `--header-tsunamiWarning-container` | `--header-tsunamiWarning-on` | `--header-band-tsunamiWarning` |
|  | `advisory` | `--header-tsunamiAdvisory-container` | `--header-tsunamiAdvisory-on` | `--header-band-tsunamiAdvisory` |

### 3.3 カード別変更と意図的例外

- WeatherAlertCard / BriefingCard  
  既存の `.card-header` を共通 class へ寄せる。role / frame 判定、UpdatedStamp、ページ footer 時の高さ補償は維持する。

- HeatAlertCard  
  外殻を `overflow: visible` から clip する構造へ変更する。title、RestoredChip、target date を meta wrapper 方式へ寄せる。

- FloodCard / FloodWideCard  
  素の `header` と文字列直置きを共通 class・title span・optional meta wrapper へ寄せる。`band-flooding` の黒背景・黄文字・白枠・白帯は意図的例外として維持する。

- TyphoonCard / VolcanoCard  
  severity 判定は維持し、共通 class、title span、meta wrapper を付与する。Typhoon の `headerTone === null` は `.standby-card-header--muted` を使う muted・色帯なしの変種として維持する。

- LatestQuakeCard / QuakeReplayCard / TsunamiStandbyBanner  
  `.banner-header` を共通 class へ寄せ、`padding: 8px 16px` を `var(--space-2) var(--space-4)` に置換する。

- TsunamiStandbyBanner  
  狭幅時の stamp 最大幅、文字縮小、非表示制御は meta wrapper 内で維持する。

- RecentQuakes  
  muted `h2` は対象外とし、色帯 header contract を適用しない。

- LegacyImprovedMock.svelte  
  凍結参照ミラーのため変更対象外とする。内部の旧 `.banner-header` selector は scoped で自己完結しており、今回の共通 class 化に合わせて変更しない。

### 3.4 capture report の拡張

`capture-legacy-standby.mjs` の `--report` に、10カードそれぞれの実レンダリング結果として以下を追加する。

- outer の `border-radius`、`overflow`
- header の `padding`、`font-size`、`font-weight`、`line-height`、`background-color`、`color`、`border-bottom-width`
- title の flex / overflow / text-overflow
- meta wrapper の flex-shrink、位置、rect
- meta 内の RestoredChip、UpdatedStamp / date の順序と rect

この report は宣言値ではなく browser 上の computed style と rect を採取する。jsdom の CSS 解決結果だけで代替してはならず、jsdom を使う場合も実 browser capture で同じ条件を確認する。

## 4. 対象ファイル

実装・capture 対象:

- `display/frontend/src/components/WeatherAlertCard.svelte`
- `display/frontend/src/components/BriefingCard.svelte`
- `display/frontend/src/components/HeatAlertCard.svelte`
- `display/frontend/src/components/FloodCard.svelte`
- `display/frontend/src/components/FloodWideCard.svelte`
- `display/frontend/src/components/TyphoonCard.svelte`
- `display/frontend/src/components/VolcanoCard.svelte`
- `display/frontend/src/components/LatestQuakeCard.svelte`
- `display/frontend/src/components/QuakeReplayCard.svelte`
- `display/frontend/src/components/TsunamiStandbyBanner.svelte`
- `display/frontend/src/components/UpdatedStamp.svelte`
- `display/frontend/src/lib/theme.css`
- `display/frontend/src/components/StandbyScreen.svelte`
- `display/scripts/capture-legacy-standby.mjs`

旧 class を直接検査する component test の確定対象:

- `display/frontend/src/components/__tests__/weather-alert-card.test.ts`
- `display/frontend/src/components/__tests__/briefing-card.test.ts`
- `display/frontend/src/components/__tests__/heat-alert-card.test.ts`
- `display/frontend/src/components/__tests__/flood-card.test.ts`
- `display/frontend/src/components/__tests__/flood-wide-card.test.ts`
- `display/frontend/src/components/__tests__/typhoon-card.test.ts`
- `display/frontend/src/components/__tests__/volcano-card.test.ts`
- `display/frontend/src/components/__tests__/latest-quake-card.test.ts`
- `display/frontend/src/components/__tests__/quake-replay-card.test.ts`
- `display/frontend/src/components/__tests__/tsunami-standby-banner.test.ts`
- `display/frontend/src/components/__tests__/standby.test.ts`
- `display/frontend/src/components/__tests__/phase5a-surface-contract.test.ts`
- `display/frontend/src/components/__tests__/phase5b-surface-contract.test.ts`
- `display/frontend/src/components/__tests__/phase6b-production-render.ts`

変更対象外:

- `display/frontend/src/preview/LegacyImprovedMock.svelte`
- `display/frontend/src/preview/__tests__/legacy-improved-mock.test.ts`

## 5. 受入条件

1. 10カードについて、footer なしの実レンダリングを browser capture で採取し、header の computed `padding-block` / `padding-inline` が以下と一致する。

   - 通常段階: `8px / 16px`
   - 圧縮段階: `4px / 8px`

   併せて `line-height: 1.18`、title fluid token 相当の computed font size、bold 相当の computed weight、16px outer radius、clip、severity 対応表どおりの背景・文字・band の実測値を確認する。

   Typhoon の muted 変種は、同じ padding・font・line-height・title/meta geometry を満たしつつ、computed `color` が `--role-muted` 相当、`background-color` が transparent、`border-bottom-width` が `0px` であることを確認する。

2. footer ありは前項の基準検査から除外し、別の実測期待値とする。

   - BriefingCard の page footer 時: header `padding-block = calc(var(--space-2) - 3px)`、通常5px、圧縮1px。
   - WeatherAlertCard の page footer かつ tornado なし時: 同じく通常5px、圧縮1px。
   - WeatherAlertCard の tornado あり時: header は通常 contract を維持し、既存 rider / footer 高さ補償を実測で維持する。

3. title と meta wrapper の rect を実測し、title → meta の順序、meta 内の RestoredChip → stamp/date の順序を確認する。長い title が ellipsis しても、meta は shrink・重なり・clip を起こさず、chip と trailing metadata が可読であること。

4. `capture-legacy-standby --report` は、10カードの outer / header / title / meta / chip / trailing metadata の computed style と rect を出力する。report は以下を検出できなければならない。

   - HeatAlertCard の header 上角が clip されない状態
   - 圧縮段階で直値 padding を保持する quake / tsunami header
   - title と meta、meta 内の chip と stamp/date の重なり
   - Typhoon muted 変種に残る band 高
   - 期待外の card height、slot overflow、card overlap、page indicator overlap

5. quake 2種と TsunamiStandbyBanner は token 化により、圧縮段階の header が従来より上下合計約8px低くなる。この card rect / slot geometry の変化は意図変更として capture 期待値を更新する。それ以外のカードでは意図しない高さ変動を発生させない。

6. Briefing page atom は実 browser capture で以下を実走し、single / multi-page の双方で header、footer 高さ補償、atom 本文、page indicator の非重なりを確認する。

```sh
cd display
node scripts/capture-legacy-standby.mjs --fixture briefing-pages --report
node scripts/capture-legacy-standby.mjs --fixture briefing-single-page --report
```

7. build、unit test、対象 component test、StandbyScreen test、layout gate、capture report、および必要な shuffle test をすべて緑にする。

