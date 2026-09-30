# A10 正式測定 a10-p2-20260930b の完了判断（移管付き完了）

## 測定の根拠（測定時のまま保持する）

- 契約: P2-EEW-E01-001 の測定時の meta.sha256 は `08bb70be…`（改訂前）。manifest `a10-p2-20260930b`（manifestSha256 `03e631e0…`、commit `0bf317fa`）はこの hash を持ち、改訂前の契約で `verifyFrozenManifest` を通る。改訂後の契約では拒否されるが、これは凍結の境界どおりで、manifest の hash は書き換えない
- 結果: `results/`（commit `c111d843`、27 窓）。`a10-result.json` の sha256 は `53625532d771723e6a2d2fb588c0ba3ae47d42a27afd0f2492b9cc26b8eac9d0`
- 生データの補足封印: `supplement/raw-supplement.json`（sha256 `0c1f9431145fd85ebaddffeaf354dd17f55fc55fea520000bb19d5db413eba1d`、27 窓・278 ファイル、窓記録の raw 199 行と不一致 0）。生データは repo 外の `~/dev/fleq-a10-runs/a10-p2-20260930b/`
- AC15・E12 の再集計: `supplement/recompute-ac15-e12.json`（sha256 `1800eb49d4d3e735d0bedce9780c0c3943989aab1eb2cdac43e88b329ca0cbc3`、allMatch=true）。追試は `supplement/recompute-ac15-e12.mjs --out <一時 path>`（成果物を上書きしない）。**この再集計は完全に生データだけからの再現ではない**: AC15 の指紋表と保持件数は封印済み結果から取り（充填時点の state/ と /snapshot を保存していない）、metadata の切断時刻は予定表の起点から推定した（runner が切断の hrtime を書き出していない）。±5ms ずらしても判定は Pass のままだが、数値には差が出る

## 完了判断（改訂後の契約を後日適用）

- 契約 P2-EEW-E01-001 を commit `78f7a2a4` と、その後の担当・再検収条件の追記で改訂し、作者裁定 2 件（2026-10-01、A）を decisionBranches に記録した
  - `P2-A10-PERF-P3`: E02-P・E05-P の Fail はそのまま、E06 の spec 式超過（原因未分類）とあわせて P3 最初の契約群へ移管
  - `P2-A10-E15-P3`: AC09 の verify 段 bytes は読んだ bytes の別計数（二重加算しない）と読み、保存・診断 write の別計数と保存前段の同期区間の計測を P3 へ移管
- A10 は **移管付き完了**とする。未測定を測定済みとは扱わず、Fail を Pass とは扱わない。P2 限定 E01 は Pass（keepA）

| 測定 | 結果 | 扱い |
|---|---|---|
| P2 限定 E01 | Pass（3 run、各 1000 標本、欠落 0） | 完了 |
| E02-N・E05-N・E03・AC15 | Pass | 完了 |
| E02-P・E05-P | Fail | P3 へ移管（`P2-A10-PERF-P3`） |
| E06 | 報告、spec 式で RSS 傾きが超過・原因未分類 | P3 で分類（`P2-A10-PERF-P3`） |
| E15 | 一部未測定 | P3 へ移管（`P2-A10-E15-P3`） |
| 参考 4 条件・E12 | 報告のみ | — |
