# spec: 竜巻注意情報カード内ページ送り（draft v0.1, 2026-08-23）

> 本書は (a) テロップ先行の完了後に残った (c) の起草である。§4 の判断分岐は未裁定であり、§3/§5/§6 の「推奨案」はその裁定を先取りして実装してはならない。

## §1 背景・目的

竜巻注意情報の対象地域は、(a) によりテロップでは優先粒度の全件を列挙できるようになった。一方、待機画面では竜巻は独立カードでなく `WeatherAlertCard` の rider であり、地域名が多いとカードの高さ上限内に収まらず、末尾が読めなくなる。

本変更の目的は、待機画面でも**全対象地域をカード内の有限ページで巡回表示**することだ。parser、官署単位の続報置換、期限（`ValidDateTime`、不在時 +1h）、1 分 sweep、revision guard は現行契約を維持し、対象外とする。

## §2 現状（2026-08-23 の実コード確認）

- `from-tornado.ts` は `selectPreferredTornadoLayer(info.layers)` の全 `areas` を `PresentationEvent.areaItems` / `areaNames` へ射影する。ここで先頭 1 件に落としてはいない。
- `StandbyStateStore.applyTornado()` はその `event.areaItems` を官署ごとの state に保存し、snapshot では各官署の地域を順序を保つ `Set` で統合して、`kind:"tornado"`, `surface:"weather-rider"`, `data.areas: string[]` として 1 rider に渡す。
- `WeatherAlertCard.svelte` の実装は背景時点の `areas[0]` ではない。現在は `tornado.data.areas.join("、")` を 1 本の `.tornado-rider` に描画している。カードは `max-height: min(44vh, 280px)` と `overflow:hidden` なので、全件保持は表示完結を意味しない。
- 気象本文は既に `sequentialPartitionRanges("weather", ...)`、forced `measurementRange`、`pageIdentity()`、`CardPageCoordinator` を使う。`omittedAreaCount` / tail-only entry も含めて、棚の実測 fit を 0/2 sentinel で返す経路がある。この「候補→forced-range 描画→identity→診断」の形を竜巻 rider の雛形とする。
- `CardPageCoordinator` の `PageableCardKey` は現在 `quake | weather | flood`。`flood` は compact/wide 双方で、props 注入、identity adapter、probe、`--report` 番兵まで配線済みである。rotation member なら logical（再登場時）、常駐なら real（15 秒 tick）で進む。
- rotation の appearance callback は layout `CardKey` を受ける。竜巻は layout card ではないため、単に `CardKey` に追加すると solver の `CARD_ORDER` 等まで汚染する。rider の logical 進行は host である `weather` の appearance と結び付ける必要がある。
- `StandbyScreen` は side / center の計測棚、`pagePartitionProbe()`、`renderPrefixProbe()`、live props 注入を持つ。fit 判定は `data-page-probe-card` と `data-page-probe-body` の縦横 overflow を見る。weather の probe は現在、**全竜巻 rider を含んだ**カードを測る。
- `--report` は `capture-legacy-standby.mjs` の属性 allowlist からのみ値を抽出する。flood の `data-flood-page*` は StandbyScreen 属性、allowlist、期待表（`TABLE_EXPECTATIONS` / `UTIL_EXPECTATIONS` 等）の三点が同期している。
- `LegacyImprovedMock.svelte` は scheduler を独立コピーしており、現在も `tornadoFullAreas` を全件 1 rider に連結する。ライブラリ側だけ更新しても preview / `--report` の実証にはならない。

## §3 設計（§4 D1 の推奨案を採った場合）

### 3.1 表示データと identity

- wire の `ActiveStandbyCardV1["tornado"].data.areas` は変更しない。全官署の統合、続報・寿命・復元の意味を paging 実装で再定義しない。
- `tornadoPageAreaEntries(areas)` を frontend lib に追加する。各 entry は `{ kindKey: "tornado", area, occurrenceIndex }` とし、同名を除去せず出現順の occurrence を付ける。wire に area code はないため `areaCode` は持たない。
- page identity は既存 `pageIdentity(entry)` を使う。label はページ先頭地域名とする。areas が空なら page は `0/0`、rider の既存 fallback 表記「対象地域」は保持する。
- resetKey は順序付きの地域名列（必要なら rider の表示種別 `isSighted` を含む）とする。集合・順序の変化は 1 ページ目へ reset、同一列の表示種別・更新時刻・restored のみの更新では active page を reset しない。active identity が消えたときは coordinator の既存 successor-after-removal 規則に従う。

### 3.2 coordinator と時間契約

- `PageableCardKey` に layout key と別の rider key `"tornado"` を追加する。`CardKey` / solver の候補列挙には追加しない。
- `CardPageRegistration` に logical host（推奨名 `appearanceHost?: CardKey`）を追加する。`recordRotationAppearance("weather")` は weather 自身に加え、host が weather の logical pager を 1 回だけ進める。epoch hold 中は既存 pending-appearance と同じく保留し、layout motion 解放後に 1 回だけ反映する。
- weather が常駐する side / center では tornado pager は real mode、15 秒ごとに進む。weather が rotation slot の member では logical mode、weather の**再登場ごと**に進む。非表示中に timer でページを消費しない。
- WeatherAlertCard は既存の weather registration と別に tornado registration を行う。`pageScheduling=false` の棚・単体 component では registration しない。unmount / tornado 消滅時は tornado を unregister し、古い `1/P` が残らないようにする。

### 3.3 カードと実測ページ分割

- WeatherAlertCard に tornado 用の `partitionProbe`、forced `measurementTornadoRange`、`measurementTornadoPageFooter`（名称は実装時に既存 props と整合させる）を追加する。forced range は通常の live scheduler を持たず、候補範囲だけを rider に描画する。
- rider は現在ページの `areas.slice(start,end)` のみを描画する。全件 `join()` は live / probe のどちらにも残さない。ページが 2 以上なら rider 内に `k/P` を表示する。気象本文の `card-page-footer` と同居する場合の footer 位置・一体表示は D3 の裁定に従う。
- `sequentialPartitionRanges("tornado", placement, ...)` を使い、fit sentinel は weather と同じ `fit=0 / fail=2` とする（fixedHeight `1` の既存 weather 契約）。`data-page-probe-card` は rider を含む実カード、`data-page-probe-body` は rider の可読領域を指す。縦だけでなく長い地域名による横 overflow も fail とする。
- side / center の preflight と forced-range 計測棚を追加する。probe id には `key=tornado`、placement、range、同時に描画する weather 文脈を含め、異なる組成の測定値を混用しない。
- `WeatherAlertCard` の既存 weather page probe は、竜巻ページ化後も選択中の rider range を含む live と同じ shell を測る。weather 本文と rider の組合せをどう有限化するかは D1 の完了条件であり、未測定の組合せを「fit」とみなしてはならない。

### 3.4 pending と infeasible 防衛

- probe 未計測の pending 中は、partition が返す provisional range を描画する。pager registration は確定 ranges のみで更新し、同一 epoch の `many → one → many` による reset を起こさない。
- pending 中は既存の全件 rider へ戻さない。全件連結は高さ超過を再導入するためである。
- 確定 `ranges: []` は、地域を黙って捨てる状態にしない。rider 専用の infeasible 表示（種別＋件数）を出し、`data-tornado-page-infeasible` で明示する。最終 clip を許容するか、可読な最小 1 地域へ縮めるかは D2 の裁定に従う。
- empty area と cancellation は既存 state の責務であり、pagination fallback を発火させない。

### 3.5 診断・`--report` 契約

- StandbyScreen root に tornado 専用属性を出す。推奨名は `data-tornado-page`、`data-tornado-page-keys`、`data-tornado-page-identities`、`data-tornado-page-infeasible`、`data-tornado-page-footer`、`data-tornado-page-visible-count`。既存 quake/weather の `data-card-page*`、flood の `data-flood-page*` を上書きしない。
- capture script の allowlist、observed object、期待表定数、fixture assertion を同一 patch で更新する。DOM に属性を追加するだけでは `--report` は検証しない。
- `data-scheduler-state` の paging diagnostics に tornado substate / active key / host を含める。rotation 中の logical advance と epoch hold の観測根拠とする。
- `LegacyImprovedMock` の独立 pager、tornado fixture、probe shell、report 属性を本実装と同じ契約に追随させる。mock の全件 rider を残して実装の代替テストにしてはならない。

## §4 未確定の判断分岐（ご主人裁定待ち）

### D1: weather 本文と tornado rider のページ座標

- **案 A: 独立 tornado pager + weather host 連動**。§3 の推奨案。tornado は専用 `PageableCardKey` と identity を持ち、rotation 中だけ weather appearance に追随する。常駐時は tornado だけ 15 秒で進む。本文と rider の各ページ組合せを実測する必要がある。
- 案 B: weather と tornado を 1 つの複合 pager にする。組合せごとに 1 identity / 1 footer となり fit 証明は明快だが、本文ページと地域ページが同じ周期で進み、ページ数が積になりうる。
- **推奨: 案 A**。既存 weather の表示契約を最も保てる。ただし §3.3 の「全 live 組合せを測定または安全側に包含する」証明を実装設計レビューの blocking 条件とする。証明できない場合は案 B に戻す。

### D2: rider 単独でも 1 地域が fit しない場合

- 案 A: 「竜巻注意情報（対象 N 地域）」の aggregate fallback を出し、`infeasible=aggregate` を報告する。
- 案 B: 先頭 1 地域を優先して clip し、`infeasible=clip` を報告する。
- **推奨: 案 A**。読めない地域名を見せたように扱わず、少なくとも対象件数を明示できる。

### D3: page footer の表現

- 案 A: weather 本文・tornado rider で別々の `k/P` を表示する。
- 案 B: rider のページ数だけを rider 行末に表示し、weather footer は従来どおりにする。
- **推奨: 案 B**。二つの独立 pager を採る D1-A と整合し、どちらの地域を送っている番号かを近接表示できる。既存 weather footer との rectangle overlap は専用診断でゼロを要件化する。

### D4: `isSighted` の resetKey への含め方

- 案 A: 地域列だけを resetKey にし、目撃情報付きへの更新でも読んでいたページを維持する。
- 案 B: `isSighted` も resetKey に含め、危険度の表示が変わる更新では 1 ページ目から再提示する。
- **推奨: 案 B**。目撃情報付きは rider 見出し・配色が変わるため、先頭の対象地域とともに再提示する方が安全側だ。

## §5 実装単位（D1-A を採る場合）

1. **identity / coordinator**: `tornadoPageAreaEntries`、`PageableCardKey`、appearance host、全 record・diagnostics・scheduler unit test。
2. **WeatherAlertCard**: tornado range / partition / registration / rider footer / pending・infeasible 表示。component test で同名地域、empty、目撃情報、resetKey、footer を確認。
3. **StandbyScreen 計測・live 配線**: side / center preflight、forced probe、組成を区別する probe id、rotation host、epoch hold、overflow / overlap 診断。
4. **preview / 番兵**: LegacyImprovedMock の独立実装、fixture、root attributes、capture allowlist、期待表、`--report` assertion。

依存順は 1 → 2 → 3 → 4。D1-B を選ぶ場合は 1–3 を複合 partition / 複合 identity 前提に置き換え、D2/D3 の acceptance を同期して改訂する。

## §6 acceptance

### 共通

- [ ] parser の優先層全地域が `PresentationEvent`、standby state、rider candidate に順序どおり到達し、ticker / 官署単位続報置換 / TTL / revision guard の既存テストを壊さない。
- [ ] 1、2、5、12 地域で、通常 viewport と長い地域名を含む fixture の全対象地域が有限時間内に表示される。未測定の overflow、横 overflow、`overflow:hidden` による黙殺を許さない。
- [ ] 1 page は footer なし、2 page 以上は D3 の裁定どおりの page marker を出す。既存 weather marker と rider marker の body / rider rectangle overlap は 0。
- [ ] pending は provisional range を表示し全件連結へ戻らず、確定まで scheduler registration を揺らさない。
- [ ] cancellation / area なしで pager と番兵が `0/0` に戻り、古い page label・identity が残らない。

### D1-A（推奨案）を採った場合

- [ ] 常駐 weather では tornado が 15 秒 tick ごとに 1 ページ進む。weather が rotation slot にいる間は、その再登場ごとにのみ 1 ページ進み、非表示中に進まない。
- [ ] epoch hold 中の weather 再登場は layout motion 解放後に 1 回だけ tornado を進める。
- [ ] weather 本文の各 live page と tornado rider の各 live page の組合せ、またはそれを安全側に包含する測定が fit を証明する。証明不能な組合せは pager 登録しない。
- [ ] 地域集合・順序変更、および D4 が採用されれば `isSighted` 変更は 1 ページ目へ reset。同一 resetKey の更新は active page を強制的に先頭へ戻さない。

### infeasible / 番兵・回帰

- [ ] D2 の裁定どおり aggregate または clip が発火し、`data-tornado-page-infeasible` が `--report` に出る。通常 fit する構成では `false` である。
- [ ] `data-tornado-page*` は capture allowlist と期待表を通って照合され、既存 quake / weather / flood の属性と衝突しない。
- [ ] StandbyScreen、WeatherAlertCard、time-slice scheduler、LegacyImprovedMock、capture `--report` の関連検査がグリーン。共有 scheduler / mock state を触るため `npm run test:shuffle` も通す。
