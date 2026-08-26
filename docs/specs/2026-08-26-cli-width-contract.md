# spec: CLI 幅規約（width contract）（draft v0.1, 2026-08-26）

> 状態: 起草。§ 8 の D1–D4 はご主人の裁定待ちであり、本 spec は推奨案を既決と扱わない。

## § 1. 背景と目的

先行監査の High A2 / A3 を、「各フォーマッタがたまたま収まる」ではなく CLI 全体の幅契約として閉じる。

- **A2（compact 要約）**: `fitTokensToWidth()` は priority 4 → 2 の `drop` と `shortText` への置換後に再検査しない。priority 0 の長い津波 headline、火山名、電文名、qualifier だけでも `maxWidth` を超える。
- **A3（フレーム）**: `frameLine()` / `frameLineColored()` は超過時に右 padding を 0 にするだけで、本文を折返しも切詰めもしない。正式に許可される最小幅 40 で可変のタイトル・地域名・種別・診断文が右枠を押し出す。

目標は、入力長や ANSI 色の有無に依存せず、指定幅を超える物理行を生成しないことだ。本 spec は parser や電文の情報選択は変更しない。

## § 2. 用語と幅の基準

- **論理幅**: `visualWidth()` で測る現行実装上の幅。ANSI エスケープは 0、日本語全角文字は現行の判定に従う。JavaScript の `string.length` は幅判定に使わない。
- **外幅 `W`**: 上下左右の枠を含むフレーム 1 行の指定幅。契約対象は**整数 40–200**に限定する。
- **内幅 `I`**: `max(0, W - 4)`。左右枠とその内側スペース各 1 幅を除いた本文予算。
- **要約幅 `M`**: `fitTokensToWidth(tokens, maxWidth)` の `maxWidth`。枠なしの要約文字列自体の予算であり、`W - 4` と自動的に同一視しない。
- **物理行**: stdout 上の改行 1 本で分かれる行。入力内の CR/LF は段落境界であり、1 本の枠に生改行を埋め込まない。

## § 3. 幅契約

### 3.1 compact 要約の契約

`fitTokensToWidth(tokens, M)` は、任意の入力と `M >= 0` に対し、次を満たす。

1. 戻り値は改行を含まない 1 行で、`visualWidth(result) <= M`。`M = 0` では空文字列。
2. priority は小さい数ほど重要とする。落とす候補は 4 → 1、同 priority では後方 token → 前方 token の安定順とし、先頭側の識別情報を優先する。priority 0 は通常の drop 対象にしない。
3. 幅判定は `preferredWidth` / `minWidth` の申告値だけに依存せず、各変形後の実文字列を `visualWidth()` で再計測する。
4. 変形の段階は「preferred 表示 → 低優先の `drop` を 1 token ずつ除外 → 残った `shorten` を低優先から適用 → 必須 token 群の最終縮退」とし、各段階で再計測する。
5. `shortText` が未指定、空、または元より広い場合は有効な短縮と数えない。最終的な契約達成は D1 の裁定にかかわらず必須である。
6. ANSI スタイルは幅に数えず、切断する場合も不正な escape 片を残さない。

`SummaryToken.minWidth` は選択の hint に留め、出力幅の証明に使わない。これにより、津波 `bannerKind`、火山 `type` / `volcanoName`、legacy counterpart `type` / `qualifier`、raw `type` が長くても契約を破らない。

### 3.2 フレームの契約

契約範囲の整数 `W = 40..200` で生成するすべての枠付き物理行は次を満たす。

1. `visualWidth(stripAnsi(line)) === W`。右枠は論理幅 W の末尾にあり、本文に押し出されない。
2. 本文の各物理行は `visualWidth(content) <= I`。長い論理行は用途ポリシーに従って折返し、短縮、または最終省略する。
3. 電文・parser ・設定・診断から来る可変文字列を `frameLine*` へ直接渡さない。固定リテラル、空行、事前に幅を証明する table / banner builder の出力のみ直接呼び出しを許す。
4. `frameTop*` / `frameDivider*` / `frameBottom*` も同じ W を使い、1 つのフレーム内で幅を混在させない。

`W < 40` または `W > 200` は best-effort であり、本 spec の幅保証・受入条件の対象外とする。compact 要約の `M` は 0 まで別途支持する。

## § 4. 共通経路と既存 wrap 資産

### 4.1 既存資産の位置づけ

`wrapFrameLines()` / `wrapFrameLinesColored()` は作り直さず、幅契約の中核とする。両者は共通の `wrapFrameLinesWith()` を通り、次の現行資産を保持する。

- `visualWidth()` による ANSI-aware / 日本語表示幅基準
- CRLF / LF の段落分割、空段落の保持
- `, ` / ` | ` / `  │  ` / ` / ` の soft wrap、分割不能時の hard wrap
- hanging indent と極端な indent の縮退ガード
- `wrapFrameLinesColored()` の枠色注入、delimiter 経路での本文 ANSI 保持

ただし、現行の hard-wrap fallback は本文を `stripAnsi()` する。これは幅安全性には寄与するが、色保持の完全契約ではない。本移行では「ANSI 片を壊さない」を必須とし、hard wrap 時の本文色完全保持は別改修としてもよい。その場合は現行制限を test と API comment に残す。

### 4.2 用途別 push API

フォーマッタが `for (const line of wrapFrameLines*) buf.push(line)` を個別実装しないよう、`formatter.ts` に共通 `pushWrappedFrameLine` を設ける。実装時の具体的な overload / options 名は型レビューで調整可だが、次の意味は変えない。

```ts
type FrameLinePurpose = "title" | "region" | "type" | "headline" | "diagnostic" | "prose";

interface FrameLinePart {
  text: string;
  priority: 0 | 1 | 2 | 3 | 4;
  shortText?: string;
  omission: "never" | "shorten" | "drop";
}
```

- API は `RenderBuffer`、level、W、purpose、論理文または `FrameLinePart[]`、任意の borderColor / indent を受け、0 本以上の契約適合済み物理行を push する。無色・色付きの折返しロジックは分岐させない。
- `region` / `headline` / `prose` / 通常の `diagnostic` は原則として全文折返し。文字列を黙って捨てない。
- `title` / `type` など複合行は part を元の表示順で保ちつつ priority で残す順を決め、入らない低優先 part を次の物理行へ送る。同じ予算に複数 part を戻し入れる最適化はしない。安定順と読みやすさを優先する。
- 用途ごとの行数上限と最終省略は D4 の裁定に従う。いずれの案でも各物理行の幅契約は必ず守る。
- 固定文言だけの行は `frameLine*` を直接呼び続けてよい。ただし D2=A の最終防衛はその呼び出しにも適用される。

## § 5. A2 移行詳細

1. `width-fit.ts` の最終行に必ず幅再検査を置き、「契約違反の文字列を return しない」を単一出口で保証する。
2. priority 4–1 の `drop` を 1 token ずつ安定順に除外し、除外ごとに separator 込み実幅を再計測する。一括 `filter()` で同 priority を全て捨てない。
3. 残る `shorten` は priority 4 → 0、同 priority は後方 → 前方に 1 token ずつ適用する。適用後も必ず再計測する。
4. `token-builders.ts` で priority 0 の可変 token を棚卸しする。少なくとも tsunami `bannerKind`、volcano `type` / `volcanoName`、legacy counterpart `type` / `qualifier`、raw `type` を D1 の方針で更新する。
5. separator も予算に含め、先頭・末尾・連続 separator を出さない。空 token は builder 側で作らないか fitter で除外する。

## § 6. A3 の全直呼び棚卸しと移行対象

`src/ui` で `frameLine()` / `frameLineColored()` を直接呼ぶ **30 ファイル**を、次の三分類で固定する。分類は「この時点の実コードで全直呼びがどの防衛経路を通るか」であり、ファイル名だけの allowlist ではない。

- **固定文字列**: 可変入力を渡さない直呼びだけ。新たに可変値を加える時点で移行対象になる。
- **幅証明済み**: `wrapFrameLines*`、`wrapTextLines`、`clampFrameContent`、table engine 等が、直呼び前に論理幅 `I` 以下を証明する。
- **移行対象**: parser / 電文 / 設定 / 診断由来の可変値が直渡しされ得る。`pushWrappedFrameLine` または用途別の幅証明済み builder へ置換する。

| ファイル | 分類 | 直呼びの扱い / 移行する用途 |
|---|---|---|
| `briefing-formatter.ts` | 固定文字列 + 移行対象 | 複合 title、`info.title`、対象地域、観測・予測の場所、parser diagnostic |
| `climate-info-formatter.ts` | 固定文字列 + 移行対象 | 複合 title、取消ラベル、対象地域、本文種別見出し、観測期間、headline / prose |
| `early-weather-formatter.ts` | 固定文字列 + 移行対象 | 複合 title、`info.title`、tag、対象地域、対象期間、現象見出し、prose |
| `earthquake-info-formatter.ts` | 幅証明済み | title / card は `clampFrameContent`、headline / 地域は `wrapFrameLines` |
| `eew-formatter.ts` | 固定文字列 + 移行対象 | 取消分岐の `info.infoType`、`eventId` を含む識別 / diagnostic 行（監査指摘 :535, :659, :705）。card・table・wrap 済み行は既存経路を維持 |
| `flood-forecast-formatter.ts` | 固定文字列 + 移行対象 | `titleHead` / `titleFull`、河川・地域・観測所見出し、`info.notice`、本文・省略 / diagnostic 行（監査指摘 :71, :193, :247, :629 を含む） |
| `formatter.ts` | 幅証明済み | primitive 本体。D2 の最終 clamp と clamp 発動カウンタをここに置く |
| `frame-table-builder.ts` | 幅証明済み | table overflow probe 後の `renderFrameTable`、fallback は `wrapFrameLines*`、空行だけ直接描画 |
| `heat-alert-formatter.ts` | 固定文字列 + 移行対象 | 複合 title、対象府県、電文 title、本文 prose |
| `legacy-counterpart-formatter.ts` | 固定文字列 + 移行対象 | control title + info type + severity、電文 title、qualifier、地域 / 現象 / 種別 code-name |
| `lg-observation-formatter.ts` | 幅証明済み | title / card は clamp、headline・本文・URI は wrap |
| `nankai-trough-formatter.ts` | 幅証明済み | banner / title / card は clip / clamp、headline・次報は wrap |
| `responsive-table-engine.ts` | 幅証明済み | `clampFrameContent` と cell clip / pad を通る共通 engine |
| `seismic-text-formatter.ts` | 幅証明済み | title は clamp、本文は `highlightAndWrap` / wrap 経路 |
| `statistics-formatter.ts` | 固定文字列 + 移行対象 | 動的に組む統計行。幅上限 200 に clamp した後も可変行を直渡しするため、200 超過時の契約証明がない |
| `tornado-formatter.ts` | 固定文字列 + 移行対象 | 複合 title、電文 title、summary parts、layer type、地域・省略 diagnostic |
| `tsunami-formatter.ts` | 幅証明済み | banner / title / card は clip / clamp、headline・地域は wrap |
| `typhoon-analysis-formatter.ts` | 固定文字列 + 移行対象 | 台風名を含む title、実況 / 予報見出し、地点・診断行（監査指摘 :76 を含む） |
| `typhoon-probability-formatter.ts` | 固定文字列 + 移行対象 | 台風名 title、地域名、確率内訳、空状態の name label、diagnostic（監査指摘 :57, :137, :159, :268 を含む） |
| `volcano-formatter.ts` | 幅証明済み | title / card は clamp、本文は reflow / highlight / wrap 後に直接描画 |
| `vpwp50-detail-formatter.ts` | 固定文字列 + 移行対象 | detail title、対象地域、未知 code の地域 / property / diagnostic。table 行は既存 table builder を維持 |
| `weather-core-action-guide.ts` | 幅証明済み | `wrapTextLines(width - 4)` 後だけ直接描画 |
| `weather-core-detail.ts` | 幅証明済み | `wrapTextLines(width - 4)` 後だけ直接描画 |
| `weather-core-formatter.ts` | 固定文字列 + 移行対象 | `info.title` のみを clip しても可変 `infoType` を含む `titleSuffix` と合成した title 全体は証明されない（:85, :88、`titleBudget` 最低 4 の復帰を含む）。suffix 込み title、地域 / type / diagnostic を移行し、table / banner の既存証明経路は維持 |
| `weather-core-table.ts` | 幅証明済み | cell ごとの clip / pad 後に直接描画 |
| `weather-core-tail-blocks.ts` | 幅証明済み | unknown code / comment は `wrapTextLines(width - 4)` 後に直接描画 |
| `weather-explanation-formatter.ts` | 固定文字列 + 移行対象 | 複合 title、電文 title、control / section / group / prediction 見出し、tag、対象地域、headline、診断文 |
| `weather-formatter-vpws50.ts` | 固定文字列 + 移行対象 | `bodyLine()` 経由の可変本文・地域・type / diagnostic。既存 `bodyWrap()` は維持し、直行だけを置換 |
| `weather-formatter.ts` | 固定文字列 + 移行対象 | colored / plain 両経路の複合 title・電文 title、summary parts、layer / comment type、地域、headline / diagnostic |
| `weather-warning-timeseries-formatter.ts` | 固定文字列 + 移行対象 | table header / cell、compact fallback summary、unknown code 連結、area count、raw fallback diagnostic（監査指摘 :664 header・:817 を含む） |

移行対象は **17 ファイル**である。固定文字列・幅証明済みの分類も永久の例外ではない。集合照合は混ぜない。① `src/ui` の AST で抽出した直呼び source 30 ファイルと §6 表のファイル列を exact-set-equal、② dispatcher entry formatter 集合と formatter test registry を exact-set-equal、と別々に検査する。補助 module を含む前者と、entry formatter だけを持つ後者を比較しない。新規 formatter・新規直呼び・分類変更は対応する表または registry の同時更新を必須にする。`clampFrameContent()` は「省略を意図した用途」にだけ使い、地域・headline・prose・period・qualifier・parser diagnostic・code-name 見出しを機械的に clip 経路へ流用しない。

## § 7. 導入単位と順序

D3 の裁定前に一括 / 縦切りを確定しない。推奨する縦切り案の依存順は次のとおり。各単位は対応 test と幅 40 / 60 / 80 / 120 / 200 の行幅 matrix を同時に入れ、次へ進む。

1. **基盤**: `fitTokensToWidth()` の最終契約、安定優先順、幅 assertion helper、`pushWrappedFrameLine`。D2=A ならここで `frameLine*` の最終防衛も入れる。
2. **基本気象・地震系**: `weather-formatter.ts` の plain / colored 両経路、`weather-core-formatter.ts`、`weather-formatter-vpws50.ts`、`tornado-formatter.ts`、`heat-alert-formatter.ts`、`eew-formatter.ts`。同型の title / region / type、suffix 込み title、bodyLine / eventId 直渡しを先に固める。
3. **解説・長文・表系**: `briefing-formatter.ts`、`weather-explanation-formatter.ts`、`weather-warning-timeseries-formatter.ts`、`flood-forecast-formatter.ts`。headline / prose / parser diagnostic / table header・cell / 複数地域の全文 wrap を固める。
4. **長期・旧形式・台風・detail 系**: `early-weather-formatter.ts`、`climate-info-formatter.ts`、`legacy-counterpart-formatter.ts`、`typhoon-analysis-formatter.ts`、`typhoon-probability-formatter.ts`、`vpwp50-detail-formatter.ts`、`statistics-formatter.ts`。長い電文名・期間・qualifier・未知 code/name・動的統計行を含める。
5. **全体ゲート**: §6 表と AST 抽出の直呼び source 30 ファイル、dispatcher entry formatter と formatter test registry を、それぞれ別の exact-set-equal で照合する。全移行対象 formatter 出力を上記幅 matrix で検査し、要約と枠の契約違反、primitive clamp fallback 発動を 0 にする。共有の幅状態を使うため shuffle を必須とする。

単位 2–4 は各々 review 可能な停止点である。単位の途中で「新 helper と旧直渡し」が混在する期間は、D2=A または test gate により外幅契約を維持する。

## § 8. 裁定待ちの分岐

### D1: priority 0 可変 token の縮退

- **案 A: ドメイン短縮形 + 最終末尾省略**。津波種別、火山電文名、qualifier 等に意味を保つ `shortText` を持たせ、それでも入らない極小幅だけ ANSI-safe な `…` で頭打ちする。
- **案 B: 共通の末尾省略のみ**。必須 token に短縮辞書を持たせず、残予算まで一律に切る。
- **推奨: A**。通常の論理幅 40 付近では「どの警報 / 電文か」を保て、予算が短縮形より狭い場合だけ契約を優先するためだ。

### D2: `frameLine` / `frameLineColored` の後方互換

- **案 A: primitive 自体に最終 clamp を持たせる**。本文が I を超えた場合は ANSI-safe に末尾省略し、常に右枠を論理幅 W の末尾に戻す。可変文字列の直渡し禁止は、情報喪失を防ぐ上位規約として併存する。
- **案 B: primitive は現行の pad-only を保つ**。呼び出し側 wrapper と全体出力 test のみで幅を保証する。
- **推奨: A**。移行漏れ、将来の新 formatter、動的診断文に対する最終防衛になる。出力変更はすでに契約違反している行に限られる。

### D3: 17 移行対象フォーマッタの導入単位

- **案 A: § 7 の縦切り**。基盤の後に 3 系統へ分け、各 patch で formatter test と幅 matrix を完結させる。
- **案 B: 基盤 + 17 フォーマッタを一括移行**。新旧混在期間はないが、snapshot 差分と回帰調査が一度に集中する。
- **推奨: A**。受入条件を系統ごとに証明でき、色付き / plain、長文 / 複合 title の回帰範囲を狭められる。D2=A なら移行中も外幅は守られる。

### D4: title / type の複数行上限

- **案 A: 2 行上限 + priority 縮退**。タイトル本体を優先し、info type / severity / qualifier を 2 行目へ送る。2 行でも入らなければ `shortText` →低優先 drop →最終省略とする。region / headline / prose は上限なしのまま。
- **案 B: title / type も上限なしの全文 wrap**。情報は失わないが、長い電文名で header が大きくなる。
- **推奨: A**。CLI の一覧性を保ちつつ、地域・headline・診断文の全文は本文側に残せるためだ。

#### D4-diagnostic: diagnostic の件数・行数制限

- **案 A: 無制限の全文 wrap**。parser diagnostic、unknown code、code-name 見出しを含む各 diagnostic を省略せず `pushWrappedFrameLine` で出す。
- **案 B: 用途別の件数または行数上限**。上限を超えた diagnostic は優先度順に集約し、`… 他 N 件` と明示する。上限値、集約単位、全件の復元先を同時に決める。
- **推奨: A**。この spec の範囲では parser fail-open の理由を黙って隠さず、幅問題だけを解く。出力量を抑える必要が生じた場合は、復元経路を伴う別裁定で B を選ぶ。

## § 9. 違反の検出と回帰防止

### 9.1 unit / property matrix

- `fitTokensToWidth`: M = 0, 1, 4, 10, 36, 40, 60, 80, 200。ASCII、全角、emoji、ANSI、空文字列、単一の過長 priority 0、複数 priority、不正な `shortText` 申告を表駆動で生成し、全例で `visualWidth(result) <= M` を検査する。落とし / 短縮の安定順も文字列で検査する。
- frame primitives / wrapper: W = 40, 60, 80, 120, 200。全物理行が正確に W、右枠が末尾、生 CR/LF が枠内に残らないことを検査する。colored は ANSI 片の完全性と無色版との幾何同値も検査する。
- §6 の各移行対象 formatter: 通常 fixture に加え、**各 formatter の各適用可能用途**（title、region、type、headline、prose、period、qualifier、parser diagnostic、code-name 見出し、table header / cell を含む）の過長 synthetic fixture を 1 つ以上持つ。全 stdout 物理行に対し `visualWidth(stripAnsi(line)) <= W`、枠行に対し `=== W` を検査する。

### 9.2 ゲート

- 共通 test helper は幅超過時に formatter 名、W、実幅、ANSI 除去後の問題行を失敗メッセージに出す。
- `test/ui/width-contract.test.ts` を全体ゲートとし、新規 formatter または新規可変行を追加する際に対象サンプルの登録を必須とする。source-text の脆い regex だけで「固定文字列か」を判定せず、実際の出力幅で破る。
- **D2 の選択にかかわらず**、可変文字列の `frameLine*` 直呼びを検出する AST ベースの静的 test を blocking gate とする。静的 test は §6 の三分類と照合し、固定文字列・幅証明済み・移行対象以外を許さない。
- D2=A の primitive clamp は最終防衛であって通過条件ではない。test ごとに reset できる clamp 発動カウンタ（または同等の注入 hook）を公開し、契約範囲 W=40–200 の formatter matrix では発動回数 **0** を要求する。発動した場合は、出力幅が収まっていても静的 gate とともに失敗とする。
- **直呼び source 棚卸し**: `src/ui` を AST で走査した `frameLine*` 直呼び source 30 ファイルと、§6 表のファイル列を exact-set-equal で照合する。補助 module を含め、未分類直呼びまたは表だけの幽霊行があれば失敗する。
- **entry formatter 到達性**: dispatcher entry formatter 集合と formatter test registry を exact-set-equal で照合する。entry に新規 formatter が増え、対応する synthetic fixture / test registry が未登録なら失敗する。これは前項の30ファイル集合とは比較しない。

## § 10. 受入条件

### 機械的チェックリスト

- [ ] D1–D4 および D4-diagnostic が裁定され、採用案だけが規範本文と test 名に反映されている。
- [ ] `fitTokensToWidth()` の全 return 経路で `visualWidth(result) <= M`。過長 priority 0 単体と M = 0 / 1 を含む。
- [ ] 優先順の同じ入力は常に同じ token を残し、separator 込みで M を超えない。
- [ ] plain / colored の wrap 出力と frame primitive の全物理行が整数 W = 40 / 60 / 80 / 120 / 200 で契約適合し、ANSI 片や右枠欠落がない。W=40 未満は best-effort としてこの assertion の対象外である。
- [ ] §6 の各移行対象 formatter の**各適用可能用途**（title / region / type / headline / prose / period / qualifier / parser diagnostic / code-name 見出し / table header・cell を含む）に過長 synthetic 回帰 test がある。`weather-formatter.ts` は plain / colored 両方を検査する。
- [ ] 可変文字列の `frameLine*` 直渡しが新規に入った場合、D2 の選択にかかわらず AST 静的ゲートが失敗する。D2=A の clamp fallback 発動回数も全 formatter matrix で 0 である。
- [ ] AST 抽出した `src/ui` の直呼び source 30 ファイルと §6 表のファイル列が exact-set-equal である。補助 module を含む未分類直呼びまたは表だけの幽霊行があれば失敗する。
- [ ] dispatcher entry formatter 集合と formatter test registry が exact-set-equal である。新規 entry formatter、未登録 synthetic fixture、未登録用途があれば失敗する。この集合を §6 の30ファイル集合と比較しない。
- [ ] 現行 snapshot の差分は「幅違反行の折返し / 短縮 / 省略」と裁定された title 複数行化に限られ、固定文言の安定出力は不変。
- [ ] 次のコマンドがすべて exit 0。

```sh
npm run build
npm test -- test/ui/summary/width-fit.test.ts test/ui/formatter.test.ts test/ui/formatter-colored.test.ts test/ui/width-contract.test.ts
npm test
npm run test:shuffle
npm run typecheck:test
git diff --check
git diff --no-index --check /dev/null docs/specs/2026-08-26-cli-width-contract.md || test $? -eq 1
```

`git diff --check` は変更対象全体の tracked diff を検査する。未追跡ファイルは diff に含まれないため、対象となる各未追跡ファイルを `git diff --no-index --check /dev/null <file>` で別途検査する（上記は本 spec 自身の例。exit 1 は差分の存在なので成功として扱う）。`npm test` は全移行対象 formatter の個別 test（未整備の formatter はその移行 patch で追加）も含む。共有の frame width キャッシュと色状態を触るため `npm run test:shuffle` を省略しない。`npm run typecheck:test` は新規 fixture / helper の型違反を検出する blocking gate である。

## § 11. 既知の制限と将来課題

- 本 spec が保証するのは `visualWidth()` の**論理幅**であり、個々の terminal emulator における実表示列数ではない。emoji、結合文字、ZWJ sequence、ambiguous-width 文字は terminal・font・locale により表示幅が異なり得る。したがって、これらの実 terminal 幅ずれは本 spec の受入対象外である。
- `visualWidth()` を `string-width` 相当の Unicode 幅実装へ更新するか、terminal / locale 別の幅契約を導入するかは、既存出力の互換性・fixture・table 配分へ広く影響する。これは**将来の別 spec 候補**とし、本 spec の A2 / A3 修正には混ぜない。
- 現行 `wrapFrameLines*` の hard-wrap fallback は本文 ANSI を `stripAnsi()` する。幅は守るが、hard wrap 時の本文色完全保持は別改修候補である。
- W=40 未満と W=200 超過は best-effort である。呼び出し側がその範囲を正式に許可する場合は、別途入力正規化と受入 matrix を定義する。
