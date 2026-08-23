# spec: 竜巻注意情報カード内ページ送り（draft v0.2, 2026-08-23）

> v0.1 → v0.2: 独立 Sol high レビューの blocking / major を反映。共通 paging/probe key、契約高、複数 readable region の fit、infeasible 多段防衛、`--report` の host/epoch 番兵を追加した。D1〜D4 はご主人裁定待ちであり、推奨は実装決定ではない。

## §1 背景・目的

テロップ先行の (a) は完了し、竜巻注意情報の優先粒度の全対象地域はテロップに出る。残る (c) は、待機画面の `WeatherAlertCard` rider でも、地域を高さ上限で黙って失わず有限ページで巡回表示することだ。

対象外: parser、官署単位の続報置換、期限（`ValidDateTime` / 不在時 +1h）、1 分 sweep、revision guard、ticker の既存意味。これらは現行のまま保持する。

## §2 現状（2026-08-23 の実コード確認）

- `from-tornado.ts` は `selectPreferredTornadoLayer(info.layers)` の**全** area を `PresentationEvent.areaItems` / `areaNames` に射影する。
- `StandbyStateStore.applyTornado()` は areaItems を官署別 state に保存し、snapshot では官署横断の順序保持 `Set` で統合して `kind:"tornado"`, `surface:"weather-rider"`, `data.areas: string[]` にする。寿命・続報・復元はここで完結済みである。
- `WeatherAlertCard.svelte` の現状は背景時点の `areas[0]` ではない。`tornado.data.areas.join("、")` を 1 本の `.tornado-rider` に描画する。カードは `max-height:min(44vh,280px)` と `overflow:hidden` のため、保持される全件が可読とは限らない。
- weather 本文は既に candidate → `sequentialPartitionRanges("weather", ...)` → forced `measurementRange` → `pageIdentity()` → `CardPageCoordinator` の経路を持つ。`omittedAreaCount` / tail-only も probe に含めるため、竜巻はこの経路を雛形にする。
- ただし現行 `PartitionProbe`、`sequentialPartitionRanges()`、`PageMeasureEntry.key` は layout `CardKey`、StandbyScreen の `PrefixCardKey` は `quake|weather|flood` に限定される。`"tornado"` は現在の API に渡せない。
- `CardPageCoordinator` の pageable key も `quake|weather|flood`。rotation appearance は layout `CardKey` を受ける。竜巻は layout card でないため、`CardKey` / `CARD_ORDER` に追加して solver を汚染してはならない。
- 現在の page probe は card root を縦方向だけ、`querySelector("[data-page-probe-body]")` の単一 weather `<ul>` を縦横だけ検査する。rider はその外にあり、rider の横 overflow は観測されない。
- `pageFixedHeight()` は weather 自身の page count / truncation だけを見る。tornado だけが複数ページの場合、solver 高、rotation reserve、live outer height は未連結で、折返しにより高さが揺れ得る。
- flood は両形態について props 注入、identity adapter、契約高、infeasible、`--report` の root 属性・capture allowlist・期待表を同期済みである。`LegacyImprovedMock.svelte` は scheduler を独立コピーしており、現在も tornado rider を全件連結する。

## §3 設計

### 3.1 共通 paging/probe key と identity

- layout の `CardKey` は変更しない。新設する `PagePartitionKey` は **layout card と dependent rider を区別せず partition / measurement だけで使う共通型**とし、`CardKey | "tornado"` とする。別途 `PageableKey = "quake" | "weather" | "flood" | "tornado"` を coordinator の record 用に定義する。
- `page-partition.ts` の `PartitionProbe` / `sequentialPartitionRanges()` / probe id、`types.ts` の `PageMeasureEntry.key` / `PartitionResult.pending`、StandbyScreen の `PrefixCardKey` / `PrefixMeasureEntry` / `pagePartitionProbe()` / forced-probe dispatch を `PagePartitionKey` へ通す。`CardKey` が必要な layout / solver / rotation API には渡さない。
- `tornadoPageAreaEntries(areas)` は `{kindKey:"tornado", area, occurrenceIndex}` を出す。同名地域も削らず、出現順の occurrence で `pageIdentity()` を一意にする。wire に area code はない。
- resetKey は順序付き地域列を必須とし、D4-A なら地域列のみ、D4-B なら `isSighted` を含む、D4-C なら `false→true` のときだけ変化する条件付き key とする。内容更新だけで再分割して active identity が消えたときは、既存 successor-after-removal に遷移し、1 ページ目 reset と混同しない。

### 3.2 rider を含むカードの契約高

- tornado または weather のどちらかが paging / pending / infeasible fallback 中なら、weather+rider shell の契約高を `min(44vh, 280px)`（現在の CSS 上限と同じ viewport 依存定数）に固定する。header、weather 本文、rider、D3 の marker を含む外枠予算である。
- この**同一の契約高**を `selectedHeight` / `measured`（solver）/ rotation slot reserve / `pageFixedHeight()` / live outer `.paged-card` / pending と確定済み page のすべてに流す。tornado 単独の複数 page も例外にしない。従ってページ送りと pending→確定で外枠高は揺れない。
- probe は boolean を返さず、`fit=0` / `fail=contractHeightPx+1` の sentinel を使う。weather の旧 0/2 sentinel は、tornado と同一 shell を測る経路ではこの一般形へ置換する。実測値から契約高を導かず、固定高⇄partition の循環を作らない。
- D1-A の safety envelope は、同一 snapshot の weather / tornado の live 組成のうち最も高い（または全組成を個別に）forced probe して契約高内を確認する。安全側の根拠なしに一方の page range を他方へ流用しない。

### 3.3 coordinator と時間契約

- `CardPageCoordinator` は `PageableKey` の全 record、`realKeys()`、diagnostics、dispose、mock 独立実装を tornado まで拡張する。`PageableKey` を列挙する全箇所を型で網羅する。
- registration に `appearanceHost?: CardKey` を追加する。tornado の logical host は `weather` とし、`recordRotationAppearance("weather")` は host=weather の dependent pager を 1 回進める。weather が 1 page でも tornado が P>1 なら進める。
- weather 常駐時は tornado real mode（15 秒 tick）、weather rotation member 時は logical mode（weather 再登場時だけ 1 step）とする。非表示中は進めない。weather/tornado 双方が複数 page でも、それぞれの mode / active identity は独立に維持する。
- epoch hold 中の appearance は既存と同じく保留し、layout motion 解放後に 1 回だけ反映する。`pageScheduling=false` の計測棚・単体 component は registration も page timer も開始しない。消滅 / unmount は tornado を unregister する。

### 3.4 カード、fit、計測順

- WeatherAlertCard に tornado 用 partition / forced `measurementTornadoRange` / measurement marker props を追加する。live と forced shelf のいずれも rider は現在 range の `areas.slice(start,end)` のみを描画し、全件 `join()` を残さない。
- `data-page-probe-readable` を weather 本文と tornado rider の**各可読 viewport**に付与する。probe は card root の縦 overflow に加え、`querySelectorAll("[data-page-probe-readable]")` の全要素について縦横 overflow を検査する。各 region の client size が 0 の未計測時は pending とし、fit 扱いにしない。
- `PageMeasureEntry` / probe id は `PagePartitionKey`、placement、forced range、tail、weather/tornado の同時組成、infeasible fallback 種別を含める。side / center の preflight と forced shelves は同一の live shell / 契約高を使う。
- D1-A の計算順は固定する。(1) snapshot から候補・reset key・契約高を決める、(2) side / center で必要な合成 probe を enqueue、(3) 全 required probe が確定するまで旧 confirmed registration を維持し provisional range を表示、(4) 確定 partition 群を atomically publish、(5) coordinator を register する。probe 結果が registration / solver 高を変えて新 probe を誘発する循環は許さない。

### 3.5 pending と infeasible 多段防衛

- pending は partition の provisional range を描画する。全件 rider へ戻さず、scheduler registration は旧 confirmed state のままにする。
- 確定して 1 地域 range も fail したとき、D2-A では (i) aggregate fallback `竜巻注意情報（対象 N 地域）` を forced probe、(ii) aggregate fit なら `infeasible=aggregate`、(iii) aggregate も fail なら契約高内の固定最終 clip / ellipsis を出し `infeasible=clip` とする。最終 clip は「全地域を読めた」と扱わない。
- D2-B を選ぶ場合も、先頭 1 地域を含む fallback を probe し、fail 時は同じ最終 `clip` へ落とす。empty / cancellation は既存 state の責務であり fallback を起動しない。

### 3.6 診断・`--report` 契約

- root の専用番兵は `data-tornado-page`、`-keys`、`-identities`、`-infeasible`、`-footer`、`-visible-count` に加え、**平坦な** `data-tornado-page-host`、`-mode`、`-pending-appearance` を出す。後三者は `data-scheduler-state` に依存しない。
- capture script の属性 allowlist、observed object、TABLE / UTIL expectation、fixture assertion に全番兵を入れる。期待表には少なくとも常駐 real、rotation logical、epoch hold 解放後、infeasible のセルを持たせる。
- `data-scheduler-state` も tornado substate / active identity / host を含めてよいが、`--report` の判定根拠は前項の平坦属性とする。
- LegacyImprovedMock の型、record、probe、logical host、契約高、root 属性、fixture を本経路と同じに更新し、全件 rider を残さない。

## §4 未確定の判断分岐（ご主人裁定待ち）

### D1: weather 本文と tornado rider のページ座標

- **案 A: 独立 pager + weather host**。tornado は独立 `PageableKey` / identity を持ち、rotation では weather appearance に依存する。採用条件は、共通 paging/probe key、§3.2 の固定契約高、host weather が 1 page でも dependent が進むこと、全 live 組成の safety envelope、§3.4 の publish 順による settle 非振動である。
- 案 B: 複合 pager。weather / tornado の組を 1 identity / 1 partition として測り、1 marker で進める。fit 証明は単純だが、組合せ数と本文の再読が増えうる。
- 案 C: zipped coordinate。`max(Pw, Pt)` 個の対応表を決め、短い側は明示規則で再利用または空欄化する。積を避けられるが、対応規則と全 pair の fit を別途定義する必要がある。
- **推奨: 案 A**。weather の既存 page 意味を保てる。ただし採用条件を全て満たせなければ案 B / C を再評価し、独立 pager を実装しない。

### D2: 1 地域も fit しない場合

- 案 A: aggregate fallback → aggregate probe → 最終 clip / ellipsis の三段防衛（`aggregate|clip` を区別）。
- 案 B: 先頭 1 地域 fallback → probe → 最終 clip / ellipsis の三段防衛。
- **推奨: 案 A**。少なくとも対象件数を明示でき、読めない地域を表示済みと誤認させにくい。

### D3: marker の DOM・位置・ラベル

- 案 A: card 共通 footer に二段 / 二セグメントで `気象 1/3` と `対象地域 2/4` を並べる。
- 案 B: weather は既存 footer、tornado は rider 行末に `対象地域 2/4` を inline 表示する。
- 案 C: D1-B の複合 pager 専用に、card 全体の単一 `カード 2/4` marker とする。
- **推奨: 案 B**。独立 pager の番号を対象地域の近くに置き、本文 marker と意味を混ぜない。いずれの案でも marker 同士、weather body、rider text の rectangle overlap は 0 とする。

### D4: `isSighted` と reset

- 案 A: 地域列だけを resetKey とし、`isSighted` の上下変化では reset しない。
- 案 B: `isSighted` の上下どちらの変化でも reset する。
- 案 C: **`false→true` の危険側変化だけ** reset、`true→false` は active page を維持する。
- **推奨: 案 C**。危険度上昇は先頭地域から再提示し、解除側は読む途中のページを不用意に巻き戻さない。

## §5 実装単位

1. **型基盤**: `PagePartitionKey` / `PageableKey` を導入し、page-partition、types の `PageMeasureEntry`、probe id、StandbyScreen measurement entry / dispatch の全経路を layout `CardKey` から分離する。scheduler と mock の全 key record を tornado まで拡張する。
2. **identity / coordinator**: tornado identity adapter、D4 条件付き resetKey、appearance host、real/logical / epoch hold / successor の unit test。
3. **WeatherAlertCard と契約高**: tornado range、複数 readable probe body、D3 marker、§3.2 の固定 outer height を追加する。weather+tornado の safety envelope と pending / infeasible 三段防衛を component test する。
4. **StandbyScreen 配線**: side / center preflight、合成 forced probes、非振動の publish 順、solver selected/measured height・rotation reserve・pageFixedHeight の同値接続、overflow / marker overlap 診断を実装する。
5. **preview / `--report`**: LegacyImprovedMock 独立経路、fixture、平坦 tornado 番兵、capture allowlist、期待表 / assertion を更新する。

依存順は 1 → 2 → 3 → 4 → 5。D1-B/C を選ぶ場合は 2〜4 をその座標契約へ置換し、§6 を同時改訂する。

## §6 acceptance

### 共通のデータ・fit・高さ

- [ ] parser の優先層全地域が event、官署 state、統合 rider candidate まで順序どおり到達し、ticker / TTL / revision guard を変えない。
- [ ] 1、2、5、12 地域、同名地域、長い地域名、weather 本文あり / なしで、全可読 region の縦横 overflow が 0。`data-page-probe-readable` の全件検査で証明し、`overflow:hidden` による黙殺を許さない。
- [ ] 同名地域の page identity は occurrence により一意で、同名を含む update 後も active identity を正しく追跡する。
- [ ] tornado 単独 paging、weather 単独 paging、双方 paging、pending、pending→確定の全てで solver selected/measured height、rotation reserve、live outer `pageFixedHeight` が §3.2 の契約高と一致し、外枠高が揺れない。
- [ ] `pageScheduling=false` の棚は pager を登録・advance せず、forced range と本番同じ shell を測る。

### D1-A を採った場合

- [ ] tornado P page の常駐表示は **15×P 秒以内**に全地域を 1 回表示する。weather rotation set が R 枚なら **15×R×P 秒以内**に表示する。
- [ ] host weather が 1 page、tornado が P>1 の logical case、weather / tornado の双方が複数 page の case、side / center の各 case を観測する。非表示中の tornado advance はない。
- [ ] epoch hold 中の host appearance は layout motion 解放後にちょうど 1 step だけ反映し、`host/mode/pending-appearance` 番兵で観測できる。
- [ ] 集合・順序変更と D4 が要求する `isSighted` 変化は reset。同一 resetKey の再分割で active identity が消えた場合は successor-after-removal へ遷移し、先頭 reset を起こさない。
- [ ] 全 live weather/tornado 組成を probe、またはそれを安全側に包含する envelope を probe する。未測定の組成を fit とせず、publish / registration は確定結果だけで 1 回行われ settle oscillation を起こさない。

### marker、infeasible、番兵・回帰

- [ ] 1 page は marker なし、複数 page は D3 の裁定どおりの DOM・位置・ラベルを出す。marker 同士、weather body、rider text の overlap は全て 0。
- [ ] 1 地域 fail → D2 fallback probe → fallback 自身が fail なら最終 clip の多段防衛を通し、`data-tornado-page-infeasible` が `aggregate` / `clip` を正しく区別する。
- [ ] `data-tornado-page*`、host / mode / pending-appearance は capture allowlist と期待表を通って `--report` で検証され、quake / weather / flood 番兵と衝突しない。
- [ ] StandbyScreen、WeatherAlertCard、page-partition、time-slice scheduler、LegacyImprovedMock、capture `--report` の関連検査がグリーン。共有 scheduler / mock state を触るため `npm run test:shuffle` もグリーン。
