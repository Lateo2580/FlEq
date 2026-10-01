# P3 実行の境界（C3a・C3b・C4 の凍結項目）

- 起草: 2026-10-01、base `87fc5ed3`。計画 `reconstruction/contracts/p3-order-plan.md`（以下 plan）§1.1 の 2・3、§4.2・§4.3、§5（D-P3-1）・§5.1 を、C1・C2 の契約がこれと矛盾しないかを確かめられる粒度にしたもの。
- 対象外: C3a・C3b・C4 の本文、型、実装手順。本文は C1・C2 の配送後に書く（plan §3.1）。ここに無い細部は本文で決める。
- 以下 `spec:` は `docs/specs/reconstruction-p0-contracts.md` の行番号。

## 1. 実行場所（D-P3-1、plan:178）

| 実行場所 | 持つもの |
|---|---|
| publisher（Node main） | 接続（C2）・振り分け・mailbox・snapshot・SSE・通知 adapter・健康状態。checkpoint の書込み権の配分と、各 worker の停止監視（C3b） |
| 急ぐ unit の worker | U-E。以後の急ぐ unit の置き場は各 unit 契約で決め、急がない unit と同居させない |
| U-W の worker | U-W |
| 急がない unit の worker | U-F と以後の急がない unit |

- 各 worker は自分の unit について、解凍・XML parse・reduce・期限処理・view 生成・checkpoint の encode と書込みを行う（plan:60、R57）。
- 実行単位の形は `worker_threads`（plan §5.1 の A、spec:1027 の常駐 worker の形）。RSS は同じプロセスに数え、C4 の予備測定で取る。

## 2. publisher と worker の間に流れるもの

| 向き | 流れるもの | 流さないもの |
|---|---|---|
| publisher → worker | 受理した入力（frame の raw bytes と ingress 済みの外形 metadata、inputId・T0）、control（期限 tick の時計、終了の段階指示）、checkpoint の書込み権（1 件ずつ） | decode・normalize 済みの中身 |
| worker → publisher | 版付きの有界な view・outcome・intent 選択の入力・persistence 状態（`kind`・`dirtySince`・`currentGeneration`・`savedGeneration`）、checkpoint の結果と計測、入力の完了、進捗応答、診断 | parse 済み tree（台帳 38: 転送 212ms）、canonical state 全体、checkpoint の bytes |

- 大きい frame の envelope の全文 JSON.parse を publisher に残すかは C4 の予備測定の `ingressJsonMs` で決める（plan:194、spec:1072「全文の JSON parse は一回」）。どちらでも parse は 1 回。
- worker と publisher の間の値は構造化複製できる素のデータに限る（関数・class instance・共有の可変参照を持たない）。

## 3. checkpoint の書込み権（plan §5.1 の A、plan:192）

- 全体の in-flight は 1 件のまま（spec:859）。publisher が worker から届く persistence 状態で §5.8 の選択（試行可能な最古の `dirtySince`、同時刻は固定 UnitId 順）を行い、書込み権を 1 つずつ渡す。§5.8 の公平性（E14・IR01）は変えない。
- 再試行の間隔（`retryAfter` と連続失敗回数、spec:859。現行は `checkpoint.ts` の retry Map）は publisher が持つ。worker は失敗・成否不明の結果を返すだけで、publisher がその結果から 1・2・4・8・10 秒の間隔を決め、選択に使う。同世代の再試行に使う request と保存 bytes は worker に残す。
- 権を受けた worker が capture・encode・hash・書込み・照合を行い、結果を型付き入力として返す。全体の権を持ち続けるのは、停止未確認の filesystem 操作が残っている間と照合を実行している間だけ（spec:841）。終了が確認できた失敗（書込み・照合の失敗を含む）では権を返し、その単位だけを再試行待ちにして、正常な他単位の保存を妨げない（spec:841、E14。現行も操作の終了で全体 writer を解放する: `checkpoint.ts` の `resultMetadata`）。
- slot の記憶（C1 が足す有効 slot・世代・hash）は、その unit を持つ worker の中にだけ置く。publisher は持たない。
- 保存完了で dirty を無条件に消さない（手順 1 の ⑤）。ack 世代が現在世代と一致したときだけ `dirtySince` を消す現行の条件（`shared-runtime.ts:971`〜`:973`）を分離後も検収に残す。

## 4. mailbox の実行場所ごとの in-flight（C3a が P2-MAILBOX-001 を改訂）

- 通常 data の in-flight は実行場所ごとに 1 件（現行は全体で 1 件: `reconstruction/src/mailbox/mailbox.ts:119`、`p2-mailbox.json` の P2-A2-RES-07、spec:1049）。大型 parse 中の U-W・U-F の入力が U-E の入力を止めない。
- 件数・byte の上限は全体で 1 つのまま。同じ順序領域の順序と完了照合（inputId と実行場所の対応）を保つ。
- mailbox は publisher にあり、worker の数だけ増やさない。

## 5. 停止監視（C3b）

- publisher が worker ごとに spec:1190〜1191 の 2 系統を監視する: 未完了仕事または期限超過があって 5 秒進捗が無ければ stalled、idle 時も返す進捗応答が 5 秒無ければ unresponsive。止まっている最中の検出が P3 から保証範囲に入る（plan:33、R60 の P2 限定を解く）。
- WS の生存監視（C2）は接続の監視で、worker の監視と別に publisher に置く。どちらの判定も他方の応答を根拠にしない。
- 通常終了の順序は spec §5.9（入力停止 → mailbox 収束 → batch 終了 → 副作用固定 → 全最終世代 ack → worker 終了）。worker の終了を含む。自動再起動は spec に無く、要るなら裁定（plan:61）。

## 6. P3 測定 manifest の骨格（C4 が予備測定の後に凍結、plan §4.3）

- 継承元: `reconstruction/test/eew-e01/evidence/manifest.json`（`manifestId` a10-p2-20260930b）。負荷 N・P・C の定義（`loads`）をそのまま使う。A10 の版付き結果は書き換えない（plan:132）。
- 正式母集団: A10 の `formal`（fixedBacklog）に、A10 の `reference` 4 条件（maxVpws50DecodeStarted・maxWeatherCheckpointEncodeStarted・maxForecastCheckpointSave・forecastDeadlineOverlap）を同じ負荷定義のまま正式条件として足す。衝突試験（最大 VPWS50 の受信直後の EEW、R57）は新しい母集団 ID にする。
- 標本: 各母集団 warm-up 100 件＋1,000 件×3 run、各 run が合格（spec:1118〜1119）。T0 は対象処理開始後 0〜5ms かつ処理中（spec:1133）。投入→T0 と T0→T6 を分けて記録し、callback に届かなかった入力も投入側で照合する。
- 観測点の追加: full parse 開始（`e01:726`）、切断の hrtime と充填時点の `state/`・`/snapshot`（AC15 の再集計）、E15 の計測点（C3a 後の配置に 1 回だけ）。
- PERF-P3 の窓は a10-p2-20260930b の P と C をそのまま使う（plan:152）。Pi の `/proc/pressure/*` は報告だけ。測定の窓では同じ機械で build・test・他レーンを走らせない（plan:112）。
- 手順: 予備測定 → manifest 凍結 → 正式測定。結果を見てから母集団・除外条件を変えない（spec:1106）。

## 7. C1・C2 の契約が守る制約

C1（`P3-CHECKPOINT-STEP1-001`）:

1. slot の記憶は unit ごとに持ち、単位をまたぐ新しい状態を足さない（§3 で worker ごとに分けるため）。既存の全体 writer 予約 1 件はそのまま。
2. `CheckpointResult`・`CheckpointMeasurement`・`CheckpointRequest` は素のデータのまま、型を変えない（§2）。保存 bytes は coordinator の内部に持ち、request に載せない。
3. composition root への新しい依存や呼出しを作らない（Wave 2 で C2 が編集する）。
4. 定常保存から verify 段が消える。段の名前と attemptId の結合は変えない。C4 の manifest は定常保存に verify 段が無い前提で組む（§6）。

C2（`P3-DMDATA-CONNECT-001`）:

1. live の frame も既存の 1 本の入口（T0 marker → ingress → mailbox への enqueue、`reconstruction/src/host/host.ts` の受信処理）を通す。mailbox を迂回する経路や、T0 より前の decode・normalize を作らない（§2・§4）。
2. 生存監視・再接続・start frame の記録・接続回復の通知は publisher 側に置き、worker の応答を判定に使わない（§5）。mailbox の排出も判定に使わないが、例外として過負荷による自接続停止からの再接続は既存どおり mailbox の排出（低水位）を待つ（C2 の P3-C2-RETRY）。接続回復で worker の状態や確認状態（R42）を戻さない。
3. start frame の本番の記録は診断 reason の閉集合への追加（`dmdataSocketStarted` など）として診断へ入れる。実接続検証の証拠用に限り、`P2HostObservation` へ制御 frame（start・ping・error）の種類 `controlFrame` を 1 つだけ足し、`config.observe` へ出す（本番の observe は null。C2 の P3-C2-START-RECORD・AC05）。接続回復は composition root の `lostThroughSequence` の解除で、表示には tick の射影で届く。C4 の runner は start と接続の出来事を診断から読み、`controlFrame` は検証で observe を渡したときだけ使える（§6）。
4. 測定はローカル WS の replay で行うので、`startP2Host` の接続先 URL 入口と replay の経路を壊さない（live 起動入口は追加）。

## 8. C3a・C4 の本文で決めるもの

worker を足したときの RSS（E05 は worker を含む、spec:2056）、`ingressJsonMs`、view の版を固定長にするか（台帳 49、plan:228）、spec の改訂（plan §4.4 の :315・:1024〜1029・:1049・:1157・:1164）。いずれも実装後にしか測れないか、C3a の凍結と同時に行うもので、C1・C2 の着手条件にしない。
