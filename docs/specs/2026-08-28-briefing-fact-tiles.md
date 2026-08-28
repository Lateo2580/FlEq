# BriefingCard 本文の構造化表示 — 案 C 改訂仕様

## 1. 症状

BriefingCard の本文は、現象 lead、対象地域、観測 fact が独立した文字列として並ぶ。そのため、記録的短時間大雨情報で重要な「どこで」「何ミリの雨が」「いつ頃」が一見して結び付かない。

VPBS50 の記録雨は parser 内で地点・数値・単位・観測時刻を取得済みだが、Card では一行文字列へ戻している。

VPOA50 は structured mode でも lead と対象都道府県だけを表示する。Headline.Text 内の地点・時刻・雨量表現は fact 化されず、structured mode が headline を描画しないため、本文から欠落する。

## 2. 根因

VPBS50 の記録雨は `PrecipitationPart` に、地点（Area または Station）、数値、単位、時刻が構造化されている。美幌町では `100 mm`・`13:10`、美幌では `93 mm`・同時刻が別 Item として得られる。

時間幅は `Precipitation@type` の「前1時間解析雨量」等に埋め込まれている。現在の parser は `description` を優先して「約100ミリ」とし、時間幅と「約」等の条件を独立 field として保持しない。

VPOA50 corpus では、地点・時刻・雨量は Headline.Text の自由文にのみ存在する。Body は発表状態と都道府県 Area の照合用であり、雨量 fact を提供しない。VPOA50 を数値タイルへ正規化してはならない。

## 3. 変更

### 3.1 VPBS50 数値タイル

VPBS50 の precipitation fact は、1観測地点ごとに不可分の stat grid として表示する。表示順は固定する。

- 地点: `美幌町`
- 雨量: `約 100 mm`
- 時刻: `13:10`
- 時間幅: `1時間`

地点は必ず構造化 field `locationName` をそのまま表示する。「付近」は付加しない。

雨量の数値と単位は既存の `NumberUnit` を使用する。数値を主役とし、「約」は前置、「以上」は後置として保持する。`value` と `unit` がともに有効な場合だけ NumberUnit を描画する。

StatsGrid の共通部品化は行わない。TyphoonCard は一切変更しない。BriefingCard 内へ TyphoonCard の次の最小スタイル規則だけを複製する。

- `.meta`: auto-fit grid、9rem 下限、既存 spacing
- `.stat`: 縦組み、最小幅 0
- `.stat-label`: muted 小見出し
- `.stat-value`: wrap 可、tabular-nums、数値強調
- `.stat-token`: 数値と単位を分断しない
- `.stat-unit`: 小さい単位表示

BriefingCard 側の class 名は衝突を避け、`.briefing-fact-grid`、`.briefing-fact-stat`、`.briefing-fact-label`、`.briefing-fact-value`、`.briefing-fact-token` とする。TyphoonCard の DOM、CSS、テスト、受入条件は本変更の対象外とする。

線状降水帯の event fact は数値タイルにしない。地点・現象状態・時刻を一つの atomic な強調行として表示する。

- 発生例: `西部　発生　02:50`
- 予測例: `東部　予想　04:40`

地点と時刻を `<strong>`、発生／予想をラベルとして描画する。対象地域ブロックは従来どおり残すが、event fact 単体でも「どこで／いつ」が分かることを要件とする。

### 3.2 parser と wire の拡張

`WeatherObservation` は新規 parser 出力として、次を必須 field で持つ。

```ts
export type BriefingApproximation =
  | "approx"
  | "atLeast"
  | "exact"
  | "unknown";

export interface WeatherObservation {
  // 既存 field
  partKind: "event" | "precipitation" | "snowfall" | "other";
  observationType: string;
  description: string;
  value: number | null;
  unit: string | null;
  time: string | null;
  locationName: string | null;
  locationCode: string | null;
  sourceType: string | null;
  contextTime: string | null;

  // 新規 parser field
  duration: string | null;
  approximation: BriefingApproximation;
}
```

`duration` は `Precipitation@type` から認識できる時間幅を正規化して保持する。例として「前１時間解析雨量」「前１時間降水量」は `1時間` とする。認識不能時は `null` とし、推測はしない。

`approximation` は XML の `condition` 属性を優先し、必要な場合だけ description の定型表現から補う。

- `condition="約"` または `description` が「約Nミリ」: `"approx"`
- `description` が「Nミリ以上」: `"atLeast"`
- 条件なしで明確な数値: `"exact"`
- 判定不能: `"unknown"`

表示 wire の union は event/snowfall と precipitation を分離する。

```ts
export type DisplayBriefingEventFactV1 = {
  kind: "event";
  label: "発生" | "予想";
  areaName: string | null;
  areaCode: string | null;
  at: string | null;
};

export type DisplayBriefingPrecipitationFactV1 = {
  kind: "precipitation";
  locationName: string | null;
  locationCode: string | null;
  description: string;
  value: number | null;
  unit: string | null;
  at: string | null;

  // wire v2。旧 wire との互換のため optional。
  duration?: string | null;
  approximation?: BriefingApproximation;
};

export type DisplayBriefingSnowfallFactV1 = {
  kind: "snowfall";
  locationName: string | null;
  locationCode: string | null;
  description: string;
  value: number | null;
  unit: string | null;
  at: string | null;
};

export type DisplayBriefingFactV1 =
  | DisplayBriefingEventFactV1
  | DisplayBriefingPrecipitationFactV1
  | DisplayBriefingSnowfallFactV1;
```

新規 producer は precipitation fact に `duration` と `approximation` を必ず書き込む。wire consumer は旧 shape を受理する。すなわち `duration` と `approximation` の未定義だけを理由に summary を invalid としてはならない。

runtime guard の要件は次のとおりとする。

```ts
function validPrecipitationFact(value: unknown): value is DisplayBriefingPrecipitationFactV1 {
  // 既存の kind/location/description/value/unit/at の型を検証する。
  // duration が存在するなら string | null。
  // approximation が存在するなら union の4値のみ。
  // duration / approximation が absent の旧 shape は valid。
}
```

`duration: 1`、`approximation: "roughly"` 等の型・語彙破損は summary を invalid とし、既存どおり entry 全体の `rawHeadlineFallback` を選ぶ。

### 3.3 VPBS50 欠損時の fail-open

欠損時の単位は fact または stat cell とし、値不足だけで entry 全体を raw fallback にしてはならない。

| 欠損・状態 | 描画 | 他 fact への影響 |
|---|---|---|
| `value` または `unit` が null | 当該 precipitation fact のみ従来文字列 fallback。`location description / time` の既存表示を使う | 他 precipitation fact は stat grid を継続 |
| `locationName` が null | 当該 grid の「地点」stat だけ省略 | 雨量・時刻・時間幅 stat は継続 |
| `at` が null | 当該 grid の「時刻」stat だけ省略 | 地点・雨量・時間幅 stat は継続 |
| `duration` が null または旧 wire で absent | 当該 grid の「時間幅」stat だけ省略 | rich grid を継続 |
| `approximation === "unknown"` または旧 wire で absent | 雨量の約／以上修飾だけ省略。数値・単位 stat は継続 | 他 stat は継続 |
| `description` が空、または既存必須 field の型が不正 | 既存 `validSummary` 判定に従い entry 全体を `rawHeadlineFallback` | 既存挙動 |
| parser 自体が対象外・必須 Head 不正 | 既存処理どおり parser failure / raw fallback | 既存挙動 |

「タイル構成が縮む」とは stat cell 単位の省略であり、残った stat cell を表示順のまま詰めて描画することを指す。`value/unit` 欠損時だけは数値の意味を偽らないため、grid ではなく当該 fact 全体を従来文字列へ戻す。

### 3.4 VPOA50 の本文復活と tokenizer

VPOA50 の structured mode は headline 本文を必ず描画する。VPOA50 は precipitation fact を持たず、数値 stat grid を一切描画しない。

Tokenizer は表示専用である。wire、parser、永続 state に VPOA50 の数値解析結果を追加しない。原文文字列を改変せず、安全に認識できた範囲だけを `<strong>` へ分割する。

正規化は照合専用コピーに対して行う。原文の NFKC 化結果を表示してはならない。

```ts
type NormalizedOffset = {
  normalizedStart: number;
  normalizedEnd: number;
  sourceStart: number;
  sourceEnd: number;
};
```

Tokenizer は原文を code point 単位で走査し、NFKC 後の各文字範囲を原文 offset へ対応付ける。正規表現の match が原文への連続した offset 範囲へ戻せない場合、その match は捨てる。

照合対象は次に限定する。ここで数字は NFKC 後の ASCII 数字とする。

```ts
// 「1時間」を時刻と誤認しないため、時の直後に「間」を許容しない。
const timePattern =
  /(?<![0-9])(?:[0-1]?[0-9]|2[0-3])時(?:[0-5]?[0-9]分)?(?!間|[0-9])/gu;

// 時間幅がある場合は表現全体を強調する。
const rainfallPattern =
  /(?:[0-9]+時間に)?約?[0-9]+ミリ(?:以上)?/gu;
```

地点 token は `areaNameCandidates` と照合する。候補は次だけから作る。

1. `entry.targetAreas[].name`
2. 同一文中の `Xで記録的短時間大雨` における `X`
3. 同一文中の `X付近で` における `X`

2 と 3 の `X` は、日本語の地名文字列であり、末尾が `都|道|府|県|市|区|町|村` のいずれかである場合だけ候補に加える。候補の表示 token は次の形に限る。

```ts
<Area.Name candidate>(?:付近)?
```

地点候補は、句点 `。`、改行、または別の読点 `、` をまたいではならない。複数地点の「北区、板橋区で記録的短時間大雨」は読点で分割し、各候補を個別の地点 token とする。

token 範囲が重複する場合は、次の優先順位で採用する。

1. 時刻
2. 雨量表現
3. 地点

優先度が低い token は、採用済み token と1文字でも重なる場合に捨てる。部分認識は許可し、認識できた種類だけを強調する。たとえば時刻と雨量だけが安全に認識できた本文では、その二つだけを `<strong>` 化し、地点はプレーンテキストのままとする。

tokenizer が token を一つも得られない、または原文 offset への写像に失敗した場合は、markup を一切出さずプレーン headline を表示する。HTML を文字列結合で生成してはならない。

### 3.5 ページングと page atom

VPBS50 の precipitation stat grid は、地点・雨量・時刻・時間幅を含む一つの atomic page block とする。stat label と値、または一つの fact の stat cell をページ境界で分断してはならない。

線状降水帯の強調行も一つの atomic block とする。

VPOA50 headline は token 化した segment 列を page atom として扱う。`chunks()` は strong token 内で分割してはならず、分割点はプレーン segment の境界だけに置く。単一 token が幅・高さ制約を超える場合は、既存の infeasible 時規則に従い、一 block 一 page として保持する。

`data-briefing-page-atom`、entry chrome、footer、live card と off-layout probe の同一 DOM 契約は維持する。

## 4. 対象ファイル

実装対象:

- `src/dmdata/briefing-parser.ts`
- `src/types.ts`
- `src/engine/display/protocol.ts`
- `display/frontend/src/lib/protocol.ts`
- `src/engine/display/standby-state-store.ts`
- `display/frontend/src/components/BriefingCard.svelte`
- `display/frontend/src/preview/fixtures.ts`
- `display/scripts/capture-legacy-standby.mjs`

fixture・テスト対象:

- `test/fixtures/82_01_02_250630_VPBS50.xml`
- `test/fixtures/phase6b_VPBS50_KJPDE202608201757_202608201757.xml`
- `test/fixtures/phase6b_VPBS50_KJPTK202608221709_202608221717.xml`
- `test/fixtures/phase6b_VPOA50_JPDE202608201757_202608201757.xml`
- `test/fixtures/phase6b_VPOA50_JPTK202608221709_202608221717.xml`
- `test/dmdata/briefing-parser.test.ts`
- `test/engine/display/briefing-corpus-0827.test.ts`
- `test/engine/display/standby-state-store.test.ts`
- `test/ui/briefing-formatter.test.ts`（実装時裁定 2026-08-28: WeatherObservation の必須 field 追加に伴う手書き fixture の型追従。typecheck:test の機械的必然）
- `test/fixtures/phase6b-legacy-card-production.json`（実装時裁定 2026-08-28: precipitation wire の duration/approximation 追加に伴う bytes snapshot 再生成。既存 assertion の意味は不変）
- `test/engine/telegram-foundation/phase6b-legacy-card-production.test.ts`（同上・snapshot 期待の wire 追従が必要な場合のみ）
- `display/frontend/src/components/__tests__/briefing-card.test.ts`
- `display/frontend/src/components/__tests__/standby.test.ts`

`display/frontend/src/preview/fixtures.ts` の VPOA50 fixture は、headline を持ち、`summary.items[0].facts` が空である実相当 shape に更新する。VPBS50 fixture は precipitation fact を持つ shape とする。

## 5. 受入条件と実測

### DOM と corpus

82_01_02 VPBS50 corpus では、次を DOM で確認する。

- `美幌町`、`100`、`mm`、`13:10`、`1時間` が同一 `data-briefing-precipitation-stat` block 内にある。
- `美幌`、`93`、`mm`、`13:10` が別 precipitation block にある。
- 地点表示に `付近` が追加されない。
- `value/unit` 欠損 fact はその fact だけ従来文字列 fallback となり、別 fact の stat grid は残る。
- `locationName`、`at`、`duration`、`approximation` の各欠損は、それぞれ対応する stat または修飾だけを省略し、entry を raw fallback にしない。

北塩原村 VPBS50 corpus では、`北塩原村`、`約 100 mm`、`17:50`、`1時間` を確認する。

`phase6b_VPBS50_KJPTK202608221709_202608221717.xml` では、VPBS stat grid に `120 mm 以上` が表示されることを確認する。

線状降水帯 corpus では、地点、発生／予想、時刻が単一の atomic 強調行にあることを確認する。

### VPOA50 tokenizer

VPOA50 では、次を確認する。

- 北塩原村 headline の時刻、地点候補、`1時間に約100ミリ` が、認識できた種類だけ `<strong data-briefing-vpoa-token>` になる。
- 板橋区 headline の `1時間に120ミリ以上` が、「以上」を含む一つの雨量 token として強調される。
- 全角数字の原文表示が維持される。
- 不正な地点句、重複 token、offset 写像不能、token なしの synthetic fixture は、文字欠落・文字置換・HTML 注入なしのプレーン headline になる。
- VPOA50 には `data-briefing-precipitation-stat` が一件も存在しない。

VPBS と VPOA50 の対照として、同じ `120ミリ以上` 相当の情報では、VPBS は stat grid、VPOA50 は headline 内 strong token のみであり、VPOA50 に stat grid がないことを確認する。

### preview と capture

preview fixture に対し、capture assertion を追加する。

- VPBS50 fixture: `data-briefing-precipitation-stat` が存在し、地点・雨量・時刻の各 selector が存在する。
- VPOA50 fixture: `data-briefing-vpoa-headline` と少なくとも一つの `data-briefing-vpoa-token` が存在する。
- VPOA50 fixture: `data-briefing-precipitation-stat` が存在しない。
- `briefing-pages` では実測した page 数、footer、entry boundary、live/probe の同一 page atom を確認する。
- `briefing-single-page` では実測した `1/1` と footer 不在を確認する。

capture の成功は終了コードだけで判定しない。report、screenshot、geometry から clip/overflow がないこと、footer と entry boundary が期待どおりであることを確認し、実測値を検証記録へ残す。

### 実行ゲート

```sh
npm run build
npm test
npm run test:shuffle
npm run typecheck:test
npm run display:build
npm run display:test
npm --prefix display run typecheck
npm run test:phase6b-production
```

表示サーバー起動後、次を実行する。

```sh
node display/scripts/capture-legacy-standby.mjs --fixture briefing-pages --url http://127.0.0.1:5173
node display/scripts/capture-legacy-standby.mjs --fixture briefing-single-page --url http://127.0.0.1:5173
```

