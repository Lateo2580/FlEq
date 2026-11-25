# P4-UW-AREA-KIND-001 の設計の表 r3（U-W の区域ごとの種別を新しい経路へ載せる）

- 起草: 2026-11-26 00:14（date の値。起草の子 r0）。r1 は r0（024eaf2e）へのヘルツの独立レビュー（NO-GO、6 件）と契約適合レビュー（条件付き GO）を統合担当がまとめた直し 11 件を当てた（対応は §8）。基点 7bf652f1953809c5c9b0913828fb0c5a31cce2f7（branch draft/p4-uw-area-kind）。行番号と anchor はこの HEAD の値（024eaf2e は本契約の 3 file だけを足した commit）。r3 は発注前点検（2026-11-26 07:53）: branch を main e6dae65d〔S0 の配送の後〕の上へ載せ直し（衝突なし、本契約の «» 72 本は今の木でも全部合う）、decisionBranches 5 件を統合担当が A で確定し、未決の問い 2 つを閉じた（JSON の questionResolutions）。
- 範囲の元: Q-DV-UW-AREA-KIND（reconstruction/contracts/p4-display-vocab.json:702 «3e4466f31a4e558e»）。要る根拠は、行の形の作者の裁定 DS-WARN-09（2026-11-23 13:32「案1でいきましょう」。docs/specs/reconstruction-display-design.md:548 «270f2e082ef2a24c»）と、DS-WARN-12（統合担当の案を作者が 13:52 に受けた「設定地域カードについてはその案で進めてみてください。」、C0 の見本の図でもう一度見せる。docs/specs/reconstruction-display-design.md:551 «df92bf49b5f7805e»）。
- 出どころの書き方: 「統合担当の案」は起草の子が置いた案。decisionBranches の 5 件は 2026-11-26 07:53 に統合担当が A で確定した（作者の字ではない。どれも wire の形・版・順の内部の決めで、画面の見え方は変えない）。「作者の裁定」は原文のある物だけ。
- 範囲外: 区域名（Q-DV-UW-AREA-NAMES）、カードの描画、区分・重い順・名前の縮め、設定した地域の値、U-Q。

## 0. 結論
- U-W の state は、区域ごとの種別を今すでに持っている。報の行は区域の token ごとに種別の列で（reconstruction/contracts/p2-weather-current-unit.types.ts:37 «94bc445bbab1692e»、受理の組み立ては reconstruction/src/domains/weather-current/weather-current.ts:292 «aefa1b8cd4a97c62»）、全国報と partial を合わせた後の府県ごとの勝った行（型 Cell: 層・区域の Code・Kind/Code・Status・復元の印）が公開形を作る時に手元にある（reconstruction/src/units/weather-current/weather-current-public.ts:118 «d4f7cb4e885c6b5a»）。だから写すだけで、保存の形・合わせの規則・差分の条件は変えない。
- 載せる形（統合担当の案、D-FORM・D-LAYER）: 語彙 weatherCurrent.area の今の一覧 areas の行に、その区域の種別を 1 列足す（`[区域 Code, null, "03 14"]`、列の名 kinds）。4 層と高潮予報区間の全部の行に入れる。
- 置き場（統合担当の案、D-PLACE）: 公開形（view）は変えず、表示差分の府県の行に areaKinds を添える。旧の経路 /events の view と要約の計量は 1 byte も変わらない。
- 全国の VPWS50 1 通で ＋24,593 byte（同じ日の通常と訓練で ＋49,186）。市町村等の層だけを別の一覧にする案（下調べの推奨）の ＋48,985 より小さく、上の層の値も落ちない。

## 1. 今の材料と、どこが公開形を読むか
| 読む所 | file:行 | 何を読むか | 本契約で変わるか |
|---|---|---|---|
| 府県の合わせ（勝った行）と公開形 | reconstruction/src/units/weather-current/weather-current-public.ts:118 «d4f7cb4e885c6b5a»・reconstruction/src/units/weather-current/weather-current-public.ts:125 «008936da62e2a054» | 勝った行 → areas・codes・names | 行の中に種別の組を作る 1 か所だけ足す |
| 勝った行が動いたかの比べ | reconstruction/src/units/weather-current/weather-current-public.ts:111 «f67ad638eb296f86» | 層・区域・Code・Status・名前・報時刻・復元の印。公開形の欄が同じでも、この列が違えば版が進む | 変えない（§3） |
| owner の view | reconstruction/contracts/p2-weather-current-unit.types.ts:85 «ecc2d5c29310daae»・reconstruction/src/units/weather-current/weather-current-public.ts:199 «bb5093a4fb1617b0» | areas（公開形） | 変えない |
| 表示差分の府県の行 | reconstruction/src/units/weather-current/weather-current-unit.ts:734 «43965e35fc0c4113» | current に公開形 | areaKinds を添える |
| 表示差分の監視の行 | reconstruction/src/units/weather-current/weather-current-unit.ts:729 «fdf335a77eeb18af» | current は null | areaKinds は null |
| 取り直しの採用の差分 | reconstruction/src/units/weather-current/weather-current-unit.ts:863 «200a8d3e0af8aa54» | displaySubjects を前後で比べる | 変えない（同じ行を通る） |
| 旧の要約と計量 | reconstruction/src/view-projector/view-projector.ts:225 «df632f347d770f91»・reconstruction/src/view-projector/view-projector.ts:214 «09afc2f0651a8562»・view-projector.ts:456〜:458 | areas・codes・view の byte | 変えない |
| 旧の Current（view）を読む端末 | prompt-current.ts:69 | codes・names | 変えない |
| 通知の step | weather-current-notice.ts:67・:309 | 府県の entry・公開形 | 変えない |
| 新しい経路の語彙 | reconstruction/src/view-projector/display-vocab.ts:109 «585bfd10334ca540»・reconstruction/src/view-projector/display-vocab.ts:114 «361b671a7c81697c» | areas → 層ごとの一覧、codes → phenomena | areas の行に kinds の列を足す |
| 新しい経路の入力 | reconstruction/src/view-projector/display-wire.ts:567 «572f78141831d596»・reconstruction/src/view-projector/display-wire.ts:599 «de7a2085cb029867» | 表示差分の current（:599 の idsOf は公開形の id・revision を読むだけ） | :567 で areaKinds を添えて渡す。:599 は変えない |
| 待つ・待たないの判定 | reconstruction/src/view-projector/display-wire.ts:899 «219408204dece296» | before と after の areas の集合 | 変えない（種別だけの減りは今どおり待つ、Q-DC-URGENT-REMAINING） |
| 詳細の part=item | reconstruction/src/runtime/owner-runtime.ts:905 «613cd500c9b7f145» | 公開形 → 語彙の項目（切らない） | areaKinds を渡す |
| 詳細の part=areas・index | weather-current-public.ts:258〜:310 | 勝った行・公開形 | 変えない |
| 災害の runner | test/disaster/runner.ts:105・:679 | 保存の byte と view の codes | 変えない |

表示差分・公開形・語彙のほかに、`weatherCurrent.areas`・`codes` を読む所を reconstruction/src と reconstruction/test で数えた（grep は §7）。地図の描画（M0）と画面のカード（C0）はまだ無い。

## 2. 決めること（統合担当の案。2026-11-26 07:53 に 5 件とも A で確定）
### 2.1 置き場（D-PLACE）
| 案 | 中身 | 旧の経路 | 触る所 |
|---|---|---|---|
| A 表示差分の府県の行の areaKinds（推奨） | `RuntimeDisplaySubject` の U-W の行に `areaKinds: WeatherCurrentAreaKinds または null`（府県の行だけ値、監視の行は null）。公開形と勝った行を一緒に持つ所（Entry、weather-current-public.ts:29）に派生値を添える形を推すが、手段は決めない。公開形を使い回すときは同じ値を使う | 変わらない（view・要約・計量・/events の byte が今のまま。T05 の公開形の鍵の期待もそのまま） | p2-shared-runtime.types.ts :214、uw の unit と public、display-wire の入力、owner-runtime の part=item、display-vocab |
| B 公開形（WeatherCurrentPublicArea）に欄を足す | 公開形 1 か所。新しい経路・詳細はそのまま届く | view と要約の計量の byte が増える（全国 1 通で ＋35,879、区域の組に種別の列を足した数、script）。1 MiB の判定は経路ごとなので、旧の総量が増え、旧の要約（65,536 を超えた分野）の組が変わりうる。旧の full は P2-A8・C4・C6 の manifest と runner の合否（計画:69）が読む | 同上から owner-runtime・unit を除く。p3-uw-canon.json の P3-UWC-AC05 (1)(3) と型の行 :24（p4-display-capacity が引く）、T05 の鍵の期待（reconstruction/test/uw-canon/uw-canon-unit.test.ts:193 «02a86cd62190aa94»）を改める |

- A の根拠: 旧の経路の出力は T0 まで今のまま（P4-DW-D-LEGACY=A、p4-display-wire.json の P4-DW-AC01）。B は B0 の AC16 のように「足した欄が旧にも出る」形で、U-W は既に 65,536 を越えているので影響が他より大きい。
- 無いと何が壊れるか: 区分ごとのカード（DS-WARN-09）と設定した地域のカード（DS-WARN-12）が、どの市町村にどの種別が出ているかを作れない。

### 2.2 層（D-LAYER）
| 案 | 中身 | 足す byte（全国 VPWS50 1 通） | 上の層だけの種別が来たとき |
|---|---|---|---|
| A 全部の層の行に種別（推奨） | 府県予報区等・一次細分・まとめた地域等・市町村等・高潮予報区間の、今の areas に出る全部の区域 | 24,593（最大の府県 1,308〔長野県〕） | 市町村等に無い種別も、その層の行に残る。どの層で描くかは C0 |
| B 市町村等の層だけ（areas の行に足す） | municipality の行だけ kinds | 17,732（最大 1,077） | 上の層だけの種別は、どの区域に出ているかが wire から分からない |
| C 市町村等の層を別の一覧に（下調べの推奨、種別 → 市町村の Code） | 府県の項目ごとに [種別, 市町村の Code の並び] | 48,985（最大 3,095）。今の areas の行と二重に持つ | B と同じ |

- 上の層だけにある種別を数えた（§5 の script、VPWS50 5 本〔本文は 2 種類〕・VPWW55 5 本・57 3 本・58〜61 各 1 本の 17 本。VPWW56 は U-L なので外した）: 区域コードの表の親子（area-codes.v1.json の group → primary → prefecture）で、市町村等 → まとめた地域 → 一次細分 → 府県予報区等の各段の種別が 1 つ下の段に必ずある。どの段も 0 件（表に無い 15 の市町村コード〔横浜市・神戸市・広島市など〕は先頭 5 桁の区の group で補った）。高潮予報区間は VPWW57 に 1 区域あり、その種別は市町村等にもある（0 件）。実の partial の数が少ない（VPWW55 は 5 本、57 は 3 本、58〜61 は 1 本ずつ。合成を含む）ので、実の配信で起きないとは言えない。A はこの欠けを作らない。
- 高潮予報区間: A では VPWW57 の区域の行に種別が載る。全国の VPWS50 は高潮予報区間の層を持たない（5 本とも 0、この fixture の数）。

### 2.3 行の形（D-FORM）
| 案 | 形 | 全国 1 通 | 備考 |
|---|---|---|---|
| A 行の 3 列目に、半角の空白で区切った種別の字（推奨） | `["0820200", null, "07 10 14 15 19 49"]`、cols は ["kinds"] | 24,593 | Kind/Code は 2 桁の数字に限る（reconstruction/src/domains/weather-current/weather-current.ts:292 «aefa1b8cd4a97c62» の直前の検査、weather-current.ts:284）ので、空白で割って読める。VocabCell（reconstruction/contracts/p4-display-wire.types.ts:181 «ff0a05ccd9ad1af3»）は広げない |
| B 行の 3 列目に字の配列 | `["0820200", null, ["07","10"]]` | 37,195 | VocabCell に `readonly string[]` を足し、17 種の一覧の読み手が配列を考える |
| C special に専用部品 | special kind weatherAreaKinds | 48,985（市町村等だけ）・80,023（4 層を種別ごと） | special は今 null で、台風・洪水だけが使う |

- 並び: 種別は昇順、区域は今の areas と同じ（層の名前の字の昇順 → Code の昇順）。`phenomena` の鍵・名前・区域の数はそのまま（名前は phenomena の 2 列目、区域の数は層を合わせた数）。
- 読み手の確かめ: 各区域の行の kinds は 1 つ以上・重複なし・昇順の 2 桁。全部の行の kinds を種別ごとに数えた数は、その項目の phenomena の areaCount と一致する（復元して未確認の行は両方に入らない）。

### 2.4 版（D-VERSION）
A 版は v3 のまま（推奨、reconstruction/contracts/p4-display-wire.types.ts:100 «97acae2a45f702ce»）。areas の行を読む描画はまだ無く、client と server は同じ repo の同じ build で出る。S0 の client の外形の確かめ（reconstruction/src/display/screen/client.ts の isWireSnapshot）は分野の unit と contentRevision までで、行の列が増えても弾かない（S0 の配送 e6dae65d の後に確かめた）。B `p4-display-wire-v4` にする（S0 の client の定数と、その行を引く 3 契約の «» の付け直し、開いたままの画面は非対応の表示になる）。

### 2.5 計画の直列（D-ORDER）
A B1 の後・E0 発注 1 の前に 1 本（推奨、reconstruction/contracts/p4-order-plan.md:223 «9abef27fd39b349e» の直列に足す）。display-wire.ts は :567 の行の中だけ、display-vocab.ts と p4-display-wire.types.ts は C0 発注 1 の前に要る。B E0 発注 1 の後（C0 発注 1 が材料を待つ）。

## 3. 種別と区域の対応が古いまま残らない条件
| 起きること | 何が変わるか | 根拠 |
|---|---|---|
| 同じ区域の種別だけが入れ替わる（区域の集合も種別ごとの数も同じ） | 府県の勝った行の列が変わるので、公開形の object と版が新しくなり、表示差分が出る | 比べは勝った行の Kind/Code を含む（reconstruction/src/units/weather-current/weather-current-public.ts:111 «f67ad638eb296f86»、reconstruction/src/units/weather-current/weather-current-public.ts:118 «d4f7cb4e885c6b5a»） |
| 続報で解除・なし・Code 00 になる | activeCell に入らないので、その行の kinds から消える。府県の行が全部消えれば項目が消える | reconstruction/src/units/weather-current/weather-current-public.ts:115 «e5b4058391f6d7ba»（T02 (ア) の解除の報） |
| 訂正・取消・全国報の置き換え・partial の退去・VPNO50 の終了 | 変わった報の before と after が載せる府県の和集合だけ作り直す。取消は残っている版へ戻る | P3-UWC-AC09 (1)（reconstruction/src/units/weather-current/weather-current-public.ts:185 «1b1a700b3b2e4445»） |
| 全国報の合わせの規則（partial が語った区域、報時刻が同じ） | 勝った行の決め方は今のまま（P3-UW-STALE-DOWNGRADE-001・P3-UTP）。本契約は勝った行を写すだけ | 同上 |
| 復元した直後（復元して未確認） | activeCell が復元の印の行を除くので areaKinds は空、areas も空（今どおり）。unit が新しい current を採ったとき（版が新しい報の採用）に、その府県の値になる。同じ版・同じ本文の報は duplicate で現況を採らないので、元の種別は戻らない（取り直しの採用でも、正味の差分が無ければ府県の行の差分は出ない） | 既存の P3-UWC-T03 と同じ性質。weather-current.ts の duplicate の判定、weather-current-unit.ts の recoveryChanges |
| 期限 | U-W の現況は期限で閉じない（P3-UWC-D-EXPIRY、partial は期限なし）。freshness は監視の行だけ | view と同じ |
| 公開形の使い回し | 公開形の object が同じなら areaKinds も同じ値。新しい公開形には作り直した値 | 公開形は publicArea の中でだけ作る。worker をまたぐと object は写しになるので、main は受けた行の areaKinds だけを読む（T03） |
| 同じ公開の中で 2 回変わる | 表示差分は最初の before と最後の after に合わさる（mergedByUnit）。項目は最後の after から作る | display-wire.ts の mergedByUnit |

## 4. 受信経路の計算量・転送・保持
| 仕事 | 対象 | 量（XML から、script r1count.py） |
|---|---|---|
| (1) 対象の府県を選ぶ走査 | current が変わった報の before と after が載せる (operation, 府県) の和集合。全国報・VPNO50 の終了でも変わった報が載せる府県だけで、その operation の全府県ではない（全国報に現れない partial だけの府県は触らない、P3-UWC-T09） | 全国の VPWS50 の置き換えは 47 府県、partial 1 通は実配信でほぼ 1 府県 |
| (2) 対象の府県の作り直し | 今の合わせ（全国報の行と partial の行）＋本契約の分: 勝った行を 1 回走って層ごとに分け、層の名前の順につなぐ（高々 5 層） | 全国の初報で 6,559 勝った行（active 6,301。福井の差し替えは 6,473・6,204）、1 府県の最多は長野県 364 行 |
| (3) 変わった項目の作り直しと直列化 | K 件（P4-DV-AC06、AGENTS.md:25 «b7f4c3a89b5bb3b2»） | 全国の置き換えで 47 件 |
| (4) 並びの併合 | 既存の N 件と K 件を 1 回（projectVocab の併合、今のまま） | O(N＋K log K) |
| 転送（worker をまたぐ量） | 表示差分 1 通の before と after の両方に areaKinds の欄が載る。足す分は、全国の VPWS50（15_18_01_250630_VPWS50）を synthetic_VPWS50_fukui_base で置き換えた 1 step で、47 府県の before 96,020 ＋ after 95,214 ＝ 191,234 byte（UTF-8 JSON、欄の字を含む）。同じ 47 組の最小の形の v8.serialize の増えは 196,373 byte。初報は before が無く 96,020。ヘルツの独立の数（96,020・95,214・191,234・196,373）と一致 | script r1count.py・r1v8.py |
| 保持 | 値は公開形の object ごとに 1 つ。旧い公開形を参照できる所（取り直しの候補・採用前の live・停止の確定で main が留めた差分・未処理の返信）がある間は、旧い値も残る。それぞれの寿命は今のまま（P4-UAK-RET-01）。実の heap は量っていない | — |

- 種別の列は全国走査・state 全体の直列化を足さない。比べに使う detailRow は行の数に比例する今のまま。
- 保存・復元: 派生の値なので checkpoint に入らない。復元は今の合わせ（P3-UWC-AC04 (3)）を作り直すだけ。復元境界（codec）に足す検査は無い。旧い保存の扱い: 変わらない（schemaVersion は v8 のまま、P3-UWC-D-SCHEMA の範囲を開けない）。
- 保持件数: 区域×種別の数は state の partial 384＋64・全国 1 の行の和で、区域の件数の定数は受理に無い（今の公開形 areas と同じ性質）。だから wire の 1 項目の byte の上界は定数で書けない（受理は区域 Code が数字であることだけを見る。1 府県に 2,979 件以上なら行だけで 65,536 を越え、詳細の 1 応答は今の規則の 503、AC06）。既知の表での大きい目安: 1 府県の最多は北海道の 4 層 262 区域で、全部の区域に WEATHER_SEVERITY の active の Code 36 を全部入れた areas の一覧は 33,592 byte（script r1v8.py、起きる値ではない）。

## 5. 容量（script `.tmp-p1/uwbytes.py`、git に入らない。XML を読んで行を数え、語彙の一覧の形を組んだ JSON の byte で数えた。vocabItem の実の出力ではない）
「今」は weatherCurrent.area の areas の一覧だけの byte（行と包み）、＋A は D-LAYER=A・D-FORM=A の増え、市町村等だけは D-LAYER=B。

| fixture（active 行数） | 今の areas | ＋A（4 層＋高潮） | ＋市町村等だけ | C（種別→市町村、別の一覧） | 4 層を種別ごと |
|---|---|---|---|---|---|
| 15_18_01_250630_VPWS50（6,301） | 53,841 | 24,593 | 17,732 | 48,985 | 80,023 |
| synthetic_VPWS50_fukui_base（6,204） | 53,657 | 24,280 | 17,524 | 48,336 | 78,811 |
| synthetic_VPWS50_national_0907_1300・1302・training_0907_1301（6,301×3、親と同じ本文） | 53,841 | 24,593 | 17,732 | 48,985 | 80,023 |
| 15_17_01_251222_VPWW55（24） | 765 | 148 | 82 | 169 | 350 |
| 15_16_02_251222_VPWW57（10） | 622 | 85 | 32 | 69 | 237 |
| 15_16_04_251222_VPWW58（15） | 616 | 103 | 57 | 119 | 293 |
| 15_16_05_241226_VPWW59（14） | 599 | 98 | 52 | 109 | 283 |
| 15_16_06_241226_VPWW60（15） | 616 | 103 | 57 | 119 | 293 |
| 15_16_07_250825_VPWW61（37） | 616 | 169 | 57 | 182 | 1,190 |
| 18_00_01_260830_VPWW55_fukui_L5（14）／downgrade（16） | 599／633 | 98／108 | 52／62 | 127／138 | 331／327 |

- 1 府県の最大（VPWS50 の fixture）: 今 2,870（01 北海道）、＋A 1,308（20 長野県）。1 区域の種別の最大は 6（例 茨城県日立市）。part=item の 1 件は P4-DISPLAY-VOCAB-001 の表 §12 の実測で U-W 4,666〔累積 5,594〕で、＋1,308 足しても 65,536 に遠い。
- U-W の分野: 全国 1 通 93,649 → 118,242、通常と訓練 186,508 → 235,694（reconstruction/contracts/p4-display-capacity-tables.md:181 «ab62d8c865a62101» の値に ＋A を足した計算で、量っていない）。1 分野の予算 65,536 は今も越えている（reconstruction/contracts/p4-display-capacity-tables.md:29 «b39db86b87a4964c»）。
- M5 の数え直し（`.tmp-p1/m5.py`、s0-draft の `m2-M5.json` の 9,244 公開に同じ byte を足し、上界 377,434 を足した「導いた組」。0 の行は capt の reconstruction/contracts/p4-display-capacity-tables.md:65 «484e6e8dcb1ebd87» と同じ 960 公開・1,092,725）:

| U-W に足す byte | 中身 | 1 MiB を越えた公開 | 要約になる分野 | 最悪の公開 |
|---|---|---|---|---|
| 0 | 今 | 960 | U-F | 1,092,725 |
| 24,593 | D-LAYER=A、通常だけ | 1,268 | U-F | 1,117,318 |
| 49,186 | 同、通常と訓練 | 1,710 | U-F | 1,141,911 |
| 35,464 | D-LAYER=B、通常と訓練 | 1,531 | U-F | 1,128,189 |
| 97,970 | C、通常と訓練（下調べ） | 2,690 | U-F | 1,190,695 |
| 155,888・160,046 | 4 層を種別ごと、通常と訓練 | 4,641・4,770 | U-F 4,276〜4,268、U-F＋U-M 365〜502 | 1,248,613・1,252,771 |

- 読み: 要約になる分野は今と同じ U-F だけで、その時間が長くなる。U-W（7 番目）が要約になる組は出ない。どの公開も 1 MiB に収まる（M5 の 9 分野の和の最大 764,477 に 377,434 を足して 1,141,911 だが、要約で 1,048,576 以下へ落ちる）。
- m5-add.py との違い: 同じ集計（同じ 9,244 公開・同じ順・同じ上界）で、足す byte だけを替えた。1 通の値を全部の時刻に当てた上側の見積もりなのは同じ。M5 の各時刻の実の区域×種別の量は分からない（採取物は repo の外）。
- 分からない所: W1・W2 の実の日の U-W の増え（M5 は W1 06-26 の写し）、1 府県に全国 1 通より多い種別が並ぶ日、区域の数が表を越える報。統合担当が配送の前に Mac mini で数える（JSON の artifactRequirements の最後の項）。
- 予算 65,536・1 MiB・要約の順（P4-DC-D-SUMMARY-ORDER=B）・要約の形は変えない。容量の契約の値の改訂は §6。

## 6. ほかの契約・計画の字で、改める必要がある所（改めていない）
| file | 行 | 改める字 |
|---|---|---|
| reconstruction/contracts/p4-display-vocab.json | :702 | Q-DV-UW-AREA-KIND を閉じる（本契約の範囲・D-LAYER・D-FORM） |
| 同 | :378・:388・:400 | outOfScope の「U-W の公開形の変更（区域と種別の対応）」から外す、AC01・AC02 の areas の一覧の字（cols に kinds）。AC02（:399 は id の行、条文は :400）の「今の view の欄を落とさない・足さない（id は足す）」は、view に無い kinds の列を足す本契約が改める条文 |
| reconstruction/contracts/p4-display-vocab-tables.md | :69・:112・:117・:119・:298・:329・:404 | areas の行が `[Code, null, kinds]`、§2.1 の表、:117 の「表示差分の … は載せない」の行に areaKinds（これは載せる）、:119 の「今の公開形に無い」の段落、:298 の「語彙は view の object の純粋な関数」（areaKinds も入力になる）、:329 の直列、:404 の part=item の実測（U-W 4,666〔累積 5,594〕を量り直す） |
| reconstruction/contracts/p3-uw-canon.json | :605 | P3-UWC-AC09 (2) の「全国報の受信と VPNO50 の終了は、その operation の全府県を作り直す」（実装と P3-UWC-T09 は変わった報が載せる府県だけで、条文の字の側が広い） |
| reconstruction/contracts/p3-uw-canon.json | :543 | P3-UWC-AC05 (2) の府県の行に areaKinds（公開形の (1)(3) は変わらない） |
| reconstruction/contracts/p2-shared-runtime.json | :222 | P2-A1-DISPLAY-CHANGES.port の U-W の行の形に areaKinds |
| reconstruction/contracts/p4-display-capacity-tables.md | :29・:181・:64・:65 | U-W の 1 通・E3・M5 の数（実測で置き換え。AC06 の E3 の試験は byte を決めずに full を見るので変わらない） |
| reconstruction/contracts/p4-order-plan.md | :223・:124・:193・:866 | 直列に本契約を足す、C0 発注 1 の依存を S0 と本契約に |
| p4-display-wire-tables.md | :175 | weatherCurrent の part は「無し」のまま（値の載る所が snapshot になるだけ） |

## 7. 数えた範囲と未確認
- 読んだ: weather-current-public.ts 全部、weather-current-unit.ts の :540〜:640・:700〜:867、weather-current.ts :265〜:310、view-projector.ts の weatherTally・fixedBytes・weatherState、display-vocab.ts :1〜:140、display-wire.ts の projectVocab・projectDisplayWire・urgentOf・mergedByUnit・vocabSource・idsOf、owner-runtime.ts :840〜:1010、p3-uw-canon.json の AC01〜AC12、P4-DV・P4-DW・P4-RL の条文、display-vocab.test.ts の T01・T03・T07、uw-canon-unit.test.ts の T03〜T05・T09、shared-runtime.test.ts :390〜、projection-fixture.ts :262〜。
- grep（reconstruction/src・test）: `\.areas\b`・`\.codes\b`・`weatherCurrentAreas`・`areaEntry`・`currentActive`・`vocabItem(` の全件。U-W の表示差分の行を手で組むか作り替える試験は 3 つ: shared-runtime.test.ts:398（監視の行を 1 から組む。areaKinds: null を足す）、display-capacity.test.ts:267〜274（受けた府県の行を展開し current だけを替えて射影に通す。areaKinds は元の行のまま）、projection-fixture.ts:274〜279（displaySubjects の監視の行を展開する）。後の 2 つは期待も字も変えない。
- U-W の表示差分の行の鍵や JSON の字を期待に持つ試験を探した: execution-split.test.ts の T03（返信の上の段と delta の鍵だけ。中は plain data かを見るだけ）・Y3（replyBytes は量るだけで期待の数が無い）、eew-e01 の ac15.mjs の指紋表（保存の payload と旧の full の view だけ）、final-gate の oracle.test.ts（state の記録だけ）、uw-canon-unit.test.ts T05（公開形の鍵と「phenomena」の字だけ）、snapshot-sse の cost.test.ts・boundaries.test.ts（displayChanges を読む行だけ見た）。どれも行の中の欄の集合を期待に持たない。
- 読んでいない: 通知の step（weather-current-notice.ts）の本文、HTTP の詳細の実装、recovery の採用、U-W の試験の残り、M5 の runner。実配信で上の層だけの種別が来るか（手元に無い）。
- 型の試作: 判別共用体・areaKinds の受け渡し・語彙の列・part=item と、shared-runtime.test.ts:398 の 1 か所だけを書いた写し（`.tmp-p1/` の中、追跡 file には無い）で `tsc --noEmit --project reconstruction/tsconfig.test.json` が rc 0（2 回目。1 回目は写しに .d.mts を入れ忘れた rc 1 で、契約の型とは無関係）。:213 の字は変えずに通る。
- T01・T02 の期待（hash と数）は XML から数えた値で、ヘルツの独立の数え直しとも全桁一致。実の unit の出力とは、実装の試験で初めて照らす。

## 8. r0 のレビューの指摘と r1 の対応
| 直し | 指摘（出どころ） | 当てた所 |
|---|---|---|
| 1 | AC06 が全入力の 65,536 を保証できない（ヘルツ P1） | AC02 (4)・AC06・RES-01、§4 |
| 2 | worker の転送量と保持が表に無い（ヘルツ P2） | §4 の転送・保持の行、RET-01 |
| 3 | 「全府県」と走査数が実コードと違う（ヘルツ P2） | AC04、§4 の (1)〜(4) |
| 4 | T02 の始まりで期待が 2 通り（ヘルツ P2） | T02 を (ア)(イ)(ウ) の 3 列に |
| 5 | T03 が worker 境界の誤りを見逃す（ヘルツ P2） | T03（structuredClone） |
| 6 | 持ち方を WeakMap に固定（ヘルツ P3） | AC01 (2)・AC07・D-PLACE・§2.1、:599 を外した |
| 7 | 手で組む試験の数え漏れ・行の回し方（契約適合） | AC02 (1)、§7 |
| 8 | current と areaKinds が別々に null になれる（契約適合） | AC01 (3)・AC02 (3)、allowedPaths、型の試作 |
| 9 | allowedPaths の import の行の漏れ（契約適合） | allowedPaths（display-vocab.ts:11、weather-current-public.ts の import と :29） |
| 10 | 1 項目の byte の例が全国の数だった（契約適合） | §4 の最後の箇条（北海道 262 区域） |
| 11 | §6 の漏れ（契約適合） | §6 |
| — | 復元の行の「採用し直す」（ヘルツの追跡の ⑥） | §3 |
