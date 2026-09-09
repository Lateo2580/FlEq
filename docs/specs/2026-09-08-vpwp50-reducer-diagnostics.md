# VPWP50 reducer の結果分類 spec（GitHub Issue #16・診断のみ）

> **裁定状態**: 裁定済み（2026-09-08、ご主人）。§6 の判断分岐 5 件はすべて推奨どおりで確定した——分岐 1 = A、分岐 2 = **C**、分岐 3 = B、分岐 4 = A、分岐 5 = A（9 コード）。バックログ上は `🌙自走OK`。

> **前提**: 本 spec は Issue #16 のうち **reducer の戻り値分類と診断ログ**だけを扱う。表示挙動・電文受理・永続化・件数上限は一切変えない。Issue の項目 6（実機の当該 revision に対応する元 XML を採って発生理由を確定する）は実機作業で、本 spec の受入条件には含めない（§5.3）。#13 の周期停止と #15 のブラウザ再計測は別レーン。

> **基準 SHA**: `f8e2c688fb25b555b0a3e579c4c70210d2cda7dd`（worktree `~/dev/fleq-layout`、branch main）。Issue の静的調査基準は `a58a2f9` だが、`weather-warning-forecast-active-reducer.ts` と `standby-state-store.ts` の該当箇所は本 spec の起草時に `f8e2c688` 上で実読して行番号を採り直した。以下の file:line はすべて `f8e2c688` のもの。

> **Issue 取得**: 成功（`gh api repos/Lateo2580/FlEq/issues/16`）。**コメントは 0 件**（`.../issues/16/comments` が空配列）。本文のみを根拠にしている。

---

## 1. 症状

実機スクリーンショットに次の 1 行が出た（Issue 本文より引用、Liebe は実機画面を見ていない）。

```text
[VPWP50] vpwp50ProjectionRejected subject=weatherTimeseries:気象庁:scope:all revision={"reportTimeMs":1788697500000,"serial":null} existingProjectionDeleted=false
```

この形式（`revision=` を持ち `reason=` を持たない）を出すのは 1 箇所だけである。

`src/engine/display/standby-state-store.ts:846-850`

```ts
if (state == null) {
  const changed = this.weatherWarningForecasts.delete(subjectKey);
  log.warn(`[VPWP50] vpwp50ProjectionRejected subject=${subjectKey.slice(0, 128)} revision=${JSON.stringify(revision)} existingProjectionDeleted=${changed}`);
  return changed ? { viewChanged: true, durableChanged: true } : NO_MUTATION;
}
```

同ファイルの他の `vpwp50ProjectionRejected` は `reason=` を持つので（`:805` `reason=invalidParsedPayload`、`:828` `reason=invalidReportDateTime`、`:861` `reason=wireInvariant`）、画像の行と形式が合わない。**この 1 行から入力原因を特定することはできない**——それが本 Issue の主題である。

## 2. 根因（file:line）

### 2.1 `reduceWeatherWarningForecast` は 8 箇所で `null` を返し、呼び出し元はそれを 1 つに潰す

`src/engine/display/weather-warning-forecast-active-reducer.ts:162-278` の戻り値は `WeatherWarningForecastState | null`（`:169`）。`null` を返す経路の全列挙は次のとおり。

| # | 行 | 条件 | 現状の意味づけ |
|---|---|---|---|
| 1 | `:178-187` | header 検証の複合条件。**11 本の disjunct**（内訳は §3.1.1 の表） | **11 種の異常が 1 つの `return null` に潰れている** |
| 2 | `:190` | `projected.some((entry) => !validOccurrence(entry))`（`validOccurrence` は `:135-159`） | 検証失敗 |
| 3 | `:214-216` | group / target / occurrence の stable key と tuple の衝突検出 | identity 衝突 |
| 4 | `:223` | `groups.size > WEATHER_WARNING_FORECAST_MAX_GROUPS_PER_SUBJECT`（128） | **容量超過** |
| 5 | `:236` | `targets.size > WEATHER_WARNING_FORECAST_MAX_TARGETS_PER_GROUP`（128） | **容量超過** |
| 6 | `:254` | `periods.length > WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_TARGET`（128） | **容量超過** |
| 7 | `:276` | `all.length === 0` | **正常な「表示対象なし」** |
| 8 | `:277` | `all.length > WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT`（128） | **容量超過** |

上限値は `src/engine/display/weather-warning-forecast-wire.ts:10-17`（subjects 512 / groupsPerSubject 128 / targetsPerGroup 128 / periodsPerTarget 128 / periodsPerSubject 128 / periodsPerCard 128 / periodsPerAnchor 4 / cardJsonBytes 64KiB）。

呼び出し元は `standby-state-store.ts:833-850` の 1 箇所だけで、上の 8 経路（header の 11 disjunct を 1 経路と数えて 8）と **例外**（`:842-845` の `catch {}` が理由を捨てる）を、同じ `state == null` に落として同じ 1 行の warn にする。§3.1 の分解後は reject code 13 種＋`empty` 1 種になる。

**7 番（正常 empty）と 4・5・6・8 番（容量超過）が隣接した同じ戻り値である**ことが Issue 本文の指摘そのものであり、実コードで確認できた。

```ts
if (all.length === 0) return null;                                              // :276
if (all.length > WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT) return null; // :277
```

### 2.2 nested count 超過が詳細診断へ到達しない

`weatherWarningForecastProjectionLimitReasons()`（`src/engine/display/weather-warning-forecast-wire.ts:282-323`）は `Vpwp50ProjectionLimitReason`（同 `:51-59`：`code` / `actual` / `declaredLimit` / `effectiveLimit` / `violatingUnitCount` / `limitingHierarchies` / `samplePaths`）を返し、`code` の enum（同 `:47-49`）は `groupsPerSubject` / `targetsPerGroup` / `periodsPerTarget` / `periodsPerAnchor` / `periodsPerSubject` / `periodsPerCard` / `cardJsonBytes` である。

**このうち前 4 者にあたる階層の超過は、reducer が `null` を返した時点で打ち切られるため、この関数に一度も渡らない。** live 受理経路でこの関数を呼ぶのは `standby-state-store.ts:856-863`、つまり `state != null` が確定した後だけだからである。

なお、この関数の呼び出し元は実測でリポジトリ全体に 4 箇所ある。本 spec が触るのは 1 番目だけで、残る 3 つは**変更しない**（§3.5）。

| file:line | 経路 | 本 spec |
|---|---|---|
| `src/engine/display/standby-state-store.ts:858` | live 受理（`applyWeatherWarningForecast`） | §3.4 で reducer 由来の拒否を追加。**この呼び出し自体は現状のまま** |
| `src/engine/display/standby-state-store.ts:3410` | 復元（`restoreActiveStateInternal` `:3314`） | 変更しない |
| `src/engine/display/standby-persistence.ts:3451` | 永続 claim の検証 | 変更しない |
| `src/engine/display/standby-persistence.ts:8925` | 起動時 bundle 正規化（`normalizeVpwp50PersistenceBundles`） | 変更しない |

結果として `vpwp50ProjectionCapacityExceeded`（`standby-state-store.ts:872-874`）が記録されるのは、**card 全体の集計（`periodsPerCard`）と wire byte（`cardJsonBytes`）を超えた場合だけ**になる。subject 単体の nested count 超過は永久にこの分岐へ来ない。

これは `docs/specs/2026-08-31-vpwp50-forecast-card.md:468-469` の契約と不一致である。

> - count超過は`vpwp50ProjectionCapacityExceeded`、wire byte超過は`vpwp50ProjectionWireBudgetExceeded`をsubject bundleあたり一回記録する。
> - diagnosticにはsubject key、超過階層、actual count / bytes、limit、candidate revision、既存projection削除有無を含める。

なお `periodsPerAnchor`（上限 4）は reducer 側で構造的に超えない。anchor 割当が `pagerAnchorOrdinal = Math.floor(ordinal / 4)`（`weather-warning-forecast-active-reducer.ts:256`）なので 1 anchor に 4 件を超えて入らない。**この階層は本 spec の追加診断の対象外**とする（既存の card 側検査には残す）。

### 2.3 `all.length === 0` の内訳が失われている

`:188-189` で 2 段の絞り込みが起きる。

```ts
const allProjected = projectForecastOccurrences(parsed);
const projected = allProjected.filter((entry) => entry.slot != null && Date.parse(entry.slot.endsAt) > nowMs);
```

`ForecastOccurrenceEntry.slot` は `ForecastTimeSlot | null`（`src/engine/presentation/weather-severity-pyramid.ts:79-86`、生成は `:127-143`）なので、`projected` が空になる原因は少なくとも 3 つに分かれる。

1. `allProjected.length === 0`——parser が occurrence を 1 件も返さなかった
2. `allProjected.length > 0` かつ全件 `slot == null`——**slot 未解決**（parser 側の診断対象）
3. resolved slot はあるが全件 `endsAt <= nowMs`——**全 period 失効**（正常な期限切れ）

`projected` が非空なら `all.length === 0` にはならない。`mergePeriods`（`:82-103`）は非空入力に対し必ず 1 件以上返し、`periods.length > 0` の target は必ず `projectedTargets` に入り（`:260`）、`projectedTargets.length > 0` の group は必ず `output` に入る（`:272`）。したがって **`all.length === 0` ⟺ `projected.length === 0`** であり、上の 3 分類が `all.length === 0` の内訳のすべてである。Issue の「slot未解決などparser側の診断まで無差別に消さない」はこの 2 番を指す。

### 2.4 例外の分類が捨てられている

`standby-state-store.ts:842-845` の `catch {}` はコメントだけを残して例外オブジェクトを束縛しない。呼び出し元は `state` が `null` のままなので `:846-850` の warn に合流し、**「reducer が異常入力で throw した」ことすら記録に残らない**。

## 3. 変更

### 3.0 Phase 0 申告

実装者は製品コードを触る前に、変更記録または実装メモへ次を宣言する。

- **倣う既存パターン**: 同一ディレクトリの判別共用体 projection 結果 2 本——`VolcanoCardProjectionResult`（`src/engine/display/volcano-card-projection.ts:36-39`、`{ kind: "empty" } | { kind: "card"; ... } | { kind: "overflow"; minimumBytes: number }`）と `FinalizedTyphoonProbabilityResult` / `TyphoonProbabilityCandidateResult`（`src/engine/display/project-typhoon-probability.ts:101-116`、`kind: "active" | "cancel" | ...`）。**新しい結果表現を発明しない**。`kind` フィールド名・`switch` での網羅・`Extract`/`Exclude` の使い方をこの 2 本に合わせる
- **倣う既存の診断形**: `Vpwp50ProjectionLimitReason` / `Vpwp50ProjectionLimitDiagnostic`（`src/engine/display/weather-warning-forecast-wire.ts:51-66`）。**新しい診断 JSON 形を作らない**
- **倣う既存の bounded ログ作法**: `warnVpwp50PersistenceDiagnostic`（`src/engine/display/standby-persistence.ts:1059-1066`、`診断名 + detail` の 1 行・読み取り context 内で同一 token を重複させない）と、store 側の `subjectKey.slice(0, 128)` による切り詰め（`standby-state-store.ts:805,816,819,828,848,861,867`）
- **不変に保つ契約**: §3.5 の全項目

### 3.1 reducer の戻り値を判別共用体にする

`reduceWeatherWarningForecast`（`weather-warning-forecast-active-reducer.ts:162-278`）の戻り値を次にする。型名・コード名は既存の enum（`Vpwp50ProjectionLimitReasonCode`）を再利用し、新語を最小にする。

```ts
export type Vpwp50ForecastRejectReason =
  | { code: "invalidRevisionSerial" }
  | { code: "invalidNowMs" }
  | { code: "invalidReportTime" }
  | { code: "invalidSubjectKey" }
  | { code: "invalidSubjectPrefix" }
  | { code: "invalidSourceEventId" }
  | { code: "invalidPublishingOffice" }
  | { code: "invalidTargetArea" }
  | { code: "invalidSemanticKey" }
  | { code: "invalidOccurrence"; projectedOccurrenceIndex: number }
  | { code: "identityCollision"; scope: "group" | "target" | "occurrence" }
  | {
      code: "capacityExceeded";
      hierarchy: Extract<Vpwp50ProjectionLimitReasonCode,
        "groupsPerSubject" | "targetsPerGroup" | "periodsPerTarget" | "periodsPerSubject">;
      actual: number;
      declaredLimit: number;
      samplePath: string;
    }
  // reducer 自身は返さない。store が catch した例外から組み立てる唯一の variant（§3.3）。
  | { code: "reducerThrew"; detail: string };

export type Vpwp50ForecastProjectionResult =
  | { kind: "active"; state: WeatherWarningForecastState }
  | { kind: "empty"; reason: "noActivePeriods"; occurrences: number; resolvedSlots: number; expiredSlots: number }
  | { kind: "rejected"; reason: Vpwp50ForecastRejectReason };
```

**`reducerThrew` は共用体の一員として reducer ファイルに置く。** reducer 本体はこれを返さないが、型を 1 箇所に集めることで store が `as` でキャストせずに `{ kind: "rejected", reason: { code: "reducerThrew", detail } }` を組み立てられる。型定義を store 側へ分けたり、store で `as` を使ったりしない（`AGENTS.md` の `any` 禁止・CLAUDE.md の「`as` でコンパイラに嘘をつかない」）。

#### 3.1.1 header 検証 11 disjunct → 9 code の畳み込み

`:178-187` の `||` は実測で **11 本**ある。判定式そのものは変えず、順序を保ったまま独立した 11 判定へ分解し、次の 9 コードへ畳む。

| # | 行 | disjunct | code |
|---|---|---|---|
| 1 | `:178` | `normalizedSerial === undefined` | `invalidRevisionSerial` |
| 2 | `:179` | `!Number.isSafeInteger(nowMs)` | `invalidNowMs` |
| 3 | `:179` | `!Number.isSafeInteger(revision.reportTimeMs)` | `invalidReportTime` |
| 4 | `:180` | `!Number.isFinite(new Date(revision.reportTimeMs).getTime())` | `invalidReportTime` |
| 5 | `:181` | `!canonicalToken(normalizedSubject, VPWP50_MAX_SUBJECT_KEY_LENGTH)` | `invalidSubjectKey` |
| 6 | `:182` | `!normalizedSubject.startsWith("weatherTimeseries:")` | `invalidSubjectPrefix` |
| 7 | `:183` | `!canonicalToken(normalizedSource, VPWP50_MAX_SOURCE_EVENT_ID_LENGTH)` | `invalidSourceEventId` |
| 8 | `:184` | `!canonicalName(publishingOffice, VPWP50_MAX_PUBLISHING_OFFICE_LENGTH)` | `invalidPublishingOffice` |
| 9 | `:185` | `targetAreaName != null && !canonicalName(...)` | `invalidTargetArea` |
| 10 | `:186` | `targetAreaCode != null && !canonicalToken(...)` | `invalidTargetArea` |
| 11 | `:187` | `!/^(?:発表\|訂正):[0-9a-f]{64}$/.test(appliedSemanticKey)` | `invalidSemanticKey` |

畳み込みの根拠と分割の根拠。

- **3 と 4 を `invalidReportTime` へ畳む**: どちらも「報時刻が使えない」で運用上の対処が同じ。**4 は 3 に吸収されない独立条件**である——`Number.isSafeInteger(9e15)` は `true`（9e15 < 2^53−1 = 9007199254740991）だが、`new Date(9e15).getTime()` は ECMAScript の time value 上限 8.64e15 を超えるため `NaN` になる。つまり 4 は到達可能で、削ってはならない
- **9 と 10 を `invalidTargetArea` へ畳む**: どちらも `parsed.targetArea` 由来で、切り分けは同じ電文を見れば済む
- **5 と 6 を分ける**: 5 は「subject key の正規化・長さが壊れている」（こちら側の生成が疑わしい）、6 は「`weatherTimeseries:` で始まらない subject が VPWP50 の reducer へ来た」（routing が疑わしい）で、**次に見る場所が違う**

11 判定は元の `||` と同じ順序で評価し、最初に真になったものを返す。真になる入力集合を変えない。

- `kind: "empty"` は §2.1 の 7 番（`:276`）だけが返す。§2.3 の 3 分類はこの 3 数値から読み取れる。算出は次のとおりで、**`:276` の empty 分岐の内側でだけ計算する**

  | 値 | 式 | コスト |
  |---|---|---|
  | `occurrences` | `allProjected.length` | 0（`:188` の配列長） |
  | `resolvedSlots` | `allProjected.filter((entry) => entry.slot != null).length` | **新規の O(n) 走査 1 回** |
  | `expiredSlots` | `resolvedSlots - projected.length` | 0（`:189` の配列長との差） |

  `resolvedSlots` だけは既存の値の再利用ではなく追加の 1 パスになる。`all.length === 0` が確定した後にしか実行しないので、正常経路（`kind: "active"`）と拒否経路には一切乗らない。**empty 分岐の外で先に計算してはならない。**
- `kind: "rejected"` の `capacityExceeded` は §2.1 の 4・5・6・8 番（`:223,236,254,277`）が返す。`hierarchy` / `actual` / `declaredLimit` は各検出点にその場でそろっている値をそのまま載せる
- `samplePath` の組み立て（`escapePath` 呼び出しを含む）は**拒否分岐の内側でだけ行う**。受理経路が group 数ぶんの文字列結合と正規表現置換を払わないようにする（§4.7 で `escapePath` の呼び出し 0 回として固定する）
- `samplePath` は `weather-warning-forecast-wire.ts:175-195` の `countUnits` が作る path 表記に合わせる（`subjects/<escaped subject>/groups`、`subjects/<subject>/groups/<group key>/targets`、`.../targets/<target key>/periods`、`subjects/<subject>/periods`）。`escapePath`（同 `:75`、`~` → `~0` / `/` → `~1`）と同じ規則を使う。**`escapePath` は現在 module private（`const` 宣言に `export` が無い）なので、wire から `export` して reducer が import する**（実装の複製を作らない）
- header 検証（`:178-187`）は §3.1.1 の表のとおり 11 判定へ分解して 9 コードへ畳む。**判定式そのものは変えない**（真になる入力集合を変えない）
- `restored: false` を含む `state` の中身は現状のまま。`kind: "active"` は既存の返却値をそのまま包むだけ

`WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_TARGET` の検査（`:254`）は group ループ・target ループの内側にあるので、`samplePath` に group key と target key を載せられる。`:236` は group key、`:223` と `:277` は subject key だけ。

### 3.2 store 側を `switch` で網羅する

`standby-state-store.ts:831-850` を書き換える。

```text
let result: Vpwp50ForecastProjectionResult;
try {
  result = reduceWeatherWarningForecast(...);           // :834-841 と同じ引数
} catch (error) {
  result = { kind: "rejected", reason: { code: "reducerThrew", detail: <§3.3 の bounded 文字列> } };
}
switch (result.kind) {
  case "active":  break;                                 // :851 以降へ落ちる（現状どおり）
  case "empty":   → 既存 projection を delete、log.info で 1 行、同じ DisplayMutation を返す
  case "rejected" → 既存 projection を delete、log.warn で 1 行、同じ DisplayMutation を返す
}
```

- **`delete` と戻り値は 3 経路とも現状と完全に同じ**。`const changed = this.weatherWarningForecasts.delete(subjectKey)` を行い、`changed ? { viewChanged: true, durableChanged: true } : NO_MUTATION` を返す（`:847-849` と同一）
- `switch` は判別共用体を網羅する。`default` に `never` 代入を置いて、将来 `kind` が増えたときにコンパイルエラーにする（`CLAUDE.md` の type-system-discipline「判別共用体は `switch` で網羅する」）
- `reducerThrew` は §3.1 の `Vpwp50ForecastRejectReason` に含まれる variant なので、store は型注釈だけで組み立てられる。**`as` によるキャストを使わない**

ログ行の形は次にする（`vpwp50ProjectionCapacityExceeded` は既存名の再利用）。

| 結果 | level | 出力 |
|---|---|---|
| `empty` | `log.info`（§6 分岐 2-C・裁定済み） | `[VPWP50] vpwp50ProjectionEmpty subject=<128 切り> reason=noActivePeriods revision=<JSON> occurrences=<n> resolvedSlots=<n> expiredSlots=<n> existingProjectionDeleted=<bool>` |
| `rejected` / `capacityExceeded` | `log.warn` | `[VPWP50] vpwp50ProjectionCapacityExceeded <既存 :866-871 と同じ形の JSON>`（§3.4） |
| `rejected` / それ以外 | `log.warn` | `[VPWP50] vpwp50ProjectionRejected subject=<128 切り> reason=<code> revision=<JSON> existingProjectionDeleted=<bool>`（＋ `projectedOccurrenceIndex` / `scope` / 引用符で囲んだ `detail` があれば付す） |

`vpwp50ProjectionRejected` に **`reason=` が必ず付く**ようになるので、`:805` / `:828` / `:861` の既存 3 行と形式が揃い、「reason の無い行」は消える。これが実機で最初に見える変化になる。

### 3.3 例外の bounded な分類

`catch (error)` で受け、次だけを残す。

- `error instanceof Error ? error.name : typeof error`
- `error instanceof Error ? error.message : ""` を **制御文字（C0/C1）と行・段落区切りを空白へ畳んだうえで、`name` と連結した全体を先頭 120 文字へ切り詰め**たもの。ログへ出すときは `JSON.stringify` で引用符に包む（自由文が `key=value` の並びを騙らないようにする）

`error.stack` を出さない。`error` オブジェクトそのものを `JSON.stringify` しない。parsed payload・XML 本文・認証情報を出さない。切り詰め長は Issue の「boundedな分類情報」を満たす最小限として 120 を採る（§6 の分岐 3 で裁定）。

### 3.4 容量超過の診断を既存の形へ詰める

store は `capacityExceeded` を受けたとき、既存の `standby-state-store.ts:866-877` と**同じ JSON 形**を組み立てて `vpwp50ProjectionCapacityExceeded` として 1 回だけ warn する。

```ts
{
  subjectKey: subjectKey.slice(0, 128),
  candidateRevision: revision,
  existingProjectionDeleted: changed,
  reasons: [{
    origin: "reducer",           // ← 必須。card 由来と取り違えさせない（§6 分岐 1）
    code: reason.hierarchy,
    actual: reason.actual,
    declaredLimit: reason.declaredLimit,
    effectiveLimit: null,
    violatingUnitCount: 1,
    limitingHierarchies: [reason.hierarchy],
    samplePaths: [reason.samplePath],
  }],
}
```

**`origin: "reducer"` は省略できない。** `effectiveLimit: null` は既存の `weatherWarningForecastProjectionLimitReasons` では「`candidate = 0..declaredLimit` のどれで切り詰めても card 制約を満たせなかった」という**強い意味**を持つ（`weather-warning-forecast-wire.ts:304-307`——ループが 1 度も `effectiveLimit` を代入できなかった場合だけ `null` が残る）。この `null` は実際に既存の golden にも現れる（`test/engine/display/standby-state-store.test.ts:866` が `[null, null]` を固定）。reducer 由来の `null` は「探索していないので不明」であって、意味がほぼ正反対になる。

**ただし card 由来の reason 側に `origin: "card"` を足してはならない。** `Vpwp50ProjectionLimitReason` の形は golden fixture（`test/fixtures/vpwp50-forecast-expectations.json` の `groupShape129Reasons` / `twoTargets129Reasons` / `mixed129Reasons`。**2026-09-09 の上限引き上げで `groupShapeOverReasons` / `threeTargetsOverReasons` / `mixedOverReasons` へ改名し、shape も作り直した。`docs/specs/2026-09-09-vpwp50-periods-limit.md` §9.3**）と厳密一致アサーション（`standby-state-store.test.ts:893-900`）に固定されており、`weatherWarningForecastProjectionLimitReasons` の出力を変えることは §3.5 の禁止変更・A7 に反する。**reducer 由来の行にだけ `origin: "reducer"` が現れ、その欠如が card 由来を意味する**という非対称を採る。型としては reducer 由来の diagnostic を `Vpwp50ProjectionLimitReason & { origin: "reducer" }` 相当の別型として store 側に置き、wire の既存 export は触らない。

`docs/specs/2026-08-31-vpwp50-forecast-card.md:468-469` が要求する 6 項目（subject key・超過階層・actual・limit・candidate revision・既存 projection 削除有無）はこれで全部そろう。

**`weatherWarningForecastProjectionLimitReasons()` をこの経路から呼んではならない。** 理由は 2 つある。

1. reducer が返した `state` は存在しないので渡せる候補がない
2. その関数は `effectiveLimit` を求めるために `candidate = 0..declaredLimit` の 129 回ループを回し、各回で `truncateReasonUnits`（`weather-warning-forecast-wire.ts:231`）→ `canonicalStateCopy`（同 `:205`、全 state を `structuredClone`）→ `cardConstraintsPass`（同 `:198-203`、card 再構築＋JSON byte 計測）を通る（ループ本体は同 `:305-307`）。Issue の「ログを改善するために巨大な全状態複製や候補全探索を追加しない」に真っ向から反する

したがって reducer 由来の reason は `effectiveLimit: null` / `violatingUnitCount: 1` を名乗る。**この 2 フィールドの意味が card 由来の reason と異なる**ことは §6 の分岐 1 で明示的に裁定する。

### 3.5 不変に保つ契約（変えてはならないもの）

- 受理済み gate を rollback しない。`applyWeatherWarningForecast` は gate に触れない（`:794-888` に gate mutation は無い）
- empty・rejected の**どちらでも**同 subject の既存 projection を削除する。`docs/specs/2026-08-31-vpwp50-forecast-card.md:398-438` の通常処理規則 9（valid period がない新報は既存 active state を削除）と、同 `:440-475` の fail-closed 規則の両方が「削除する」で一致している。**empty を「削除しない」に変えてはならない**
- 他 subject の projection を変えない
- `DisplayMutation` の値（`viewChanged` / `durableChanged`）を現状から変えない
- gate-only watermark の保持、取消・永続化・再起動後の旧報復活防止
- `weatherWarningForecastProjectionLimitReasons` / `buildWeatherWarningForecastCard` / `assertWeatherWarningForecastWireInvariant` の挙動と**出力の形**（golden fixture `test/fixtures/vpwp50-forecast-expectations.json` と厳密一致アサーション `test/engine/display/standby-state-store.test.ts:893-900` に固定されている。`origin` フィールドを足さない）
- store `:856-879` の card 側容量経路
- **復元経路 `restoreActiveStateInternal`（`src/engine/display/standby-state-store.ts:3314`、`weatherWarningForecastProjectionLimitReasons` 呼び出しは `:3410`）**
- 永続化側の 2 経路——`standby-persistence.ts:3451`（claim 検証）と `normalizeVpwp50PersistenceBundles`（同 `:8899-8940`、呼び出しは `:8925`）。どちらも reducer を呼ばず `weatherWarningForecastProjectionLimitReasons` を直接使うので、本 spec の変更は届かない
- 件数上限・byte 上限の値（`weather-warning-forecast-wire.ts:10-17`）
- 永続ファイルの schema / envelope / migration

### 3.6 呼び出し元の追従（全 3 箇所）

`reduceWeatherWarningForecast` の呼び出しは実測でリポジトリ全体に 3 箇所しかない。

| file:line | 用途 | 追従 |
|---|---|---|
| `src/engine/display/standby-state-store.ts:834` | 唯一の製品コード呼び出し | §3.2 |
| `test/engine/display/standby-state-store.test.ts:762` | fixture reduce ヘルパ。`:772,773,774,789,791` で `null` 判定・`?.` を使う | `result.kind` 判定へ書き換え。`:791` の `toBeNull()` は `{ kind: "empty" }` の確認へ（この行は「全 slot 失効で表示対象なし」を確かめている＝まさに empty） |
| `test/engine/display/standby-persistence.test.ts:201` | 永続化 fixture 生成。`:209` で `runtime == null` を throw し、`:210` で `const { restored: _restored, ...projection } = runtime` と分割代入する | `:209` を `result.kind !== "active"` の throw へ。**`:210` の分割代入も `result.state` を受けるよう追従が要る**（`result` 自体を展開すると `kind` が projection に混ざる） |

### 3.7 docs 同期を grep で照合可能にする

「差分目視」は再実行できないので、**docs 側に固定文言を置いて grep で当てる**形にする。`docs/specs/2026-08-31-vpwp50-forecast-card.md` の §3.3（現行 `:440-475` の診断契約のすぐ後ろ）へ、次の 3 行を**この文字列のまま**追加する。

```text
reducer が候補を棄却した場合の診断は origin=reducer を名乗り、effectiveLimit は探索していないため null とする。
card 集計に到達した候補の診断は origin を持たず、既存の Vpwp50ProjectionLimitReason の形をそのまま使う。
表示対象 period が 0 件の新報は vpwp50ProjectionEmpty として記録し、vpwp50ProjectionRejected とは区別する。
```

照合はこの 1 本で行う。`grep -q` は一致で exit 0・不一致で exit 1 を返すので、`&&` 連鎖の終端に `echo GREEN` だけを置く（`grep -c` は 0 件で exit 1 になるため成功判定に使わない）。

```bash
set -o pipefail
D=docs/specs/2026-08-31-vpwp50-forecast-card.md \
  && grep -q 'origin=reducer を名乗り' "$D" \
  && grep -q 'origin を持たず' "$D" \
  && grep -q 'vpwp50ProjectionEmpty として記録し' "$D" \
  && grep -q 'vpwp50ProjectionEmpty' src/engine/display/standby-state-store.ts \
  && grep -q '"reducer"' src/engine/display/standby-state-store.ts \
  && echo GREEN
```

最後の 2 行は「docs に書いた識別子が実コードにも存在する」ことを見る。文言だけ更新してコードが追随していない（またはその逆の）状態を弾くのが目的で、**実装の正しさは §4 のテストが担う**。docs の文言を変えるときはこのチェーンの pattern も同じ commit で変える。

## 4. 検証

### 4.1 結果分類の表駆動テスト

§3.1.1 の header 11 判定＋occurrence 検証＋identity 衝突 3 種＋容量 4 階層＋empty＋例外を、それぞれ意図した入力で発火させ、`kind` と `reason.code` を固定する。**重要なのは「別の早期 reject で誤って合格しない」こと**（Issue の回帰テスト項目 2）——各ケースで時刻・identity・semantic key・publishing office をすべて正常にし、狙った 1 条件だけを崩す。

reducer は先頭から順に判定するので、後段の条件（容量）を試すケースでは前段（header・occurrence 検証・identity 衝突）が全部通ることを同じテストで確認する。

**header は 11 disjunct すべてに 1 ケースずつ置く。** とくに `:180` の `!Number.isFinite(new Date(revision.reportTimeMs).getTime())` は `:179` の safe integer 検査に吸収されないので、独立したケースを必ず作る——`revision.reportTimeMs = 9e15` は `Number.isSafeInteger` を通り（9e15 < 9007199254740991）、`new Date(9e15).getTime()` が `NaN`（ECMAScript の time value 上限 8.64e15 超）になる。このケースが `invalidReportTime` を返すことを固定する。`:179` 側は `revision.reportTimeMs = 1.5` など非整数で撃つ。

### 4.2 nested count の境界

`groupsPerSubject` / `targetsPerGroup` / `periodsPerTarget` / `periodsPerSubject` の 4 階層それぞれについて、**128 件で `kind: "active"`・129 件で `kind: "rejected"` かつ `hierarchy` が当該階層**であることを確認する。

**fixture は period 数の従属制約に縛られる。** 4 階層は独立に動かせないので、期待値を書く前に次を織り込む。

| 階層 | 129 件ケースの作り方 | 同時に破れる上限 | 実際に報告される code | 根拠 |
|---|---|---|---|---|
| `groupsPerSubject` | 129 group。各 group は最低 1 target・1 period を持つので**総 period も必ず 129 件**になり `:277` も破る | `periodsPerSubject` | `groupsPerSubject` | `:223` が output ループより前 |
| `targetsPerGroup` | 1 group に 129 target。同じ理由で総 period も 129 件 | `periodsPerSubject` | `targetsPerGroup` | `:236` が group ループ内、`:277` より前 |
| `periodsPerTarget` | 1 target に 129 period | `periodsPerSubject` | `periodsPerTarget` | `:254` が target ループ内、`:277` より前 |
| `periodsPerSubject` | 2 target × 65 period = 130。各 target は 128 以下なので `:254` を通る | なし | `periodsPerSubject` | 唯一 `:277` に到達できる形 |

- **「128 件で `active`」側も制約を受ける**。`groupsPerSubject` = 128 を `active` にするには総 period を 128 以下に収める必要があるので、**group あたり target 1 件・target あたり period ちょうど 1 件**にする。`targetsPerGroup` = 128 も同様
- 上の 3 階層は `periodsPerSubject` と必ず同時に破れるので、テストは「**先に当たる方だけが報告される**」ことを期待値として書く。`hierarchy` が `periodsPerSubject` になったら失敗とする
- 既存の fixture ヘルパ `forecastGroupShape`（`test/engine/display/standby-state-store.test.ts:462`）・`twoTarget129ForecastState`（`:647`）・`mixed129ForecastState`（`:657`）は（2026-09-09 の上限引き上げで後ろ 2 つは `threeTargetOverForecastState` / `mixedOverForecastState` へ改名。`forecastGroupShape` は group あたり period 数の引数が増えた） `WeatherWarningForecastState` を直接組み立てるもので reducer を通らない。本テストは **reducer の入力（`ParsedWeatherWarningTimeseriesInfo`）側**を作る必要があるので、新しいヘルパを作る
- `periodsPerAnchor` は §2.2 のとおり reducer 側で構造的に超えないため、このテストの対象外とする

### 4.3 正常 empty が warn にならない

Issue の回帰テスト項目 1。

- newer な正常報で表示対象 period が 0 件のとき、`kind: "empty"` になり、既存 projection が削除され、`viewChanged: true` / `durableChanged: true` が返る
- **`log.warn` がその処理中に 1 回も呼ばれない**（spy の呼び出し回数 0）
- `occurrences` / `resolvedSlots` / `expiredSlots` が §2.3 の 3 分類を区別できる値になっている（3 ケース：occurrence 0 件／全 slot 未解決／全 slot 失効）

### 4.4 例外経路

reducer が throw する入力（parser payload を壊す）で `kind: "rejected"` / `code: "reducerThrew"` になり、既存 projection が削除されること。ログ行に `stack` が含まれないこと、`detail` が引用符に包まれ、復号後の値が 120 文字以下で制御文字・行区切りを含まないことを文字列として確認する。message に `reason=` 風の並びを混ぜ、ログ側の `reason=` フィールドが 1 つだけであることも固定する。

### 4.5 挙動不変の確認

分類を足しても表示・永続の結果が変わっていないことを、経路ごとに直接固定する。

- 9 経路すべてで、既存 projection ありのとき削除されて `{ viewChanged: true, durableChanged: true }`、無いとき `NO_MUTATION`
- 同時に存在する**他 subject の projection が変わらない**
- gate（`telegramFoundation` 側）が変わらない
- `kind: "active"` のとき `:851-887` の受理経路（`old` との比較・`weatherWarningForecasts.set`）が現状どおり動く

### 4.6 card 側容量経路の非退行

subject 単体の count は収まるが card 全体の period 数または wire byte が超える候補で、既存の `vpwp50ProjectionCapacityExceeded` / `vpwp50ProjectionWireBudgetExceeded` が**既存の診断形のまま** 1 回ずつ記録され、fail-closed 動作（候補を受理しない・既存 projection を削除・他 subject を evict しない）が保たれること（Issue の回帰テスト項目 3）。

### 4.7 追加コストを入れていないことの確認

reducer 由来の `capacityExceeded` 経路で `weatherWarningForecastProjectionLimitReasons` が **0 回**呼ばれること（spy）。§3.4 の理由 2 を機械的に固定する。

受理経路（`kind: "active"`）で `escapePath` が **0 回**呼ばれること（spy）。どちらの spy にも「拒否経路では 1 回以上呼ばれる」positive control を併置し、spy が配線されていないための 0 と本物の不在を区別する。

`samplePath` が `escapePath` の規則を実際に適用していることは、`/` と `~` を含む subject key で固定する。期待値は `escapePath` で組み立て直さず literal で書き、card 側 `weatherWarningForecastProjectionLimitReasons` が同じ subject に対して返す `samplePaths` とも一致させる。

### 4.8 既存回帰

- `npm run build`
- `npm test`
- `npm run test:shuffle`
- `npm run typecheck:test`

`test:shuffle` は、本変更が module スコープの状態を持たない設計（§6 の分岐 2 で「集約カウンタを作らない」を採る前提）でも実行する。store は共有状態を持つため。

## 5. 受入条件

### 5.1 機械的に確認できるもの

| # | 条件 | 確認方法 |
|---|---|---|
| A1 | `reduceWeatherWarningForecast` の戻り値が判別共用体になり、store 側 `switch` に `never` 網羅チェックがある（`kind` を 1 つ増やすとコンパイルが落ちる） | 型検査＋実コード確認 |
| A2 | header 11 判定（`:180` の time value 上限ケース `reportTimeMs = 9e15` を独立ケースとして含む）＋occurrence 検証＋identity 衝突 3 種＋容量 4 階層＋empty＋例外のすべてで、期待どおりの `kind` と `reason.code` が返る | 4.1 |
| A3 | 4 階層すべてで 128 件 = `active` / 129 件 = `rejected`＋正しい `hierarchy`。129 件ケースが header・occurrence 検証・identity 衝突を通過し、かつ `hierarchy` が `periodsPerSubject` へ流れていない（§4.2 の従属制約表どおり先に当たる階層が報告される） | 4.2 |
| A3b | reducer 由来の容量 diagnostic に `origin: "reducer"` が付き、card 由来の reason には `origin` が付かない（既存 golden と厳密一致アサーションが無改変で通る） | 4.2 / 4.6 |
| A4 | 正常 empty の処理中に `log.warn` の呼び出しが 0 回。`occurrences` / `resolvedSlots` / `expiredSlots` が 3 分類を区別する | 4.3 |
| A5 | 例外経路が `reducerThrew` になり、ログに `stack` を含まず、引用符つき `detail` の復号値が 120 文字以下・制御文字なし | 4.4 |
| A6 | 9 経路すべてで `DisplayMutation` が変更前と同一（削除あり = `viewChanged`/`durableChanged` 双方 true、削除なし = `NO_MUTATION`）、他 subject 不変、gate 不変 | 4.5 |
| A7 | card 側の `vpwp50ProjectionCapacityExceeded` / `vpwp50ProjectionWireBudgetExceeded` が既存の診断形のまま 1 回ずつ出る | 4.6 |
| A8 | reducer 由来の容量拒否で `weatherWarningForecastProjectionLimitReasons` の呼び出しが 0 回 | 4.7 |
| A9 | `vpwp50ProjectionRejected` を出す全経路（`:805` / `:828` / `:861` ＋新経路）に `reason=` が付く。`reason` の無い warn 行が製品コードから消える | `grep -n "vpwp50ProjectionRejected" src/` の全ヒット目視＋テスト |
| A10 | `docs/specs/2026-08-31-vpwp50-forecast-card.md` §3.3 に §3.7 の固定文言 3 行が入っており、対応する識別子が実コードにも存在する | §3.7 の grep チェーン（GREEN 出力） |
| A11 | `npm run build` / `npm test` / `npm run test:shuffle` / `npm run typecheck:test` がすべて成功 | 実行ログ |
| A12 | `weatherWarningForecastProjectionLimitReasons` の他 3 呼び出し元（`standby-state-store.ts:3410` / `standby-persistence.ts:3451` / 同 `:8925`）の diff が空 | `git diff` 目視 |
| A13 | store 側に `as` によるキャストを追加していない（`reducerThrew` を型注釈だけで組み立てている） | 差分目視 |

### 5.2 実機で確認するもの（配送後・CI 対象外）

| # | 条件 | 測定 |
|---|---|---|
| B1 | Pi の通常稼働（既定 log level = `INFO`）で、VPWP50 の平常な報に対し `vpwp50ProjectionEmpty` の **info 行が出て**、`vpwp50ProjectionRejected` の **warn 行が出ない** | Pi のログ観測 |
| B2 | 実際に拒否が起きたとき、行が `reason=` を名乗り、容量超過なら階層・actual・limit が読める | 実発表待ち。**待機項目**で、配送の前提条件にしない |

**B1 は §6 の分岐 2-C（`log.info`・裁定済み）に立っている。** 既定 log level は `INFO`（`src/logger.ts:10`）なので、empty 行が通常稼働の Pi ログにそのまま現れ、「empty が起きたのか、そもそも VPWP50 が来ていないのか」を切り分けられる。

### 5.3 スコープ外（本 spec では触らない・別 spec）

- **件数上限・byte 上限の変更**、候補の切り詰め、部分受理、他 subject の evict（Issue が明示的に禁じている）
- **表示挙動の変更**。empty のときに何かを画面へ出す、拒否をカードにする、`RestoredChip` を出す等
- **電文受理・gate 判定の変更**。admission、subject 512 件上限、watermark
- **永続化の変更**。schema・migration・`normalizeVpwp50PersistenceBundles`
- **集約カウンタ／統計画面への露出**（§6 の分岐 2 で B を採った場合のみ対象になる）
- **実機の当該 revision の原因確定**（Issue 項目 6）。元 XML または安全な再現 fixture と投影時の `nowMs` の採取が要る実機作業。時刻依存なので現在時刻だけで再生して「全 period 失効」と結論しない。認証情報を公開 Issue へ貼らない
- #13 の周期停止、#15 のブラウザ再計測

## 6. 判断分岐

### 分岐 1: reducer 由来の容量診断をどう作るか

- **A（推奨）: 検出点で分かる 1 件だけを返し、`origin: "reducer"` / `effectiveLimit: null` / `violatingUnitCount: 1` を名乗る（§3.4）。** 追加の走査・複製をしない。Issue の「既に判明した件数・理由を返す構造を優先する」に一致し、`weatherWarningForecastProjectionLimitReasons` の 129 回ループ（`weather-warning-forecast-wire.ts:305-307`）を持ち込まない。代償として card 由来の reason と意味が食い違うので、**`origin: "reducer"` を必須フィールドとする**（§3.4。「例」ではなく要件）。食い違いは 3 点ある

  | フィールド | card 由来 | reducer 由来 |
  |---|---|---|
  | `effectiveLimit` | `null` = 切り詰めても救えない | `null` = 探索していない |
  | `violatingUnitCount` | 違反ユニットの実数 | 常に 1（early return のため） |
  | `actual` | 違反ユニット中の最大値 | 最初に検出した違反値 |

  **`actual` の母集団についての注記**: `:223` の `groups.size` と `:236` の `targets.size` は「空 target / 空 group を落とす前」の集約 Map の件数で、card 側 `countUnits`（同 `:175-195`）が数える `state.groups.length` は落とした後の件数である。**現状の実装ではこの 2 つは必ず一致する**——`mergePeriods`（reducer `:82-103`）は非空入力に必ず 1 件以上返すので、entries を持つ target は必ず `periods.length > 0` になって `:260` で push され、target を持つ group は必ず `:272` で push されるため、空 target / 空 group は発生しない。したがって現時点で乖離は観測されないが、**この一致は偶然ではなく上記の連鎖に依存している**。将来 period のフィルタが増えて空 target が生じうるようになったら、reducer 由来の `actual` は card 側より大きく出る。実装時にこの根拠をコメントで残す
- **B: reducer が early return をやめ、全階層の違反を数え上げてから返す。** `violatingUnitCount` と `actual` の意味が card 側とそろう。ただし `:223` の group 数超過を検出した後も target / period の構築を続けることになり、病的入力での作業量が増える。上限を超えた入力に対してわざと余分に働く形になるので推奨しない

### 分岐 2: 正常 empty の運用記録をどこに出すか

**この分岐は独立レビューで推奨が A から C へ差し替わり、2026-09-08 にご主人が C で確定した。** §3.2 の表と §5.2 の B1 は C を前提に書いてある。

- **C（確定）: `log.info` の 1 行だけ（§3.2）。** Issue の不満は「1 行から原因が分からない」——**情報の不足であって行数の過多ではない**。既定 level が `INFO`（`src/logger.ts:10`）なので、C なら empty の行が通常稼働の Pi ログに出て、§5.2 の B1 が「info 行が出て warn 行が出ない」という**観測可能な条件**になる。新しい状態を持たない点は A と同じで、`log.info`（同 `:47-53`）を使うだけ。warn から info への降格でも「異常ではない」という Issue の要求は満たせる
- **A（退避先）: `log.debug` の 1 行だけ。** 既定 level では**完全に見えなくなる**（`log.debug` は `currentLevel <= LogLevel.DEBUG` のときだけ出力され、`DEBUG` へ落ちるのは `opts.debug` が真のときだけ——`src/logger.ts:39-45`、`src/engine/cli/cli-run.ts:51-53`）。その結果 B1 で empty の存在を確認できず、F7 と同じ観測不能問題を持ち込む。**Pi のログ量が実際に問題になった場合の退避先**として残す
- **B: 集約カウンタ（一定間隔で件数をまとめて出す）を足す。** 頻度が分かるが、module スコープまたは store フィールドの新規状態が増え、永続化・shuffle テスト・REPL 表示との整合が芋づるで付いてくる。**本 spec の「診断のみ」の枠を超える**ので、A を採り、必要になったら別 spec にする

### 分岐 3: 例外の `detail` に何を載せるか

- **A: `error.name`（または `typeof error`）だけ。** 漏洩リスクが最小。ただし実運用では `Error` としか出ず、切り分けにほぼ役立たない
- **B（推奨）: `name` ＋ `message` を制御文字畳み込み・120 文字切り詰め・引用符包みで載せる（§3.3）。** リポジトリ内の throw は静的文字列が中心（`standby-state-store.ts:903` `"invalid VPTA state subject"`、`:926` `"VPTA reducer binding mismatch"`、`:939` `"VPTA active reducer invariant failed"`、`:942` `"VPTA projection capacity exceeded"`）なので payload 混入の実危険は低い。`stack` は出さない
- **C: `stack` も載せる。** 採らない。行数・パス・場合によっては変数内容が混ざる

### 分岐 4: 既存シグネチャを残すか

- **A（推奨）: `reduceWeatherWarningForecast` の戻り値そのものを共用体へ変える。** 呼び出しは実測 3 箇所（製品 1・テスト 2、§3.6）だけなので追従は小さい。CLAUDE.md の subtract-before-you-add に沿って、経路を 1 本に保つ
- **B: 既存の `| null` シグネチャを残し、診断つきの別関数を並置する。** 呼び出し元の変更が要らないが、**同じ判定ロジックが 2 本になり、片方だけ直る事故が構造的に可能になる**。採らない

### 分岐 5: header 検証（`:178-187`）を何コードに分けるか

- **A（推奨・レビュー同意）: 11 disjunct を分解して 9 コードにする（§3.1.1）。** 判定式は既にすべて独立した boolean なので、順序を保って分解するだけでコストがない。実機で reason を見た瞬間に「電文が変か・こちらの正規化が変か」が切り分けられる。**subject は `invalidSubjectKey`（正規化・長さが壊れている＝こちら側の生成が疑わしい）と `invalidSubjectPrefix`（`weatherTimeseries:` で始まらない subject が VPWP50 の reducer へ来た＝routing が疑わしい）の 2 コードに分ける**——次に見る場所が違うため。これが「8 コード」ではなく「9 コード」になる理由で、レビューもここに同意している
- **B: `invalidHeader` の 1 コードにまとめる。** diff は小さいが、いま起きている「1 行から原因が分からない」問題を header 内部にそのまま残す

---

## 裁定ラベル案（6 要素）

```
対象:
  src/engine/display/weather-warning-forecast-active-reducer.ts
  src/engine/display/standby-state-store.ts（applyWeatherWarningForecast :794-888 のみ）
  src/engine/display/weather-warning-forecast-wire.ts（escapePath の export のみ）
  test/engine/display/standby-state-store.test.ts
  test/engine/display/standby-persistence.test.ts（呼び出し追従のみ）
  test/ 配下の新規テスト
  docs/specs/2026-08-31-vpwp50-forecast-card.md（§3.3 へ §3.7 の固定文言 3 行を追加）
  docs/specs/2026-09-08-vpwp50-reducer-diagnostics.md（本 spec）

許容変更:
  reduceWeatherWarningForecast の戻り値を判別共用体へ置換
  header 検証の複合条件を、判定式を変えずに 11 の独立判定へ分解し 9 コードへ畳む
  容量超過の検出点で hierarchy / actual / declaredLimit / samplePath を返す
  store 側を kind の switch（never 網羅）へ置換
  正常 empty を log.info（分岐 2-C・裁定済み）、拒否を log.warn へ振り分け
  例外を bounded な分類情報つきで記録
  上記を検証するテストの追加と、呼び出し元 3 箇所の追従

禁止変更:
  weather-warning-forecast-wire.ts:10-17 の件数上限・byte 上限の値
  weatherWarningForecastProjectionLimitReasons / buildWeatherWarningForecastCard /
    assertWeatherWarningForecastWireInvariant の挙動と出力の形
    （card 由来 reason に origin を足さない。golden fixture と厳密一致
     アサーションが無改変で通ること）
  standby-state-store.ts:851-887 の受理経路と :856-879 の card 側容量経路
  復元経路 restoreActiveStateInternal（standby-state-store.ts:3314、呼び出し :3410）
  standby-persistence.ts:3451 の claim 検証
  各経路の DisplayMutation の値（viewChanged / durableChanged）
  empty・拒否時の「同 subject の既存 projection を削除する」挙動
  gate 判定・admission・subject 512 件上限・gate-only watermark
  standby-persistence.ts の VPWP50 復元経路（normalizeVpwp50PersistenceBundles ほか）
  永続ファイルの schema / envelope / migration
  表示側（display/・ui/）のファイル
  集約カウンタ・統計画面・REPL への露出（分岐 2-B を採らない限り）
  package.json / package-lock.json
  data/runtime/ 配下の実データ
  実電文由来の XML のリポジトリへの追加

配送先: main → personal → Pi
  main へ push 後、GitHub Actions（Test workflow）の緑を配送条件に含める

ロールバック:
  main は該当 commit を git revert、personal は rebase 追従後に
  git push --force-with-lease private personal、Pi は
  git fetch origin personal && git reset --hard origin/personal で戻す

受入条件: §5.1 の A1〜A13 を全件。§5.2 の B1 は配送後の Pi ログ観測で確認する
  （分岐 2-C 確定。info 行が出て warn 行が出ないこと）。
  B2 は実発表待ちの待機項目で、配送の前提条件にしない。

裁定: 2026-09-08 ご主人裁定済み（分岐 1=A / 2=C / 3=B / 4=A / 5=A）。🌙自走OK。
```

---

## 改訂履歴

- **2026-09-08 初版**（Liebe 起草、HEAD `f8e2c688`）
- **2026-09-08 分岐判定の反映**: 分岐 2 に **C 案（`log.info` 1 行）を追加して推奨を A から差し替え**、A は「Pi のログ量が問題になった場合の退避先」として残した（Issue の不満は情報不足であって行数過多ではない／既定 level が `INFO` なので A では B1 が観測不能になる）。§3.2 の表と §5.2 の B1 は C 前提で書いた。B1 を「`vpwp50ProjectionEmpty` の info 行が出て `vpwp50ProjectionRejected` の warn 行が出ない」へ書き直し、任意項目だった B3 は B1 に吸収して削除。分岐 5 の見出しと本文を 9 コード（subject 2 分割）へ更新。A10 を「差分目視」から §3.7 の固定文言＋`grep -q` チェーン（終端 `echo GREEN`）へ機械化
- **2026-09-08 独立レビュー反映（F1〜F10）**: header disjunct を 8→**11**（`:180` の time value 上限が `:179` に吸収されない独立条件であることを含む）へ訂正し §3.1.1 の畳み込み表を新設（F1・F2）。`origin: "reducer"` を「例」から必須要件へ格上げし、card 側 golden を壊さない非対称を明記（F3）。empty の `resolvedSlots` が新規 O(n) 走査であることと算出位置を明文化（F4）。§4.2 に period 数の従属制約表を追加（F5）。`reducerThrew` を §3.1 の共用体に明示（F6）。B1 を warn の不在のみに絞り、debug 行が既定 level で観測不能であることを明記して B3 を任意へ分離（F7）。`weatherWarningForecastProjectionLimitReasons` の呼び出し元 4 箇所を列挙し、残り 3 つを禁止変更へ（F8）。行番号訂正（F9）。`actual` の母集団差を分岐 1-A の注記へ（F10、ただし現状の実装では乖離が発生しない旨を根拠つきで併記）
- **2026-09-08 ご主人裁定 C 確定**: 分岐 2 を **C（正常 empty は `log.info` 1 行）**で確定し、分岐 1・3・4・5 も推奨どおり確定した。裁定待ち表記と分岐 2-A への差し戻し注記を整理し、裁定ラベルへ `🌙自走OK` を追記した
- **2026-09-08 独立レビュー反映（配送前 fix 5 件・すべて Low）**: `samplePath` の組み立てを拒否分岐の内側へ移し受理経路のコストをゼロにした（§3.1）／`occurrenceIndex` を `projectedOccurrenceIndex` へ改名し、値が `projected` の添字であって元電文の occurrence 番号ではないことを明示（§3.1・§3.2）／例外 `detail` の畳み込みを C0/C1 制御文字と行・段落区切りへ広げた（§3.3）／`detail` を `JSON.stringify` で引用符に包み `key=value` の偽装を封じた（§3.2・§3.3）／`escapePath` の実効果を `/` と `~` を含む subject で固定し、card 側 `samplePaths` との一致も検証（§4.7）
