# 台風カード「暴風域に入る確率」ラベル隣接化 spec

> **裁定（2026-09-06 朝、ご主人）**: たたき台 §6 の問いは 1B・2A・3A・4B・5A（範囲 a）。本 spec はその実装 spec。独立 DOC レビュー（Sol high、新規 read-only スレッド）2 巡で DOC-OK。


## 1. 症状

TyphoonCard の VPTA50 表示では、全地域の最大値を示す `最大5日確率` と `80%` がカードの左右端へ分離し、同じ 80% が全体最大、府県等内最大、最大地域の三箇所へほぼ同じ強さで反復される。利用者は最初に「最も高い地域はどこで何%か」を読みたいが、現行 DOM はその地域名を府県等一覧と omission の後へ置き、数値との関係を一つの結論として示していない（`display/frontend/src/components/TyphoonCard.svelte:228-248`）。

full 表示の `.probability-maximum` は `justify-content: space-between` で label と value を両端へ押し分ける（`display/frontend/src/components/TyphoonCard.svelte:325-333`）。既存の 1280×720 capture では左端の label と 80% が約 244px 離れており、隣接性がない（`docs/specs/2026-09-06-typhoon-probability-display-options.md:62-68`）。compact も `5日以内 最大`、府県等一覧、最大地域、時刻を二つの折返し領域へ並べるため、同じ集約関係を利用者が復元しなければならない（`display/frontend/src/components/TyphoonCard.svelte:231-235,351-373`）。

本修正の目的は、次の一問へ局所的に答えることだ。

> 5日積算で最も高い地域はどこで、何%か。

後続の全面再設計を妨げないため、府県等一覧の二列構造、表示件数、period 別推移、projection / wire は作り替えない。

## 2. 根因（file:line）

### 2.1 値の意味と現行 wire

確率電文の型名は **VPTA50** である。VPTW60 / 61 / 62 は台風解析・予報、VPTA50 は「台風の暴風域に入る確率」として別の parsed type を持つ（`src/types.ts:2491-2509,2575-2595`）。処理入口も VPTA50 を probability outcome として明記する（`src/engine/presentation/processors/process-typhoon-probability.ts:41-54`）。VPTW は combined preview で header tone の根拠になる台風実況側であり、「VPTW 確率電文」とは呼ばない。

実 VPTA50 fixture `test/fixtures/76_01_01_200630_VPTA50.xml` は、地域ごとに 1〜5日積算を別 section として持つ。5日積算 section は `Duration=PT120H` / `Name=120時間先` である（`test/fixtures/76_01_01_200630_VPTA50.xml:24061-24070`）。parser は五つの積算 section を `daily[0..4]` へ格納する（`src/dmdata/typhoon-probability-parser.ts:124-131,158-176`）。したがってカードの 80% は時間帯別 series のピーク値ではなく、各地域の `daily[4]`、すなわち起点から 120 時間の積算値である。

projection は次の三段集約を行う。

1. 同じ府県等コードに属する地域の `daily[4]` の最大を `topPrefectures[].fiveDayProbability` とする（`src/engine/display/project-typhoon-probability.ts:465-479`）。府県等全体の確率を再計算した値ではない。
2. その先頭値を `maxFiveDayProbability` とする（`src/engine/display/project-typhoon-probability.ts:505-518`）。
3. `worstArea` は 5日積算、時間帯別ピーク値、最初のピーク時刻、コードの順で一地域へ決め、その `fiveDayProbability` を保持する（`src/engine/display/project-typhoon-probability.ts:390-397,420-425,519-525`）。projection state の invariant は `worstArea.fiveDayProbability === maxFiveDayProbability` と先頭府県等の最大値との一致を保証する（`src/engine/display/project-typhoon-probability.ts:315-338`）。同率最大が複数地域にある場合、カードへ出る `worstArea` はこの安定した tie-break による代表一件である。

実 fixture では大東島地方の 5日積算が 100%（`test/fixtures/76_01_01_200630_VPTA50.xml:29969-29983`）、時間帯別 series は refID 7 で 100% に達する（同 `:50524-50544`）。projection の固定期待値は全地域最大 100%、最大地域「大東島地方」100%、active 府県等 45 としている（`test/fixtures/typhoon-probability-card/expectations.json:2-24`）。この実電文経路は既存 test が parser から projection まで通している（`test/engine/display/project-typhoon-probability.test.ts:21-55,94-111`）。

VPTA50 の永続化は `typhoon-numeric-persistence.ts` ではなく Standby persistence / state store が担う。reader は top prefecture、`maxFiveDayProbability`、`worstArea.fiveDayProbability` の一致を再検証してから復元する（`src/engine/display/standby-persistence.ts:3871-3899,3916-3976`）。state store は復元 state から display probability wire を作り（`src/engine/display/standby-state-store.ts:2560-2584`）、同じ probability projection を export する（同 `:2749-2764`）。probability-only / combined の round-trip と復元後 card は専用 test が覆う（`test/engine/display/standby-persistence-vpta.test.ts:32-48,194-220`、`test/engine/display/standby-state-store-vpta.test.ts:101-135,224-246`）。

wire は full grid や `daily[0..4]` を渡さず、全体最大、active 府県等数、上位府県等、最大地域と `peakAt` だけを渡す（`display/frontend/src/lib/protocol.ts:968-995`）。本修正はこの wire だけで成立する。

### 2.2 読みづらさを作る DOM / CSS

現行 full DOM は、全体最大、府県等一覧、omission、最大地域、peak を別々の sibling として並べる（`display/frontend/src/components/TyphoonCard.svelte:237-248`）。`.probability-maximum` と `.probability-worst` はともに `space-between` で label と値を離す（同 `:325-330`）。府県等の各 `li` も `space-between` を使う（同 `:335-345`）。このため、値が同じ semantic group に入っていても視覚上は隣接しない。

compact は全体最大と府県等一覧を `.probability-compact-summary` に詰めた後、最大地域と peak を `.probability-worst--compact` へ連結する（`display/frontend/src/components/TyphoonCard.svelte:231-235`）。full / compact とも「全体最大の値」と「その値を持つ代表地域」が別 block であり、同じ値を重複描画する。

`worstArea.peakAt` は最大地域の時間帯別 series が最大になった最初の slot の開始時刻であり、5日積算値の発生時刻ではない（`src/engine/display/project-typhoon-probability.ts:390-397,420-425`）。wire は slot duration と peak 値を持たず開始時刻だけを持つ（`display/frontend/src/lib/protocol.ts:978-995`）。ところが現行 full の `.probability-peak` には visible label がなく、compact では最大地域と同じ文へ日時だけを続ける（`display/frontend/src/components/TyphoonCard.svelte:234,246-247`）。これが 5日積算との誤読を生む。

### 2.3 高さと外側 solver

TyphoonCard 自身に pager はない。StandbyScreen は side / center の measurement shelf へ各 variant と live と同じ component DOM を描画し（`display/frontend/src/components/StandbyScreen.svelte:2106-2150`）、`data-live-border-box` があれば `max(rect.height, scrollHeight)`、なければ外側の border-box rect を自然高として読む（同 `:1046-1056`）。その値が solver の `CardCandidate.naturalHeight` と rotation slot reserve に使われる（同 `:569-576`）。shelf と live は同じ side / center 幅を使う（同 `:2244-2269`）。

solver は実高により配置を決め、Typhoon の compact → full promotion も収容可能性で判定する（`display/frontend/src/lib/legacy-standby/solver.ts:89-120,148-170`）。したがって結論 block の自然高が一行変わるだけでも full / compact、placement、rotation に影響し得る。probe / live の DOM と CSS を分岐させて高さを見積もってはならない。

## 3. 変更

### 3.0 Phase 0 申告

実装者は DOM / CSS を変更する前に、同じ変更記録または実装メモへ次を宣言する。

- **対象 surface**: TyphoonCard 内の VPTA50 probability section の full / compact。カード shell、台風実況部、header、外側 solver は対象外。
- **錨カード / pattern**: LatestQuakeCard の `.meta > .stat > .stat-label + .stat-value`。一つの意味単位で label と value を縦に隣接させる DOM と typography に倣う（`display/frontend/src/components/LatestQuakeCard.svelte:275-288,421-434`）。TyphoonCard 自身の shell / header / `NumberUnit` と、府県等表示上限 / omission は維持する（`display/frontend/src/components/TyphoonCard.svelte:141-142,228-250,255-257`、`docs/specs/display-design-system.md:237`）。
- **共通 header / footer**: `.standby-card-header` の padding、type、semantic 三変数、muted 契約は一切変えない（`display/frontend/src/lib/theme.css:280-313`）。TyphoonCard に card pager footer はなく、新設しない。共通 footer 契約も変更しない（同 `:315-334`）。
- **surface / shape token**: `--surface-standby`、`--hairline`、`--radius-standby`、`--elevation-2` を現状の shell のまま使う（`display/frontend/src/lib/theme.css:168-175,195-203`、`display/frontend/src/components/TyphoonCard.svelte:255-257`）。
- **文字 / spacing token**: `--fg`、`--role-muted`、`--space-1`〜`--space-4`、`--type-label-xs-size`、`--type-label-s-fluid`、`--type-body-l-fluid`、`--type-body-s-fluid`、`--num-weight` と `NumberUnit` だけを使う（`display/frontend/src/lib/theme.css:32,74,123-130,142-159,199-203`）。新しい token、primitive 色、負 margin、生の spacing px は追加しない。
- **高さ contract**: side / center shelf と live に同一 component DOM / CSS を描画し、border-box 実高を solver へ渡す現行 contract を維持する（`display/frontend/src/components/StandbyScreen.svelte:1046-1056,2106-2150,2262-2269`）。固定高、clip、scroll で差分を吸収しない。
- **検証基準**: DOM の隣接性、実 rect 間隔、自然高、full / compact、header tone、placement、rotation、omitted、overflow を before / after で採る。画像だけで受入にしない。

### 3.1 裁定 1B / 2A: 局所的な結論 block

範囲は (a) とする。full / compact の双方で、独立した「全体最大」と「最大地域」を一つの `.probability-conclusion` に置き換える。新しい detail view、bar、map、pager、府県等二列の再構成は行わない。

結論 block の可視順と direct-child 構造は次で固定する。

```text
div.probability-conclusion
├─ span.probability-conclusion-label  「5日積算・全地域の最大」
└─ div.probability-conclusion-result
   ├─ span.probability-conclusion-area  「東京地方（東京都）」
   └─ span.probability-number
      └─ NumberUnit                    「80%」
```

`.probability-conclusion-label + .probability-conclusion-result` と `.probability-conclusion-area + .probability-number` はそれぞれ直接隣接 sibling とする。result は area と `%` の間を `gap: var(--space-2)` とする wrapping flex とし、`justify-content: space-between`、`margin-left:auto`、固定幅で離してはならない。label と result は `gap: var(--space-1)` の縦組みにする。長い地域名は area 側で折返せるが、`NumberUnit` 内の数値と `%` は分断しない。

表示する確率値の source には次の選択肢がある。

- **A（採用・推奨）**: `worstArea.fiveDayProbability`。地域名と同じ object の値を一つの結論にし、area/value が不整合な synthetic input でも別 object の値を混ぜない。`maxFiveDayProbability` との一致は projection invariant と test で守る。
- **B（不採用）**: `maxFiveDayProbability`。全体最大という label には直接対応するが、表示地域は `worstArea` から取るため、二つの object を一つの visible fact に混ぜる。

現行の `.probability-maximum` と `.probability-worst` は full / compact とも DOM からなくす。同じ 80% の結論内反復は一回だけにする。full の probability number は結論1件 + 府県等5件で最大6件、compact は結論1件 + 府県等3件で最大4件となる。

### 3.2 裁定 3A: 府県等一覧は見出しを付け、二列を維持

結論 block の直後に、visible section heading `h4.probability-prefecture-heading` を一つ置き、文言を厳密に **「府県等内の地域最大」** とする。各行は従来どおり `府県等名 + fiveDayProbability` だけとし、「東京都内の最大」のような反復文へ変えない。`h4` の browser default margin は使わず、既存 type / spacing token だけで明示する。

full の `.probability-prefecture-list` は現在の auto-fit / `minmax(min(100%, 8rem), 1fr)` と最大5件を維持する（`display/frontend/src/components/TyphoonCard.svelte:335-345`）。府県等二列を一列 ranking や bar へ再構成しない。ただし各 `li` 内は府県等名と `.probability-number` を direct adjacent sibling にし、`justify-content: flex-start` と `gap: var(--space-2)` で隣接させる。列そのものの二列 grid と row / column gap は変えない。

compact は現行の最大3件と wrapping flex を維持し、見出しの直後へ `.probability-prefectures` を置く（`display/frontend/src/components/TyphoonCard.svelte:115-122,231-235,361-368`）。各府県等名と値は同じ child 内の adjacent sibling とし、omission を prefecture item と数えない。full / compact とも残件は既存計算の `ほかN府県等` をそのまま可視化する。

### 3.3 裁定 4B: ピーク開始時刻を DOM から外す

「カードから外す」には次の選択肢がある。

- **A（採用・推奨）**: `.probability-peak` と compact 内の日時 text を render branch から削除し、DOM / accessible name の双方から外す。不要になる `formatJstDateTime()` と peak 用 CSS も削除する。
- **B（不採用）**: node を残して `hidden` または CSS 非表示にする。`hidden` は通常 accessibility tree からも外れるが、不要 DOM と selector contract を残し、CSS 上書きで再露出する余地がある。今回の「次回再設計までカードから外す」という裁定には A の方が明確である。

wire / projection / persistence の `worstArea.peakAt` は変更しない。将来、時間帯別 peak 値と slot duration を一緒に運べる全面再設計で再検討する。既存 component test の「JST 表示」「null はピーク時刻不明」は、仕様変更理由を test 名またはコメントへ残した上で、full / compact の DOM、可視 text、section accessible name に日時も「ピーク時刻不明」も存在しない期待へ置き換える（現行期待: `display/frontend/src/components/__tests__/typhoon-card.test.ts:635-652`）。

### 3.4 裁定 5A: 期間別推移は扱わない

`daily[0..4]`、時間帯別 series、peak 値、slot duration は frontend へ追加しない。parser、projection、wire、永続化、通知は変更しない。24 / 48 / 72 / 96 / 120h の積算推移、時間帯別 chart、府県等 ranking の全面再設計は次以降の独立 spec へ送る。

### 3.5 full / compact の完成形

full は次の情報順とする。

```text
暴風域に入る確率（5日以内）
5日積算・全地域の最大
東京地方（東京都） 80%
府県等内の地域最大
東京都 80%    神奈川県 70%
千葉県 60%    埼玉県 50%
茨城県 40%
ほか3府県等
```

compact は同じ意味順を保ち、府県等一覧だけ最大3件の既存 wrapping flex とする。compact だから結論 label、地域名、section heading を省略してはならない。

現行 full では maximum、worst、peak の三段があり、本案では conclusion の label + result と府県等 heading の三段へ置き換わる。このため full の自然高は概ね同等を見込む。compact は peak 文字列を除き conclusion label / result と見出しを明示するため、折返し次第で同等〜一行増の可能性がある。これは CSS 見積りで固定せず §5 の shelf / live 実測を正本とする。高さを抑えるために label、地域名、omission を削らない。

### 3.6 preview / capture の更新方針

表示値の意味は実 VPTA50 fixture とその projection 期待値で検証し、画面 geometry は既存 preview fixture で検証する。両者を混同しない。

- **実電文経路**: `test/fixtures/76_01_01_200630_VPTA50.xml` と `test/fixtures/typhoon-probability-card/expectations.json` を使う既存 projection test を通し、5日積算100%、最大地域「大東島地方」100%、府県等内最大の導出を維持する（`test/engine/display/project-typhoon-probability.test.ts:94-111`）。fixture / expectation は変更しない。
- **preview 経路**: `#standby-vpta50-probability-muted` と `#standby-vpta50-probability-normal` は同じ固定 probability payload を使い、VPTW 実況の有無だけを変える現行 contract を維持する（`display/frontend/src/preview/fixtures.ts:2352-2367,2403-2411`、`display/frontend/src/preview/PreviewApp.svelte:75-89,338-347`）。80% は geometry 用の preview 値であり、実電文由来と記述しない。
- **混雑経路**: `#standby-design-alignment-compressed` の固定 payload と 1280×720 `legacy-standby-gate max` を使い、compact Typhoon と外側 solver を捕捉する。既存 manifest は 1920×1080 / 1280×720 の max plan と 1280×720 / 960×620 の compressed plan を持つ（`display/scripts/capture-legacy-standby.mjs:1040-1084,1323-1341`）。本件の必須比較は真の viewport 1920×1080 と 1280×720 とし、960×620 は既存 gate 回帰として残す。

capture collector は現行の `maximum / prefecture / worst` 三 role から `conclusion / prefecture` 二 role へ更新し、結論の label、area、number、隣接 rect と peak 不在も記録する（現行 collector: `display/scripts/capture-legacy-standby.mjs:1573-1609`、現行 assertion: 同 `:2276-2330`）。before report は旧 selector で取得した値を保持し、after report と比較可能な共通項として card natural height、layout、rotation、omitted、overflow を残す。

center へ置かれた Typhoon の live instance は現行 manifest にない。単独 VPTA scenario は right、compressed scenario は rotation であり、1280×720 compressed の center は weather である（`display/frontend/src/preview/fixtures.ts:2403-2411`、`display/scripts/capture-legacy-standby.mjs:1061-1083,1323-1341`）。この局所修正のためだけに solver 入力を増やした専用 scenario は作らない。動的な probe / live 高さ比較は実際に捕捉できる side / rotation に限定し、center は次を組み合わせて検証する。

- side / center shelf と side / center live はいずれも同じ `renderCard` snippet を呼び、Typhoon branch は placement / measuring による別 DOM を持たないことを source test で固定する（`display/frontend/src/components/StandbyScreen.svelte:1852-1854,1940,2106-2150,2203-2225`）。
- center shelf と center track の実幅を capture し、1px以内で一致させる。両者は同じ `--center-width` を正本にする（`display/frontend/src/components/StandbyScreen.svelte:2262-2283`）。center shelf の Typhoon full / compact border-box 高さは finite かつ正で、`liveBorderBoxHeight()` と同じ測定関数を通ることを確認する（同 `:1046-1056,2145-2150`）。

### 3.7 独立 DOC レビュー指摘の処置

1. **center 配置の probe / live 高さ経路 — a) 採用。** 現行 manifest に center live がないという指摘を採用し、§5.3.4 を side / rotation の動的比較と center の同一 render path / 同幅 / 正の shelf 実高検査へ分割する。専用 center scenario の追加は、範囲 (a) に不要な solver fixture 調整を持ち込むため採らない。
2. **許容レイアウト変化と固定 manifest の矛盾 — a) 採用。** rotation の短縮と compact → full 昇格を許す旧記述を撤回し、placement、rotation keys / tick、Typhoon variant、compressed / stage、omitted を before / after で完全一致させる。現行 gate と同じ比較可能性を維持する。
3. **VPTA50 永続化ファイルの漏れ — a) 採用。** `typhoon-numeric-persistence.ts` を検証対象から外し、実際の保存・sanitize・復元・wire 化を担う `standby-persistence.ts`、`standby-state-store.ts` を §2.1 / §4.2へ、VPTA 専用 test を §4.1 / §5.3へ加える。
4. **VPTA50 / VPTW と `--fg` の引用不足 — a) 採用。** `src/types.ts`、probability processor、`theme.css:32` の直接根拠を §2.1 / §3.0へ追加する。
5. **復元後 invariant の明示 assertion 不足 — a) 採用。** オブジェクト全体の round-trip 一致や `maxFiveDayProbability` 単独確認だけでは三値 invariant の受入根拠にならない。VPTA 専用2テストを「有効な復元 card に対する必要な invariant assertion の追加に限り変更可」へ移し、復元後の三値を個別の path で同じ既知 literal と相互に一致すると直接 assert する。

## 4. 対象ファイル

### 4.1 実装時に変更してよいファイル

- `display/frontend/src/components/TyphoonCard.svelte` — probability DOM / CSS と不要な時刻 formatter の削除。
- `display/frontend/src/components/__tests__/typhoon-card.test.ts` — full / compact の結論 DOM、隣接、件数、見出し、peak 不在、header tone、omission の期待更新。
- `display/scripts/capture-legacy-standby.mjs` — Typhoon probability collector、before / after 比較、隣接距離、自然高、rotation / omitted / overflow assertion の更新。
- `display/frontend/src/components/__tests__/capture-contract.test.ts` — capture helper の公開 assertion や schema に変更が生じる場合だけ最小更新。
- `test/engine/display/standby-persistence-vpta.test.ts` — probability-only / combined の有効な復元 card について、三値 invariant の直接 assertion を追加する場合だけ変更可。fixture、保存形式、復元処理、既存期待は変えない。
- `test/engine/display/standby-state-store-vpta.test.ts` — 有効な永続状態から復元して得た display wire について、同じ三値 invariant の直接 assertion を追加する場合だけ変更可。不正状態 test や state-store 挙動は変えない。

### 4.2 検証に使うが変更しないファイル

- `test/fixtures/76_01_01_200630_VPTA50.xml`
- `test/fixtures/typhoon-probability-card/expectations.json`
- `test/engine/display/project-typhoon-probability.test.ts`
- `display/frontend/src/preview/fixtures.ts`
- `display/frontend/src/preview/PreviewApp.svelte`
- `display/frontend/src/lib/protocol.ts`
- `src/dmdata/typhoon-probability-parser.ts`
- `src/engine/display/project-typhoon-probability.ts`
- `src/engine/display/standby-persistence.ts`
- `src/engine/display/standby-state-store.ts`
- `docs/specs/display-design-system.md`
- `display/frontend/src/lib/theme.css`
- `display/frontend/src/components/StandbyScreen.svelte`
- `display/frontend/src/lib/legacy-standby/solver.ts`

preview scenario / payloadが既存 selector では受入値を捕捉できないことが実装前 capture で判明した場合だけ、`display/frontend/src/preview/fixtures.ts`、`display/frontend/src/preview/PreviewApp.svelte` と対応 preview test の最小更新を許す。ただし center 専用 scenario は追加せず、§3.6 / §5.3.4 の分割した検証で閉じる。新しい production wire、`gateFixture`、強制 compact / 圧縮 query は作らない。

## 5. 受入条件

### 5.1 DOM / 可視内容 / accessibility

`display/frontend/src/components/__tests__/typhoon-card.test.ts` で少なくとも次を機械検証する。

1. full / compact とも probability section は一つで、既存 `aria-label="暴風域に入る確率（5日以内）"` を維持する（現行契約: `display/frontend/src/components/__tests__/typhoon-card.test.ts:673-680`）。
2. 各 probability section に `.probability-conclusion` が厳密に一つある。その direct children は順に `.probability-conclusion-label` と `.probability-conclusion-result` の二つだけで、前者の text は `5日積算・全地域の最大` である。
3. `.probability-conclusion-result` の direct children は順に `.probability-conclusion-area` と `.probability-number` の二つだけである。preview fixture では area が `東京地方（東京都）`、NumberUnit が `80%` であり、`.nu-value + .nu-unit` が一組、unit は `%` である。
4. `.probability-maximum`、`.probability-worst`、`.probability-peak` は full / compact とも 0 件である。可視 text と probability section の accessible name に `7月21日 09:00`、`ピーク時刻不明`、preview の `7月8日 09:00` を含めない。
5. `h4.probability-prefecture-heading` は full / compact とも厳密に一つで、text は `府県等内の地域最大` である。見出しは DOM / accessibility tree から隠さない。
6. full は `.probability-prefecture-list li` が最大5件、compact は `.probability-prefectures` の prefecture item が最大3件。fixture の active 8件に対し omission はそれぞれ `ほか3府県等` / `ほか5府県等` であり、現行件数計算を維持する（現行期待: `display/frontend/src/components/__tests__/typhoon-card.test.ts:586-600`）。
7. full の各 `li`、compact の各 prefecture item は「府県等名 sibling の直後に `.probability-number`」の構造を持つ。結論を含む NumberUnit 数は full 6、compact 4 とする。府県等名・順序・wire order は変えない。
8. `maxFiveDayProbability !== worstArea.fiveDayProbability` の不正 synthetic payload を通常の fixture として正当化しない。component fixture は invariant を満たし、複数台風 test も各 slice の両値を揃えてから結論値を確認する（現行の片側だけを変える fixture: `display/frontend/src/components/__tests__/typhoon-card.test.ts:683-699`）。
9. probability-only は muted header、combined は VPTW 実況由来の header tone のままで、確率 1 / 50 / 100% が tone を変えない（`display/frontend/src/components/__tests__/typhoon-card.test.ts:558-584,654-680`）。

旧 peak test を理由なく削除して test 数だけ減らしてはならない。裁定 4B による「full / compact / null peak のいずれも非描画」を明記した負の test へ置き換える。

### 5.2 CSS と隣接距離

source test と browser capture の双方で次を検査する。

- `.probability-conclusion` は縦方向の `gap: var(--space-1)`、`.probability-conclusion-result` と府県等 item は `gap: var(--space-2)` を使う。結論 / 府県等 item に `justify-content: space-between`、`margin-left:auto`、固定 width、負 margin、生の spacing px がない。
- full の `.probability-prefecture-list` は既存の auto-fit 二列定義と `gap: var(--space-1) var(--space-3)` を維持する。compact の prefecture container は wrapping flex を維持する。bar、grid 列の追加、scroll はない。
- browser で label と result の rect を採り、`max(0, result.top - label.bottom) <= resolved(--space-1) + 1px` とする。標準 preview の area と number が同一 visual lineなら `max(0, number.left - area.right) <= resolved(--space-2) + 1px`、折返した場合は number の top が area の最終 line bottom から `resolved(--space-2) + 1px` 以内である。府県等名と number も同じ規則で測る。単なる DOM 隣接だけでは合格にしない。
- `.probability-number`、`.nu-value`、`.nu-unit` の client / scroll overflow は各軸 0（計測誤差1px以内）で、数値と `%` は一 visual lineである。`.nu-value` の weight は card で解決した `--num-weight` と一致する（既存 assertion: `display/scripts/capture-legacy-standby.mjs:2276-2301`）。
- card shell、共通 header の computed padding / color / band、UpdatedStamp、RestoredChip は before と一致する。新しい footer は 0 件である。

### 5.3 実電文、preview、before / after capture

capture collector を旧 DOM / 新 DOM の両方を読める additive schema に先に更新し、固定 manifest を確定する。その状態で表示 DOM 変更前に baseline、変更後に同じ collector、同じ manifest key、Chrome、font、URL、真の viewport で after を採る。manifest と期待 plan は baseline 採取後に変更しない。既存一括 gate を使う（`docs/specs/2026-09-05-standby-card-design-alignment.md:526-535`、現行 manifest 完全一致: `display/scripts/capture-legacy-standby.mjs:1928-1937`）。

```sh
node display/scripts/capture-legacy-standby.mjs --suite design-alignment --report \
  --write-baseline /tmp/fleq-typhoon-probability-label-base.json
node display/scripts/capture-legacy-standby.mjs --suite design-alignment --report \
  --baseline-report /tmp/fleq-typhoon-probability-label-base.json
```

必須条件は次のとおり。

1. `Emulation.setDeviceMetricsOverride` で測定した document viewport が厳密に 1920×1080 / 1280×720 で、root computed font-size は16px、`document.fonts.ready` 後かつ `data-measurement-settled=true`、`data-measurement-nonconverged=false` である。960×620 の既存 compressed cell も回帰 gate として通す。
2. 1920×1080 と 1280×720 の `legacy-standby-gate max`、1280×720 の `#standby-design-alignment-compressed`、1280×720 の muted / normal VPTA scenario を before / after の同じ manifest key で比較する。Typhoon が rotation member の cell はその active tick まで進め、live DOM を捕捉する。
3. after の `data-layout-unresolved=false`、card overflow count 0、readable overflow key 0、footer overlap 0を満たす（現行 diagnostics: `display/frontend/src/components/StandbyScreen.svelte:1465-1498,1501-1525`）。probability section と全 child の overflow も0とする。
4. **捕捉可能な live 高さ**: side の単独 VPTA scenario と rotation の compressed scenario では、対応する Typhoon shelf probe / live が同じ display mode、DOM role、computed CSS を使い、幅と border-box 実高の差を1px以内とする。probe 専用の label 省略や peak 復活を認めない。**center の静的 / shelf contract**: source test で side / center shelf と live center が同じ `renderCard` snippet / Typhoon branch を通り、placement / measuring による Typhoon DOM 分岐がないことを確認する（`display/frontend/src/components/StandbyScreen.svelte:1852-1854,1940,2106-2150,2203-2225`）。capture では center shelf / center track 幅が1px以内、center shelf の Typhoon full / compact border-box 高さが finite かつ正であることを確認する。center live との高さ一致を捕捉したとは報告しない。
5. `data-ladder-stage`、`data-measurement-geometry-stage`、compressed、side-left / side-right / center placement と順序、rotation keys と順序 / tick / active key / position、Typhoon variant、visible cards は baseline と after で完全一致する。`rotationOmittedCount`、visible card の omitted / failure countも完全一致し、現行 baseline 0なら0とする。subsequence、rotation 短縮、compact → full 昇格を許容しない（現行固定 plan: `display/scripts/capture-legacy-standby.mjs:2049-2084`、現行比較 policy: 同 `:2447-2471`）。差が出た場合は期待表や manifest を更新して通さず、本実装を停止して実測差を報告する。
6. probability 内の `ほかN府県等` は before と完全一致する。full / compact variant も固定するため、表示件数は full 5件 / `ほか3府県等`、compact 3件 / `ほか5府県等` のままとする。
7. muted / normal preview は conclusion / prefecture の visible 値が同一で、header だけが既存契約どおり異なる。full の conclusion は1件、prefectureは5件、peakは0件。compressed compact は conclusion 1件、prefecture 3件、peak 0件である。
8. 実 VPTA50 projection test は fixture / expectations 無変更で成功する。加えて `test/engine/display/standby-persistence-vpta.test.ts` の combined を含む有効な復元 card と、`test/engine/display/standby-state-store-vpta.test.ts` の有効な復元後の display wire について、`topPrefectures[0].fiveDayProbability`、`maxFiveDayProbability`、`worstArea.fiveDayProbability` をそれぞれ個別に同じ既知 literal へ `expect` し、三値の相互一致も直接 assert する。オブジェクト全体の round-trip 一致または `maxFiveDayProbability` 単独 assertion を代用にしない。変更はこの assertion 追加に限り、fixture、永続化形式、復元処理、既存の不正状態 test は変更しない。capture report / screenshot 上では preview の 80% を「実電文値」と記録せず、`payloadSignature` として区別する。

### 5.4 test / build gate

実装完了には次をすべて成功させる。

```sh
npm run build
npm test
npm run display:build
npm run display:test
npm --prefix display run typecheck
npm --prefix display run docs:design:check
git diff --check
```

永続化、共有状態、module scope の可変状態を変更しないため `npm run test:shuffle` は必須にしない。それらへ範囲が広がった場合は本 spec 逸脱として停止し、裁定後に `npm run test:shuffle` を追加する。

## 6. 裁定ラベル

- **対象**: TyphoonCard の VPTA50 probability full / compact における結論 block、label / value 隣接、見出し「府県等内の地域最大」、peak 表示除去、side / rotation の probe-live と center の静的 / shelf contract、固定 manifest の before-after、VPTA50 projection / persistence / restore 検証、理由付き component test 更新。
- **許容変更**: `TyphoonCard.svelte` の probability DOM / CSS と未使用 formatter、対象 component test、capture script の旧新両対応 Typhoon collector / assertion / before-after policy。VPTA 専用 persistence / state-store test は、有効な復元 card / display wire の三値 invariant を個別に直接 assert する追加だけを許す。既存 preview で捕捉不能と事前実測された場合だけ既存 scenario の fixture / route / test を最小更新する。
- **禁止変更**: parser、確率計算、projection、wire、永続化、通知、header tone / severity、NumberUnit 本体、theme token 値、共通 header / footer、StandbyScreen / solver、center 専用 scenario、府県等二列の列構造、5 / 3件上限、omission 計算、bar / map / period 推移 / pager / detail view、新しい production API、固定高、clip、scroll、負 margin、生の spacing px、baseline 採取後の manifest /期待 plan 更新、rotation 短縮、compact → full 昇格。
- **配送先（main → personal → Pi）**: main で §5 を受入後、同一差分を personal、Pi の順に配送する。各段で component / build gate を通し、Pi では真の 1920×1080 と 1280×720 で conclusion の隣接、peak 不在、overflow 0、placement / rotation / variant / omitted の baseline 完全一致を確認する。main だけで止めない。
- **ロールバック**: 本弾の単一実装 commit を revert し、main → personal → Pi の順に再配送する。wire / persistence は変更しないため data migration は行わない。
- **受入条件**: §5.1 の厳密 DOM と peak 不在、§5.2 の token / rect 距離、§5.3 の実 VPTA50 と preview の分離、真の 1920×1080 / 1280×720 before-after、side / rotation の probe-live 一致、center の同一 path / 同幅 / 正の shelf 実高、placement / rotation / variant / omitted の完全一致、VPTA50 persistence / restore invariant、overflow 0、§5.4 の全 gateを満たし、未申告の範囲拡大がないこと。
