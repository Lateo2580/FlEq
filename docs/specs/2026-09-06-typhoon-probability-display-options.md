# 台風カード「暴風域に入る確率」表示設計の選択肢

## 0. この文書の位置づけ

2026-09-05 の design-alignment 配送後、ご主人から「`最大5日確率` と `80%` が左右に離れ、最上段の 80% が何の値か読めない。府県別の 2 列と、最大値・最大地域の関係も含めて表示内容を再設計したい」と観測があった。

本書は決定仕様ではなく、朝の相談で範囲と優先する読み方を決めるための選択肢集である。受入条件と裁定ラベルは、範囲決定後の実装 spec で定める。

前提は次のとおり。

- まず「ラベルと数値の対応」と「全体最大・府県等内最大・最大地域の関係」を決め、その後で領域へ収める。
- 表示だけの改善では parser、確率計算、wire、永続化を変更しない。
- 2026-09-05 夜のご主人裁定 4B により、本件はリリース前に済ませる 5 件に含まれる。ただし、従来の「全面再設計は次以降」という裁定との境界を先に決める必要がある。
- `docs/specs/dmdata.md` には現時点で VPTA50 の値の意味を定義する節がない。このため、本書の意味確認は実 XML、parser、projection、display protocol を正本とした。

## 1. 確率の意味

### 1.1 結論

現在カードが `最大5日確率` と呼ぶ値は、**対象期間内の時間帯別確率の最大値ではない**。次の三段集約の最終値である。

1. XML は対象地域ごとに「1日積算」から「5日積算」までを別値として持つ。5日積算は起点から 120 時間の間に、その地域が暴風域に入る確率である。実 fixture では 5日積算 section が `Duration=PT120H`、`Name=120時間先` を持つ（`test/fixtures/76_01_01_200630_VPTA50.xml:24061-24070`）。parser はこれを `daily[4]` に格納する（`src/dmdata/typhoon-probability-parser.ts:124-131,158-176`）。
2. `topPrefectures[].fiveDayProbability` は、同じ府県等コードに属する対象地域の `daily[4]` の最大値である。府県全域を一つの事象として再計算した確率ではない（`src/engine/display/project-typhoon-probability.ts:465-479`）。表示上は「府県等内の地域最大」と呼ぶのが最も正確である。
3. `maxFiveDayProbability` は、その府県等内最大を全府県等で比べた最大値である（`src/engine/display/project-typhoon-probability.ts:505-518`）。`worstArea.fiveDayProbability` も同じ全体最大になることが invariant で保証されている（同 `:332-338`）。すなわち、全体最大の数値と最大地域の数値は別指標ではなく、**同じ 5日積算値の要約と内訳**である。

`worstArea.peakAt` はさらに別の軸である。これは最大地域の時間帯別 series のうち、最大値を最初に記録した slot の開始時刻であり、5日積算値がその時刻に発生するという意味ではない（`src/engine/display/project-typhoon-probability.ts:390-397,420-425,519-525`）。現行 wire は開始時刻だけを持ち、時間帯の長さとピーク値は持たない（`display/frontend/src/lib/protocol.ts:978-995`）。したがって、現行 wire のままなら表示名は「時間帯別ピーク開始」が安全であり、「3時間確率」や終了時刻までは断定表示しない。

### 1.2 実 fixture での照合

実 VPTA50 fixture `76_01_01_200630_VPTA50.xml` では次の関係になる。

- 益田地区は 1〜5日積算が `[0, 0, 92, 92, 92]` である（parser test: `test/dmdata/typhoon-probability-parser.test.ts:44-59`、5日積算の実 XML: `test/fixtures/76_01_01_200630_VPTA50.xml:28145-28159`）。一方、時間帯別の最大は 87% で、開始は 2020-10-03 03:00 である（同 test `:70-90`、XML `:44275-44307`）。**5日積算 92% と時間帯別ピーク 87% は異なる値**である。
- 大東島地方の 5日積算は 100% である（XML `:29969-29983`）。時間帯別 series は refID 7 で初めて 100% となる（XML `:50524-50544`）。projection fixture の全体最大は 100%、上位府県等は奄美地方・沖縄本島地方・大東島地方が各 100%、最大地域は大東島地方 100%、ピーク開始は 2020-10-01 09:00 である（`test/fixtures/typhoon-probability-card/expectations.json:2-24`）。同率の全体最大が複数あっても、`worstArea` は 5日積算、時間帯別ピーク値、最初のピーク時刻、コードの順で一件へ決定される（`src/engine/display/project-typhoon-probability.ts:420-425`）。
- design-alignment preview の 80% は実電文値ではなく固定表示 fixture である。`maxFiveDayProbability=80`、東京都 80 / 神奈川県 70 / 千葉県 60 / 埼玉県 50 / 茨城県 40 / 栃木県 30、最大地域は東京地方（東京都）80%、`peakAt=2026-07-08 09:00` である（`display/frontend/src/preview/fixtures.ts:2352-2367`）。

## 2. 現状の表示構造と読めなかった理由

対象 component は `display/frontend/src/components/TyphoonCard.svelte` である。display protocol が渡す probability slice は、起点・予測終了、全体最大、active 府県等数、上位府県等、最大地域とピーク開始だけであり、全地域の grid や 1〜5日積算の推移は frontend へ渡らない（`display/frontend/src/lib/protocol.ts:972-995`）。

full 表示の DOM は次の順である（`TyphoonCard.svelte:237-248`）。

```text
section.probability
├─ h3  暴風域に入る確率（5日以内）
├─ div.probability-maximum
│  ├─ text  最大5日確率
│  └─ span.probability-number  80%
├─ ul.probability-prefecture-list
│  ├─ li  東京都       80%
│  ├─ li  神奈川県     70%
│  └─ ...（full は最大5件、2列自動配置）
├─ div.probability-omitted  ほか3府県等
├─ div.probability-worst
│  ├─ span  最大地域 東京地方（東京都）
│  └─ span.probability-number  80%
└─ div.probability-peak  7月8日 09:00
```

読みにくさは数値の装飾ではなく、構造上の次の問題から生じる。

1. `.probability-maximum` は label と value を別 child にし、`justify-content: space-between` で両端へ押し分ける（`TyphoonCard.svelte:325-333`）。1280×720 の実 capture では行の左端が x=957.8、80% が x=1201.5 で、約 244px 離れる（`display/tmp-capture/review-after/design-alignment-records.json:2142-2183`）。視線を横断しなければ対応を復元できない。
2. 全体最大 80%、東京都の府県等内最大 80%、東京地方の地域値 80% が、ほぼ同じ typography で三回現れる。しかし「全体最大 → 東京都内の最大 → 東京地方」という包含関係は DOM 上で親子になっておらず、最大地域は一覧と omission の後に別 block として置かれる。
3. `最大5日確率` は「何について最大か」を書かないため、「5日間の時間方向の最大」にも「全対象地域の空間方向の最大」にも読める。実際は後者である。
4. 府県等一覧の行は名称と値だけであり、その値が「府県等に属する対象地域の 5日積算最大」であることを示さない。2列 grid は一覧性を上げる一方、最大地域との対応をさらに離す（`TyphoonCard.svelte:335-345`）。
5. 最下段の日時には visible label がない（`TyphoonCard.svelte:246-247,346-350`）。5日積算 80% の時刻に見えるが、実際は別 series のピーク開始である。

compact 表示も `5日以内 最大`、府県等一覧、`最大地域` を一つの折返し flex と次行へ並べるため、重複と集約関係は残る（`TyphoonCard.svelte:231-235,351-373`）。

なお、該当 preview の full card 実高は約 308px で overflow はない（`display/tmp-capture/review-after/design-alignment-records.json:2081-2104`）。TyphoonCard 自身に内蔵 pager はなく、高さ増は StandbyScreen の `spill → center → 圧縮 → rotation` と full → compact fallback に効く（`docs/specs/display-design-system.md:231`）。以下の「ページ送りへの影響」は、主にこの外側 rotation へ回る可能性を指す。

## 3. 意匠上の錨とトークン

どの案でも、次を共通契約とする。

- **錨 1: LatestQuakeCard の `.meta > .stat > .stat-label + .stat-value`**。一つの意味単位の中で label と value を縦に隣接させる（`display/frontend/src/components/LatestQuakeCard.svelte:275-286,426-435`）。全体最大の label/value 対応はこれに倣う。
- **錨 2: WeatherAlertCard の bounded list と omission 可視化**。収まらない情報を黙って切らず、件数を出し、実高を placement へ反映するという原則に倣う（`docs/specs/display-design-system.md:242`）。TyphoonCard に同じ pager 実装を移植するという意味ではない。
- **錨 3: 現行 TyphoonCard の shell/header/NumberUnit**。`probability` から header tone や severity を作らず、probability-only は muted のままにする。full は最大5府県等、compact は最大3府県等、残りは `ほかN府県等` を維持する（`docs/specs/display-design-system.md:237`）。
- surface は `--surface-standby`、境界は `--hairline`、外形は `--radius-standby` と `--elevation-2` を維持する（`display/frontend/src/lib/theme.css:170-175,197`）。
- 文字は `--fg` / `--role-muted`、間隔は `--space-1`〜`--space-4`、label/value は `--type-label-xs-size` / `--type-label-s-fluid` / `--type-body-l-fluid`、数値は `--num-weight` と `NumberUnit` を使う（`theme.css:74,130,148,156,159,200-203`）。
- probability bar を使う案でも、警報・注意報色は使わない。確率は severity ではないため、neutral な `--fg` / `--role-muted` / `--hairline` の範囲で強弱を作る。

## 4. 情報設計の選択肢

### 案 I: 「どこが・何%か」を一つの結論にする（推奨）

**最初に知りたいことの想定:** 5日間に最も可能性が高い地域はどこで、何%か。

```text
暴風域に入る確率
5日積算・全地域の最大
東京地方（東京都） 80%
時間帯別ピーク開始  7月8日 09:00

府県等内の地域最大
東京都       80%    神奈川県     70%
千葉県       60%    埼玉県       50%
茨城県       40%    ほか3府県等
```

- `maxFiveDayProbability` と `worstArea` を別々に表示せず、一つの結論 block に統合する。同じ 80% の無意味な反復を一回減らす。
- label/value/area を同じ semantic group に置き、`space-between` でカード両端へ分断しない。数値は地域名の直後、または同じ stat cell の次行へ置く。
- 府県等一覧には section label として一度だけ「府県等内の地域最大」を明示する。東京都 80% の再掲は「全体最大の根拠となる府県等別内訳」なので残し、最大行を weight または細い neutral marker で識別する。
- ピーク開始は結論 block の補助行に置くが、5日積算値の日時に見えない明示 label を付ける。
- **高さ:** 現行の maximum 行と worst 行を統合できるため、同等〜約1行減を見込む。2列一覧は維持する。
- **ページ送り:** full → compact / outer rotation のリスクは現状以下。TyphoonCard 内部 pager は増やさない。
- **弱点:** 府県等比較は補助情報のままで、棒の長さによる直感的比較はない。

### 案 II: 府県等ランキングを主役にする

**最初に知りたいことの想定:** 自分の府県等と他地域の差はどの程度か。

```text
5日積算・府県等内の地域最大
東京都       ████████ 80%  ← 東京地方
神奈川県     ███████  70%
千葉県       ██████   60%
埼玉県       █████    50%
茨城県       ████     40%
ほか3府県等
時間帯別ピーク開始  7月8日 09:00
```

- 一列の確率 bar で順位と差を読みやすくし、全体最大の行だけに最大地域名を隣接させる。独立した「最大5日確率」「最大地域」行は廃止する。
- bar の 0〜100 scale は固定し、数値も必ず残す。bar だけに意味を持たせない。
- **高さ:** full の5件が現行2列の概ね3段から5段になる。label や bar の二段化を避けても約2行増、長い府県等名の折返しでさらに増える。
- **ページ送り:** 現在約308pxの card を明確に高くする。混雑時に full → compact、center 移動、outer rotation へ進む条件を増やす。高さを固定して切るのではなく、実測と omission を再検証する必要がある。
- **弱点:** 360px未満級の side 幅では、名称・bar・数値・最大地域名を一行に保ちにくい。compact 用には bar を捨てた別構造が必要になる。

### 案 III: 期間別の積算推移を主役にする（次以降の全面再設計候補）

**最初に知りたいことの想定:** 24 / 48 / 72 / 96 / 120時間のどこでリスクが増えるか。

```text
東京地方（東京都）
積算  24h  48h  72h  96h  120h
確率   0%    0%   92%   92%   92%
時間帯別ピーク開始  10月3日 03:00
```

- XML の1〜5日積算は独立した「各日の確率」ではなく、起点から各 horizon までの積算値である。表示するなら5点すべてを cumulative と明記する。24 / 48 / 72 / 120h だけを抜くと、96hの変化を隠す可能性がある。
- 「どの地域の推移か」を固定しなければならない。各 horizon の全体最大を並べると最大地域が途中で変わり、同じ対象の推移にはならない。本案では 120h の `worstArea` を固定して、その地域の5点を見せるのが最も説明しやすい。
- 現行 display protocol は `daily[0..4]` を持たず、`peakAt` の値や slot duration も持たない。本案は frontend の組み替えだけでは実現できず、projection / wire / 永続化 / tests の変更が必要になる。parser 自体には値が既にあるが、「表示改善だけでは parser や確率計算を巻き込まない」という境界を越える。
- **高さ:** 表形式でも2〜4行、chartならさらに凡例と軸が必要。府県等一覧も残すなら現行より大幅に増える。
- **ページ送り:** full card の常駐は難しくなり、内部2ページ化または outer rotation 前提の再設計が必要になる。短時間に一瞥する待機カードより detail view に向く。
- **弱点:** 「どこが最大か」より「いつ増えるか」を先にするため、ご主人が今回観測した最大値と地域の対応不明を最短では解かない。

## 5. 範囲の選択肢

工数は、実装・component test・preview fixture/capture・design spec 同期・通常 gate までを含む概算である。調査で新たな表示制約が判明した場合は変動する。

| 範囲 | 内容 | 目安 | リリース前5件に含める妥当性 |
|---|---|---:|---|
| **(a) 局所修正** | full/compact の label と数値を同じ group 内で隣接させ、`最大地域` を同じ行または直後へ移す。府県等2列の意味・構造は現状のまま | 0.5〜1人日 | 高い。緊急の可読性修正として小さい。ただし、ご主人が同時に挙げた「府県別2列と最大値・最大地域の関係」のうち、2列側を未解決で残す |
| **(b) 既存 wire 内で情報階層を再構成** | 案I。全体最大と最大地域を一つの結論にし、府県等一覧を「府県等内の地域最大」と再定義して最大行を識別、日時を明示 label 化。full/compact の双方を組み直すが、件数上限と外側 solver は維持 | 1.5〜2.5人日 | **最も妥当。推奨。** 今回の観測を一通り閉じつつ parser / projection / wire / persistence を触らず、従来の「全面再設計は次以降」も守れる |
| **(c) 全面再設計** | 案IIの高さ戦略や案IIIの期間別推移、必要なら内部 paging/detail 導線まで含める。daily vector、peak値、slot duration等を出す場合は wire と永続化を拡張 | 4〜7人日 | 低い。リリース前5件の一項目としては境界が広く、状態・protocol回帰も増える。今回は設計判断だけ残し、次以降の独立弾が安全 |

### 推奨範囲

**範囲 (b) で案Iを実装対象にする**のを推奨する。

理由は、今回の問題が単なる gap ではなく、同じ 80% を三つの集約 level に重複配置し、時間帯別ピーク開始まで無標識で隣接させた情報階層にあるためである。(a) では視線距離は直せても意味関係が残る。一方、(b) は現行 wire が既に保証する `max = worstArea = topPrefectures[0]` の関係を DOM に写し直すだけで済み、確率の算出や保存契約を変えない。(c) の期間別推移は価値があるが、表示だけの弾ではない。

実装 spec では、少なくとも次の二状態を別に確認する必要がある。

- probability-only / muted header: preview の 80%、東京都〜茨城県、東京地方、日時が意図した階層で読めること。
- VPTW + VPTA combined / normal header: VPTW の気圧・風速等と probability 結論の主従が崩れず、確率が header tone を変えないこと。

また、1280 / 960 の混雑 fixture で full → compact と outer rotation を再実測する。数値の見栄えだけを固定 screenshot で確認して終えず、最大地域名が長い場合、同率最大が複数府県等にある場合、`peakAt=null`、省略ありを component test に含めるのがよい。

## 6. 相談の問い

1. **リリース前の範囲** — A: 既存 wire 内で府県等2列まで組み直す **(b・推奨)** / B: label隣接だけの (a) に留める。
2. **最初に答える問い** — A: 「最も高い地域はどこで何%か」を結論 block にする **(案I・推奨)** / B: 「府県等ごとの差」を一列 bar で先に見せる（案II）。
3. **府県等一覧の呼び方** — A: section 見出しを「府県等内の地域最大」として各行は短くする **(推奨)** / B: 各行を「東京都内の最大 80%」のように自己完結させる。
4. **ピーク開始時刻** — A: 最大地域の直下に「時間帯別ピーク開始」と明記して残す **(推奨)** / B: 5日積算との混同を避けるため、値・durationも運べる次回全面再設計までカードから外す。
5. **期間別推移** — A: 今回は扱わず、daily vectorを含む次以降の独立設計へ送る **(推奨)** / B: リリース前に wire / 永続化まで範囲を広げて扱う。
