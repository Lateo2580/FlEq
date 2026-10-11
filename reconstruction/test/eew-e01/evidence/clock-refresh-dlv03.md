# 時計の往復測定の間隔（DLV-03）の逸脱

作者裁定 A（2026-10-11）。下の記録はどれも結果を書き換えず、この逸脱を併記して読む。

## 事実

- spec `docs/specs/reconstruction-p0-contracts.md` の「時計対応」は、Node と Chrome の単調時計を開始時・終了時・実行中 30 秒ごとの往復測定で対応付ける。契約の上限は P2-EEW-E01-001・P3-E01-REACCEPT-001（P3-C4-DLV-03）・P3-TSUNAMI-E01-001（P3-C6-DLV-03）とも 30 秒
- `run.mjs` は試行の頭で「前の測定から 29 秒経ったか」を見てから測るので、間隔は試行の長さのぶん伸びる。判定器（`analysis.mjs` の PROBE_MAX_AGE_MS = 35 秒）は各標本の最近傍の測定が 35 秒以内かだけを見て、30 秒の間隔は検査しない
- C6（p3-c6-formal-20261009）の 24 窓: 3,152 区間のうち 1,563 区間が 30 秒超、最大 34.184 秒。最近傍の測定までの距離は最大 16.05 秒、対応区間の幅は最大 1.33 ms（標本の U に含まれる）。出典は外部監査（agent-mailbox `ed82aa4` の projection-audit-20261011）で、投影の probe は run-record の全部（correspondencesEqualRunRecord 24/24）

## 対象

同じ runner で測った a10-p2-20260930b・p3-c4-formal-20261007・p3-c4-formal-deadline-20261008・p3-c6-formal-20261009・p3-mh-e05p-20261011・p3-mh-uwr-20261011。C6 以外は件数を数えていない（公開の記録に対応の列が無い）が、作りが同じなので同じ逸脱を持つ。

## 扱い

同じ Mac の上の対応で、区間の幅は U に入っているので p99 の結論は変わらない見立て。閉じた契約の文は変えない（凍結 manifest の contractSha256 に入っている）。測る時機の直しと判定器への 30 秒の検査は、別機械の harness の契約で行う。
