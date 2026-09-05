# RecentQuakes 狭幅 reflow の統計間隔

> **裁定（2026-09-06 朝、ご主人）**: §3 の裁定点はすべて推奨案を採用。独立 DOC レビュー（Sol high、新規 read-only スレッド）2 巡で DOC-OK。


- 日付: 2026-09-06
- 状態: 実装前仕様（ご主人裁定 2026-09-05 夜、4B のリリース前対象）
- 観測: 2026-09-05 Liebe、design-alignment capture 960×620

## 1. 症状

960×620 の狭幅表示で「今日あった地震」の一行が二段へ reflow したとき、二段目の `M4.8`、`50km`、`7/7 14:28` が `M4.850km7/7 14:28` のように連結して見える。
値の欠落や順序変更ではなく、独立した三つの統計値の視覚的な境界が不足する症状である。

960×620 は常用解像度ではない。ただし既存 token の狭幅適用だけで完結できるため、Sol Pro 提案書の方針どおり独立 commit としてリリース前に扱う。新 breakpoint、token、DOM 意味、専用 layout API が必要になった場合は、この弾へ広げず低優先へ戻す。

1280×720 `hdMax` の配置・行組み・layout plan は変更しない。1920×1080 `fhdMax` は既存裁定どおり
表示集合だけを固定し、左右列の再割当を許す。両通常幅で RecentQuakes 自身の rect は変更しない。

## 2. 根因（file:line）

1. `display/frontend/src/components/RecentQuakes.svelte:49-53` は magnitude、depth、time を隣接する三つの `span` として描く。表示用文字区切りはなく、分離は CSS gap に依存する。
2. 同 `:61-66` が component root を inline-size container とし、`:190-193` の固定
   **container query 420px** が二段化の境界である。viewport media query や fluid breakpoint ではない。
   `:193-216` は `.row` を一列 grid、`.stats` を二段目の flex group とし、`gap: var(--space-1)` を指定する。
3. `display/frontend/src/components/StandbyScreen.svelte:2248-2261` は stage 2 以上の
   `.ladder-compressed` で `--space-1` を 2px、`--space-2` を 4px、`--space-3` を 6px に上書きする。
   したがって 960×620 の圧縮段では統計間隔が 2px まで縮み、文字の輪郭と連続して見える。
4. `docs/specs/2026-09-05-standby-card-design-alignment.md:285-292` は 960×620 を stage 3、
   compressed と固定する。同 `:309-316` は圧縮 token と solver の正本を StandbyScreen に置く。
5. spacing の正本は `display/frontend/src/lib/theme.css:199-205` と `docs/specs/display-design-system.md:570-578` の 4px grid である。使う **`--space-2`** は base 8px、圧縮段 4px とし、token の定義値自体は変更しない。
6. 既存 `recent-quakes-narrow` fixture は長名の横 clip だけを
   `display/scripts/capture-legacy-standby.mjs:711-713,2850-2856` で検査し、統計間の実距離を検査しない。
   design-alignment suite は同 `:1265-1272` に 960×620 compressed cell を既に持ち、
   その snapshot は `display/frontend/src/preview/fixtures.ts:1084-1100` の標準 RecentQuakes、すなわち
   `:32-43` の `M4.8` / `50km` / `7/7 14:28` を含む。番兵に必要なのは新 fixture ではなく計測追加である。
7. `docs/specs/2026-09-05-standby-card-page-footer-contract.md:138-145` と capture の `:2416-2431` は
   `fhdMax` の表示集合を固定しつつ左右列再割当を許し、`hdMax` だけ placement 完全一致とする。
8. capture の `:1375-1405,2337-2407` は RecentQuakes 内部 rect を収集・比較せず、`:1899-1902,1930-1938`
   は baseline の必須 field を fail-closed で検査する。新 schema と fresh baseline は一組で導入する必要がある。

## 3. 変更

### 3.1 裁定点 1: 修正の形

- **案 A（推奨）— reflow 時の gap token を一段上げる**:
  420px 以下の `.stats` は現行 `display:flex` を維持し、column gap を `var(--space-2)`、wrap 時の row gap を現行どおり `var(--space-1)` とする。960×620 compressed では 4px を確保する。
- **案 B — 要素間に可視区切り `·` を入れる**:
  magnitude / depth / time 間へ区切り node を二つ追加する。視覚境界は強いが、`textContent` と accessible name を変え、通常幅にも区切りの表示条件が波及する。
- **推奨理由**: 案 A は意味・DOM・読み上げ・通常幅を変えず、既存 spacing scale だけで直せる。
  `.stats` は既に flex container なので「二段目だけ `inline-flex`」への置換だけでは gap は増えず、
  grid item の表示外形にも実効差がないため採らない。案 B は 4px の実測でも分離不能な場合の再裁定とする。

### 3.2 裁定点 2: 960 capture の寿命

- **案 A（推奨）— 回帰番兵として常設する**:
  design-alignment suite の既存 960×620 compressed cell に rect / computed gap report と非0終了 assertion を追加する。既存 cell と標準 `M4.8` 行を再利用し、重複 cell は増やさない。
- **案 B — 今回だけ capture する**: before / after の PNG と report だけを保存し、suite へ assertion を残さない。
- **推奨理由**: 圧縮時 token override と container query の組合せでだけ再現するため、unit test の
  source guard や非圧縮の `recent-quakes-narrow` fixture では退行を検出できない。既存 cell の計測拡張なら
  維持費が小さく、960 を製品の新しい常用解像度として扱うことにもならない。

三解像度の対象 record は 1920×1080 `legacy-standby-gate max/fhdMax`、1280×720 同 `hdMax`、
960×620 `standby-design-alignment-compressed` とする。各 record の `geometry.recentQuakes` は共通して
`root`、`firstRow`、`rowMain`、`stats`、`magnitude`、`depth`、`time` の rect、root inline-size、
computed row / column gap、解決済み `--space-1` / `--space-2` / `--space-3` を持つ。

### 3.3 baseline の採取順

capture schema と fail-closed assertion だけを先に実装し、表示 CSS はまだ変えない。その product build から
fresh baseline を採取した後、`--space-2` の CSS 変更を入れた product build から after を採る。両者は同一
Chrome、font、DPR 1、真の viewport、font ready / measurement settled 条件を使う。旧 baseline JSON への
field 後付け、欠損値の推測・補完、異なる build の取り違えは禁止し、baseline / after の欠損は非0終了する。

### 3.4 実装境界

新 token、区切り文字、breakpoint、font-size、`.row` の row gap、統計値の順序・文言・幅、
RecentQuakes の最大5件、solver、stage、center width は変更しない。狭幅規則外へ selector を漏らさない。

### 3.5 独立 DOC レビュー指摘への処置

| # | 処置 | 反映 |
| ---: | --- | --- |
| 1 High | **a) 採用** | `fhdMax` の左右再割当許容を維持し、完全一致を RecentQuakes rect へ限定。`hdMax` だけ placement 完全一致。 |
| 2 Medium | **a) 採用** | §3.2 に三解像度共通 `geometry.recentQuakes` schema、§5 に node と query 成立条件を固定。 |
| 3 Medium | **a) 採用** | §3.3 に schema-first、CSS-before baseline、CSS-after capture、旧 JSON 補完禁止を固定。 |
| 4 Low | **a) 採用** | §5 の gap 判定を `actualGap + 0.5 >= expectedGap` の一式に固定。 |

## 4. 対象ファイル

- `display/frontend/src/components/RecentQuakes.svelte` — 狭幅 `.stats` の column gap。
- `display/frontend/src/components/__tests__/recent-quakes.test.ts` — token と DOM 順序の guard。
- `display/scripts/capture-legacy-standby.mjs` — 三解像度共通 schema、比較、非0終了 assertion。
- `display/frontend/src/components/__tests__/capture-design-alignment.test.ts` — report schema と失敗系。
- `docs/specs/display-design-system.md` — RecentQuakes catalog に狭幅の統計分離契約を一文同期する。

`theme.css`、preview fixture、parser、engine、wire、永続化は対象外である。

## 5. 受入条件

1. §3.2 の三 target record は同じ key と型の `geometry.recentQuakes` を必須で持ち、各 node の rect は
   `x / y / left / right / top / bottom / width / height` を持つ。欠損、`null`、非有限値は非0終了する。
2. 1920×1080 / 1280×720 は root inline-size `> 420px` で container query が不成立、computed row / column gap
   はともに解決済み `--space-3` と一致する。root、firstRow、rowMain、stats、magnitude、depth、time の
   before / after 各 rect property は **0 CSS px 差**とする。
3. 960×620、DPR 1、font ready、measurement settled では root inline-size `<= 420px`、`.row-main` と
   `.stats` は異なる grid row、magnitude / depth / time はこの DOM 順のまま同じ二段目に並ぶ。
4. 960 の computed column gap は解決済み `--space-2`（4px）、row gap は `--space-1`（2px）と一致する。
   隣接 pair ごとに `actualGap = next.rect.left - previous.rect.right`、
   `expectedGap = max(computedColumnGap, resolvedSpace2)` とし、合格式を
   **`actualGap + 0.5 >= expectedGap`** とする。負値、非有限値、別行への分裂は許容差内でも失敗とする。
5. 三解像度とも RecentQuakes root / firstRow / stats は `scrollWidth <= clientWidth + 1px`、三統計は clip なし。
6. 1280 `hdMax` は placement / rotation / Typhoon variant / omitted と stage 3 / compressed を完全一致する。
   1920 `fhdMax` は表示集合、rotation なし、omitted 0、stage 0 / non-compressed を一致させるが、既存裁定どおり
   left / right の割当変更は許容する。RecentQuakes rect の 0px 契約はこの許容に左右されない。
7. §3.3 の fresh baseline と after の双方で新 schema を fail-closed 検査し、旧 JSON は拒否する。
8. 案 A では `.stats.textContent` に `·` や空白を追加せず、既存 accessible name を維持する。
   将来案 B へ変えるなら、区切りを含む `textContent` と、読み上げ名が三値を意味単位で区切って読むことを
   component test と実ブラウザ accessibility tree の両方で確認する。
9. `npm run build`、`npm test`、`npm run test:shuffle` を成功させ、該当する場合は
   `npm run typecheck:test` と `npm --prefix display run docs:design:check` も成功させる。

## 6. 裁定ラベル（案）

| 要素 | 案 |
| --- | --- |
| 対象 | RecentQuakes の 420px 以下 reflow における統計三値の視覚分離。 |
| 許容変更 | 既存 `--space-2` の狭幅適用、component test、三解像度共通 report / comparison、catalog 同期。 |
| 禁止変更 | 新 token / breakpoint / fixture、区切り文字、typography、情報量、solver / stage、theme token 値、parser / wire / persistence。 |
| 配送先 | main で独立 commit を受入後、同一差分を personal、Pi の順に配送する。Pi は常用解像度で通常幅不変も確認する。 |
| ロールバック | この独立 commit を revert し、main → personal → Pi の順に再配送する。schema / migration 残骸は生じない。 |
| 受入条件 | §5 の 960 実距離、overflow 0、三解像度 schema、通常幅 RecentQuakes rect 差 0、既存 `fhdMax` / `hdMax` 契約、fresh baseline、DOM / 読み上げ、build / test / shuffle。 |
