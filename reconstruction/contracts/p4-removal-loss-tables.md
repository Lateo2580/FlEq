# P4-REMOVAL-LOSS-001 の設計の表 r1（H17 の消えた理由と H39 の件数）

- 起草日: 2026-11-21（起草の子 r0）。木は main 37fbd7f3（draft/p4-rl）。行番号は全部この木。
- r1（2026-11-22）: 作者の分岐 5 と統合担当の分岐 5 の確定（契約の meta.decisionBranches）と、同日未明の U-W の量り（repo の外の `p4-uw-mixed-cell-count.md`、契約の Q-RL-MIXED-FREQUENCY）に合わせた。
- 入力の事実: 事実の表 r0（作業ノートの外の `p4-vocab-facts-r0.md`、行番号は 093dc8b9）と、ヘルツの確かめ（`hz-facts-r0.reply.txt`、行番号は 37fbd7f3）。食い違う所はヘルツの返事を正にした。下の表の行番号はヘルツの返事と、この起草で開いた行から取った。
- 採らないもの: B0 の表 r7（f3b61acf の `p4-display-wire-tables.md` §13.2）の removals の決め方。同じ step の outcome と losses を下流で突き合わせる形で、ヘルツの返事の 3・4 のとおり、(1) 同じ回に原因が混ざる、(2) owner の返信（`owner-host.ts:408`〜`:424` の output）が前置きの期限と受信を 1 つに平らにする、(3) 停止の確定では displayChanges しか新しい射影に届かない（`composition-root.ts:1601`）、(4) 取り直しの採用で accepted が失われ正味の差分だけになる（`owner-runtime.ts:708`〜`:709`）、(5) LossTally は publisher に届かない。r7 の hasHole の読み（§13.2 の `hole`）も採らない（§2.3）。
- 作者の裁定（2026-11-21 22:2x）: 理由が分からない消え方は「理由不明で消えた」と出す。ふだん起きる消え方（期限切れ・押し出し）は unit の側で理由を残すように直し、「理由不明」はめったに出ない形にする。wire は unknown を値として運び、描き方と何秒出すかは C2 の板。

## 0. 結論

- 消えた理由は、after が null の表示差分（RuntimeDisplayChange）そのものに unit が載せる。載せるのは消える所（容量の退去・期限の回収・取消・解除・置き換え）で、outcome の transition の字からは引かない（字は分野で食い違う。事実の表 §2.3 の字の表）。
- この形は 21 組の全部と、U-W・U-Q の鍵の食い違い・停止の確定・前置きの期限と受信の平らな返信を、unit の 1 か所で満たす（§1.2・§1.3）。
- 満たさない所は 2 つ。取り直しの採用（正味の差分を state の比べで作り直すので、差分に載せた理由が消える）と restore（owner が after の null を捨てる）。採用は候補が理由を持ち運ぶ扱いを足す（§1.4 の 1）。restore は消えたと出さない（§1.4 の 2、P4-RL-D-RESTART=A）。
- 行の中の一部（U-W の府県の行の区域・現象）が消える場合は after が null にならないので、この形の外になり、理由を付けない（P4-RL-D-CELL=A）。ふつうの報の status 解除も、解除の区域が行を作るので府県の行を消さず、こちらに入る。
- H39 の件数は owner の LossTally を `OwnerUnitDelta` に載せて publisher へ運ぶ（§2.2）。件数の分からない欠けは hasHole をそのまま読まず、確認の判定とは別の読み手を足す（§2.3）。H28 の未確認の区間は publisher が 10 分後に H39 の値へ移す（§2.4）。

## 1. 最初の作業: 理由を after が null の差分に載せる形の当てはめ

### 1.1 決まり

- **removal の定義**: 表示差分で `after == null` かつ `before != null`。ほかの差分（after が null でない）は消えたことにしない。
- **理由の閉集合（DisplayRemoval）**。各語の「無いと何が壊れるか」を 1 行で書く。

| 語 | 意味 | 出す所 | 無いと何が壊れるか |
|---|---|---|---|
| cancelled | 取消の報で消えた | 各 unit の取消の受理 | H17 の「取消は画面に出す」が出せない |
| ended | 解除・終了・消滅の報で消えた（U-Y の確率 zero を含む。U-W の府県の行は VPNO50 の終了だけで、ふつうの報の status 解除では行が消えない） | 解除・最終報・消滅の受理 | 解除で消えたものが理由不明になり、「理由不明はめったに出ない」が崩れる |
| expired | 表示の期限（currentUntil・期限の回収・保留の確定）で消えた | 各 unit の期限の回収 | H17 の期限切れが出せない |
| retentionEnded | 取消・終了の後も残していた記録が保持の期限で消えた（U-Q の取消済みの地震、U-F の取消・noActiveItems の記録） | 保持の期限の削除 | 取消済みの地震が一覧から外れるのを「期限切れ」と出し、取消の後に期限が切れたように読める |
| evicted | 容量で押し出された | 各 unit の容量の退去 | H17 の押し出しが出せない |
| replaced | 別の系列の報・新しい版に置き換わった（U-B の replaced・aliased、U-W の全国報の入れ替え `weather-current.ts:700`〜`:702` と報の更新 `:703` で府県の行が消えたとき） | U-B の受理、U-W の府県の行 | 置き換えを ended か unknown に読み替えることになる（H51） |
| unavailable | 読めない・決められない印（H51）に替わった（U-W の取消で戻す版が無い historyUnavailable で報の current が外れ、府県の行が消える。`weather-current-unit.test.ts` の no-history の回。capacityUnavailable で同じことが起きるかは読んでいない） | U-W の unavailable の置き換え | 同上（H51） |
| markCleared | 情報を持たない行（before.current が null の U-W の監視の行）の印が解けた（coverageConfirmed） | U-W の監視の行 | 型が理由を必ず求めるので、監視の行に unknown を入れることになり、unknown の少なさを試験で見られない |
| mixed | 取り直しの採用の正味の差分で、同じ府県の行に 2 つ以上の原因（P4-RL-D-MIXED=B） | 採用（§1.4 の 1 の (5)） | 置き換えも重なった行を 1 つの原因で出す（作者裁定 B と食い違う） |
| unknown | unit にも分からない | §1.4 の 1 の残り、unit が分からない所 | 作者の裁定の「理由不明」 |

- **型で強いる**: `after` が null の差分は removal を必ず持ち、null でない差分は持たない（判別共用体）。無いと: 12 unit のどれかの消える所が理由を付け忘れても、コンパイラが止めない。
- **付ける所**: 各 unit の内側の変化（`Change` の組や `changed(before, after)` の呼び出し）を作る行で、消える原因を知っている所が付ける。表示差分にまとめる所（各 unit の merged の Map と push、下の表の「合流」）は理由を作らない。
- **合流の規則（1 つ）**: 同じ subject の変化をまとめるときは、最初の before と最後の after を取り、removal は最後の変化が after を null にしたときのその変化の removal。owner の output（`owner-host.ts:408`〜`:424`）・publisher の wireChanges（`composition-root.ts:1601`）・display-wire の changesOf（`display-wire.ts:580`〜`:584`、最後が勝つ）も同じ規則で、removal は差分と一緒に運ばれる。
- **読み手の絞り**: wire の消えた理由の列に載せるのは、before.current が null でない差分だけ（owner-runtime の leaving と同じ見方、`owner-runtime.ts:361`〜`:362`）。markCleared の差分は値として運ぶが列に載せない。

### 1.2 21 組（事実の表 §2.3・ヘルツの返事の 4）

列: 消える所（unit が理由を知る行）／単独（その原因だけで消える回）／混在（同じ step に別の原因が混ざる回）／判定。合流はどの組も各 unit の merged と push（U-E `eew-unit.ts:302`〜`:311`、U-W `weather-current-unit.ts:746`〜`:781`、U-F `weather-timeseries-unit.ts:576`、U-T `tsunami-unit.ts:930`、U-Q `seismic-unit.ts:1372`、U-N `nankai-unit.ts:701`、U-V `volcano-unit.ts:1367`、U-L `landslide-unit.ts:515`、U-R `flood-unit.ts:573`〜`:578`、U-B `briefing-unit.ts:716`、U-M `local-bulletins-unit.ts:711`、U-Y `typhoon-unit.ts:631`）。

| 組 | 消える所 | 単独 | 混在 | 判定 |
|---|---|---|---|---|
| U-E 押出 | `eew.ts:590`〜`:597` の evicted の changed(item, null) | evicted | 同じ受信で別の subject の採用・期限と並ぶが、差分は subject ごと | 満たす |
| U-W 押出 | 件数の退去 `weather-current.ts:664`〜`:670`（training・test の最古の partial だけ。normal は退去せず容量の unavailable）と byte の退去 `weather-current-unit.ts:440`・`:443`（normal の候補のときに training・test の current を外す）。`:672`〜`:697` の履歴の深さの退去は current を外さず行を変えない（府県の行は `weather-current-unit.ts:747` の callback で報の変化を受け、`:780` の rowChanges で作る） | 府県の行の全部の区域がその報から来ていたら evicted | 1 回の受信では原因の違う 2 つが同じ府県の行を消さない（取消は件数の退去の前に return、byte の退去は normal の行と別の subject。Q-RL-MIXED-FREQUENCY (4)）。行が残る回は理由を付けない（P4-RL-D-CELL=A）。2 原因は取り直しの採用で束ねたときだけ（§1.4 の 1 の (5)） | 満たす（府県の行の規則を足す） |
| U-F 押出 | `weather-timeseries-unit.ts:262`〜`:269` の training・test の退去 | evicted | 保持の削除（`:137`）と同じ step に並ぶが、削除の所と退去の所が別なので subject ごとに分かれる | 満たす（H39 の件数は §2.1 の U-F の行を足す） |
| U-T 押出 | `tsunami-unit.ts:669`〜`:682` | evicted | 期限の保留と見えない記録の退去が同居。見えない記録は表示差分を作らない | 満たす |
| U-Q 押出 | 受信の退去 `seismic-unit.ts:781`〜`:787`、期限の予約の超過 `:1234`〜`:1246` | evicted | 予約の超過が取消済みの一覧の保持削除（`:1209`）と同じ collect に並ぶ。所が別なので subject ごとに evicted と retentionEnded | 満たす |
| U-N 押出 | `nankai-unit.ts:473`〜`:492` | evicted | 自分自身の退去は表示に出ない。期限で消えた情報とは所が別 | 満たす |
| U-V 押出 | `volcano-unit.ts:1030`〜`:1054`・`:1095`〜`:1108` | evicted | 複数 entry の退去と受信の中の期限の回収（`:1095`）が同じ reduce。所が別 | 満たす |
| U-L 押出 | `landslide-unit.ts:304`〜`:319` | evicted | 前置きの期限（owner の `:483`〜`:484`）は別の reduce の呼び出しで差分も別 | 満たす |
| U-R 押出 | `flood-unit.ts:411`（changes の [evicted, null]） | evicted | 前置きの期限は別の reduce | 満たす |
| U-B 押出 | `briefing-unit.ts:435`〜`:451` | evicted | 前置きの期限は別の reduce | 満たす |
| U-M 押出 | `local-bulletins-unit.ts:446`〜`:460` | evicted | 無言の期限の保留は所が別 | 満たす |
| U-Y 押出 | `typhoon-unit.ts:379`〜`:392` | evicted | 連動で終わる確率・保留は所が別 | 満たす |
| U-W 取消 | `weather-current.ts:634`〜`:659`（取消で戻す版が無ければ historyUnavailable の置き換え） | 府県の行が消えれば cancelled。戻す版が無く unavailable に替わったら unavailable | 1 回の受信では別の原因と重ならない。取り直しの採用で束ねたときは §1.4 の 1 の (5) | 満たす（府県の行の規則） |
| U-W 解除 | 通常の報の区域の status 解除（`weather-current.ts:724`〜`:725`）・VPNO50 の終了（`:630`、`:547`〜`:558` の endSnapshot が 3x の行を外す） | status 解除では府県の行は消えない（解除の区域も行を作る、`weather-current-public.ts:165`。福井の警報→解除で区域 14→0、行は残る）。VPNO50 の終了で府県の行が特別警報だけなら消えて ended（読みだけ） | 同上 | 満たす（府県の行の規則）。status 解除は行が残るので理由を付けない（P4-RL-D-CELL=A） |
| U-F 保持削除 | `weather-timeseries-unit.ts:137`（retainUntil） | retentionEnded | 退去と同じ step。所が別 | 満たす |
| U-Q 地震期限 | collect の寄与の期限（`seismic-unit.ts:1203`〜`:1213`）。表示の鍵は `operation/earthquake/eventId` | expired | unverified の保留は消える時と outcome の時が別だが、消える所（verified の collect）で付けるので鍵も時も合う | 満たす（鍵の食い違いを越える） |
| U-Q 保持削除 | `seismic-unit.ts:1209` | retentionEnded | 予約の超過の退去と同じ collect。所が別 | 満たす |
| U-V 解説期限 | `volcano-unit.ts:1190`〜`:1205` | expired | 遅着・退去と同じ reduce。所が別。遅着は P4-RL-D-LATE | 満たす |
| U-L 期限 | `landslide-unit.ts:398`〜`:426` の collect | expired | 遅着の取消・解除でも無言で消える（`:357`〜`:368`）。P4-RL-D-LATE | 満たす |
| U-R 期限 | `flood-unit.ts:452`〜`:470` の collect | expired | 前置きの回収と押出が 1 つの返信に並んでも、差分ごとに理由を持つ | 満たす |
| U-B 期限 | `briefing-unit.ts:589`〜`:595` | expired | 遅着の採用も `subjects=[]` で旧表示を消す。受信の所が自分の原因（replaced・cancelled など）を付ける。P4-RL-D-LATE | 満たす |

受信の中の回収 (b)（事実の表 §2.2、U-Q `seismic-unit.ts:1031`〜`:1051`・U-L `landslide-unit.ts:357`・U-N `nankai-unit.ts:473`・U-V `volcano-unit.ts:1095`）: collect が消した subject に expired を付ける。同じ受信で受けた報がその subject の取消・解除・置き換えのときは報の原因が勝つ（P4-RL-D-LATE=A）。どちらも消える所で決まるので満たす。

### 1.3 21 組の外の行

| 行 | 今の動き | 理由を差分に載せる形で | 判定 |
|---|---|---|---|
| U-W・U-Q の鍵の食い違い | outcome は報・寄与の subject、表示は府県・地震の subject（ヘルツの返事の 1 (b)） | 理由は表示の subject の差分に直接付くので、鍵を突き合わせない | 満たす |
| 前置きの期限と受信の平らな返信 | `owner-host.ts:135` は [forced, step] を 1 つの output に流す | 差分ごとに理由を持つので、平らにしても落ちない | 満たす |
| 停止の確定（finalizeDone） | publisher は `reply.output.displayChanges` だけを wireChanges に積む（`composition-root.ts:1601`）。outcomes は wire に渡らない | 差分と一緒に理由が届く | 満たす |
| 停止の入力（shutdownInput） | U-R などの deadlineStep が期限の回収を出す（`flood-unit.ts:558`） | 差分に expired が付く | 満たす |
| 取り直しの採用 | `owner-runtime.ts:708`〜`:709` が期限の step の差分を空にし、`recoveryChanges`（live → 採用の state の比べ）で作り直す。候補の各 step の差分は `applyCandidate`（`owner-host.ts:196`〜`:203`）が持たない | 比べで作る差分は原因を知らない | **満たさない**（§1.4 の 1） |
| restore | owner は `after != null` だけを `before=null` で渡す（`owner-runtime.ts:438`〜`:439`）。8 unit は restore の中の collect で消えた記録の差分を作らない（ヘルツの返事の 2）。U-R は restore で collect を呼ばず全部を戻し、owner-host の restore が直後に `deadlineOwner`（`owner-host.ts:286`）を当てるので、期限の回収の差分が restored の返信に並ぶと読んだ（2 つの読みを結んだもので、試験では見ていない）。U-E は current を保存しない。U-W は期限が無い。U-F は restore の collect が無言（`weather-timeseries-unit.ts:483`） | 差分そのものが無い（U-R だけ restored の返信に追加と消失が並ぶ） | **満たさない**（§1.4 の 2） |

### 1.4 満たさない行の扱い

1. **取り直しの採用**: 候補（owner-host の Candidate）が、shadow に当てた各 step の差分のうち after が null のものの removal を、表示の鍵（operation と subject）の Map に持つ。同じ鍵に after が null でない差分が後から来たら外す。当て直し（`owner-host.ts:229`〜`:230`）では cancelled と同じく空にして作り直す。採用（`adoptRecoveryOwner`）は、期限の step の差分を空にする前にその removal も Map に足し、`recoveryChanges` の正味の差分のうち after が null のものに Map の値を付ける。Map に無ければ unknown。
   - 無いと: 切断の後の取り直し（H26）で消えたものが全部 unknown になり、「理由不明はめったに出ない」が崩れる。
   - 鍵: `recoveryChanges` は unit の reduce と同じ鍵（U-W は府県の行、U-Q は `keyOf`）で作るので、shadow の差分の鍵と合う。`candidate.cancelled`（outcome の subject の鍵）は使わない。
   - 保存しない（候補は owner の手元だけ）。
   - (5) mixed（P4-RL-D-MIXED=B）: 候補は、shadow の各 step で府県から外れた報の変化の原因を、府県の行のキーごとに集める（行が残った step も）。上の「after が null でない差分が来たら外す」は removal にだけ当て、集めた原因を外すのは行が消えて戻ったときと当て直しのときだけ。正味の差分で消えた府県の行は、集めた原因が 1 種ならその語、2 種以上なら mixed。departed の型の欄は発注 1、U-W が付けることと候補の集めは発注 2。1 回の受信では原因の違う 2 つが同じ府県の行を消さないので、mixed が付くのはここだけ。集めた原因は候補の手元だけで、保存せず wire に載せない（P4-RL-D-CELL=A のまま）。行が残った step の原因は、RuntimeDisplayChange の after が null でない側の任意の欄 departed（U-W の府県の行だけ、その step で府県から外れた報の原因の語）で候補へ渡す（統合担当の決め 2026-11-22 07:2x、契約の Q-RL-MIXED-CARRIER）。返信の形に置くと unit の step・owner-runtime の step・owner-host の 3 か所に欄が要るので、型 1 か所の差分の側に置く。publisher・display-wire は読まない。無いと: 判断カードの 2 の場面で、最後に行を消した step の原因 1 つを出す。
2. **restore**: 再起動の間に消えた記録は差分が無い。消えたとは出さない（P4-RL-D-RESTART=A）。publisher は restored の返信の差分を wire の消えた理由の一覧に載せない（U-R の追加と消失の並びもここで落ちる）。止まっている間に期限で終わったことそのものは、画面のどこにも残らない（H32 の起動時のダイジェストは止まっていた間に出た電文を dmdata の一覧から作るもので、新しい電文が無く期限で終わっただけのものは載らない、spec 16.2.3）。

## 2. H39 の件数

### 2.1 16.2.6 の箇条と値

| 16.2.6 の箇条 | 値 | 出どころ |
|---|---|---|
| 落としたもの | notificationExpired・notificationExpiredClockUnverified・notificationCapacityEvicted の件数 | owner の LossTally（`p2-shared-runtime.types.ts:547`〜`:551`） |
| 押し出したもの | 各 unit の *CapacityEvicted・seismicStationsFolded・noticeMarkEvicted・unreadableDropped の件数 | 同上。U-F は今 UNIT_EVICTION に無く（`checkpoint.ts:648`〜`:651`）、退去の診断も出さない（ヘルツの返事の 1 (c)）。U-F の退去の語を足す |
| 取りこぼしたもの | capacityRejected の件数と、件数の分からない欠け | 件数は LossTally、欠けは §2.3 |
| 通知したか不明（H48） | notificationOutcomeUnknown の件数 | LossTally |
| 読めなかった EEW と津波（H43） | unreadableReport の件数（12 unit とも運び、どれを描くかは C2） | LossTally |
| 照合できないまま時間がたった EEW の未確認（H28） | 10 分で外した区間の数と最後の区間 | publisher（§2.4） |
| 件数の分からない欠けを 0 件と出さない | unit ごとの欠けの真偽。穴を持たない unit（U-E・U-F）は null（追えない） | §2.3 |
| 原文は器の都合で消えた（H51） | unreadableDropped（押し出したものに入る） | LossTally |
| 対応の無いもの | 保存の失敗（16.3 の案、P4 の別の契約）。mailbox と host が断った入力（unit が決まる前、P3-NL-AC14 (8)）は件数でなく §2.3 の欠けで出る | — |

- 見えない記録の退去も件数に入る（例: U-E の gate、ヘルツの返事の 4 の U-E）。数える理由の閉集合は P3-NL-AC14 (3) で決まっていて、本契約は U-F の 1 語を足すだけ。

### 2.2 件数を publisher へ運ぶ道

- owner の state の losses（unit ごと）→ `OwnerUnitDelta` に `losses`（null は変わらない）→ publisher の mirror の unit ごとの losses → 新しい射影。
- 「変わった」の比べ方は pendingIntents と同じ（`owner-host.ts:402`〜`:406`）。前に報告した losses の参照と今の参照が違えば書く。
- 件数だけが変わった入力は世代を進めて changed に入る（`owner-runtime.ts:279`〜`:282`）ので delta に載る。カード（addCard）と採用（adoptRecoveryOwner の losses の差し替え）も changed を呼ぶ。capture が 24 時間を過ぎた行を外す所（`owner-runtime.ts:590`〜`:594`）は state の losses を書き換えるが changed を呼ばないので、次にその unit が delta に載るときに参照の違いとして届く（それまで publisher には外した行が残りうる。表示の古さは最大でその unit の次の変化まで）。restored の返信は全 unit の delta を持つので、復元した行も届く。
- 旧 `/events` の出力と view は変えない。

### 2.3 件数の分からない欠け（hasHole をそのまま読まない）

- 事実（ヘルツの返事の 1 (g)、事実の表の確かめ 1）: 接続の無い回の採用で `confirmable` の印が付いた後に新しい拒否が来ると、`hole()` の `oldestHole ??= opened`（`checkpoint.ts:903`）が古い印を残し、`hasHole`（`:887`）は偽のまま。H39 が hasHole を読むと、次の取り直しの採用まで欠けを 0 件と出す。
- 扱い（P4-RL-D-HOLE=B）: InputBoundaries に unit ごとの「印の後に開いた穴」の印を足し、`hole()` で oldestHole が confirmable のときに立て、`resolve()` と `advanceHole()` で下ろす。H39 の読み手は `hasHole(unit) || 印` を読む。確認を出す判定（`composition-root.ts:2320`）と `hasHole` は変えない。
- 採らなかった A（`hole()` が confirmable を外し、hasHole の意味を変える）は、確かめ 1 の「証拠不足の 1 点」（settleAdopted と recoveryAdopted の間の await）も閉じるが、P3-RB-AC07 (3) の振る舞いを変える。採るなら構造的欠陥台帳の項として別に扱う。

### 2.4 H28 の未確認の区間を H39 へ

- 事実（ヘルツの返事の 1 (h)、事実の表の確かめ 2）: 10 分後の最初の tick で札を外し（`watch.ts:150`〜`:156`）、行き先は publisher の WARN 1 件だけ（`composition-root.ts:2358`〜`:2360`）。owner の LossTally にも B0 の wire にも入らない。
- 扱い: `noteEewWindow`（10 分の tick の `composition-root.ts:1985` と、停止の開始で札を履歴へ出す `:1694` の 2 か所から呼ばれる、P3-REC-AC14 (5)）が外した区間を publisher の手元の値（件数と最後の区間の from・to）に足し、新しい射影が H39 の U-E の欄に載せる。保持は LossTally と同じ最後の追加＋24 時間。publisher の手元だけに持ち、再起動で消える（P4-RL-D-EEW-WINDOW=A）。区間を外してから 24 時間以内に再起動すると H39 の EEW の欄からその区間が消え、記録は WARN の診断の 1 行に残る。

## 3. wire に足すもの

- 版を上げる（`display-wire.ts:27` の `p4-display-wire-v1` の次。P4-DW-D-SCOPE-NARROW の「display の版を上げる」）。
- **消えた理由の一覧**: 1 件は `{ unit, operation, reason, at, ref: { id } }`。id は B0 の ref と同じ sha256([unit, operation, subject])（`display-wire.ts:112`〜`:114`）で、描画は前の snapshot の要素と id で結ぶ。at は射影した時の publisher の wall。分野ごとに新しい 4 件を残し、古いものから落として分野ごとの外した件数を数える（12 分野で最大 48 件、P4-RL-D-WIRE-CAP=B）。一覧は stream ごとで、新しい streamId で空に戻る。
- **H39 の欄**: unit ごとに LossTally の行（reason と count。lastAt は載せない）と欠けの真偽（U-E・U-F は null）、U-E にだけ H28 の区間の件数と最後の区間。形は理由の行をそのまま（P4-RL-D-H39-SHAPE=A）。共通部の余りが負なら B（B0 の表 r7 の 5 区分と詳細の part）に替える。
- **勘定**: 足すものは共通部（65,536、今の上界 49,443、余り 16,093。B0 の表 §12）に入れる。script `p4-display-wire-max.mjs` に足して最大を出し、余りが負なら exit 1。起草の見積もり（script を回していない）: 理由の行は 12 unit × 最大 9 行で約 6,000 byte、消えた理由の列は B で 48 件 × 約 150 byte で約 7,200 byte。合わせて約 13,200 で余りに入る見込みだが、P4-DISPLAY-VOCAB-001 が共通部に足すものと合わせて数える。
- 比べ: 列と H39 の欄は前の snapshot の object を使い回し、参照で比べる（notices と同じ、`display-wire.ts:602`）。

## 4. 触る file と «» と直列

| file | 触る所 | «» で引く契約の行（main 37fbd7f3 で数えた） |
|---|---|---|
| `contracts/p2-shared-runtime.types.ts` | RuntimeDisplayChange（:235〜:241）に removal と departed（§1.4 の 1 の (5)）、DisplayRemoval、LossReason と DiagnosticReason に U-F の退去の語 | 53 本（21 契約） |
| `contracts/p3-execution-split.types.ts` | OwnerUnitDelta に losses | 21 本（10 契約） |
| `contracts/p4-display-wire.types.ts`・`contracts/p4-display-wire-max.mjs` | §3 | 0 本・2 本 |
| `src/runtime/owner-runtime.ts` | adoptRecoveryOwner に候補の Map（restore の渡し方は変えない、P4-RL-D-RESTART=A） | 78 本（34 契約） |
| `src/runtime/owner-host.ts` | Candidate の Map、delta の losses | 50 本（21 契約） |
| `src/runtime/shared-runtime.ts` | MirrorUnit・applyDeltas の losses | 18 本（9 契約） |
| `src/runtime/composition-root.ts` | wireInput に losses・欠け・H28 の区間、restored の差分の扱い、noteEewWindow | 228 本（49 契約） |
| `src/checkpoint/checkpoint.ts` | UNIT_EVICTION に U-F、InputBoundaries の印（P4-RL-D-HOLE） | 46 本（16 契約） |
| `src/checkpoint/persistent-diagnostic-sink.ts` | U-F の退去の語を既知の理由に | 42 本（14 契約） |
| `src/view-projector/display-wire.ts` | §3 | 0 本 |
| 12 unit の reducer と、変化を作る domain の file | 消える所に理由、合流の規則 | eew.ts 141・eew-unit.ts 34・weather-current.ts 59・weather-current-unit.ts 55・weather-timeseries-unit.ts 46・tsunami-unit.ts 104・seismic-unit.ts 148・nankai-unit.ts 126・volcano-unit.ts 132・landslide-unit.ts 54・flood-unit.ts 38・briefing-unit.ts 52・local-bulletins-unit.ts 20・typhoon-unit.ts 21 |

- 行の中の書き換えを原則にする。行を足すなら、引く行の少ない所（関数の末尾・file の末尾の export の前）に寄せる。足した file は統合担当が配送の commit で reanchor-target.py で付け直す。
- 直列（計画 §3.2）は P4-RL-D-ORDER=A で確定:
  - unit の file（eew.ts・seismic-unit.ts・tsunami-unit.ts）: B0（済み）→ P4-EEW-NO-INTENSITY-001（済み）→ **本契約** → E0 発注 1 → N0 → T0。ほかの 9 unit の file は計画 §3.2 の直列に無い。N0 発注 3 は本契約より先でよく、本契約は発注 3 の後の木で行を読み直す（計画 §1.3 の N0 の行）。P4-TSUNAMI-MULTI-EVENT-001 は直列の外で先に入る（同契約の P4-TME-D-ORDER）。
  - `display-wire.ts`・`p4-display-wire.types.ts`・`composition-root.ts` の wireInput: B0（済み）→ P4-DISPLAY-VOCAB-001 → **本契約** → B1 → E0 発注 1。
- 発注は 2 つ（P4-RL-D-SPLIT=A）。発注 1 は型（departed の欄を含む）・owner・publisher・wire・checkpoint・U-F の件数で、unit は after が null の差分を作る所（reduce の合流、10 unit の recoveryChanges〔U-E・U-F に無い〕、U-W の rowChanges）で unknown を付ける。recoveryChanges の値は採用で §1.4 の 1 の Map の値に置き換わる。発注 2 で 12 unit が消える所に理由を付け、U-W が departed を付けて候補が原因を集める（§1.4 の 1 の (5)）。新しい wire は S0 まで試験の client だけなので、発注 1 と 2 の間に unknown だけの値が流れても画面は変わらない。

## 5. 計算量と保存

- 受信 1 回で、理由の付与は変化の数に比例する（消える所で 1 語を付けるだけ）。府県の行の規則は、その step で作り直す府県（`weather-current-unit.ts:769`〜`:771` の areas）について、効いた報の原因を数えるだけ。候補の Map は shadow の差分の数に比例し、上限は unit の記録の上限。府県の行の原因の集め（§1.4 の 1 の (5)）は shadow の step ごとに作り直す府県の数に比例する（区域の数に比例しない）。departed は、作り直す府県を集める今の走査（`weather-current-unit.ts:769`〜`:771`、変わった報の before・after の areaKeys を 1 回ずつ見る）の中で、before に府県があり after に無い報の原因を足すだけで、変わった報の区域の数の和に比例する。件数の運びは unit ごとに最大 9 行。wire の列は 1 件の追加が O(1)。state や intent の全体を直列化しない。
- 保存の形: unit の payload は変わらない（理由は差分にだけ載り、保存しない）。LossTally の閉集合に U-F の 1 語が増えると、読み戻し（`checkpoint.ts:669`〜`:685`）は広がるだけで旧い保存は読める。足す語は `weatherTimeseriesCapacityEvicted`（32 字）。`LOSS_TALLY_MAX_BYTES`（`checkpoint.ts:659`〜`:661`、閉集合の長い順の 9 語）は、今の 9 番目（22 字の tsunamiCapacityEvicted ほか）がこの語に替わるので 10 byte 増え、これを足す 12 unit の envelope の上限の予約も 10 byte ずつ増える。数を固定で見る試験があればその書き換えだけ許す（契約の AC10 (3)）。新築の開発の保存は P5 の前は初期化してよい（p3plan:498）ので、版の移行は作らない。

## 6. 確かめられなかったこと

- 台帳 144〜146（許可 root の外）は開いていない。中身は B0 の契約（P4-DW-D-SCOPE-NARROW の reason）と依頼文の要約から読んだ。
- 9 unit（U-E・U-W・U-F・U-T 以外）の消える所の行は、ヘルツの返事の行番号を使い、全部は開いていない。発注前点検で各行の中身を読み直す。
- U-W の府県の行（2026-11-22 未明に量った、契約の Q-RL-MIXED-FREQUENCY）: 手元の corpus では府県の行が消えた回が 0 で、2 原因で消える回の頻度は分母 0 のため量れていない。1 回の受信の reduce で 2 原因が同じ行を消さないことはコードの読みで、試験では見ていない。VPNO50 の終了で府県の行が消える回（3x だけの府県）は読みだけで、走らせていない。取り直しの採用で 2 原因になる回は量っていない。
- §3 の byte は見積もりで、script を回していない。
- 8 unit の restore の codec が容量を越えた記録を削るかは読んでいない（restore の中で消える原因が期限と保持だけという読みは、ヘルツの返事の 2 による）。
