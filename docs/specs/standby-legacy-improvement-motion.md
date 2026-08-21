# 待機画面 従来フォーマット改良: 変化アニメーション scoped spec

`standby-legacy-improvement.md` §9 を実装可能な範囲へ詳細化する Unit 6-1 の
scoped spec。配置・stage の意味論、測定、受入の正本は同 spec の §4、§7、§9、§11.2
であり、本書はそれを変更しない。

## 1. 目的と境界

- 更新報によるカード自然高の変化、カードの追加・削除、stage 遷移を、変化の理由を
  追える静かな連続動作として描く。情報、key、最終配置を遅らせたり隠したりしない。
- stage 遷移は中央受け皿へ移るカードと側列へ戻るカードを対象とする。中央時計から
  ticker-clock への退避／復帰は別 DOM 間のクロスフェードとし、FLIP しない。App が
  同一の確定 stage で両時計の表示を切り替え、rect 仲介用 overlay は導入しない。これは
  ticker 全体を対象外とする本 spec の例外であり、ticker-clock 以外の ticker motion は
  変更しない。stage 0→3 のような多段確定も、同一 epoch の最終配置だけを論理状態として
  一回 commit する。途中 stage を状態・測定へ露出しない。
- カード内改ページと stage 3 輪番は U4 の時分割 scheduler が所有する。いずれも
  固定枠内の原子的な内容交代を保ち、カードの自然高・外側配置を変化させない。
  したがって本 spec の FLIP／高さいじりを改ページ・輪番の通常 tick に重ねない。
- tick の既存 opacity transition は §7 のままとする。本 spec が扱うのは tick と
  同時に起きた epoch/stage 更新での排他だけである。

## 2. 確定配置と描画層

- epoch coordinator が A0→比較器→B と bounded settle を完了した値を `final snapshot`
  と呼ぶ。card key、stage、surface、各列順、自然高、容量、診断属性はこの snapshot
  だけから決める。旧 snapshot と最終 snapshot の中間値を次 epoch の入力にしない。
- epoch を開始する直前に `preEpochCapture` hook を一回走らせる。表示 card の outer
  visual shell は `card key + surface` を identity とする要素 registry へ登録し、hook は
  現在の rect と旧本文を保つ shell をこの identity ごとに捕捉する。削除 shell もこの時点で
  取得し、final commit 後に registry/DOM を引き直さない。本文更新・surface 移動・削除の
  旧見え方は committed plan/selection から復元せず、この capture だけを始点とする。
- commit 時点で DOM の論理配置は最終 snapshot へ原子的に替える。測定棚、solver、
  `data-*-natural-height-px`、容量および overflow 判定はアニメーション中も最終の
  確定値を読む。補間は描画層だけであり、再測定・stage 判定・scheduler の key 集合を
  駆動しない。
- 高さ変化は最終レイアウトを保った visual shell（clip/overlay を含んでよい）で旧見え方
  から新見え方へ補間する。本文を scale して文字を歪めない。追加は最終位置で入場し、
  削除は論理配置から除いた後に旧 visual shell を一時保持して退場させる。
- 同一 key の位置移動（列間移動、中央受け皿）は手動 FLIP とする。変更前の
  可視 rect を読み、進行中 animation を cancel し、最終 rect を読んでから translate
  を補間する。既存 `transform` を壊さず、独立 `translate` を用いる。
- keyed sibling の単純な並べ替えだけは `animate:flip` を使ってよい。高さ・同一 key の
  surface/stage 移動・時計には使わない。layout motion の duration は
  `SPRING_SPATIAL_DEFAULT_MS`、easing は `springSpatialOut` に固定する。deadline はこの
  duration の 2 倍とし、新しい時間定数を導入しない。

## 3. 決定的完了と資源所有権

- StandbyScreen が layout motion coordinator を一つ所有する。run は source epoch と
  単調な run token を持ち、callback は token と animation identity の両方が一致するとき
  だけ現在 run を完了できる。
- Web Animations が使える場合、`Animation.finished` を一次の完了通知とする。fulfilled
  のみが自然完了であり、cancel による rejection は supersede/dispose として扱い、古い
  run を完了扱いにしない。
- 各 run は同じ token の deadline backstop を持つ。`finished` が来なければ deadline で
  animation を cancel し、最終 snapshot を残して一回だけ完了する。`finished` と
  deadline、`finish`/`cancel` callback は相互排他で、二重 commit・二重 timer を作らない。
- WAAPI を使えない環境では同じ token の timer fallback を使う。visual animation は省略
  しても、timer 後の再測定や追加の state 遷移を待たず、最終 snapshot が既に表示される。
  fallback は observability のための完了資源であって、論理配置を遅延させる手段ではない。
- 新 run、epoch/stage の supersede、unmount では旧 run の animation、deadline、fallback、
  一時 visual shell を必ず破棄する。dispose 後の promise/callback は何も描画・再 arm
  しない。既存 scheduler の timer/animation 所有権を layout coordinator へ移さない。

## 4. INV-排他

- epoch/stage 更新は進行中の時分割交代より常に優先する。順序は
  `preEpochCapture → epoch begin → scheduler transition cancel + hold → final commit →
  layout motion → scheduler release → pending tick を一回再評価` とする。active key は
  null を経由せず保持または後続 key へ原子的に替える。
- scheduler は公開する `holdForEpoch()` と `releaseAfterLayoutMotion()` を持つ。
  `holdForEpoch()` は in-flight transition を cancel して tick を pending 化し、stage と
  key 集合が不変の epoch でも必ず呼べる。`releaseAfterLayoutMotion()` だけが hold を解き、
  pending tick を一回だけ §7 の単調 tick 規則で再評価する。古い時刻を盲目的に再生しない。
- final commit は `flushSync` の同期境界で行い、epoch coordinator はこれが完了するまで
  `settle()` を呼ばない。`epoch.settle()` が listener を同期通知しても、その通知は
  scheduler を release/processTick してはならない。coordinator と scheduler の API 境界で
  hold を保ち、release は layout motion の natural completion、deadline、または fallback
  の後に coordinator 所有者が明示的に行う。前の tick transition が `finished`・deadline・
  epoch hold による cancel のいずれかで終端する前に、次の交代は開始しない。
- stage 3 退出時に破棄するのは輪番 scheduler の資源だけである。改ページ coordinator は
  §7.2・§7.4 の card 消滅または 1 ページ化まで保持する。layout motion の cancel は、
  これらの page state、pending、位相を reset する理由にならない。

## 5. reduced motion と非対象

- `prefers-reduced-motion: reduce` では layout motion、入退場、FLIP、visual shell を
  生成せず、最終 snapshot へ即時差替えする。カード、時計、全地域、輪番・改ページの
  到達機会は残す。時分割そのものは停止しない。
- ticker、緊急画面、津波・熱中症のマーキーは対象外である。それぞれの既存 motion と
  所有権を変更しない。カード内改ページ／輪番の tick 演出も §7 の範囲外では変更しない。

## 6. 受入と実装前提・回帰 gate

- 機械層は受入条件でなく実装前提・回帰 gate とする。§11.1 C の scheduler 共通 contract
  を輪番・改ページ・epoch 競合で再実行し、layout coordinator 自身の supersede、
  `finished`/deadline の相互排他、dispose 後 callback 無効化、layout motion と scheduler の
  animation/timer/一時 shell の unmount 後破棄を挙動・資源観測で検査する。視覚の滑らかさを
  jsdom の矩形や duration assertion だけで合格としない。
- 人間受入は §11.2「変化の体感」の目視 packet のみとする。通常更新の高変化、追加・
  削除、時計退避／復帰、中央受け皿移動、stage 3 からの復帰、reduced-motion を動画または
  連続キャプチャで提出し、「変化に気づけない／うるさい」を反証条件とする。
- packet には viewport、fixture、開始／最終 stage、更新した card key、reduced-motion の
  有無、tick と epoch が競合したかを添える。§11.2 の GO/NO-GO がない main 合流はしない。
