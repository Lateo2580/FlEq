# 待機画面カード page footer 統一 spec

## 1. 症状

ご主人の実機確認で、待機画面カードの改ページ表示とカード下端の関係、および気象警報系カードの末尾構造に次の不整合が見つかった。

1. 右下のカード改ページ表示 `n/m` がカード下端へ接し、上下の余白が不均衡に見える。
2. WeatherWarningForecastCard（VPWP50）は、対象地域行の右端にある `続き n/m` と、カード右下の `n/m` が同じページ位置を二重表示する。
3. VPWP50 の対象地域に、6桁 / 7桁が混在する親 Area.Code や `L001` 形式の Local code が露出している。コード表示をやめ、予報区と地域内細分の関係を人が読める地名へ改める必要がある。
4. WeatherAlertCard の竜巻注意情報 rider はカード下角の丸みに対応せず、ページ footer との間に高さ補償用の空間が見える。

対象は `data-card-page-footer` を描く BriefingCard、WeatherWarningForecastCard、VolcanoCard、WeatherAlertCard、FloodCard、FloodWideCard と、WeatherAlertCard の竜巻 rider である。ページ分割アルゴリズム、scheduler、solver の意味論を作り替える修正ではない。

## 2. 根因

header 統一前と同じく、同じ役割の要素へ複数の局所方言が残っていることが根因である。

| 方言 | 対象 | footer の構造 | 高さの確保 | 下端との関係 |
|---|---|---|---|---|
| (a) 通常フロー（正系） | FloodCard / FloodWideCard | 本文後の通常フロー要素。`padding: var(--space-1) var(--space-4)` と `border-top: 1px solid var(--hairline)` | footer 自身の自然高 | indicator の下に `--space-1` の内側余白があり、カード下端へ接しない |
| (b) 下端 absolute | BriefingCard / WeatherWarningForecastCard / VolcanoCard | `position: absolute; inset-inline: 0; bottom: 0; height: var(--card-page-indicator-block-size)` | card の `padding-bottom` へ同じ固定高を予約 | indicator の border-box がカード内側下端へ接する |
| (c) 高さ 0 の上描き | WeatherAlertCard | `height: 0; overflow: visible` の footer から indicator を下向きに描く | `ul -10px`、rider `-6px`、header `-6px`、margin / card padding `+16px` の組合せ | 本文、footer、rider の順序を、計測高を変えない補償算術で成立させる |

(b) と (c) は、旧 solver が footer chrome を実高へ含めない前提を局所 CSS で補った名残である。現行 StandbyScreen は side / center の measurement shelf で border-box 実高を測り、spill → center → 圧縮 → rotation を解く。前弾 §3.5 では VPWP50 の header 局所縮小を撤去して通常段 `+12px`、圧縮段 `+6px` の自然高変化を shelf へ追従させ、base / after の配置差が 0 であることを実 browser で確認済みである。したがって footer も実在する通常フロー行として測るのが現在の計測契約に合う。

VPWP50 はさらに、`vpwp50ForecastTargetLabel()` が可視表示、`title`、atom label、accessible name を一つのコード込み文字列で兼用し、別に `atom.continuation` も対象地域行へ描く。表示用の人間向け名称と、診断・読み上げ用の完全名称の責務が分離されていない。`scope=local` は地域内細分であり、`localCode` は実データでは `L001` 形式または欠落する。これを行政区域 code と解釈してはならない。一方、親 `areaCode` は6桁と7桁が混在し、7桁が主流なので、県名導出は両方を扱う必要がある。

WeatherAlertCard では footer が rider の直前にあり、`.has-page-footer.has-tornado .tornado-rider` の `margin-top: var(--card-page-indicator-block-size)` が footer の描画領域を捻出する。この margin が実機で余計な空間として見える。外殻 `.weather-card` は既に `border-radius: var(--radius-standby)` と `overflow: hidden` を持つため、外殻の clip 能力が欠けているわけではない。rider 自身に下角の形状契約がないことと、補償用 margin が同時に残ることが問題である。

## 3. 変更

### 3.1 共通 footer 契約

方言 (a) の FloodCard / FloodWideCard を正系とし、`display/frontend/src/lib/theme.css` に全対象カードが共有する `.card-page-footer` と `.card-page-indicator` を置く。大掛かりな component 化は行わず、header 統一と同じ global class 方式を採る。

```css
.card-page-footer {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: flex-end;
  padding: var(--space-1) var(--space-4);
  border-top: 1px solid var(--hairline);
  pointer-events: none;
}

.card-page-indicator {
  box-sizing: border-box;
  padding: 1px var(--space-2);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--role-muted);
  font-size: var(--type-label-xs-size);
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
```

footer は本文の後にある通常フロー要素とし、`position`、`inset`、`bottom`、`z-index`、明示 `height` / `min-height` / `block-size`、`overflow: visible` を使わない。`.card-page-indicator` の自然な border-box 高は通常 font-size 12px のとき `12 + 2×1px padding + 2×1px border = 16px` である。footer の自然高は通常段で `1px border + 2×4px padding + 16px = 25px`、圧縮段で `1 + 2×2 + 16 = 21px` となる。

indicator は右寄せし、その下端とカード内側下端の間に必ず footer の `padding-bottom` を残す。rider がないカードでは footer border-box の下端をカードの border 内側下端へ合わせる。すなわち browser rect では、`footer.bottom = card.bottom - card.borderBottomWidth`、`indicator.bottom = footer.bottom - footer.paddingBottom` を 1px 以内で満たす。背景色は overlay の名残を持たず transparent とする。

各 component の scoped `.card-page-footer` / `.card-page-indicator` は削除する。`--card-page-indicator-block-size` と、それを用いた card bottom reserve も削除する。新しい footer 高 token は追加しない。font、padding、border の既存 token から得た自然高を measurement shelf が測る。

### 3.2 カード別変更と意図的例外

本 spec は後発の正本として、次の既存規範だけを明示的に上書きする。

- header 統一 spec §5.2 の BriefingCard footer 時 header `padding-block=5px / 1px`、WeatherAlertCard の tornado なし footer 時 `5px / 1px`、tornado あり時の旧 rider / footer 高さ補償。
- 前弾 design-alignment spec §3.5 / §3.10 / §5.2 の VPWP50 bottom reserve と可視 continuation の維持、BriefingCard footer 時 header `-3px` 補償の維持、および production partition の `data-card-page-identities` / active identity / page count を固定していた旧比較契約。

上書きは本節で列挙する footer、padding、continuation、末尾 layout と range 由来 page metadata の比較契約に限る。両既存 spec の header 色、typography、period spacing、論理項目 identity / key、pager namespace / key、scheduler reset の入力列、情報保持、capture gate など、それ以外の契約は引き続き有効である。

- **FloodCard / FloodWideCard**  
  DOM と見た目を正系の錨として維持し、重複する scoped footer / indicator 宣言だけを共通 CSS へ移す。forced measurement fixture の footer 表示条件は変えず、得られた page range は他カードと同じく診断値とする。自然高差の期待値は 0px とする。
- **BriefingCard**  
  `.briefing-card.has-page-footer` の bottom reserve と footer 時だけの header `-3px` 補償を削除する。live card の `shellHeightPx` による固定 border-box 高は維持し、`.briefing-card` を column flex、`[data-briefing-page-atom]` を `flex: 1 1 auto; min-height: 0` の column flex とする。page atom が header 後の残余高を所有し、footer へ追加する `.briefing-page-footer` だけを `margin-top: auto` として最終 trackへ着地させる。この auto margin は Briefing page atom 内だけの余剰高配分であり、rider の間隔補償には使わない。probe と partition は footer と復元後 header の実高を含む利用可能本文高で再計算する。ページ範囲は変わり得るが、entry / block の論理 identity と順序、全情報保持を変えてはならない。
- **WeatherWarningForecastCard**  
  bottom reserve と absolute footer を削除し、atom 後の通常フロー footer とする。共通 header と period spacing は前弾 §3.5 の状態を維持する。
- **VolcanoCard**  
  `.volcano-card.has-page-footer` の reserve と absolute footer を削除する。火山 / 降灰のページ分割、muted header、最大高は維持し、footer 実高を含めて既存 probe に再計測させる。
- **WeatherAlertCard**  
  `height: 0` footer、footer 用 `ul` 縮小、rider padding 縮小、rider margin、footer なし rider 用ではない card bottom reserve、footer 時 header 縮小をすべて削除する。外殻を `header / ul / footer / rider` の四つの named grid row にし、`header auto / ul minmax(0, 1fr) / footer auto / rider auto` を明示する。header、footer にはそれぞれ配置専用の追加 class `.weather-card-header`、`.weather-page-footer` を付け、共通 class の寸法宣言を上書きしない。存在しない footer / rider の named row は0になり、固定 shell の余剰高は `ul` row だけが所有する。footer と rider は連続した最下段へ置き、rider に `margin-top: auto` その他の余白補償を設けない。`ul`、header、rider は footer の有無にかかわらず各通常 contract の padding を使う。DOM 順は `header → ul → footer → tornado rider` を維持する。
- **意図的例外: WeatherAlertCard + tornado rider**  
  rider があるときだけ footer はカード最下段ではなく rider の直前に置く。`n/m` は weather alert のページ位置、`.tornado-page-marker` は竜巻対象地域の独立ページ位置であり、異なる pager なので両者を統合しない。両者の accessible text、pager namespace / key、scheduler reset の入力列を維持する。

固定 shell / max-height 内で footer が実高を使う結果、Briefing / WeatherAlert / Volcano の一ページ当たり表示量と partition range は変わってよい。production partition の range、`data-card-page-identities`、active identity、page count、range 由来の page key は、各 card pager（WeatherAlert は weather pager / tornado pager を分離）の base / after を記録する診断値であり、通常の受入 gate で完全一致を要求しない。

固定するのは、partition range から作らない pager namespace / key と、scheduler reset の元になる全論理項目列である。各 pager の列は論理項目 key を出現順に並べ、base / after 同一、重複0、欠落0とする。Weather の列は occurrence-aware area key を原順序で保持し、kind ごとに `["omittedAreaCount", kind, omittedAreaCount]` sentinel を加える。同値な別 field で比較する場合も kind と count の組を固定しなければならない。情報の削除、period / entry の並べ替え、ellipsis 以外の切詰め、scroll 化、固定高を超える描画で吸収してはならない。range と page identity を完全一致させる例外は、自然高差を切り出す §3.6 の専用 forced-range auto-height probe だけとする。既存期待値を変える場合は §3.7 を先に満たす。

### 3.3 VPWP50 の「続き」削除

WeatherWarningForecastCard の `.target-row` 右端にある `.continuation` を DOM から削除し、対応する scoped CSS も削除する。複数 atom 時の可視ページ位置は共通 footer の `n/m` 一つだけとする。`.target-row` は対象地域を一要素で描くため、単純な block または同等の min-width / ellipsis 契約へ整理できる。

削除対象は可視の重複表示だけである。`WeatherWarningForecastAtom.continuation`、fingerprint、atom identity / key / label、pager namespace / key、scheduler reset の入力列、atom 順序は前弾の契約を守るため変更しない。コード込みの完全 target label、period label、既存 accessible name / `title` の情報も削らない。内部 `continuation` を除去する必要が生じた場合は、fingerprint と scheduler 挙動への影響を §3.7 で先に報告し、本 spec の無断拡張として実施しない。

### 3.4 VPWP50 の地名

可視表示専用 helper `vpwp50ForecastTargetDisplayLabel()` を `display/frontend/src/lib/weather-warning-forecast.ts` に追加し、従来の `vpwp50ForecastTargetLabel()` はコード込みの完全名称として維持する。

Local は予報区内の地域内細分である。実例は `沿岸 東部`、`菅平周辺`、`陸上` で、`localCode` は `L001` 形式または欠落する。`localCode` を行政区域 code として扱わず、都道府県導出には使わない。

既定の **A案** は「予報区名 細分名」とする。6桁に厳密一致する親 `areaCode` の先頭2桁から既存 `PREFECTURE_BY_CODE` を引く専用 helper `prefectureFromSixDigitAreaCode()` を `prefecture-group.ts` に追加し、表示 helper 側では `prefectureFromSixDigitAreaCode(target.areaCode) ?? prefectureFromMunicipalityCode(target.areaCode)` の順に桁別合成する。後者は既存の7桁厳密 helperをそのまま再利用し、受理範囲を変えない。parser から渡る正規化済み `parentAreaName` に対し、`parentAreaName.startsWith(prefectureName)` のときだけ正式都道府県名を前置済みとみなす。それ以外は、非先頭位置に同じ県名文字列を含んでいても `都道府県名 + 半角空白 + parentAreaName` として予報区表示名を補う。これは `prefecture-group.ts` の完全名前方一致規約と同じである。親 code が null、不正、未知なら `parentAreaName` をそのまま使う。名称だけから都道府県を推測しない。

| `scope` | A案の可視表示 | 完全名称（`title` / accessible name / atom label） |
|---|---|---|
| `area` | 補正後の予報区表示名のみ。例: `areaCode=0121400, parentAreaName=稚内市` → `北海道 稚内市`。正規化済み名称が県名で始まる `長野県 北部` はそのまま | 従来どおり `parentAreaName（areaCode）`。code null 時は名称のみ |
| `local` | 補正後の予報区表示名 + 半角空白 + `name`。例: `北海道 稚内市 稚内海岸` | 従来どおり `parentAreaName（areaCode） / name（localCode）`。`L001` と null を含む既存 fallback を維持 |

可視表示では両 scope の code を出さない。契約用の人工反例である6桁の `areaCode=200010, parentAreaName=北部` は `長野県 北部`、7桁の `areaCode=0121400, parentAreaName=稚内市` は `北海道 稚内市` とする。後者の local `name=稚内海岸` は `北海道 稚内市 稚内海岸` となる。実 corpus と同型の正規化済み `parentAreaName=長野県 北部` は `startsWith("長野県")` を満たすため重ねて前置しない。`parentAreaName=北部（長野県）` のように非先頭位置だけへ正式県名を含む人工反例は前置済みとみなさず、`長野県 北部（長野県）` とする。

**B案**「都道府県名 細分名」（例: `長野県 菅平周辺`）は、予報区名を可視文字から落とす別案として検討したが、**2026-09-05 にご主人が A案を裁定**したため不採用とする。真に別粒度の行政区域名を表示するには parser / protocol から別 code を供給する拡張が必要で、本 spec の対象外である。

既存 `legacyImprovedWeatherWarningForecast` preview は、本番 fixture と同型の `parentAreaName=稚内市`、`name=稚内海岸`、`areaCode=0121400`、`localCode=L001` を使い、area の `北海道 稚内市` と local の `北海道 稚内市 稚内海岸` を一つの 128-period / 32-atom fixture で確認する。fixture の period 数、atom 数、最大4 period、group / target / period の key と順序は変えない。6桁、7桁、県名前方一致、null の4分類に、県名文字列が非先頭にある反例を加えた5ケースを §5.2 の helper / component test matrix で必須化する。

### 3.5 竜巻 rider

WeatherAlertCard の DOM では rider が常に最下段である。footer がある場合も通常フローの footer を rider の上へ置き、rider 用 `margin-top` は設けない。

外殻の `border-radius` / `overflow` 設定は変更せず、rider 自身へ次の下角を明示する案を採る。

```css
.tornado-rider {
  border-bottom-left-radius: calc(var(--radius-standby) - 1px);
  border-bottom-right-radius: calc(var(--radius-standby) - 1px);
}
```

1px はカード border の内側へ合わせる差である。border-radius は box の計測寸法を変えないため、measurement probe、固定 shell、rider page partition に新しい高さ差を持ち込まない。既存の `.weather-card { overflow: hidden; }` は二重の安全策として維持する。通常注意情報と `.sighted` 背景の双方で、rider 背景が下角の外へ漏れず、rider 下端とカード内側下端の間に空行がないことを browser で確認する。

### 3.6 preview・capture の追従

新しい独立 capture suite は作らず、前弾の `display/scripts/capture-legacy-standby.mjs --suite design-alignment` を拡張する。既存 `#standby-vpwp50-forecast`、`#standby-briefing-design-alignment`、`#standby-design-alignment-compressed`、`#legacy-standby-gate?gateScenario=max` を再利用し、必要な card page tick / rotation tick を manifest に足す。footer / rider の実表示を捕捉できない record を、単なる非表示 `null` として合格させない。

三解像度は `1920×1080`、`1280×720`、`960×620` とする。各解像度を合計しただけでなく、三解像度それぞれに少なくとも一つの通常フロー footer を捕捉する。WeatherAlertCard + tornado rider は `max` または compressed fixture の、weather page footer と rider が同時に見える tick を各解像度で捕捉する。

`legacy-standby-gate max` は単一の compressed 前提へ混ぜず、少なくとも次の二 plan に分ける。

| plan | viewport | stage | compressed | 比較契約 |
|---|---|---:|---|---|
| `fhdMax` | 1920×1080 | 1 | false | baseline 採取時の placement、pager namespace / key、reset 元の全論理項目列と after を一致。page range / identity / count は診断値 |
| `hdMax` | 1280×720 | 3 | true | 既存 `DESIGN_ALIGNMENT_MAX_PLAN` の placement / rotation / Typhoon variant / omitted と base / after を完全一致 |

capture 実装では単数 `DESIGN_ALIGNMENT_MAX_PLAN` を viewport keyed の max plans または同等の別定義へ分ける。comparison policy は各 record が属する plan の `compressed` を期待し、すべての `legacy-standby-gate` record に `compressed=true` を一律要求しない。`fhdMax` は base / after の ladder / measurement stage 1と `compressed=false`、`hdMax` は両 stage 3と `compressed=true` を固定する。既存 compressed scenario の1280 / 960 plan は別枠のまま維持する。

WeatherAlertCard の高さ差専用に、tornado なし・weather footer あり・`.paging-contract` なし・explicit height なしの `weatherAutoFooterNormal` / `weatherAutoFooterCompressed` target を design-alignment manifest へ明示する。通常 geometry と compressed geometry ごとに alert payload、literal な forced `measurementRange`、page count、`data-card-page-identities`、active identity、page key を manifest で固定し、base / after の同じ論理項目範囲を測る。この専用 fixture だけは range と page identity を完全一致させ、production partition の合否条件へ横展開しない。

manifest は、base / after の双方で `card.scrollHeight <= card.clientHeight + 1` かつ `card.getBoundingClientRect().height < computed max-height - 1px` となる forced range を選ぶ。computed `max-height` は px へ解決した値を記録し、一方でも非数値、overflow、または max-height 到達なら fixture 不適合として非0終了する。既存 shelf からこの条件を一意に得られない場合だけ、既存 suite 内の固定 preview scenario と probe fixture を追加してよい。これは fixed tornado shell の代用ではなく、補償撤去の自然高差だけを測る counterfactual である。

report へ、対象 footer ごとに次を追加する。

- card / footer / indicator / 直前の本文要素 / 直後の rider の rect
- card の四辺 border 幅、footer の computed position / height / padding / border-top / background、indicator の font-size / color / line-height / background
- `footer.bottom` と card 内側下端の差、`indicator.bottom` と `footer.bottom - paddingBottom` の差
- 本文↔footer、footer↔rider、indicator↔本文、indicator↔rider の overlap
- DOM の footer 数、indicator の可視 text、footer / rider の sibling 順
- rider の四隅 radius、background、カード内側下端との差
- VPWP50 の可視 target、target `title`、card / atom accessible name、可視 `.continuation` 件数
- Briefing page atom の rect / display / flex-grow / min-height、WeatherAlert の grid-template-rows / grid-area と各 row rect
- Weather auto-height probe の tornado / paging-contract / explicit-height 有無、forced range、page count、`data-card-page-identities`、active identity、page key、card rect / clientHeight / scrollHeight、computed max-height、max-height までの gap、非 clamp 判定
- production の各 card pager の page range、page count、`data-card-page-identities`、active identity、range 由来 page key。いずれも診断値とし、WeatherAlert は weather / tornado を別 pager として出す
- pager namespace / key と reset 元の全論理項目列 / 出現順 / 重複数。Weather は occurrence-aware area key と kind 別 `omittedAreaCount` sentinel を含める

変更後 assertion は次を満たさなければ非0終了とする。

- computed `position: static`、footer padding は通常段 `4px 16px`、圧縮段 `2px 8px`、border-top は1px、indicator は12px・`--role-muted` 相当・transparent。
- rider なしでは footer が最後の flow child で、footer 下端は card 内側下端、indicator 下端はそこから block padding 分だけ上にある。本文との overlap は0。
- rider ありでは `footer.bottom <= rider.top`、rider が最後の flow child、rider 下端は card 内側下端、全 overlap は0、左右下角は `calc(16px - 1px) = 15px` 相当である。
- VPWP50 の可視 `.continuation` は0、footer は1、表示地名は area / local の規則どおり、完全名称には従来の code が残る。
- client / scroll overflow は1px以内、font ready / measurement settled、measurement shelf と live の幅一致、period / entry の論理 identity、pager namespace / key、reset 元の全論理項目列の保持を満たす。
- auto-height weather probe は tornado / `.paging-contract` / explicit height を持たず、base / after で manifest の同じ forced range を測る。双方で `scrollHeight <= clientHeight + 1`、computed max-height が数値に解決すること、border-box 高がその max-height より1px超低く非 clamp であることを先に assert する。fixed tornado shell はこの自然高 assertionへ流用しない。
- production partition では range、page count、`data-card-page-identities`、active identity、range 由来 page key の差だけで失敗させない。各 card pager（WeatherAlert は weather / tornado を分離）で pager namespace / key と reset 元の全論理項目列が base / after 同一、順序維持、重複0、欠落0、各ページの overflow が1px以内であることを assert する。Weather の列は occurrence-aware area key と kind 別 `omittedAreaCount` sentinel を含む。

前弾 suite の期待値で本弾により変わる箇所は次のとおりである。実装前に main `8b63f1441` の fresh baseline を採り、古い baseline JSON を流用しない。

| 対象 | main `8b63f1441` → 本弾 after の幾何期待 |
|---|---|
| FloodCard / FloodWideCard | 共通 CSS への移動だけなので footer / card 自然高差 `0px ±1px` |
| WeatherWarningForecastCard | old reserve 16px → footer 25px / 21px のため、自然高差は通常 `+9px ±1px`、圧縮 `+5px ±1px`。前弾の `+12px / +6px` assertion は本弾の fresh baseline 比較では使わない |
| VolcanoCard | footer を持つ同一 page の自然高差は通常 `+9px ±1px`、圧縮 `+5px ±1px` |
| BriefingCard | live fixed shell の外形差は `0px ±1px`。probe の使用高は header 復元6pxと footer差9px / 5pxにより通常 `+15px ±1px`、圧縮 `+11px ±1px`。その分だけ本文 budget が減る |
| WeatherAlertCard | tornado なし・同一 forced range・base / after とも非 clamp の auto-height probe は、補償を全撤去した通常 contract に footer 行が加わるため通常 `+25px ±1px`、圧縮 `+21px ±1px`。tornado あり fixed shell の outer rect / scrollHeight 差は `0px ±1px` とし、内部 child 高の和と overflow を比較する。weather / tornado の partition range / identity / count は pager 別の診断値とし、pager namespace / key、occurrence-aware 論理項目列、kind 別 `omittedAreaCount` sentinel、順序、重複なしを固定する。rider radius 自体の高さ差は0 |

履歴上の前弾変更前 baseline と連続比較する資料を残す場合、VPWP50 の累積自然高差は通常 `+21px ±1px`（前弾 +12、本弾 +9）、圧縮 `+11px ±1px`（前弾 +6、本弾 +5）となる。ただし自動 gate の正本は本弾直前の fresh baseline に対する `+9 / +5` とする。

前弾で固定した `#standby-design-alignment-compressed` の candidate / rider / reserve 件数、128 period / 32 atom / 最大4 period、1280 / 960 の stage、placement、rotation key、Typhoon variant、omitted count は base / after 完全一致を維持する。`fhdMax` / `hdMax` も各 plan の stage、compressed、placement、pager namespace / key と reset 元の全論理項目列・順序を一致させる。production の page range、`data-card-page-identities`、active identity、page count、range 由来の page key、単一 tick のページ内表示件数は診断値とし、変化だけでは失敗させない。page identity の完全一致は §3.6 の専用 forced-range probe だけに要求する。それ以外の固定値が高さ変化で変わった場合は期待表を黙って更新せず §3.7 へ進む。

### 3.7 実装時裁定の報告

実測値、partition、既存 layout gate、型制約から本 spec どおりに実装できない場合は、変更を入れる前に次を報告する。

1. 逸脱する節と規則。
2. 変更前の browser 実測、失敗した assertion、該当 viewport / scenario / tick。
3. 採用したい代替案と、footer 下余白、本文量、ページ数、rider、accessible name、solver 配置への影響。
4. spec 本文と baseline / after expectation を同じ弾で更新するか、未解決として止めるか。

§3.2 に列挙した競合では本 spec を後発の正本とする。header 統一 spec と前弾 design-alignment spec の該当期待へ戻して本 spec を弱めてはならない。一方、列挙外の既存契約を本 spec が暗黙に上書きしたものと解釈してはならず、追加の競合を見つけた時点で本節の報告を行う。

既存テストの期待値を変更する前にも、変更対象 assertion、旧期待が表していた契約、新 spec により変わる理由を先に報告する。確定済みの変更対象は、absolute / zero-height footer、`--card-page-indicator-block-size`、header / ul / rider の補償算術、VPWP50 の可視 `続き` と code 付き可視地名、preview の `稚内市 / 稚内海岸 / 0121400 / L001` への変更、前弾 capture の forecast `+12 / +6`、production partition の range / page identity / active identity / page count 完全一致 assertion の診断値化である。それ以外の text、snapshot、stage / placement / rotation 期待を実装に合わせて黙って緩めてはならない。これらの期待変更は診断値の base / after 報告と、pager namespace / key・reset 元の全論理項目列・順序・重複なしの契約への置換として報告し、単に assertion を削除してはならない。

負 margin、transform による位置補正、raw px の新しい補償算術、fixed / absolute footer、共通 header の局所縮小、本文の切詰めを代替案として無断導入しない。

## 4. 対象ファイル

実装対象:

- `display/frontend/src/lib/theme.css`
- `display/frontend/src/lib/prefecture-group.ts`（6桁の親 areaCode 専用 helper を追加し、表示 helper から既存7桁 helper と桁別合成する。既存7桁 helper 本体と受理範囲は変更しない）
- `display/frontend/src/lib/weather-warning-forecast.ts`
- `display/frontend/src/components/FloodCard.svelte`
- `display/frontend/src/components/FloodWideCard.svelte`
- `display/frontend/src/components/BriefingCard.svelte`
- `display/frontend/src/components/WeatherWarningForecastCard.svelte`
- `display/frontend/src/components/VolcanoCard.svelte`
- `display/frontend/src/components/WeatherAlertCard.svelte`
- `display/frontend/src/components/StandbyScreen.svelte`（旧 `gate-overlap` の補償 margin 前提と footer / rider geometry diagnostics の追従だけ。solver / stage API は変更しない）
- `display/frontend/src/preview/fixtures.ts`
- `display/frontend/src/preview/PreviewApp.svelte`（auto-height weather probeを既存 shelf から一意に捕捉できない場合の固定 scenarioだけ）
- `display/scripts/capture-legacy-standby.mjs`
- `docs/specs/display-design-system.md`（§5 の対象カード説明と共通 footer / rider 契約だけ。§8 generated 領域は変更禁止）

テスト対象:

- `display/frontend/src/components/__tests__/flood-card.test.ts`
- `display/frontend/src/components/__tests__/flood-wide-card.test.ts`
- `display/frontend/src/components/__tests__/briefing-card.test.ts`
- `display/frontend/src/components/__tests__/weather-warning-forecast-card.test.ts`
- `display/frontend/src/components/__tests__/volcano-card.test.ts`
- `display/frontend/src/components/__tests__/weather-alert-card.test.ts`
- `display/frontend/src/components/__tests__/standby.test.ts`
- `display/frontend/src/components/__tests__/capture-design-alignment.test.ts`
- `display/frontend/src/lib/__tests__/prefecture-group.test.ts`
- `display/frontend/src/lib/__tests__/weather-warning-forecast.test.ts`（可視表示 helper の4分類・5ケースを直接検査）

変更対象外:

- parser、engine、wire protocol、永続化、通知、CLI
- `display/frontend/src/lib/protocol.ts`、`display/frontend/src/lib/prefecture-group.ts` の既存7桁 helper 本体・受理範囲・都道府県表
- `display/frontend/src/lib/legacy-standby/solver.ts`、time-slice scheduler、page partition の意味論
- VPWP50 の最大4 period / atom、128 period fixture の総数・順序・identity / key
- tornado page partition の意味論、`.tornado-page-marker`、WeatherAlertCard の280px上限
- `display/frontend/src/preview/LegacyImprovedMock.svelte` とその凍結参照 test
- theme token の値、`docs/specs/display-design-system.md` §8 generated 領域

## 5. 受入条件

### 5.1 静的契約

否定条件は selector / ファイル単位で0件を要求する。

```sh
! rg -U '\.card-page-footer\s*\{' \
  display/frontend/src/components/FloodCard.svelte \
  display/frontend/src/components/FloodWideCard.svelte \
  display/frontend/src/components/BriefingCard.svelte \
  display/frontend/src/components/WeatherWarningForecastCard.svelte \
  display/frontend/src/components/VolcanoCard.svelte \
  display/frontend/src/components/WeatherAlertCard.svelte
! rg -U '\.card-page-indicator\s*\{' \
  display/frontend/src/components/FloodCard.svelte \
  display/frontend/src/components/FloodWideCard.svelte \
  display/frontend/src/components/BriefingCard.svelte \
  display/frontend/src/components/WeatherWarningForecastCard.svelte \
  display/frontend/src/components/VolcanoCard.svelte \
  display/frontend/src/components/WeatherAlertCard.svelte
! rg -- '--card-page-indicator-block-size' \
  display/frontend/src/components/BriefingCard.svelte \
  display/frontend/src/components/WeatherWarningForecastCard.svelte \
  display/frontend/src/components/VolcanoCard.svelte \
  display/frontend/src/components/WeatherAlertCard.svelte
! rg -U '\.weather-card\.has-page-footer[^}]*\}|\.briefing-card\.has-page-footer[^}]*\}' \
  display/frontend/src/components/WeatherAlertCard.svelte \
  display/frontend/src/components/BriefingCard.svelte
! rg 'calc\(var\(--space-[23]\) - [346]px\)|margin-top: var\(--card-page-indicator-block-size\)' \
  display/frontend/src/components/WeatherAlertCard.svelte \
  display/frontend/src/components/BriefingCard.svelte
! rg 'class="continuation"|\.continuation\s*\{' display/frontend/src/components/WeatherWarningForecastCard.svelte
! rg -U '\.card-page-footer\s*\{[^}]*(position:|inset|bottom:|z-index:|height:|min-height:|overflow:\s*visible)' display/frontend/src/lib/theme.css
! rg 'prefectureFrom(?:SixDigitAreaCode|MunicipalityCode)\(target\.localCode\)' display/frontend/src/lib/weather-warning-forecast.ts
! rg '(target\.)?parentAreaName\.includes\(prefectureName\)' display/frontend/src/lib/weather-warning-forecast.ts
```

肯定条件は共通 selector と各 ownership selector を別々に検査する。

```sh
rg -U '\.card-page-footer\s*\{[^}]*display:\s*flex;[^}]*flex:\s*0 0 auto;[^}]*justify-content:\s*flex-end;[^}]*padding:\s*var\(--space-1\) var\(--space-4\);[^}]*border-top:\s*1px solid var\(--hairline\);' display/frontend/src/lib/theme.css
rg -U '\.card-page-indicator\s*\{[^}]*padding:\s*1px var\(--space-2\);[^}]*background:\s*transparent;[^}]*color:\s*var\(--role-muted\);[^}]*font-size:\s*var\(--type-label-xs-size\);[^}]*line-height:\s*1;' display/frontend/src/lib/theme.css
test "$(rg -l 'data-card-page-footer' \
  display/frontend/src/components/FloodCard.svelte \
  display/frontend/src/components/FloodWideCard.svelte \
  display/frontend/src/components/BriefingCard.svelte \
  display/frontend/src/components/WeatherWarningForecastCard.svelte \
  display/frontend/src/components/VolcanoCard.svelte \
  display/frontend/src/components/WeatherAlertCard.svelte | wc -l | tr -d ' ')" -eq 6
rg -U '\.briefing-card\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;' display/frontend/src/components/BriefingCard.svelte
rg -U '\[data-briefing-page-atom\]\s*\{[^}]*display:\s*flex;[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;[^}]*flex-direction:\s*column;' display/frontend/src/components/BriefingCard.svelte
rg -U '\.briefing-page-footer\s*\{[^}]*margin-top:\s*auto;' display/frontend/src/components/BriefingCard.svelte
rg -U '\.weather-card\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto auto;[^}]*grid-template-areas:\s*"header"\s*"body"\s*"footer"\s*"rider";' display/frontend/src/components/WeatherAlertCard.svelte
rg -U '\.weather-card-header\s*\{[^}]*grid-area:\s*header;' display/frontend/src/components/WeatherAlertCard.svelte
rg -U 'ul\s*\{[^}]*grid-area:\s*body;' display/frontend/src/components/WeatherAlertCard.svelte
rg -U '\.weather-page-footer\s*\{[^}]*grid-area:\s*footer;' display/frontend/src/components/WeatherAlertCard.svelte
rg -U '\.tornado-rider\s*\{[^}]*grid-area:\s*rider;' display/frontend/src/components/WeatherAlertCard.svelte
rg '^export function prefectureFromSixDigitAreaCode\(' display/frontend/src/lib/prefecture-group.ts
rg '^export function prefectureFromMunicipalityCode\(' display/frontend/src/lib/prefecture-group.ts
rg -U 'prefectureFromSixDigitAreaCode\(target\.areaCode\)\s*\?\?\s*prefectureFromMunicipalityCode\(target\.areaCode\)' display/frontend/src/lib/weather-warning-forecast.ts
rg '(target\.)?parentAreaName\.startsWith\(prefectureName\)' display/frontend/src/lib/weather-warning-forecast.ts
rg '^export function vpwp50ForecastTargetDisplayLabel\(' display/frontend/src/lib/weather-warning-forecast.ts
rg 'vpwp50ForecastTargetDisplayLabel\(atom\.target\)' display/frontend/src/components/WeatherWarningForecastCard.svelte
rg -U '\.tornado-rider\s*\{[^}]*border-bottom-left-radius:\s*calc\(var\(--radius-standby\) - 1px\);[^}]*border-bottom-right-radius:\s*calc\(var\(--radius-standby\) - 1px\);' display/frontend/src/components/WeatherAlertCard.svelte
rg 'continuation' display/frontend/src/lib/weather-warning-forecast.ts
```

### 5.2 component / DOM

- six card components は page footer の表示条件と `data-card-page-footer` / `data-card-page-indicator` を維持する。multi-page では footer が一つ、single-page では既存仕様どおり0とする。
- FloodCard / FloodWideCard は forced measurement footer、page label、全ページの論理項目と自然高を維持する。ページ範囲は診断値として記録する。
- BriefingCard は footer 時にも header が共通 padding を持つ。fixed shell では page atom が header 後の残余高を所有し、footer bottom が card 内側下端に一致する。再 partition しても全 entry / block の key、順序、総数を失わず、本文と footer が重ならない。
- WeatherWarningForecastCard は可視 `.continuation` が0、footer が1、page text が `n/m` である。A案で area は補正後の予報区名、local はそれに地域内細分名を続け、可視 text に area / local code を出さない。一方 target の `title`、atom / card accessible name は親 area code と `L001` を従来どおり含む。6桁 / 7桁の親 code を桁別 helper で合成し、null / 不正 / 未知は原予報区名へ fail-open する。128 period、32 atom、最大4 period、identity / key / order と fingerprint の構成規則を維持する。preview 値変更後に採った fresh baseline と after の fingerprint は一致させる。

  `prefecture-group.test.ts` は6桁 helper と既存7桁 helper の桁別受理を固定する。`weather-warning-forecast.test.ts` の表示 helper 検査と `weather-warning-forecast-card.test.ts` の component 検査は、それぞれ次の4分類・5ケースを省略せず固定する。

  | 経路 | 入力 | helper / 可視表示の期待 |
  |---|---|---|
  | 6桁 | `areaCode=200010`, `parentAreaName=北部` | 6桁 helper は `長野県`。area は `長野県 北部` |
  | 7桁 | `areaCode=0121400`, `parentAreaName=稚内市`, local `name=稚内海岸`, `localCode=L001` | 6桁 helper は null、既存7桁 helper は `北海道`。area は `北海道 稚内市`、local は `北海道 稚内市 稚内海岸` |
  | 県名文字列あり（2ケース） | 実 corpus 同型の正規化済み `areaCode=200010`, `parentAreaName=長野県 北部`, local `name=菅平周辺`／人工反例 `parentAreaName=北部（長野県）` | 前者は area `長野県 北部`、local `長野県 北部 菅平周辺` として重複しない。後者は非先頭一致なので `長野県 北部（長野県）` と前置する |
  | null | `areaCode=null`, `parentAreaName=宗谷地方`, local `name=沿岸` | helper は null。area は `宗谷地方`、local は `宗谷地方 沿岸`。名称から県名を推測しない |

  7桁 helper の既存の受理 / 拒否 matrix も維持する。component では5ケースそれぞれの必要な area / local scope、code なし可視 text、code あり `title` / accessible name を同時に assert する。
- VolcanoCard は muted / severity header、火山・降灰内容、omitted count、論理項目 identity / key、pager namespace / key を維持する。production の page identity / count は診断値とする。
- WeatherAlertCard は footer の有無にかかわらず header / `ul` / rider の通常 padding が同じである。fixed shell では `ul` row だけが余剰高を所有し、footer は `ul` の後、rider の前、rider はカード内側下端に接する最後の子となる。weather pager と tornado pager は独立したまま全対象地域を保持する。production の range、`data-card-page-identities`、active identity、page count は診断値として変化を許容する。固定する pager namespace / key と reset 元の全論理項目列には、Weather の occurrence-aware area key と kind 別 `omittedAreaCount` sentinel を含め、出現順、重複なし、欠落なし、overflow 1px以内を assert する。

対象 vitest を個別に通す。

```sh
npm --prefix display test -- \
  frontend/src/components/__tests__/flood-card.test.ts \
  frontend/src/components/__tests__/flood-wide-card.test.ts \
  frontend/src/components/__tests__/briefing-card.test.ts \
  frontend/src/components/__tests__/weather-warning-forecast-card.test.ts \
  frontend/src/components/__tests__/volcano-card.test.ts \
  frontend/src/components/__tests__/weather-alert-card.test.ts \
  frontend/src/components/__tests__/standby.test.ts \
  frontend/src/components/__tests__/capture-design-alignment.test.ts \
  frontend/src/lib/__tests__/prefecture-group.test.ts \
  frontend/src/lib/__tests__/weather-warning-forecast.test.ts
```

既存テストの期待値変更は §3.7 の事前報告を必須とする。特に WeatherAlertCard test の `height: 0` / padding 補償 source assertion、WeatherWarningForecastCard test の bottom reserve / `続き` / code付き可視文字、capture test の `+12 / +6` は旧契約の検出器なので、理由を記録した上で本 spec の正期待へ置き換える。assertion の削除だけ、許容差の拡大だけで通してはならない。

### 5.3 browser capture と layout gate

実装順は、(1) report field / manifest / assertion と preview fixture を先に追加、(2) main `8b63f1441` の fresh baseline を採取、(3) component / shared CSS を変更、(4) 同じ Chrome、font、真の viewport、tick で after を採取、の順とする。

```sh
node display/scripts/capture-legacy-standby.mjs --suite design-alignment --report \
  --write-baseline /tmp/fleq-standby-page-footer-base.json
node display/scripts/capture-legacy-standby.mjs --suite design-alignment --report \
  --baseline-report /tmp/fleq-standby-page-footer-base.json
```

1920×1080、1280×720、960×620 の三解像度すべてで §3.6 の geometry assertion を実行する。footer の `position: static`、下余白、本文非重複、Briefing page atom の残余高所有、WeatherAlert の四 grid row、rider 最下段と15px下角、overflow 0を computed style / rect から判定する。DOM source や screenshot の保存だけで代替しない。

前弾 `design-alignment` の Briefing 2×2、VPTA NumberUnit、candidate / payload signature、font readiness、measurement/live width、1280 / 960 compressed plan、1280 max comparison の assertion は削らず併走させる。VPWP50 の自然高 delta だけは §3.6 の fresh baseline 値へ置き換える。三解像度の card / readable overflow は1px以内、footer / body / rider overlap は0、`data-layout-unresolved=false`、measurement nonconverged=false、rotation omitted count 0とする。

max comparison は `fhdMax(1920)` と `hdMax(1280)` を plan key で引く。`fhdMax` は ladder / measurement stage 1、`compressed=false`、base / after placement一致を要求する。`hdMax` は既存 stage 3、`compressed=true` と既存 placement / rotationを要求する。compressed assertion は `plan.compressed` との一致として実装し、scenario 名だけで true を決めない。

WeatherAlert の `+25 / +21` は manifest 上の専用 auto-height probeだけで判定する。probe report は `tornadoPresent=false`、`pagingContract=false`、explicit heightなし、footerあり、manifest literal の forced range / page count / `data-card-page-identities` / active identity / page key の base / after 一致を必須 field とする。通常 / 圧縮の各 before / after で card rect / `clientHeight` / `scrollHeight`、computed `max-height`、max-height までの gap を記録し、差分比較の前に双方の `scrollHeight <= clientHeight + 1` と `border-box height < computed max-height - 1px` を要求する。manifest はこれを満たす forced range を固定し、非 clamp 条件不成立の record で `+25px ±1px` / `+21px ±1px` を判定しない。page identity の完全一致はこの専用 forced-range probe だけに要求する。tornado あり fixed shell は outer rect / scrollHeight差 `0px ±1px`、`header + ul row + footer + rider` の内側占有高が content box以内、footer / rider overlap 0を別 assertionにする。production の weather / tornado は partition range / page identity / active identity / page count を別々に base / after へ記録するが診断値とし、完全一致を要求しない。

stage、placement、rotation key / active position、pager namespace / key、Typhoon variant が base / after で変わった場合は非0終了し、§3.7 の裁定を求める。production の page range、`data-card-page-identities`、active identity、page count、range 由来の page key、単一 tick のページ内表示件数は pager 別の診断値とし、差だけでは失敗させない。代わりに、各 pager の scheduler reset 元となる全論理項目列を比較し、base / after 同一、順序維持、重複0、欠落0、各ページの overflow 1px以内を要求する。Weather の列には occurrence-aware area key と kind 別 `omittedAreaCount` sentinel を含める。range と page identity の完全一致は、非 clamp を before / after で先に確認する専用 auto-height probe に限る。

### 5.4 全体ゲート

```sh
npm run build
npm test
npm run display:build
npm run display:test
npm --prefix display run typecheck
npm --prefix display run docs:design:check
```

本変更は永続化、共有状態、module scope の可変状態を変更しないため `npm run test:shuffle` は必須にしない。それらへ実装範囲を広げる場合は §3.7 の報告後に対象へ追加し、`npm run test:shuffle` も通す。

## 6. 裁定ラベル

- **対象**: 6カードの page footer 共通契約、Briefing の残余高 column flex、WeatherAlert の四 row grid、VPWP50 の可視 `続き` 一本化と6 / 7桁親 Area.Code・正規化済み `startsWith` による予報区 / 地域内細分表示、production page metadata の診断値契約、pager reset 元の全論理項目列、竜巻 rider 下角、既存 preview / design-alignment suite の三解像度 geometry / 非 clamp auto-height probe / plan別 base比較、対象 test、design-system catalog。
- **許容変更**: §3 の shared CSS、対象 component の footer / target DOM と scoped CSS、6桁親 areaCode 専用 helper の追加と既存7桁 helper との表示側合成、既存 preview fixture の `稚内市 / 稚内海岸 / 0121400 / L001`、必要時だけの固定 auto-height probe scenario、StandbyScreen の旧 counterexample / diagnostics、capture manifest / report / plan別 assertion、production の range / `data-card-page-identities` / active identity / page count の診断値化、occurrence-aware key / `omittedAreaCount` sentinel 比較、§5を満たす対象 test の更新。追加の既存期待値変更は §3.7 の事前報告後だけ許容する。
- **禁止変更**: parser、engine、wire、永続化、通知、CLI、solver / stage API、scheduler / partition 意味論、pager namespace / key、scheduler reset 元の全論理項目列・順序、既存7桁 helper の本体・受理範囲、親 areaCode を6桁だけまたは7桁だけと決め打ちすること、`localCode` からの都道府県導出、VPWP50 の期間 / atom 構成・identity・順序・総数、tornado paging の意味論、theme token 値、対象外カード、凍結 preview、§8 generated 領域、absolute / fixed / zero-height footer、負 margin、transform 補正、header / 本文 / rider の局所 padding 縮小、名称からの都道府県推測、情報の切詰め。
- **配送先（main → personal → Pi）**: main で本弾を受入後、同一差分を personal、Pi の順に配送し、各段で §5 の gate と三解像度 preview、最後にご主人の実機表示を確認する。
- **ロールバック**: 本弾の単一修正 commit を revert し、main → personal → Pi の順に再配送する。前弾 header / spacing / NumberUnit の成果は巻き戻さない。
- **受入条件**: §5 の selector 単位の静的契約、6ファイル厳密件数、対象 vitest、A案の6桁・7桁・県名前方一致・nullの4分類と非先頭反例を含む5ケース、三解像度 browser geometry、before / after とも非 clamp の forced-range auto-height 差、fixed-shell 外形差、plan別 compressed と base / after layout 同一性、production page metadata の pager別診断値、pager namespace / key と reset 元の全論理項目列・順序・重複なし・欠落なし・overflow、Weather の occurrence-aware key / kind 別 omitted sentinel、全体 gate をすべて満たし、未申告の spec 逸脱と情報欠落がないこと。

裁定状態（2026-09-05）: 洪水型 footer を正系とすること、VPWP50 の可視 `続き` を footer へ一本化すること、rider を最下段として下角を持たせることは、Liebe が仮裁定として提示しご主人から異議なし（追認扱い）。地名は Local を地域内細分と訂正し、6 / 7桁の親 Area.Code を桁別合成し、正規化済み `parentAreaName.startsWith(prefectureName)` だけを前置済みとする **A案「予報区名 細分名」をご主人が裁定**（B案は不採用）。production の range / page identity / active identity / page count は診断値、pager namespace / key と reset 元の全論理項目列は固定、専用 forced-range probe の page identity だけを非 clamp 前提で完全一致とする。本 spec は裁定済みとして実装へ進める。
