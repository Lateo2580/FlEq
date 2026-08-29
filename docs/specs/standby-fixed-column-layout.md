# spec: 待機画面カードのカテゴリ固定配置（平常時）と高さバランシングの条件付き切り替え

- 状態: v1.0（spec レビュー 1 巡 + 実装 + 独立レビュー反映済み・配送版）
- 対象ブランチ: main（公開一般改善）
- 起点 SHA: 3355201

## 1. 背景・目的

待機画面（StandbyScreen）は現在、津波・地震カードのみ左カラム固定（`LEFT_KEYS`）で、
それ以外のカード（weather / briefing / flood / typhoon / volcano / heat）は
高さ実測に基づく全探索ソルバ（`makeColumnPlan()`）が左右へ効率配置している。

そのため平常時（カードが少なく高さに余裕があるとき）でも、気象系カードが
左カラムに現れることがあり、視線の定位置が安定しない。

要望（ご主人裁定 2026-08-29）:

- **平常時は従来どおり「左＝地震・津波系、右＝気象系ほか」の固定配置**にする
- **カード数・高さが増えて固定配置では収まらないときに限って**、既存の
  高さバランシング配置へ切り替える

## 2. 設計

数のしきい値は導入しない。既存の高さ実測をそのまま使う。

### 2.1 固定配置案（fixed plan）の定義

- 左: `LEFT_KEYS`（`tsunami`, `quake`）に該当する候補、canonical order 保持
- 右: **それ以外の全候補**（補集合定義。明示的な右キー集合は作らない——
  将来 `CardKey` が増えても黙って落ちない）、canonical order 保持
- 中央: 使わない（stage 0 と同じ）。ただし fit 判定には既存の
  `placementTotalOverflow()` と同じ計算を使い、`centerFixedHeightPx`
  （固定クラスタ）を必ず含める
- fit 判定は既存と同一: `height + (n - 1) * gap <= capacity` を左右両カラムで
  満たし、総 overflow ゼロ

### 2.2 挿入点と評価順序

挿入点は `makeColumnPlan()`（solver.ts:385 付近）の stage-0 内部。
stage-0 が現在持つ詳細レベル再試行階梯（typhoon full → 収まらなければ
typhoon compact で再探索）の**各段の先頭で fixed plan を先に評価**する:

1. fixed（typhoon full）が収まる → 採用
2. 収まらなければ既存 `enumeratePlacements()`（typhoon full）
3. それも収まらなければ fixed（typhoon compact）
4. 最後に既存の全探索（typhoon compact）→ stage 1〜3 へ

quake/weather の初期 compact 等、stage-0 の既存の詳細レベル初期値は
fixed 評価でもそのまま使う。fixed 採用後の `promoteAndExpand()`
（flood wide / typhoon full / 追加行の実測内昇格）は従来どおり適用する
（配置は固定のまま、収まる範囲の情報量拡張は歓迎）。

コンポーネント側（`automaticPlan()`）では分岐しない。

### 2.3 previousPlan 安定化との優先関係

- **stage-0 の計画時、fixed plan が収まるなら previousPlan の保持規則
  （solver.ts:269 付近）より fixed を優先する**。バランシング配置が
  「収まっている」ことを理由に温存されることはない
- fixed が収まらず全探索へ進んだ後は、従来どおり previousPlan 安定化が効く
- **既存の安定化テスト 3 件（solver.test.ts:63-75, 107-120, 123-136 相当、
  weather/volcano を左に残す期待）は本仕様変更により期待値を意図的に更新する**。
  「既存テスト全緑のまま」ではなく「仕様変更として期待値を書き換える」が正

### 2.4 stage 復帰（floorStage / ヒステリシス）は変更しない

コンポーネントは committed stage を `floorStage` として維持し、
geometry-only の変化では降格しないヒステリシスを持つ
（StandbyScreen.svelte:846-869, 1570-1585, 1740-1756）。本機能は
**この復帰規則に手を入れない**。stage 1〜3 からの復帰タイミングは従来どおり
（content 更新・既存ヒステリシス越え）で、**復帰して stage-0 計画が
走った瞬間に fixed plan が優先評価される**ことで平常時配置へ戻る。
既存の geometry-only 非降格テスト（standby.test.ts:1444-1469）は緑のまま。

### 2.5 左カラム単独 overflow

`LEFT_KEYS` は全 stage で左固定のため、tsunami/quake だけで左が溢れる場合は
fixed でも全探索でも解消できない。この場合の挙動（stage 進行・圧縮・
unresolved）は**既存のまま変更しない**。テストで「fixed 不採用 →
既存経路へフォールスルー」を確認する。

### 2.6 フラッピング

fixed plan は決定的（同じ候補集合・同じ実測なら常に同一配置）。
fixed ⇔ balancing の境界振動は実測が振動しない限り起きず、stage 復帰側は
既存ヒステリシスが守る。追加のヒステリシスは入れない
（実機で振動が観測されたら別途）。

## 3. 非対象（やらないこと）

- 中央カラム・輪番・圧縮ロジック・stage 復帰規則の変更
- カード順序（canonical order）の変更
- protocol の `surface`（corner-right 等）の変更・再利用
- 設定ファイルによる配置カスタマイズ
- 件数ベースのしきい値・追加ヒステリシス

## 4. テスト計画

solver 単体（`__tests__/solver.test.ts`）:

1. 全カードが収まる高さ → fixed 採用（left = tsunami/quake のみ、
   right = その他全部、canonical order）
2. 右カラムが overflow する高さ → 既存バランシング結果（気象系が左に移れる）
3. previousPlan がバランシング配置・候補集合不変・fixed が fit →
   fixed へ復帰する（安定化より優先）
4. previousPlan.center に weather 等がある・候補集合不変・fixed が fit →
   fixed へ復帰する
5. 境界: 右カラム合計がちょうど capacity（gap 込み）→ fixed 採用、
   +1px → フォールバック
6. typhoon full では fixed 不成立・全探索なら full で収まる →
   全探索（full）が選ばれる（§2.2 の評価順序）
7. 左カラム（tsunami+quake）単独 overflow → fixed 不採用、既存経路へ
8. `candidates: []` かつ `centerFixedHeightPx > capacity` →
   既存の overflow 経路が壊れない
9. 既存安定化テスト 3 件の期待値を仕様変更として更新
10b. preview 既存テスト 2 件（legacy-improved-mock.test.ts の
    counterfixture / row-prefix boundary "all"）も共有 solver の仕様変更の
    帰結として期待値を更新する（fixture の高さ・容量から導出根拠をコメントで示す）

画面統合（`standby.test.ts`）:

10. 全カード収容時: `data-placement-left/right` で left = tsunami/quake、
    right = その他を機械確認
11. 右 overflow 時: バランシング配置が描画されることを同属性で確認
12. 既存の左固定テスト（standby.test.ts:758 付近）・stage 系・
    geometry-only 非降格テストが緑のまま

## 5. 受入条件

- [ ] `npm run build` 成功
- [ ] `npm test` 全緑（§4 の期待値更新 3 件を含む）
- [ ] §4 テスト 1〜8, 10, 11 が新規追加され緑
- [ ] 既存テストの期待値変更は §4-9 の solver 3 件と §4-10b の preview 2 件のみ
      （それ以外の既存テストは無改変で緑）
- [ ] diff が allowed_paths 内: display/frontend/src/lib/legacy-standby/**、
      display/frontend/src/components/__tests__/**、
      display/frontend/src/preview/__tests__/legacy-improved-mock.test.ts、docs/specs/**
      （StandbyScreen.svelte は原則触らない。必要になったら blocked 報告で理由を返す）
- [ ] docs/specs/ に本 spec を最終版として同梱
