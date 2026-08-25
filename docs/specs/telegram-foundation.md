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

本節の表は、各 surface が当該値を表示対象にした場合の表現規約である。すべての domain／field を各 surface に新規表示することまでは要求しない。

| 下流 | value | missing | empty | unknown | qualitative / range |
|---|---|---|---|---|---|
| CLI 詳細 | 数値＋単位 | `—` | `（空欄）` | `不明`＋理由 | 定性語、`X以上`、`X～Y` |
| 通知 | 必要な値だけ記載 | 省略 | 省略 | 主題に不可欠な場合だけ明記 | qualifier を落とさず記載 |
| テロップ | 短縮した通常値 | 省略 | 省略 | `不明` | `巨大`、`5弱以上未入電`、`X以上` |
| カード | 数値＋単位 | `—` | `空欄` | `不明` badge | qualifier badge 付き |
| 地図 | 通常色 | 非描画 | neutral 色＋`∅` badge | unknown 色＋`?` badge | safety rank 色＋記号 badge |
| 永続化 | 全フィールド保存 | `raw:null` | 元 raw を空白も含め完全保存（長さ0／self-closing のみ `raw:""`） | raw・condition 保存 | raw・bounds 保存 |

台風カードは既存表示維持の例外とする。気圧・最大風速・最大瞬間風速の `range`／`unknown`／`empty` は semantic を保持しても新規表示せず、移動速度も `qualitative` 以外の特殊値は新規表示しない。既知の移動速度 `qualitative` だけを原文と badge 付きで表示する。

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

subject 全体に適用する取消動作は次の三種類だけを使用する。これらとは別に、津波 VTSE41 の keyed 部分取消だけは、後述の `stateNeutralCancellation` を第四の処理経路として使用する。

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

第四経路である津波 keyed 部分取消は、同一 EventID の一部 `EventID + Area.Code + Kind.Code` だけを解除し、別 item が残る場合に使用する。`stateNeutralCancellation:true` により A を不成立とし、`resolvedTrigger`／`clearCurrent`／`cancelApplied` を経由せず、共通 gate が受理した後に holder が対象 item をコードで直接削除する。gate は取消電文の semantic と revision を受理済みとして進めるが、EventID subject は `cancelled:false` の non-cancel watermark として残し、残存 item と再起動後の遅延報拒否を維持する。`test/engine/telegram-foundation/phase3b-tsunami.test.ts` は、同一 EventID の keyed 部分取消後も残存 item と non-cancel watermark を persistence／restart 越しに保つ regression を固定する。

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

Phase 3B 完了時の registry は次を正とする。保持期間の「runtime」は process lifetime 中だけ有効で、再起動時には失われる。durable family の期間は cancellation tombstone の保持期間を基準に記載し、active holder に同じ期間を適用するかは domain policy で分離する。

| domain／revisionFamily（head.type） | state subject 粒度 | policy | durable／tombstone 保持期間（非永続は runtime TTL） | `maxSubjects` |
|---|---|---|---|---:|
| EEW／VXSE43、VXSE44、VXSE45 | family ごとの EventID | `markCancelled` | 非永続／11分 runtime | 各512 |
| weather／VPWS50 | 固定 `weather:vpws50` | `restorePrevious` | 永続／無期限 | 1 |
| weather／VPWW56 | `(head.type, publishingOffice)` stream | `clearCurrent` | 永続／6時間 | 128 |
| tsunami／VTSE41 | EventID | `clearCurrent` | 永続／無期限 | 512 |
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
- 洪水で unknown と known 低位が混在する場合、現行実装は known 低位が一件以上あり警報級が一件もなければ EventID 全体を deactivation できる。前回警報級だった局が今回 unknown の場合に早期解除となる可能性は既知の限界であり、`前回 high + 今回 known-low／unknown 混在` を将来の回帰ケース候補とする。
- VTSE51／52 は holder と gate の station 上限・LRU 順序を同じ 1,024 件にし、family 取消時は item watermark を除去して whole tombstone だけを残す。
- 火山 `volcanoAlert`／`volcanoEruption` の30日／2日は tombstone の保持期間である。active holder はこの期間では期限切れにせず、明示解除または family capacity による退場まで保持する。
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
- 各 `maxSubjects` は1以上16,384以下でなければならず、全登録 family の宣言値合計も16,384以下でなければ起動を失敗させる。無期限 durable family の合計にも同じ検証を適用する。Phase 3B 完了時の宣言値合計は9,796件である。
- 新 subject 受理時は同じ family 内の期限切れ／退場可能 entry だけを整理する。他 family の watermark／tombstone を容量確保のために削除しない。
- 無期限 tombstone や明示保護 entry だけで family が満杯なら、新 subject を fail-closed で拒否して warning を一度記録する。既存 subject の更新は許可する。
- 既知の限界として、現行 warning latch の再武装は `enforceFamilyLimit` 終端で family size が上限未満になった場合に限られる。`clear`、family clear、expiry など他の削除経路では直接解除されないため、一枠だけ空いて再充填された後の capacity 拒否では warning が再発火しない場合がある。
- holder が独自 item 上限を持つ family は gate と同じ LRU 更新順・退場対象を使う。VTSE51／52 は station 1,024件と whole subject 1件を合わせて1,025件とする。
- 非永続 family も宣言した `tombstoneRetentionMs` を runtime TTL として使用する。保持は process lifetime 内だけであり、再起動後の遅延報拒否は保証しない。

既知の実装課題: `capacityExceeded` の正式な foundation metric 化は未実装であり、現行の受信統計／採用統計には含めない。

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

### 7.5 特殊値適用第 1 例: 震度 Condition（未入電）実装契約

状態: **再監査・実電文適用契約の起草完了、表示文言はご主人裁定待ち**（2026-08-26、調査基準 HEAD `37568dd6c`）。

本項は §3 の特殊値基盤を初めて domain の全経路へ適用する契約である。ただし調査基準 HEAD には Phase 4A の synthetic fixture ベース実装が既に存在するため、既存実装を未実装として扱わない。現在の semantic 配線を baseline とし、実電文 corpus による schema 確認、plain `未入電` の安全側表示ギャップ、ならびにご主人裁定が必要な表示文言を差分として閉じる。

#### 7.5.1 前提・不変条件

- 対象は地震情報 `VXSE51`／`VXSE53` の Observation／Pref／Area／City／IntensityStation にある `MaxInt`／`Int` とする。`VXSE52` は震度構造を持たない電文として `missing` のまま扱い、名称や同一 EventID から parser が震度を補完しない。後続報との保持は §7.4 だけが担う。
- parser は `specialValueBody` の shadow tree を読み、本文、`condition`、`description`、From／To、空要素、空白 raw を失わない。通常 tree の `str()`、既存 scalar、表示文言から `SpecialValue` を再構成しない。
- plain `未入電` は `presence:"unknown"`、`value:null`、数値 rank なしとする。震度0、震度1、震度5弱、または「閾値未満」へ変換しない。
- `5弱以上未入電` は `presence:"qualitative"`、`value:null`、`lowerBound:"5-"` とする。exact 震度5弱へ変換せず、安全判定だけが lower rank 5 を使う。
- Condition が数値本文、From／To、Description と矛盾する場合は §3.5 の優先順位と diagnostics に従う。既知 Condition を無視せず、未知語から値の無効化を推定しない。
- Area／City／IntensityStation の provenance と code を相互に畳み込まない。地図キーは code とし、名称から code を推定しない。
- qualifier は parser → presentation → CLI／通知 → ticker → display protocol／地図／カード → daily persistence の各境界を通過する。旧 scalar は互換 adapter に限り、severity、色、badge、通知 gate、永続化の真実源にしない。
- `unknown`／`qualitative` は構造的 `missing` ではない。§7.4 の VXSE51→VXSE52／VXSE61 観測値保持を誤発火させず、同一 EventID の明示状態として置換する。
- exact 震度、EEW、長周期地震動、Magnitude／Depth、取消・訂正・revision gate の現行挙動は、本項で明示した差分以外変更しない。

#### 7.5.2 現状調査と基盤との差分

| 面 | plain `未入電` の現 HEAD | `5弱以上未入電` の現 HEAD | 契約差分 |
|---|---|---|---|
| parser／presentation | Observation MaxInt、Pref／Area／City MaxInt、IntensityStation Int を `unknown` として raw／Condition／Description ごと保持し、exact scalar／`maxIntRank` は null | 同じ階層を `qualitative`＋`lowerBound:"5-"` として保持し、exact scalar は null | synthetic shape では一致。実 XML の各階層、名前空間、属性形を未確認 |
| severity／通知発火 | 通知自体は発行するが、`earthquakeFrameLevel`／sound は unknown 専用 branch を持たず `?? 0` 相当で normal へ落ちる | safety rank 5 により warning frame／sound、地図 host、カード選択を通る | plain unknown を rank 0 相当の安全状態として扱わない明示 branch が必要。router の notifier dispatch に震度 gate はない |
| 通知文言 | overall なら現共通 formatter は `最大震度不明（未入電）`。地域だけの未入電は通知本文へ列挙しない | overall なら `最大震度5弱以上未入電` | 文言は §7.5.4 D のご主人裁定待ち。qualifier を省略する案は不可 |
| CLI／ticker | CLI は `不明（未入電）`、ticker は `不明`。地域 group は `不明（未入電）` | CLI／ticker とも `5弱以上未入電` | 見た目は §7.5.4 A〜D の裁定待ち。raw semantic の保持は実装済み |
| 地図 | 同じ電文に rank 3 以上の既知候補があれば unknown 色＋`?` badge で地域を出せる。一方、全候補 unknown では overall gate が `-1` となり map command が `nonExact` remove になる | lower rank 5 の色＋`≥` badge で map と large-quake surface を発火 | 全候補 unknown を「閾値未満」と同じ remove にする現分岐は §§2.2、3.6、7.3 と不一致。表示継続／unknown map 用の明示 branch が必要 |
| カード／履歴行 | latest／recent と地域 group に semantic を保持し、unknown chip＋`?` badge を表示 | latest／recent と地域 group に qualifier chip＋`≥` badge を表示。daily の件数／最大震度統計は exact-only のため加算しない | semantic card／履歴は配線済み。表示文言は §7.5.4、exact-only 日次統計は現行維持 |
| 永続化 | `maxIntValue` の raw／Condition／Description／presence と display semantic を round-trip | 左記に bounds／safety semantic を加えて round-trip | synthetic round-trip は一致。実 XML 起点の restart 同値を追加する |

階層ごとの現在の到達点と、今後の検証責務を次で固定する。`parser-only` は捨ててよい意味ではなく、表示面へ新規に畳み込む前に canonical parser field と単体テストだけで保持する範囲を指す。

| 階層 | parser canonical | presentation | map・card・persistence | 本契約で固定すること |
|---|---|---|---|---|
| Pref `MaxInt` | `prefs[].maxIntValue` | parser result／`raw` のみ | parser-only | raw、Condition、bounds を parser test で固定し、Area へ推定・複製しない |
| Area `MaxInt` | `areas[].intensityValue` | `areaItems`／`quakeIntensityValues.localAreas` | map、地域 group、latest／recent、daily persistence | end-to-end の主対象。unknown と lower-bound の wire semantic を保存する |
| City `MaxInt` | `municipalities[].intensityValue` | `municipalityNames`／`quakeIntensityValues.municipalities` | 現 HEAD は map・card・daily persistence の入力外 | presentation までの qualifier を固定する。市町村 map／card を導入する場合は Area と混在させない別変更単位を起こす |
| IntensityStation `Int` | `stations[].intensityValue` | 現 HEAD は parser result／`raw` のみ | parser-only | raw、Condition、bounds を parser test で固定する。観測点 map／card／persistence は本契約の非対象 |

fixture 調査では、tracked corpus の置き場は `test/fixtures/`、基盤用抜粋は `test/fixtures/telegram-foundation/`、人工ケースは `test/fixtures/synthetic_phase4a_*.xml` だった。`未入電`／`5弱以上未入電` を含む tracked XML は Phase 4A の synthetic fixture のみで、2026-07-28 熊本地震の実 XML はこの checkout 内に存在しない。`[[reference_weathercw_fixtures]]` の実体を示す path／symlink／manifest も checkout 内では解決できなかったため、checkout 外を探索せず「実電文未確認」を維持する。未追跡 `evidence-vxse51/` の 2026-08-24 VXSE51 は Condition を含まず、本契約の代替 evidence にはしない。

#### 7.5.3 確定裁定

次は §3、§7.1〜7.4 から一意に導けるため、ご主人の表示裁定を待たず固定する。

1. `extractSpecialValue("Intensity", node)` を Observation／Pref／Area／City の `MaxInt` と IntensityStation の `Int` へ一度だけ適用し、`SpecialValue<JmaIntensity>` を canonical field とする。
2. plain `未入電` の安全評価は `kind:"unknown"` とし、exact rank、wire の正常 rank、daily 最大震度へ入れない。既知の高震度 state を降格させる根拠にも使わない。
3. `5弱以上未入電` は safety lower rank 5 とし、frame／sound、地図 host、カード選択を通す。router は震度 rank を問わず受理済み earthquake outcome を notifier へ dispatch するため、「通知 gate」と呼ばない。ただし表示 label、tooltip、ARIA、永続値を `震度5弱` に置換しない。
4. 地図 semantic は plain `未入電` が unknown 色＋`?`、`5弱以上未入電` が rank 5 色＋`≥` とする。plain unknown の map wire は `maxIntRank:-1` を予約済み sentinel とし、`maxIntSemantic.presence:"unknown"`、`color:"unknown"`、`badge:"?"` を必須にする。`-1` は数値震度、safety rank、通常の色 rank、日次統計へ流用しない。
5. **all-unknown map host**: `DisplayQuakeMapStateV1` に optional additive な `unknownHost:{ eventKey, expiresAtMs }` を導入する。これは rank 3〜4 専用の既存 `nonEmergencyHost` と別であり、新規の all-unknown 地震は既知の map host または large-quake map reference がない場合にだけ `unknownHost` として選択する。選択時の TTL は既存 non-emergency host と同じ5分、tier は `calm`、frame／sound の昇格なしとする。同一 EventID の newer unknown revision は同じ `unknownHost` の TTL だけを更新し、別 EventID の unknown は先行する有効 known host を置換しない。known host または large-quake map reference が成立した時点で `unknownHost` を外し、取消は当該 EventID の unknown host と map contribution を直ちに削除する。
6. **既知 emergency→unknown 続報**: 震度5弱以上で既に参照されている map contribution／large-quake は、同一 EventID の unknown 続報で置換・TTL延長・rank降格しない。続報の震源諸元だけは既存 structural-missing preservation と同じ `eventUpdate` 経路で更新できる。取消または有効な低震度訂正は既存の取消／訂正規則で処理し、unknown をその代用にしない。
7. plain unknown の frame・sound・通知 cadence は次表を唯一の期待値とする。いずれも revision gate を通過した電文だけを対象とし、notifier は rank gate なしで一電文につき一回 dispatch する。

| ケース | frameLevel | soundLevel | 通知 cadence | map／state |
|---|---|---|---|---|
| 新規 plain unknown | `info` | `info` | 受理 revision ごとに1回。通常報・訂正報の既存 dedup を越えて再送しない | `maxIntRank:-1` の `unknownHost` を、known host／large-quake がなければ5分保持 |
| 既知の高震度→plain unknown 続報 | `info` | `info` | 受理 revision ごとに1回。高震度通知を再発火しない | 既知 emergency の map contribution と hold を保存し、unknown は host を奪わない |
| 取消 | `cancel` | `cancel` | 取消通知を1回 | 当該 EventID の unknown／known host と contribution を既存取消規則で削除 |
8. recent／latest／地域 group は unknown／qualitative の履歴行を保持する。日次の数値統計（件数、exact 最大震度）は推定値を混ぜないため現行の exact-only を維持する。
9. persistence は canonical `SpecialValue` と表示 semantic を保存し、live と restart 後で presence、raw、Condition、Description、bounds、badge、color rank、history row を一致させる。旧 scalar-only schema は既存 migration を維持する。
10. 実 fixture は取得した XML を意味変更せず保存し、出典、取得日、EventID の取扱いをテストコメントまたは manifest に記録する。Condition を注入した加工 XML を「実 fixture」と呼ばない。

#### 7.5.4 裁定待ち（ご主人の表示領域）

基盤 semantic、safety rank、色、badge は裁定対象外である。次の A〜D は文字列とカード内の情報配置だけを選ぶ。裁定までは現 HEAD の見た目を暫定 baseline とし、実装変更を開始しない。

- **A: plain 未入電地域の表示文言** — A案 `不明（未入電）`（現 HEAD、unknown と理由を明示）／B案 `未入電`（原文を短く表示）。**推奨 A**: §3.7 の「不明＋理由」と他 domain の unknown formatter に揃う。B案を選べるのはカード、地図 tooltip／ARIA、地域 group などの非 CLI 面だけであり、CLI 詳細は裁定にかかわらず §3.7 に従い `不明`＋理由を表示する。
- **B: `5弱以上未入電` の履歴行** — A案 `5弱以上未入電` の独立 group／chip を残し `≥` badge を付ける（現 HEAD）／B案 `5弱以上（未入電）` と自然文へ整形して `≥` badge を付ける。**推奨 A**: 電文 qualifier と ticker／map label が一致し、exact 震度5弱との混同が少ない。
- **C: `5弱以上未入電` のカード** — A案主 label に `5弱以上未入電`＋`≥`、tooltip／ARIA に Condition／Description（現 HEAD）／B案主 label は `5弱以上`＋`≥`、`未入電` を副 label に分離。**推奨 A**: 狭幅でも情報の一部が装飾依存にならず、qualifier を落とさない。
- **D: 通知文言** — A案共通 formatter の `最大震度不明（未入電）`／`最大震度5弱以上未入電`（現 HEAD）／B案通知専用の `最大震度は未入電`／`最大震度は5弱以上（未入電）`。**推奨 B**: semantic を保ったまま読み上げと自然文の明瞭さが上がる。

#### 7.5.5 変更単位、対象ファイル、完了条件

変更単位は次の依存順とし、一単位内で parser だけ、または UI だけを先行 release しない。括弧内は調査基準 HEAD で実在を確認した対象である。

1. **実 evidence 固定**: 熊本地震の原本を `test/fixtures/` へ追加し、fixture helper と出典情報を固定する（`test/helpers/mock-message.ts`、`test/engine/telegram-foundation/phase0-manifest.ts`、`test/fixtures/telegram-foundation/`）。原本を checkout 内へ提供できない場合は blocked とし、synthetic を実電文扱いして進めない。
2. **parser 契約**: 実 XML で Observation／Pref／Area／City／IntensityStation の出現階層と raw 属性を固定し、plain unknown／qualitative／矛盾／missing を検証する（`src/dmdata/special-value.ts`、`src/dmdata/telegram-parser.ts`、`src/types.ts`、`test/dmdata/special-value.test.ts`、`test/dmdata/telegram-parser.test.ts`）。
3. **安全評価・presentation・CLI**: unknown 専用 frame／sound branch と `5弱以上未入電` lower gate を固定し、裁定 A の非 CLI 面制約を守る（`src/utils/intensity.ts`、`src/engine/presentation/level-helpers.ts`、`src/engine/presentation/events/from-earthquake.ts`、`src/ui/earthquake-info-formatter.ts`、`test/engine/presentation/level-helpers.test.ts`、`test/engine/presentation/events/from-earthquake.test.ts`、`test/ui/earthquake-info-formatter.test.ts`）。
4. **通知・ticker**: 裁定 D と qualifier 非欠落、訂正／取消／通常値回帰を固定する（`src/engine/notification/notifier.ts`、`src/engine/display/ticker-sentence.ts`、`test/engine/notifier.test.ts`、`test/engine/display/ticker-sentence.test.ts`）。
5. **地図・カード・履歴**: all-unknown の sentinel wire、unknown host 選択・5分TTL・tier・既存地図置換、既知 emergency→unknown 保存、unknown／lower-bound の色・badge、裁定 B／C、tooltip／ARIA を固定する。frontend は `unknownHost` を protocol から受け、`deriveQuakeMapHostEvent()` で known host を優先した上で、未期限の unknown host だけを選択する。largeQuake がある間、または known host が有効な間は unknown host を画面選択しない（`src/engine/display/intensity-groups.ts`、`src/engine/display/project-event.ts`、`src/engine/display/protocol.ts`、`src/engine/display/state-store.ts`、`display/frontend/src/lib/protocol.ts`、`display/frontend/src/lib/derive.ts`、`display/frontend/src/lib/quake-map-colors.ts`、`display/frontend/src/components/LatestQuakeCard.svelte`、`display/frontend/src/components/RecentQuakes.svelte`、`test/engine/display/project-event.test.ts`、`test/engine/display/quake-map-state.test.ts`、`test/engine/display/standby-state-store.test.ts`、`display/frontend/src/lib/__tests__/derive.test.ts`、`display/frontend/src/components/__tests__/quake-map.test.ts`、`display/frontend/src/components/__tests__/latest-quake-card.test.ts`、`display/frontend/src/components/__tests__/recent-quakes.test.ts`）。
6. **状態・永続化**: §7.4 merge、daily recent history、live／restart 同値を実 fixture 起点で固定する（`src/engine/display/quake-observation-merge.ts`、`src/engine/display/state-store.ts`、`src/engine/messages/daily-quake-counter.ts`、`src/engine/messages/daily-quake-persistence.ts`、`test/engine/display/quake-observation-merge.test.ts`、`test/engine/display/standby-state-store.test.ts`、`test/engine/messages/daily-quake-counter.test.ts`、`test/engine/messages/daily-quake-persistence.test.ts`）。
7. **端到端・production-shaped 検証**: 実 fixture を router の parser → presentation → notifier → ticker → quake map → latest／recent card → persistence／restore に通す。加えて同じ実 shape の値だけを最小加工した all-unknown 検証を synthetic と明記して置き、新規 all-unknown と既知 emergency→unknown 続報を別 test に固定する。`nonExact` remove、normal への暗黙降格、rank 0、qualifier 消失がないことを固定する（`test/engine/telegram-foundation/phase4a-contract.test.ts`、`test/engine/presentation/level-helpers.test.ts`、`test/engine/presentation/events/from-earthquake.test.ts`、`test/engine/display/project-event.test.ts`、`test/engine/display/quake-map-state.test.ts`、`test/engine/display/quake-observation-merge.test.ts`、`test/engine/messages/daily-quake-counter.test.ts`、`display/frontend/src/components/__tests__/quake-map.test.ts`、`display/frontend/src/components/__tests__/latest-quake-card.test.ts`、`display/frontend/src/components/__tests__/recent-quakes.test.ts`）。

実装完了条件は、両特殊語について Pref／Area／City／IntensityStation の実在する階層ごとに上表の到達点が固定され、overall frame／sound／通知実文字列／cadence、ticker 実文字列、map command、unknown sentinel／host／TTL、unknown／`≥` badge、latest／recent、daily round-trip の具体値が一本の実 fixture 系列で固定されることとする。frontend host 選択は known host 優先、unknownHost の5分有効・期限切れ後の非選択、largeQuake 中の unknownHost 非選択を `derive.test.ts` で固定する。新規 all-unknown と既知 emergency→unknown 続報は別 test とし、exact 震度4と §7.4 の VXSE51→VXSE52／VXSE61 保持が回帰しないことを要する。

必須検証コマンド:

```text
npx vitest run test/dmdata/special-value.test.ts test/dmdata/telegram-parser.test.ts test/engine/telegram-foundation/phase4a-contract.test.ts
npm run build
npm test
npm run test:shuffle
npm run typecheck:test
npm run display:build
npm run display:test
npm --prefix display run typecheck
git diff --check
```

#### 7.5.6 非対象・既存挙動保存

- EEW の ForecastInt／親 Area Condition、LgInt、PLUM／主要動到達、regionless 処理の再設計。
- 震度 map の閾値、配色 palette、SVG geometry、badge 座標計算そのものの変更。all-unknown は既存 unknown semantic を表示可能にする差分だけとする。
- 日次地震件数と「本日の最大震度」へ qualitative lower bound を exact 値として加算すること。
- 震度以外の SpecialValue、TelegramMeta、revision／cancellation policy、通知頻度、音源、カード全体 layout の変更。
- corpus に存在しない階層へ、地域名や既存 synthetic shape だけから Condition を補完すること。

本項の**起草完了条件**について、コード・fixture・snapshot の変更、build、runtime test は N/A とする。文書差分が本項だけであること、対象 path が現 HEAD に実在すること、`git diff --check` が成功することを文書タスクの完了条件とする。実装完了は上記7変更単位と全検証が成功するまで未完了である。

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

> **稼働状態:** Phase 6A は main へ統合済みであり、本節の購読確認付き抑止が稼働中である。VXSE45 の実受信または `DeliveryCapabilities` による配送保証がある場合だけ VXSE44 を抑止し、capability unknown／切断中は fail-open とする。

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
- VXSE44→VXSE45 の type 間通常第1報通知は EventID latch が一回へ畳む。同 type 内 replay は transport dedup／revision gate が抑止する。警報昇格・訂正・取消・最終報は独立資格とする。

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
- `WebSocketManager` は socket start 受信後の実効 classifications と、その socket の start 確認済み状態を connection generation ごとに保持する。snapshot を変更できるのは current generation の event だけとし、旧 generation の open／start／close／error は無視して current snapshot を downgrade しない。同一 generation では最初の valid start を latch し、完全一致する二重 start は no-op、内容不一致の二重 start または malformed start を一度でも観測したら、その generation の残り期間を `source:"unknown"`／`guaranteedHeadTypes` 空集合へ固定する。TCP/WebSocket の open や `connected:true` だけでは確認済みとせず、start 未受信も unknown とする。切断・再接続開始・close は次 generation の unknown 初期状態へ戻す。
- 契約 API の確認に成功した場合だけ、その有効 classifications を runtime-only の検証済み契約情報として connection 層へ渡し、socket start との積集合を `source:"contract-and-socket"` の解決材料にする。契約確認失敗時や契約情報なしでは、valid start の実効 classifications を `source:"socket-start"` の観測値として保持しても、`guaranteedHeadTypes` は必ず空集合とする。
- `MultiConnectionManager.getDeliveryCapabilities()` を process-wide の読み取り口とする。対象経路集合 `P` は primary と、生成済みで管理対象にある backup とし、backup が未生成または明示停止済みなら含めない。集約式は次で固定する: `connected = P.length > 0 && P.every(path => path.connected)`、`effectiveClassifications` は全対象経路の実効 classifications の積集合（どれかが未確認なら空）、`source` は全経路が `contract-and-socket` の場合だけ `contract-and-socket`、全経路が `socket-start` の場合だけ観測用の `socket-start`、unknown を含む場合および source が混在する場合は `unknown`、`guaranteedHeadTypes` は全経路が `contract-and-socket` の場合だけ各経路の保証集合の積集合、それ以外は空集合とする。従って **全対象経路が接続・start・契約・registry の全条件を満たして VXSE45 を保証する場合だけ**44を capability 抑止し、一経路でも切断中・再接続中・start 未確認・契約不明・registry 不明なら fail-open とする。§9.1 の「現在接続中の socket」は multi connection 時にはこの process-wide aggregate を指し、任意の一経路だけの保証ではない。
- monitor の生成順は、`createMessageHandler()` が `MultiConnectionManager` より先である現状を維持する。`MessageHandlerOptions` に `getDeliveryCapabilities?: () => DeliveryCapabilities` の遅延 getter を追加し、未指定時と manager 生成前は必ず unknown snapshot を返す。monitor は nullable な manager 参照を getter closure に閉じ、manager 生成後の各 message 処理時に fresh snapshot を読む。mutable holder を engine 側へ複製したり、message に capability を埋め込んだりしない。
- VXSE44 の処理は parse 後に三分岐する。(1) **非空かつ valid な EventID** について同一 EventID の VXSE45 実受信済みなら、既存 `EewTracker` の `hasSeen45` に基づく抑止を使う。(2) 実受信抑止でなく集約 capability が VXSE45 を保証する場合だけ capability 抑止とする。(3) それ以外は VXSE44 を通常の `EewTracker.update()`、logger、通知、表示へ通す。実受信 VXSE45 による抑止を capability 判定へ置換・短絡せず、tracker を唯一の type 間 EventID 相関根拠として残す。EventID 欠落・空文字・空白・invalid は transient subject とし、EventID latch／`hasSeen45`／44-45 type 間相関へ参加させず、「両 type を受信しても一回」の保証対象外とする。
- fail-open VXSE44 の通知音・通知資格は VXSE45 と同格とする。ただし第1報 signal の資格は、**共通 revision gate が受理し、抑止されず、終端でなく、`InfoType=発表` で、非空 valid EventID を持つ報**に限定する。`InfoType=訂正` は第1報 signal の資格外とし、§5.4／§17 に従う受理済み訂正通知だけを独立に発行する。
- EventID 単位の第1報 latch は `EewTracker` が所有し、`EewUpdateResult.firstReportSignal: boolean` の専用値として通知層へ渡す。既存 `isNew` は event 作成と logger の semantics のまま残し、第1報音判定へ転用しない。`Notifier` の独自 `notifiedEewEventIds` latch は撤去し、notifier は第1報可否について tracker の `firstReportSignal` だけを消費して第1報音を発火する。第1報 latch の寿命は現行 notifier 挙動を tracker 側へ移して保存する。遷移点は一意に、`EewTracker.update()` が非抑止・非 duplicate の outcome を確定して `EewUpdateResult` を生成する時点を通知処理到達と同値とし、tracker が同じ原子的遷移内で latch／TTL を更新する。notifier からの callback／ack では更新しない。その outcome が既存の EEW 通知資格（第1報、警報昇格、訂正、最終報）を満たすたびに当該 EventID の TTL 基準時刻を刷新し、最後の outcome 生成から10分で expiry とする。**非抑止・非 duplicate の取消 outcome** を生成した場合だけ entry を削除して再武装し、取消自身は TTL entry を作らない。suppressed 取消は lifecycle だけを適用し、latch／TTL を変更しない。最終報は TTL を刷新するが再武装しない。再武装後も次の受理済み・非抑止・非終端・`InfoType=発表` だけが新しい signal を取得する。
- 第1報 signal、type 内 replay、その他の通知資格は責務を分離する。transport duplicate と同 type/revision family 内の replay は transport dedup／revision gate が抑止する。VXSE44／45 間で双方受理可能な通常第1報の二重通知だけを tracker latch が抑止する。警報昇格は `isUpgradeToWarning`、訂正は `isCorrection`、取消・最終報は terminal／cancellation result による独立資格とし、`firstReportSignal:false` でもそれぞれの既存通知を妨げない。一つの受理結果で `firstReportSignal` と `isUpgradeToWarning` が同時に true となる場合も、notifier は既存の優先規則で一通知／一音に畳み、どちらかの意味を latch に代用しない。
- capability 抑止された VXSE44 も、既存 `acceptSuppressed()` 相当の type-local revision gate、suppressed forecast safety cache、取消／最終報の lifecycle 特例を通す。取消・最終報は表示・通知を抑止しても EventID の終端処理と display lifecycle command を実行する。後続 VXSE45 は suppressed VXSE44 の safety rank を継承し、VXSE44 が latch を消費していなければ第1報資格を得る。
- 「両順序で EventID ごとに一回」は双方が受理可能な非終端通常報に限定し、順序別の契約を次で固定する。

| 先行報 | 後続報 | 第1報 signal | 独立通知／状態契約 |
|---|---|---:|---|
| fail-open VXSE44・非終端 `発表` | 受理可能な VXSE45・非終端 `発表` | 44で1、45で0 | 45は表示更新可能だが第1報音なし |
| VXSE45・非終端 `発表` | 同 EventID の VXSE44 | 45で1、44で0 | 44は `hasSeen45` で抑止 |
| capability-suppressed VXSE44・非終端 `発表` | 受理可能な VXSE45・非終端 `発表` | 44で0、45で1 | safety rank は44から45へ継承可能 |
| capability-suppressed VXSE44・取消／最終報 | 別 family の遅延 VXSE45 | 合計0 | 44の終端を適用し、45は lifecycle 上表示対象外 |
| 任意の受理済み通常報 | 同 family・同一 serial の `訂正` | 訂正で0 | `isCorrection` による訂正通知だけを一回発行 |
| 任意の受理済み通常報 | 同 family・strictly newer 続報 | 有効な未期限切れ latch があれば0。latch 不在（10分 expiry 後を含む）なら第1報資格の基本規則を再評価 | 既存の表示／警報昇格資格も独立に評価 |
| 最終報後 | 同 family の受理済み終端撤回 | 有効な未期限切れ latch があれば0。latch 不在（10分 expiry 後を含む）なら第1報資格の基本規則を再評価 | 訂正なら第1報資格外で訂正通知、通常報なら表示復帰。最終報は latch を再武装しない |
| 終端後 | 別 family の遅延報 | 0 | lifecycle gate で抑止し、terminal notification を合成しない |
| 取消後 | 同 EventID の受理済み非終端 `発表` | 再武装後の発表で1 | 取消自身は0。新しい event cycle の第1報として扱う |

- 抑止理由は `vxse44SuppressedByObservedVxse45` と `vxse44SuppressedByCapability` の別 metric とし、同一入力を両方へ加算しない。実受信理由を先に判定し、両条件が真なら observed 側だけへ加算する。既存 `StatsSnapshot.foundation` と `recordFoundation(metric, now?)` の global 集計・呼出規約を残し、その上で `recordFoundationForHeadType(headType, metric, now?)` を追加する。この API は一操作で global と当該 head type を各一回だけ原子的に加算し、6A の二 metric は head type `VXSE44` でこの API を使う。`foundationByHeadType` の snapshot 型は `ReadonlyMap<string, Readonly<Record<TelegramFoundationMetric, number>>>` 相当とし、snapshot 取得ごとに外側 `Map` と各内側 record の双方を新規コピーする。6B は将来同じ API に legacy metric を追加できるものとする。
- stats の不変契約は、既存 metric key の意味と非 VXSE44 入力の集計結果が変わらないことを指す。新規二 metric の追加、および新たに受理される VXSE44 による既存 `received`／`presented`／`notified`／type count 等の増加は意図した変更として許可する。JST rollover と防御コピーを維持し、stats formatter は既存表示項目・ラベル・並び順を変更せず、新規 metric の表示追加は別契約とする。
- 回帰禁止: (1) VXSE44 の先行受信が、suppressed の場合に後続 VXSE45 の第1報音資格を失わせない。(2) VXSE44 の取消・最終報は抑止中でも logger close、tracker 終端、active display 解除を行う。(3) suppressed VXSE44 の既知 forecast safety rank を後続 VXSE45 の unknown で逆降格させない。(4) VXSE45 実受信後の VXSE44 抑止は tracker 側に残し、capability unknown／切断中でも有効とする。加えて、fail-open VXSE44→VXSE45 と VXSE45→VXSE44 の双方受理可能な非終端通常報で、EventID ごとの第1報 signal を一回に固定する。
- 期待値変更の許可範囲は、capability unknown 時の VXSE44 fail-open 表示・通知・第1報音、理由別 stats、connection status の additive capability 公開に限る。VXSE43／45 の表示・通知 cadence、EEW revision comparator、取消／最終報の表示 command、safety rank、transport dedup、socket 再接続、backup の message ID dedup、既存 metric key の意味、非 VXSE44 入力の stats、stats formatter の既存表示項目・ラベル・並び順が変わる場合は裁定済み範囲外として報告・停止する。

変更単位（依存順。connection capability と stats の独立契約を先に固定し、最後に EEW policy へ接続する）:

1. 契約先行（本節。文書のみ）: 対象は `docs/specs/telegram-foundation.md`。完了条件は capability の generation latch／unknown 固定／multi-connection 集約式、遅延 getter、EventID と InfoType を限定した第1報 signal、notifier との責務境界、stats の原子的二重集計、真理値表、回帰禁止事項が一意に読めること。検証は文書差分と既存 §5.4／§9／§13／§17 の整合確認とする。
2. connection capability（main `d6add13` で統合済み）: 対象は新規 `src/dmdata/delivery-capabilities.ts`、`src/dmdata/connection-manager.ts`、`src/dmdata/ws-client.ts`、`src/dmdata/multi-connection-manager.ts`、`src/engine/cli/cli-run.ts` と対応する dmdata／CLI tests。完了条件は current generation の event だけが snapshot を変更し、最初の valid start を latch、完全一致重複を no-op、不一致／malformed を同世代 unknown 固定、旧世代 event を無視し、single／primary+backup を上記の all／積集合／mixed-source 式で集約すること。test は open→start、open/data だけ、最初から malformed、valid→完全一致、valid→不一致、valid→malformed、旧世代 start／close、disconnect→reconnect、primary confirmed＋backup unknown、両系 confirmed、mixed source、backup 停止を固定する。
3. stats additive API: 対象は `src/engine/messages/telegram-stats.ts`、必要な stats formatter と `test/engine/telegram-stats.test.ts`／`test/ui/statistics-formatter.test.ts`。完了条件は既存 metric key の意味と非 VXSE44 入力の結果を維持し、head type 付き記録 API が一操作で global と type-local を各一回だけ原子的に加算し、`foundationByHeadType` の外側 Map／内側 record を snapshot ごとにコピーし、両集計が JST rollover すること。test は API 単体の既存 metric、新規二 metric、同 metric の複数 head type、原子的二重集計、外側／内側防御コピー、rollover、formatter の既存項目・ラベル・並び順不変を固定する。本番 call-site の排他的理由判定と加算回数は単位4で検証する。
4. EEW policy・notifier 接続・回帰固定: 対象は `src/engine/monitor/monitor.ts`、`src/engine/messages/message-router.ts`、`src/engine/presentation/processors/process-message.ts`、`src/engine/presentation/processors/process-eew.ts`、`src/engine/eew/eew-tracker.ts`、`src/engine/notification/notifier.ts` と `test/engine/message-router.test.ts`、`test/engine/presentation/processors/process-eew.test.ts`、`test/engine/eew-tracker.test.ts`、`test/engine/notifier.test.ts`。完了条件は遅延 getter の fresh snapshot で三分岐し、unknown／切断中の44を通常処理し、observed／capability の理由を排他的に各一回記録し、`EewUpdateResult.firstReportSignal` と `isNew` を分離し、notifier が tracker signal だけで第1報音を判定し、取消再武装／10分TTLと上記真理値表を満たすこと。test は fail-open 44、capability 抑止、45実受信後の44抑止、45後の43抑止、双方受理可能な44→45／45→44、suppressed 44→45、suppressed終端44→遅延45、非抑止取消再武装、suppressed 取消で latch／TTL 不変、最終報非再武装、10分 expiry 後の strictly newer 続報／same-family 終端撤回に対する第1報資格再評価、別-family 遅延報抑止、EventID null／空文字／空白、警報昇格、同一 serial 訂正通知、logger start／append／close、safety rank 継承、semantic／transport replay、本番 metric call-site の排他性と一回加算を固定する。さらに `firstReportSignal` と `isUpgradeToWarning`／`isCorrection`／terminal notification が独立に共存し、既存優先規則で一通知／一音へ畳まれることを確認し、最後に build／通常 test／shuffle test／test typecheck を通す。

### Phase 6B: legacy counterpart correlator

状態: **骨組み完了**（main `e9220a6`。変更単位2〜5を実装し、Sol high 独立レビュー各巡を経て xhigh 最終 GO。production counterpart／severity rule は空のままで、三 source type は60秒 Holdback後に fail-open表示する。6B後半は実 pair fixture 取得後に別契約で着手する）。

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

実装契約（2026-08-11 起草・同日ご主人裁定。Phase 6A main 統合後の骨組み範囲を含む）:

- Phase 6A→Phase 6B の直列順を維持する。本契約でいう **6B 骨組み** は、三 source type の ignore 解除、専用 route／parser／outcome、相関 registry と非永続 cache、60秒 Holdback、前後5分窓、source 受信から11分の保持、fail-open release、unmatched／ambiguous stats、通知適格性 filter の接続までを指す。実在 counterpart rule、高 Severity code rule、実 pair の訂正／取消、遅着時の ticker canonical reconcile（browser active card は第3縦切り）は、両側 fixture を得てから行う **6B 後半** とし、骨組み完了を Phase 6B 全体完了とは呼ばない。
- `VPOA50`／`VPNO50`／`VXWW50` は `IGNORED_HEAD_TYPES` からだけ除き、ignore より後、classification route より前に `classification:null` の専用 `legacyCounterpart` route として列挙する。従って envelope の classification が想定外でも raw へ抜けず、他の ignore type の優先順位は変えない。route の `statsCategory` は既存表示カテゴリを増やさない `other`、`foundationHeadTypes` は三 type とし、`Route`→`LinearRoute`→`PROCESSOR_TABLE` の型網羅で adapter 漏れをコンパイルエラーにする。
- 専用 route は ignore の早期 return を通らず、既存の `requireTelegramMeta()`、`received`、transport dedup、ReportDateTime 診断、共通 revision gate を順に通る。`routeTaps` は分類直後かつ dedup 前なので相関入力に使わない。相関器へ渡せるのは `processMessage()` が parse／revision 判定を終え、受理済み `ProcessOutcome` を返した後だけとし、router の `recordStats()`／`dispatchNotify()`／`runDisplayPipeline()` より前を唯一の接続点にする。
- raw fallback は相関 source にしない。`ParsedLegacyCounterpartInfo` と `LegacyCounterpartOutcome` を追加し、TelegramMeta、type、title、headline、ReportDateTime、publishing office、EventID、serial、抽出できた地域／現象／Kind の code-name pair、severity evidence を保持する。body の node path は fixture で確認できたものだけ extractor registry に追加し、骨組み時点の body extractor と severity registry は空とする。名称、title、headline、本文から code、counterpart、Severity を推定せず、raw XML 全文を formatter／notification／PresentationEvent へ渡さない。parse 不能時だけ既存 raw fallback へ落とし、正常な最小抽出を raw outcome で代用しない。
- 専用 revision family は `legacyCounterpart`、comparator は `reportDateTimeThenSerial`、subject は `legacyCounterpart:<type>:<valid EventID>`、EventID 不可時は既存 transient gate の messageId subject、`allowMissingSerial:true`、`markCancelled`、非永続、retention 11分、`maxSubjects:512` とする。この11分と相関保持は別定数・別 entry であり、revision watermark／tombstone と相関候補を相互参照しない。
- `legacyCounterpart` を独立 `PresentationDomain` とし、専用 `from-legacy-counterpart.ts`、CLI formatter、summary／ticker projection を持つ。fail-open event は少なくとも §11.7 の header 情報、「対応電文未確認」の reason、抽出済み code-name pair を表示し、`groupKey:null` の raw 表示へ退化させない。骨組みの安定 identity は `legacy:<sourceType>:<valid EventID>`、EventID を使えない場合は `legacy:<sourceType>:<messageId>` とし、名称を identity にしない。`tickerCategoryOf()` には `legacyCounterpart:"旧形式防災情報"` を明示登録し、未知 domain fallback の「気象庁情報」を本 domain の正式 category にしない。
- production registry は Phase 0 characterization と一対一の三 entry を置くが、いずれも `counterpartTypes:[]`、`extractEventKey:()=>null`、body key extractor 未登録、status `unconfirmed` のままとする。active counterpart type 集合は空であり、synthetic test rule を production export へ混入させない。confirmed registry では一つの counterpart type を参照できる source rule はちょうど一つ、を validation invariant とし、重複参照は registry 構築時に拒否する。これにより counterpart 先着 metric の type-local 帰属先を、その counterpart type を所有する唯一の rule の `sourceType` に固定する。実在両側 fixture、EventID／code identity、ReportDateTime、訂正／取消対象を確認して初めて entry を `confirmed` にし、名称類似だけの候補追加を禁止する。
- 相関器は clock と timer scheduler を注入可能な `LegacyCounterpartCorrelator` とし、受理済み outcome ごとに `emitNow`／`holdSource`／`suppressSource`／`releaseSource`／`ambiguousSource`／`reconcileLateCounterpart` の判定を一つだけ返す。counterpart outcome は cache 観測後も通常 pipeline へ即時 emit し、source outcome だけを Holdback 対象にする。一致判定は §11.4 の順で、両側に non-blank valid EventID があれば一致＋時間窓を要求し、不一致時に code fallback しない。片側以上で EventID を利用できない場合だけ官署・地域・現象／Kind・対象時刻の全 code identity を要求し、候補 0 件は unmatched、2 件以上は nearest を選ばず ambiguous とする。
- router integration test の注入口は `MessageHandlerOptions.legacyCounterpartCorrelatorFactory?: LegacyCounterpartCorrelatorFactory` とする。未指定時だけ production registry／system clock／system timer で新 instance を生成し、test は factory から synthetic rule／fake clock／fake timer を持つ新 instance を handler ごとに返す。生成後の correlator と timer の所有者は router とし、`MessageHandlerResult.disposeLegacyCounterpartCorrelator()` を冪等な唯一の disposal 口として shutdown へ接続する。呼出側による instance 再利用、production export の mutation、module mock／resetModules による registry 差替えを禁止する。
- 相関窓は source ReportDateTime が counterpart ReportDateTime の `[-5分,+5分]` にあることを inclusive に判定する。invalid／future-skew ReportDateTime は相関器到達前の既存診断で落ち、received time や `Date.now()` を ReportDateTime の代用にしない。Holdback deadline と cache expiry だけは `TelegramMeta.receivedAtMs` と同じ epoch millisecond の注入 clock で管理する。
- source admission 時刻を `t0`、`holdbackDeadline=t0+60_000`、`sourceExpiry=t0+660_000` とする。counterpart は `arrivalAtMs <= holdbackDeadline` なら Holdback 内、`arrivalAtMs <= sourceExpiry` なら相関保持内であり、境界値ちょうどを相関可能側へ含める。timeout release と expiry prune はそれぞれ `nowMs > holdbackDeadline`、`nowMs > sourceExpiry` のときだけ許可する。timer callback が境界値ちょうどに先に実行されても release／prune せず `deadline+1ms`／`expiry+1ms` へ再 arm するため、同じ epoch millisecond の counterpart input が callback 順にかかわらず常に先勝ちする。counterpart 先着 cache も受信＋11分を inclusive とし、`nowMs > expiry` でだけ退場させる。
- source record の `receivedAtMs`、60秒 deadline、11分 expiry は最初の受理時に固定し、timeout release、訂正、遅着で延長しない。`eligibleInfoTypes` 対象の同一 source subject に受理済み訂正／strictly newer revision が Holdback 中に来た場合は payload と revision を置換するが、最初の deadline／expiry は保つ。非対象の訂正／取消による同一 source key の pending 発表の失効は後記 admission 例外に従い、payload 置換では処理しない。transport／semantic duplicate、stale、invalid meta／revision は相関器へ入れない。correlation cache と raw revision family registry は、同じ11分値を使う場合も定数、entry、prune、capacity、責務を共有しない。
- cache は非永続・有限とし、source と counterpart を別 Map、各最大512 record で保持する。この容量定数も raw revision family と共有しない。各 input のcapacity判定前に `nowMs > expiry` のrecordを通常のexpiry遷移でpruneする。prune後もsource Mapが満杯なら、既存 source を退場・release・延命せず、新しい source を record／timer／expired tombstone なしの `correlatorCapacityExceeded` として即 fail-open する。この入力は遅着相関と同 subject revision 集約の対象外となり、後続の受理済み訂正／取消／newer report もその時点の容量に従う独立 admission とする。counterpart input は既存 source との照合を cache admission より先に行う。照合先がなく counterpart Map が満杯なら、`receivedAtMs`、次いで安定 record id が最小の未参照 record を一件退場させる。全512件が source record から参照中なら新 counterpart を cache せず通常 emit し、既存参照を壊さない。source／counterpart の capacity bypass と counterpart victim eviction は warning／audit reason を残すが、存在しない相関を stats へ合成しない。
- source record が `nowMs > sourceExpiry` で退場するとき、`released-unmatched` または `ambiguous` の未相関 record に限り、payload を持たない expired-source tombstoneへ correlation identity、source type、revision、ReportDateTime、`expiredAtMs` だけを移す。`matched-suppressed`／`late-reconciled` の解決済み record は tombstone 化せず、`legacyCorrelationExpired`／`legacyLateCounterpartExpired` の対象にも戻さない。tombstone は expiry から11分、最大512件の別 Map とし、超過時は最古から退場、同 subject の新 lifecycle admission 時は旧 tombstone を除く。保持中に valid な late counterpart が一致した最初の一回だけ `legacyLateCounterpartExpired` を記録して tombstone を消費し、表示・通知・canonical reconcile は行わない。tombstone 保持後の counterpart は過去 source と結び付けず通常の unmatched counterpart として扱う。
- timer callback は entry token／generation を照合し、置換前 payload、dispose 後 callback、timeout と counterpart 到着の競合から二重 emit しない。非対象訂正／取消による pending 発表失効時は holdback／expiry timer を cancel して token／generation を無効化する。`dispose()` は source／counterpart／expired-source tombstone の全 timer と Map を破棄し、shutdown 中に新規表示・通知を合成しない。pending は既定どおり非永続であり、restart 前に失効済みの場合も restart 後に空 cache から訂正／取消を受ける場合も、旧発表を release／通知／high metric 加算しない外部挙動を同一にする。旧 process の counterpart 観測を抑止根拠にしない。
- **確定裁定（2026-08-11 ご主人裁定）:** production rule が空でも、三 source type は60秒 Holdback した後、reason `counterpartRuleUnconfirmed` で fail-open release する。候補不在時の即時 fail-open は、§13／§17 の完了条件と骨組み runtime で Holdback を検証する必要を優先して採用しない。§13／§17 の60秒・11分条件はsource Mapへadmitできた通常経路へ適用し、唯一の即時 release／保持省略例外は source capacity 超過の `correlatorCapacityExceeded` とする。この例外ではhard boundとfail-openをHoldback／遅着相関より優先する。
- **確定裁定（2026-08-11 ご主人裁定）:** counterpart 先着 cache は counterpart 受信から11分で退場させ、後着 source を得た時点で pair record の expiry を source 受信＋11分へ固定し直す。ReportDateTime の前後5分窓を配送到着差へ流用する5分保持、および無期限保持は採用しない。
- `received` は既存どおり foundation gate 到達時に即時一回記録する。`countByType`／`categoryByType` は transport／meta／revision gate で受理された legacy outcome を相関器へ admit する時に一回だけ記録し、Holdback 中の snapshot に現れるようにする。timeout callback や late action が共通 emit 関数へ戻っても再加算しない。`presented`／`notified` と legacy disposition metric は判定確定後だけ記録する。この分離のため router 末尾を「受理時 stats」と「notify→display の共通 emit」に分け、同期経路と timer 経路が同じ emit を使う。
- stats API へ渡す時刻は handler 所有の非減少 `statsNowMs(rawNowMs)=max(lastStatsNowMs, rawNowMs)` で正規化する。受理時の `received`／`countByType` は admission clock、timer／late／expiry action は callback または input action の現在 clock を使い、保存した source `receivedAtMs` を遅延 actionへ再利用しない。従って23:59:30受理→00:00:30 releaseでは受信／type countは前日、表示・通知・legacy dispositionは翌日に帰属する。遅延 action 後に古い時刻が渡っても day key を過去へ戻して再 clear しない。
- §11.9 の metric tuple はすべて `TelegramFoundationMetric` に additive 追加し、各 disposition は `recordFoundationForHeadType(sourceType, metric, statsNowMs(actionNowMs))` で global と type-local を各一回だけ加算する。既存 entry に新 metric の zero field が増えることだけを許可し、statistics formatter の項目・ラベル・順序は骨組みでは変えない。action と metric の対応は次で固定する。

| 確定 action | 加算する legacy metric | 重複規則 |
|---|---|---|
| 新しい source lifecycle を candidate なしで admit | `legacySourceArrivedFirst` | timeout unmatched、後続 matched／ambiguous と重複可。pending／released record の訂正・取消・newerでは再加算しない。capacity bypass も既存 candidate が0件の場合だけ独立 admission ごとに加算する |
| source 不在で counterpart を受理 | `legacyCounterpartArrivedFirst` | counterpart type を所有する唯一の confirmed rule の `sourceType` へ加算する。後着 source の matched／ambiguous と重複可。capacity victim eviction／cache bypass でも到着順の事実として一回加算する |
| Holdback 内の一意 match で source を抑止 | `legacyMatchedSuppressed` | arrival-order metric と重複可。表示／通知 dispositionとは排他 |
| 0 candidate の timeout、released record の即時更新が実際に表示された | `legacyUnmatchedDisplayed` | `legacyAmbiguousDisplayed` と排他。`runDisplayPipeline()` が false なら加算しない |
| counterpart 取消後の candidate 再計算が 0 件となり source が復帰表示された | `legacyUnmatchedDisplayed` | lifecycle correction の明示例外として source の通知適格性を再評価せず、三 notification metric を加算しない。`runDisplayPipeline()` が false なら加算しない |
| source capacity 超過による即時 fail-open が実際に表示された | `legacyUnmatchedDisplayed` | candidate 数にかかわらず capacity disposition をこれへ畳む。candidate 0件のときだけ `legacySourceArrivedFirst` と重複し、record／tombstoneを持たないため expiry／late metricは加算しない |
| 複数 candidate の source が実際に表示された | `legacyAmbiguousDisplayed` | `legacyUnmatchedDisplayed` および三 notification metric と排他 |
| 通知適格性を評価する新規受理済み unmatched high の通知を実際に発行 | `legacyUnmatchedHighSeverityNotified` | 下記二 suppression metric と排他。arrival／display metricとは重複可 |
| unmatched non-high の通知を抑止 | `legacyUnmatchedNonHighNotificationSuppressed` | high／unknown notification metric と排他。通知適格性を評価する新規受理済み表示 outcome ごとに一回 |
| unmatched severity unknown の通知を抑止 | `legacySeverityUnknownNotificationSuppressed` | high／non-high notification metric と排他。通知適格性を評価する新規受理済み表示 outcome ごとに一回 |
| unmatched／ambiguous source record が保持期限を超えて tombstone 化 | `legacyCorrelationExpired` | record lifecycle ごとに一回。capacity bypass／matched-suppressed recordには加算しない |
| live source record に保持期限内の late counterpart が一致し、原子的 surface reconcile が成功 | `legacyLateCounterpartReconciled` | arrival metric と重複可。骨組みでは typed action までなので production 値は0固定し、6B後半で成功後加算を有効化する |
| expired-source tombstone に valid late counterpart が初回一致 | `legacyLateCounterpartExpired` | `legacyCorrelationExpired` と重複可。tombstone 消費により lifecycle ごとに一回 |
| 訂正／取消 candidate が event／time identity までは一致するが対象 revision 不一致 | `legacyCorrectionMismatch`／`legacyCancellationMismatch` | mismatch diagnostic と fail-open表示 dispositionは重複可。同一 candidate 判定につき該当一方だけ |

- arrival-order metric は「どちらが先に存在したか」、display／notification metric は「何を出したか」を測るため重複を許す。一方、`legacyUnmatchedDisplayed` と `legacyAmbiguousDisplayed`、三 notification metric、correction と cancellation mismatch は各組の中で排他的にする。timeout callback、input action、共通 emit の複数箇所から同じ metric を加算せず、correlator action token を一回性の根拠にする。
- type 別 high Severity code registry は空で開始するため、骨組みの production source はすべて `severity:unknown` である。通知適格性 filter 自体は router／notifier に接続し、`isHighSeverity === true` 以外を通知しない。従って骨組みでは OS 通知／通知音、`legacyUnmatchedHighSeverityNotified` は常に 0 で、通知適格性を評価する新規受理済み 0-candidate outcome は `legacySeverityUnknownNotificationSuppressed` を一回記録する。counterpart 取消だけによる source 復帰は前表の lifecycle-correction 例外、ambiguous は severity 判定より先に `legacyAmbiguousDisplayed` へ畳み、いずれも severity suppression metric を重ねない。high／non-high rule と「訂正」＋「対応電文未確認」通知は実 code fixture 登録後に有効化する。
- 訂正／取消の共通 gate と revision metadata は骨組みから通す。`pending` 中の同一 subject 訂正／strictly newer report／対象 revision が一致する取消は、pending payload と revision を in-place 置換し、最初の deadline／expiryと一個のtimeout timerを保つ。superseded payloadは表示・通知・disposition metricを発生させず、各受理 outcome の受理時 count だけを残す。`released` 後かつ `nowMs <= sourceExpiry` の同入力は再 Holdback せず、record を置換して即時 fail-open 表示更新する。受理時 count、実表示 disposition、通知適格性は outcome ごとに一回評価するが、`legacySourceArrivedFirst`、deadline、expiry、timeout timerは再生成しない。取消表示も同じ即時更新規則とし、active sourceを解除する。
- counterpart 取消が、保持中の source を抑止／canonical reconcileした対象 revision と一致した場合は、まず対象 counterpart record へ取消を適用し、その後の live cache を §11.4 の candidate 数の唯一の真実源として source ごとに再計算する。0 件なら保存した最新 source payloadを即時 fail-open表示へ復帰し、1 件なら残った唯一の candidate に結び直して抑止を継続し、2 件以上なら ambiguous へ遷移して source を fail-open表示する。取消だけで生じた0件の復帰は実表示時に `legacyUnmatchedDisplayed`、複数化は実表示時に `legacyAmbiguousDisplayed` を加算するが、いずれも新規 source outcome ではない lifecycle correction のため source通知、合成取消通知、三 notification metricを発生させない。再 Holdback、表示TTL／source expiryの延長も行わない。対象 revision 不一致は取消を適用せず状態を変えず `legacyCancellationMismatch`、訂正 candidate の対象 revision 不一致は `legacyCorrectionMismatch` とする。この状態遷移は synthetic rule で骨組みから検証し、実 pair の production rule／metric有効化だけを fixture 確定後の6B後半へ送る。
- **確定裁定（2026-08-11 ご主人裁定）:** 骨組みの表示 surface は専用 CLI＋通常 ticker までを実装し、correlator は遅着一致時の typed `reconcileLateCounterpart` action と source identity を unit test まで固定する。browser active card の追加とその atomic reconcile/remove API は6B後半の第3縦切りへ送る。同一 `groupKey` の上書きだけでは hub の `recent` に source が残り、canonical domain 固有 identity／TTL と衝突し得るため採用しない。generic legacy card と frontend authoritative ticker sync の先行実装も、実 counterpart の card identity と TTL を fixture なしで固定するため採用しない。
- 期待値変更の許可範囲は、三 type が foundation gate 後に専用 route へ入り、通常 admission は60秒後、source capacity 超過だけは即時に qualifier 付き fail-open 表示されること、legacy metric field が additive に増えること、timer／shutdown wiring が増えること、および `legacyCounterpart` ticker category が未知 domain fallback の「気象庁情報」から専用「旧形式防災情報」へ変わることに限る。他の ignore type、既存 route の classification 優先順位、transport／semantic dedup、revision family、stats formatter、通知 cadence、この許可済み ticker category 以外の display protocol／frontend surface が変わる場合は、本骨組みの裁定済み範囲外として報告・停止する。

骨組みと6B後半の完了条件の区分:

- 骨組みで production verification する: 三 type の ignore 解除と専用 route、foundation gate／transport dedup／日時診断、rule／severity registry が空で suppression／通知が 0 件であること、空 rule でも60秒 Holdback 後に `counterpartRuleUnconfirmed` で行う fail-open release、capacity 時だけの即時 fail-open、受信時 stats と release 時 stats の一回性、11分 source record expiryとexpired tombstone、dispose／restart fail-open、他 ignore type の不変。
- 骨組みで synthetic rule に限って state-machine verification する: counterpart／source 両先着、Holdback 内 match、60,000msちょうどのinput先勝ちと60,001ms release、前後5分の inclusive 境界と窓外、EventID／code identity、候補複数、660,000msちょうどのlate matchと660,001ms expiry、counterpart-first expiry再固定、timer 競合、source／counterpart／tombstone capacity、released後の訂正／取消／newer、counterpart取消後の candidate 再計算が0／1／複数となる各遷移、typed late reconcile action。synthetic rule の成功を実 counterpart 確認済みとは数えない。
- 6B後半・第2縦切りへ持ち越す: 実 pair での suppression と到着順同値、timeout 後の canonical ticker 表示、source ticker の原子的 targeted remove/replace protocol、実 code の high／non-high 通知、pair をまたぐ訂正／取消と source 復帰のproduction有効化、`legacyLateCounterpartReconciled` の成功後加算。browser active card の導入と reconcile は第3縦切り（裁定待ち・ご主人判断）へ送る。従って既存完了条件のうち「片系だけの fail-open」「restart」「他 ignore／回帰」と訂正／取消の純粋状態遷移は骨組み対象、「対応電文確認時だけ抑止」「両順序の最終 ticker／hub／snapshot 状態一致」「high 通知」「実 pair rule による訂正／取消」は6B後半対象とする。

変更単位（依存順。空 registry の安全な縦切りを先に通し、相関 state machine と router timer 接続を分ける）:

1. 契約先行（本節。文書のみ）: 対象は `docs/specs/telegram-foundation.md`。完了条件は骨組み／6B後半、空 registry、authoritative 接続点、stats の受信時／release 時境界、timer disposal、三つの確定裁定が一意に読めること。検証は文書差分と §9／§11／§13／§14.7／§16 U1・U2／§17 の整合確認とする。
2. 専用 route・最小 parser・presentation vertical slice: 対象は `src/types.ts`、新規 `src/dmdata/legacy-counterpart-parser.ts`、`src/engine/messages/route-catalog.ts`、`src/engine/messages/revision-family-registry.ts`、`src/engine/presentation/types.ts`、新規 `src/engine/presentation/processors/process-legacy-counterpart.ts`、`src/engine/presentation/processors/process-message.ts`、新規 `src/engine/presentation/events/from-legacy-counterpart.ts`、`src/engine/presentation/events/to-presentation-event.ts`、`src/engine/display/project-event.ts`、`src/engine/display/ticker-sentence.ts`、`src/ui/display-adapter.ts`、新規 `src/ui/legacy-counterpart-formatter.ts`、`src/ui/summary/token-builders.ts`、`test/engine/display/ticker-sentence.test.ts` と対応 tests。完了条件は三 type だけが classification 非依存の専用 route に入り、header-only parsed model でも raw へ落ちず、名称推定／raw XML 流出なしに qualifier 付き CLI／tickerとcategory「旧形式防災情報」を生成し、他 ignore／route が不変であること。test は三 type×想定外 classification、他 ignore、invalid date、transport／semantic duplicate、EventID 有／無、header 欠落縮退、body extractor 空、summary／formatter、ticker category、raw XML 非露出を固定する。
3. registry・純粋 correlator: 対象は新規 `src/engine/messages/legacy-counterpart-registry.ts`、新規 `src/engine/messages/legacy-counterpart-correlator.ts` と `test/engine/telegram-foundation/legacy-counterpart-correlator.test.ts`。完了条件は production 三 entry が unconfirmed／counterpart 空、confirmed counterpart type の source rule 間一意性 validation、注入 clock／timer、source／counterpart／expired tombstone の分離 cache、有限 capacity、generation token、dispose、排他的 action を持つこと。test は registry の counterpart type 重複拒否、§14.7 の arrival order、59,999／60,000／60,001ms、±300,000ms inclusive と超過、EventID 一致／不一致／片側欠落 code fallback、地名だけ一致、候補複数、source 受信＋659,999／660,000／660,001ms、counterpart 先着受信＋659,999／660,000／660,001ms と source 到着時の expiry 再固定、pending／released の訂正・取消・newer、counterpart取消後の candidate 0／1／複数、callbackとinputの順序反転、source満杯、counterpart未参照eviction／全件参照時bypass、未相関recordだけのtombstone化と解決済みrecordの非tombstone化、tombstone TTL／capacity／一回消費、dispose／restart を synthetic rule で固定する。
4. router emit・stats・notification filter・shutdown 接続: 対象は `src/engine/messages/message-router.ts`、`src/engine/messages/telegram-stats.ts`、`src/engine/notification/notifier.ts`、`src/engine/monitor/monitor.ts`、`src/engine/monitor/shutdown.ts`、`test/engine/message-router.test.ts`、`test/engine/messages/message-router-display.test.ts`、`test/engine/telegram-stats.test.ts`、`test/engine/notifier.test.ts`、新規 `test/engine/monitor/shutdown.test.ts`、`test/ui/statistics-formatter.test.ts`。完了条件は factory 注入した synthetic correlator も受理済み outcome 後だけ入り、router がinstance／timerを単独所有・冪等disposeし、countByType はadmit時一回、notify／displayとlegacy metricはaction表どおり一回、timer callbackも共通emitを通り、空severity registryで通知が常に0となること。test は module mock なしで、Holdback中snapshot、60,000ms input先勝ち／60,001ms一回release、released後即時更新、capacity fail-open、counterpart先着metricの唯一のsourceType帰属、counterpart取消による復帰／ambiguous表示のnotification metric明示例外を含む全action→metricの排他／重複、23:59:30 admission→00:00:30 releaseのJST帰属、遅延action後の古い時刻非逆行、global／type-localの各一回、防御コピー、formatter不変、shutdown／dispose後callback 0を固定する。
5. 骨組み統合ゲート: 対象は上記単位の integration tests と Phase 0 manifest 契約。三 production type が空 rule でも60秒 Holdback 後に fail-open し、counterpart／severity rule が空であることを明示 assertion にする。`npm run build`、`npm test`、timer／module state を触るため `npm run test:shuffle`、`npm run typecheck:test`、さらに §14.1 の `npm run display:build`、`npm run display:test`、`npm --prefix display run typecheck` をすべて通す。実 fixture 不在を synthetic fixture で「確認済み」に昇格させない。
6. 6B後半（本骨組みの対象外）: 実 pair fixture ごとに、(a) parser extractor、confirmed counterpart／severity rule、実到着順 integration test を含む rule/severity slice と、(b) 明示 ticker display reconcile/remove、frontend／protocol sync、`legacyLateCounterpartReconciled` を含む display reconcile slice の二段へ分割する。前者の完了を Phase 6B 全体完了とは呼ばない。browser active card とその reconcile は第3縦切りへ分離し、各 slice の対象ファイルと TTL は対応 fixture と前 slice の確定契約から定める。

6B後半・第1縦切り実装契約（2026-08-23 起草。VPOA50→VPBS50 の production rule 有効化）:

状態: **実装済み（2026-08-23。late reconcile A 裁定・全 3 単位＋xhigh 補修・Sol xhigh 最終 GO）**。本契約は `corpus-6b-latter/raw-VPOA50/` と `corpus-6b-latter/raw-VPBS50-all/` の各 `index.jsonl` および実 XML を照合した結果に限定する。各 index.jsonl は dmdata message id と XML file の対応だけを示し、EventID、ReportDateTime、PublishingOffice、Kind 等の実値の真実源は XML 本体である。VPOA50 と VPBS50 は実 6 pair すべてで ReportDateTime、PublishingOffice、記録的短時間大雨の内容が対応し、VPBS50 の EventID は VPOA50 の EventID に `K` を前置した値だった。反例は観測していないため、これは §11.2 の「名称類似」ではなく EventID 構造と両側実電文による確認済み規則として登録できる。一方、VXWW50→VPWW56 は内容対応を確認したものの Kind `3`／`49` と官署 code の canonical identity が未確定、VPNO50 は実電文未観測のため、本縦切りでは両 rule を `unconfirmed` のまま維持する。

VXWW50→VPWW56 corpus 再調査記録（2026-08-24）:

- `raw-VXWW50` 16件と `raw-VPWW56` 2件から実対応2 pairを確認した。両 pair は ReportDateTime 完全一致、到着差7〜8秒、VPWW56先着だった。
- ただし VPWW56 の EventID は全件空で `K` 前置のような構造規則はなく、XMLにも官署コード要素がなく名称だけである。さらに Kind 対応は `3↔49` だけでなく `1↔29` も実在し、単一正規化では説明できない。従って §11.4 の code-only identity を満たせず、`unconfirmedRule("VXWW50")` を維持する。
- confirmed 化には、(1) 両側共通の XML 由来官署コードの根拠、(2) 複数官署・複数自治体で `3↔49` と `1↔29` 双方を含む実 pair、(3) VPWW56 の自治体層だけを対象地域とする反例なしの証拠、(4) 同官署・同時刻・同地域でも対応しない fixture（誤抑止検証用）が必要である。

契約変更と保存範囲:

- `LegacyCounterpartRule` に rule 固有の optional hook `normalizeEventId` を additive に追加する。入力は少なくとも `side: "source" | "counterpart"`、`headType`、trim 済み raw EventID を持ち、戻り値は比較用 canonical EventID または `null` とする。hook 未指定時は trim 済み raw EventID をそのまま使うため、既存 synthetic rule と将来の他 production rule の比較は変わらない。normalization は相関比較だけに使い、`TelegramMeta`、revision subject、transport／semantic dedup、source／counterpart identity、監査表示の raw EventID は書き換えない。
- 両側に valid・non-blank raw EventID がある場合は、時間窓確認後、EventID 比較より先に両側を rule hook へ通す。どちらかが `null`、空、例外、または canonical 値が不一致なら即時 non-match とし、code identity へ fallback しない。少なくとも一方の raw EventID が欠落／invalid／blank の場合だけ、従来どおり `extractEventKey` による §11.4 code identity を使う。従って未知形式と正規化後不一致はいずれも source を抑止せず fail-open する。
- `LegacyCounterpartRule` に `eligibleInfoTypes?: readonly ("発表" | "訂正" | "取消")[]` 相当の additive admission filter を追加する。filter は source／counterpart とも pair 相関 cache（counterpart candidate 側）へ入れる前に評価し、VPOA50 rule は `eligibleInfoTypes:["発表"]` とする。非対象 counterpart は既存 domain の通常 emit だけを行い、この pair 相関 cache を変更しない。非対象 source は共通 gate による受理後、pair 相関 cache、candidate、late reconcile を変更せず即時 fail-open 表示へ進める。ただし同一 source key に Holdback 中の `InfoType=発表` pending record があるときは、訂正／取消の到着をその record の静かな失効遷移として優先する。holdback／expiry timer を cancel して record を退場させ、旧発表は表示へ流さず、通知・high metric 加算なしの displayLifecycleOnly 相当 release を一回だけ行い、deadline 到来後にも再 release しない。訂正自身は既存の即時 fail-open release と一回通知を行い、取消自身は既定どおり非通知である。さらに VPOA50 の `InfoType=取消` は、admission filter と独立に Kind.Code／Condition／Status の値を問わず severity を `unknown` へ固定し、high 昇格経路を構造的に遮断する。従って未観測の訂正／取消が pair 相関 cache の候補置換・解除・復帰を偶然起こさず、取消の即時 emit が通知適格にならない。
- VPOA50 rule は `status:"confirmed"`、`counterpartTypes:["VPBS50"]`、`windowBeforeMs:300_000`、`windowAfterMs:300_000`、`holdbackMs:60_000` とする。hook は source 側を identity とし、counterpart 側かつ `headType === "VPBS50"` のときだけ `^K(JP[A-Z]{2}\d{12}_\d{12})$` の capture 1 を返す。それ以外の counterpart type／形式は `null` とする。実 6 pair では EventID が常に利用できた一方、VPOA50 の府県予報区 code と VPBS50 の細分区域／市町村 code は同一粒度でなかったため、この縦切りの production `extractEventKey` は code fallback を成立させない。EventID 欠落時に名称・地域名・本文で補完しない。
- VPOA50 parser は Head の `Information[type="記録的短時間大雨情報（発表細分）"]` と Body の `Warning[type="記録的短時間大雨情報（発表細分）"]` から、Kind の code-name と Condition／Status、Area の code-name を抽出する。両経路が存在する場合は code の一致を要求し、矛盾、未知 shape、欠落を推測で埋めない。実 6 件では両経路の Kind.Code はすべて `1`、Condition／Status は `発表` だった。`InfoType=取消` を除くこの組を VPOA50 の `high` と確定する。通知を許す集合は、**`InfoType=発表` の unmatched release** と、Kind.Code `1`・発表状態を確定できた受理済み `InfoType=訂正` の §11.8／U5 通知だけとし、いずれも `対応電文未確認` を付けて既存 legacy high 規則の weather category／`warning` 音で一回発行する。取消は前項どおり常に `unknown` であり、同じ Code `1`／発表状態を含んでも通知しない。通常報／訂正について corpus に裏付けられた `nonHigh` code はないため、`1` 以外、code 欠落、Head／Body 矛盾、未知 Condition／Status、mixed evidence は `unknown` とし、`nonHigh` へ丸めない。これにより §11.9 の high／unknown metric は実 code で有効化し、通常報／訂正の non-high metric は将来の確認済み code 登録まで production では 0 を維持する。
- VPOA50 が一意 match した場合だけ source を抑止し、VPBS50 自体の既存 briefing parser、severity、通知、CLI／ticker、revision gate は変更しない。browser active card は未実装であり、本縦切りでは追加しない。VPBS50 が VPOA50 と無関係な場合も既存経路をそのまま通る。VXWW50／VPNO50 の60秒後 fail-open、三 source type 以外の ignore、他 domain の相関・表示・通知・stats・永続化は不変とする。

訂正・取消の保守側確定裁定（実 fixture 取得後に再裁定）:

- **保守側で確定（2026-08-23）:** 実 6 pair はすべて `InfoType=発表` であり、訂正／取消 pair は未観測である。`eligibleInfoTypes:["発表"]` により、VPOA50／VPBS50 の訂正・取消は type 間 suppression、pair candidate 置換、source 復帰、late reconcile の根拠にしない。ただし同一 source key の Holdback 中 pending 発表は前項の静かな失効遷移の対象とする。VPOA50 訂正は source-local の共通 revision gate を通して即時 fail-open 更新し、Kind.Code `1` と発表状態を確定できる場合だけ §11.8／U5 の `訂正`＋`対応電文未確認` 通知を一回許可する。VPOA50 取消は、`markCancelled` の EventID subject 受理が既存 active state を要求せず、legacy DTO の `groupKey` も `null` であるため、実取消 fixture を得るまで**表示解除を行わない非通知 fail-open**とする。severity は常に `unknown` へ固定し、受理は共通 revision gate の既存挙動に完全に委譲する。本縦切りでは取消に追加の診断・metric を設けず、既出表示は TTL 満了へ委ねる。VPBS50 側の訂正／取消は既存 briefing 契約を変えない。VPOA50 の取消 remove policy と pair をまたぐ訂正／取消は、両側実 fixture を得た次縦切りで再裁定する。

late reconcile の確定裁定:

- **裁定済み（2026-08-23、A 採択）:** 本縦切りは Holdback 内 suppression と timeout 後の unmatched high 通知までとする。timeout 後に VPBS50 が到着した場合、既存 typed `reconcileLateCounterpart` action により VPBS50 は通常 emit するが、表示済み VPOA50 の ticker は除去せず、browser active card は未実装のまま、`legacyLateCounterpartReconciled` も加算しない。現在の `DisplayIngestSink` は `ingest()` だけで legacy DTO の `groupKey` は `null` のため、source 除去と canonical ticker 差し替えを原子的に保証できない。ここで同一 `groupKey` 上書きを導入すると hub `recent`、VPBS50 固有 identity、TTL が競合するため、fixture／rule／通知の有効化と表示 protocol 変更を分離する。この既知の残存差分は §11.5 の最終状態をまだ満たさず、Phase 6B 全体完了とは数えない。

変更単位（依存順。3単位）:

1. 実 fixture・VPOA50 extractor・severity vertical slice: 対象は `test/fixtures/`、`test/helpers/mock-message.ts`、`src/types.ts`、`src/dmdata/legacy-counterpart-parser.ts`、`src/engine/presentation/processors/process-legacy-counterpart.ts` と対応 parser／processor tests。corpus の 12 XML は内容を編集せず、`phase6b_VPOA50_<raw EventID>.xml`／`phase6b_VPBS50_<raw EventID>.xml` として copy し、test 内の provenance table に元の checkout 相対 path と dmdata message id を残す。test は destination と corpus source の byte equality を持込時に照合した後、tracked fixture だけで実行可能にする。完了条件は 6 pair を EventID、ReportDateTime、PublishingOffice、serial、Kind.Code `1`、Condition／Status `発表` で固定し、VPOA50 の areas／kinds／severity evidence が raw XML から抽出され、title／headline の語から code や severity を推定せず、**取消以外では `InfoType=発表` の `1` active、および Kind.Code `1`・発表状態を確定できた受理済み `InfoType=訂正` が high**、未知／欠落／矛盾は unknown、取消は Code `1`／発表状態を含んでも unknown 固定・表示解除なし・非通知 fail-open で既出表示を TTL 満了まで残すこと。後続検証は対象 vitest と `npm run typecheck:test`。
2. EventID normalization・confirmed registry・correlator vertical slice: 対象は `src/engine/messages/legacy-counterpart-registry.ts`、`src/engine/messages/legacy-counterpart-correlator.ts`、`test/engine/telegram-foundation/legacy-counterpart-correlator.test.ts` と実 pair integration test。完了条件は optional hook の後方互換、`eligibleInfoTypes:["発表"]` の admission 前評価と非対象 input の pair 相関 cache 不変／source 即時 fail-open、VPBS50 側だけの厳密 `K` 除去、6 pair×source／counterpart 両先着の一意 match、前後5分 inclusive、60秒 Holdback を固定すること。さらに source／counterpart の各側で hook が throw、`""`、空白だけを返す場合、余分な `K`、小文字、桁不足、異なる canonical EventID、時間窓外、片側 EventID 欠落、未確認の code fallback、複数候補がすべて fail-open となり、両 raw EventID がある non-match で code identity に降りないこと、保守側確定裁定どおり訂正／取消は production pair 相関へ参加しないこと、VXWW50／VPNO50 の production rule が `unconfirmed`／counterpart 空のままであることを確認する。後続検証は対象 vitest、`npm run test:shuffle`、`npm run typecheck:test`。
3. router・通知・stats・production integration gate: 対象は `src/engine/messages/message-router.ts`、`src/engine/notification/notifier.ts`、`src/engine/messages/telegram-stats.ts` と `test/engine/message-router.test.ts`、`test/engine/notifier.test.ts`、`test/engine/telegram-stats.test.ts`、Phase 6B integration tests。完了条件は Holdback 内の実 pair で VPOA50 表示／通知が 0、VPBS50 が既存 briefing 経路で一回だけ表示／通知されること、source-only の `InfoType=発表` Code `1` が60秒後に qualifier 付きで weather category／`warning` 音の通知を一回発行し high metric を一回加算すること、取消が Code `1`／発表状態を含んでも severity unknown・通知0となり、共通 gate 後も pair 相関 cache／active surface を除去せず TTL 満了へ委ね、追加の取消 diagnostic／metric を発生させないこと、unknown／ambiguous が通知されないこと、受理済み Code `1` 訂正が `訂正` と qualifier を併記して一回だけ通知されることを固定する。さらに `pending 発表→訂正／取消→deadline 超過` を fake timer で固定し、旧発表が表示・通知・high metric に一度も現れず、訂正は自身だけ即時表示・一回通知、取消は非通知、失効後の timer callback は release／metric を再実行しないことを確認する。restart 前の失効済み pending と restart 後の空 cache の同シナリオでも、旧発表の表示・通知・high metric と timer 再実行が生じないことを確認する。VXWW50／VPNO50 の fail-open、無関係な VPBS50、他 ignore、他 domain、既存 notification cadence／sound／stats／persistence に回帰がないことも固定する。後続の全ゲートは `npm run build`、`npm test`、`npm run test:shuffle`、`npm run typecheck:test`、`npm run display:build`、`npm run display:test`、`npm --prefix display run typecheck`。
旧条件付き変更単位4（late reconcile・display atomic replacement）は**非採択（次縦切りで再検討）**とする。

本起草タスクの完了条件は **N/A（DOC 照合のみ）** とする。§11.2〜11.9、上記 Phase 6B 骨組み契約、§14.7、§16 U2／U5、§17 に対し、normalization の比較順、high／nonHigh／unknown、metric 一回性、fail-open、既存挙動保存、rule/severity slice と次縦切りの display reconcile slice の境界が矛盾なく一意に読めることだけを確認する。コード、fixture、corpus は本起草では変更しない。

6B後半・第2縦切り実装契約（2026-08-24 改訂。VPOA50→VPBS50 ticker reconcile slice）:

状態: **実装済み（2026-08-24。裁定 A/A/A は2026-08-25ご主人追認済み・確定。単位1 926e070・単位2 9a22809・単位3 3a6f250・単位4 33b5ccd、各単位 Sol high レビュー ADDRESSED・全ゲート緑）**。本縦切りは第1縦切りで production 有効化済みの VPOA50→VPBS50 `InfoType=発表` 一意 pair に限り、source admission から11分以内かつ Holdback timeout 後の typed `reconcileLateCounterpart` action を ticker surface の原子的 reconcile へ接続する。対象は `InfoDisplayHub.recent`、frontend ticker scheduler／catalog、display protocol sync、`legacyLateCounterpartReconciled` metric だけである。browser active card は現状未実装で除去対象がなく、standalone VPBS50 を含む card の新規表示は本縦切りの範囲外とする。現状の `DisplayIngestSink` は `ingest(event):void` だけで、legacy DTO の `groupKey` は `null`、通常 event ingest 時には source の exact key を置換しない。既存 `src/engine/messages/legacy-counterpart-correlator.ts` の action は canonical `outcome`、`sourceOutcome`、`sourceIdentity` を既に型付きで返すため、相関器へ display receipt／TTL を持ち込まず、この action を router の起点として保存する。

前提・不変条件:

- 2026-08-23 の A 裁定どおり、第1縦切りの rule／severity／通知を変更しない。本縦切りは late action の ticker 結果だけを扱い、Holdback 内 suppression、VPOA50 high 判定、VPBS50 の briefing parser／通知／revision gate、VXWW50／VPNO50 の unconfirmed 状態を保存する。
- 同一 `groupKey` 上書きは再提案しない。source ticker は timeout 時の ingest result が返した全 exact `eventKey` で除去し、canonical VPBS50 は自身の DTO identity のまま挿入する。`InfoDisplayHub.recent` に source を残したまま frontend だけ隠す設計、source key を VPBS50 key に偽装する設計、browser active card を追加する設計を禁止する。
- reconcile は「source ticker key 集合の除去」「canonical VPBS50 ticker の挿入」「client が参照する seq の更新」を一つの server mutation と一つの frontend reduce で行う。`tickerGeneration` と `resetScheduler` の全破棄は使わず、frontend scheduler の current／queue／deferred／catalog を exact source `eventKey` だけ targeted purge して canonical を一度だけ投入する。source 通知は撤回せず、合成取消・再通知・`notified` metric を発生させない。
- source receipt は router が handler-local・非永続に所有し、最大512 lifecycle とする。一 lifecycle は最大32個の active ticker `eventKey`、absolute expiry、receipt generation と、注入 scheduler で source 受信 `t0` を起点に inclusive 境界の外側である `t0+660,001ms` に張る expiry timer を保持する。従って `t0+660,000ms` までは late match が有効で、`t0+660,001ms` で receipt を破棄する。source の revision／ReportDateTime／messageId が変わる更新は key を同 receipt へ追加する。lifecycle 上限超過時は最古 receipt を eviction して timer と receipt を破棄するが、その key を hub `recent` から除去しない。key 上限超過は receipt だけを unsupported とし、expiry／dispose まで timer は維持する。同一 EventID の新 lifecycle admission、expiry timer 発火、router dispose でも receipt と timer を確実に破棄し、late reconcile 成功時だけ receipt を消費して同様に破棄する。late action の action token は変更せず、receipt generation を一回性の照合子として使う。reconcile failure は receipt を消費しないが correlator を再駆動せず、metric 0 の fail-open とする。correlator の match・timer・capacity・tombstone／expiryと receipt の掃除は独立に動き、receipt 不在は unsupported fail-open・metric 0 とする。
- pair 適格（`eligibleInfoTypes` を通過して pair 相関、すなわち source 側の Holdback／counterpart 側の candidate cache に参加する）VPOA50／VPBS50 の通常 ingest は、source先着・counterpart先着・late reconcile のいずれでも date gate 済み `ReportDateTime + tickerTtlMs(priority, domain)` を absolute expiry に使う。VPOA50 は warning frame の mid priority、従って現行 duration は120分である。late VPBS50 は `min(source expiry, canonical VPBS50 の ReportDateTime＋自身の priority duration)` を使い、Holdback／遅着で source TTL を延長しない。VPBS50 の priority は自身の既存判定に従い、固定30分へ丸めない。pair 不適格の訂正・取消、他 domain、rule対象外 type は現行どおり受信時刻 anchor のままとする。
- `legacyLateCounterpartReconciled` は typed result の hub mutation が `applied` の場合だけ、receipt generation ごとに global／VPOA50 type-local を各一回加算する。delivery は `delivered`、`noClients`、`blockedSkipped`、`byteGuardDropped` を result で区別し、後三者は mutation の rollback 理由にしない。`unsupported`、receipt 不在／unsupported、hub unavailable／stopped、hub mutation failure は metric 0 とし、canonical の通常 ingest を一回だけ fail-open で続ける。
- display off/on の ticker 分岐は次で固定する。(1) timeout 時に hub があれば receipt と surface を作る。(2) hub 不在／stop／projection失敗なら receipt を作らない。(3) receipt なしの late action は unsupported fail-open・metric 0 で canonical を通常 ingest する。(4) receipt 作成後に hub が不在となった late action も metric 0・再試行なしとし、canonical は通常 ingest 経路だけを試みる。(5) その後 display on しても source／canonical ticker を遡及 seed しない。存在しない surface の除去を自明成功にせず、receipt 不在を success にしない。process restart 後も空 receipt から fail-open とする。

裁定済み（A/A/A、2026-08-25ご主人追認済み・確定）:

1. **sink command shape A**: `DisplayIngestSink` は optional capability として discriminated `DisplayIngestResult` と pair 専用 `reconcileLateCounterpart()` を定義する。未実装 sink は `unsupported` fail-open とし、C の段階導入互換をここへ含める。汎用 `applyAtomicBatch()` は導入しない。
2. **wire atomicity A**: protocol に event 相当の seq／SSE id を持つ targeted `reconcile` message を additive に追加し、canonical DTO と source ticker `eventKey[]` を一 frame で運ぶ。既存 `event`＋`state{tickerSynced:true}` の二 frame 方式は採用しない。
3. **expiry anchor A**: pair 適格 VPOA50／VPBS50 の通常 ingest 全経路に前記 ReportDateTime anchor と `min(source, canonical)` 上限を採用する。pair 不適格 input の受信時刻 anchor は変えない。現行 high 30分という前提は撤回し、priority 別 `tickerTtlMs()` を唯一の duration source とする。

変更単位（依存順。4単位）:

1. sink result／receipt と router ownership: 対象は `src/engine/display/types.ts`、`src/engine/monitor/display-sink.ts`、`src/engine/monitor/monitor.ts`、`src/engine/messages/message-router.ts`、`test/engine/monitor/display-sink.test.ts`、`test/engine/message-router.test.ts`、`test/engine/messages/message-router-display.test.ts`。`src/engine/messages/legacy-counterpart-correlator.ts` の既存 typed action shape は参照するが変更しない。完了条件は router 所有の receipt lifecycle の512／32上限、注入 scheduler による `t0+660,000ms` まで有効・`t0+660,001ms` で破棄する timer、generation、成功消費／new lifecycle／expiry／eviction／dispose の timer を含む確実な破棄、correlator cleanup と独立した receipt 不在 fail-open、unsupported／failure 非消費、late action の通常 ingest 一回 fallback を固定すること。検証は `npx vitest run test/engine/monitor/display-sink.test.ts test/engine/message-router.test.ts test/engine/messages/message-router-display.test.ts`、`npm run typecheck:test`。
2. server ticker mutation／protocol transport: 対象は `src/engine/display/hub.ts`、`src/engine/display/protocol.ts`、`src/engine/display/sse-clients.ts`、`test/engine/display/hub.test.ts`、`test/engine/display/sse-clients.test.ts`、`test/engine/display/protocol-sync.test.ts`。完了条件は hub `recent` の全 source exact key を除去して canonical DTO を一 mutation で挿入し、ReportDateTime anchor の expiry 上限、seq／SSE id、0 client／blocked／byte guard result、snapshot による gap recovery を固定すること。standalone／無関係な VPBS50 は通常 ingest のまま、card／standby state／persistence は変更しない。検証は `npx vitest run test/engine/display/hub.test.ts test/engine/display/sse-clients.test.ts test/engine/display/protocol-sync.test.ts`、`npm run build`、`npm run typecheck:test`。
3. frontend targeted reconcile sync: 対象は `display/frontend/src/lib/protocol.ts`、`display/frontend/src/lib/store.ts`、`display/frontend/src/lib/connection.svelte.ts`、`display/frontend/src/lib/ticker-schedule.ts`、`display/frontend/src/components/Ticker.svelte`、`display/frontend/src/App.svelte`、`display/frontend/src/lib/__tests__/store.test.ts`、`display/frontend/src/components/__tests__/ticker.test.ts`。完了条件は single reconcile reduce が source keys だけを ticker と scheduler の全滞留箇所から消し、canonical を一回投入し、generation 全 reset を行わないこと。旧 snapshot／unknown message／通常 event scheduling は不変とする。検証は `npm run display:build`、`npm run display:test`、`npm --prefix display run typecheck`、`npx vitest run test/engine/display/protocol-sync.test.ts`。
4. production metric／実 pair integration gate: 対象は `src/engine/messages/message-router.ts`、`test/engine/telegram-foundation/phase6b-legacy-counterpart.test.ts`、`test/engine/telegram-foundation/legacy-counterpart-correlator.test.ts`、`test/engine/telegram-stats.test.ts` と上記 display tests。完了条件は tracked 実6 pairで `source→60,001ms timeout→660,000ms 以下の counterpart` と `counterpart→source` の最終 hub recent／frontend ticker catalog／再接続 snapshot が、pair 適格の ReportDateTime anchor と `min(source, canonical)` 上限を含めて同じ canonical VPBS50 ticker identity・内容・expiryとなり、source key が残らないこと。pair 不適格 input が現行の受信時刻 anchor を保つこと、60,000ms input先勝ち、660,001ms expiry、unrelated／ambiguous／訂正／取消、receipt上限、receipt expiry／eviction／dispose、sink failure、action再送、display off/on の5分岐、process restart、0 client／blocked／byte guardを固定し、mutation成功時だけ metric を各一回加算する。全ゲートは `npm run build`、`npm test`、`npm run test:shuffle`、`npm run typecheck:test`、`npm run display:build`、`npm run display:test`、`npm --prefix display run typecheck`。

第3縦切り（着手確定・全12裁定確定）: browser active card の新規導入、card type／kind union、layout solver、component、standalone VPBS50 card、および card reconcile は、直後の独立契約で扱う。本縦切りの ticker receipt、identity、TTL、metric を card state へ流用してはならず、card 専用 fixture と layout 契約を先に確定する。

非対象・既存挙動保存: parser／fixture／corpus、VPOA50→VPBS50 normalization・production registry・severity、通知本文／sound、revision／transport／semantic dedup、correlator の match・timer・capacity・tombstone、VPOA50取消 remove policy、pairをまたぐ訂正／取消、VXWW50／VPNO50 rule、browser active card／standby state／layout solver／component、永続化 schema、他 domain の ticker identity・TTL・protocol projectionは変更しない。late reconcile 前に発行済みの VPOA50 OS通知と CLI出力は履歴として残し、監査ログから source を消さない。

本起草タスクの完了条件は **N/A（DOC照合のみ）** とする。§11全節、1769〜1830行の6B骨組み契約、上記第1縦切り契約、§14.7、§16 U1／U2／U5、§17に対し、ticker exact-key removal、canonical identity、TTL非延長、通知非撤回、metric成功境界、receipt lifecycle、optional capability、protocol mirror、card第3縦切りへの分離が矛盾なく一意に読めることだけを確認する。コード、fixture、corpusは本起草では変更しない。

6B後半・第3縦切り実装契約（2026-08-25 起草。VPOA50／VPBS50 browser active card 導入＋card reconcile slice）:

状態: **着手確定・実装前（全12裁定確定）**。scope は VPOA50／VPBS50 の browser active card 新規導入、独立した card state、wire kind、component、layout solver 参加、および VPOA50→VPBS50 の card reconcile とする。standalone、pair 先着、pair 後着、pair 不適格を含む受理済み VPBS50 はすべて card projection の対象とし、pair の有無で VPBS50 card の有無を変えない。VPOA50 は既存 60秒 Holdback 内に一意 match した source を card に出さず、timeout／unmatched／ambiguous／pair 不適格の fail-open emit が実際に行われたときだけ card に出す。これにより §11.5 の「同じ pair が保持期間内に揃う限り到着順によらず最終 active 表示が一致」を ticker だけでなく browser card にも成立させる。

前提・不変条件:

- 第2縦切りの scope 切り直しと設計裁定 A/A/A（pair 専用 optional sink command、single targeted reconcile wire frame、ReportDateTime anchor）は2026-08-25にご主人追認済みであり、再裁定しない。第1縦切りの production rule／`eligibleInfoTypes:["発表"]`／severity／通知、第2縦切りの ticker exact-key removal／TTL／receipt／`legacyLateCounterpartReconciled` 成功境界を保存する。
- card は既存 `ActiveStandbyCardV1` と frontend `CardKey` に additive な**新規 kind**として参加させる。既存 `volcano`／`typhoon`／`heat`／`flood`／`tornado`／`longPeriod`／`nankaiTrough` の wire shape、`tsunami`／`quake`／`weather`／`flood`／`typhoon`／`volcano`／`heat` の solver 契約、component、priority、TTL、永続化、表示順を変更しない。weather card の別名、weather rider、未知 kind fallback に偽装しない。
- card state は第2縦切りの ticker receipt、ticker `eventKey`／`groupKey`、`tickerTtlMs()`、`legacyLateCounterpartReconciled`、hub `recent` を一つも真実源にしない。card 専用 identity、expiry、generation／一回性、容量、mutation result を別に定義する。同じ数値を採択する場合も card registry の独立定数と根拠を持ち、ticker の定数・receipt・metric を import／参照しない。
- card fixture の一次入力は既存実 XML `test/fixtures/82_01_01_260324_VPBS50.xml`、`test/fixtures/82_03_01_260324_VPBS50.xml`、`test/fixtures/82_01_02_250630_VPBS50.xml`、`test/fixtures/82_01_03_241031_VPBS50.xml`、既存 `test/fixtures/synthetic_VPBS50_multi.xml`／`test/fixtures/synthetic_VPBS50_unknown-tag.xml`／`test/fixtures/synthetic_VPBS50_empty.xml`／`test/fixtures/synthetic_VPBS50_cancel.xml`、および `test/fixtures/phase6b_VPOA50_*.xml`／`test/fixtures/phase6b_VPBS50_*.xml` の実6 pairとする。card 用 expected fixture は `test/helpers/display-fixtures.ts` に raw XML から得た title、headline、Condition 集合、code付き target area、ReportDateTime、PublishingOffice、InfoType、severity evidence、qualifier を明示し、raw XML全文、CLI整形済み文字列、ticker sentenceを card payload に流さない。
- layout 契約は「新 kind が `CARD_ORDER`、candidate presence／score、side／center measurement shelf、`CardCandidate`、solver、rotation、live render、layout motion identity の全経路を同じ自然高で通る」「solver が選んだ外枠高と live component 高が一致する」「overflow／unresolved 時も既存 card を clip／重複表示しない」とする。新 kind は既存 pager と同じ `PageableKey`／probe／rotation appearance 契約へ参加し、page遷移・pending→確定でもsolver予約高とlive outer高を揺らさない。`fcba058` の previous committed plan 固定は保存し、同 candidate の内容置換で fitting surface を動かさず、candidate追加、真のseverity score上昇、実overflowだけが固定を解除する。
- typed `reconcileLateCounterpart` action は ticker receipt の有無と独立に必ず card mutation へ配送する。card mutation は card専用generationを持つ `CardReconcileResult` を返し、ticker mutation／receipt／`legacyLateCounterpartReconciled` の結果とは合成しない。ticker receiptがあり配送可能な場合は一つの additive `reconcile` frame にticker targeted mutationとcard payloadを載せ、frontendの一 reduceで両surfaceを更新する。receipt不在時も、card mutationが`applied`なら配信可能な場合にだけcard-only reconcile frameまたはauthoritative state snapshotを一回送信し、display off、hub unavailable／stopped、0 client、blocked、byte guardでは送信を要求せずmonitor所有card stateへ反映する。次回display on／browser reconnectはそのauthoritative snapshotで収束し、同じreconcile reduceはticker schedulerを触らずcardだけを更新する。card metricはdelivery resultによらずcard mutationが`applied`となった後だけ一回加算し、deliveryの`delivered`／`noClients`／`blockedSkipped`／`byteGuardDropped`はrollback理由にしない。process restart は非永続の空stateからfail-open再開する。protocol unknown message、旧 snapshot の kind 欠落は fail-open とし、電文処理、CLI、通知を停止しない。

確定裁定（2026-08-25 ご主人裁定）:

1. **scope 確定**: VPOA50／VPBS50 の browser active card 新規導入と card reconcile を本縦切りで実装する。
2. **standalone 確定**: standalone を含む全受理済み VPBS50 を card projection の対象にする。pair 参加資格は相関だけの条件であり、card 表示資格へ流用しない。受理済み訂正／取消も card projection 自体を無かったことにせず、具体的な active lifecycle は下記裁定に従う。
3. **new kind 確定**: card は既存 kind の意味を広げず、新規 kind として layout solver に参加する。既存 card の wire／表示／layout 契約は保存する。
4. **第2縦切り追認**: A/A/A と scope 切り直しは追認済み・確定であり、本縦切りは ticker reconcile を作り直さない。
5. **state 分離確定**: ticker receipt／identity／TTL／metric の card state への流用を禁止する。card fixture と layout 契約の緑を、runtime reconcile 接続より先の完了条件にする。

確定実装裁定（全12件、2026-08-25）:

1. **kind／集約（A）**: kind は `briefing` とし、一 outer cardへ複数の VPOA50／VPBS50 entryを集約する。identity／expiryはentry単位で持ち、一 kind＝一 solver candidateを保つ。
2. **identity（B）**: `card:vpoa:<raw EventID|messageId>`／`card:vpbs:<raw EventID|messageId>` をcard専用exact keyとする。事前canonical化を行わず、相関器の確定 actionだけを統合根拠としてsource keyをremoveしcanonical VPBS50 keyをinsertする。ticker key、EventID normalization hookの戻り値、`groupKey`は参照しない。
3. **TTL（A）**: 全entryはdate gate済みReportDateTime＋独立 `BRIEFING_CARD_TTL_MS=120分` を絶対expiryとする。late reconcileは `min(source expiry, canonical expiry)` を使い、到着順、Holdback、遅着、訂正で延長しない。
4. **原子性（A）**: ticker receiptがあり配送可能なlate pairはcard storeのsource→canonical commitとticker targeted mutationを一つのadditive `reconcile` frameに載せ、frontendの一 reduceで更新する。receipt不在時もcard mutationは必須で、`applied`後は配信可能な場合にだけcard-only reconcile frameまたはauthoritative state snapshotを一回送信し、配送不能時はmonitor所有stateを次回display on／browser reconnectのsnapshotで収束させる。card metricはdelivery resultでなく`applied`を一回性境界とし、card result／generation／metricとticker result／receipt／metricは別に判定する。
5. **solver安定化（A）**: VPOA50→VPBS50は同じ`CardKey`内のentry内容置換とする。candidate集合不変、score非上昇、収容可能ならfitting surface／rotation membership／current keyを保持し、candidate追加、真のseverity score上昇、自然高overflowだけが`fcba058`固定を解除する。
6. **severity／frame（A）**: engineは既存 `briefingFrameLevel` の結果をcard wireへ明示する。VPBS50はcritical／warning／infoを保持し、VPOA50 highはcritical、unknownはqualifier付きwarningとする。frontendの文字列再判定を禁止する。
7. **ticker重複（A）**: cardと既存VPBS50／VPOA50 tickerを併存させる。tickerは速報、cardはactive contextであり、既存tickerのidentity、TTL、scheduler、通知を変更しない。
8. **長文／複数entry（B）**: `briefing` を `PageableKey`へ追加し、既存15秒pager、partition probe、rotation appearanceへ接続する。固定上限による切捨てをせず、page遷移、pending→確定、rotationでsolver予約高、probe高、live outer高を同じpage-shell契約高に固定する。
9. **restart（A）**: card stateはmonitor process内・非永続とする。display off/onとbrowser reconnectは保持するが、process restartは空stateからfail-open再開し、`standby-persistence` schemaを変更しない。
10. **訂正／取消（A）**:受理済みVPBS50訂正は同entryを置換し、取消は取消frameへ置換してcard専用10分TTL後に消す。VPOA50は既存「取消で表示解除しない」裁定を保ち、取消自身のfail-open cardを独立表示する。
11. **容量（A）**: outer card一つ、active entry最大128とする。expiry済みを先にpruneし、なお満杯ならoldest updatedAt＋安定keyを一件evictして新報を表示する。既存briefing revision familyの上限は流用しない。
12. **metric（A）**: card専用 `legacyCardDisplayed`／`legacyCardReconciled`／`legacyCardEvicted` をadditiveに設け、deliveryの成否にかかわらずcard store mutationが`applied`となった後だけ一回加算する。`delivered`／`noClients`／`blockedSkipped`／`byteGuardDropped`はdelivery区分でありrollback理由にしない。第2縦切りのticker metricを流用しない。

変更単位（依存順。4単位）:

1. card fixture／独立 state／wire model: 対象は既存入力 `test/fixtures/82_01_01_260324_VPBS50.xml`、`test/fixtures/82_03_01_260324_VPBS50.xml`、`test/fixtures/82_01_02_250630_VPBS50.xml`、`test/fixtures/82_01_03_241031_VPBS50.xml`、`test/fixtures/synthetic_VPBS50_*.xml`、`test/fixtures/phase6b_VPOA50_*.xml`、`test/fixtures/phase6b_VPBS50_*.xml`（参照のみ）、既存 `test/helpers/mock-message.ts`（参照のみ）、`test/helpers/display-fixtures.ts`、`src/engine/display/protocol.ts`、`display/frontend/src/lib/protocol.ts`、`src/engine/display/standby-registry.ts`、`src/engine/display/standby-state-store.ts`、`test/engine/display/standby-state-store.test.ts`、`test/engine/display/protocol-sync.test.ts`。完了条件は fixture matrix の全 card payload、standaloneを含む全VPBS50、VPOA50 fail-open、card専用identity／TTL／generation／capacity、訂正／取消、source→canonical純粋置換が ticker stateなしで決定的に通り、engine／frontendのprotocol sync区間が同一単位内でbyte-for-byte一致し、既存 kind snapshotがbyte-level shapeを変えないこと。検証は `npx vitest run test/engine/display/standby-state-store.test.ts test/engine/display/protocol-sync.test.ts test/dmdata/briefing-parser.test.ts test/engine/telegram-foundation/legacy-counterpart-correlator.test.ts`、`npm run typecheck:test`。
2. production sink／hub／protocol reconcile: 対象は `src/engine/display/types.ts`、`src/engine/monitor/display-sink.ts`、`src/engine/monitor/monitor.ts`、`src/engine/display/hub.ts`、`src/engine/display/protocol.ts`、`src/engine/display/sse-clients.ts`、`src/engine/messages/message-router.ts`、`test/engine/monitor/display-sink.test.ts`、`test/engine/display/hub.test.ts`、`test/engine/display/sse-clients.test.ts`、`test/engine/messages/message-router-display.test.ts`。完了条件は通常ingestがdisplay off中もcard stateを更新し、Holdback内suppressionはsource cardを作らず、typed late actionがticker receiptの有無にかかわらずcard専用generationを一回だけ消費してsource→canonicalを置換すること。ticker receiptがあり配送可能ならsingle reconcile frame／single frontend reduceで二surfaceを更新する。receipt不在、hub unavailable／stopped、display off中card、0 client／blocked／byte guardではcard resultをticker resultと独立に`applied`としてmonitor所有stateへ確定し、配信可能な場合だけcard-only reconcile frameまたはstate snapshotを一回送信し、不可なら次回display on／browser reconnectのauthoritative snapshotで収束する。card metricはdelivery resultによらず`applied`ごとに一回加算し、delivery区分をrollback理由にしない。ticker receiptのexpiry／eviction、action再送、display off/on、process restartでもcardとtickerのfail-open境界を混同しない。検証は対象vitest、`npm run build`、`npm run typecheck:test`。
3. frontend kind／component／layout solver／reduce: 対象は `display/frontend/src/lib/store.ts`、`display/frontend/src/lib/connection.svelte.ts`、`display/frontend/src/lib/legacy-standby/types.ts`、`display/frontend/src/lib/legacy-standby/solver.ts`、`display/frontend/src/lib/legacy-standby/layout-motion.svelte.ts`、`display/frontend/src/lib/legacy-standby/time-slice-scheduler.svelte.ts`、`display/frontend/src/lib/legacy-standby/page-partition.ts`、`display/frontend/src/components/StandbyScreen.svelte`、新規 `display/frontend/src/components/BriefingCard.svelte`、`display/frontend/src/lib/__tests__/store.test.ts`、`display/frontend/src/lib/legacy-standby/__tests__/solver.test.ts`、`display/frontend/src/lib/legacy-standby/__tests__/time-slice-scheduler.test.ts`、`display/frontend/src/lib/legacy-standby/__tests__/page-partition.test.ts`、`display/frontend/src/components/__tests__/standby.test.ts`、新規 `display/frontend/src/components/__tests__/briefing-card.test.ts`、`display/frontend/src/preview/LegacyImprovedMock.svelte`、`display/frontend/src/preview/__tests__/legacy-improved-mock.test.ts`（実装時裁定 2026-08-25: `PageableKey` の exhaustive 列挙が preview mock の Record 型全列挙へ波及するため additive な briefing entry 追加のみ対象に含める）。完了条件は単位1で同期済みの新 kindをcomponentまでexhaustiveに接続し、`briefing` を `PageableKey` の固定配列／Record型／scheduler diagnostics／dispose／rotation appearanceの全列挙へ加えること。page partition、pending→確定、page送り、rotationでpage-shell契約高がsolver予約高／probe高／live outer高と一致し、single reduceでsource cardが残らずcanonical VPBS50 cardが一つだけ残ることを固定する。`fcba058` の候補集合不変・priority非上昇・収容可能時のsurface固定、候補追加／priority rise／overflowの解除条件、layout motion identity、unknown旧snapshot、既存card全種の配置／表示回帰を固定する。検証は `npm run display:build`、`npm run display:test`、`npm --prefix display run typecheck`。
4. production-shaped integration gate／metric: 対象は `src/engine/messages/telegram-stats.ts`、新規 `test/engine/telegram-foundation/phase6b-legacy-card-production.test.ts`、`test/engine/telegram-foundation/phase6b-legacy-counterpart.test.ts`、`test/engine/telegram-foundation/legacy-counterpart-correlator.test.ts`、`test/engine/telegram-stats.test.ts` と上記server／frontend tests。card metric 配線の機械的必然として `src/engine/display/standby-registry.ts`、`src/engine/display/standby-state-store.ts`、`src/engine/display/types.ts`、`src/engine/messages/message-router.ts`、`src/engine/monitor/display-sink.ts`、`test/ui/statistics-formatter.test.ts`、新規 frontend 一本鎖 production test と補助 byte 同期 fixture、専用 project 化に必須の `vitest.config.ts`（除外設定）・新規 `display/vitest.phase6b-production.config.ts`・root `package.json` の `test:phase6b-production` script も対象に含める（実装時裁定 2026-08-25）。完了条件は**同一test実行内で、実XML→実parser／processor→実`createDisplaySink` factory→実`StandbyStateStore`／`InfoDisplayHub`→実router late actionが生成したframe／snapshotを加工せず→frontend `reduce()`→`StandbyScreen` render**まで渡すproduction-shaped testを新規ファイルに持つこと。区間別testの合算、`PresentationEvent`の直投入、mock sink／store、手組みframe／snapshotではこの完了条件を満たさない。tracked実6 pairの `source→60,001ms timeout→660,000ms以下のcounterpart` と `counterpart→source`、standalone実VPBS50 4種、Holdback内suppression、unrelated／ambiguous、訂正／取消、card expiry境界、ticker receipt不在のcard-only late reconcile、display off/on、restart、0 client／blocked／byte guardで最終card identity・内容・expiry・配置が一致し、source cardが残らずcanonical cardが一つ、既存ticker／通知／CLIが保存されることを確認する。全ゲートは `npm run build`、`npm test`、`npm run test:shuffle`、`npm run typecheck:test`、`npm run display:build`、`npm run display:test`、`npm --prefix display run typecheck`、`npm run test:phase6b-production`（一本鎖 production gate は専用 jsdom project のため通常 vitest から除外——この script でのみ走る。実装時裁定 2026-08-25）。

非対象・既存挙動保存: VPOA50／VPBS50 parserと既存XML fixture／corpusの内容、confirmed normalization／`eligibleInfoTypes`／severity、correlatorのmatch／timer／capacity／tombstone、第2縦切りのticker receipt／identity／TTL／metric／targeted scheduler purge、通知本文／sound／通知済み履歴、CLI出力、VPOA50取消remove policy、pairをまたぐ訂正／取消、VXWW50／VPNO50 rule、他domainのcard／ticker／standby state、`standby-persistence` schemaは変更しない。late reconcile前に発行済みのVPOA50通知とCLI履歴は撤回せず、監査ログからsourceを消さない。

本起草タスクの完了条件は **N/A（DOC照合のみ）** とする。§11全節、§14.7、§16 U1／U2／U5、§17、Phase 6B骨組み、第1・第2縦切り契約、実在するfixture／card kind／solver／pager／protocol／factory結線に対し、standaloneを含む全VPBS50、new kind、card fixture先行、ticker/card state分離、receipt不在のcard-only reconcile、到着順同値、`fcba058`安定化、production-shaped integration gate、非対象保存、および全12確定裁定が矛盾なく一意に読めることだけを確認する。コード、fixture、corpus、他文書は本起草では変更しない。

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
