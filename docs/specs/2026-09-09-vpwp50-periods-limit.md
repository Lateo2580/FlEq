# VPWP50 `periodsPerSubject` 上限引き上げ spec（実機容量超過・Issue #16 の後続）

> **裁定状態**: **裁定済み（2026-09-09、ご主人 8-A）**。分岐 1 = A（256 period / 128KiB）、分岐 2 = B（reducer と wire を同時）、分岐 3 = A（`MAX_SNAPSHOT_BYTES` は触らない）、分岐 4 = A（回転設計は別 spec へ起票）。実装は §9 のとおり完了。

> **前提 spec**: `docs/specs/2026-09-09-vpwp50-limit-search-binary.md`（`effectiveLimit` 探索の二分探索化）の**配送後**に着手する。理由は §4.2。本 spec は同 spec がテスト用に export する `cardConstraintsPass` / `truncateReasonUnits` にも依存する。

> **基準 SHA**: `fb67852238b8b9db0b91a0b3365a4dd841207c4a`（worktree `~/dev/fleq-layout`、branch main）。以下の file:line はすべてこの SHA のもの。`git status --porcelain` は `?? display/tmp-capture/` のみ（追跡ファイルに変更なし）。

> **計測環境**: 数値はすべて `dist/`（`b98caed` ビルド、`fb67852` との差は CI 設定のみで `src/` は同一）へ直接 require する probe を darwin 上で実走して採った。probe は scratchpad に置き、repo には入れていない。Pi 実機での再計測は未実施（§5.2）。

---

## 1. 症状

2026-09-08 20:26、Pi 実機で名古屋地方気象台の VPWP50（20:23 発表）が表示対象から外れた。Issue #16 で入れた reducer 由来診断が理由を出した。

```text
[VPWP50] vpwp50ProjectionCapacityExceeded {"subjectKey":"...","candidateRevision":{...},
  "existingProjectionDeleted":false,
  "reasons":[{"origin":"reducer","code":"periodsPerSubject","actual":194,"declaredLimit":128,...}]}
```

`actual: 194` に対し `declaredLimit: 128`。判定点は `src/engine/display/weather-warning-forecast-active-reducer.ts:390-398`。

```ts
if (all.length > WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT) {
  return rejected({ code: "capacityExceeded", hierarchy: "periodsPerSubject", ... });
}
```

`existingProjectionDeleted: false` なので、消えたのではなく最初から出なかった。仕様どおりの fail-closed であって不具合ではないが、**実在する規模の電文が表示不能である**ことが判明した。

---

## 2. 現状の値と、その出典

### 2.1 定数の定義位置

`src/engine/display/weather-warning-forecast-wire.ts:10-17`

| 定数 | 現在値 | 行 |
|---|---|---|
| `WEATHER_WARNING_FORECAST_MAX_SUBJECTS` | 512 | `:10` |
| `WEATHER_WARNING_FORECAST_MAX_GROUPS_PER_SUBJECT` | 128 | `:11` |
| `WEATHER_WARNING_FORECAST_MAX_TARGETS_PER_GROUP` | 128 | `:12` |
| `WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_TARGET` | 128 | `:13` |
| `WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT` | 128 | `:14` |
| `WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_CARD` | 128 | `:15` |
| `WEATHER_WARNING_FORECAST_PERIODS_PER_ATOM` | 4 | `:16` |
| `WEATHER_WARNING_FORECAST_MAX_CARD_JSON_BYTES` | 65,536 | `:17` |

### 2.2 128 の出典（`git log -S` で確定）

`WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT` を導入した commit は 2 件だけである。

```
1649775 feat(display): VPWP50 reducer の結果を active / empty / rejected(reason) に分類して診断に出す (#16)
3c19768 feat(display): 気象警報の危険度予測(VPWP50)を待機画面カードへ統合する
```

`1649775` は import を足しただけで値を触っていない。導入は `3c19768`（2026-08-31 spec の実装）。commit message は「容量 preflight(128 period + 64KiB AND)」と書いている。

当時の根拠は `docs/specs/2026-08-31-vpwp50-forecast-card.md` にある。`:1085`

> `WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT` は従来案の 16,384 から 128 へ引き下げる。`WEATHER_WARNING_FORECAST_MAX_TARGETS_PER_GROUP` も、nonempty target が最低一件の period を消費する canonical invariant に合わせ、512 から 128 へ引き下げる。

card の wire invariant は `:821-829`。**引用は途中を飛ばさずに全文を出す**。

> - 全 active subject を横断した period 総数は 128 件以下。
> - canonical card item の UTF-8 JSON byte 数は 64KiB 以下。
> - count と byte の両方を満たす場合だけ wire-valid とする。
> - 128 period であっても 64KiB を超える組合せは wire-invalid とする。
> - 64KiB 以内でも 129 period は wire-invalid とする。
> - gate-only watermark / tombstone は card item へ入らないため period / card byte 集計対象外とする。
> - `MAX_SNAPSHOT_BYTES` は既存の 256KiB を維持する。
> - **64KiB は snapshot 上限の 4 分の 1 とし**、既存の他 card、snapshot envelope、SSE framing 用の headroom を確保する。

つまり **128 は byte 予算から逆算された値**である。当時の見積もりが実測と合っているかを §2.3 で確かめる。

なお「切り詰め、部分受理、他 subject eviction で救済してはならない」の契約は上の引用ブロックではなく **`:444`**（§3.3 の projection failure 節）にある。

### 2.3 128 は byte 予算と実際に噛み合っている（実測）

`81_09_01_260605_VPWP50.xml`（長野地方気象台、Pi 実機 2026-06-05 受信）の active projection を種にして target を複製し、period 数だけを変えた canonical card の UTF-8 JSON byte 数を実測した。scope 別に 2 系統を採った（理由は §2.4）。

| period 数 | area scope の bytes | local scope の bytes | local が 64KiB に占める割合 |
|---|---|---|---|
| 128 | 58,470 | 60,656 | 92.6% |
| **194（実機実測値）** | **88,368** | **91,676** | **139.9%** |
| 256 | 116,454 | 120,816 | 184.4% |
| 277 | 125,967 | 130,686 | 199.4% |
| 300 | 136,386 | 141,496 | 215.9% |

限界コストは area scope で 453 byte/period、**local scope で 474.6 byte/period**。64KiB を local scope の限界コストで割ると 138 period 相当なので、**宣言上限 128 と byte 上限 64KiB はほぼ同じ地点で効く**。2026-08-31 spec `:1113` の「64KiB byte 上限が count 上限より先に到達する場合は、byte 上限を実効上限とする」は、この設計を意図したものと読める。

**この事実が本 spec の中心にある**。`periodsPerSubject` だけを 256 に上げても、194 period の card は 88,368〜91,676 byte で `cardJsonBytes`（65,536）に落ちる。reducer を通っても `standby-state-store.ts:932-947` の card 検査で **切り詰めではなく fail-closed** になり、表示されないことは変わらない。診断のコードが `periodsPerSubject` から `cardJsonBytes` へ変わるだけである。

### 2.4 byte の主成分は名前ではなく派生キー（H5）

1 period が消費する byte の内訳を実測すると、可変長の地名より**固定長の派生キー**が支配的である。

- `VPWP50_DERIVED_KEY_LENGTH = 43`（`weather-warning-forecast-wire.ts:43`）。base64url の SHA-256 ダイジェストで、地名の長さに関係なく常に 43 文字
- 1 period につき 3 本乗る: `target.key`、`period.key`、`period.pagerAnchorKey`
- 43 × 3 = 129 文字。JSON のクォートとフィールド名を含めると 1 period の 453〜475 byte のうち **200 byte 前後が派生キー**である

したがって「市町村名が長い地域では byte が跳ねる」という直感は主成分を外している。**実際に効くのは scope である**。local scope の target は `localCode` を持ち `name` と `parentAreaName` の両方を載せるため、area scope より 1 period あたり 21.6 byte 重い。

**local scope の 256 period card は 120,816 byte で、128KiB の 92.2% を占める。** 128KiB の byte 上限が count 上限（256）より先に効き始めるのは **277 period**（130,686 byte、131,072 の 99.7%）なので、**count 256 に対する byte 側の余裕は 8%** しかない。

§5.1 の A5（AND の両方向試験）はこの狭さのために重要度が高い。

---

## 3. 194 の内訳（実測と推定）

### 3.1 period が増える仕組み

`projectForecastOccurrences()`（`src/engine/presentation/weather-severity-pyramid.ts:127-158`）は、`partKind === "Significancy"` の kind だけを occurrence 化する。

```
occurrence 数 = Σ(area) Σ(tsNum 1..3) Σ(危険度 kind) (base occurrence + local occurrence)
```

このうち `vpwp50ForecastLabel()` が `null` を返すもの（`below` / `none` 相当の平常値）は落ちる（`:137-138`）。残った occurrence を reducer が group（現象 × significancy code × label × severity）と target（area / local）で畳み、partition ごとに時間帯を merge して period にする（`weather-warning-forecast-active-reducer.ts:334-347`）。

```
periodsPerSubject ≒ (警報級以上の予測が立つ area 数) × (立つ現象 × 階級の種類数) × (非連続な時間帯の数)
```

### 3.2 リポジトリの実 fixture の実測

`test/fixtures/` の VPWP50 fixture 12 件を reducer に通した（`nowMs` は最も早い slot 終了の 1 分前に置き、期限切れ落ちをゼロにした）。

| fixture | 官署 | area 数 | 危険度 kind 種類 | occurrence | group | 最大 target/group | periodsPerSubject | card bytes |
|---|---|---|---|---|---|---|---|---|
| `81_01_01_260129`（宗谷 #1） | 稚内 | 10 | 15 | 0 | — | — | 0（empty） | — |
| `81_01_02_260129`（宗谷 #2） | 稚内 | 10 | 15 | 0 | — | — | 0（empty） | — |
| `81_01_03_260129`（宗谷 #3） | 稚内 | 10 | 15 | 0 | — | — | 0（empty） | — |
| `81_01_04_251222`（宗谷 #4） | 稚内 | 10 | 15 | 0 | — | — | 0（empty） | — |
| `81_09_01_260605`（長野・実機受信） | 長野 | **81** | 13 | 22 | 1 | 11 | **11** | 5,488 |
| `81_02_01_260605_high_severity` | 稚内 | 1 | 2 | 6 | 5 | 1 | 5 | 3,750 |
| `81_06_01_260605_criteria_period` | 稚内 | 1 | 2 | 8 | 6 | 2 | 7 | 4,943 |
| `81_09_01_260605_local_identity` | 長野 | 3 | 5 | 13 | 9 | 2 | 10 | 6,951 |

**リポジトリの実 fixture はすべて平常時の電文で、最大でも 11 period しかない。** 194 の再現には合成 fixture が要る（§5.1 A1）。

宗谷 4 件が 0 occurrence なのは、10 area × 15 kind すべてが平常値（`vpwp50ForecastLabel` が `null`）だったためで、パーサの取りこぼしではない。同じ fixture で `areasWithSignificancy` は 10/10 である。

### 3.3 194 の内訳の推定（**推測**、実 XML は未取得）

名古屋地方気象台の 2026-08-30 20:23 の電文そのものは採っていない。以下は **推測**である。

- 名古屋地方気象台の VPWP50 対象は愛知県。市町村等の発表区域は 54 前後
- 実機診断は `periodsPerSubject` で落ちた。reducer は `targetsPerGroup`（`:322`）を **先に** 検査するので、**どの group も target 128 件以下だった**ことは確定している
- 194 ÷ 54 ≒ 3.6。「4 種前後の（現象 × 階級）が県内のほぼ全域に立ち、一部の区域で時間帯が 2 つに割れた」という形が最も素直に 194 を説明する。8/30 は大雨で、土砂災害危険度・大雨浸水危険度・雷危険度・風危険度が同時に立つ状況と整合する
- period は 1 target あたり 1〜2 件と推定する（実 fixture の `maxPeriodsPerTarget` はすべて 1〜2）。`periodsPerTarget`（128）と `periodsPerAnchor`（4）は当分効かない

### 3.4 全国で最大になりうる規模（**推測**）

subject key は `weatherTimeseries:{官署}:{対象地域}`（`src/engine/messages/revision-family-registry.ts:384-390`）なので、1 subject の守備範囲は 1 官署である。

- 実測で最大の area 数は長野地方気象台の **81**。北海道は 8 官署に分かれるため 1 官署あたりはこれより小さい（稚内は実測 10）
- 危険度 kind の種類は実測で最大 15（稚内）。ただし全種が同時に警報級になることはない
- **現実的な最悪**: 81 area × 4〜5 種 × 1〜1.5 時間帯 ＝ **324〜600 period**
- **理論上の最悪**: 81 area × 15 種 × 2 階級 ＝ 2,430 period。この規模の電文は観測されていない

**推測の限界を明示する**: 「4〜5 種」は 8/30 名古屋の 194 からの逆算であって、全国の統計ではない。検証は §5.2 B3（実発表待ち）に置く。

### 3.5 `weatherTimeseries:気象庁:scope:all` は据え置き判断の反例になりうる（L4）

Issue #16 の元スクリーンショットの subject は `weatherTimeseries:気象庁:scope:all` だった。`publishingOffice` が気象庁で `targetArea` が無い場合に生成される key である（`revision-family-registry.ts:387-389`）。

§4.1 で `targetsPerGroup`（128）を据え置く根拠は「1 官署の守備範囲は最大 81 area」だが、**この subject は 1 官署の守備範囲という前提が成り立たない**。全国規模の area を含む電文なら 1 group が 128 target を超えうる。

- 8/30 名古屋の診断は `periodsPerSubject` だったので、**今回の事例には当たらない**
- しかし据え置きの根拠に反例が存在することは隠さない
- **§5.2 B2 で `targetsPerGroup` 由来の拒否が観測されたら、分岐 2 を開き直す**（`targetsPerGroup` も引き上げ対象に含めるかを再裁定する）

---

## 4. 変更

### 4.0 Phase 0 申告（実装着手前の成果物）

1. 読んだ規範: 本 spec、`docs/specs/2026-09-09-vpwp50-limit-search-binary.md`（前提 spec）、`docs/specs/2026-08-31-vpwp50-forecast-card.md` §3.3 / §3.6 / §3.9、`docs/specs/2026-09-08-vpwp50-reducer-diagnostics.md` §3.5
2. 触る定数と行: `weather-warning-forecast-wire.ts:14` / `:15` / `:17`
3. 触らないと宣言する定数と行: 同 `:10` / `:11` / `:12` / `:13` / `:16`、`constants.ts:9`（`MAX_SNAPSHOT_BYTES`）、`constants.ts:19`
4. 前提 spec が配送済みで、`cardConstraintsPass` / `truncateReasonUnits` が export 済みであること
5. `git rev-parse HEAD` が base_oid と一致すること、`git status --porcelain` が空であること

### 4.1 定数の引き上げ（分岐 1・分岐 2 の裁定待ち／推奨値）

`src/engine/display/weather-warning-forecast-wire.ts`

```ts
export const WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT = 256;    // :14  128 → 256
export const WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_CARD = 256;       // :15  128 → 256
export const WEATHER_WARNING_FORECAST_MAX_CARD_JSON_BYTES = 128 * 1024; // :17  64KiB → 128KiB
```

**3 つを同時に上げる**。1 つでも据え置くとその階層が新しい壁になり、194 は表示されない（§2.3）。

据え置く定数と理由は次のとおり。

| 定数 | 据え置き | 理由 |
|---|---|---|
| `MAX_SUBJECTS`（512） | 据え置き | 今回の超過と無関係。gate 側の別契約 |
| `MAX_GROUPS_PER_SUBJECT`（128） | 据え置き | 実測最大は 9。危険度 kind は 15 種、階級は 3 段なので理論上も 45 前後 |
| `MAX_TARGETS_PER_GROUP`（128） | 据え置き | 実測最大の area 数は 81（長野）。**ただし §3.5 の反例がある。B2 の観測次第で分岐 2 を開き直す** |
| `MAX_PERIODS_PER_TARGET`（128） | 据え置き | 実測最大は 2 |
| `PERIODS_PER_ATOM`（4） | 据え置き | pager atom の見た目そのもの。触ると表示仕様が変わる |
| `MAX_SNAPSHOT_BYTES`（256KiB、`constants.ts:9`） | **据え置き** | SSE 1 メッセージの壁。分岐 3 で扱う |
| `STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE`（16MiB、`constants.ts:19`） | 据え置き | §4.4 のとおり余裕がある |

### 4.2 `effectiveLimit` 探索は前提 spec で済ませる

上限を上げると `weatherWarningForecastProjectionLimitReasons()`（`weather-warning-forecast-wire.ts:302-308`）の線形探索が `declaredLimit` に比例して重くなる。**この修正は本 spec には含めない**。

`docs/specs/2026-09-09-vpwp50-limit-search-binary.md` を**先に単独で配送する**。理由は 2 つある。

1. **前提 spec は本 spec なしでも価値がある**。実測で 90〜123 ms のコストは、現行の 128 のままでも横断集計（`periodsPerCard`）が超えていれば毎回払っている。上限引き上げの裁定を待つ理由がない
2. **前提 spec は製品緩和を含まない**ので 🌙自走OK 候補にできる。本 spec と束ねると裁定待ちに巻き込まれる

本 spec が着手できるのは前提 spec の配送後である。§5.1 のテストは前提 spec がテスト用に export する `cardConstraintsPass` / `truncateReasonUnits` を使う。

### 4.3 変更しない契約

- 超過時の扱いは **fail-closed のまま**。切り詰め・部分受理・他 subject の eviction による救済を入れない（2026-08-31 spec **`:444`**）
- `Vpwp50ProjectionLimitReason` の形（`code` / `actual` / `declaredLimit` / `effectiveLimit` / `violatingUnitCount` / `limitingHierarchies` / `samplePaths`）と `origin: "reducer"` の非対称（`docs/specs/2026-09-08-vpwp50-reducer-diagnostics.md` §3.4）
- `REASON_ORDER` と `isAncestorReason()` の階層関係
- reducer の判定順序（`groupsPerSubject` → `targetsPerGroup` → `periodsPerTarget` → `periodsPerSubject`）
- `degradeSnapshotToBudget()`（`http-server.ts:572`）に VPWP50 の救済を委ねない（2026-08-31 spec `:829`）
- 永続 schema・envelope・migration。定数は上限なので、引き上げは既存ファイルの受理範囲を広げるだけで、**移行は不要**

### 4.4 波及箇所（全列挙）

| file:line | 経路 | 引き上げの効果 |
|---|---|---|
| `weather-warning-forecast-active-reducer.ts:390` | live 受理の reducer | 194 period が `active` を返す |
| `weather-warning-forecast-wire.ts:181` | `countUnits` の `periodsPerSubject` | 同上 |
| `weather-warning-forecast-wire.ts:195` | `countUnits` の `periodsPerCard` | card 集計が 256 まで通る |
| `weather-warning-forecast-wire.ts:203` / `:290` / `:330` | `cardConstraintsPass` / byte 判定 | 128KiB まで通る |
| `standby-state-store.ts:925-947` | live の card 検査 | 拒否が受理へ変わる |
| `standby-state-store.ts:3479` | 復元経路（`restoreActiveStateInternal` 内の try ブロック） | 復元受理範囲が広がる |
| `standby-persistence.ts:3437-3438` | 永続 claim の検証 | 超過は `return null` で subject を落とすだけ（throw しない） |
| `standby-persistence.ts:3451` | claim の wire 検証 | 同上 |
| `standby-persistence.ts:8925-8935` | 起動時 bundle 正規化 | 超過 subject は `continue` で捨てる（throw しない） |
| `standby-persistence.ts:9002-9006` | 書き込み時の card byte 検証 | 128KiB まで通る。**ここだけ throw** する |

**永続ファイルサイズ**: `STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE` は 16MiB（`constants.ts:19`）。VPWP50 の名目最悪は 512 subject × 256 period × 475 byte ＝ 62MB だが、これは現行の 128 でも 512 × 128 × 475 ＝ 31MB で既に超えており、**引き上げが新たに作る問題ではない**。実効的な壁は `periodsPerCard`（全 subject 横断で 256）なので、実際の永続 VPWP50 は 256 × 475 ＝ 122KB 程度に収まる。

**ロールバック時の挙動**: 256 で書いた永続ファイルを 128 のビルドで読むと、超過 subject は `standby-persistence.ts:3438` の `return null` と `:8925` の `continue` で**静かに落ちる**（throw しない）。次の正常報で projection は再構築される。ロールバックはファイル削除を伴わずに安全である。

### 4.5 docs 同期（M4・**決定的述語で洗う**）

`docs/specs/2026-08-31-vpwp50-forecast-card.md` は 128 と 64KiB を本文の多数箇所で断定している。素朴な `grep -n "128\|64KiB"` は **104 行**返り、tornado の `maxSubjects: 128` などの無関係な一致を含むので判定に使えない。

VPWP50 の上限を指す文脈だけを拾う述語を使う。

```bash
grep -nE 'WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_(SUBJECT|CARD)|WEATHER_WARNING_FORECAST_MAX_CARD_JSON_BYTES|64KiB|65,536|65536|128 period|period 総数は128|128 periodであっても|129 period|128-period|128 atom|128 target|128 件' \
  docs/specs/2026-08-31-vpwp50-forecast-card.md
```

これは **61 行**返る（`fb67852` 実測）。全 61 行を 1 件ずつ判断し、更新した行と「更新不要と判断した行＋その理由」を差分説明に列挙する。主な集中箇所は `:822-828`（wire invariant）、`:1044-1047`（定数表）、`:1085`、`:1102-1113`（実効上限の式）、`:1223`、`:2147-2149` / `:2198`（atom 数）、`:2668-2691` / `:2748-2796` / `:2810-2818`（試験設計）、`:2904-2905` / `:3051-3052`（spec 内 golden JSON の `declaredLimit: 65536`）、`:3079-3126`（byte 境界の試験）、`:3592-3676`（チェックリスト）。

`:828` の「64KiB は snapshot 上限の 4 分の 1」は **2 分の 1** に書き換わる。この一文が (c) 製品緩和そのものなので、書き換え時に「2026-09-09 に 194 period の実機超過を受けて引き上げた」由来を残す。

---

## 5. 検証

### 5.1 機械的に確認できるもの（A）

| # | 内容 |
|---|---|
| A1 | 合成 fixture で **194 period**（54 target × 4 group 相当）の VPWP50 candidate を作り、`reduceWeatherWarningForecast()` が `kind: "active"` を返すことを固定する |
| A2 | 同 candidate を `standby-state-store` の live 経路へ流し、`weatherWarningForecasts` に入り、`vpwp50ProjectionCapacityExceeded` も `vpwp50ProjectionWireBudgetExceeded` も出ないことを固定する |
| A3 | **新上限の境界**: 256 period は受理、**257** period は `periodsPerSubject` で拒否（`actual: 257` / `declaredLimit: 256`）。合成 fixture は byte 上限に当たらない短い名前で作る |
| A4 | **byte 上限の境界**: **131,072 byte ちょうど**を受理し、`131,073` を `cardJsonBytes` で拒否する。`vpwp50ProjectionWireBudgetExceeded` が 1 回だけ出ることを固定し、実 byte 数を assert する（2026-08-31 spec `:3084-3085` の型を踏襲） |
| A5 | **AND の両方向（§2.4 より重要度高）**: 256 period 以内でも 128KiB 超は wire-invalid、128KiB 以内でも 257 period は wire-invalid。**local scope の fixture で両方向を採る**（local は 256 period で 128KiB の 92.2% を占め、余裕が 8% しかない） |
| A6 | 据え置いた 5 定数（`MAX_SUBJECTS` / `groupsPerSubject` / `targetsPerGroup` / `periodsPerTarget` / `PERIODS_PER_ATOM`）の境界テストが**無改変で通る** |
| A7 | **golden fixture の作り直し（H1）**: `test/fixtures/vpwp50-forecast-expectations.json` の `groupShape129Reasons` / `twoTargets129Reasons` / `mixed129Reasons` は `declaredLimit` を 128 が 10 箇所・65536 が 3 箇所、`effectiveLimit` を 13 箇所に**直値で持つ**。新上限では reason 配列の要素数・`limitingHierarchies`・`effectiveLimit` がすべて変わる（例: `groupShape129Reasons` は 129 group / 129 period / 83,608 byte なので、新上限では `groupsPerSubject` 1 件だけが残り他 3 件が消える）。**fixture の shape を 129 起点から 257 起点へ作り直し、A3 の境界と整合させる**。作り直した値の根拠（どの shape でどの reason が出るか）を差分説明に書く |
| A8 | `test/fixtures/standby-persistence/standby-all-domain-capacity-expectations.json` の期待値差分を洗い、更新箇所を列挙する |
| A9 | **数値直書き試験の棚卸し（M3）**: 下表のファイルを 1 件ずつ見て、VPWP50 上限を指す直値を 257 / 131,073 に寄せるか定数 import に張り替える。**失敗様式は赤ではなく空洞化**（129 period が新上限では合法になり、境界を検査していたつもりの試験が何も検査しなくなる）なので、各ファイルで「VPWP50 由来の直値は N 件で、うち M 件を更新した」を差分説明に書く |
| A10 | `npm run build` と `npm test` が緑 |
| A11 | `npm run test:shuffle` が緑（永続化と module スコープ定数を触るため必須） |
| A12 | `npm --prefix display run build` と display 側テストが緑 |
| A13 | docs 同期: §4.5 の決定的述語（61 行）を全件判断し、更新行と更新不要行を列挙する。チェーンの終端は `echo GREEN` のみ（`grep -c` を成功判定に使わない） |
| A14 | 永続往復: 194 period の projection を書き出し → 読み戻して同一 canonical state になること。および、それを 128 の旧定数で読むと当該 subject が静かに落ちる（throw しない）ことを固定する（§4.4 のロールバック契約） |
| A15 | **SSE の最大 card 試験の作り直し（H4）**: `test/engine/display/sse-clients.test.ts:426-437` は現在「128 period ちょうど・`Buffer.byteLength(...)` が `64 * 1024` ちょうど」の最大 VPWP50 card を作り、snapshot / state の双方が `MAX_SNAPSHOT_BYTES`（256KiB）以内に収まることを assert している。**これを 256 period・128KiB ちょうどで作り直す**。`maxValidWeatherWarningForecastCard()` のヘルパも新上限へ更新する。**この試験が分岐 1-A を承認できる唯一の機械的根拠である**（§7 のリスクを参照） |

M3 の対象ファイルと直値の件数（`fb67852` 実測。素朴 grep は上限、同行 VPWP50 文脈 grep は下限）。

| file | 素朴 grep | 同行に VPWP50 文脈 | 備考 |
|---|---|---|---|
| `test/engine/display/standby-state-store.test.ts` | 34 | 17 | 他ドメインの 128 を含む。要 1 件ずつ判断 |
| `test/engine/display/vpwp50-reducer-diagnostics.test.ts` | 27 | 2 | **ファイル全体が VPWP50 なので 27 件すべて対象** |
| `test/engine/display/sse-clients.test.ts` | 6 | 1 | A15 と重なる |
| `test/engine/display/standby-persistence.test.ts` | 5 | 0 | 同行文脈はゼロ。VPWP50 由来か 1 件ずつ確認する |
| ~~`test/engine/telegram-foundation/phase3b-standby-domains.test.ts`~~ | 4 | 0 | **対象外**。4 件はすべて tornado の `maxSubjects: 128` / `office-128` / salvage ログの `retained=128` で、VPWP50 と無関係（`:137` / `:626` / `:641` / `:643` を実読して確認） |

### 5.2 実機で確認するもの（B・配送後・CI 対象外）

| # | 内容 |
|---|---|
| B1 | Pi で名古屋地方気象台の次報が表示される。`vpwp50ProjectionCapacityExceeded` と `vpwp50ProjectionWireBudgetExceeded` の warn 行が出ない |
| B2 | `weatherTimeseries:気象庁:scope:all` subject で `targetsPerGroup` 由来の拒否が出ていないことをログで確認する。**出ていたら分岐 2 を開き直す**（§3.5） |
| B3 | 実発表待ち（待機項目・配送の前提にしない）: 広域大雨時に `periodsPerSubject` の実測が 256 を超えるかを診断ログで観測し、§3.4 の推定を検証する |
| B4 | SSE の非退行: 大きい VPWP50 card が乗った状態で、`http-server.ts:674-676` の「縮退後も snapshot が上限を超えたため接続を切断しました」warn と `res.destroy()` が発生しないこと |
| B5 | カードの回転が実用に耐えるかの目視（分岐 4 の材料）。194 atom × 15 秒 ＝ 約 48 分で 1 周する |

### 5.3 スコープ外（本 spec では触らない）

- `effectiveLimit` 探索の二分探索化（前提 spec `2026-09-09-vpwp50-limit-search-binary.md`）
- pager の回転設計そのもの（`TIME_SLICE_PERIOD_MS = 15_000`、`time-slice-scheduler.svelte.ts:7`）。分岐 4 で問題提起だけする
- 重大度順に atom を間引く / 上位 N だけ表示する設計。fail-closed 契約の変更にあたり、別 spec
- `MAX_SNAPSHOT_BYTES` の引き上げ（分岐 3 で B 案として提示、推奨しない）
- gate・admission・`MAX_SUBJECTS` 512 の契約
- Issue #16 の診断コード（`1649775` で完了済み）

---

## 6. 判断分岐

### 分岐 1: 上限値をいくつにするか（**(c) 製品緩和を含む・要裁定**）

| 案 | periodsPerSubject / periodsPerCard | cardJsonBytes | 194 は通るか | local scope 256 の実測 | snapshot 予算に占める名目 | 1 周の回転時間 |
|---|---|---|---|---|---|---|
| **A（推奨）** | **256** | **128KiB** | **通る（91,676 byte）** | **120,816 byte（92.2%）** | **1/2** | 最大 64 分 |
| B | 512 | 256KiB | 通る | — | **1/1（超過）** | 最大 128 分 |
| C | 1,024 | 512KiB | 通る | — | **2/1（超過）** | 最大 256 分 |
| D | 256 | 64KiB 据え置き | **通らない**（91,676 > 65,536） | — | 1/4 | — |

**推奨は A（256 / 128KiB）**。根拠は 3 つある。

1. **B と C は SSE の壁を越える**。`MAX_SNAPSHOT_BYTES` は 256KiB（`constants.ts:9`）で、VPWP50 card だけで 512 period ＝ 232KB を占めると、他の card を足した snapshot が確実に上限を超える。`degradeSnapshotToBudget()` は `standbyItems` を縮退させない（2026-08-31 spec `:829`）ので、超えた時点で `http-server.ts:674-676` の `res.destroy()` に落ちる。B / C を採るなら `MAX_SNAPSHOT_BYTES` の引き上げが前提になる（分岐 3）
2. **A は元の設計比を保つ**。現行は「count 128 ≒ byte 138 相当（local scope）」でほぼ等しい地点に 2 つの壁が並んでいる。256 / 128KiB は「count 256 ≒ byte 277 相当」で、count が先に効く関係が維持される。片方だけ倍にすると設計の意図が崩れる
3. **D は目的を達しない**（§2.3）。診断コードが変わるだけで表示は復旧しない

**A の弱点を隠さない**。

- **byte 側の余裕は 8%**（§2.4）。local scope の 256 period card は 128KiB の 92.2% を占め、byte 上限が効き始めるのは 277 period である。地名が長い官署や local 細分の多い官署では、count 256 に届く前に byte で fail-closed する組合せがある
- **count 256 は 194 に対して 32% の余裕しかない**。§3.4 の推定では長域事象で 324〜600 period がありうるので、**A では再発する可能性がある**

それでも A を推すのは、B の 512 が SSE の壁と回転時間 128 分という別の破綻を招くからで、「上限をどこまでも上げる」方向には出口がないという判断である。再発したときの正しい次手は分岐 4 の表示側設計であって、さらなる引き上げではない。

**(c) 該当**: `cardJsonBytes` の 64KiB → 128KiB は、他 card 用の snapshot headroom を名目 3/4 から 1/2 へ削る製品挙動の緩和である。ご主人裁定を要する。

### 分岐 2: どの定数まで上げるか

| 案 | 内容 | 判断 |
|---|---|---|
| A | reducer の `periodsPerSubject` だけ上げる | **不可**。§2.3 の実測で 194 は byte 上限に落ちる。表示は復旧しない |
| **B（推奨）** | **reducer と wire の両方（`periodsPerSubject` / `periodsPerCard` / `cardJsonBytes`）を上げる** | **推奨** |
| C | reducer の上限を撤廃し、wire の切り詰めに任せる | **不可**。wire は切り詰めない。`weatherWarningForecastProjectionLimitReasons()` は理由を返すだけで、`standby-state-store.ts:932-947` は fail-closed する。「切り詰め・部分受理・他 subject eviction で救済してはならない」は 2026-08-31 spec `:444` の明示契約であり、撤廃には別途ご主人裁定が要る |

C を採らない理由をもう一段書く。C は「上限を消せば表示される」ように見えるが、実際には reducer の checkpoint が消えるだけで判定は card 側に移る。card 側が fail-closed である以上、結果は同じで、診断の粒度（Issue #16 で足したばかりの `origin: "reducer"`）だけが失われる。**C は退行である**。

**再開条件**: §5.2 B2 で `targetsPerGroup` 由来の拒否が観測されたら、`MAX_TARGETS_PER_GROUP` を含めるかどうかで本分岐を開き直す（§3.5）。

### 分岐 3: `MAX_SNAPSHOT_BYTES`（256KiB）を触るか

| 案 | 内容 | 判断 |
|---|---|---|
| **A（推奨）** | **触らない** | 分岐 1-A なら 128KiB は 256KiB の半分に収まる。SSE framing と他 card の headroom を残す |
| B | 512KiB へ上げる | 分岐 1-B / C の前提。全 card と SSE 経路に波及し、Pi の帯域とブラウザ側の処理も巻き込む。**本 spec の範囲を大きく超える** |

**推奨は A**。B を採るなら分岐 1 と切り離した別 spec にする。

### 分岐 4: 回転時間の問題をどう扱うか（**問題提起のみ・本 spec では実装しない**）

`WeatherWarningForecastCard.svelte:66-73` は atom を**一度に 1 つだけ**表示し、`TIME_SLICE_PERIOD_MS = 15_000`（`time-slice-scheduler.svelte.ts:7`）で送る。`buildWeatherWarningForecastAtoms()`（`display/frontend/src/lib/weather-warning-forecast.ts:65-119`）に件数の上限はない。

| period 数 | atom 数（1 target 1 period の一般形） | 1 周 |
|---|---|---|
| 128（現行上限） | 128 | 32 分 |
| 194（実機実測） | 194 | 48.5 分 |
| 256（推奨上限） | 256 | 64 分 |

atom は group の重大度降順に並ぶので、最も重い警戒レベルは各周の冒頭に出る。それでも **1 つの市町村の予測が 1 時間に 1 回しか出ない**状態は、常設ディスプレイとしては実用性が薄い。

| 案 | 内容 |
|---|---|
| A | 本 spec では扱わない（上限引き上げだけ入れる） |
| B | 別 spec で「重大度上位 N atom だけ回す」設計を起こす |

**推奨は A + バックログへ B を起票**。上限引き上げは「消えるより出たほうがいい」を満たす最小の一手で、回転設計は独立に判断できる。B を本 spec に混ぜると、fail-closed 契約の変更（表示する period の取捨選択）が上限変更に紛れて入ってしまう。

---

## 7. 裁定ラベル案（6 要素）

```
対象:
  src/engine/display/weather-warning-forecast-wire.ts（:14 / :15 / :17 の値のみ）
  test/fixtures/vpwp50-forecast-expectations.json（129 起点の golden 3 ブロックを 257 起点へ作り直す）
  test/fixtures/standby-persistence/standby-all-domain-capacity-expectations.json（差分が出た場合のみ）
  test/engine/display/sse-clients.test.ts（最大 VPWP50 card 試験を 256 period・128KiB へ）
  test/engine/display/http-server.test.ts（degradeSnapshotToBudget の最大 card を同上へ）
  test/engine/display/standby-state-store.test.ts
  test/engine/display/vpwp50-reducer-diagnostics.test.ts
  test/engine/display/standby-persistence.test.ts
  test/ 配下の新規テスト
  docs/specs/2026-08-31-vpwp50-forecast-card.md（§4.5 の決定的述語が返す 61 行の全件判断）
  docs/specs/2026-09-09-vpwp50-periods-limit.md（本 spec）
  docs/specs/2026-09-08-vpwp50-reducer-diagnostics.md（旧 golden 名へのポインタ 1 行ずつ）
  docs/specs/2026-09-09-vpwp50-limit-search-binary.md（同上）

許容変更:
  WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT を 128 → 256
  WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_CARD を 128 → 256
  WEATHER_WARNING_FORECAST_MAX_CARD_JSON_BYTES を 64KiB → 128KiB
  golden fixture の 129 起点 shape を 257 起点へ作り直す
  数値直書き試験を新上限へ寄せる、または定数 import へ張り替える
  前提 spec がテスト用に export した cardConstraintsPass / truncateReasonUnits を
    新規テストから使う（本番コードからの新規呼び出しは足さない）
  docs の 128 / 64KiB 記述の同期

禁止変更:
  WEATHER_WARNING_FORECAST_MAX_SUBJECTS（512）
  WEATHER_WARNING_FORECAST_MAX_GROUPS_PER_SUBJECT（128）
  WEATHER_WARNING_FORECAST_MAX_TARGETS_PER_GROUP（128・B2 の観測で再裁定するまで）
  WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_TARGET（128）
  WEATHER_WARNING_FORECAST_PERIODS_PER_ATOM（4）
  MAX_SNAPSHOT_BYTES（constants.ts:9）と STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE（constants.ts:19）
  effectiveLimit 探索の実装（前提 spec の領分）
  fail-closed 契約（切り詰め・部分受理・他 subject eviction による救済を入れない）
  Vpwp50ProjectionLimitReason の形と origin:"reducer" の非対称
  REASON_ORDER・isAncestorReason の階層関係
  reducer の判定順序
  degradeSnapshotToBudget への VPWP50 救済の委譲
  永続 schema / envelope / migration
  表示側の回転設計（TIME_SLICE_PERIOD_MS・buildWeatherWarningForecastAtoms）
  gate 判定・admission
  package.json / package-lock.json
  data/runtime/ 配下の実データ
  実電文由来の XML のリポジトリへの追加

配送先: main → personal → Pi
  main へ push 後、GitHub Actions（Test workflow）の緑を配送条件に含める
  前提 spec（2026-09-09-vpwp50-limit-search-binary.md）の配送完了を着手条件とする

ロールバック:
  main は該当 commit を git revert、personal は rebase 追従後に
  git push --force-with-lease private personal、Pi は
  git fetch origin personal && git reset --hard origin/personal で戻す
  永続ファイルの手当ては不要（旧定数で読むと超過 subject が静かに落ちる。§4.4）

受入条件: §5.1 の A1〜A15 を全件。§5.2 の B1・B2・B4 は配送後の Pi 観測で確認する。
  B3・B5 は待機項目で、配送の前提条件にしない。

裁定: **未裁定**。分岐 1（上限値・(c) 製品緩和を含む）と分岐 2 の裁定が要る。
  分岐 3・4 は推奨で確定してよい。**🌙自走OK にはしない**。
```

---

## 8. 未検証・残るリスク

- **SSE 全体の余裕は管理されていない**。「headroom 3/4 → 1/2」は 2026-08-31 spec `:828` が宣言した名目値であって、実際に他 card が何 byte 使うかを測る仕組みはない。**byte 予算を持つ待機カードは VPWP50 だけである**。超過したときの挙動は `http-server.ts:674-676` の `res.destroy()`、すなわち **ディスプレイ全体の SSE 切断**であり、VPWP50 カードだけが消えるのではない。A15 が分岐 1-A を承認できる唯一の機械的根拠なのはこのためで、実機観測 B4 と対で見る
- **194 の内訳は推測である**（§3.3）。名古屋の当該 XML を採っていない
- **byte 側の余裕は 8% しかない**（§2.4）。local scope の 256 period card は 120,816 byte（128KiB の 92.2%）で、byte 上限が効くのは 277 period である
- **Pi での実測をしていない**
- **256 で足りる保証はない**（§3.4）。再発時の次手は分岐 4 の表示側設計であって、さらなる引き上げではない
- **`targetsPerGroup` 据え置きには反例がある**（§3.5）。B2 で観測されたら分岐 2 を開き直す

---

---

## 9. 実装記録（2026-09-09）

### 9.1 変更した定数

`src/engine/display/weather-warning-forecast-wire.ts:14-17` の 3 行だけを書き換えた。

| 定数 | 旧 | 新 |
|---|---:|---:|
| `WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT` | 128 | **256** |
| `WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_CARD` | 128 | **256** |
| `WEATHER_WARNING_FORECAST_MAX_CARD_JSON_BYTES` | 64 KiB | **128 KiB** |

**reducer の実装変更はゼロである**。`weather-warning-forecast-active-reducer.ts:28` は
`WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT` を wire から import しており、
`:390` / `:395` はその値をそのまま使う。分岐 2-B の「reducer と wire を同時に上げる」は
定数 1 箇所の変更で満たされる。据え置き対象（`MAX_SUBJECTS` / `groupsPerSubject` /
`targetsPerGroup` / `periodsPerTarget` / `PERIODS_PER_ATOM` / `MAX_SNAPSHOT_BYTES` /
`STANDBY_PERSISTENCE_MAX_BYTES_PER_FILE`）と fail-closed 契約は無変更である。

### 9.2 失敗様式は赤ではなく「shape の痩せ」だった

上限を上げると、**祖先階層を同時に超えさせるために置いていた合成 shape が、自分の
階層しか超えなくなる**。129 group の fixture は 129 period・83,608 byte なので、新上限では
`groupsPerSubject` 1 件しか鳴らず、canonical order を検査する試験が 4 件から 1 件へ痩せる。
対処は全て「shape を定数から導いて 257 起点へ作り直す」で、直値の書き換えではない。

- `test/engine/display/standby-state-store.test.ts`: `FORECAST_OVER_SUBJECT_PERIODS = periodsPerSubject + 1`
- `test/engine/display/vpwp50-limit-search-binary.test.ts`: `OVER_SUBJECT_PERIODS` 同上
- `test/engine/display/vpwp50-reducer-diagnostics.test.ts`: `OVER_SUBJECT_COUNTS`（target 上限内に収めたまま subject 上限 +1 を作る）

`twoTarget129` shape は **3 target へ作り直した**。subject 上限 256 が target 上限 128 の
ちょうど 2 倍になったため、2 target のままだと共通 `effectiveLimit` が declaredLimit
128 と同値になり、「共通 N を同時適用する」性質を検査しなくなる。3 target なら
`floor(256 / 3) = 85 < 128` で数値枝が残る。

### 9.3 golden の作り直し（A7）

`test/fixtures/vpwp50-forecast-expectations.json` の 3 ブロックを再生成した。reason の
**件数・code 集合・null / 数値の別**は旧 golden と同じで、値だけが動いている。

| golden | shape | reason codes | `effectiveLimit` |
|---|---|---|---|
| `groupShapeOverReasons`（旧 `groupShape129Reasons`） | 129 group × 3 period | groups / subject / card / bytes | **85** / 256 / 256 / 131,072 |
| `threeTargetsOverReasons`（旧 `twoTargets129Reasons`） | 3 target × 257 period | perTarget / subject / card / bytes | **85** / 128 / 128 / 131,072 |
| `mixedOverReasons`（旧 `mixed129Reasons`） | 257 target group ＋ 257 period target | targets / perTarget / subject / card / bytes | **null / null** / 128 / 128 / 131,072 |

`groupShapeOverReasons` を 1 period / group のまま 257 group で作ると、`groupsPerSubject`
の実効上限が宣言上限 128 と同値になり、**二分探索が declaredLimit をそのまま返した
だけの状態と区別できない**（独立レビュー F4）。`128 * p > 256` となる最小の p ＝ 3 を
使うと 85 へ落ちる。代わりに同 golden の `periodsPerSubject` / `periodsPerCard` が
宣言上限と同値になるが、この 2 code の数値枝は `threeTargetsOverReasons`（ともに 128）
と `mixedOverReasons`（ともに 128）が持っており、試験側にその番人を置いた。
`groupsPerSubject` の実効上限を持つ golden は group shape だけなので、痩せを許せない
のはこちら側である。

byte golden も測り直した。group shape は 100 / 101 / 102（旧 64KiB の実効境界）に加えて
**201 / 202 / 203**（新 128KiB の実効境界。202 = 130,839 byte ≤ 131,072 < 203 = 131,486 byte）と
256 / 257 を追加し、byte 曲線が上限と独立に固定されるようにした。

### 9.4 A15 の実測（分岐 1-A の機械的根拠）

`test/engine/display/sse-clients.test.ts` の最大 card を 2 group × 128 target ＝
**256 period・131,072 byte ちょうど**へ作り直した（`targetsPerGroup` は 128 のままなので
1 group には 256 target を載せられない）。`encodeSseGuarded()` を通した実測は次のとおりで、
`MAX_SNAPSHOT_BYTES`（262,144）に対して **49.8% の余白**が残る。

| frame | bytes | MAX_SNAPSHOT_BYTES 比 |
|---|---:|---:|
| snapshot | 131,462 | 50.1% |
| state | 131,456 | 50.1% |

### 9.5 §5.1 受入の結果

| # | 結果 | 根拠 |
|---|---|---|
| A1 | GREEN | 194 period candidate が `active`。`vpwp50-reducer-diagnostics.test.ts` |
| A2 | GREEN | live store 経由で `vpwp50Projection*` warn ゼロ、reason 配列 empty |
| A3 | GREEN | 256 受理 / 257 を `periodsPerSubject` で拒否。3 target へ分けて per-target 上限に触れさせない |
| A4 | GREEN | 131,071 / 131,072 受理・131,073 を `cardJsonBytes` で拒否（実 byte 数を assert） |
| A5 | GREEN | local scope 128 target × 2 period で両方向。byte 側は地名長を実測で挟んで境界を作る（探索ループには `VPWP50_MAX_AREA_NAME_LENGTH` 由来の反復上限と throw を置く） |
| A6 | GREEN | 据え置き 5 定数の境界試験は無改変で通過 |
| A7 | GREEN | §9.3 |
| A8 | GREEN | `standby-all-domain-capacity-expectations.json` に差分なし（`VPWP50: 512` は `MAX_SUBJECTS`） |
| A9 | GREEN | §9.6 |
| A10 | GREEN | `npm run build` / `npm test` |
| A11 | GREEN | `npm run test:shuffle` |
| A12 | GREEN | display の build / typecheck / test |
| A13 | GREEN | §9.7 |
| A14 | GREEN | 194 period の永続往復が同一 canonical state。上限超過 subject は throw せず静かに落ちる |
| A15 | GREEN | §9.4 |

### 9.6 数値直書き試験の棚卸し（A9・M3）

| file | VPWP50 由来の直値 | 更新 | 方針 |
|---|---:|---:|---|
| `standby-state-store.test.ts` | 17 | 17 | 定数 import へ張り替え。golden 参照は §9.3 の新 key へ |
| `vpwp50-reducer-diagnostics.test.ts` | 27 | 9 | 128 のまま正しい階層（groups / targets / perTarget）は据え置き。periodsPerSubject 系のみ差し替え |
| `sse-clients.test.ts` | 6 | 6 | 定数 import へ張り替え |
| `http-server.test.ts` | 6 | 6 | 定数 import へ張り替え。`degradeSnapshotToBudget()` の縮退梯子を試験しているのはこのファイルだけなので、上限の半分の card では梯子を通り切った証拠にならない（独立レビュー F1） |
| `standby-persistence.test.ts` | 5 | 0 | 5 件とも briefing の raw entry 境界で VPWP50 と無関係（実読で確認） |
| `vpwp50-limit-search-binary.test.ts` | 12 | 12 | 前提 spec の shape。`declaredLimit !== 128` の skip を `ceil(log2(declaredLimit + 2))` の上界式へ置き換え、256 の階層も探索回数の検査対象に戻した |

### 9.7 docs 同期の判断（A13・M4）

§4.5 の決定的述語は更新前に 61 行、更新後に 17 行を返す。**44 行を更新し、17 行を
更新不要と判断した**。加えて、先行 2 spec（`2026-09-08-vpwp50-reducer-diagnostics.md`・
`2026-09-09-vpwp50-limit-search-binary.md`）の旧 golden 名参照 3 箇所へ、新名と本 spec
へのポインタを 1 行ずつ足した（独立レビュー F3）。

- 更新不要の内訳: `periodsPerTarget`（128）と `targetsPerGroup`（128）の atom 算術 9 行
  （`:2147` / `:2148` / `:2198` / `:2668` / `:2671` / `:2684` / `:2689` / `:2691` / `:3685`）、
  display preview fixture 名の `128-period` 3 行（`:2351` / `:2364` / `:2365`）、
  引き上げ後の値そのもの 3 行（`:1044` / `:1045` / `:1047`）、由来を残した注記 2 行
  （`:828` / `:1085`）
- **述語が拾えなかった 4 行も直した**: `:821`（invariant 引用の period 総数 128 件）、
  `:924`（card period 上限からの active pair 数の導出）、`:1111` / `:1112`。
  述語は全角混じりの `period総数は128` や `128件` を拾えない
- **更新しないと判断した述語外の記述**: `:2748`〜`:2783` と `:3244`〜`:3269` の
  「active pair 128 件」は 512 / 513 bundle の内訳であって上限の言い換えではない。
  数値としては今も正しいが、旧上限では card period 予算ちょうどだった境界性は失われる。
  fixture 設計を境界へ戻すかは別途裁定とする

### 9.8 残るリスク

- §8 の 6 項目は据え置き。特に **byte 側の余裕 8%** と **256 で足りる保証がない**点は変わらない
- 3 target shape の共通 `effectiveLimit` が 85 なのは `256 / 3` に依存する。上限が
  再び動くと 128 と衝突しうるので、試験側に `shared < declaredLimit` の番人を入れた
- B1 / B2 / B4 は Pi 実機での配送後観測

---

## 改訂履歴

- **2026-09-09 初版**（Liebe 起草、HEAD `b98caed`）。128 の出典を `git log -S` で `3c19768` に確定し、byte/period の実測と拒否経路コストの実測を dist 直 require の probe で採った
- **2026-09-09 scoped 再確認の反映**: §4.4 の復元経路の行を `:3410` から **`:3479`**（`restoreActiveStateInternal` 内の try ブロック、`standby-state-store.ts` を実読して確認）へ訂正した
- **2026-09-09 独立レビュー反映と spec 分割**（HEAD `fb67852`）。二分探索を同伴修正から外し、単独 spec `2026-09-09-vpwp50-limit-search-binary.md` へ分離した（H3・M2: reducer 拒否経路は wire の探索を通らず、実際にコストを payしているのは横断集計と起動時 bundle 正規化だった）。**A10「golden 無改変」は事実と逆だったので A7「golden 作り直し」へ全面訂正**（H1: `groupShape129Reasons` ほかが `declaredLimit` 128 ×10・65536 ×3、`effectiveLimit` 13 件を直値で持つことを実読で確認）。`cardConstraintsPass` / `truncateReasonUnits` が module-private であることを確認し、前提 spec の export に依存させた（H2）。SSE 最大 card 試験の作り直しを A15 として追加し、これが分岐 1-A の唯一の機械的根拠であることと `res.destroy()` がディスプレイ全体を切ることを §8 へ明記（H4）。byte リスクの主成分を名前長から派生キー（43 文字 ×3/period）と local scope へ訂正し、余裕を 12% から **8%** へ実測で訂正（H5、local 256 period ＝ 120,816 byte）。数値直書き試験の棚卸しを A9 として追加し、`phase3b-standby-domains.test.ts` の 4 件が tornado 由来で対象外であることを実読で確認して一覧から外した（M3 の訂正）。docs 同期の grep を素朴 104 行から決定的述語 61 行へ置き換えた（M4）。救済禁止の引用を `:826` から **`:444`** へ訂正し、§2.2 の引用ブロックを飛ばさず全文にした（L1）。基準 SHA を `fb67852` へ（L2）。A15 の結合先を preview fixture から `sse-clients.test.ts` へ訂正した（L3、`preview/fixtures.ts:2408-2412` の `designAlignmentCompressedPayloadSignature` は engine 定数と連動しない固定署名）。`weatherTimeseries:気象庁:scope:all` が `targetsPerGroup` 据え置きの反例になりうることと、B2 で観測したら分岐 2 を開き直す条件を §3.5 として追加した（L4）
- **2026-09-09 実装完了**（裁定 8-A）。定数 3 本を 256 / 256 / 128KiB へ引き上げ、合成 shape を 257 起点へ作り直し、golden 3 ブロックを再生成した。A1〜A15 全件 GREEN、A15 の snapshot frame は 131,462 byte（`MAX_SNAPSHOT_BYTES` の 50.1%）。詳細は §9
- **2026-09-09 独立レビュー反映**（F1〜F4）。`http-server.test.ts` の `degradeSnapshotToBudget` 最大 card を 256 period・128KiB へ作り直し（F1）、`findEffectiveLimit` の陳腐化コメントを訂正（F2）、先行 2 spec の旧 golden 名へポインタを追加（F3）、`groupShapeOverReasons` を 129 group × 3 period へ作り直して `groupsPerSubject.effectiveLimit` を 85（< 宣言上限 128）にした（F4）
- **2026-09-09 独立レビュー F5 反映**。A5 の地名 filler 探索ループに反復上限（250）と `filler capacity exhausted` の throw を足した。filler が byte に効かなくなったときに無限ループへ落ちない
