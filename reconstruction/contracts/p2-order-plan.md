# P2「最小縦断」発注計画

- 起草日: 2026-09-16
- 対象 checkout / base: `/Users/sayue/dev/fleq-p2-plan` / `94ae9cbe836edf8237acb87bddce6a6c8479cb4e`
- 目的: P2 を一契約一スレッド、材料・境界凍結後の実装1〜2晩を目安に分け、起草・凍結・実装・統合の順序を決める。準備・測定・修正・再検収は別計上し、重い契約の超過幅を§7に示す。各契約本体は本書の対象外とする。
- 原則: 既存の P1 公開口を使い、1実装の interface、factory、汎用 worker pool、outbox DB、差分 journal、将来用 extension point を追加しない。実装の完結単位は `I-U-*` とする（`docs/specs/reconstruction-p0-contracts.md:2646`、`docs/specs/reconstruction-p0-contracts.md:2664`）。

## 1. P2 の完了定義

### 1.1 凍結ゲート

コード着手前に、次を機械検査可能な契約 field と版付き artifact にする。

1. `I-U-E`、`I-U-W`、`I-U-F` の `UnitState / PersistedUnit / UnitView`、唯一の codec、入力 route、複数 subject 方針、gate、取消、intent、outcome、期限、復元、容量境界。統合契約が固定すべき項目は `docs/specs/reconstruction-p0-contracts.md:588`〜`docs/specs/reconstruction-p0-contracts.md:620`、各保存内容と開始 byte 予算は同 `:474`、`:478`、`:480` にある。
2. §7.5 の EEW 測定 manifest。T0〜T6、対応 ID、時計対応、母集団、warm-up、標本数、分位点、欠落判定、Chrome 条件を固定する（同 `:1102`〜`:1147`）。
3. 保存と終了契約。世代型・Q2=B・2 slot・成否不明・公平な再試行・終了順と code を固定する（同 `:741`〜`:775`、`:777`〜`:786`、`:821`〜`:876`、`:878`〜`:902`）。
4. P1 の残件 `Q-ENUM`、P2 通知の `Q-NOTICE`、U-F の `Q-VALUES`（A6でclosed）、U-W の `Q-REV`、測定の `Q-LIMIT / Q-PERF` を、owner と解決期限付きで各契約へ転記する。未決の意味を実装者が補完しない（同 `:2662`、`:2890`〜`:2904`）。

### 1.2 機械的受入 ID

P2 の phase 行が直接要求する ID は `O02 / O04 / O06 / O07 / O09 / O10`、`E01`、`E15`、`IR01 / IR03 / IR06 / IR08 / IR14` である（`docs/specs/reconstruction-p0-contracts.md:2613`）。これを次の確認単位へ展開する。

| 区分 | P2 で閉じる確認 | 機械判定 |
|---|---|---|
| U-F / 共通拒否 | `O02` の VPWP50 正常 newer empty、未知値、構造拒否、容量直前・一致・+1、件数で切らないperiod保持 | 現行参照と充足後参照を下のsubset表で区別する。`expected:O02:14` は元XML直接集計の件数と値集合を保持。全48 stepの扱いは裁定D5 |
| U-W | `O04` の stale lock 脱出と `freshnessSuspect` の対象束縛 | P2用の区分・時計・出典を明示した新築初期状態から`:3`〜`:8`相当を検収。現行`:2`の旧Pi移行候補はP3へ留保し、代替初期化stepをD5で固定する。別官署・別subject・別operationで解除0（同 `:1780`、`:1192`） |
| U-W | `O06` の全国履歴2、partial履歴8、連続取消、履歴不足 | P2は`:1`〜`:28`の実入力を充足し、履歴内復元、範囲外`unavailable`、取消watermark非巻戻しを検収。`:29`〜`:30`の旧v2履歴8→2移行はP3（同 `:1782`、`:572`、`:2614`）。範囲の確定はD5 |
| U-E | `O07` の non-durable current と durable intent | `O07:15`〜`:18`。再起動後 active EEW 復活0、期限内 intentだけ再試行、期限延長0（同 `:462`、`:997`〜`:1001`） |
| runtime / checkpoint | `O10` の Q2=B、取消中の保存失敗、rename後 ack 前、ack 喪失、単位固有失敗 | current巻戻し0、`uncertain`を再読込で解決、停止未確認 write 重複0、正常単位を飢餓にしない（同 `:837`〜`:846`、`:865`〜`:872`）。現行 `O10` は U-V 入力を使うため裁定 D5 |
| EEW 実表示 | `O09` の P2 母集団 | 固定 backlog、最大 VPWS50 full parse 開始直後、最大 U-W checkpoint encode 開始直後で `E01`。各 run `p99(U_i) <= 250ms`、欠落0、時計区間幅5ms以下（同 `:1124`〜`:1129`、`:1141`〜`:1145`） |
| mailbox | queue 排出と計数 | `E07`: 件数・byte上限内、通常入力最大待機年齢、入力停止後 pending / in-flight 0、周期末 backlog 非増加（同 `:2058`、`:2082`〜`:2084`） |
| runtime | 無変化 tick 0仕事 | `E08`: clone / stringify / checkpoint write / 内容 snapshot 生成が各0（同 `:2059`）。`E11` の変更検出 stringify 0も同じ契約で通す（同 `:2062`） |
| checkpoint | 他単位非干渉・失敗隔離 | `E10` の U-W encode 0、`E14` の正常単位3秒以内 ack・再試行間隔・書込み重複0（同 `:2061`、`:2066`） |
| checkpoint / diagnostics | write 帰属 | `E15`: unit / generation / stage / byte / retry reason を対応付け、帰属不能0。同一単位の encode回数・byte・worker占有を報告（同 `:2067`、`:2099`） |
| shutdown | 保存と終了 | `E20`: §5.9 の順序・世代・code・上限一致、保存未確認の code 0 が0（同 `:2072`） |
| notification | 緊急初回試行 | `E21`: EEW初回 adapter 呼出しまで暫定1秒以内、固定優先順、無効化・隔離、停止未確認処理への重ね呼出し0（同 `:2073`、`:948`〜`:962`） |
| diagnostics | sink と秘密値 | `E23`: 有界保持、再起動後可読、秘密値露出0、sink失敗の再帰増殖0（同 `:2075`） |
| 単位正常性 | 正常 corpus の恒常的 unavailable 0 | P2 三単位について `E13`。配送 summary は意味 `unavailable` と別集計（同 `:2064`） |
| P2 性能報告 | backend / 最大入力 / 資源 | `E02 / E03 / E05 / E06 / E12` を P2 条件で報告し、未測定を Pass にしない（同 `:2053`〜`:2057`、`:2063`） |

O02のP2 subset案（D5裁定前）。以下の各IDは独立した参照で、`expected:`であっても意味期待の未決・未実行があればPassではない。

| 検査・担当 | 現行の機械参照ID | 充足後の参照・扱い |
|---|---|---|
| U-F初期化・正常・旧報・未知値・最大入力／A6 | `expected:O02:1`, `expected:O02:2`, `expected:O02:4`, `expected:O02:5`, `expected:O02:6`, `expected:O02:13`, `expected:O02:14` | ID維持。`:1`を含む初期化を省かず、`:6`のQ-VALUESはA6でclosed。`:4`は前提のunmet:O02:3が充足するまで保留（2026-09-23） |
| U-F newer empty・容量境界／A6 | `unmet:O02:3`, `unmet:O02:15`, `unmet:O02:16`, `unmet:O02:17` | 充足後ID案は`expected:O02:3`, `expected:O02:15`, `expected:O02:16`, `expected:O02:17`。入力・根拠・reason固定後に統合担当がstep/expectation両参照とhashを更新しcheckerで検査。現時点では存在しないID |
| 共通の意味入力拒否／A1、U-F境界／A6 | `expected:O02:7`, `expected:O02:8`, `expected:O02:9`, `expected:O02:10` | ID維持。`:8`はVPWP50 Head欠落、`:10`はVXSE51不正日時。A1の共通検証で`:10`を拒否し、M02意味実装は要求しない。`:8`はA6接続でも拒否・state不変を確認。両reasonは凍結待ち |
| 共通parser拒否の回帰確認／P1継承 | `expected:O02:11`, `expected:O02:12` | VPTW60抽出断片。U-F固有検査に含めず、P1の拒否経路と根拠を照合して参照。M11実装は要求しない |

`IR01 / IR03 / IR06 / IR08 / IR14` の契約別対応は**未確定・元レビューの対応表待ち**とする。P2の未決台帳にIDを保持し、各契約の検収は下表のE/O IDとspec行番号で割り当てる。対応表入手前に特定のIRを契約へ割り当てたり、IR単位でPassにしたりしない。

### 1.3 D-AC の扱い

P2 行は D-AC ID を指定していない。一方、最小 Chrome 経路は次の条件へ証拠を供給する。

- `D-AC02`: empty card 0、`unavailable` を無発令へ変換しない（同 `:1839`）。
- `D-AC12`: metadata 更新だけで scene 初期化・全再 mount 0（同 `:1849`）。
- `D-AC14`: EEW の operation 交差取消0と active EventID 維持。ただし geometry bounds、full / summary、E13a を含む全件 Pass は P4（同 `:1851`）。
- `D-AC24`: P2 は EEW の E01 部分だけを実測する。E04 / E25 / E26 を含む全件 Pass は P4（同 `:1861`、`:2615`）。

したがって P2 では上記を「先行証拠」と記録し、D-AC14 / 24 全体を Pass と報告しない。P2 で正式に Pass を要求する D-AC ID は裁定 D3 で確定する。

### 1.4 完了報告の共通条件

- 全実装契約で新築 build と test を実行する。永続化、共有状態、module scope を触る契約は shuffle も必須（同 `:2670`）。
- 追加・変更した各テストは、受入条件／契約境界／実不具合／corpus履歴のいずれか一つへ対応付ける。
- `Pass / Fail / Blocked / N/A / 未確認` を分け、Chrome実 paint、故障注入、長時間測定を unit test で代用しない（同 `:2672`〜`:2678`）。
- P2 最終完了は10契約の配送だけでなく、統合契約・測定 manifest・保存終了契約の凍結版と、該当受入 ID の実行記録が揃った時点とする。

## 2. 契約の分割案

### 2.1 推奨案 A: 10契約、基盤から直列に境界を閉じる

| # / 契約 ID | 対象 ID | 公開型・公開口 | 依存 | 凍結するもの | outOfScope | 検収 ID |
|---|---|---|---|---|---|---|
| A1 `P2-shared-runtime-001` | B01補完、B06、B15 | `RejectionReason`、`validateSemanticEnvelope`、`UnitId`、`RuntimeInput`、`RuntimeState`、`RuntimeStep`、`SaveProgress`、`PersistenceStatus`、`NotificationIntent`、`PublishedOutcome`、`reduceRuntime(state,input)` | P1 | 絶対時計と単調時計、唯一の state 更新口、operation 伝播、no-op、diagnostic field、共通Head/日時検証と拒否reason | I/O、各 reducer、HTTP、adapter | E08、E11、spec:693・733（意味入力拒否）、spec:668（区分伝播） |
| A2 `P2-mailbox-001` | B05 | `MailboxEnvelope`、`MailboxCompletion`、`MailboxStats`、`enqueue`、`takeNext`、`complete`、`beginDrain` | A1、P1 B03/B04/B05型境界 | 128件/16MiB、通常120件/14MiB、緊急予約、in-flight計数、固定優先順、停止・排出、進捗時刻 | worker pool、詳細ページ、REST recovery | O09(P2 queue)、E07、spec:2082（queue排出・計数） |
| A3 `P2-checkpoint-shutdown-001` | B02、B07、B15永続sink | `CheckpointEnvelope`、`CheckpointRequest/Result`、`ShutdownSummary`、`restoreUnit`、`scheduleCheckpoint`、`applyCheckpointResult`、`shutdownRuntime`、有界診断配送・回収口 | A1、A2、凍結済み codec 形 | 2 slot、hash / generation、Q2=B、`uncertain`照合、最古dirty選択、再試行、通常終了、E15 record、filesystem adapter経由の非同期回転ログ・回収・故障隔離 | SQLite、journal、複数writer、旧v2移行 | O07、O10、E10、E14、E15、E20、E23、spec:865・872（保存失敗隔離） |
| A4 `P2-eew-unit-001` | M01、I-U-E | `EewUnitState/PersistedEewUnit/EewUnitView`、`EewInput`、`reduceEewUnit`、唯一の codec、`toEewView` | A1、P1、A3のcodec契約 | current/gateはN、intentはD、512 subject、15秒TTL、報番号・終端・取消・operation交差、family固有identity/必須構造検証 | 地震観測、津波、最終GIS、P4 scene | O07:15-18、O09のEEW意味部、E13、D-AC14先行証拠 |
| A5 `P2-weather-current-001` | M06、I-U-W | `WeatherCurrentUnitState/PersistedWeatherCurrentUnit/WeatherCurrentUnitView`、`WeatherCurrentInput`、`reduceWeatherCurrentUnit`、codec、`toWeatherCurrentView` | A1、P1、A3のcodec契約 | 全国base1/履歴2、partial128/履歴8、所有現象、freshness target、取消復元、16MiB、官署/subject/必須構造検証 | VPWW56、VPNO50のP2非対象分岐を推測実装、旧移行 tool | O04/O06（D5のP2 subset）、E10、E13、spec:1192（意味鮮度の対象束縛） |
| A6 `P2-weather-timeseries-001` | M08、I-U-F | `WeatherTimeseriesUnitState/PersistedWeatherTimeseriesUnit/WeatherTimeseriesUnitView`、`WeatherTimeseriesInput`、`reduceWeatherTimeseriesUnit`、codec、`toWeatherTimeseriesView` | A1、P1、A3のcodec契約 | subject / period、194 period、正常empty、gate-only、取消、7日、512 subject、32MiB、意味入力`RejectionReason`と`unavailable` reason、subject/period必須構造検証 | VPTA50、カード幅に合わせた削減、P4詳細API | O02(P2範囲)、E13 |
| A7 `P2-notification-delivery-001` | B09、U-E/U-W/U-F intent配送 | `NotificationAttempt/Result`、選択・結果照合・実adapter試行/abort/停止確認 | A1/A3、A4〜A6配送境界（Wave 4のR24順） | R24〜R30/Q-NOTICE、分野別20音、固定優先、初回1秒、channel別1件、単調timeout/停止/再試行、単位別TTL/容量、保存予約後dispatch | exactly-once、独立outbox、津波意味生成、旧築handoff | O07:15-18（通知期待は契約検収）、O10通知枝のみ、E21（A7単体→A3結線後最終、正式33報はprivate corpus専用） |
| A8 `P2-snapshot-sse-001` | B08、B11のP2最小範囲 | `DisplayVersion`、P2 `DisplaySnapshot`、`projectSnapshot`、snapshot / SSE / health handler | A1、A4〜A6、A3 | 完全snapshot、最新1枚、client待機1枚、1MiB、heartbeat、healthとworker状態分離、slow client | §7.10詳細、全12分野、静的asset設計、P4認証拡張 | E01のT3〜T5、E02、D-AC02/12先行証拠 |
| A9 `P2-chrome-eew-001` | D02と、D05/D07/D11のEEW最小部分 | native `EventSource` client、EEW card/map paint marker、時計対応 probe | A8、A4、凍結済み測定manifest | 前景Chrome、固定viewport/DPR、snapshot置換、EEW card＋必要な予想震度表示の同一paint、T5/T6 | hover、詳細、ページ送り、県focus、津波、LOD、最終意匠 | E01、D-AC02/12/14/24先行証拠 |
| A10 `P2-eew-e01-001` | P2統合・測定・条件付き§7.6 | 製品経路の replay / trace runner と版付き結果。汎用benchmark frameworkは作らない | A1〜A9 | N/P/C、3母集団、T0〜T6、100 warm-up、1000×3 run、時計区間、A/B原因判定、E15対応 | 津波母集団、personal最終配線、P4容量縮退・詳細 | O09(P2範囲)、E01、E03/E05/E06/E12、E15 |

A1の共有型は既に複数契約が参照するdiscriminated unionに限る。表の`spec:`は`docs/specs/reconstruction-p0-contracts.md`の行番号を指す。

A1は共通Head・報告日時検証（`validateSemanticEnvelope`）と`RejectionReason`の語彙を固定する。routedな入力ではA4/A5/A6がreceive先頭でこれを呼ぶ（A1-route、2026-09-23）。A4/A5/A6はfamily固有identity・日時・必須構造を意味入力確定前に検証する。EventID/Serialが合法的に空のfamilyを一律拒否しない。信頼できない入力は`rejected`としてcurrent/watermark/intentを不変にする（同`:693`、`:733`）。

永続診断sinkはA3へ集約する。filesystem adapterと終了処理を既に所有し、別のI/O担当契約を増やさず再起動後の可読性まで検収できるためだ。非同期回転ファイル一方式を実装し、queue 256件/1MiB（in-flight込み）、行8KiB、7日または100MiBの早い回収、level別欠落、sink失敗時の非再帰な状態表示/stderr、終了要約を固定する（同`:1213`〜`:1228`）。A3がE23の容量回収・再起動読取・sink故障・秘密値試験を所有し、P1のメモリringだけでは完了にしない。既存parser診断からsinkへの接続に公開口変更が必要なら§6.2の契約改訂として先に固定する。

各unit契約の完了は§13.3の9段すべてを結線後の経路で確認した時点とする。unit担当は段ごとの受入ID・試験結果を記録し、A3担当の結線差分・結線後再検収を同じ契約の配送証拠に含め、統合担当が確認する（同`:620`、`:2648`〜`:2666`）。

### 2.2 代替案 B: 8契約、境界凍結後に並走

次の二組を統合し、A4 EEWを A2 と並走させる。

1. A1+A2を `P2-runtime-mailbox-001` に統合する。
2. A8+A9を `P2-minimal-display-001` に統合する。
3. A3の保存公開型と `I-U-E` の状態型だけを先に凍結し、checkpoint実装と EEW reducer実装を並走する。
4. U-W、U-F、notificationはそれぞれ独立契約のままにし、最終E01契約も残す。

契約数は8本になるが、runtime/mailbox と SSE/Chrome が P1 の規模を越えやすく、同一スレッドで基盤障害と実表示障害を切り分けにくい。推奨は A である。

## 3. 発注順と並列可否

### 3.1 依存グラフ

```text
P1 → A1 shared-runtime → A2 mailbox
A1/A2 → A3 checkpoint-shutdown
P1/A1/A3 → A4 I-U-E
P1/A1/A3 → A5 I-U-W
P1/A1/A3 → A6 I-U-F
A1/A3/A4/A5/A6 → A7 notification（R24、Wave 4条件）
A3/A4/A5/A6 → A8 SSE → A9 Chrome
A3/A7/A8/A9 → A10 E01
```

発注波は次の順とする。

1. **Wave 0（起草・凍結のみ）**: A1〜A10の契約本文を起草し、A1共有型、I-U-E/W/F、A3保存終了、A7通知、A10測定manifestの相互参照を固定する。実装は始めない。
2. **Wave 1**: A1。
3. **Wave 2**: A2とA3。公開型凍結後なら実装を並走できる。
4. **Wave 3**: A4、A5、A6の独立実装は並走できる。各担当は自unit/test directoryを所有する。各unitの実装配送ごとに、A3担当がcomposition rootへreducer・codec・期限・view/outcome/intentを直列に結線し、unit担当と保存障害・通常終了・復元直後続報を再検収する。9段の証拠が揃うまで当該unitは未完了。A3契約に後続結線用allowed_pathsと再検収工程を事前に含める。
5. **Wave 4**: A7はA1改訂→Q-NOTICE確定→A4 intent生成→A7改訂→baseOid割当→発注（R24）の順と、A4/A5/A6の3単位配送境界・型の凍結を条件とする。desktop体験はR30=A（2026-09-23 ご主人）で確定。正式EEW証拠の保管/実行はA7のP2-A7-PRIVATE-EEW-EVIDENCEに従い、private repoのpersonalのみ、公開環境では正式検収blockedとする。搬入は統合担当の契約外作業。A8はA4〜A6の公開view凍結が条件で、条件成立後はA7と並走できる。配送ごとにA3担当がadapter/出力を結線し、実通知結果・SSEを含む保存障害・終了・復元を再検収して各unitの9段証拠を更新する。
6. **Wave 5**: A9。
7. **Wave 6**: A10。A/B判定で B が必要になった場合だけ、A10の契約改訂または後続 `P2-parse-worker-001` を発注し、同じ manifest で再測定する。

parse分離の扱いは作者裁定ではなく§7.6の既定手順とする（同`:1155`、`:1168`、`:2737`）。A10担当はWave 0で測定条件を固定し、A4/A5/A8/A9の最小結線が動き次第、A構成の3母集団を早期に予備測定する。P1の231ms parse・212ms転送だけではBを発注しない。T0〜T6と七区間で未達原因を帰属し、XML parse主因の場合だけBへ移行する。encode・射影・転送・描画が主因なら各原因の最小修正を行う。いずれも同一manifestで正式再測定し、未達・証拠不足はPassにしない。

### 3.2 共有ファイルと衝突源

| 衝突源 | 所有契約 | 並走時の規則 |
|---|---|---|
| P2共有 types / runtime input union | A1のみ | A2以降は編集禁止。追加が必要ならA1契約改訂 |
| composition root / 起動終了入口 | A3のみ | A3担当が各unit配送時とA7/A8配送時に直列結線・再検収。各unit担当は直接編集しない |
| mailbox port・worker protocol | A2のみ | A4〜A6は公開 envelope の consumer。独自portを作らない |
| checkpoint envelope / scheduler | A3のみ | unitはcodecとstateだけを所有。writerを持たない |
| `NotificationIntent` と選択順 | 型はA1、配送はA7、生成は各unit | 同じ型をunitごとに複製しない |
| `DisplaySnapshot` wire型 | A8のみ | 各unitは `UnitView` まで。Chrome側独自schemaを作らない |
| E01 trace schema / manifest | A10のみ | A2/A3/A8/A9は固定markerを出すだけ |
| corpus `sequences.json` と派生fixture | 統合担当またはA10の明示allowed_paths | unit担当が期待値を変更しない |
| `reconstruction/package.json`、tsconfig、vitest config | 最初に必要となる契約1本だけ | 依存追加は原則0。変更が必要なら直列配送 |

A4〜A6を並走させる前に共有型を凍結する。共有ファイルの同時編集を「あとで merge」で処理せず、owner一人に限定する。

## 4. 先に凍結する契約

### 4.1 保存単位の統合契約 `I-U-E / I-U-W / I-U-F`

固定内容:

- route / family / operation / subject から一つの unit sliceを選ぶ対応。
- A1の共通Head/日時検証と、各unitのidentity/必須構造検証の境界・`RejectionReason`。拒否ではwatermarkを進めない（同`:693`、`:733`）。
- `UnitState / PersistedUnit / UnitView` と唯一のcodec。
- gate、意味更新、取消記憶、intent、outcome、期限、保存ack、復元直後続報。
- 一入力内の複数subjectは原則原子的。例外は根拠・残存状態・一回の参照交換を明記（`docs/specs/reconstruction-p0-contracts.md:616`〜`:618`）。
- U-Eはactive currentを保存しない。U-Wは全国/partial/所有現象/履歴/freshness。U-Fはperiod/正常empty/gate-only/容量超過。

材料の充足:

| 契約 | 揃っている材料 | 足りない材料 |
|---|---|---|
| I-U-E | 実EEW XML、P1 operation型、U-E保存区分、O07:15-18、15秒TTL | 同一EventIDのnormal/training交差更新・取消fixture、M01の報番号/終端/予測保持のP2完全系列、`Q-NOTICE`具体値 |
| I-U-W | 最大VPWS50、既知stale-lock checkpoint、全国/partial保持上限、O04/O06期待 | O04/O06のP2対象未充足入力、`Q-REV`、出典・operation・時計を明示した新築初期状態。O04:2とO06:29-30の旧形式移行証明はP3 |
| I-U-F | 大容量の実VPWP50（長野 XML 2.27MB）、未知code、取消/head欠落fixture、7日/512/32MiB、Q-VALUES/Q-PERIODはA6でclosed | P2対象のnewer emptyと容量直前・一致・+1、容量境界は試験内state調整で段階縮退と差分計量を検収 |

### 4.2 §7.5 EEW測定 manifest

固定内容:

- T0〜T6、run/input/operation/subject/revision/stream/sequence の対応。
- 固定backlog、最大VPWS50 parse開始直後、最大U-W encode開始直後の3母集団。
- 各run 100 warm-up、1000正式標本、3 run、nearest-rank、10秒欠落、p50/p95/p99/max。
- Node/Chrome時計の往復対応、30秒ごとの再測定、区間幅5ms以下、traceと画面記録。
- Chrome版、前景tab、viewport、DPR、地図資材hash、motion、Node/OS/端末。
- P1実測は予備根拠として保持するがE01 Passには使わない。P1の最大VPWS50は full XML parse約231ms、metadata＋特殊値約37ms、treeを含むMessageChannel転送約212ms、VPWP50はparse約105ms・転送約71ms（`reconstruction/tools/corpus/README.md:110`）。

材料の充足: T0〜T6定義と集計式は揃う。足りないのは、固定N/P/C負荷、合成EEWの全日時、投入offset、Chrome描画証拠取得方法、時計probe、最小地図資材、最大U-W checkpoint実体である。現行 `O09` は57 unmetであり、P2外の津波・personal・詳細・容量縮退も混在する。

### 4.3 保存・成否不明・通常終了契約

固定内容:

- `SaveProgress / PersistenceStatus`、世代・capturedAt・ackAt・dirtySince。
- A/B 2slot、tmp→file sync→close→rename→directory sync→ack、hashとgenerationによる選択。
- rename後ack前は `uncertain`。停止未確認I/O中はwriterを占有し、終了後は正常単位へ失敗待ちを波及させない。
- writer全体1件、単位ごと最新dirty参照、最古dirty優先、1/2/4/8/10秒retry、正常時3秒以内ack。
- Q2=B、最終化後は保存ackと終了処理だけ、終了code 0/2/3/4。
- E15のunit/generation/stage/byte/attempt記録。
- A3所有の永続診断sinkの配送・回収・故障隔離・終了時排出条件とE23。A1の許可field射影、P1診断との接続口もA3実装前に固定する（同`:1213`、`:1224`、`:2075`）。

材料の充足: 状態遷移・時間上限・判定式は揃う。足りないのは filesystem adapter の故障注入点、実媒体でのfile/directory syncとrename後再読込の証拠、P2三単位の最大encoded byte、終了時の遅いack fixtureである。Pi停電耐性は未確認のまま P5へ残す（`docs/specs/reconstruction-p0-contracts.md:850`、同 `:2924`）。

## 5. 作者裁定が必要な分岐

計8件。参照安定性のためD1・D3〜D9を維持し、旧D2は§3.1の既定手順へ移した。

1. **D1 分割数**
   A: 推奨案Aの10契約。B: 代替案Bの8契約。
   **推奨 A**。P1約500 src行・12 test・レビュー3巡を基準にすると、runtime/mailboxとSSE/Chromeを分けた方が凍結後の実装を小さく保ち、故障を帰属しやすい。総所要は§7の追加工程を含める。

2. **D3 最小 SSE/Chrome の範囲**
   A: P2三分野の完全snapshot、状態帯、EEW card、必要な予想震度表示、T5/T6 markerだけ。D-ACは先行証拠扱い。B: P4のD02/D05/D07/D11を製品UIとして部分実装。
   **推奨 A**。P2はE01判定に必要な実paintだけを作り、hover、詳細、pagination、県focus、津波、最終GISを先取りしない。ただし「必要な予想震度表示」の最小geometryと判定方法は実装前に固定する。

3. **D4 E01の検収owner**
   A: A10が統合検収を所有し、A9はmarkerと単発smokeだけ。B: A9が正式1000×3 runまで所有。
   **推奨 A**。T0〜T4はmain/worker/SSE、T5/T6はChromeに跨るため、一契約でmanifest・時計・集計を所有した方が除外条件の後付けを防げる。

4. **D5 O系列の「成功」範囲**
   A: P2対象stepを版付きsubsetとして固定し、P2用step/fixtureを `sequences.json` に追加する。P2外stepは未確認のままP3〜P5へ残す。B: O02/O04/O06/O07/O09/O10の全stepをP2で要求し、旧形式移行を含むphase範囲を改訂する。
   **推奨 A**。O04:2は旧Pi移行候補、O06:29-30は旧v2全国履歴8→新履歴2の移行である。P2は出典・区分・時計・履歴を固定した新築stateを試験用に生成し、その生成を移行器の合格証拠にしない。置換初期化stepを別IDで追加して旧stepとの対応を残し、旧形式変換・operation証明・捨てた履歴範囲の報告はP3で検収する（同`:1782`、`:2614`）。現行O07はU-Q/U-V、O09は津波/P4詳細/P5 personal、O10はU-V/exportを含み、P2対象モジュールだけでは全件Pass不能である。subsetの命名と「Oxx成功」のphase表記を作者が裁定しない限り、P2最終完了は Blocked になる。

5. **D6 EEW最小地図の証拠**
   A: P2専用の固定・hash付き最小geometryで、manifestが列挙する予想震度区域だけを実paintし、P4 GIS合格とは呼ばない。B: P4の正規GISを先に作る。
   **推奨 A**。E01のT6には地図が必要だが、47県/1,892区域、LOD、hit testはP4である。固定資材の出典・対象code・期待pixel/geometry集合は未記載なので凍結が必要だ。

6. **D7 training/test通知**
   A: training/testは区分付きdesktopだけを生成し、soundは生成しない（R28=A）。B: 通常と同じchannelを低優先群で試行する。
   **推奨 A**。specの開始案はtraining/test soundなしで、採用時も通常緊急を追い越さない（同 `:672`、`:964`）。Q7から引き継いだchannel別条件もQ-NOTICE/R28で確定（`reconstruction/contracts/p1-parser-boundary.json:51`〜`:55`）。

7. **D8 分野別根音表の搬入**
   A: Vault由来表をcheckout内の版付きspecへ統合してからA7を起草。B: A7で仮のtone IDだけを固定し音資材は後送。
   **推奨 A**。§6.2が要求する根音表v1はdocs/specs/sound-design-system.mdへ搬入済み（`docs/specs/reconstruction-p0-contracts.md:944`）。checkout外参照のまま再現不能な契約にしない。

8. **D9 P1公開型の改訂**
   A: `ParserMailboxItem`を変えず、B05の薄い `MailboxEnvelope` にT0・enqueue時刻・run IDを置き、`inputId`でdecode結果と照合。B: `ParserMailboxItem`へ単調T0、`DecodedMaterial`へ単調T0・inputSequence・receivedAtを追加するP1契約改訂。`ParserMailboxItem`のinputSequence・receivedAtは既存fieldで、再追加しない。
   **推奨 A**。`ParserMailboxItem`にはheadType/encoding/compression/byteが既にあり（`reconstruction/contracts/p1-parser-boundary.types.ts:79`〜`:94`）、P2測定情報はparser境界の意味ではない。相関不能が実測で判明した場合だけP1契約改訂にする。

## 6. P1 から引き継ぐ未決と契約改訂候補

### 6.1 未決と解決済み

| ID | 現在のowner / 期限 | P2で閉じる内容 | 配置先 |
|---|---|---|---|
| Q-ENUM | `implementer` / 最初の対象I-U-* reducer契約凍結前（`reconstruction/contracts/p1-parser-boundary.json:535`〜`:541`） | parser拒否・意味入力の`RejectionReason`・意味上`unavailable`を分離したreason表。identity/日時/必須構造検証とscope・lastKnown・affectedScopeを固定 | A1とA4/A5/A6の契約凍結前 |
| Q-NOTICE（EEW closed） | 2026-09-23 R24〜R29/Q-NOTICE | 旧築5機会、U-EのVXSE43/45、三区分のdesktop/sound、15秒TTL、取消・訂正・置換、単調期限、正式33報はprivate corpus専用（明示コマンドはA7のP2-A7-PRIVATE-EEW-EVIDENCE）、公開CIは気象庁サンプルと人工境界試験。77_01_33取消は気象庁作例で実系列に無い。証拠区分をA4/A7へ固定。VPWP50は生成0。corpus の他family通知は別途未決。 | A4/A7（A1/A3結線） |
| Q-VALUES（closed） | 2026-09-23 R22 裁定 | VPWP50未知Codeの扱いはA6 questionResolutions[Q-VALUES]。最低warning表示はP4/A8 | A6 |
| Q-REV | `integrator` / O06対象Unit契約前 | 同revision訂正、時刻/Serial、連続取消の対象版。U-Fの同時刻訂正は別ID Q-REV-UF（既存gateを保つ既定でA6を発注） | A5/A6 |
| Q-MIGRATION | `integrator` / O04/O06/O07移行oracle前 | P2は明示的な新築初期状態生成と元事例との対応をA5前に固定。旧checkpoint operation証明・O04:2/O06:29-30の変換検収はP3移行契約前に固定 | A5/A10、P3移行担当 |
| Q-LIMIT | `integrator` / 容量fixture作成前 | U-W/U-F checkpoint、subject/period、snapshotの合法最大と+1。U-Fの全国保存量と上限はQ-PERIODでclosed、容量境界と段階縮退はA6実装検収前に試験内state調整で確認 | A5/A6/A8 |
| Q-PERF | `integrator` / EEW A/B測定前 | N/P/C、投入offset、端末、時計、paint evidence | A10 |

`Q-ENUM`のparser拒否reasonはP1で閉じたが、意味入力の拒否は別である。P1はHead欠落を空文字、不正日時をraw文字列として返す（`reconstruction/src/decode-material/decode-material.ts:271`〜`:288`）。`expected:O02:8`・`expected:O02:10`のreasonは未確定であり、A1の共通検証とA4/A5/A6のfamily固有検証が`RejectionReason`を固定する（`docs/specs/reconstruction-p0-contracts.md:693`、同`:733`）。これはP1公開型変更を必須にしない。`UnavailableReason`は正常な意味入力の容量超過・履歴不足等として別に固定する。

### 6.2 型・公開口の不足確認

| 対象 | 判定 | P2方針 |
|---|---|---|
| `ParserMailboxItem.headType / encoding / compression / encodedByteLength` | 足りている | 変更しない。緊急候補は検証済みheadTypeからB05で導く |
| T0、enqueue単調時刻、run ID、priority選択理由 | P1型には未記載 | A2の`MailboxEnvelope`に置く。保存しない |
| `DecodedMaterial`のinputSequence / receivedAt | 未記載 | A2が`inputId`に結び付けたenvelopeを完了まで保持。decoded treeへ複製しない |
| `classifyMaterial`のroute/family | 返値型が公開宣言されず、現実装は広いclassificationとheadTypeを返す（`reconstruction/src/decode-material/decode-material.ts:202`〜`:238`） | P2の一か所だけでheadType→M01/M06/M08→U-*を対応付ける。新しいregistry/factoryは作らない。曖昧ならP1契約改訂 |
| `ProcessingMarks` | P1七区間のみでT0〜T6ではない（`reconstruction/contracts/p1-parser-boundary.types.ts:67`〜`:77`） | A10のtrace型を別に置く。P1 marksを拡張しない |
| B05 control / checkpoint ack / deadline / shutdown入力 | P1はparser itemだけ | A1/A2で必要なunionを新設。parser契約改訂ではない |

現時点の推奨はP1契約改訂0件である。必要になった場合は、P2契約へ黙って型を足さず、`P1-PARSER-BOUNDARY-001` の公開型・公開口を変える別改訂として、理由・影響するconsumer・再検証を記録する。

## 7. 見積もり

P1（src約500行、test 12本、レビュー3巡）は規模の参考であり、総所要1〜2晩の保証ではない。以下のLOCは準備済みの材料・凍結済み境界を実装する目安で、fixture準備、契約起草、正式測定、修正・結線後再検収を別計上する。行数・本数はquotaではなく、各テストは§1.4の目的に対応するものだけを残す。

| 契約 | src行目安 | test / harness行目安・本数 | レビュー巡数 | 工程数 |
|---|---:|---:|---:|---:|
| A1 shared-runtime | 250〜400 | 300〜450 / 8〜12 | 2 | 5 |
| A2 mailbox | 300〜450 | 350〜550 / 9〜13 | 2〜3 | 5 |
| A3 checkpoint-shutdown・永続診断 | 550〜800 | 700〜1,000 / 12〜16 | 3〜5 | 5＋後続結線 |
| A4 I-U-E | 300〜450 | 400〜600 / 10〜14 | 2〜3 | 5 |
| A5 I-U-W | 550〜800 | 750〜1,050 / 15〜20 | 3〜5 | 5＋結線後再検収 |
| A6 I-U-F | 350〜500 | 450〜650 / 10〜14 | 2〜3 | 5 |
| A7 notification | 300〜450 | 400〜600 / 10〜14 | 3 | 5 |
| A8 snapshot-SSE | 250〜400 | 300〜500 / 8〜12 | 2 | 5 |
| A9 Chrome-EEW | 250〜400 | 300〜500 / 6〜10＋実Chrome | 2〜3 | 5 |
| A10 E01統合 | 100〜250 | 600〜900 / 6〜10＋各母集団3run測定 | 3〜5 | 5＋原因別修正・再測定 |
| **合計** | **3,200〜4,900** | **4,550〜6,800 / 94〜135** | **24〜34** | **基本50＋下記の反復工程** |

| 対象 | 材料・境界凍結後の実装 | fixture・測定準備（別枠） | 測定・修正・再検収（別枠） |
|---|---|---|---|
| A1/A2/A4/A6/A7/A8/A9 | 各1〜2晩目安 | 各0.5〜1晩。既存fixtureの対応・期待・adapter条件を固定 | 各0.5〜2晩。実adapter/Chrome・統合結果によって延長 |
| A3 | 2〜3晩。保存公平性・終了・永続診断を含む | 1〜2晩。故障停止点、slot、ログ上限・回収fixture | 2〜4晩。I/O故障、E23、unit/adapter配送後の直列結線と再検収。追加レビュー最大2巡を予備枠 |
| A5 | 2〜3晩。履歴・取消・復元を一単位で閉じる | 2〜4晩。現行O06 unmet24件をD5のP2/P3へ配分し、P2対象とO04初期state・Q-REVを準備 | 1〜3晩。結線後の保存故障・終了・復元と履歴oracle。追加レビュー最大2巡を予備枠 |
| A10 | runner実装1〜2晩 | 1〜3晩。3母集団、最大encode state、時計・trace・paint対応を準備 | 2〜5晩。3母集団×1,000標本×3run＝9,000正式標本、各run100 warm-up、E06/E07の60分系列、資源測定・原因別修正・再測定。追加レビュー最大2巡を予備枠 |

期間は起草上の推定でありspecの規定値ではない。契約起草・初回レビューは各0.5〜1.5晩を別枠とする。並走分を単純に暦日へ合算せず、fixture準備完了、A3結線枠、Chrome測定環境を確認して統合担当が日程を確定する。反復が予備枠を超えた場合は残件と再見積もりを報告し、未測定を配送完了に含めない。

各契約の基本5工程は **起草 → 独立レビュー → 実装 → 独立レビュー／修正 → 配送・再検証** とする。Wave 0の材料準備・境界凍結を起草/レビュー枠に計上する。A3担当によるA4/A5/A6各配送後の結線・再検収3回と、A7/A8各配送後の結線・再検収2回を配送工程の明示的な反復枠にする。unit完了の判定は§2.1の9段証拠が揃った後だ。A10の正式測定後に修正すればレビュー・再測定を追加する。§7.6の原因判定でparse worker Bが必要になれば、追加1契約・同じ5工程・src 200〜350行・test/harness 300〜500行・レビュー3巡に加え、同一manifestの再測定枠を見込む。

### 発注前に不足している材料

1. IR01/03/06/08/14 と組込み条項の正式な対応表。
2. P2対象stepとしてのO系列裁定と、O04/O06/O09のunmet fixture／負荷manifest。現状の系列検査は O02=12、O04=5、O06=24、O07=1、O09=57、O10=0 unmetであり、未充足を免除しない（`reconstruction/tools/corpus/README.md:37`）。
3. 共通・各unitの意味入力`RejectionReason`、U-Fの`unavailable` reason、VPWP50未知code、容量直前・一致・+1。
4. EEW normal/training交差系列、P2通知channel条件、checkout内の分野別根音表。
5. E01の固定N/P/C、T0〜T6 trace、Chrome時計対応、固定最小geometry、最大U-W checkpoint。
6. filesystem故障注入adapterと、実媒体でのsync/rename/ack喪失の証拠条件。

以上が凍結されない場合、独立して進められるのはA1の共有型・純粋runtime、A2の容量計数、各unitの未決に依存しない純粋抽出までであり、P2完了は `Blocked` とする。

## 8. IR01/03/06/08/14 の対応表（2026-09-16 夜、統合担当が元レビューから起こした）

§1.2 と「発注前に不足している材料」1 の充足。出典は ChatGPT Pro 独立レビュー（2026-09-11、作業ノート `To-Claude/2026-09-11-FlEq-P0-v3.1-independent-review.md`）の各 IR の「箇所」「直し方」と、それを取り込んだ spec v4 の条項（`docs/specs/reconstruction-p0-contracts.md` の行）。契約起草時は本表を出典にし、IR 番号だけを `acceptanceChecks` に複写しない。

| IR | 元レビューの指摘（要旨） | spec の受け皿（条項） | 担当契約 | 検収 ID |
|---|---|---|---|---|
| IR01 | 最古の保存失敗単位が writer を独占し、正常な他単位の保存を永久に妨げる | §5.8 `:853`〜`:876`: 単位ごとの `retryAfter`・連続失敗回数、「dirty かつ試行可能のうち最古の `dirtySince`」、終了済み失敗の 1／2／4／8／10 秒間隔、停止未確認 I/O の writer 占有は維持、E14 に「一単位だけ永続失敗＋他単位正常」 | A3 checkpoint-shutdown | E14（`:2066`）、O10 の単位固有失敗 |
| IR03 | 大津波警報の通知が通常通知と再試行の後ろに置かれ、期限内に届かない | §6.3 `:946`〜`:966`: 固定優先群「通常運用の EEW → 津波緊急 → その他」、緊急 intent の初回 adapter 呼出し暫定 1 秒以内、下位群実行中の abort、通常再試行が緊急を追い越さない | A7 notification（EEW 部分。津波緊急は P3 の津波単位契約で同じ条項を検収） | E21（`:2073`） |
| IR06 | checkpoint encode 起因の EEW 未達に対し、parse 分離 B では原因が残る | §7.6 `:1149`〜`:1168`: T0〜T6 と七区間で主因を帰属、XML parse 主因の場合だけ B、encode・射影・整形・転送起因は非中断区間の縮小を先に比較し同じ母集団で再測定、成立しなければ当該契約を Blocked | A10 E01 統合（原因帰属・A/B 判定・Blocked 出口）、A3（encode の非中断区間） | E01 母集団 3（最大 U-W checkpoint encode 開始直後）、§7.5 `:1102`〜 |
| IR08 | 意味鮮度の疑いを、別 subject・別官署の正常受理で解除できる読み方が残る | §7.8 `:1192`: `freshnessSuspect` を `operation／family／subject／影響範囲` へ束縛、解除は同じ対象・範囲の正常採用か coverage 確認だけ、別官署・別 subject・別区分・heartbeat では解除しない。§9.3 O04 `:1780` に「全国報不採用→別官署 partial 受理→全国の疑い存続」 | A5 I-U-W（判定と解除）、A1 shared-runtime（記録の型） | O04（`:1780`）、§7.8 の監視表 |
| IR14 | queue 年齢の 3 窓連続増加をそのまま不合格にする式は誤検出する | §9.9 E07 `:2058`: 3 窓連続増加は要調査シグナル、合否は宣言上限・通常入力の最大待機年齢（暫定 5 秒）・入力停止後の排出（暫定 10 秒）・周期末 backlog 非増加 | A2 mailbox | E07（`:2058`） |

IR02（運用区分の全経路伝播）は P1 で三判定源を閉じ、P2 では EEW の通常／訓練交差系列（A4）へ引き継ぐ。IR15（intent 同居による encode 回数）は E10／E15 の計測として A3 が報告する。上記以外の IR（04／05／07／09〜13）は P3／P4 の該当契約前に扱う（元レビュー最終判定）。
