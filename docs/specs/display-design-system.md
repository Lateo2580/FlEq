# 常設情報ディスプレイ デザインシステム

> `display/`（常設情報ディスプレイ frontend）のデザイントークンとアクセシビリティ基準の正本。
> CLI 側テーマ（`docs/specs/ui.md` / `docs/display-reference.md`）とは別物。
> 付録（§8）の表は `display/scripts/generate-design-docs.mjs` が生成する。
> 再生成: `cd display && npm run docs:design` / 乖離検査: `npm run docs:design:check`。

## 目次

- [1. 概観](#1-概観)
- [2. デザイン原則](#2-デザイン原則)
- [3. Foundations](#3-foundations)
- [4. Tier 機構](#4-tier-機構)
- [5. コンポーネントカタログ](#5-コンポーネントカタログ)
- [6. アクセシビリティ](#6-アクセシビリティ)
- [7. 用語集](#7-用語集)
- [8. 付録（GENERATED）](#8-付録generated)

## 1. 概観

この文書は常設情報ディスプレイ（`display/`）のデザイントークンとアクセシビリティ基準の正本である。
トークンとは「色・文字サイズ・角丸などの値に名前を付けて一箇所で定義した設定値」で、実体は `display/frontend/src/lib/theme.css` の CSS カスタムプロパティ（`--...`）にある。
各コンポーネントはこの名前を参照するだけで、生の値を持たない。
値を一箇所に集めることで、全画面の見た目を一本の定義から動かせる。

対象範囲は `display/` の frontend に限る。
FlEq には別に CLI 側の端末テーマがあり、その規範は `docs/specs/ui.md` と `docs/display-reference.md` にある。
両者は色の錨（後述の CUD 9 色）を共有するが、トークン体系・レイアウト・アクセシビリティ方針は独立している。
本書の記述を CLI 側にそのまま当てはめてはならない。

デザインの下敷きとしてデジタル庁デザインシステム（DADS）を全面採用することは検討したが、見送った。
理由は三つ。
第一に、DADS はライトモード主体でダークモードのトークンが揃っていない。本ディスプレイは常時ダークで運用する（§2）。
第二に、DADS の severity（重大度）表現が 3 段階止まりで、地震・津波・気象で必要な多段の警報階層を表しきれない。
第三に、震度分布や津波予報区といった地図系の部品が DADS には無い。
そこで DADS そのものは採用せず、アクセシビリティの考え方（JIS X 8341-3:2016 レベル AA 相当）だけを規範として借り、トークンは自前で定義した（§6）。

本書の末尾 §8 はスクリプト生成物である。
`display/scripts/generate-design-docs.mjs` が `theme.css` を読み、トークン一覧（§8a）とコントラスト監査表（§8b）を `<!-- GENERATED:... -->` マーカーの間に書き込む。
再生成は `cd display && npm run docs:design`、生成物と現物の乖離検査は `npm run docs:design:check` で行う。
検査は vitest からも走り、`theme.css` を変えたのに §8 を再生成し忘れると乖離としてテストが落ちる。
§8 を手で編集してはならない。値の裏取りは常に §8 の生成表を見る。

## 2. デザイン原則

本ディスプレイは装飾ではなく計器盤（instrument panel）として設計する。
計器盤とは、車のメーターや航空機の計器のように「数値を一目で正確に読ませる」ことを最優先にした表示面のことである。
この思想が全トークンの土台にある。

**計器盤思想。**
本文フォントに等幅の JetBrains Mono を第一候補に置く（`theme.css:1-5` のヘッダコメント、`--font-ui` は `theme.css:105`）。
等幅フォントは全文字が同じ横幅なので、桁の位置が揃い、数値が縦にきれいに並ぶ。
数値表示には `tabular-nums`（等幅数字）を使い、値の列は em / ch を単位に固定幅で揃える。
これにより、震度やマグニチュードが更新されても桁位置が動かず、遠目でも読み違えない。
画面幅への追従は文字幅ではなく font-size 経由で行う（§3 タイポ）。

**ダーク常設。**
`:root` に `color-scheme: dark` を固定する（`theme.css:23`）。
ライト／ダークを切り替える機構は持たない。
明るさ調整は減光（dim）トグルだけで、寝室などで画面全体を沈めるための一段階である（§4・§5 の StandbyScreen）。
背景は `--bg`（純黒）、基本文字は `--fg`（`theme.css:25-28`）で、この 2 色が全コントラストの基準点になる。

**CUD 9 色と JMA 法定色を錨とする。**
色の土台は CUD（Color Universal Design、色覚多様性対応）の 9 色パレットである（`theme.css:30-41`）。
CUD は、色の見え方が多数派と異なる人にも区別しやすいよう選ばれた配色群を指す。
この 9 色を「錨（anchor）」＝動かさない基準色として固定し、意味色はここから導く。
例外は津波の 3 段階で、これは気象庁（JMA）が定める法定の標準色（紫・赤・黄）に従う（`theme.css:43-47`）。
人命に直結する津波表示で独自色を使わないための規約である。

**M3E 概念の自前翻訳。**
角丸の段階（shape scale）、面の重なり（surface container）、影による奥行き（tonal elevation）、ばね物理の動き（spring motion）といった概念は、Material 3 Expressive（M3E）から発想を借りている（`theme.css:161-224`）。
ただし M3E のライブラリやコンポーネントには依存しない。
概念だけを受け取り、値はすべてこのディスプレイの都合（ダーク常設・遠見・焼付き回避）に合わせて自前で定義した。
したがって本書のトークンは M3E の実装と一対一では対応しない。

## 3. Foundations

トークンの土台となる 4 領域を扱う。
各節は「なぜこの設計か」を述べ、個々の値は §8a の生成表を参照する。

### 3.1 色

色は 4 層の階層で組む。
下層ほど生の値に近く、上層ほど意味に近い。

1. **プリミティブ**（`theme.css:30-47`）: CUD 9 色に加え、`-lift` 変種と JMA 津波色を置く。ここが唯一の生の色定義である。
2. **DisplayColorRole**（`theme.css:49-66`）: `--role-critical` や `--role-tsunamiMajor` のように「意味」に色を割り当てる層。コンポーネントは原則この role を参照し、生の色を直接触らない。
3. **震度 rank**（`theme.css:68-80`）: 震度 1〜7 を 9 段（5 弱・5 強・6 弱・6 強・7 を分割）に展開したテキスト色。rank 1〜7 は文字色だが、6 強（rank8）と 7（rank9）だけは面（背景色）＋反転文字で塗る。強い震度を「文字色」ではなく「塗り」で示して段位を跳ね上げるためである。
4. **ヘッダ 3 層**（`theme.css:82-102`）: 緊急パネル見出しの意味色 container 面・明るい on-container 文字・下端の CUD 色帯の 3 点セット。色相＝意味のシグナルは下端の帯（`--header-band-*`、既存の CUD/JMA 色）が担保するので、container 面の色相を各意味へ手動移植しても色の錨には抵触しない。

`-lift` 変種（`--c-blue-lift`・`--c-orange-lift`、`theme.css:34,38`）は「黒背景のテキスト専用に一段明るくした色」で、面（背景塗り）には使わない。
純黒の上に暗い CUD 色を文字として置くとコントラストが足りないため、文字のときだけ明度を持ち上げる。
特に `--c-orange-lift` は、実機パネルで `--c-orange` が注意報の黄色と見分けづらかったため、テキスト role をこちらへ寄せた経緯がある（`theme.css:38` のコメント）。

`--c-jma-purple-bar` は語彙設計上の中立 alias である（`theme.css:82-90`）。
大津波警報（津波）と気象特別警報（気象）は共に法定紫で、container 面も下端帯も一致する。これは意図通りで、両者は見出し文言で区別する。
ただし帯トークンで気象側が津波専用名の `--c-tsunami-purple-bar` を直接借りると「気象なのに津波色を使っている」と読める語彙の混線が起きる。
そこで中立名 `--c-jma-purple-bar` を一枚かませ、両者はこの alias 経由で同じ紫を共有する（プリミティブの `--c-tsunami-purple-bar` はそのまま温存）。

### 3.2 タイポグラフィ

フォントは 2 種をセルフホストする（`theme.css:7-20`）。
欧文・数字の JetBrains Mono と、日本語の Noto Sans JP で、いずれも 1 ファイルで複数太さを持つ可変フォント（variable font）である。
ライセンスは SIL Open Font License 1.1（同ディレクトリの `OFL-*.txt`）。
外部 CDN に頼らずアプリ内に同梱するのは、ネットワーク断でも確実に同じ字形で表示させるためである。

太さは可変フォントの wght 軸を段階化した `--type-weight-*`（regular〜heavy）で持ち、role 別に baseline と emphasized の 2 つを定義する（`theme.css:115-122`）。
通常時は baseline、強調時は emphasized に切り替えることで、太さのゆらぎを役割単位で一元管理する。
主役数字の太さ `--num-weight` は tier に連動して離散的に heavy へ持ち上がる（§4）。

型スケール（文字サイズの段階表）は二本立てである。

- **固定 px**（`theme.css:124-140`）: 緊急パネル向け。使用側で `* var(--panel-scale, 1)` を掛け、パネルの拡大率に追従させる。緊急時（scale 1.5）に主役文字を一律に大きくするための仕組みである。
- **fluid clamp**（`theme.css:145-151`）: 待機画面向け。`clamp(最小, 画面幅追従, 最大)` で画面幅に連続追従する。待機画面は情報密度が低く、画面サイズに応じてなめらかに伸縮させたいためである。

`--panel-scale` は緊急パネル系のみが注入し（EmergencyScreen が `1.5` を定義）、下端帯幅 `--header-band-width` などもこれに連動する（`theme.css:91,124`）。
この二本立ての帰結として、同一トークンが画面幅次第で小さめの文字にもなり得る点は §6 のアクセシビリティ方針に効いてくる。

**数値+添え字（NumberUnit）。**
単位・等級ラベルつきの数値は NumberUnit コンポーネント（`components/NumberUnit.svelte`）で「主役数値 大 + 添え字 小」に統一する（2026-07-23 数値表記統一）。
添え字とは数値に従属する短い記号・語のことで、後置の単位（`3.31m` の m、hPa、m/s、km/h、km）と前置の等級ラベル（`M7.1` の M、`レベル3` のレベル）の両方を指す。
つまり「読む人がまず掴むべきは数値、添え字はその読み方の補助」という優先度を、サイズ差で表現する仕組みである。

- 数値（`.nu-value`）は常に `tabular-nums`（等幅数字）+ `--num-weight`（tier 連動）。添え字（`.nu-prefix` / `.nu-unit`）は weight・variant とも normal
- 添え字サイズは `max(12px, var(--number-unit-affix-size, 0.6em))`。0.6em の縮小は数値が 20px 級（洪水ワイドの主役水位など）で初めて視覚的な階層になる。12〜14px 文脈では 12px 床が効いて縮小がほぼ潰れるため、狭小レイアウト側は `--number-unit-affix-size: 1em` を指定して**縮小なし・構造だけ共有**とする（FloodCard corner の水位が該当）。この例外は「洪水という意味」ではなく「狭小レイアウトという表示制約」に紐づく判断である
- NumberUnit は文字列を解析しない。`value` / `prefix?` / `unit?` の描画だけを担い、null 分岐・丸め・ラベル選択は呼び出し側の責務
- 適用外: 時刻表示、震度チップ（単位語がなくチップ自体が形式）、範囲値
- 将来の調整枠: FHD 実画面で「規模の M だけ見失う」失敗が観測された場合は、M 特例ではなく全 prefix 共通で 0.6em → 0.75em へ上げる（2026-07-23 対立的レビュー裁定）

### 3.3 Shape / Surface / Elevation / Spacing

面まわりの 4 スケールは M3E 概念の自前翻訳で、いずれも段階を刻んだ数列として持つ（`theme.css:174-203`）。

- **Shape（角丸）**: 7 段の radius（`--radius-xs`〜`--radius-full`、`theme.css:174-180`）。none（角丸なし＝0）はトークン化しない。待機カードは `l`（16px）、緊急ヒーローは `xl`（28px）を割り当て、形の大胆さで階層を付ける。
- **Surface（面の明度）**: 5 段の無彩色面（`--surface-lowest`〜`--surface-highest`、`theme.css:181-186`）。純黒からわずかに持ち上げた暗いグレー階層で、面の重なりを明度差だけで示す。無彩色なので CUD 色相の錨に抵触しない。
- **Elevation（奥行き）**: 3 段の box-shadow（`--elevation-1`〜`-3`、`theme.css:187-190`）。通常 LCD と判明したため OLED 焼付き制約を外し、ダーク向けの控えめな影を解禁した。
- **Spacing（余白）**: 4px グリッドの 12 段（`--space-1`〜`-12` = 4〜48px、`theme.css:191-203`）。余白を 4px の倍数に揃え、間隔のばらつきを無くす。

surface と elevation の適用は Phase B の作業で、トークン定義が先行している。

### 3.4 Motion

動きはばね物理（spring）から生成する（`theme.css:204-224` と `display/scripts/generate-springs.mjs`）。
ばね物理とは、実際のばねの伸び縮みを模した動きのモデルで、硬さ（stiffness）と減衰（damping）の 2 値で振る舞いが決まる。
`generate-springs.mjs` はこの 2 値から減衰振動の単位ステップ応答をサンプリングし、CSS の `linear()` イージング（動きの緩急を折れ線で近似する関数）を 25 点の点列として書き出す。
値は生成物なので手で書かず、`--write` で `theme.css` の該当マーカー間へ再生成する。

spring は spatial 3 種と effects 2 種の 5 つを用意する（`generate-springs.mjs:24-30` の `SPRING_SPECS`）。
使い分けの軸は overshoot（行き過ぎて戻る動き）の可否である。

- **spatial**（default / quick / slow、damping 0.8）: 位置・スケールの移動用。damping が 1 未満なので目標を少し行き過ぎてから戻る。動きに弾みを付けて生き生きと見せる。
- **effects**（default / slow、damping 1.0）: 色・不透明度の変化用。臨界減衰（damping = 1）で overshoot しない。色や透明度が行き過ぎると別の色に見えてしまうため、まっすぐ収束させる。

退場は不透明度だけを `--dur-exit`（200ms、`theme.css:223`）で処理する。
「消失感を出さない」ため、位置移動を伴わずその場でそっと消す設計である。
tier 昇格時の主役ウェイト bold→heavy の遷移は `--dur-weight-swell`（200ms、`theme.css:224`）が担い、太さだけを連続的に膨らませる（色・面は瞬時、§4）。

**二層 slot（dim と transition の所有権分離、2026-07-23 モーション修正）。**
待機画面の slot 4 系統（flood-slot / weather-corner / standby-corner / corner-item）は、外枠と内枠 `.slot-motion` の二層で組む。
外枠が dim 減光 CSS・absolute 配置・高さ計測（measureBorderHeight）・`animate:flip` を持ち、内枠が `in:spatialScaleIn|global` と local `out:fade` を持つ。
Svelte の intro は Web Animations として author rule より優先されるため、transition と dim opacity を同じ要素に持たせると dim 中の入場が一時的に明るくなる——所有者を分ければ両者は乗算で共存する。
intro の `|global` は画面切替時の入場演出のために維持し、**outro には `|global` を付けない**（付けると親子二重 fade + 画面切替が全 outro 完了まで遅れる。FloodWideCard の子セルも同じ理由で local intro）。

**単一要素の位置補間は手動 FLIP。**
`animate:` は keyed each の並べ替え専用で、同一 key のまま class・座標だけが変わる要素（洪水スロットの corner ⇔ clock-top-wide、時計スライド）には反応しない。
これらは `$effect.pre`（変更前 rect）+ `$effect`（変更後 rect）の手動 FLIP で補間する。
keyframe は `transform` ではなく独立 CSS `translate` プロパティを使う——既存の `transform: translateX(-50%)` 等と自動合成され、matrix 文字列合成のように base の変形で dx/dy が歪む事故がない（`StandbyScreen.svelte` の洪水 FLIP を参照実装とする）。
高速往復に備え「可視 rect 読取 → 旧アニメ cancel → final rect 読取」の順を守り（先に cancel すると開始点が飛ぶ）、`onfinish`/`oncancel` は animation identity を確認する。

**dim 明転/暗転の同期契約。**
待機画面の dim 切替は `--dur-standby-dim`（600ms、`theme.css`）を StandbyScreen `.standby` と TickerLane（本文・ラベル・レーン面）が共有する。値の変更は必ず両者同時。`prefers-reduced-motion` では両者とも即時。

## 4. Tier 機構

tier（severity tier、重大度の段）は、平常から緊急までの「今どれだけ重大か」を表す離散的な段位である。
これを 2 系統の別々な仕組みで表現し、役割を分ける。

**離散上書き（`main[data-tier]` 駆動）。**
`main` 要素の `data-tier` 属性（alert / critical など）に応じて、CSS が特定トークンを離散的に差し替える（`theme.css:257-268`）。
具体的には緊急パネル面を一段持ち上げ（`--surface-panel` を container→high、`--surface-panel-raised` を high→highest）、主役数字の太さ `--num-weight` を heavy へ上書きする。
これは「段が上がった瞬間の状態そのもの」の切り替えで、色・面は瞬時に切り替わる。
太さだけは消費側の hero 要素に `--dur-weight-swell` の transition を付け、bold→heavy をなだらかに昇らせる（wght スウェル）。

**opacity crossfade（TierOverlay）。**
一方 `TierOverlay.svelte` は、画面全体に敷いた 3 層（caution / alert / critical）の不透明度をクロスフェードで出し入れする（`TierOverlay.svelte:27-35`）。
各層は radial-gradient で「中心は透明、縁だけほんのり色づく」気配の面で、色は rgba 直値で持つ（例: critical は `rgba(160, 48, 160, ...)`）。
色面自体は静止させ、`opacity` の遷移だけ（`--spring-effects-slow`）で雰囲気を連続的に変える。
段が上がったときの「空気の変化」を担うのがこちらである。

つまり離散上書きが「値の瞬時切替（状態）」を、TierOverlay の crossfade が「雰囲気の連続遷移」を受け持つ。
両者を分けることで、情報（数値・面の段位）は即座に正しく切り替えつつ、演出（周縁の色づき）だけをなめらかに追従させられる。
`prefers-reduced-motion` 指定時は TierOverlay の transition を切り、情報は消さずに即時切替へ倒す（`TierOverlay.svelte:42-46`）。

## 5. コンポーネントカタログ

`display/frontend/src/components/` の 21 コンポーネントを役割・主要トークン依存・特記の順に挙げる。
緊急パネル系（EewPanel / QuakePanel / TsunamiPanel / WeatherEmergencyPanel / QuakeHeadline の panel variant）は `--panel-scale` 連動を持ち、待機画面系カードは持たない。

- **Clock**: 待機画面の大時計（時刻＋日付）と緊急画面の小時計の 2 バリアント。`--type-clock-hero`・`--clock-fg`・`--font-num` 依存。小時計の時刻はあえて `--fg`（`--clock-fg` の非減光トーンを避ける）。
- **ConnectionBadge**: SSE / dmdata 切断時のみ時計上に出す警告バッジ。`--role-connectionStale`・`--role-muted` 依存。意味色 1 つで全体を統一する role 依存の典型。
- **EewPanel**: 緊急地震速報（警報／予報）パネル。震源・推定最大震度・M・深さ・県別集約を表示。`--surface-panel`・`--header-eewWarning/Forecast-*`・`--num-weight`・`--panel-scale` に広く依存。region-list の区切りは可読性優先で `--role-muted` を使う。
- **EmergencyScreen**: 緊急パネル群のレイアウト・FLIP 補間・グリッド段組みを司るコンテナ。トークン依存は薄く構造中心。`--panel-scale: 1.5` を自ら注入する唯一の箇所。
- **InstrumentRow**: 待機画面下部の統計行（受信通数・本日の地震件数＋スパークライン）。`--role-muted`・`--num-weight`・`--fg-faint` 依存。SVG スパークラインは `fill="var(--role-muted)"` を属性で直接埋める。
- **LatestQuakeCard**: 待機画面左上の「最新の地震」カード（看板ヘッダ＋概要＋震度別グループ／ページング）。`--surface-standby`・`--header-quakeWarning/Critical-*`・`--int-*` 依存。震度 8/9 面の前景は `#000`/`#fff` 直値（トークン未整備箇所）。
- **PageDots**: 詳細ページャの現在地ドット＋クリックジャンプ（4 箇所で共有）。`--fg`・`--spring-effects-default` 依存。非強調を opacity ではなく `color-mix(--fg 35%, transparent)` で表す減光合成の代表例。
- **QuakeHeadline**: 「最大震度規模行＋拡大範囲行」の共有ヘッドライン（QuakePanel / LatestQuakeCard で共通化）。`variant="panel"|"card"` で寸法差を吸収。震度 8/9 面の前景を `--int-8-on`/`--int-9-on` でトークン化している唯一の箇所。
- **QuakePanel**: 緊急画面の地震情報パネル（EewPanel と対）。震源・最大震度・チップ・震度別リストを表示。トークン構成は EewPanel とほぼ同型で `--panel-scale` 連動が広範。震度 8/9 前景は `#000`/`#fff` 直値。
- **QuakeReplayCard**: 待機画面の地震履歴クリックで再表示する簡易版カード（ページング無し）。LatestQuakeCard と寸法・トークンをほぼ完全共有。フォーカスリングは `outline: 2px solid var(--role-muted)`。
- **RecentQuakes**: 待機画面の「直近の地震」一覧（最大 5 件、行クリックで Replay）。`--int-*`・`--role-muted`・`--num-weight` 依存。震度 8/9 前景は `#000`/`#fff` 直値。
- **RollingNumber**: 数値を桁ごとに転がして更新するアニメーション部品。トークン依存が低く（色・サイズは親から継承）、動きに専念する。
- **StandbyScreen**: 待機画面全体のレイアウト（時計中央・左上コーナー・右上・下段）。`--surface-standby`・`--space-*`・`--hairline` 依存。減光は例外的に opacity 方式で、`.standby.dim` 全体 0.35 に主要ブロック 0.7 を重ねる「寝室仕様」の全体沈降（他所の opacity 禁止規範とは用途が別）。**右上スタックの選抜は実高計測ベース**（2026-07-24、measurement shelf 方式）: 全候補カードを `.measure-shelf`（inert + aria-hidden + visibility:hidden、`.corner-right` の overflow:hidden の外）に隠し描画して共有 ResizeObserver で実測し、全候補が現在版（updatedAt）で計測済みになったら選抜入力を固定見積り→実測へ一括切替する。選抜集合は severity 降順 + 配列順 tie-break（描画順は常に配列順）。カード幅の真実源は `.standby` の `--standby-card-width`（本表示と棚で共有——棚の containing block 差による折返し高ズレを防ぐ）。二層 slot 規約に従い棚には motion を載せない。
- **Ticker**: 下部テロップ帯（2 レーン）のスケジューラ表示コンテナと緊急画面用の右端時計。`--surface-low`＋`--hairline` 上辺で「計器盤の最暗面の一段上」に敷く。
- **TickerLane**: テロップ 1 レーンの走行描画。dim 時は文字・チップを `color-mix(--tk-c 35%, --bg)` で面と同率に沈める合成規則を持つ（`TickerLane.svelte:527-539`）。大津波警報の走行文字だけ header 反転ペアで面付き強調する。
- **TierOverlay**: 画面全体の tier 気配レイヤ（§4）。radial-gradient を rgba 直値でグラデ発光させ、opacity crossfade で雰囲気を出す（`TierOverlay.svelte:27-35`）。
- **TsunamiPanel**: 緊急画面の津波パネル（予報区リスト／観測実況・種別別背景面）。`--header-tsunami*-*`・`--role-tsunami*` に依存し、背景トーンは `color-mix(role色 15%, --bg)` で合成する。CSS 変数名を JS で組み立て inline style へ注入する。
- **TsunamiStandbyBanner**: 待機画面左上の津波バナー（種別別マーキー巡回＋チップ再生）。`--surface-standby`・`--radius-full` 依存。dim は opacity 重ね掛け事故を避け `color-mix(chipBg 35%, --surface-standby)` へ切替。
- **UpdatedStamp**: カード見出し右端の「最終更新時刻」（気象警報／台風情報／火山情報／津波情報バナーで共有）。表記は常に月日込み（`formatMdHm`）— 数時間〜数日更新が空く種別があり、`HH:MM` だけだと古い電文が今日の更新に見えるため、桁数より曖昧さの排除を採る。色は `color: inherit` で見出し帯の on 色を継承し、独自トークンを持たない（コントラスト監査の対象ペアを増やさない）。
- **WeatherAlertCard**: 待機画面右上の気象警報／特別警報カード（最高ランクのみ表示）。`--header-weather*-*`・`--role-weather*` 依存。意味色は JS 注入でなく CSS クラスセレクタで完結する。
- **WeatherEmergencyPanel**: 緊急画面の気象警報パネル（警戒レベル 4・5 相当の主役化、Spec C）。**面（surface + 影）を持つのは詳細一覧（「どこ」）だけ**で、「何が」はパネル地の上のヒーロー（`警戒レベル N` + 一段小さい `相当`）、「どうする」は `--role-weather*` の縦レール（`border-inline-start`）を持つ行動レール、副セクションは `--hairline` の区切り線のみ。**compact スロットだけ**はレベルと行動文を `警戒レベル N 相当 — <行動文>` の 1 行に束ねて縦を節約する（ゆとりのある主役スロットでは分離したまま）——同格タイルを 4 枚並べると重要度が横並びになり、EEW / 津波 / 地震の「主役＋計器＋リスト」構成に対して平板に見えるため（実機目視 2026-07-26）。詳細行は「区分 ｜ 地域」の 2 列グリッドで、地域側に `--hairline` の縦罫を引く（**遠見・夜間減光では font-weight 差が最初に消える**ので、太さだけの分離は成立しない）。警報名はパネル内でのみ `L5 ` 接頭辞を落として揃える（レベルは見出しの「警戒レベル N 相当」が担う。`formatLevelLabel` 自体は変更せず、待機カード・テロップ・CLI は接頭辞つきのまま）。1 行に並べる地域名の件数は領域の実測幅と文字サイズから算出する（固定件数だと、ゆとりがあるのに省略／狭いのに詰め込む、の両方が起きる）。「何が（警戒レベル N 相当＋警報名）／どこ（種別ごとの地域＋ほか N 地域）／どうする（固定の行動文＋補助行）」の 3 固定領域で、L5 昇格中に併存する L4 相当は同パネル内の副セクションへ回す。色 role は `--header-weather{Emergency,Warning}-*`・`--role-weather*` を **WeatherAlertCard と共有**し、新規トークンを持たない（ただし監査ペアは増える——実際に消費する面との組合せを §8b に追加した）。**critical tier（L5 発表中・大津波警報併発など）では主要な文字を `--fg` へ退避する**：`TierOverlay` の全画面フィルム（最大 α=0.34）が文字にも背景にも掛かり、合成後は意味色が AA を割るため（weatherEmergency 3.21〜3.66:1 / weatherWarning 3.90〜4.44:1、`--fg` なら 6.85〜7.81:1）。意味色は看板ヘッダ帯と行動レール（非テキスト、閾値 3:1）に残す。この「使わない組合せ」も監査表に載せ、退避を外したら FAIL として気づけるようにしてある。source（vpws50 / vpww56）間で同種別を統合せず地域数も合算しない点だけが待機カードと異なる契約（跨 source 統合は待機カード側の従来どおり）。「どこ」領域は QuakePanel / TsunamiPanel と同じ `createPageCycler` + `PageDots` の自動ページ送りで、領域高と代表行を実測して 1 ページの行数を決める（実測不能時は fallback 行数）。**画面に収まらない情報を黙って切らない**ことを設計の錨とし、上限で落ちた情報は必ず件数で可視化する（1 行の地域名は engine 縮退ぶんと合算して「ほか N 地域」、副セクションに載らない種別と「何が」の警報名は「ほか N 種別」）。ページ送りを持たない固定領域（「何が」「どうする」「副セクション」）は内容駆動で伸ばさず有界にする。ただし**区分一覧（警報名）は上限を掛けず、折り返して全種別を載せる**——上限 + 「ほか N 種別」で畳むと、狭い枠で**最上級レベルに何が出ているかが件数へ丸められ**、最優先の情報を最初に削ることになる（実機目視 2026-07-26）。表示の優先順位は **レベル + 行動文 ＞ 区分一覧 ＞ 地域** で、ヒーローは `flex: 0 0 auto` で縮まず、高さが足りないときは**ページ送りを持つ地域カード側が縮む**（ページ送りの待ちを地域だけに閉じ込め、「何が起きていて何をするか」は常に一目で読める）。補助行「自治体が発令する避難指示とは別の防災気象情報です」は行動レール内に置き、主役スロットのみに出す（compact では主情報へ高さを回す）。**副セクション（L5 昇格中の L4 相当）は幅によらず地域名を持たない種別の要約**にする（件数の上限は高さの上限にならないため——地域行は折返しで高さが青天井になり、ページ送りのない領域では溢れが黙って切られる。L4 の地域が要る場面は主レベルの「どこ」が担う）。省略の告知は**行末の件数だけ**に一本化する（領域下端の固定文「表示は一部です」は主語が無く「ページの一部」と誤読されたため廃止。実機目視 2026-07-26）。ページャは詳細一覧の見出し行（`対象地域・区分` と同じ行）に置き、省略の告知とは場所を分ける。副セクションの上限は distinct な種別数で数える（source 違いの同一種別を 2 種別と数えない）。

## 6. アクセシビリティ

本ディスプレイは遠見の情報端末なので、文字と背景のコントラスト（明るさの差）を機械的に監査する。
監査の実体は §8b の生成表で、各トークンペアの実測コントラスト比と判定を並べる。

**採用基準。**
WCAG 2.1 レベル AA 相当を採る。
通常テキストは 4.5:1 以上、非テキストの UI 要素（帯・境界など）は 3:1 以上を閾値とする。
コントラスト比とは前景色と背景色の相対輝度（後述）から算出する比で、白黒が 21:1、数字が小さいほど文字が背景に埋もれる。

**全テキストペアを 4.5:1 で判定する保守側の方針。**
WCAG には「大きい文字は 3:1 に緩めてよい」という規定があるが、初版ではこの緩和を使わず、テキストは一律 4.5:1 で判定する。
理由は §3.2 の型スケールにある。
fluid clamp や container query で、同一トークンが画面幅次第で小さい文字にもなり得る。
どのトークンがどの画面幅で「大きい文字」なのかを font-size 根拠としてペアに持たせるまでは、緩和の前提が保証できない。
そこで安全側に倒し、すべてを通常テキスト基準で見る。

**JIS X 8341-3:2016 レベル AA との対応。**
この JIS はウェブコンテンツのアクセシビリティ規格で、レベル AA は WCAG 2.0 相当の達成基準に対応する。
コントラストに関する達成基準（1.4.3）はここで採る 4.5:1 / 3:1 と一致する。
本ディスプレイはウェブサイトではないが、コントラストの規範だけをこの基準に合わせる。

**出典。**
アクセシビリティの考え方は「デジタル庁デザインシステム（DADS）β版 Markdown版」の webaccessibility 方針から借りた。
同方針は「2025年12月10日更新」版で、JIS X 8341-3:2016 レベル AA に準拠し、WCAG 2.1 / 2.2 の A・AA 達成基準を順次追加中である。
公式情報は DADS サイト（`https://design.digital.go.jp/dads/`）、アクセシビリティ方針は同 `https://design.digital.go.jp/dads/webaccessibility/` にある。

**監査の適用範囲。**
§8b は静的なトークンペアと、列挙済みの合成状態（dim 減光・tier overlay 合成・津波ページの二段 mix・opacity 経路）のコントラストを機械監査するものである。
画面全体としての AA 適合を宣言するものではない。
特に、radial-gradient の位置依存 alpha（TierOverlay の縁ぼかし）・blur・画像の重なりは、位置によって実効コントラストが変わるため静的監査の適用外とする。
これらは実機の目視検証で担保する。

**FAIL 許容リストの読み方。**
§8b には閾値未満の FAIL 行が含まれる（例: `--fg-faint` の base、dim チップ各種、dim×high lane 各種）。
FAIL の一部は「許容」として明示的に受け入れているが、許容は免罪符ではなく「非適合をあえて明示した記録」である。
沈んでいてよい要素（接続正常ドットなど）や、減光時に意図的に沈める dim 面がこれに当たる。
許容は生成器への入力（トークン値・ペア定義）の hash に紐づいており、入力が変われば許容は STALE として失効し、判断のやり直しを迫る。
つまり「一度許容したら永久に無視」ではなく、根拠が変わるたびに再点検が走る。

**非色チェックリスト（A11y ラウンド、2026-07-18）。**
色以外のアクセシビリティ規範を、実装確認・レビュー時のチェックリストとしてここにまとめる。
典拠は A11y ラウンド設計（`設計メモ 2026-07-18-display-a11y-round-design.md` の裁定 D1〜D5・§8）とその実装であり、根拠の詳細は同文書を見る。

- [ ] **視聴環境の錨**: 24 インチ FHD（1920×1080）・視聴距離 1.0〜1.5m を前提に本節の数値を導いている。設置環境（画面サイズ・距離）が変わったら、この錨から数値を再導出すること。
- [ ] **二層文字サイズ**: 層 1（安全情報・常設情報）は 14px 以上、層 2（低プロミネンス補足）は 12px 以上。11px のトークン・fluid 下限は廃止済み。14px は暫定下限であり、視角 16 分（この視聴距離では約 21px）に満たない帯（12〜20px）が残る既知の限界を正直に記録する。「規範を満たす＝理想」ではなく「規範を満たす＝この端末で許容する下限」である。実機での距離別可読性検証（津波バナー地域名を代表に 14px と 21px 級を目視比較）は**未実施の残タスク**として明記する。
- [ ] **行間**: グローバル `line-height: 1.3`（`theme.css:243`）はデータ密度優先の kiosk 例外（緊急パネル収容制約）で、DADS の 150% 基準（段落文章向け）はここには適用しない。折り返して読ませる文章ブロック（散文）には `.prose`（行間 1.5、`theme.css:261-263`）を付けること。列挙式の適用対象リストではなく、この反転チェックリスト（付け忘れをレビューで検出する運用）で管理する。
- [ ] **動くテロップ・自動ページ送り**: 停止手段を持たない放送型 kiosk の挙動は「本製品独自の例外判断であり、停止手段がない既知の差分」であり、WCAG 適合を意味しない（将来の静止モードが成立しうる以上「停止が本質的に不可能」とは言えない）。`prefers-reduced-motion` は「動きの軽減」（アニメーションを 0ms 化する）に限られ、ページ送り（10 秒）とテロップの自動切替は reduced-motion でも継続する。ここを「停止手段」とは呼ばない。静止モードは将来タスクとし、受入条件を明記しておく：(1) サーバ／REPL から静止モードを指示できる (2) 静止中はテロップ・自動ページ送りが自動では進まない (3) 現在の表示内容は失われず手動送りができる (4) 解除で通常動作へ復帰する。
- [ ] **dim 操作系**: クリックは「対話要素発のクリックを無視する」ガード反転方式（契約は `lib/dim-interaction.ts` の `shouldToggleDimOnClick`）を採り、対話要素発の誤爆を構造的に防ぐ。既存コンポーネント側の `stopPropagation` は二重防御として残す。D キーでもトグルできる（`shouldToggleDimOnKey`）。長押し反復（`repeat`）・修飾キー併押・編集可能要素へのフォーカス中は無視する。画面に常設 UI を置かない設計のため、操作の発見可能性は `docs/display-setup.md` の記載で担保する。
- [ ] **night-dim 二重防御**: 「災害情報端末として、夜でも警報は光る」を原則とする。基底ガードは警報級 role の可読性フロアで、dim による混色を除外する（判定表の真実源は `lib/alert-roles.ts` の `isAlertRole`、監査番兵は §8b の cat9／cat11／cat14）。強調層は警報級掲載中の自動サスペンドで、`requestedDim`（手動意思）と `effectiveDim`（実効値）を分離し、判定不能・未知の重大度は明るい側へ倒す（fail-bright、`computeEffectiveDim`）。
- [ ] **ターゲットサイズ**: 対話要素の当たり判定は 24×24px 以上。PageDots は当初「透明 24×24px ボタン＋擬似要素でドットを描く」方式で適合させたが、26 ページ相当の多ページ時に 624px → 2 行折返しでメイン表示を圧迫する実害が preview で見つかり (再裁定 2026-07-18)、ドット自身を見えるサイズ (6px/current 8px) で直描きする旧来構造に撤回した。ヒット領域は縦 24px + 横は間隔上限 (約10px) の拡張に留め、24×24px には満たない既知の限界として記録する。津波バナーの count-chip は `min-height: 24px` で適合させる (この項は不変)。
- [ ] **見出し階層**: 視覚非表示の `<h1>`（`App.svelte` の `.visually-hidden`）を起点にレベルを飛ばさない。
- [ ] **DADS 出典の区別**: 「正式準拠」（JIS X 8341-3:2016 = WCAG 2.0 レベル AA 相当。§6 のコントラスト基準はここに属する）と「先取り推奨」（2.5.8 など、WCAG 2.1／2.2 系で DADS が順次追加中の達成基準。ターゲットサイズはここに属する）を混同せず書き分ける。

## 7. 用語集

プロジェクトオーナー向けに、本書の用語を身近なたとえ付きで説明する。

- **トークン**: 色やサイズの値に付けた名前。値そのものを一箇所（`theme.css`）に集めた「設定の辞書」で、各画面はページ番号ではなく見出し語で値を引く。辞書を 1 行直せば全ページの見た目が変わる。
- **tier（重大度の段）**: 平常・注意・警戒・危機のような「今どれだけ重大か」の段位。信号機の青・黄・赤を、地震や津波の段階へ細かくしたもの。
- **elevation（奥行き）**: 影の付け方で「その面がどれだけ手前に浮いているか」を示す表現。紙を机に重ねると下の紙に影が落ちるのと同じで、影が濃いほど手前に感じる。
- **CUD（色覚多様性対応）**: Color Universal Design。色の見え方が多数派と違う人にも区別しやすいよう選ばれた配色。多くの人が同じ色を「別の色」として読み分けられるように整えたパレット。
- **コントラスト比**: 文字と背景の明るさの差の比。白と黒が 21:1 で最大、数字が小さいほど文字が背景に埋もれて読めなくなる。本書は通常文字で 4.5:1 以上を合格とする。
- **相対輝度**: 色を「人の目に感じる明るさ」に換算した値（0〜1）。赤・緑・青の成分に人の感度の重み（緑が最も明るく感じる）を掛けて求める。コントラスト比はこの明るさどうしの比で決まる。
- **color-mix**: CSS で 2 色を指定割合で混ぜる関数。絵の具を混ぜるのと同じで、`color-mix(in srgb, 前景 35%, 背景)` は前景を 35%・背景を 65% で混ぜた中間色になる。本書では減光（dim）や津波ページの背景トーン合成に使う。
- **可変フォント**: 1 つのフォントファイルの中に細い〜太いを連続で持つフォント。太さごとに別ファイルを積むかわりに、1 冊で全太さをまかなう辞書のようなもの。ファイルが軽くなり、太さの中間も自由に選べる。

## 8. 付録（GENERATED）

このセクションの表はスクリプト生成物であり手編集しない（`npm run docs:design` で再生成）。

### 8a. デザイントークン一覧

<details>
<summary>トークン一覧（クリックで展開）</summary>

<!-- GENERATED:tokens:start (display/scripts/generate-design-docs.mjs --write) -->
#### (未分類)

| トークン | 定義 | 実値 | 説明 |
| --- | --- | --- | --- |
| `--bg` | `#000000` | `#000000` |  |
| `--fg` | `#f2f4f6` | `#f2f4f6` |  |
| `--fg-faint` | `#566069` | `#566069` | 空状態・接続正常ドットなど「沈んでいてよい」もの |
| `--clock-fg` | `#eef2f6` | `#eef2f6` | 待機画面の大時計。通常 LCD 判明で OLED 焼付き制約を撤廃し白寄りへ (遠目コントラスト改善) |

#### CUD 9 色

| トークン | 定義 | 実値 | 説明 |
| --- | --- | --- | --- |
| `--c-gray` | `#84919e` | `#84919e` |  |
| `--c-gray-lift` | `#b4c2cf` | `#b4c2cf` | gray の黒背景テキスト用リフト (面には使わない)。overlay 合成でのコントラスト救済用に明度を上げた明色 (spec §6) |
| `--c-sky` | `#56b4e9` | `#56b4e9` |  |
| `--c-blue` | `#0072b2` | `#0072b2` |  |
| `--c-blue-lift` | `#3193db` | `#3193db` | blue の黒背景テキスト用リフト (面には使わない) |
| `--c-blue-green` | `#009e73` | `#009e73` |  |
| `--c-yellow` | `#f0e442` | `#f0e442` |  |
| `--c-orange` | `#e69f00` | `#e69f00` |  |
| `--c-orange-lift` | `#ff8c00` | `#ff8c00` | orange の黒背景テキスト用リフト (面には使わない)。実機パネルで #e69f00 が注意報の黄色と区別しづらいため、テキスト role はこちらを使う |
| `--c-vermillion` | `#d55e00` | `#d55e00` |  |
| `--c-vermillion-lift` | `#e56910` | `#e56910` | vermillion の黒背景テキスト用リフト (面には使わない)。int-7 の surface-highest 上コントラスト救済用に明度を上げた明色 (spec §6) |
| `--c-raspberry` | `#cc79a7` | `#cc79a7` |  |
| `--c-dark-red` | `#7a1e00` | `#7a1e00` | 面 (bg) 専用。黒背景の文字色には使わない |

#### JMA 標準 (津波)

| トークン | 定義 | 実値 | 説明 |
| --- | --- | --- | --- |
| `--c-tsunami-purple` | `#c46bde` | `#c46bde` | テキスト用 |
| `--c-tsunami-purple-bar` | `#b23ab2` | `#b23ab2` | 色面用。旧 #a030a0 (CLI weatherBannerOfficialL5 と同値) からマゼンタ色相 (300°) を維持したまま明度を上げた明色 (spec §6 int-7/紫バー/muted 明度修正) |
| `--c-jma-red` | `#ff453a` | `#ff453a` | テキスト用リフト |
| `--c-jma-red-bar` | `#e60012` | `#e60012` | 色面用 |

#### DisplayColorRole → 色

| トークン | 定義 | 実値 | 説明 |
| --- | --- | --- | --- |
| `--role-critical` | `var(--c-vermillion)` | `#d55e00` |  |
| `--role-warning` | `var(--c-orange)` | `#e69f00` |  |
| `--role-normal` | `var(--fg)` | `#f2f4f6` |  |
| `--role-info` | `var(--c-gray)` | `#84919e` |  |
| `--role-cancel` | `var(--c-raspberry)` | `#cc79a7` |  |
| `--role-eewWarning` | `var(--c-vermillion)` | `#d55e00` |  |
| `--role-eewForecast` | `var(--c-orange)` | `#e69f00` |  |
| `--role-tsunamiMajor` | `var(--c-tsunami-purple)` | `#c46bde` |  |
| `--role-tsunamiWarning` | `var(--c-jma-red)` | `#ff453a` |  |
| `--role-tsunamiAdvisory` | `var(--c-yellow)` | `#f0e442` |  |
| `--role-quakeMajor` | `var(--c-vermillion)` | `#d55e00` |  |
| `--role-weatherEmergency` | `var(--c-tsunami-purple)` | `#c46bde` |  |
| `--role-weatherWarning` | `var(--c-orange-lift)` | `#ff8c00` |  |
| `--role-weatherAdvisory` | `var(--c-yellow)` | `#f0e442` |  |
| `--role-connectionOk` | `var(--fg-faint)` | `#566069` |  |
| `--role-connectionStale` | `var(--c-orange)` | `#e69f00` |  |
| `--role-muted` | `var(--c-gray-lift)` | `#b4c2cf` | --c-gray (#84919e) の無彩色相を維持し明度のみ上げた --c-gray-lift。overlay 合成でのコントラスト救済 (spec §6)。--c-gray / --fg-faint 自体は他消費者のため変更しない |
| `--int-1` | `var(--c-gray)` | `#84919e` |  |
| `--int-2` | `var(--c-sky)` | `#56b4e9` |  |
| `--int-3` | `var(--c-blue-lift)` | `#3193db` |  |
| `--int-4` | `var(--c-blue-green)` | `#009e73` |  |
| `--int-5` | `var(--c-yellow)` | `#f0e442` |  |
| `--int-6` | `var(--c-orange)` | `#e69f00` |  |
| `--int-7` | `var(--c-vermillion-lift)` | `#e56910` | CUD 朱 --c-vermillion (#d55e00, hue 26°) の色相を維持し明度のみ上げた --c-vermillion-lift (surface-highest 上のコントラスト救済、spec §6) |
| `--int-8-bg` | `var(--c-vermillion)` | `#d55e00` | 6強: 面+黒文字 |
| `--int-9-bg` | `var(--c-dark-red)` | `#7a1e00` | 7: 面+白文字 |
| `--int-8-on` | `#000` | `#000` | int-8-bg (vermillion) 面上の文字色 |
| `--int-9-on` | `#fff` | `#fff` | int-9-bg (dark-red) 面上の文字色 |

#### ヘッダ標準 (M3E): 意味色 container 面 + 明るい on-container 文字 + 下端 CUD 色帯

| トークン | 定義 | 実値 | 説明 |
| --- | --- | --- | --- |
| `--c-jma-purple-bar` | `var(--c-tsunami-purple-bar)` | `#b23ab2` | JMA 特別警報級の法定紫 (面用)。津波大津波警報と気象特別警報で共有 |
| `--header-band-width` | `calc(4px * var(--panel-scale, 1))` | `calc(4px * 1)` | panel-scale 連動。emergency (scale 1.5) → 6px / 待機カード (scale 1) → 4px。同一画面内では均一、パネル拡縮には追従 |
| `--header-eewWarning-container` | `#3a1206` | `#3a1206` |  |
| `--header-eewWarning-on` | `#ffb392` | `#ffb392` |  |
| `--header-band-eewWarning` | `var(--c-vermillion)` | `#d55e00` |  |
| `--header-eewForecast-container` | `#3a2600` | `#3a2600` |  |
| `--header-eewForecast-on` | `#ffd68a` | `#ffd68a` |  |
| `--header-band-eewForecast` | `var(--c-orange)` | `#e69f00` |  |
| `--header-quakeCritical-container` | `#3a1206` | `#3a1206` |  |
| `--header-quakeCritical-on` | `#ffb392` | `#ffb392` |  |
| `--header-band-quakeCritical` | `var(--c-vermillion)` | `#d55e00` |  |
| `--header-quakeWarning-container` | `#3a2600` | `#3a2600` |  |
| `--header-quakeWarning-on` | `#ffd68a` | `#ffd68a` |  |
| `--header-band-quakeWarning` | `var(--c-orange)` | `#e69f00` |  |
| `--header-tsunamiMajor-container` | `#301238` | `#301238` |  |
| `--header-tsunamiMajor-on` | `#eabdf0` | `#eabdf0` |  |
| `--header-band-tsunamiMajor` | `var(--c-jma-purple-bar)` | `#b23ab2` |  |
| `--header-tsunamiWarning-container` | `#3a0a08` | `#3a0a08` |  |
| `--header-tsunamiWarning-on` | `#ffb0a8` | `#ffb0a8` |  |
| `--header-band-tsunamiWarning` | `var(--c-jma-red-bar)` | `#e60012` |  |
| `--header-tsunamiAdvisory-container` | `#2e2c05` | `#2e2c05` |  |
| `--header-tsunamiAdvisory-on` | `#f2ea94` | `#f2ea94` |  |
| `--header-band-tsunamiAdvisory` | `var(--c-yellow)` | `#f0e442` |  |
| `--header-weatherEmergency-container` | `#301238` | `#301238` |  |
| `--header-weatherEmergency-on` | `#eabdf0` | `#eabdf0` |  |
| `--header-band-weatherEmergency` | `var(--c-jma-purple-bar)` | `#b23ab2` |  |
| `--header-weatherWarning-container` | `#3a2600` | `#3a2600` |  |
| `--header-weatherWarning-on` | `#ffd68a` | `#ffd68a` |  |
| `--header-band-weatherWarning` | `var(--c-orange)` | `#e69f00` |  |
| `--header-weatherAdvisory-container` | `#2e2c05` | `#2e2c05` |  |
| `--header-weatherAdvisory-on` | `#f2ea94` | `#f2ea94` |  |
| `--header-band-weatherAdvisory` | `var(--c-yellow)` | `#f0e442` |  |

#### タイポ

| トークン | 定義 | 実値 | 説明 |
| --- | --- | --- | --- |
| `--font-ui` | `"JetBrains Mono Var", "Noto Sans JP Var", "UDEV Gothic HSJPDOC", "UDEVGothic HSJPDOC", "Noto Sans JP", "Hiragino Sans", "Yu Gothic UI", "Meiryo", system-ui, sans-serif` | `"JetBrains Mono Var", "Noto Sans JP Var", "UDEV Gothic HSJPDOC", "UDEVGothic HSJPDOC", "Noto Sans JP", "Hiragino Sans", "Yu Gothic UI", "Meiryo", system-ui, sans-serif` |  |
| `--font-num` | `var(--font-ui)` | `"JetBrains Mono Var", "Noto Sans JP Var", "UDEV Gothic HSJPDOC", "UDEVGothic HSJPDOC", "Noto Sans JP", "Hiragino Sans", "Yu Gothic UI", "Meiryo", system-ui, sans-serif` |  |

#### ウェイト scale (可変フォント wght 軸)

| トークン | 定義 | 実値 | 説明 |
| --- | --- | --- | --- |
| `--type-weight-regular` | `400` | `400` |  |
| `--type-weight-medium` | `500` | `500` |  |
| `--type-weight-semibold` | `600` | `600` |  |
| `--type-weight-bold` | `700` | `700` |  |
| `--type-weight-heavy` | `800` | `800` | tier 連動の主役数字強調用 |

#### role 別ウェイト (baseline / emphasized)

| トークン | 定義 | 実値 | 説明 |
| --- | --- | --- | --- |
| `--type-display-weight` | `var(--type-weight-regular)` | `400` |  |
| `--type-display-weight-emphasized` | `var(--type-weight-bold)` | `700` |  |
| `--type-headline-weight` | `var(--type-weight-medium)` | `500` |  |
| `--type-headline-weight-emphasized` | `var(--type-weight-bold)` | `700` |  |
| `--type-title-weight` | `var(--type-weight-medium)` | `500` |  |
| `--type-title-weight-emphasized` | `var(--type-weight-bold)` | `700` |  |
| `--type-body-weight` | `var(--type-weight-medium)` | `500` |  |
| `--type-body-weight-emphasized` | `var(--type-weight-semibold)` | `600` |  |
| `--type-label-weight` | `var(--type-weight-regular)` | `400` |  |
| `--type-label-weight-emphasized` | `var(--type-weight-semibold)` | `600` |  |
| `--num-weight` | `var(--type-weight-bold)` | `700` | tier 連動の主役数字ウェイト。tier overlay (T8) が alert/critical で --type-weight-heavy に離散上書き |

#### 型スケール: 固定 px (パネル。使用側で * var(--panel-scale,1))

| トークン | 定義 | 実値 | 説明 |
| --- | --- | --- | --- |
| `--type-display-l-size` | `56px` | `56px` | EewPanel hypocenter |
| `--type-display-m-size` | `44px` | `44px` | compact hypocenter |
| `--type-display-s-size` | `34px` | `34px` | Clock small time |
| `--type-headline-l-size` | `40px` | `40px` | TsunamiPanel level-label / EewPanel stat-value |
| `--type-headline-m-size` | `32px` | `32px` | EewPanel/QuakePanel heading, max-int |
| `--type-headline-s-size` | `28px` | `28px` | ticker/loading/compact stat-value/compact max-int |
| `--type-title-l-size` | `26px` | `26px` | QuakePanel group |
| `--type-title-m-size` | `24px` | `24px` | chip-row, coast-row |
| `--type-title-s-size` | `20px` | `20px` | warning-comment, observation-row |
| `--type-body-l-size` | `19px` | `19px` | RecentQuakes 行 (fluid ceil と一致) |
| `--type-body-m-size` | `18px` | `18px` | assumed-chip |
| `--type-body-s-size` | `16px` | `16px` | coast-kind, obs-heading, badge dot |
| `--type-label-l-size` | `15px` | `15px` | ─ |
| `--type-label-m-size` | `14px` | `14px` | stat-label |
| `--type-label-s-size` | `13px` | `13px` | Clock small date |
| `--type-label-xs-size` | `12px` | `12px` | compact stat-label ほか (spec D1: 11px 廃止、層2下限) |
| `--type-clock-hero` | `min(11vw, 20vh)` | `min(11vw, 20vh)` | Clock 大時計 (visual gate: 圧迫感解消で一回り縮小) |
| `--type-headline-m-cq` | `clamp(20px, 2.4cqw, 32px)` | `clamp(20px, 2.4cqw, 32px)` | QuakePanel heading (container 追従) |

#### 型スケール: fluid clamp (待機画面)

| トークン | 定義 | 実値 | 説明 |
| --- | --- | --- | --- |
| `--type-headline-s-fluid` | `clamp(16px, 2.2vw, 28px)` | `clamp(16px, 2.2vw, 28px)` | Ticker, Clock date |
| `--type-title-s-fluid` | `clamp(14px, 1.7vw, 20px)` | `clamp(14px, 1.7vw, 20px)` | TsunamiBanner header, ConnectionBadge title |
| `--type-body-l-fluid` | `clamp(12px, 1.6vw, 19px)` | `clamp(12px, 1.6vw, 19px)` | RecentQuakes 行 |
| `--type-body-s-fluid` | `clamp(12px, 1.1vw, 14px)` | `clamp(12px, 1.1vw, 14px)` | ConnectionBadge caption (spec D1: 11px 廃止、層2下限) |
| `--type-label-l-fluid` | `clamp(12px, 1.3vw, 15px)` | `clamp(12px, 1.3vw, 15px)` | RecentQuakes h2, TsunamiBanner counts (spec D1: 11px 廃止、層2下限) |
| `--type-label-s-fluid` | `clamp(12px, 1.2vw, 14px)` | `clamp(12px, 1.2vw, 14px)` | TsunamiBanner areas (spec D1: 11px 廃止、層2下限) |
| `--panel-header-font-size` | `32px` | `32px` |  |
| `--panel-header-padding-v` | `14px` | `14px` |  |
| `--panel-header-padding-h` | `28px` | `28px` |  |
| `--panel-header-min-h` | `64px` | `64px` |  |

#### Expressive Instrument (M3E 翻訳)

| トークン | 定義 | 実値 | 説明 |
| --- | --- | --- | --- |
| `--radius-standby` | `var(--radius-l)` | `16px` | 待機カード = l (16) |
| `--radius-panel` | `var(--radius-xl)` | `28px` | 緊急ヒーロー = xl (28、contrasting shapes で 24→28 に一段大胆化) |
| `--surface-standby` | `var(--surface-low)` | `#070a0c` | 待機カード面 |
| `--surface-panel` | `var(--surface-container)` | `#0b0f12` | 緊急パネル面 |
| `--surface-panel-raised` | `var(--surface-high)` | `#10161a` | パネル内タイル面 |
| `--hairline` | `#1a2126` | `#1a2126` | 面分離用の薄い境界線色。焼付き最小、containment を遠目に効かせる |
| `--ticker-label-pad` | `0.9em` | `0.9em` | テロップ種別ラベル枠の右パディング (instrument surface 化) |
| `--ticker-label-bg` | `var(--surface-high)` | `#10161a` |  |
| `--ticker-label-radius` | `var(--radius-full)` | `999px` |  |
| `--ticker-label-margin` | `0.7em` | `0.7em` |  |
| `--ticker-label-shadow` | `var(--elevation-1)` | `0 1px 2px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.025)` |  |

#### M3E shape scale (7 段。適用は Phase B。none は角丸なし=0 のため未トークン化)

| トークン | 定義 | 実値 | 説明 |
| --- | --- | --- | --- |
| `--radius-xs` | `4px` | `4px` |  |
| `--radius-s` | `8px` | `8px` |  |
| `--radius-m` | `12px` | `12px` |  |
| `--radius-l` | `16px` | `16px` |  |
| `--radius-xl` | `28px` | `28px` |  |
| `--radius-full` | `999px` | `999px` |  |

#### M3E surface container 階層 (5 段。無彩色明度、CUD 色相の錨に抵触しない。適用は Phase B)

| トークン | 定義 | 実値 | 説明 |
| --- | --- | --- | --- |
| `--surface-lowest` | `#030405` | `#030405` |  |
| `--surface-low` | `#070a0c` | `#070a0c` |  |
| `--surface-container` | `#0b0f12` | `#0b0f12` |  |
| `--surface-high` | `#10161a` | `#10161a` |  |
| `--surface-highest` | `#171f25` | `#171f25` |  |

#### M3E tonal elevation (LCD 前提で解禁。ダーク向け控えめ box-shadow。適用は Phase B)

| トークン | 定義 | 実値 | 説明 |
| --- | --- | --- | --- |
| `--elevation-1` | `0 1px 2px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.025)` | `0 1px 2px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.025)` |  |
| `--elevation-2` | `0 3px 8px rgba(0, 0, 0, 0.6), 0 1px 2px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.03)` | `0 3px 8px rgba(0, 0, 0, 0.6), 0 1px 2px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.03)` |  |
| `--elevation-3` | `0 10px 24px rgba(0, 0, 0, 0.66), 0 3px 8px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.04)` | `0 10px 24px rgba(0, 0, 0, 0.66), 0 3px 8px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.04)` |  |

#### spacing scale (4px グリッド。適用は Phase B)

| トークン | 定義 | 実値 | 説明 |
| --- | --- | --- | --- |
| `--space-1` | `4px` | `4px` |  |
| `--space-2` | `8px` | `8px` |  |
| `--space-3` | `12px` | `12px` |  |
| `--space-4` | `16px` | `16px` |  |
| `--space-5` | `20px` | `20px` |  |
| `--space-6` | `24px` | `24px` |  |
| `--space-7` | `28px` | `28px` |  |
| `--space-8` | `32px` | `32px` |  |
| `--space-9` | `36px` | `36px` |  |
| `--space-10` | `40px` | `40px` |  |
| `--space-11` | `44px` | `44px` |  |
| `--space-12` | `48px` | `48px` |  |

#### M3E spring easing (display/scripts/generate-springs.mjs 生成、再生成可)

| トークン | 定義 | 実値 | 説明 |
| --- | --- | --- | --- |
| `--spring-spatial-default` | `linear(0, 0.0516, 0.1705, 0.3163, 0.4636, 0.598, 0.7123, 0.8044, 0.8751, 0.9271, 0.9636, 0.9877, 1.0026, 1.0108, 1.0144, 1.0151, 1.0141, 1.0122, 1.01, 1.0077, 1.0058, 1.0041, 1.0027, 1.0017, 1.001)` | `linear() 25 点` | spring-spatial-default: stiffness=380 damping=0.8 wn=19.49 settle=~435ms |
| `--spring-spatial-default-dur` | `435ms` | `435ms` |  |
| `--spring-spatial-quick` | `linear(0, 0.0517, 0.1708, 0.3168, 0.4643, 0.5988, 0.713, 0.805, 0.8757, 0.9276, 0.9639, 0.9879, 1.0027, 1.0109, 1.0145, 1.0151, 1.0141, 1.0122, 1.0099, 1.0077, 1.0057, 1.004, 1.0027, 1.0017, 1.001)` | `linear() 25 点` | spring-spatial-quick: stiffness=3600 damping=0.8 wn=60.00 settle=~142ms |
| `--spring-spatial-quick-dur` | `142ms` | `142ms` |  |
| `--spring-spatial-slow` | `linear(0, 0.0516, 0.1704, 0.3162, 0.4635, 0.5979, 0.7122, 0.8043, 0.875, 0.9271, 0.9635, 0.9877, 1.0025, 1.0108, 1.0144, 1.0151, 1.0141, 1.0122, 1.01, 1.0078, 1.0058, 1.0041, 1.0028, 1.0017, 1.001)` | `linear() 25 点` | spring-spatial-slow: stiffness=200 damping=0.8 wn=14.14 settle=~599ms |
| `--spring-spatial-slow-dur` | `599ms` | `599ms` |  |
| `--spring-effects-default` | `linear(0, 0.0576, 0.1805, 0.3211, 0.4555, 0.5733, 0.6714, 0.7504, 0.8125, 0.8604, 0.8968, 0.9242, 0.9446, 0.9597, 0.9708, 0.979, 0.9849, 0.9892, 0.9922, 0.9945, 0.9961, 0.9972, 0.998, 0.9986, 0.999)` | `linear() 25 点` | spring-effects-default: stiffness=1600 damping=1 wn=40.00 settle=~231ms |
| `--spring-effects-default-dur` | `231ms` | `231ms` |  |
| `--spring-effects-slow` | `linear(0, 0.0575, 0.1803, 0.3208, 0.4552, 0.573, 0.6711, 0.7502, 0.8122, 0.8602, 0.8966, 0.9241, 0.9445, 0.9596, 0.9708, 0.9789, 0.9848, 0.9891, 0.9922, 0.9944, 0.996, 0.9972, 0.998, 0.9986, 0.999)` | `linear() 25 点` | spring-effects-slow: stiffness=800 damping=1 wn=28.28 settle=~327ms |
| `--spring-effects-slow-dur` | `327ms` | `327ms` |  |
| `--dur-exit` | `200ms` | `200ms` | 退場 (opacity のみ) の共通 duration。spec §4「消失感を出さない」200ms 前後 |
| `--dur-standby-dim` | `600ms` | `600ms` |  |
| `--dur-weight-swell` | `200ms` | `200ms` | tier 昇格時の主役ウェイト bold→heavy の連続遷移 (weight のみ、色/surface は瞬時) |
| `--ticker-row-h` | `40px` | `40px` |  |
| `--ticker-rows` | `2` | `2` |  |

#### tier 上書き

| トークン | 定義 | 実値 | 説明 |
| --- | --- | --- | --- |
| `--surface-panel` | `var(--surface-high)` | `#10161a` | 一段持ち上げ (container→high) |
| `--surface-panel-raised` | `var(--surface-highest)` | `#171f25` |  |
| `--num-weight` | `var(--type-weight-heavy)` | `800` |  |
<!-- GENERATED:tokens:end -->

</details>

### 8b. コントラスト監査表

<details>
<summary>コントラスト監査表（クリックで展開）</summary>

<!-- GENERATED:contrast:start (display/scripts/generate-design-docs.mjs --write) -->
| id | カテゴリ | state | 前景 | 背景 | 実測比 | 閾値 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| base---fg | 1 基本文字色 | base | `--fg` | `--bg` | 19.05:1 | 4.5:1 | PASS |
| base---fg-faint | 1 基本文字色 | base | `--fg-faint` | `--bg` | 3.27:1 | 4.5:1 | 許容 (意図的低プロミネンス (theme.css「沈んでいてよい」: 接続正常ドット/空状態)) |
| base---clock-fg | 1 基本文字色 | base | `--clock-fg` | `--bg` | 18.67:1 | 4.5:1 | PASS |
| int---int-1-on---bg | 2 震度rank文字 | base | `--int-1` | `--bg` | 6.52:1 | 4.5:1 | PASS |
| int---int-1-on---surface-lowest | 2 震度rank文字 | base | `--int-1` | `--surface-lowest` | 6.38:1 | 4.5:1 | PASS |
| int---int-1-on---surface-low | 2 震度rank文字 | base | `--int-1` | `--surface-low` | 6.17:1 | 4.5:1 | PASS |
| int---int-1-on---surface-container | 2 震度rank文字 | base | `--int-1` | `--surface-container` | 5.98:1 | 4.5:1 | PASS |
| int---int-1-on---surface-high | 2 震度rank文字 | base | `--int-1` | `--surface-high` | 5.67:1 | 4.5:1 | PASS |
| int---int-1-on---surface-highest | 2 震度rank文字 | base | `--int-1` | `--surface-highest` | 5.18:1 | 4.5:1 | PASS |
| int---int-2-on---bg | 2 震度rank文字 | base | `--int-2` | `--bg` | 9.10:1 | 4.5:1 | PASS |
| int---int-2-on---surface-lowest | 2 震度rank文字 | base | `--int-2` | `--surface-lowest` | 8.89:1 | 4.5:1 | PASS |
| int---int-2-on---surface-low | 2 震度rank文字 | base | `--int-2` | `--surface-low` | 8.60:1 | 4.5:1 | PASS |
| int---int-2-on---surface-container | 2 震度rank文字 | base | `--int-2` | `--surface-container` | 8.34:1 | 4.5:1 | PASS |
| int---int-2-on---surface-high | 2 震度rank文字 | base | `--int-2` | `--surface-high` | 7.90:1 | 4.5:1 | PASS |
| int---int-2-on---surface-highest | 2 震度rank文字 | base | `--int-2` | `--surface-highest` | 7.23:1 | 4.5:1 | PASS |
| int---int-3-on---bg | 2 震度rank文字 | base | `--int-3` | `--bg` | 6.33:1 | 4.5:1 | PASS |
| int---int-3-on---surface-lowest | 2 震度rank文字 | base | `--int-3` | `--surface-lowest` | 6.18:1 | 4.5:1 | PASS |
| int---int-3-on---surface-low | 2 震度rank文字 | base | `--int-3` | `--surface-low` | 5.98:1 | 4.5:1 | PASS |
| int---int-3-on---surface-container | 2 震度rank文字 | base | `--int-3` | `--surface-container` | 5.80:1 | 4.5:1 | PASS |
| int---int-3-on---surface-high | 2 震度rank文字 | base | `--int-3` | `--surface-high` | 5.49:1 | 4.5:1 | PASS |
| int---int-3-on---surface-highest | 2 震度rank文字 | base | `--int-3` | `--surface-highest` | 5.02:1 | 4.5:1 | PASS |
| int---int-4-on---bg | 2 震度rank文字 | base | `--int-4` | `--bg` | 6.14:1 | 4.5:1 | PASS |
| int---int-4-on---surface-lowest | 2 震度rank文字 | base | `--int-4` | `--surface-lowest` | 6.00:1 | 4.5:1 | PASS |
| int---int-4-on---surface-low | 2 震度rank文字 | base | `--int-4` | `--surface-low` | 5.80:1 | 4.5:1 | PASS |
| int---int-4-on---surface-container | 2 震度rank文字 | base | `--int-4` | `--surface-container` | 5.62:1 | 4.5:1 | PASS |
| int---int-4-on---surface-high | 2 震度rank文字 | base | `--int-4` | `--surface-high` | 5.33:1 | 4.5:1 | PASS |
| int---int-4-on---surface-highest | 2 震度rank文字 | base | `--int-4` | `--surface-highest` | 4.87:1 | 4.5:1 | PASS |
| int---int-5-on---bg | 2 震度rank文字 | base | `--int-5` | `--bg` | 15.88:1 | 4.5:1 | PASS |
| int---int-5-on---surface-lowest | 2 震度rank文字 | base | `--int-5` | `--surface-lowest` | 15.52:1 | 4.5:1 | PASS |
| int---int-5-on---surface-low | 2 震度rank文字 | base | `--int-5` | `--surface-low` | 15.01:1 | 4.5:1 | PASS |
| int---int-5-on---surface-container | 2 震度rank文字 | base | `--int-5` | `--surface-container` | 14.55:1 | 4.5:1 | PASS |
| int---int-5-on---surface-high | 2 震度rank文字 | base | `--int-5` | `--surface-high` | 13.79:1 | 4.5:1 | PASS |
| int---int-5-on---surface-highest | 2 震度rank文字 | base | `--int-5` | `--surface-highest` | 12.61:1 | 4.5:1 | PASS |
| int---int-6-on---bg | 2 震度rank文字 | base | `--int-6` | `--bg` | 9.32:1 | 4.5:1 | PASS |
| int---int-6-on---surface-lowest | 2 震度rank文字 | base | `--int-6` | `--surface-lowest` | 9.11:1 | 4.5:1 | PASS |
| int---int-6-on---surface-low | 2 震度rank文字 | base | `--int-6` | `--surface-low` | 8.81:1 | 4.5:1 | PASS |
| int---int-6-on---surface-container | 2 震度rank文字 | base | `--int-6` | `--surface-container` | 8.54:1 | 4.5:1 | PASS |
| int---int-6-on---surface-high | 2 震度rank文字 | base | `--int-6` | `--surface-high` | 8.10:1 | 4.5:1 | PASS |
| int---int-6-on---surface-highest | 2 震度rank文字 | base | `--int-6` | `--surface-highest` | 7.40:1 | 4.5:1 | PASS |
| int---int-7-on---bg | 2 震度rank文字 | base | `--int-7` | `--bg` | 6.36:1 | 4.5:1 | PASS |
| int---int-7-on---surface-lowest | 2 震度rank文字 | base | `--int-7` | `--surface-lowest` | 6.21:1 | 4.5:1 | PASS |
| int---int-7-on---surface-low | 2 震度rank文字 | base | `--int-7` | `--surface-low` | 6.01:1 | 4.5:1 | PASS |
| int---int-7-on---surface-container | 2 震度rank文字 | base | `--int-7` | `--surface-container` | 5.83:1 | 4.5:1 | PASS |
| int---int-7-on---surface-high | 2 震度rank文字 | base | `--int-7` | `--surface-high` | 5.52:1 | 4.5:1 | PASS |
| int---int-7-on---surface-highest | 2 震度rank文字 | base | `--int-7` | `--surface-highest` | 5.05:1 | 4.5:1 | PASS |
| int8 | 3 震度rank面 | base | `--int-8-on` | `--int-8-bg` | 5.43:1 | 4.5:1 | PASS |
| int9 | 3 震度rank面 | base | `--int-9-on` | `--int-9-bg` | 10.43:1 | 4.5:1 | PASS |
| role-critical-on---bg | 4 role文字色 | base | `--role-critical` | `--bg` | 5.43:1 | 4.5:1 | PASS |
| role-critical-on---surface-high | 4 role文字色 | base | `--role-critical` | `--surface-high` | 4.71:1 | 4.5:1 | PASS |
| role-critical-on---surface-panel | 4 role文字色 | base | `--role-critical` | `--surface-panel` | 4.98:1 | 4.5:1 | PASS |
| role-warning-on---bg | 4 role文字色 | base | `--role-warning` | `--bg` | 9.32:1 | 4.5:1 | PASS |
| role-warning-on---surface-high | 4 role文字色 | base | `--role-warning` | `--surface-high` | 8.10:1 | 4.5:1 | PASS |
| role-warning-on---surface-panel | 4 role文字色 | base | `--role-warning` | `--surface-panel` | 8.54:1 | 4.5:1 | PASS |
| role-normal-on---bg | 4 role文字色 | base | `--role-normal` | `--bg` | 19.05:1 | 4.5:1 | PASS |
| role-normal-on---surface-high | 4 role文字色 | base | `--role-normal` | `--surface-high` | 16.54:1 | 4.5:1 | PASS |
| role-normal-on---surface-panel | 4 role文字色 | base | `--role-normal` | `--surface-panel` | 17.45:1 | 4.5:1 | PASS |
| role-info-on---bg | 4 role文字色 | base | `--role-info` | `--bg` | 6.52:1 | 4.5:1 | PASS |
| role-info-on---surface-high | 4 role文字色 | base | `--role-info` | `--surface-high` | 5.67:1 | 4.5:1 | PASS |
| role-info-on---surface-panel | 4 role文字色 | base | `--role-info` | `--surface-panel` | 5.98:1 | 4.5:1 | PASS |
| role-cancel-on---bg | 4 role文字色 | base | `--role-cancel` | `--bg` | 6.86:1 | 4.5:1 | PASS |
| role-cancel-on---surface-high | 4 role文字色 | base | `--role-cancel` | `--surface-high` | 5.96:1 | 4.5:1 | PASS |
| role-cancel-on---surface-panel | 4 role文字色 | base | `--role-cancel` | `--surface-panel` | 6.29:1 | 4.5:1 | PASS |
| role-eewWarning-on---bg | 4 role文字色 | base | `--role-eewWarning` | `--bg` | 5.43:1 | 4.5:1 | PASS |
| role-eewWarning-on---surface-high | 4 role文字色 | base | `--role-eewWarning` | `--surface-high` | 4.71:1 | 4.5:1 | PASS |
| role-eewWarning-on---surface-panel | 4 role文字色 | base | `--role-eewWarning` | `--surface-panel` | 4.98:1 | 4.5:1 | PASS |
| role-eewForecast-on---bg | 4 role文字色 | base | `--role-eewForecast` | `--bg` | 9.32:1 | 4.5:1 | PASS |
| role-eewForecast-on---surface-high | 4 role文字色 | base | `--role-eewForecast` | `--surface-high` | 8.10:1 | 4.5:1 | PASS |
| role-eewForecast-on---surface-panel | 4 role文字色 | base | `--role-eewForecast` | `--surface-panel` | 8.54:1 | 4.5:1 | PASS |
| role-tsunamiMajor-on---bg | 4 role文字色 | base | `--role-tsunamiMajor` | `--bg` | 6.51:1 | 4.5:1 | PASS |
| role-tsunamiMajor-on---surface-high | 4 role文字色 | base | `--role-tsunamiMajor` | `--surface-high` | 5.65:1 | 4.5:1 | PASS |
| role-tsunamiMajor-on---surface-panel | 4 role文字色 | base | `--role-tsunamiMajor` | `--surface-panel` | 5.96:1 | 4.5:1 | PASS |
| role-tsunamiWarning-on---bg | 4 role文字色 | base | `--role-tsunamiWarning` | `--bg` | 6.16:1 | 4.5:1 | PASS |
| role-tsunamiWarning-on---surface-high | 4 role文字色 | base | `--role-tsunamiWarning` | `--surface-high` | 5.35:1 | 4.5:1 | PASS |
| role-tsunamiWarning-on---surface-panel | 4 role文字色 | base | `--role-tsunamiWarning` | `--surface-panel` | 5.65:1 | 4.5:1 | PASS |
| role-tsunamiAdvisory-on---bg | 4 role文字色 | base | `--role-tsunamiAdvisory` | `--bg` | 15.88:1 | 4.5:1 | PASS |
| role-tsunamiAdvisory-on---surface-high | 4 role文字色 | base | `--role-tsunamiAdvisory` | `--surface-high` | 13.79:1 | 4.5:1 | PASS |
| role-tsunamiAdvisory-on---surface-panel | 4 role文字色 | base | `--role-tsunamiAdvisory` | `--surface-panel` | 14.55:1 | 4.5:1 | PASS |
| role-quakeMajor-on---bg | 4 role文字色 | base | `--role-quakeMajor` | `--bg` | 5.43:1 | 4.5:1 | PASS |
| role-quakeMajor-on---surface-high | 4 role文字色 | base | `--role-quakeMajor` | `--surface-high` | 4.71:1 | 4.5:1 | PASS |
| role-quakeMajor-on---surface-panel | 4 role文字色 | base | `--role-quakeMajor` | `--surface-panel` | 4.98:1 | 4.5:1 | PASS |
| role-weatherEmergency-on---bg | 4 role文字色 | base | `--role-weatherEmergency` | `--bg` | 6.51:1 | 4.5:1 | PASS |
| role-weatherEmergency-on---surface-high | 4 role文字色 | base | `--role-weatherEmergency` | `--surface-high` | 5.65:1 | 4.5:1 | PASS |
| role-weatherEmergency-on---surface-panel | 4 role文字色 | base | `--role-weatherEmergency` | `--surface-panel` | 5.96:1 | 4.5:1 | PASS |
| role-weatherWarning-on---bg | 4 role文字色 | base | `--role-weatherWarning` | `--bg` | 9.00:1 | 4.5:1 | PASS |
| role-weatherWarning-on---surface-high | 4 role文字色 | base | `--role-weatherWarning` | `--surface-high` | 7.82:1 | 4.5:1 | PASS |
| role-weatherWarning-on---surface-panel | 4 role文字色 | base | `--role-weatherWarning` | `--surface-panel` | 8.25:1 | 4.5:1 | PASS |
| role-weatherAdvisory-on---bg | 4 role文字色 | base | `--role-weatherAdvisory` | `--bg` | 15.88:1 | 4.5:1 | PASS |
| role-weatherAdvisory-on---surface-high | 4 role文字色 | base | `--role-weatherAdvisory` | `--surface-high` | 13.79:1 | 4.5:1 | PASS |
| role-weatherAdvisory-on---surface-panel | 4 role文字色 | base | `--role-weatherAdvisory` | `--surface-panel` | 14.55:1 | 4.5:1 | PASS |
| role-connectionOk-on---bg | 4 role文字色 | base | `--role-connectionOk` | `--bg` | 3.27:1 | 4.5:1 | 許容 (意図的低プロミネンス (theme.css「沈んでいてよい」: 接続正常ドット/空状態)) |
| role-connectionOk-on---surface-high | 4 role文字色 | base | `--role-connectionOk` | `--surface-high` | 2.84:1 | 4.5:1 | 許容 (意図的低プロミネンス (theme.css「沈んでいてよい」: 接続正常ドット/空状態)) |
| role-connectionOk-on---surface-panel | 4 role文字色 | base | `--role-connectionOk` | `--surface-panel` | 3.00:1 | 4.5:1 | 許容 (意図的低プロミネンス (theme.css「沈んでいてよい」: 接続正常ドット/空状態)) |
| role-connectionStale-on---bg | 4 role文字色 | base | `--role-connectionStale` | `--bg` | 9.32:1 | 4.5:1 | PASS |
| role-connectionStale-on---surface-high | 4 role文字色 | base | `--role-connectionStale` | `--surface-high` | 8.10:1 | 4.5:1 | PASS |
| role-connectionStale-on---surface-panel | 4 role文字色 | base | `--role-connectionStale` | `--surface-panel` | 8.54:1 | 4.5:1 | PASS |
| role-muted-on---bg | 4 role文字色 | base | `--role-muted` | `--bg` | 11.56:1 | 4.5:1 | PASS |
| role-muted-on---surface-high | 4 role文字色 | base | `--role-muted` | `--surface-high` | 10.04:1 | 4.5:1 | PASS |
| role-muted-on---surface-panel | 4 role文字色 | base | `--role-muted` | `--surface-panel` | 10.59:1 | 4.5:1 | PASS |
| hdr-eewWarning | 5 ヘッダ3層 | base | `--header-eewWarning-on` | `--header-eewWarning-container` | 9.55:1 | 4.5:1 | PASS |
| hdr-eewForecast | 5 ヘッダ3層 | base | `--header-eewForecast-on` | `--header-eewForecast-container` | 10.46:1 | 4.5:1 | PASS |
| hdr-quakeCritical | 5 ヘッダ3層 | base | `--header-quakeCritical-on` | `--header-quakeCritical-container` | 9.55:1 | 4.5:1 | PASS |
| hdr-quakeWarning | 5 ヘッダ3層 | base | `--header-quakeWarning-on` | `--header-quakeWarning-container` | 10.46:1 | 4.5:1 | PASS |
| hdr-tsunamiMajor | 5 ヘッダ3層 | base | `--header-tsunamiMajor-on` | `--header-tsunamiMajor-container` | 10.27:1 | 4.5:1 | PASS |
| hdr-tsunamiWarning | 5 ヘッダ3層 | base | `--header-tsunamiWarning-on` | `--header-tsunamiWarning-container` | 9.80:1 | 4.5:1 | PASS |
| hdr-tsunamiAdvisory | 5 ヘッダ3層 | base | `--header-tsunamiAdvisory-on` | `--header-tsunamiAdvisory-container` | 11.48:1 | 4.5:1 | PASS |
| hdr-weatherEmergency | 5 ヘッダ3層 | base | `--header-weatherEmergency-on` | `--header-weatherEmergency-container` | 10.27:1 | 4.5:1 | PASS |
| hdr-weatherWarning | 5 ヘッダ3層 | base | `--header-weatherWarning-on` | `--header-weatherWarning-container` | 10.46:1 | 4.5:1 | PASS |
| hdr-weatherAdvisory | 5 ヘッダ3層 | base | `--header-weatherAdvisory-on` | `--header-weatherAdvisory-container` | 11.48:1 | 4.5:1 | PASS |
| band-eewWarning-container | 6 ヘッダband | base | `--header-band-eewWarning` | `--header-eewWarning-container` | 4.28:1 | 3:1 | PASS |
| band-eewWarning-bg | 6 ヘッダband | base | `--header-band-eewWarning` | `--bg` | 5.43:1 | 3:1 | PASS |
| band-eewForecast-container | 6 ヘッダband | base | `--header-band-eewForecast` | `--header-eewForecast-container` | 6.40:1 | 3:1 | PASS |
| band-eewForecast-bg | 6 ヘッダband | base | `--header-band-eewForecast` | `--bg` | 9.32:1 | 3:1 | PASS |
| band-quakeCritical-container | 6 ヘッダband | base | `--header-band-quakeCritical` | `--header-quakeCritical-container` | 4.28:1 | 3:1 | PASS |
| band-quakeCritical-bg | 6 ヘッダband | base | `--header-band-quakeCritical` | `--bg` | 5.43:1 | 3:1 | PASS |
| band-quakeWarning-container | 6 ヘッダband | base | `--header-band-quakeWarning` | `--header-quakeWarning-container` | 6.40:1 | 3:1 | PASS |
| band-quakeWarning-bg | 6 ヘッダband | base | `--header-band-quakeWarning` | `--bg` | 9.32:1 | 3:1 | PASS |
| band-tsunamiMajor-container | 6 ヘッダband | base | `--header-band-tsunamiMajor` | `--header-tsunamiMajor-container` | 3.26:1 | 3:1 | PASS |
| band-tsunamiMajor-bg | 6 ヘッダband | base | `--header-band-tsunamiMajor` | `--bg` | 4.14:1 | 3:1 | PASS |
| band-tsunamiWarning-container | 6 ヘッダband | base | `--header-band-tsunamiWarning` | `--header-tsunamiWarning-container` | 3.56:1 | 3:1 | PASS |
| band-tsunamiWarning-bg | 6 ヘッダband | base | `--header-band-tsunamiWarning` | `--bg` | 4.37:1 | 3:1 | PASS |
| band-tsunamiAdvisory-container | 6 ヘッダband | base | `--header-band-tsunamiAdvisory` | `--header-tsunamiAdvisory-container` | 10.74:1 | 3:1 | PASS |
| band-tsunamiAdvisory-bg | 6 ヘッダband | base | `--header-band-tsunamiAdvisory` | `--bg` | 15.88:1 | 3:1 | PASS |
| band-weatherEmergency-container | 6 ヘッダband | base | `--header-band-weatherEmergency` | `--header-weatherEmergency-container` | 3.26:1 | 3:1 | PASS |
| band-weatherEmergency-bg | 6 ヘッダband | base | `--header-band-weatherEmergency` | `--bg` | 4.14:1 | 3:1 | PASS |
| band-weatherWarning-container | 6 ヘッダband | base | `--header-band-weatherWarning` | `--header-weatherWarning-container` | 6.40:1 | 3:1 | PASS |
| band-weatherWarning-bg | 6 ヘッダband | base | `--header-band-weatherWarning` | `--bg` | 9.32:1 | 3:1 | PASS |
| band-weatherAdvisory-container | 6 ヘッダband | base | `--header-band-weatherAdvisory` | `--header-weatherAdvisory-container` | 10.74:1 | 3:1 | PASS |
| band-weatherAdvisory-bg | 6 ヘッダband | base | `--header-band-weatherAdvisory` | `--bg` | 15.88:1 | 3:1 | PASS |
| tsunami-purple | 7 JMA文字色 | base | `--c-tsunami-purple` | `--bg` | 6.51:1 | 4.5:1 | PASS |
| jma-red | 7 JMA文字色 | base | `--c-jma-red` | `--bg` | 6.16:1 | 4.5:1 | PASS |
| tier---fg-on---surface-high | 8 tier上書き後 | tier | `--fg` | `--surface-high` | 16.54:1 | 4.5:1 | PASS |
| tier---fg-on---surface-highest | 8 tier上書き後 | tier | `--fg` | `--surface-highest` | 15.13:1 | 4.5:1 | PASS |
| tier---role-muted-on---surface-high | 8 tier上書き後 | tier | `--role-muted` | `--surface-high` | 10.04:1 | 4.5:1 | PASS |
| tier---role-muted-on---surface-highest | 8 tier上書き後 | tier | `--role-muted` | `--surface-highest` | 9.18:1 | 4.5:1 | PASS |
| dim-chip-eewWarning | 9 dim×tickerチップ | dim | `floor(--header-eewWarning-on)` | `floor(--header-eewWarning-container)` | 9.55:1 | 4.5:1 | PASS |
| dim-chip-eewForecast | 9 dim×tickerチップ | dim | `dim35(--header-eewForecast-on)` | `dim35(--header-eewForecast-container)` | 2.27:1 | 4.5:1 | 許容 (注意報級は夜間減光を優先 (警報級は spec D5 の可読性フロア + 自動サスペンドで救済済み)) |
| dim-chip-quakeCritical | 9 dim×tickerチップ | dim | `floor(--header-quakeCritical-on)` | `floor(--header-quakeCritical-container)` | 9.55:1 | 4.5:1 | PASS |
| dim-chip-quakeWarning | 9 dim×tickerチップ | dim | `floor(--header-quakeWarning-on)` | `floor(--header-quakeWarning-container)` | 10.46:1 | 4.5:1 | PASS |
| dim-chip-tsunamiMajor | 9 dim×tickerチップ | dim | `floor(--header-tsunamiMajor-on)` | `floor(--header-tsunamiMajor-container)` | 10.27:1 | 4.5:1 | PASS |
| dim-chip-tsunamiWarning | 9 dim×tickerチップ | dim | `floor(--header-tsunamiWarning-on)` | `floor(--header-tsunamiWarning-container)` | 9.80:1 | 4.5:1 | PASS |
| dim-chip-tsunamiAdvisory | 9 dim×tickerチップ | dim | `dim35(--header-tsunamiAdvisory-on)` | `dim35(--header-tsunamiAdvisory-container)` | 2.41:1 | 4.5:1 | 許容 (注意報級は夜間減光を優先 (警報級は spec D5 の可読性フロア + 自動サスペンドで救済済み)) |
| dim-chip-weatherEmergency | 9 dim×tickerチップ | dim | `floor(--header-weatherEmergency-on)` | `floor(--header-weatherEmergency-container)` | 10.27:1 | 4.5:1 | PASS |
| dim-chip-weatherWarning | 9 dim×tickerチップ | dim | `floor(--header-weatherWarning-on)` | `floor(--header-weatherWarning-container)` | 10.46:1 | 4.5:1 | PASS |
| dim-chip-weatherAdvisory | 9 dim×tickerチップ | dim | `dim35(--header-weatherAdvisory-on)` | `dim35(--header-weatherAdvisory-container)` | 2.41:1 | 4.5:1 | 許容 (注意報級は夜間減光を優先 (警報級は spec D5 の可読性フロア + 自動サスペンドで救済済み)) |
| overlay---fg-on---surface-high | 10 critical overlay合成 | tier-overlay | `film(--fg)` | `film(--surface-high)` | 7.40:1 | 4.5:1 | PASS |
| overlay---fg-on---surface-highest | 10 critical overlay合成 | tier-overlay | `film(--fg)` | `film(--surface-highest)` | 6.85:1 | 4.5:1 | PASS |
| overlay---fg-on---surface-panel | 10 critical overlay合成 | tier-overlay | `film(--fg)` | `film(--surface-panel)` | 7.81:1 | 4.5:1 | PASS |
| overlay---role-muted-on---surface-high | 10 critical overlay合成 | tier-overlay | `film(--role-muted)` | `film(--surface-high)` | 4.99:1 | 4.5:1 | PASS |
| overlay---role-muted-on---surface-highest | 10 critical overlay合成 | tier-overlay | `film(--role-muted)` | `film(--surface-highest)` | 4.62:1 | 4.5:1 | PASS |
| overlay---role-muted-on---surface-panel | 10 critical overlay合成 | tier-overlay | `film(--role-muted)` | `film(--surface-panel)` | 5.27:1 | 4.5:1 | PASS |
| overlay-role-weatherEmergency-on---surface-high | 10 critical overlay合成 | tier-overlay | `film(--role-weatherEmergency)` | `film(--surface-high)` | 3.46:1 | 4.5:1 | 許容 (critical 中はパネルが主要文字を --fg へ退避するため、この組合せは文字として描かれない (意味色は帯とレールの非テキストに残る)) |
| overlay-role-weatherEmergency-on---surface-highest | 10 critical overlay合成 | tier-overlay | `film(--role-weatherEmergency)` | `film(--surface-highest)` | 3.21:1 | 4.5:1 | 許容 (critical 中はパネルが主要文字を --fg へ退避するため、この組合せは文字として描かれない (意味色は帯とレールの非テキストに残る)) |
| overlay-role-weatherEmergency-on---surface-panel | 10 critical overlay合成 | tier-overlay | `film(--role-weatherEmergency)` | `film(--surface-panel)` | 3.66:1 | 4.5:1 | 許容 (critical 中はパネルが主要文字を --fg へ退避するため、この組合せは文字として描かれない (意味色は帯とレールの非テキストに残る)) |
| overlay-role-weatherWarning-on---surface-high | 10 critical overlay合成 | tier-overlay | `film(--role-weatherWarning)` | `film(--surface-high)` | 4.21:1 | 4.5:1 | 許容 (critical 中はパネルが主要文字を --fg へ退避するため、この組合せは文字として描かれない (意味色は帯とレールの非テキストに残る)) |
| overlay-role-weatherWarning-on---surface-highest | 10 critical overlay合成 | tier-overlay | `film(--role-weatherWarning)` | `film(--surface-highest)` | 3.90:1 | 4.5:1 | 許容 (critical 中はパネルが主要文字を --fg へ退避するため、この組合せは文字として描かれない (意味色は帯とレールの非テキストに残る)) |
| overlay-role-weatherWarning-on---surface-panel | 10 critical overlay合成 | tier-overlay | `film(--role-weatherWarning)` | `film(--surface-panel)` | 4.44:1 | 4.5:1 | 許容 (critical 中はパネルが主要文字を --fg へ退避するため、この組合せは文字として描かれない (意味色は帯とレールの非テキストに残る)) |
| overlay-hdr-eewWarning | 10 critical overlay合成 | tier-overlay | `film(--header-eewWarning-on)` | `film(--header-eewWarning-container)` | 4.73:1 | 4.5:1 | PASS |
| overlay-hdr-eewForecast | 10 critical overlay合成 | tier-overlay | `film(--header-eewForecast-on)` | `film(--header-eewForecast-container)` | 5.11:1 | 4.5:1 | PASS |
| overlay-hdr-quakeCritical | 10 critical overlay合成 | tier-overlay | `film(--header-quakeCritical-on)` | `film(--header-quakeCritical-container)` | 4.73:1 | 4.5:1 | PASS |
| overlay-hdr-quakeWarning | 10 critical overlay合成 | tier-overlay | `film(--header-quakeWarning-on)` | `film(--header-quakeWarning-container)` | 5.11:1 | 4.5:1 | PASS |
| overlay-hdr-tsunamiMajor | 10 critical overlay合成 | tier-overlay | `film(--header-tsunamiMajor-on)` | `film(--header-tsunamiMajor-container)` | 4.94:1 | 4.5:1 | PASS |
| overlay-hdr-tsunamiWarning | 10 critical overlay合成 | tier-overlay | `film(--header-tsunamiWarning-on)` | `film(--header-tsunamiWarning-container)` | 4.85:1 | 4.5:1 | PASS |
| overlay-hdr-tsunamiAdvisory | 10 critical overlay合成 | tier-overlay | `film(--header-tsunamiAdvisory-on)` | `film(--header-tsunamiAdvisory-container)` | 5.55:1 | 4.5:1 | PASS |
| overlay-hdr-weatherEmergency | 10 critical overlay合成 | tier-overlay | `film(--header-weatherEmergency-on)` | `film(--header-weatherEmergency-container)` | 4.94:1 | 4.5:1 | PASS |
| overlay-hdr-weatherWarning | 10 critical overlay合成 | tier-overlay | `film(--header-weatherWarning-on)` | `film(--header-weatherWarning-container)` | 5.11:1 | 4.5:1 | PASS |
| overlay-hdr-weatherAdvisory | 10 critical overlay合成 | tier-overlay | `film(--header-weatherAdvisory-on)` | `film(--header-weatherAdvisory-container)` | 5.55:1 | 4.5:1 | PASS |
| dim-high-critical | 11 dim×high lane | dim | `floor(--role-critical)` | `dim60(lane12 critical)` | 5.01:1 | 4.5:1 | PASS |
| dim-high-warning | 11 dim×high lane | dim | `floor(--role-warning)` | `dim60(lane12 warning)` | 8.39:1 | 4.5:1 | PASS |
| dim-high-eewWarning | 11 dim×high lane | dim | `floor(--role-eewWarning)` | `dim60(lane12 eewWarning)` | 5.01:1 | 4.5:1 | PASS |
| dim-high-eewForecast | 11 dim×high lane | dim | `dim35(--role-eewForecast)` | `dim60(lane12 eewForecast)` | 1.71:1 | 4.5:1 | 許容 (注意報級は夜間減光を優先 (警報級は spec D5 の可読性フロア + 自動サスペンドで救済済み)) |
| dim-high-tsunamiWarning | 11 dim×high lane | dim | `floor(--role-tsunamiWarning)` | `dim60(lane12 tsunamiWarning)` | 5.69:1 | 4.5:1 | PASS |
| dim-high-tsunamiAdvisory | 11 dim×high lane | dim | `dim35(--role-tsunamiAdvisory)` | `dim60(lane12 tsunamiAdvisory)` | 2.20:1 | 4.5:1 | 許容 (注意報級は夜間減光を優先 (警報級は spec D5 の可読性フロア + 自動サスペンドで救済済み)) |
| dim-high-weatherEmergency | 11 dim×high lane | dim | `floor(--role-weatherEmergency)` | `dim60(lane12 weatherEmergency)` | 5.94:1 | 4.5:1 | PASS |
| dim-high-weatherWarning | 11 dim×high lane | dim | `floor(--role-weatherWarning)` | `dim60(lane12 weatherWarning)` | 8.13:1 | 4.5:1 | PASS |
| dim-high-weatherAdvisory | 11 dim×high lane | dim | `dim35(--role-weatherAdvisory)` | `dim60(lane12 weatherAdvisory)` | 2.20:1 | 4.5:1 | 許容 (注意報級は夜間減光を優先 (警報級は spec D5 の可読性フロア + 自動サスペンドで救済済み)) |
| dim-high-quakeMajor | 11 dim×high lane | dim | `floor(--role-quakeMajor)` | `dim60(lane12 quakeMajor)` | 5.01:1 | 4.5:1 | PASS |
| tsu-heading-大津波警報 | 12 津波ページ二段mix | base | `見出し(--fg 65%)` | `page-bg(大津波警報 15%)` | 7.45:1 | 4.5:1 | PASS |
| tsu-body-大津波警報 | 12 津波ページ二段mix | base | `--fg` | `page-bg(大津波警報 15%)` | 16.56:1 | 4.5:1 | PASS |
| tsu-heading-津波警報 | 12 津波ページ二段mix | base | `見出し(--fg 65%)` | `page-bg(津波警報 15%)` | 7.45:1 | 4.5:1 | PASS |
| tsu-body-津波警報 | 12 津波ページ二段mix | base | `--fg` | `page-bg(津波警報 15%)` | 16.82:1 | 4.5:1 | PASS |
| tsu-heading-津波注意報 | 12 津波ページ二段mix | base | `見出し(--fg 65%)` | `page-bg(津波注意報 15%)` | 6.89:1 | 4.5:1 | PASS |
| tsu-body-津波注意報 | 12 津波ページ二段mix | base | `--fg` | `page-bg(津波注意報 15%)` | 14.53:1 | 4.5:1 | PASS |
| opacity-eew-serial | 13 opacity経路 | opacity | `EEW serial on×0.85` | `--header-eewWarning-container` | 7.24:1 | 4.5:1 | PASS |
| dim-mid-critical | 14 dim×通常レーン警報本文 | dim | `floor(--role-critical)` | `dim60(--surface-low)` | 5.25:1 | 4.5:1 | PASS |
| dim-mid-warning | 14 dim×通常レーン警報本文 | dim | `floor(--role-warning)` | `dim60(--surface-low)` | 9.01:1 | 4.5:1 | PASS |
| dim-mid-eewWarning | 14 dim×通常レーン警報本文 | dim | `floor(--role-eewWarning)` | `dim60(--surface-low)` | 5.25:1 | 4.5:1 | PASS |
| dim-mid-tsunamiWarning | 14 dim×通常レーン警報本文 | dim | `floor(--role-tsunamiWarning)` | `dim60(--surface-low)` | 5.96:1 | 4.5:1 | PASS |
| dim-mid-quakeMajor | 14 dim×通常レーン警報本文 | dim | `floor(--role-quakeMajor)` | `dim60(--surface-low)` | 5.25:1 | 4.5:1 | PASS |
| dim-mid-weatherEmergency | 14 dim×通常レーン警報本文 | dim | `floor(--role-weatherEmergency)` | `dim60(--surface-low)` | 6.29:1 | 4.5:1 | PASS |
| dim-mid-weatherWarning | 14 dim×通常レーン警報本文 | dim | `floor(--role-weatherWarning)` | `dim60(--surface-low)` | 8.70:1 | 4.5:1 | PASS |
<!-- GENERATED:contrast:end -->

## 5. 待機画面カード拡充

HeatAlertCard、TyphoonCard、VolcanoCard、FloodCard/FloodWideCard は右上または時計上の待機カードである。NankaiBadge は時計下、竜巻と長周期地震動は既存の WeatherAlertCard / LatestQuakeCard の rider として表示する。右上の収容上限を超えたカードは StandbyOverflowSummary に集約する。RestoredChip（同期中）は永続化から復元した状態だけに付け、live 更新後は消す。critical standby は tier と夜間減光を抑止するが、emergency 画面遷移はしない。

右上の積み順は 気象警報カード > 洪水 > 火山 > 台風 > 熱中症（洪水スロットは corner⇔clock-top を同一 key で移動するため絶対配置だが、気象カード高さ分のオフセット + スペーサーで気象カードの下に収める）。FloodWideCard の幅 `min(720px, 56vw)` は視聴環境の錨（24インチ FHD）では左右コーナーと衝突しない。**FHD 未満（例: 1280px 幅）では右上カード列と水平に重なり得る既知の制約**であり、FHD 未満の常用が必要になったら幅計算を「画面幅 − 左右コーナー幅」基準へ変更する。目視確認はプレビュー `#standby-active-cards` / `#standby-active-wide` を使う。

</details>
