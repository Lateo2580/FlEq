# 緊急津波 pager の probe/live chrome 同期と有限再分割

- 状態: **確定（案 1+2 裁定済み・Sol high DOC-OK 2026-08-27・実装待ち）**
- 対象: 緊急画面 `attention-visibility-emergency` の津波 coasts pager
- 起源: 2026-08-27 Chrome gate containment 赤

## 1. 症状

`attention-visibility-emergency`（1280×720）で、津波 coasts pager の live 本文が
`clientHeight=50.47px`、`scrollHeight=78px` となり containment が失敗する。

棚 outer の約708pxと live 本文の約668pxとの差40pxは、page 内側の左右20px padding による
比較層の違いである。検証対象は棚 root ではなく `partition-probe-body` と
live `page-list-body` とする。

## 2. 根因

`panelPages` は coast 3 section（大津波警報9・津波警報20・津波注意報21）と観測 section
22件を連結した全体 pager である。

live page の chrome は全 `panelPages.length`、active index、未読数に依存する。
一方、現行 probe generation は本文・compact・棚寸法だけで、総ページ chrome を含まない。
後続 section の分割で総ページ数や chrome の折返しが変わっても、既に fit と確定した range は
pending でなくなり再測定されない。

また live は `PageDots` と `PageAttentionState` の view model、棚は別 DOM を描く。
active dot の 6px/8px 差、`1/10` と `10/10` の幅差を含め、両者の wrap 条件が同値ではない。

## 3. 変更

### 3.1 共通 pager chrome と active-index 不変の予約

`TsunamiPanel` 内に live/probe 共用の pager chrome snippet を置く。

- dot 部は必ず `PageDots` を用いる
- attention 部は `PageAttentionViewModel` を入力とする
- live は `attention.viewModel(pageCycler.index)` を渡す
- probe は予約 model `pageAttentionViewModel({ activeIndex: pageCount - 1, pageCount, unseenCount: pageCount })` を渡す
- `.page-attention` は予約 model と live model を同じ grid cell に重ね、予約文字列で inline-size を確保する
- `PageDots` は各 button の flex basis を常に8pxへ固定し、非 current dot は内側描画を6pxにする。
  これにより current dot の位置は line wrap を変えない
- 従って pageCount ごとの最大 chrome は「最終 active index + 最大未読数」で一意に表せる。
  `1/10` ではなく `10/10・未表示10` を予約し、live の全 active index を包含する
- probe/live とも同じ reservation block height を `page-frame` に適用する

### 3.2 partition epoch state machine（採用）

`sequentialPartitionRanges` をそのまま前反復へ接続せず、`page-partition.ts` に
津波用の純粋な split-only state machine を追加する。

state は section ごとに `{ ranges, pending, infeasibleRanges }` を持つ。
epoch 開始時は入力・compact・fonts generation・probe box 寸法の変化で起こし、各 section を
全 item 1 range の初期状態へ戻す。

各 logical pass は、必要な exact probe id がすべて解決してから次の順に処理する。

1. 現在の ready/pending/infeasible range 数から `pageCount` を算出する。
2. `chromeSignature = { pageCount, reservationText, chromeLayoutVersion }` を作り、
   probe generation に含める。
3. chromeSignature が変われば、ready range を含む**全非 infeasible range**を pending に戻す。
4. 各 pending parent range を、その start/end 内に限定して `sequentialPartitionRanges` へ渡す。
   子 range の global offset を復元し、親 range を子 range だけで置換する。
5. fit は維持する。不適合かつ item 数が2以上なら子 range へ分割する。
   一度できた境界は epoch 内で削除せず、range の結合は行わない。
6. item 数1の range が chrome 込みで不適合なら、その range を terminal
   `infeasible` とする。live は既存の「表示領域不足」ページを表示し、再 probe 対象に戻さない。
7. pending が0で、pageCount・境界・infeasible 集合・量子化寸法が連続2 logical pass 一致した時だけ
   commit する。

### 3.3 probe delivery と logical pass の分離

probe の待機と収束判定は別の層として扱う。

- exact probe id は `partitionEpoch + chromeSignature + sectionId + range + probeBox` から作る
- 各 exact probe id は mount 時に `unresolved` とし、初回同期測定と `ResizeObserver` delivery を
  個別に記録する
- `contentHeight > 0 && availableHeight > 0` の有効測定を得た exact id だけを `resolved` とする
- 同一 parent range の候補探索で複数 exact id が順次必要になっても、それらは同一 logical pass の
  probe 作業であり、境界増加回数には数えない
- 各 exact probe id は、初回測定を含めて3回の測定機会を得ても有効測定を返さない場合だけ
  `partition-probe-unresolved` として失敗する
- 未解決診断は exact probe id ごとに出し、同一 chromeSignature 全体の delivery 回数では失敗させない
- 新しい exact probe id が生成された時点で、その id の測定機会は独立して数え始める
- 未解決 id が1件でもある間は logical pass を確定・commit しない

### 3.4 収束性と診断

epoch 内では range 境界と infeasible terminal が増えるだけで、減少・結合しない。
item 総数を N、section 数を S とすると、境界増加を伴う logical pass は最大 `N - S` 回で有限である。

stress fixture は N=72、S=4 のため、最大68回の境界増加後に停止する。
初期状態と連続一致確認を含む logical pass 上限は `N - S + 2 = 70` とする。
この上限は probe delivery 数ではなく、境界・terminal 状態を確定する logical pass 数だけに適用する。

- 寸法は0.01pxへ量子化し、同一判定は各幅・高の差が±1px以内とする
- fit 判定は既存どおり `contentHeight <= availableHeight + 1` とする
- 同一 epoch で直前以外の logical candidate signature が再訪した場合は
  `partition-cycle` 診断で失敗する
- 直前と同じ logical candidate signature は安定確認としてのみ許し、2回目で commit する
- logical pass 上限超過時は `partition-nonconverged` 診断で失敗する
- `infeasible` と `partition-probe-unresolved` は区別する。
  前者は内容が物理的に入らない terminal 表示、後者は測定不能による gate 失敗である

### 3.5 不採用案

反復回数だけを固定して全 section を毎回再 partition する案は採用しない。
境界の結合を許すため `A → B → A` の振動を構造的に除去できず、上限到達時の表示契約も曖昧である。

## 4. 対象ファイル

- `display/frontend/src/components/TsunamiPanel.svelte`
- `display/frontend/src/components/PageDots.svelte`
- `display/frontend/src/lib/page-attention.ts`
- `display/frontend/src/lib/legacy-standby/page-partition.ts`
- `display/frontend/src/lib/legacy-standby/types.ts`
- `display/frontend/src/components/__tests__/tsunami-panel.test.ts`
- `display/frontend/src/components/__tests__/page-dots.test.ts`
- `display/frontend/src/lib/__tests__/page-attention.test.ts`
- `display/frontend/src/lib/legacy-standby/__tests__/page-partition.test.ts`
- `display/frontend/src/components/__tests__/emergency.test.ts`
- `display/frontend/src/preview/PreviewApp.svelte`
- `display/frontend/src/preview/fixtures.ts`
- `display/scripts/capture-legacy-standby.mjs`

## 5. 受入条件（機械検証）

- unit: pageCount=10 で active index 0 と9の `PageDots` chrome 高が一致する
- unit: `1/10` と `10/10`、未読0と未読10を含む live chrome が予約 block を超えない
- unit: pageCount 増加時、確定済み coast range が全件 pending へ戻る
- unit: 同一 parent range 内の複数候補 probe が、境界増加前に複数 delivery を要しても誤失敗しない
- unit: exact probe id ごとに3測定機会で有効測定がなければ `partition-probe-unresolved` となる
- unit: split-only state machine が境界を削除せず、N=72/S=4入力で70 logical pass以内に
  stable または infeasible terminal へ到達する
- unit: `A → B → A` の非連続 logical candidate signature 再訪が `partition-cycle` となる
- unit: 単一 item 不適合は `infeasible` terminal となり、無限再 probe しない
- fixture: `attention-visibility-emergency` で tsunami / quake とも multi-page、
  infeasible=false、panel/body の縦横 containment と indicator overlap が0
- 実 browser: `npm --prefix display run build && node display/scripts/capture-legacy-standby.mjs --fixture attention-visibility-emergency --viewport 1280x720`
  が終了コード0となる
- 上記実走で probe/live の chrome 高・本文幅を geometry diagnostics に出し、不一致または
  containment 違反を非ゼロ終了とする
- `attention-visibility-standby` と `attention-visibility-reduced-motion` が緑
- `npm --prefix display test` が緑
- Chrome gate `node display/scripts/capture-legacy-standby.mjs --report` が18/18 match を維持する

