# 電文基盤共通化仕様 — 特殊値・TelegramMeta・Revision・試験判定・条件付き抑止

> 状態: **Phase 5B・5C 完了（main 合流、最終レビュー GO、仕様同期済み）**
> 更新日: 2026-08-10
> 対象: FlEq parser／Presentation／CLI／通知／テロップ／常設ディスプレイ／永続化
> 実装同期基準: HEAD `da5f5a5`（Phase 5B `0e964f5` と Phase 5C を main へ合流、両 Phase 最終レビュー GO）
> 起草時参照基準: HEAD `f634e410`
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
| `empty` | 要素は存在するが空、または空白のみ | self-closing／長さ 0 は `""`、空白のみは元の空白文字列をそのまま保持 | `null` | なし |
| `unknown` | 「不明」「観測できず」「未入電」など、値が不明と明示される | 元文字列 | `null` | 原則なし |
| `qualitative` | 「巨大」「高い」「ごく浅い」「5弱以上未入電」など、定性的意味がある | 元文字列 | `null` | 意味が定まる場合のみ設定 |
| `range` | 上限、下限、区間で表現される | 元文字列 | `null` | 一方または双方を設定 |

### 3.3 不変条件

- `presence === "value"` のとき `value` は必須とする。
- `presence !== "value"` のとき `value` は `null` とする。
- `range` は `lowerBound`、`upperBound` の少なくとも一方を持つ。
- `qualitative` は bounds を持たなくてもよい。
- `missing` と `empty` を相互変換しない。
- `empty.raw` は round-trip の全境界で完全一致させる。空白のみの raw を `""` へ trim せず、self-closing と空白のみを同一化しない。
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

特殊語と本文／`Condition` の優先順位は domain ごとに次で固定する。既知の特殊語を generic な文字列判定だけで分類しない。

| domain value | 語・出現箇所 | presence | 本文と `Condition` が矛盾した場合 |
|---|---|---|---|
| TsunamiHeight | `観測中`（本文または `Condition`） | `qualitative` | 数値本文があれば数値を `value` とし、`観測中` は進行状況として `condition` に保持する。数値がなければ `qualitative` を正とする |
| PlumeHeight | `雲中`（本文または `Condition`） | `qualitative` | 観測阻害の意味を持つ `Condition` を正とし、矛盾する数値本文は値として採用せず raw と診断へ残す |
| PlumeHeight | `観測できず`（本文または `Condition`） | `unknown` | `Condition` を正とし、矛盾する数値本文は採用しない |
| Pressure | `解析不能`（本文または `Condition`） | `unknown` | `Condition` を正とし、矛盾する数値本文は採用しない |
| Intensity | `未入電` | `unknown` | 既知の `Condition` を正とし、数値 rank へ変換しない |
| Intensity | `5弱以上未入電` | `qualitative` | 既知の `Condition` を正とし、`lowerBound:"5-"` を設定する |
| Magnitude | `Ｍ８を超える巨大地震`（description、本文、`Condition` のいずれか） | `qualitative` | 巨大地震の description を正とし、矛盾する数値本文は採用せず raw と診断へ残す |
| Depth | `ごく浅い`（Coordinate 深さ成分 0、または description／`Condition`） | `qualitative` | Coordinate 数値が 0 以外で矛盾する場合は数値を `value` とし、`ごく浅い` は採用せず raw と診断へ残す |
| Depth | `以上`／`以下` を含む bound 表現（description または `Condition`） | `range` | Coordinate 数値と整合する場合は bound として合成する。矛盾する場合は数値を `value` とし、qualifier は採用せず raw と診断へ残す |

- 数値本文を採用する例外は、上表の TsunamiHeight のように特殊語が値の無効化ではなく進行状況を表すと明記した場合だけとする。
- 未知の `Condition` と valid な本文が矛盾する場合は本文を `value` として保持し、未知 `Condition` も失わず `unmappedSpecialValue`／`specialValueConflict` を記録する。未知語から値の無効化を推定しない。

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
| 永続化 | 全フィールド保存 | `raw:null` | 元 raw を空白も含め完全保存（長さ0／self-closing のみ `raw:""`） | raw・condition 保存 | raw・bounds 保存 |

共通規約として、通知やテロップで qualifier を削って通常値のように表示してはならない。

Depth の既知定性語「ごく浅い」は、内部 semantic に `upperBound: 5`（km）を持つが、定性語表示を維持し、カード／地図では `?` badge を付けない。この例外を他 domain の upper-only `qualitative` へ一般化しない（2026-08-10 ユーザー裁定）。

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
| Depth の `ごく浅い`（`qualitative`、`upperBound: 5`） | safety rank 色 | なし |
| qualitative かつ bounds なし | unknown 色 | `?` |
| unknown | unknown 色 | `?` |
| empty | neutral 色 | `∅` |
| missing | 非描画 | なし |

- `5弱以上未入電` は震度5弱の色と `≥` badge を使用する。
- upper-only `qualitative` の badge なしは Depth の既知「ごく浅い」だけの例外とし、他 domain は従来どおり unknown 色と `?` badge を使用する。
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
- 永続状態の解除は、§5.5 の A: `InfoType=取消`、B: lifecycle terminal、C: active state deactivation を registry で評価し、解決済み trigger と cancellation policy で判断する。

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
- 未来方向の許容 skew は `FUTURE_REPORT_DATETIME_SKEW_MS = 15 * 60_000` とする。`receivedAtMs` より15分以内の未来日時は clock skew として valid のまま扱う。
- 15分を超える未来日時は `valid:false`、`epochMs:null` とし、理由 `futureSkewExceeded`、raw 値、差分 ms を監査ログと `futureDateDiagnosed` 統計へ記録する。
- 不正値を `Date.now()`、受信時刻、ファイル時刻へ昇格させない。
- 不正日時および許容 skew 超過の未来日時は fail-closed とし、現在状態を置換、解除、巻き戻しできない。
- `receivedAtMs` はログ、TTL、相関待機時間にだけ使う。
- invalid ReportDateTime／`futureSkewExceeded` の電文は CLI と診断テロップにだけ transient 表示する。
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

状態 identity は revision identity と分離する。標準形は次とする。

```text
domain + revisionFamily + stateSubjectKey
```

`revisionFamily` の既定値は `type.value` とする。

異なる head.type が同じイベント状態を更新する場合は、domain registry で type family を明示する。暗黙に type を無視してはならない。

registry は revisionFamily ごとに少なくとも次を持つ。

```ts
export type RevisionFamilyPolicy<TParsed, TItem = never> = {
  domain: string;
  revisionFamily: string;
  headTypes: readonly string[];
  comparator: "reportDateTimeThenSerial" | "serialOnly";
  extractStateSubjectKey: (
    meta: TelegramMeta,
    parsed: TParsed,
  ) => string | readonly string[] | null;
  extractCancellationTarget: (
    meta: TelegramMeta,
    parsed: TParsed,
  ) => readonly string[] | null;
  cancellationPolicy: CancellationPolicy;
  terminalPredicate: (meta: TelegramMeta, parsed: TParsed) => boolean;
  deactivationPredicate: (meta: TelegramMeta, parsed: TParsed) => boolean;
  durable: boolean;
  tombstoneRetentionMs: number | null;
  maxSubjects: number | null;
  allowMissingSerial?: boolean;
} & (
  | {
      fragmentMerge: false;
      extractItems?: never;
      itemSubjectKey?: never;
      itemFingerprint?: never;
      fingerprintVersion?: never;
      fragmentEvidence?: never;
    }
  | {
      fragmentMerge: true;
      fragmentAllowlistKey: FragmentMergeAllowlistKey;
      extractItems: (parsed: TParsed) => readonly TItem[];
      itemSubjectKey: (
        meta: TelegramMeta,
        item: TItem,
      ) => string | null;
      itemFingerprint: (item: TItem) => string;
      fingerprintVersion: string;
      fragmentEvidence: {
        corpusFixtures: readonly string[];
        regressionTests: readonly string[];
        rationale: string;
      };
    }
);
```

- `stateSubjectKey` は EventID を必須とはしない。EventID、火山コード、発表官署、weather source、対象日、地域コード、観測点コードなど、実際に state holder が分離している粒度を registry が組み立てる。
- authoritative なコードだけで完全な subject key を抽出できる domain は、EventID 欠落時もその key で更新できる。EventID を名称や受信時刻で補完しない。
- subject key が不完全で `null` となった電文は fail-open 表示してよいが、durable state、watermark、tombstone を変更しない。
- `extractCancellationTarget` は解除対象の完全な subject key の集合を返す。部分キーしか得られない取消は、一致が一意に証明できる既存 subject だけへ適用し、revisionFamily 全体の一括解除へ拡張しない。
- `durable` は gate entry を persistence v2 へ保存する family だけ `true` とする。`false` の family は process lifetime 中だけ watermark／tombstone を保持し、再起動後の復元を契約しない。
- `tombstoneRetentionMs` は family 固有の保持期間である。`null` は無期限を表すが、必ず有限の `maxSubjects` と組み合わせる。
- `maxSubjects` field は全 family で必須とし、登録 policy では非 `null` の有限値を要求する。family 内の whole-message subject と item subject の合計上限を表し、宣言値だけでなく起動時 validation と gate admission でも強制する。
- `allowMissingSerial` は実 fixture で Serial 欠落が確認され、日時だけで安全に順序付けできる family に限って明示する。未指定時は numeric serial を必須とする。
- VFVO51 の複数火山一覧は火山コードごとに一件へ展開し、各 entry を独立した `stateSubjectKey` として gate に通す。EventID が欠落しても火山コードが valid なら更新できる。
- VFVO51 の `alertClass.isActive === false` は、その entry の火山コードに対応する alert subject だけを解除する。同じ火山の eruption event や、同じ電文に含まれる別火山を解除しない。
- 旧 `domain + revisionFamily + EventID` state は、Phase 3B の reader が domain 固有情報から subject key を再構成できる場合だけ新 key へ移す。再構成不能または複数候補になる entry は表示復元専用とし、取消対象・watermark には採用しない。

`fragmentMerge:true` は型上も registry 上も allowlist 制とする。

- `fragmentAllowlistKey`、`extractItems`、`itemSubjectKey`、`itemFingerprint`、`fingerprintVersion`、`fragmentEvidence` の六つが揃わない family は起動時検証を失敗させる。
- `itemSubjectKey` は item の authoritative なコードから安定生成し、配列位置、表示名、受信時刻を使用しない。key が `null` の item は fail-open 表示してよいが durable merge しない。
- `itemFingerprint` は subject key を除く全 semantic field、`SpecialValue.raw`、presence、condition、description、bounds を順序固定の canonical form から生成する。transport ID、telegram 内の item 順、受信時刻を含めない。fingerprint algorithm／version は `fingerprintVersion` として registry entry に固定し、移行なしに変更しない。
- 有効化には、同一 revision の分割・補完があり得ることを示す repo corpus、item key の一意性、merge／訂正／取消規則、到着順を反転した regression test を `fragmentEvidence` に列挙する。
- 現在の allowlist は `tsunamiObservation:VTSE51` と `tsunamiObservation:VTSE52` だけとし、両者の revision 系列は独立させる。根拠は repo fixture `32-39_11_10_250206_VTSE51.xml` と `61_11_01_250206_VTSE52.xml` が観測点コードを持つ反復 item 構造を示し、`test/engine/display/state-store.test.ts` の VTSE51／52 観測点コード単位 merge baseline が部分報・遅延旧報の保持規則を固定していることとする。
- 上記 corpus は station-scoped identity の実在根拠であり、同一 revision 分割到着そのものは synthetic regression で補う。この限界を `fragmentEvidence.rationale` に明記する。
- allowlist の追加は、型を `true` にするだけでは認めない。本節の corpus／test 根拠を伴う仕様変更と registry validation の更新を必須とする。

### 5.2 比較規約

比較結果は数値ではなく次の union で返す。

```ts
export type RevisionRelation =
  | "newer"
  | "equal"
  | "older"
  | "unordered";
```

既定 comparator `reportDateTimeThenSerial` の比較順序は次のとおりとする。

1. domain、revisionFamily、抽出済み stateSubjectKey が同じか確認する。EventID を identity に含める family では、registry が stateSubjectKey の一部として比較する。
2. 両方の ReportDateTime が valid なら時刻を比較する。
3. ReportDateTime が同じ場合、両 serial が valid なら numeric を比較する。
4. 必要な要素が不正または片側だけ欠落している場合は `unordered` とする。
5. 非数値 serial の辞書順比較をしない。
6. `unordered` を `equal` とみなさない。

EEW（VXSE43／44／45）は現行 `EewTracker` の serial 主順序を正とし、revisionFamily registry で `comparator:"serialOnly"` を必須 override とする。

1. 同一 EventID、同一 head.type 内で、両 serial が valid なら numeric serial を先に比較する。
2. numeric serial が同じなら ReportDateTime の前後にかかわらず `equal` とする。EEW comparator は日時を tie-breaker に使用しない。
3. serial が小さい電文は ReportDateTime が新しくても `older`、serial が大きい電文は ReportDateTime が古くても `newer` とする。
4. serial 不正・欠落は `unordered` とし、ReportDateTime だけで EEW state を置換しない。
5. §4.4 の ReportDateTime validation は comparator 前に適用するが、valid な日時同士の大小は EEW revision relation に影響させない。

registry に未登録の comparator override を暗黙に推定しない。

### 5.3 InfoType ごとの判断

| InfoType | newer | equal | older | unordered |
|---|---|---|---|---|
| 発表 | accept | duplicate、ただし `fragmentMerge` family は `mergeFragment` | stale | invalidRevision |
| 訂正 | accept | replaceCorrection | stale | invalidRevision |
| 取消 | domain policy を適用 | domain policy を適用 | stale | invalidRevision |
| 不正・欠落 | invalidMeta | invalidMeta | invalidMeta | invalidMeta |

revision gate は副作用のない `evaluate` と、採用を確定する `decide` に分離する。

1. parser 後に `evaluate` で relation、semantic duplicate、取消 latch、capacity を判定する。この時点では watermark／tombstone／semantic key を変更しない。
2. `evaluate` が拒否した invalid metadata、stale、unordered は既存の抑止／診断経路へ送る。受理候補には domain の safety check と projection preview を行い、異常放流量などの unsafe preview は既存の warning 表示／通知候補へ送ってよいが `decide` しない。
3. safety check を通過した入力だけ `decide` し、gate、holder、projection、通知、永続化を順に更新する。

この分離により、unsafe な新 revision が watermark だけを先行消費し、同 revision の正常な再送を拒否することを禁止する。
解析対象 item が全件 unknown など、解除とも active 更新とも断定できない入力は `observeOnly` とする。受理済み revision／投影完了 token は進めてよいが、active payload を消去・置換せず、deactivation／tombstone を成立させない。

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

`fragmentMerge:true` の revisionFamily は、通常報の relation が `equal` でも telegram 全体を duplicate として捨てず、parsed item を item gate へ渡す。

- transport ID duplicate は従来どおり item gate 前に拒否する。
- item gate は観測点コードなどの `itemSubjectKey` と item fingerprint を使用する。
- 同じ item の完全な再送は拒否し、同一 revision の未見 item、分割報、補完報は merge する。
- whole-message の semantic duplicate は、未見 item が一件もないことを item gate で確認した後にだけ確定する。
- 津波 VTSE51／52 の station merge を初期適用とし、同一 revision で別観測点が分割到着した場合は両方を保持する。同一観測点の明示訂正は `InfoType=訂正` の規則で置換する。

### 5.4 訂正通知

2026-07-31 の決定により、訂正は共通 gate で受理され、かつ経路固有の通知適格性 filter を通過するたびに通知する。

- U2 は unmatched legacy 経路の通知適格性 filter であり、U5 より先に評価する。
- unmatched legacy の訂正は、コードから高 Severity が確定した場合だけ通知適格とする。適格な high 訂正にだけ U5 の `訂正` 明示、一回通知、重複排除を適用する。
- high 未満、severity unknown、コード欠落、ambiguous の unmatched legacy 訂正は state／表示へ反映しても通知しない。
- legacy 以外は、既存 domain の通常通知対象外という明示規則がない限り、受理済み訂正へ U5 を適用する。

- 通知タイトルまたは本文へ `訂正` を明示する。
- presentation 上の実質差分がなくても、通知適格な受理済み訂正は通知する。
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

取消／終端／非活性化の trigger は `InfoType === "取消"` だけに限定しない。registry は次の A〜C の成立有無を収集し、単一 trigger へ解決する。

- A. 明示取消: `meta.infoType.value === "取消"`。`extractCancellationTarget` が返した subject に `cancellationPolicy` を適用する。
- B. lifecycle 終端: `terminalPredicate(meta, parsed) === true`。台風の `transitionedToLow`／`formationCancelled` など、現象が terminal state へ移った subject に policy を適用する。
- C. active state の非活性化: `deactivationPredicate(meta, parsed) === true`。火山 `alertClass.isActive === false`、`action === "release"`／`"cancel"`、噴火警戒レベル1への引下げなどを alert subject の解除として扱う。

優先順位は `A > B > C` とする。

```ts
const resolvedTrigger =
  explicitCancellation ? "explicitCancellation"
  : terminal ? "terminal"
  : deactivation ? "deactivation"
  : null;
```

- `resolvedTrigger` と `isCorrection` は別フィールドとして保持する。訂正と A／B／C が同時成立した場合も、mutation kind は `resolvedTrigger` に対応する policy とし、訂正属性だけを失わない。
- A が成立した場合、parser が同じ入力から `action:"cancel"` を生成して C も成立していても A だけを適用する。現行 `volcano-parser.ts` の `InfoType=取消 → action=cancel` がこの実例である。
- A が不成立で B と C が同時成立した場合は、lifecycle 全体の終端を表す B を適用し、C の部分解除を別処理として重ねない。
- 成立した raw predicate の集合は診断用に記録してよいが、state mutation、`cancelApplied`／関連 stats、presentation、通知、永続化は `resolvedTrigger` から一度だけ実行する。
- `extractCancellationTarget` の返却値は重複排除した subject key 集合へ正規化し、同一 telegram／revision／subject key に対する policy 適用を exactly-once とする。
- 同一 subject の二重 clear、二重 tombstone、二重 stats、A/B/C ごとの二重通知を禁止する。複数の異なる subject を含む batch は各 subject を一度ずつ mutation し、通知は domain の単一 batch 規則に従う。
- A〜C のいずれでも対象 key の抽出と revision 判定を先に行う。target 不一致、stale、unordered は current state を変更しない。C は非活性になった state class だけを解除し、同じ subject の別 class の履歴や event を巻き添えにしない。

#### restorePrevious

- 取消対象が現在 revision と一致した場合だけ、一つ前の完全 snapshot を復元する。
- history がない場合は current を空にする。
- watermark／tombstone は維持し、遅延した旧報を復活させない。
- 部分データから過去状態を合成しない。

#### clearCurrent

- 対象となる current state を消す。
- previous revision は復元しない。
- tombstone を残し、取消以前の遅延電文を拒否する。
- tombstone と同一 revision の非取消報は、`InfoType=訂正` であっても解除を許可しない。復活には strictly newer な revision を必要とする。
- この latch は `clearCurrent` family の契約である。EEW の `markCancelled` は、同一 family の正当な訂正または newer 続報が final／cancel lifecycle を置換できる既存契約を維持する。
- EventID、type family、地域コードなど domain key に一致する範囲だけを消す。

#### markCancelled

- イベントを取消済みの terminal state として保持する。
- アクティブ件数や警報表示から除外する。
- 取消表示、監査ログ、遅延報抑止に必要な最小情報を保持する。

### 5.6 domain 間の実装差と正規化先

Phase 3B 完了時の registry は次を正とする。保持期間の「runtime」は process lifetime 中だけ有効で、再起動時には失われる。

| domain／revisionFamily（head.type） | state subject 粒度 | policy | durable／保持期間 | `maxSubjects` |
|---|---|---|---|---:|
| EEW／VXSE43、VXSE44、VXSE45 | family ごとの EventID | `markCancelled` | 非永続／11分 runtime | 各512 |
| weather／VPWS50 | 固定 `weather:vpws50` | `restorePrevious` | 永続／無期限 | 1 |
| weather／VPWW56 | `(head.type, publishingOffice)` stream | `clearCurrent` | 永続／6時間 | 128 |
| tsunami／VTSE41 | 固定 `tsunami:current` | `clearCurrent` | 永続／無期限 | 1 |
| tsunamiObservation／VTSE51、VTSE52 | family whole subject＋観測点コード item | `clearCurrent` | 永続／無期限 | 各1,025（whole 1＋station 1,024） |
| volcano／volcanoAlert（VFVO50、VFVO51、VFSVii） | 火山コード | `clearCurrent` | 永続／30日 | 512 |
| volcano／volcanoEruption（VFVO52、VFVO56） | 火山コード | `clearCurrent` | 永続／2日 | 512 |
| volcano／volcanoAshfall（VFVO53〜55） | `(head.type, 火山コード)` | `markCancelled` | 非永続／36時間 runtime | 128 |
| volcano／volcanoTransient（VZVO40、VFVO60） | `(head.type, EventID)` | `markCancelled` | 非永続／36時間 runtime | 128 |
| floodForecast（VXKO50〜89、VXSU50〜59） | EventID | `clearCurrent` | 永続／36時間 | 512 |
| tornado（VPHW50、VPHW51） | 正規化した発表官署 stream | `clearCurrent` | 永続／36時間 | 128 |
| heatAlert／VPFT50 | `(JST対象日, 対象地域)` | `clearCurrent` | 永続／3日 | 256 |
| typhoonAnalysis（VPTW60〜62） | typhoon EventID | `clearCurrent` | 永続／7日 | 64 |
| typhoonProbability／VPTA50 | EventID | `clearCurrent` | 非永続／7日 runtime | 256 |
| nankaiTrough／nankaiTrough（VYSE50〜52、VYSE60） | 固定 `nankai:current` | `clearCurrent` | 永続／30日 | 1 |
| nankaiTrough／nankaiInformation（VYSE50〜52、VYSE60） | `(head.type, EventID)` | `clearCurrent` | 非永続／30日 runtime | 256 |
| weatherWarningTimeseries／VPWP50 | `(発表官署, 対象コード／名称／全域)` | `clearCurrent` | 非永続／36時間 runtime | 512 |
| lgObservation／VXSE62 | EventID | `markCancelled` | 永続／36時間 | 256 |
| earthquake（VXSE51〜53、VXSE61） | type をまたぐ EventID | `markCancelled` | 非永続／24時間 runtime | 512 |
| seismicText（VXSE56、VXSE60、VZSE40） | `(head.type, EventID)` | `markCancelled` | 非永続／36時間 runtime | 256 |
| briefing／VPBS50 | `(head.type, EventID)` | `markCancelled` | 非永続／36時間 runtime | 128 |
| earlyWeather／VPAW51 | `(head.type, EventID)` | `markCancelled` | 非永続／7日 runtime | 128 |
| climateInfo（VPZI50、VPCI50） | `(head.type, EventID)` | `markCancelled` | 非永続／30日 runtime | 128 |
| weatherExplanation（VPCJ51、VPZJ51、VPFJ51、VMCJ53〜55） | `(head.type, EventID)` | `markCancelled` | 非永続／36時間 runtime | 256 |
| weather／VPWW55、VPWW57〜61 | `(head.type, EventID)` | `markCancelled` | 非永続／36時間 runtime | 128 |
| raw fallback | `(head.type, EventID)`。欠落時は単発 transient key | `markCancelled` | 非永続／11分 runtime | 512 |

- `typhoonAnalysis` の `transitionedToLow`／`formationCancelled` は B（terminal）として解決する。
- 洪水は station が全件 unknown のとき `observeOnly` とし、解除 tombstone を作らない。VXSU の observed series 非保持契約も維持する。
- VTSE51／52 は holder と gate の station 上限・LRU 順序を同じ 1,024 件にし、family 取消時は item watermark を除去して whole tombstone だけを残す。
- 火山 eruption の旧 v1 key は、実 EventID 由来と火山コード fallback 由来の provenance を区別する。空コード取消の EventID 逆引きは実 EventID 由来だけを対象とし、legacy-v1 由来候補と live EventID 欠落 event も混同しない。
- subject を抽出できない入力は family 固有 TTL／`maxSubjects` を使う単発 transient key で重複排除する。authoritative mutation は行わず、表示／ticker だけを fail-open し、通知と durable projection を抑止する。

同じ Presentation domain 内で policy が異なる場合があるため、registry のキーを domain だけにしてはならない。

新しい revisionFamily を追加したとき cancellation policy、subject extractor、cancellation target extractor、terminal predicate、deactivation predicate、durability、retention、`maxSubjects` のいずれかが未登録なら、コンパイルまたは起動時検証を失敗させる。暗黙の既定 policy／predicate／capacity は置かない。
終端／非活性化を持たない family も predicate を省略せず、常に `false` を返す実装を明示登録する。

### 5.7 共通重複排除

処理順序を次に統一する。

```text
transport validation
  → TelegramMeta 抽出
  → transport ID dedup
  → parser
  → revision evaluate（副作用なし）
  → domain safety check／observe-only 判定
  → revision decide（commit）
  → item gate / semantic dedup
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
   - stateSubjectKey、revisionFamily、ReportDateTime、serial、InfoType、payload fingerprint が同じ電文

payload fingerprint は canonical payload の SHA-256 digest とし、永続化する semantic key を固定長にする。各 gate entry は InfoType prefix 付き digest の直近32件だけを順序付き集合として保持する。pre-digest v2 を読む場合も SHA-256 へ圧縮し、重複除去後の直近32件へ compact する。

`fragmentMerge:true` の family では、2 の判定を item gate 後へ遅延する。equal revision を telegram 単位で先に捨ててはならない。

通知は両方の重複排除を通過した後にだけ実行する。

訂正は、重複排除を通過して共通 gate が受理され、§5.4 の通知適格性 filter を通過した場合、実質差分の有無にかかわらず訂正通知を一回発行する。

容量は global LRU ではなく family partition とする。

- `maxSubjects` は各 family の通常 subject、item subject、EventID 欠落時の transient subject を合算した hard limit である。
- 各 `maxSubjects` は1以上16,384以下でなければならず、全登録 family の宣言値合計も16,384以下でなければ起動を失敗させる。無期限 durable family の合計にも同じ検証を適用する。Phase 3B 完了時の宣言値合計は9,285件である。
- 新 subject 受理時は同じ family 内の期限切れ／退場可能 entry だけを整理する。他 family の watermark／tombstone を容量確保のために削除しない。
- 無期限 tombstone や明示保護 entry だけで family が満杯なら、新 subject を fail-closed で拒否して capacity stats／warning を一度記録する。既存 subject の更新は許可し、family size が実際に上限未満へ戻るまで warning latch を再武装しない。
- holder が独自 item 上限を持つ family は gate と同じ LRU 更新順・退場対象を使う。VTSE51／52 は station 1,024件と whole subject 1件を合わせて1,025件とする。
- 非永続 family も宣言した `tombstoneRetentionMs` を runtime TTL として使用する。保持は process lifetime 内だけであり、再起動後の遅延報拒否は保証しない。

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
- `futureDateDiagnosed`
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

### 7.4 quake-observation-merge

現行 `quake-observation-merge` の baseline を共通 state 更新後も維持する。

- 同一の非空 EventID について、VXSE51 で取得済みの観測震度があり、後続 VXSE52／VXSE61 の震度要素が構造的に `missing` の場合だけ、既存 `maxInt`、`maxIntRank`、`intensityGroups` を保持する。
- 震源名、発生時刻、Magnitude、Depth などの震源諸元は後続 VXSE52／VXSE61 の値を採用する。
- `unknown`、`empty`、`qualitative` は `missing` とみなさない。電文が明示した状態として置換し、前回の観測値を自動維持しない。
- `InfoType=訂正` で震度要素が明示された場合は、通常の訂正規約に従って置換する。取消は観測値保持を行わず、cancellation policy に従う。
- EventID 欠落または不一致では観測値を別電文へ持ち越さない。
- latest quake、recent quake、daily counter、永続化 restore 後で同じ helper／同じ意味規則を使用する。

## 8. EEW 同一 serial 訂正

### 8.1 revision

EEW の重複判定を `serial <= lastSerial` だけで行わない。

EEW revisionFamily は §5.2 の `serialOnly` comparator override を使用する。これは現行 `EewTracker` の serial 主順序を正規化する契約であり、共通既定の日時主順序へ戻したり、同一 serial を日時で newer／older に分けたりしてはならない。

- 同一 type、同一 serial: ReportDateTime にかかわらず revision relation は `equal`
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
- 予報区と観測点の警報種別結合は Area.Code で行う。観測側の code が欠落する場合は、同名でも結合しない。
- 常設ディスプレイの予報区行、種別 group、観測行は code を identity に含める。表示ラベルは Name を使うが、Name の一致や変更を行 identity にしない。

### 10.4 TsunamiHeight semantic と表示順序

- parser／engine 内部は `maxHeight: SpecialValue<number>` を真実源とする。`maxHeightDescription`／`maxHeightValue` は既存 CLI と旧 protocol の表示互換 scalar であり、semantic がある経路では比較のために再解析しない。
- display protocol は `DisplayTsunamiHeightSemanticV1` に `raw`、presence、label、condition、description、value、numeric／raw bounds、badge、color、render を明示する。§3.7 の永続化列と同じく元の qualifier を落とさない。
- badge／color／描画規則は §3.8 に従う。exact は badge なし、lower-only は `≥`、upper-only／両側 range は `↔`、bounds なし qualitative／unknown は `?`、empty は `∅`、missing は非描画とする。
- 高さの大小は `value ?? upperBound ?? lowerBound` を比較値とする。同じ比較値では `lower-only > exact > upper-only／両側 range` の順とし、range は上限値で安全側に比較する。この順序は bucket の並びと最大観測選定だけに使い、raw／label／badge は変更しない。
- bounds のない既知 qualitative は、既存表示の安全順序を維持するため `巨大` を最上位、`高い` を 3m 相当かつ同値の lower-only より上位とする内部比較値だけを持つ。表示値や永続値を数値へ推定せず、`観測中` 等の状態表現は最大観測選定から除外する。
- 予報区の height semantic と観測点の height semantic は別々に投影する。観測 projection は内部 `maxHeight` を wire へ spread せず、明示した観測 field と `maxHeightSemantic` だけを出力する。semantic がない旧 V1 観測は scalar のまま通す。

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
const LEGACY_CORRELATION_RETENTION_MS =
  LEGACY_SOURCE_HOLDBACK_MS
  + LEGACY_CORRELATION_WINDOW_BEFORE_MS
  + LEGACY_CORRELATION_WINDOW_AFTER_MS; // 11分
```

- source 先着時は最大60秒待機する。
- ReportDateTime の許容範囲は counterpart の前後5分とする。
- EventID が一致していても、時間窓外なら自動抑止しない。
- type 別の実測で60秒を超える正当な到着差が確認された場合、type 別 override を追加できる。
- override は fixture／コーパス根拠、最大値、理由を registry に明記する。
- runtime 設定による任意変更は初期実装に含めない。
- Holdback 中も受信統計を記録し、表示・通知統計は判定確定後に記録する。
- source／counterpart の相関 record は source 受信から11分保持する。表示 state 自体の TTL は既存 domain 規則を使い、Holdback や遅着で延長しない。

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
- timeout 後も11分の相関保持期間内に valid な counterpart が遅着した場合、表示中の source を atomically counterpart の canonical 表示へ切り替え、source は active surface から除く。source は監査ログにだけ残す。
- 遅着による切替では source の通知を撤回せず、合成取消も通知しない。counterpart 自体の通知は共通 dedup gate に従う。
- 相関保持期間を過ぎた遅着は既存 source 表示を遡及変更せず、新しい unmatched 入力として扱う。
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

- この高 Severity 判定は U5 より先に適用する通知適格性 filter である。訂正であっても filter を迂回しない。
- CLI、テロップ、カードによる fail-open 表示は Severity にかかわらず行う。
- OS 通知と通知音は `isHighSeverity === true` の場合だけ発行する。
- high 判定は type 名やタイトル文字列ではなく、抽出した現象コード、Kind コード、警報レベルを domain resolver へ渡して行う。
- domain resolver が高 Severity を確定できない場合は通知しない。
- unknown code、コード欠落、相関 ambiguous は表示するが通知しない。
- high 判定に名称 fallback を使用しない。
- 通知には `対応電文未確認` または同等の qualifier を明示する。
- counterpart が Holdback 内に到着して source が抑止された場合、source 側通知は行わない。
- timeout 後に通知済みとなった source へ counterpart が遅着しても、通知を撤回したり取消通知を合成したりしない。
- 高 Severity が確定した受理済み訂正だけ、通知へ `訂正` と `対応電文未確認` の双方を明示する。high 未満／unknown／ambiguous の訂正は表示だけ更新する。
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
- `legacyLateCounterpartReconciled`
- `legacyLateCounterpartExpired`

## 12. 永続化・protocol

### 12.1 schema version

Phase 3B で schema version 2 を導入済みとする。互換期間は version 2 envelope 内の legacy projection だけで rollback 互換とみなさず、次の二ファイルを毎回生成する。

| path | 役割 | version |
|---|---|---:|
| `data/runtime/display-active-state-v2.json` | canonical。共通 gate、holder、projection coupling の真実源 | 2 |
| `data/runtime/display-active-state-v1.json` | rollback 用。旧 binary がそのまま読める真正 v1 | 1 |

- writer は同一確定 snapshot から v2 と v1 を生成し、それぞれ固有 tmp へ書いた後、v2、v1 の順に rename する。通し番号より古い非同期 write は rename しない。
- load は canonical v2 を優先する。v2 が valid な場合も standalone v1 を読み、新旧二ファイルと v2 envelope 内の legacy projection を照合する。
- canonical v2 がない場合は standalone path の真正 v1 を migration reader で読む。Phase 3B 導入途中に同 path へ書かれた version 2 も互換入力として読む。
- 新旧矛盾は canonical v2 を正とする。一回の `load()` 内で複数箇所の矛盾が見つかっても、`persistenceMigrationConflict` は一回だけ計上する。
- rollback 用 v1 の `seen`／flood `seen` は trusted な v2 gate entry から再投影する。同一 key に untrusted な旧 seen があっても新 gate 投影を優先する。

v2 の `telegramFoundation` は domain ごとに holder state、active projection、gate entries を保持する。reader は domain を独立に sanitize し、壊れた domain または event／subject だけを空へ落とす。他 domain の valid watermark／tombstone を巻き添えにしない。洪水のように active projection と gate の semantic coupling を証明できない場合も、その event の projection だけを除外し、検証済みの別 EventID の tombstone は保持する。

durable projection の完了証明は次による。

- projection の内容由来 revision と、gate をどこまで適用処理したかを示す `appliedRevision` を分離する。`observeOnly` では内容 revision が遅行してよいが、`contentRevision <= appliedRevision` を満たす。
- `appliedRevision` は対応 gate の revision と、日時だけでなく serial の presence／numeric 値まで意味的一致しなければならない。numeric serial 必須 family では `valid:true`、数字列 raw、numeric 一致を gate-only tombstone を含む全 entry に要求する。Serial 欠落を許す family は registry の `allowMissingSerial` と domain policy に従って明示的に検証する。
- `appliedSemanticKey` は gate の最後に受理した semantic key と一致しなければならない。同一日時・同一 serial の訂正でも旧通常報 projection を「適用済み」とみなさない。
- projection revision 自体を applied revision として使う domain も、対応 gate の最新 revision と `appliedSemanticKey` の両方を照合する。
- tokenless projection は、対応 gate が存在しない真正 legacy input にだけ暫定許可する。active gate があるのに token がない projection は復元しない。

v2 reader は shape 検証だけでなく、次の invariant を検証する。

- `eventId`／`type` など identity の `valid:true` と値の一致。invalid identity を trusted gate entry として復元しない。
- strict ReportDateTime、family policy に整合する serial、subject key、`maxSubjects`、semantic key 32件上限。
- holder／active projection と gate の一対一対応。non-cancelled watermark は current identity と一致し、cancelled watermark は復元 current より新しいこと。
- `restorePrevious` history の revision が strictly increasing であり、訂正前 snapshot を別履歴段として積まないこと。
- whole subject と item watermark、active item、取消 tombstone、legacy provenance の cross-field invariant。

津波 domain の canonical v2 schema は次に確定する。

```ts
tsunami: {
  active?: PersistedTsunamiActiveV2 | null; // migration input only
  keyedActive?: PersistedTsunamiActiveV2[];
  legacyActive?: PersistedTsunamiActiveV2 | null;
  observations: { VTSE51: PersistedTsunamiObservationV2[]; VTSE52: PersistedTsunamiObservationV2[] };
  gateEntries: PersistedTelegramRevisionGateEntryV2[];
}
```

- canonical writer は `keyedActive`／`legacyActive` だけを書き、旧 scalar `active` を書き戻さない。`active` は旧 v2 を一方向 migration する reader 入力である。
- `keyedActive` は EventID ごとの snapshot 配列とし、各 forecast item が `EventID + Area.Code + Kind.Code` で keyable でなければならない。警報レベルがなくても非空の正規 keyed state は保存・復元し、forecast が空の state と unkeyed item は保存しない。
- keyed snapshot と non-cancel gate は `reportDateTimeThenSerial` で結合する。重複 active は EventID 内の全候補から最新を先に選び、その候補が gate と結合できなければ subject 全体を拒否する。片側 Serial 欠落など `unordered` な組は active／gate とも subject 単位で拒否する。
- reader は壊れた EventID／subject だけを除外し、正常な別 EventID と検証済み取消 tombstone を salvage する。VTSE41 の EventID gate と `keyedActive` は上限512 subjectの同じ retained 集合で compact し、holder／gate の一対一を維持する。
- `legacyActive` は code 不完全な名称-only snapshot の表示専用領域である。取消照合、revision gate、新報の置換・通知判定へ参加させず、同 EventID の正規通常報で退場させる。完全 keyed payload が `legacyActive` に入った入力は gate と結合できる場合だけ `keyedActive` へ昇格し、結合不能なら除外する。
- 旧固定 subject `tsunami:current` は、有効な EventID を持つ旧 scalar／`legacyActive` を材料に canonical `tsunami:<EventID>` へ一方向 migration する。名称-only legacy と併存する固定 gate は `cancelled:true` の tombstone だけを移行して表示を残し、non-cancel gate は legacy mutation gate にしない。canonical tombstone は stale active や同 EventID の legacy 表示と併存しても保持し、再起動後の取消以前の遅延報を拒否する。
- persisted 取消 payload 自体は `keyedActive`／`legacyActive` の表示 state に採用せず、検証済み tombstone だけを残す。旧形式への書き戻しは行わない。

旧 state の読込 adapter は次の規約とする。

- 旧数値文字列を完全に解析できる場合だけ `presence:"value"` へ移行する。旧空文字は `presence:"empty"`、欠落か不明か判別できない `null` は `presence:"unknown"` として migration reason を記録する。
- 旧 state の不正 ReportDateTime を migration 時刻や now へ置き換えない。
- 旧 revision が比較不能な state は表示復元できても、newer telegram を拒否する watermark には使用しない。
- 旧 `revisionOf` が invalid／15分超の未来 ReportDateTime を `nowMs` へ昇格して生成した `reportTimeMs` は untrusted とする。元の valid ReportDateTime を別 field から証明できない限り watermark／tombstone／取消対象照合へ採用しない。
- 旧 state の subject key を §5.1 の粒度へ一意に再構成できない場合、表示 snapshot の復元だけを許可し、mutation gate の entry にしない。migration 後の最初の valid telegram で正規状態へ置換する。
- 旧 v2 で retention field が欠落する場合は一律既定値にせず、reader が対象 family の現在 policy から補完する。VPWS50／VTSE41／VTSE51／VTSE52 の無期限 tombstone もこの規則で維持する。

dual-write の終了は Phase 7 の明示 cleanup とする。全 durable domain の旧／新 reader fixture、実ファイル round-trip、restart、取消、訂正、遅延報、rollback test と migration telemetry を確認するまでは停止しない。

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
- fragment merge allowlist を VTSE51／52 の津波観測だけに固定し、fixture／regression test／根拠と限界を manifest 化する。
- 修正弾 A〜C の挙動を baseline として固定する。

完了条件:

- five-state special value matrix が対象 domain ごとに存在する。
- cancellation registry の全 Presentation domain／state holder が列挙されている。
- counterpart 未確認を「重複確認済み」と扱う規則がない。
- allowlist 外の revisionFamily が fragment merge を有効化できない。
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

状態: **完了**（main `9f88b6b4`）。実装は次の7変更単位で収束した。

1. VPWS50: `restorePrevious` の基準実装、evaluate／decide 分離、persistence v2 と真正 v1 dual-write。
2. tsunami: VTSE41／51／52 の `clearCurrent`、VTSE51／52 fragment item gate、active／観測／tombstone の restart 保護。
3. VPWW56: `(head.type, publishingOffice)` stream 単位の `clearCurrent` と官署 union。
4. volcano: alert／eruption の火山コード subject、ashfall／transient family、EventID／fallback provenance。
5. floodForecast: EventID 単位の `clearCurrent`、station digest、observe-only、projection application token。
6. active standby: tornado、heat、typhoon analysis／probability、nankai、VPWP50、lgObservation。
7. transient coverage: earthquake、seismicText、briefing、earlyWeather、climateInfo、weatherExplanation、transient weather、raw fallback。

実装確定後の契約:

- 全 routing 対象 head.type は明示 policy または raw fallback policy を持つ。broad matcher が未知 type を受理して専用 selector が policy を返せない場合は、legacy 経路へ抜けず警告付き raw fallback とする。
- 全 family は comparator、subject extractor、cancellation target、terminal predicate、deactivation predicate、durability、retention、`maxSubjects` を明示する。
- authoritative subject を抽出できない入力は表示／ticker だけ fail-open し、holder、durable projection、promotion、通知、watermark、tombstoneを変更しない。
- clearCurrent、restorePrevious、markCancelled、訂正、unsafe preview、observe-only、fragment merge は §5 の共通 gate を通り、domain 固有 guard を重ねない。
- durable family は §12.1 の v2 foundation と rollback 用 v1 を round-trip し、domain／event 単位 salvage と projection application token を適用する。
- `maxSubjects` と family partition により、他 domain の流量が cancellation latch を期限前に追い出さない。保護 entry で満杯なら新 subject を fail-closed にする。

起草時の計画から実装で確定・変更された点:

- persistence の「新旧 field を同じ version 2 envelope に含めるだけ」の案は旧 binary が読めないため不十分とし、legacy projection を含む canonical v2 と真正 v1 の二ファイル方式へ変更した。
- cancellation 判定は単純な predicate OR ではなく、`resolvedTrigger` で `A > B > C` を一つに解決し、`isCorrection` を独立保持する形に確定した。
- clearCurrent は取消済み同一 revision の訂正でも解除できない latch とした。EEW markCancelled の正当な lifecycle 置換だけは例外として維持した。
- semantic payload 全文の永続化は SHA-256 digest＋直近32件へ変更した。
- 単一 global LRU は domain 間干渉を起こすため廃止し、family partition、合計16,384件の起動時検証、fail-closed admissionへ変更した。
- 非永続 family の retention は固定11分ではなく family 宣言 TTL を process lifetime 中に適用する契約へ確定した。ただし再起動をまたぐ保護はしない。
- durable projection は revision の前後だけでなく `appliedRevision`／`appliedSemanticKey` で gate 適用完了を証明する形へ強化した。
- 全 station unknown など解除を断定できない入力は `observeOnly` とし、active payload と tombstone を変更しない形へ確定した。

完了確認:

- 全 revisionFamily の policy coverage と registry 起動時検証がある。
- 旧 schema fixture、新旧 dual-write、restart、rollback、取消、訂正、遅延報、実ファイル round-trip の domain 回帰がある。
- untrusted な旧 `nowMs` revision、invalid ReportDateTime／serial、identity 不整合が trusted watermark にならない。
- VFVO51 の複数火山、EventID 欠落、部分キー取消、legacy provenance が対象外 state を変更しない。
- A／B／C 同時成立、clear 後の遅延報、restorePrevious、通知適格な訂正一回通知が共通契約どおりである。
- domain 固有 lifecycle、音、frame、表示期限と先行 domain に回帰がない。

### Phase 4A: 震度 Condition と EEW intensity

状態: **完了**（runtime 実装基準: 現 HEAD `052dfd1d`。契約テスト・仕様同期は変更単位8で追加）。変更単位1〜7で共通値、parser、観測保持、EEW safety、下流 qualifier、display protocol、frontend 表示を実装し、変更単位8で同一 synthetic fixture の端到端契約を固定した。

実装確定後の契約:

- `Intensity`／`LgInt` は `SpecialValue`（`value`／`missing`／`empty`／`unknown`／`qualitative`／`range`）を真実源とし、`raw`、`condition`、`description`、bounds、diagnostics を保持する。既存 scalar は表示・互換 adapter であり、判定の真実源ではない。
- 対象電文は `specialValueBody` を使う shadow XML tree から特殊値の raw structure を再取得する。`VXSE43`／`44`／`45`／`51`／`53`／`62` の `Intensity`／`LgInt` を同じ契約で扱う。
- EEW の親 `Area/Condition` は `forecastIntensity.areas[].condition` として独立保持し、ForecastInt の `intensityValue.condition` と混ぜない。PLUM と主要動到達も `isPlum`／`hasArrived` で独立する。
- 地域なし EEW は overall `ForecastInt`／`ForecastLgInt` を評価する一方、地域項目・地域カードは生成しない。overall の emergency payload と `regions: []` は両立する。
- 震度は `IntensitySafetyRank`、長周期は `LgIntensitySafetyRank` を使う。`5弱以上未入電` は下限 rank 5 として safety gate、色、`≥` badge を通し、LgInt の unknown は震度 rank に混ぜず、専用 frame／sound 判定へ渡す。
- `unknown` は `?`／unknown、`empty` は `∅`／neutral、`missing` は非描画・構造欠落として扱う。`unknown`／`empty`／`qualitative` は observation merge の missing ではなく、後続報で旧観測値を誤保持しない。
- qualifier は parser → presentation → notification／ticker → display semantic → persistence を貫通する。`5弱以上未入電`、range、unknown、empty の raw label と意味を下流で scalar に潰さない。
- EEW の表示 payload 置換と safety latch は分離する（§7.3 準拠）。新しい unknown は retained safety rank を降格させず、emergency host を降格させない。
- 終端抑止の撤回は `restoreRevision`（presentation では `eewDisplayRestoreRevision`）で直前の権威表示を復元する。restore 判定は safety latch と別の display state lifecycle である。
- display protocol V1 は `DisplayIntensitySemanticV1`／`DisplayLgIntensitySemanticV1`、EEW の全体・地域 semantic、`restoreRevision` などを optional additive field として拡張し、旧 scalar field を残す。
- frontend の地域 badge 座標は SVG path の bounding box 中心ではなく、scanline で求めた path 内の最長 filled span の中点を使う。凡例、tooltip、ARIA は `≥`／`↔`／`?`／`∅` を説明する。
- 実電文 fixture での確認は未実施であり、変更単位8の fixture は synthetic XML のみである。

起草時の計画から実装で確定・変更された点:

- EEW 親 `Area/Condition` は ForecastInt の値へ畳み込まず、独立 field 方式へ確定した。
- 地域なし EEW の全体値評価と、地域カード／地域 item 非生成を分離した。
- `LgInt` は `IntensitySafetyRank` から分離した専用 safety 型とし、frame／sound も別 helper で判定する。
- 表示 payload の置換と safety latch を分離し、§7.3 の safety state を unknown で降格させない契約へ確定した。
- terminal retract は `restoreRevision` による終端撤回復元を持つ形へ確定した。
- V1 wire は既存 scalar を置換せず optional semantic 拡張を追加する方式へ確定した。
- frontend badge は見かけの中心ではなく scanline 内部点方式へ確定した。
- 実電文 fixture の確認済みとはせず、synthetic fixture のみという制限を明記した。

完了確認:

- `test/engine/telegram-foundation/phase4a-contract.test.ts` は `VXSE45`（地域あり／regionless）・`VXSE51`・`VXSE53`・`VXSE61`・`VXSE62` の6 synthetic fixture を router の parser → presentation → notification → display projection → display state／ticker → standby／daily persistence へ通す。各 test は qualifier、presence、rank、badge、色、ticker 実文字列、対象 domain の round-trip 後の具体値を固定する。
- 同テスト内の `[§13-N]` test 名と対応表は、上の実装確定後の契約11項目を検証先へ一対一で対応付ける。engine 側で `5弱以上未入電` の gate／色／badge、unknown／empty の required wire rank `-1` と optional semantic、City／IntensityStation、missing、regionless EEW、LgInt 専用 safety、通常震度4を固定する。payload／safety latch と `restoreRevision` は既存の EEW tracker／presentation processor 単体契約を参照する。
- frontend の scanline 内部点、badge、凡例、tooltip、ARIA は root Vitest の対象外であるため、`npm run display:test` を完了ゲートの必須コマンドとする。root test だけの成功を Phase 4A 完了とは扱わない。
- fixture は synthetic XML のみであり、実電文の schema／運用差分確認は残存リスクとして扱う。

Phase 4A の完了ゲートは §14.1 の7コマンドに従い、次のコマンド列を全て成功させることとする。

```text
npm run build
npm test
npm run test:shuffle
npm run typecheck:test
npm run display:build
npm run display:test
npm --prefix display run typecheck
```

### Phase 4B: 津波コードと TsunamiHeight

状態: **完了**（実装基準 HEAD `f7d2f5d`）。変更単位1〜6で parser／canonical DTO、keyed state、下流 code、display protocol、height semantic、永続化 migration を順に実装した。

1. parser: Area.Code／Kind.Code の raw 保持と診断、VTSE41／51／52 の `TsunamiHeight` を `SpecialValue<number>` 化し、旧 scalar adapter を追加した。
2. state／revision: `EventID + Area.Code + Kind.Code` の keyed holder、EventID 単位 gate、コードだけを使う部分取消、unkeyed fail-open を実装した。
3. presentation／CLI／通知: code を presentation まで貫通し、観測と予報区を Area.Code で結合する一方、CLI／通知は従来どおり名称を表示した。
4. display protocol: 予報区／Kind／観測 identity を code 化し、予報・観測それぞれの height semantic projection と protocol sync を追加した。
5. 常設ディスプレイ: `maxHeightSemantic` を行、headline、最大観測、bucket 順序、色、badge、tooltip／ARIAへ通し、旧 scalar fallback と restart 復元一致を固定した。
6. persistence: EventID ごとの `keyedActive` と読込専用 `legacyActive`、scalar／固定 gate の一方向 migration、subject salvage、holder／gate 同期 compaction を実装した。

実装確定後の契約:

- canonical forecast item は `areaCode`／`kindCode`／`kindName` と `maxHeight: SpecialValue<number>` を持つ。raw code は trim／名称推定せず保持し、不明 code は diagnostics とともに下流へ通す。
- holder の mutation key は triple key、VTSE41 revision subject は `tsunami:<EventID>` とする。code 欠落 item は holder、取消照合、永続化へ入れず、live の表示・通知は受信 `parsed` を用いた fail-open とする（通知 payload の Kind・予報区名には unkeyed item も残る）。
- 名称-only legacy snapshot は表示専用とし、取消、revision、置換、通知へ参加させない。同 EventID の正規通常報でだけ退場する。
- VTSE51／52 の観測 holder は stationCode、予報区との表示結合は Area.Code を一次キーとし、code 欠落時の名称 fallback を禁止する。
- height semantic の badge、色、描画、比較、`巨大`／`高い` の内部安全順序は §10.4 を正とし、表示 label や永続値を推定数値へ置換しない。
- display wire は既存 scalar を残す optional additive semantic とする。semantic がある場合は scalar を比較へ再利用せず、観測 projection から内部 `maxHeight` を漏らさない。
- 津波 v2 persistence は §12.1 の `keyedActive`／`legacyActive` を canonical とし、旧 scalar／`tsunami:current` は読込方向だけ migration する。

起草時の計画から実装で確定・変更された点:

- 単一の津波 active scalar では複数 EventID を復元できないため、EventID ごとの `keyedActive` と名称-only `legacyActive` に分離した。
- unkeyed item は名称で既存 state を推定更新せず、受信時の fail-open 表示だけに限定した。
- 予報区 height と観測 height は同じ `SpecialValue<number>` extractor を使うが、display projection は別境界とした。
- 高さの安全順序は数値そのものだけでなく qualifier を含め、同値では `lower-only > exact > upper-only／range` とした。`巨大`／`高い` は表示を変えない内部比較規則に限定した。
- 旧固定 tombstone は legacy 表示と分離して canonical EventID subject へ移行し、旧名称-only 表示を取消対象へ昇格させない形に確定した。

完了確認:

- 同コード・名称変更は `src/engine/messages/tsunami-state.ts:56` の triple key を共有し、`test/engine/tsunami-state.test.ts:91` が表示名だけの更新を固定する。
- 同名称・別コードは同じ key に畳まれず、`test/engine/tsunami-state.test.ts:104` と `test/engine/presentation/events/tsunami-observations.test.ts:76` が holder／観測結合の分離を固定する。
- code 欠落 item は `src/engine/messages/tsunami-state.ts:143` の presentation-only 経路へ送り、`test/engine/tsunami-state.test.ts:114` と `test/engine/telegram-foundation/phase3b-tsunami.test.ts:279` が既存 state／永続化を解除しないことを確認する。
- 高さの定性表現、unknown、観測中、range は `src/dmdata/telegram-parser.ts:1022` から semantic のまま抽出し、`test/engine/telegram-foundation/phase4b-tsunami-parser.test.ts:13`、`:85`、`:151` がゼロ化せず raw／condition／bounds を保つことを確認する。
- range／qualitative の badge と比較順は `src/engine/display/tsunami-height-semantic.ts:159` と `display/frontend/src/lib/tsunami-bucket.ts:65` に実装し、`test/engine/display/tsunami-height-semantic.test.ts:22`、`display/frontend/src/lib/__tests__/tsunami-bucket.test.ts:84`、`:108`、`:161` が qualifier、同値順、`巨大`／`高い` を固定する。
- 既存警報レベル、通知、テロップ、CLI、カードは `test/engine/presentation/processors/process-tsunami.test.ts:29`、`test/engine/notifier.test.ts:328`／`:356`、`test/engine/display/project-event.test.ts:577`、`test/ui/tsunami-formatter.test.ts:494`、`display/frontend/src/components/__tests__/tsunami-panel.test.ts:82`／`:136`／`:257` で名称表示と既存 severity／surfaceを維持する。
- 複数 EventID、警報レベルなし、部分破損 salvage、legacy 併存、旧 scalar／固定 tombstone、実ファイル、REST 不通、遅延報は `test/engine/telegram-foundation/phase3b-tsunami.test.ts:662`、`:727`、`:778`、`:996`、`:1234`、`:1280`、`:1359`、`:2028`、`:2280` と `test/engine/display/runtime.test.ts:116` で writer／reader／holder の対称性を確認する。
- §14.1 の共通回帰ゲート7コマンドを全て成功させ、津波以外を含む既存機能の回帰が0件であることを Phase 4B 完了条件とした。

Phase 4B の完了ゲートは §14.1 の7コマンドに従い、次のコマンド列を全て成功済みとする。

```text
npm run build
npm test
npm run test:shuffle
npm run typecheck:test
npm run display:build
npm run display:test
npm --prefix display run typecheck
```

### Phase 5A: Magnitude・Depth

状態: **完了**（実装基準 HEAD `30b0d4d`）。変更単位1〜6で契約、共通型／parser、semantic 伝搬、state／永続化、EEW diff、全表示 surface／frontend を順に実装し、最終 xhigh レビュー GO を得た。

内容:

- 地震、EEW、関連 formatter の Magnitude／Depth を `SpecialValue` へ移行する。
- 不明、ごく浅い、巨大、範囲を保持する。
- diff と通知判定を canonical value／bounds へ移行する。
- 旧 string field は adapter で生成する。
- VXSE51→VXSE52／61 の merge で観測震度だけを missing 時に保持し、Magnitude／Depth／震源名／発生時刻は後続報を採用する。

完了条件:

- 通常値の既存表示が一致する。
- 不明が NaN、0、空文字にならない。
- ごく浅いが 0km へ変換されない。
- diff が raw 表記揺れだけで発火しない。
- latest／recent／daily counter／persistence restore 後で quake-observation-merge の結果が一致する。
- 受理済み訂正が実質差分の有無にかかわらず訂正通知される。
- 既存機能の回帰が 0 件である。

実装契約（2026-08-09 着手時確定。ご主人裁定 4 件と分岐判断を含む）:

- canonical field は `magnitudeValue`／`depthValue` の `SpecialValue<number>` とする。既存 `magnitude`／`depth` string は adapter が生成する表示互換 scalar であり、判定の真実源ではない。既存 field の非 nullable `string` 型は維持し、canonical `missing` の adapter 値は現行互換の `""` とする。semantic がある経路の表示は §3.7 に従い（CLI／カードの missing は `—`、通知／テロップは省略）、scalar `""` を表示判定に使うのは legacy consumer／fallback に限る。
- Depth の情報源は Coordinate 第3成分の数値を主源とし、description／condition の特殊語を §3.5 の Depth 行に従って合成する。矛盾時は数値を `value` として保持し、特殊語を失わず diagnostics（`specialValueConflict`）へ記録する。未知語から値の無効化を推定しない。
  - 深さ成分が存在し 0: `qualitative`（ごく浅い）。「ごく浅い」は「深さ約 5km 未満」に相当する内部 semantic として `upperBound: 5`（km）を持たせるが、表示・永続 raw・旧 scalar adapter は定性語のまま維持し、`?` badge は付けない（2026-08-10 ユーザー裁定）。
  - 深さ成分が欠落（Coordinate 全体の欠落・形式不正・第3成分なし）: `missing`。現行の「ごく浅い」表示への畳み込みは §2.2 違反として修正し、既存挙動変更を test で明示固定する（ご主人裁定 2026-08-09）。
  - 「深さ600km以上」等の bound 表現: `range`（lowerBound 設定）。
- 巨大 Magnitude（「Ｍ８を超える巨大地震」）は `qualitative` とし、description を表示源とする。現行 helper（`src/utils/magnitude.ts`）の NFKC・trim・`M<数値>` 後の空白補正は維持し、`M8超` 等への意味的短縮はしない（ご主人裁定 2026-08-09＝現行表示の維持）。内部順序のみ exact／range より上位とし、順序 rank は engine 側 semantic として下流へ渡す。frontend に raw 再解析させない。
- canonical equality helper は `presence`／`value`／`lowerBound`／`upperBound` で判定する。raw、condition、description、diagnostics は比較へ含めない。bounds の欠落と明示 `null` は同値として扱い、生成段でも各 schema で形を固定する（§3.3）。
- diff は canonical の変化すべて（presence 遷移・value 変化・bounds 変化）で発火し、raw／description だけの表記揺れでは発火しない（ご主人裁定 2026-08-09）。適用面は `EewTracker` と `PresentationDiffStore` の両方とし、`PresentationDiffStore` には Depth も canonical equality で追加する。
- 通知は既存 cadence を維持する。通常続報を Magnitude／Depth diff だけを理由に通知せず、受理済み訂正は実質差分の有無と独立に `訂正` を明示して通知する。地震・EEW 通知本文の Magnitude が `missing`／`empty` の場合は、§3.7 の省略規約に対する明示例外として現行互換の `M不明` 表示を維持する（2026-08-09 通知文言の現行一致を優先）。
- filter の数値比較は canonical から判定する。exact は `value` を用い、range／lower-only／upper-only は bounds から結果が確定できる場合だけ真とする。`qualitative` の bounds 比較は Depth の既知「ごく浅い」（`upperBound: 5`）だけに許可し、他 domain の `qualitative`（巨大を含む）と、確定できない値／`unknown`／`missing`／`empty` は非マッチとする。これは特殊値が数値化不能で非マッチとなる現行挙動の保存であり、巨大の内部順序最上位（表示順）とは別契約とする。
- 特殊値 fixture は実電文 schema に忠実な合成 XML を許容する（ご主人裁定 2026-08-09）。実電文が観測でき次第、差し替え候補としてバックログへ記録する。
- 期待値変更の許可範囲は本実装契約で明示した範囲に限る: 深さ成分欠落の `missing` 化とその表示変更、巨大 Magnitude の内部順序最上位、canonical diff 発火範囲の変更、特殊値への badge／tooltip／ARIA 追加、persistence への additive semantic と legacy migration、合成 fixture の追加。通常値の丸め・`M7.3`／`深さ 10km` 等の表示接頭辞と空白・通知頻度と音・exact 値の filter 結果・VXSE51→52／61 の震度保持条件・persistence の salvage 方針・巨大以外の並び順が変わる場合は裁定済み範囲外として報告・停止する。

変更単位（依存順。共通 semantic 契約と engine 側投影を、state 永続化と EEW の両方より前に確定する）:

1. 契約先行（本節と §3.5 Depth／Magnitude 行の固定。文書のみ）
2. 共通型・parser・adapter: Coordinate carrier、diagnostics 拡張（Magnitude／Depth の conflict 記録）、Magnitude／Depth 本配線、欠落と深さ0の分離、VXSE52／61 の shadow 対象追加、canonical equality helper・ranking・共通 formatter、旧 scalar adapter、合成 fixture
3. semantic 伝搬・通知・engine 投影: Parsed DTO→PresentationEvent（earthquake／EEW／tsunami／lg-observation）、engine display protocol の additive 型と engine display projection（`projectRecentQuake`・latest・EEW・map／emergency への semantic 投影）、notification formatter、`PresentationDiffStore`
4. 地震 state・merge・永続化: latest／recent／daily merge、durable owner ごと（daily／standby／QuakeExtreme）の schema 拡張と旧 reader（読込方向のみ migration）・canonical 優先・scalar-only fixture・round-trip、live／restore の同値性、`test:shuffle` 通過
5. EEW tracker・diff: canonical diff、同一 serial 訂正、logger と detail の diff 行のみ（通常 snapshot 表示は単位 6）
6. 全表示 surface・frontend: CLI formatter 群（EEW は通常 snapshot 表示）、summary／ticker／template／filter、frontend view model と card／replay／recent／emergency、badge・tooltip・ARIA、内部順序の frontend 反映、legacy scalar fallback、同一合成 XML を parser→formatter→notification→ticker→card→persistence へ通す横断 contract test（§14.2）と protocol sync・全ゲート

起草時の計画から実装で確定・変更された点:

- Depth は Coordinate の第3成分を raw のまま運ぶ carrier を設け、成分欠落／形式不正を `missing`、数値0だけを `qualitative`（ごく浅い）とした。description／Condition の安全な終端一致と数値が矛盾する場合は数値を保持し、`specialValueConflict` を残す §3.5 の状態機械へ確定した。
- canonical equality は `presence`／`value`／`lowerBound`／`upperBound` だけを比較し、raw／condition／description／diagnostics の揺れを無視する。bounds の field 省略と明示 `null` は同値とし、wire は明示 `null`、persistence canonical は省略形へ正規化する方式に確定した。
- Magnitude rank は `magnitudeSortRank()` の in-process 比較（巨大だけ `Infinity`）と `SerializableMagnitudeRank`／`magnitudeSerializableRank()` の wire／永続化表現に分離した。range の代表順位は旧 scalar 順序を維持する下限優先（lower-only／両側 range は lowerBound、upper-only は upperBound）へ engine／frontend とも統一し、parity test を常設した。
- 地震／EEW 通知の canonical `missing`／`empty` Magnitude は、通知文言の現行一致を優先し、§3.7 の省略規約に対する例外として `M不明` を維持した。通常値の小数第1位丸め、通知 cadence、音は変更しない。
- EEW は optional Earthquake container 自体の欠落も Magnitude／Depth の canonical `missing` に正規化した。container 欠落↔contained missing は非発火、欠落↔value は missing endpoint 付き diff とし、Earthquake block がない current snapshot でも M／Depth diff 行だけを描画する。
- restart／display off→on 後の structural-missing VXSE52／61 でも、復元済み daily history を fresh `DisplayStateStore` の baseline provider へ接続し、latest／recent／largeQuake が live と同じ §7.4 merge を使う形に確定した。震度だけを旧観測から保持し、Magnitude／Depth／震源名／発生時刻は後報を採用する。
- daily／standby／QuakeExtreme の3 durable owner は canonical の全 field（raw、presence、value、condition、description、bounds、raw bounds、diagnostics）と JSON-safe rank を保存する。旧 scalar-only は読込方向だけ migration し、canonical valid なら壊れた派生 semantic を再生成して record を救済する。
- filter の数値比較は exact または range bounds から結果を確定できる場合だけ真とし、`qualitative` では Depth の既知「ごく浅い」の `upperBound: 5` だけを同様に扱う。判定不能な range、unknown、missing、empty、他 domain の qualitative は偽とした。巨大の表示順最上位と filter の数値非マッチは別契約である。
- CLI／summary／ticker／template／card／replay／recent／emergency／map は semantic がある場合に §3.7 の特殊値表示へ移行した。`≥`／`↔`／`?`／`∅` の badge、tooltip、凡例、ARIA を追加し、scalar-only `magnitude:null` は既存の空欄／`-` 表示と ARIA の意味を一致させた。通常 exact の表示は従来どおりとした。

完了確認:

1. 通常値の既存表示一致: `test/engine/telegram-foundation/phase5a-magnitude-depth-parser.test.ts:134` が旧 scalar と canonical formatter の小数第1位丸めを分離し、`test/engine/telegram-foundation/phase5a-surface-contract.test.ts:39` と `display/frontend/src/components/__tests__/latest-quake-card.test.ts:95` が CLI／実 card の通常 M／Depth 表示を固定する。
2. 不明値の非数値保持: `test/engine/telegram-foundation/phase5a-magnitude-depth-parser.test.ts:65` が `unknown` と legacy `""` を分離し、`test/engine/notifier.test.ts:240` が通知の `M不明` 例外、`display/frontend/src/components/__tests__/latest-quake-card.test.ts:111`／`:146` が badge／ARIA と `NaN` 非表示を固定する。
3. ごく浅いの非0km化: `test/engine/telegram-foundation/phase5a-magnitude-depth-parser.test.ts:70` が深さ0を `qualitative` として固定し、`display/frontend/src/components/__tests__/latest-quake-card.test.ts:154` が `ごく浅い` を距離表示へ変換しないことを確認する。
4. canonical diff: `test/engine/eew-tracker.test.ts:657` が raw／description／diagnostics だけの揺れを非発火、`:706` が container missing の正規化、`:821` が同一 presence の bounds 変化を発火として固定する。
5. latest／recent／daily／restore 同値: `test/engine/display/quake-observation-merge.test.ts:268` が latest／recent の helper 同値、`test/engine/display/state-store.test.ts:440` が復元 daily baseline＋fresh store の VXSE52／61、`test/engine/messages/daily-quake-persistence.test.ts:190` が diagnostics／rank 込み round-trip、`test/engine/display/runtime.test.ts:170` が live／restart の semantic wire 同値を固定する。
6. 同一 serial 訂正: `test/engine/eew-tracker.test.ts:281` が実質差分なし訂正の一回受理と再送抑止、`test/engine/notifier.test.ts:556` が `訂正` 明示と一回通知を固定する。serial-only comparator 自体は変更していない。
7. 横断回帰と protocol: `test/engine/telegram-foundation/phase5a-surface-contract.test.ts:23` が同一 XML を parser→formatter→notification→ticker→wire→persistence、`display/frontend/src/components/__tests__/phase5a-surface-contract.test.ts:13` が同じ XML を実 `LatestQuakeCard` DOM、`test/engine/display/protocol-sync.test.ts:20` が engine／frontend protocol mirror へ通す。下記7ゲートを全て成功させ、既存機能の回帰0件を確認した。

緑でも固定できていない契約・実機リスク（実機観察待ち）:

- 横断 contract は1つの合成 XML（exact Magnitude＋lower-only Depth）であり、全 presence の parser→全下流一括網羅ではない。presence ごとの単体／層別 test はあるが、同一 fixture の全経路網羅は実機観察後の追加候補とする。
- 同一 XML の実 DOM 横断は `LatestQuakeCard` のみであり、他 card／replay／recent／emergency／map は component 単体 test で固定している。
- 実解像度での badge／凡例／tooltip の視認性と、実スクリーンリーダーによる ARIA 読み上げは未確認である。
- 実電文における Coordinate、Condition、description の空白／全半角／終端表現の揺れは synthetic fixture の範囲を超え得るため、観測時に raw と diagnostics を確認する。

Phase 5A の完了ゲートは §14.1 の7コマンドに従い、次のコマンド列を全て成功済みとする。

```text
npm run build
npm test
npm run test:shuffle
npm run typecheck:test
npm run display:build
npm run display:test
npm --prefix display run typecheck
```

### Phase 5B: 台風数値

状態: **完了**（実装同期基準 HEAD `da5f5a5`、Phase 5B 実装基準 `0e964f5`）。変更単位1〜4で契約、parser／共通 helper、semantic 伝搬／state／永続化、既存 surface／card 横断 contract を順に実装し、最終 xhigh レビュー GO を得た。

Phase 5A からの引き継ぎ（5B／5C 共通・順位）: range の代表順位を consumer ごとに定義せず、共通 serializable rank／比較 helper を唯一の契約とする。

Phase 5A からの引き継ぎ（5B 固有）: 「ほとんど停滞」の qualitative 表示と filter／期限計算の数値判定を分離し、表示語を 0km/h や推定数値へ変換しない。

Phase 5A からの引き継ぎ（5B／5C 共通・同期）: engine／frontend の serializable rank parity test を常設し、protocol mirror の同期漏れを完了ゲートで検出する。

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

実装契約（2026-08-10 着手時確定。※印は夜間自律走行の仮裁定として起草し、同日朝にユーザー確認済み——確定）:

- canonical field は `pressureHpaValue`／`maxWindMsValue`／`maxGustMsValue`／`moveSpeedKmhValue` の `SpecialValue<number>` とする。抽出は `extractSpecialValue` の Pressure／WindSpeed／MovementSpeed domain を parser へ接続する。既存 scalar（`number | null`）は adapter が生成する互換値であり、**valid な数値本文は condition の有無にかかわらず現行どおり数値のまま保持する**（`condition="なし"` の `0m/s` を含む——現 parser の結果と bit 一致）。数値本文がない特殊値のみ `null` とする（現行一致）。
- ※qualitative の表示語は description／condition／raw の既定優先順で最初の非空の語を使い、語自体は正規化しない（「ゆっくり」は self-closing 本文のため condition／description 由来になる。巨大 Magnitude と同じ流儀）。
- ※WindSpeed の `condition="なし"` は qualitative として内部保持し、scalar・表示とも現行を維持する（CLI 予報表の `0(0)` を含め表示変更しない）。
- 前報差分（RollingNumber 補助行）の数値差分・trend は両端が `presence:"value"` の場合のみ算出する。**前報・現報がともに exact value なら、canonical 同値でも現行どおり 0 差分と steady を維持する**（canonical equality は raw だけの揺れの識別に用いるものであり、既存の 0 差分表示を消さない）。※value↔unknown 等の遷移は差分行に出さない（現行の見え方保存）。
- trend は canonical value から算出し、unknown／missing／qualitative を強度低下・上昇の根拠にしない。※優先規則（developing 先勝ち）は現行維持。※最大瞬間風速は trend・差分の根拠に含めず、SpecialValue 化は表示・保存のみとする。
- ※移動速度の既知 qualitative は card の数値 slot（RollingNumber は exact value のみ）に加え、CLI とテロップにも description／condition／raw 優先の原文で表示する。CLI は方向と定性語を組み合わせる。テロップは任意の原文を動詞へ直接連結せず、実況を `北へ向かっていますが、移動速度は「原文」です`、予報を `北へ向かうものの、移動速度は「原文」となる見込みです` の独立節とし、方向欠落時も移動速度節だけを表示する。今回変更する CLI／テロップでは unmapped qualitative の従来 fallback（CLI は旧欠損表示、テロップは速度句省略）を維持する（2026-08-10 朝のユーザー裁定で card 限定から拡張）。
- ※通知本文へ数値は追加しない（現行の名称・位置のみ＋受理済み訂正の `訂正` 明示を維持）。通知本文の現行一致・数値非追加・訂正明示は回帰 test で固定する。
- standby persistence（typhoon domain）は canonical 全フィールド（diagnostics 込み）を additive 保存し、旧 scalar-only snapshot は読込方向のみ migration する。validator・restore default・protocol mirror を同時更新し round-trip を固定する（5A の 3 owner 契約と同形）。
- 期待値変更の許可範囲: 移動速度 qualitative の card テキストと付随 badge、および既知 qualitative の CLI／テロップ表示、canonical diff 発火範囲、persistence への additive semantic と migration、に限る。次が変わる場合は報告して停止する: 通常値の表示・strength/size の header tone・4 stat の 2×2 grid・exact 値の RollingNumber・exact 同値続報の 0 差分/steady・最大瞬間風速列の既存省略条件・通常通知本文（名称・位置）・trend 結果・TTL・通知 cadence。

変更単位（依存順。共通 helper と engine 投影を表示より前に確定する）:

1. 契約先行（本節。文書のみ）
2. parser・型・adapter・共通 helper: extractSpecialValue 接続、canonical field 追加、旧 scalar adapter（数値本文保持）、数値 SpecialValue 共通 formatter（台風単位系）・canonical equality 転用・serializable rank/比較 helper、合成 fixture（ゆっくり・停滞・なし・不明・複数単位併記）
3. 伝搬・state・永続化: engine semantic projection（label・badge・rank を protocol 投影時に生成）、standby store の差分/trend canonical 化、protocol と frontend mirror の additive semantic、persistence migration・round-trip、通知現行一致の回帰 test
4. 表示 surface・横断 contract: CLI・テロップ・card（既知 qualitative テキスト表示。card は badge も付与）・同一合成 XML の parser→表示→persistence 横断 test・engine/frontend parity・全ゲート。CLI／テロップへの拡張は 2026-08-10 朝のユーザー裁定で追加した。

起草時の計画から実装で確定・変更された点:

- 旧 scalar adapter は valid な数値本文を condition の有無にかかわらず現 parser と bit 一致で保持した。`condition="なし"` の WindSpeed `0` も canonical qualitative と legacy scalar `0` を両立し、既存 CLI／card 数値表示を変えない。
- 前報・現報がともに exact value の場合は canonical が同値でも、既存の差分 `0` と `steady` を維持した。unknown／missing／qualitative を差分・trend の根拠にせず、最大瞬間風速も trend へ加えない。
- 当初は移動速度 qualitative の表示変更を card テキストと badge に限定したが、2026-08-10 朝のユーザー裁定で既知 qualitative に限り CLI／テロップへ拡張した。表示語は description／condition／raw 優先の原文を維持し、unmapped qualitative は旧表示へ戻す。exact は adapter の bit 一致に裏づけられた canonical `value` を表示し、気圧・風速の特殊 semantic、通知には新しい表示値を追加しない。
- live の `WindPart` 欠落は unknown と推定せず、最大風速／最大瞬間風速の canonical `missing` として diagnostics なしで保持・永続化する形に確定した。
- range と canonical structured bounds は WindSpeed だけに許可した。Pressure／MovementSpeed の From／To は range 化せず、数値本文を優先して raw bounds と diagnostics を保持する。
- protocol は4数値の JSON-safe rank を engine で一度だけ生成し、frontend mirror へ渡す。旧 scalar-only snapshot は読込方向だけ canonical 化する。

完了確認:

1. 停滞の非0化と表示: `test/engine/telegram-foundation/phase5b-typhoon-parser.test.ts:77`／`:275` が「ゆっくり」「ほとんど停滞」と WindSpeed `なし + 0` の canonical／legacy 分離を固定する。`test/engine/telegram-foundation/phase5b-surface-contract.test.ts` が同一 XML の CLI／テロップ表示、`test/ui/typhoon-analysis-formatter.test.ts` と `test/engine/presentation/events/typhoon-to-text.test.ts` が既知語・unmapped・exact／missing fallback、`display/frontend/src/components/__tests__/phase5b-surface-contract.test.ts:23` が実 card DOM まで `0km/h` 化しないことを確認する。
2. 不明値と trend: `test/engine/display/standby-state-store.test.ts:527` が両端 exact のみ差分を算出し、unknown を強度低下の根拠にせず exact 同値の `0/steady` を維持する。`:753` が片側欠落時の差分／trend を null に固定する。
3. 通常表示・差分・期限: `display/frontend/src/components/__tests__/typhoon-card.test.ts:92` が exact の既存 NumberUnit 表示、`:125`／`:169`／`:198`／`:247` が qualitative 以外の legacy fallback と新規表示禁止を固定する。`test/engine/display/standby-state-store.test.ts:827` が stale resend で TTL を延長せず24時間と tombstone を維持する。
4. 受理済み訂正: `test/engine/display/standby-state-store.test.ts:632` が同一 revision の訂正だけを置換し、`test/engine/notifier.test.ts:132` が通知の名称・位置だけの本文と title／body の `訂正` 明示を固定する。
5. persistence: `test/engine/display/standby-persistence.test.ts:513` が `WindPart` 欠落の missing 往復、`:884` が diagnostics／raw bounds 込み canonical round-trip、`:1010` が旧 scalar-only の読込 migration を固定する。
6. 横断回帰と protocol: `test/engine/telegram-foundation/phase5b-surface-contract.test.ts:25` と `display/frontend/src/components/__tests__/phase5b-surface-contract.test.ts:23` が同じ合成 XML の engine／DOM 横断、`test/engine/display/protocol-sync.test.ts:21`／`:27` が engine／frontend protocol と rank union の一致を固定する。下記7ゲートを全て成功させ、既存機能の回帰0件を確認した。

緑でも固定できていない契約・実機リスク（実機観察待ち）:

- 実台風電文における self-closing、description／condition、単位併記、`WindPart` 部分欠落の表記揺れは synthetic fixture を超え得るため、受信時に raw と diagnostics を確認する。
- 実解像度での長い移動速度 qualitative の CLI／テロップ折返しと card の折返し、badge、tooltip／ARIA の視認性・読み上げは実機観察待ちである。

Phase 5B の完了ゲートは §14.1 の7コマンドに従い、次のコマンド列を全て成功済みとする。

```text
npm run build
npm test
npm run test:shuffle
npm run typecheck:test
npm run display:build
npm run display:test
npm --prefix display run typecheck
```

### Phase 5C: 噴煙高度

状態: **完了**（実装同期基準 HEAD `da5f5a5`）。変更単位1〜4で契約、parser／型／共通 helper、semantic 伝搬／fingerprint／永続化、全既存表示 surface／警報判定／横断 contract を順に実装し、最終 xhigh レビュー GO を得た。

Phase 5A からの引き継ぎ（5B／5C 共通・順位）: range の代表順位を consumer ごとに定義せず、共通 serializable rank／比較 helper を唯一の契約とする。

Phase 5A からの引き継ぎ（5C 固有）: 海抜高度と火口上高度は field 名だけでなく型／判別子で基準を分離し、同じ `SpecialValue<number>` の無印値へ混在させない。

Phase 5A からの引き継ぎ（5B／5C 共通・同期）: engine／frontend の serializable rank parity test を常設し、protocol mirror の同期漏れを完了ゲートで検出する。

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

実装契約（2026-08-10 着手時確定。※印は夜間自律走行の仮裁定として起草し、同日朝にユーザー確認済み——確定）:

- canonical は基準と単位を判別子で持つ wrapper 型とする: `PlumeHeightSemantic = { reference: "aboveCrater" | "aboveSeaLevel", unit: "m" | "FT", value: SpecialValue<number> }`。field 名（`plumeHeightAboveCraterValue`／`plumeHeightAboveSeaLevelValue`）と型の両方で基準を分離し、無印 `SpecialValue<number>` へ混在させない（引き継ぎ契約の型分離）。
- 無印 `plumeHeight` 系 scalar（`number | null`＋`plumeHeightUnknown`）は adapter が生成する互換値とし、**現 parser の parseInt 結果を bit 一致で再現する**（`以上` 等の数値本文が現在 scalar 数値になる挙動を含む）。警報発火判定は単位 4 の canonical 切替まで旧 scalar を使い続け、切替は表示・判定と同一単位で原子的に行う。
- ※単位は原単位で保持する（火口上 m・海抜 FT。変換・丸めをしない）。表示も原単位＋単位表記とする。
- `雲中`=qualitative、`観測できず`／`不明`=unknown、観測阻害の condition を数値より優先（§3.5 の PlumeHeight 行）。※表示語は「分類を決めた特殊語の原文」を無正規化で使う——観測阻害は condition の語、本文自体が特殊語なら raw、の優先順とする（不明の self-closing 本文で raw が空になるため）。補足文は足さない。
- `X以上` は range（lowerBound）とし、表示は 5A Depth と同形「{n}m以上」。CLI・通知・テロップ・カードで同じ共通 formatter（噴煙用に新設）を使う。
- diagnostics: PlumeHeight の既知 condition 語集合（雲中・観測できず・不明・以上系）を helper に追加した上で除外を解除し、数値本文と特殊語の矛盾を `specialValueConflict`、未知語を `unmappedSpecialValue` へ記録する。
- ※表示面は現行の表示箇所（火口上）のみを semantic 化し、既存面へのラベル・値の新規追加はしない。**「単位・基準の明示」という完了条件は canonical・永続化・wire に限定して充足させる**——既存 card／通知への「火口上」ラベル追加は通常値表示の変更にあたるためご主人裁定待ちとし、本 Phase では行わない。海抜高度も canonical 保持・永続化までとし、表示への新規追加は行わない。
- 警報閾値（`>= 3000`）は火口上のみを対象と明文化する。単位 4 で canonical 判定（exact value または lowerBound が閾値以上で発火。unknown／bounds なし qualitative は発火根拠にしない）へ原子的に切り替え、**切替前に現行 fixture corpus の warning 判定一覧を固定し、切替後の比較で発火が減る場合はその変更単位を受理しない**。
- revision fingerprint（§5.1）には canonical の raw・presence・condition・description・bounds・reference・unit を含め、訂正検知の回帰 test を固定する。
- standby persistence（volcano domain）は canonical 全フィールドを additive 保存し、旧 scalar/boolean snapshot は読込方向のみ migration する。`plumeHeightUnknown:true`→unknown、**`false`＋`null` は真の欠落と旧 parser が潰した特殊値を区別できないため missing＋`legacyNullUnknown` 診断**とする。round-trip を固定する。
- 期待値変更の許可範囲: 特殊値（雲中・観測できず・以上・範囲）の表示 §3.7 化、diagnostics 追加、persistence への additive semantic と migration、に限る。通常値表示（既存面へのラベル追加を含む）・警報発火実績の減少・lifecycle（取消 tombstone・訂正置換）・通知 cadence が変わる場合は報告して停止する。

変更単位（依存順。共通 helper と engine 投影を表示より前に確定する）:

1. 契約先行（本節。文書のみ）
2. parser・型・adapter・共通 helper: extractSpecialValue("PlumeHeight") 接続、PlumeHeightSemantic wrapper と両高度 field 追加（海抜は新規抽出）、既知語集合＋diagnostics 解除、旧 scalar adapter（parseInt 再現）、噴煙用共通 formatter・canonical equality 転用・serializable rank/比較 helper、warning 判定 corpus の固定、合成 fixture（雲中・観測できず・以上・海抜 FT・矛盾）
3. 伝搬・fingerprint・永続化: engine semantic projection と protocol/frontend mirror の additive semantic（wire rank 含む）、revision fingerprint への canonical 反映、standby persistence migration・round-trip
4. 表示 surface・横断 contract: CLI・通知・テロップ・card（火口上のみ・badge・ARIA）・警報閾値の canonical 原子的切替と発火比較・同一合成 XML の横断 test・frontend parity・全ゲート

起草時の計画から実装で確定・変更された点:

- canonical は `PlumeHeightSemantic` wrapper で reference／unit／`SpecialValue<number>` を一体化し、火口上 m と海抜 FT を型・field・wire・永続化の全てで分離した。海抜 FT は変換せず、既存表示面には新規表示しない。
- canonical の raw／condition／description は `trimValues:false` の shadow XML tree から抽出し、旧 scalar adapter は従来 tree の trim 後文字列を `parseInt(..., 10)` へ渡す形に分離した。原文保持と legacy bit 一致を同じ tree へ依存させない。
- revision fingerprint は canonical raw／presence／condition／description／bounds／reference／unit を含む key へ移行した。旧 key alias 一致時は canonical key を同じ slot で置換し、32件履歴を消費・追い出しせず、発表／訂正／取消の duplicate を無通知のまま restart 跨ぎで移行する。
- §3.7 表示への切替軸は presence ではなく「分類を決めた語が spec 既知特殊語か」に統一した。既知の雲中／観測できず／不明／bound・range と `empty`（CLI `（空欄）`・card `空欄`・通知／テロップ省略）だけを semantic 表示し、exact、missing、機械表現 `NaN`、unmapped qualitative は valid な legacy scalar があれば従来表示へ戻し、なければ従来どおり省略する。
- ※警報の「原子的切替」は保守側で、火口上 canonical の exact value または lowerBound が `>= 3000` **OR** 有効な legacy scalar が従来判定で `>= 3000` の論理和と確定した。canonical を主判定、legacy を安全床とし、桁あふれ等でも発火減少ゼロを構造的に保証する（2026-08-10 朝にユーザー確認済み——確定）。
- persistence reader は正当な片側 raw bound、qualitative の raw／canonical bounds を受理する。semantic だけが壊れている場合は volcano record／domain を捨てず、その semantic field だけを旧 scalar から再生成して別火山・tombstone を salvage する。

完了確認:

1. 特殊状態の分離: `test/engine/telegram-foundation/phase5c-plume-height-parser.test.ts:83`、`:137`、`:148` が雲中／観測できず／以上、NaN、明示 From／To の優先と raw bounds／diagnostics を固定し、`:237` が不明の parser 分類、`test/engine/telegram-foundation/phase5c-surface-contract.test.ts:47` が不明の全 surface 表示を固定して、相互に潰れないことを確認する。
2. `X以上` の全下流伝搬: `test/engine/telegram-foundation/phase5c-plume-height-parser.test.ts:168` が本文 bound を lower-only range にし、`test/engine/telegram-foundation/phase5c-surface-contract.test.ts:324` が parser→CLI／通知／テロップ→wire→persistence、`display/frontend/src/components/__tests__/volcano-card.test.ts:352` が同じ XML の実 card DOM まで qualifier を保持する。
3. 基準・単位・rank: `test/engine/telegram-foundation/phase5c-plume-height-parser.test.ts:61`／`:260`／`:349` が火口上 m／海抜 FT、明示 null bounds、JSON-safe rank を固定し、`test/engine/display/standby-persistence.test.ts:1109` が diagnostics／reference／unit／rank 込みの実ファイル往復を確認する。
4. 訂正と fingerprint 移行: `test/engine/telegram-foundation/phase5c-surface-contract.test.ts:305` が実 notifier の `[訂正]`／`訂正:` を固定する。`test/engine/telegram-foundation/phase3b-volcano.test.ts:321`／`:399`／`:449` が旧 fingerprint の訂正／発表／取消 alias を無通知移行し、`test/engine/telegram-foundation/phase3a-revision-gate.test.ts:353` が32件満杯でも同じ slot を置換して未 flush restart と追い出し順を維持する。
5. 警報・表示・salvage: `test/engine/telegram-foundation/phase5c-plume-height-parser.test.ts:469`／`:598`／`:668` が canonical 閾値、legacy safety floor、合成境界と既存 fixture corpus の発火減少ゼロを固定する。`:492` と `test/engine/telegram-foundation/phase5c-surface-contract.test.ts:147`／`:208`、`display/frontend/src/components/__tests__/volcano-card.test.ts:237`／`:261`／`:297` が既知特殊語だけの §3.7 切替を全 surface で固定する。`test/engine/display/standby-persistence.test.ts:1257` と `test/engine/telegram-foundation/phase3b-volcano.test.ts:690` が semantic 縮退時も別火山・tombstone を保全する。
6. lifecycle と横断回帰: `test/engine/telegram-foundation/phase3b-volcano.test.ts:301`／`:845`／`:939` が同一 revision 訂正、restart 後取消 tombstone、保持期限前後を固定する。`test/engine/telegram-foundation/phase5c-surface-contract.test.ts:324`、`display/frontend/src/components/__tests__/volcano-card.test.ts:352`、`test/engine/display/protocol-sync.test.ts:21` が parser から実 DOM と protocol mirror までを横断する。下記7ゲートを全て成功させ、修正弾 A〜C と既存機能の回帰0件を確認した。

緑でも固定できていない契約・実機リスク（実機観察待ち）:

- 実噴煙電文における condition／description、全半角空白、否定形、本文 bound、単位不一致の表記揺れは synthetic matrix を超え得るため、受信時に raw と diagnostics を確認する。
- 実解像度での噴煙特殊値、badge、tooltip／ARIA の視認性・読み上げは実機観察待ちである。海抜高度は本 Phase の表示対象外のままとする。

Phase 5C の完了ゲートは §14.1 の7コマンドに従い、次のコマンド列を全て成功済みとする。

```text
npm run build
npm test
npm run test:shuffle
npm run typecheck:test
npm run display:build
npm run display:test
npm --prefix display run typecheck
```

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

実装契約（2026-08-11 着手時確定。ご主人裁定 3 件と着手前調査の 6A 分岐判断を含む）:

- Phase 6A と Phase 6B は直列で実装し、6A を先に main へ統合して connection／router／stats 契約を固定した後に 6B へ着手する。6B は当面骨組みまでとし、本 Phase では legacy counterpart の route／cache／Holdback／通知を実装しない。ただし stats API は後述の head type 別集計へそのまま拡張できる形に固定する。
- `DeliveryCapabilities` と classification→guaranteed head.type の明示 registry は connection 層の新規 `src/dmdata/delivery-capabilities.ts` に置く。`types.ts` の汎用電文 DTO へ connection runtime 状態を混在させない。registry は証拠のある保証だけを列挙し、**`eew.forecast` が VXSE45 を保証するという対応は、根拠が registry に追加されるまで未登録＝unknown とする**。設定上の希望 classification、名称類似、実受信履歴から保証を推定しない。
- `WebSocketManager` は socket start 受信後の実効 classifications と、その socket の start 確認済み状態を保持し、切断・再接続開始・close で当該世代の capability を unknown へ戻す。TCP/WebSocket の open や `connected:true` だけでは確認済みとせず、start 未受信・start schema 不正・世代不一致は `source:"unknown"`、`guaranteedHeadTypes` 空集合とする。契約 API の確認に成功した場合だけ、その有効 classifications を runtime-only の検証済み契約情報として connection 層へ渡し、socket start との積集合を `source:"contract-and-socket"` の解決材料にする。契約確認失敗時は socket start を観測用に保持しても保証へ昇格させない。
- `MultiConnectionManager.getDeliveryCapabilities()` を process-wide の読み取り口とする。primary と、生成済みで管理対象にある backup の各 snapshot を保守的に合成し、**全経路が start 確認済みかつ registry 上 VXSE45 を保証する場合だけ**集約 `guaranteedHeadTypes` に VXSE45 を含める。一経路でも切断中・再接続中・start 未確認・契約不明・registry 不明なら VXSE45 は集約保証から外し、VXSE44 を fail-open にする。backup が未生成または明示停止済みで受信経路に存在しない場合は合成対象に含めない。
- monitor の生成順は、`createMessageHandler()` が `MultiConnectionManager` より先である現状を維持する。`MessageHandlerOptions` に `getDeliveryCapabilities?: () => DeliveryCapabilities` の遅延 getter を追加し、未指定時と manager 生成前は必ず unknown snapshot を返す。monitor は nullable な manager 参照を getter closure に閉じ、manager 生成後の各 message 処理時に fresh snapshot を読む。mutable holder を engine 側へ複製したり、message に capability を埋め込んだりしない。
- VXSE44 の処理は parse 後に三分岐する。(1) 同一 EventID の VXSE45 実受信済みなら、既存 `EewTracker` の `hasSeen45` に基づく抑止を使う。(2) 実受信抑止でなく集約 capability が VXSE45 を保証する場合だけ capability 抑止とする。(3) それ以外は VXSE44 を通常の `EewTracker.update()`、logger、通知、表示へ通す。実受信 VXSE45 による抑止を capability 判定へ置換・短絡せず、tracker を唯一の EventID 相関根拠として残す。
- fail-open VXSE44 の通知音・通知資格は VXSE45 と同格とする。VXSE44 を tracker に載せ、EventID 単位の「第1報 signal 発行済み」latch を tracker が所有する。VXSE44／45 のどちらが先でも、受理された非終端の表示対象報のうち最初の一報だけが第1報音資格を得て、後着する他 type は資格を得ない。capability または実受信 VXSE45 により suppressed となった VXSE44 は latch を消費しないため、後続 VXSE45 の第1報資格を保存する。音の二重抑止を notifier の偶然の cadence や同一 serial に依存させない。
- capability 抑止された VXSE44 も、既存 `acceptSuppressed()` 相当の type-local revision gate、suppressed forecast safety cache、取消／最終報の lifecycle 特例を通す。取消・最終報は表示・通知を抑止しても EventID の終端処理と display lifecycle command を実行する。後続 VXSE45 は suppressed VXSE44 の safety rank を継承し、VXSE44 が latch を消費していなければ第1報資格を得る。
- 抑止理由は `vxse44SuppressedByObservedVxse45` と `vxse44SuppressedByCapability` の別 metric とし、同一入力を両方へ加算しない。実受信理由を先に判定し、両条件が真なら observed 側だけへ加算する。既存 `StatsSnapshot.foundation` と `recordFoundation(metric, now?)` の global 集計・呼出規約は維持する。その上で `recordFoundationForHeadType(headType, metric, now?)` と additive な `foundationByHeadType` snapshot を追加し、この API は global と当該 head type の両方を一回ずつ加算する。6A の二 metric は head type `VXSE44` でこの API を使い、6B は将来同じ API に legacy metric を追加できるものとする。日次 rollover、防御コピー、既存 formatter の global 表示を壊さない。
- 回帰禁止: (1) VXSE44 の先行受信が、suppressed の場合に後続 VXSE45 の第1報音資格を失わせない。(2) VXSE44 の取消・最終報は抑止中でも logger close、tracker 終端、active display 解除を行う。(3) suppressed VXSE44 の既知 forecast safety rank を後続 VXSE45 の unknown で逆降格させない。(4) VXSE45 実受信後の VXSE44 抑止は tracker 側に残し、capability unknown／切断中でも有効とする。これらに加え、fail-open VXSE44→VXSE45 と VXSE45→VXSE44 の両順序で第1報 signal が EventID ごとに一回であることを固定する。
- 期待値変更の許可範囲は、capability unknown 時の VXSE44 fail-open 表示・通知・第1報音、理由別 stats、connection status の additive capability 公開に限る。VXSE43／45 の表示・通知 cadence、EEW revision comparator、取消／最終報の表示 command、safety rank、transport dedup、socket 再接続、backup の message ID dedup、既存 global stats が変わる場合は裁定済み範囲外として報告・停止する。

変更単位（依存順。connection capability と stats の独立契約を先に固定し、最後に EEW policy へ接続する）:

1. 契約先行（本節。文書のみ）: 対象は `docs/specs/telegram-foundation.md`。完了条件は capability の unknown／multi-connection 合成、遅延 getter、EventID 単位の第1報 signal、stats 二重集計規約、回帰禁止事項が一意に読めること。検証は文書差分と既存 §9／§13 の整合確認とする。
2. connection capability: 対象は新規 `src/dmdata/delivery-capabilities.ts`、`src/dmdata/connection-manager.ts`、`src/dmdata/ws-client.ts`、`src/dmdata/multi-connection-manager.ts`、`src/engine/cli/cli-run.ts` と対応する dmdata／CLI tests。完了条件は socket start の実効 classifications を世代付きで保持し、start 前・切断・再接続・契約未確認を unknown に戻し、single／primary+backup の全経路保証だけを集約すること。test は open→start、data/open だけ、schema 不正、disconnect→reconnect、primary confirmed＋backup unknown、両系 confirmed、backup 停止を now／socket 世代注入で固定する。
3. stats additive API: 対象は `src/engine/messages/telegram-stats.ts`、必要な stats formatter と `test/engine/telegram-stats.test.ts`／`test/ui/statistics-formatter.test.ts`。完了条件は既存 global snapshot が不変で、head type 付き記録が global と type-local を各一回加算し、両 map が JST rollover し、防御コピーされること。test は既存 metric、新規二 metric、同 metric の複数 head type、rollover、呼出側が global と type-local を二重加算しないことを固定する。
4. EEW policy 接続・回帰固定: 対象は `src/engine/monitor/monitor.ts`、`src/engine/messages/message-router.ts`、`src/engine/presentation/processors/process-message.ts`、`src/engine/presentation/processors/process-eew.ts`、`src/engine/eew/eew-tracker.ts` と `test/engine/message-router.test.ts`、`test/engine/presentation/processors/process-eew.test.ts`、`test/engine/eew-tracker.test.ts`。完了条件は遅延 getter の fresh snapshot で三分岐し、unknown／切断中の44を通常処理し、observed／capability の理由を排他的に記録し、EventID 第1報 signal を両到着順で一回にすること。test は fail-open 44、capability 抑止、45実受信後抑止、44→45／45→44、suppressed 44→45、取消、最終報、safety rank 継承、semantic／transport replay を同一 tracker と fake capability snapshot で固定し、最後に build／通常 test／shuffle test／test typecheck を通す。

### Phase 6B: legacy counterpart correlator

内容:

- VPOA50、VPNO50、VXWW50 を無条件 ignore 集合から外す。
- counterpart registry と短期相関 cache を追加する。
- source 先着時の60秒 Holdback と timeout 表示を実装する。
- ReportDateTime 前後5分の相関窓を実装する。
- 相関 record を source 受信から11分保持し、timeout 後の遅着 counterpart で source 表示を canonical counterpart 表示へ切り替える。
- unmatched／ambiguous stats を追加する。
- unmatched high Severity だけに通知を許可する。

完了条件:

- 対応電文確認時だけ source が抑止される。
- 片系だけの場合は60秒後に表示される。
- 時間窓外、コード不一致、候補複数は fail-open になる。
- 到着順が逆でも結果が一致する。
- timeout 後でも相関保持期間内なら、counterpart→source と source→timeout→counterpart の最終 active 表示が一致する。
- restart 後は fail-open になる。
- high Severity の unmatched は qualifier 付きで一回通知される。
- high 未満、severity unknown、ambiguous は表示されるが通知されない。
- Holdback 内に counterpart が来た場合は source 通知が発生しない。
- VPOA50、VPNO50、VXWW50 以外の ignore 方針に回帰がない。
- 既存機能の回帰が 0 件である。

### Phase 7: protocol／永続化移行と legacy cleanup

内容:

- display protocol を正式版へ上げ、Phase 3B から運用している persistence 新 schema を正式化する。
- Phase 3B の migration telemetry と互換 fixture を確認した後、旧 schema の dual-write を停止する。停止条件は、全 durable domain の v2 reader／writer が配備済みであること、rollback 対象の旧 binary を運用しないと決定したこと、新旧実ファイル conflict／salvage telemetry の観測期間を完了したこと、restart／rollback／取消／訂正／遅延報の fixture が継続して通ること、とする。観測期間と旧 binary のサポート終了日は cleanup 着手時に明示する。
- dual-write 停止後も旧 read adapter は定めた互換期間だけ維持し、その終了条件と削除 release を記録する。
- restart 後に durable projection から family ごとの managed-subject set を再構築し、最初の別 family 更新で復元 subject を legacy 扱いしたり刈り込んだりしない構造へ移す。
- tokenless legacy projection の grace は、移行 telemetry で旧入力が不要と確認できた後に廃止する。それまでは「対応 gate が存在しない真正 legacy」にだけ限定する。
- v1 migration 用 identity provenance、legacy EventID fallback、旧 seen adapter は、対応する rollback／read grace の終了後に domain 単位で削除する。
- 十分な移行期間後に旧 scalar field と、registry に移管済みの domain 固有 revision comparator を削除する。EEW の serial 主 comparator override は registry 契約として残す。
- `str()` の禁止範囲を lint、review checklist または型で固定する。
- architecture docs を最終状態へ更新する。

完了条件:

- 旧 persistence fixture を読み込める。
- 新 persistence の round-trip で presence、raw、bounds、revision が失われない。
- dual-write 停止前に、canonical v2 単独で全 durable holder、projection、watermark、tombstone、managed-subject set を再構成できる。
- tokenless legacy fixture の互換終了を telemetry と release policy で説明できる。
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
- empty raw の `""`／半角空白／全角空白の byte-for-byte round-trip
- `観測中` は TsunamiHeight の qualitative、`雲中` は PlumeHeight の qualitative、`解析不能` は Pressure の unknown
- domain 表で定めた本文／Condition の優先順位
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
- 許容未来日時（15分ちょうどを含む）
- 許容 skew を1ms超える未来日時
- 同一 EventID・異なる type family
- 異なる EventID・同一 serial
- primary／backup 同一 messageId
- 異なる messageId・同一 semantic payload
- EEW serial=2／日時が古い報 → serial=1／日時が新しい報（後者は stale）
- EEW serial=1／日時が新しい報 → serial=2／日時が古い報（後者は newer）
- EEW 同一 serial／日時だけ新しい報（relation は `equal`、通常報は duplicate）
- EEW 同一 serial／日時だけ古い訂正（relation は `equal`、訂正は replaceCorrection）
- 日時主 comparator の family で上記と同じ入力（EEW と逆の日時主結果）
- `fragmentMerge:true` の同一 revision で、VTSE51 または VTSE52 の各 family 内に別 station fragment が分割到着
- 同一 revision／同一 station item の完全再送
- 同一 revision／同一 station の明示訂正
- allowlist 外の family が `fragmentMerge:true` なら registry validation が失敗する
- `fragmentMerge:true` で `extractItems`／`itemSubjectKey`／`itemFingerprint`／`fingerprintVersion`／`fragmentEvidence` の一つでも欠ければ型検査または起動時検証が失敗する
- item 配列順と transport metadata の違いでは fingerprint が変わらず、raw／presence／condition／bounds の違いでは fingerprint が変わる

各ケースで state mutation 回数、presentation 回数、notification 回数、stats を検証する。

訂正については次を追加する。

- 実質差分ありの通知適格な受理済み訂正が一回通知される。
- 実質差分なしの通知適格な受理済み訂正も一回通知される。
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
- 15分以内の未来日時は valid のまま処理される。
- 15分超の未来日時は current state と watermark を変更せず、`futureDateDiagnosed` が一回記録される。
- 15分超の未来日時が `nowMs` に昇格されない。

quake-observation-merge の baseline は次を追加する。

- VXSE51 の観測震度 → 同一 EventID の震度 missing VXSE52／61: 観測震度だけ保持し、震源諸元は後報へ更新する。
- 後報が `unknown`、`empty`、`qualitative` の各場合: 観測震度を保持しない。
- 訂正で震度が明示された場合: 訂正値へ置換する。
- 取消、EventID 欠落、EventID 不一致: 観測震度を持ち越さない。
- persistence restore 前後、latest、recent、daily counter で結果が一致する。

### 14.4 cancellation policy

- `restorePrevious`: 二世代以上の履歴、対象不一致、history なし
- `clearCurrent`: tombstone、遅延報、部分キー取消
- `markCancelled`: active count、final state、再送、遅延報
- A: `InfoType=取消`、B: typhoon `transitionedToLow`／`formationCancelled`、C: volcano `isActive:false`／release／cancel／Lv1 引下げ
- 火山 `InfoType=取消` が `action=cancel` も生成する A＋C 同時成立で、A だけが resolve される
- A＋B＋C、B＋C の synthetic case で優先順位が `A > B > C` になる
- 同時成立時も同一 subject の clear、tombstone、`cancelApplied`、presentation、通知、persistence write が各一回だけになる
- VFVO51 一電文内の複数火山を独立更新し、一件の非活性化が別火山へ波及しない
- EventID 欠落でも valid な火山コード subject は更新でき、名称だけ／部分キーだけの取消は全件解除しない
- volcano alert の非活性化が同じ火山の eruption event を消さない
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
- timeout 後、11分の相関保持期間内の counterpart 遅着
- 11分の相関保持期間を超えた counterpart 遅着
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
- counterpart→source と source→timeout→counterpart で、保持期間内の最終 active 表示が counterpart canonical 表示に一致する。
- timeout 後の切替でも source の表示 TTL が延長されない。
- unmatched high の訂正だけが `訂正` と「対応電文未確認」を併記して一回通知され、high 未満／unknown／ambiguous の訂正は通知されない。

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
- correlation record retention: source 受信から11分
- runtime 任意設定: 初期実装では提供しない
- type 別 override: 実電文の到着差を根拠として必要な場合だけ許可する
- timeout 後に保持期間内の counterpart が遅着した場合、source の active 表示を counterpart canonical 表示へ切り替える。通知は撤回せず、表示 TTL も延長しない。
- 同じ pair が保持期間内に揃う限り、到着順にかかわらず最終 active 表示を一致させる。

### U2: unmatched legacy 電文の通知

**決定済み — 2026-07-31**

高 Severity の unmatched legacy 電文だけ通知する。

- U2 は legacy 経路の通知適格性 filter であり、U5 より先に評価する。
- Severity にかかわらず fail-open 表示は行う。
- high Severity がコードから確定した場合だけ OS 通知と通知音を許可する。
- high 未満、unknown、コード欠落、ambiguous は通知しない。
- high 判定に名称 fallback を使用しない。
- 通知には「対応電文未確認」を明示する。
- 訂正でも high が確定した場合だけ通知し、その通知に U5 の `訂正` 明示規則を適用する。

### U3: invalid ReportDateTime 電文の可視化

**決定済み — 2026-07-31**

CLI と診断テロップにだけ表示し、通知しない。

- current state を変更しない。
- ReportDateTime を now へ変換しない。
- 未来方向の許容 skew は15分とし、超過時は `futureSkewExceeded` として同じ fail-closed／診断表示規則を適用する。
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

訂正は、共通 gate が受理され、経路固有の通知適格性 filter を通過するたびに `訂正` を明示して通知する。

- presentation 上の実質差分がなくても通知する。
- unmatched legacy は U2 を先に適用し、high が確定した訂正だけ通知する。
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
- EEW は serial だけで revision relation を決め、同一 serial は ReportDateTime にかかわらず `equal` になる。
- fragment merge family の通常 equal revision は item gate へ渡り、未見の分割／補完 item が保持される。
- fragment merge は VTSE51／52 津波観測 allowlist と型で制限され、item key／fingerprint／corpus 根拠が欠けた family は有効化できない。
- 通知適格な受理済み訂正が実質差分の有無にかかわらず `訂正` を明示して一回通知される。
- cancellation policy が全 revisionFamily で明示されている。
- state identity と取消対象が EventID だけに依存せず、domain 固有 subject key の粒度で分離されている。
- InfoType 取消、lifecycle terminal、active state deactivation の三 trigger が registry で明示されている。
- A／B／C の同時成立は `A > B > C` で一つに解決され、同一 subject の mutation、stats、通知、永続化が二重にならない。
- invalid ReportDateTime と不正 serial が active state を変更しない。
- 15分超の未来 ReportDateTime が `nowMs` へ昇格されず、active state と watermark を変更しない。
- invalid ReportDateTime が CLI／診断テロップだけに表示され、通知されない。
- 通知前に transport／semantic の共通重複排除が完了する。
- VXSE44 は配送確認なしに抑止されない。
- VPOA50、VPNO50、VXWW50 は counterpart 未確認時に60秒 Holdback 後、fail-open 表示される。
- timeout 後11分以内の counterpart 遅着で canonical 表示へ切り替わり、到着順によらず最終 active 表示が一致する。
- unmatched legacy はコードから high Severity が確定した場合だけ通知される。
- 津波予報区と Kind がコードを一次キーにする。
- `未入電` と `5弱以上未入電` が異なる safety semantics を持つ。
- 地図の特殊値が色と記号バッジの双方で識別できる。
- protocol と永続化で raw、presence、condition、description、bounds が round-trip する。
- empty の元 raw が空白を含め byte-for-byte round-trip する。
- Phase 3B の canonical v2／真正 v1 dual-write が動作し、domain／event 単位 salvage と projection application token が旧 `nowMs` 昇格 revision や未適用 payload を trusted watermark／projection にしない。
- registry の family partition、宣言値合計16,384件以下、family ごとの fail-closed admission により、他 domain の流量が保持期間内の cancellation latch を追い出さない。
- VXSE51→VXSE52／61 で missing のときだけ観測震度を保持し、明示 unknown／empty／qualitative／取消と区別する。
- 全 Phase で既存機能の回帰が 0 件である。
