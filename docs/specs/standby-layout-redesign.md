# 待機画面レイアウト再設計

> Status: implementation-ready specification
>
> Decision date: 2026-08-11
>
> Scope: `display/` の待機画面、待機カード投影、火山 Lv2+ 投影/active state、気象全量 roster/注目更新の chunk transport、熱中症 targetDate 集約

## 1. 目的と非目標

### 1.1 目的

本仕様は、待機画面の右側カード群が縦方向の高さを奪い合い、重要情報がカード単位またはカード内の行単位で非表示になる問題を解消する。

設計の錨は次のとおりとする。

1. active な既知カードを高さ不足だけを理由に表示対象から落とさない。
2. カード内の反復情報は、複数列とページ切替によって全件へ到達可能にする。
3. 緊急度の高い更新は自動巡回を待たず、更新箇所を含むページを直ちに表示する。
4. 全 domain の最高状態と active 件数は aggregate anchor へ常時残し、個々の名前・レベル・種別は詳細より優先する上位ページで失わず到達可能にする。
5. DOM のはみ出しを `overflow: hidden` で黙って隠すことを収容策にしない。

この変更は、2026-08-11 の実機観測で確認された次の事象を直接の対象とする。

- 火山カードが高さを占有し、台風カードが compact 化されても右上から落ちた。
- 暴風警報の対象地域拡大が `ほか N 地域/項目` に吸収され、更新箇所を確認できなかった。
- 台風、火山、気象、竜巻などが同時 active のとき、高さ予算とクリップが複数段で働き、最終的な不可視化の理由が利用者から判別できなかった。

### 1.2 非目標

- emergency 画面のパネル優先順位、主役・副役レイアウト、気象 L4/L5 昇格条件は変更しない。
- ticker、CLI formatter、通知音の意味論は変更しない。
- standby persistence の domain salvage 方針は本仕様へ統合しない。
- ページ位置、強調表示の残存時間、直前 snapshot は永続化しない。
- すべてのカードを同じ表示密度に揃えない。安全情報の固定アンカー/上位ページと低頻度の詳細領域は明確に分ける。

### 1.3 用語

- **右側ドック**: 待機画面右側で、気象警報、右寄せ洪水、火山、台風、熱中症の各カードを収容する grid container。
- **aggregate anchor**: dock pager 横に常設し、全 domain の最高状態と active 件数を同時表示する有界な一覧。
- **固定アンカー**: card が属する dock page の表示中、card page に依存せず表示するカード見出し、最高状態、active 件数。高さを有界にする。
- **上位ページ**: 名前、レベル、警報種別など「何が active か」を失わず列挙するため、固定アンカー直下で巡回する領域。詳細ページより優先して表示する。
- **詳細ページ**: 対象地域、火山の補助情報、台風の諸元など、反復する詳細行を載せるページ領域。
- **注目更新**: emergency 画面へ遷移しないが即時の可視化を必要とする新規、追加、格上げ、同段階の意味更新、解除、格下げ。
- **変更エコー**: 解除・格下げで現行 DTO から消えた旧値を、変化を知らせるため frontend が一時的に保持して描画する行。

## 2. 表示領域と解像度

### 2.1 右側ドックの列数

右側ドックは viewport 幅そのものではなく、ドックの利用可能 inline size を container query で判定する。

- viewport 幅が 1280px 未満、または viewport 高が 720px 以下の場合は、利用可能幅にかかわらず 1 列とする。
- 上記の強制縮退に該当せず、右側ドックの container inline size が 744px 以上の場合は 2 列とする。
- 上記以外は 1 列とする。
- 24 インチ FHD 相当は必ず 2 列になることを preview の受入条件とする。
- 720p は必ず 1 列になることを preview の受入条件とする。

744px は、現行の標準カード幅 360px を 2 枚、列間余白と安全余白を含めて並べるための下限である。実装では viewport breakpoint だけで列数を決めてはならない。

### 2.2 ドックの占有範囲

- `corner-right` の洪水カードは右側ドックに含める。
- `clock-top-wide` の洪水カードは従来どおり時計上の独立 surface とし、右側ドックへ移さない。
- 左上の津波・地震カード、中央時計、時計下の南海トラフ、下段の統計・地震履歴は現行 surface を維持する。
- 右側ドックは ticker を除いた `.screen-area` 内に収める。

### 2.3 高さの扱い

カード自身の `max-height` を収容制御に使わない。右側ドックの grid track が各カードへ利用可能な block size を与え、各カードはその内側で固定アンカー、上位ページ、詳細ページへ高さを配分する。

aggregate anchor と dock pager はドック本文の外側に高さを先取りして常設し、dock page の切替で消したり高さを変えたりしない。

- 固定アンカーは `flex: 0 0 auto` 相当で縮めず、§3.4 の最大行数を超えて内容駆動で伸ばさない。
- 固定アンカーに収まらない「何が」の列挙は、失わず上位ページへ送る。
- 詳細ページ領域は `minmax(0, 1fr)` 相当で残りの高さを受け取る。
- 詳細ページは実測した利用可能高と最大行高から収容量を求める。
- 実測値が不正な場合は 1 行へ縮退する。過積載してクリップする fallback は禁止する。
- 1 行も安全に収まらない場合は §3.4.2 の runtime fallback を実行し、文字サイズ下限を破って収めてはならない。

`overflow: hidden` は、実測済みの同寸法ページを重ねる crossfade のマスクに限って使用できる。情報量を削るためのクリップには使用しない。

## 3. 右側ドックとカード内ページング

### 3.1 ドックのカード順

視覚上のカード順は次で固定する。

1. 気象警報・竜巻
2. 洪水（`corner-right` の場合）
3. 火山
4. 台風
5. 熱中症
6. 未知 kind の互換プレースホルダ

2 列時も DOM 順と読み上げ順はこの順を維持する。CSS の見た目だけを `order` で入れ替えてはならない。

### 3.2 カードを落とさない契約

既知の active カードはすべて右側ドックへ描画する。高さ見積り、実高、severity を用いたカード単位の visible/overflow 選抜は廃止する。

全 shell の最小高がドックへ同時収容できない場合は、severity 選抜ではなく §3.4.2 の dock page へ全 shell を DOM 順のまま分割する。非表示ページの shell も page model から削除せず、pager で必ず到達可能にする。

dock pager 横には最大6 cell の aggregate anchor を常設する。cell は §3.1 の domain 順で、domain 名/識別記号、最高状態、active 件数を1行で示す。2列 dock では6列、1列 dock では3列×2行とし、cell 高は1行で固定する。完全な accessible name を持ち、cell 操作で該当 dock/card page へ jump できる。注目更新中の cell は同じ10秒強調を持つ。

未知 kind を受信した場合は、`未対応の待機情報`、kind、件数を持つ通常カードとして表示する。未知 kind を黙って捨てたり、既知カードを落とすための予約領域にしてはならない。

### 3.3 共通ページャ

各cardは上位pageと詳細pageからordered viewを作るが、surface/dock/cardに独立timerを置かない。`StandbyScreen`に単一schedulerを置き、visit tupleを`(surfaceOrder, surfacePageIndex, cardKey, cardView)`とする。`cardView`は`{ upperPageIndex, detailPageIndex: number | null }`であり、単一の不透明な`cardPageIndex`に潰さない。

fullのように上位bodyと詳細bodyを同時表示するcardは、`upperPageIndex`を外側、`detailPageIndex`を内側とする辞書順の直積をordered viewとし、上位/詳細のページ数が異なっても全組合せを有限時間内に表示する。縮約cardは全`{u, null}` summary viewを先に並べ、その後に各detailを所有する上位pageへ結び付けた`{u, d}`をu、d順に並べる。上位または詳細が空でもplaceholder page 0を1つ持ち、順序を空にしない。

surface順は次で固定する。

1. `right-dock`: §3.4.2で分割したdock page順。各dock page内は§3.1のDOM card順、各card内は前段のordered view順。
2. `clock-top-wide`: FloodWideを`surfacePageIndex: 0`、`cardKey: "flood:wide"`とする擬似dock page。FloodWideの全ordered viewを消化する。

右側dockの全tupleを消化してからFloodWideへ進み、FloodWide完了後にright-dock先頭へ戻る。非表示surface/pageのcardと現在visit対象でないcardはpauseし、背後でindexを進めない。左上、下段、長周期、南海トラフなどページャ非対象surfaceはschedulerへ入れない。

dock pagerは`表示中カード範囲 / 全カード数`と現在/総dock page数を示す。FloodWide表示中もright-dockのaggregate anchorは常設する。§4の注目更新は対象tupleへ同一更新cycleでjumpし、pending queue消化後はそのtupleの辞書順successorから通常巡回へ戻る。

- 自動ページ送り周期は 10,000ms とする。
- 手動 jump または強制 jump の後は、移動先ページで 10,000ms の静止時間を取り直す。
- `prefers-reduced-motion: reduce` でもページ送り自体は継続し、ページ切替アニメーションだけを 0ms にする。
- 内容世代が変わっても注目更新がない場合は page 0 へ戻す。
- 注目更新がある場合は §4 の規則で対象ページへ移動する。
- 複数カードが同時更新された場合も timer を増やさず、§4 の優先順で visit tuple を pending queue に積む。

ページャ領域は常に予約し、総ページ数が 1 の場合も `1/1` を表示する。内容更新でページャの有無が変わり、固定アンカーの高さが跳ねないようにする。

- 1〜12 ページは既存 `PageDots` を使用し、数値 `現在/総数` を併記する。
- 13 ページ以上はドットを描画せず、前へ・`現在/総数`・次への数値ページャへ切り替える。
- 数値ページャの前へ/次へは 24×24px 以上の当たり判定を持つ。
- 自動巡回中であることをページャから隠さない。ARIA label は現在ページと総ページ数を含める。

### 3.4 共通のページ容量計算

カードの詳細ページは、`WeatherEmergencyPanel` の既存方式に合わせて次を守る。

1. 詳細領域の border-box 高を測る。
2. 現在の列幅で描画した全候補行の最大 border-box 高を測る。ページ内の行間 `row-gap` は 0 とし、必要な行間余白は各行の border-box の padding に含める。
3. `floor(領域高 / 最大行 border-box 高)` を収容量とし、下限を 1 とする。将来 `row-gap` を非 0 にする場合は `floor((領域高 + gap) / (最大行高 + gap))` へ式とテストを同時に変更する。
4. 未実測時だけ domain ごとの保守的 fallback を使う。
5. font loading、container 列数変更、カード内容変更、dim 解除によらない font metrics 変更で再測定する。
6. grid/crossfade の遷移中に得た過渡寸法を確定値へ昇格させない。

行高が不揃いでも先頭行だけを代表値にしてはならない。収容量の過小評価はページが増えるだけだが、過大評価は不可視化を再発させるためである。

実ブラウザでは、各上位ページ・詳細ページについて animation の静止後に `scrollHeight <= clientHeight` を必須 assertion とする。jsdom のゼロ矩形や計算上の件数だけで収容を証明しない。

#### 3.4.1 固定アンカーの最悪ケース収容

右側ドックの shell は、既知5系統（weather/tornado、corner-right flood、volcano、typhoon、heat）と未知 kind を集約した1 shell の最大6枚とする。未知 kind を kind ごとに shell 化せず、上位ページ内で全 kind を列挙する。

各カードの固定アンカー、上位 body、詳細 body は次の上限を契約とする。`Cu/Ru/Lu` は上位 body の列数/visual row 数/1 item 最大折返し、`Cd/Rd/Ld` は詳細 body の同じ値である。超過 item は次の card page へ送る。

| domain | 固定アンカー | `Cu×Ru`（最大件数） | `Lu` | `Cd×Rd`（最大件数） | `Ld` |
|---|---|---:|---:|---:|---:|
| weather/tornado | 最高 rank + active 種別数 | 1×2（2種別） | 2行 | 1×1（1地域行） | 2行 |
| flood | 最高氾濫段階 + active 河川数 + 更新時刻 | 1×2（2河川） | 2行 | 1×1（1河川詳細） | 2行 |
| volcano | 最高 level/class + active 火山数 | 2×2（4火山） | 2行 | 1×1（1火山詳細） | 3行 |
| typhoon | 最高強度 + active 台風数 | 1×2（2台風） | 2行 | 1×1（1台風詳細） | 3行 |
| heat | 最高区分 + active 地域数 + 更新時刻 | 1×2（2日付） | 2行 | 1×1（1地域行） | 2行 |
| unknown | `未対応の待機情報` + kind 数 | 1×2（2 kind） | 2行 | 1×1（1詳細行） | 2行 |

全 item 数そのものは transport/schema が受理した件数まで保持し、上限超過を捨てず上位ページ数へ変換する。したがって高さを支配する domain 最大件数は上表の「同一ページへ同時描画する件数」であり、総 item 数はページ数だけを増やす。最悪ケースでカードが成立する条件は次とする。

`HupperBody = Ru × Hitem(Lu)`、`HdetailBody = Rd × Hitem(Ld)` とし、full card の最小高は次とする。

`HshellMinFull = 2P + B + Hheader(1行) + G1 + Hanchor(2行) + G2 + HupperPager + G3 + HupperBody + G4 + HdetailPager + G5 + HdetailBody`

上表を代入すると、たとえば volcano は `HupperBody = 2 × Hitem(2行, 2列幅)`、`HdetailBody = 1 × Hitem(3行, 1列幅)`、weather は `2 × Hitem(2行, 1列幅)` と `1 × Hitem(2行, 1列幅)` になる。列数による inline size の違いを同じ `Hitem` で流用してはならない。

縮約 card の summary page と detail page は同時表示しないため、`HshellMinPaged = 2P + B + Hheader + G1 + Hanchor + G2 + HcardPager + G3 + max(HupperBody, HdetailBody)` とする。`P` は上下 padding、`B` は上下 border、`G1..G5` は実際に存在する gap、各 `H` は実 font metrics の border-box 高である。

aggregate anchor は `Haggregate = 1 × Hcell(1行)`（2列 dock）または `2 × Hcell(1行) + GaggregateRow`（1列 dock）とする。全6 shell 同時 active 時の本文高を `Hbody = Hdock - Haggregate - Gaggregate - HdockPager - GdockPager` とし、1列なら `Hbody >= Σ HshellMinMeasured + (Nshell - 1) × GrowGap`、2列なら各 row の `max(HleftMinMeasured, HrightMinMeasured)` の総和へ row gap を加える。`HshellMinMeasured` は上の修正式を満たした外枠実測値であり、旧の header/anchor だけの近似値を使わない。

上表と各式を 1920×1080、1366×768、1280×720 の worst-case fixture で評価する。成立する最大の連続 shell 群を1 dock page とし、最低1 shell は載せる。文字列長 fixture は実データ corpus の最大値に加え、各最大値の2倍長を含める。

#### 3.4.2 runtime fallback

まず全 shell の修正後 `HshellMinMeasured` が同時に収まらない場合、aggregate anchor と dock pager の実高を先取りした前項の式で dock page へ分割する。これはカード落としではなく、全 shell を順に表示する画面レベル上位ページングである。ページ生成後に aggregate/pager が増えて再 overflow してはならない。

次に、通常の固定アンカー + 上位ページ + 詳細ページがcard内の式を満たさない場合、当該カードだけを full-card pager へ切り替え、アンカー item、上位 item、詳細 item を優先順のページとして1件以上ずつ表示する。カード見出し、最高状態、active 件数、pager は全ページで残す。これをカード内の「固定情報を失わない上位ページング」とする。

full-card pager でも最小1行が `scrollHeight <= clientHeight` を満たせない場合だけ、同じ shell を残して `表示領域不足`、domain 名、最高状態、active 件数を明示する layout-failure 表示へ切り替える。カードを DOM から落とす、`overflow:hidden` で隠す、空欄にすることは禁止する。failure は console error と preview diagnostics にも記録する。

横方向の ellipsis は固定アンカー/上位ページの最大2行だけに許可する。省略した完全な文字列は同じカードの詳細ページに `overflow-wrap:anywhere` で必ず到達可能にし、accessible name にも完全値を保持する。詳細ページ側で ellipsis を再適用してはならない。

### 3.5 カード別契約

#### 気象警報・竜巻

- 現行どおり、気象 alert の最高 rank をカードの主表示対象とする。
- 最高 rank と active 種別数を固定アンカーに置き、同 rank の全種別名は詳細より優先する上位ページで全件へ到達可能にする。
- 地域行を詳細ページへ載せ、`clipWeatherRows` による末尾切断は行わない。
- 新serverでは地域詳細pageを§4.5の完成rosterから生成し、snapshotの`shownAreas`最大6件を恒常表示の入力にしない。
- 同一 kind の source 横断 union と重複排除は維持する。
- 竜巻はカード末尾の一行 rider ではなく、気象カードの固定アンカー、上位ページ、詳細ページへ統合する。
- 竜巻目撃中は `竜巻目撃情報` を上位ページの先頭に置き、対象地域を詳細ページへ載せる。
- 通常の竜巻注意情報も同じページモデルを使うが、目撃情報より後に並べる。
- transport上の`omittedAreaCount`はroster同期中/旧server fallbackの行末`ほか N 地域`として維持する。完成roster受信後は全地域をpage化できるため、同じsource/phenomenonのsnapshot省略件数を恒常pageへ重ねない。

#### 火山

- 最高 level/class と active 火山数を固定アンカーに置き、全火山の名前と現在レベルまたは警報 class は上位ページの2列 grid で全件へ到達可能にする。
- Lv1 は現行どおり active volcano card の投影対象外とし、名前や件数にも含めない。
- Lv3 以上、Lv2でactive warning class、数値levelなしのactive warning class、または有効な噴火イベントを持つ火山は通常群とし、常に full 表示する。明示的なLv1だけのalertは投影しない。
- §5 の条件をすべて満たす火山だけを縮約群とする。
- 縮約群も名前とレベルは上位ページから除外しない。
- warning kind、target kind、噴火諸元などの詳細だけを詳細ページへ送る。

#### 台風

- `full → compact → overflow` の自動縮退を廃止する。
- standby 用 `displayMode: "compact"` と compact 専用 DOM/CSS は移行完了後に削除する。
- 最高強度と active 台風数を固定アンカーへ置き、各台風の名前・番号・強度を上位ページ、位置、気圧、風速、移動などを詳細ページへ載せる。
- 1ページに載せる台風数は実測容量で決める。従来の compact 表示をページ内容として再利用してはならない。
- 狭幅用の簡潔な固定サマリが必要な場合は responsive summary として実装し、`displayMode` による選抜状態とは分離する。

#### 洪水・熱中症

- 河川・地域の反復行を詳細ページへ載せる。
- 固定アンカーには最高レベル、active 件数、更新時刻を残す。
- `clock-top-wide` 洪水も同じ共通ページャと容量計算を使う。
- 河川や地域の件数を固定上限で切った場合は、transport 由来の省略件数だけを行末へ残す。DOM 高さ由来の省略は行わない。
- Heat は active な複数 `targetDate` を `key: "heat:active"` の1 shell へ集約する。targetDate 昇順の `heat:<targetDate>` を上位 page key とし、各日付の区分/地域をその詳細 page に載せる。
- Heat shell の severity は全 targetDate の最大、`updatedAt` は最大 report time、`expiresAt` は最大 targetDate end、`restored` はいずれか1日でも restored なら true とする。aggregate anchor の件数は active targetDate 数ではなく active 地域の重複除外件数とする。

## 4. 緊急固定規則

### 4.1 emergency との境界

津波、EEW、大地震、気象 L4/L5 昇格など、`deriveEmergencyPanels()` が返す情報は standby ページングの対象外とする。emergency mode が active の間、通常巡回のページ時刻は破棄または進行してよいが、注目更新の表示期限は開始しない。復帰時は最新 snapshot と App 階層の pending descriptor からページを再評価する。

standby item の `severity: critical` は、それだけでは emergency 遷移を起こさない。注目更新の対象 kind は次の閉じた表だけとし、catch-all 判定を設けない。

| kind | 注目更新 |
|---|---|
| 竜巻目撃 | 新規発表、対象地域追加、目撃地域変更、解除 |
| 火山 | Lv4 以上への格上げ、Lv4 以上での対象・警報内容更新、Lv4 未満への格下げ、解除 |
| 噴火速報 | 新規、更新、取消 |
| 暴風警報 | 新規発表、対象地域拡大、格上げ、解除、格下げ |
| 洪水 | 氾濫発生情報への格上げ、同段階の対象河川追加・更新、同段階からの格下げ、最後の解除 |
| 台風 | 強度 class が `猛烈な` への格上げ、`猛烈な` の台風の新規・更新・消滅、同 class からの格下げ |
| 熱中症 | 熱中症特別警戒アラートへの格上げ、対象地域追加、解除、格下げ |

ページャを持たない長周期地震動カードと南海トラフカードは本表の対象外とする。津波、EEW、大地震、気象 L4/L5 など emergency panel 対象も standby 注目更新へ二重登録しない。

### 4.2 強制 jump

- 注目更新を含む `(surfaceOrder, surfacePageIndex, cardKey, { upperPageIndex, detailPageIndex })` tuple を、snapshot/canonical batch の反映と同じ更新サイクルで表示する。
- DOM 実測が終わる前の fallback page で jump 済みにしてはならない。最終ページ分割が確定してから対象行のページへ一度だけ jump する。
- jump 後はそのページを 10,000ms 保持し、その後は通常の 10,000ms 周期へ復帰する。
- ページャは強制表示中も常時表示し、利用者が別ページへ手動移動できる。
- 手動移動は強制 jump より優先する。同じ更新 token で再び強制 jump して手動操作を奪ってはならない。
- 同一内容の定時再掲、時刻だけの更新、意味差分のない source 重複は注目更新に数えない。

同一 card で同じ更新 batch に複数の注目更新がある場合は、実測容量に収まる限り更新行を同じ先頭 card pageへ集約する。収まらない更新は §4.3 の優先順と wire の安定順で target tuple を `pending page queue` へ積み、現在 tuple の10秒保持後に通常 scheduler より先に1 tupleずつ10秒表示する。dock pager の隣に `未表示の更新 N件` を常時表示し、各 descriptor が初めて可視になった時点で N を減らす。手動移動は現在の強制表示より優先するが、10秒の手動静止後は未消化 queue を再開する。同じ token で手動操作を取り消さない。

emergency中の長時間queueはstable item key単位でcoalesceする。emergency開始時のbaselineと最新snapshot/rosterを比較し、同じkeyの中間差分を捨てて次の最終状態だけを残す。

- baselineでinactive、復帰時activeなら`added`。
- baselineでactive、復帰時activeならbaseline→最新の`promoted`/`updated`/`demoted`。段階を保ったcanonical内容変更は`updated`とし、差が消えた場合はqueueから除く。
- baselineでactive、復帰時inactiveなら`removed`として旧値echoを残す。
- baselineでinactive、途中で追加後に復帰前解除されたitemは現況も旧現況もないためqueueから除く。

queue上限はcoalesce後256 stable keysかつUTF-8 JSON換算512KiB以下とする。どちらかを超えた時点で個別descriptor/解除echoを全破棄し、1件の`critical-resync` markerへ縮退する。復帰時は閉表に該当する最新critical現況の全tupleを優先順でsafety jumpし、`緊急表示中の更新が多いため最新状況を確認します`と通知する。現況criticalが0件でもaggregate anchorを表示し、過去の解除対象を推測しない。完成weather rosterは現況正本としてqueue外に保持し、この512KiBへ重複計上しない。

### 4.3 気象警報内の順序

- 新規追加地域を含む行を初期ページへ置く。
- 同 rank に暴風警報の新規または対象地域拡大がある場合、その行を当該カードの先頭ページに置く。
- 複数の注目更新が競合する場合は、竜巻目撃、解除・格下げの変更エコー、格上げ、地域追加、その他更新の順とする。
- 同順位は wire の安定順を維持する。

### 4.4 weather canonical batch envelope

気象地域が snapshot 縮退で1種別最大6件へ切られても、全active地域と注目更新差分を失わないよう、engineがcap前に作る二種類のcanonical batchをsnapshot外で送る。

- `roster`: source + phenomenon keyごとの全active地域。恒常表示の正本。
- `attention`: 最新semantic updateの`added | promoted | updated | removed | demoted`差分。10秒強調の正本。

`attention` payloadの各entryはstable item key、閉じた`kind: "added" | "promoted" | "updated" | "removed" | "demoted"`、canonicalな`before`/`after`、対象page keyを持つ。`updated`、`promoted`、`demoted`は`before`と`after`を必須とし、`added`は`after`、`removed`は`before`を必須とする。同一内容、時刻だけの更新、source重複はentryを生成しない。frontendがkindを再分類せず、このentryをweather差分の正本として使う。

両者は`DisplayServerMessage`の`type: "standby-weather-batch"`を共有し、必須fieldを`batchKind: "roster" | "attention"`、`status`、`streamEpoch`、source、単調増加`sourceSequence`、32桁hexの`batchToken`、report timeとする。`status`は次の閉じたunionだけとする。

| `status` | 必須field | 禁止field | 意味 |
|---|---|---|---|
| `chunk` | `partIndex`、`partCount`、`payload` | `reasonCode` | batch本文の一部 |
| `tooLarge` | `partCount: 0`、`reasonCode: "batch-limit"` | `partIndex`、`payload` | 129 partsまたはpayload総量3MiB超 |
| `descriptorTooLarge` | `partCount: 0`、`reasonCode: "entry-limit"`、対象のstable key/hash | `partIndex`、`payload` | 単一entryが24KiB chunkへ入らない |

`chunk`は`0 <= partIndex < partCount <= 128`を満たす。1 chunkのJSON payload budgetは24KiB、SSE envelopeを含むencode後サイズは既存`MAX_EVENT_BYTES = 32KiB`以下とする。payload総量が3MiB以下かつpartCountが128以下ならchunk送信を許可する。129 partsまたは3MiB超の場合だけ`tooLarge`、単一entryが24KiBを超える場合だけ`descriptorTooLarge`へ置換し、部分batchは送らない。

snapshot/stateは本文を持たず、sourceごとに`rosterWatermark`と`attentionWatermark`を持つ。各watermarkは`batchKind`、`status`、`streamEpoch`、`sourceSequence`、`batchToken`、`partCount`を共通必須fieldとする。`status: "chunk"`では`partCount`を対応messageと同じ1〜128とし、`reasonCode`と対象key/hashを持たない。`status: "tooLarge"`では`partCount: 0`と`reasonCode: "batch-limit"`、`status: "descriptorTooLarge"`では`partCount: 0`、`reasonCode: "entry-limit"`、対象stable keyまたはその固定長hashを必須とする。messageとwatermarkの`status`、`partCount`、marker固有fieldが一致しないbatchは欠落扱いとする。全source・両kindのwatermark encode budgetは合計2KiB以下とする。

frontendは`(batchKind, streamEpoch, source, sourceSequence, batchToken)`単位でchunkを集め、重複partを除外し、全partをpartIndex順に結合してから一括commitする。新しいmatching watermark/chunkを最後に受信するたびidle timerを更新し、15,000msの受信idleまたはwatermark受信から180,000msの総上限で未完成batchを破棄する。同じsource/batchKindのより新しいwatermarkを受けた場合は旧sequenceの部分batchを直ちに破棄し、最新sequenceの完成を待つ。この意図的なobsolete roster破棄は単独ではfailure表示を出さず、最新sequence側の欠落、接続断、encode/parse error、marker、idle/総上限超過時にだけsafety jumpする。いずれの場合も部分rosterや部分差分を描画しない。

### 4.5 全active地域 roster

engineは各weather semantic updateでcap前の全active地域集合からrosterを生成する。roster entryはsource、phenomenon stable key、警報kind/rank、stable area key、完全labelを持つ。stable area keyは最大64 UTF-8 bytes、labelは最大256 UTF-8 bytes、distinctな`(phenomenon key, area key)` roster rowはsource当たり最大4,096件とし、正規catalogとprotocol validationで固定する。この最大入力をchunk化しても128 partsかつ3MiB以下になることをproperty testで証明する。catalog拡張で証明が破れた場合は実装をrelease不可とし、runtimeで黙って地域を落とさない。

- frontendは完成rosterを受けるまで直前の完成rosterを表示し続け、完成時にgenerationを原子的に置換する。
- 初回接続はsnapshot後に全sourceの最新rosterを再送し、完成するまでweather cardへ`地域一覧を同期中`を表示する。
- 再接続もsnapshot watermarkと最新roster再送から再構成する。epoch/sequence連続性を仮定しない。
- 同内容再掲ではroster sequence/tokenを更新しないが、完成済みfrontend rosterを保持し、再接続clientには保持中の最新rosterを再送する。
- attention-only行は10秒後に消してよいが、追加地域を含む完成rosterは残るため、その後も通常のcard page巡回で全active地域へ到達できる。
- rosterのmarker、timeout、validation failure時は直前rosterを現況として確定せず、weather shellに`全地域一覧を受信できませんでした`を明示して最新critical weather pageへsafety jumpする。

weather地域差分もengineがrosterの前世代と新世代をstable keyで比較した`attention` batchを正本とする。frontendがweather snapshot配列から同じ差分を再計算するのは、旧serverがbatch/watermarkを実装しない場合だけとする。完成attentionの対象がsnapshot `shownAreas`に無くてもroster行を直接強調し、`omittedAreaCount`を二重加算しない。

### 4.6 client delivery failure

client別再送queueは設けず、batch pumpを全client共通の逐次送信器とする。各partは、その送信開始時点で生存している全clientへのenqueueを一度ずつ試みる。enqueueが成功してもtransportがbackpressureを返したclientについては`drain`を待ち、全生存clientがdrain済みになるか切断されるまで次partを送らない。clientごとのdrain待ち上限はpartごとに5,000msとし、超過したclientだけを切断して、他clientへのbatch転送は継続する。enqueue自体を実行できずblocked-skipになったclientは待たずに同じbroadcast cycle内で切断し、以後のpartを送らない。drain後にそのclientだけを途中partから再開してはならない。

batch pumpはpart途中では差し替えないが、roster送信中に新しいattentionと同じsemantic updateの新roster watermark、またはattentionを伴わない同じsourceの新roster watermarkを受理した時点で、送信中rosterをobsoleteとする。attentionだけを先行公開して対応roster watermarkなしに旧rosterを中止してはならない。現在partの全client enqueue/drain barrierだけを完了し、次のpart境界で旧rosterの未送信partを中止する。部分rosterはfrontendの一括commit前であり、前項どおり新watermarkによって破棄されるため表示へ混入しない。

中止後はpending attentionを最優先で到着順に送り、同着時はsourceの安定順、次いでsourceSequenceで順序を固定する。その後に各sourceの最新pending rosterを送る。未送信rosterはsourceごとに最新1世代だけを保持し、それ以前のpending rosterを置換する。attention受理からそのattentionの先頭part送信開始までの遅延上限は、送信中の現在1partをenqueueする時間 + 当該partのdrain待ち最大5,000msとする。obsolete rosterの残part数や180,000ms総上限をattention待ち時間へ加えてはならない。これはclient別再送queueではなく、全client共通pumpの送信状態である。

clientは通常の再接続を行い、新snapshot + 全source最新roster + 最新attention batchの順で初期同期をやり直す。snapshot自体がblocked-skipした場合も同じく即切断する。これによりwatermarkだけ進みchunkが欠けた接続を生存させない。

## 5. 火山縮約データ契約

### 5.1 `activeSinceMs`

engine の `VolcanoState` と永続化 state に、表示対象となった同一警報状態の継続開始を表す `activeSinceMs: number | null` を追加する。frontend wire の `DisplayVolcanoEntryV1` にも additive field として `activeSinceMs?: number | null` を追加する。Lv1 は現行どおり card 非表示であり、Lv1 を新たな active 表示状態として扱わない。Lv1 から Lv2 へ遷移した場合は Lv2 の report time から開始し、Lv1 の継続時間を引き継がない。

同一警報状態の identity は次の canonical 値で構成する。

- `alertLevel`
- `alertClass.code`, `alertClass.severity`, `alertClass.isActive`
- 正規化した `warningKind`
- 重複を除き安定順へ正規化した `targetKinds`

identity が変化した報を受理した時点で `activeSinceMs` をその report time へ更新する。同一 identity の定時再掲・訂正で意味が変わらない場合は更新しない。取消では `null` にする。

- startup seed で新規に得た警報は seed の report time を開始時刻とする。
- persistence から復元した値は維持する。
- `activeSinceMs` を持たない旧 persistence は、migration/restore を行った `nowMs` を開始時刻とする。旧データを即時縮約しないための安全側 migration である。
- future skew や不正値は `nowMs` へ正規化し、負の継続日数を作らない。

### 5.2 自動縮約条件

火山は、次の条件をすべて満たす場合だけ自動縮約できる。

1. `alertLevel` が 2。
2. `latestEvent` がなく、有効な噴火イベント state もない。
3. `alertClass?.isActive === true && alertClass.severity === "warning"` ではない。
4. `activeSinceMs` が既知で、現在時刻との差が 7日以上。

条件の一つでも満たさなければ full 表示とする。Lv3 以上は継続期間にかかわらず常に full 表示する。Lv1 は full/縮約のどちらにも入れず、現行どおり非表示とする。

有効な噴火イベントの発生中は縮約を解除する。イベント失効後、警報 identity 自体が変わっていなければ元の `activeSinceMs` を使って再判定してよい。

### 5.3 full/縮約表示 matrix

| 情報 | Lv1 alertのみ | Lv2 full | Lv2 縮約 | Lv3+ / active warning / 噴火イベント中 |
|---|---|---|---|---|
| 火山名 | 非表示 | 上位ページに表示 | 上位ページに表示 | 上位ページに表示 |
| level / class | 非表示 | 上位ページに表示 | 上位ページに表示 | 上位ページに表示 |
| `warningKind` | 非表示 | 詳細ページに表示 | 詳細ページに退避 | 詳細ページに表示 |
| `targetKinds` | 非表示 | 全件を詳細ページに表示 | 全件を詳細ページに退避 | 全件を詳細ページに表示 |
| `latestEvent` 種別・時刻・諸元 | 非表示 | 値があれば即 full へ移行して表示 | active 中はこの状態にならない | 詳細ページに表示 |
| 初期 page key | なし | `volcano:<code>:full` | `volcano:<code>:summary` | `volcano:<code>:full` |
| 初期 view の領域配分 | なし | 上位 body + 詳細 body | 上位 body のみ | 上位 body + 詳細 body |
| 初期 view の詳細行 | 0 | 実測容量で1行以上 | 0 | 実測容量で1行以上 |

full は火山名/level の上位 body と、`warningKind` または先頭 `targetKinds` を含む詳細 body を同じ初期 card page に描画する。縮約は上位 body だけを初期 page に描画し、`volcano:<code>:detail:<n>` を単一 scheduler の後続 page とする。7日境界で full→縮約へ変わったら該当火山の summary page へ index をリセットし、同一 view の詳細行が1以上から0へ変わることを DOM で観察可能にする。

縮約は DTO の field や配列を削除する操作ではない。`targetKinds.slice(0, 2)` のような表示時切断は禁止し、全件を後続ページで到達可能にする。噴火イベント発生、Lv3 への格上げ、active warning class 化、または7日条件を外れる identity 変更が起きた同一 render cycle で full に戻し、初期 view の詳細 body と、`warningKind`、全 `targetKinds`、`latestEvent` 諸元を復帰させる。

Lv1 alertと独立してactive eventが存在する場合は、Lv1 alert自体をcard化せず、eventを右端のfull列として表示する。

### 5.4 engine 変更境界

本仕様で必要な engine 変更は次に限定する。

1. 火山 `activeSinceMs` の保持、migration、wire 投影。Lv1 の表示/active 意味論は変更しない。
2. volcano card 投影を「`alertLevel >= 2`、`alertLevel == null` でactive warning class、または active event」へ拡張し、明示的なLv1 alertはeventがない限り除外する。Lv2 単独 card は `severity: normal`、Lv3または active warning class は `warning`、Lv4+または噴火速報は `critical` とする。複数火山は最大 severity を card severity とする。
3. volcano の `restored` は投影対象となる Lv2+ alert/class の `alertRestored` または active event の `eventRestored` のいずれかで true とする。startup seed は live baseline として false、persistence restore は live 更新まで true とする。Lv2→Lv1 の lower は Lv1を cardから除外して `activeSinceMs` を null にし、他の投影対象がなければ §6.4.1 の解除 shell を生成する。
4. §4.4〜4.6のweather canonical roster/attention保持、`standby-weather-batch` chunk、snapshot watermarks、blocked client切断。transport cap後のfrontendでは全地域/差分を復元できず、snapshotへ本文を載せると256KiB上限を脅かすため必要である。
5. §3.5 の Heat 複数 targetDate を1つの `heat:active` cardへ集約する投影。最大6 shell と単一 scheduler の前提を守るため必要である。

次は frontend ローカル状態と §6 の汎用変化強調機構で実現し、engine field を追加しない。

- ページ index と自動巡回時刻。
- §4 の強制 jump に必要な追加・解除・格上げ・格下げ判定。
- weather 以外のカードに表示する追加・解除・格上げ・格下げ判定。weather 地域差分は §4.4 engine descriptor を正本とする。
- 強制 jump token。
- 10秒間の変更エコー。
- dim 一時解除の残存時刻。

火山、洪水、台風、熱中症で §4 の注目更新を強制 jump・強調するための frontend adapter は許容するが、engine field は追加しない。これらのカードで注目更新以外の一般的なレベル・強度遷移まで強調する展開は §6.9 の将来 Phase とする。

frontend だけでは安定した意味差分を判定できない事例が実装時に見つかった場合、上記5系統以外の engine field/message を暗黙に追加してはならない。§10 の実装時裁定へ戻し、field、永続化要否、旧 server fallback を明示してから追加する。

## 6. 更新・遷移・汎用「変化強調」機構

### 6.1 責務と構成

変化強調は standby 専用品や気象警報専用品にせず、任意の domain adapter が正規化した前回表示と現在表示の差分を受け取れる frontend 共通機構とする。構成要素は次の二つに分ける。

1. `App.svelte` 階層の共通期限管理器: stable item key ごとの前回値、change token、表示開始、期限、対象ページ、解除 shell、pending page queue を管理し、強制 jump と装飾の存続を同じ時刻基準で制御する。
2. 共通の表示 component: 正規化済みの変化 descriptor を受け、順序尺度またはカテゴリ変化に対応する記号、旧値、新値、下線、打ち消し線、accessible name を描画する。

domain adapter は item の同一性、順序、before/after label、対象ページを決める。共通機構は `warningKind` や任意の文字列から severity 順を推測しない。この分離により、同じ期限・a11y・演出規約を別カードへ展開できる一方、domain 固有の誤った大小比較を防ぐ。

### 6.2 差分 descriptor の契約

weather 地域 adapter は、§4.5 の完成 roster を現況の正本、§4.4 の完成 attention batch を差分の正本として descriptor を共通機構へ渡し、旧 server 時だけ snapshot fallback を使う。weather 以外の domain adapter は前回の正常 snapshot と現在 snapshot を stable key で比較する。いずれも共通 descriptor は次を持つ。

- `itemKey`、`cardKey`、`targetPageKey`、解除時に shell を復元できる最小の旧 card snapshot。
- `kind`: `added | promoted | updated | removed | demoted`。
- `scale`: `categorical | ordinal`。
- canonical な `before` / `after` と、その可視 label。`promoted` / `updated` / `demoted` は両方を必須とする。
- 色や記号に依存しない文章の accessible label。
- weather は engine `sourceSequence`、他 domain は snapshot sequence を含む一意な change token。

初回 App mount は snapshot watermark と再送 batch を baseline として消費済みにし、過去差分を発火しない。restored-only snapshot も baseline の確立だけを行う。SSE 再接続は §6.4.2 の epoch/sequence連続性規則に従う。`updatedAt` だけが変わり canonical 内容が同じ場合も発火しない。同じ token は再発火させない。

追加・格上げ・更新は現行 item を装飾する。`updated`は`scale: "categorical"`で、severity/段階を維持したままcanonicalカテゴリ内容が変わる場合に限り、旧カテゴリ値から新カテゴリ値への差分として生成する。解除は旧 item、格下げは旧値を期限つき変更エコーとして保持する。順序尺度で before または after の一方しか得られない場合は格上げ/格下げと推測せず、意味に応じて追加/解除または変化なしへ落とす。

### 6.3 期限管理の契約

- 強調と変更エコーは対象ページが初めて可視になった時点から 10,000ms 表示する。対象ページが見える前に期限を消費しない。
- 強制 jump の静止時間と同じ monotonic clock を使う。wall clock の補正や snapshot timestamp を期限計算に使わない。
- 手動で別ページへ移動しても期限は継続する。期限内に戻れば再表示し、期限後なら再表示しない。
- 同じ item に新しい差分が来た場合は、新しい token で before/after を置換して 10,000ms を開始し直す。
- 期限後は変更エコーだけを既存の短い退場で除去し、現行情報を残す。
- manager の scheduler/timer/shell 状態は frontend ローカルであり、durable state や engine persistence へ保存しない。§4.4〜4.6 の engine roster/attention batch、watermark、配信制御は weather の現況・差分根拠であり、この期限状態とは分離する。
- `StandbyScreen` が unmount しても `App.svelte` の manager は存続する。App 自体の破棄時だけ timer と frontend queue を破棄する。

### 6.4 本仕様で有効化する範囲

本 Phase で共通機構を使う consumer は次に限定する。

- `StandbyScreen` の緊急 jump consumer: §4 の注目更新 descriptor を受け、対象ページへの強制 jump、10秒静止、pager 常時表示、dim 一時解除を行う。jump 先では更新箇所を共通表示 component で必ず10秒強調し、renderer がないまま jump だけを実装してはならない。
- `WeatherAlertCard` の既定表示 consumer: 気象警報の新規/拡大、解除、順序づけ可能な格上げ/格下げを、共通表示 component で描画する。

竜巻 (c) は共通 pager と緊急 jump consumer へ合流し、目撃等の §4 の注目更新箇所を共通表示 component で強調する。

#### 6.4.1 最後の1件解除と解除 shell

解除によって domain の最後の active item が current snapshot から消えても、manager は直前の card snapshot から解除済み shell を同じ surface・DOM 順に生成して10秒保持する。

- shell は通常カードと同じ見出し、pager、寸法契約を持ち、旧 item を `解除` + 打ち消し線で表示する。
- shell の10秒は standby 上で対象ページが初めて可視になった時点から開始する。期限後に shell 全体を `--dur-exit` で退場させる。
- 新しい active item が同じ card key に入った場合は shell と現行 card を二重表示せず、現行 card 内の変更エコーへ統合する。
- weather/tornado、flood、volcano、typhoon、heat の最後の1件解除に同じ仕組みを使う。カードが消えたことだけで解除通知を代用してはならない。

#### 6.4.2 emergency 中と再接続

`StandbyScreen` が emergency 遷移で unmount されている間も、App 階層の manager は live snapshot、§4.4〜4.6のwatermark/chunk、完成roster、消費済みsequenceを追跡する。standby非表示中は強調期限を開始せず、polite statusも読み上げず、注目更新を§4.2のstable-key coalesce/256件/512KiB契約で保持する。standby復帰時は最新roster/現況で対象pageを再構築し、未消化更新または`critical-resync`へsafety jumpしてから10秒を開始する。

SSE 再接続時は、最後に消費した `streamEpoch` が一致し、source ごとの `sourceSequence` が同値または直後である場合だけ未消化 descriptor を通常どおり処理する。epoch 変更または sequence gap で連続性を証明できない場合は架空の追加・解除差分を作らず、閉じた表に該当する現在 active な critical item のページを pending queue へ積み、`再接続後の重要情報 N件` として safety jump する。この現況確認には旧値矢印や打ち消し線を使わない。

### 6.5 レベル遷移表記の比較と確定

| 比較軸 | 記号 + 下線/打ち消し線を全変化へ適用 | 旧値 `→` 新値の矢印表記 | 確定する併用案 |
|---|---|---|---|
| 始点・終点の伝達力 | 種別は強いが、旧値と新値の対応が弱い | `Lv2 → Lv3` の一行で両端を明示できる | 順序尺度は矢印で両端を示す |
| 省スペース性・2列との相性 | 単一 item は最短 | 旧新二値ぶん幅を使うが、`Lv` 等の短縮 label ならカード内に収めやすい | カテゴリは短い記号、順序尺度だけ矢印に限定する |
| 地域追加/解除への適用 | 適する | 集合への出入りを旧値→新値で表すと不自然 | カテゴリ変化は下線/打ち消し線を使う |
| 旧値の期限管理 | 格下げ時の旧値エコーだけ規則が特殊になる | before/after を同じ descriptor と同じ期限で扱える | 順序尺度の旧値は10秒だけ矢印内に保持する |
| a11y・色覚 | 記号、線、文章 label の併用が必要 | 矢印だけでは格上げ/格下げを読み上げられない | 可視種別 label と文章の accessible label を必須にする |
| `RollingNumber` との整合 | 数値 animation と意味記号が別々に見えやすい | 外側が遷移全体、`RollingNumber` が新値を担当できる | 外側で before→after と意味を持ち、新値側の既存 roll を重ねない |

確定案は併用とする。順序尺度の格上げ/格下げは `旧値 → 新値` と新値強調、カテゴリの追加/解除は下線/打ち消し線を使う。矢印だけ、色だけ、motion だけで変化種別を伝えてはならない。

### 6.6 確定する表示規則

カテゴリ変化は既存 `WeatherEmergencyPanel` の「下線 + 記号、文字色を変えない」規約を参照する。

- 追加: 可視文字 `＋`、可視対象語への 3px 下線、`追加` の accessible name。
- 更新: カテゴリの`旧値 → 新値`、可視文字またはlabel `更新`、新値への3px下線。旧値には打ち消し線を付けず、accessible nameに対象、始点、終点、`更新`を含める。
- 解除: 可視文字 `−` と `解除` label、旧対象語への 2px 以上の打ち消し線。旧値は現況と誤認されないよう `解除` / `旧` を明記する。
- 格上げ: `旧値 → 新値` と可視文字 `↑` または `格上げ` label。新値に 3px 下線と font weight の一時強調を付け、旧値に打ち消し線は付けない。
- 格下げ: `旧値 → 新値` と可視文字 `↓` または `格下げ` label。新値に 3px 下線と font weight の一時強調を付け、旧値に打ち消し線は付けない。

更新も§6.3と同じ可視開始基準で10,000ms保持し、期限後は`更新` label、旧値、下線だけを外して新しい現況値を残す。

`aria-label` は、例として `暴風警報 対象に横浜市を追加`、`台風の位置を北緯25度から北緯26度へ更新`、`宮崎市の暴風警報を解除`、`レベル2からレベル3へ格上げ` のように対象、始点、終点、変化種別を文章で含める。domain role 色を線に使えるが、本文色は `--fg` または既存の監査済み文字色を維持する。

新値に既存 `RollingNumber` を使う場合、外側の共通 component が遷移全体の accessible label を持ち、内部 digit は従来どおり読み上げから隠す。共通 component は独自の数値 roll を重ねず、下線と weight だけを加える。

### 6.7 motion

- ページ切替は既存 `spring-effects-default` の重ね crossfade を使う。
- 更新内容の入場は既存 `spring-effects-default` の短い fade-in とし、点滅、pulse、無限 animation は使わない。
- 変更エコーの期限切れ退場は既存 `--dur-exit` / `EXIT_MS` の opacity 退場を使う。
- card slot の再配置は既存 spatial spring と二層 slot 規約に従う。
- `prefers-reduced-motion` では上記 animation と `RollingNumber` の roll を 0ms にするが、矢印、記号、下線、打ち消し線、10秒保持、自動ページ送りは維持する。

### 6.8 dim、tier、accessibility

- 注目更新の強制 jump から 10,000ms は `standbyAttentionActive` とし、利用者の requested dim を変更せず effective dim だけを一時解除する。
- `standbyAttentionActive` は frontend ローカル値として `App.svelte` の既存 `computeEffectiveDim` 入力へ合流させる。10,000ms 後、requested dim が true なら自動的に減光へ戻す。
- 既存の critical standby / weather L5 による減光抑止は維持する。
- 下線、打ち消し線、矢印、記号は dim と critical TierOverlay の両方で目視確認し、線色は非テキスト 3:1、本文は通常文字 4.5:1 を満たす。
- 安全情報・常設情報は 14px 以上、補足は 12px 以上という既存の二層文字サイズを守る。
- 変化の種類を色だけ、線だけ、矢印だけ、motion だけで伝えない。
- ページャは `role="group"` と現在/総数を持ち、数値ページャの操作には前へ/次への accessible name を付ける。
- aggregate anchor は `role="group"` を持ち、各 cell の accessible name に domain、最高状態、active 件数、`表示へ移動`を含め、24×24px以上の操作領域を持つ。
- 自動ページ送りは reduced-motion でも継続する既存 kiosk 例外を維持する。停止手段ではないことも design system の記述を引き継ぐ。
- 更新で自動 jump しても focus を移動しない。画面の視覚表示だけを変え、キーボード focus を奪わない。
- 注目更新 descriptor だけを通知する視覚非表示の `role="status" aria-live="polite" aria-atomic="true"` を1つ置く。最初の descriptor から300ms debounce して同一 snapshot/token 群を一度に集約し、優先度最上位の変化文と `ほか N件` を一度だけ通知する。同じ token を再通知しない。
- 自動/手動のページ変更、通常巡回、pager の現在値変化は status へ流さない。現在表示中の行自体も、色や線に依存しない accessible name を維持する。

### 6.9 将来展開候補と非適用範囲

次は、§4 の注目更新に必要な強調を越えて、通常更新にも共通機構を展開する有力候補である。この展開は将来 Phase とし、本仕様の変更単位、完了条件、回帰 gate に含めない。

- 火山カード: §4 に該当しない警戒レベル引上げ/引下げも順序尺度の矢印表記へ載せる。
- 洪水カード: 氾濫段階の遷移を順序尺度として扱う。情報種別名だけで大小を推測せず、domain adapter に明示順序を持たせる。
- 台風カード: 強度 class の格上げ/格下げを候補とする。中心気圧や風速の単純な数値増減を強度遷移と同一視せず、`RollingNumber` と競合する animation を増やさない。
- 熱中症カード: 警戒アラートから特別警戒アラートへの格上げを候補とする。

emergency 系画面には本共通表示 component を適用しない。津波格上げ等は即時全面遷移そのものが主たる通知であり、standby の10秒エコーを重ねると現況の視認と読み上げを競合させるためである。将来扱う場合は emergency 専用 spec で表示寿命、取消、音声、画面遷移を一体で裁定する。

ticker にも適用しない。流れる短文に旧値エコーや打ち消し線を混ぜると、取消と過去情報の区別が崩れ、motion と読み上げの負荷も増える。静的な要約カードへ遷移を集約する。

## 7. 互換性と永続化境界

### 7.1 wire 互換

- `DisplayVolcanoEntryV1.activeSinceMs` は additive optional field とする。
- 旧 server または旧 persistence で field がない場合、frontend は縮約不可として full 表示する。
- `standby-weather-batch` messageとsnapshot/stateのbounded `rosterWatermark`/`attentionWatermark`はadditive optionalとし、旧serverでは§4.5の明示的fallbackを使う。
- Heat card data に additive optional `dates: Array<{ targetDate, areas }>` を追加する。新serverはlegacy `targetDate`/`areas`にも先頭日付を投影し、新frontendは`dates`欠落時にlegacy fieldから1日分を合成する。
- 既存 `ActiveStandbyCardV1` の kind、surface、severity は維持する。
- weather全active地域は完成roster、地域差分は完成attentionを正本とし、旧server時だけsnapshot fallbackを使う。それ以外の§4注目更新は既存stable keyと内容からfrontend adapterが導出する。

### 7.2 persistence

- `activeSinceMs` は volcano active state と v1/v2 persistence の双方で round-trip する。
- persistence reader は field 単体の不正を理由に火山 record 全体を捨てず、`activeSinceMs` だけを migration 時刻へ縮退する。
- rollback 用 schema との互換、volcano foundation、tombstone、subject salvage の意味は変更しない。
- ページ位置、変化強調 manager、解除 shell、pending page queue、変更エコー、attention timer は保存しない。
- engine の最新 roster/attention batch、chunks、watermark sequence は wire 配信用の transient state とし、standby persistence へ保存しない。再起動で epoch/sequence 連続性を失った場合は §6.4.2 の safety jump を使う。

### 7.3 再起動と再接続

- 再起動後は全カードのページを初期規則から開始し、現在 active な閉表 critical item を safety-jump queue へ積む。
- weatherはsnapshotの縮退地域を恒常pageの正本にせず、最新roster再構成後にcard generationを確定する。
- persistence 復元だけでは更新 highlight を点灯しない。
- live snapshot を初めて受けた時点でも、復元内容との差だけから追加・解除を捏造しない。token 連続性がなければ §6.4.2 の現況確認だけを行い、次の意味変更から通常 tracker を開始する。
- active 火山の `activeSinceMs` は再起動を跨いで維持し、7日判定をやり直さない。

## 8. 廃止対象と移行完了条件

### 8.1 廃止する仕組み

次は新レイアウトへの移行完了時に削除する。

- `WeatherAlertCard` の `max-height: min(44vh, 280px)` と clipped 固定高。
- `clipWeatherRows`、`visibleRowLimit`、`clippedCount`、`.clip-hidden`、`.clip-summary`。
- DOM 高さ由来の `ほか N 項目/地域`。transport の `omittedAreaCount` に由来する行単位の `ほか N 地域` は残す。
- `StandbyScreen` の右上カード候補 measurement shelf。
- `standby-measure.ts` の右上カード単位選抜専用 API。
- `rightStackBudgetPx`、`selectRightStack*`、summary reservation。
- `StandbyOverflowSummary` と、overflow へカードを送る経路。
- `.corner-right` の `max-height` + `overflow:hidden` による最終クリップ。
- standby 台風の `displayMode: "compact"`、compact 候補の二重実測、compact 専用表示。
- Heat/Flood/FloodWide のカード `max-height` を使うクリップ。
- `layoutFloodWideRows` が DOM 高さ予算から生成する `ほか N 河川` 行。全河川を詳細ページへ送る。
- `HeatAlertCard` の marquee と、`prefers-reduced-motion` 時だけ使う2行 clamp。地域は静的な詳細ページへ移す。
- targetDateごとに別 `heat:<targetDate>` shellを生成する投影。単一 `heat:active` shell + 日付上位ページへ置換する。
- `VolcanoCard` の `targetKinds.slice(0, 2)` と `ほか N`。全 `targetKinds` を詳細ページで到達可能にする。

### 8.2 残してよいもの

- page crossfade 用の局所的な `overflow:hidden`。
- transport 上限により engine が既に省略した件数の表示。
- 固定アンカー/上位ページの最大2行 ellipsis。ただし §3.4.2 のとおり完全値を詳細ページと accessible name に残すものだけ。
- emergency panel の compact 表示。standby 台風 compact の廃止とは別である。
- 左上、時計上、下段など、右側ドック外 surface のレイアウト境界。

### 8.3 移行完了条件

旧選抜・clip・compact 経路を feature flag なしで完全に削除し、同じカードに新旧両方の収容判定を残さないことを完了条件とする。

## 9. 変更単位

以下の 6 単位で、上から依存順に実施する。

### Unit 1: 共通ページャと汎用変化強調基盤

対象:

- `display/frontend/src/lib/page-cycler.svelte.ts`
- 新規の `display/frontend/src/lib/standby-scheduler.svelte.ts`
- `display/frontend/src/components/PageDots.svelte`
- 新規の数値ページャ/共通 pager component
- 新規の汎用 change descriptor、期限管理器、共通変化強調 component と単体テスト
- `display/frontend/src/lib/dim-interaction.ts`
- `display/frontend/src/App.svelte`

完了条件:

- 単一schedulerがright-dock各pageの全`{upperPageIndex, detailPageIndex}` view、次いでFloodWide擬似surfaceの全viewを固定順で消化し、非表示/非対象cardをpauseする。
- 10秒巡回、強制 jump、手動操作優先、pending tuple、12ページ境界、1/1 の予約表示が純関数/コンポーネントテストで固定される。
- 追加、格上げ、更新、解除、格下げ、同内容再掲、初回 snapshot の差分判定と domain adapter 境界が固定される。
- 順序尺度は旧値→新値+新値強調、カテゴリ追加/解除は下線/打ち消し線、カテゴリ更新は旧値→新値+`更新` label+新値下線という表示分担が固定される。
- 対象ページが見えるまで期限を消費せず、表示開始から10秒で現行表示だけへ戻る。
- 同一 card の複数更新が先頭ページへ集約され、超過時は pending page queue と `未表示の更新 N件` で全件を順に表示する。
- 最後の1件解除でも共通解除 shell が10秒残る。
- App 階層の manager が emergency 中も token を追跡し、復帰/再接続時に §6.4.2 の safety jump を行う。
- 注目更新だけが300ms debounce の polite status で一度通知され、ページ変更は通知されない。
- `standbyAttentionActive` が requested dim を変更せず、10秒後に effective dim だけ復帰する。

テスト方針:

- fake timer による単一 scheduler/変化強調 manager/queue/解除 shell lifecycle/dim/status debounce の単体テスト。
- ARIA、polite status の集約と非重複、矢印、`更新` label、記号、下線、打ち消し線、旧値の期限切れを component DOM test で確認する。
- crossfade と focus 非移動は component test と preview 目視を併用する。

### Unit 2: 右側ドックと旧高さ選抜の置換

対象:

- `display/frontend/src/components/StandbyScreen.svelte`
- 新規の共通 `StandbyCardShell.svelte`
- 新規の `StandbyAggregateAnchor.svelte`
- 新規の dock pager component
- `display/frontend/src/lib/standby-cards.ts`
- `display/frontend/src/lib/standby-measure.ts`
- `display/frontend/src/components/StandbyOverflowSummary.svelte`
- 関連 frontend tests

完了条件:

- FHD/十分幅で2列、720p/1280px未満で1列になる。
- active な既知カードがすべて DOM に存在する。
- measurement shelf、カード単位 overflow、summary reservation が削除される。
- ドックの DOM 順が §3.1 と一致する。
- 最大6 cell の aggregate anchor が全 domain の最高状態・件数を常設し、dock page と独立している。
- 共通 shell が固定アンカー、上位/detail body、pager、解除 shell、full-card/layout-failure skeleton の寸法所有者になる。Unit 3〜5 の domain component はデータ/row renderer だけを差し込む。
- §3.4.1 の最大6 shell、aggregate、修正収容式を、domain 非依存の synthetic row renderer fixture で成立させる。
- 全 shell が同時に収まらない fixture は dock page に全 shell を分割し、通常card式が成立しない fixture は full-card pager、最小1行も成立しない fixture は明示的 layout-failure shell になり、カードを落とさない。

テスト方針:

- container query のソース契約と全カード DOM 存在は jsdom test で確認する。
- 実際の2列/1列、時計・左上との非干渉、ticker 内収容は 1920×1080、1366×768、1280×720 の実測系 browser test または preview 目視で確認する。全ページで `scrollHeight <= clientHeight` を検査し、jsdom の矩形 0 だけで layout 完了を証明しない。
- Unit 2 の完了判定は Unit 3〜5 の再設計済み domain rendererへ依存せず、共通 slotへ synthetic rowを差し込んで検証する。実domain fixtureとの統合gateはUnit 6だけが所有する。

### Unit 3: 気象警報・竜巻ページングと注目更新

対象:

- `display/frontend/src/components/WeatherAlertCard.svelte`
- `display/frontend/src/lib/prefecture-group.ts`
- `src/engine/display/standby-state-store.ts`
- `src/engine/display/http-server.ts`
- `src/engine/display/sse-clients.ts`
- `src/engine/display/hub.ts`
- `src/engine/display/transport.ts`
- `src/engine/display/constants.ts`
- `src/engine/display/types.ts`
- `src/engine/display/protocol.ts`
- `display/frontend/src/lib/protocol.ts`
- frontend の SSE connection/store
- 必要なら新規 weather/tornado page helper
- weather/standby component tests

完了条件:

- `clipWeatherRows` と DOM clip summary が削除される。
- 全対象行がページ巡回で到達可能になる。
- 竜巻 (c) が共通ページモデルへ合流する。
- 竜巻目撃と暴風警報の新規/拡大/解除/格下げが対象ページへ jump し、更新箇所が10秒装飾される。
- 気象警報の順序尺度遷移は旧値→新値+新値強調、地域の追加/解除は下線/打ち消し線で表示される。
- engine の canonical weather batch が地域最大6件の snapshot 縮退を受けず、24KiB chunkへ分割され、各 encode が32KiB以下になる。
- 全active地域rosterが初回・更新・再接続で原子的に再構成され、attention期限後も全地域pageを生成する。
- roster/attention watermarks、closed status union、partIndex/partCount、128parts/3MiB境界、epoch/sequence、再構成、重複除去、15秒idle/180秒総上限、marker safety jumpが固定される。snapshot/stateに本文を含めない。
- state watermarkまたは任意chunk/markerのblocked-skipでclientを即切断し、再接続時にsnapshot+最新roster+attentionを再送する。
- batch pumpがpartごとの全生存client enqueue/drain barrier、client別5秒drain上限、遅いclientだけの切断、obsolete rosterの次part境界中止、attention開始遅延上限「現在1part + 5秒drain」、sourceごとのpending roster最新1世代coalesceを守る。
- cap 外の対象が attention-only 行として10秒表示され、`omittedAreaCount` を二重加算しない。
- weather/tornado の最後の1件解除で解除 shell が10秒表示される。
- transport の省略件数は行単位で維持される。

テスト方針:

- page分割、source union、暴風優先、weather adapter、変更エコー、roster上限property、chunk境界/marker/欠落/順序逆転、blocked state、縮退前後のcanonical差分を純関数/engine/DOM testで固定する。
- 不均一な折返し行、font loading 後の再測定、実幅でのページ収容は実測系 browser test または preview 目視を必須とする。
- 3MiB/128part batchを帯域256kbps、matching part間隔15秒未満のthrottle条件で受信し、180秒以内にcommitできるbrowserまたはtransport integration gateを必須とする。
- 最大batch転送中に新attention sequenceと複数roster sequenceを投入し、現在part barrier完了→旧roster中止→attention→最新rosterだけの順、attention開始遅延上限、drain上限超過clientだけの切断をtransport integration testで固定する。
- dim、critical overlay、reduced-motion の組合せを preview matrix で確認する。

### Unit 4: 火山 `activeSinceMs` と縮約表示

対象:

- `src/engine/display/standby-state-store.ts`
- `src/engine/display/standby-persistence.ts`
- `src/engine/display/protocol.ts`
- `display/frontend/src/lib/protocol.ts`
- `display/frontend/src/components/VolcanoCard.svelte`
- engine/frontend の volcano tests

完了条件:

- `activeSinceMs` が受理、同内容再掲、identity 変更、取消、seed、restore、legacy migration で §5 のとおり動く。
- card 投影が Lv2+ を含み明示Lv1 alertを除外し、active eventは独立表示し、Lv2単独 severity、seed/restored、Lv2→Lv1 lower が §5.4 のとおり動く。
- Lv1 は現行どおり非表示、Lv2 の4条件一致時だけ縮約、Lv3 以上は常に full になる。
- 火山名とレベル/class は上位ページで全件到達でき、§5.3 matrix どおり詳細が復帰する。
- 7日境界前の full 初期 view は詳細行を1行以上持ち、境界後の縮約 summary 初期 view は詳細行0、後続 detail page は全詳細を持つ。
- `targetKinds.slice(0, 2)` が削除され、全 target kind が詳細ページで到達可能になる。
- Lv4+ の同level対象内容更新と噴火速報更新が`updated`、格上げ/格下げ/解除が対応する閉じたkindを生成して §4 の強制 jump を行い、更新箇所を10秒強調する。§4 に該当しない火山レベル遷移への展開は §6.9 の将来 Phase に残す。
- volcano の最後の1件解除で解除 shell が10秒表示される。

テスト方針:

- persistence round-trip、legacy migration、semantic identity、7日境界を engine test で固定する。
- 永続化・共有状態を触るため `npm run test:shuffle` を必須とする。
- 2列上位ページと詳細ページの実収容は browser test または preview 目視を行う。

### Unit 5: 台風・洪水・熱中症のページ移行

対象:

- `display/frontend/src/components/TyphoonCard.svelte`
- `display/frontend/src/components/FloodCard.svelte`
- `display/frontend/src/components/FloodWideCard.svelte`
- `display/frontend/src/components/HeatAlertCard.svelte`
- `display/frontend/src/lib/standby-cards.ts`
- `src/engine/display/standby-state-store.ts`
- `src/engine/display/protocol.ts`
- `display/frontend/src/lib/protocol.ts`
- 関連 frontend tests

完了条件:

- standby 台風 compact mode が削除される。
- 各カードが固定サマリと詳細ページに分離される。
- card `max-height` によるクリップが残っていない。
- 洪水、`猛烈な` 台風、熱中症特別警戒の closed-table adapter が §4 の jump・強調・queueを生成し、同段階の洪水更新と`猛烈な`台風の諸元更新を`updated`として分類する。
- flood/typhoon/heat の最後の1件解除で解除 shell が10秒表示される。
- `layoutFloodWideRows` の `ほか N 河川`、Heat marquee/reduced-motion 2行 clamp が削除され、全件がページで到達可能になる。
- FloodWideが`clock-top-wide`擬似surface tupleとして単一schedulerへ入り、right-dock周回後に全pageを巡回する。
- 複数 Heat `targetDate` が1つの `heat:active` shellへ集約され、日付が安定した上位 page key になる。
- 720p で dock pager を含む全 active card の固定アンカーと各 pagerへ到達でき、詳細全件を巡回できる。

テスト方針:

- ページデータ生成、closed-table adapter、最後の解除 shell、複数 targetDate 集約は jsdom test で確認する。
- 720p の縦収容、FloodWide の時計非干渉、長い台風位置・河川名・地域名は実測系 browser test または preview 目視を必須とする。

### Unit 6: cleanup、design system 同期、統合 gate

対象:

- `docs/specs/display-design-system.md`
- `display/frontend/src/preview/PreviewApp.svelte`
- `display/frontend/src/preview/fixtures.ts`
- `display/scripts/generate-design-docs.mjs`（監査対象追加が必要な場合）
- 旧選抜/clip/compact tests の削除または置換

完了条件:

- §8 の旧経路がコード・テスト・design system から消える。
- Unit 3〜5 の実 domain rendererを使った最大件数/最大折返し fixtureが§3.4.1の全式を満たし、Unit 2 の synthetic fixtureとの寸法契約差がない。
- 変更装飾の通常/dim/critical overlay コントラストが監査表へ追加される。
- 1920×1080、1366×768、1280×720 の全 gate が通る。
- root と display の build/test/typecheck が成功する。

テスト方針:

- `npm run build`
- `npm test`
- `npm run test:shuffle`
- `npm run display:build`
- `npm run display:test`
- `npm --prefix display run typecheck`
- `npm --prefix display run docs:design:check`
- preview の各解像度・dim・critical・reduced-motion 目視。

## 10. 実装時裁定として残す点

次だけは、実 DOM と fixture corpus を得てから値を固定する実装時裁定とする。設計方針そのものは変更しない。

1. 右側ドックの active card 数ごとの grid row 比率。§3.4.1 の式、全 pager 可視、`scrollHeight <= clientHeight` を満たす範囲で決める。
2. domain role ごとの下線・打ち消し線・順序尺度の新値強調の具体色。通常、dim、critical overlay の監査結果から既存 token を選び、新しい意味色は原則追加しない。
3. 数値ページャの前へ/次へ glyph。ARIA name と24×24px当たり判定は本仕様で確定済みとする。

これらの裁定で、単一schedulerの巡回順、10秒周期、744px container threshold、12ページ切替、aggregate anchor、24KiB chunk/32KiB event上限、Lv2だけの7日縮約、固定アンカー上限、runtime fallback、注目更新の閉表・優先順位、廃止対象を変更してはならない。

## 11. design system 側の要更新箇所

`docs/specs/display-design-system.md` はトークンとアクセシビリティ基準の正本であり、本仕様は待機レイアウト機能の正本とする。実装完了時に design system の次を更新する。

- コンポーネント一覧の `StandbyScreen`: measurement shelf、実高選抜、三段構えの記述を削除し、右側ドックの container query、aggregate anchor、dock/card単一schedulerへ置換する。
- scheduler節: surface-aware tuple、`{upperPageIndex, detailPageIndex}` ordered view、right-dock全件後のFloodWide擬似surface、非表示pauseを追記する。
- §3.4 の待機画面 slot: 現行の4系統（`flood-slot` / `weather-corner` / `standby-corner` / `corner-item`）と外枠高さ計測の記述を、新しい shell、固定アンカー、上位/詳細 pager、full-card fallback の所有権へ置換する。二層 slot の motion 所有権自体は維持する。
- component 総数 `21` の固定記述は、新しい共通 pager、変化強調、解除 shell を反映して generator/実ファイルから再集計した値へ更新する。旧数値を残さない。
- `WeatherAlertCard`: 280px 上限、`clipWeatherRows`、`ほか N 項目/地域` の記述を削除し、最高 rank/count の固定アンカー + 警報名の上位ページ + 地域詳細ページへ置換する。
- `PageDots`: `4 箇所で共有` の固定数を削除して実装後の consumer 一覧/生成数へ更新し、12ページ以下の表示と13ページ以上の数値ページャを追記する。
- `VolcanoCard`: `activeSinceMs`、Lv2だけの7日縮約、Lv1非表示、名前+レベルの上位ページ、Lv3+ full、表示 matrix を追記する。
- `HeatAlertCard`: 複数targetDateの単一shell集約、日付上位page key、marquee/clamp廃止を追記する。
- 待機画面カード拡充節: `full → 台風 compact → StandbyOverflowSummary` と右上高さ予算を削除し、本仕様のドック順・列条件・廃止契約へ置換する。
- component 節: 汎用の change descriptor、期限管理器、共通変化強調 component と domain adapter の責務境界を追記する。
- layout 節: domain 別列数/visual row上限、`HupperBody`/`HdetailBody`を分けた収容式、aggregate実高、gap 0、full-card/layout-failure fallback、横 ellipsis の完全値到達条件、実ブラウザの `scrollHeight <= clientHeight` gate を追記する。
- transport 節: weather canonical roster/attentionをsnapshot外の24KiB `standby-weather-batch` chunksで運び、32KiB event/256KiB snapshot上限、partごとの全client barrier、5秒drain上限、obsolete rosterのpart境界中止、attention開始遅延上限「現在1part + 5秒drain」、roster最新1世代coalesce、blocked client切断、欠落safety jumpを守る契約を追記する。
- state節: emergency中pendingのstable-key coalesce、256件/512KiB上限、`critical-resync`縮退を追記する。
- motion 節: 注目更新の fade-in、10秒 change echo、`RollingNumber` と animation を重ねない規則、reduced-motion 時の装飾維持を追記する。
- accessibility 節: 順序尺度の旧値→新値+新値強調、カテゴリ追加の下線、カテゴリ更新の旧値→新値・`更新` label・新値下線、カテゴリ解除の打ち消し線、可視種別 label、300ms debounce の polite status、focus 非移動、ページ変更非通知を追記する。
- 適用範囲節: 本 Phase は closed-table の緊急 jump/強調 consumer と WeatherAlertCard の既定 consumer に限定し、他カードの通常更新への展開を将来 Phase、emergency 画面と ticker を非適用と明記する。
- コントラスト監査表: 追加・格上げ・更新・解除・格下げについて通常、dim、critical overlay の組合せを追加する。

現行 design system の旧高さ予算記述と本仕様が矛盾する期間は、本仕様を将来実装の契約、design system を現行実装の記録として読む。Unit 6 完了時に矛盾を解消し、この例外文も不要になる。

## 12. 受入シナリオ

最低限、次を preview fixture と回帰テストへ含める。

1. 1280×720、1366×768、1920×1080 で §3.4.1 の `HupperBody`/`HdetailBody`、domain 別列数/visual row 数、aggregate 実高を代入した最大6 shell fixtureを表示し、中央時計・左上・ticker と重ならず、全ページで `scrollHeight <= clientHeight` になる。
2. dock page を切り替えても aggregate anchor に全 active domain の最高状態・件数が同時表示され続ける。最大値の2倍長文字列でも固定アンカー/上位ページは最大2行に留まり、ellipsis の完全値へ詳細ページと accessible name の双方から到達できる。
3. 通常収容式を意図的に満たさない fixture は full-card pager へ切り替わり、さらに最小1行も入らない fixture は domain・最高状態・件数を持つ `表示領域不足` shell になり、カードが DOM から消えない。
4. 暴風警報の地域追加が旧表示上限より後方にあり、更新直後にそのページへ jump して下線+`＋`が10秒見える。
5. 旧snapshotでは地域A〜Fを6件表示、更新後はA〜Fのまま`omittedAreaCount`だけ増えるtransport縮退でも、完成roster/attentionにより新規地域Gのstable key・実名を特定し、Gを恒常pageへ追加して10秒強調できる。
6. 旧 snapshot の `omittedAreaCount > 0` から地域Gが解除された場合も、canonical batch によりGを打ち消し線+`解除`で10秒表示する。旧 server fallback は実名を推測せず `対象地域を更新（省略地域を含む）` と表示する。
7. 暴風警報解除で旧地域が変更エコーとして打ち消し線+`解除`を10秒表示し、その後消える。
8. weather、tornado、flood、volcano の各 domain で最後の1件を解除すると、旧 card shell が同じ位置に10秒残って解除を示し、期限後に shell ごと退場する。
9. typhoon、heat の最後の1件解除も同じ共通 shell を使い、現行 card と解除 shell を二重表示しない。
10. 竜巻目撃が通常竜巻ページの巡回中に届き、目撃ページへ即時 jump して10秒後に巡回へ戻る。
11. 同一 card に容量を超える複数更新が同時到着すると、収まる更新を先頭ページへ集約し、残りを優先順の pending page queue で巡回し、`未表示の更新 N件` が可視化済み件数に応じて減る。
12. 洪水の氾濫発生情報、`猛烈な` 台風、熱中症特別警戒アラートの各更新が closed-table adapter から jump・強調を発生させる。一方、長周期地震動、南海トラフ、表にない critical kind は standby jump を発生させない。
13. active eventを伴わないLv1火山は新規受理・継続・Lv2からの格下げのいずれでも volcano card に表示されず、active 件数にも含まれない。Lv1の継続時間は後のLv2へ引き継がれない。
14. 火山 Lv2 が6日23時間59分では full、4条件を満たす7日境界で初めて縮約可能になる。
15. Lv2 が7日超でも噴火イベント中または active warning class 中は full、条件解消後は名前+レベルを上位ページに残して詳細だけ縮約される。
16. Lv3 以上が長期継続しても full のままになる。
17. 縮約中のLv2に噴火イベントが発生すると同じ render cycle で full に戻り、`warningKind`、全 `targetKinds`、`latestEvent` 諸元がページで到達可能になる。
18. `targetKinds` が3件以上でも `slice(0, 2)` や `ほか N` に変換されず、全件を詳細ページで確認できる。
19. 火山 Lv4→Lv3 では対象ページへ強制 jump し、`Lv4 → Lv3`、`↓`/`格下げ`、下線付き新値を10秒表示する。警報解除・噴火速報取消では旧対象を打ち消し線+`解除`で10秒表示する。
20. 気象警報の順序尺度が上がる/下がると `旧値 → 新値`、格上げ/格下げ label、下線付き新値を10秒表示し、旧値には打ち消し線を付けない。
21. 13ページ以上で PageDots が数値ページャへ切り替わり、手動操作後に pending queue、次いで10秒周期が再開する。
22. emergency 表示中に standby 注目更新が届いても status/期限を開始せず、復帰時に最新ページへ safety jump して10秒強調する。
23. SSE 再接続で token 連続性がある場合は未消化差分を一度だけ処理し、連続性がない場合は架空の旧値を作らず現在 active な closed-table critical ページを `再接続後の重要情報` として確認する。
24. 注目更新が300ms内に複数届くと polite status は優先度最上位の説明+`ほか N件`を一度だけ通知し、同 token、ページ巡回、手動ページ変更では通知しない。
25. reduced-motion で page/更新/`RollingNumber` animation が0msになっても、自動巡回、矢印、記号、下線、打ち消し線、10秒保持が残る。
26. requested dim 中の注目更新で10秒だけ effective dim が解除され、requested dim を失わず自動復帰する。
27. 同内容の定時再掲で jump、変化強調、status、dim 解除が再発火しない。
28. persistence 復元直後に追加/解除強調は出ず、火山 `activeSinceMs` だけが復元される。critical 現況確認は差分強調と区別される。
29. 対象ページの実測確定が遅れても、変化強調の10秒はページが初めて可視になってから始まる。
30. `RollingNumber` を含む順序尺度で外側の accessible label が始点・終点・格上げ/格下げを読み上げ、digit と変化を重複して読み上げない。
31. 3 dock page、各pageに複数card、各cardに複数ordered viewを持つfixtureを手動操作なしで動かし、単一schedulerが各`(surfaceOrder, surfacePageIndex, cardKey, cardView)` tupleを固定順に一度ずつ表示してから周回し、非表示cardのindexが背後で進まない。
32. canonical roster/attentionを意図的に24KiB超へ増やすと複数`standby-weather-batch` messageになり、各encodeは32KiB以下、partIndexは欠番なし、snapshot/stateに本文が入らず、全source最大watermarkも2KiB以下で256KiB budgetを圧迫しない。
33. chunkの中間part欠落、重複、順序逆転を注入し、完成batchだけが一度commitされる。matching partを受信し続ける間は15秒idleが更新され、180秒総上限までは完走でき、idle/総上限超過時だけ部分情報を表示せずsafety jumpになる。
34. Lv2単独 volcano は `severity: normal` で card化され、Lv3/active warning、Lv4+/噴火速報でそれぞれ warning/criticalになる。startup seedはrestored false、persistence restoreはtrue、active eventのないLv2→Lv1 lowerで投影から外れて最後の1件なら解除 shellになる。
35. Heat の3つ以上の `targetDate` が同時 activeでも `heat:active` shellは1枚だけで、日付昇順の安定page keyから全日付・地域へ自動巡回でき、最大6 shell前提を崩さない。
36. Lv2の7日境界直前は `volcano:<code>:full` が初期 indexで上位 bodyと詳細行1件以上を同時に持ち、境界直後は `volcano:<code>:summary` へresetして詳細行0になる。後続 `detail:<n>` では同じ詳細全件へ到達できる。
37. canonical batchは128 parts以下かつpayload総量3MiB以下なら許容する。129 partsまたは3MiB超のfixtureだけを、部分payloadなし・partCount 0・32KiB以下の`tooLarge` markerへ置換してsafety jumpする。
38. 地域G追加の10秒強調終了後、初回接続、SSE再接続、同内容再掲後の各時点で、完成rosterからA〜Gすべてのactive地域pageを再構成し、自動巡回と手動pagerの双方で全件へ到達できる。
39. watermarkを含むstate自体、roster chunk、attention chunk、markerをそれぞれblocked-skipさせるfixtureで、該当clientが即切断され、途中partを継続送信せず、再接続後のsnapshot+最新roster+最新attentionで完全同期する。
40. 複数right-dock pageと複数pageのFloodWideを同時activeにし、schedulerがright-dockの全tuple後に`(clock-top-wide, 0, flood:wide, cardView)`全件を巡回して先頭へ戻る。
41. 上位3page・詳細2pageのfull cardは`{u,d}`直積6viewを、上位3page・詳細数が不均一な縮約cardは全`{u,null}`後に所有関係どおりの`{u,d}`を、重複・欠落なく有限時間内に表示する。
42. emergency中に同じstable keyへ追加→格上げ→解除、baseline active項目の解除、257 keysまたは512KiB超を投入し、net差分coalesce、不要な一過性項目の除去、上限超過時の単一`critical-resync`と最新critical現況safety jumpを確認する。
43. `chunk`、`tooLarge`、`descriptorTooLarge`の各wire shapeについて必須/禁止field、watermarkとのstatus/partCount一致をprotocol testで固定し、未知statusを受理しない。
44. 最大3MiB・128part batchを256kbps相当、各matching part間隔15秒未満で配信し、idle timeoutを誤発火せず180秒以内に完成commitするbrowserまたはtransport integration testを通す。
45. `猛烈な`台風の強度classを保ったまま位置・中心気圧・最大風速のいずれかが意味変更されると、domain adapterが`updated`を生成し、対象pageへjumpしてカテゴリの`旧値 → 新値`、可視`更新` label、新値下線、完全なaccessible labelを10秒表示する。
46. Lv4以上の火山でlevelを保ったまま対象地域、`warningKind`、`targetKinds`のいずれかが変わると、domain adapterが`updated`を生成し、同じ更新表現を10秒表示する。
47. 同一噴火速報の識別子を保った更新で噴火時刻、火口、噴煙高その他のcanonical諸元が変わると、domain adapterが`updated`を生成し、同じ更新表現を10秒表示する。同一内容再掲では生成しない。
48. 洪水が同じ氾濫段階のまま対象河川またはcanonical詳細を更新すると、domain adapterが`updated`を生成し、同じ更新表現を10秒表示する。段階遷移は`promoted`/`demoted`のままとする。
49. 最大batchのroster中間partを送信中に新attention sequenceと同一sourceのroster 2世代を到着させる。現在partの全client enqueue/drain barrierを完了した次のpart境界で旧rosterを中止し、attention、最新rosterの順に送る。attentionの先頭partは受理から最大「送信中の1part + 5秒drain」以内に開始し、旧rosterの残partや180秒総上限に塞がれない。古いpending rosterは送らない。旧rosterの部分batchはcommitされず、1clientだけが5秒以内にdrainしない場合はそのclientだけを切断し、他clientはattentionと最新rosterを順序どおり受信・commitする。
