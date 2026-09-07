# VPWS50 stale current 自己ロックの解除 spec

> **裁定（2026-09-07 19:45、ご主人）**: §6 の 7 分岐は 6-1〜6-7 すべて A（T=30 分／再同期は要約 1 行＋現況再掲／通知 info／gate は holder 側限定／脱出時 history クリア／restore 時 prune あり／fixture は匿名化して main）。本 spec は実装 spec として有効。対応 Issue #17（#11 同時対処）。
>
> **訂正履歴 (a) 測定事実の訂正**
> - **2026-09-07（実装後の独立レビュー）**: §3.2 の prune 対象から `partialStreams` を外した。`partialStreams` は表示 overlay だけでなく、次の部分報の解除範囲を決める台帳（`mergePartialWithDisplay()` の `ownedPhenomena` 復元）でもあり、消すと kind code 00 の解除報が base 側の現象を解除できなくなる。prune は `partialHistory` / `restoredPartialSubjects` に限る。§3.2 と §4.10 を書き換えた。

> **対応 issue**: **GitHub Issue #17**（本件。VPWS50 の全国報 8 日間恒久拒否）。§5 は #17 の完了条件チェックリストと対応させる（§5.6 に対応表）。
> **同時に扱う既知 issue**: **GitHub Issue #11**（stale partial subject の容量保護）。同じ holder・同じ revision family の同一機序のため本 spec に統合する。#11 の筋書きと実状態のズレは §1.3 を見る。
> **関連 issue**: #13（5 秒 sweep の停止）。本件が状態肥大の原因だが、性能改善は #13 の独立 spec の仕事（§1.4 / §5.4）。
> **状態**: たたき台。§6 の判断分岐 7 件は未裁定。独立レビュー未実施。実装は裁定後。
> **対象 SHA**: `7aabcf251e5776b3aec3f0913bb623a5604036bc`（branch personal、Pi 稼働 SHA と同じ。main 基準 `a58a2f9`）

## 1. 症状

### 1.1 実機で確定している事実

Raspberry Pi（SHA `7aabcf2`、22.5h 連続稼働）で、全国気象警報 VPWS50 の定時再掲（10 分周期）が **2026-08-30 13:01 以降ずっと拒否され続けている**。CLI には毎報こう出る（`src/ui/weather-formatter-vpws50.ts:781-787`）。

```text
解析不能 — state を更新せず維持
⚠ 異常な解除率を検出しました
  入力電文の構造を確認してください
```

Pi から採取した永続状態のコピー（`scratchpad/pi-state/display-active-state-v2.json`、7,083,368 bytes、読み取り専用）を実測した値は次のとおり。

| 観測項目 | 値 |
|---|---|
| `telegramFoundation.vpws50.state.current.identity` | `reportDateTime=2026-08-30T13:00:00+09:00` / `serial=null` |
| `current.snapshot` の規模 | 1,080 区域 / 1,296 kind |
| `history` | 8 件（全件 2026-08-30 11:40〜12:50） |
| `partialStreams` | 128 件（`2026-08-30T12:00` 〜 `2026-09-07T19:02`） |
| うち current より新しいもの | **127 件** |
| partial の受信時刻分布（9/7 19:10 基準の経過日数） | 0 日 57 / 1 日 21 / 2 日 10 / 3 日 28 / 4 日 9 / 5 日 1 / 6 日 1 / 8 日 1 |
| `partialHistory` | 127 subject |
| `gateEntries` | 129 件（`weather:vpws50` 1 件 ＋ 官署別 partial 128 件）＝ family 上限と同数 |
| `gateEntries` の base entry の watermark | `2026-08-30T13:00:00+09:00`（**gate も 8/30 で止まっている**） |
| 同 base entry の `acceptedAtMs` | `1788062486713` ＝ `2026-08-30T13:01:26.713+09:00`（最後の受理） |
| partial entry の `acceptedAtMs` の範囲 | `2026-08-30T12:00:46` 〜 **`2026-09-07T19:02:48`**（partial は今日も受理され続けている） |
| `state` の内訳 | 合計 5.9MB（`history` 2.17MB / `partialHistory` 3.07MB / `partialStreams` 0.39MB / `current` 0.27MB） |

CLI 側は 2026-09-07 17:00〜19:20 の **15 報連続**の拒否を tmux で確認済み。ご主人の目視では 20 報以上（Issue #17）。

`gateEntries` の base watermark と `acceptedAtMs` がともに 8/30 13:01 で止まっている事実は、**拒否が gate 到達前で起きている**ことの直接証拠になる。`previewUnsafe()` は `decide()` より前に走り、unsafe なら `weatherStateMutationAccepted:false` で早期 return するため gate は前進しない（`src/engine/presentation/processors/process-weather.ts:201-227,229`）。

一方 partial（VPWW55/57-61）の `acceptedAtMs` は今日 19:02 まで伸びている。**Issue #17 本文の「partial の受理は 9/1 まで続いており」は実測と食い違う**（実測は 9/7 19:02:48 まで継続）。拒否されているのは全国 base だけで、partial は今も受理されている。したがって「129/129 で埋まっているせいで**新しい官署の**subject が入れない」のであって、既知 subject の更新は止まっていない。

### 1.2 表示に出ている実害

今日（2026-09-07）の SSE snapshot の `weatherAlerts` に、8 日前の警報が残っている。

- 「L4 土砂災害危険警報」福井市・大野市・勝山市ほか 9 区域 — **8/30 の base 由来**
- 「L4 大雨危険警報」鴨川市・南房総市 — 9/7 16:21 の partial 由来（これは正しい今日の警報）
- `updatedAt` は `2026-09-07T19:02:00+09:00`

つまり **8 日前の警報と今日の警報が同じカードに同じ鮮度で並び、更新時刻だけが今日を指している**。`getCurrentIdentity()` は base と partial の最新を返すため（`src/engine/messages/vpws50-state.ts:1315-1323`）、表示上の更新時刻は今日になる。

福井市の内訳を追うと機序が確定する。

| 出所 | 福井市（`1820100`）の内容 |
|---|---|
| base（8/30 13:00） | レベル４大雨危険警報 / レベル４土砂災害危険警報 / 雷注意報 |
| partial `weather:VPWW55:福井地方気象台`（9/3 18:44） | `areas` に kind 0 件、`clearedPhenomena` に `大雨` |
| partial `weather:VPWW61:福井地方気象台`（9/4 10:25） | `areas` に kind 0 件、`clearedPhenomena` に `雷` |

partial の解除は `clearedPhenomena` に載った現象しか消さない（`src/engine/messages/vpws50-state.ts:1004-1012`）。そして `mergePartialWithDisplay()` が解除 placeholder から作る `ownedPhenomena` は、**その partial stream 自身が直前報で持っていた kind と直前報の `clearedPhenomena` だけ**である（同 `:800-812`）。base だけが持つ現象は partial の解除対象に入らない。結果、`土砂災害` は base からしか消せず、base が凍結している限り **不死化する**。

### 1.3 Issue #11 との関係（重要な訂正）

Issue #11 は「全国 base より**古い** partial が容量保護されて新規 VPWW を拒否する」という筋書きで、対処として「base より古い partial を prune する」を挙げている。しかし本件の実状態では **128 件中 127 件が base より新しい**。base が凍結しているせいで、8 日前の partial すら「base より新しい」と判定される。

したがって **Issue #11 の修正方針だけでは Pi は 1 件しか prune できず回復しない**。§3.1 の stale 脱出で base を先に前進させてから prune するという順序が要る。逆に、gate が 129/129 で埋まっている影響（新しい官署の VPWW55/57-61 が `capacityExceeded` で恒久拒否される）は #11 の記述どおり現に成立している。

### 1.4 副次的な影響（本 spec の受入条件には入れない）

`state` 5.9MB は 5 秒ごとの sweep コスト（Pi 実測 1.0〜1.4 秒の停止）の主因になっている。ベンチでは history と partialHistory を空にすると no-op sweep が 219.5ms → 37.9ms へ落ちた（`~/Obsidian/Liebe/Session-log/2026-09/2026-09-07-fleq-performance-root-cause.md`）。本 spec の prune と history 整理はこの 5.2MB のうち大部分を落とすが、**性能改善は Issue #13 の独立 spec の仕事**であり、ここでは受入条件にしない（§5.4 で情報として計測だけする）。

## 2. 根因（file:line）

### 2.1 自己ロックの本体 — `unsafeReasonFor()` が current の古さを見ない

```ts
// src/engine/messages/vpws50-state.ts:1055-1074
private unsafeReasonFor(
  newSnap: Snapshot | null,
  info?: ParsedWeatherWarning,
): "layer_missing" | "abnormal_release_rate" | null {
  if (newSnap == null) return "layer_missing";
  if (this.current == null) return null;
  let actualReleased = 0;
  for (const [areaCode, prevArea] of this.current.areas) { /* ... */ }
  const remaining = countAreaKeys(newSnap);
  return remaining > 0
    && actualReleased >= ABNORMAL_UNEXPLAINED_RELEASE_MIN
    && (info == null || !hasExplicitReleasesForAllMissing(info, this.current, newSnap))
    ? "abnormal_release_rate"
    : null;
}
```

判定に使う入力は `this.current`（保持している state）と新報の 2 つだけで、**両者の時間差が一切考慮されていない**。定数は `ABNORMAL_UNEXPLAINED_RELEASE_MIN = 4`（同 `:37-39`）。

`hasExplicitReleasesForAllMissing()` は「消える既存 key はすべて同じ区域の解除 Kind で明示されている」ことを要求する（同 `:539-562`）。8 日前の 1,296 kind に対して今日の新報が明示解除を持つはずがないので、この関数は必ず false を返す。`actualReleased` は 4 をはるかに超え、`remaining > 0` も成り立つ。よって **どの新報も必ず `abnormal_release_rate` になる**。

拒否しても `this.current` は更新されないので、次の報も同じ判定になる。これが自己ロックである。

呼び出し口は 2 つあり、どちらも同じ関数を通る。

- `previewUnsafe()`（同 `:1050-1053`）→ `src/engine/presentation/processors/process-weather.ts:201-227`。gate の `decide()` 前に呼ばれ、unsafe なら early return するので **gate watermark も前進しない**。
- `diffAndUpdateInternal()`（同 `:736-738`）。gate 通過後の本体。

この防御自体は「途中で切れた payload による state 破壊を防ぐ」ために正しい設計であり（同 `:536-538` のコメント）、無効化してはいけない。欠けているのは **「保持している state 自体が信用できないほど古い」という第 3 の状態** である。

### 2.2 8/30 13:10 の初回拒否の直接原因は未確定

拒否の連鎖がいつ・なぜ始まったかは、手元の材料では確定できない。少なくとも次の 2 説が残る。

- (a) 13:10 報を通信断・再接続で取りこぼし、次に届いた報の時点で既に解除が進んでいた
- (b) 13:10 報自体は届いたが、その解除表現が `hasExplicitReleasesForAllMissing()` の要求（消える全 kind について同一区域の解除 Kind が並ぶ）を満たさなかった
- (c) **8/30 当日は v3.4.0 の配送で複数回再起動している**（Issue #17）。再起動をまたいだ復元と受信再開の間に解除が進み、(a) と同じ状態になった

**断定しない。** (a) と (c) は「取りこぼし」として同型で、修正の効き方も同じ。(b) だけが別の含意（判定関数自体の厳しさ）を持つ。確定に必要な材料は次のとおり。

1. Pi の 8/30 13:00〜13:30 の稼働ログ（受信電文の head type と reportDateTime、WebSocket の再接続記録、プロセス起動時刻）。まずこれを見る。取得できれば (a) / (c) と (b) は切り分けられる。
2. 当該 VPWS50 の raw XML。本 repo に気象電文向けの GD API クライアントは無く（`src/dmdata/rest-client.ts:221-224` の GD 経路は地震のみ）、dmdata の telegram list API の保持期間内に 8 日前の電文が残っているかは未確認。取得可否の確認から始める。
3. 2 が取れたら `hasExplicitReleasesForAllMissing()` に食わせて (b) の成否を直接判定する。

本 spec の修正は (a) (b) のどちらであっても効く（どちらも「current が古いまま固まる」に帰着する）ので、**この未確定を理由に実装を止めない**。ただし (b) が真なら `hasExplicitReleasesForAllMissing()` 自体の厳しさも別途見直す価値があるため、確定したら追記する。

### 2.3 Issue #11 — 容量保護が freshness を見ない

```ts
// src/engine/messages/vpws50-state.ts:939-941
/** 容量判断は gate の印ではなく、holder に現存する部分警報で行う。 */
activePartialSubjects(): string[] {
  return [...this.partialStreams.keys()];
}
```

`partialStreams` の全 key を返す。呼び出し側はこれをそのまま容量保護集合に渡す。

```ts
// src/engine/presentation/processors/process-weather.ts:185-188
activeFamilySubjects: isVpws50StateHeadType(msg.head.type)
  ? ["weather:vpws50", ...deps.vpws50State?.activePartialSubjects() ?? []]
  : undefined,
```

family 上限は `1 + VPWW_PARTIAL_MAX_SUBJECTS = 129`（`src/engine/messages/revision-family-registry.ts:147,769-791`）。VPWS50 policy には `activeRetentionMs` が無い（同 `:786-790`。他 family、例えば `:406,419,446` は持つ）ため、**active gate entry は時間で失効しない**。したがって `retainActiveSubjects()` による holder 側の刈り取り（`src/engine/display/standby-persistence-admission.ts:735-737`、holder 側は `src/engine/messages/vpws50-state.ts:915-937`）も発火しない。

`partialStreams` の key は「head type × 官署」なので、蓄積量は「同時に有効な警報数」ではなく「これまで受信した head type × 官署の種類数」で増える。長期常駐すると必ず上限に達する。Pi は既に 129/129 で、新しい官署の VPWW55/57-61 は `capacityExceeded` で拒否される状態にある。

一方 `effectiveSnapshot()` は base より新しい overlay だけを合成するので（同 `:986-998`）、**表示に寄与しない partial まで容量を占有する**という保護集合と実効集合の不一致がある。

### 2.4 `trimPartialSubjects()` は救いにならない

LRU trim は上限超過時にしか働かず（同 `:943-956`）、`partialStreams` が 128 ちょうどでは 1 件も落とさない。しかも新規 subject は gate の `capacityExceeded` で弾かれ holder まで到達しないので、trim を起こす契機自体が来ない（Issue #11 本文の指摘どおり）。

## 3. 変更

### 3.0 Phase 0 申告

実装者は製品コードに触れる前に、実装メモへ次を宣言する。

- **対象**: `Vpws50StateHolder` の unsafe 判定と partial 保持契約、およびその表示文言。gate 本体（`telegram-revision-gate.ts`）、family policy 定数、他 family の holder は対象外。
- **読む規範**: 本 spec §2、`.claude/rules/message-pipeline.md`、`docs/specs/telegram-foundation.md` の VPWS50 節。
- **既存挙動の保存宣言**: `layer_missing` 拒否、全解除（`remaining === 0`）受理、`hasExplicitReleasesForAllMissing()` による通常時の防御、VPWS50 取消報の `restorePrevious` 契約、partial の overlay 合成順序。これらを変えないことを差分で示す。
- **永続 schema**: 本 spec は `PersistedVpws50StateV2` の形を変えない。追加フィールドを入れる案（§6-2 の B）を採る場合は migration とテストを 1 セットで出す。

### 3.1 stale current からの脱出

`unsafeReasonFor()` に「current が新報より著しく古いときは `abnormal_release_rate` を出さない」という前段を入れる。

```text
if (newSnap == null) return "layer_missing";          // 変更なし
if (this.current == null) return null;                // 変更なし
if (isStaleCurrent(info, this.currentIdentity)) return null;   // ★追加
... 以下は現行のまま
```

`isStaleCurrent()` の契約:

- 新報側の時刻は `info.reportDateTime`（`src/types.ts:1218,1226`）、保持側は `this.currentIdentity.reportDateTime` を使う。`previewUnsafe()` と `diffAndUpdateInternal()` の両経路が同じ `info` を持つので、シグネチャ変更は要らない。
- `Date.parse()` がどちらかで NaN になったら **false を返す**（＝従来どおり拒否）。時刻が読めないときに防御を外さない。
- `currentIdentity == null` のときも false（identity 不明の state を根拠に脱出しない）。
- 差が 0 以下（新報が同時刻または過去）なら false。
- 差が閾値 T を超えたときだけ true。**T は §6-1 の裁定事項**（推奨 30 分）。

脱出が成立したときの副作用:

- **`history` をクリアしてから current を置換する。** これをやらないと、置換直後に VPWS50 取消報が来たとき `rollback()` / `restorePrevious()`（同 `:1077,1126`）が 8 日前の snapshot を復活させる。取消で戻る先は「無し」（`current = null`）の方が安全で、次の定時報（最大 10 分）で埋め直る。代替案は §6-5。
- **CLI・ログの文言**: 「解析不能」を出さない。`log.warn` を 1 行出し、CLI には再同期を示す行を出す（§6-2 と §6-3 で形と通知レベルを決める）。
- **差分の扱い**: 8 日ぶんの差分は released が 1,000 件級になり得る。既定の差分描画に流すと CLI と通知が溢れる。§6-2 の推奨案は「差分を出さず、要約 1 行 ＋ `currentAreasForDisplay` の現況再掲」。

脱出は **判定を緩めるのではなく、判定の前提（current が信頼できる）が崩れていることを検出して判定自体を適用外にする**。閾値内では現行の防御が 1 ビットも変わらないことを §4 のテストで固定する。

### 3.2 Issue #11 — 容量保護を fresh な partial に限定する

`activePartialSubjects()` を、現在の base identity より新しい partial に限定する。

```text
activePartialSubjects(): string[]
  currentIdentity == null なら 全 key（base 未受信時は従来どおり全件を守る）
  それ以外は compareWeatherReportIdentity(entry.identity, currentIdentity) > 0 の key だけ
```

これは `effectiveSnapshot()` の overlay filter（同 `:996-998`）と**同じ述語**であり、保護集合と実効集合を一致させる。述語は 1 箇所に切り出して両方から呼び、二重定義にしない。

加えて、**全国 base を受理した時点で古くなった partial の「復元台帳」を holder から prune する**。prune 対象は `partialHistory` と `restoredPartialSubjects` の 2 つで、同じ subjectKey 集合を同時に落とす（食い違うと復元時に history-only subject が残る。`retainActivePartialSubjects()` の既存コメント `:900-901` と同じ懸念）。

**`partialStreams` は prune しない（2026-09-07 訂正）。** `partialStreams` は表示 overlay であると同時に、その官署 stream が何を所有しているかの台帳でもある。`mergePartialWithDisplay()` は kind code 00 の解除 placeholder を受けたとき、直前の stream entry が持つ kind から `ownedPhenomena` を復元して `clearedPhenomena` を組む（同 `:800-812`）。stream を消すと解除報が 1 件も解除を記録できず、base 側の現象が残留する。stream の表示からの除外は `effectiveSnapshot()` の freshness filter が、件数の上限は既存の LRU 128 上限（`trimPartialSubjects()`）が担う。容量保護から外れるのは `activePartialSubjects()` の述語だけで足り、holder から消す必要は無い。

prune の安全性:

- prune 対象の**台帳**は **既に表示に寄与していない**（戻した先が base より古く、`effectiveSnapshot()` の filter で落ちる）。したがって prune は表示契約を変えない。§4 でこれを不変条件として固定する。
- 影響を受けるのは `restorePreviousPartial()`（同 `:1139-1155`）の復元先だけ。base より古い partial の取消報が来ても、その partial はもう表示に効いていないので、復元しても表示は変わらない。この契約変更は spec 本文と test 名に明記する。
- gate 側の entry は**明示的に消さない**。`activeFamilySubjects` から外れた entry は `isFamilyEvictable()` で eviction 可能になるため、容量が要求されたときに gate 自身が退場させる。tombstone 化や `activeRevisionFamilySubjects()` との双方向 compact は入れない（§6-4 の推奨 A）。

### 3.3 Pi の現状態からの回復経路

修正版を Pi に配送した後、何がどの順で起きるかを具体的に書く。**この経路を §4.13 の統合テストで実際に走らせる。**

1. **再起動時（restore）**: `restorePersistedState()`（同 `:1192-1252`）が 8/30 の current と 128 partial をそのまま読み込む。base が stale なので、§3.2 の prune 述語では **127 件が「base より新しい」判定になり残る**。restore 時 prune を入れても（§6-6 の A）落ちるのは 1 件だけ。**再起動だけでは回復しない。**
2. **次の定時報（最大 10 分後）**: 新報の `reportDateTime` は current より 8 日以上新しいので §3.1 の脱出が成立。`previewUnsafe()` が null を返し、gate の `decide()` へ進む。gate の base watermark（8/30 13:00）より新しいので accept。`diffAndUpdateInternal()` が history をクリアして current を新報に置換する。
3. **base 更新直後の prune**: 新 base（例 19:10）より古い partial が prune される。Pi の実データでは partial の最新が 19:02 なので **128 件すべてが落ちる**。`partialHistory` 127 subject、`restoredPartialSubjects` 0 件も同時に落ちる。
4. **表示の回復**: 新 base は現在有効な警報だけを持つので、福井市の L4 土砂災害危険警報は消える。`weatherAlerts` は新 base ＋ それ以降に届く partial だけになる。
5. **容量の回復**: `activePartialSubjects()` が 0 件を返すので gate の 128 件の partial entry はすべて evictable になり、次に新しい官署の VPWW が来ても `capacityExceeded` にならない。
6. **状態サイズ**: `state` 5.9MB のうち `history` 2.17MB と `partialHistory` 3.07MB が消え、`current` は当日の規模になる。1MB を大きく下回る見込み。

ステップ 2 が起きるまで（最大 10 分）は 8/30 の警報が表示されたままになる。これは許容する。即時回復させたいなら restore 時に「current が現在時刻より T2 以上古ければ current を捨てる」という別の契約が要るが、起動直後に警報表示が空になる窓を作るので推奨しない（§6-6 に選択肢として置く）。

### 3.4 安全側の契約は維持する

次は一切変えない。差分に現れたら本 spec 逸脱として停止する。

- `layer_missing`: 新報の layer を抽出できない場合は、時間差に関係なく常に拒否する。§3.1 の判定は `layer_missing` の**後**に置く。
- 全解除: `remaining === 0`（新報が空）は従来どおり正当な一斉解除として受理する。§3.1 はこの経路に触れない。
- 閾値内の防御: 時間差が T 以下なら `hasExplicitReleasesForAllMissing()` を含む現行判定がそのまま働く。
- VPWS50 取消報: `cancellationPolicy: "restorePrevious"`（`src/engine/messages/revision-family-registry.ts:782`）と `restorePrevious()` の契約は維持する。§3.1 の history クリアは「脱出が成立した報に限る」もので、通常の受理報では従来どおり history を積む（同 `:759-765`）。
- partial の overlay 合成順序・`clearedPhenomena` の適用・`emergencyClearTombstones` の適用（同 `:1004-1027,1032-1048`）は変更しない。

### 3.5 変更してよいファイル

- `src/engine/messages/vpws50-state.ts` — §3.1 の stale 判定、§3.2 の `activePartialSubjects()` と prune、脱出時の history クリアと warn ログ。
- `src/ui/weather-formatter-vpws50.ts` — 再同期時の表示分岐（§6-2 の裁定に従う）。
- `src/engine/presentation/processors/process-weather.ts` — 再同期時の `frameLevel` / `soundLevel` 解決（§6-3 の裁定に従う）。§3.2 の prune を holder 内で完結させる場合、この経路の変更は不要。
- `src/types.ts` — `Vpws50Diff` に再同期を示すフィールドを足す場合のみ（§6-2 の A を採るなら必要）。判別共用体の網羅は既存 `switch` を壊さない形にする。
- テスト: `test/engine/messages/vpws50-state.test.ts`、`test/engine/messages/vpws50-state-edgecase.test.ts`、`test/engine/telegram-foundation/phase3b-vpws50-router.test.ts`、`test/ui/weather-formatter-vpws50.test.ts`、および §4.13 用の新規ファイル 1 本。

### 3.6 変更しないファイル

`src/engine/messages/telegram-revision-gate.ts`、`src/engine/messages/revision-family-registry.ts`（`maxSubjects` / `activeRetentionMs` を含む policy 定数）、`src/engine/display/standby-persistence-admission.ts`、`src/engine/messages/vpww56-state.ts`、`src/engine/messages/volcano-state.ts`、`package.json` / `package-lock.json`。

## 4. テスト

すべて既存 test の隣に足す。既存 test（`test/engine/messages/vpws50-state-edgecase.test.ts:86,124`、`test/engine/messages/vpws50-state.test.ts:859`）の `abnormal_release_rate` 期待は**残す**。閾値内の挙動が変わらないことの証明になるので、削って件数を減らさない。

### 4.1 stale 脱出の再現

1. current を D 日・4 kind 以上で構築する。
2. 新報を D+8 日、kind が減り、明示解除を持たない payload で作る。
3. **修正前の挙動を先に固定**: 同じ入力で `previewUnsafe()` が `abnormal_release_rate` を返す test を、修正前 commit で緑にしてから修正する（赤→緑の順を守る）。
4. 修正後: `previewUnsafe()` が `null`、`diffAndUpdateWithDisplay()` が `confidence: "confirmed"` を返し、`current` が新報へ置換される。

### 4.2 閾値の境界

閾値 T（§6-1 の裁定値）に対して、`info.reportDateTime` を直接指定して次を固定する。

| 時間差 | 期待 |
|---|---|
| T − 1 分 | `abnormal_release_rate`（拒否） |
| T + 1 分 | `null`（受理） |
| ちょうど T | 仕様として明記した側に倒す（推奨: T ちょうどは拒否、「超えたら」で判定） |
| 0 分（同時刻・serial のみ差） | 拒否 |
| 負（新報が過去） | 拒否 |

### 4.3 閾値内の防御が生きている

current が新報の 10 分前で、4 kind 以上が明示解除なく消える payload → 従来どおり `abnormal_release_rate`。これが赤くなったら防御を壊している。

### 4.4 `layer_missing` は時間差と無関係

current が 8 日前でも、layer を抽出できない新報は `layer_missing` で拒否される。

### 4.5 全解除は従来どおり

current が 8 日前で新報が空（`remaining === 0`）→ 受理され、`current` が空になる。脱出経路を通ったか通らないかに関わらず結果が同じであることを確認する。

### 4.6 時刻が読めないときは拒否側

`info.reportDateTime` が不正文字列、または `currentIdentity` が null のとき、`abnormal_release_rate` 判定が従来どおり働く（fail-safe）。

### 4.7 脱出後の取消が古い state を復活させない

脱出受理 → 直後に同報の取消（`restorePrevious`）→ 8 日前の 1,296 kind が復活しないこと。`history` が空であることと、`getCurrentAreasForDisplay()` が 8 日前の区域を含まないことの両方を assert する。

### 4.8 `activePartialSubjects()` の freshness 限定

base identity を D+1 に更新した状態で、D 日の partial 3 件と D+2 日の partial 2 件を持たせ、返り値が D+2 の 2 件だけであること。`currentIdentity == null` のときは全件返ること。

### 4.9 prune の 3 集合同期

base 更新後、prune された subject が `partialStreams` / `partialHistory` / `restoredPartialSubjects` のいずれにも残らないこと。`exportPersistedState()` の出力にも現れないこと。

### 4.10 prune が表示を変えない

prune の直前と直後で `getCurrentAreasForDisplay()` が完全一致すること（prune 対象の台帳は既に overlay 対象外なので、これは不変条件）。

加えて（2026-09-07 訂正で追加）、**`partialStreams` を台帳として保つことの回帰**を固定する。base が 1 周期進んで stream が base より古くなった後に、その stream から kind code 00 の解除報（明示 `clearedPhenomena` なし）が届いたとき、`ownedPhenomena` の復元が働いて base 側の当該現象が解除されること。stream を prune する実装ではこれが赤になる。

### 4.11 Issue #11 の容量回帰

Issue #11 §回帰テスト案の 1〜6 を router 経路で通す。

1. base VPWS50 を 1 件受理。
2. distinct な VPWW55/57-61 subject を 128 件受理（gate と holder の両方に載せる）。
3. それらより新しい全国 VPWS50 を受理。
4. `activePartialSubjects()` が 128 件を active 扱いしないこと。
5. 129 件目の新規 partial subject が `capacityExceeded` ではなく受理され、表示 state に反映されること。
6. base より新しく実際に表示へ寄与している partial は eviction されないこと。

### 4.12 永続 round-trip

`exportPersistedState()` → `restorePersistedState()` 後も §4.8〜§4.11 の性質が保たれること。永続化と module スコープ状態を触るので、この test 群は `npm run test:shuffle` にも通す。

### 4.13 実 Pi 状態の縮小 fixture による復元 → 次報受理

**必須。** §3.3 の 6 ステップを 1 本の統合 test で走らせる。

fixture の縮小手順（5.9MB をそのまま repo へ入れない）:

1. Pi の `display-active-state-v2.json` から `telegramFoundation.vpws50` だけを取り出す。
2. `current.snapshot.areas` を 12 区域へ間引く。**福井市の「レベル４土砂災害危険警報」に相当する L4 エントリを 1 件必ず残す**（不死化の再現に要る）。kind 総数は `ABNORMAL_UNEXPLAINED_RELEASE_MIN = 4` を確実に超える数（12 以上）にする。
3. `history` を 8 件 → 1 件へ。identity は 8/30 のまま残す（§4.7 の復活防止を同じ fixture で確認するため）。
4. `partialStreams` は 4 件だけ残す。内訳は (a) `clearedPhenomena` だけを持ち base の一部現象を消す stream、(b) base に無い新しい L4 を追加する stream、(c) base より古い stream 1 件、(d) 素の stream 1 件。§4.11 の 128 件版は fixture ではなくコードで合成生成する。
5. `partialHistory` は 1 subject × 1 entry へ。
6. `emergencyClearTombstones` は 1 件そのまま残す。
7. 目標サイズは 100KB 未満。生成スクリプトを `test/fixtures/vpws50-stale-lock/` に置くのではなく、**生成済み JSON 1 本 ＋ 縮小手順を書いた README** を置く（生成スクリプトは Pi の実ファイルに依存するので再実行できない）。

**再配信ポリシーの確認が要る。** 本 fixture は dmdata 電文の raw XML ではなく派生 state だが、区域名・区域コード・官署名・reportDateTime が実電文由来で残る。main へ置いてよいかは §6-7 の裁定事項。裁定前は personal 側にだけ置く前提で書く。

test 本体で確認すること:

- 復元直後: `getCurrentAreasForDisplay()` に L4 土砂災害相当が含まれる（＝不死化の再現）。
- 復元直後に新報（base より 8 日新しい、L4 土砂災害を含まない）を `previewUnsafe()` へ通すと、**修正前は `abnormal_release_rate`、修正後は null**。
- 受理後: L4 土砂災害相当が消える。`history` が空。partial が prune され `activePartialSubjects()` が縮む。
- 受理後の `exportPersistedState()` の JSON バイト数が復元前より小さいこと（閾値は置かず、単調減少だけを assert する）。

## 5. 受入条件

### 5.1 test / build gate

```sh
npm run build
npm test
npm run test:shuffle
git diff --check
```

`npm run test:shuffle` は必須。partial 保持と永続 state を触るため（`AGENTS.md` の規定）。

### 5.2 テスト件数と名前

§4.1〜§4.13 に対応する test が実在し、緑であること。既存の `abnormal_release_rate` 期待 3 箇所（`test/engine/messages/vpws50-state-edgecase.test.ts:124`、`test/engine/messages/vpws50-state.test.ts:859`、および `:86` のコメント対象）が削除も改変もされていないこと。差分レビュー時に `git diff` でこの 3 箇所が触れられていないことを確認する。

### 5.3 Pi 実機（配送後）

1. 配送後の**最初の定時報（10 分以内）**で、CLI から「解析不能 — state を更新せず維持」「⚠ 異常な解除率を検出しました」が消えること。
2. 同じ報で再同期を示す行が **1 回だけ**出ること（毎報出続けたら失敗）。文言は §6-2 の裁定に従う。
3. その次の定時報が「解析不能」なしで受理されること（2 報連続で確認する。1 報だけでは偶然と区別できない）。
4. SSE snapshot の `weatherAlerts` から、区域コード `1820100`（福井市）の「土砂災害 / officialL4」が消えること。確認は `weatherAlerts` の該当 item を grep する。
5. `telegramFoundation.vpws50.gateEntries` の `weather:vpws50` entry の `reportDateTime` が当日の値に前進していること。
6. `gateEntries` の件数が 129 未満になっていること。加えて、その後に新しい官署の VPWW55/57-61 が届いたとき `capacityExceeded` のログが出ないこと（実事象待ちになるなら、この 1 項目だけ「観察継続」として残してよい）。

### 5.4 情報として計測する（合否には使わない）

- `telegramFoundation.vpws50.state` のバイト数（配送前 5.9MB → 配送後の値）。
- Pi の `/healthz` 応答遅延（100ms 間隔・120 秒・port 7788）の p99。配送前は 1,283ms。

これらは Issue #13 の性能 spec の入力にする。本 spec の合否条件には入れない。

### 5.5 範囲逸脱の停止条件

差分に §3.6 のファイルが現れた場合、`package.json` / `package-lock.json` / `data/runtime/` が変わった場合、`PersistedVpws50StateV2` の型が §6-2 の裁定なしに変わった場合は、実装を停止して報告する。

### 5.6 Issue #17 の完了条件との対応

#17 の 4 チェックボックスは、それぞれ本 spec の次の条件で閉じる。**#17 側をチェックしてよいのは、対応する本 spec の条件が全部緑になったときだけ。**

| #17 の完了条件 | 本 spec の対応 | 閉じる根拠 |
|---|---|---|
| current が D 日、新報が D+8 日で kind が減り明示解除なしのケースが、現行では拒否・修正後は受理されるテスト | §4.1 | 修正前 commit で `abnormal_release_rate` を返す test を緑にしてから修正する（赤→緑の順）。修正後は `previewUnsafe()` が null、`diffAndUpdateWithDisplay()` が `confirmed` |
| 閾値境界と `layer_missing` / 全解除 / 取消経路の非退行テスト | §4.2 / §4.4 / §4.5 / §4.7、および §5.2 | 境界は T±1 分と 0 分・負の 4 ケース。取消経路は「脱出後の取消が 8 日前を復活させない」まで含む。既存 `abnormal_release_rate` 期待 3 箇所の無改変を `git diff` で確認する |
| 実機で次の定時報が受理され、SSE `weatherAlerts` から 8/30 の警報が消える | §5.3 の 1〜5 | 「解析不能」2 行の消失、再同期行が 1 回だけ、**2 報連続**受理、区域コード `1820100` の「土砂災害 / officialL4」消失、base gate entry の `reportDateTime` 前進。1 報だけの受理では閉じない |
| gate entry が 129 件から減り、新規 VPWW55/57-61 subject が受理される（#11） | §5.3 の 6、および §4.8 / §4.9 / §4.10 / §4.11 | 件数減はローカル test（§4.11 の 129 件目受理）で機械的に閉じる。実機側の「新規官署の受理」は実事象待ちになり得るので、その場合は #17 上で「観察継続」と明記して残す。**実事象が来ないことを理由に閉じない** |

#11 は §4.8〜§4.11 と §5.3 の 6 が緑になった時点で閉じてよい。ただし #11 本文の修正方針（base より古い partial の prune）だけでは実機が回復しないことを §1.3 で訂正しているので、**#11 を閉じるときはその訂正を issue にコメントで残す**。

## 6. 判断分岐

推奨を先頭に置く。**7 件すべてが埋まるまで配送不可。**

### 6-1. stale 判定の閾値 T

- **A（推奨）: 30 分。** 定時周期 10 分の 3 周期ぶん。通信瞬断 1 回（10 分）や処理遅延（20 分）では防御が外れず、3 周期落としたら異常として脱出する。8 日という実害に対して十分速く、誤脱出には十分遅い。
- B: 20 分（2 周期超）。復帰は 10 分速いが、瞬断＋再接続遅延の組み合わせで防御が外れる余地が増える。
- C: 時間ではなく「同一 current に対する連続拒否回数 3 回」。周期変更に強いが、カウンタを永続 state に持つ必要があり schema 変更と migration が要る。今回の実害に対して割に合わない。

### 6-2. 再同期時の差分表示と `Vpws50Diff` の形

- **A（推奨）: `Vpws50Diff` に再同期フラグを 1 つ足し、差分描画を抑制して要約 1 行 ＋ 現況再掲にする。** 8 日ぶんの差分は released が 1,000 件級になり、CLI・通知・ディスプレイのどれもが溢れる。文言案は「**再同期 — 保持していた現況が古いため新報で置き換えました**」。`currentAreasForDisplay` の現況再掲は既存の recap 経路を再利用する。型追加は `Vpws50Diff` のみで、永続 schema は変わらない。
- B: 通常の差分としてそのまま描画する。実装は最小だが、大量 released の描画・通知が出る。ご主人が実機で見る画面が数千行になる可能性がある。

（これは製品挙動の変更なのでご主人裁定。実装者は独断しない。）

### 6-3. 再同期時の通知レベル

- **A（推奨）: `frameLevel` / `soundLevel` とも `info`（音なし）。** 再同期そのものは災害事象ではない。音で起こす必要はなく、`log.warn` と CLI 1 行で足りる。
- B: `warning`（音あり）。8 日の欠測という異常を人に気づかせる。ただし配送直後に 1 回鳴るだけで、以後は鳴らない。

### 6-4. gate entry の扱い

- **A（推奨）: `activePartialSubjects()` の限定だけ。gate entry は消さず、evictable に戻すだけにする。** 変更が holder に閉じ、gate 本体（`telegram-revision-gate.ts`）に触らない。容量が要求されたときに gate 自身が退場させるので、恒久拒否は解ける。
- B: base 更新時に gate entry を明示的に tombstone 化 / compact する。gate の状態がすぐ小さくなるが、`telegram-revision-gate.ts` と holder の双方向同期を新設することになり、面が広がる。

### 6-5. 脱出時の `history` の扱い

- **A（推奨）: `history` をクリアしてから current を置換する。** 取消報で 8 日前の state が復活する経路を塞ぐ。取消で戻る先が無くなるが、次の定時報（最大 10 分）で埋め直る。副次的に 2.17MB が落ちる。
- B: 通常どおり history に積む。取消時の巻き戻し先は残るが、それは 8 日前の state であり、復活させたい state ではない。

### 6-6. restore 時の prune

- **A（推奨）: 起動時 restore の直後に §3.2 の prune を 1 回走らせる。** base が fresh な通常のケースでは、再起動のたびに古い partial が落ちて state が小さく保たれる。今回の Pi の状態では 1 件しか落ちないが、無害。
- B: restore 時は何もせず、次の base 受理時の prune だけにする。実装は小さいが、再起動を繰り返しても state が縮まない。
- C: restore 時に「current が現在時刻より T2 以上古ければ current を捨てる」。即座に 8 日前の表示が消えるが、**起動直後に警報表示が空になる窓**を作る。実警報発表中の再起動で表示が消えるので推奨しない。

### 6-7. 実 Pi 状態由来 fixture の置き場所

- **A（推奨）: 区域名・区域コード・官署名を合成値へ置換した匿名化 fixture を main に置く。** dmdata 由来の実データを公開 repo に置かない原則（`project_dmdata_policy_stage2`）に沿う。構造の再現には実際の地名は要らず、L4 の重なりと `clearedPhenomena` の関係だけが要る。
- B: 実データのまま personal にだけ置き、main では合成 fixture で代替する。main / personal でテスト内容が分岐するので、rebase のたびに差分が出る。
- C: 実データのまま main に置く。再配信ポリシー上の判断が要る。**実装者が独断してよい事項ではない。**

## 裁定ラベル案（6 要素）

> §6 の 7 件が未裁定のため、現時点では**配送不可**。裁定が埋まった時点でこのラベルが有効になる。

- **対象**: `src/engine/messages/vpws50-state.ts`（stale 判定 / `activePartialSubjects()` / partial prune / 脱出時 history）、`src/ui/weather-formatter-vpws50.ts`（再同期表示）、`src/engine/presentation/processors/process-weather.ts`（再同期の frame / sound）、`src/types.ts`（`Vpws50Diff` のフラグのみ）、および §3.5 に挙げたテスト群と新規 fixture 1 本。
- **許容変更**: §3.1 の stale 脱出、§3.2 の freshness 限定と 3 集合同期 prune、§6 で裁定された文言・閾値・通知レベル、§4 のテスト追加、縮小 fixture の追加。
- **禁止変更**: `telegram-revision-gate.ts`、`revision-family-registry.ts` の policy 定数（`maxSubjects` / `activeRetentionMs` / `tombstoneRetentionMs`）、`standby-persistence-admission.ts`、他 family の holder、`PersistedVpws50StateV2` の schema（§6-2 の裁定に含まれない形の変更）、`package.json` / `package-lock.json`、`data/runtime/`、`layer_missing` と全解除の既存契約、既存 `abnormal_release_rate` テスト 3 箇所。
- **配送先**: main → personal → Pi。main へ push 後は GitHub Actions の Test workflow を `gh run watch <id> --exit-status` で緑確認してから personal へ進む。
- **ロールバック**: 単一実装 commit を revert し、main → personal → Pi の順に再配送する。永続 schema を変えないので data migration は不要。ただし **prune 済みの partial は戻らない**。revert 後は base が新しくなっているため、prune された partial は表示に寄与しない状態のままで、実害は無い。
- **受入条件**: §5.1 の 4 コマンドが緑、§5.2 の test 実在と既存 3 箇所の無改変、§5.3 の Pi 実機 6 項目（項目 6 は実事象待ちなら観察継続として明示）、§5.5 の逸脱なし。
