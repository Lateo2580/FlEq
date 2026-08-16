# 待機画面 従来フォーマット改良

グリッドレイアウト凍結（2026-08-15、`freeze/standby-grid-2026-08-15`）を受けた従来フォーマットの改良仕様。比較モック反復（`display/frontend/src/preview/LegacyImprovedMock.svelte`、`preview.html?nav=0&legacyMock2=4|7|max[&ladder=..&rotationTick=..&cardPageTick=..&floodWide=1]#legacy-improved-mock`）でご主人の目視 GO を得た確定形を本実装へ写す。

- **正本**: モック v23（commit `42c943e`）。`5af389d` 以前のモックは目視裁定の視覚基線としてのみ参照する。**数値の正本は本文の固定表（§5 期待 stage 表・§11.1 期待値表）であり、モックはその測定証跡**——将来モックと表が食い違った場合は表が勝ち、表の改定はご主人裁定を伴う spec 改版としてのみ行う。
- **本文の役割分担（排他）**: **性質・意味論・確定規則＝spec が正**。**数値・視覚配置・規則を満たす手続きの実装＝モックが正**。食い違いはこの区分で裁定し、どちらに属するか曖昧な事項は spec 側に規則として追記してから進める。
- 裁定に使った目視 packet は第一〜十八号（セッションログ参照）。本 spec は品質メタ見直し（2026-08-15 合意）の第一号適用例であり、§11 の受け入れ条件は Oracle 欄（主張・基線・反証条件・Oracle と証跡・判定者と時点）を持つ。

## 1. 目的と主張

- **主張（隠さないの三層）**: 全 active hazard を無操作で表示し、情報を無言で隠さない。
  1. **常時表示**: 収容可能な範囲では全件を常時表示し、外側レイアウトのカードページング・巡回は行わない。
  2. **輪番枠**: 物理的に収容不能なときのみ、固定位置のローテーション枠（§5 stage 3）で低優先カードを時分割表示する。
  3. **カード内改ページ**: カード内の項目（地域リスト）が収まらないときは、固定高のまま時分割でページを交代し、供給された全地域をいずれ必ず表示する（§7）。
  - どの層でも「見る場所が動かない」原則を保つ（枠・カード・リスト領域の位置と高さは固定で、中身だけが周期交代する）。枠すら確保できない極限は layout-failure として明示する。平時は時計ランドマークを画面中心に保ち、文字サイズはどの段でも潰さない。
- **基線**: 現行 main の待機画面（corner スタック＋overflow summary）と、凍結済みグリッド実装。
- **反証条件**: 実機（Pi・720p〜1080p）の目視で「基線より読みにくい」「配置が予測できない」とご主人が裁定した場合、該当変更単位を差し戻す。
- **Oracle と証跡**: 機械層は §11.1。利用価値層はご主人の目視 packet 裁定（§12）。
- **判定者と時点**: 実装前=モック反復で裁定済み。実装後=変更単位ごとの目視 packet と、main 合流前の最終目視。

## 2. 固定 tier（見る場所は動かない）

| tier | domain | 形式 |
|---|---|---|
| 左列（先頭固定） | 津波（TsunamiStandbyBanner）→ 最新地震（長周期 rider・リプレイ差し替え） | 現行形式そのまま |
| 右列（基準順） | 気象警報（竜巻 rider）→ 河川洪水 → 台風 → 火山 → 熱中症 | 現行形式（気象警報のみ §8 の改修） |
| 中央（時計ランドマーク） | 時計・受信統計・今日あった地震 | §3 |
| 下部帯 | 南海トラフ | ticker 直上に接地・左右 edge inset |
| 非表示 | unknown（未対応電文系） | 画面から排除し §10 のログで観測可能性を保つ |

- 左列の先頭は常に津波→地震。それ以外の可動カードは §4 のソルバが左右いずれにも配置できる（右列の並びは基準順を保つ。左へ移った可動カードは左列の末尾側に基準順で並ぶ）。
- 中央受け皿（時計退避後）へ移動できるのは **気象警報・河川洪水・台風・火山** のみ（中央資格）。熱中症は左右のみ。地震・津波系は常に左。
- **現行機能の維持**（本 spec で廃止しない）: 接続バッジ、FloodWideCard への surface 切替（engine 判定）、台風カードの compact mode（§4 でソルバの自由度として扱う）、リプレイ差し替え。LatestQuakeCard の内部ページングは**機能として維持しつつ実装を §7 の時分割 scheduler へ置換統合**する（二重ページャ禁止）。
- **wide flood の placement 変換**: engine が wide surface を選んだ flood は中央資格の**優先候補**とし、中央受け皿では FloodWideCard（36rem）、側列・輪番枠では FloodCard へ変換して描画してよい（placement に応じた形式変換。両形式を測定棚で二重実測する）。上記以外のカードはソルバからは「1 枚のカード」として実測されるだけで、内部挙動に介入しない。

## 3. レイアウトと時計ランドマーク

- 3 列グリッド。**中央トラックは固定幅 `min(36rem, 60vw)`、左右トラックは残余の等分 `minmax(0, 1fr)`**（モック正）。間隔は縦横 1 トークン。
- 側列カード幅は `min(30rem, トラック幅)` でトラック内中央寄せ。中央に置かれる要素（時計クラスタ・受け皿カード）はすべて中央トラック幅（36rem 規格）。
- **時計は viewport（ticker を含む画面全体）の縦横中央に絶対固定**。フォントは列幅追従 `clamp(72px, 16cqw, 160px)`、秒・日付は比例。1920×1080 / 1512×982 / 1280×720 で秒が欠けない。
- 平時の中央クラスタは「時計 → 受信統計 → 今日あった地震 → 南海帯上辺」の 3 区間を実測等間隔。
- 南海トラフ帯は ticker 領域の直上に gap なしで接地し、左右に edge inset を持つ。帯の実測高は全列の容量から差し引く。
- 時計退避（§5 stage 1 以降）後は、全列（左右・中央）ともカードを縦中央揃えにする（packet 第十三号 GO。以降のモックで側列 flex-start に戻る変更は退行として扱う）。

## 4. 実測 2 パスとソルバ

- 高さは算術推定ではなく**実 DOM 同期測定**で得る: 測定棚（本表示と同幅・同 CSS の非表示棚。側列幅と中央 36rem の二重測定）を同期 read し、1 回の再描画で配置を確定する。rAF 連鎖は使わない（headless 停止実績があるため）。
- 判定には gap・列 padding・南海帯予約を px 単位で含め、`data-left/right/center-natural-height-px` / `-capacity-px` 等の診断属性で外部から照合可能にする。容量は `.screen-area`（ticker 高除外済み）基準で、ticker 高は診断として測るのみ（二重控除しない。§13）。
- **再測定の契機**（測定 epoch を進める）: mount／viewport resize／カード集合の変化（追加・削除・engine 判定の surface 切替）／カード内容の更新（updatedAt 変化）／`document.fonts.ready`。**A・余裕利用フェーズが選ぶ表示形式（台風 compact/full・flood 形式変換・展開 k）は同一 coordinator 内の出力であり、外部 epoch を進めない**。reactive effect による再入は禁止。epoch coordinator 内の **bounded settle pass**（stage 適用・圧縮・輪番枠確保による寸法変化の再測定）は最大 4 pass。非収束時は最後の pass で確定し診断（`data-measurement-nonconverged`）に記録する。
- **フェーズ構造（A0→比較器→B）**: ①A0 が compact baseline の測定値で fit 候補を全列挙 ②比較器（達成可能展開量 potential 込み）が 1 候補を確定——potential は二重測定値からの算出で B は実行しない ③B（余裕利用フェーズ）が確定候補へ**一度だけ**実体化し、結果を A0・比較器へ再入力しない。
- **ソルバの解決順**（時計の中央維持が最優先の目的関数）:
  1. 左右 2 列に全カードが収まる割当を全列挙（左先頭は津波→地震固定。全カード常設・quake/weather は compact baseline・台風のみ full から試行）。
  2. 不成立なら台風を compact に切り替えて再試行（compact の採否は A の一部）。
  3. 不成立なら中央資格カードを中央受け皿へ移して時計退避（stage 1）。中央へ移す枚数に固定上限なし（実測容量が許す複数枚の組合せも列挙）。
  4. それでも不成立なら余白・行間圧縮（stage 2）。**フォントサイズは縮めない**。
  5. それでも不成立なら輪番枠（stage 3、§5）。
- **余裕利用フェーズ（配置確定後・一方向）**: 確定配置の各列残余容量を canonical 順に「①compact 昇格（台風・wide flood の FloodCard 変換を含む）→②地域展開（§6 の B: quake→weather）」の優先度で使い切る。配置・stage・他カードの寸法は変えない。判定は実測値比較のみで、昇格・展開が新たな溢れを生まないことを保証する。**輪番集合のカードは余裕利用フェーズ全体の対象外**（枠は compact 最大高で予約されるため）。
- **主比較規則（規範）**: 割当候補の優劣は辞書式で決める。
  1. 総 overflow（左右＋中央使用時の中央超過 px 合計）が 0 の候補（fit）は non-fit に常に勝つ。
  2. 両者 fit: ①中央移動枚数の少なさ → ①'（stage 1 以降のみ）wide flood が中央にある候補の優先 → ①''達成可能な展開量（compact 昇格数＋展開地域数。二重測定値から算出）の多さ → ②最大側列高の低さ。
  3. 両者 non-fit: ①総 overflow の少なさ。
  4. 共通: ③左右列高差の小ささ → ④中央 overflow の少なさ → ⑤中央移動枚数 → ⑥移動枚数 → ⑦決定性 tie-break: **「左列キー列 → 右列キー列 → 中央キー列」の順で連結した tuple**（各列内は canonical 順）の辞書順最小。
- **決定性**: 配置と stage は「カード集合（内容含む）・実測寸法・直前 stage」の 3 入力の関数。snapshot 到着順・入力 shuffle に依存しない。
- **初回・多段遷移**: 目標 stage が 2 段以上先でも同一外部 epoch 内の内部 settle で**目標 stage まで直接確定**してから描画する。「1 epoch 1 段」の見かけはアニメーション（§9）の演出。
- **振動防止**: 上げ判定 `natural > capacity`・下げ判定 `natural + H < capacity` の非対称閾値。`H` は平時（非圧縮）の gap トークン×2 の px 値で一意。下げ判定は下位 stage の寸法規則で測る。内容変化を伴わない epoch（resize を除く）では stage を下げない。

## 5. 劣化のはしご（4 段）

| stage | 状態 | 条件 |
|---|---|---|
| 0 | 通常 | 時計中央固定。左右 2 列の最適割当（可動カードの左配置・台風 compact を含む）で全件収容 |
| 1 | 時計退避 | 左右のみで不成立。時計は ticker 右下（緊急画面と同位置）へ、中央資格カードを中央受け皿へ |
| 2 | 余白圧縮 | 中央込みでも不成立。余白・行間のみ圧縮（文字サイズ死守） |
| 3 | 輪番枠 | 圧縮でも不成立。低優先カードが固定位置の 1 枠を時分割表示（§7） |

- 旧 4 段案の「左退避」は stage 0 の割当自由度に統合（ご主人裁定）。モックの `ladder` パラメータ旧番号との対応は新 0→旧 0・新 1→旧 2・新 2→旧 3（旧 1 は廃止・本実装へ移植しない）。診断属性は新番号 0/1/2/3 が正。
- **輪番集合の構成（stage 3）**: canonical order 逆順（熱中症→火山→台風→河川→気象警報。津波・地震・中央クラスタは対象外）でカードを 1 枚ずつ輪番集合へ移し、そのたびにソルバを再実行する。**候補列挙 loop は DOM settle pass（最大 4）とは独立のカウンタで、最大 5 枚まで必ず試し切る**。全常設カード＋輪番枠（右列末尾固定・高さは集合の compact 実測高の最大値を予約）が収まった時点で確定。
- **終端（省略告知）**: 集合の最大 compact 高でも枠を確保できない場合、集合中最大のカード（同値なら canonical 逆順で先）を予約対象から外して枠高を次点で再計算し、外れた枚数 N の「ほか N 件を表示できません」行を枠直下に 1 行描画する（グリッド期資産流用。failure 行の実測高も予約に含める）。診断は `data-rotation-omitted-count`（省略告知）と `data-layout-unresolved`（真の未解決）に分離する。
- **期待 stage 表（v16 実測・v18/v21/v22/v23 で同値確認・rotationTick=0。§冒頭の数値正本規則に従い実装後の観測値で書き換えない）**:

| viewport | scenario 4 | scenario 7 | scenario max |
|---|---|---|---|
| 1920×1080 | 0 | 0 | 0 |
| 1512×982 | 0 | 0 | 1 |
| 1280×720 | 0 | 3（輪番: heat） | 3（輪番: volcano,heat） |
| 960×620 | 1 | 3（輪番: volcano,heat） | 3（輪番: typhoon,volcano,heat） |

  - 全セルで `data-layout-unresolved="false"`（輪番枠の導入により解決不能セルは消滅）。
  - **720p の注記**: 720p の scenario 7 以上は圧縮でも収容できず stage 3 へ到達する。720p の見え方は §11.2 の目視必須項目とし、「現行 main より読める情報量が減らないこと」を比較 gate に含める。カード側の 720p 向け縮退調整は後続課題（§13）。
- 判定は決定的（§4 の 3 入力の関数。stage 3 の枠内表示とカード内ページのみ周期 tick に依存）。外側ページング不在の診断属性は `data-outer-paging="none"`。

## 6. 地域リスト適応展開と wire 契約

- **B（地域展開）**: 余裕利用フェーズの一部（§4）。展開候補の**原子は地域 1 件**とし、追加件数 j（j=0..候補追加数）の prefix を実組版（pref-group 集約・2 列・折返し込み）で実測し **fit する最大の j** を採る。prefix 高は「ほか n」行の消滅境界で非単調になり得るため、**B は j=0..候補追加数の全 prefix を線形に全走査**して fit する最大 j を採る（途中 non-fit での打ち切り・二分探索は禁止。「途中 non-fit・後続 fit」の反証 fixture を §11.1 C に置く）。測定キャッシュは §7 の計算量契約に従う。入力は最大 128 件（wire 上限）。**B の役割は常時表示枠の拡大まで**で、それを超える分は §7 のカード内改ページが受け持つ。展開しきれない残りは「ほか n」に集約（n は下記再計算式。期待値表の「展開」列は現行表示分を含む総表示件数）。
- **跨 epoch の一方向性**: A は epoch を問わず常に compact baseline の測定値で解く。B は別測定の expanded variant 高を残余容量に当てる。前 epoch の展開が次 epoch の配置・stage に影響しない。輪番集合内カードは B の対象外（枠内は常に compact）。
- **engine 側 wire 契約（新設）**:
  - **設置場所と型**: quake は `DisplayIntensityGroupV1` に `expandedAreas?: string[]` と `candidateTruncated?: boolean`（group 単位。新 producer は常時送信・欠落は旧 snapshot 互換=展開しない）。weather は**表示単位（kind 統合後）**で供給する: `DisplayStateSnapshotV1` に新集約型 `DisplayWeatherExpandedKindV1 { kindKey: string; areas: string[]; totalAreaCount: number; candidateTruncated: boolean }` の配列 `weatherExpandedKinds?` を新設。**候補配列は現行表示分を先頭に含む canonical prefix**（発表順・重複排除済み）。
  - **grouping の正規化**: rank filter（最高 rank のみ）・`phenomenonKey ?? kind` の alias 解決・旧 item 形式 fallback を含む正規化は、engine 側（src/engine/display/）の実装を唯一の正本とし、display/frontend へは protocol 複製と同じ既存機構による**一方向コピー**を置く（手書き二重実装禁止・同一入力 fixture への出力一致テストを §11.1 に含める）。`kindKey` はこの関数の出力キー。候補は union・重複排除（発表順・最初の出現保持）し統合後ユニーク総数を持つ。
  - **上限**: 候補は**完全リスト供給が原則**・カードあたり安全弁 **128 地域**。**複数 group/kind への配分は「全 group/kind の現行表示分を先に予約し、残余を発表順の先着で追加候補へ配る」**（単純な group 順充填で後続 group の現行表示分を侵食しない。128 に達した時点で残る追加候補は切られ、それぞれの candidateTruncated を true にする）。安全弁または snapshot budget の縮退で切られた場合は `candidateTruncated=true` を送る（optional 欠落=旧互換と縮退を frontend が確実に区別）。現行表示分は無条件で全含。現行表示だけで 128 超は既存 compact formatter の表示上限により到達不能（入力不変条件として明記。万一超過時は現行表示分優先・truncated=true）。
  - **「ほか n」再計算式**: quake `n = group 総地域数 − 表示件数`、weather `n = totalAreaCount − 表示済みユニーク地域数`。既存 `omittedAreaCount` 系は非展開表示用として変更しない。
  - **縮退ラダー上の位置**: snapshot budget（SSE 256KB 安全弁）超過時、候補削除は**カード本体の縮退より前段**（gridbase で GO 済みの順序）。保持優先度は「現行表示分 > 展開候補」。
  - **移植元**: `feature/legacy-improved-gridbase` の `e5d6bbb`（`display/frontend/src/lib/grid-region-expansion.ts`・engine 側候補供給・SSE 縮退ラダー）。frontend protocol 複製（`display/frontend/src/lib/protocol.ts`）へ同時反映。

## 7. 時分割 scheduler（共通規範）

輪番枠（§5 stage 3）とカード内改ページは、同一の時分割 scheduler の 2 インスタンスである。手続きの詳細は正本モックの実装を規範とし、本節は保証すべき性質と確定規則を定める。

### 7.1 不変条件（invariant）

- **INV-到達（単体）**: 単体のインスタンスでは、集合が安定していれば同一要素の再表示間隔は **周期×集合長** 以内。
- **INV-到達（合成）**: 輪番集合内カードのページは論理 tick（=再登場イベント）で進むため、輪番長 R・ページ数 P のとき同一ページの再表示間隔は最長 **15 秒×R×P**。この値は §11.2「カード内改ページ」の目視 packet に総周期として記録し、ご主人が体感の許容を裁定する。
- **INV-飢餓なし（有限 churn 前提）**: 集合変更が有限回で止まれば、その後 INV-到達の式が成立する。変更が続いても、残存し続ける要素は変更のたびに位置を失わず（先頭 reset を繰り返さず）、表示機会が単調に進む。
- **INV-決定**: scheduler は明示的な内部状態（現在要素 key・位相起点時刻・pending/defer 集合・一周起点 key・**一周管理の既表示集合・処理済み tick 数・直前ページ数・suspend/in-flight transition フラグ**）を持ち、表示中の要素は「列挙入力（集合・実測寸法・直前 stage）＋scheduler 状態＋単調 tick」の関数とする（同一入力でも状態履歴が異なれば表示が異なるのは正常。テスト・撮影用に tick override（`rotationTick`/`cardPageTick`）と状態の診断属性を持つ）。
- **INV-固定**: 時分割は枠・カード・リスト領域の位置と高さを変えない（中身の交代のみ）。
- **INV-排他**: epoch/stage 変更は進行中の交代 transition を cancel して優先する。次 tick の交代は前 transition の finished/deadline 後。交代中も要素は枠外へ描画されず、空表示フレームを作らない。unmount・stage 退出で timer と animation を破棄する。
- **INV-継続**: reduced-motion では交代の動きを即時差し替えにするが、時分割そのものは停止しない。

### 7.2 共通規則

- **tick の種別**: 輪番枠と非輪番カードの改ページは**実時間 tick**（周期 15 秒・単調時計基準。wall-clock 境界ではない）。輪番集合内カードの改ページは**論理 tick**（再登場イベント。§7.4 合成規則）。周期の起点は当該インスタンスの開始時刻（stage 3 進入・改ページ成立）。**初期要素は集合の canonical 順先頭**。
- **集合変化時の位相**: 現在表示要素が残る変更では表示とタイマーを維持し、次 tick は**新集合における現在要素の canonical 後続**へ進む。現在要素が消えた変更では canonical 後続へ即時交代し、その時刻を位相起点とする。
- timer drift・background 復帰は、単調時計で位相起点からの経過 tick 数を再計算して 1 回で合流する。
- epoch 処理は tick に優先し、tick は epoch 完了後に処理する（skip しない）。
- **exit と suspend の区別**: reset（先頭から）になる「退出」は**インスタンス別**に定める。輪番 scheduler の exit は「stage 3 の終了」。カード内改ページ scheduler の exit は「**カードの消滅・改ページの不成立化（1 ページ化）**」のみで、**stage 遷移（0↔1↔2↔3）ではページ状態を維持する**（resize・内容更新による stage 変化で先頭ページへ戻らない。stage 3 終了で輪番集合から常設へ戻ったカードもページ位置を維持する）。**輪番による一時非表示は suspend であり、ページ状態（現在ページ・pending）を保持して再登場時に resume する**（再登場ごとに reset して次ページへ永遠に進まない状態を禁止）。同一 epoch 内の settle による瞬間的な出入りも resume。

### 7.3 輪番枠インスタンス（§5 stage 3）

- 集合は §5 の輪番集合・canonical order 巡回・枠は右列末尾固定。
- 診断: `data-rotation-keys` / `data-rotation-active-key` / `data-rotation-omitted-count`。

### 7.4 カード内改ページインスタンス（2026-08-16 ご主人裁定）

余裕利用後も展開しきれない残りがある（n>0）多項目カード（気象警報・地震の震度地域）は、地域リスト領域を固定高のまま時分割でページ交代し、供給された全地域をいずれ必ず表示する（「ほか n」の恒久省略を廃止。wire 縮退時の例外は §6）。

- **ページ分割（実測 partition。B の全走査とは別契約）**: 候補を canonical 順に「そのページに追加しても固定高に入る」限り詰め、**最初の overflow でそのページを閉じて次ページを続きから始める**逐次貪欲で決定的に分割する（実組版で実測・件数不揃い許容。B の「全 j 走査」とは探索規則が異なることを明記する）。**計算量契約**: 測定は逐次貪欲（1 件ずつ追加測定・溢れたら改ページして続きから）で probe 数 O(実供給候補数)（上限は **max(1, 2×実供給数)/カード**——供給 0 件＋残置行のみの合法入力は残置行測定の 1 回。128 件供給で高々 ~256 回）・同一 epoch 内は測定キャッシュ。tail-only（供給 0 件）fixture を §11.1 C に置く。1 地域も入らないページが生じる場合は改ページを断念し「ほか n」残置＋`data-card-page-infeasible`（終端）。現行表示 0 件・n>0 の合法入力も先頭ページから表示する。
- **truncated の残置行は group/kind 単位**: partition は group/kind ごとの tail（供給切れ残数）を保持し、「ほか n」は各 group/kind の並び末尾にそれぞれの n で描画する（カード全体残数の一括帰属＝危険度の誤帰属を禁止。供給 0 件の group/kind も自身の残置行を持つ）。残置行込みの組版で測定して partition する（測定/描画のズレによる境界 overflow 禁止）。
- **ページ identity**: 安定 key は「kindKey（quake は group key）＋先頭地域名＋canonical 出現順」の複合（同名重複でも一意）。repartition 後、現在ページの先頭地域が残っていれば位置維持・消えたら canonical 後続へ。追加ページは**現在ページ起点の一周完了後**に参加（defer）。**defer 中に起点ページが削除されたら、削除時点の canonical 後続を新起点として解禁判定を継続**する（pending の永久飢餓禁止）。
- **輪番との合成**: 輪番集合内のカードのページは自走させず、**輪番で再登場するたびに 1 ページ前進**する（15 秒×15 秒の共振で一部ページが gcd 分の 1 しか表示されない問題の回避）。**輪番集合長 1 の場合は 15 秒の slot boundary を再登場と数える**。
- **表示**: 非 truncated 時、最終ページは「ほか n」でなくページ表示（例「2/3」）。truncated 時はページ表示と group/kind 別残置行を併記。1 ページに収まる場合は改ページしない。
- 配置・stage・カード高は改ページで変化しない。診断: `data-card-page`（現在/総）・`data-card-page-keys`（各ページ先頭地域）・`data-card-page-identities`（複合 identity 列）・`data-partition-probe-count`。
- **既存ページャとの一元化**: LatestQuakeCard の既存内部ページング（10 秒 page-cycler）は本機構へ置換統合する（二重ページャ禁止・周期 15 秒へ統一・既存ページ構成条件は partition 規則へ吸収）。

## 8. カード改修と表示規範

- **WeatherAlertCard 本改修**（モックで CSS 試作済み・本実装でコンポーネントへ）: 対象地域リストの 2 列組版（pref-group 単位で泣き別れ禁止）・竜巻注意/目撃情報の対象地域フル表示（「ほか」省略廃止）。
- **TyphoonCard 本改修**: 位置情報（「沖縄の南」等）を台風名と同じ行の右端へ右詰め（compact/full 両形式。full で独立行に残る形は不可）。
- **狭幅の見出し規範**: カード見出し（津波バナー等）は折り返さない。狭幅では更新スタンプ等の従属要素を縮小・省略して見出し 1 行を守る。
- **マーキー**: 実表示は現行どおり走行マーキー（津波バナー・熱中症カード。熱中症の地域はマーキーで全件到達するため §7.4 の改ページ対象外）。モック・静止画評価では in-flow 静止化する（走行 transform は overflow clip で閉じ込められないことが実測で判明済み）。本実装の目視 packet 撮影用にも静止化パラメータを設ける。

## 9. 変化アニメーション

- カードの自然高さが更新報で変化した場合、高さ・位置の変化をトランジションで繋ぐ（瞬間ジャンプさせない）。stage 遷移（時計退避・復帰）にも同方針。
- 実装はグリッド期の motion planner / epoch coordinator の決定的確定パターン（Animation.finished 一次＋deadline backstop＋timer fallback）を流用候補とし、詳細は実装時の scoped spec で確定する（本 spec の受け入れは §11.2「変化の体感」の目視のみ）。時分割の交代との排他は §7.1 INV-排他。

## 10. unknown の抑止とログ

- unknown（未対応電文系）カードは待機画面に描画しない。データ経路は新設せず、**それぞれ単体で検証**する。
  - engine: 未対応電文の受信イベントごとに logger へ 1 record（電文種別コード・受信時刻）。ユニットテストで検証。
  - frontend: snapshot 内の future-kind DTO を描画せず、枚数を `data-suppressed-unknown-count` に出す。ユニットテストで検証。

## 11. 受け入れ条件

### 11.1 機械検証可能（テスト・ゲートが判定）

**A. ビルド・テスト**（個別実行）: `npm run build`・`npm test`・`npm --prefix display run build`・`npm --prefix display test`・`npm --prefix display run typecheck` がすべて成功。

**B. レイアウト実測ゲート**（headless Chrome runner。期待表は §5・本節の実測表を正本とし、実装後の観測値で書き換えない）:
- runner は `data-measurement-settled="true"` を待って採寸する。この属性は **fonts.ready・測定 epoch・stage settle・partition queue の全消化**が揃った時点でのみ true（途中状態の撮影禁止）。
- scenario（4/7/max）× viewport（1920×1080・1512×982・1280×720・960×620）で `data-ladder-stage` が §5 表と一致し、`data-layout-unresolved="false"` かつ `data-measurement-nonconverged="false"`。
- **切れゼロ（縦横）**: 各カード root の `scrollHeight ≤ clientHeight + 1`・`scrollWidth ≤ clientWidth + 1`・カード矩形が viewport 内。時計の秒・日付矩形がクラスタ矩形に包含。台風カードの名前と位置情報が同一行（矩形縦中心差 ≤ 2px、compact/full 両形式）。ページ番号矩形と地域本文矩形の交差 0。
- **重なりゼロ**: カード矩形同士・時計クラスタ・南海帯の交差面積 0（境界 1px 許容）。
- **時計中心**: stage 0 で時刻要素中心と viewport 中心の差が各軸 ≤ 1px（DPR 込み実測 rect）。列スクロールなし（各列 `scrollHeight ≤ clientHeight + 1`）。
- ソルバ決定性: 同一入力・入力順 shuffle で診断属性（配置キー列・stage）完全一致。

**C. 余裕利用・時分割ゲート**:
- **余裕利用の期待値表（v18 実測・v21/v22/v23 で同値確認・rotationTick=0）**: 診断属性 `data-typhoon-variant` / `data-flood-form` / `data-expanded-counts` / `data-placement-surplus-use` との一致を検査。

| セル | 台風 variant | flood 形式 | quake 展開 | weather 展開（大雨警報） | surplus |
|---|---|---|---|---|---|
| 1920×1080 / 4 | −（不在） | −（不在） | 7 (n=0) | 12 (n=0) | 13 |
| 1920×1080 / 7 | full | card | 7 (n=0) | 12 (n=0) | 13 |
| 1920×1080 / max | compact | card | 7 (n=0) | 16 (n=8) | 16 |
| 1512×982 / 4 | −（不在） | −（不在） | 7 (n=0) | 12 (n=0) | 13 |
| 1512×982 / 7 | compact | card | 7 (n=0) | 12 (n=0) | 13 |
| 1512×982 / max | full | card | 7 (n=0) | 24 (n=0) | 25 |
| 1280×720 / 4 | −（不在） | −（不在） | 7 (n=0) | 3 (n=9) | 4 |
| 1280×720 / 7 | compact | card | 7 (n=0) | 8 (n=4) | 9 |
| 1280×720 / max | compact | card | 7 (n=0) | 5 (n=19) | 5 |
| 960×620 / 4 | −（不在） | −（不在） | 7 (n=0) | 12 (n=0) | 13 |
| 960×620 / 7 | compact | card | 7 (n=0) | 12 (n=0) | 13 |
| 960×620 / max | compact | card | 7 (n=0) | 5 (n=19) | 5 |
| 1920×1080 / max＋floodWide | compact / stage 0 | card（中央不在のため FloodCard 変換） | 7 (n=0) | 5 (n=19) | 5 |
| 1280×720 / max＋floodWide | compact / stage 3（輪番: flood,typhoon,volcano,heat） | card | 7 (n=0) | 4 (n=20) | 4 |

  - surplus は `data-placement-surplus-use`。「−（不在）」はカード不在。存在するのに非検査の欄は本表に置かない。stage 3 セルの輪番カードは昇格・展開の対象外。
  - **比較器 ①'' の反証 fixture**: 旧比較器なら低展開配置・①'' 込みなら高展開配置を選ぶ入力を固定し、配置キー列が高展開側であることを検査。
- **時分割 scheduler の共通 contract test**（輪番・改ページの両インスタンス＋合成ケースへ同一スイートを適用。**存在確認や本文文字列検査でなく挙動検査であること**）: ①epoch/tick 競合時に epoch 優先・tick を skip しない ②reduced-motion でも時分割が継続する ③交代 transition の finished/deadline 排他・空表示フレームなし（**非アニメの交代は「animation を生成しない＋原子的差替え」を検査**）④unmount・exit 後に timer と animation が破棄される（**unmount 前後の資源観測で検査**）⑤exit 条件（輪番=stage 3 終了／改ページ=カード消滅・1 ページ化）を**各条件個別の fixture**で検査し、stage 遷移でのページ状態維持と輪番 suspend=resume も個別に検査 ⑥合成到達時間（R×P の最長再表示間隔が 15×R×P 以内）。
- **輪番の検査**: stage 3 セルは `data-rotation-keys` の期待集合一致＋`rotationTick=0..集合長−1` の全 tick 撮影（現在 key・枠内包含・切れ・重なり・failure 行）。fake timer で①安定集合の交代順序と再表示間隔（15 秒×集合長）②カード追加③非 active 削除④active 削除⑤長時間停止後の一括合流、の 5 系統。
- **改ページの検査**: n>0 セルで①全ページ撮影の地域 union が期待 canonical 集合と完全一致（重複・欠落ゼロ）②各ページが固定高に収まる（長い地域名・複数 pref-group・複数 kind fixture 込み）③現行表示 0 件・n>0 ④公約数 fixture で再登場前進により全ページ到達 ⑤15 秒未満連続更新で後方ページが飢餓しない ⑥LatestQuakeCard で二重ページャ不発火 ⑦輪番集合長 1×複数ページで全ページ到達 ⑧同名地域重複 fixture で複合 identity が誤ジャンプしない ⑨defer 一周解禁＋起点削除でも全ページ到達 ⑩truncated 最終ページの残置行込み包含 ⑪`data-partition-probe-count ≤ max(1, 2×実供給数)/カード`（tail-only fixture 含む）・128 件×2 カードで settle 完了・非収束なし。

**D. wire 契約ユニットテスト（engine 側）**: ①同一 kind・複数 source・一部重複の union（順序・重複排除・totalAreaCount）②安全弁 128 の境界（127/128/129——129 で prefix 128 切り・candidateTruncated=true・残数正。**複数 group/kind をまたいで 128 に到達する fixture を含み、切られた group/kind の帰属が正しいこと**）③optional 欠落の旧互換④budget 縮退で候補が本体より先に落ち truncated=true が残る⑤sanitizer・protocol 複製後も候補と flag が保持⑥正規化関数コピーの同一性（同一入力→出力一致）。

**E. ゲートの反証テスト**（runner 自体の失敗能力）: 意図的に壊した 3 種の fixture（overflow／矩形重なり／stage 3 で枠・failure 行を描かない）で runner が非ゼロ終了する。壊し方はテスト専用パラメータで注入し本番経路に置かない。§10 の unknown 単体検証も含む。

### 11.2 人間検証必須（ご主人の目視 packet が判定）

| 項目 | 主張 | 基線 | 反証条件 |
|---|---|---|---|
| 平時の姿 | 時計中心の秩序が基線より整う | 現行 main とモック 13 巡目（`5af389d`） | 「基線の方が落ち着く」裁定 |
| 多発時の姿 | stage 1/2 でも読み取りが破綻しない | モック 13 巡目 max | 「どこを見ればいいか分からない」裁定 |
| 距離可読性 | 実機の視聴距離で主情報が読める | 現行実機 | 実機 gate で読めない項目の指摘（packet に距離・対象文字を明記） |
| 変化の体感 | 更新時の動きが追える（§9） | 現行（瞬間切替） | 「変化に気づけない/うるさい」裁定（packet に更新シーケンス動画または連続キャプチャ） |
| 720p 輪番 | stage 3 の一周で全 key が現れ、main より情報量が減らない | 現行 main の 720p | 「輪番で追えない」「main より減った」裁定（packet に一周連続キャプチャと domain key・主要フィールドの main 対照表） |
| カード内改ページ | n>0 でも全地域が周期到達し、改ページが読み取りを乱さない | 「ほか n」恒久省略（v18 まで） | 「交代が追えない/うるさい」「最終ページ到達が遅すぎる」裁定（packet に全ページ連続キャプチャ・総周期・最終ページ到達時間） |

- **Oracle と証跡**: 目視 packet（§12）のスクリーンショット集とご主人の GO/NO-GO 記録。
- **判定者と時点**: ご主人。変更単位ごと（実装後）＋ main 合流前（最終）＋ Pi 実機反映後（実機 gate）。

## 12. 目視 packet ゲート運用

- 実装の変更単位ごとに、「代表シナリオ＋最悪ケース数枚＋基線との並列比較＋問い（最大 3 つ）」を数分で裁定できる packet として提出する。
- **目視 GO のない main 合流を禁止**。無応答は GO と数えない。
- 微修正・非視覚変更・裁定済みの狭い変更はリスク分類により目視を省略できる（省略の事実を記録）。
- 「比較の結果、変更しない」は正規の成功として扱う。

## 13. 実装対象の見取り図

- **`App.svelte` / `Ticker.svelte`** — stage 所有権: **StandbyScreen がソルバと stage の権威**で、確定 stage を prop/callback で App へ通知。App は ticker 内時計の表示/非表示を切り替える（中央時計と ticker 時計は同一 stage 確定の同一描画フレームで排他切替）。時計の viewport 中央配置は viewport 基準（fixed 相当）。容量計算は `.screen-area` 実測高から南海帯実測高のみを差し引く（ticker 高の二重控除禁止）。
- **`StandbyScreen.svelte`** — 3 列レイアウト・実測 2 パス＋ソルバ・はしご・縦中央揃え・時分割 scheduler（最大の変更単位）。
- **`WeatherAlertCard.svelte` / `TyphoonCard.svelte` / `LatestQuakeCard.svelte`** — §7.4・§8 の本改修（改ページ統合・2 列組版・竜巻フル・位置行・見出し規範）。
- **engine 側** — unknown 受信ログ（§10）・展開候補の wire 契約と供給（§6・gridbase 資産の移植）。DTO を再構築する全経路（weather kind 統合・永続化 sanitizer・snapshot 縮退コピー）で候補フィールドが落ちないことを監査対象に含める。正規化関数は engine 正本の一方向コピー（§6）。
- モックの実測棚・ソルバ・scheduler・診断属性のロジックは本実装への移植元とする（モックは spec の実証プロトタイプとして残す）。
- 変更単位の分割・委譲契約・レビュー階梯（実装→Sol high→xhigh→**目視 GO**→合流）は plan 側で確定する。
- **後続課題（スコープ外・backlog 登録）**: 720p でのカード縮退調整による完全収容。登録先はリポジトリ外の常設バックログ（Obsidian Vault `Artifacts/FlEq-やりたいことリスト.md`）。
