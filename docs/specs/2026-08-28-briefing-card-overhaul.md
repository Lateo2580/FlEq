# BriefingCard 総点検（裁定済みドラフト）

- 状態: **確定（dedup = 案 A・地域表示 = 案 A 裁定済み・Sol high DOC-OK 2026-08-27・実装待ち）**
- 起源: 2026-08-27 秋田・富山 L4 事象の実機観察、および VPBS50 corpus 4 通
- 対象: BriefingCard の表示用同一性、対象地域表示、ページング、視覚言語
- 非対象: engine 基盤の raw EventID identity、ticker・通知・CLI の identity/TTL

## 1. 症状

1. 同一種の気象防災速報が待機画面内で entry 増殖する。
2. 対象地域が「沿岸 050010」のように areaCode を含む生表記になる。
3. 複数 entry 時、2 entry 目がカード下端で見切れる。
4. 気象警報カードと比較して、ヘッダ、時刻、対象地域、ページャーの視覚言語が不揃いである。

## 2. 根因（コード・corpus 確認済み）

- card key は raw `EventID/messageId` を `card:vpbs:${id}` にするため、時刻入りで毎回変わる VPBS50 EventID は dedup にならない。
- corpus 4 通は、Head に `Title / EventID / InfoType / Serial / ReportDateTime`、情報タグに `Condition / Areas.Area.Name / Code`、Control に `EditorialOffice` を持つ。
- `PublishingOffice` は4通とも「気象庁」で scope 識別子にならない。`EditorialOffice` は富山地方気象台／金沢地方気象台で分離できる。
- target `Name/Code` は parser から wire まで保持され、BriefingCard が両方を直接文字列化する。
- 見切れについて、entry header が partition probe の勘定外である証拠はない。probe は同じ card shell の `scrollHeight/clientHeight` を測る。
- ただし partition は本文 block 単位、描画は entry ごとに header を再生成する。entry 境界をまたぐ実 browser の二 entry 実測回帰がない。

## 3. 既存仕様との関係・supersede 範囲

本 spec は**カード表示の同一性**についてのみ、次を supersede する。

- `docs/specs/2026-08-27-briefing-card-structuring.md` §7 の  
  `card:vpoa:<raw EventID|messageId>`／`card:vpbs:<raw EventID|messageId>` を card identity とする記述。
- `docs/specs/telegram-foundation.md` §5.1、§5.5、§5.7 のうち、BriefingCard 表示 projection を raw EventID の exact identity のみで更新・取消・重複排除すると解釈できる部分。

次は不変とする。

- parser/engine/protocol 層の raw EventID exact identity と `sourceEventId` 保存。
- transport dedup、revision gate、ticker/通知/CLI、VPOA50→VPBS50 の相関規約。
- VPBS50取消の cancel frame 置換と10分TTL、VPOA50取消の通常120分 fail-open。
- `ReportDateTime + Serial` による新旧比較、遅着旧報を新報へ置換しない原則。

## 4. 変更案

### 4.1 card 表示同一性（ご主人裁定）

#### 案 A: `source × phenomenonKind × editorialOffice`（推奨）

表示専用の semantic subject を導入する。`source` は VPBS50/VPOA50、`editorialOffice` は Control の編集官署とする。

VPBS50 の kind-bearing Condition を NFKC 正規化し、既知 allowlist から tag 集合 `K` を作る。`K` の tag は重複除去し、順序は次で固定する。

1. `linearRainObserved`
2. `linearRainPredicted`
3. `recordRain`
4. `shortSnow`

新しい VPBS50 subject を作る場合だけ、`K` の最上位 tag を `phenomenonKind` とする。一度作った entry の `phenomenonKind` は不変である。

通常報は次の順で既存 subject と照合する。

1. `sourceEventId` 完全一致なら、その entry を先行照合する。
2. 一致しない VPBS50 は、同じ `source`・`editorialOffice` の既存 VPBS50 subject から、**保存済み `phenomenonKind` が現報の `K` に含まれるもの**を抽出する。
3. 候補が一件なら、その subject を更新候補とする。現報に Condition が追加されても、既存 subject の kind/key は変わらない。
4. 候補が零件なら、`K` 最上位 tag で新 subject を作る。
5. 候補が複数、`K` が空、または `editorialOffice` が空なら semantic merge をしない。raw EventID exact identity の fail-open entry とし、既存 entry を変更しない。

VPOA50 の `ParsedLegacyCounterpartInfo` は `phenomena: []` であり、`kinds`／`severityEvidence` は発表状態・警報 evidence であって現象種別ではない。現在の `recordRain` は `isHighVpoaCard()` 成立時の表示 summary 固定値であり、semantic kind の入力に使えない。したがって **VPOA50 は常に raw EventID exact identity** とする。

同一 subject の新旧比較は `ReportDateTime`、同値時は numeric `Serial` の順とする。

- `newer`: 既存 entry を後報で置換する。
- `older`: 置換しない。
- ReportDateTime・Serial が同値で payload も同一: no-op。
- ReportDateTime・Serial が同値で payload が異なる: **no-op + diagnostic warn**。置換しない。
- 必要値の欠落等で `unordered`: semantic merge をせず raw EventID exact fallback とする。

利点は、対象地域の追加・縮小を伴う続報を一枚へ集約できることだ。欠点は、同一官署・同一種別の独立事象を同じ表示 subject とみなすことだが、本仕様では後報置換を優先する。

#### 案 B: `source × phenomenonKind × 対象 Area.Code 集合`

対象 code をソート・重複除去して key に含める。

- 利点: 同一官署・同種別・別地域の独立事象を共存でき、追加 wire が不要。
- 欠点: 対象地域が変わる続報は別 entry となり、増殖を再発する。取消の一致も弱い。
- 採用時も、空 Condition・空 code は raw EventID exact identity へ fallback する。

### 4.2 取消契約（裁定済み）

VPBS50取消は、次の順で対象を決める。

1. `sourceEventId` の完全一致を第一照合とする。
2. sourceEventId が欠落している場合のみ、`source × phenomenonKind × editorialOffice` の semantic key を fallback に使う。
3. fallback が複数候補、kind集合が空、または官署が空なら取消しない。diagnostic を残して現存 entry を保護する。
4. 一意に照合できた取消は、既存 entry を cancel frame へ置換し、10分TTL とする。
5. VPOA50取消は既存どおり独立 `rawHeadlineFallback` entry・通常120分TTL とする。

実取消 corpus 未入手は配送 blocker としない。synthetic fixture で上記を固定し、実電文は追加検証項目とする。

### 4.3 VPOA50→VPBS50 late reconcile

canonical 化は、相関 context が運ぶ **sourceEventId 完全一致の VPOA50 entry** に対してのみ行う。VPOA50 を semantic key から探索・置換してはならない。

canonical VPBS50 を入れる前に、同 semantic subject の既存 VPBS50 entry が source entry 以外にある場合は、`ReportDateTime + Serial` を比較する。

- canonical が `newer` の場合のみ、source VPOA50 を除去し canonical VPBS50 へ原子的に置換する。
- canonical が `older`、`unordered`、または同値かつ payload 相違の場合、既存 VPBS50 を変更せず、VPOA50 source も除去しない。diagnostic を残す。
- canonical と既存 VPBS50 が同値かつ payload 同一なら、source VPOA50 を除去し、既存 canonical を維持する。
- semantic key の衝突だけを根拠に、古い canonical が新しい独立 entry を置換することを禁止する。

### 4.4 県文脈表示（ご主人裁定）

#### 案 A: 県文脈を一度だけ表示し、対象は名称のみ（推奨）

Head title から安全に得られる都道府県名を entry の文脈として一度だけ表示し、対象は `西部、東部` のように `Area.Name` だけを表示する。抽出不能時は名称のみへ fallback する。

#### 案 B: 対象名称のみを表示する

`対象: 西部、東部` のみを表示する。実装は小さいが、地域名だけでは県を判別しにくい場合がある。

両案とも `Area.Code` は wire・identity・監査用に保持し、可視文字列には含めない。

### 4.5 見切れ

- visual chrome 確定後の DOM を正本として、partition の表示単位を「entry chrome + 本文 blocks + 必要な footer」と定義する。
- probe、live、pager は同一の page atom を描画・計測する。
- entry 境界をまたぐ候補では、再描画される header を候補高さに含める。
- 一 block が shell を超える既存の保全 fallback は維持し、空ページを作らない。

### 4.6 視覚言語

- card 全体で一つの header と更新時刻を持つ構成へ寄せる。
- WeatherAlertCard と同じ header token、更新時刻、footer token、地域階層表現を再利用する。
- 複数 entry の最上位 severity を card header に反映し、個別 entry は本文上の区切りとする。
- Briefing 固有の現象 lead、観測 fact、取消、VPOA50 の未確認 qualifier は維持する。

## 5. 対象ファイル

- `src/dmdata/briefing-parser.ts`
- `src/dmdata/legacy-counterpart-parser.ts`
- `src/engine/presentation/types.ts`
- `src/engine/presentation/events/from-briefing.ts`
- `src/engine/display/protocol.ts`
- `display/frontend/src/lib/protocol.ts`
- `src/engine/display/standby-state-store.ts`
- `src/engine/monitor/display-sink.ts`
- `display/frontend/src/components/BriefingCard.svelte`
- `display/frontend/src/components/StandbyScreen.svelte`
- `test/engine/display/standby-state-store.test.ts`
- `test/engine/display/briefing-corpus-0827.test.ts`
- `test/engine/display/protocol-sync.test.ts`
- `display/frontend/src/components/__tests__/briefing-card.test.ts`

## 6. 実装フェーズ

1. **識別子再設計**: 案 A/B の裁定、Condition集合照合、revision比較、取消、late reconcile、protocol同期を実装する。
2. **表示改善**: 県文脈の裁定、areaCode 非表示、対象地域表示の DOM 契約を実装する。
3. **視覚言語**: card chrome、header、更新時刻、footer、entry 区切りを確定する。
4. **見切れ**: Phase 3 の確定 DOM を使い page atom/probe を実装し、全 geometry gate を再実行する。

## 7. 受入条件（機械検証）

- VPBS50 の sourceEventId 完全一致が、Condition集合による semantic 照合より先に解決されること。
- 同一官署の既存 subject の kind が現報 `K` に一つだけ含まれる場合、異なる EventID の後報が同じ entry を更新すること。
- Condition追加後も、初回 entry の `phenomenonKind` と semantic key が変わらないこと。
- `K` に一致する既存 subject が複数、`K` 空、または官署空の場合、既存 entry を変更せず exact fallback となること。
- VPOA50 は `recordRain` 表示 summary を持っても semantic merge せず、常に exact identity となること。
- `older` canonical が新しい VPBS50 entry を置換せず、late reconcile の VPOA50 source も消さないこと。
- 同 revision・同 payload は no-op、同 revision・payload相違は no-op + warn であること。
- corpus 4 通で、富山/石川 × 発生/直前予測の Condition集合・編集官署・対象地域が期待どおりであること。
- synthetic VPBS50取消で、sourceEventId 完全一致は cancel frame・10分TTLへ置換されること。
- synthetic VPBS50取消で sourceEventId 欠落かつ semantic fallback 一意なら置換、複数候補なら削除・置換しないこと。
- synthetic VPOA50取消が VPBS50 cancellation へ混ざらず、通常120分 fail-open を維持すること。
- 実取消 VPBS50 corpus を入手した場合、synthetic と同じ取消規約を追加検証すること。
- corpus 4 通の DOM で、県名が entry ごとに一度だけ現れ、対象地域名が残り、対象 areaCode が可視文字列に現れないこと。
- 県文脈抽出不能 fixture で、名称のみ表示へ安全に fallback すること。
- 実 browser の二 entry fixture で、各 page の card が `scrollHeight <= clientHeight + 1` を満たすこと。
- 同 fixture で `[data-page-probe-readable]` の縦横 overflow がなく、header/footer あり・なし、critical/warning 混在を検証すること。
- protocol sync test で engine/frontend の Briefing wire が同期し、旧 shape は raw fallback となること。
- `npm run build`、`npm test`、`npm run test:shuffle`、`npm run typecheck:test`、display 側の build/test/typecheck が成功すること。

