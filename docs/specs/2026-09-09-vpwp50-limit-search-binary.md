# VPWP50 `effectiveLimit` 探索を二分探索にする spec（性能のみ・製品緩和なし）

> **裁定状態**: 未裁定。**🌙自走OK 候補**として起草した。製品挙動の変更を含まず、`effectiveLimit` の値も変えないため、§7 の裁定ラベル 6 要素は全欄を埋めてある。

> **基準 SHA**: `fb67852238b8b9db0b91a0b3365a4dd841207c4a`（worktree `~/dev/fleq-layout`、branch main）。以下の file:line はすべてこの SHA のもの。`git status --porcelain` は `?? display/tmp-capture/` のみ（追跡ファイルに変更なし）。

> **位置づけ**: `docs/specs/2026-09-09-vpwp50-periods-limit.md`（上限引き上げ本体）の**前に単独で配送する**。引き上げは本 spec の配送を前提にする。逆に本 spec は引き上げなしでも単独で価値がある（§3 のとおり、現行 128 のままでも毎回コストを払っている）。

> **計測環境**: 数値はすべて `dist/`（`b98caed` ビルド、`fb67852` との差は CI 設定のみで `src/` は同一）へ直接 require する probe を darwin 上で実走して採った。probe は scratchpad に置き、repo には入れていない。Pi 実機での再計測は未実施（§6.2）。

---

## 1. 症状

`weatherWarningForecastProjectionLimitReasons()` は、上限を超えた VPWP50 候補について「どこまで削れば通るか」を `effectiveLimit` として返す。この探索が線形で、**1 回の呼び出しに 90〜123 ms かかる**（darwin 実測）。同期呼び出しなので、その間 display パイプラインが止まる。

Pi は単コア性能でおよそ 5〜8 倍遅いため、**0.4〜0.9 秒の停止**に相当する。#13 で潰した種類の停止である。

---

## 2. 根因（file:line）

`src/engine/display/weather-warning-forecast-wire.ts:302-308`

```ts
const units = limitReasonUnits(states, code);
const paths = new Set(units.map((unit) => unit.path));
const declaredLimit = units[0]!.declaredLimit;
let effectiveLimit: number | null = null;
for (let candidate = 0; candidate <= declaredLimit; candidate += 1) {
  if (cardConstraintsPass(truncateReasonUnits(states, code, paths, candidate))) effectiveLimit = candidate;
}
```

超過した code ごとに 0 から `declaredLimit`（128）まで **129 回**、次を回す。

- `truncateReasonUnits()`（`:232-281`）→ 先頭で `canonicalStateCopy()`（`:206-222`）が全 state を `structuredClone` し、group / target / period を全ソートする
- `cardConstraintsPass()`（`:199-204`）→ `countUnits()` の全走査、`buildWeatherWarningForecastCard()`（内部でさらに `structuredClone`）、`JSON.stringify` による byte 計測

コストは `declaredLimit × state サイズ` に比例する。`break` がなく、通る最大の `candidate` を最後まで探し続ける。

---

## 3. この探索が実際に走る経路（H3・M2）

**先に誤解を潰しておく**。2026-09-08 の名古屋 194 period の拒否は、この探索を**通っていない**。

`src/engine/display/standby-state-store.ts:872-912` の `case "rejected"` は、reducer が返した `hierarchy` / `actual` / `declaredLimit` / `samplePath` から診断を直接組み立て、`effectiveLimit: null` を明示して `return` する。`weatherWarningForecastProjectionLimitReasons()` を呼ぶのは `:915` 以降、つまり `result.state` が取れた後だけである。したがって reducer 段で落ちた候補は wire の探索に到達しない。

実際に線形探索が走るのは次の 2 経路である。

### 3.1 live の横断集計（`standby-state-store.ts:925`）

reducer を通った候補は、他 subject の projection と合わせた prospective card として `weatherWarningForecastProjectionLimitReasons()` に渡される。**全 active subject を横断した period 総数**（`periodsPerCard`、上限 128）が超えていれば、探索が走る。

1 官署あたりの period が上限内でも、**複数官署の合計が 128 を超えれば、以後どの官署の報が来ても毎回**このコストを払う。実測は次のとおり。

| 構成 | 合計 period | 実測 | 検出された code |
|---|---|---|---|
| 3 subject × 50 period | 150 | **90.0 ms** | `periodsPerCard`, `cardJsonBytes` |
| 5 subject × 40 period | 200 | **113.9 ms** | 同上 |
| 20 subject × 10 period | 200 | **122.6 ms** | 同上 |

`cardJsonBytes` は固定 reason（`:294-300`）で探索を伴わないので、上の時間はすべて `periodsPerCard` 1 code 分のループである。subject 数が増えるほど 1 反復の `canonicalStateCopy` が重くなり、同じ 200 period でも 20 subject のほうが遅い。

**広域の荒天では複数官署が同時に危険度予測を出す**ので、この状態は例外ではなく通常運転になりうる。

### 3.2 起動時の bundle 正規化（`standby-persistence.ts:8925-8935`）

```ts
for (const gate of retainedGates) {
  ...
  const prospective = [...retainedRuntime, candidate];
  const reasons = weatherWarningForecastProjectionLimitReasons(prospective);
```

`retainedGates` は最大 `WEATHER_WARNING_FORECAST_MAX_SUBJECTS`（512）件（`:8905`）。**gate 1 件ごとに探索を回す**ので、合計が上限を超えた状態で再起動すると §3.1 のコストが最大 512 倍に増幅する。起動が数十秒単位で伸びうる。

### 3.3 その他の呼び出し元（変更しない）

| file:line | 経路 |
|---|---|
| `standby-state-store.ts:925` | live 受理（§3.1） |
| `standby-state-store.ts:3479` | 復元（`restoreActiveStateInternal` 内の try ブロック） |
| `standby-persistence.ts:3451` | 永続 claim の検証 |
| `standby-persistence.ts:8925` | 起動時 bundle 正規化（§3.2） |

4 箇所すべてが同じ関数を呼ぶので、本 spec の改善は全経路に一様に効く。呼び出し側は 1 行も変えない。

---

## 4. 変更

### 4.0 Phase 0 申告（実装着手前の成果物）

1. 読んだ規範: 本 spec、`docs/specs/2026-08-31-vpwp50-forecast-card.md` §3.9（`effectiveLimit` の null 規則、`:1223` 付近）、`docs/specs/2026-09-08-vpwp50-reducer-diagnostics.md` §3.5（不変に保つ契約）
2. 触る行: `weather-warning-forecast-wire.ts:302-308`（探索の**関数抽出と二分探索化**）と、`:199` / `:232` の export 化
3. 触らないと宣言する行: 同ファイル `:10-17`（全定数）、`:283-325` の返り値の形、`:346-349`（`assertWeatherWarningForecastWireInvariant`）
4. `git rev-parse HEAD` が base_oid と一致すること、`git status --porcelain` が空であること

### 4.1 探索を述語受け取りの純関数へ切り出す

`cardConstraintsPass(truncateReasonUnits(states, code, paths, k))` は k について単調である（k を小さくすると常に部分集合になる。単調性の前提は §5）。したがって「通る最大の k」を二分探索できる。

**ループ本体をその場で書き換えるのではなく、述語を受け取る純関数として切り出す。** 理由は §4.2。

```ts
/** 単調な述語 pass について、pass(k) が true になる最大の k を返す。どの k でも false なら null。 */
export function findEffectiveLimit(
  declaredLimit: number,
  pass: (candidate: number) => boolean,
): number | null {
  let low = 0;
  let high = declaredLimit;
  let effectiveLimit: number | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (pass(mid)) {
      effectiveLimit = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return effectiveLimit;
}
```

呼び出し側（`:302-308`）は述語を渡すだけになる。

```ts
const effectiveLimit = findEffectiveLimit(
  declaredLimit,
  (candidate) => cardConstraintsPass(truncateReasonUnits(states, code, paths, candidate)),
);
```

- 反復数は `declaredLimit = 128` で **129 → 8**（`⌈log2(129)⌉`）
- `effectiveLimit` が `null` になる条件（k = 0 でも通らない）は現行と同じ。`:309-311` の `zeroReasons` 分岐は**そのまま残す**
- 探索の外にある `actual` / `declaredLimit` / `violatingUnitCount` / `limitingHierarchies` / `samplePaths` の計算には一切触れない

### 4.2 なぜ関数抽出が要るか（spy が効かないため）

素朴に `vi.spyOn(wireModule, "cardConstraintsPass")` で呼び出し回数を数える案は**成立しない**。

TypeScript が CommonJS へコンパイルすると、module 内部からの呼び出しは bare local binding のまま残る。`dist/engine/display/weather-warning-forecast-wire.js:255` を実読して確認した。

```js
for (let candidate = 0; candidate <= declaredLimit; candidate += 1) {
    if (cardConstraintsPass(truncateReasonUnits(states, code, paths, candidate)))
        effectiveLimit = candidate;
}
```

`exports.cardConstraintsPass` でも `(0, exports.cardConstraintsPass)` でもないので、`export` を足しても `exports` オブジェクトに別名が 1 つ増えるだけで、この呼び出しは差し替わらない。**spy はカウント 0 のまま「8 回以下」を満たして緑になる**——テストが何も検査していない空洞になる、最も気づきにくい失敗様式である。

`findEffectiveLimit` を切り出せば、テストが自前の述語を渡して**呼び出し回数を直接数えられる**。A2 の参照実装比較も同じ述語で書けるので、二分探索と線形探索を同一入力で突き合わせられる。

### 4.3 テスト用 export（許容変更）

`cardConstraintsPass`（`:199`）と `truncateReasonUnits`（`:232`）は現在 module-private である。§6.1 の A4（単調性そのものの検査）は 2 関数を直接呼ぶので、両方の export が要る。

- 2 つを `export` する。**シグネチャと挙動は変えない**
- 本番コードからの新規呼び出しは足さない。用途はテストのみ
- `findEffectiveLimit` は本番経路が使う正規の export であって、テスト専用ではない

### 4.4 変更しない契約

- `Vpwp50ProjectionLimitReason` の形と、各フィールドの値
- `REASON_ORDER`（`:68-71`）と `isAncestorReason()`（`:334-344`）
- `weatherWarningForecastProjectionLimitReasonsShallow()`（`:327-332`）
- `assertWeatherWarningForecastWireInvariant()`（`:346-349`）の throw 条件とメッセージ
- `weather-warning-forecast-wire.ts:10-17` の**全定数**（上限引き上げは別 spec）
- 呼び出し元 4 箇所（§3.3）
- reducer（`weather-warning-forecast-active-reducer.ts`）と store の受理経路
- 永続 schema / envelope / migration
- 表示側（`display/`・`ui/`）

---

## 5. 単調性が依存している前提（M1・**静かに壊れる**）

二分探索の正しさは `cardConstraintsPass(truncate(k))` が k について単調であることに依る。count 側は自明（truncate は部分集合を返す）だが、**byte 側は自明ではない**。card の JSON byte 数は period 数だけでなく、次の派生値にも依存する。

| 派生値 | 現状 | 単調性への影響 |
|---|---|---|
| `severity`（`buildWeatherWarningForecastCard` `:151-154`） | `severityRank`（`:73`）は `info: 0` / `normal: 1` / `warning: 2` / `critical: 3`。文字列長は 4 / 6 / 7 / 8 | **rank 順と文字列長順が一致している**。period を削ると severity は下がるか同じ、つまり文字列は短くなるか同じ。単調性を壊さない |
| `updatedAt` / `expiresAt`（`:161-162`） | ISO 8601 で**常に 24 文字** | 長さが変わらないので影響なし |
| `sourceEventIds`（`:155`） | 空になった state は `truncateReasonUnits` の `:280` で除去される | 要素が減るだけなので短くなるか同じ |
| `restored`（`:163` の `states.some((state) => state.restored)`） | `true`（4 文字）と `false`（5 文字）。**縮小側が 1 byte 長くなる唯一のフィールド** | 値が `true → false` へ反転するのは、`restored: true` の state が**すべて丸ごと落ちた**ときだけである。state が落ちるにはその state の全 period が消える必要があり、そのとき当該 state の group / target / period の JSON と `sourceEventIds` の 1 要素が同時に消える。最小でも数十 byte 減るので、`restored` の +1 byte が優越することはない。単調性を壊さない |

**したがって現状は単調である。** ただしこれは偶然の一致に支えられている。将来 `severityRank` に「rank は高いが文字列が短い」値が入る（たとえば `critical` の上に `max`）と、period を削ったのに byte が増える組合せが生まれ、**二分探索は例外を出さず違う `effectiveLimit` を返す**。診断の数字が静かにずれるだけなので、テストがなければ気づけない。

そこで §6.1 の A3 で、この前提そのものを assert する。

---

## 6. 検証

### 6.1 機械的に確認できるもの（A）

| # | 内容 |
|---|---|
| A1 | 二分探索の実装が、`declaredLimit = 128` の全 code で `effectiveLimit` を現行と同じ値で返す。既存の VPWP50 テストが**無改変で緑**であること |
| A2 | **参照実装との一致（property テスト）**: 線形探索（0..`declaredLimit` を全走査して通る最大の k を返す）を参照実装としてテスト内に持ち、**`findEffectiveLimit` に渡すのと同じ述語**で両者を突き合わせる。複数 shape（group 超過 / target 超過 / period 超過 / 横断集計超過 / 複合違反 / `effectiveLimit === null` になる形）と複数 subject 数（1 / 3 / 20）について、返り値が全 code で一致することを固定する |
| A3 | **単調性の前提の固定（§5）**: `severityRank` の rank 昇順と、対応する `StandbySeverity` 文字列の長さ昇順が一致することを assert する（`info` 4 / `normal` 6 / `warning` 7 / `critical` 8）。加えて `updatedAt` / `expiresAt` が 24 文字であることを assert する。前提が崩れたらこのテストが赤になる |
| A4 | **単調性そのものの固定**: 合成 state と code について、`cardConstraintsPass(truncateReasonUnits(..., k))` が k について単調（k で通れば k−1 でも通る）であることを 0..`declaredLimit` の全 k で検査する。export した 2 関数を直接呼ぶ |
| A5 | **探索回数の固定**: `findEffectiveLimit` に**呼び出し回数を数える述語を直接渡して**、`declaredLimit = 128` で **8 回以下**（`⌈log2(129)⌉`）であることを固定する。時間ではなく回数で固定し、CI のノイズを避ける。**`vi.spyOn(module, "cardConstraintsPass")` で数えてはならない**——§4.2 のとおり module 内部呼び出しは差し替わらず、カウント 0 で緑になる |
| A6 | **golden 無改変**: `test/fixtures/vpwp50-forecast-expectations.json` の `groupShape129Reasons` / `twoTargets129Reasons` / `mixed129Reasons` が**一切改変されずに通る**こと。本 spec は上限を触らないので、`declaredLimit` / `effectiveLimit` / `limitingHierarchies` はすべて現行値のままである |
| A7 | `assertWeatherWarningForecastWireInvariant()` の throw 条件とメッセージが不変であること |
| A8 | 起動経路の非退行: `standby-persistence.ts:8925` を通る既存の bundle 正規化テストが緑であること |
| A9 | `npm run build` と `npm test` が緑 |
| A10 | `npm run test:shuffle` が緑（module スコープの関数 export を増やすため） |
| A11 | `npm --prefix display run build` と display 側テストが緑（本 spec は display を触らないので、非退行の確認のみ） |

### 6.2 実機で確認するもの（B・配送後・CI 対象外）

| # | 内容 |
|---|---|
| B1 | Pi で VPWP50 の合計 period が 128 を超えている状態のとき、display パイプラインの停止が観測されないこと。#13 で入れた sweep 計測のログで確認する |
| B2 | 再起動時、`standby-persistence.ts:8925` の bundle 正規化を含む起動時間が悪化していないこと |

### 6.3 スコープ外

- 上限値の引き上げ（`docs/specs/2026-09-09-vpwp50-periods-limit.md`）
- fail-closed 契約そのもの
- `effectiveLimit` を返すこと自体の是非（診断の設計）
- 表示側の回転設計

---

## 7. 裁定ラベル（6 要素・**🌙自走OK 候補**）

```
対象:
  src/engine/display/weather-warning-forecast-wire.ts
    （:302-308 の探索の関数抽出と二分探索化、:199 と :232 の export 化のみ）
  test/engine/display/ 配下の新規テスト（参照実装一致・単調性・述語呼び出し回数）
  docs/specs/2026-09-09-vpwp50-limit-search-binary.md（本 spec）

許容変更:
  effectiveLimit 探索を、述語を受け取る純関数
    findEffectiveLimit(declaredLimit, pass) として切り出して export する
    （テストが述語呼び出し回数を直接数えられるようにするため。§4.2）
  切り出した探索を線形（0..declaredLimit の 129 反復）から二分探索（8 反復）へ置換
  weatherWarningForecastProjectionLimitReasons の該当ループを
    findEffectiveLimit への委譲へ書き換える
  cardConstraintsPass と truncateReasonUnits を export する
    （シグネチャと挙動は不変。用途はテストのみ。本番コードからの新規呼び出しを足さない）
  上記を検証するテストの追加

禁止変更:
  weather-warning-forecast-wire.ts:10-17 の全定数（件数上限・byte 上限）
  Vpwp50ProjectionLimitReason の形と各フィールドの値
    （effectiveLimit の値が変わってはならない。golden fixture が無改変で通ること）
  REASON_ORDER / isAncestorReason / weatherWarningForecastProjectionLimitReasonsShallow
  assertWeatherWarningForecastWireInvariant の throw 条件とメッセージ
  呼び出し元 4 箇所（standby-state-store.ts:925 / :3479、
    standby-persistence.ts:3451 / :8925）
  reducer（weather-warning-forecast-active-reducer.ts）と store の受理経路
  fail-closed 契約（切り詰め・部分受理・他 subject eviction による救済を入れない）
  永続 schema / envelope / migration
  表示側（display/・ui/）のファイル
  package.json / package-lock.json
  data/runtime/ 配下の実データ

配送先: main → personal → Pi
  main へ push 後、GitHub Actions（Test workflow）の緑を配送条件に含める

ロールバック:
  main は該当 commit を git revert、personal は rebase 追従後に
  git push --force-with-lease private personal、Pi は
  git fetch origin personal && git reset --hard origin/personal で戻す
  永続データの手当ては不要（永続形式を触らない）

受入条件: §6.1 の A1〜A11 を全件。§6.2 の B1・B2 は配送後の Pi 観測で確認し、
  配送の前提条件にはしない。

裁定: 未裁定。製品挙動の変更と (c) 製品緩和を含まないため、🌙自走OK 候補とする。
```

---

## 8. 未検証・残るリスク

- **Pi での実測をしていない**。0.4〜0.9 秒は darwin 実測（90〜123 ms）からの外挿である。配送後に B1 で観測する
- **§3.1 の実測は合成 state による**。実際の官署ごとの period 分布は §3.2（別 spec の §3.2）の実 fixture が平常時のものしかないため未確定
- **単調性は現状の実装に対する検証である**（§5）。A3 と A4 は前提が崩れたことを検出するが、崩れた場合の正しい対応（二分探索を戻すのか、byte 計算を単調化するのか）は本 spec では決めない

---

## 改訂履歴

- **2026-09-09 実装（base `592e5d2`）**: §4.1 のとおり `findEffectiveLimit(declaredLimit, pass)` を切り出して二分探索化し、`cardConstraintsPass` / `truncateReasonUnits` を export した。受入 A1〜A11 は全件緑。同一 probe での実測は 3×50 が 41.2 → 3.3 ms、5×40 が 51.7 → 3.9 ms、20×10 が 63.8 → 4.8 ms（darwin・`dist/` 直 require・5 回中央値）。絶対値が初版起草時の 90〜123 ms より小さいのは probe の合成 state が軽いためで、削減比は約 12〜13 倍。`effectiveLimit` の値は before / after で同一だった。なお live 経路の呼び出しは base `592e5d2` では `standby-state-store.ts:927`（§3.3 の表と §7 の禁止変更は `:925` と書いているが、これは基準 SHA `fb67852` の行番号）
- **2026-09-09 scoped 再確認の反映（fix 2 件）**: A5 の `vi.spyOn(module, "cardConstraintsPass")` 案が**空洞化する**ことが判明したため（`dist/engine/display/weather-warning-forecast-wire.js:255` を実読し、module 内部呼び出しが bare local binding で残ることを確認。export を足しても差し替わらず、spy はカウント 0 のまま「8 回以下」を満たして緑になる）、探索を述語受け取りの純関数 `findEffectiveLimit(declaredLimit, pass)` として切り出す設計へ変更した。§4.1 を関数抽出込みに書き直し、§4.2 に spy が効かない理由を新設、A2 と A5 を述語ベースへ、§4.0 の「触る行」と §7 の対象・許容変更へ関数抽出と export を追記。復元経路の呼び出し行を `:3410` から **`:3479`**（`restoreActiveStateInternal` 内の try ブロック、`standby-state-store.ts` を実読して確認）へ §3.3 の表と §7 の禁止変更の 2 箇所で訂正
- **2026-09-09 初版**（Liebe 起草、HEAD `fb67852`）。独立レビューの H3・M2 を受けて、当初 `2026-09-09-vpwp50-periods-limit.md` の同伴修正として書いていたものを単独 spec へ分離した。分離にあたり、reducer 拒否経路がこの探索を通らないこと（`standby-state-store.ts:872-912` の実読）を確認し、実際にコストを払う経路を横断集計（`periodsPerCard`）と起動時 bundle 正規化に訂正した。時間の実測を 3 構成で採り直した（90.0 / 113.9 / 122.6 ms）。M1 の単調性依存を §5 として独立させ、`severityRank` の rank 順と文字列長順の一致を受入条件（A3）へ入れた
