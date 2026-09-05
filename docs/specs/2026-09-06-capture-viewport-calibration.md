# Standby capture viewport 校正 spec

> **裁定（2026-09-06 朝、ご主人）**: §3 の裁定点はすべて推奨案を採用。独立 DOC レビュー（Sol high、新規 read-only スレッド）2 巡で DOC-OK。


## 1. 症状

通常 gate の viewport 契約は未校正である。通常 `--scenario` / `--fixture` / `--report` は `--window-size=W,H` だけを指定し、PNG と DOM dump を別 Chrome process で取得する（`display/scripts/capture-legacy-standby.mjs:899-923`）。通常 record の要求 viewport は入力値の転記であり、実際の `window.innerWidth`、`window.innerHeight`、`window.devicePixelRatio` を取得・assert しない（`:969-972`）。

通常 DOM は closing `</html>`、containment、rotation、clock 等も検査している（`:416-468`, `:947-967`）。したがって不足を「DOM assertion 全般」とはしない。不足しているのは viewport / readiness 契約であり、standby では `data-measurement-settled=true`、emergency ではその例外だけで、実 viewport / DPR と capture 前後の同一状態を証明しない点である（`:467`, `:945-968`）。

design-alignment は CDP で `Emulation.setDeviceMetricsOverride` を適用し（`:1762-1790`）、実 `innerWidth` / `innerHeight` を report し（`:1739-1742`）、manifest 指定値との一致を assert する（`:1930-1935`）。ただし DPR と browser version は未記録・未 assertion である。

旧通常 gate の `max / 1280x720` 期待表は stage 3・rotation 6 本だが（`:813-818`）、真 viewport を保存した design-alignment record は同じ `gateScenario=max` で `inner=1280x720`、stage 3・rotation 3 本である（`display/tmp-capture/review-base.json:13753-13798`; `display/tmp-capture/footer-base.json:369908-369952`）。旧 1920x1080 stage 1 についても、既存 spec は「viewport 高 577px 時代の値」と記す（`docs/specs/2026-09-05-standby-card-page-footer-contract.md:363-367`）。

ただし通常経路の既存 JSON に実 `innerHeight`、DPR、browser version、payload signature、candidate count はない。「577px はこの checkout の証跡だけで全 Chrome・全 host において断定できる」とはしない。`1280x720 - 577 = 143px` の容量回復と rotation 6→3 の因果は仮説であり、§3.6 の fresh control / calibrated pair と機械 verifier が承認した場合だけ校正由来と判定する。旧 JSON と新 JSON の比較だけでは判定しない。

製品レイアウト修正、特に 720p の RecentQuakes とテロップの干渉は本 spec の非対象である。

## 2. 根因

根因は次の三点である。

1. 通常 capture と補助 `captureLiveGeometry()` は `--window-size` のみで起動し、device-metrics override を適用しない（`display/scripts/capture-legacy-standby.mjs:193-198`, `:907-910`）。
2. 通常 PNG、DOM dump、補助 geometry は別 process / session であり、同じ描画状態を証明できない（`:913-930`）。補助 geometry は fonts ready と連続二回同一 geometry を待つが（`:217-225`, `:366-379`）、capture 本体との同一性は保証しない。
3. 通常 report は要求 viewport を実測値として扱い（`:969-972`）、design-alignment も実測 DPR / browser metadata を欠く（`:1739-1742`, `:1820-1824`）。さらに通常 `--report` は table assertion を無効化し、mismatch を JSON に書くだけで成功終了する（`:964-972`, `:2915-2919`）。実測・schema・受入結果の証拠連鎖が閉じていない。

## 3. 変更

### 3.1 共通 browser-session helper・metadata・readiness

`captureDesignAlignmentPage()` の CDP pipe 起動、page target attach、`Page.enable` / `Runtime.enable`、device-metrics override、評価、終了処理を共通 browser-session helper へ切り出す（`display/scripts/capture-legacy-standby.mjs:1762-1828`）。通常 capture、補助 geometry、design-alignment は同じ helper を使う。

helper は次を明示的な引数とする。

- `requestedViewport: { label, width, height }`
- `viewportMode: "legacy-control" | "calibrated"`。control は override なし、calibrated は `Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile: false })`
- `readinessKind: "standby" | "emergency"`
- `virtualTimeBudgetMs: 10000 | null`
- `sessionRole: "primary" | "comparator"`

attach 後に `Browser.getVersion` を実行し、`requestedBinary`、`protocolVersion`、`product`、`revision`、`userAgent`、`jsVersion` を全 record の `browser` に保存する。fresh pair ではこれらの完全一致を要求する。起点は現行 design CDP session（`:1762-1790`）である。

CDP command、target 待機、readiness loop、screenshot、process 終了を含む一 capture 全体に 120 秒の deadline を設ける。期限超過時は pending command を reject し Chrome を kill して非0終了する。現行 CLI artifact watchdog の期限を失ってはならない（`:67-104`）。

readiness predicate は画面種別で分ける。

- **standby**: `await document.fonts.ready` 完了、`document.fonts.status === "loaded"`、`.standby` と `main.preview-screen` が存在、`data-measurement-settled === "true"`、実 viewport と診断 snapshot が連続二回完全一致。design expression の現行条件を共通化する（`:1309-1314`, `:1798-1811`）。
- **emergency**: `await document.fonts.ready` 完了、`document.fonts.status === "loaded"`、`main.preview-screen` が存在、`data-preview-mode === "emergency"`、`data-preview-attention-visibility === "true"`、emergency panel が二つ以上 measurable、panel containment / indicator overlap / probe-live geometry が既存 assertion を満たし、実 viewport と emergency geometry snapshot が連続二回完全一致する。`.standby` と `data-measurement-settled` は要求しない（`:467`, `:494-524`, `:945-968`）。
- **attention comparator**: attention standby / reduced-motion の baseline URL は primary と同一 snapshot ではない。現行どおり別 URL を別 session で採るが（`:931-938`）、`sessionRole="comparator"` と primary record key を保存し、同じ requested viewport、viewport mode、browser metadata、standby readiness、二回一致を独立に満たす。primary / comparator を「同一 snapshot」と表現しない。emergency は comparator を持たない。

### 3.2 通常 capture の同一 session 化と既存挙動

通常 `capture()` の CLI `--screenshot` / `--dump-dom` 二重起動を、primary CDP session の次の処理へ置換する。

1. readiness snapshot を連続二回一致させる。
2. `Runtime.evaluate` で diagnostics、geometry、payload / candidate / font / capacity signatures と DOM を採る。
3. `Page.captureScreenshot({ format: "png", fromSurface: true, captureBeyondViewport: false })` を clip なしで実行する（`display/scripts/capture-legacy-standby.mjs:1812`）。
4. 同じ evaluation を再実行し、screenshot 前後の readiness / diagnostics / signatures が完全一致することを assert する。
5. PNG 完全性と DOM 完全性を既存 assertion で確認する（`:408-418`）。

DOM は `document.documentElement.outerHTML` だけでなく、doctype がある場合は `new XMLSerializer().serializeToString(document.doctype) + "\n"` を前置する。現行 `--dump-dom` と byte-equivalent であるとは主張しないが、doctype と closing HTML、`diagnosticsFromDom()` が必要とする属性を維持する。通常 capture の DOM は現行どおり parse 後に削除するが、calibration pair だけは §3.3 の offline evidence として sidecar を保存する（`:915-923`, `:970-971`）。

通常 / fixture / legacy-control / calibrated は既存の `--virtual-time-budget=10000` を維持する（`:907-910`）。design-alignment は従来どおり virtual-time budget なしとする（`:1766-1769`）。helper の route profile と unit test でこの差を固定し、暗黙に統一・廃止しない。

通常 record の artifact 名、scenario / fixture / rotation / card-page tick の走査、既存の DOM diagnostics assertion は維持する（`:899-972`, `:2882-2919`）。

### 3.3 report schema と assertion

schema は `schemaVersion: 2` とし、要求値と実測値を次の一箇所に固定する。`record.viewport` を実測値で上書きしてはならない。

```json
{
  "schemaVersion": 2,
  "browser": {
    "requestedBinary": "chrome",
    "protocolVersion": "...",
    "product": "Chrome/...",
    "revision": "...",
    "userAgent": "...",
    "jsVersion": "..."
  },
  "viewport": {
    "label": "1280x720",
    "width": 1280,
    "height": 720
  },
  "geometry": {
    "viewport": {
      "innerWidth": 1280,
      "innerHeight": 720,
      "devicePixelRatio": 1
    },
    "readiness": {
      "kind": "standby",
      "fontsLoaded": true,
      "measurementSettled": true,
      "stableSampleCount": 2
    }
  }
}
```

配置契約は次のとおりである。

- 通常 `legacy-standby-*.json` は上記 record 自体を保存する。
- 通常 stdout `--report` は `{ schemaVersion: 2, outDir, cells }` とし、各 `cells[]` が同じ `browser`、要求 `viewport`、実測 `geometry.viewport`、readiness、mismatches を持つ。
- design の `--write-baseline` report、`design-alignment-records.json`、after stdout / saved record は wrapper と各 `records[]` の双方を schema v2 とする。
- calibration artifact は `{ schemaVersion: 2, kind: "viewport-calibration-pair", calibrationRunId, evidenceAlgorithm, pairs, summary }` とする。`pairs[]` は `{ cellKey, control: { repeats }, calibrated: { repeats }, verdict }` とし、各 `repeats[]` は `{ rotationKeys, ticks }`、各 `ticks[]` は同じ schema v2 の capture record とする。各 mode を二回反復し、tick の範囲は §3.6 に従う。
- `measurementSettled` は standby で `true`、emergency で `null` とする。emergency を偽の `true` で埋めない。

全 calibrated capture は screenshot 前に `geometry.viewport.innerWidth === record.viewport.width`、`innerHeight === record.viewport.height`、`devicePixelRatio === 1` を assert する。legacy-control は DPR=1 と finite positive viewport を assert するが、要求高さとの不一致を観測可能にする。design の既存幅高 assertion は新 field 名へ置換する（`display/scripts/capture-legacy-standby.mjs:1930-1935`）。

calibration pair の各 tick record は、offline verifier が保存済み `verdict` を信用せず再計算できるよう、次の `evidence` を必須とする。

- `evidence.snapshots.stable[0..1]`、`preScreenshot`、`postScreenshot`: evaluation が返した canonical snapshot の実体と SHA-256。snapshot は `geometry.viewport`、readiness、diagnostics、layout、capacity、全 signatures を含み、時刻・path のような非決定値を含めない。
- `evidence.png`: artifact root からの相対 `path`、`byteLength`、IHDR の `width` / `height`、SHA-256。offline verifier は file を読み直し、signature / IEND、size、dimensions、hash を再検査する。
- `evidence.dom`: artifact root からの相対 sidecar `path`、`byteLength`、SHA-256。offline verifier は file を読み直し、doctype、closing `</html>`、size、hash、diagnostics 再抽出結果を検査する。pair の sidecar は online verification 後も削除しない。

canonicalization は `canonical-json-v1` とする。object key を UTF-16 code unit 昇順で再帰 sort、array 順を保存、`undefined` を禁止、finite な JSON scalar だけを許し、`JSON.stringify` した UTF-8 bytes を SHA-256、lowercase hex で保存する。PNG / DOM は file bytes そのものを SHA-256 にする。artifact の `evidenceAlgorithm` は `{ canonicalization: "canonical-json-v1", hash: "sha256", textEncoding: "utf-8" }` と完全一致しなければならない。

### 3.4 `--assert-from` と mismatch の終了状態

`--suite design-alignment --assert-from` は browser を起動せず保存 JSON を再 assertion する replay-only 経路である（`display/scripts/capture-legacy-standby.mjs:2804-2819`, `:2841-2848`）。次のいずれかを欠く after または baseline は schema 不足として非0終了する。

- wrapper と全 record の `schemaVersion === 2`
- `record.viewport.{label,width,height}`
- `record.geometry.viewport.{innerWidth,innerHeight,devicePixelRatio}`
- `record.browser` の必須六 field
- 画面種別に対応する `record.geometry.readiness`

値の推測、旧 field からの補完、browser 起動による救済はしない。unit test は「旧 schema after」「旧 schema baseline」を別々の negative case として必須化する。現行 replay routing test は `display/frontend/src/components/__tests__/capture-design-alignment.test.ts:905-919` にある。

各 record は `expectationPolicy` を次のいずれかで持つ。`tableMismatches()` は policy に対応する source だけを参照し、fixture-specific expectation がない fixture を通常表へ fallback させない。現行 fallback は `display/scripts/capture-legacy-standby.mjs:831-842` にある。

- `normal-table`: `fixture == null` の通常 cell。`TABLE_EXPECTATIONS` / `UTIL_EXPECTATIONS` / flood /通常 tornado expectation と比較する。
- `fixture-table`: `TORNADO_FIXTURE_EXPECTATIONS` に該当する fixture cell。その専用表だけと比較する。
- `fixture-assertions-only`: attention、emergency、briefing、recent-quakes、cluster / cluster-calm 等、専用表を持たない positive fixture。通常 table mismatch は生成せず、専用 assertion の成功で判定する。
- `expected-failure`: `overflow` / `rotation`。positive report matrix から除外し、下記の structured error を negative harness で検査する。

standard `--report` は JSON / PNG を書き終えた後、`normal-table` / `fixture-table` の `mismatches` が一件でもあれば `process.exitCode = 1` とする。`fixture-assertions-only` は専用 assertion 違反時に非0終了する。readiness / schema / containment 違反も従来どおり非0である。mismatch を表示するだけで成功終了する現行挙動（`:964-972`, `:2915-2919`）は廃止する。

`overflow` は `CARD_SCROLL_CONTAINMENT`、`rotation` は `ROTATION_VIEWPORT_FOOTER_GEOMETRY` の安定した `CaptureAssertionError.code` で非0終了させる。前者は card 高を 1px に壊す反証（`display/frontend/src/components/StandbyScreen.svelte:2305-2310`; assertion `display/scripts/capture-legacy-standby.mjs:605-608`）、後者は rotation footer を消す反証（`display/frontend/src/components/StandbyScreen.svelte:2322`; assertion `display/scripts/capture-legacy-standby.mjs:761-775`）である。§5.3 の harness は underlying capture が非0で、指定 code と一致するときだけ成功する。

`--write-report PATH` は stdout と同じ wrapper を保存する。offline `--assert-capture-report PATH` は `--expect-suite`、`--expect-viewport-mode`、`--expect-cells`、`--expect-mismatches` を任意の必須条件として受け、schema、全 record の recorded mode、cell 数、policy、mismatch 総数を raw record から検査する。normal / design の default mode を受入 command 自身が証明するために使う。

Stage ①は実装前 base から `TABLE_EXPECTATIONS`、`UTIL_EXPECTATIONS`、`FLOOD_WIDE_EXPECTATIONS`、`TORNADO_EXPECTATIONS`、`TORNADO_FIXTURE_EXPECTATIONS` を `canonical-json-v1` で直列化した SHA-256 を作業契約の `BASE_EXPECTATION_SHA256` として固定する。`--verify-legacy-expectation-digest "$BASE_EXPECTATION_SHA256"` は現 checkout の五 object を再計算し、不一致時に非0終了する。mode 無指定の18-cell capture と併用し、「legacy-control の主張と期待値が Stage ①配送前後で同一」を機械的に証明する。

Stage 2 の対照採取は standard `--report` の例外にせず、専用 `--calibration-pair` command が fresh pair を採って verifier を実行する。pair command と offline `--verify-calibration-pair` は verifier reject 時に非0終了する。

### 3.5 `captureLiveGeometry()` の統合方針

独立 Chrome を起動する `captureLiveGeometry()` は廃止し、primary session の evaluation helper へ統合する（`display/scripts/capture-legacy-standby.mjs:193-379`, `:927-943`）。PNG、DOM、通常 geometry は同じ primary snapshot から得る。

唯一の複数 session 例外は attention standby / reduced-motion の baseline comparator である。これは §3.1 の別 URL / 別 comparator session として明示し、それぞれ独立した真 viewport・readiness・browser metadata を記録する。`--window-size` だけの無記録 session は残さない。

### 3.6 fresh pair と機械 verifier による校正

旧通常 JSON と新 calibrated JSON の比較だけで期待表を更新してはならない。Stage 2 の `--calibration-pair` は、同じ新 helper・同じ command invocation で各 cell を次の順に採る。

1. **legacy-control #1**: device-metrics override なし。`--window-size` が作る実 viewport を schema v2 で測る。
2. **calibrated #1**: 同じ requested viewport へ `Emulation.setDeviceMetricsOverride(..., deviceScaleFactor=1)` を適用して測る。
3. 同条件の **legacy-control #2 / calibrated #2** を再採取する。readiness 内の連続二 sample とは別の browser capture 反復である。
4. exported verifier を即時実行し、四つの raw record、再計算値、verdict を一つの `pairs[]` entry に保存する。

各 pair は同じ `calibrationRunId` を持つ。offline verifier は §3.3 の canonical snapshot 実体、PNG、DOM sidecar を読み直し、hash と derived field を再計算する。保存済み hash、`stableSampleCount`、`verdict` だけを比較して合格させない。

比較対象の launch profile は `record.capture.commonLaunchProfile` とし、headless mode、sandbox / first-run / GPU / scrollbar、forced device scale、requested window size、virtual-time budget を正規化した object とする。ephemeral profile path と target id は除外する。`record.capture.viewportMode` と `record.capture.deviceMetricsOverride` は profile 外へ置き、control / calibrated 間で差があるべき二 field とする。verifier は `commonLaunchProfile` の完全一致と、control の `deviceMetricsOverride === null`、calibrated の `{ width, height, deviceScaleFactor: 1, mobile: false }` を別々に検査する。

signature の JSON path と順序は次に固定する。各 field は canonical value とその SHA-256 を保持し、offline verifier が hash を再計算してから値を比較する。

- `geometry.signatures.fonts`: `{ family, style, weight, stretch, status }` を tuple の各 field 順に code-unit sort した array。同じ tuple の重複は保持する。
- `geometry.signatures.payload`: fixture が page へ投入した正規化 payload object。object key は `canonical-json-v1`、payload 内 array は入力順を保存する。
- `geometry.signatures.candidates`: `{ key, count }` を `key` 昇順にした array。
- `geometry.signatures.logicalItems`: `{ kind, identity, occurrence }` の入力順 array。sort せず、同一 identity の `occurrence` は0始まりで増やす。

placement の比較は occurrence-aware identity の **multiset** とする。`geometry.layout.placement.left/right/center`、`rotation`、`omitted` は順序付き array として保存する一方、保存則は全四領域を結合した `{ identity -> count }` の完全一致で検査する。各領域内の順序、rotation active identity / position も別 assertion として固定する。

高さ予算は surface ごとに次式で再計算する。`members_s` はその surface の static placement、`h_s(i)` は同 capture / surface で測った candidate natural height、`g_s` は track gap である。

```text
used_s(mode) = sum(h_s(i) for i in members_s(mode))
             + g_s(mode) * max(0, count(members_s(mode)) - 1)
headroom_s(control) = available_s(control) - used_s(control)
recovered_s = available_s(calibrated) - available_s(control)
incremental_s = used_s(calibrated) - used_s(control)
```

全 surface で `available_s` / `used_s` が finite、`used_s(calibrated) <= available_s(calibrated) + 1px`、`incremental_s <= headroom_s(control) + recovered_s + 1px` を要求する。複数 member の昇格、別 surface への再配置、gap 数の変化は `used_s` の全 member 再計算へ含め、member ごとの単純な高さ比較へ縮約しない。さらに `recovered_s` と `innerHeight(calibrated) - innerHeight(control)` は 1px 以内で一致しなければならない。

rotation は tick 0 だけで比較しない。各 mode / 各反復の tick 0 からその mode 固有の `rotationKeys` を読み、`ticks[]` に `0..max(0, rotationKeys.length - 1)` を全採取する。rotation なしでも tick 0 を一件持つ。control が6 keys、calibrated が3 keysなら、それぞれ6件 / 3件を別 array に保存し、短い側へ揃えない。verifier は全 tick の active identity、position、viewport / footer geometry、readiness / evidence と、同一 mode 二反復の完全一致を検査する。

以上を前提に verifier は次を再計算する。

- schema、canonical snapshot 二連続一致、screenshot 前後一致、PNG / DOM 完全性が全 tick で成立する。
- `requestedBinary` と `Browser.getVersion` 由来の五 field、`commonLaunchProfile`、requested viewport、normalized URL/query、scenario、fixture、card-page tick が全 capture で一致する。
- four signatures、root font size、論理 item identity / order が一致する。
- control は override なし、calibrated は override あり、両者の `devicePixelRatio === 1`、`innerWidth` が一致し、calibrated の inner width / height が要求値と一致する。
- control の `normal-table` / `fixture-table` mismatch が空で、checked-in の旧期待値を fresh capture で再現する。`fixture-assertions-only` を通常表と比較しない。旧 JSON は判定入力に使わない。
- viewport 高さ以外の入力・環境・payload が一致する。control が旧期待値を再現しない、幅 / DPR / font / payload 等も変わる、または高さが同じなのに layout が変わる場合は reject する。
- multiset 保存則と surface 別高さ予算式を満たし、`data-layout-unresolved === "false"`、`data-measurement-nonconverged === "false"`、card / readable overflow は 1px 以下、rotation omitted 増加 0、clipping / footer overlap / pager identity 欠落 0である。

上記を満たさない cell は `verdict="rejected"` とし、理由 code と raw record path を出す。一件でも reject なら command は非0終了する。`577→720` は verifier が fresh control でその高さ差を実測した cell に限って記載できる。577px を再現しない場合は仮説のまま残し、期待表を更新しない。

verifier が `approved` とした cell だけを Stage 3 の期待値候補にできる。候補値は verifier が raw diagnostics から生成し、人手で design-alignment plan や旧 / 新 JSON を一括コピーしない。更新対象候補は `TABLE_EXPECTATIONS`（`display/scripts/capture-legacy-standby.mjs:813-818`）、`UTIL_EXPECTATIONS`（`:819-829`）、`max-floodWide`（`:806-809`）、tornado expectation / fixture 表（`:780-802`, `:791-796`）である。design manifest / plan 値（`:980-1018`, `:1258-1276`）を通常期待表へコピーしてはならない。

Stage 3 の `--verify-calibrated-expectations PAIR.json` は approved pair の raw calibrated diagnostics から候補 object を再生成し、対象となる checked-in expectation object と key set・value を deep-equal で照合する。approved cell の欠落、rejected cell の混入、余分な手修正、候補と期待表の不一致は非0終了する。通常 pair と tornado fixture pair の全 report に対して成功しなければ、standard browser report が緑でも期待表更新は受入れない。

### 3.7 三段階の配送単位と裁定点

三段階は一 commit ずつの独立した配送・revert 単位とし、後段へ前段の変更を混ぜない。

| 段階 | commit 内容 | この段階で禁止 | 独立受入 |
|---|---|---|---|
| ① capture contract | 共通 helper、schema v2、`Browser.getVersion` metadata、standby / emergency readiness、attention comparator、同一-session PNG / DOM、120秒 deadline、fixture policy、`--report` mismatch 非0化、unit test | 期待表変更、calibrated 値への default 切替、tracked capture artifact | mode 無指定の通常18-cellが legacy-control /旧期待値 mismatch 0、attention comparator、emergency、design v2 baseline、schema / timeout / serialization test |
| ② calibration verifier | fresh legacy-control / calibrated pair、capacity/signature 採取、online / offline verifier、pair artifact format | 期待表変更、default 切替、Stage 2 scratch artifact の tracking | 18-cell と expectation-bearing fixture の pair を verifier が全件承認。旧 JSON 非依存を test |
| ③ calibrated gate | verifier 承認済み期待値だけを更新、通常 default を calibrated へ切替、承認済み pair / verdict /必要最小限 PNG と校正前 provenance を tracked artifact 化、全 browser matrix / replay、配送 | 製品 layout / payload / solver semantics の変更、rejected cell の期待値化 | approved候補と期待表が完全一致、mode 無指定 report が calibrated、positive gate 0、negative fixture は指定 code で非0 |

裁定点は次のとおりとする。

- **(a) 一括統一 A / 通常のみ先行 B**: **A を採用**する。三経路は Stage ①で共通 helper へ統一し、emergency と comparator は同 helper の明示 predicate / role とする。
- **(b) 1〜2 commit / 三段階 commit**: review 後は **三段階を採用**する。期待値更新を helper と verifier から分離し、各段階を単独配送・reverse-order rollback 可能にする。
- **(c) tracked artifact / untracked / 削除**: **tracked artifact を採用**する。現行 `display/tmp-capture/` は上書き・削除せず、Stage ③で選定した校正前 JSON は `pre-calibration/` に provenance / checksum とともに「verdict 入力ではない historical evidence」として複製する。fresh approved pair / verdict は `approved/` に置く。scratch と全 PNG を無差別に追跡しない。

## 4. 対象ファイル

| 段階 | ファイル | 現行 file:line | 役割 |
|---|---|---|---|
| ①〜③ | `display/scripts/capture-legacy-standby.mjs` | `:67-104`, `:193-379`, `:408-468`, `:780-972`, `:1298-1320`, `:1739-1828`, `:1930-1954`, `:2804-2919` | helper、capture、schema、metadata、verifier、CLI、期待表 |
| ①〜② | `display/frontend/src/components/__tests__/capture-design-alignment.test.ts` | `:118-159`, `:571-1046` | helper / schema / emergency / verifier / replay / negative unit test |
| ③ | `display/artifacts/legacy-standby-viewport-calibration/` | 新規 | approved pair、verdict、design v2 records、校正前 provenance、必要最小限の比較 PNG |
| spec | `docs/specs/2026-09-06-capture-viewport-calibration.md` | 本文全体 | 本契約 |

`StandbyScreen`、solver / stage API、parser、fixture payload、候補数、pager / scheduler semantics、製品 CSS / DOM、theme token、表示レイアウトは全段階で対象外である。720p RecentQuakes とテロップの干渉も別 spec / commit で扱う。

## 5. 受入条件

### 5.1 Stage ① — capture contract

unit test は少なくとも schema の固定配置、`Browser.getVersion` 必須 field、calibrated viewport / DPR assertion、standby / emergency predicate、attention comparator role、virtual-time route profile、screenshot 引数、doctype 付き DOM serialization、120秒 timeout、旧 schema after / baseline の個別 rejection、fixture policy、`--report` mismatch 非0化を検査する。`parseCaptureArgs([])` と通常 record は default `viewportMode="legacy-control"`、design record は `viewportMode="calibrated"` であることを assert する。

```sh
npm run build
npm test
npm --prefix display run build
npm --prefix display run test
npm --prefix display run typecheck

test -n "$BASE_EXPECTATION_SHA256"
node display/scripts/capture-legacy-standby.mjs \
  --verify-legacy-expectation-digest "$BASE_EXPECTATION_SHA256"

CHROME_BIN="${CHROME_BIN:-chrome}" \
node display/scripts/capture-legacy-standby.mjs --report \
  --write-report display/artifacts/legacy-standby-viewport-calibration/stage-1/normal-report.json \
  --out-dir display/artifacts/legacy-standby-viewport-calibration/stage-1/normal-report

node display/scripts/capture-legacy-standby.mjs --assert-capture-report \
  display/artifacts/legacy-standby-viewport-calibration/stage-1/normal-report.json \
  --expect-suite normal --expect-viewport-mode legacy-control \
  --expect-cells 18 --expect-mismatches 0

CHROME_BIN="${CHROME_BIN:-chrome}" \
node display/scripts/capture-legacy-standby.mjs \
  --out-dir display/artifacts/legacy-standby-viewport-calibration/stage-1/normal-assert

for fixture in \
  attention-visibility-standby attention-visibility-reduced-motion \
  attention-visibility-emergency; do
  CHROME_BIN="${CHROME_BIN:-chrome}" \
  node display/scripts/capture-legacy-standby.mjs --fixture "$fixture" --report \
    --out-dir display/artifacts/legacy-standby-viewport-calibration/stage-1/attention
done

CHROME_BIN="${CHROME_BIN:-chrome}" \
node display/scripts/capture-legacy-standby.mjs --suite design-alignment --report \
  --out-dir display/artifacts/legacy-standby-viewport-calibration/stage-1/design-base \
  --write-baseline display/artifacts/legacy-standby-viewport-calibration/stage-1/design-base.json

node display/scripts/capture-legacy-standby.mjs --assert-capture-report \
  display/artifacts/legacy-standby-viewport-calibration/stage-1/design-base.json \
  --expect-suite design-alignment --expect-viewport-mode calibrated \
  --expect-mismatches 0
```

全 command は mode 指定なしである。通常 report がちょうど18-cell、全 record が `legacy-control`、旧期待値 mismatch 0、expectation digest 不変であり、通常 non-report gate も成功しなければ Stage ①を配送しない。attention standby / reduced-motion は comparator session、emergency は固有 readiness、design baseline は calibrated schema v2 を実 browser で証明する。この条項が、Stage ①を今夜単独で main へ配送しても既存 gate の主張が変わらないことの機械的条件である。

### 5.2 Stage ② — fresh pair と verifier

display build 後、既存の通常 18-cell（4 scenario × 4 viewport と `max-floodWide` 2 viewport。走査は `display/scripts/capture-legacy-standby.mjs:18-21`, `:2882-2919`）を一 command で control / calibrated の順に採る。

```sh
npm --prefix display run build

CHROME_BIN="${CHROME_BIN:-chrome}" \
node display/scripts/capture-legacy-standby.mjs --calibration-pair \
  --out-dir display/artifacts/legacy-standby-viewport-calibration/stage-2/pair \
  --write-calibration-report display/artifacts/legacy-standby-viewport-calibration/stage-2/pair.json

node display/scripts/capture-legacy-standby.mjs --verify-calibration-pair \
  display/artifacts/legacy-standby-viewport-calibration/stage-2/pair.json
```

tornado expectation / fixture 表も fresh pair で検査する。

```sh
for fixture in tornado-pages tornado-aggregate tornado-clip tornado-epoch-release; do
  CHROME_BIN="${CHROME_BIN:-chrome}" \
  node display/scripts/capture-legacy-standby.mjs --calibration-pair --fixture "$fixture" \
    --out-dir "display/artifacts/legacy-standby-viewport-calibration/stage-2/$fixture" \
    --write-calibration-report "display/artifacts/legacy-standby-viewport-calibration/stage-2/$fixture.json"
  node display/scripts/capture-legacy-standby.mjs --verify-calibration-pair \
    "display/artifacts/legacy-standby-viewport-calibration/stage-2/$fixture.json"
done
```

online / offline verifier は同じ exported function を呼ぶ。pair command は reject 時も raw JSON、PNG、DOM sidecar、verdict を書いてから非0終了し、offline command はそれらを読み直して canonical hash、PNG / DOM 完全性、四 snapshot、signature、multiset、高さ予算、mode 固有の全 rotation tick を再計算する。online verdict と一致するだけでは合格にしない。Stage ②では期待表を一行も変更せず、artifact は review 用 scratch として untracked のままにする。

### 5.3 Stage ③ — 期待値・tracked artifact・全 browser matrix

verifier-approved 値だけを期待表へ反映し、通常 default を calibrated とした後に実行する。browser 起動前に approved pair から再生成した候補と checked-in expectations を完全照合する。通常 `--report` は mode を指定せず、全18 cell の recorded mode が calibrated、mismatch 0であることを別 command でも検査する。

```sh
set -e

npm --prefix display run build

node display/scripts/capture-legacy-standby.mjs --verify-calibrated-expectations \
  display/artifacts/legacy-standby-viewport-calibration/approved/pairs/normal.json

for fixture in tornado-pages tornado-aggregate tornado-clip tornado-epoch-release; do
  node display/scripts/capture-legacy-standby.mjs --verify-calibrated-expectations \
    "display/artifacts/legacy-standby-viewport-calibration/approved/pairs/$fixture.json"
done

CHROME_BIN="${CHROME_BIN:-chrome}" \
node display/scripts/capture-legacy-standby.mjs --report \
  --write-report display/artifacts/legacy-standby-viewport-calibration/approved/normal-report.json \
  --out-dir display/artifacts/legacy-standby-viewport-calibration/approved/normal-report

node display/scripts/capture-legacy-standby.mjs --assert-capture-report \
  display/artifacts/legacy-standby-viewport-calibration/approved/normal-report.json \
  --expect-suite normal --expect-viewport-mode calibrated \
  --expect-cells 18 --expect-mismatches 0

CHROME_BIN="${CHROME_BIN:-chrome}" \
node display/scripts/capture-legacy-standby.mjs \
  --out-dir display/artifacts/legacy-standby-viewport-calibration/approved/normal-assert
```

全 fixture branch を calibrated で走らせる。attention emergency は emergency predicate、standby / reduced-motion は別 comparator session も受入対象とする。`briefing-pages` は実装上 single-page も追加採取するが（`display/scripts/capture-legacy-standby.mjs:2889-2905`）、single-page を単独でも実行する。

```sh
set -e

for fixture in \
  tornado-pages tornado-aggregate tornado-clip tornado-epoch-release \
  recent-quakes-narrow \
  attention-visibility-standby attention-visibility-emergency attention-visibility-reduced-motion \
  briefing-pages briefing-single-page; do
  CHROME_BIN="${CHROME_BIN:-chrome}" \
  node display/scripts/capture-legacy-standby.mjs --fixture "$fixture" \
    --viewport-mode calibrated --report \
    --out-dir display/artifacts/legacy-standby-viewport-calibration/approved/fixtures
done

CHROME_BIN="${CHROME_BIN:-chrome}" \
node display/scripts/capture-legacy-standby.mjs --fixture cluster \
  --viewport-mode calibrated --report \
  --out-dir display/artifacts/legacy-standby-viewport-calibration/approved/fixtures

CHROME_BIN="${CHROME_BIN:-chrome}" \
node display/scripts/capture-legacy-standby.mjs --fixture cluster-calm --scenario 4 \
  --viewport-mode calibrated --report \
  --out-dir display/artifacts/legacy-standby-viewport-calibration/approved/fixtures

CHROME_BIN="${CHROME_BIN:-chrome}" \
node display/scripts/capture-legacy-standby.mjs --scenario max --viewport 960x620 \
  --viewport-mode calibrated --report \
  --out-dir display/artifacts/legacy-standby-viewport-calibration/approved/forecast-continuation
```

`overflow` / `rotation` は positive loop に入れない。underlying capture の非0と structured error code を次の negative harness で検査する。

```sh
set -e

mkdir -p display/artifacts/legacy-standby-viewport-calibration/approved/expected-failure

overflow_stderr=display/artifacts/legacy-standby-viewport-calibration/approved/expected-failure/overflow.stderr
if CHROME_BIN="${CHROME_BIN:-chrome}" \
  node display/scripts/capture-legacy-standby.mjs \
    --fixture overflow --scenario quiet --viewport 960x620 \
    --viewport-mode calibrated --report \
    --out-dir display/artifacts/legacy-standby-viewport-calibration/approved/expected-failure/overflow \
    2>"$overflow_stderr"; then
  exit 1
fi
rg -q '"code"[[:space:]]*:[[:space:]]*"CARD_SCROLL_CONTAINMENT"' "$overflow_stderr"

rotation_stderr=display/artifacts/legacy-standby-viewport-calibration/approved/expected-failure/rotation.stderr
if CHROME_BIN="${CHROME_BIN:-chrome}" \
  node display/scripts/capture-legacy-standby.mjs \
    --fixture rotation --scenario max --viewport 960x620 \
    --viewport-mode calibrated --report \
    --out-dir display/artifacts/legacy-standby-viewport-calibration/approved/expected-failure/rotation \
    2>"$rotation_stderr"; then
  exit 1
fi
rg -q '"code"[[:space:]]*:[[:space:]]*"ROTATION_VIEWPORT_FOOTER_GEOMETRY"' "$rotation_stderr"
```

design-alignment は base / after の双方へ明示 `--out-dir` を渡す。base と after は既存 design semantic contract を満たす対応 product build から採り、同一 build を便宜的に base / after と呼ばない。`DESIGN_BASE_URL` と `DESIGN_AFTER_URL` が用意できなければ Stage ③は blocked とし、旧 schema record を補完して通さない。

```sh
set -e

CHROME_BIN="${CHROME_BIN:-chrome}" \
node display/scripts/capture-legacy-standby.mjs --suite design-alignment --report \
  --url "$DESIGN_BASE_URL" \
  --out-dir display/artifacts/legacy-standby-viewport-calibration/approved/design-base \
  --write-baseline display/artifacts/legacy-standby-viewport-calibration/approved/design-base.json

CHROME_BIN="${CHROME_BIN:-chrome}" \
node display/scripts/capture-legacy-standby.mjs --suite design-alignment --report \
  --url "$DESIGN_AFTER_URL" \
  --out-dir display/artifacts/legacy-standby-viewport-calibration/approved/design-after \
  --baseline-report display/artifacts/legacy-standby-viewport-calibration/approved/design-base.json

node display/scripts/capture-legacy-standby.mjs --suite design-alignment \
  --assert-from display/artifacts/legacy-standby-viewport-calibration/approved/design-after/design-alignment-records.json \
  --baseline-report display/artifacts/legacy-standby-viewport-calibration/approved/design-base.json
```

最後に全体 gate を通す。

```sh
npm run build
npm test
npm --prefix display run build
npm --prefix display run test
npm --prefix display run typecheck
```

受入結果は通常 / positive fixture / design の全 record で requested viewport と実 `innerWidth` / `innerHeight` が一致し、DPR=1、画面別 readiness、二回 snapshot と screenshot 前後一致を証明すること。positive route の残留 mismatch / overflow / unresolved / nonconverged / omitted 増加 / verifier reject は0件とする。negative fixture は underlying capture が指定 code で非0となることが成功条件である。mode 無指定の normal report / non-report は calibrated を記録し、approved pair から再生成した候補と checked-in expectations が完全一致しなければならない。

## 6. 段階別裁定ラベル

### 6.1 Stage ① — capture contract

- **対象**: 共通 CDP helper、schema v2、browser metadata、standby / emergency readiness、attention comparator、同一-session capture、timeout、fixture policy、report 保存 / offline assertion、legacy expectation digest、standard `--report` の mismatch 非0化、unit test。
- **許容変更**: capture script と対象 unit test 内の session / serialization / assertion / CLI contract。
- **禁止変更**: 全期待表、default の calibrated 切替、tracked artifact、製品 code / layout。
- **配送先**: main で §5.1 を受入後、この一 commit だけを personal、Pi の順に配送する。
- **ロールバック**: Stage ② / ③ が未配送なら Stage ① commit を単独 revert できる。後段配送済みなら必ず ③→②→① の順で revert する。
- **受入条件**: §5.1 全成功。base expectation digest 不変、mode 無指定の通常18-cell / non-report が legacy-control、全 mismatch 0であること。attention comparator、emergency 固有 readiness、design calibrated v2 baseline も実 browser で成功すること。これを満たさず Stage ①を単独配送しない。

### 6.2 Stage ② — calibration verifier

- **対象**: fresh control / calibrated pair、canonical snapshot / PNG / DOM sidecar、browser / payload / font / candidate / logical-item / capacity signatures、multiset / surface予算式、mode固有全tick sweep、online / offline verifier、pair schema。
- **許容変更**: capture script と verifier unit test。review 用 artifact は untracked scratch に限る。
- **禁止変更**: 期待表、通常 default、tracked artifact、製品 code / layout。
- **配送先**: Stage ①受入済みの main で §5.2 を受入後、Stage ② commit を personal、Pi の順に独立配送する。
- **ロールバック**: Stage ③がなければ Stage ②だけを revert し Stage ①へ戻せる。Stage ③配送済みなら先に Stage ③を revert する。
- **受入条件**: 18-cell と tornado fixture の全 pair approved。offline verifier が sidecar / hash / canonical snapshot / signatures / multiset / surface予算 /各mode全tickを raw evidence から再計算して0終了し、期待表 diff 0、旧 JSON の verdict 入力0であること。

### 6.3 Stage ③ — calibrated gate・artifact・配送

- **対象**: verifier-approved 期待値、通常 calibrated default、approved / pre-calibration tracked artifact、全 browser matrix / design replay。
- **許容変更**: verifier が生成した候補に一致する期待表行、必要最小限の approved record / verdict / PNG、校正前 provenance。
- **禁止変更**: rejected / unexplained 値の期待化、旧 JSON / design plan の一括コピー、overflow / unresolved / nonconverged / DPR mismatch の隠蔽、製品 layout / payload / solver / pager / scheduler semantics。
- **配送先**: main で §5.3 を受入後、Stage ③ commit を personal、Pi の順に配送する。Pi は実 1920x1080 表示を別途確認する。
- **ロールバック**: Stage ③ commit だけを revert すれば、旧期待表と legacy-control default を持つ Stage ②へ戻る。さらに戻す場合だけ ②→① の順に revert する。三 commit を「校正 commit 一つ」として扱わない。
- **受入条件**: §5.3 の positive command と negative harness 全体が0終了すること。underlying negative capture は指定 code で非0、approved pair 再生成候補と checked-in expectations は完全一致、mode 無指定 report / non-report は calibrated、positive mismatch / verifier reject は0、新 schema base / after replay 成功、tracked artifact は approved verdict / provenance と一致すること。

## 7. DOC review 指摘の採否

9件すべてを `a) 採用` とする。`b) 根拠を示して不採用` とした指摘はない。

| # | 判定 | spec への反映 |
|---:|---|---|
| 1 | **a) 採用** | `record.viewport={label,width,height}` と `geometry.viewport={innerWidth,innerHeight,devicePixelRatio}` を schema v2 の固定配置とし、全 artifact / stdout / replay を列挙した（§3.3〜3.4）。 |
| 2 | **a) 採用** | standby / emergency readiness を分離し、attention baseline は別 comparator session と明記した（§3.1, §3.5）。 |
| 3 | **a) 採用** | 同じ新 helper の fresh control / calibrated pair、`Browser.getVersion`、payload / font / capacity verifier を唯一の校正判定にした。旧 JSON 比較だけでは承認しない（§3.6）。 |
| 4 | **a) 採用** | standard `--report` と calibration verifier を mismatch / reject 時非0終了に固定した（§3.4, §5）。 |
| 5 | **a) 採用** | design base / after の両方へ `--out-dir` を追加し、v2 after records の具体的な `--assert-from` command を置いた（§5.3）。 |
| 6 | **a) 採用** | virtual-time を route 別に裁定し、screenshot 引数、doctype serialization、120秒 deadline を固定した（§3.1〜3.2）。 |
| 7 | **a) 採用** | non-report、全通常 report、attention / emergency / briefing / forecast / tornado / その他 fixture、design after / replay、旧 schema negative test を受入 matrix に加えた（§5）。 |
| 8 | **a) 採用** | 二 commit 案を三段階へ改め、各 commit の配送単位と ③→②→① の rollback 順序を段階別ラベルに固定した（§3.7, §6）。 |
| 9 | **a) 採用** | 症状を「viewport / readiness assertion の不足」に限定し、closing HTML と既存 diagnostics assertion を明記した（§1）。 |

## 8. 再 review 残点の採否

残点4件と追加の期待表照合要求をすべて `a) 採用` とする。

| # | 判定 | spec への反映 |
|---:|---|---|
| 1 | **a) 採用** | expectation policy を4種に分け、専用表なし fixture の通常表 fallback を禁止した。`overflow` / `rotation` は underlying 非0と安定 error code を検査する negative harness へ分離した（§3.4, §5.3）。 |
| 2 | **a) 採用** | canonical snapshot 実体、PNG metadata / bytes、DOM sidecar、SHA-256 と canonicalization を pair schema に必須化し、offline verifier が raw evidence から再計算する契約にした（§3.3, §3.6）。 |
| 3 | **a) 採用** | common launch profile から mode / override を分離し、signature path / sort、occurrence-aware multiset、surface別予算式、control / calibrated 固有の全tick sweepを固定した（§3.6）。 |
| 4 | **a) 採用** | Stage ①へ mode 無指定18-cell、non-report、attention comparator、emergency、design v2 baseline、default mode / expectation digest assertionを追加した。Stage ③も mode 無指定 report の calibrated 記録を検査する（§5.1, §5.3, §6）。 |
| 追加 | **a) 採用** | `--verify-calibrated-expectations` で approved pair 由来候補と checked-in expectation を完全照合し、直接コピーや余分な手修正を拒否する（§3.6, §5.3, §6.3）。 |
