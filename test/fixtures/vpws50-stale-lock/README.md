# vpws50-stale-lock fixture

`pi-stale-lock-state.json` は、VPWS50 の全国報が 8 日間拒否され続けた Raspberry Pi の
永続状態を縮小・匿名化したもの。`spec: 2026-09-07-vpws50-stale-current-lock.md（作業ノート、repo 外）`
§4.13 の統合テスト（`test/engine/messages/vpws50-stale-lock-recovery.test.ts`）が使う。

中身は `PersistedVpws50StateV2`（`src/engine/messages/vpws50-state.ts`）そのままの形なので、
`Vpws50StateHolder.restorePersistedState()` に直接渡せる。

## 由来

- 採取元: Pi の `display-active-state-v2.json`（7,083,368 bytes）の
  `telegramFoundation.vpws50.state`
- 採取日: 2026-09-07
- 凍結していた全国 base の identity: `reportDateTime=2026-08-30T13:00:00+09:00` / `serial=null`

生成スクリプトは Pi の実ファイルに依存して再実行できないため、repo には置いていない。
同じ形の fixture を作り直すときは以下の手順を再現する。

## 縮小手順

1. `telegramFoundation.vpws50.state` だけを取り出す。
2. `current.snapshot.areas` を 12 区域へ間引く。**不死化していた L4 土砂災害を持つ区域を
   必ず 1 件残す**（福井市 `1820100` 相当。この fixture では `9100001`）。kind 総数は
   `ABNORMAL_UNEXPLAINED_RELEASE_MIN = 4` を確実に超える数にする（この fixture は 33）。
3. `history` を 8 件 → 1 件へ。identity は 2026-08-30 のまま残す
   （脱出後の取消で 8 日前が復活しないことを同じ fixture で確認するため）。
4. `partialStreams` を 4 件だけ残す。内訳は
   - (a) `clearedPhenomena` だけを持ち base の一部現象を消す stream
   - (b) base に無い新しい L4 を追加する stream（base より新しいので受理後も生き残る）
   - (c) base より古い stream 1 件（復元時 prune の対象）
   - (d) 素の stream 1 件
5. `partialHistory` を 1 subject × 1 entry へ。
6. `emergencyClearTombstones` は 1 件そのまま残す。
7. 目標サイズは 100KB 未満（現状 29,820 bytes）。

## 匿名化

dmdata 由来の実データを公開 repo に置かない原則（spec §6-7 の裁定 A）に従い、次を合成値へ
置換してある。構造の再現に実際の地名は要らず、L4 の重なりと `clearedPhenomena` の関係だけが要る。

| 元 | 置換後 |
|---|---|
| 区域名 | `架空区域NN` |
| 区域コード | `9` 始まりの合成コード（元の桁数だけ保つ） |
| 官署名 | `架空第NN気象台`（subject は `weather:VPWW55:架空第NN気象台` の形を保つ） |

区域コードは snapshot 側が 7 桁（市町村等）、`emergencyClearTombstones` の 1 件だけが 6 桁。
**この fixture には府県予報区コード（6 桁・末尾 `0000`）が 1 件も無い。** 採取元の Pi 実状態でも
`current.snapshot.areas` 1,080 件はすべて 7 桁の市町村等コードで、府県予報区コードはゼロだった。
したがって `prefecturePrefix()` / `removeEmergencyKinds()` の府県前方一致経路はこの fixture では
踏まない。その経路は `test/engine/messages/vpws50-state.test.ts` が `180000` 等の合成コードで
別途カバーしている。実状態に無い構造を fixture に足すと採取元の再現ではなくなるので、ここには入れない。

`reportDateTime` / `serial` / `kindCode` / `kindName` / `phenomenonKey` / `displaySeverity` は
挙動の再現に必要なので実値のまま残している。これらは気象庁のコード表と時刻であり、地名情報を含まない。
