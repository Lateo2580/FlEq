# 電文基盤共通化仕様 — 特殊値・TelegramMeta・Revision・試験判定・条件付き抑止

> 状態: **Reviewed Draft（Sol レビュー前）**  
> 更新日: 2026-07-31  
> 対象: FlEq parser／Presentation／CLI／通知／テロップ／常設ディスプレイ／永続化  
> 参照基準: HEAD `c76f3578ebb4fbdd20ef5d824ac99a90ce9ab012`  
> 前提: 修正弾 A〜C で個別 High は対処済みとし、本仕様は構造的根因の共通化を扱う

## 1. 目的・スコープ

### 1.1 目的

電文ごと、domain ごと、表示経路ごとに個別実装されている次の判断を、共通契約へ段階的に集約する。

- 数値に見える要素の特殊値、欠落、空欄、定性表現、範囲
- EventID、type、ReportDateTime、serial、InfoType による revision 判定
- 訂正、取消、遅延電文、重複電文の扱い
- 訓練・試験電文の判定
- 重複する旧形式電文の抑止条件
- 地域名・現象名ではなくコードを一次キーにする領域

目的は、特殊値を通常値やゼロへ誤変換しないこと、古い電文で新しい状態を巻き戻さないこと、片系受信時に情報を無条件で捨てないこと、および同じ入力がすべての下流で同じ意味を持つことだ。

### 1.2 対象

本仕様の対象は次のとおりとする。

1. 共通特殊値モデル
   - Magnitude
   - Depth
   - Intensity
   - TsunamiHeight
   - LgInt
   - 台風の気圧、風速、最大瞬間風速、移動速度
   - 噴煙高度
2. 共通 `TelegramMeta` と `Revision`
3. `deriveIsTest` の一元化
4. VPOA50、VPNO50、VXWW50 の条件付き抑止
5. 震度 Condition
6. EEW 同一 serial 訂正
7. VXSE44 の購読確認付き抑止
8. 津波予報区コード・Kind コードの一次キー化
9. CLI、通知、テロップ、カード、地図、永続化への伝播

### 1.3 非スコープ

次は本仕様の非スコープとする。

- 修正弾 A〜C で対応済みの個別不具合を再実装すること
- すべての parser を一度に書き換えること
- XML ライブラリそのものの置換
- 地域コード表、現象コード表の全面刷新
- VPOA50、VPNO50、VXWW50 以外の既存 ignore 電文の方針変更
- 通知文面、カード配置、地図意匠の全面的な再設計
- WeatherCW を runtime または CI の必須依存にすること

### 1.4 導入原則

- additive な型追加から始め、旧フィールドを直ちに削除しない。
- parser だけ、または UI だけを先行させず、domain 単位の縦切りで移行する。
- 新旧値を併存させる期間は、共通モデルを真実源とし、旧値は adapter から生成する。
- revision の判断を旧実装と新実装の双方で行わない。切替対象 domain では共通 gate を唯一の決定点にする。
- 永続化と wire protocol は schema version を上げ、旧形式を読める期間を設ける。
- コーパスで未確認の構造を、地名や文言から推測して補完しない。
- 各 Phase で既存機能の回帰を 0 件にする。

## 2. 共通設計原則

### 2.1 raw と意味値を分離する

電文に書かれていた文字列と、FlEq が計算・比較に使う意味値を同じフィールドで兼用しない。

- `raw` は電文由来の値を保持する。
- `value` は正確に数値化または列挙値化できた場合だけ設定する。
- 推定値や安全側評価を `value` に書き込まない。
- 定性値や範囲は `condition`、`description`、`lowerBound`、`upperBound` で表す。
- 下流は `raw` を再解析せず、共通 renderer と domain helper を使う。

### 2.2 不明をゼロにしない

欠落、空欄、不明、未入電を次の値へ変換してはならない。

- 数値 `0`
- 震度 rank `0`
- 空の EventID
- 現在時刻
- 「なし」「解除」などの状態値

不明は「安全」と同義ではない。状態更新、通知抑止、地図着色、severity 判定では、明示的な unknown branch を持つ。

### 2.3 コードを一次キーにする

地域名、現象名、火山名などの表示文字列を状態キーに使わない。

- コードは文字列として保持する。
- 数値化しない。
- 先頭ゼロを維持する。
- Unicode 正規化や全角半角変換を適用しない。
- 名称は表示用属性とする。
- コード欠落時に名称から推測しない。

### 2.4 fail-open と fail-closed を区別する

- 情報を表示するか否かの判断に確証がない場合は fail-open を基本とする。
- 現在の永続状態を置換・解除する判断に確証がない場合は fail-closed とする。
- したがって、不正 revision の電文は現在状態を変更しないが、診断経路で受信事実を可視化する。
- 「表示しない」と「状態を変更しない」を同じ判断にしない。

## 3. 特殊値の共通データモデル

### 3.1 型

通常値と五つの特殊状態を次の型で表す。

```ts
export type SpecialValuePresence =
  | "value"
  | "missing"
  | "empty"
  | "unknown"
  | "qualitative"
  | "range";

export interface SpecialValue<T> {
  raw: string | null;
  value: T | null;
  condition: string | null;
  description: string | null;
  presence: SpecialValuePresence;
  lowerBound?: T | null;
  upperBound?: T | null;
}
```

`missing`、`empty`、`unknown`、`qualitative`、`range` が区別すべき五つの特殊状態であり、`value` は通常値を表す。

### 3.2 各状態の契約

| presence | 意味 | raw | value | bounds |
|---|---|---:|---:|---|
| `value` | 正確な通常値 | 非 null | 非 null | 原則なし |
| `missing` | 要素・属性そのものが存在しない | `null` | `null` | なし |
| `empty` | 要素は存在するが空、または空白のみ | `""` または元の空白文字列 | `null` | なし |
| `unknown` | 「不明」「観測できず」「未入電」など、値が不明と明示される | 元文字列 | `null` | 原則なし |
| `qualitative` | 「巨大」「高い」「ごく浅い」「5弱以上未入電」など、定性的意味がある | 元文字列 | `null` | 意味が定まる場合のみ設定 |
| `range` | 上限、下限、区間で表現される | 元文字列 | `null` | 一方または双方を設定 |

### 3.3 不変条件

- `presence === "value"` のとき `value` は必須とする。
- `presence !== "value"` のとき `value` は `null` とする。
- `range` は `lowerBound`、`upperBound` の少なくとも一方を持つ。
- `qualitative` は bounds を持たなくてもよい。
- `missing` と `empty` を相互変換しない。
- `raw` を trim、NFKC、数値文字列化した結果で上書きしない。
- XML entity の decode は行うが、異体字を別字へ変換しない。
- `condition` と `description` は、存在しない場合 `null`、明示空の場合 `""` を維持する。
- JSON／SSE／永続化の境界では `undefined` による意味の消失を避ける。optional bounds を出力する場合は、schema ごとに「省略」または `null` を固定する。
- 未知の定性語を黙って `unknown` や `0` に変換せず、`qualitative` として raw を保持し、`unmappedSpecialValue` 統計を記録する。

### 3.4 XML 抽出

`SpecialValue` の生成に、単純な `str()` を直接使用してはならない。

共通 extractor は次を同時に読む。

- 要素の存在
- 要素本文
- `condition`
- `description`
- 単位
- 上限・下限を表す属性または構造

`str()` は、欠落と空欄の区別や属性情報が不要な通常テキストに限って残す。

数値解析時だけ、raw のコピーに対して次を許可する。

- 前後空白の除去
- 全角数字、全角小数点、全角符号の ASCII 化
- domain で定義済みの単位除去

この解析用変換は `raw`、地名、コード、表示名へ反映しない。

### 3.5 domain 別の適用

| domain value | `T` | 単位・列挙 | 主な特殊表現 |
|---|---|---|---|
| Magnitude | `number` | 気象庁マグニチュード | 不明、巨大、M不明 |
| Depth | `number` | km | 不明、ごく浅い、範囲 |
| Intensity | `JmaIntensity` | 震度階級 | 未入電、5弱以上未入電、範囲 |
| TsunamiHeight | `number` | m | 不明、巨大、高い、観測中 |
| LgInt | `JmaLgIntensity` | 長周期地震動階級 | 不明、未入電、範囲 |
| Pressure | `number` | hPa | 不明、解析不能 |
| WindSpeed | `number` | m/s | 不明、範囲 |
| MovementSpeed | `number` | km/h | ほとんど停滞、不明 |
| PlumeHeight | `number` | m | 不明、雲中、観測できず、以上、範囲 |

単位は型 alias またはフィールド名で固定し、同じ `number` を異なる単位のまま比較しない。

### 3.6 Intensity の安全側評価

`intensityToRank()` のような数値だけを返す API とは別に、unknown を保持できる評価型を導入する。

```ts
export type IntensitySafetyRank =
  | {
      kind: "known";
      lower: number;
      upper: number | null;
    }
  | {
      kind: "unknown";
    };
```

規約は次のとおりとする。

- 通常震度は `lower === upper` とする。
- 範囲震度は lower／upper を保持する。
- `5弱以上未入電` は `presence: "qualitative"`、`lowerBound: "5-"` とし、安全側 lower rank を震度5弱とする。
- `5弱以上未入電` は、震度5弱以上を条件とする通知・地図・カード表示を発火できる。
- 単なる `未入電` は `kind: "unknown"` とする。
- 単なる `未入電` を震度0、震度1、または震度5弱へ推定しない。
- unknown は既存の高い状態を降格させる根拠にしない。
- unknown を「閾値未満」と判定して通知や警戒表示を抑止しない。
- 並び順が必要な場合、unknown は通常 rank の配列へ混ぜず、別 group として扱う。

### 3.7 下流表示規約

| 下流 | value | missing | empty | unknown | qualitative / range |
|---|---|---|---|---|---|
| CLI 詳細 | 数値＋単位 | `—` | `（空欄）` | `不明`＋理由 | 定性語、`X以上`、`X～Y` |
| 通知 | 必要な値だけ記載 | 省略 | 省略 | 主題に不可欠な場合だけ明記 | qualifier を落とさず記載 |
| テロップ | 短縮した通常値 | 省略 | 省略 | `不明` | `巨大`、`5弱以上未入電`、`X以上` |
| カード | 数値＋単位 | `—` | `空欄` | `不明` badge | qualifier badge 付き |
| 地図 | 通常色 | 非描画 | neutral 色＋`∅` badge | unknown 色＋`?` badge | safety rank 色＋記号 badge |
| 永続化 | 全フィールド保存 | `raw:null` | `raw:""` | raw・condition 保存 | raw・bounds 保存 |

共通規約として、通知やテロップで qualifier を削って通常値のように表示してはならない。

例:

- `5弱以上未入電` を `震度5弱` と表示しない。
- `3000m以上` を `3000m` と表示しない。
- `雲中` を `不明` だけへ潰さない。
- `巨大` を数値へ推定しない。
- `ほとんど停滞` を `0km/h` にしない。

### 3.8 地図の色と記号バッジ

特殊値を地図へ出す場合は、2026-07-31 決定の「色と記号バッジ」を使用する。

| 状態 | 色 | badge |
|---|---|---|
| exact value | 通常 rank 色 | なし |
| lower bound | lower bound の safety rank 色 | `≥` |
| range | safety upper rank 色 | `↔` |
| qualitative かつ lower bound あり | lower bound の safety rank 色 | `≥` |
| qualitative かつ bounds なし | unknown 色 | `?` |
| unknown | unknown 色 | `?` |
| empty | neutral 色 | `∅` |
| missing | 非描画 | なし |

- `5弱以上未入電` は震度5弱の色と `≥` badge を使用する。
- badge だけに意味を依存せず、凡例、tooltip、カード、アクセシビリティラベルにも condition を記載する。
- exact value と特殊値を同じ色にする場合でも、badge を省略しない。
- unknown 色を低震度色や「警戒なし」の色と共用しない。
- 色を識別できない環境でも記号とテキストで意味を判別できるようにする。

### 3.9 状態更新との関係

`SpecialValue` は値の意味を表すものであり、前回値を保持するか否かを決めない。

- snapshot 型電文では、unknown を含め今回の内容で置換する。
- partial update 型電文では、domain policy が未掲載フィールドを維持する。
- `missing` を「前回値維持」と解釈するか「値なし」と解釈するかは、telegram type ごとの update policy に明記する。
- `empty` を自動的に削除命令と解釈しない。
- 永続状態の解除は `InfoType` と cancellation policy で判断する。

## 4. 共通 TelegramMeta 契約

### 4.1 型

```ts
export interface StrictTextMeta {
  raw: string | null;
  value: string | null;
  valid: boolean;
}

export interface StrictDateTimeMeta {
  raw: string | null;
  epochMs: number | null;
  valid: boolean;
}

export interface TelegramSerial {
  raw: string | null;
  numeric: number | null;
  valid: boolean;
}

export type TelegramInfoTypeValue =
  | "発表"
  | "訂正"
  | "取消";

export interface StrictInfoTypeMeta {
  raw: string | null;
  value: TelegramInfoTypeValue | null;
  valid: boolean;
}

export interface TelegramMeta {
  messageId: string;
  eventId: StrictTextMeta;
  type: StrictTextMeta;
  reportDateTime: StrictDateTimeMeta;
  serial: TelegramSerial;
  infoType: StrictInfoTypeMeta;
  receivedAtMs: number;
  status: string | null;
  isTest: boolean;
}
```

### 4.2 抽出規約

- `eventId` は XML Head の EventID から取得する。
- `type` は WebSocket head.type を正とし、XML Title や表示タイトルを使用しない。
- `reportDateTime` は XML Head の ReportDateTime から取得する。
- `serial` は XML Head の Serial から取得する。
- `infoType` は XML Head の InfoType から取得する。
- `messageId` は transport の電文 ID とし、EventID の代用にしない。
- `receivedAtMs` は受信時刻であり、ReportDateTime の代用にしない。

### 4.3 serial

`serial` は次の規約で解析する。

- `raw === null`: 欠落、`numeric:null`、`valid:false`
- `raw === ""`: 明示空、`numeric:null`、`valid:false`
- 10進数字のみで安全な整数範囲: `numeric` を設定し、`valid:true`
- 符号、単位、文字混在、小数、桁あふれ: `numeric:null`、`valid:false`
- 先頭ゼロは raw に保持する。
- revision 比較で非数値 serial を辞書順比較しない。
- `parseInt("12A") === 12` のような部分一致を禁止する。

domain が serial 欠落を許す場合でも、`valid` を true に偽装しない。比較不能を許容する domain policy を別途定義する。

### 4.4 ReportDateTime

- ISO 8601 の完全一致と実在日時を検証する。
- timezone を必須とする。
- 不正値、欠落、明示空の `epochMs` は `null` とする。
- 不正値を `Date.now()`、受信時刻、ファイル時刻へ昇格させない。
- 不正日時の電文は現在状態を置換、解除、巻き戻しできない。
- `receivedAtMs` はログ、TTL、相関待機時間にだけ使う。
- invalid ReportDateTime の電文は CLI と診断テロップにだけ transient 表示する。
- 通常テロップ、カード、地図、active state、OS 通知、通知音へは流さない。
- 診断テロップには type、EventID、raw ReportDateTime、受信時刻、および「日時不正」を明示する。
- 診断表示は durable active state として永続化しない。監査ログと統計は保存してよい。

## 5. Revision 契約

### 5.1 revision identity

```ts
export interface TelegramRevision {
  eventId: StrictTextMeta;
  type: StrictTextMeta;
  reportDateTime: StrictDateTimeMeta;
  serial: TelegramSerial;
  infoType: StrictInfoTypeMeta;
}
```

標準の状態キーは次とする。

```text
domain + revisionFamily + EventID
```

`revisionFamily` の既定値は `type.value` とする。

異なる head.type が同じイベント状態を更新する場合は、domain registry で type family を明示する。暗黙に type を無視してはならない。

### 5.2 比較規約

比較結果は数値ではなく次の union で返す。

```ts
export type RevisionRelation =
  | "newer"
  | "equal"
  | "older"
  | "unordered";
```

比較順序は次のとおりとする。

1. EventID と revisionFamily が同じか確認する。
2. 両方の ReportDateTime が valid なら時刻を比較する。
3. ReportDateTime が同じ場合、両 serial が valid なら numeric を比較する。
4. 必要な要素が不正または片側だけ欠落している場合は `unordered` とする。
5. 非数値 serial の辞書順比較をしない。
6. `unordered` を `equal` とみなさない。

### 5.3 InfoType ごとの判断

| InfoType | newer | equal | older | unordered |
|---|---|---|---|---|
| 発表 | accept | duplicate | stale | invalidRevision |
| 訂正 | accept | replaceCorrection | stale | invalidRevision |
| 取消 | domain policy を適用 | domain policy を適用 | stale | invalidRevision |
| 不正・欠落 | invalidMeta | invalidMeta | invalidMeta | invalidMeta |

訂正の規約は、修正弾 A で導入済みの「同一 revision の訂正は置換を許可し、通常報の同一 revision は重複として拒否」を一般化する。

訂正を受理した場合は、同一 serial でも次を再計算する。

- formatter 出力
- severity
- 差分
- 通知内容
- テロップ
- カード
- 地図
- 永続状態

### 5.4 訂正通知

2026-07-31 の決定により、訂正は共通 gate で受理されるたびに通知する。

- 通知タイトルまたは本文へ `訂正` を明示する。
- presentation 上の実質差分がなくても、受理された訂正は通知する。
- 同一 messageId の transport 再送は受理前に除外するため通知しない。
- 同一 semantic payload の再送も受理前に除外するため通知しない。
- stale、invalidRevision、invalidMeta の訂正は受理されず、通知しない。
- 訂正を新規イベントまたは第1報として扱わない。
- 第1報専用音を再発火しない。
- 通知音と severity は訂正後 payload に対する既存 domain 規則を使う。
- 通知文には、可能な場合は「何が訂正されたか」を diff として付記する。diff が空でも「訂正」の明示は省略しない。

### 5.5 cancellation policy

取消動作は次の三種類だけを使用する。

```ts
export type CancellationPolicy =
  | "restorePrevious"
  | "clearCurrent"
  | "markCancelled";
```

#### restorePrevious

- 取消対象が現在 revision と一致した場合だけ、一つ前の完全 snapshot を復元する。
- history がない場合は current を空にする。
- watermark／tombstone は維持し、遅延した旧報を復活させない。
- 部分データから過去状態を合成しない。

#### clearCurrent

- 対象となる current state を消す。
- previous revision は復元しない。
- tombstone を残し、取消以前の遅延電文を拒否する。
- EventID、type family、地域コードなど domain key に一致する範囲だけを消す。

#### markCancelled

- イベントを取消済みの terminal state として保持する。
- アクティブ件数や警報表示から除外する。
- 取消表示、監査ログ、遅延報抑止に必要な最小情報を保持する。

### 5.6 domain 間の実装差と正規化先

この表を cancellation registry の初期値とする。

| domain／revisionFamily | 現行実装の主な形 | 共通化後の policy |
|---|---|---|
| EEW（VXSE43/44/45） | `EewTracker` がイベントを取消済みにする | `markCancelled` |
| earthquake | 主に transient event と取消文 | `markCancelled` |
| seismicText | 主に transient event と取消文 | `markCancelled` |
| lgObservation | 主に transient event と取消文 | `markCancelled` |
| tsunami | active level／lastInfo を clear、watermark 維持 | `clearCurrent` |
| volcano alert | 火山コード単位で active alert を削除 | `clearCurrent` |
| volcano eruption event | EventID／火山単位で最新イベントを削除 | `clearCurrent` |
| VPWS50 | current と履歴を持ち、取消対象一致時に rollback | `restorePrevious` |
| VPWW56 | stream の current view を消し、watermark を維持 | `clearCurrent` |
| floodForecast | EventID 単位の履歴を削除 | `clearCurrent` |
| tornado | 発表官署／EventID 単位の active state を削除 | `clearCurrent` |
| heatAlert | 対象日・地域単位の active state を削除 | `clearCurrent` |
| typhoonAnalysis | 台風キー単位の active state を削除 | `clearCurrent` |
| typhoonProbability | EventID／対象時刻単位の active cache を削除 | `clearCurrent` |
| nankaiTrough | current active state を削除 | `clearCurrent` |
| weatherWarningTimeseries | source／地域単位の active state を削除 | `clearCurrent` |
| briefing | durable current を持たない取消表示 | `markCancelled` |
| earlyWeather | durable current を持たない取消表示 | `markCancelled` |
| climateInfo | durable current を持たない取消表示 | `markCancelled` |
| weatherExplanation | durable current を持たない取消表示 | `markCancelled` |
| raw | 状態を推定しない | `markCancelled` |

同じ Presentation domain 内で policy が異なる場合があるため、registry のキーを domain だけにしてはならない。

新しい revisionFamily を追加したとき cancellation policy が未登録なら、コンパイルまたは起動時検証を失敗させる。暗黙の既定 policy は置かない。

### 5.7 共通重複排除

処理順序を次に統一する。

```text
transport validation
  → TelegramMeta 抽出
  → transport ID dedup
  → parser
  → revision decision
  → cancellation policy / state mutation
  → presentation diff
  → stats
  → ticker / card / map
  → notification dedup
  → notification
  → persistence
```

重複排除は二層にする。

1. Transport duplicate
   - `messageId` が同じ電文
   - primary／backup の重複
2. Semantic duplicate
   - EventID、revisionFamily、ReportDateTime、serial、InfoType、payload fingerprint が同じ電文

通知は両方の重複排除を通過した後にだけ実行する。

訂正は、重複排除を通過して共通 gate が受理した場合、実質差分の有無にかかわらず訂正通知を一回発行する。

受信統計と採用統計を分ける。

- `received`
- `transportDuplicate`
- `semanticDuplicate`
- `correctionReplaced`
- `correctionNotified`
- `stale`
- `invalidMeta`
- `invalidRevision`
- `invalidDateDiagnosed`
- `cancelApplied`
- `cancelTargetMismatch`
- `presented`
- `notified`

## 6. deriveIsTest の一元化

### 6.1 契約

試験判定は次の和集合とする。

```ts
export function deriveIsTest(input: {
  headTest: boolean | null;
  controlStatus: string | null;
}): boolean {
  return input.headTest === true
    || input.controlStatus?.trim() === "訓練"
    || input.controlStatus?.trim() === "試験";
}
```

判定源は次とする。

- WebSocket `head.test`
- `xmlReport.control.status`
- raw XML を decode した `Control.Status`

いずれか一つでも試験・訓練を示した場合は `true` とする。情報源の不一致によって `false` へ戻してはならない。

Notice、Title、本文中の「テスト」「訓練」などの自由文は共通判定へ含めない。

### 6.2 validator

- `head.test` が存在する場合は boolean 以外を拒否する。
- production の WebSocket message では `head.test` を必須とする。
- `xmlReport.control.status` が存在する場合は string 以外を拒否する。
- raw XML の `Control.Status` と envelope metadata が異なる場合、`isTest` は和集合で導出し、`testMetadataMismatch` を記録する。
- parser は独自に `msg.head.test` を読まない。
- validator または ingress normalizer が生成した `TelegramMeta.isTest` を使用する。

### 6.3 parser と PresentationEvent

- すべての Parsed 型は `meta: TelegramMeta` を参照する。
- 移行期間の旧 `isTest` フィールドは `meta.isTest` から生成する。
- `PresentationEvent.isTest` は `TelegramMeta.isTest` だけから生成する。
- `from-*.ts` ごとの `outcome.msg.head.test` 再読込を廃止する。
- validator、parser、PresentationEvent の三箇所で異なる判定を持たない。

### 6.4 fixture helper

fixture helper は実 XML の次を解析して envelope を構成する。

- `Control.Status`
- `Head.InfoType`
- `Head.Serial`
- `Head.ReportDateTime`
- `Head.EventID`
- `Control.Title`
- telegram type

通常 fixture を常に `status:"通常"`、`head.test:false` として包まない。

明示 override は、metadata mismatch や不正 envelope を検証するテストだけで許可する。override 使用時はテスト名または helper 引数で意図を明記する。

## 7. 震度 Condition の適用

### 7.1 対象

次の震度値を `SpecialValue<JmaIntensity>` へ移行する。

- 地震情報の最大震度
- Area／Pref／City／IntensityStation の震度
- EEW の最大予測震度
- EEW の地域別 From／To
- 長周期地震動階級
- 地図表示用震度

### 7.2 Condition

要素本文だけでなく、Condition、Description、From／To を保持する。

特に次を潰してはならない。

- 未入電
- 5弱以上未入電
- 震度幅
- 長周期地震動階級の幅
- PLUM 法による推定・不確実性

### 7.3 地図と severity

- exact value は通常 rank を使う。
- range は安全側 upper を表示優先度に使う。下限しかない場合は lower を最低保証として使う。
- `5弱以上未入電` は震度5弱以上の表示面を発火させる。
- `5弱以上未入電` は震度5弱の色と `≥` badge を表示する。
- plain `未入電` は「弱い地域」として塗らず、unknown 色と `?` badge を表示する。
- empty は neutral 色と `∅` badge を表示する。
- missing は非描画とする。
- exact value と uncertainty の見た目は同一にしない。
- unknown の存在によって既存 emergency host を降格させない。

## 8. EEW 同一 serial 訂正

### 8.1 revision

EEW の重複判定を `serial <= lastSerial` だけで行わない。

- 同一 type、同一 serial、通常報: duplicate
- 同一 type、同一 serial、InfoType=訂正: replaceCorrection
- 小さい serial の訂正: stale
- 大きい serial の訂正: newer として受理
- serial 不正・欠落: unordered。現在状態を置換しない
- 取消は cancellation policy に従う

### 8.2 state update

同一 serial 訂正では次を置換する。

- `previousInfo`
- magnitude／depth
- forecast intensity
- warning 判定
- diff の比較元
- final／cancel 状態
- 表示・通知用 payload

`lastSerial` は同値のまま維持する。訂正を「新しい第N報」として新規イベント音へ流さない。

共通 gate が訂正を受理した場合は、実質差分がなくても `訂正` を明示した通知を一回発行する。ただし transport duplicate、semantic duplicate、stale、invalid revision は通知しない。

## 9. VXSE44 の購読確認付き抑止

### 9.1 基本方針

VXSE44 を type だけで常時抑止しない。

抑止できる条件は次のいずれかとする。

1. 同一 EventID で VXSE45 をすでに受信している。
2. 現在接続中の socket について、VXSE45 が配送対象であることを `DeliveryCapabilities` が確認済みである。

それ以外は VXSE44 を通常処理する。

### 9.2 DeliveryCapabilities

```ts
export interface DeliveryCapabilities {
  connected: boolean;
  effectiveClassifications: readonly string[];
  guaranteedHeadTypes: ReadonlySet<string>;
  source: "socket-start" | "contract-and-socket" | "unknown";
}
```

確認には次を使用する。

- 設定ファイル上の希望 classifications だけではなく、WebSocket start message で返された実効 classifications
- 有効な契約情報
- classification から保証される head.type の明示 registry

classification から VXSE45 の配送が保証できない場合、capability は unknown とし、VXSE44 を抑止しない。

接続切断中、再接続中、socket start 未確認時も抑止しない。

### 9.3 tracker

- 同一 EventID で実際に VXSE45 を受信した事実は最も強い抑止根拠とする。
- capability に基づく抑止と、実受信に基づく抑止を stats で分ける。
- VXSE44 の取消・最終報を抑止する場合でも、対象イベントの終端処理は実行する。
- VXSE44 を fail-open 処理した後に VXSE45 が来た場合、共通 revision／dedup gate で二重通知を防ぐ。

## 10. 津波予報区・Kind コードの一次キー化

### 10.1 parser

津波 forecast item に次を追加する。

```ts
export interface TsunamiForecastItem {
  areaCode: string | null;
  areaName: string;
  kindCode: string | null;
  kindName: string;
  maxHeight: SpecialValue<number>;
  firstHeight: SpecialValue<string>;
  // existing station fields
}
```

時刻自体は日時専用型へ後続移行できる。初期適用では高さとコードの保持を優先する。

### 10.2 キー

状態キーは次とする。

```text
EventID + Area.Code + Kind.Code
```

- Area.Name をキーにしない。
- Kind.Name をキーにしない。
- 同じコードの名称変更は同じ状態の表示名更新として扱う。
- 同じ名称でもコードが異なれば別状態とする。
- コード欠落時に名称からコードを推定しない。
- コード欠落 item は unkeyed として fail-open 表示できるが、既存状態を置換・解除しない。
- 不明コードは raw code のまま保持し、`unknownTsunamiAreaCode`／`unknownTsunamiKindCode` を記録する。

### 10.3 下流

- CLI、通知、テロップは名称を表示する。
- state、dedup、地図結合、取消対象照合はコードを使用する。
- protocol は areaCode／kindCode を必ず通す。
- 地図 asset と一致しないコードを名称一致で補完しない。

## 11. VPOA50・VPNO50・VXWW50 の条件付き抑止

### 11.1 基本方針

三種類を無条件 ignore 集合から外す。

- 対応電文を同一イベント・時間窓で確認できた場合だけ抑止する。
- 片系しか受信していない場合は fail-open 表示する。
- 相関できない場合は unmatched として観測可能にする。
- その他の既存 ignore type は本仕様では変更しない。

### 11.2 相関 registry

```ts
export interface LegacyCounterpartRule {
  sourceType: "VPOA50" | "VPNO50" | "VXWW50";
  counterpartTypes: readonly string[];
  extractEventKey: (meta: TelegramMeta, parsed: unknown) => CorrelationKey | null;
  windowBeforeMs: number;
  windowAfterMs: number;
  holdbackMs: number;
}
```

各 type の counterpartTypes と一致条件は、repo fixture と実コーパスで両側を確認してから登録する。片側しか確認できない規則を、名前の類似だけで有効化しない。

### 11.3 Holdback と時間窓

2026-07-31 の決定により、中程度の Holdback を採用する。

本仕様では次を初期値とする。

```ts
const LEGACY_SOURCE_HOLDBACK_MS = 60_000;
const LEGACY_CORRELATION_WINDOW_BEFORE_MS = 5 * 60_000;
const LEGACY_CORRELATION_WINDOW_AFTER_MS = 5 * 60_000;
```

- source 先着時は最大60秒待機する。
- ReportDateTime の許容範囲は counterpart の前後5分とする。
- EventID が一致していても、時間窓外なら自動抑止しない。
- type 別の実測で60秒を超える正当な到着差が確認された場合、type 別 override を追加できる。
- override は fixture／コーパス根拠、最大値、理由を registry に明記する。
- runtime 設定による任意変更は初期実装に含めない。
- Holdback 中も受信統計を記録し、表示・通知統計は判定確定後に記録する。

### 11.4 一致条件

抑止には次のいずれかを要求する。

1. 両電文の非空 EventID が一致し、時間窓内である。
2. EventID が利用できない場合、次のコードベース identity がすべて一致する。
   - 発表官署コード
   - 対象地域コード
   - 現象／Kind コード
   - 対象時刻または ReportDateTime の時間窓

地名、タイトル、本文の部分一致だけでは抑止しない。

複数候補が一致する場合は ambiguous とし、source を fail-open 表示する。

### 11.5 到着順

- counterpart が先着した場合は短期 cache に保持し、後着 source を即時抑止する。
- source が先着した場合は60秒だけ待つ。
- Holdback 内に counterpart が来れば source を抑止する。
- timeout すれば source を表示する。
- restart で cache が失われた場合は fail-open とする。
- 相関 cache を永続化しない。

### 11.6 訂正・取消

- 訂正は訂正前後の revision を区別して相関する。
- 通常報の counterpart があるという理由だけで、source の訂正を無条件に捨てない。
- 取消は対象 revision が一致する場合だけ相関する。
- counterpart の取消後に source だけが active なら、source を表示対象へ戻す。
- Holdback 中の電文にも共通 `deriveIsTest`、TelegramMeta validation、transport dedup を適用する。

### 11.7 fail-open 表示

専用 parser が未実装でも、最低限次を表示する。

- telegram type
- title
- headline
- ReportDateTime
- publishing office
- 対象地域・現象コードを抽出できた場合はその名称
- 「対応電文未確認」の内部 reason

raw XML 全文は通知・テロップ・カードへ直接流さない。

### 11.8 unmatched legacy の通知

2026-07-31 の決定により、unmatched legacy 電文は高 Severity の場合だけ通知する。

- CLI、テロップ、カードによる fail-open 表示は Severity にかかわらず行う。
- OS 通知と通知音は `isHighSeverity === true` の場合だけ発行する。
- high 判定は type 名やタイトル文字列ではなく、抽出した現象コード、Kind コード、警報レベルを domain resolver へ渡して行う。
- domain resolver が高 Severity を確定できない場合は通知しない。
- unknown code、コード欠落、相関 ambiguous は表示するが通知しない。
- high 判定に名称 fallback を使用しない。
- 通知には `対応電文未確認` または同等の qualifier を明示する。
- counterpart が Holdback 内に到着して source が抑止された場合、source 側通知は行わない。
- timeout 後に通知済みとなった source へ counterpart が遅着しても、通知を撤回したり取消通知を合成したりしない。
- counterpart 自体の通常通知は共通 dedup gate に従う。

高 Severity の具体的なコード集合は type 別 registry として実装し、未知コードを high と推定しない。

### 11.9 統計

type ごとに次を記録する。

- `legacyMatchedSuppressed`
- `legacyUnmatchedDisplayed`
- `legacyUnmatchedHighSeverityNotified`
- `legacyUnmatchedNonHighNotificationSuppressed`
- `legacySeverityUnknownNotificationSuppressed`
- `legacyAmbiguousDisplayed`
- `legacyCorrelationExpired`
- `legacyCorrectionMismatch`
- `legacyCancellationMismatch`
- `legacyCounterpartArrivedFirst`
- `legacySourceArrivedFirst`

## 12. 永続化・protocol

### 12.1 schema version

`SpecialValue` と `TelegramMeta` を永続化する state は version を上げる。

旧 state の読込 adapter は次の規約とする。

- 旧数値文字列を完全に解析できる場合だけ `presence:"value"` へ移行する。
- `null` が欠落か不明か判別できない旧形式は `presence:"unknown"` とし、migration reason を記録する。
- 旧空文字は `presence:"empty"` とする。
- 旧 state の不正 ReportDateTime を migration 時刻や now へ置き換えない。
- 旧 revision が比較不能な state は表示復元できても、newer telegram を拒否する watermark には使用しない。
- migration 後の最初の valid telegram で正規状態へ置換する。

### 12.2 protocol

engine と frontend に同じ wire 型を持たせる。

- protocol sync test を必須とする。
- `raw`、`condition`、`description`、presence、bounds を落とさない。
- frontend が raw を独自再解析しない。
- map／card／ticker 用 view model は共通 renderer の結果を受け取る。
- map の badge semantic を wire または共通 view model で明示し、frontend に再判定させない。
- V1 互換期間中は旧 scalar field を adapter で生成する。
- 新旧 field が矛盾した場合は新しい `SpecialValue` を正とし、矛盾を telemetry に残す。

## 13. 段階導入

各 Phase は原則として独立した変更単位に分ける。同じ Phase 内でも、複数 domain を一つの巨大な変更へまとめない。

### Phase 0: 契約・基準 fixture の固定

内容:

- 2026-07-31 の U1〜U5 決定を acceptance criteria として固定する。
- repo fixture と WeatherCW から、特殊値、InfoType、Status、serial、ReportDateTime の characterization matrix を作る。
- VPOA50、VPNO50、VXWW50 の counterpart 候補は、両側の実在が確認できたものだけ記録する。
- 現在の cancellation behavior を domain／type family ごとに snapshot test 化する。
- 修正弾 A〜C の挙動を baseline として固定する。

完了条件:

- five-state special value matrix が対象 domain ごとに存在する。
- cancellation registry の全 Presentation domain／state holder が列挙されている。
- counterpart 未確認を「重複確認済み」と扱う規則がない。
- Holdback 60秒、相関窓前後5分が test constant として固定されている。
- invalid ReportDateTime の診断表示方針が fixture expectation に反映されている。
- 訂正通知、高 Severity 限定通知、地図 badge の acceptance criteria が固定されている。
- 既存機能の回帰が 0 件である。
- root／display の既存テストがすべて成功している。

### Phase 1: 共通型と shadow extractor

内容:

- `SpecialValue`、`TelegramMeta`、`TelegramRevision`、comparison result 型を追加する。
- node-aware special value extractor を追加する。
- 既存 parser の返却型は変えず、対象 fixture に対して shadow parse する。
- 旧値と新値の差をテストで比較する。
- invalid date を now にする経路を列挙し、共通 helper の新規利用を禁止する。

完了条件:

- 新型の unit test が通る。
- missing と empty が別結果になる。
- 非数値 serial が numeric revision として扱われない。
- invalid ReportDateTime が now にならない。
- runtime の表示・通知・永続化は Phase 0 と同一である。
- 既存機能の回帰が 0 件である。

### Phase 2: deriveIsTest の統一

内容:

- `deriveIsTest` を追加する。
- validator／ingress normalizer で `TelegramMeta.isTest` を生成する。
- 全 parser の独自判定を置換する。
- 全 `from-*.ts` を `TelegramMeta.isTest` 参照へ移行する。
- flood parser などの本文・Notice による独自 test 判定を廃止する。
- fixture helper を実 XML の Control／Head 参照へ変更する。

完了条件:

- `head.test × Status` の真理値表が全組合せで通る。
- Status=訓練／試験の fixture が全 parser と PresentationEvent で `isTest:true` になる。
- Status=通常かつ `head.test:false` は false になる。
- metadata mismatch は true 側へ倒れ、統計が記録される。
- 通常電文の既存表示・通知に回帰がない。
- 既存機能の回帰が 0 件である。

### Phase 3A: 共通 revision gate と EEW pilot

内容:

- `TelegramMeta` を EEW へ適用する。
- transport dedup と semantic revision gate の責務を分離する。
- EEW の同一 serial 訂正を受理する。
- cancellation policy `markCancelled` を EEW へ適用する。
- 通知を revision gate 後へ移す。
- 受理された訂正を必ず `訂正` と明示して通知する。
- invalid ReportDateTime を診断表示経路へ分離する。

完了条件:

- 同一 serial の通常報は一回だけ処理される。
- 同一 serial 訂正は state を置換し、訂正通知を一回発行する。
- 実質差分のない受理済み訂正も訂正通知を一回発行する。
- 小さい serial の訂正は state を巻き戻さず、通知しない。
- primary／backup の同一 messageId は一回だけ処理される。
- 同じ訂正 payload の再送は再通知されない。
- invalid ReportDateTime は CLI／診断テロップだけに出て、active state、通常テロップ、カード、地図、通知を変更しない。
- EEW の既存第1報音、警報昇格、取消、最終報に回帰がない。
- 既存機能の回帰が 0 件である。

### Phase 3B: cancellation registry の domain 移行

内容:

- VPWS50 を `restorePrevious` の基準実装とする。
- tsunami、volcano、VPWW56、floodForecast を `clearCurrent` へ移行する。
- transient domain を `markCancelled` へ移行する。
- active standby domain を一つずつ registry へ移行する。
- 各 domain の旧 revision guard を、移行完了後にだけ削除する。
- 各 domain の受理済み訂正へ共通訂正通知規約を適用する。

完了条件:

- 全 revisionFamily に明示 policy がある。
- 取消対象不一致が current state を変更しない。
- clear 後の遅延電文で状態が復活しない。
- restorePrevious が一つ前の完全 snapshot だけを復元する。
- invalid ReportDateTime／serial が current state を変更しない。
- 全 domain で受理済み訂正が `訂正` を明示して一回だけ通知される。
- domain 固有の既存 lifecycle と表示期限に回帰がない。
- 既存機能の回帰が 0 件である。

### Phase 4A: 震度 Condition と EEW intensity

内容:

- Intensity／LgInt を `SpecialValue` へ移行する。
- 震度の From／To／Condition／Description を保持する。
- `IntensitySafetyRank` を導入する。
- `未入電` と `5弱以上未入電` を分離する。
- EEW、地震カード、通知、テロップ、地図を同じ rank helper へ移行する。
- 色と記号バッジを実装する。

完了条件:

- plain 未入電が rank 0 にならない。
- `5弱以上未入電` が震度5弱以上の safety gate を通る。
- `5弱以上未入電` が震度5弱色＋`≥` badge になる。
- unknown が unknown 色＋`?` badge になる。
- empty が neutral 色＋`∅` badge になる。
- qualifier が通知、テロップ、カードで失われない。
- unknown 地域が「震度なし」として地図表示されない。
- badge の意味が凡例、tooltip、アクセシビリティラベルに反映される。
- 通常震度の既存色、音、通知閾値に回帰がない。
- 既存機能の回帰が 0 件である。

### Phase 4B: 津波コードと TsunamiHeight

内容:

- Area.Code と Kind.Code を parser から下流まで保持する。
- 状態キーと地図結合をコードへ変更する。
- tsunami height を `SpecialValue<number>` へ移行する。
- 高い、巨大、不明、観測中、範囲を保持する。
- 名称キーの legacy adapter を読込専用にする。
- 高さの range／qualitative を色と記号バッジへ反映する。

完了条件:

- 同コード・名称変更が同じ state を更新する。
- 同名称・別コードが混同されない。
- コード欠落 item が既存 state を解除しない。
- 高さの定性表現が数値やゼロへ変換されない。
- range／qualitative の badge が qualifier と一致する。
- 津波の既存警報レベル、通知、テロップ、カードに回帰がない。
- 既存機能の回帰が 0 件である。

### Phase 5A: Magnitude・Depth

内容:

- 地震、EEW、関連 formatter の Magnitude／Depth を `SpecialValue` へ移行する。
- 不明、ごく浅い、巨大、範囲を保持する。
- diff と通知判定を canonical value／bounds へ移行する。
- 旧 string field は adapter で生成する。

完了条件:

- 通常値の既存表示が一致する。
- 不明が NaN、0、空文字にならない。
- ごく浅いが 0km へ変換されない。
- diff が raw 表記揺れだけで発火しない。
- 受理済み訂正が実質差分の有無にかかわらず訂正通知される。
- 既存機能の回帰が 0 件である。

### Phase 5B: 台風数値

内容:

- 中心気圧、最大風速、最大瞬間風速、移動速度を `SpecialValue` へ移行する。
- 「ほとんど停滞」を qualitative として保持する。
- intensity trend や前報差分を canonical value から算出する。
- カード、CLI、通知、永続化を移行する。

完了条件:

- 停滞が `0km/h` と表示・保存されない。
- 不明な気圧・風速が強度低下の根拠にならない。
- 通常値の台風カード、差分、期限計算に回帰がない。
- 受理済み訂正が `訂正` を明示して通知される。
- persistence round-trip が通る。
- 既存機能の回帰が 0 件である。

### Phase 5C: 噴煙高度

内容:

- 噴煙高度を `SpecialValue<number>` へ移行する。
- 不明、雲中、観測できず、以上、範囲を保持する。
- 火山 parser、CLI、通知、テロップ、カード、永続化を移行する。
- 海抜高度と火口上高度を同じ数値フィールドへ混在させない。

完了条件:

- 不明、雲中、観測できずが相互に潰れない。
- `X以上` の qualifier が全下流に残る。
- 海抜高度と火口上高度の単位・基準が明示される。
- 受理済み訂正が `訂正` を明示して通知される。
- 修正弾 A〜C の火山 lifecycle に回帰がない。
- 既存機能の回帰が 0 件である。

### Phase 6A: VXSE44 購読確認化

内容:

- `DeliveryCapabilities` を connection 層へ追加する。
- socket start の実効 classifications を保持する。
- VXSE44 の常時早期 return を撤去する。
- 実受信 VXSE45 または保証済み capability だけで抑止する。
- 抑止理由別 stats を追加する。

完了条件:

- VXSE45 配送を確認できない構成では VXSE44 が表示される。
- 同一 EventID の VXSE45 受信後は VXSE44 が抑止される。
- capability unknown／切断中は fail-open になる。
- 第1報音、取消、最終報の終端処理に回帰がない。
- 既存機能の回帰が 0 件である。

### Phase 6B: legacy counterpart correlator

内容:

- VPOA50、VPNO50、VXWW50 を無条件 ignore 集合から外す。
- counterpart registry と短期相関 cache を追加する。
- source 先着時の60秒 Holdback と timeout 表示を実装する。
- ReportDateTime 前後5分の相関窓を実装する。
- unmatched／ambiguous stats を追加する。
- unmatched high Severity だけに通知を許可する。

完了条件:

- 対応電文確認時だけ source が抑止される。
- 片系だけの場合は60秒後に表示される。
- 時間窓外、コード不一致、候補複数は fail-open になる。
- 到着順が逆でも結果が一致する。
- restart 後は fail-open になる。
- high Severity の unmatched は qualifier 付きで一回通知される。
- high 未満、severity unknown、ambiguous は表示されるが通知されない。
- Holdback 内に counterpart が来た場合は source 通知が発生しない。
- VPOA50、VPNO50、VXWW50 以外の ignore 方針に回帰がない。
- 既存機能の回帰が 0 件である。

### Phase 7: protocol／永続化移行と legacy cleanup

内容:

- display protocol と persistence schema を正式版へ上げる。
- 旧 scalar field の read adapter を維持したまま、新形式を write する。
- 十分な移行期間後に旧 field と domain 固有 revision comparator を削除する。
- `str()` の禁止範囲を lint、review checklist または型で固定する。
- architecture docs を最終状態へ更新する。

完了条件:

- 旧 persistence fixture を読み込める。
- 新 persistence の round-trip で presence、raw、bounds、revision が失われない。
- engine／frontend protocol sync が通る。
- map badge semantic が engine と frontend で一致する。
- domain 固有の重複判定や test 判定が残っていない。
- 全 parser が共通 TelegramMeta を持つ。
- 既存機能の回帰が 0 件である。

## 14. テスト計画

### 14.1 共通回帰ゲート

すべての実装 Phase で次を実行する。

```text
npm run build
npm test
npm run test:shuffle
npm run typecheck:test
npm run display:build
npm run display:test
npm --prefix display run typecheck
```

順序依存の可能性がある state、persistence、module scope cache を変更した Phase では `npm run test:shuffle` を省略しない。

### 14.2 SpecialValue

domain ごとに最低限次を parameterized test 化する。

- 要素欠落
- self-closing element
- 空文字
- 空白のみ
- 通常数値
- 全角数値
- 不明
- 定性値
- 下限のみ
- 上限のみ
- 区間
- 未知の condition
- condition と本文の矛盾
- description のみ
- 異体字を含む表示名
- 不正な単位
- 桁あふれ

同じ fixture を parser、formatter、notification、ticker、card、persistence まで通す contract test を用意する。

### 14.3 TelegramMeta／Revision

次の順列を検証する。

- 通常報 → 同一通常報
- 通常報 → 同一 revision 訂正
- 通常報 → 古い訂正
- 通常報 → 新しい訂正
- 通常報 → 対象一致取消
- 通常報 → 対象不一致取消
- 取消 → 遅延通常報
- serial 欠落同士
- serial 片側欠落
- 非数値 serial
- 先頭ゼロ serial
- invalid ReportDateTime
- 未来日時
- 同一 EventID・異なる type family
- 異なる EventID・同一 serial
- primary／backup 同一 messageId
- 異なる messageId・同一 semantic payload

各ケースで state mutation 回数、presentation 回数、notification 回数、stats を検証する。

訂正については次を追加する。

- 実質差分ありの受理済み訂正が一回通知される。
- 実質差分なしの受理済み訂正も一回通知される。
- 通知に `訂正` が明示される。
- 同一 messageId の訂正再送は再通知されない。
- 同一 semantic payload の訂正再送は再通知されない。
- stale／invalid の訂正は通知されない。
- 訂正で第1報専用音が再発火しない。

invalid ReportDateTime については次を追加する。

- current state が変化しない。
- CLI へ診断表示される。
- 診断テロップへ表示される。
- 通常テロップ、カード、地図へ表示されない。
- OS 通知と通知音が発生しない。
- `invalidDateDiagnosed` が一回記録される。

### 14.4 cancellation policy

- `restorePrevious`: 二世代以上の履歴、対象不一致、history なし
- `clearCurrent`: tombstone、遅延報、部分キー取消
- `markCancelled`: active count、final state、再送、遅延報
- persistence restore 後の取消
- 同一 revision 訂正後の取消
- type family をまたぐ明示的 cancellation

### 14.5 deriveIsTest

真理値表:

| head.test | Status | expected |
|---:|---|---:|
| false | 通常 | false |
| true | 通常 | true |
| false | 訓練 | true |
| false | 試験 | true |
| true | 訓練 | true |
| null | 訓練 | true |
| null | 試験 | true |
| null | 通常 | false |
| false | 未知 | false |

さらに envelope と raw XML の不一致、型不正、fixture override を検証する。

### 14.6 地図の色と記号バッジ

最低限、次を screenshot／component test で固定する。

- exact value: 通常色、badge なし
- lower bound: safety rank 色、`≥`
- range: safety upper rank 色、`↔`
- unknown: unknown 色、`?`
- empty: neutral 色、`∅`
- missing: 非描画
- `5弱以上未入電`: 震度5弱色、`≥`
- badge の tooltip とアクセシビリティラベル
- 色覚に依存せず badge とテキストで状態を判別できること
- exact と特殊値の視覚的区別
- 既存の通常震度色が変化しないこと

### 14.7 legacy correlation

- counterpart 先着
- source 先着
- 60秒以内の counterpart 到着
- 60秒 timeout
- ReportDateTime 差が前後5分以内
- ReportDateTime 差が前後5分を超える
- EventID 一致
- EventID 不一致
- EventID 欠落＋コード一致
- 地名だけ一致
- コード不一致
- 候補複数
- 訂正
- 取消
- test telegram
- restart
- cache TTL
- primary／backup 重複

通知条件は次を検証する。

- unmatched high Severity は一回通知する。
- 通知に「対応電文未確認」を明示する。
- unmatched high 未満は表示するが通知しない。
- severity unknown は表示するが通知しない。
- ambiguous は表示するが通知しない。
- counterpart 確認済み source は通知しない。
- timeout 後に通知した source へ counterpart が遅着しても、二重通知や合成取消を発生させない。

### 14.8 コーパス

- repo fixture は再現可能な regression test として保持する。
- WeatherCW は構造と実在の確認に使用する。
- WeatherCW の絶対パスを production code や CI に埋め込まない。
- 実電文から test fixture へ昇格する場合は、必要最小限へ固定し、由来 type と確認した特殊構造をコメントまたは fixture manifest に記録する。
- コーパスに存在しない状態は synthetic fixture で補うが、「実在確認済み」とは区別する。
- Holdback の type 別 override を追加する場合、到着差の実測根拠を characterization data に残す。

## 15. 想定変更ファイル

実装時の想定であり、Phase ごとに必要なものだけを変更する。

### 15.1 共通型・parser 基盤

- `src/types.ts`
- `src/dmdata/xml-shape.ts`
- `src/dmdata/telegram-parser.ts`
- `src/dmdata/volcano-parser.ts`
- `src/dmdata/typhoon-analysis-parser.ts`
- `src/dmdata/briefing-parser.ts`
- `src/dmdata/climate-info-parser.ts`
- `src/dmdata/early-weather-parser.ts`
- `src/dmdata/flood-forecast-parser.ts`
- `src/dmdata/heat-alert-parser.ts`
- `src/dmdata/tornado-parser.ts`
- `src/dmdata/weather-parser.ts`
- `src/dmdata/weather-explanation-parser.ts`
- `src/dmdata/weather-warning-timeseries-parser.ts`
- `src/dmdata/ws-client.ts`
- 新規 `src/dmdata/special-value.ts`
- 新規 `src/dmdata/telegram-meta.ts`
- 新規 `src/dmdata/derive-is-test.ts`

### 15.2 Revision・state・routing

- `src/dmdata/multi-connection-manager.ts`
- `src/engine/messages/message-router.ts`
- `src/engine/messages/route-catalog.ts`
- `src/engine/eew/eew-tracker.ts`
- `src/engine/presentation/processors/process-eew.ts`
- `src/engine/messages/tsunami-state.ts`
- `src/engine/messages/volcano-state.ts`
- `src/engine/messages/vpws50-state.ts`
- `src/engine/messages/vpww56-state.ts`
- `src/engine/messages/flood-forecast-state.ts`
- `src/engine/display/revision-guard.ts`
- `src/engine/display/standby-state-store.ts`
- `src/engine/display/state-store.ts`
- 新規 `src/engine/messages/revision-policy.ts`
- 新規 `src/engine/messages/telegram-ingest-gate.ts`
- 新規 `src/engine/messages/delivery-capabilities.ts`
- 新規 `src/engine/messages/legacy-counterpart-correlator.ts`

### 15.3 Presentation・表示・通知

- `src/engine/presentation/types.ts`
- `src/engine/presentation/events/from-*.ts`
- `src/engine/presentation/events/to-presentation-event.ts`
- `src/engine/display/project-event.ts`
- `src/engine/display/project-standby.ts`
- `src/engine/display/ticker-sentence.ts`
- `src/engine/display/protocol.ts`
- `src/engine/notification/notifier.ts`
- `src/utils/intensity.ts`
- CLI formatter 群
- `display/frontend/src/lib/protocol.ts`
- `display/frontend/src/lib/display-contract.ts`
- 対象カード、テロップ、地図コンポーネント

### 15.4 テスト

- `test/helpers/display-fixtures.ts`
- parser test 群
- `test/engine/eew-tracker.test.ts`
- `test/engine/display/standby-state-store.test.ts`
- `test/engine/display/protocol-sync.test.ts`
- notification／ticker／formatter test 群
- `display/frontend/src/lib/__tests__/display-contract.test.ts`
- 対象 frontend component test 群
- 新規 special-value／telegram-meta／revision-policy／derive-is-test／correlator test

### 15.5 文書

- `docs/specs/dmdata.md`
- `docs/specs/engine.md`
- `docs/specs/ui.md`
- `docs/specs/root.md`
- message pipeline 関連文書

## 16. 決定事項

### U1: legacy counterpart の時間窓と Holdback

**決定済み — 2026-07-31**

中程度の Holdback を採用する。

本仕様上の初期値は次とする。

- source Holdback: 60秒
- correlation window before: 5分
- correlation window after: 5分
- runtime 任意設定: 初期実装では提供しない
- type 別 override: 実電文の到着差を根拠として必要な場合だけ許可する

### U2: unmatched legacy 電文の通知

**決定済み — 2026-07-31**

高 Severity の unmatched legacy 電文だけ通知する。

- Severity にかかわらず fail-open 表示は行う。
- high Severity がコードから確定した場合だけ OS 通知と通知音を許可する。
- high 未満、unknown、コード欠落、ambiguous は通知しない。
- high 判定に名称 fallback を使用しない。
- 通知には「対応電文未確認」を明示する。

### U3: invalid ReportDateTime 電文の可視化

**決定済み — 2026-07-31**

CLI と診断テロップにだけ表示し、通知しない。

- current state を変更しない。
- ReportDateTime を now へ変換しない。
- 通常テロップ、カード、地図へ出さない。
- OS 通知と通知音を発行しない。
- durable active state として永続化しない。
- 監査ログと統計は記録する。

### U4: 地図上の unknown／qualitative の意匠

**決定済み — 2026-07-31**

色と記号バッジを使用する。

- exact: 通常色、badge なし
- lower bound／`以上`: safety rank 色、`≥`
- range: safety upper rank 色、`↔`
- unknown: unknown 色、`?`
- empty: neutral 色、`∅`
- missing: 非描画
- `5弱以上未入電`: 震度5弱色、`≥`

badge の意味を凡例、tooltip、テキスト、アクセシビリティラベルにも反映する。

### U5: 同一 revision 訂正の通知条件

**決定済み — 2026-07-31**

訂正は、共通 gate が受理するたびに `訂正` を明示して通知する。

- presentation 上の実質差分がなくても通知する。
- transport duplicate と semantic duplicate は受理前に除外し、再通知しない。
- stale、invalidRevision、invalidMeta は通知しない。
- 訂正を新規イベントまたは第1報として扱わない。
- 第1報専用音を再発火しない。
- severity と通常の通知音規則は訂正後 payload から導出する。

## 17. 全体完了条件

本仕様の完了条件は次のとおりとする。

- 対象特殊値が `SpecialValue` で表現され、missing、empty、unknown、qualitative、range が失われない。
- unknown が数値0、低 rank、now、解除へ変換されない。
- 全 parser と PresentationEvent が共通 `TelegramMeta` と `deriveIsTest` を使用する。
- 同一 revision 訂正が置換され、通常の同一 revision は重複排除される。
- 受理済み訂正が実質差分の有無にかかわらず `訂正` を明示して一回通知される。
- cancellation policy が全 revisionFamily で明示されている。
- invalid ReportDateTime と不正 serial が active state を変更しない。
- invalid ReportDateTime が CLI／診断テロップだけに表示され、通知されない。
- 通知前に transport／semantic の共通重複排除が完了する。
- VXSE44 は配送確認なしに抑止されない。
- VPOA50、VPNO50、VXWW50 は counterpart 未確認時に60秒 Holdback 後、fail-open 表示される。
- unmatched legacy はコードから high Severity が確定した場合だけ通知される。
- 津波予報区と Kind がコードを一次キーにする。
- `未入電` と `5弱以上未入電` が異なる safety semantics を持つ。
- 地図の特殊値が色と記号バッジの双方で識別できる。
- protocol と永続化で raw、presence、condition、description、bounds が round-trip する。
- 全 Phase で既存機能の回帰が 0 件である。
