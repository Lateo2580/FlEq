# P3「意味と出力と移行」発注計画

- 起草日: 2026-10-01（修正 5 まで反映。作者裁定 S5・D-P3-1〜6 は 2026-10-01 に全部 A。修正 5 は同日夜、Pi 500 の実測（台帳 63）と進行の外部相談を受けた D-P3-7〜9 と工程の前倒し。C4 の閉鎖は 2026-10-08 に §5 末尾・§6 と `p3-e01-reaccept.json` の P3-C4-CLOSE-* に記録）
- 対象 checkout / base: `/Users/sayue/dev/FlEq` / `584a0b6cfcdc2ab0f726f48e59d28fbb246b7a43`
- 目的: P3 を契約に分け、順序・依存・凍結物・検収 ID・作者裁定を決める。各契約本体（JSON）は本書の対象外とする。
- 前提（覆さない）: S2=A（P3-0 → P3-1 → P3-2 → 残り unit）、S3=A、S4=A、R43〜R58、R10、R61・R63、P2-A10-PERF-P3・P2-A10-E15-P3。本文は進捗ノート §3（作業ノート、repo 外）と `reconstruction/contracts/p2-eew-e01.json:56`〜`:108`。
- 原則: 1 実装の interface、factory、汎用 worker pool、journal、DB、将来用 registry を足さない（`docs/specs/reconstruction-p0-contracts.md:2754`）。機構を 1 つ足すときは、要求する契約 ID と「無いと壊れる振る舞い」を 1 行で添える。受信経路で全件×全件の走査や全量直列化をしない（`AGENTS.md` の受信経路の計算量）。
- 実装体制: 各契約は Claude のサブエージェントで、実装 → 契約適合レビュー ∥ コード品質レビュー（同じ固定 patch に並行、D-P3-11）。Codex（Astra high、read-only・新規スレッド）の総合レビューは §5 の D-P3-10 の節目で行う。表の「担当」は省略し、この体制を全契約に適用する。

以下、`spec:` は `docs/specs/reconstruction-p0-contracts.md`、`e01:` は `reconstruction/contracts/p2-eew-e01.json`、`p2plan:` は `reconstruction/contracts/p2-order-plan.md` の行番号を指す。

## 1. P3 の完了定義

### 1.1 凍結ゲート

各契約のコード着手前に、次を機械検査できる契約 field と版付き資料にする。

1. **C0 の前**: unit 表の型（`UnitModule<K>`、`persistence: durable | ephemeral`、§3.2 の 5 関数）と coverage 表の行形式（ready＋unit／not-ported＋理由／ignored＋理由）。S3 の 4 行の行き先を含む。
2. **C3a の前**: 実行の境界（publisher と worker の間の入出力の型、D-P3-1 の実行場所、checkpoint の書込み権）。
3. **C4 の正式測定前**: 予備測定の後に凍結する P3 測定 manifest（§4.3）。結果を見てから母集団・除外条件を変えない（spec:1106）。
4. **C5 の前**: `I-U-T`、Q-NOTICE の津波分、§7.5 の津波系列（spec:1131。容量縮退は期待値だけ、D-P3-6）。spec:1104 は「津波を閉じる P3 契約前に津波条件を凍結」と定める。
5. **各 unit の前**: その `I-U-*`（spec:590「残りは各 P3 単位の実装前に凍結」）と、C16 が集める E22 の復旧範囲（N2、spec:2925）。

### 1.2 機械的受入 ID

spec の P3 行（spec:2614）が求めるのは、全 route の正常・取消・復元の oracle 合格、一入力一保存単位、必須機能契約、移行直後の続報、通知・export の故障隔離、津波単位の運用区分・緊急通知・§7.5 系列・最小実描画での E01 である。これに P2 からの移管（§6）を足す。

| 区分 | P3 で閉じる確認 | 判定 |
|---|---|---|
| EEW の正式再検収（移管） | spec §7.5 の EEW 母集団 1〜3（spec:1124〜1128）。P2 が除外した 4 条件と衝突試験（最大 VPWS50 の受信直後の EEW） | 各 run の p99(U_i)≤250ms・欠落 0、T0 が対象処理開始後 0〜5ms かつ処理中である証拠（spec:1133）。投入→T0 の待ちを別記録 |
| 性能・保存の帰属（移管） | E02-P・E05-P・E06、E15 の全要素 | `e01:93`・`e01:102` の再検収条件 |
| 保存・終了 | E10、E14、E20、O07、O10 | 実行の分離と保存手順の変更後に再検収。E20 はその時点の単位を C3b、全単位（spec:2072、spec:889）を C22 で |
| 実行・監視 | E07、E08、E11、worker の stalled／unresponsive（spec:1190〜1191） | 止まっている最中の検出は P3-1 から保証範囲に入る（R60 の P2 限定を解く） |
| 1 unit 追加の型 | 台帳 52 の実害 3 点が 0、coverage 全行、負の型検査 | C0 |
| 津波 | O05、O01/O07 の津波 step、E01 の津波系列（発令系と解除系を別に）、E21 の津波緊急（spec:2073） | IR02・IR03・IR05 を検収 |
| 各 unit | §13.3 の 9 段（spec:2650〜2660）、O01〜O08 の該当 step、E13 | unit ごとに版付き subset を固定（P2 の D5 と同じ型） |
| 回復 | E22（spec:2074） | C16 が unit ごとの subset で集める |
| 移行 | O04:2、O06:29-30、§10.4 の出力（spec:2159〜2201） | 旧 v2 の読み取り専用コピーから。逆変換 tool は作らない |

D-AC は P4 で検収する。津波の最小描画は先行証拠として記録し、D-AC を Pass と報告しない。O09（spec:1785）は step ごとに振り分け、C4 の manifest 凍結時に版付き subset で固定する: EEW の E01 母集団は C4、津波は C6、main health・queue 待ち・固定優先順は C3b・C4（E02・E07）、EEW の容量縮退（spec:1129 の母集団 4）と personal 有効は P4/P5、津波の容量縮退（spec:1131）は D-P3-6 により期待値だけを P3 で固定し、測定は P4。O11（spec:1787）は §5.2 で P4 へ送る。現行 sequences の unmet は O01=14、O02=12、O03=3、O04=5、O05=12、O06=26、O07=1、O08=4、O09=57、O10=0、O11=5（`node reconstruction/tools/corpus/check-sequences.mjs`、2026-10-01 実行）で、免除しない。

### 1.3 完了報告

P2 計画 §1.4（p2plan:63〜68）をそのまま使い、reconstruction のゲート（root の build/test に含まれない。`AGENTS.md` のビルド・テスト節）を全契約で通す。

- **最初の契約群（C0〜C4）の完了**: E01 の正式再検収と R63 の条件（所有者・接続 1 本・既存接続の保護・実接続検証・共通受入口への結線）が揃うまで完了にしない（`e01:562` の (5)「未達・未測定では当該契約群を完了にしない」）。E01 や R63 を P4/P5 へ再移管するには、R61・R63 を改める新しい作者裁定が要る。
- **P3 最終完了**: C22（最終ゲート）の合格、C21（personal 配線）の配送と C22 のうち影響する部分の再受入（spec:2953 は実配線で O09/O10 を通すことを求める）、§6 の移管行がすべて「再検収済み」か「新しい作者裁定で P4/P5 へ再移管」になった時点。spec:2614 は personal 配線を P3 に含めるので、C21 を P3 の外へ出すには作者の裁定が要る。C21 の配送前に行う C22 は部分受入とする。

## 2. 契約の分割案

### 2.1 推奨案 A: 最初の契約群 6 本＋津波 2 本＋残り 16 本

最初の契約群（P3-0・P3-1）:

| # / 契約 ID | 対象 | 公開型・公開口 | 依存 | 凍結するもの | outOfScope | 検収 ID |
|---|---|---|---|---|---|---|
| C0 `P3-UNIT-TABLE-001`（P3-0） | R43・R44、台帳 52 | `UnitModule<K>`、`unitTable satisfies { [K in RuntimeUnitId]: UnitModule<K> }`（`UnitId` は未実装の 9 unit を含むので鍵にできない）、unit 列（`as const`＋網羅検査）、coverage 表、相関 union を受ける dispatcher の網羅 switch 1 つ | P2 完了（裁定不要） | unit 列の真実源 1 つ。headType→unit の唯一の対応。not-ported／ignored／表に無い型を実行時に件数か診断で区別。`Record<RuntimeUnitId, …>` のように型が漏れを止める箇所は残し、unit 変数による分岐と配列の直書きだけを表へ寄せる | 実行場所の列（C3a）、新 unit の意味 | 既存 3 unit の全試験・shuffle 緑、負の型検査 6 本（R43 の probe）、台帳 52 の 3 点の再現試験、E08・E11 不変 |
| C1 `P3-CHECKPOINT-STEP1-001`（P3-1） | 保存の設計 手順 1 の ②〜④、台帳 55 | `CheckpointCoordinator` の定常保存経路 | C0 | 書き手が有効 slot と世代を覚える。読み直しは起動時の復元と `uncertain` の照合だけ。envelope の直列化は 1 回で、hash はその bytes に取る | 官署ごとの保存（D-P3-2）、E15 の計測点（C4） | 定常保存の読み直し 0、既存の保存試験の緑、S5 の範囲の故障注入 |
| C2 `P3-DMDATA-CONNECT-001`（P3-1） | R63、台帳 58・59、spec §10.1 | 最小の live 起動入口（API キー・appName・購読区分を受け、REST socket start で得た URL で `startP2Host` を起動）、接続の再接続、生存監視、start frame の記録先、接続回復の通知口 | C0 | 接続 1 本（R57）、自分の socket だけを閉じる、生存監視の期限、T0 より前で decode・normalize をしない | CLI の引数解析（C18）、購読区分の拡大（R54） | B03 の接続所有（spec:372）、§10.1 の条件（spec:2111〜2119）、実 dmdata 接続の検証（D-P3-3） |
| C3a `P3-EXECUTION-SPLIT-001`（P3-1） | R56・R57、台帳 38・55・56・61、手順 1 の ①・⑤、mailbox の dispatch | publisher と worker の間の型付き入出力、unit 表の実行場所 1 列、worker の生成、mailbox の実行場所別 dispatch（P2-MAILBOX-001 の改訂） | C1、C2 | 解凍・XML parse・reduce・期限処理・checkpoint encode と書込みは unit の持ち主の worker 内。parse 済み tree は worker 外へ送らない（台帳 38: 転送 212ms）。公開担当は 1 つ。保存完了で dirty を無条件に消さない。16 KiB 以下の data frame を peek と ingress で 2 回 JSON parse している現状（`host.ts:174`〜`:188`）を、spec:1072 の「全文の JSON parse は一回」に直す。mailbox は通常 data の in-flight を実行場所ごとに 1 件、件数・byte 上限は全体で 1 つ、同対象の順序と完了照合を保つ | 停止監視（C3b）、新しい unit、官署ごとの保存 | E10・E14・O07・O10 の再検収、台帳 62 と同型（参照 cache 外れで全量へ戻る計量）の点検 |
| C3b `P3-EXECUTION-LIFECYCLE-001`（P3-1） | 台帳 56・57 の残り、spec §5.9・§7.8 | worker の停止監視、通常終了の順序（worker の終了を含む） | C3a | spec:1190〜1191 の stalled／unresponsive、§5.9 の順序・世代・code | 自動再起動の方針（spec に無い。要るなら裁定） | E07・E08、その時点の単位での E20（全単位は C22）、止めた worker での stalled／unresponsive の検出試験 |
| C4 `P3-E01-REACCEPT-001`（P3-1） | R61 の 4 条件、PERF-P3、E15-P3、衝突試験、AC15 の再集計、Pi 予備確認（D-P3-7） | P3 測定 manifest、runner の改修（full parse 開始の観測、切断 hrtime と充填時点の `state/`・`/snapshot` の保存）、host config の filesystem 注入口、E15 の計測点（C3a 後の配置に 1 回だけ置く）、A10 の測定道具を C1 後の保存 stage に追従（verify の読み直しが消えるので、保存の占有に verify を数える `reconstruction/test/eew-e01/aux-measures.mjs:188`・`ac15.mjs:181` を直す） | C3b | 投入→T0 と T0→T6 を分けた記録、Pi の `/proc/pressure/*` との突合せ（報告のみ）、Pi での unit ごとの保存回数・書込量 | 津波の母集団（C6）、P4/P5 の母集団 | E01（§1.2）、E02・E05・E06、E15、E03・E12 の報告、N7・IR06 の閉鎖の記録、Pi 予備確認の記録（正式 Pass と呼ばない、§4.5） |

C3a の分離は R57 で決まっている（解凍と XML 解析は公開担当のスレッドで行わない）。A10 の参考測定では、最大 VPWS50 の decode 中に投入した EEW の投入→T0 が p99 388ms、最大 U-W の encode 中は 148ms、最大 U-F の保存中は 67ms、期限処理の重なりは 9.7ms で、T0→T6 の p99 上界はどれも 35〜44ms だった（`reconstruction/test/eew-e01/evidence/windows/a10-p2-20260930b/results/result-reference-*-run1.json`）。待ちの主因は受信 callback 以前で、T0→T6 に現れない。N7・IR06（§7.6 の parse 分離 B）は C3a で parse が publisher の外へ出た時点で構成として閉じ、C4 は衝突試験の結果を証拠に「閉じた」と記録する。ただし worker を分けるだけでは足りない。現 mailbox は parser 入力が 1 件 in-flight の間、ほかの parser 入力を一切渡さず（`reconstruction/src/mailbox/mailbox.ts:119`）、契約も通常 data の in-flight を 1 件と定める（`p2-mailbox.json:320`〜`:323` の P2-A2-RES-07、spec:1049）。このままでは大型 parse 中の EEW が mailbox で待つので、C3a が mailbox と P2-MAILBOX-001 を改訂する。

C2 の範囲: `composition-root.ts` の接続表示（`:327`〜`:335`、`:400`〜`:402`）と、start frame の記録に要る型（診断 reason の閉集合 `p2-shared-runtime.types.ts:228`〜`:238`、`p2-eew-e01.types.ts:103` の `P2HostObservation`）の編集権を持つ。台帳 59 の回復は RuntimeInput の型を変えずに直す。reconnecting は composition root 内の `lostThroughSequence` だけで決まる（`:329`、`:333`〜`:335`、`:401`）ので、`recordInput`（`:398`）と同じ形のメソッド 1 つで `null` に戻し、画面へは毎秒の tick の射影で届く（`view-projector.ts:561` の変更比較に connection が入る）。heartbeat は worker・latestVersion・emittedAt しか運ばない（`http-sse.ts:166`）ので、heartbeat には頼らない。確認状態は戻さない（R42）。`startP2Host` の config は接続先 URL だけ（`host.ts:24`〜`:31`）なので、live 起動入口は C2 が足す。

P3-2（津波）:

| # / 契約 ID | 対象 | 公開型・公開口 | 依存 | 凍結するもの | outOfScope | 検収 ID |
|---|---|---|---|---|---|---|
| C5 `P3-TSUNAMI-UNIT-001` | M04、I-U-T、IR02・IR03、R45、spec:1092 | 津波 unit の State・Persisted・View、唯一の codec、unit 表の 1 行、coverage の VTSE41/51/52 行、VTSE41 の `tsunamiCandidate` 付与（`host.ts:199`〜`:201` の編集権） | C0〜C4 の完了（§1.3）、Q-NOTICE 津波分 | §4.2 U-T（spec:476）、station 最大 1024×2（spec:575）、津波緊急 intent の固定優先（spec:946〜966）、容量縮退系列の期待（D-P3-6） | 最終 GIS、REST 回復（C16） | O05、O01/O07 の津波 step、E13、E21 の津波緊急、VTSE41 の発令・解除・降格が緊急予約と固定優先順で通常 backlog を追い越すことの製品経路検収（現 host は VXSE43/45 だけを緊急候補にし VTSE41 は normal、`host.ts:201`）、R45 の確認（触ったのが adapter・意味・codec・射影・fixture 期待値・coverage 行だけか、file 一覧で示す） |
| C6 `P3-TSUNAMI-E01-001` | IR05、津波の最小実描画（spec:1147） | 津波の大カード・警報区分・最小海岸線の描画、T5/T6 marker（A9 の型を流用） | C5、C4 の runner | §7.5 の津波 T6（spec:1115）、発令系と解除系を別母集団、最小海岸線資材（D-P3-4） | hover・詳細・LOD・P4 の意匠 | E01 の津波系列 4 母集団（通常 backlog・大型 parse 直後・encode 直後・EEW 同時）。Pi backend＋Mac Chrome で、津波の発令系・解除系と EEW 同時の短い予備確認（D-P3-7、U-T を急ぐ worker に足した干渉を見る）。容量縮退（spec:1131）は未検収の範囲として P4 の容量契約を引受先に記録する（D-P3-6） |

残りの 15 本（unit 契約の公開口は P2 の A4〜A6 と同じ型: State・Persisted・View、唯一の codec、unit 表の 1 行）:

| 契約 | 対象 | 先に要るもの | 検収の要点 |
|---|---|---|---|
| C7〜C14 `P3-UNIT-{Q,N,V,L,R,B,M,Y}-001`（D-P3-5 の順に C7=U-Q、C8=U-N、C9=U-V、C10=U-L、C11=U-R、C12=U-B、C13=U-M、C14=U-Y） | I-U-Q・N・V・L・R・B・M・Y（spec:595〜605） | 各 `I-U-*`、Q-LIMIT（最大正常と +1）、Q-NOTICE の該当 family | §1.2 の「各 unit」行。共通条文: 拒否・診断の記録容量を上限の内側に予約（台帳 41）、受信 1 回の費用（台帳 47）、履歴の深さ上限と容量上限を同じ decision に束ねない（台帳 60）、受理と decode と世代の計量は配送の更新の予約を `reconstruction/src/notification-delivery/delivery-growth.ts` の式で数える（P3-INTENT-UPDATE-RESERVE-001）。横断不変条件は §9 の P3-X-C1〜C6 による。既配送 unit への適用は同節の6修正契約の上書き条文に従い、期限・再受理・normal 非active記憶の保護・outcome の時制は各 unit の裁定値を用いる。C12 以降はパラメータ表と境界受入例を発注前に埋める。実行場所は急ぐ unit と急がない unit を同居させない（D-P3-1）。配置先 worker で最も長い非中断処理（最大入力・期限回収・view 生成・checkpoint encode）と、その処理中に急ぐ入力を受けたときの待ちを報告する（台帳 63。正式 E01 の全実施は求めない）。S3 の not-ported 行（VXSE47→C7、VPBS51→C12、新指定河川→C11）は移植時に中身を確かめてから ready にする。C11 は R51 の意味要件（水位の観測・予測 series と基準水位）。C14 は R50 の意味要件（台風の数値緯度経度、予報円の中心と半径）、R53（VPTA50-55・VPTW60-65 を coverage に全部）、coverage 下書きの未確認 2（spec の M11/M12 の範囲表記、§4.4） |
| C15 `P3-MIGRATION-001` | §10.4 の移行器、Q-MIGRATION、O04:2・O06:29-30、N8 | 着手: persisted 型が凍結した unit から（spec:2161 で移行器は製品 runtime の外）。完了: 対象の全 unit の配送・結線後（復元後に取消・訂正を投入する検収、spec:2176） | 旧形式変換・operation 証明・捨てた履歴範囲の報告（p2plan:215・:243）、旧 checkpoint の operation 不明を未確認とする期待（`p2-checkpoint-shutdown.json:720`）、復元直後の続報 |
| C16 `P3-RECOVERY-001` | §10.5 の REST 回復、N2、E22、`origin=recovery`（`p2-eew-unit.json:189`） | 着手: 回復範囲（N2、spec:2224）、C3a の mailbox credit（spec:2211）と runtime の候補採用（spec:2216）の境界、C2 の REST 接続。完了: 対象 unit の配送・結線後（共通の reducer を使う、spec:2207。live との競合の受入、spec:2224） | unit ごとの E22 subset。途中公開 0・新規履歴通知 0・live 上書き 0・期限延長 0（spec:2224） |
| C17 `P3-REPLAY-CLI-001` | R10②: `fleq replay <fixture...>`、spec:650 | C3b（host の入口）、C4 の runner | 固定時計・隔離保存先・通知無効化。runner を C4 と共有するのは、検収用 replay と公開口を同じ製品経路に通すため（spec:650）。Q7 表への追記は §4.4 |
| C18 `P3-CLI-REPL-001` | B12。§11.2 の互換必須行、§11.3 の互換必須の REPL 19 行（spec:2310〜2352）、§11.5 の設定移行（spec:2403） | 着手: C2（引数解析と typed command の先行実装）。完了: C9（U-V）・C15・C16・C19（各入口の機能結線） | §11 と O10。無効入力で副作用 0（spec:381）。`volcanorepair`（spec:2347）は新 U-V と移行契約で復旧不足の確認・明示解決を実現する（spec:2351）ので、機能結線の検収は依存先の配送後 |
| C19 `P3-TERMINAL-OUTPUT-001` | B13。R10① の CLI 表示設計 spec、§11.4 の端末側の互換必須行（定期要約・当日地震履歴・EEW ログファイル・待機 tips・update check・lowmem、spec:2353〜2400） | CLI 表示設計 spec（材料は CLI 監査 2026-08-26、作業ノート） | §11 と O02（spec:382）。出力滞留が受理を止めない |
| C20 `P3-WEATHER-NOTICE-001` | U-W・U-F の通知 intent の生成 | Q-NOTICE の気象分、台帳 48（終端 intent の持ち方を U-E 型へ揃えるか）の決定 | E21 の気象分、終端 intent の件数上限が復元境界と保持の両方で効く証拠 |
| C21 `P3-PERSONAL-001` | spec P3 行の personal 配線、B10・§12 | PERS-1〜5（spec:2949〜2953）。この checkout に実体が無い | 未見積もり（§8） |
| C22 `P3-FINAL-GATE-001`（統合担当） | 全単位接続後の最終検証（spec:2664）と終了の再確認（spec:889） | C7〜C20 の配送。C21 の配送前は部分受入で、配送後に影響する部分（O09/O10 の実配線分を含む）を再受入 | 全 route の正常・取消・復元の oracle、一入力一保存単位、全単位での E20（spec:2072）、Pi での短い確認（最も重い急ぐ unit との競合、全 unit 同時 dirty の保存、終了。D-P3-7）、通知・export の故障隔離と O10 の U-V・export 分（p2plan:215） |

### 2.2 代替案 B: 最初の契約群を 3 本にまとめる

C1・C3b を C3a に、C4 を C3a の完了条件に含める。起草とレビューの回数は減るが、C3a は A3 と A10 の host 結線を合わせた規模で、保存の故障と実行分離の故障と測定の不備を同じスレッドで切り分けることになる。P2 の D4（測定の所有を 1 契約に集める）とも逆向きだ。推奨は A。

## 3. 発注順と並列可否

### 3.1 依存グラフとレーン

```text
C0 → C1 ∥ C2（C2 の実接続の検収は作者が決める時刻）
C1・C2 → C3a → C3b → C4（正式測定は manifest 凍結の後）→ 最初の契約群の完了
最初の契約群の完了 → C5 → C6
C5 → unit レーン: C7〜C14 を D-P3-5 の順に（C6 と重なってよい）
脇レーン: C2 → C18 の前半、C3b・C4 → C17、CLI 表示設計 spec → C19、Q-NOTICE 気象分・C3a → C20、
          凍結した persisted 型 → C15 の着手、回復範囲・C3a・C2 → C16 の着手
対象 unit の配送・結線 → C15・C16 の完了 → C18 の完了（C9・C19 も）     C7〜C20 → C22（最終ゲート）
```

- **同時実行の上限**: 実装中の契約は、C6・unit レーン・脇レーンを全部合わせて同時に 3 本まで。直列区間（C0〜C5）では、直列の 1 本のほかに脇レーン 2 本まで。C5 の配送後に 4 本目を 1 本だけ試してよい（D-P3-12）。
- **unit を並走させてよい条件**（C5 が R45「1 unit 追加の型」の試行なので、C5 の配送後に限る）: 各 unit レーンは自分の unit・domain・test の directory だけを所有し、共有ファイルには自分の 1 行（unit 表・coverage・route）を足すだけにする。P2 計画も A4〜A6 の並走を認め、結線は直列にしていた（p2plan:126。実際の配送は 9/20 朝・同夜・9/23 で、同時進行の度合いは未確認）。
- **脇レーンの所有**: 各脇レーンは契約で名前を固定する新設 directory だけを排他的に持つ（C15 は移行器、C16 は回復、C17・C18 は CLI、C19 は端末出力）。C20 は実施中だけ U-W・U-F の unit・domain directory を持つ。脇レーンが使う他契約の境界は、着手前に凍結済みであること（C16 は C3a の mailbox と runtime 採用、C2 の REST。C17 は C3b の host 入口と C4 の runner。C20 は C3a）。
- **共有部分への合流**: unit レーンも脇レーンも、共有ファイル（§3.2）への結線は統合担当が 1 本ずつ直列に合流し、合流のたびに reconstruction のゲートを全部回し直す。
- **C6 と最初の unit レーン**: C7 の依存は C5 で C6 ではないので、C6 と unit レーンは重なってよい（上限 3 本の内側で）。
- **測定の隔離**: C4・C6 の正式測定の窓では、同じ機械で build・test・他レーンの作業を走らせない。正式測定は Mac mini の独立 checkout で行い（2026-10-06 作者裁定、C4 の P3-C4-MACHINES=B。A10 の MacBook M5 の値は参考の比較にだけ使う）、その窓では Mac mini で build・test・他レーンを走らせず、実装レーンは MacBook で続ける（`reconstruction/dist/`・`node_modules` を測定用 checkout と共有しない）。Pi 予備確認（§4.5）の第 1 段は Pi の中で完結するので Mac のレーンを止めない。第 2 段（Pi backend＋Mac Chrome）は Pi と Mac の両方を測定機として扱い、この規則を両方に適用する。private corpus と測定の生データは Mac・Mini・Pi のローカルに置き、公開の Actions・artifact に渡さない。
- **脇レーンは最早着手条件で始める**: C15・C16 の本体と C18 の前半は、§2.1 の「着手」条件が揃った時点で始め、全 unit の配送後には結線と受入だけを残す（§7 の配置例より優先）。
- **起草の先行**: 次の契約の起草と発注前点検は、前の契約の実装中に進める（例: C3a の実装中に `I-U-T` と Q-NOTICE 津波分を凍結、C5 の実装中に `I-U-Q`・`I-U-N`・`I-U-V` を起草）。C3a・C3b・C4 の本文も C1・C2 の実装中に起草と点検まで進める。C1・C2 の配送後に確定するのは、実装への参照・baseOid・最終の型と hash・測定条件だけで、実装後にしか分からない値（RSS、`ingressJsonMs` など）は仮の数字で凍結しない。C4 のうち母集団の対応表・期待する証拠・集計と判定の試験・runner の準備は C3a の配送を待たずに進め、新配置への計測点の設置・予備測定・manifest 凍結・正式測定は C3b の後に行う。

波: Wave 0 で C0〜C2 の本文と C3a・C3b・C4 の境界・凍結項目（§4.2・§4.3）を起草（C3a・C3b・C4 の本文は Wave 2 の実装中に起草、修正 5） → Wave 1 で C0 → Wave 2 で C1 ∥ C2（C1 は `checkpoint.ts` だけで `composition-root.ts` に触れない）→ Wave 3 で C3a → C3b（spec 改訂 §4.4 は C3a の凍結と同時）→ Wave 4 で C4（Mac の予備測定と Pi 予備確認 → manifest 凍結 → 正式測定）→ Wave 5 で C5（最初の契約群の完了後。PERF-P3 だけが残った場合に先へ進めるかは作者裁定）→ Wave 6 で C6 と unit レーン・脇レーン → 最後に C22。

### 3.2 共有ファイルと衝突源

| 衝突源 | 所有と編集順 | 並走時の規則 |
|---|---|---|
| unit 表・coverage 表・route（`shared-runtime.ts` の行き先）・`p2-shared-runtime.types.ts` の `UnitId`／`RuntimeUnitId`（:18、:22） | C0。実行場所の列は C3a。以後は各 unit レーンが自分の 1 行だけを足す | レーンの行は統合担当が 1 レーンずつ直列に合流し、合流ごとにゲートを回す。列の追加は C3a だけ |
| unit・domain・test の directory、脇レーンの新設 directory | そのレーン（§3.1） | 他レーンは触らない。共有部分への結線は統合担当の直列合流 |
| CLI の入口（コマンドの振り分け） | C18 | C17 の replay 入口の追加は直列合流 |
| `reconstruction/src/checkpoint/checkpoint.ts` | C0（`:171`・`:186` の unit 列の直書きだけ、Wave 1）→ C1 → C3a → UWR（`P3-UNIT-WRITE-RIGHT-001`。CheckpointWriter の権を unit ごとに、D-P3-2=B） | Wave 2 では C1 だけが編集する |
| `reconstruction/src/checkpoint/persistent-diagnostic-sink.ts` の reason 一覧（`:40`〜`:52`） | C0 → C2 → C3a → C3b（直列） | reason の追加だけ |
| `reconstruction/src/units/*/` | C0（unit ごとの module の export を足す）→ 各 unit レーン（自分の directory） | 他 unit の directory は触らない |
| `reconstruction/src/host/host.ts` | C2 → C3a → C3b → C4（config の注入口だけ）→ C5（:199〜:201 の候補分類だけ） | Wave 2 では C2 だけが編集する |
| `reconstruction/src/mailbox/mailbox.ts` と `p2-mailbox.json` | C3a → C3b（実行場所の pending を 1 回の走査で外す 1 メソッドだけ） | dispatch の改訂は契約改訂と同じ commit |
| `composition-root.ts` | C0 → C2（接続表示と start の記録だけ）→ C3a → C3b → C4 → UWR → C5 → unit レーンの結線 | C1 は編集しない。C5 は UWR の合流の後で rebase し、ずれた anchor は UWR の合流と同じ commit で直す。unit レーンの結線は統合担当の直列合流 |
| `shared-runtime.ts`・`view-projector.ts`・`owner-runtime.ts` | C0 → C3a → C3b → unit レーン（`owner-runtime.ts` は C3a → C3b → UWR［finish の射影の前の時刻の読み口だけ］→ C5 → unit レーン） | unit レーンの変更は統合担当の直列合流。台帳 49 で view の版を固定長にするなら C3a |
| 診断 reason・`P2HostObservation` の型 | C0 → C2（start の記録に要る分だけ）→ C3a → C3b → C4 → UWR（generationRaised に ownerMonotonicMs を足すだけ） | 追加は契約改訂として記録 |
| P3 測定 manifest・runner（`reconstruction/test/eew-e01/**` の後継） | C4（津波の母集団は C6）。UWR は `aux-measures.mjs` の E14 の束の起点だけ | A10 の版付き結果（`a10-p2-20260930b`）は書き換えない |
| `sequences.json` と派生 fixture、spec | 統合担当 | unit レーンは期待値を変えない。追加 step はレーンごとに直列で合流 |
| `reconstruction/package.json`・tsconfig・vitest config | 最初に必要とする契約 1 本 | 依存追加は原則 0。worker 用の build 出力が要るなら C3a |

## 4. 先に凍結する契約

### 4.1 C0 の unit 表

固定内容: unit 列の真実源 1 つ、`UnitModule<K>`、dispatcher の網羅 switch、coverage 表の 3 区分と理由。現 HEAD の直書きは、unit 列の配列 8 か所（`shared-runtime.ts:43`、`composition-root.ts:282`・`:310`・`:503`・`:545`・`:553`、`checkpoint.ts:171`・`:186`）と、`=== "U-x"` の分岐 33 か所（`shared-runtime.ts` 20、`view-projector.ts` 13）。分岐のうち unit 変数で分けるのは 14 か所（`shared-runtime.ts:89`・`:145`・`:401`・`:408`・`:434`・`:439`・`:442`・`:529`・`:533`・`:725`・`:727`・`:926`、`view-projector.ts:442`・`:490`）で、残り 19 か所は view や scope の判別共用体の値で分けている。台帳 52 の 6 か所から A10 の結線で増えた。実害 3 点は現 HEAD でも残る: ① `unitRoutes` は `Map<string, RuntimeUnitId>`（`shared-runtime.ts:47`〜`:51`）で、行き先の無い headType は envelope が正しければ診断も件数も残さず捨てる（`:923`、`:938`〜`:945`）② 復元の最後の else が U-F に流れる（`:537`〜`:540`）③ 保存候補が直書き列で絞られる（`checkpoint.ts:186`）。

材料: R43 の probe（tsc strict で `as` 0・負の検査 6 本）、coverage 表の下書き（作業ノート、143 行。S3 の 4 行を反映する）。coverage 表はコードの `as const` 表を正とし、spec には挿入しない（§4.4）。足りないもの: corpus manifest の全 headType が表にあることの検査。

CI の reconstruction 系列は新築の shuffle を回していない（engine-shuffle は旧築の `npm run test:shuffle` だけ、`.github/workflows/test.yml:66`〜`:77`）。C0 の検収は新築全体の shuffle 緑を求めるので、C0 で CI の reconstruction 系列に shuffle の実行を足す。C0 契約への追記は baseOid の割当時に行う。

### 4.2 C3a・C3b の実行境界

固定内容: unit の実行場所（D-P3-1）、publisher へ渡すもの（版付きの有界な view・outcome・intent 選択の入力。巨大な canonical state は渡さない）、checkpoint の書込み権（§5.1）、期限処理を持ち主の中で行うこと、停止監視（spec:1190〜1191）、通常終了の順序（spec §5.9）。

材料: 手順 1 の ⑤（保存完了で dirty を無条件に消さない）は現実装が満たしている（`shared-runtime.ts:971`〜`:973` は ack 世代が現在世代と一致したときだけ `dirtySince` を消す）。分離後もこの条件を検収に残す。未確認のまま進めるもの: worker を増やしたときの RSS（E05 は worker を含む、spec:2056。E05-P は既に Fail）と、大きい frame の envelope JSON.parse（`reconstruction/src/ingress/ingress.ts:33`）が publisher に残る費用。実装後にしか測れないので着手条件にせず、C4 の予備測定・正式測定で取る。

### 4.3 P3 測定 manifest

固定内容: A10 の参考 4 条件の負荷定義を正式条件として継承し、各 1,000 標本×3 run と 100 warm-up（spec:1118〜1119）にする。full parse 開始の観測点を足す（`e01:726` は「P3 の正式再検収で追加する」）。衝突試験は新しい母集団 ID にする。理由: spec §7.5 の母集団 2 は「parse 開始直後」で、R57 が求める「1 本の接続で先に届いた最大 VPWS50 の転送を追い越せない」待ち（受信直後）を含まない。PERF-P3 の窓は `a10-p2-20260930b` の P と C をそのまま使う。測定側のローカル WS は ping を送らないので、C2 の生存監視（90 秒）のもとでは、frame の間隔が 90 秒を超える窓で再接続が起きる（C2 の Q-C2-RUNNER-LIVENESS）。ping を送るか、間隔の上限を窓の定義に入れるかを manifest で固定する。

母集団は fixedBacklog・参考 4 条件・衝突試験の 6 つで、同じ正式規定なら正式標本は 6×1,000×3＝18,000 件（§1.2・§2.1 の「5 母集団」はこの 6 に読み替える。衝突試験を別形式で検収するなら、その条件を manifest に書く）。投入周期だけで積むと、fixedBacklog 1,370ms・参考 4 条件 3,000ms の 5 母集団で 3×1,100×(1.37＋4×3)÷3,600≒12.3 時間で、衝突試験・初期化・後処理・PERF-P3 の窓・T0 が処理開始後 0〜5ms に入らない試行の取り直しは含まない。予備測定で各母集団の T0 条件の成立率と初期化・後処理の時間を取り、正式測定の所要を `初期化＋試行×必要試行数＋後処理` で積む。N/P/C の再生時刻と `periodMs` は機械の速さに合わせて変えない。

予備測定では速さに加えて証拠が成立することを確かめる（正式の長い実走の後に証拠不足が判明する測り直しを防ぐ）: ① 入力と時刻（投入 ID と callback の対応、未到達の扱い、処理開始の観測点、T0 条件、時計区間）② 表示と判定（実 paint、欠落判定、集計入力）③ 保存と長時間（C1 後の verify 段の扱い、E15 の write の帰属、AC15 の切断時刻・`state/`・`/snapshot`、C2 の生存監視と replay の整合）。NO-GO のときは、raw に証拠がそろっていれば再集計、証拠の取得漏れなら該当窓の取り直し、製品か測定条件を直したら新しい版として影響する条件を再検収する（runner の `--windows` は Blocked／未実施だけを再実行する現行規則を保つ）。

### 4.4 spec 改訂

spec は 3005 行で、行番号と行内容の hash（«…»）で引用されている。契約 JSON に 264 件、`sequences.json` に 2,558 件あり、`check-contract.mjs:64`〜`:68` と `check-sequences.mjs:96`〜`:101` が行の中身を照合する。改訂は行数を変えない置換で行う。引用されている行を書き換えたら、引用側の anchor を同じ commit で更新し、両 checker を通す。

| 箇所 | 改訂の内容 | 被引用 | 時期 |
|---|---|---|---|
| spec:315（§3.1） | 「状態更新担当一つ」→「公開する担当は一つ、unit ごとに書き手は一つ」（R56） | 0 | C3a の凍結時 |
| spec:1024〜1029（§7.1） | 常駐 engine worker 一本の構成表を、D-P3-1 の配置へ | 0 | 同上 |
| spec:1049（§7.2「worker への通常 data in-flight 1 件」） | 実行場所ごとに 1 件へ（D-P3-1） | 0 | 同上 |
| spec:1157、:1164（§7.6） | 「状態担当 worker は一つのまま」と「XML worker 追加を解決としない」を、R57 の分離と矛盾しない文へ | :1157 は 0、:1164 は 1 | 同上 |
| spec:2613（P2 行）、:2930（N7） | P2 は「P2 限定 E01」で閉じ、N7 は P3 で閉じたことを書く（台帳 56 の同期要求） | 各 1 | C4 の完了時 |
| spec:390（M01）、:499（§4.3 の eew 行） | VXSE44 を外す（R27） | :390 は 1、:499 は 0 | C0 の凍結時 |
| spec:400・:401、:523・:524（M11/M12） | VPTW60-65・VPTA50-55 の範囲表記（R53） | 0 | C14 の凍結時 |
| spec:2308（§11.2） | 既存の 1 文を置換し「検収用 replay の公開口は互換必須（新設、R10）」を入れる。表に行を足すと以後の全行がずれるため | 0 | C17 の凍結時 |
| spec:835（§5.7「別 manifest は作らない」） | D-P3-2 の再裁定で官署ごとの保存を選んだときだけ | 3 | その再裁定後 |
| spec:1131、:2614（津波の容量縮退、P3 行） | 津波の容量縮退の測定を P4 へ送る旨（D-P3-6） | 110、1 | C5 の凍結時 |

spec:167 と §15.4 の改訂（R52）は P4 前に行う（§5.2）。

### 4.5 Pi 予備確認（D-P3-7）

台帳 63 の単発測定で、同じ製品経路の最大 VPWS50 の processing（T2→dispatch 完了、公開用の直列化を含む）は Mac 384ms・Pi 2,400ms（中央値）だった。spec は Pi の資源測定・72 時間並走・最終構成の E01 を P5 に置く（spec:2148〜2150・:2616）が、実行分離と保存方式が Pi で成り立たないと P5 で初めて分かると、設計の手戻りと連続試験の再実施が重なる。そこで、設計を変えうる問いだけを C4 の正式測定前に Pi へ持っていく。所有は C4 で、C3a と別の測定器を作らない（C3a の契約には Pi で確かめる性質を書くだけ）。

- **第 1 段（Pi 単独、backend）**: 投入側と新築 host を Pi 上の別プロセスで動かし、localhost の WS で流す。C3a の配送後と C3b の配送後（C4 の予備測定）に行う。条件は、大型 VPWS50 処理中・U-W encode 中・U-F 保存中の EEW、それに「U-W の大型処理＋U-F の処理と保存＋旧築稼働中に EEW」の重ね合わせ。単体の比較（処理完了を待って次を送る）に加え、N/P/C から選んだ窓を処理完了と独立した予定時刻で流す（遅れた投入は予定→実送信、受信後の滞留は T0→T2 として分ける）。
- **第 2 段（Pi backend＋Mac Chrome）**: 実 paint まで確かめる。Pi と Mac の時計は spec:1141〜1143 の往復対応で結び、別機械の `performance.now()`・hrtime を直接引き算しない。通信経路（LAN・Tailscale・SSH トンネル）を manifest に書き、本番と違う経路の値を本番の E01 にしない。
- **記録**: 区間は「投入側の実送信→T0」「T0→T2」「T2→採用・射影完了」「採用・射影完了→publisher の公開完了」「T0→T6」「実送信→T6」を分ける（E01 の定義は変えない）。E14 は書込み権の待ち・権を受けた worker が着手するまでの待ち・capture/encode/hash・write/sync/rename・ack の反映に分ける（spec:864 の reservedAt／capturedAt／writeStartedAt／ackAt に対応させる）。同じ窓で Pi の `/proc/pressure/{cpu,memory,io}`、`vcgencmd measure_clock arm`・`measure_temp`・`get_throttled` を取る。RSS はプロセス全体の値で、`heapUsed`・`external` は呼んだ thread の値なので、worker 化の後は worker ごとに分けて取り、RSS を足し合わせない。通知は silent（spawn 先を `/usr/bin/true` に替える）で、実通知の検収ではないことを結果に書く。
- **標本と判定**: 競合条件ごとに warm-up を別に取り、30 件程度×3 回から始める。標本が 100 件未満では nearest-rank の p99 は最大値なので、値は「観測最大」と書く。見るのは、EEW が大型処理に追従して止まる、publisher が worker の完了を待つ、書込み権が戻らず他の単位が保存できない、RSS が上限を明らかに超える、queue が一方向に増える、の 5 つ。異常が出なければ「この予備条件では再現せず」と書き、E01・E14 などの Pass とは呼ばない。
- **旧築の保護**: 新築は旧築と別の directory・state・port・記録先で動かし、新しい dmdata 購読は使わない（localhost の replay だけ）。資源が悪化したら新築側を止め、旧築を止めて測定を成立させない（spec:2125〜2138・:2230〜2234）。
- **異常が出たとき（D-P3-9）**: 原因を分類して作者へ報告し、作者が判断する。C5 以降の着手禁止条件にはしない。対処の順は、C1 後の実時間を測る → 占有時間を分解する（全体 writer が空いた後の不要な待ちがあれば先に除く）→ encode 量・I/O を減らす（spec:872〜876）→ worker ごとの同時書込み・官署ごとの保存・期限の変更を裁定する。旧構成の 148ms・67ms（EEW の待ち）に倍率を掛けた予測で、先に保存方式を変えない。
- **E03**: worker 分離は重い処理から他の仕事を守る対策で、重い処理そのものは速くしない。C3a 後も Pi の E03 が 1 秒を大きく超えるなら、不要な全量処理・コピー・直列化を先に削る。それでも満たせないときに Pi に対する E03 の上限を変えるのは作者裁定（大型通常入力の処理完了の保証と、同じ unit の後続処理への影響を失う）。
- **判定場所**: 性能条件ごとに「本番性能として判定する場所」と「開発機で判定してよい範囲」を C4 と P5 の manifest に書く。目安: E01 は Pi backend＋実接続経路＋Mac Chrome、E02・E03・E05〜E07・E14・E15・E20 は Pi（開発機は回帰検出用）、E16〜E19 は Pi 必須、E04・E25・E26 は表示端末の Mac Chrome、E08〜E11 の構造・回数の不変条件は Mac・CI でよい。

## 5. 作者裁定（2026-10-01 に全部 A で決定）

| ID | 決定（A） | 退けた案 | 計画への反映 |
|---|---|---|---|
| S5 | 約束は「保存の途中で止まっても前回の保存は壊れない」まで。検証はプロセス停止試験と fsync→rename→ディレクトリ sync の手順の確認（`checkpoint.ts:308`・`:329`） | 使い捨て媒体での実電源断。Pi の停電耐性は P5 へ（spec:850、p2plan:195） | C1 の故障注入の範囲 |
| D-P3-1 | worker 3 本（U-E 系／U-W／急がない unit）。publisher は接続・振り分け・mailbox・snapshot・SSE・通知 adapter だけ。根拠は R56・R57 と `e01:410`、A10 参考測定の待ち（VPWS50 decode 388ms、U-W encode 148ms、U-F 保存 67ms） | 重さで 2 本（R56 の例外）、unit ごとに 1 本 | C3a。RSS は未確認で C4 の予備測定で取る。以後の unit は急ぐ／急がないを同居させない |
| D-P3-2 | C1・C3a の後に同じ P・C の窓で測り、なお E02-P・E05-P が Fail なら官署ごとの保存を Pi の保存回数・書込量と一緒に再裁定 | いま官署ごとの保存へ移る、暫定上限の見直し | C4。spec:835・:2099 を守る |
| D-P3-3 | 検証の間だけ開発機から別 appName で 1 本足す（Q9 の 4 本・spec:2113 の範囲）。R57 の「なるべく 1 本」は製品の常用構成への意向と読んだ | 検証中に Pi の旧築を止める | C2 の実接続の検収。費用の有無と実施時刻は作者が確認・決定（§8） |
| D-P3-4 | P3 専用の固定・hash 付き最小海岸線資材。P4 の GIS 合格とは呼ばない | P4 の正規津波 GIS（N18、spec:2941）を先に作る | C6 |
| D-P3-5 | U-Q → U-N → U-V → U-L → U-R → U-B → U-M → U-Y（急ぐ unit から、S4） | 表示価値・バックログからの別順 | unit レーンの開始順 |
| D-P3-6 | 津波の容量縮退系列（spec:1131）は期待値を C5・C6 で固定し、測定は P4。現行 spec（spec:1131・:2614）から P3 の受入範囲を変える移管で、spec 改訂（§4.4）と未検収範囲・P4 の容量契約を引受先とする記録を伴う。代償は、縮退中の津波 E01 が P4 まで未検収で残ること | 現行 spec どおり P3 の C6 で測る | C5・C6・§5.2 |
| D-P3-7 | Pi 予備確認を P3 に入れる。C3a・C3b の後、C4 の正式測定の前。所有は C4、二段（Pi 単独 → Pi backend＋Mac Chrome）。C6・C22 にも短い確認。正式 Pass にしない | P5 まで Pi で確かめない | §4.5、C4・C6・C22 の行。根拠は台帳 63（2026-10-01 夜の追加裁定） |
| D-P3-8 | Pi の E14（3 秒保存）の超過も D-P3-2 の再裁定の契機に加える | Mac の E02-P・E05-P だけを契機にする | D-P3-2 の再裁定条件。保証を緩めず、検討の条件を足す変更（同上） |
| D-P3-9 | Pi 予備確認で重大な超過が出ても C5 以降の着手禁止条件にしない。原因を分類して作者へ報告し、作者が判断する | 超過が出たら C5 以降を止める | §4.5（同上） |
| D-P3-10 | Codex 総合レビューの必須の節目を固定する: C0、C1＋C2、C3a＋C3b、C4 の測定準備一式（正式測定の前）、C4 の結果、C5＋C6、C15、C16、C22。ほかの契約（C7〜C14・C17〜C20）は Claude のゲートで配送を進め、数本ずつまとめて Codex に渡す。節目以外では後続の着手が Codex を待たない。Codex には凍結契約・差分・機械検証の結果・raw に基づく証拠を渡し、Claude の自己評価は添えない | 契約ごとに Codex を待つ | 実装体制（冒頭）。枠の回復待ちを依存経路から外す。独立したモデルによる発見は、まとめて渡す契約の分だけ遅れる（同上） |
| D-P3-11 | 契約適合レビューとコード品質レビューを、同じ固定 patch（SHA か patch hash）に並行で当てる。契約適合は AC と証拠、品質は状態遷移・故障・非同期・計算量を見る。統合担当が指摘を統合し、一括で直して必要な部分だけ再確認する。レビュー中は実装を動かさない | 直列（契約適合 → 修正 → 品質） | 実装体制（冒頭）、`CLAUDE.md` のレビュー方針。指摘の重複・衝突は統合担当が整理する（同上） |
| D-P3-12 | C5 の配送後に 4 本目の実装レーンを 1 本だけ試す。載せるのは共有部分の変更が少なく境界が凍結済みの仕事。続けるかは合流待ち・手戻り・レビュー枠・作者確認の積み上がりで統合担当が判断し、作者へ報告する | 3 本のまま | §3.1。CPU 使用率は判断に使わない（同上） |

条件付きの作者裁定 3 つのうち 2 つは 2026-10-08 に決まった: PERF-P3 だけが残った場合の C5（§3.1）は C5 を先に進める（E05-P は台帳 66 の契約で再検収）、D-P3-2 の再裁定は設計 B（unit ごとの書込み権、`P3-UNIT-WRITE-RIGHT-001`）。まだ開いているのは C21 を P3 の外へ出すか（§1.3）。

### 5.1 統合担当の即断候補

作者の裁定を要しない技術的な細部。A で進め、B を選ぶときだけ作者に諮る。決めたら作者へ報告する。

- **実行単位の形**: A `worker_threads`（spec:1027 の常駐 worker の形。tree を送らない配置で転送費用を避け、RSS は同じプロセスに数える）。B 子プロセス（IPC が直列化し、起動・終了・監視の経路が増える）。
- **checkpoint の書込み権**: 2026-10-08 に D-P3-2=B（作者裁定）で unit ごとの in-flight 1 件へ改めた（`P3-UNIT-WRITE-RIGHT-001`、spec:859・:872・:1053 を置換）。以下は C3a の時点の即断の記録: A 全体の in-flight 1 件（spec:859）を保ち、publisher が書込み権を 1 つずつ渡す。encode と書込みは unit の持ち主の worker が行う。§5.8 の公平性（E14・IR01）を変えない。B worker ごとに in-flight 1 件（spec:859 の改訂が要る）。A のまま、Pi で権の待ち・worker の着手待ち・encode・I/O・ack を分けて E14 を確かめる（§4.5）。全体 1 件では、同時に dirty になった単位の保存は占有時間の和だけかかる（各保存の p99 の和を全体の p99 とは呼ばない）ので、C4 は U-E/U-W/U-F、C6 は U-T を加えて、C22 は全 unit で同時 dirty を確かめる。
- C1 を C3a の前に置く（読み直しを除いた単純な checkpoint を worker へ移す方が移す量が少ない）。
- 大きい frame の envelope JSON.parse を publisher に残すかは、C4 の予備測定の `ingressJsonMs` で決める。spec:1072 は「大きい data frame は raw bytes のまま worker へ渡せる境界にし、全文の JSON parse は一回」とする。
- 移行器は全 `I-U-*` の persisted 型の凍結後に 1 本（§10.4 は単位ごとの成功・未充足を出すので、途中の単位だけ先に移す利益が小さい）。

### 5.2 P4 に送るもの

S6（Q6 の残り、最終表示端末）と Q5（Q5-a・Q5-b）は P4 着手前の裁定で、P3 では扱わない。ほかに次を送る。

- R46〜R49・R52（表示語彙・点地物・Pi Chrome の長期検収）と spec:167・§15.4 の改訂（R52）
- R50・R51 の描画部品（台風の予報円・暴風域、水位ミニグラフ）。意味要件（台風の数値緯度経度、水位の観測・予測 series と基準水位）は P3 の C14・C11 で閉じる
- R58 と design-system の「ほかN」6 か所の同期
- IR04・IR07・IR09〜IR13（独立レビュー `2026-09-11-FlEq-P0-v3.1-independent-review.md:205`、作業ノート）。IR07 の詳細要求は worker と main の境界を通るので、P4 の契約で C3a の境界型を改訂する（U-F の分は `P3-UF-PUBLIC-001` で P3 へ前倒しした。2026-10-15）
- O11（spec:1787）、O09 の EEW の容量縮退（spec:1129）と personal の step、津波の容量縮退の測定（D-P3-6）、津波の burst・詳細射影中の E01（O09:30・31・39・40・48・49・57・58・66・67。詳細射影の実体が P4 にあるため。P3-C6-O09-REST=A、作者裁定 2026-10-09。P3 の完了報告に未検収と書く。U-F の詳細射影は `P3-UF-PUBLIC-001` で P3 に入ったが、その E01 は同契約の残存リスク (9) で C4・E01 の窓の範囲）
- §11.4 のブラウザ側の互換必須行（津波 chip 再放送・browser dim・reduced-motion）
- 台帳 50・53・54

## 6. P2 から引き継ぐ未決・移管の対応表

| 事項 | 出所 | 落とし先 | 再検収条件 |
|---|---|---|---|
| Mac と Pi の速度差（台帳 63） | 2026-10-01 の単発測定: 最大 VPWS50 の processing が Mac 384ms・Pi 2,400ms（中央値、約 6.3 倍）。単一スレッドのままなら Pi では大型処理中の EEW が T0 より前で 2.4〜2.5 秒規模待ちうる | C4 の Pi 予備確認（D-P3-7）、C6・C22 の短い確認 | 正式 Pass にしない。設計を変えうる問題（EEW の追従停止・publisher の待ち・書込み権が戻らない・RSS の明白な超過・queue の一方向増加）が無いことの確認 |
| E01 の 4 条件（最大 VPWS50 の full parse 開始・最大 U-W encode 中・最大 U-F 保存中・U-F 期限重なり） | `e01:66`（R61）、`e01:479`、`e01:562`（AC16）、`e01:726` | C4 | §1.2 の EEW 行。P2 の参考と同じ版付き負荷、full parse 開始の観測、投入側の独立記録と callback 未到達の照合。**C4 で再検収済み**（2026-10-08、P3 E01 Pass、`p3-e01-reaccept.json` の P3-C4-CLOSE-VERDICTS） |
| N7・IR06 の A/B 判断 | spec:2930、p2plan:129 | C3a（構成として閉じる）、C4（証拠の記録） | §7.6（spec:1149〜1168）の原因帰属を衝突試験で確かめる |
| E02-P・E05-P の Fail、E06 の超過（台帳 61） | `e01:93` | C4（測り方）、D-P3-2（直し方） | `e01:93` のとおり。E06 は数時間の窓と `--expose-gc` 後の RSS でも分類（台帳 61 追記）。**C4 の結果**（2026-10-08）: E02-P Pass、E06 は 3 式の範囲内（超過なし）、E05-P は Fail のまま台帳 66 の契約で再検収（作者裁定、P3-C4-CLOSE-E05P）。D-P3-2 は設計 B（`P3-UNIT-WRITE-RIGHT-001`） |
| E15 の残り（write の別計数、保存前段の同期区間、verify の読んだ bytes） | `e01:102` | C4（計測点・注入口・測定） | `e01:102` のとおり。**C4 で記録**（2026-10-08）: 帰属不能 0、verify 段 0 回で未観測、byte/日は未確認（P3-C4-CLOSE-E15） |
| AC15 の再集計 | `evidence/windows/a10-p2-20260930b/closure.md:8`（切断の hrtime と充填時点の `state/`・`/snapshot` が無い） | C4 | 生データだけから AC15 を再集計できる。**C4 で再検収済み**（2026-10-08、AC15 Pass） |
| 本物の dmdata 接続 | `e01:84`（R63）、`e01:562` の (5)、p2plan:129 | C2 | 所有者、接続 1 本（R57）、既存接続の保護（旧築 `src/dmdata/rest-client.ts:585`・`:627` の同 appName 残留 socket の扱いを持ち込まない、spec:2121）、実接続検証、共通受入口への結線、T0 以前に decode・normalize をしない |
| WS の生存監視・start frame の記録（台帳 58） | `host.ts:180`〜`:181`（start を捨てる）、旧築 `src/dmdata/ws-client.ts:53`・`:577`〜`:591`（90 秒の heartbeat 期限） | C2 | 半開きの TCP を期限内に切る試験、start の socketId 等の記録 |
| 再接続後も reconnecting のまま（台帳 59） | `composition-root.ts:329`〜`:335`・`:401`、`p2-shared-runtime.types.ts:267`（入力は `connectionLost` だけ） | C2 | 接続回復（open と start 受理）で data を待たずに connected へ戻る。確認状態は戻らない |
| worker 状態の写像（台帳 57） | A10 で実装済み: 写像は `host.ts:239`〜`:245` と `composition-root.ts:390`〜`:395`、受信時刻は `:397`〜`:398`、試験 `reconstruction/test/host/host.test.ts:260`〜`:274`（commit `dfa8bdd0`）。台帳の状態欄は「未修正」のまま | 閉じた部分は再移管しない。止まっている最中の独立監視（R60 で P2 保証外）は C3b | spec:1190〜1191 の stalled／unresponsive を、止めた worker で検出 |
| O04:2・O06:29-30・Q-MIGRATION | p2plan:26〜27・:215・:243、`p2-checkpoint-shutdown.json:717`〜`:721`、`p2-weather-current-unit.json:12`・`:426`・`:677` | C15 | §1.2 の移行行 |
| O02:18-48（P2 外 step） | `p2-weather-timeseries-unit.json:12` | fixture の headType で振り分け: VXSE52/53→C7、VFVO52→C9、VXKO50→C11、VPBS50→C12、VPFT50→C13、VPTA50→C14。unmet 19 step は各契約が入力を充足してから | 版付き subset で各 unit が閉じる |
| `origin=recovery` の適用 | `p2-eew-unit.json:189` | C16 | §10.5 の受入（spec:2224） |
| IR03 の津波緊急 | p2plan:309、`p2-notification-delivery.json:70`・`:430`・`:438` | C5 | E21 の津波緊急（spec:2073） |
| IR05・IR02（津波） | 独立レビュー :204 | C5（運用区分）、C6（E01） | §1.2 の津波行 |
| R10 の 2 点 | 進捗ノート §3（2026-09-19）、spec:650・:2308 | C17（replay）、C19（CLI 表示設計） | §2.1 の各行 |
| 台帳 49（上流 view の semanticRevision が O(N)） | `e01:553`（「P3 の受信経路契約前」に再検討） | C3a | view の版を固定長にするかを C3a の凍結時に決める。受信 1 回の直列化回数を報告 |
| 台帳 48（終端 intent の件数上限） | 台帳 48 | C20 の前 | 気象通知を生成する前に持ち方を決める |

台帳のうち上の表に無いもの: 38（tree 転送の費用）→ C3a の固定内容。41・47・60 → C7〜C14 の共通条文。46・55・56 → C1・C3a・C4。51（起動入口）→ A10（S1）で host を持ち、worker の生成だけ C3a に残る。52 → C0。62（解消済み）→ 同型の点検を C3a のレビュー項目に入れる。42・43 は旧築の U-W 防御の話で、新築の U-W に解除率防御を持ち込む契約ができたときに現象単位で設計する（P3 の最初の契約群には入れない）。44・45 は P2 で解消。50・53・54 は P4。

## 7. 見積もり

P2 の実績（git log と作業ノートのハンドオフ）: 計画の起草が 9/16、A10 の移管付き完了が 10/01 で、約 16 日。A1〜A9 の実装 commit は 9/19・9/20・9/23・9/24・9/29 の 5 日に収まった（A1 9/19 22:50、A5 9/20 19:30、A7 9/23 19:55、A8 9/24 16:17、A9 9/29 08:43 など）。残りの日数を使ったのは、Wave 0 の起草（9/16〜9/19）、発注前点検と点検待ち（9/23〜9/28。ヘルツの枠の回復待ちを含む）、A10 の測定（9/29〜10/01、本番 2 回）だった。レビュー巡数は 9/25 以降の体制の実績（A10: 包みごとに契約適合 2〜3 巡・品質 1〜2 巡、ヘルツの総合レビューは NO-GO 2 回の後 GO）を全契約の目安にする。

| 契約 | 起草と発注前点検（晩） | 実装（晩） | 測定・修正（晩） | 根拠 |
|---|---:|---:|---:|---|
| C0 | 0.5〜1 | 2〜3 | 0.5 | A1（共有型の改訂）。直書き 41 か所（§4.1）に加え、`reduceRuntime` の第 3 引数を必須にするので既存試験の呼出し約 53 か所・stub 約 65 個を機械的に移す |
| C1 | 0.5 | 1 | 0.5 | A3 の保存部分。故障注入の土台は A3 にある |
| C2 | 0.5〜1 | 1〜2 | 0.5〜1 | A10 WP1（host）。実接続は作者の時刻に合わせる |
| C3a | 1〜2 | 2〜4 | 1〜2 | A3＋A10 の host 結線に mailbox の改訂を足した規模 |
| C3b | 0.5〜1 | 1 | 1 | A3 の終了処理 |
| C4 | 1〜2 | 1〜2 | 2〜4 | A10（正式 5 母集団×1,000×3、PERF、E06 の長い窓、Pi の保存計測） |
| C5 | 1〜2 | 2〜3 | 1〜2 | A5（O05 の unmet 12、Q-NOTICE 津波分、VTSE41 の優先度） |
| C6 | 1 | 2〜3 | 2〜3 | A9＋A10。津波は 2 系列×4 母集団 |
| C7〜C14（8 本） | 各 0.5〜1.5 | 各 1〜3 | 各 0.5〜2 | A4・A6（小）〜A5（大） |
| C15・C16 | 各 1〜2 | 各 2〜3 | 各 1〜2 | 前例なし。未確認 |
| C17 | 0.5 | 0.5〜1 | 0.5 | runner の公開口だけ |
| C18 | 1〜1.5 | 2〜4 | 0.5〜1 | CLI 引数と REPL 19 入口・設定移行。前例なし |
| C19・C20 | 各 0.5〜1 | 各 1〜2 | 各 0.5 | A8 程度 |
| C22 | 0.5〜1 | — | 1〜2 | 統合担当の全体検証。見つかった欠陥の修正は別枠 |
| **合計（C21 を除く）** | **15〜31.5** | **28.5〜58** | **17.5〜38.5** | **61〜128 晩** |
| うち最初の契約群（C0〜C4） | 4〜7.5 | 8〜13 | 5.5〜9 | 17.5〜29.5 晩 |

総期間は依存経路で数える。表の合計 61〜128 晩は作業量で、経路の長さではない。起草は先行させる（§3.1）ので、経路に乗る起草は Wave 0（C0〜C2 の 1.5〜2.5 晩）と C3a（1〜2 晩）だけとし、ほかは実装・測定だけを数える。

- 直列区間（Wave 0〜C5）: Wave 0 起草 1.5〜2.5 ＋ C0 2.5〜3.5 ＋ C1 ∥ C2 の長い方（C2）1.5〜3 ＋ C3a 4〜8 ＋ C3b 2 ＋ C4 3〜6 ＋ C5 3〜5 ＝ **17.5〜30 晩**。脇レーンの C17・C18 の前半・C19・C20 は、この区間に空いている 2 レーンで進める（経路外）。
- レーン区間: 3 本の配置例で数える（上限側、各 unit 5・C6 の実装 3・正式測定 3・C15/C16 の本体 3 と完了の検収 2・C18 の後半 2.5 晩。D-P3-5 の順）。

```text
晩     0     3     6       11  13    16   18   21   23  25.5
L1  [C6 実装][測定*][C9 V   ][C12 B    ][C15 本体][C15 完了]
L2  [C7 Q  ][測定*][C7][C10 L    ][C13 M   ][C16 本体][C16 完了][C18 後半]
L3  [C8 N  ][測定*][C8][C11 R    ][C14 Y   ]
*C6 の正式測定の窓は Mac mini の build・test だけを止め、実装レーンは MacBook で続ける（§3.1、修正 5、2026-10-06 に測定機を Mac mini へ改訂）。上の晩数は修正前の全停止のまま
```

  終わりは 25.5 晩で、統合担当の直列合流（unit 8 回×0.25 晩＝2）を足して **27.5 晩**。下限側（各 unit 1.5・C6 の実装 2・測定 2・C15/C16 の本体 2 と完了 1・C18 の後半 1.5）を同じ並べ方にすると 11.5 晩、合流を足して **13.5 晩**。作業量を 3 で割った 7〜18.5 晩は、契約を分割できない以上届かない参考の下限。

経路の合計は 17.5〜30＋13.5〜27.5＋1〜2＝**32〜59.5 晩**、最初の契約群（Wave 0〜C4）は 14.5〜25 晩。P2 の実績比 1 つ（計画合計の中央 56 晩に対して実際 16 日、16/56≒0.29 日/晩。p2plan:262〜289）を掛けると、P3 全体は **約 9〜17 日**、最初の契約群は **約 4〜7 日**。

並走の費用（日数に含めない。合流の 2 晩だけは上に含めた）:

- Opus のゲート実行が同時に最大 3 契約ぶん走るので、トークンの使用量が増える。節目ごとに使用量を確かめ、上限に近ければレーンを減らす。
- 統合担当の直列合流が律速になる。合流の待ちが 1 晩を超えたらレーンを減らす。
- 作者が同時に読む報告・裁定の材料が、最大 3 契約ぶんに増える。

別枠（上の日数に含めない）:

- C21（personal）: 材料が無く未見積もり。
- 条件付きの作者裁定の待ち（§5 末尾）。P2 の比には点検待ち（9/24〜9/28 のヘルツ枠待ち）が入っているが、それを超える待ちは別枠。
- 測定の失敗: A10 は本番 1 回目の NO-GO から修正・測り直しまで約 1 日かかった（9/30〜10/01）。C4・C6 は 1 回ごとに 1〜2 日を足す。D-P3-2 の再裁定で官署ごとの保存へ移る場合は、C1 以上の規模の契約が 1 本増える（未見積もり）。

修正 5 の注記: この比は P2 の計画合計（総作業量に近い）を分母にして、P3 の依存経路（並走を反映した長さ）に掛けているので、校正の対象がそろっていない。比には実装速度・作者の空き・Codex の枠待ち・起草・レビュー往復・実時間の測定が混ざり、P3 は測定の比率が高い。C0〜C2 の配送の後、残りを「依存する実作業」「正式測定（母集団ごとの実時間、§4.3）」「可用性待ち（Codex・作者・材料）」「再作業・未見積もり（C4/C6 の測り直し、D-P3-2、C21）」の 4 つに分けて見積もり直す。そのため、作業記録に `着手可能 → 実作業開始 → patch 完成 → レビュー完了 → 合流完了 → 必須検証完了` の時刻と、待ちの理由（quota／author／materials／review／integration／measurement）を残す。Pi 予備確認（§4.5）の準備と試運転は 0.5〜1.5 晩の作業で、第 1 段は Pi の中で走るので依存経路への上乗せはそれより小さい（推定）。

根拠は弱い。比は P2 の 1 回の実績だけから取り、P2 の比には起草の日数も入っているので、起草を経路から外した P3 に掛けると短めに出る。3 レーンが実際に詰まらず回るかも未確認。比較元の P2 計画は A10 の host 結線を見積もっておらず（p2plan:277）、正式 E01 も 1 条件だけだった（p2plan:285）。P3 の C4（正式 5 母集団）と C6（津波 2 系列×4 母集団）は P2 より測定負荷が重いので、上の日数は下振れより上振れしやすい。超過したら残件と再見積もりを報告し、未測定を配送完了に含めない。

## 8. 契約ごとの着手ゲート

一括の着手禁止は置かない。§1.1 の凍結ゲート、§3.1 の依存、§2.1 の「先に要るもの」は全契約に共通の必須条件で、下の表はそれに加える条件だけを書く。実装後にしか得られない測定（worker の RSS、`ingressJsonMs`、Pi の unit ごとの保存回数・書込量）は着手条件にせず、C4 の予備測定・正式測定と完了条件に置く。

| 契約・工程 | 追加の条件 |
|---|---|
| C2 の実接続の検収 | 作者が用意する API キー・appName・接続数の確認、1 本足すと費用が生じるかの確認、実施時刻 |
| C4 の正式測定 | 予備測定の後に §4.3 の manifest を凍結する（着手条件ではない） |
| C5 | 津波の fixture（VTSE41 8・VTSE51 4・VTSE52 3。O05 の unmet 12 は synthetic 待ち） |
| C6 | 最小海岸線資材（D-P3-4） |
| C15 | 旧 v2 の読み取り専用コピーと補助保存物（N8） |
| Pi 予備確認（§4.5） | Pi の作業複製（公開 fixture だけ。資材の前例は台帳 63 の `~/p3-bench`）、旧築と別の state・port、第 2 段は Pi と Mac の時計対応と通信経路の記録 |

coverage 下書きの「未確認」12 項目のうち、項目 9（priorityReason の付与箇所）は `host.ts:201` で EEW の分だけ解消した。VTSE41 は normal のままで、C5 で扱う。項目 2 は C14 で扱う。残りは移植時に確かめる。

## 9. 計画の後で足した契約（2026-10-08）

§2 の表の行番号を他の契約が anchor で引いているので、表には挿さずここに足す。

| 契約 | 対象 | 依存 | 状態 |
|---|---|---|---|
| C3B-CLOSE（`P3-EXECUTION-LIFECYCLE-001` の改訂） | 台帳 65: 終了要約の 2 回目の保存が期限切れのとき、stop() を例外で終わらせず reason `workerClose:summaryNotPersisted`・code 4 で返す | C3b | 配送 `eb62d423` |
| `P3-UNIT-WRITE-RIGHT-001` | D-P3-2=B（作者裁定 2026-10-08）: checkpoint の書込み権を unit ごとの in-flight 1 件にし、返信の反映の後にすぐ再評価する。非緊急の owner の留保は自分の保存中だけ（台帳 64・68） | C3a・C3b・C4 の閉鎖 | 配送 `54a63c25` |
| `P3-WEATHER-LIGHT-001`（段 1） | E03・台帳 66 の前段: 気象の処理の重複を削る（jPath、xmlValue、値の使い回し、history と encode の計量） | UWR | 配送 `0bf810b1`。Pi の段ごとの内訳（Q-WL1-PI-STAGES）は未測定 |
| `P3-WEATHER-LIGHT-002`（段 2） | 台帳 66・E05-P: 自前の速い組立てで XmlNode を 1 本、変な形は旧の FXP の経路へ戻す（全入力で旧と同じ）。D-WL2-DEP=B・同値の基準（作者裁定 2026-10-09） | 段 1 | 起草 `e5a86bae`、発注前点検 2026-10-09 |
| 段 3（未起草） | 台帳 70: 保存の書込量（圧縮・地域本文の重複除去） | 段 1 | 段 2 の後 |
| `P3-OWNER-LEDGER-BOUND-001`（台帳 67） | owner の未保存の世代ごとの入力 ID の記録（OwnerHost.ledger）を unit ごとに 4,096 世代までにする。LEDGER67=A（作者裁定 2026-10-08）、OVERFLOW=A（2026-10-09）。上限の外では P2-A3-AC10 の和集合の固定・P3-UWR-AC05 と T01・UWR の残存リスク (3)・E15 の相関を本契約の AC05 が上書きする（他の契約の条文は編集しない） | UWR。C7 と試験 2 本が重なり、本契約が先 | 起草 `d41394a9`、発注前点検 2026-10-09 |
| 写した読み取り関数の集約（未起草） | domains・units で写した XML の読み取り関数（localName・children・scalar・leafValues など）と unit の codec の基本形を 1 か所へ寄せる。共有の行（Record<RuntimeUnitId,…>・網羅 switch）は unit ごとの直書きのまま（P3-C7-SHARED-ROWS、C8 の Q-C8-BASE） | C14 の後・C22 の前 | 未着手 |
| 配送の更新の容量の横断 `P3-INTENT-UPDATE-RESERVE-001` | 台帳 73: 通知の配送の更新（intentUpdate）で pending の byte が増えても上限を確かめない。U-T・U-Q は保存できない状態を保存し復元で拒否（P1）、U-E・U-W・U-F は保存の失敗（P2）。C8 の直しの形を使い回す。AC05 の読み替え: 既存試験の期待値の変更 3 本（P2-A4-T11・P2-A4-T03・P3-WL1-T06 の境界を「実 byte＋予約」に置き直す）。U-E の世代の条件（P3-IUR-GENERATION）: 更新の束ね方を変える契約（伸びと終端を 1 つの intentUpdate に混ぜる）は、世代の計量に予約を足すか後段の退去から更新した記録を外す | C8 | 配送 `2a8f80bc` |

### 横断修正の発注順と裁定（2026-10-10）

作者裁定: D-ORDER=A、D-EVIDENCE=A（移行A1）、D-OUTCOME=A、D-OPERATION=A、D-CODEC=A、D-EEW=A（current/gateは有限期限。current＝版の起点＋10分、gate＝最後に採用した版の起点＋24時間、新規subjectの再確立horizon＝10分で確定。根拠は気象庁の公開の発表状況の警報83イベント（2023-02〜2026-08）。未来skewは起点をmin(報の時刻, 受信時刻)にして拒否しない（P3-LIFE-D-SKEW=A）。再起動後は非永続A1）、D-HORIZON=A、D-FORECAST=A。各Aの内容はK1〜K6で条文化する。K6の数値は確定済みで、発注は発注前点検のbaseOid割当による。

| 契約 | 対象 | 依存 | 状態 |
|---|---|---|---|
| K1 `P3-REVISION-ORDER-001` | F02、循環しない版比較（Q/N/V/L） | C11配送、K5後。K2より先 | 配送 `e4e8e3ab`（2026-10-10） |
| K2 `P3-AUTHORITY-EVIDENCE-001` | F03/F07/F09、復元をまたぐ受理証拠（N/V/W） | K1後。新保存形の上界はK5で再検証 | 配送 `e0d3f0f1`（2026-10-10） |
| K3 `P3-FINAL-ADOPTION-001` | F05/F06/F12/F16、期限・撤回を反映した最終採用（Q/N/V、Lの試験） | K2後、K4より先 | 配送 `b117d77a`（2026-10-10。D-OUTCOME=Aに加えD-VANISHED=A・D-L-OUTCOME=Cを裁定） |
| K4 `P3-OPERATION-CAPACITY-001` | F04/F10、操作別の退去適格性とnormal終了（T/V/L/R/W）。K3のP3-FINAL-AC01・T01〜T03を保ち、trainingの自己退去の結果の時制をD-OUTCOME=Aに揃え、U-Lの遅着の結果とpendingの撤回もD-VANISHED・D-WITHDRAWへ揃える（P3-FINAL-D-L-OUTCOME=C） | K3後、C11配送後 | 配送 `1d307989`（2026-10-10）。改訂 K4N `P3-OPERATION-CAPACITY-N-001`（節目の総合レビューのP1: U-Nの情報系列の退去にもD-OPERATION=A、`p3-operation-capacity-n.json`）は配送（2026-10-10） |
| K5 `P3-CODEC-CLOSURE-001` | F08/F15、保存byteと派生通知の文字境界（V/N） | C11配送後の先頭。K1〜K4と同時編集しない | 配送 `22e6b875`（2026-10-10） |
| K6 `P3-LIFETIME-AND-EEW-GATE-001` | F01/F11/F17＋F14裁定、寿命・再受理・同版訂正（E/F） | EEWの実データによる数値確定後。K5と並走可 | 配送 `7a4c70a8`（2026-10-10） |

### 横断不変条件 P3-X-C1〜C6

| ID | 共通規則 | unitごとの裁定・境界 |
|---|---|---|
| P3-X-C1 | identity・family・版・取消対応・将来の受理証拠を表示から分ける。比較可能な範囲で版順を循環させず、未解決の新報の証拠を後退させない | Serial欠落、同版競合、branch、D/N、保証範囲を各unitで定める。共通identity・総順序・表示全文の永続化は要求しない |
| P3-X-C2 | active・記憶・再受理・配送の寿命を分け、起点と期限境界を固定する。有効なactiveを保持GCで先に消さず、再送・復元だけで延命しない | 無期限active、受理時起点の例外、未来skew、忘却後の保証を各unitで定める |
| P3-X-C3 | 意味更新・期限・撤回・容量を反映した最終候補を採る。D射影が同値なら不要なdirtyを作らず、変化すれば保存対象にする | 独立deadline、日次履歴、rollbackを保ち、g+1や共通トランザクション層を強制しない。accepted/view/currentEstablishedの時制を受入例で固定する |
| P3-X-C4 | codecが受け入れるstateから、受信・期限・復元・配送更新・退去後も保存して再decodeできる。byte・envelope・配送予約を一致させる | schema・上界・移行を各unitで定める。hot pathの全state JSON化を避け、record単位計量と差分集計を使う |
| P3-X-C5 | 退去順位より前にoperationと作用別の適格性を決める。消えるnewcomerのための他subject退去、owner照合対象の自己GCを防ぐ | D-OPERATION=Aによりtraining/testはnormalの取消・版・所有証拠を退去しない。trainingの自己退去は可。normal同士の既存順位、承認済みの表示集約・切断は別に定める |
| P3-X-C6 | 通知の生成・撤回/維持・配送証拠を別々に定義する。新通知0でも必要な旧pendingを撤回し、派生文字列の文字境界を守る | 現在成立と過去の重要遷移を区別する。Tの上位pending維持、Rの復元後expiry例外を残し、acceptedの時制をC3と照合する |

C3/C6の境界例: 失効済報の受理後にactiveが残らなければactiveの`currentEstablished`を返さない。newer解除で旧activeが消え、新通知が0でも、旧pendingはそのunitの撤回規則で処理する。

### unitごとのパラメータ表

C12以降の新規unitと既配送unitの修正契約は、正本の条文IDを指して次の8行を埋める。数値を二重管理せず、境界受入例のIDも示す。

| 行 | 最低限埋める内容 |
|---|---|
| Identity / Revision | operation、subject、family/branch、取消key、比較tuple、Serial欠落・同版訂正・競合/比較不能 |
| Lifetime | active/記憶/配送の起点・式・境界、再受理horizon、容量忘却/再起動後の保証、未来skew |
| Persistence | D/Nと最小受理証拠、schema移行、期限の復元、dirty/世代の規則 |
| Adoption / Outcome | 最終正規化の順、reject時rollback、独立deadline、accepted/view/currentEstablishedの時制 |
| Capacity | 件数/byte/envelope/配送予約の正本、operation×作用の退去適格性と順位、自己退去、normal同士の超過 |
| Fidelity | identity非切断、表示集約/履歴深さ/短縮を許すfield、truncated、失う情報と下流の判断への影響 |
| Notification | 遷移ごとの生成・撤回・維持、channel/TTL、late/recovery/restore/expiry例外、配送更新の照合 |
| Acceptance | 各行を覆う既存/追加ACのID。順列・取消先着・復元・期限境界・容量を必要な組合せで指定 |

### C12の再開条件

C11配送後、K1〜K6の受入条件と対応するNodeゲートが成功し、P3-X-C1〜C6の例外と各unitのパラメータ・境界受入例を確定する。C12の2h/3h遅着、退去保護、置換時pendingの追加裁定を準備して発注前点検を再開する。横断修正後の保存量・処理量を反映したC12改訂を承認してから実装を発注する。C13以降も共通条文を満たしてから発注する。P3-C12-CAPACITY=Aの退去の候補(1)(2)と自身の退去の結果をK4のP3-OPCAP-AC01・AC02とK4NのAC01・AC02に揃え、operationによる退去の禁止と退去の後の保証外を別に確定する。

### 測定harnessの追随（2026-10-11）

| 契約 | 対象 | 依存 | 状態 |
|---|---|---|---|
| `P3-MEASURE-HARNESS-001` | 台帳76: K6・UWRの後にE01/C4の測定harnessが成り立たない（充填のEEWが受信の時点でhorizon外のstale、3つの保存母集団の引き金が1秒のtickを前提、E14のowner側の区間が無い、凍結の照合の集合と機械の値）。K6のP3-LIFE-D-HARNESS=Aの申し送りを引き受け、UWR AC08の別報告の未実装とtriggerLeadMsの読み替えを本契約に記録する。測り直しはE05-P・Q-UWR-REMEASUREのMac mini・PiのE03。P3-C6-AC09のPi予備とQ-UWR-REMEASUREのPi第1・2段は別機械のharnessが要り本契約の後も残る | K6・UWR・C6・WL2の配送 | 起草（e7440188から）。作者裁定P3-MH-FULL-STATE=D・残存リスク10件承認（2026-10-11朝）。発注前点検 2026-10-11（RETIME-SCOPE=A・SETUP-PATH=Aを統合担当が確定、Q-MH-PRECHECK）。baseOidは点検のcommitに割り当てる（Q-MH-BASE） |

### K6 の改訂（2026-10-11）

| 契約 | 対象 | 依存 | 状態 |
|---|---|---|---|
| K6R `P3-EEW-GATE-EVICT-001`（`p3-eew-gate-evict.json`） | K6 の残存リスク (2)（残存リスク一覧の型 C1）: U-E の family が normal で満杯のとき、報時刻＋10 分を過ぎ current と pending の無い normal の gate を最古順に退去して新しい normal の報を受ける（作者裁定 2026-10-11）。満杯の拒否は 10 分に 512 件を超えるときだけ残る | K6 | 起草（2026-10-11）。作者裁定 D-AGE=A・D-DIAG=A、残存リスク (1)〜(6) 承認（2026-10-11朝）。発注前点検 2026-10-11（1871540b、Q-EVICT-PRECHECK）。P3-MH-T01 の最後の句（充填の開始＋600,000ms の新しい通常の EventID が capacityExceeded）と本契約がぶつかるので、MH との順を決めてから baseOid を割り当てる（Q-EVICT-BASE） |

### E05-P の原因の分類（2026-10-11）

| 契約 | 対象 | 依存 | 状態 |
|---|---|---|---|
| `P3-E05P-CLASSIFY-001`（`p3-e05p-classify.json`） | Q-WL2-E05P の Fail（p3-mh-e05p-20261011、E05-P は 3 run とも上限 400MiB 超）の原因を、条件を先に決めた別の窓で分類する。probe の preload で 4 thread の memoryUsage を 200ms ごとに残し、GC の run では RSS が閾値を越えた直後に 4 thread で強制 GC（通常の GC と last-resort の 2 段）。判定表（GC 待ち・heap の予約・allocator/native・生きた値・混合）と次の手の候補、ふだんの Σheap の差（C4 より約 +55MiB）の確かめ方を先に固定する。窓の E02・E05 は報告だけで判定しない。P3-MEASURE-HARNESS-001 は閉じた契約なので、条文を後から足さない（作者裁定 2026-10-11） | MH・WL2 の配送 | 起草（2026-10-11、7d458fbf から）。作者裁定 5 件（P3-E05C-THRESHOLD・GC-CAP・RUN-SPLIT・HEAP-SNAPSHOT・PRELIM-BOUNDS）とも A、判定表の境界と残存リスク (1)〜(10) 承認（2026-10-11 夕、Q-E05C-AUTHOR）。発注前点検 2026-10-11（裁定前の書き方 3 か所、J0・run／窓の分類の不定の所と区切りの待ちの読み方を明記、Q-E05C-PRECHECK）。baseOid は点検の commit に割り当てる（Q-E05C-BASE）。窓の改訂（閾値の GC は区切りの 2 回目の後から、Q-E05C-GC-ARM＝A、3e0ba779）。正式の窓 2026-10-12（p3-e05c-20261012、4 窓とも N/A、a7f470e6）: 判定表では混合（GC の run1 が J1、run2 が主 J1＋従 J3）で、作者は実質 J1（GC 待ち）と読む（Q-E05C-RESULT＝A）。次は J1 の①（weatherCurrent の VPWS50 の確保を減らす、WL2 の後続）を起草する |
| `P3-XML-TREE-COMPACT-001`（`p3-xml-tree-compact.json`） | 分類の窓の結果（実質 J1＝GC 待ち、Q-E05C-RESULT）の次の手 J1 の①。decodeMaterial の XmlNode の木を値を変えずに小さく作る（配列を要素数ちょうどに、空の配列と空白だけの text の node を凍結して共有、名前を揃える）。最大 VPWS50 の生きた木 70.6MiB を約 38MiB へ（起草時の試し）。E05-P の測り直しは配送の後に統合担当（Q-XTC-E05P） | WL2・分類の窓 | 起草（2026-10-12、36ab3db6 から）。作者裁定 D-XTC-SCOPE＝A（木だけ）・D-XTC-SHARE＝A、残存リスク (1)〜(6) 承認（2026-10-12 午後）。baseOid は発注前点検の後（Q-XTC-BASE）。配送 1f6b1933（生きた木 70.6→34.9MiB）。E05-P の測り直し（p3-xtc-e05p-20261012）は 414.0・420.3・410.4MiB で Fail（前回 445.7・406.5・435.9）。山の形は J2（heap の予約）に変わった |
| `P3-OWNER-YOUNG-LIMIT-001`（`p3-owner-young-limit.json`） | 木の後の山は J2（weatherCurrent の heap の枠が 1 入力で約 +92MiB 広がる、Q-WYL-MATERIAL）。weatherCurrent の owner thread だけに Worker の resourceLimits.maxYoungGenerationSizeMb＝12 を付ける（手元で 1 入力の後の heapTotal −32〜42MiB）。host.ts の行の数は変えない。E05-P の測り直しは配送の後に統合担当（Q-WYL-E05P） | 木の契約 | 起草・発注前点検（2026-10-12 夕、1eb82ad9 から）。作者裁定 D-WYL-NEXT＝A（②から）、残存リスク (1)〜(6) 承認。配送 cc3d1aea。E05-P の測り直し（p3-wyl-e05p-20261012、e63dba43）で 370.7・389.3・388.9MiB、3 run とも Pass（Mac mini、判定場所の Pi は P5） |

### 台風の確率の報を上乗せした E05-P（2026-10-13）

| 契約 | 対象 | 依存 | 状態 |
|---|---|---|---|
| `P3-E05P-TYPHOON-001`（`p3-e05p-typhoon.json`） | C14（U-Y）の残存リスク (21)。今の E05-P の負荷 P には VPTA50（約 1.85MB）が 0 通で U-Y の寄与が出ないので、負荷 P の 1 周ごとに確率の報 3 通を上乗せした変種の窓 e05y-P を足し、E05（400MiB）を判定する。置く位置は実配信の窓で VPTA51 が届いた offset（P で 300,121ms、5.5 秒後に VPWS50）。確率の報 1 通ごとの deferred の待ちと処理も報告する（C14 の残存リスク (14)） | C14 の配送 | 起草（2026-10-13 夜、f130ed39 から）。独立レビュー（契約適合 条件付き GO、品質 NO-GO→NO-GO→GO、Q-E05Y-REVIEW1・REVIEW2）。作者裁定 P3-E05Y-FREQ・PLACE・CONTROL とも A（1 周に 3 通、実配信の VPTA51 の位置、同じ checkout で素の E05-P 3 run を交互に）、残存リスク (1)〜(10) 一括承認（2026-10-13 夜、Q-E05Y-AUTHOR）。発注前点検 2026-10-13 夜（裁定前の書き方 15 か所を A の形に、windows.mjs の他の契約が引く行を動かさない行の約束を AC06 に、Q-E05Y-PRECHECK）。baseOid は点検の commit c43e9033 に割り当て済み（Q-E05Y-BASE）。実装は配送 841b748e（CI success）、manifest は 0179eb5d で凍結（p3-e05y-20261013）、正式の記録は 06df4c22。**正式の測定（Mac mini、2026-10-13 21:36〜23:23、e02-P と e05y-P を交互に 3 run ずつ）の判定は、上乗せの窓 Fail（Pass・Fail・Pass、最大 RSS 392.9・407.5・387.7MiB、run2 は周 0 の 306.2s で 7.5MiB 超過）、対照の素の E05-P は 3 run Pass（381.7〜390.3MiB）、差は最大 +17.17MiB。AC05(1): 寄与は差で読み、C14 の残存リスク (21) は閉じない。AC05(3) の次の手（deferred の owner の heap を切り出す補助の窓／deferred の owner にも若い世代の上限を付ける／U-Y の decode の確保を減らす製品の契約）は作者裁定待ちで、起草しない**→2026-10-14 朝 ①を裁定（Q-E05S-NEXT）、P3-E05Y-SPLIT-001 |
| `P3-E05Y-SPLIT-001`（`p3-e05y-split.json`） | TYPHOON の上乗せの窓の Fail（run2 の 407.5MiB、周 0 の 306.2s、VPWS50 の処理の終わりの約 0.3 秒後）の次の手、AC05(3) の①（作者裁定 2026-10-14 朝、Q-E05S-NEXT）。上乗せの後の山の区間で、記録できた点（probe の山）でどの thread（deferred〔U-Y の確率の報の decode〕・重なった weatherCurrent〔VPWS50〕・publisher と urgent）の何（heap の容量・external、または未説明の残差）が対照より増えていたかを、観測（probe・processing と GC の行・mem 行）の照合で届く範囲で出す。記録できなかった頂点の帰属は未確定とし、RSS への寄与と native への帰属は断定しない。起草案は e05y-P の負荷のまま分類の窓の probe（4 thread の 200ms、観測だけ）を足した窓 e05s-y と、同じ probe の素の E05-P の窓 e05s-p を交互に 3 run ずつ。判定表 S0〜S6 と分類ごとの次の手（②deferred の若い世代の上限／③U-Y の decode の確保を減らす 等）を結果の前に固定する。窓の E02・E05 は報告だけ | TYPHOON の正式の記録 | 起草（2026-10-14、444de1a7 から）。独立レビュー（品質 NO-GO が 3 巡〔Q-E05S-REVIEW1〜3、3 巡目の後は作者裁定で引く直し〕→4 巡目で GO、契約適合 条件付き GO→条件は直し済み、Q-E05S-REVIEW）。作者裁定 P3-E05S-SHAPE＝B・CONTROL＝A・RUNS＝A・GC＝A（4 つとも推奨どおり）、残存リスク (1)〜(16) 一括承認（2026-10-14 朝、Q-E05S-AUTHOR）。発注前点検 2026-10-14（裁定前の書き方を B・A・A・A の形に、他の契約が引く windows.mjs の 34 行を動かさない行の約束を確かめ、anchor のずれ 0、Q-E05S-PRECHECK）。baseOid は点検の commit 9b3d5f15 に割り当て済みだった。実装は配送 1c00ac0a。AC07 の予備 1 回目（Mac mini、p3-prelim-20261014T004049）は (c) で停止（e05s-y の周 0 が busy、weatherCurrent の山の側の minor GC 2 回）。作者裁定 B（busy の効く範囲を thread ごとに絞る。deferred が ok なら d だけで S1）で改訂（Q-E05S-PRELIM1・REVISE1）。baseOid は改訂の commit 556be0a5 に割り当て直し済み（Q-E05S-BASE）。改訂の配送 feac9e78、予備 2 回目は (a)〜(d) 通過、manifest 凍結 8dd1dca1（p3-e05s-20261014）。正式（Mac mini、2026-10-14、54226dec）: 周 0・周 1 とも 3 run S1V（周 0 の d_S1 47.7〜48.5MiB・deferred の ΔV 差 +37.5〜38.3、周 1 は 17.3〜17.8MiB）、対照を 1 つずつ替えても変わらず、取り逃し 0。次の手は S1V→②の候補で作者裁定待ち |
| `P3-OWNER-YOUNG-LIMIT-002`（`p3-owner-young-limit-deferred.json`） | SPLIT の正式の S1V（上乗せの後の山の区間で deferred の heapTotal−heapUsed の差 +37.5〜38.3MiB）の次の手 ②（作者裁定 2026-10-14 午後、D-DYL-NEXT）。deferred の owner thread にも Worker の resourceLimits.maxYoungGenerationSizeMb＝12 を付ける（weatherCurrent と同じ値、urgent は縛らない。手元の Mac mini で確率の報の後の heapTotal 約 −40MiB、1 入力の時間 +3〜7%）。受理・状態・出力・通知・保存は変えない（AC02、上限なしと上限ありで出力と保存の一致を示す）。host.ts の 127 行を 1 行で置き換え、行の数は変えない（127 行を引く TYPHOON・SPLIT の anchor 2 件は配送の commit で同期）。E05-P の測り直しは配送の後に統合担当（Q-DYL-E05P） | SPLIT の正式の記録 | 起草・発注前点検（2026-10-14 午後、aa6c95b7 から）。作者裁定 VALUE＝A・SCOPE＝A・E05P＝A、残存リスク (1)〜(10) 一括承認（Q-DYL-AUTHOR、Q-DYL-PRECHECK）。baseOid は点検の commit に割り当てる（Q-DYL-BASE）。baseOid は点検の commit fef851af に割り当て済み。配送 c8cc8614（AC02 で 524 入力の出力と保存の 4 slot が上限なしと一致、AC03 で heapTotal −28.5MiB 以上）。e05y-P の測り直し（p3-dyl-e05y-20261014、b0ae4c34）で 374.5・362.3・380.6MiB、3 run とも Pass（前回 392.9・407.5・387.7、対照の素の E05-P も 364.1・354.6・361.3 で Pass。Mac mini、判定場所の Pi は P5） |

### 上限の扱いを ChatGPT Pro の候補 1＋2 へ（2026-10-15）

上限・縮退・退去の監査（53 行、台帳 79〜85）と ChatGPT Pro の構造レビュー（`To-Claude/2026-10-14-FlEq-limits-structural-review.md`、3fe5dd69）を受け、作者裁定 D0（2026-10-15 朝）で、起草案 P3-LIMIT-RULES-001 の S1（subject 別の隠し）・S2（退去の共通化）を恒久形として発注せず、3 単位に切り替えた: ① U-F の公開境界、② 容量の失敗を隠さず現在性・網羅性として扱う、③ U-W の正本の持ち方（406 鍵・取消履歴の保証・U-W の view の大きさ）。順は ① → ②（② の base は ① の配送の後）。

| 契約 | 対象 | 依存 | 状態 |
|---|---|---|---|
| `P3-UF-PUBLIC-001`（`p3-uf-public.json`） | U-F の owner が publisher へ出すもの（view・displayChanges・restore・normal の公開の制限）を、常設表示に要る小さい公開形式（1 鍵 1,510＋10×区域 byte）に限り、範囲・版付きの詳細取得の口と索引ページを足す（spec §7.10 の U-F 分を P3 で）。U-F の state・codec・reducer・保存は変えない。A3（他分野の巻き添えの要約）を U-F について閉じる（U-W の分は ③） | P3-EXECUTION-LIFECYCLE-001・P3-UNIT-TABLE-001 | 起草・発注前点検（2026-10-15、3fe5dd69 から）。独立レビュー（品質 ヘルツ NO-GO→条件付き GO、契約適合 Opus 条件付き GO×2）。作者裁定 D-FIELDS＝A・D-DETAIL-SCREEN＝A（作者裁定 P2-A8-D03=A を U-F について一部覆す）、残存リスク (1)〜(10) 一括承認（Q-UFP-AUTHOR、Q-UFP-PRECHECK）。baseOid は点検の commit 9b0248ac に割り当て済み（Q-UFP-BASE）。実装のレビュー（品質 ヘルツ GO・契約適合 Opus GO）を経て配送、同じ commit で AC09 の原文の改訂（spec §3・§7.10・§8.1、実行境界メモ §2、P2-SHARED-RUNTIME・P2-WEATHER-TIMESERIES-UNIT・P2-SNAPSHOT-SSE・P3-EXECUTION-SPLIT・P3-EXECUTION-LIFECYCLE、本計画 §5.2） |
| `P3-CURRENCY-COVERAGE-001`（`p3-currency-coverage.json`） | 容量の拒否で normal を隠す経路（withoutNormal・admission の記録・overflow・main の normal pending の一括除外）を外し、旧値のある記録に付箋（U-T・U-Q。U-W・U-F は既存の lastKnown の印）、付箋の付かない拒否は unit の網羅性（UnconfirmedReason に capacityExceeded）へ。失敗した系列のまだ鳴っていない desktop の題名に時刻、拒否した報が warning 以上なら unit×operation ごとに 1 つの失敗警報 | P3-UF-PUBLIC-001 の配送 | 起草（2026-10-15、3fe5dd69 から）。独立レビュー（品質 ヘルツ NO-GO 4 巡→条件付き GO〔D-FAILNOTICE を unit 単位へ作者裁定で形を変えた後〕、契約適合 Opus 条件付き GO×3）。作者裁定 D-CLEAR・D-PENDING・D-SHOW＝A、D-FAILNOTICE＝A（unit 単位の失敗警報）、残存リスク (1)〜(18) 一括承認（Q-CC-AUTHOR）。発注前点検は ① の配送（963351a7）の後に済み（Q-CC-PRECHECK、http-sse.ts を allowedPaths に追加）。baseOid は点検の commit e37e40ec に割り当て済み（Q-CC-BASE）。実装のレビュー（品質 ヘルツ NO-GO→条件付き GO、契約適合 Opus 条件付き GO→条件付き GO、Q-CC-IMPL）を経て配送、同じ commit で AC09 の原文の改訂（P2-SHARED-RUNTIME・P2-SNAPSHOT-SSE・P2-EEW-UNIT・P2-WEATHER-CURRENT-UNIT・P2-WEATHER-TIMESERIES-UNIT・P3-TSUNAMI-UNIT・P3-UNIT-Q・P3-UNIT-TABLE・P3-EXECUTION-SPLIT・P2-CHECKPOINT-SHUTDOWN・P2-CHROME-EEW・P3-UF-PUBLIC）。起草案 P3-LIMIT-RULES-001 の S1 は本契約が置き換え、発注しない（Q-CC-LIMIT-RULES）。chrome-eew の smoke は実 Chrome で実走済み（Q-CC-SMOKE） |
| `P3-DISASTER-CAPACITY-001`（`p3-disaster-capacity.json`） | 災害の日の電文を本物の順で仮想時計に乗せて製品の composition root へ流し、unit ごとの器の使用率の最大・入力単位の拒否と未解消の拒否・退去・容量で消えた記録・snapshot の要約を測る道具の 1 段目。筋書き 7 本（W1 台風・大雨の日の実電文、W2 U-W の鍵の累積、R1 能登 2024 の実電文、R2 2011 東北の津波、N1〜N3 南海トラフの全割れ・半割れと 12 時間後の後発・それに台風を重ねたもの）。製品の src は変えない。2 段目（実時間の RSS・EEW の遅れ）は外 | P3-EXECUTION-SPLIT-001 ほか unit の契約（本文の dependsOnContractIds） | 起草（2026-10-15、3fe5dd69 から）。独立レビュー（品質 ヘルツ NO-GO→条件付き GO、契約適合 Opus 条件付き GO）。作者裁定 D1〜D3＝A、D-SUMMARY＝A'（U-E・U-T・U-Q の要約を欠けに数える）・D-CLOSE＝A（結果の記録で閉じ、直しは別の契約）、残存リスク (1)〜(13) 一括承認（Q-DC-AUTHOR）。発注前点検は済み（Q-DC-PRECHECK、R2 の 7 時刻を原文で確認、余震の EEW の比を 360 件に合わせて直した）。baseOid は点検の commit e37e40ec に割り当て済み（Q-DC-BASE）。実装のレビュー（品質 ヘルツ NO-GO→条件付き GO→GO・契約適合 Opus 条件付き GO→GO）を経て配送（reconstruction/test/disaster/ の 4 file、製品の src は変えない。Q-DC-IMPL）。正式の run（Q-DC-RUN）は配送の後に Mac mini で。R1 は Archive の取得まで blocked（Q-DC-ACQUIRE-EQ）。① ② ③ の配送ごとに同じ道具で測り直す（Q-DC-REMEASURE） |

## 振る舞い表の反映（2026-10-19）

作者が 2026-10-17〜19 に決めた利用者から見た振る舞い表の決まりを、spec §16（H01〜H50）に写した。
ここでは、それを運ぶ仕事を契約ごとにまとめる。発注の順と見積もりは作者と決める。

### 配送済みの契約を変える仕事（変更の契約の候補）

「永続 schema の移行」は、保存の型が変わり、旧データの移行と復元の試験が要るか。未確認は起草のときに確かめる。

| 候補 | 変える契約 | §16 | 永続 schema の移行 |
|---|---|---|---|
| 通知の段の改訂 | `P2-EEW-UNIT-001`（Q-NOTICE.payloadRules の level）、`P3-UNIT-Q-001`（P3-C7-NOTICE-LEVELS）、`P3-TSUNAMI-UNIT-001`（P3-C5-NOTICE-LEVELS）、`P3-UNIT-N-001`（P3-C8-NOTICE-LEVELS）、`P3-UNIT-M-001`（P3-C13-NOTICE-LEVELS） | H06、H08、H09、H12、H13 | 無し |
| 津波緊急の群の判定を音の段から切り離す | `P2-NOTIFICATION-DELIVERY-001`（P2-A7-IR03 の実装）、`P3-TSUNAMI-UNIT-001`（通知の優先順の導出） | H09 | 群の保存表現と旧 pending の互換処理は要確認 |
| 通知の文面と取消の通知条件 | `P2-EEW-UNIT-001`（Q-NOTICE.payloadRules の title と body）、`P3-UNIT-Q-001` ほか各 unit の取消の payload、各 unit の LEGACY-DIFF の取消の条件（`P3-TSUNAMI-UNIT-001`・`P3-UNIT-Q-001`・`P3-UNIT-N-001`・`P3-UNIT-V-001`・`P3-UNIT-L-001`・`P3-UNIT-R-001`・`P3-UNIT-M-001`）、各 unit の通知の証拠の保持と復元（例: 土砂は intent を expiresAt で回収するので、数時間後の取消では元の報を通知した証拠が残らない） | H06、H16、H19 | 文面は無し。通知の証拠は保持の方式を要確認 |
| 新旧の比べ方の横断修正（`P3-REVISION-ORDER-001` の後継） | `P3-REVISION-ORDER-001`、`P2-EEW-UNIT-001`、`P3-LIFETIME-AND-EEW-GATE-001`（P3-LIFE-D-LATE）、`P2-WEATHER-CURRENT-UNIT-001`、全 unit の codec | H14 | 有り（Control/DateTime を保存と復元まで運ぶ） |
| EEW の閉じ方と鳴り直し | `P3-LIFETIME-AND-EEW-GATE-001`（P3-LIFE-D-EEW）、`P2-EEW-UNIT-001`、`P2-CHECKPOINT-SHUTDOWN-001`（P2-A3-AC01） | H20、H33 | H20・H33 だけなら型の変更は不要（current・gate は保存しない）。H48 の互換処理は別 |
| 通知の出し直しを B にする | `P2-NOTIFICATION-DELIVERY-001`、`P2-CHECKPOINT-SHUTDOWN-001`（P2-A3-AC01）、`P2-EEW-UNIT-001`（Q-NOTICE.capacity）、全 unit の復元 intent の再試行 | H48、H33 | 未定（保持方式が決まってから） |
| 期限切れの形の統一と二段の期限 | `P3-UNIT-L-001`（P3-C10-ACTIVE-EXPIRY）、`P3-UNIT-Y-001`（P3-C14-EXPIRY）、`P3-UNIT-N-001`（P3-C8-CURRENT-EXPIRY）、`P3-UNIT-M-001`（P3-C13-TORNADO-EXPIRY）、`P3-UNIT-V-001`（噴火の期限） | H23 | 未定（旧期限の扱いが決まってから） |
| 消えた理由と欠けの件数のお知らせ | `P2-SNAPSHOT-SSE-001`（P2-A8-NOTICE、Q-NOTICE-UX） | H17、H39、H11（画面のお知らせも作るとき） | A8 の表示 wire に永続 schema の移行は無い。再起動後もまとめを残すかは未定 |
| 地震の取消の印と保持件数 | `P3-UNIT-Q-001`（P3-C7-CANCEL-SCOPE、P3-C7-CAPACITY） | H18、H36 | 取消表示の recent.cancelled は既存。取消による件数の補正は別で、旧 count は取消を引かず recent は 5 件なので、旧集計を完全には直せない |
| 南海トラフの情報系列の保存 | `P3-UNIT-N-001`（P3-C8-SUBJECTS、288 KiB の予算） | H30 | 有り |
| 接続の間隔、繋がらない理由、切断の時刻 | `P3-DMDATA-CONNECT-001`（P3-C2-RETRY、P3-C2-RECOVERY） | H24、H26、H29 | 無し |
| 取り直しの全分野化 | 各 unit の N2（P3-C7-N2、P3-C8-N2、P3-C9-N2、P3-C10-N2〜P3-C14-N2）、各 unit の recovery の通知（`P3-TSUNAMI-UNIT-001` ほか）。C16 と一緒に | H26、H27 | 未定（保存境界が決まってから） |
| snapshot で EEW・地震・津波を要約に落とさない | `P2-SNAPSHOT-SSE-001`（`P2-A8-RES-06` の分野の優先）、`P3-DISASTER-CAPACITY-001`（この線で測り直す） | H37 | 無し |
| 容量を先に取る | 新しい契約。`P3-CURRENCY-COVERAGE-001`（最後の網として残す）、`P3-EEW-GATE-EVICT-001`、`P3-TSUNAMI-UNIT-001`・`P3-UNIT-Q-001` の容量の分岐 | H35 | 未定（採用容量が決まってから） |
| 手元の時計に頼らない | `P3-LIFETIME-AND-EEW-GATE-001`（P3-LIFE-D-SKEW、AC13）、`P3-UNIT-B-001`・`P3-UNIT-M-001`・`P3-UNIT-Y-001` の時計の扱い、時計を供給する runtime と host、`P2-NOTIFICATION-DELIVERY-001` の通知の期限 | H42 | 補正した時計を渡すだけなら型の変更は不要。旧式で作った期限の扱いは別途 |
| 読めなかった電文の表示 | `P3-UNIT-TABLE-001`（P3-C0-RUNTIME-DISTINCTION）、`P3-UNIT-M-001`（P3-C13-RAW、作者裁定を覆す） | H43 | 受信時の表示だけなら永続化は不要。履歴の保存まで求めるなら別 |
| 一覧との突き合わせによる鮮度の疑い | `P2-WEATHER-CURRENT-UNIT-001`（P2-A5-SEM-01）。C16 と一緒に | H41 | 未定（保存境界が決まってから） |
| 形の違う気象電文の読み方 | `P2-WEATHER-TIMESERIES-UNIT-001`、`P3-UNIT-Y-001` | H44 | 無し |

### 未起草の契約に足すもの

| 契約 | §16 |
|---|---|
| C16 `P3-RECOVERY-001` | H04、H22、H26、H27、H28、H31、H32、H41 |
| C18 `P3-CLI-REPL-001` | H11（`notify` の既定）、H46、H50（設定） |
| C19 `P3-TERMINAL-OUTPUT-001` | H08（端末の枠）、H18（今日の件数）、H24、H25、H29 |
| C20 `P3-WEATHER-NOTICE-001` | H11、H19 |
| ③ U-W の正本の持ち方 | H38 |
| 区域の対応表の資材（新しい契約） | H50 |
| P4 の契約群 | H01、H02、H03、H05、H07、H10、H15、H17、H21、H34、H40、H45、H47、H49、H50、ほかの決まりの見せ方 |

## 再開の並べ方（2026-10-20 作者裁定）

作者は判断カード「新築の再開の並べ方」（作業ノート、2026-10-19 起草）で、判断 1 を推奨案 D、判断 2 を「含める」と決めた（2026-10-20）。上の「振る舞い表の反映」の候補は、この順で発注する。

### 判断 1: 推奨案 D の順

1. 断られている気象の電文を読めるようにする（H44、台帳 89）。判断を待たずに起草してよかった直しで、どの案でも最初に来る。
2. 保存の前提をまとめて決める（起草だけ、実装の前）。新旧を比べる材料を保存まで運ぶこと（H14）、通知を照合する材料（H27、H48、H19、C16 の保存境界）、期限の決め方（H23、H42）、重い情報で何を保存し何を守りどれだけ持つか（H35〜H38）。画面・音・通知の出方が変わる選択は、起草のときに判断カードで作者へ戻す。
3. 保存の形を変え、同じ分野の鳴り方と通知の文面も一緒に直す（H14、H30、H38、H48、H23、H06、H08、H09、H12、H13、H16、H19）。保存の形の変更は決まりごとに 1 本（K1〜K6 と同じ型）とし、鳴り方と文面の直しは同じ分野を触る保存の形の契約に混ぜる。同じ分野の所は直列に合流する。
4. 上限の値と、画面へ送る形を確定する（H35〜H37）。落としたもの・押し出したものの件数と取消の理由を作って画面へ送る所もここで作る（H17、H39）。
5. 災害の日の測定で中間確認をする（W1、W2、N1〜N3、R2）。上限の直しの効きを確かめる場所で、判断 2 の合格はここでは見ない。途中の配送ごとに影響する筋書きだけを測り直す（Q-DC-REMEASURE）。
6. 旧データの移行と切れていた間の取り直し（C15、C16。C16 は H04、H22、H26〜H28、H31、H32、H41 を含む）。C16 の起草は 2 と並行で始める。続けて残りの P3（C17〜C20、H24、H25、H29、H43、C21）。
7. 最終検証で、最終の形の災害の日の測定をやり直す（C22）。判断 2 の合格はここで見る。
8. P4 は描画だけを受け取る（H01〜H03、H10、H21 ほか）。通知の段と文面、件数のまとめと取消の理由は P3 で作り、P4 へ送らない。

併せて決めたもの（統合担当）: H09 と津波緊急の群の判定の切り離しは同じ契約、H20 と H33 は同じ契約、W2 の道具の直し（台帳 90）は ③ と同じ契約、写した読み取り関数の集約（§9）は 3 の後、同時に走らせる本数は §3.1 の 3 本まで。

### 判断 2: 災害の日の測定の合格を P3 最終完了の条件に加える

§1.3 の「P3 最終完了」の条件に次を加える（§1.3 の行は他の契約から引かれているので、ここに書く）。

- P3 の最終の形（C22）で、W1 の 3 日それぞれ、道具を直した W2、N1、N2、N3、R2 の各筋書きが、`P3-DISASTER-CAPACITY-001` の P3-DC-PASS の 4 条件をすべて満たすこと。4 条件は、どの分野・どの運用区分でも上限のために電文を断らない、画面に出ていた通常の情報が本来の期限の内に上限のために消えない、筋書きごとの「この時刻にこれが残っているはず」の例が全部合う、EEW・地震・津波が画面へ送るときに要約にならない。
- 測れなかった筋書き（blocked）は合格に数えない。
- R1（能登 2024）は電文が取れたら加える。取れないまま P3 を閉じるときは、R1 を欠いたことを記録し、その時点で作者に確かめる。
- 結果には、流した電文の指紋、測ったときの版、契約の版を残す。
- この合格は、通知が溢れたとき、保存に失敗したとき、Pi の実時間の遅れとメモリを保証しない（P3-DC の残存リスク (1)・(3)・(6)・(13)）。
