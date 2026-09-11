# FlEq 全面再構成 P0 spec — 契約・境界・route 対応表・oracle・機能採否表

版: v3.1（独立レビュー F01〜F19 反映、ご主人裁定 F01=A・F08=A・ページ送り統一、scoped 再レビュー R01〜R13 反映） / 2026-09-11  
対象 checkout: 使い捨て clone（public main、`8e0b785`）  
基準版: ご主人提示の main `8e0b785`。git による照合は行っていない。

## 0. 判断分岐・読み方・用語集

### 0.1 判断分岐の表

「裁定済み」は実装の前提だ。「保留」の A は推奨案であり、採用済みとは扱わない。Q5-a・Q5-b・Q7 は P4 着手前に裁定する。

| ID | 状態 | 選択肢（採用案・推奨案を先頭） | 理由 |
|---|---|---|---|
| J1 新築の置き場 | **裁定済み：A** | **A：同 repo の `reconstruction/`** ／ B：別 repo | 資材・fixtures と検証経路を共有し、公開 main と personal の境界は配線・配送対象で守る。 |
| J2 v3.5.0 の公開順 | **裁定済み：B** | **B：再構成より先に v3.5.0 を公開する** ／ A：再構成と独立に保留する | 不安定な最新版へ対症療法のパッチを重ねている現状に、先に区切りを付ける。 |
| J3 実装費の配分 | **裁定済み：A** | **A：P1 の実装・レビュー・配送 1 サイクルのトークン実費を採り、以後を段階ごとに配分する** ／ B：全フェーズを先に一括配分する | 実測した単位費用と手戻りを、次の発注量へ反映できる。 |
| Q5-a 必須掲載と器の割当 | **保留：A 推奨** | **A：§8.5 の「通常・見出し・伸縮・テロップ」の割当表を製品要件にする** ／ B：割当・常設対象を変更して再検証する | 高さを情報種別に合わせ、多発令時も概要を同時に見渡せるようにする。 |
| Q5-b あふれ時の巡回時間 | **保留：A 推奨** | **A：器でも収まらない場合だけページ送りを使い、全対象の一巡を最長 60 秒にする** ／ B：最長 120 秒に緩和する | ページ送りは保険とし、普段の表示に周期フォーカスを持ち込まない。 |
| Q7 機能採否 | **保留** | 各機能について **A：互換必須** ／ B：廃止可 | §11 の空欄を埋める。使用実績の推測や既定値だけで廃止しない。 |

J1〜J3、津波 T1〜T3・「今すぐ避難！」・片側への集約、見出し帯 48px、snapshot 超過時の分野別縮退、EEW＋大津波警報の残り高さ利用、あふれ時のページ送りとクリック可能なドットは裁定済み（agenda-v2 §11.1・§10.2・§11.2）。Q5-a の全種別への器割当、Q5-b の自動送り一巡上限（推奨 60 秒）、Q7 は保留。手動ページ選択後の自動送り調停は §8.5.5 の仕様案とする。

### 0.2 読み方

ご主人が先に見る箇所は、上の判断表、§4 の保存単位、§5 の保存障害、§8 の画面、§11 の機能採否表だ。

新築は、届いた電文を整理する係を一人にする。電文を読む部品、地図を描く部品、音を出す部品は分けるが、それぞれが勝手に「現在の警報一覧」を持つことはさせない。

保存は、関連する記録を同じ引き出しに入れる形だ。例えば「この警報は取り消された」という記録と、その警報の現在状態は同じ引き出しに置く。別々に保存して片方だけ新しくなることを防ぐ。一方、地震の更新のために全国の気象警報を全部書き直す必要はない。

保存装置が故障しても、届いた最新情報の表示は続ける。ただし、画面に「未保存」と出す。その間に電源が切れれば、最後に保存できた地点までの記録しか残らない。取消を失った可能性もあるため、再起動後の古い写しを、確認済みの現在情報として無言で表示しない。

地図は「どこで、どれほど広く」を受け持つ。カードは「何が、どれくらい、いつまで」を受け持つ。カードがページ送りされても、有効な区域は地図から消えない。

争点から結論までの見取り図は次のとおりだ。

| 争点 | この spec の結論 | 詳細 |
|---|---|---|
| 部品を23個にするか45個にするか | 実装契約は細かく分け、状態更新と保存の持ち主は増やさない | §3 |
| 複数ファイルを同時に保存する仕組みが必要か | 横断する意味状態を同じ保存単位へまとめる。確認した route では不要 | §4 |
| 保存に失敗したら更新を止めるか | 最新表示を続け、「未保存」と失いうる範囲を示す | §5 |
| 通知を再送するか | 期限内の通知予定を保存して再試行する。重複は許容する | §6 |
| worker は1本で足りるか | 1本で始め、大型 XML 直後の EEW 実表示で判定する | §7 |
| カードをどう詰めるか | 全面地図に半透明の左右列を重ね、通常・見出し・伸縮・テロップの器を使う。収まらない対象はページ送りし、クリック可能なドットでページを選ぶ | §8.5・§8.7 |
| 新築の正しさを何と比較するか | 裁定済み仕様と根拠付き期待値を先に置き、旧築は比較材料にする | §9 |
| いつ旧築を止めるか | personal を含む検収と切替を終え、戻せることを確認した後 | §10・§13 |
| どの情報を大きく見るか | 時間で勝手に巡回しない。ホバーは「指す」、クリックは「開く」。受信した情報だけは自動で開き、初期値 6 秒で概要へ戻る。 | §8.6 |
| 地図をどう見るか | 全体図は都道府県、拡大すると市区町村の **2 層地図**だ。選んだ **フォーカス県**を浮き立たせ、拡大中はドラッグで移動できる。 | §8.8 |
| カードが増えたらどうするか | 発令中の情報だけを載せ、情報種別に応じた高さの「器」に入れる。詳細は隣のカードを押し動かさず、その場に重ねる。 | §8.5〜§8.6 |
| 届いた場所をどう伝えるか | 受信演出とホバーで区域・カードを対応付け、引き出し線は最大 1 本。camera は手動操作と津波の全体図固定を尊重する。津波の左列大カード・大津波だけの点滅・「今すぐ避難！」は裁定済み | §8.6〜§8.8 |

### 0.3 用語集

| 用語 | この spec での意味 |
|---|---|
| engine | 電文を受信し、内容を解釈し、状態を更新する側 |
| display | engine の結果をブラウザで地図・カードとして見せる側 |
| route | 電文の配送先分類。郵便物を仕分ける宛先に相当する |
| 意味モジュール | 地震、津波、気象など、それぞれの電文の規則を扱う部品 |
| family | 新旧判定や取消規則を共通にする電文系列 |
| subject | 更新・取消の対象を識別する鍵。EventID、官署と電文種別、火山コードなど |
| revision | 発表時刻、報番号、訂正などから判断する報の版 |
| gate | 重複、古い報、取消対象の不一致などを判定する処理 |
| watermark | 「ここまでの報を判断した」という記録 |
| tombstone | 取消・終了を覚えておく記録。遅れて届いた古い報の復活を防ぐ |
| current | その系列について、現在有効と判断している状態 |
| reducer | 現在状態、入力、時刻から、次の状態と判断を返す関数。自分では保存や通知をしない |
| 整合性単位 | 一緒に更新・保存・復元しなければ意味が壊れる記録のまとまり |
| checkpoint | 整合性単位の保存済みの写し。再起動時の出発点 |
| snapshot | ブラウザへ渡す、その時点の表示情報一式。checkpoint とは別物 |
| durable | 再起動後にも復元する対象として保存すること。受信直後の保存完了を意味しない |
| non-durable | 実行中だけ保持し、再起動時にはその状態を復活させないこと |
| 原子的保存 | 一つの保存単位について、途中まで書いた内容を完成品として読ませない保存方法 |
| codec | 保存用データへの変換と、保存データの検証・読込みを行う部品 |
| outbox / intent | 「この通知を、この期限までに届ける」という予定の保存場所／予定そのもの |
| worker | Node のメイン処理とは別のスレッド。重い XML 処理で接続や HTTP を止めないために使う |
| mailbox | worker に渡す前の有限の待ち列 |
| SSE | サーバからブラウザへ更新を送り続ける通信方式 |
| slow client | 通信や描画が遅く、配信に追い付けないブラウザ |
| paint | ブラウザが実際に画面へ描いた段階。データ受信や DOM 更新とは異なる |
| p99 | 測定の99%がその値以内に収まる境界。最大値ではない |
| fixture | 試験に使う固定の電文・状態・期待値 |
| corpus | fixtures と、その出典・順序・期待値をまとめた検収資材 |
| oracle | 何を正解とするか、その根拠と判定方法 |
| shadow | 旧築を運用したまま、新築を並走させて比較する運転 |
| overlay | 公開 main に対し、personal 側だけで追加する配線・機能 |
| scene | ページ送り、フォーカス、EEW 割込みを一元管理する表示側の状態機械 |
| GIS | 区域の形や位置を扱う地理データ |
| ポリゴン | 地図上の区域の輪郭 |
| 重心／引き出し点 | 区域の代表座標／カードからの線を実際につなぐ座標。両者が同じとは限らない |
| unavailable | 情報を信頼できる形で利用できない状態。「警報なし」ではない |
| 2 層地図 | 引いて見ると都道府県、寄って見ると市区町村になる地図。気象や津波などの情報の重ね合わせとは別の区分だ。 |
| フォーカス県 | クリックして選んだ都道府県。周囲を暗くし、選んだ県の縁を太くして、見ている範囲を示す。 |
| 受信演出 | 新しい情報が届いた場所を光らせ、地図を寄せ、担当カードを一時的に開く一連の表示。 |
| ホバー | マウスを重ねて「ここを指している」と示す操作。相手の縁と線を出すが、カードの高さは変えない。 |
| 詳細モード | クリックまたは受信によって、カードの詳しい内容を開いた状態。他カードの位置を動かさず、上に重ねて表示する。 |
| 器 | 情報を入れるカードの高さと掲載方法。通常・見出し・伸縮・テロップの 4 種を使う推奨案だ。 |
| scene | EEW 割込み、受信演出、ホバー、開いているカード、フォーカス県、ズームをまとめて管理する表示側の状態。周期フォーカスは持たない。 |
| dissolve | 隣り合う区域をまとめ、内側の境界を消す加工。細分区域を県ごとにまとめ、都道府県の輪郭を作るために使う。 |
| LOD | 拡大率に応じた地図の細かさ。全体図には軽い資材、拡大図には細かい資材を使う。 |
| 描画方式 | 地図をブラウザで描く方法。SVG は図形要素、Canvas は描画面、WebGL は GPU を使う方式だ。速さと見栄えを測って選ぶ。 |

### 0.4 根拠と状態の表記

- **確認済み**: この checkout の実装・設定・fixture・テスト定義を静的に確認した事実。
- **入力上の確定事項**: ご主人の指示と `agenda-v2.md` の裁定。Pi の提示測定値もここに含む。
- **仕様案**: 今回採る構造・契約・開始値。実装済み、達成済みではない。
- **未確認**: この checkout に実体がないもの、実行・実機測定・外部確認が必要なもの。

以下の `file:line` は、この checkout を基準とする。長い対応表では次の略記を使う。

| 略記 | ファイル |
|---|---|
| RC | `src/engine/messages/route-catalog.ts:115` |
| RF | `src/engine/messages/revision-family-registry.ts:122` |
| PM | `src/engine/presentation/processors/process-message.ts:378` |
| CMD | `src/ui/repl-handlers/command-definitions.ts:8` |

## 1. 目的・範囲・非目標

### 1.1 目的

意味の正しさと継続運転を維持しながら、全状態の複製・比較・保存、多重の状態所有、表示の反復探索を取り除く。

設計候補は、次の必須制約をすべて通して比較する。

1. 誤取消、誤降格、別区域への誤適用を防ぎ、不明・欠落・復旧不足を明示する。
2. 大型入力、保存障害、遅い出力先が全体の処理停止へ波及しない。
3. queue、状態、履歴、保存、配信が有限で、復旧可能範囲が説明できる。
4. 固定入力・初期状態・時計・設定から、重要な判断を再検証できる。

制約を満たした案の間では、状態の持ち主と同期条件、例外経路、実装・検証量、余剰性能の順に単純なものを選ぶ。

「シンプルで堅牢」「型で守る」「足す前に引く」を適用する。この checkout の `CLAUDE.md` に後二者の本文がないことは、適用しない理由にならない。

根拠: `agenda-v2.md:32`（Vault Artifacts/2026-09-10-fleq-reconstruction-agenda-v2.md）、`plan-hertz.md:11`（Vault To-Claude/2026-09-10-Astra_Codex_max_reconstruction.md）、`CLAUDE.md:35`。

### 1.2 再構成範囲

| 対象 | 扱い |
|---|---|
| `src/engine/` | 更地から再構成する |
| `src/ui/` | 更地から再構成する。採用する CLI・REPL の意味と機能を維持する |
| `display/frontend/` | 地図を中央に置く新設計として再構成する |
| `src/dmdata/` のパーサ | 資材として持ち越す。境界整理、一回 decode・parse 化、最適化を認める |
| `src/dmdata/` の REST・WS・接続管理 | パーサ資材とは区別して設計する |
| `test/fixtures/` | 原本を保存し、出典と改変有無を再分類する |
| 地図・フォント・ライセンス | 来歴を維持して再利用し、必要な GIS を追加する |
| personal 限定機能 | events JSON、exploration、REPL 拡張を切替条件に含める |
| 旧築 | Pi で継続運用し、新築の検収後に切り替える |

### 1.3 変更しない裁定

- 状態更新担当は一つ。
- 初期構成は Node main と常駐 worker 一本。
- P2 の大型 XML 直後 EEW 検収で必要なら parse 分離へ進む。
- 整合性単位ごとに原子的 JSON 保存を行う。
- 表示 API は有界な完全 snapshot SSE と有限の表示中通知項目。容量超過分野だけを最小事実へ縮退し、その詳細は版付き個別取得に分ける（§8.1・§8.3）。
- display は主領域全面の地図と半透明の左右カード列。発令中・現在有効な情報だけを載せ、あふれはページ送りとクリック可能なドットで扱う。
- 器は通常・見出し・伸縮・テロップの 4 種。見出しは 48px の帯 1 本。通常の基準高 214px と全種別への割当は Q5-a、詳細高さは別の宣言値とし、詳細を周囲へ被せる。
- 保存不能時も最新情報を表示し、「未保存」を明示する。
- 通知は取りこぼし最小化を優先し、期限付き intent を保存・再試行する。
- EEW は受信から実表示まで p99 250ms を出発点とする。
- main は汎用拡張点、personal は具体的配線を持つ。
- dmdata の同時接続枠は最大4本。
- 最初の display 検収端末は開発機の Chrome。Pi にブラウザを追加することは本 spec の前提にしない。
- Q5 と Q7 は未決のまま保持する。

根拠: `agenda-v2.md:36`（Vault Artifacts/2026-09-10-fleq-reconstruction-agenda-v2.md）、`agenda-v2.md:106`（Vault Artifacts/2026-09-10-fleq-reconstruction-agenda-v2.md）。

### 1.4 非目標

初期構成では次を作らない。

- 常設 raw journal、全履歴 event sourcing、汎用 claim。
- SQLite、複数ファイルの commit journal、commit manifest、二段 commit。
- owner 間の楽観ロックと version 突合せ。
- v1／v2 の同時書込み。
- 表示 snapshot の別永続化。
- 全状態を自己往復させる本番経路の検査。
- 差分配送の再送ログ。
- 表示5層、Layout Solver、hidden shelf、収束まで繰り返す DOM 計測。
- 任意 viewport における最大情報密度。
- 旧画面配置・罫線・文字列の全面一致。
- 全保存ファイル喪失からの無条件な自動復旧。
- 受理済み入力の RPO=0、通知の exactly-once。

検収用の有限の入力記録は、常設 journal とは別だ。製品の正しさをその記録の存在に依存させない。

### 1.5 今回の検証範囲

静的読解、ファイル件数、byte 数、指定 fixture の SHA-256 を確認した。書込み・git 操作・build/test・実ブラウザ・Pi 測定は行っていない。

本書は P0 spec の起草成果物だ。corpus manifest の全件作成、oracle の実行、P0 凍結の完了を主張しない。

## 2. 新築の置き場

### 2.1 推奨: 同 repository の新ディレクトリ

J1-A を推奨する。以下は採用時の配置案だ。

```text
reconstruction/
  AGENTS.md
  src/
    contracts/
    app/
    ingress/
    decode/
    runtime/
    domains/
    checkpoint/
    delivery/
    extensions/
    http/
    cli/
    diagnostics/
  display/
    client/
    scene/
    maps/
    components/
  material/
    telegram-types/
    parser/
    values/
  test/
    contracts/
    histories/
    fault/
    performance/
  tools/
    corpus/
    compare/
    migrate-v2/
  build/
    engine/
    display/

test/fixtures/                  既存資材の共有元
display/maps/quake/              既存 GIS の出典・投影設定
docs/licenses/                  既存ライセンスの共有元
```

`material/` は、旧パーサを出所付きで新しい純粋境界へ抽出した資材だ。旧 engine の wrapper、logger、設定読込みまで持ち込む場所ではない。

共有対象は fixture 原本、パーサの出所と期待値、純粋な値処理、地図の出典・生成資材だ。Pi で稼働中の旧配布物は固定する。新築のビルド先が旧 `dist/` を消したり上書きしたりしてはならない。

### 2.2 公開 main と personal

公開 main に置くものは次に限定する。

- 新築本体。
- 型付きの非同期・有界な outcome 購読口。
- 名前空間付きの REPL 拡張登録口。
- 拡張を使わなくても完結する fake consumer による契約テスト。
- 公開可能性を確認した fixtures と GIS 資材。

personal 側に置くものは次だ。

- events JSON の schema、writer、保存先・保持設定。
- exploration のデータ処理・UI・索引。
- personal 専用 REPL コマンド。
- 実運用の入力記録、比較記録、private fixture、移行コピー。
- main の拡張口を personal 実装へ接続する composition root。

環境変数で無効にしているだけの personal writer を公開 main に置くことは認めない。公開 source、browser bundle、npm tarball、公開 CI artifact のすべてを対象にする。

この制約は今回の要求と既存の表示専用ポリシーに基づく。現行 dmdata 規約全文の外部確認は行っておらず、repository を分ければ再配信条件を満たす、とは判断しない。

確認済みの公開制限: `docs/specs/engine.md:2746`、`src/engine/template/parser.ts:174`。

### 2.3 CI と release の分離

現物では次が確認できる。

- root TypeScript は `src/**/*` を対象とする。
- npm 配布対象は `dist`、`display/dist`、`assets` 等の許可リスト。
- `prepack` は engine と display をビルドする。
- release workflow は `v*` tag で起動し、tag commit が main に到達可能であることを確認する。
- release workflow は `npm publish --provenance --access public` を実行する。
- 通常 CI は main への push／PR を対象に build、型検査、通常 test、shuffle、strict sweep、display test を実行する。

根拠: `tsconfig.json:6`、`package.json:9`、`package.json:29`、`.github/workflows/release.yml:3`、`.github/workflows/release.yml:20`、`.github/workflows/test.yml:25`。

新築では以下を契約にする。

1. 新築用の build／test／型検査を明示的な別 target にする。
2. 旧 target の include／exclude と出力先を維持し、新築の追加だけで旧 release 内容が変わらないようにする。
3. root と display の既存 lockfile を利用する。追加 package は必要性を別契約で示すまで作らない。
4. package scripts、TypeScript 設定、CI の変更は、許可パスを明記した専用契約で行う。
5. main CI では公開資材だけを使う。personal の検収は private 側で、main 基準版と overlay 版の組を記録する。
6. shadow 用配布は npm 公開を起動しない経路にする。新築検収用の名前に既存 `v*` release trigger を流用しない。
7. P6 までは npm の通常 `fleq` entry を旧築のままにする。
8. 切替版では配布内容を実際に展開して検査し、personal の実装・データ、旧 reader、検収専用 recorder の混入がないことを確認する。
9. 公開前に main 本体と personal 配線の双方が切替対象版で検収済みであることを記録する。

### 2.4 別 repository を選ぶ場合

J1-B では、次の追加負担を受け入れる。

- パーサ・fixtures・GIS ごとの移入版、hash、出典を別途固定する。
- 旧新比較で二つの repository の基準版を常に記録する。
- 公開 main／personal 相当の境界と private CI を新設する。
- npm package 名、既存利用者の更新経路、release 権限を設計し直す。
- 資材のコピーに含まれる公開可否を再監査する。

別 repository は公開境界を自動的に解決しない。今回の要求では、これらの負担を増やす具体的な利益が確認できないため A を推奨する。

## 3. モジュール一覧と責務

### 3.1 統合方針

**45の責務モジュール、12の保存単位、状態更新担当一つ**を仕様案とする。

45は package 数、常駐処理数、独立した current store の数ではない。

- ヘルツ案の「関連する意味状態をまとめる」「公開口を絞る」を採る。
- ChatGPT 案の「一つの AI 実装契約を閉じられる粒度」を採る。
- display の15分野中心の分割を、地図・区域塗り・フラッシュ・引き出し線・カード列・EEW 縮退・scene に組み替える。
- 意味モジュールは純関数群だ。状態参照の交換は runtime だけが行う。
- 保存単位内の複数モジュールを、別 owner の同期問題にしない。

根拠: `plan-hertz.md:46`（Vault To-Claude/2026-09-10-Astra_Codex_max_reconstruction.md）、`plan-chatgpt.md:126`（Vault To-Claude/FlEq_Reconstruction_Simple_Robust_2026-09-10.md）、`agenda-v2.md:253`（Vault Artifacts/2026-09-10-fleq-reconstruction-agenda-v2.md）。

### 3.2 共通の公開契約

状態の所有者は保存単位ごとの runtime であり、意味モジュールの数だけ所有者を増やさない。

意味モジュールは、入力型・純粋な意味判定・slice の更新・表示事実の射影を持つ。共有保存単位の公開口は、その単位の統合契約が一つだけ所有する。

```ts
reduceUnit(state, input, clock): Step<UnitState>
toView(state, clock): UnitView
encodeCheckpoint(state): PersistedUnit
decodeCheckpoint(value: unknown): DecodeResult<UnitState>
nextDeadline(state): Deadline | null
```

複数の意味モジュールを持つ単位では、各モジュールの純関数を `reduceUnit` が組み立てる。個別モジュールに同じ単位の全量 codec・独立した保存世代・公開 mutator を持たせない。単独モジュールの単位でも、委譲だけの class や interface を追加せず、その関数を統合契約の実装として使ってよい。

`reduceUnit` に logger、filesystem、通知、HTTP、現在時刻取得、他単位の mutator を渡さない。時計・設定版・入力起源を値で渡す。意味更新、期限処理、batch 終了、復元結果の採用、通知結果、保存 ack は runtime が直列に処理する。

状態は private とし、可変 Map・配列・内部 object を外へ貸さない。公開 DTO は再帰的に readonly な値型とし、mutable state への参照を含めない。境界テストでは入力・未変更枝の不変性を確認する。本番で変更検出のために全状態を clone・freeze・stringify しない。

各契約は次を必須とする。

| 項目 | 必須内容 |
|---|---|
| 公開型・関数 | 入力、結果、reason、公開関数、呼出主体 |
| 依存 | 許可 module・adapter と先行契約 ID |
| 保存単位 | `U-*` と統合契約 ID、状態・codec の所有者 |
| 受理方針 | 複数 subject の適用範囲、全体拒否・部分受理の条件 |
| 副作用境界 | intent・表示・outcome を作る条件と公開時点 |
| 時間 | 業務上の絶対期限、保持期限、試行 timeout、作業期限を分離 |
| 上限 | 件数・byte・in-flight・超過時の結果 |
| oracle | 系列 ID、fixture ID、各 step の期待 decision と根拠 |
| 検証 | 受入条件・契約境界・実不具合・corpus 履歴のどれを確認するか |
| 未決 | owner、依存する作業、解決期限。期限未記入で発注しない |

契約は新しい抽象層を必須にするものではない。型と関数と受入条件のまとまりであり、同じ責務を別の wrapper へ複製しない。

### 3.3 基盤15モジュール

表中の O01〜O11 は §9 の必須系列だ。意味 reducer を持たない部品は、期待 decision の代わりに境界の期待結果を記載する。

| ID / モジュール | 公開口・責務 | 許可依存 | fixture・期待結果 | 期限・保存対象・非対象 |
|---|---|---|---|---|
| B01 `contracts-revision` | `ReportRef`、区域参照、特殊値、結果型、純粋な revision 比較 | 純粋な値型のみ | O01/O02。先頭ゼロ、同一 revision 訂正、不明値の区別 | 保存 schema を定義するが I/O・current を持たない |
| B02 `app-config` | 設定検証、composition root、起動・停止 | 各公開 adapter | 新旧ディレクトリ・appName 衝突を拒否 | 起動・停止期限。設定だけを保存し、電文状態は持たない |
| B03 `ingress` | WS/REST/replay を共通入力へ変換、購読根拠を保持 | B01、通信 adapter | O09/O10。接続所有、受信時刻の自前確定 | 再接続・REST deadline。入力の無制限蓄積をしない |
| B04 `decode-material` | decode、展開、XML tree、metadata、分野抽出 | B01、純粋パーサ資材 | 全 XML、O02/O09。一回 decode・展開・full parse | 入力上限。tree・raw は処理後解放、保存しない |
| B05 `mailbox` | credit、入力順、件数・byte、worker 完了 | B01、MessagePort adapter | O09/O10。満杯・停止・異常終了時も計数一致 | §7 の上限。queue は non-durable |
| B06 `runtime-clock` | 唯一の state 更新、期限入力、保存完了入力 | B01、意味モジュール、port | 全系列。同じ入力順・時計で同じ decision | 単調時間と絶対時刻を分離。保存対象は §4 |
| B07 `checkpoint` | encode 要求、2スロット保存、検証・世代選択 | B01、filesystem adapter | O07/O10。途中書込み・成否不明を区別 | 正常系では初回 dirty から包含世代の保存確認まで3秒以内（§5.8）。状態の意味を補修しない |
| B08 `view-projector` | domain view から完全表示 snapshot を作る | B01、各 `toView` | O02/O11。全区域と件数、失敗単位の局所化 | view cache は再生成可能。別 current を持たない |
| B09 `notification-delivery` | intent の試行、ack・失敗を runtime に戻す | B01、通知・音 adapter | O01/O07/O10。期限内再試行、重複許容 | intent は発生元単位へ保存。独立 outbox DB は作らない |
| B10 `extension-port` | 型付き outcome の非同期・有界配送 | B01、登録 consumer | O10/O11。遅い／失敗する consumer の隔離 | §12。公開 main は exporter を持たない |
| B11 `http-sse` | snapshot、health、詳細、静的配信、認証 | B01、immutable view | O11。再接続直後から一枚で復元 | 最新一枚＋client ごとの待機一枚。配信履歴は保存しない |
| B12 `cli-commands` | CLI/REPL を typed command に変換 | B01、command port | §11、O10。無効入力で副作用なし | command deadline。domain state を直接変更しない |
| B13 `terminal-output` | 採用した意味事実の整形、stdout への有界配送 | B01、表示用値処理 | §11、O02。特殊値と取消を保持 | 出力滞留上限。受理完了条件にしない |
| B14 `filter-template` | 採用した DSL の構文・型・評価 | B01、出力 DTO | §11。既存文法、表示専用制限、未知 field 拒否 | 式サイズ・深さ上限。通知・受理状態へ作用しない |
| B15 `diagnostics` | reason、遅延、進捗、保存・容量・接続状態 | B01、小さい log sink | O04/O09/O10/O11。凍結・欠落を観測 | 有限 ring と保持上限付きログ。raw/token を通常記録しない |

### 3.4 意味18モジュール

| ID / モジュール | 主な責務・公開結果 | fixture・期待 decision | 保存単位・期限 | 非対象 |
|---|---|---|---|---|
| M01 `eew` | VXSE43/44/45、報番号、終端、取消、予想震度と保持根拠 | O01/O02/O09。重複抑制、unknown 続報で誤降格しない | U-E。current は N、intent は D | 地震観測、永続 EEW current |
| M02 `earthquake` | EventID ごとの観測・訂正、日次履歴、強震保持根拠 | O01/O07。取消と復元後 unknown | U-Q。既存地震期限を明示移植 | 別 quake map store |
| M03 `long-period` | VXSE62、長周期値・観測根拠 | O01/O02/O07 | U-Q。36時間の gate retention を基準 | 震度 rank との混同 |
| M04 `tsunami` | VTSE41 警報、VTSE51/52 観測系列、区域・観測点取消 | O01/O05/O07 | U-T。family ごとの期限 | 全分野への fragment merge 一般化 |
| M05 `nankai` | 現況を変える情報と説明だけの情報を分離 | O01/O02/O07 | U-N。現況 D、情報系列 N | 全 VYSE を同じ current へ上書き |
| M06 `weather-current` | 全国 base、官署 partial、code00、VPNO50 終了 | O03/O04/O06 | U-W。全国履歴2・partial8 | VPWW56、表示容量による受理拒否 |
| M07 `landslide` | VPWW56 の官署別 current、解除、取消 | O01/O03/O07 | U-L。官署×type、6時間 retention | 他官署の一括消去 |
| M08 `weather-timeseries` | VPWP50 の subject、period、正常 empty、容量不足 | O02/O09。194 period と gate-only | U-F。7日 retention | カードに合わせた state 削減探索 |
| M09 `tornado` | 官署別区域、目撃、通常解除、有効期限 | O01/O02/O08 | U-M の tornado slice、36時間 retention | 名前からの地図区域推定 |
| M10 `heat` | 対象日・地域、通常／特別、取消 | O01/O08 | U-M の heat slice、対象日終了・3日 retention | 日付の受信時刻置換 |
| M11 `typhoon-analysis` | 台風 identity、解析、低気圧化、発生取消 | O01/O02/O07 | U-Y の analysis slice、7日 tombstone | 根拠のない確率 slice の消去 |
| M12 `typhoon-probability` | VPTA50、地域・時刻・値、連続ゼロ、empty | O02/O07/O10 | U-Y の probability slice、7日 retention | 表示失敗による gate 巻戻し |
| M13 `flood` | EventID、河川・発表区間・観測点、解除と unknown | O01/O02/O07 | U-R。36時間 retention | 全 unknown の解除扱い |
| M14 `volcano-alert` | VFVO50/51/VFSVii、火山別数値・非数値警報 | O01/O07。多火山報の局所取消 | U-V。alert tombstone30日 | 同火山の噴火・降灰の無条件取消 |
| M15 `volcano-eruption` | VFVO52/56、火山と EventID の対応、空コード取消 | O01/O07 | U-V。eruption tombstone2日 | 出典不明 identity の推測 |
| M16 `volcano-ashfall` | VFVO54/55 共通系列、VFVO53 集約 | O01/O08。54/55 variant、53無音 flush | U-V。54/55 D・7日、53 N | 保存単位を三つに割ること |
| M17 `briefing-counterpart` | VPBS50、VPOA50、予測→発生、対応報置換、取消 | O01/O03/O07/O08 | U-B。意味 lifecycle と必要 watermark | 全 legacy 電文への未確認相関規則 |
| M18 `bulletins` | 地震解説、早期天候、気候、気象解説、未確認 legacy、raw の短命表示事実 | O01/O02/O08 | U-M の transient slice、family 固定期限 | 永続警報 current の捏造 |

M02/M03、M09/M10、M11/M12、M14〜M16 の分割はコードと発注の分割だ。保存単位を別にする要求ではない。

### 3.5 display モジュール

以下の 12 モジュールを display の発注単位とする。モジュール数は実行プロセス数・保存単位数を意味しない。engine の意味状態を display が更新することは禁止する。

**製品要件上確定**：地図全面配置、発令中のみのカード、区域ごとの最大重大度と共有色トークン、周期フォーカスなし、ホバー＝指す／クリック＝開く、詳細 overlay、4 種の器と見出し帯 48px、2 層地図、県フォーカス、EEW の猶予秒廃止、津波 T1〜T3・「今すぐ避難！」、片側集約、同時発生時の EEW 宣言高と右列残余の見出し表示、あふれ時のページ送り・クリック可能なドット、snapshot の分野別容量縮退。

**仕様案・未裁定**：Q5-a の全種別・状態への器割当、Q5-b の自動送り一巡上限（推奨 60 秒）、§8.5.5 の手動選択後の自動送り停止・明示再開、§8 の容量配分・詳細取得開始値と操作調停案。津波 T1〜T3 と agenda-v2 §11.2 の裁定を未決へ戻さず、P4 前に残る仕様案の採用値・fixture を固定する。

| ID／モジュール | 公開型・責務 | 許可する依存 | fixture・期待 decision | 期限・保持対象／非対象 |
|---|---|---|---|---|
| D01 `gis-assets` | `MapAssetManifest`、`AreaGeometry`、`AreaName`、`AreaAnchor`。都道府県 dissolve、全体図用・ズーム用資材、コード対応表、代表点・境界・bounds を build する。 | 固定した GIS 入力、コード表、build 用 GIS ライブラリ | 47 県、既存 1,892 区域、離島、複数ポリゴン、欠損コード、異なる LOD。対応不明は明示し、名前から区域を推測しない。 | build 時に生成・hash 固定。実行時の dissolve、一般化処理、電文本文は保持しない。 |
| D02 `snapshot-client` | `DisplaySnapshot` の接続・schema・連番を管理し、容量縮退分野の詳細を版付きで個別取得する。 | 公開 wire 型、SSE、個別取得 API、単調時計 | 完全 snapshot の置換、再接続、旧版破棄、容量縮退中の別分野取消、詳細取得中の更新・取消・版不一致。metadata 更新で scene を初期化しない。 | 最新 snapshot 1 個、開いている詳細 1 件・その現在ページ、個別取得 in-flight 1 件。旧版履歴・先読み列を持たない。 |
| D03 `scene` | `SceneState`、`SceneEvent`、純粋な `reduceScene`。受信演出、ホバー、詳細、県フォーカス、camera 所有、ページ位置・自動送り停止を管理する。 | 公開 view 型、D04 の宣言値、明示時計 | 手動操作前後の受信、津波固定、EEW 割込み、ドット選択と timer 同時発火、取消、単独→同時→単独。周期フォーカス遷移は存在しない。 | 受信詳細は初期 6 秒。手動詳細とページ停止は明示操作まで。実行中 scene のみで、engine checkpoint へ保存しない。 |
| D04 `card-profiles` | `VesselProfile`、`DetailProfile`、`ColumnBudget`。器・詳細・行高・gap・時計・ページドットの予約高、EEW 固定高、残余高、ページ範囲を宣言値で計算する。 | 固定 profile、viewport、カードの意味種別・件数 | 通常 214px、見出し 48px、伸縮、片側の自動昇格、同時発生時の右列残余、全対象のページ到達、下端補正。 | profile と現在の算術結果のみ。候補 DOM、測定キャッシュ、Layout Solver は持たない。 |
| D05 `display-shell` | 主領域全面の地図、半透明の左右列、下段テロップ、右下時計、表示モード・接続状態だけのヘッダを配置する。 | D02〜D04、表示 component | 無発令、通常、多発令、EEW、時計予約、テロップ。空の災害カードを作らない。 | 表示中の component のみ。画面外カードの測定用 mount をしない。 |
| D06 `map-viewport` | `MapCamera`、`GeographicLevel`。全体図・市区町村層、県クリック、wheel、drag、県フォーカスと全体図復帰を扱う。 | D01、D03 | 県クリックで拡大・周囲 dim、県外クリックで復帰、wheel の層切替、pan 制限、離島。 | camera と入力操作状態のみ。地理形状の runtime 再生成はしない。 |
| D07 `hazard-layers` | 区域ごとの最大重大度、共有色トークン、EEW 予想震度、津波海岸線、hover 境界を描く。容量縮退で失った地理情報を正常な無発令に見せない。 | 公開意味 view、D01、D06、固定した重大度対応表 | 異種災害の重なり、同順位、入力順逆転、最大状態の取消、LOD 切替、縮退、未対応区域。海岸線と陸の塗りを別検証する。 | 最新 view の描画情報のみ。警報 current を別所有しない。 |
| D08 `receipt-effects` | フラッシュ、許可された camera 遷移、自動詳細、終了を scene event として進める。 | D03、D06、宣言済み motion profile | 自動 camera の通常系列、既存の手動 camera 維持、津波中の zoom 抑止、取消、連続受信、古い timeout、reduced motion。 | 実行中 1 件＋最新候補 1 件を開始案とし、演出の省略で意味状態・通知を落とさない。 |
| D09 `pointer-link` | hover の相手縁取り、区域名札、カードから代表区域への線 1 本を表示する。 | D01、D03、D04、D06 | 平常時 0 本、hover／受信時最大 1 本、カード hover、区域 hover、対象消失。高さは変更しない。 | 現在の pointer 対象と線だけ。周期的な線の巡回はしない。 |
| D10 `active-cards` | 発令中の概要、クリック詳細、詳細 overlay、共通見出しを描く。 | 公開 view、D03、D04 | 種別別 compact 内容、器、詳細再クリック、隠れるカードの減光、下端補正、空カード不在。 | 表示対象のみ mount。詳細高さは宣言値。全候補の hidden DOM は作らない。 |
| D11 `emergency-columns` | EEW 右列大カード、津波左列大カード、片側への他カード集約、同時発生時の EEW 宣言高と右列残余の 48px 見出し・ページ送りを扱う。 | 公開 EEW／津波 view、D03〜D07、D10 の見出し契約 | 猶予秒なし、津波なし時の EEW bounds、T1〜T3、「今すぐ避難！」、単独→同時→単独、重大度順・取消・全ページ到達。 | 有効な緊急情報と表示状態のみ。独自期限・独自取消判定を持たない。 |
| D12 `notices-ticker` | 表示中の通知項目、受信診断、テロップとチップを描く。熱中症・竜巻の器割当案を受け持つ。 | 公開 snapshot、D03、D04 | 有効期限、再接続、複数チップ、未保存・復元不確実性、内容欠落の明示。 | 有界の表示項目のみ。通知履歴全件、音声再送、engine intent の更新を行わない。 |

見出しの現行契約は `.standby-card-header`、title、metadata の構造と container／on／band の三組で確認済みだ。新築でも継承する。根拠：`docs/specs/2026-08-28-standby-card-header-unification.md:41`、`display/frontend/src/lib/theme.css:282`。

### 3.6 依存規則

- `domains/*` は contracts、純粋な値処理、自モジュールの内部 helper だけに依存する。
- 関連する複数意味モジュールの組立ては保存単位の reducer 境界で行う。
- formatter、HTTP、display、personal consumer から reducer の private state を変更できない。
- 新 runtime は旧 engine／ui の実装に依存しない。
- 旧 reader、旧出力 adapter は `tools/` と比較テストだけに置く。
- browser に共有するのは表示 protocol と純粋な値型であり、保存 schema や Node の状態実装ではない。
- `optional` 引数を省くと gate・保存・通知条件を迂回できる公開口を作らない。

## 4. 整合性単位と全 route 対応表

### 4.1 durable の読み分け

**確認済み:** 現行 RF の `durable` は主として revision gate の保存指定であり、その route に関する保存の全体像ではない。

例えば earthquake の gate policy は non-durable だが、実際には `gateDurablePresentationOutcome` を経由する。地図保持・強震保持・日次履歴も別途更新される。VPBS50/VPOA50 も transient gate と durable な速報 lifecycle を併せ持つ。

根拠: RF:172–229、PM:481–490、PM:539–548、`src/engine/monitor/display-sink.ts:266`、`src/engine/display/standby-state-store.ts:409`。

新築では次を分けて固定する。

1. **意味状態の保存**: current、取消・復元に必要な記憶、期限。
2. **通知 intent の保存**: Q4 に従う短命の配送予定。
3. **実行中だけの状態**: 接続、queue、表示周期、一般の重複 cache。

EEW の current は non-durable のままだ。EEW intent を保存しても、EEW current を再起動後に復活させる契約にはしない。

表中の D は保存対象、N は実行中だけの対象だ。D でも受理時に保存待ちを挟むとは限らず、保存完了は別に示す。

### 4.2 保存単位

12単位を定義する。各単位は一つの schema を持ち、物理ファイルは A/B の2スロットとする。

byte 予算は**開始値**だ。P1〜P3 で最大正常入力・同時最大状態を通すことを検収する。予算内で安全に拒否できることだけでは、機能合格にならない。

| 単位 | 内容 | 保存するもの | 保存しないもの | 1世代の開始 byte 予算 |
|---|---|---|---|---:|
| U-E `eew` | EEW | 期限付き intent、配送済み／失効の必要最小記録 | active EEW、予測保持 latch、実行中 gate | 256 KiB |
| U-Q `seismic` | 地震・長周期 | 有効観測、出典、取消記憶、強震保持の根拠、必要な当日履歴、intent | 描画 path、カード配置、別地図 snapshot | 4 MiB |
| U-T `tsunami` | 津波警報・観測 | EventID 別警報、区域状態、VTSE51/52 の独立観測系列、station記憶、取消、intent | 表示用複製、復旧用 REST queue | 4 MiB |
| U-N `nankai` | 南海トラフ | 現況、現況更新の出典・取消記憶、intent | 説明だけの報の永続 current | 256 KiB |
| U-W `weather-current` | VPWS50、VPWW55/57–61、VPNO50終了 | 全国 base、partial、現象所有情報、履歴、watermark、区域終了 tombstone、intent | 別 standby／promotion current | 16 MiB |
| U-L `landslide` | VPWW56 | 官署×type の current・gate・取消・期限・intent | 全国一括の権威ある union | 2 MiB |
| U-F `weather-timeseries` | VPWP50 | period、subject revision、正常 empty、unavailable根拠、取消、期限、intent | カード幅に合わせた切捨て state | 16 MiB |
| U-B `briefing` | VPBS50/VPOA50 | 復元が必要な速報 lifecycle、予測置換・取消・alias記憶、出典、intent | 相関待ち timer、raw原文、一般 holdback queue | 2 MiB |
| U-M `local-and-bulletins` | 竜巻・熱中症・各種短命情報 | tornado/heat の意味状態・取消・期限、通知対象の intent | 早期天候・気候・解説・raw の永続 current | 4 MiB |
| U-Y `typhoon` | 台風解析・確率 | 独立 slice、各 revision・期限・取消、連続ゼロ判定、intent | formatter 別の台風 cache | 8 MiB |
| U-V `volcano` | 警報・噴火・降灰 | 三 slice、火山と EventID の対応、provenance、取消・復旧不足、intent | VFVO53 待機 batch、runtime `restored` | 4 MiB |
| U-R `flood` | 指定河川・水位周知 | EventID lifecycle、河川・区間・station事実、gate、取消・期限、intent | 別 card current、表示用 station 複製 | 8 MiB |

設定は電文保存単位とは別の設定ファイルとする。設定変更と電文状態の複数ファイル原子性は要求しない。設定版を各 decision と intent に記録し、どの設定で判断したかを説明できるようにする。

### 4.3 全 route 対応

RC には21 route がある。以下は全21 route を網羅し、意味の異なる下位分類を展開した表だ。

| route / 対象 | 意味モジュール | 保存単位 | D / N | 取消・復元で一緒に変える状態 | 現行根拠 |
|---|---|---|---|---|---|
| `ignore` / VPWW53/54、VPZJ50、VPCJ50、VPFJ50、VMCJ50/51/52 | ingress の明示 ignore | なし | N | current、通知、業務統計を作らない | RC:91–120 |
| `legacyCounterpart` / VPOA50 | M17 | U-B | lifecycle D、相関待ち N | raw由来速報、VPBS50へのalias、取消・置換記憶、intent | RC:123、PM:1067、`standby-state-store.ts:3337` |
| `legacyCounterpart` / VPNO50 の区域解除 | M06 | U-W | 終了記憶 D | 対象区域の特別警報終了、官署watermark、base/partial合成、intent | PM:378–453、PM:1062–1076 |
| `legacyCounterpart` / その他VPNO50、VXWW50 | M18 | U-M | 意味表示 N、対象intentのみD | 同じ legacy subject の短命表示・取消。気象 current を推測で変更しない | RF:271–289、PM:1074 |
| `eew` / VXSE43/44/45 | M01 | U-E | current/gate N、intent D | EventID と family の報番号、終端、取消、実行中予測保持、該当intent | RC:133、RF:122–143 |
| `volcano` / VFVO50/51/VFSVii | M14 | U-V | D | 対象火山の alert、非数値警報、出典、取消、intent | RC:139、RF:651–670 |
| `volcano` / VFVO52/56 | M15 | U-V | D | eruption、EventID逆引き、空コード取消、provenance、intent | RF:672–693 |
| `volcano` / VFVO54/55 | M16 | U-V | D | 共通 ashfall、54/55 variant、取消、期限、未配送intent | RF:315–335 |
| `volcano` / VFVO53 | M16 | U-V | batch/gate N、intent D | 火山別batch、取消、54/55割込み時の無音flush | RF:292–313、`volcano-vfvo53-aggregator.ts:2–42` |
| `volcano` / VFVO60/VZVO40 | M16内の短命情報処理 | U-V | current N、intent D | 当該 type×EventID の短命表示・取消 | RF:347–354 |
| `seismicText` / VXSE56/60/VZSE40 | M18 | U-M | current/gate N、intent D | type×EventID の情報項目・取消 | RC:145、RF:214–221 |
| `lgObservation` / VXSE62 | M03 | U-Q | D | 長周期の観測、特殊値、EventID、取消、保持期限、intent | RC:155、RF:496–507 |
| `earthquake` / VXSE51/52/53/61 | M02 | U-Q | 復元対象D、受信cache N | EventIDの観測寄与、取消、強震保持、当日履歴、地図表示根拠、intent | RC:165、PM:481、`display-sink.ts:268–270` |
| `tsunami` / VTSE41 | M04 | U-T | D | EventIDごとの警報・区域・種別、取消・解除、出典、intent | RC:171、RF:824–844 |
| `tsunami` / VTSE51 | M04 | U-T | D | VTSE51のfamily watermarkとstation item、訂正・取消、観測値 | RF:715–743 |
| `tsunami` / VTSE52 | M04 | U-T | D | VTSE52の独立family watermarkとstation item、訂正・取消 | RF:715–743 |
| `nankaiTrough` / 現況を更新するVYSE50/51/52/60 | M05 | U-N | D | `nankai:current`、出典EventID、取消・終了、intent | RC:177、RF:451–460、PM:506–514 |
| `nankaiTrough` / 説明だけの同型電文 | M05 | U-N | 情報系列N、intent D | 情報subjectだけ。現況を更新しない | RF:462–478、PM:516–520 |
| `weather` / VPWS50 | M06 | U-W | D | 全国base、履歴2、gate、partialとの合成、取消復元、intent | RC:183、RF:769–790 |
| `weather` / VPWW55/57/58/59/60/61 | M06 | U-W | D | type×官署partial、履歴8、所有現象、code00、取消復元 | `weather-stream-key.ts:5–28`、`vpws50-state.ts:997–1012` |
| `weather` / VPWW56 | M07 | U-L | D | type×官署だけを clear、gate、期限。ほかの官署を維持 | RF:793–820 |
| `tornado` / VPHW50/51 | M09 | U-M | D | 官署別区域、目撃、有効期限、取消、intent | RC:189、RF:398–408 |
| `briefing` / VPBS50 | M17 | U-B | 復元対象lifecycle D、一般短命表示N | 予測→発生、意味subject、VPOA alias、取消、期限、intent | RC:199、PM:539–548、`standby-state-store.ts:3337` |
| `earlyWeather` / VPAW51 | M18 | U-M | current/gate N、intent D | type×EventIDの短命情報と取消 | RC:205、RF:232–239 |
| `weatherWarningTimeseries` / VPWP50 | M08 | U-F | D | subject、period、正常empty、watermark、取消、unavailable、intent | RC:211、RF:480–494 |
| `climateInfo` / VPZI50/VPCI50 | M18 | U-M | current/gate N、intent D | 当該情報subjectの表示・取消 | RC:217、RF:241–248 |
| `weatherExplanation` / VPCJ51/VPZJ51/VPFJ51/VMCJ53/54/55 | M18 | U-M | current/gate N、intent D | 当該情報subjectの表示・取消。気象警報を変更しない | RC:227、RF:250–257 |
| `heatAlert` / VPFT50 | M10 | U-M | D | 対象日・対象地域、取消、期限、intent | RC:237、RF:410–421 |
| `typhoonAnalysis` / VPTW60/61/62 | M11 | U-Y | D | 台風analysis、低気圧化・発生取消、watermark、intent | RC:243、RF:423–435 |
| `typhoonProbability` / VPTA50 | M12 | U-Y | D | probability、gate-only、連続ゼロ、取消・期限、intent | RC:253、RF:437–449 |
| `floodForecast` / VXKO50–89 | M13 | U-R | D | EventID、station digest、河川・区間、取消・解除、unknown保持根拠 | RC:259、RF:508–569 |
| `floodForecast` / VXSU50–59 | M13 | U-R | D対象のlifecycle、観測seriesなし | 確定できる見出し・区間状態、取消。存在しない観測seriesを作らない | RC:82–85、RF:520–569 |
| `raw` / 未対応・parse失敗のfallback | M18 | U-M | N | 業務currentを作らない。元route・reasonを診断へ残す | RC:269、RF:259–266 |

追加規則:

- classification／prefix の広い route に入っただけでは、意味対応済みにしない。明示 policy のない head type は raw／未対応診断へ送る。
- `ignore` が最優先である順序を維持する。
- parse failure と semantic suppression を区別する。重複・古い報を raw に戻して再表示しない。
- identity が確定できない入力から、名前・受信時刻で擬似 subject を作って durable current を更新しない。
- transient と durable の区別は表示の大きさや緊急モードで切り替えない。
- 復元対象の地震・速報では、旧 gate の `durable:false` を理由に必要な取消記憶まで捨てない。既存の分散した保持根拠を同じ新 schema に収める。

### 4.4 Q13 の結論

**結論: 上記の保存単位に統合した後、確認した21 route に、複数保存単位の同時 commit を要求する例は残らない。初期 SQLite／commit journal は不要だ。**

コード上の横断関係を次のように閉じる。

| 横断関係 | 確認した現行処理 | 新築での解決 |
|---|---|---|
| 全国警報と官署別先行報 | 同じ VPWS50 holder の base/partial を構成 | U-W に同居 |
| VPNO50 と気象警報 | gate・VPWS50・standby をまとめて更新し、区域終了 tombstone を記録 | VPNO50 の当該意味分岐を U-W に割り当てる |
| 地震と地図・強震・日次履歴 | 一つの受理結果から複数 store を更新 | 観測寄与と必要履歴を U-Q に統合し、地図はそこから射影 |
| VPBS50 と VPOA50 | 速報カードの canonical 置換とalias・取消記憶 | U-B に同居 |
| 火山三系列と VFVO53 待機batch | 警報・噴火・降灰に関連する取消と割込み | U-V に同居。batch自体はN |
| 台風解析と確率 | 独立した意味sliceを表示時に結合 | U-Y に同居し、根拠のある操作だけを対象sliceへ適用 |
| 受理結果と通知 | 保存状態と通知予定が別に進み得る | intentを発生元単位へ同居 |
| 全分野の画面 | 複数状態から表示を構成 | 保存不要の純粋な射影。全分野同時保存を要求しない |

重要な根拠は、PM:406–453、`src/engine/messages/vpws50-state.ts:1016`、`src/engine/monitor/display-sink.ts:266`、`src/engine/display/standby-state-store.ts:3337` だ。

定期 tick が複数単位の期限を同時に迎えることは、複数ファイルの原子性を必要としない。それぞれの単位を直列に更新し、snapshot は runtime の一時点の組合せから作る。

復旧後の単位間 checkpoint 世代が異なることも許容する。各単位の保存世代と鮮度を示し、全体で一つの保存時点だったと偽らない。

P3 の追加実装で新しい横断不変条件を発見した場合は、Q13 を根拠付きで再開する。file journal を先に作って解決してはならない。

### 4.5 保持上限

現行の開始基準として次を採る。active の有効期限と tombstone retention は別欄で扱う。

| 対象 | 件数・保持基準 |
|---|---|
| EEW | familyごと最大512 subject。再起動復元なし |
| 地震 | 最大512 EventIDを基準。日次履歴・強震保持は別の有限期限を明示 |
| 長周期 | 最大256 subject、gate retention36時間 |
| VPWS50 | 全国base1、partial128、全国履歴2、partial履歴8 |
| VPWW56 | 最大128 subject、6時間 retention |
| VPWP50 | 最大512 subject、7日 retention。194 periodの正常系列を必ず扱う |
| 津波観測 | VTSE51/52それぞれstation最大1024とfamily watermark |
| 竜巻 | 最大128 subject、36時間 retention |
| 熱中症 | 最大256 subject、3日 retention、activeは対象日で評価 |
| 台風解析 | 最大64 subject、tombstone7日 |
| 台風確率 | 最大256 subject、7日 retention |
| 火山 | 各family最大128 subject。alert30日、eruption2日、ashfall7日の取消記憶 |
| 洪水 | 最大512 subject、36時間 retention |
| VFVO53 batch | 最大20件、quiet8秒、maxWait90秒を互換開始値 |
| 通知 intent | §6の件数・byte・期限上限 |

根拠: RF:139、RF:146–154、RF:398–569、RF:571–573、`src/engine/messages/vpws50-state.ts:34`、`src/engine/messages/tsunami-state.ts:37`、`src/engine/messages/volcano-vfvo53-aggregator.ts:40`。


### 4.6 保存単位の統合契約

各保存単位に統合契約 `I-U-*` を一つ置く。契約を所有するのは統合担当、実装を所有するのはその単位の担当者とする。P2 対象は P2 着手前、残りは各 P3 単位の実装前に凍結する。

| 統合契約 | 組み立てる意味モジュール | 単位内で一緒に確定するもの |
|---|---|---|
| I-U-E | M01 | 実行中 EEW と期限付き intent の区別。保存から active EEW を作らない |
| I-U-Q | M02・M03 | 地震・長周期の関連付け、取消、保持根拠、履歴、intent |
| I-U-T | M04 | 警報、独立した観測系列、station、取消・復元の coverage |
| I-U-N | M05 | 現況と説明報の区別、現況取消、intent |
| I-U-W | M06 | 全国 base、partial、所有現象、VPNO50 終了、履歴・watermark |
| I-U-L | M07 | 官署×type の更新・取消。他官署を消さない |
| I-U-F | M08 | subject・period・gate-only・正常 empty・容量超過 |
| I-U-B | M17 | VPOA50／VPBS50 の置換、alias、取消記憶、lifecycle |
| I-U-M | M09・M10・M18 | tornado・heat・短命情報の独立 slice と期限、intent |
| I-U-Y | M11・M12 | 解析・確率の独立 slice、identity、各取消・期限 |
| I-U-V | M14・M15・M16 | 三系列、火山 identity、取消、VFVO53 batch 終了、intent |
| I-U-R | M13 | EventID、河川・区間・station、unknown、取消・期限 |

各契約は次を一つの公開境界で定める。

- 入力の route・family・subject から、更新対象 slice と保存単位を決める対応。
- 単位全体の `UnitState／PersistedUnit／UnitView` と、唯一の codec。
- gate、意味更新、取消記憶、intent、公開 outcome の整合条件。
- 複数 subject の受理方針と、各 subject の decision。
- batch・期限・復元結果・保存 ack による遷移。
- 正常、訂正、取消、旧報、復元直後の続報、容量境界の系列。

**複数 subject の既定方針は一入力内で原子的に適用する**。一部を不正として拒否すべき入力では、残りだけを変更しない。ただし、正常な重複・旧報の subject が `unchanged` となり、他の正常 subject が変化することは拒否と同一視しない。

family に独立 subject の部分受理が必要な根拠がある場合だけ、統合契約に対象・根拠・拒否時の残存状態を明記する。部分受理でも、runtime の単位参照交換は一回、保存世代は一つとする。VFVO51 の複数火山報は、現行の全 subject 適用可否をまとめて判定する境界を保ち、暗黙の部分受理へ変更しない。

個別意味モジュールは純関数として先行検証できる。ただし単位の完了は、組立て reducer・codec・取消と復元・出力まで接続した時点とする。コードの分割を別保存単位や複数 commit の根拠にしない。§4.4 の SQLite・commit journal 不要という結論は維持する。

## 5. 一電文の経路と結果型

### 5.1 入力経路

```text
自プロセスで取込時刻・入力連番・起源を確定
  → frame／REST body の byte・外形検査
  → 有界 mailbox
  → decode・展開・全文 XML parse
  → metadata・特殊値・意味入力を確定
  → route／family／subject／保存単位を確定
  → gate
  → 対象単位の reduceUnit
  → runtime が次状態・保存対象世代・dirty 状態を一回の遷移として採用
  → 採用後の状態から表示・intent・公開 outcome を射影
  → 対象単位の非同期 checkpoint を予約
  → 非同期 checkpoint
  → 保存 ack を runtime 入力として処理
```

入力起源は `live／recovery／replay` を区別する。

- `live` は現在の購読から得た電文。自プロセスの取込時刻を受信時刻として記録する。
- `recovery` は過去状態を充足する取得。取込時刻と元報の発表・対象時刻を分け、履歴を今受信した新報として扱わない。
- `replay` は検証用入力であり、固定時計と試験 manifest を持つ。意味更新・intent 生成・射影は製品と同じ経路を通す。外部配送の無効化、試験専用保存先への書込み、実 adapter の使用は試験ごとに明示する。性能・保存・personal の検収で対象負荷を無効化した結果を製品条件の合格に使わない。

`recovery` も同じ parser・gate・意味 reducer を使うが、途中結果は §10.5 の候補状態へ適用する。各履歴報から現在向けの音・desktop intent・受信演出を作らず、途中 current を公開しない。復元結果の採用は runtime の型付き入力で行い、別の公開 mutator を作らない。

保存待ちは電文受理の完了条件にしない。直列化するのは状態遷移であり、I/O 中も次入力を扱える。I/O callback が current を直接変更することは禁止する。

`unchanged／rejected` では業務状態の参照と意味 revision を変えない。診断更新は別に許す。通知だけ・保存対象だけの変更も、変わった内容に従って結果型と世代へ反映する。

変更しない枝は参照共有する。変更判定のための全状態 clone・stringify を行わない。外部 consumer の処理はこの受理 stack で呼ばない。

### 5.2 結果型

概念型を次に固定する。

```ts
type Step<S> =
  | {
      kind: "unchanged";
      reason: "duplicate" | "stale" | "noChange";
    }
  | {
      kind: "rejected";
      reason: RejectionReason;
      diagnostic: DiagnosticRef;
    }
  | {
      kind: "changed";
      next: Readonly<S>;
      change: "semantic" | "revisionOnly" | "deliveryOnly";
      notices: readonly DisplayNotice[];
      intents: readonly NotificationIntent[];
    };

type Effective<T> =
  | {
      kind: "active";
      value: T;
      source: ReportRef;
      validUntil: number | null;
    }
  | {
      kind: "inactive";
      cause:
        | { kind: "released"; report: ReportRef }
        | { kind: "cancelled"; report: ReportRef }
        | { kind: "noActiveItems"; report: ReportRef }
        | { kind: "expired"; source: ReportRef; expiredAt: number };
    }
  | {
      kind: "unavailable";
      reason: UnavailableReason;
      source: ReportRef | null;
      lastKnown: T | null;
      affectedScope: AffectedScope;
    };
```

重要な区別:

- 正常な newer report に有効 period がない場合は `changed → inactive/noActiveItems`。watermark を残し、旧 current を除く。
- 正当な newer report の意味は確認できたが扱える容量を超える場合は `changed → unavailable`。古い current を新報として保持しない。
- identity・日時・構造を信頼できない場合は `rejected`。それを利用して watermark を進めない。
- 無変化に見える受理済み訂正でも、通知や revision 記憶が変われば `changed` だ。
- 期限切れは解除報ではない。`expired` を「解除」と表示しない。
- 起動直後の未充足状態を `inactive` にしない。
- diagnostics の更新は `rejected` でも可能だが、業務 current の更新とは区別する。

確認済みの区別: `src/engine/display/weather-warning-forecast-active-reducer.ts:62`、`test/engine/telegram-foundation/phase0-manifest.ts:58`。

### 5.3 保存の状態型

保存単位ごとに、メモリ上の世代と保存確認済み世代を分ける。

```ts
type SaveProgress = Readonly<{
  currentGeneration: number;
  savedGeneration: number | null;
  savedCapturedAt: number | null;
  savedAckAt: number | null;
  dirtySince: number | null;
}>;

type PersistenceStatus =
  | (SaveProgress & { kind: "saved" })
  | (SaveProgress & { kind: "pending" })
  | (SaveProgress & {
      kind: "failed";
      stage: SaveFailureStage;
      reason: string;
    })
  | (SaveProgress & {
      kind: "uncertain";
      attemptedGeneration: number;
    });
```

- `currentGeneration` は保存対象が変わるたびに進める。意味 revision と同一ではない。
- `savedGeneration` は §5.7 の完了を確認した世代。試行開始や rename だけでは進めない。
- `savedCapturedAt` はその世代の状態を切り出した時刻、`savedAckAt` は保存完了を確認した時刻。ack 時刻までの状態が入っていると誤認させない。
- `dirtySince` は、保存確認済み世代に含まれない最初の更新時刻。後続更新で先送りしない。
- 保存中に新しい更新が来た場合は、その試行に含まれない最初の更新時刻を一つ記録する。古い ack 後はこれを次の `dirtySince` にする。電文ごとの時刻列は保持しない。
- `saved` は保存対象について `currentGeneration === savedGeneration` のときだけ使う。

時刻は表示用の絶対時刻と、同一プロセス内の待ち時間計算用単調時刻を分けて記録する。再起動をまたいで単調時刻を比較しない。

### 5.4 Q2=B: 保存不能時

1. 受信、意味判定、最新状態への更新、画面配信を続ける。
2. 常設状態領域に「未保存」を出し、影響単位、開始時刻、最終保存時刻を確認可能にする。
3. 影響するカードにも未保存を識別できる印を付ける。
4. 原因が解消するまで、保存待ち入力列を無限にためない。単位ごとの最新 state と、書込み中の一世代だけを保持する。
5. 通知は §6 に従って継続する。未保存 intent は crash で失う可能性を明示する。
6. 復帰時は dirty 単位の**最新状態を一括して順に保存**する。受信した電文を一件ずつ再演算する意味ではない。
7. 「一括保存」は全単位の同時 commit を意味しない。保存が済んだ単位から状態を更新する。
8. 保存失敗を接続正常表示だけで覆い隠さない。

### 5.5 未保存中の取消と tombstone

保存故障中も、取消は通常と同じ reducer を通す。

- `clearCurrent` は対象 current を除き、tombstone を残す。
- `restorePrevious` は取消対象の現在報を取り除き、必要な履歴から復元する。取消記憶は維持する。
- VPNO50 の区域終了は U-W 内で記録し、全国 base・partial・取消復元を通じて終了済みの特別警報を再露出させない。
- 取消された危険情報の未配送 intent を失効／置換する。同じ変更に取消通知の intent があれば同居させる。
- 書込み中の古い世代が完了しても、取消後の current を上書きしない。その単位は最新世代が保存されるまで dirty のままだ。
- tombstone を保存する前に、古い current だけを「復旧用の正常値」として保存し直さない。
- tombstone と必要な履歴の回収は family 契約による。未保存の取消記憶を容量確保のために無言で捨てない。

保存不能が長引いて保持上限に達した場合は、当該単位を `unavailable` とし、保持できなかった範囲を示す。上限を外すこと、古い current を平常の確定状態として使い続けることは認めない。

### 5.6 再起動後に失うもの

保存済み checkpoint 以降の変更は失い得る。取消、訂正、正常 empty、通知 intent の追加・完了も含む。

journal がないため、再起動後に**実際に失った電文の完全な一覧は分からない**。推定値を実測件数として出さない。

起動時は次を行う。

1. 各単位の有効な保存世代を検証する。
2. 絶対期限を現在時刻で評価し、期限を再延長しない。
3. 保存時点以降の欠落可能区間と、復旧・照合が済んだ範囲を表示する。
4. 取消を失った可能性がある復元値は、出典・保存時刻付きの「復元した前回情報」として扱う。
5. 部分的な新報で全単位を確認済みにしない。官署・subject・系列ごとに充足を進める。
6. REST で coverage を証明できる範囲だけを再確認する。
7. 古い危険情報を表示する必要がある場合も、確認済み current の色・文言と区別する。
8. 全状態喪失を正常 empty として扱わない。

この契約は未保存取消の喪失を防ぐものではない。喪失を許容した Q1/Q2 の下で、喪失の可能性を現在情報と混同しないための契約だ。

### 5.7 原子的 JSON と成否不明

保存は次の順だ。

```text
対象単位の最新世代を encode
  → 空いている側のslot用tmpへ書く
  → file sync
  → close
  → 同一filesystem内でrename
  → directory sync
  → 世代・hash付き保存完了をruntimeへ通知
```

2スロット交互保存と tmp→rename は併用する。単一置換だけの案に対し、直前の検証可能な写しを一つ残せるためだ。世代選択は二つの envelope 内の世代とhashで行い、別 manifest は作らない。

| 位置 | 契約 |
|---|---|
| encode失敗 | 現在のメモリ状態を巻き戻さない。型／容量／保存障害を区別し、未保存またはunavailableを示す |
| write／sync／rename前失敗 | 保存成功としない。最新stateを保持して再試行する |
| rename後・ack前 | `uncertain`。保存writerの次の上書きを止め、2slotを再読込みして世代・hashを照合する |
| directory sync失敗 | 保存完了を確認できたとは扱わない。再試行・再照合する |
| 再読込みで試行世代を確認 | 必要なsyncを再確認し、保存世代を進める。メモリのより新しい世代は維持 |
| 旧世代しか確認できない | 最新メモリ世代を改めて保存する |
| 読込み結果が矛盾／未知schema | 自動合成しない。当該単位の保存を障害状態にし、メモリ上の最新表示はQ2=Bで続ける |
| 保存後にview生成失敗 | 保存を取り消さず、当該表示をunavailableにして再生成する |

起動時に新しい側が破損し古い側だけ読める場合、古い側を読み込めることと、最新状態が復旧したことは別だ。「古い世代へ退避した復旧」として欠落可能性を示す。

Pi の filesystem・媒体での停電耐性は未確認だ。rename の原子性と、電源断後に残る保証を同一視しない。


### 5.8 保存の期限・公平性・未保存区間

Q1 の「最後の未保存更新は最長 3 秒ぶん」という境界を、単に「3 秒以内に保存開始」とは定義しない。**正常な保存環境では、各 dirty 更新が最初に発生してから 3 秒以内に、その更新を含む世代の保存完了を確認する**。

この値は正常環境での受入条件であり、disk full・I/O 停止・成否不明の間にも成立する電源断保証ではない。未達時は Q2=B に従い最新表示を続け、3 秒を超える未保存区間を明示する。

保存 scheduler は既存の全体 in-flight 1 件を維持する。

1. dirty 単位は各一つの最新参照で待つ。後続更新で待ち期限を延長しない。
2. writer が空けば最も古い `dirtySince` の単位を選び、同時刻なら固定 UnitId 順とする。通知 intent の優先予約も、他単位の期限を無制限に追い越す理由にしない。
3. 選択時点の最新世代を切り出して encode する。予約時の古い state を後で保存しない。
4. `reservedAt／capturedAt／writeStartedAt／ackAt` と対象世代を記録する。受入では `ackAt - dirtySince ≤ 3,000ms` を判定する。
5. 古い世代の ack は保存進捗だけを更新する。新しい current・取消・intent を巻き戻さない。
6. dirty のまま 3 秒を超えた時点で `checkpointOverdue` を示す。接続が正常でも保存正常とは表示しない。
7. 保存失敗・成否不明の解決中も、他単位を含む期限超過をそれぞれ計数する。

保存開始を 3 秒まで遅らせる debounce は置かない。更新の合流は、writer 待ちの最新参照への置換で行う。

一試行の監視期限は暫定 10 秒とする。超過しても、停止を確認できない古い filesystem 操作と新しい書込みを重ねない。writer は占有中として扱い、保存障害を表示する。遅延 ack は世代・試行 ID を照合して処理し、成功を推測しない。

3 秒条件を通常最大負荷で満たせなければ、encode 量と I/O を減らして再測定する。単位の追加分割や journal を自動追加しない。保存正常系の境界を緩める場合は Q1 の変更として扱う。

保存開始・完了・capture の時刻差、最大未保存年齢、影響単位を §9.9 で測る。凍結担当は checkpoint 実装担当と統合担当、時期は P2 の保存契約検収前とする。


### 5.9 通常終了と保存確認

通常終了は次の順に行う。SIGINT／SIGTERM と通常の終了 command を同じ入口へ集約する。

1. **入力受付終了**：購読・新規 REST・変更 command の受付を止める。受付境界の入力連番を記録する。
2. **受理済み処理の収束**：境界までに mailbox が引き受けた待機・in-flight を処理する。受信 callback に入っただけで受付済みと呼ばない。
3. **batch 終了**：受理済み入力から残った batch・holdback を、各単位の宣言した終了入力で閉じる。VFVO53 は終了理由付きの無音 flush とし、未検証の相関を確定させない。
4. **副作用結果の固定**：通知の新規試行を止め、実行中試行を期限内で終了または無効化する。consumer の終了待ちは有界とし、未配送を記録する。以後の遅い結果が保存世代を変えない境界を確定する。この段階の終了時刻を `finalizationAt` とし、その時刻までの業務期限を適用した後、期限 timer と新たな状態変更入力を止める。以後は保存 ack と終了処理だけを扱う。`finalizationAt` より後の期限は次回起動時に評価し、最終保存対象の世代を途中で動かさない。
5. **最新 dirty 世代の保存確認**：各単位の最終世代を §5.7 で保存し、すべての対象について世代一致を確認する。通常の待ち合わせを省略して直ちに保存要求する。
6. **worker 終了**：保存結果と終了要約を記録してから worker・接続・出力を閉じる。

開始上限は、全体 30 秒、受理済み入力の収束 10 秒、batch・通知等の固定 5 秒、最終保存 10 秒、終了処理 5 秒とする。すべて単調時計で測る暫定値であり、前段の超過分を後段の上限へ足さない。統合担当が P2 の終了試験前に固定し、P3 の全単位接続後に同じ条件で確認する。

終了コードは次とする。

| code | 意味 |
|---:|---|
| 0 | 受付済み処理・batch が収束し、最終保存対象の全世代を確認 |
| 2 | 最終保存が failed／uncertain／未完了 |
| 3 | 受理済み処理または batch が期限内に収束せず、未処理が残る |
| 4 | 保存確認後の worker・adapter 終了が期限内に完了しない |

複数理由がある場合は `3 → 2 → 4` の順に終了コードを選び、要約には全理由を残す。期限超過時に exit 0 を返さない。未配送の期限内 intent は保存して再起動後の対象とし、通常終了のために全通知の成功まで待たない。

二度目の終了要求や強制終了は通常終了完了ではない。未処理件数、保存済み／最終世代、未保存範囲を可能な限り出して非正常終了する。OS の強制 kill や電源断では要約保存自体も保証しない。

## 6. 通知契約

### 6.1 基本保証

Q4 に従い、期限付き intent を発生元の保存単位に同居させ、失敗・再起動後に再試行する。

- 取りこぼしの最小化を優先する。
- 重複通知を許容する。
- exactly-once は主張しない。
- OS 通知が表示されたことや、人が音を聞いたことまでは保証しない。
- 通知失敗を理由に current を巻き戻さない。
- filter／template／CLI focus は通知条件に影響させない。

現行の通知と表示条件の分離は README にも記載される。根拠: `README.md:161`。

### 6.2 intent の最小型

```ts
interface NotificationIntent {
  id: string;
  unit: UnitId;
  subject: string;
  source: ReportRef;
  transition: NotificationTransition;
  channel: "desktop" | "sound";
  payload: NotificationPayload;
  createdAt: number;
  expiresAt: number;
  nextAttemptAt: number;
  attempts: number;
  configRevision: string;
  disposition: "pending" | "delivered" | "expired" | "superseded";
}
```

- `id` は保存単位、subject、電文識別、意味revision、遷移、channelから決定する。
- SSE seq、画面ページ、process内連番だけを id にしない。
- 同一 revision の異なる受理済み訂正を区別する。
- 意図的な再通知は、業務上の再通知機会を識別する情報を含める。
- raw XML、巨大な parsed object、formatter の可変状態を保存しない。
- desktop と sound の成否を別々に記録する。

### 6.3 試行・選択順・保存順序

1. reducer が意味変更と intent を同時に返し、runtime が同じ単位へ採用する。
2. 保存を予約するが、通知は保存完了を待たず試行できる。EEW を fsync 待ちにしない。
3. 空いた channel は、現在時刻で有効かつ `nextAttemptAt` 到達済みの intent から選ぶ。
4. **EEW を通常通知より優先**する。同じ優先群では期限が早い順、生成時刻、intent ID の順とする。
5. 試行ごとに一意の `attemptId` と AbortSignal、単調時計の timeout を与える。
6. adapter の結果は runtime 入力へ戻し、現在の intent・attemptId・期限・置換状態と照合する。
7. 有効な成功だけを delivered にし、同じ単位を dirty にする。失敗・timeout は期限内なら再試行対象とする。

通常通知を送信中に EEW が来ても、進行中の外部効果を巻き戻せるとは主張しない。新規選択は EEW 優先とし、現在の試行は channel timeout で有界にする。

intent の期限・取消・置換・試行 timeout に達したら、結果を無効化し、abort を要求して**論理 channel を解放する**。遅い成功が届いても delivered へ変えず、次の試行や intent の結果を上書きしない。

論理 channel の解放と、外部実処理の停止は別である。adapter は子プロセス終了・通信中止など、自分の実処理を閉じる責務を持つ。停止確認ができない adapter は隔離・無効化し、別の試行を同じ実処理へ重ねない。channel には新しい intent を有界に保持できるが、adapter が利用可能になるまで試行せず、期限到達で欠落を記録する。

成功は adapter が定める送信完了であり、人が見た・聞いた保証ではない。保存前の crash は intent を失い得る。送信後・delivered 保存前の crash は重複し得る。exactly-once を主張しない。

### 6.4 期限・queue・試行上限

| 項目 | 開始値・契約 |
|---|---|
| live EEW intent | 元の生成から 15 秒以内。より早い取消・失効・置換を優先 |
| その他 sound | 元の生成から 60 秒以内 |
| その他 desktop | 元の生成から 180 秒以内 |
| sound の一試行 timeout | 暫定 10 秒 |
| desktop の一試行 timeout | 暫定 5 秒 |
| 実際の試行期限 | channel timeout と intent 残存期限の短い方 |
| abort 後の停止確認猶予 | 暫定 1 秒。未確認なら adapter を隔離・無効化 |
| 再試行間隔 | 失敗確定から 1、2、4、8 秒、その後最大 10 秒。元の期限を延長しない |
| pending intent | 単位ごと最大 128 件かつ 128 KiB |
| 同時試行 | channel ごと 1 件。無効化済みでも停止未確認の実処理を別に計数 |
| 完了・失効記録 | family の重複判定に必要な期間だけ保持 |

channel timeout は adapter ごとの宣言定数とし、利用者設定を増やさない。sound の 10 秒は音の継続を途中で切りすぎない開始値、desktop の 5 秒は応答不能の待ちを EEW intent の全寿命より短くする開始値だ。P2 の通知担当が実 adapter の停止確認とともに測定し、統合担当が P2 検収前に凍結する。

満杯時は期限切れ・superseded・完了済みを先に回収し、それでも収まらなければ欠落理由・件数を記録する。通常通知の実行順が遅れて期限切れになる場合も成功扱いしない。

新報というだけで旧 intent を全削除しない。取消・解除・意味上の置換は意味モジュールが決める。recovery 履歴から新しい期限付き intent を作らない。保存済み intent の再試行には元の `createdAt／expiresAt` を使う。

### 6.5 non-durable family

EEW、一般解説、VFVO53 などは、currentを復元しなくても、期限内の未配送 intent は保存対象にする。

復元 intent を配信する場合は、保存されている出典と期限を使い、「受信済み報の通知を再試行している」ことを区別する。intent から active current を生成してはならない。

期限切れ、既知の取消、置換済み、設定上の無効化に当たる intent は再生しない。停止中・未保存中の取消を把握できない可能性は §5.6 の復旧状態として残す。

### 6.6 旧築との handoff

通常 shadow は通知・音を停止し、生成された intent の比較だけを行う。長期間の shadow intent を、切替時にまとめて再生しない。

Q4 の優先順位から、切替は短い重複窓を許す手順を推奨する。

1. 新築の追従、保存、通知 adapter、設定を確認する。
2. 切替対象となる受信時刻／電文の境界を記録する。
3. 新築の通知を有効化する。対象は境界以後と、明示した短い引継ぎ窓だけにする。
4. 旧築で `notify all:off`、続いて `sound off` を行う。
5. 両設定が反映されたことを確認する。
6. 旧築は受信・状態更新を継続する。

確認済みのコマンド: CMD:81–90、CMD:195–203。

rollback は旧側を先に有効化し、新側を止める順序を基本とする。どちらも二プロセス間の原子的な通知 handoff ではない。重複・失敗・切替窓を記録する。

## 7. 実行構成・mailbox・EEW 遅延

### 7.1 初期構成 A

| 実行場所 | 責務 |
|---|---|
| Node main | 接続、軽いcontrol frame、mailbox、HTTP/SSE、通知adapter、小さい端末出力、health |
| 常駐 engine worker一本 | decode・展開・XML parse、意味状態、reducer、期限処理、view生成、checkpoint encode |
| 非同期I/O | checkpoint、ログ、採用したexport。完了はtyped入力へ戻す |
| 開発機Chrome | 完全snapshotの受信、scene、地図・カード描画 |

worker は電文ごとに生成しない。Node の worker 数だけで全体のメモリ上限や障害隔離を保証しない。

確認済みの現行課題:

- `ws-client` は `onData` 前に normalize を行う。
- body decode は同期 gunzip/unzip を使う。
- `requireTelegramMeta` は normalize を呼び直す。
- 一部の電文では通常 tree と特殊値用 tree の二つを作る。

根拠: `src/dmdata/ws-client.ts:527`、`src/dmdata/telegram-body.ts:8`、`src/dmdata/telegram-ingress.ts:217`、`src/dmdata/telegram-parser.ts:780`。

### 7.2 入力上限と計数

| 対象 | 開始上限 |
|---|---:|
| 入力mailbox全体 | 128件かつ16 MiB |
| 通常入力の利用枠 | 120件かつ14 MiBまで |
| 残り予約 | 緊急入力・必要control用8件／2 MiB |
| workerへの通常data in-flight | 1件 |
| 単一WS frame／REST本文 | 8 MiB |
| 展開後本文 | 10 MiB |
| REST同時本文取得 | 2件。mailbox creditを使う |
| checkpoint書込み | 全体で1件in-flight、各単位に最新dirty参照 |
| mainへ送る待機snapshot | 最新1枚 |

mailbox の計数には、待機中と worker へ渡した未完了入力を含める。`postMessage` 済みだから計数から外すことはしない。

encoded frame の byte、展開後 byte、parsed state の予算は別々に記録する。queue 16 MiB はプロセス RSS の上限ではない。

最大の既存 XML は以下だ。

| fixture | 実ファイルbyte |
|---|---:|
| `15_18_01_250630_VPWS50.xml` | 4,567,490 |
| `81_09_01_260605_VPWP50.xml` | 2,268,084 |
| `76_01_01_200630_VPTA50.xml` | 1,850,328 |

既存の展開後上限は10 MiBだ。一方、現行 REST 本文取得には4 MiB上限があり、最大 XML をそのまま収められない。このため新築は入口ごとの上限を揃え、envelope化後も最大正常fixtureが通ることを P1 で確認する。

根拠: `src/dmdata/telegram-body.ts:4`、`src/dmdata/rest-client.ts:328`。

小さいframeはmainで外形を確認し、大きいdata frameはraw bytesのままworkerへ渡せる境界にする。外形JSONをどこで読む場合も、全文のJSON parseは一回とする。mainに大型XMLのdecode・normalizeを残さない。

### 7.3 queue 満杯時

1. 容量を超える入力を無制限に受け付けない。
2. 自分が所有する入力接続を停止／切断し、過負荷を表示する。
3. 最後に取り込めた入力、欠落が始まった時刻、購読範囲を記録する。
4. 待機列を排出し、低水位へ戻ってから再接続する。
5. REST補完は権限とcoverageを確認できた範囲だけにする。
6. 回復できなかった範囲を「未回復」として残す。
7. 状態型・snapshotには小さい障害表示用の予約予算を確保する。
8. 旧築の接続やqueueを操作しない。

有限queueとjournalなしで任意burstを無欠落処理する保証はない。通常の合法流量で満杯が繰り返される場合は、過負荷処理が動いたとしても検収不合格だ。

### 7.4 優先順位と決定論

- Aでは、一件処理中の大型XMLをEEWが途中で追い越すことはできない。
- 次の入力を選ぶ際には、確認済みのEEWを優先できる。
- 同一family／subjectの順序は維持する。
- 入力連番、受信順、実際の処理順を比較記録に残す。
- 異なる順序を使う検収では、そのscheduler規則も固定する。
- 全familyに「同じ集合なら順序無関係」を要求しない。

### 7.5 P2 A/B 判定用の EEW 測定プロトコル

本節を **P2 の A/B 判定前に凍結する唯一の EEW 測定プロトコル**とする。測定担当が試験 manifest を作り、統合担当が入力・時計・描画証拠・集計式を確認して凍結する。結果を見て母集団や外れ値除外を変更しない。

| 項目 | 固定条件 |
|---|---|
| 起点 T0 | main が完全な WS frame を受け取った callback の入口。decode 前の単調時刻 |
| T4 | 対象 snapshot を SSE writer へ渡した時刻。ネットワーク送信完了とは呼ばない |
| T5 | Chrome が対象 snapshot を受け取った時刻 |
| 終点 T6 | 対象 EEW のカードと必要な地図色分けが初めて同時に実 paint された時刻 |
| 対応 ID | run ID、input ID、EEW の意味 revision、snapshot の streamId／sequence を対応付ける |
| ブラウザ | 開発機 Chrome の前景 tab。版・viewport・DPR・地図資材 hash・motion 設定を固定 |
| warm-up | 各 run の最初に 100 件の固定入力を処理。測定対象と別 ID にする |
| 正式標本 | 母集団ごとに 1,000 件を 3 run。各 run と合算を報告し、各 run が合格すること |
| 分位点 | 昇順に並べた n 件の `ceil(p × n)` 番目。補間しない |
| 欠落 | 試行開始後 10 秒までに対象の実 paint がないもの。欠落 1 件でも不合格 |
| 集計 | p50／p95／p99／max、標本数、欠落数、時計不確かさ、trace 欠落数 |

母集団は混ぜず、少なくとも次を測る。

1. 平常負荷中の EEW。
2. 最大正常 XML の full parse 開始から **1ms 後を目標**に EEW frame を投入する系列。
3. 最大正常 checkpoint encode 開始直後の EEW。
4. P5 では、母集団 1〜3 を旧築＋新築＋採用 personal の最終構成で再測定する。これは P2 の A/B 判定の前提ではない。

2・3 は開始 marker と実際の T0 の差を記録する。開始後 0〜5ms に投入されたこと、かつ対象処理がまだ進行中だったことを正式標本の条件とする。投入に失敗した試行は理由付きで別記し、遅い結果を除外する口実にしない。短時間で処理が終わり条件を作れない場合は、その所要時間と投入試行を報告し、統合担当が判定前に代替条件を固定する。

大量の EEW が相互に取消・置換して実 paint の対象を消す試験にはしない。各試行は既知の初期状態から始め、対象が期限内に描かれる条件を固定する。burst・置換の正しさは別の契約系列で検証する。

**時計対応**：

- Node と Chrome の単調時計間に、開始時・終了時・実行中 30 秒ごとの往復測定を行い、対応可能な時刻区間を得る。
- 非対称な通信遅延をゼロと仮定しない。T0・T6 は一点の推定値だけでなく、対応誤差を含む区間として扱う。
- 各標本の遅延区間を `[L_i, U_i]` とし、`p99(U_i) ≤ 250ms` なら合格、`p99(L_i) > 250ms` なら不合格。それ以外は未確認とする。
- 時刻対応の区間幅は暫定 5ms 以下を正式条件とする。超える場合は計測改善が先であり、A 合格とも B 必須とも判定しない。

Chrome の描画 trace と画面記録を対応付け、T6 の証拠を残す。DOM 更新・rAF callback だけで置き換えない。保存完了・通常表示 debounce・ページ巡回を EEW の必須経路へ挟まない。

P2 は最小の実描画経路、P4/P5 は製品実装で同じ定義を使う。§7.6 の B 移行は、このプロトコルで確認した未達を根拠にする。背景 tab は別の復帰試験であり、前景性能の標本に混ぜない。

### 7.6 B: parse分離へ移る条件

次のいずれかなら、Aのまま合格にしない。

- 大型XML直後のEEW系列で p99 250msを超える。
- XML parse／checkpoint encode／重い整形が、一件で緊急目標を妨げる長さになり、その仕事を減らしても目標を満たせない。
- mailboxの通常負荷で緊急予約枠が繰り返し枯渇する。
- healthは応答しても、workerの期限処理・緊急処理が進まない。

Bでは、**大型XMLを読む専用workerを追加し、既存の状態担当workerは一つのまま**にする。

- 大型parseの完了順で、同一familyの入力順を入れ替えない。
- EEW用の軽いdecode経路を状態担当側に残す。
- 同じ電文を二つのworkerで再parseしない。
- parse待ち結果にも件数・byte上限を設ける。
- control、期限、保存ackを状態担当が処理できるようにする。
- 汎用worker poolへ拡大しない。

これは裁定済みの条件付き移行であり、P2で根拠が出た後に改めてA/Bを保留へ戻す必要はない。

### 7.7 その他の性能ゲート

試験条件・母集団・計数範囲・暫定閾値・判定式は **§9.9 の一表へ集約する**。本節と §10.6 に別の閾値表を持たない。

対象は backend 応答、最大正常入力、frontend 更新、RSS・allocation・FD・queue、checkpoint、書込み、固定 corpus の加速試験、Pi 72 時間、旧築への影響とする。

通常負荷・ピーク負荷・故障注入を混ぜて分位点を計算しない。故障時の継続動作を確認できたことと、通常負荷で性能目標を満たしたことを分ける。

EEW は §7.5 の測定プロトコルを使う。開始値を達成実績として書かず、計測不能・標本不足・条件未凍結を Pass にしない。


### 7.8 接続・処理進捗・意味鮮度の監視

「接続がある」「worker が応答する」「新しい意味状態が確認できている」を別々に示す。災害状態が変わらないことだけを凍結と判定しない。

既存の main・worker・SSE に次の有界な進捗値を持たせ、新しい監視プロセスは作らない。

| 観測対象 | 持つ値 | 故障判定・動作 |
|---|---|---|
| SSE 到達 | 最終有効 snapshot／名前付き heartbeat の受信単調時刻 | 45 秒無受信で stale、最大 15 秒周期の検査で検知。接続を閉じて最新 snapshot を再取得 |
| main→worker | 最古の未完了入力時刻、入力・完了件数、処理中 ID、次期限、最後の進捗時刻 | 未完了仕事または期限超過があり、5 秒進捗なしで stalled |
| worker 生存 | idle 時も返す小さい進捗応答 | 1 秒周期を開始値とし、5 秒応答なしで unresponsive |
| 単位の受理 | 最新候補の出典時刻、最後の decision と reason、最新受理出典・意味 revision | family の公開 revision 比較で現在より新しいと確認できる候補が `unchanged/stale` 等として採用されなかった場合は、その一件から `freshnessSuspect` と候補・現在の出典・decision reason を記録する。新旧不明は不明として示す。current を自動で書き換えず、疑いの解消は正常な後続受理または coverage 確認で行う |
| 復元・coverage | 単位／subject／系列ごとの確認済み範囲と last-known | 未充足を正常 current に昇格させない。O04 の既知凍結系列を独立して検証 |
| 保存 | §5.3・§5.8 の世代・dirty 年齢 | 3 秒超過・failed・uncertain を接続状態と別表示 |

SSE heartbeat は **名前付きイベントを 15 秒周期**で送る。EventSource から観測できないコメントだけを監視信号にしない。heartbeat は snapshot の semanticRevision・sequence を進めず、内容 snapshot の生成や scene 初期化を起こさない。最新の worker 状態・既知の最新 snapshot 版を小さく含める。

worker 停止を main が検知した場合、main は接続・処理停止の状態を配信する。現在の災害情報は「更新未確認の最終情報」として識別し、古い情報を正常な最新状態に見せない。heartbeat が届くだけで worker 正常に戻さない。

worker が進まない間は有界 mailbox と §7.3 の過負荷動作を守る。自動で state を初期化したり worker を再生成して未保存状態を捨てたりしない。回復操作は通常終了・再起動の契約に従う。復帰判定には実際の進捗と、未完了仕事・期限・coverage の再評価を必要とする。

frontend が背景から前景へ戻った際は、通常の timer 発火を待たず無受信時間を確認し、必要なら再同期する。

これらの時間は、SSE は現行の 15／45 秒を継承し、worker は暫定値とする。B05・B15 担当が P2 の停止注入前に固定する。停止のない長時間無更新、新入力なし、worker busy、heartbeat だけ継続、SSE だけ停止、worker は進むが newer 候補を採用しない系列を別々に試験する。意味的な全バグを heartbeat で検出できるとは主張しない。


### 7.9 診断ログと保持

B15 は診断を次の固定 field で出す。

`timestamp／level／component／reason／runId` を必須とし、該当時だけ `inputId／unit／generation／attemptId／durationMs／count` を加える。level は `DEBUG／INFO／WARN／ERROR` の文字列で保持し、色だけで区別しない。

本番の永続 sink は、運用環境の保持上限付きログ機構、または非同期の回転ファイルの**どちらか一つ**を使う。tmux scrollback だけを保存先にしない。新しい logger framework は必須にしない。

開始値は次のとおりとする。

- ログ配送 queue：256 件かつ 1 MiB、in-flight を含む。
- 一行：8 KiB 以下。本文を切った場合は省略理由を付ける。
- 永続保持：7 日または合計 100 MiB の早い方で回収。
- DEBUG：通常無効。性能標本は電文全文のログではなく固定 field の測定記録へ出す。

queue 満杯では DEBUG、通常 INFO を先に落とし、level 別欠落数を保持する。同じ障害を無制限に積まず、最初の一件と反復件数を記録する。ERROR でも無限保持はしない。

sink 失敗は受理を止めず、main の小さい状態表示と stderr に理由・欠落数を示す。失敗した sink 自身へ無制限に再帰ログを出さない。process 再起動を越えてログと終了要約を読めることを検証するが、電源断直前の未排出ログまでは保証しない。

token・認証 header・query の秘密値・raw XML・巨大 parsed object を通常ログへ渡さない。許可 field の射影を先に行い、例外 object の丸ごと stringify を禁止する。

B15 担当と運用担当が P2 前に形式・上限を固定し、Pi の sink と回収は P5 開始前に確認する。level、再起動後の可読性、容量回収、sink 故障、秘密値混入を契約境界として検証する。

## 8. 表示 API と display 像

### 8.1 API の境界と完全 snapshot

engine は現在有効な意味状態と表示に必要な事実を公開し、display は配置・操作・演出を所有する。zoom、hover、詳細の開閉、県フォーカス、ページ位置は engine の保存状態へ入れない。

SSE は差分列ではなく**完全 snapshot** を配信する。任意の 1 通だけで、全分野の現在の表示状態と、接続・保存・復元状態を再構成できることを契約とする。容量縮退がある場合も、過去の snapshot との合成を要求しない。「完全」は全詳細を必ず同梱する意味ではなく、詳細の省略範囲と取得先を含む現在表示の完全性を指す。

```ts
type DisplayVersion = Readonly<{
  streamId: string;
  semanticRevision: string;
  sequence: number;
}>;

type DisplaySnapshot = Readonly<{
  schemaVersion: number;
  streamId: string;
  sequence: number;
  generatedAt: string;
  semanticRevision: string;
  connection: ConnectionView;
  persistence: PersistenceView;
  recovery: RecoveryView;
  current: CurrentDisplayView;
  notices: readonly VisibleNotice[];
}>;
```

`CurrentDisplayView` は固定した分野 ID ごとに、意味状態と配送状態を別々に持つ。

- 意味状態は `active／inactive／unavailable`。容量縮退を意味上の取消・失効・`unavailable` へ変換しない。
- 配送状態は `full／summary`。`summary` の理由は `snapshotBudget` とし、分野 ID、元の byte 数、適用予算、版付き詳細取得の参照を付ける。
- `full` は安定した事象・カード ID、情報種別、更新時刻、出典、復元状態、区域コードと体系、数値・時刻・件数・代表地名、有界な詳細、EEW 予想震度区域、津波予報区・警報区分、有効期限を含む。
- `summary` は、現在有効な情報種別ごとの**情報種別・最上階級・対象区域数・時刻**を含む。件数は区域体系内の重複を除いた数とし、異なる体系の同一性を推測しない。時刻はその要約を構成する意味更新の最新時刻であり、snapshot 生成時刻で代用しない。階級や時刻が未提供なら型付きの不明値を使う。
- 要約の最上階級は、その情報種別の意味上の最大値とする。個々の数値・区域一覧を要約から推定しない。
- 取消後に有効情報がなくなった分野は `inactive` と空の有効項目を送る。以前の要約を残さない。

容量縮退した分野は、見出し帯相当の最小事実と「詳細は個別取得」「地図の対象範囲は省略中」を表示する。区域一覧を持たない場合、古い地図塗りを最新として残さず、当該分野の描画を外す。他分野の地図・カード・取消反映を継続し、分野別の省略表示を常に残す。ページ送りでカードが見えない状態とは区別する。

U-E／U-T の容量縮退中も、緊急表示モード、EEW 宣言高、津波の左列、全体図固定、大津波警報に対応する「今すぐ避難！」は最小事実から維持する。未取得の区域別値・geometry は描かず、省略中を示す。通常の全区域描画・予報区別内容の受入は full 時に適用し、summary 時は最小事実・緊急配置・省略表示・詳細到達を検証する。容量縮退を理由に緊急表示を解除しない。

個別取得は次を契約とする。HTTP の経路名と開始値は仕様案だ。

1. `GET /api/display/domains/{domainId}/detail` に `streamId`、`semanticRevision`、`sequence`、ページ番号を渡す。任意 URL を snapshot に埋め込まず、既知の API と分野 ID から参照する。
2. 応答には要求した版と分野 ID、ページ番号・ページ数を返す。一つの応答へ異なる版の内容を混ぜない。
3. 要求・応答には streamId、semanticRevision、sequence を保持する。詳細の有効性は、対象分野の公開内容の版でも照合する。他分野・接続・保存 metadata だけの更新では対象詳細を無効化しない。対象分野の内容版が変わった場合だけ `409 versionChanged` とし、旧版保存庫は作らない。
4. 応答は実際に参照した snapshot の版と対象分野の内容版を返す。client は対象分野の内容版と streamId が現在値と一致する場合だけ採用する。対象の取消・失効・内容変更・streamId 変更で取得結果を無効化する。
5. 版不一致・通信失敗時は最小事実を残し、「更新済み・詳細再取得」または取得失敗を表示する。無制限の自動再試行はせず、再取得操作は最新の版を使う。
6. 詳細も有界とし、宣言した行・項目境界でページ分割する。1 応答の JSON は開始値 64 KiB 以下。単一項目が上限内に表現できない場合は、該当項目と理由を明示して未取得とし、途中切断した JSON や不完全な正常値を返さない。通常合法 corpus でこの状態が出る設計は受入不可とする。
7. client は現在開いている詳細の現在ページだけを保持し、in-flight は 1 件。server も同一 client の取得を直列化し、通常の snapshot 配送を詳細取得の完了待ちにしない。詳細経路は既存 display API と同じ認証境界に置く。取得の待機上限は §8.6.4 に従う。

SVG path、DOM 寸法、HTML、CSS class、投影後の画面座標、生 XML、engine の mutable object、checkpoint 全体を wire 型へ入れない。

カード表示は現在有効な情報から決める。「津波なし」「台風なし」の空カードは作らない。`unavailable`・未保存・復元不確実性・配送縮退を「何も発令されていない」に読み替えず、状態表示として明示する。

### 8.2 意味更新・metadata 更新・scene の分離

snapshot の置換と scene の更新を分離する。

| 入力 | 更新するもの | 維持するもの |
|---|---|---|
| 現在の意味状態が変わった | 対象カード・区域・件数・詳細内容 | 無関係な対象の手動選択。配置変更は必要な範囲だけ |
| 新しい表示対象の受信通知 | §8.6 の受信演出 | 無関係なページ・scene。手動状態は同節の調停に従う |
| 接続・保存・復元 metadata だけの変化 | 状態表示と snapshot の版 | camera、hover、詳細の開閉と開いている詳細の内容、県フォーカス、ページ停止状態 |
| 同じ受信項目を含む次の snapshot | 最新内容 | 同じ受信演出を再起動しない |
| 対象の取消・失効 | 対象表示と依存する詳細・線・取得要求を除去 | 他事象の意味状態 |
| `full／summary` の切替 | 当該分野の表示・地図省略状態・詳細参照 | 他分野と障害表示 |
| viewport・緊急表示モードの変化 | 宣言値による矩形・ページ範囲 | engine current。手動ページ停止は維持する |

表示中の通知項目には安定 ID と期限を付ける。新旧 snapshot の ID 比較で新着を識別し、毎回フラッシュし直さない。

初回接続・再接続の既存項目を新規受信として一斉演出しない。現在情報を即表示し、その後の新しい項目から演出する。復元表示は維持する。

個別取得した詳細は対象分野の公開内容の版に束縛する。対象内容または streamId が変われば、開閉状態を保ったまま再取得が必要な状態にする。保存・接続 metadata や他分野だけの更新では詳細内容を維持する。これは scene の全初期化や自動再取得を意味しない。対象分野の内容版は §12.2 の保存世代と混同せず、表示内容の変更判定から得る。

scene の時計は明示的に渡す。周期フォーカス用 timer は作らない。ページ送りの timer は §8.5.5 に限定し、時計表示の更新だけで全カード・地図を再構築しない。

### 8.3 SSE・容量縮退・slow client

**裁定済み**：完全 snapshot が 1 MiB を超える場合、超過分野だけを §8.1 の最小事実へ縮退し、他分野と接続・保存・復元状態の完全配送を続ける。snapshot 超過を理由に SSE 全体を切断しない。

次の容量配分は、この保証を実装可能にする**開始仕様案**とする。

| 項目 | 契約 |
|---|---|
| 完全 snapshot | シリアライズ後の JSON 本体を UTF-8 で計数し、1,048,576 byte 以下。SSE framing は別計数 |
| 分野境界 | §4.2 の 12 保存単位に対応する固定の表示分野。保存内容そのものは送らない |
| 分野の基準予算 | 各 64 KiB、計 768 KiB。分野の wrapper を含める |
| 分野の要約 | 各 4 KiB 以下、基準予算の内数。情報種別ごとの最小事実と縮退診断を含める |
| 表示中通知項目 | §8.4 の 128 KiB 以下 |
| 共通状態・構造 | 接続・保存・復元状態、版、JSON の共通構造に 64 KiB を予約 |
| 残余 | 64 KiB を容量余裕とする。内容の無断追加枠にはしない |
| 同時 display client | 最大 8 接続 |
| engine→HTTP 側 | 最新 snapshot 1 個。未配送の旧版を蓄積しない |
| client ごとの送信待ち | 最新 1 個。未送信の旧版は置き換える |
| backpressure | `write()` の結果と `drain` を扱い、無制限に書き込まない |
| slow client | 排出できない状態が 5 秒続けば切断する |
| 再接続 | その時点の完全 snapshot。差分再送や履歴再生はしない |
| schema 不一致 | 非対応を明示し、未知の payload を正常表示しない |

生成手順を固定する。

1. 分野ごとに full view の byte 数を得る。総量が 1 MiB 以下なら、全分野を full で送る。
2. 総量が超過した場合、基準予算を超えた分野だけを summary にする。予算内の分野は内容を変えない。
3. 分野別予算と共通予約の合計によって、縮退後の全体が必ず 1 MiB 以下になることを schema の最大値テストで確認する。
4. summary にも全情報種別の最小事実が収まることを保証する。文字列長・項目数・診断表現を型と境界検査で有界にし、自由文の蓄積に予約領域を使わない。
5. 次の意味更新で全体が上限内へ戻れば full に復帰する。復帰のための周期 timer、履歴、容量探索用の全状態 clone は作らない。

基準予算は engine の受理上限・保存上限ではない。超過で意味状態を捨てない。初期の均等配分は単純な開始案であり、変更する場合は分野ごとの値・総和・合法 corpus の結果を同時に更新する。

共通状態と最小事実だけで予約容量を超える schema は設計不合格とする。未知の拡張 field を無制限に通したり、障害表示を削って正常配送と扱ったりしない。

遅い client・個別詳細取得・一分野の容量超過は、受信・reducer・通知・他 client の待ち合わせ条件にしない。snapshot 全体の再送も、全 DOM の再 mount を意味しない。

### 8.4 表示中の通知項目と通知契約の区別

`VisibleNotice` は、現在表示できる有期限の項目だ。音・desktop 通知の配送を担う §6 の intent とは別の view であり、display が intent の完了を記録しない。

開始上限は **64 項目・合計 128 KiB** とする仕様案だ。期限切れを除去し、容量超過は診断へ出す。任意の古い snapshot を保存して通知履歴を増殖させない。

SSE の中間 snapshot が置き換わっても、まだ有効な通知項目は次の完全 snapshot に含める。ただし、切断中に期限が切れた全演出の再現までは保証しない。Q4 の取りこぼし最小化は engine の有期限 intent と再試行で扱い、フラッシュの再生を通知配送保証と混同しない。

未保存・復元不確実性・GIS 未対応は災害の空カードにせず、意味の異なる状態表示として提示する。

### 8.5 全体配置・器・概要表示

#### 8.5.1 地図とカードの配置・重大度

**製品要件上確定**：

- 地図を主領域全面に敷き、左右カード列との間に地図を切る境界を作らない。
- カードは半透明とし、裏の地図を薄く見せながら文字の可読性を保つ。
- 発令中・現在有効な情報だけを表示する。固定なのは宣言寸法であり、空のカテゴリ枠や固定数のカード枠ではない。
- ヘッダは表示モード・接続状態だけとする。保存・復元・縮退の状態表示にも常時到達できる場所を確保する。
- 時計は右下、地図の上、右カード列の下端に置き、列の高さ計算で先に予約する。
- 平常時の地図は、現在有効な情報を重ね、**同じ場所では最も重大な状態の色を採る**。
- 重大度の色トークンを地図の塗りとカードの縁取りで共有する。カードの見出し三組も同じ意味トークンから導く。

直近の地震は意味モジュールが定める掲載期間内の情報を対象とし、警報の有無だけで消さない。

異なる災害の重なりを描画順に任せない。P4 の hazard 契約で、全表示種別・階級から比較可能な `displayRank` と色トークンへの対応表を固定する。これは表示優先度であり、異種の観測数値を同じ物理量に変換するものではない。対応漏れを暗黙の最低順位に落とさない。

**同順位の開始仕様案**は、情報種別の固定順、安定した事象 ID の辞書順とする。地図の塗り・カードの重大度順・区域 hover の代表相手で同じ順を使い、受信順や DOM 順で結果を変えない。取消後は残る有効状態から最大値を選び直す。

異なる区域体系が重なる場合は、コード対応と検証済み geometry に基づいて重なりを扱う。一部区域の警戒を根拠なく県全域へ拡張しない。細分区域の最大値を県の概要色へ集約する場合は、県内最大値の要約表示であることを凡例に示し、拡大図では元の対象範囲を維持する。

EEW 中の陸は予想震度表示を優先し、津波は独立した海岸線層へ描く。hover 境界は強調用の別層であり、重大度の色を別の意味へ置き換えない。容量縮退分野の地理情報が省略されている場合は §8.1 に従い、その範囲の完全表示を主張しない。

#### 8.5.2 器の割当表

器は 4 種、見出しは帯 1 本 48px とする。以下の全種別への割当と通常の基準高は **Q5-a の推奨案**であり、P4 前に割当を完結させる。

| 器 | 概要時の高さ・表示 | 割当の推奨 |
|---|---|---|
| 通常 | 基準 214px。§8.5.3 の概要事実を表示 | 特別警報、警報級、氾濫危険、火山 L3、台風 |
| 見出し | 48px、本文なし、帯 1 本。最上階級の見出しを 1 行、右端に時刻 | 火山 L2、氾濫警戒、記録的短時間大雨、南海トラフ調査中。片側集約時は直近の地震も |
| 伸縮 | 他の器・予約領域を引いた残り高さから表示行数を計算 | 直近の地震 |
| テロップ | 下段の宣言高に情報種別チップと要点を表示 | 熱中症警戒アラート、竜巻注意情報 |

未記載の種別・警戒段階・状態を暗黙に通常へ割り当てない。詳細高さは器の概要高さと別に、情報種別ごとの宣言値を持つ。見出しを本文付きへ戻して高さを増やすことはしない。

伸縮は、列の利用可能高から他の器・gap・時計・ページ操作領域を引き、見出し高・行高・footer 高から表示件数を算術で決める。残る地震項目もページ対象とし、件数要約だけで到達不能にしない。

モックの多発令例は入力上の確認情報であり、この checkout の合格実績ではない。P4 で事象 ID・件数・viewport を明示した fixture に置き換える。旧モックで件数要約に隠れていた対象を「全件表示済み」に数えず、全件が収まらなければページ送りを使う。

#### 8.5.3 器ごとの必須情報

次の表は通常・伸縮・テロップに載せる事実と、見出しから開いた詳細に必ず残す事実を定める。電文にない値は補わず、未提供・不明・未確認を区別する。

| 情報 | 通常・伸縮・テロップの必須事実／詳細で保持する事実 |
|---|---|
| 気象 | 警報の種別と対象区域、注意報の件数と種別 |
| 記録的短時間大雨などの速報 | 雨量と発表官署 |
| 地震 | 発生時刻、規模・震度の提供値、津波の有無・評価。未確認を「なし」にしない |
| 火山 | 最新噴火と警戒範囲。噴火情報なし・未提供を区別 |
| 洪水 | 河川・対象範囲・警戒段階。観測値不明を正常値にしない |
| 台風 | 台風の識別、解析時刻、中心・勢力など提供された現在情報。解析と確率の出典時刻を分ける |
| 熱中症 | 情報種別、対象地域・対象日、提供された指数。指数未提供なら未提供と表示 |
| 竜巻 | 情報種別、対象区域、発表時刻・有効期限 |
| 南海トラフ | 調査・評価の区分、発表時刻、提供された要点 |

**48px 見出しは上表の全事実を帯へ詰め込む対象外**とする。後日の帯 1 本裁定を優先し、情報種別・最上階級・識別に必要な地域または事象名を 1 行にまとめ、右端は時刻だけとする。下位階級の列挙や概要本文は付けない。省いた上表の事実はクリック詳細で取得・表示できなければならない。

例は「大雨特別警報 宮崎県」「線状降水帯 発生 宮崎県」「桜島 警戒レベル3」「レベル4 氾濫危険情報 鹿児島県 川内川」「日向灘 M7.1 震度6弱」とする。長い正式名称は詳細で確認できるようにし、意味の異なる状態へ略記しない。

容量縮退の見出しは別契約であり、§8.1 の情報種別・最上階級・区域数・時刻を表示する。未取得の区域名・雨量等を、通常の見出し生成のために推測しない。

#### 8.5.4 見出し契約

現行の `standby-card-header` を継承する。

- 色は `container／on／band` の三組で指定する。
- 見出し下辺に基準 4px の帯を置き、外殻の角丸で clip する。
- title と付随 metadata を分離する。
- 縦リボンは使わない。
- 詳細 overlay でも同じ意味色を保つ。

地図の塗り・カードの縁取り・見出し三組は共通の意味トークンを参照する。可読性のための派生色は許すが、component ごとに独立した重大度色表を持たない。

現行 CSS の下辺は `--header-band-width` の基準 4px に `panel-scale` を掛ける。基準値と実ピクセル幅を混同しない。根拠は `display/frontend/src/lib/theme.css:99`、同 `:282`、`docs/specs/2026-08-28-standby-card-header-unification.md:45`。

#### 8.5.5 あふれ・ページドット・手動操作

**裁定済み**：通常時・片側集約・EEW と大津波警報の同時発生のいずれでも、器に収まらない対象はページ送りにする。件数だけの要約へ畳んで対象を隠す方式は採用しない。ページごとのドットを置き、クリックでそのページへ切り替えられるようにする。

ページ送りはカードやテロップの表示範囲だけを変える。camera・県フォーカス・詳細を周期的に巡回させない。ページ外のカードに対応する有効な地図情報も消さない。容量縮退による地理情報省略だけは §8.1 に従う。

ページ構成は次の開始仕様案とする。

1. 対象を §8.5.1 の重大度順に整列し、同順位は固定順で決める。
2. 宣言寸法で一画面へ収まるかを判定する。収まらない場合だけ、ページドットの宣言領域を予約して順に分割する。候補 DOM や収束探索を使わない。
3. 各対象はその表示面のいずれかのページに存在する。伸縮リスト・テロップ・大カード内の一覧・詳細内の一覧も、あふれをページ分割する場合は同じドット操作に従う。
4. ドットにはページ番号の accessible name と現在ページ状態を付け、keyboard でも選択可能にする。ドットを省略して到達不能なページを作らない。必要な行数・予約高を profile で宣言し、最大対象数でも操作領域が収まることを検証する。
5. 内容更新では、現在ページの先頭の安定 ID を含むページを維持する。先頭が消えた場合は旧ページ番号を新しい範囲へ clamp する。metadata 更新ではページを変えない。
6. ページ数が 1 になれば timer を解除する。再び複数になっても、手動停止中なら停止を維持する。

**手動と自動の調停案**：ドット選択後は、その表示面の自動送りを停止し、「自動送りを再開」操作まで再開しない。一定時間で勝手に再開する timeout は作らない。手動詳細を開いた表示面も同様に停止する。再開操作は現在ページから新しい滞在時間を開始し、古い timer は世代照合で無効にする。ドット選択と timer が同時なら手動選択を優先する。

ページ変更時は旧ページに属する通常の詳細 overlay と受信演出を終了する。手動停止中は新着電文による自動ページ移動を行わない。EEW・津波の大カード出現はページ送りとは別に即反映し、表示モード変更後も手動停止を引き継ぐ。

自動送りの一巡上限は **Q5-b の推奨 60 秒、P4 前裁定**のまま保留する。採用時には全ページ数と各滞在時間の総和で一巡時間を検証する。手動停止中・手動詳細中の時間は自動一巡の保証対象外と明示する。最小読取時間と一巡上限が両立しない最大件数は、黙って高速送りせず Q5-b の裁定材料に含める。

### 8.6 ホバー・クリック・詳細 overlay・受信演出

#### 8.6.1 ホバーは「指す」

カードまたは区域へマウスを重ねた間だけ、対応関係を示す。

- 対応相手を縁取りし、カードから代表区域への線を最大 1 本表示する。
- 区域 hover の名札には**区域名と現在の状態**を表示する。
- 対象区域境界を地理・災害描画の最前面で強調する。
- カード高さ・列内位置・詳細開閉・ページ位置・camera を変えない。

複数の有効状態が同じ区域に対応する場合、名札の代表状態と線の相手は §8.5.1 の最大重大度・固定同順位規則で選ぶ。他の状態を「存在しない」とは表示せず、全状態は詳細から確認可能にする。

対応カードがページ外なら自動ページ移動せず、区域名札と境界を表示し、実在しないカードへの線は引かない。容量縮退で区域対応を取得できていなければ、省略中を明示して推測の線を引かない。

hover と受信演出が競合した場合は hover の線を優先する仕様案とし、合計最大 1 本を守る。hover・受信演出のない平常時と手動詳細表示中は線を出し続けない。

#### 8.6.2 クリックは「開く」

- カードをクリックすると詳細を開く。容量縮退カードでは版付き個別取得を開始し、取得待ち・失敗・版不一致を表示する。
- 同じカードの再クリック、または地図の何もない所のクリックで閉じる。
- 県クリックは県フォーカスの操作とし、同じ click をカード開閉へ二重処理しない。
- 手動詳細には受信演出の 6 秒 timeout を適用しない。
- 対象の取消・失効時は詳細・取得要求・依存する線を終了する。

同時に手動で開く通常の詳細は 1 枚を開始案とする。別カードを開けば前を閉じる。EEW・津波の大カードの存在数とは別に扱う。手動詳細を開いた表示面の自動ページ送りは §8.5.5 に従って停止する。

#### 8.6.3 詳細は列を押し動かさない

詳細は元カードの位置に重ね、周囲カードの並びと概要矩形を維持する。

- 境界を影と縁取りで立たせ、下に隠れるカードを減光する。
- 下端を超える場合だけ上へずらす。
- 高さは器・情報種別ごとの宣言値を使い、重なりも宣言矩形で計算する。
- DOM 計測を使わない。
- 右列の下端は時計予約領域より上とし、ページ操作領域も覆わない。
- 同時発生時の他カード詳細は、EEW 大カードを除いた右列残余内へ重ねる。緊急大カードを隠さない。

詳細高さを `H`、元カード上端を `Y`、その表示面の下端を `B` とした場合、上端は原則 `min(Y, B - H)` とする。`H` が表示面の利用可能高を超える profile は不正とし、宣言高に収まる内部分割とページドットで解決する。画面外にはみ出した結果を測って収束させない。

#### 8.6.4 受信演出と camera の所有

通常の受信演出は、対象区域のフラッシュ、許可された camera 遷移、担当カードの自動詳細、終了の順とする。保持時間の初期値は **6 秒**、起点は詳細を実際に表示した時点とする。個別取得待ちだけの表示を起点にしない。

自動詳細を省略する場合は、宣言したフラッシュの終了で当該演出を終了する。個別取得の待機上限は暫定 5 秒とし、失敗・版不一致・timeout では取得待ちを終了し、その演出が所有する camera だけを復帰させる。手動詳細では取得失敗表示と再取得操作を残す。待機中のまま通常演出の実行枠を占有し続けない。

演出の詳細・camera・ページを一括して所有したことにしない。各操作について、その演出が開始時に取得した所有だけを終了時に戻す。

| 開始時の状態 | 通常受信時の camera | 演出終了時 |
|---|---|---|
| 津波の全体図固定中 | zoom しない | 全体図固定を維持 |
| 県フォーカス、手動 wheel・drag による camera | 変更しない | 手動 camera を維持 |
| EEW camera 中 | 通常受信では変更しない | EEW の規則を維持 |
| 手動所有のない通常全体図 | 対象区域へ zoom | 所有を保っている場合だけ全体図へ戻す |

フラッシュは現在 camera 内で可能な範囲に行い、画面外の対象へ自動で寄ることを手動状態維持の例外にしない。手動詳細を開いている場合は自動詳細で置き換えない。対象カードがページ外の場合、手動停止中はページを動かさず演出を省略する。自動送り中に対象ページへ移る場合も、camera や県フォーカスをページ遷移へ連動させない。

演出中に drag・wheel・県選択・手動詳細・ページ選択があれば、該当する自動所有を失わせる。古い timeout は演出 ID と所有の世代を照合し、新しい手動状態を閉じたり戻したりしない。drag 開始後は自動で全体図へ戻さず、明示的な全体図操作を待つ。

通常受信の演出候補は「実行中 1 件＋最新候補 1 件」を開始案とする。省略対象は演出だけであり、意味更新・カード・通知 intent を省略しない。EEW は通常受信演出に優先するが、津波の全体図固定を破らない。

### 8.7 EEW と津波

#### 8.7.1 EEW

- EEW は右列に大カードを表示する。
- 地図を主役に保ち、陸を予想震度で色分けする。
- 揺れの到達時間・猶予秒・countdown をカードに載せない。
- 津波表示がない場合、EEW 受信時は予想最大震度 3 以上の区域が全部入る bounds へ zoom する。
- bounds は代表点ではなく全対象 geometry から計算する。欠損区域を除外して「全部入った」と判定しない。
- 不明・範囲値は意味型の規則を使う。文字列比較や不明値の 0 扱いで対象から落とさない。
- EEW の current・取消・期限は engine が所有し、演出終了を解除と同一視しない。

EEW の camera 割込みは、通常受信より優先する。既存の手動 camera を一時退避して EEW bounds を示し、EEW 終了後に退避状態へ戻すことを**開始仕様案**とする。EEW 中に新たな手動 camera 操作を行った場合はその操作を保持し、古い復帰処理で戻さない。津波表示中はこの割込みを行わず全体図を維持する。

#### 8.7.2 津波

以下は裁定済みであり、未裁定の叩き台として扱わない。

1. **T1＝A**：津波情報でも地図主役を維持し、別の緊急画面へ切り替えない。左列を津波の大カードにする。
2. **T2**：海岸線は大津波警報だけを点滅させ、津波警報は赤・静止、津波注意報は黄・静止とする。大津波の紫 6px と正規予報区 GIS の島保持は開始案として P4 で検証する。
3. **T3＝A**：津波表示中は zoom なし、全体図固定。EEW 同時でも維持し、陸は予想震度、海岸線は津波を描く。
4. 大津波警報の直下の避難指示帯は**「今すぐ避難！」**。テロップの避難文言も一致させる。カード内の意匠は P4 で検証する。
5. 津波単独では他カードを右列へ寄せる。EEW 単独では鏡像として左列へ寄せる。容量超過を件数要約へ畳まず、ページ送りとドットで扱う。

津波大カードには予報区ごとの予想高さ・到達予想時刻・観測値・警報／注意報区分を載せる。予想と観測、到達予想と観測時刻を混同せず、未提供値を計算して埋めない。一覧が宣言高を超える場合はカード内をページ分割する。

海岸線表示と hover／受信時のカードからの線は別物であり、引き出し線を常時増やさない。

モックの県輪郭由来の海岸線を正規津波予報区 GIS として採用しない。予報区コード・範囲・島・複数区間に対応する資材を用意する。現行 `display/maps/quake/source.lock.json:11`、同 `:44` の入力に津波予報区 GIS は含まれない。

#### 8.7.3 片側集約と同時発生

**片側集約**では、反対側へ寄せたカードをいったんすべて 48px の見出しにし、同じページ内の空きが許す限り重大度上位から本来の通常カードへ戻す。直近の地震は集約中は見出しのままとする。通常カード化のために新しいページを増やさない。

見出しでも収まらない場合は先に全対象をページ分割し、各ページの残余で昇格を計算する。取消等で空きが増えれば同じ算術で自動昇格する。重大度・同順位・現在ページ維持は §8.5 に従う。テロップに割り当てられた情報は下段に残し、そのあふれもページ送りする。

**EEW と大津波警報の同時発生は F08=A**：

- 左列に津波大カードを置く。
- 右列上部に EEW 大カードを置き、その高さ `H_EEW` は採用 profile の宣言値で固定する。
- 時計・余白・gap・ページドットを予約した右列の残余に、他カードを**48px の見出しだけで重大度順**に並べる。同時発生中は通常カードへ昇格させない。
- 残余に入らない対象はページ送りし、すべてのページをドットで選択可能にする。
- EEW・津波大カード自体を他カードのページと一緒に消さない。
- 陸は予想震度、海岸線は津波、camera は全体図固定を維持する。

右列全高を `H_R`、時計等の固定予約を `R`、大カードとの gap を `G`、ページ操作の予約を `P` とすると、他カードの利用可能高は `H_R - R - H_EEW - G - P` とする。見出し間 gap を含めて収納数を求め、DOM で高さを測らない。

`H_EEW` の具体値・対応 viewport・最小残余は N17 で固定する。対応 viewport では少なくとも見出し 1 本とそのページ操作が収まることを profile の受入条件とする。残余 0 の profile を採用し、対象を不可視にする実装は認めない。

単独→同時→単独の遷移ごとに有効対象から配置を再計算する。手動ページ停止は引き継ぎ、対象取消は現在ページ外でも即反映する。容量縮退中の分野は最小事実の帯として同じ到達規則に従う。snapshot の容量縮退と画面の見出し化は別の状態である。

### 8.8 2 層地図・県フォーカス・操作・描画品質

#### 8.8.1 地理的な 2 層

| 層 | 表示・操作 |
|---|---|
| 全体図 | 都道府県単位の輪郭で日本を表示 |
| 拡大図 | 市区町村等の区域を表示。県 click または wheel で拡大し、drag で移動 |

これは地理形状の粒度であり、気象・予想震度・津波・火山・洪水の意味層を 2 種へ制限しない。

既存の `area-information-city-quake.v1.json` を出発資材とする。1,892 は区域コード数であり、行政上の自治体数と同一だとは主張しない。

#### 8.8.2 県フォーカスと camera 調停

県クリックによる拡大では、その県を `focusedPrefecture` として保持し、周囲の県と他県の市区町村を dim し、対象県の縁を太く最前面で強調する。選択範囲外の click で県フォーカスを解除し、全体図へ戻す。

wheel 拡大だけでは特定県を選択しない。wheel で拡大した後の市区町村 click は、その所属県をフォーカスする。所属は検証済み対応表から得る。

地図の空白 click が詳細を閉じる条件と県フォーカス解除の両方を満たす場合は両方を閉じる。drag 終了を click と誤認しない。「全体図へ戻る」操作を提供し、手動 camera と県フォーカスを明示的に解除できるようにする。

手動 camera の保持は、受信演出が始まる前から存在した操作にも適用する。県フォーカス中・手動 pan／wheel 後は、通常電文の到着やその timeout で zoom・全体図復帰をしない。

津波の全体図固定を守るため、**津波表示中は camera を変える県選択・wheel・drag を停止し、hover・名札・カード詳細は使用可能とする開始仕様案**を採る。固定理由を表示する。津波開始前の手動 camera は一つだけ退避し、津波終了時に復帰する。復帰先が不正なら全体図に戻して理由を示す。EEW が継続していれば EEW の camera 規則を適用する。

camera の適用優先順位は、津波全体図固定、津波なしの EEW 割込み、手動 camera、通常受信の自動 camera とする。タイマーは自分が取得した所有だけを解放する。

wheel の層切替閾値・zoom 上下限・drag 範囲・離島 inset は固定値として宣言し、境界 fixture を持つ。

#### 8.8.3 高速できれいな地図

現行の 0.1% 間引き資材を拡大するだけで合格にしない。

- 全体図用と zoom 用で異なる細かさの資材を build する。
- 共有境界、島、細い地形、県境・市区町村境の連続性を検証する。
- zoom 用は粗い path の再加工ではなく、十分な精度の元 GIS から生成する。
- SVG を初期比較対象とし、必要な場合だけ Canvas／WebGL を比較する。
- renderer や LOD を変えても区域 ID、重大度の結果、色トークン、hit test、名札、hover 境界、代表点を変えない。

P4 の開発機 Chrome における開始性能目標は次の仕様案とする。

| 計測 | 開始目標 |
|---|---|
| 資材読込済みの層切替要求→市区町村層の実 paint | p99 ≤ 250ms |
| drag／wheel 中のフレーム時間 | p95 ≤ 16.7ms、p99 ≤ 33.3ms |
| EEW 受信→実表示 | §7 の p99 250ms |
| 初回読込 | 資材転送・decode・初回 paint を分離して報告 |

最大値・標本数・viewport・DPR・zoom・端末・Chrome 版を併記する。DOM 更新完了や rAF callback だけを実 paint の証拠にしない。

最終端末は未定であり、検収はまず開発機 Chrome とする。§15.4 の端末条件を変更しない。測定定義は §7.5・§9.9 に従う。本節の開始値だけで解決済みとしない。

### 8.9 現行 GIS 資材の確認結果と再生成要件

| 現物 | 確認済みの内容 | 新築での扱い |
|---|---|---|
| `source.lock.json` の投影 | JGD2011、EPSG:6668。元 archive に `.prj` がないことを明示 | 宣言・座標範囲・control point の検証を維持する |
| `AreaForecastLocalE` | 3 桁 code、期待 188 コード | 県対応表を介して dissolve し、全体図の県輪郭を生成する |
| `AreaInformationCity_quake` | 7 桁 `regioncode`、期待 1,892 コード | 市区町村層の対応元にする |
| 現行 build | mapshaper の `-simplify 0.1% keep-shapes` を使用 | 全層共通の固定値をやめ、層ごとの build profile を持つ |
| 名称 | 加工途中で `name` を保持するが、生成物は code 別 path を中心とする | 名札用の区域名テーブルを明示的な生成物へ追加する |
| mapshaper | display の依存に含まれる | 使用版・コマンド・入力 hash・出力 hash を再現可能に固定する |

根拠：`display/maps/quake/source.lock.json:5`、同 `:13`、同 `:44`、`display/scripts/build-quake-map-assets.mjs:157`、同 `:486`、`display/package.json:24`。

都道府県の独立した輪郭資材は、この lock の入力にはない。細分区域から 47 県を生成できたというモック結果は**ご主人からの確認情報**であり、今回この checkout で生成・検証した結果ではない。

dissolve は、検証済みの細分区域→都道府県対応表で行う。名前の部分一致やコード先頭の推測だけで県を割り当てない。生成物は次を分離する。

- 全体図用の都道府県 geometry。
- zoom 用の市区町村等 geometry。
- 意味区域から geometry への対応表。
- 区域名、都道府県との所属対応。
- bounds、名札位置、引き出し線の代表点。
- 元資料・変換手順・除外区域・hash を記した manifest。

代表点は単純な重心が海上や区域外に出る場合を扱う。複数島・飛び地では、全体 bounds とラベル・線の代表点を同一視しない。

### 8.10 GIS 拡張・LOD・区域名の受入要件

| 対象 | 必要な資材・対応 | 禁止する代用 |
|---|---|---|
| 気象警報 | 電文の区域体系に対応する polygon、行政階層、コード表 | 地震用コードとの名前一致だけによる対応 |
| 津波 | 津波予報区コードに対応する海岸線・範囲、区間境界、島の扱い | 県輪郭から抽出した海岸線を正規の予報区線とすること |
| 火山 | 火山の位置、提供される警戒範囲との対応 | 電文にない警戒半径を独自計算して描くこと |
| 洪水 | 河川・区間・観測点・対象範囲の対応 | 河川情報を根拠なく県全域や市全域の警戒塗りにすること |
| 都道府県 | 検証済み対応表による細分区域の dissolve | 名称推測や未検証のコード切出し |
| 区域名 | 元資料の code・name・所属を保持した生成表 | path しかない生成物から名称を推測すること |

全生成物に、入手元、版、取得日、利用条件、元 archive hash、変換 tool 版、変換引数、出力 hash、期待コード数、既知の欠損・除外を持たせる。公開可否は資材ごとに確認し、dmdata の電文再配信条件と GIS の利用条件を混ぜない。

LOD の選定は次を満たす。

1. 全体図用・zoom 用の間引き率を別々に宣言する。
2. 同じ意味区域の色塗りと境界が LOD 切替で別の区域へずれない。
3. 47 県・1,892 区域を基準に、欠落・重複・空 geometry を検査する。元資料の正当な除外は理由付き allowlist とする。
4. 代表的な都市部、細い地形、入り組んだ海岸線、離島で、元形状との視覚差を検収する。
5. 資材 byte 数、点数、初回読込、層切替、連続操作を同じ corpus・端末条件で比較する。
6. SVG／Canvas／WebGL の選択を、速度だけでなく境界品質・hit test・保守範囲と合わせて決める。
7. 未対応コードは件数と対象を診断し、地図に出なかった情報を「対象なし」にしない。

間引き率・描画方式・区域名テーブルの生成方法は §15.2 に残す。これらの数値・方式を、今回の静的読解だけで確定済みとしない。

## 9. oracle・必須系列・corpus manifest

### 9.1 正解の順序

1. 今回の裁定済み要求と、採用版を固定した公式電文意味仕様。
2. 元電文を確認して作った期待値、既知インシデントの期待結果。
3. 独立した小さい参照モデル、不変条件、許可範囲の順序交換試験。
4. 旧築との意味比較。
5. screenshot・装飾の一致。

旧築と一致しただけでは合格ではない。新築の出力をそのままgoldenへ保存して正解を作ることも禁止する。

根拠: `plan-chatgpt.md:513`（Vault To-Claude/FlEq_Reconstruction_Simple_Robust_2026-09-10.md）。

### 9.2 比較単位

```text
初期checkpoint／初期state
＋ 順序付き入力
＋ 各入力の受信時刻と入力元
＋ 時計の進行
＋ 設定版
＋ scheduler規則
→ 各stepのdecision・reason・subject・revision
→ current・watermark・tombstone・必要履歴
→ active / inactive / unavailable
→ 地図区域・カード事実・通知intent
→ 保存・停止・復元後の続報の結果
```

fixtureを現在時刻で流して全部失効させ、「空で一致」と判定しない。

### 9.3 必須11系列

| ID | 入力系列 | 必須の期待 |
|---|---|---|
| O01 | 発表→続報→同一revision訂正→取消→重複→遅着 | 対象だけ取消。受理済み訂正は表示差分なしでも通知判定。取消後の古い報は復活しない。EEW、火山三slice、洪水、地震を含む |
| O02 | 正常newer empty／unknown／構造不正／容量超過 | inactive・unavailable・rejectedを区別。VPWP50/VPTA50 gate-only、洪水全unknown、特殊値0/missing/empty/rangeを含む |
| O03 | 全国base＋複数官署partial＋code00＋VPNO50、VPOA50→VPBS50 | 所有現象を保持し、区域終了後に古いbaseを再露出しない。対応報置換で取消記憶を失わず、未確認相関を確定扱いしない |
| O04 | 8日前のVPWS50 current＋新しい正常全国報 | stale lockから脱出し、新しい報を受理。baseより新しい有効partialを維持。古い正常表示を継続しない |
| O05 | VTSE51/52の同一revision fragment、順序交換、同station訂正 | allowlist内だけの可換性。family独立、station codeによる結合、観測欠落防止 |
| O06 | 全国履歴2、partial履歴8の境界、連続取消 | 範囲内の復元、履歴不足の明示、旧8段からの移行。取消記憶をcurrent revisionと混同しない |
| O07 | 保存→停止→復元→直後の訂正／取消／unknown | 復元単位の整合、期限非延長、地震の既知危険保持、火山identity、pending intentの再試行 |
| O08 | 時計逆行、大幅補正、期限横断、入力停止 | 期限切れと解除を区別。失効・取消を復活させない。熱中症対象日、VFVO53 batch、相関holdbackを含む |
| O09 | 最大XML処理開始→EEW、burst、personal有効 | p99実paint250ms、main health、queue待ち、priority、A/B判定 |
| O10 | disk full、write遅延、rename前後kill、ack喪失、通知／export／stdout失敗 | Q2=B、未保存取消、保存再開、成否不明の解決、重複許容、有限資源 |
| O11 | SSE切断、slow client、内容更新合流、metadata churn、EEW割込み | 最新一枚で復元、取消notice保持、全区域掲載、ページ滞在維持、引き出し線、資源有界 |

O05の根拠には限界がある。現行manifestも、実corpusはstation identityの根拠で、同一revisionの分割到着はsyntheticで補っていると明記する。

根拠: `test/engine/telegram-foundation/phase0-manifest.ts:1211`。

O04の既存試験は確認済みだ。O07には復元後unknownの試験が存在する。ただし今回実行してはいない。

根拠: `test/engine/messages/vpws50-stale-lock-recovery.test.ts:118`、`test/engine/telegram-foundation/phase7_5-end-to-end-production.test.ts:590`。

### 9.4 構造上の合格条件

| 条件 | 合格値 |
|---|---:|
| 無変化tickの全状態clone | 0回 |
| 無変化tickの全状態stringify | 0回 |
| 無変化tickのcheckpoint write | 0回 |
| 無変化tickの内容snapshot生成 | 0回 |
| 他保存単位の電文受理によるU-W全量encode | 0回 |
| 変更検出のための全状態stringify | 0回 |
| 一入力のbase64 decode | 必要時1回以下 |
| 一入力の展開 | 必要時1回以下 |
| 一XMLのfull parse | 1回 |
| 別出力のための同電文再parse | 0回 |
| 旧probe/shelf/settle pass | 0 |
| display off中に失われる意味更新 | 0件 |
| queueの計数外in-flight | 0件 |
| 保存に含まれるruntime専用field | 0件 |
| 未確認差分を合格扱い | 0件 |
| 通常合法corpusの恒常的unavailable | 0件 |

metadataを読む小さいenvelope parseと、Body全体のfull parseは計数を分ける。

性能は七区間で採る。

1. ingress JSON。
2. base64 decode。
3. gunzip/unzip。
4. full XML parse。
5. metadata・SpecialValue抽出。
6. 分野抽出・集約。
7. worker転送。

台帳のms/KBだけからXML parser単体が超線形であるとは確定しない。encoded、展開後、node数、深さ、属性、text量を併記する。

#### 9.4.1 display 関連の合格条件

表の ID を系列 fixture と検証報告の参照先にする。これは検証実績ではない。測定定義は §7.5・§9.9 に従う。

| ID | 対象 | 合格条件 |
|---|---|---|
| D-AC01 | 線・周期フォーカス | hover・受信演出なしでは線 0 本、競合中も最大 1 本。時間だけで対象・zoom・詳細を巡回する timer・遷移 0 |
| D-AC02 | 有効情報 | 空の災害カード 0。取消・失効を現在ページ外でも反映。`unavailable`・容量縮退を無発令に変換しない |
| D-AC03 | hover | 高さ・概要矩形・詳細・ページ・camera が前後で不変。名札の区域名と状態が期待値に一致し、境界が最前面 |
| D-AC04 | 手動詳細 | 再クリック・空白 click で閉じる。受信 timeout で閉じない。取消で詳細と取得要求を終了 |
| D-AC05 | overlay | 周囲の概要矩形が不変。減光・宣言値による下端補正が成立。時計・ページ操作・緊急大カードを隠さない |
| D-AC06 | 算術配置 | 器・詳細・行高・gap・予約高だけで計算。内容 fit の DOM 計測 0、測定用・非表示ページ・全詳細候補の mount 0 |
| D-AC07 | 器・情報量 | Q5-a 裁定後、全種別・状態の割当漏れ 0。見出しは 48px・本文なし・右端時刻。§8.5.3 の省略事実が詳細から取得可能。熱中症の指数・対象と区域 hover の状態を検証 |
| D-AC08 | ページ到達 | 通常・片側・同時発生・伸縮・テロップ・内部分割について、ページ集合の対象 ID が有効対象集合と一致。ドットで全ページへ到達。件数だけの畳みによる到達不能 0 |
| D-AC09 | 手動ページ調停 | ドット click 後、明示再開まで自動ページ遷移 0。timer 同時発火では手動が勝つ。metadata・単独／同時切替でも停止を維持。再開は現在ページから新しい timer |
| D-AC10 | 自動一巡 | Q5-b 裁定後、固定した最大対象数で全ページ滞在時間の総和が採用上限内。手動停止時間は別報告。自動 zoom・自動詳細をページ送りに付随させない |
| D-AC11 | 受信・camera | 通常自動系列と、受信前からの県フォーカス・pan・wheel、演出中の手動操作、連続受信、古い timeout を検証。手動状態の巻戻し 0、津波中の自動 zoom 0 |
| D-AC12 | metadata | metadata だけで scene 初期化・camera 復帰・全カード再 mount・ページ停止解除 0。版付き詳細は対象分野の内容版が変わった場合だけ再取得状態にし、他分野・metadata だけの更新では維持する |
| D-AC13 | 2 層・県操作 | 47 県・1,892 区域の coverage。県 click の dim・太線、拡大図の市区町村 click による所属県選択、県外復帰、drag と click の分離 |
| D-AC14 | EEW | 猶予秒・到達 countdown 0。津波なしの自動 camera 適用直後は震度 3 以上の全対応 geometry が bounds 内。欠損は明示。手動操作後を自動 bounds 保証に混ぜない。full／summary の期待値は §8.1 に従う |
| D-AC15 | 津波 | 地図主役、左大カード、大津波のみ点滅、全体図固定、「今すぐ避難！」。正規予報区単位の線・島・警報／注意報区分。県輪郭代用を合格にしない。full／summary の期待値は §8.1 に従う |
| D-AC16 | 片側・同時発生 | 単独→同時→単独、最大件数、取消を系列化。同時は EEW 宣言高が不変、右残余に 48px 見出し・ドットが収まり、全対象へ到達。片側では空きに応じ上位から昇格。full／summary の期待値は §8.1 に従う |
| D-AC17 | 最大重大度・共有色 | 異種災害の重なり、同順位、入力順逆転、最大状態取消で区域ごとの期待 rank・token が一致。LOD 変更で意味結果不変。地図・カードが同じ意味トークンを参照 |
| D-AC18 | 見出し | container／on／band、基準下辺 4px、title／metadata、角丸 clip。縦リボン 0 |
| D-AC19 | 容量と分野隔離 | 上限直下・一致・超過・複数分野超過を生成。全 SSE JSON が 1 MiB 以下、予算内分野と共通状態の内容欠落 0、容量超過だけを理由とする SSE 切断 0 |
| D-AC20 | 縮退中の別分野取消 | 一分野を summary に保ったまま別分野を取消。次の配送 snapshot と表示で取消が反映され、縮退分野の最小事実・接続・保存・復元状態も維持 |
| D-AC21 | 版付き詳細 | 正常取得、ページ切替、取得中の更新・取消・再起動、遅延旧応答、409、通信失敗を検証。異なる対象内容版の合成 0、旧詳細の現在値表示 0、in-flight 上限超過 0 |
| D-AC22 | 容量縮退の復帰 | full→summary→full。省略中を常時明示し、古い地図塗りを最新扱いしない。他分野は継続。新規接続も単一 snapshot だけで同じ縮退状態を再構成 |
| D-AC23 | 地図品質 | §8.10 の LOD・境界・島・細部・区域名・hit test を検証。目視検収と機械検査を分け、粗い資材の拡大だけで合格にしない |
| D-AC24 | 実表示性能 | 開始目標は市区町村 paint p99 ≤ 250ms、操作フレーム p95 ≤ 16.7ms・p99 ≤ 33.3ms、EEW は §7 の p99 250ms。最大値・標本数・条件・証拠を併記 |

モック多発令 fixture は事象の全 ID と表示先を列挙する。旧モックの「ページ送りなし」を、件数要約に隠れた対象を除外して再現しない。裁定済み profile で全件収まれば 1 ページ、収まらなければページ分割を正解とする。

T1〜T3・F01=A・F08=A・ページドットは裁定済みである。Q5-a・Q5-b と残る仕様案は採用値を固定してから検証する。未実施の Chrome 操作・実 paint・描画品質を unit test 成功で代用せず、未裁定・未実測を Pass に含めない。

### 9.5 corpus manifest の形式

依存追加を避け、JSONまたはTypeScriptにする。fixtureの来歴と、系列での使い方を分ける。

```ts
interface CorpusFixture {
  fixtureId: string;
  path: string;
  sha256: string;
  byteLength: number;
  role: "telegramXml" | "checkpoint" | "restResponse"
      | "expectedValues" | "provenance";

  acquisition: {
    kind: "jmaPublished" | "dmdataCaptured" | "externalCorpus"
        | "generated" | "unknown";
    locator: string | null;
    acquiredAt: string | null;
    evidenceRefs: readonly string[];
  };

  modification: {
    kind: "byteIdentical" | "edited" | "synthetic" | "unknown";
    parentFixtureId: string | null;
    parentSha256: string | null;
    changes: readonly FieldChange[];
  };

  transport: {
    classification: string | null;
    headType: string | null;
    evidence: string;
  };

  documentTimes: {
    reportDateTimeRaw: string | null;
    targetDateTimeRaw: string | null;
  };

  sourceStrength: "confirmedOriginal" | "confirmedDerived"
      | "synthetic" | "unconfirmed";

  distribution: "publicApproved" | "privateOnly" | "unconfirmed";
}

interface CorpusSequenceStep {
  sequenceId: string;
  position: number;
  action: "receive" | "advanceClock" | "save" | "restart"
        | "injectFailure" | "recover";
  fixtureId: string | null;
  receivedAt: number | null;
  evaluatedAt: number;
  inputSource: "ws" | "rest" | "replay" | "test";
  expectedRef: string;
  expectationBasis: readonly string[];
}
```

必須規則:

- `source:"repo"` を原本証明に使わない。
- 入手元と改変有無を別欄にする。
- 原本未確認を `byteIdentical` にしない。
- 合成受信時刻は、実際の受信時刻として記録しない。
- XML filenameから補ったhead typeと、実配信metadataに記録されたhead typeを区別する。
- 期待値の根拠は、新築の出力以外に置く。
- 元XMLを改変せず、時計入力だけを変えた場合はその差を明示する。
- fixtureの公開可否と、利用規約・ライセンスの確認状態を記録する。

確認したhash例:

```text
15_18_01_250630_VPWS50.xml
4730b26b18e285be6b6141b1140aa5c2f81ce32907571bdd17e80525e3746981

81_09_01_260605_VPWP50.xml
f4614dc206b143ef3a9997fecf1ebffaef2f4f9b3000ddd2df0de522bc8cad4b
```

hash一致は、このcheckoutのbytesを固定する証拠だ。配信原本であることの証拠とは分ける。

### 9.6 XML236本・JSON21本の再分類手順

1. `test/fixtures/` の全XML236本、JSON21本を列挙し、相対path、byte、SHA-256を記録する。
2. XMLは内容、既存helper、既存manifest、provenance文書を照合し、head type・分類・日時を抽出する。
3. JSONは電文として一律に扱わず、checkpoint、REST応答、期待値、provenanceへ分類する。
4. 既存の「実182・synthetic47・不明7」は仮分類として取り込む。
5. ファイル名にsyntheticがなくても、日時・EventID・値の改変根拠があれば派生とする。
6. 官署名が実在することだけで原本に昇格させない。
7. 原本hash・取得元・改変列挙があるものを優先して確定する。
8. 取得元を確認できないものはunknownのまま残す。
9. 各fixtureをO01〜O11とroute/familyへ対応付ける。
10. 正常・訂正・取消・解除・empty・unknown・不正・上限境界の不足を列挙する。
11. 足りない系列はsyntheticを追加するが、公式に観測済みの形とは区別する。
12. 公開mainには公開確認済み資材だけを置く。
13. 全257ファイルについて、分類済みまたは理由付き未確認のどちらかが存在することを機械検査する。
14. 基準版とmanifest自身のhashを固定する。

`phase0-manifest.ts` の `source` 表記は39件で、repo28・weathercw7・synthetic4だった。全236 XMLの来歴表ではない。

根拠: `test/engine/telegram-foundation/phase0-manifest.ts:82`、`test/engine/telegram-foundation/phase0-manifest.ts:584`、`agenda-v2.md:208`（Vault Artifacts/2026-09-10-fleq-reconstruction-agenda-v2.md）。

### 9.7 旧テストの移植

`it`単位で次へ分類する。

- パーサ・値処理の期待値を持ち越す。
- 順序付き履歴テストへ変換する。
- 通知・DSL・表示の契約を抽出する。
- 旧owner/token/pair/solver構造の試験として廃棄する。
- 根拠不足として保留する。

既存helperは旧比較側に残してよい。新testkitが旧engineを暗黙起動する依存を作らない。

旧新差分は必ず以下のいずれかへ分類する。

```text
newImplementationBug
knownLegacyBug
approvedSpecificationChange
insufficientEvidence
```

`insufficientEvidence` は一致でもPassでもない。


### 9.8 構造的欠陥台帳 36 項目との対応

台帳の実項目数は **36 項目・6 節**と訂正する。内訳は ①9・②8・③6・④4・⑤5・⑥4。冒頭の記入例 `- **題**` は項目に数えない。

安定 ID は台帳の「節番号-節内順」とし、この表の採番を固定する。以後の追記で既存 ID を振り直さない。対応先の記載は解決実績ではなく、設計構造と検証先の追跡表である。契約上の解決先は下表と §9.9。実装検証は未実施。

| 台帳 ID | 欠陥 | 消す・抑える spec 構造 | 受入条件・残る確認 |
|---|---|---|---|
| ①-1 | 一電文で永続状態を最大 3 回 JSON 化 | §4.2 の保存単位、§5.1・§5.7 の変更単位 encode | §9.4 の無関係 U-W encode 0・変更検出 stringify 0 |
| ①-2 | 却下前に全コストを払う | §5.1 の gate と reducer 境界 | 却下後の reduce・encode・write が不要に走らない。判定に必要な parse 費用は残る |
| ①-3 | 同期受理で event loop 停止 | §7.1 の worker 境界 | §7.5・§7.7。停止検出・測定定義は F02・F12・F13 |
| ①-4 | VPWS50 二重 parse | §5.1 の decode 済み入力共有 | §9.4 の full parse 1 回・出力別再 parse 0 |
| ①-5 | transact 外のサイズ比例残差 | §9.4 の七区間計測 | 区間外残差を報告。計測自体は処理費用の除去ではなく、F12〜F14 で定義補完 |
| ①-6 | 自作 byte 列の再 parse・stringify 検証 | §1.4・§5.7 の本番自己往復検査廃止 | 本番経路の自己往復 0、codec 検査は境界・テスト |
| ①-7 | 一電文 heapDelta 50〜75MB | §5.1 の共有・変更単位処理 | allocation・GC の測定と基準は F14。RSS だけで解決扱いしない |
| ①-8 | 初回 XML parse が main を同期停止 | §7.1 の decode・parse worker | §7.5・§7.7、大型入力中の main 応答 |
| ①-9 | 大型 XML parse が停止時間の半分 | §7.5・§7.6 の実測による A/B 判断 | 大型 XML 直後 EEW、七区間。parse 自体の高速化を未測定で主張しない |
| ②-1 | v2/v1 二重 envelope | §5.7 の新形式、§10.4 の一方向移行 | 通常保存で旧 v1 生成 0 |
| ②-2 | lossless 検査の全量往復 | §5.7 の codec 境界 | 本番自己往復 0、独立した codec 往復 fixture |
| ②-3 | current が凍結しても検出できない | §5.6・§10.5 の復元、O04 | §7.8、O04 |
| ②-4 | no-op sweep の全量 JSON 化 | §3.2 `nextDeadline`、§5.1・§5.2 | §9.4 の無変化 tick の clone・stringify・write・内容 snapshot 0 |
| ②-5 | runtimeVersion 過剰 bump の権威 | §3.2・§5.2 の結果型と単一 runtime | 無変化で意味 revision を進めない。統合契約は F18 |
| ②-6 | coordinator 外の holder 変異 | §3.2・§3.6 の私有状態と入口制限 | 公開 mutator・別所有の状態変異経路 0。F18 で共有単位契約補完 |
| ②-7 | runtime 専用 restored の保存漏出 | §3.2 の runtime／persisted 型分離、§5.7 | §9.4 の runtime 専用 field 0、合法 persisted 入力の往復 |
| ②-8 | VPWS50 history による肥大 | §4.5 の保持上限、§4.2 の U-W 分離 | 全国履歴 2・官署別 8 の境界と取消復元、無関係単位の encode 0 |
| ③-1 | settle 107 pass の長時間 task | §8.5・§8.6 の宣言矩形 | D-AC06、D-AC24 |
| ③-2 | 毎 pass の partition 再計算 | §3.5 D04、§8.5.5 の算術分割 | D-AC06。DOM・probe を介する再計算 0 |
| ③-3 | metadata だけで全カード再計測 | §8.2 の意味・metadata・scene 分離 | D-AC12 |
| ③-4 | gate trace が pass² 成長 | §9.4 の旧 pass 廃止 | 旧 pass trace を移植しない。計測器の有界性は F14 |
| ③-5 | solvePlan・partition の反復 | §8.5 の宣言 profile と入力起点計算 | D-AC06、旧 solver・settle pass 0 |
| ③-6 | probe 副作用が探索を進める構造 | §3.5 D04、§8.6.3 | D-AC06、hidden DOM・収束探索 0 |
| ④-1 | 実データ 194 periods が上限脱落 | §4.5、§9.3 O06、§13 P2 | 194 periods の保持と境界超過時の明示 |
| ④-2 | 容量探索と全状態 clone の結合 | §5.2 の意味更新と §8.3・§8.5 の表示容量分離 | D-AC06・D-AC19、表示 fit のための意味状態 clone 0 |
| ④-3 | 拒否理由 9 種が一警告へ潰れる | §5.2 の型付き rejected・diagnostic | 拒否理由ごとの期待値。具体 enum・観測契約は F14・F15 |
| ④-4 | snapshot 超過で SSE 全体切断 | §8.1・§8.3 の分野別 summary と版付き詳細 | D-AC19〜D-AC22。特に超過中の別分野取消 |
| ⑤-1 | ログが scrollback のみで消える | §7.1・B15 の観測基盤 | §7.9、E23 |
| ⑤-2 | ログの level prefix なし | B15 の診断契約 | §7.9、E23 |
| ⑤-3 | 受理・sweep 所要時間の観測不足 | §7.5・§7.7・§9.4・§10.6 | 区間・標本・時計・閾値定義は F12〜F14 |
| ⑤-4 | アクセストークンの平文ログ | B15・§14 の秘匿情報禁止 | token を含む入力・例外・接続ログで露出 0 |
| ⑤-5 | personal export が受理を同期停止 | §12.2 の汎用 consumer 境界 | 契約と timeout 隔離は F16・F17。personal 実コードは未確認 |
| ⑥-1 | 変更検出の全状態コピー・文字列化 | §5.2 の明示結果、§9.4 | 無変化 tick と変更検出の全状態 clone／stringify 0 |
| ⑥-2 | owner と保存単位の不一致 | §4.2・§4.4 の整合性単位 | 一入力一保存単位、無関係 encode 0。単位内統合契約は F18 |
| ⑥-3 | 受理・保存・表示の同期結合 | §7.1、§8.2・§8.3 の実行・配送境界 | §7 の遅延・応答、D-AC12・D-AC19。凍結検出は F02 |
| ⑥-4 | 局所修正が次の同型欠陥を露出 | §1 の第一原則、§13 の段階検収、§14 の仕組み追加条件 | 本表の全 ID に構造・検証先・未解決状態を残す。単独機能の追加で解決扱いしない |


### 9.9 試験条件表・計数範囲・判定式

§7.7・§9.4・§10.6 の性能・資源判定は本節を共通定義とする。§9.4 の構造条件は以下の初期条件・計数範囲で判定し、§9.4.1 の display 条件と併用する。

**試験 manifest** は、入力 hash・順序・投入時刻、初期 checkpoint、設定、時計、端末、OS、Node／Chrome、viewport／DPR、実行構成、client 数、personal consumer、測定器、標本数、期待値と根拠を含む。未記入のまま正式測定しない。

通常負荷 N は、採用した実入力窓の時刻間隔を維持した replay とする。ピーク負荷 P は、同じ入力の固定倍率 replay と最大正常入力・同時最大状態の系列とする。倍率・実入力窓・最大状態を、結果を見る前に測定担当が選び、統合担当が凍結する。単に「通常」「ピーク」とだけ記録しない。

接続条件は backend 単独、display 1 client、最大 8 client、旧新並走、personal 有効を分ける。故障注入 F は正常性能の分位点へ混ぜない。

| ID | 試験条件・測定対象 | 判定式・報告 | 凍結担当・時期 |
|---|---|---|---|
| E01 | §7.5 の EEW 各母集団 | P2 は母集団 1〜3、P5 は最終構成での再測定について、各 run の遅延上界 p99 ≤250ms、欠落 0。境界不確かは未確認 | 測定担当＋統合担当、P2 A/B 前 |
| E02 | N・P 中、独立 client から `/healthz` を毎秒要求。接続確立済み、要求開始→本文受信完了 | 暫定 p99 ≤100ms。transport 応答と worker 正常判定を分ける。HTTP が速くても stalled を正常と返さない | B11 担当、P2 性能測定前 |
| E03 | 最大正常 XML、worker が入力処理を開始→decision・公開用射影が確定。decode・parse・reduce・射影を含み、queue 待ちを別計数 | 暫定 p99 ≤1秒。parse だけの値に置換しない | B04・測定担当、P2 前 |
| E04 | 資材読込済み Chrome、意味 snapshot 受信→対象内容の実 paint | 暫定 p99 ≤250ms。ネットワークを含む E01 と区別 | display 担当、P4 性能測定前 |
| E05 | N・P、Node プロセス RSS を 1 秒周期。worker を含み、Chrome は別集計 | 暫定 N の最大≤300MiB、P の最大≤400MiB | 測定担当、P2 前。製品構成は P5 前に再固定 |
| E06 | 保持上限を事前充足し、更新・取消・期限回収が各巡で実際に発生する固定系列を 60 分実行する。必要な時刻・revision の変更は派生 fixture として事前固定し、重複だけの巡回を代用しない。10 分窓を 6 窓、RSS・FD・queue を測定 | RSS 窓中央値の回帰傾き≤暫定1MiB/時、最終窓中央値≤初窓＋暫定5MiB。FD 最終最大≤初窓最大。queue は E07。超過は調査し、原因未分類のまま合格にしない | 測定担当、P2 の長時間試験前 |
| E07 | N を 60 分、queue 件数・byte・最古年齢を毎秒。最後に入力停止 | 全時点で宣言上限内。最後の各10分窓の最古年齢の最大値を比較し、3窓連続の厳密増加を不合格とする。排出 deadline は正式試験開始前の manifest に固定し、入力停止からその期限までに入力 mailbox の pending／in-flight が0になること | B05 担当、P2 前 |
| E08 | 初期 state は保存済み、intent・batch・I/O なし、期限未到達。固定時計で無変化 tick を1,000回 | 全状態 clone・変更検出 stringify・checkpoint write・内容 snapshot 生成が各0。heartbeat・小さい進捗値は別計数 | runtime 担当、P2 契約前 |
| E09 | decode が必要な正常入力、拒否入力、ignore 入力を別系列化 | base64・展開は必要時各1回以下。Body を読む XML は full parse 1回、事前拒否・ignore は0を許す。出力別の再 parse は0 | B04 担当、P1 契約前 |
| E10 | U-W 保存済みから他単位だけを更新。U-W の期限は未到達 | U-W 全量 encode 0。別の理由で既に dirty な試験を混ぜない | checkpoint 担当、P2 前 |
| E11 | 正常／取消／no-op／最大入力の代表系列 | 変更検出の全状態 stringify 0。`structuredClone` だけでなく手動全量コピー・JSON roundtrip も監査。必要な変更枝の構築と codec encode は別計数 | runtime 担当、P2 前 |
| E12 | 代表的な小型・大型・最大 XML、旧新を同一入力・初期状態・Node で別実行 | allocation profiler の割当量推定、GC 回数・停止時間、heap 使用量前後を報告。RSS と heapDelta を割当総量と呼ばない。改善主張は同条件差分でのみ行う | 測定担当、P2 前 |
| E13 | 全正常 corpus と同時最大状態、既知の GIS／REST 未対応は理由付き別群 | 意味上の恒常的 unavailable 0。入力処理・必要な期限処理が完了しても残る unavailable を数える。配送 summary は別状態で、意味 unavailable に数えない | 各単位担当、実装契約前 |
| E14 | 複数単位を同時 dirty、連続更新、遅い旧世代 ack | 正常系は各最初の dirty から包含世代 ack まで≤3秒。古い ack による current 巻戻し0。故障系は超過表示と有限保持 | checkpoint 担当、P2 前 |
| E15 | 一保存試行ごとに unit・generation・stage・byte を記録 | 計測 write は宣言した checkpoint／tmp／ログ／採用 export に帰属。帰属不能write 0。retry は理由付き。byte/保存・受理・日を報告し、量の改善自体は根拠なしの合格条件にしない | checkpoint・運用担当、P2／P5 前 |
| E16 | Pi 並走中、MemAvailable・disk を1秒周期 | 暫定 MemAvailable≥2GiB、空きdisk≥10GiB。下回れば新築shadow停止判断 | 運用担当＋統合担当、P5開始前 |
| E17 | Pi swap counter・throttle の現在 bit を毎秒、10秒窓で差分集計 | 暫定で swap-in/out 正の窓が3連続、または新たなthrottleが30秒継続したら停止判断。起動前からの履歴bitを新規障害と数えない | 運用担当、P5開始前 |
| E18 | 旧築単独と旧新並走で、同じ入力 manifest・速度・設定の30分窓を各3回 | 各窓の旧系p99を比較。`新窓−基準窓≥100ms` かつ `新窓≥1.2×基準窓` が2窓連続で停止判断。旧系の指標は受信 frame callback 入口から当該電文の同期受理処理終了までとする。各比較窓は同じ入力 ID 群の1,000件以上を含め、不足時は試験前に固定した長い窓を使う。新築の実 paint 指標と混同しない。標本不足・入力非同等は未確認 | 測定担当、P5開始前 |
| E19 | Pi 72時間、固定した N・P 窓と障害系列、display・personal 条件を実行計画に配置 | 全窓・系列の実施、上限内、未知の欠落・未分類障害0。重大変更後は影響する連続運転試験を再実施。稼働時間だけで合格にしない | 運用担当＋統合担当、P5開始前 |
| E20 | 通常終了、保存不能、worker停止、batch残存、終了中の遅いack | §5.9 の順序・世代一致・終了code・時間上限が期待値通り。保存未確認のcode0は0件 | B02・checkpoint担当、P2前／全単位P3 |
| E21 | adapter／consumer が成功、reject、timeout、abort無視、遅い成功 | §6.3・§12.7 の無効化、隔離、欠落計数。停止未確認の実処理への重ね呼出し0 | B09・B10担当、P2／P3契約前 |
| E22 | 過去履歴の復元中にlive更新・取消、期限横断、coverage不足 | 中間current公開0、新規履歴通知0、期限延長0、live上書き0。未充足理由を保持 | 復旧担当、各P3単位契約前 |
| E23 | ログ最大量・sink失敗・再起動・秘密値を含む例外 | level保持、保持上限内、再起動後に既存ログ読取可、秘密値露出0、sink失敗の再帰増殖0 | B15・運用担当、P2／P5前 |
| E24 | GIS の機械検査と目視検収 | code・coverage・geometry検査は数値結果、境界・島・細部の見栄えは指定画面と原資料に対する担当者の判定。目視未実施を機械Passで代替しない | GIS担当＋検収担当、P4検収前 |

分位点は §7.5 と同じ nearest-rank を使う。E02〜E04 の正式判定も各条件 1,000 標本以上、3 run とし、標本不足は未確認。最大値基準を p99 へ置き換えない。

E06 の回帰傾きは窓中央時刻と窓中央値の最小二乗直線とする。allocator の揺れを許す 1MiB/時・5MiB は経験的な**暫定値**であり、無限成長を数学的に否定する証拠ではない。保持上限・queue 上限の構造検査と合わせて判定する。

E12 は割当量の観測を必須にするが、根拠のない全入力共通の byte 閾値を置かない。全状態コピーの除去は E11、実資源上限は E05・E06 で判定する。allocation が減ったと主張する場合だけ、profiler の誤差・有効標本を含む比較結果を必要とする。

暫定閾値の理由は、100ms・1秒・300/400MiB が既存の開始目標、2GiB・10GiB が旧系を残す運用余裕、20%かつ100ms が比率だけ・絶対値だけの微小差を避ける開始判定である。安全性や最適値の実証ではない。担当者は正式試験前の予備測定で妥当性を確認し、統合担当が凍結する。結果を見た後の緩和は旧結果の合格化に使わず、新しい版の試験として扱う。

72時間には通常・ピーク・入力停止排出・再接続・保存失敗と復帰・通常終了と復元・通知失敗・consumer隔離を含める。実機で破壊的障害を入れられない系列は別環境の契約試験として明示し、Pi 実施と偽らない。

構造ゼロ条件は runtime counter だけに依存せず、対象経路の呼出・手動コピーの静的確認を併用する。全入力を新しい snapshot にしてから比較する検査器や、実装と同じ分岐を写した oracle を作らない。

**契約補完と実装検証済みは別**であり、§9.8 の実施結果がない行を Pass へ変更しない。

## 10. 並走・切替・移行・rollback

### 10.1 起動前の接続条件

dmdataの最大4本という入力上の前提を採る。開始時には、その時点の使用本数を確認する。

- 旧主・旧副・新主・新副を合算して4本以内。
- 初期shadowは新主一本から始める。
- 新築には旧築と異なるappNameを必須指定する。
- デフォルト`fleq`のまま設定をコピーして起動しない。
- 新しい接続名は、ほかの稼働端末とも重ならないよう役割・端末を区別する。
- 起動・再接続・停止で閉じるsocketは、新築が所有するものに限定する。
- socket一覧取得に失敗して所有・容量が判断できない場合は、新規接続を開始しない。

現行`prepareAndStartSocket`は、`keepExistingConnections=true`でも、初回起動で同じappNameの残留socketを閉じる。したがって`--keep-existing`だけでは旧築を保護できない。

根拠: `src/dmdata/rest-client.ts:585`、`src/dmdata/rest-client.ts:627`。

### 10.2 配置分離

新旧で以下を分離する。

- 実行・インストールディレクトリ。
- 設定ディレクトリ。
- state directory。
- port。
- display token。
- appNameとsocket ownership。
- 通知の有効化状態。
- personal export先と検収記録先。

現行の設定読込みには旧パスからの自動移行や権限変更がある。新築の起動で旧設定ファイルを読んだだけのつもりでも、旧領域へ作用しないようにする。

根拠: `src/config.ts:84`、`src/config.ts:242`。

### 10.3 並走の順序

1. 開発機で固定corpusを旧新へ同じ順序・時計で流す。
2. 旧v2から新checkpointを作り、復元直後の続報を検証する。
3. 別appNameの独立購読を開始する。
4. message ID、本文hash、購読区分、受信範囲、欠落区間を照合する。
5. Piへ新backendだけを配置し、旧築を動かしたまま資源測定する。
6. 開発機Chromeを新backendへ接続し、地図・カード・EEW実表示を検収する。
7. personalを含めた72時間の並走を行う。
8. 表示と通知を切り替え、旧築をwarm rollback先として残す。

独立購読では到着順が一致するとは限らない。live比較だけで順序差と不具合を混同せず、共通の固定順序replayを併用する。

`outcomeTaps`はsuppressed入力を通さないため、完全な入力比較の源には使えない。

根拠: `src/engine/messages/message-router.ts:703`。

### 10.4 旧v2一方向移行ツール

移行器は製品runtime外に置く。

入力:

- 読取り専用コピーの旧v2。
- 必要な旧地震・強震・日次等の補助保存のコピー。
- writer版・出典・取得時刻。
- 必要に応じたREST取得結果とcoverage証拠。

出力:

- 新しい空の移行先directoryへのU-* checkpoint。
- 単位ごとの成功／未充足／拒否。
- source hash、移行器版、schema版、入力・出力件数。
- 落とした／解釈できないfieldと理由。
- 復元後に投入する取消・訂正fixtureの結果。

保存する意味:

- gate/watermark。
- cancellation tombstone。
- currentの出典。
- 全国2／partial8の必要履歴。
- partialの現象所有情報。
- VPNO50終了記憶。
- 火山の三slice・identity・provenance不足。
- 速報のalias・予測置換・取消記憶。
- 特殊値と危険保持の根拠。
- 絶対期限。

移行しないもの:

- timer handle、listener、queue。
- 旧v1へのmirror。
- display layout、描画snapshot。
- runtime専用`restored`。
- 実際の未配送を証明できない過去通知。

旧保存が複数ファイルに分かれている場合、一括コピーしたという理由だけで相互整合を仮定しない。revision・出典を検証し、同じU-*へ安全に統合できないものは未充足にする。

移行後に旧schemaへ逆変換するtoolは作らない。

### 10.5 REST による充足と副作用

現行で確認できるのは、津波の VTSE41 と火山の VFVO50/54/55 を中心とする履歴取得・coverage 判定である。全 family の完全復元が可能だとは主張しない。

新築は同じ parser・意味 reducer を利用するが、**履歴再構築と live 受理の公開・通知条件を分ける**。

1. 復旧対象の単位・subject・系列・取得範囲・必要な基点を固定する。
2. 開始時の対象 UnitState 参照と記録用の版を控え、不変の基点から一つの候補状態を作る。候補は runtime の権威ある current ではない。
3. REST 取得は既存 mailbox credit と本文上限を使う。候補は全体で一単位だけとし、入力本文を無期限に保存しない。
4. 履歴は、取得順ではなく family 契約の revision・出典時刻・fragment 順で適用する。元の受信時刻が不明なら不明とし、REST 取得時刻で代用しない。
5. 業務上の期限は元報の絶対時刻から計算する。履歴順の評価時計が必要な family は基準を統合契約に明記する。根拠が足りず結果が変わる場合は未充足にする。
6. 途中の発表・訂正・取消・batch から、新規の音・desktop intent・受信演出・通常 outcome を公開しない。
7. 最後に現在時刻で期限を評価し、coverage と期待する取消・watermark の整合を確認する。
8. runtime は候補作成時に参照した UnitState が現在も同一参照であることを照合し、一致した場合だけ候補を一回の状態遷移として採用する。保存 ack だけの進捗更新は比較対象外とする。候補に含まれる意味状態・runtime slice・intent が変われば競合とし、保存世代だけで判定しない。別単位の更新は妨げない。

live 更新で対象単位の世代が変わった場合、古い候補で上書きしない。新しい基点から再構築するか未充足で終了する。再試行は一回の復旧要求あたり暫定 3 回・合計 30 秒を上限とし、live 入力の journal を追加して無理に成立させない。

復旧完了の公開は `recoveryApplied` の一件とし、確認した scope・coverage・採用世代を含める。中間の歴史的な危険状態を新規発令として見せない。既存 pending intent は候補 state の再構築で消さず、現在の期限・既知取消・置換で再評価する。復元履歴から新しい通知期限を起こさない。

取得失敗・基点不足・時計根拠不足・世代競合・容量超過は理由付き未充足とする。取得できた一部 subject だけで単位全体を確認済みにしない。

受入は、過去の発表→訂正→取消、既に期限切れの報、元受信時刻不明、再構築中の live 取消、別単位更新、世代競合、coverage 不足を含む。途中公開 0、新規履歴通知 0、live 上書き 0、期限延長 0 を確認する。N2 の対象範囲は復旧担当が P3 の各単位契約前に固定し、実 API の権限・coverage 証拠は P5 前に確認する。

### 10.6 Pi の資源ゲート

2026-09-10 の提示値は Pi 500、Node v22.22.3、RAM 約 8GB、MemAvailable 7,045MB、swap 未使用、旧 Node RSS 161MB、空き disk 44GB、Pi 上ブラウザなしである。これは入力上の過去測定値であり、今回の実測でも並走合格の証拠でもない。

試験開始前に実端末・OS・Node・filesystem・媒体・旧新の版・設定・接続数・温度・RSS・空き容量を取り直し、§9.9 の試験 manifest に記録する。旧 Node 780MB を前提にしない。

並走の判定式は §9.9 に集約する。旧系への影響、MemAvailable、swap、throttling、disk、FD、queue、保存量を同じ窓で測る。

停止基準を超えた場合は新築 shadow を停止し、旧築を止めて資源条件を満たしたことにしない。通常終了が可能なら §5.9、進捗不能なら未保存・未処理を明示した非正常終了として記録する。

### 10.7 rollback

rollback条件:

- 誤取消、誤降格、別区域表示。
- 重大な意味差分の未分類。
- EEW遅延の継続的逸脱。
- 保存破損・復旧不能・未保存状態の解消不能。
- personal必須機能の喪失。
- 旧築を含む資源悪化。

手順:

1. 旧築の入力追従と鮮度を確認する。
2. 表示先を旧築へ戻す。
3. §6の通知handoffを逆向きに行う。
4. 新築の外部副作用を止める。
5. 新状態・比較記録を保全する。
6. 新schemaを旧stateへ書き戻さない。

旧築が追従していない場合、古い画面に戻すだけで安全なrollbackが成立したとは扱わない。

## 11. 機能採否表 — Q7

### 11.1 記入規則

裁定欄へ「互換必須」または「廃止可」を記入する。空欄は未決だ。

- 既定値は利用実績ではない。
- docs掲載は現在の利用を証明しない。
- testの存在は、今回の成功を意味しない。
- このcheckoutに実利用ログはなく、実際の利用頻度はすべて未確認だ。
- 空欄の機能を、不要と推測して削除しない。
- 内部の旧solver・pair等は非目標として廃止するが、ユーザー機能の廃止とは区別する。

既定値の根拠は `src/types.ts:403`。以下のtest言及は存在・対象の静的確認であり、未実行だ。

### 11.2 CLIコマンド・起動option

| 機能 | 現行の内容・既定値 | docs・test等の材料 | 裁定 |
|---|---|---|---|
| `fleq` 通常起動 | 指定区分を常時受信 | `cli.ts:22–80` | |
| `--help` / `--version` | commanderの案内・版表示 | `cli.ts:19–27` | |
| `init` | 対話初期設定 | `cli.ts:85–92` | |
| `config show` | 設定表示 | `cli.ts:98–103` | |
| `config set <key> <value>` | 設定保存 | `cli.ts:105–119` | |
| `config unset <key>` | 設定削除 | `cli.ts:121–135` | |
| `config path` | 設定path | `cli.ts:137–142` | |
| `config keys` | 設定key一覧 | `cli.ts:144–149` | |
| `-k / --api-key`、環境変数 | 認証入力 | `cli.ts:28–31` | |
| `-c / --classifications` | 5区分を既定購読 | `cli.ts:32–35`、`types.ts:404` | |
| `--test` | `no / including / only`、既定no | `cli.ts:36–39` | |
| `--keep-existing` | 互換option、既定true | `cli.ts:40–43` | |
| `--close-others` | 接続整理。説明と実装のappName範囲を揃える必要あり | `cli.ts:44–47`、`rest-client.ts:585` | |
| `--mode` | normal / compact、既定normal | `cli.ts:48–51` | |
| `--filter` | 複数指定AND、表示限定 | `cli.ts:52–57`、README:161 | |
| `--template` | inline／`@file`要約 | `cli.ts:58–61` | |
| `--focus` | 非一致をdim compactへ | `cli.ts:62–65` | |
| `--summary-interval` | 指定時既定10分、0で無効 | `cli.ts:66–71` | |
| `--night` | 既定false | `cli.ts:72` | |
| `--display` | browser server、既定false | `cli.ts:73` | |
| `--display-port` | 既定7788 | `cli.ts:74` | |
| `--display-bind` | 既定127.0.0.1 | `cli.ts:75` | |
| `--display-token` | 非loopback認証 | `cli.ts:76` | |
| `--debug` | 既定false | `cli.ts:77` | |
| `replay <prediction> <occurrence>` | 固定VPBS50二通 | `cli-replay.ts:42`、`replay-cli.test.ts:35` | |
| replay `--state-dir` | 空の専用directory必須 | `cli-replay.ts:44` | |
| replay `--interval` | 既定1000ms | `cli-replay.ts:45` | |
| replay `--hold` | SSE client待ち・終了後保持 | `cli-replay.ts:46` | |

一般的なcorpus replay検収器と、公開CLIの固定二通replayを同一機能にしない。後者が廃止可でも、検収用replayは必要だ。

### 11.3 REPL全36入口

| 入口 | 下位操作・現行機能 | 利用を推定する材料 | 裁定 |
|---|---|---|---|
| `help` | command/subcommand詳細 | CMD:10。定義あり | |
| `commands` | 一覧、category、検索 | CMD:16 | |
| `?` | help alias | CMD:22 | |
| `history` | REST地震履歴1〜100、既定10 | CMD:27。`repl.test.ts:232` | |
| `stats` | 電文統計 | CMD:33。`statistics-formatter.test.ts:99` | |
| `colors` | palette・震度色 | CMD:38 | |
| `detail` | 既定津波、tsunami/tornado/vpws50/vpwp50/volcano | CMD:44–54 | |
| `status` | WS、socket ID、再接続 | CMD:57。`repl.test.ts:313` | |
| `config` | 保存設定表示 | CMD:63。`repl.test.ts:414` | |
| `contract` | 契約区分取得 | CMD:69。`repl.test.ts:349` | |
| `socket` | 接続socket一覧 | CMD:75。`repl.test.ts:373` | |
| `notify` | category toggle/on/off、all:on/off | CMD:81。地震系等on、気象系offが既定 | |
| `eewlog` | on/off、12記録fieldの切替 | CMD:92。既定off、`eew-logger.test.ts:95` | |
| `tablewidth` | 40〜200 / auto | CMD:103。既定auto | |
| `infotext` | full / short | CMD:113。既定short | |
| `tipinterval` | 0〜1440分、0無効 | CMD:123。既定30分 | |
| `mode` | normal / compact | CMD:132。既定normal | |
| `filter` | 表示、set、clear、test | CMD:142。filter test群あり | |
| `focus` | 式設定、off | CMD:153。README:289 | |
| `clock` | elapsed / now / uptime | CMD:163。既定elapsed | |
| `night` | on/off | CMD:174。既定off、night-overlay testあり | |
| `summary` | on [分] / off / now | CMD:184。既定停止、summary-tracker testあり | |
| `sound` | on/off | CMD:195。既定on、sound-player testあり | |
| `theme` | path/show/reset/reload/validate | CMD:205。theme testあり | |
| `layout` | path/reset/reload/validate | CMD:218。display-layout/repl-layout testあり | |
| `mute` | duration / off | CMD:230 | |
| `fold` | 上位N観測点 / off | CMD:240。既定無制限 | |
| `limit` | key N/default/reset | CMD:250。11種類の省略上限 | |
| `test` | sound level、table type/番号 | CMD:261。専用operation-handler testあり | |
| `clear` | 端末画面clear | CMD:277 | |
| `backup` | EEW副回線 on/off | CMD:282。既定off | |
| `retry` | 手動WS再接続 | CMD:292 | |
| `display` | status/on/off | CMD:298。専用operation-handler testあり | |
| `volcanorepair` | status/accept/clear/acknowledge-domain/rest | CMD:308–322 | |
| `quit` | 終了 | CMD:324 | |
| `exit` | quit alias | CMD:329 | |

`volcanorepair` の内部実装をそのまま移植することは要求しない。採用する場合は、復旧不足の確認・明示解決という機能を、新しいU-Vと移行契約で実現する。

### 11.4 DSL・統計・整形・display補助

| 機能 | 現行の内容 | 根拠・材料 | 裁定 |
|---|---|---|---|
| filter論理式 | and/or/not、括弧、truthy | `filter/parser.ts:23–68` | |
| filter比較 | `= != < <= > >= ~ !~ in contains` | `filter/types.ts:53` | |
| filter型検査 | field、alias、enum rank、配列、未知field検出 | `filter/field-registry.ts:97–169`、専用test群 | |
| filter特殊値 | M/深さのsemantic、予想震度safety rank | `filter/field-registry.ts:124–140` | |
| template構文 | path、literal、if/else、filter chain | `template/parser.ts:57–110` | |
| template filter | default/truncate/pad/date/replace/upper/lower | `template/filters.ts:5–13` | |
| template表示専用制限 | raw参照・配列index禁止、joinなし、改行結合の制限 | `template/parser.ts:174`、`template/filters.ts:22` | |
| normal/compact整形 | フルframe／一行要約 | CMD:132 | |
| CLI focus dim | 条件非一致だけ薄いcompact | README:162 | |
| CLI night | 彩度・輝度低下、危険色維持 | README:24、night-overlay test | |
| カスタムtheme | palette/role、再読込み | CMD:205 | |
| カスタムdisplay-layout | CLI表示block構成 | CMD:218 | |
| 観測点fold | 件数制限 | CMD:240 | |
| テキスト省略limit | 地震解説・南海・火山・洪水等11項目 | `config.ts:191–204` | |
| VPWP50端末詳細幅 | standard120、wide160、entry8行、全体60行 | `types.ts:470–473` | |
| 統計 | 分野件数、EEWイベント数、震度内訳 | `statistics-formatter.test.ts:166–182` | |
| 定期要約・sparkline | 分bucket、30slot、最大値 | `summary-tracker.test.ts:54–143` | |
| 当日地震履歴 | display off中も更新 | `display-sink.ts:92–93` | |
| EEWログファイル | 続報・差分・取消・特殊値 | `eew-logger.test.ts:95–640` | |
| 待機tips | interval設定、表示 | CMD:123、`types.ts:413` | |
| 地震の再表示／再放送 | 既存card関連機能。操作範囲の追加棚卸しが必要 | `quake-replay-card.test.ts`あり、挙動全体未確認 | |
| 津波chip再放送 | clickで低優先tickerへ、受理と独立 | `App.svelte:115–158`、`tsunami-replay.ts:2–4` | |
| browser dim | localStorageに希望を保存、警報中の実効値と分離 | `dim.svelte.ts:1–31` | |
| browser reduced-motion | 動きを軽減。周期停止とは別 | `display-design-system.md:310` | |
| 起動時update check | npm、失敗時GitHub、24時間cache、無効化env | README:231 | |
| lowmem起動 | `--optimize-for-size` | `package.json:20–22` | |
| studio補助起動 | root scriptsにbackend/studioあり | `package.json:34–35`。利用・全機能未確認 | |

filter公開fieldも採否対象に含める。

```text
domain, type/headType, subType, classification, id, infoType,
frameLevel/level,
isCancellation/isCancelled, isWarning, isFinal, isTest, isRenotification,
eventId, serial, volcanoCode, volcanoName,
hypocenterName/hypocenter, depth, magnitude/mag,
maxInt, maxLgInt, forecastMaxInt, forecastMaxIntSafetyRank, alertLevel,
title, controlTitle, headline,
areaNames, forecastAreaNames, municipalityNames, observationNames,
areaCount, tsunamiKinds
```

旧REPLの「focus」と新displayのカードフォーカスは別の機能だ。名前が同じでも設定を流用しない。

### 11.5 採否後の扱い

- 互換必須: 入出力例・設定移行・エラー・副作用を契約化する。
- 廃止可: UI、help、設定key、文書、関連コードを一緒に除く。
- 代替機能へ統合: 旧操作から新操作への対応と、意味差を明示する。
- 未決: 実装済みとしない。必要ならP3/P4の該当契約を待機させる。

`notify all:off` と `sound off` は旧築のhandoff操作として使用するため、新築側Q7の採否と無関係に切替手順へ残る。

## 12. personal限定機能の扱い

### 12.1 確認済みと未確認

確認済み:

- mainには処理後の汎用`outcomeTaps`がある。
- 同期callbackで、suppressedの入力は含まれない。
- これを完全なraw記録として扱えない。

根拠: `src/engine/messages/message-router.ts:703`。

入力上の確定事項:

- personalのevents JSONは処理後射影。
- raw原文や完全な配信metadata・受信順を保持する記録ではない。
- events JSON、exploration、REPL拡張は切替条件に含む。

未確認:

- personalの実装、全schema、全コマンド、読込み側、保持設定。
- 最新overlayの差分全体。
- 新築と組み合わせた実性能。

根拠: `agenda-v2.md:207`（Vault Artifacts/2026-09-10-fleq-reconstruction-agenda-v2.md）。

### 12.2 main の拡張点と公開結果

main は既に要求されている処理結果購読・query・typed command の境界だけを持つ。events JSON・exploration の名前、保存先、schema 変換、専用分岐を main に置かない。

公開結果は runtime が採用した結果から B10 が射影する。consumer が reducer の状態や戻り値を直接受け取る構造にしない。

```ts
type PublicValue =
  | null | boolean | number | string
  | readonly PublicValue[]
  | { readonly [key: string]: PublicValue };

type OutcomePersistence = Readonly<{
  kind: "saved" | "pending" | "failed" | "uncertain";
  currentGeneration: number;
  savedGeneration: number | null;
}>;

type PublishedOutcome =
  | Readonly<{
      kind: "accepted";
      change: "semantic" | "revisionOnly" | "deliveryOnly";
      subjects: readonly SubjectOutcome[];
    }>
  | Readonly<{
      kind: "batchCompleted";
      reason: "deadline" | "interrupted" | "shutdown";
      subjects: readonly SubjectOutcome[];
    }>
  | Readonly<{
      kind: "deadlineApplied";
      subjects: readonly SubjectOutcome[];
    }>
  | Readonly<{
      kind: "recoveryApplied";
      scope: readonly string[];
      coverage: readonly string[];
      subjects: readonly SubjectOutcome[];
    }>;

type SubjectOutcome = Readonly<{
  subject: string;
  informationType: string;
  transition: string;
  severity: string | null;
  source: ReportRef | null;
  facts: Readonly<Record<string, PublicValue>>;
  changedFields: readonly string[];
}>;

type OutcomeEnvelope = Readonly<{
  schemaVersion: number;
  outcomeId: string;
  runId: string;
  causeId: string;
  inputSequence: number | null;
  receivedAt: number | null;
  decidedAt: number;
  unit: UnitId;
  unitRevision: number;
  persistence: OutcomePersistence;
  outcome: PublishedOutcome;
}>;

type ConsumerResult =
  | Readonly<{ kind: "consumed" }>
  | Readonly<{ kind: "skipped"; reason: string }>
  | Readonly<{ kind: "failed"; reason: string }>;

type OutcomeConsumer = Readonly<{
  id: string;
  timeoutMs: number;
  maxPendingItems: number;
  maxPendingBytes: number;
  consume: (
    outcome: OutcomeEnvelope,
    signal: AbortSignal
  ) => Promise<ConsumerResult>;
}>;
```

`PublicValue` は任意の状態 object を通す抜け道ではない。各 `I-U-*` が `informationType／transition／severity／facts／changedFields` の許可値と schema を固定し、境界で検査する。有限数でない number、関数、Map、内部 class、raw XML、未宣言 field は拒否する。全単位に共通しない facts の巨大な共通 class は作らない。

公開時点は次に固定する。

| runtime 結果 | 購読への公開 |
|---|---|
| live の `changed` | 採用後に `accepted` 一件。subject ごとの事実・変更 field を含む |
| `unchanged／rejected` | 通常 outcome は出さず、reason を診断へ出す |
| batch の待機開始・中間追加 | 出さない |
| batch 終了 | 採用後に `batchCompleted` 一件 |
| 業務期限による変更 | `deadlineApplied` 一件 |
| recovery の途中 | 出さない |
| recovery の採用 | `recoveryApplied` 一件 |
| 保存 ack・保存失敗だけ | 業務 outcome を再発行しない。保存状態 query・診断を更新 |
| 通知結果による deliveryOnly | 新しい runtime 結果として一件。元報の再受理と区別 |

`outcomeId` は `runId` と runtime の公開連番から一意にする。永続的な無欠落台帳ではなく、consumer の欠落追跡用である。期限入力・batch 終了には新しい `causeId` を付け、存在しない電文受信連番を捏造しない。

`persistence` は公開時点の状態であり、後日の保存成功をその envelope に遡及して書き込まない。保存確認が必要な consumer は、公開 query で当該単位の保存世代を確認する。保存対象が変わった outcome は、新しい currentGeneration と未保存状態を記録してから公開する。

公開 query の開始範囲は `getStatus` と `getUnitView(unit)` とする。返すのは公開状態・view の不変 DTO であり、内部 state・codec・任意 filesystem ではない。取得時の単位 revision を付ける。command は §11 で採用した操作の型付き union に限り、未知 command・不正引数を受付前に拒否する。任意関数を worker へ渡す command は作らない。

登録・queue は汎用 port が所有する。consumer ごとの開始上限は 64 件かつ 4 MiB、in-flight 1 件を含む。DTO の一回のサイズ計数を配送先間で再利用し、consumer 数だけ全状態を stringify しない。

電文受理 stack で consumer を呼ばず、後続の配送処理として実行する。Promise・queue・旧 envelope を無制限に増やさない。公開値は state から独立した再帰的 readonly DTO とし、consumer が変更して他の consumer や engine に影響しないことを境界試験で確認する。

personal の実体との互換性は、personal 側で実 schema と利用機能を照合して判定する。main の受入は、汎用の試験 consumer で訂正・取消・batch・期限・復元・最大 payload・保存未完了を受け取り、必要な事実と出典を識別できることとする。

### 12.3 events JSON

personal側で次を実装する。

- 新しいOutcomeEnvelopeから既存利用者向けschemaへの射影。
- 非同期write、保持・回転、byte上限。
- schemaVersionとsource outcome ID。
- 欠落・失敗・未保存の識別。
- 必要な旧schema読込み互換。
- 最大電文とburst時のCPU・I/O測定。

完全入力記録ではなく、採用された処理結果の書出しであることを明示する。無欠落exportが必要かどうかは、その消費側の要求として別に確認する。Q4の通知保証を、そのままexport保証へ拡張しない。

### 12.4 exploration

personal側の消費者として実装する。

- immutableな処理結果、またはpersonalが保有するファイルを読む。
- engineの意味状態を別途再解釈して現在警報の権威にしない。
- 件数・検索範囲・保持期間・計算時間を有界にする。
- 重い集計をengine受理stackへ戻さない。
- exploration用索引の失敗でmainを停止しない。
- 既存の検索・表示・操作の互換範囲はpersonal実体から棚卸しする。

### 12.5 REPL 拡張

main は名前空間付き command の登録口を持ち、コマンド名、help、引数 schema、timeout、handler を宣言する。

- main の予約名・登録済み名との衝突は起動時に拒否する。
- 引数は呼出前に検査し、不正入力で handler を呼ばない。
- handler は §12.2 の公開 query と採用済み typed command を使う。
- state holder、任意 filesystem、内部 codec を能力として貸さない。
- query 結果は版付きの不変 DTO とし、query 時点と command 適用時点が同じだと仮定しない。
- handler の timeout・AbortSignal 無視は §12.7 と同じく隔離・無効化する。同じ handler の実処理を重ねない。
- personal 固有の writer・探索・保存先は personal の composition root で配線する。拡張追加のたびに main へ固有名分岐を足さない。

公開 main の契約試験には汎用名の handler を使い、query、正常 command、不正引数、名前衝突、timeout を確認する。personal の実コマンド互換性は personal 側の契約で検証する。

### 12.6 追加実行単位の扱い

consumerの同期CPUが目標を妨げる場合は、まずpayload・射影・処理量を減らす。それでも成立しなければ、personal側の専用consumer実行単位を四点契約付きで再設計する。

これはP2の大型XML parse分離とは別の判断だ。`async`にしたという理由だけで隔離済みとせず、未達のpersonal機能を残して切替を通さない。


### 12.7 consumer の timeout・隔離・終了

consumer の一試行 timeout は登録時の必須宣言値とし、開始値は暫定 5 秒、abort 後の完了確認猶予は暫定 1 秒とする。B10 担当と consumer 担当が P3 の接続契約前に固定する。

- timeout・終了要求で AbortSignal を通知し、その試行の結果を無効化する。
- 猶予内に実処理が完了した場合は timeout 欠落を記録し、次の項目へ進める。
- **AbortSignal を無視して完了しない場合は、その consumer を隔離・無効化する。次を呼んで実処理を重ねない。**
- 無効化時は待機項目を排出せず、未配送として欠落を記録して解放する。以後の公開結果も欠落数へ加える。
- 失効した試行の遅い成功・失敗で、consumer を再有効化したり欠落を成功へ書き換えたりしない。
- 再有効化は、旧処理の停止・完了を確認した後の明示操作または再起動だけとする。自動再起動 loop は作らない。

欠落は consumer ごとに reason 別件数と、最初・最後の outcome ID、時刻を記録する。範囲内の全件が欠落したと証明できない場合は「欠落を含む範囲」と書く。無限の欠落 ID リストは持たない。queue full、timeout、reject、disabled、shutdown を区別する。

通常終了で consumer の完了を無限に待たない。未配送を記録し、engine の最終保存を妨げない。consumer の成果物を engine checkpoint と原子的に commit する保証は付けない。

同じ event loop を同期 CPU で占有する consumer は、timer や AbortSignal 自体を動かせなくする。この場合は隔離できたと主張せず、§12.6 の性能不合格として扱う。同期処理量を減らしても満たせないと実測された場合だけ、personal 側の専用実行単位を検討する。

## 13. フェーズ計画 P0〜P6

| Phase | 成果物 | 機械的に確認する受入条件 |
|---|---|---|
| P0 契約・境界・oracle | 本spec、route表、単位表、corpus manifest、機能採否、比較形式 | 21routeの未対応0、全257fixtureの分類行あり、全系列に期待根拠あり、Q13の未処理横断0、未決事項にownerと期限あり |
| P1 パーサ境界 | 純粋な資材型、decode済み入力、診断結果、七区間計測 | 全XMLの期待差分が分類済み、一入力一回decode/展開/full parse、特殊値・空白・属性・先頭ゼロ保持、旧engine/ui依存0、入力上限検査 |
| P2 最小縦断 | EEW＋VPWS50＋VPWP50、runtime、mailbox、checkpoint、通知intent、最小SSE/Chrome表示 | O02/O04/O06/O07/O09/O10の対象系列成功、194periodを保持、無変化tick0仕事、Q2=B、rename成否不明解決、EEW250ms判定、A/Bを確定 |
| P3 意味・出力・移行 | 残りの意味モジュール、旧v2移行、採用CLI/DSL、personal配線 | 全routeの正常/取消/復元がoracleを通る、一入力一保存単位、必須機能の契約テスト成功、移行直後の続報成功、通知・export故障隔離 |
| **P4：display・GIS・実操作** | 完全 snapshot と分野別容量縮退・版付き詳細、全面地図と半透明カード、最大重大度・共有色、2 層地図と県フォーカス、4 種の器、詳細 overlay、ページドット、受信・手動 camera 調停、EEW／津波と同時発生、LOD・区域名、Chrome 検収記録 | **着手前に Q5-a・Q5-b・Q7 と残る display 仕様案の採用値を固定する。** T1〜T3・F01=A・F08=A・ページ送り／ドットは裁定済みとして実装する。§9.4.1 D-AC01〜D-AC24 の fixture・実操作・性能証拠を揃え、§9.8 の display 関連台帳 ID を追跡する。容量超過中の別分野取消、版付き詳細の更新競合、最大重大度の取消、通常／片側／同時の全ページ到達、ドット手動停止、手動 camera 保護、津波中の全体図固定を必須系列に含める。旧モックの件数要約を全件表示実績に数えない。未裁定・未実測・目視未検収を Pass に含めない。 |
| P5 並走検収 | 固定比較、独立購読照合、Pi72時間、開発機Chrome実表示 | 未分類の重大差分0、資源ゲート内、旧系非退行、personal有効時EEW目標、入力停止で排出、保存復帰、切断復帰 |
| P6 切替・rollback | 実行手順、表示・通知handoff、warm rollback、運用記録 | 新築単独の必須機能、旧state非変更、通知設定反映、rollback実走、版・hash・未確認事項が記録済み |

### 13.1 P0の未決と進行

P0は、未決事項を消して見せるphaseではない。

- Q5未決でもP1/P2を進められる。
- Q7未決でもパーサ・保存・EEW基本経路を進められる。
- 採否未決機能の作り直しや削除は確定しない。
- Q5はP4本契約前、Q7は該当P3/P4契約前に解決する。
- 最終切替では未決を残さない。

### 13.2 P1のトークン実費

P1を最初の費用測定単位にする。

記録するもの:

- 作業契約IDと基準版。
- 実装、独立レビュー、修正、配送、再検証の各工程。
- 実際に表示・取得できたinput/output/cached token。
- モデル、試行回数、再作業理由。
- 人手修正量、意味的手直しの有無。
- 実測できない使用量は未計測として別記。

一工程のtokenだけで1サイクルの費用としない。P1の実費からP3以降の係数を更新する。両案のLOC見積もりの平均を、確定費用へ置き換えない。

根拠: `agenda-v2.md:162`（Vault Artifacts/2026-09-10-fleq-reconstruction-agenda-v2.md）。

### 13.3 一保存単位を閉じる条件

実装の完結単位は `I-U-*` とする。個別意味モジュールの純関数は先行検証できるが、次の統合境界を閉じずに多数の未接続部品を積まない。

```text
単位入力・複数subject方針
→ 個別意味関数
→ 組立てreduceUnit
→ persisted型・唯一のcodec
→ toView・intent・PublishedOutcome
→ 期限・batch・取消
→ 保存障害・通常終了
→ 復元直後の続報
→ 履歴oracle・構造条件
```

各単位契約には先行契約 ID、担当、凍結版、受入 ID を記す。共有型が未定なら、それに依存しない純関数までを作業範囲とする。未決の意味を実装者が推測で埋めて完成扱いしない。

P2 は対象単位の統合契約・§7.5 の測定 manifest・保存と終了契約を先に固定する。P3 は残る単位を一つずつ閉じ、最後に全 route の正常・取消・復元と共有資源の契約を検証する。

通常終了、consumer 隔離、復元副作用、観測 sink は後日の運用補足へ送らず、対応単位・基盤契約の受入に含める。

### 13.4 検証の報告

コード実装では、対象のbuildとtestを必須にする。永続化・共有状態・module scopeを触る契約はshuffleも必須とする。

- Pass: 実行して合格したもの。
- Fail: 実行して不合格のもの。
- Blocked: 必要な検証を実行できないもの。
- N/A: 当該契約に該当しないもの。
- 未確認: 未測定・未実行・実体不在。

本書起草のbuild/testは、read-only起草契約により未実行・対象外だ。実装時の完了条件を免除するものではない。

## 14. 新築の AGENTS.md 案

以下を `reconstruction/AGENTS.md` の本文案とする。

````markdown
# AGENTS.md — FlEq reconstruction

## 第一原則

シンプルで堅牢。
型で守る。
足す前に引く。

意味の正しさ、不確実性の明示、継続運転、有界資源、検証可能性を
必須制約にする。その中で状態所有者・同期条件・例外経路が少ない案を選ぶ。

## 要求の優先順位

1. ユーザーの最新の明示指示・裁定。
2. 採用済みP0 specと、その後の裁定記録。
3. 固定版の意味仕様・根拠付きoracle。
4. この作業契約。
5. 旧実装・旧文書。

旧実装と一致するだけで正しいと判断しない。
新出力をそのままgoldenへ書いて正解を作らない。

## 状態と境界

- state参照を交換するのはruntimeだけ。
- reducerは純関数。I/O、logger、通知、Date.now、timer生成をしない。
- gate/current/tombstone/必要履歴/intentを定義済み保存単位に収める。
- 別の権威あるcurrent storeを作らない。
- display、CLI、personal consumerへ可変stateを貸さない。
- persisted型、runtime型、wire型を分ける。
- durable/non-durableはfamily/slice契約で固定する。
- EEW currentはnon-durable。intent保存からcurrentを復活させない。
- parse済み入力を必須にし、optional引数で検証を迂回させない。
- 新runtimeから旧engine/uiをimportしない。
- 旧reader・移行・比較adapterはtools/test側だけに置く。

## 停止条件

次の兆候が出たら、該当する仕組みの実装を止め、契約と入力例を添えて報告する。

1. stateとは別に、正しい現在状態を持つstoreを増やす。
2. 変化検出のために全stateをstringifyする。
3. 複数JSONファイルのcommit journalやmanifestを自作し始める。
4. workerやMessagePortのqueue量を数えられない。
5. 表示が収まるまでDOM計測と候補生成を反復する。
6. 同じ電文を別の副作用のために再parseする。
7. freshnessを確認せず、最後の画面を正常表示として保持する。
8. 旧新差分を原因未確認のまま新goldenに更新する。
9. 「asyncにした」「上限がある」「型が通る」だけで
   性能・正しさを検収する。

停止は、根拠のない追加機構を作らないためのもの。
既に裁定されたQ2=BやP2条件付きparse分離を、再承認待ちに戻さない。
無関係な読解・fixture整理・許可済み検証は継続してよい。

## 仕組みを足す前の四点

1. 無いと壊れる具体的な契約。
2. それを示す入力例。
3. 最小の実装と、より小さい代替を採れない理由。
4. 将来削除できる条件。

変更説明には、増える状態と故障経路も記載する。
「将来役立ちそう」「念のため」だけを理由に追加しない。


## 最小実装・最小テスト

- 型・層・抽象・設定・helper を足す前に「無いと何が壊れるか」を一行で示す。既存の型・関数・標準機能で満たせるなら再利用する。
- 一実装だけのための interface、一製品だけの factory、変わらない値の利用者設定化、将来用の拡張点は作らない。境界の入出力を定める型や、実際に複数の採用 consumer が使う契約とは区別する。
- テストの目的は、受入条件、契約境界、実不具合の再発防止、corpus 履歴のいずれかに限る。
- 内部構造を写すテスト、同じ分岐を言い換えたテスト、private helper の形を固定するだけのテストは作らない。
- 一振る舞いにつき一テストを基本とし、値の違いは同じテストの表形式入力へまとめる。独立した故障境界や実機証拠を一つに潰す意味ではない。
- 追加した各テストについて「テストID → 対応する受入条件・境界・不具合・履歴ID」を成果物に一行で書く。対応を説明できない追加テストは除く。
- build・型検査・既定の必要検証を減らす口実にしない。実機が必要な受入を unit test の増量で代替しない。

## 入力・保存・通知

- 入力、queue、state、history、intent、wireに件数・byte上限を持つ。
- queue上限にはin-flightを含める。
- unknown、empty、missing、range、qualitative、0を区別する。
- 取消・期限切れ・正常empty・unavailableを区別する。
- 保存不能時は最新表示を続け、未保存を明示する。
- 保存ackで、より新しいメモリstateを上書きしない。
- rename後ack前の成否不明を成功・失敗のどちらかへ推測で倒さない。
- 通知intentは期限付きで発生元保存単位へ同居させる。
- 重複は許容し、exactly-onceを主張しない。
- raw XMLやtokenを通常log、公開artifact、browser bundleへ混入させない。

## display

- 地図を主領域全面に敷き、半透明の左右カード列を重ねる。発令中・現在有効な情報だけを載せ、あふれは通常・片側・同時発生ともページ送りとクリック可能なドットで扱う。
- 器は通常・見出し・伸縮・テロップの 4 種。見出しは 48px の帯 1 本、通常は採用 profile の宣言高。詳細は別の宣言高で被せる。津波 T1〜T3・「今すぐ避難！」、同時発生時の EEW 宣言高と右列残余の見出し表示を守る。
- 地図は区域ごとの最大重大度を描き、カードと意味色トークンを共有する。容量縮退分野は最小事実と省略状態を明示し、詳細を版付きで取得する。他分野と接続・保存・復元状態を欠落させない。
- scene がページ・手動停止・県フォーカス・camera 所有・受信演出を管理する。周期フォーカスは作らず、通常受信で既存の手動 camera を奪わない。津波中は全体図固定を優先する。
- codeとGIS体系で区域を結合し、名称から推測しない。
- hidden shelf、反復solver、全ページhidden mountを作らない。
- metadataだけでページ滞在・詳細の開閉・camera を初期化しない（周期フォーカスは存在しない）。
- 実paintの検収をDOM更新やrAF callbackだけで代用しない。

## public / personal

- mainは汎用の型付き拡張口だけを持つ。
- events JSON writer、exploration、personal REPL配線はpersonal側に置く。
- 拡張は非同期・有界にし、受理stateのcommit条件にしない。
- async関数内の同期CPU処理が隔離されたとはみなさない。
- personal必須機能未検収のまま切替完了と報告しない。

## 作業開始

実装契約ではbase_oid一致とclean treeを確認する。
不一致をfetch/reset/stash等で修正しない。

read-only契約では、契約に指定された開始条件とgit禁止を優先する。
read-only起草に実装用clean-tree条件を自動適用しない。

## 探索・変更範囲

- read_pathsとallowed_pathsを守る。
- 他checkout、ユーザープロファイル、global設定、認証情報を探索しない。
- 範囲外の問題は変更せず、根拠付きで報告する。
- package.json / lockfile / CI変更は専用契約でのみ行う。

## 検証

- 実装は対象buildとtestを成功させる。
- 永続化・共有状態・module scope変更ではshuffleを実行する。
- test用型検査も対象契約に従って実行する。
- 履歴oracleは初期状態・入力順・時計・設定を固定する。
- 実機目標を単体testの成功で代用しない。
- 実行不能はblocked。N/AやPassに置き換えない。
- 原因未確認のgolden更新をしない。

## gitと成果物

履歴操作・統合は統合担当が行う。
commit/push/fetch/merge/rebase/cherry-pick/reset/branch/tag/add/
restore/switch/stash/clean/worktree/configは禁止。

許可する読取りgit操作も作業契約に列挙する。
read-only契約でgit禁止なら実行しない。

実装成果物:
- allowed_pathsに限定したbinary-safe patch。新規fileも漏らさない。
- 変更file一覧。
- 実行commandと結果。
- 未実行検証と理由。
- 仕様差分、残存リスク、未確認事項。

配送・公開・統合は、その作業契約で明示された担当が行う。
````

停止条件の出典: `plan-chatgpt.md:841`（Vault To-Claude/FlEq_Reconstruction_Simple_Robust_2026-09-10.md）。四点の出典: `plan-hertz.md:40`（Vault To-Claude/2026-09-10-Astra_Codex_max_reconstruction.md）。

### 14.1 作業契約の型

```ts
interface ReconstructionWorkContract {
  contractId: string;
  mode: "read-only" | "implementation";
  objective: string;

  baseOid: string;
  cleanTreeRequired: boolean;
  readPaths: readonly string[];
  allowedPaths: readonly string[];
  allowedGitCommands: readonly string[];

  moduleIds: readonly string[];
  integrationContractIds: readonly string[];
  dependsOnContractIds: readonly string[];
  publicTypes: readonly string[];
  publicFunctions: readonly string[];
  allowedDependencies: readonly string[];

  fixtureIds: readonly string[];
  sequenceIds: readonly string[];
  expectedDecisions: readonly ExpectedDecision[];
  expectationEvidence: readonly EvidenceRef[];

  semanticDeadlines: readonly DeadlineContract[];
  deliveryDeadlines: readonly DeadlineContract[];
  retentionLimits: readonly RetentionContract[];
  resourceLimits: readonly ResourceLimit[];
  workDeadline: string | null;

  persistenceUnits: readonly UnitId[];
  persistedFields: readonly string[];
  nonPersistedFields: readonly string[];

  outOfScope: readonly string[];
  acceptanceChecks: readonly AcceptanceCheck[];
  testMapping: readonly {
    testId: string;
    purpose:
      | "acceptance"
      | "contractBoundary"
      | "regression"
      | "corpusHistory";
    referenceIds: readonly string[];
    behavior: string;
  }[];
  requiredCommands: readonly CommandSpec[];
  artifactRequirements: readonly string[];

  unresolvedQuestions: readonly {
    id: string;
    owner: "user" | "implementer" | "integrator" | "personal";
    blocks: readonly string[];
    resolveBy: string;
    requiredEvidence: readonly string[];
  }[];
}
```

`integrationContractIds` は対象の `I-U-*`、`dependsOnContractIds` は先行して凍結が必要な契約を指す。保存単位を触る実装契約で統合契約 ID を省略しない。

`testMapping` は追加・変更するテストごとに一行を持ち、`behavior` に確認する一振る舞いを書く。同じ目的の重複テストを増やさず、fixture の追加だけなら対応する既存テスト ID を記す。read-only 作業でテスト追加がない場合は空配列とする。

`resolveBy` は日付または明確な契約開始前・判定前の milestone とする。「後で」「P3」だけではなく、どの作業を開始するまでかを記す。未決によって変わる意味を実装者が埋めず、依存しない作業だけを先行できるよう `blocks` を具体化する。

## 15. 未決事項と起草で見つかった問い

### 15.1 ご主人の裁定が必要な項目

J1〜J3 は裁定済みのため、この表から外す。

| ID | 未決事項 | 推奨 A／代案 B | 裁定期限 |
|---|---|---|---|
| Q5-a | 必須掲載と器の割当 | **A：§8.5 の通常 214px・見出し 48px（帯 1 本）・伸縮・テロップの割当を製品要件にする。** B：割当・常設対象を変更する。未記載の種別・段階も含めて完結させる。 | P4 着手前 |
| Q5-b | 自動ページ送りの一巡上限 | **A：あふれ時の自動送りを最長 60 秒。** B：最長 120 秒。あふれをページ送りしクリック可能なドットを置くこと自体は裁定済み。§8.5.5 の手動停止・明示再開案、各ページの最小読取時間と最大対象数を合わせて裁定する。周期フォーカスは採用しない。 | P4 着手前 |
| Q7 | 現行機能の互換必須／廃止可 | §11 の各行について **A：互換必須** ／ B：廃止可。空欄を黙示の廃止にしない。 | P4 着手前 |

T1〜T3 は 2026-09-10 21:45 に裁定済み（§8.7.2）。

### 15.2 実装・検証で解決する問い

| ID | 問い | 必要な証拠・決める内容 | 解決期限 |
|---|---|---|---|
| N1 | Pi の filesystem で保存の成否不明をどう判定するか | file／directory sync、rename 前後の障害注入、再読込による世代判定 | P2・P5 |
| N2 | REST で回復できる範囲はどこまでか | 契約・権限・種別・取得期間・欠落検出の実証。未対応を回復済みにしない | 対象範囲は各 P3 単位契約前、実 API の権限・coverage 証拠は P5 前（§10.5） |
| N3 | 各 GIS の正規入力・利用条件・coverage は揃うか | archive、hash、区域体系、再生成手順、津波予報区を含む欠損一覧 | P4 |
| N4 | 公開物へ含められる資材の境界は何か | main／personal の source・bundle・npm pack・artifact を含む配送検査 | 公開前 |
| N5 | 最大正規入力と同時発生時の容量開始値は足りるか | corpus の byte 数・展開量・queue・snapshot・checkpoint・RSS | P1〜P5 |
| N6 | Pi 受信時刻と Chrome 実 paint をどの精度で対応付けられるか | 時計誤差、trace、対応 ID、測定不確かさ | 測定方法は P2 A/B 判定前に凍結、最終構成は P5 前に再確認（§7.5） |
| N7 | parse 分離 B が必要か | 大型 XML 直後 EEW の O9。§7 の移行条件に従う | P2 |
| N8 | 旧 v2 と補助保存物の移行入力に整合した切り口を作れるか | 読み取り専用コピーの世代・時刻・相互参照検査。不明部分の移行報告 | P3 |
| N9 | 新旧の依存・build・CI・配送をどう分離するか | `reconstruction/` 専用 target、旧成果物の非上書き、公開物の検査 | P1 |
| N10 | 再放送・studio 等の実際の外部契約は何か | コマンド・docs・tests・使用側の棚卸し。Q7 と混同せず材料を出す | 対象機能の実装契約前 |
| N11 | 未保存中の取消を再起動で失った場合、回復限界をどう運用表示するか | 回復可能範囲、last-known 表示、確認手順、rollback 手順 | P5・P6 |
| N12 | 全体図用・zoom 用の間引き率をいくつにするか | 元形状との比較、境界・島・細部、点数・byte 数、層切替と操作性能。率は層別に固定する | P4 GIS 契約で候補固定、P4 検収で確定 |
| N13 | SVG／Canvas／WebGL のどれを採るか | 同じ資材・viewport・DPR で paint、操作、hit test、境界品質、保守範囲を比較する | P4 |
| N14 | 区域名テーブルと県所属対応をどう生成するか | 元 GIS 属性・コード表の出典、code/name/所属 schema、47 県・1,892 区域の照合、名称不明の扱い | P4 GIS 契約前 |
| N15 | wheel・pan・離島 inset の camera 規則をどう固定するか | §8.6・§8.8 の手動所有保護・津波固定を前提に、層切替閾値・zoom 上下限・drag 範囲・EEW 退避復帰案の採用値と遷移 fixture を固定する | P4 scene 契約前 |
| N16 | 操作・受信演出・ページ timer の調停案をどう確定するか | §8.5.5 のドット手動停止・明示再開、§8.6 の線 1 本・詳細所有・6 秒起点、§8.8 の camera 優先順位を採否決定し、同時発火・取消・古い timeout の期待遷移を固定する | P4 scene 契約前 |
| N17 | 器・詳細・緊急大カード・ページ予約をどう固定するか | 全種別割当、正確なモック事象 ID・viewport、時計とドット予約、EEW 宣言高、同時発生時の最小残余、詳細内部分割、伸縮行高、最大件数での全対象到達を宣言値だけで検証する | Q5 裁定後、P4 component 契約前 |
| N18 | 正規津波予報区 GIS をどう線へ加工するか | 裁定済み T1〜T3 を前提に、予報区境界・海岸区間・島・複数区間・警報種別を対応させる。県輪郭代用との差を検証する | P4 GIS 契約前 |

Q13 の「複数保存単位の同時 commit が必要な例が残るか」は §4 の結論を維持し、未決事項へ戻さない。

### 15.3 personal側で必要な追加材料

| ID | 必要な確認 | 切替への影響 |
|---|---|---|
| PERS-1 | events JSONの全field、読込み側、schema互換 | 未確認のままexport互換をPassにしない |
| PERS-2 | explorationの全操作・保持・性能・依存 | mainのみ完成しても切替不可 |
| PERS-3 | personal REPLコマンド一覧と副作用 | §11とは別に同じ形式の採否・契約表を作る |
| PERS-4 | consumer queue満杯時に許される欠落と再生成方法 | mainの受理を止めずに成立する保証を定義 |
| PERS-5 | personalの同期CPUがEEWを妨げないか | 実配線でO09/O10を通す |

このcheckoutには実体がないため、今回の確認済み事項には含めない。

### 15.4 最終表示端末

Q6として、最終的なviewport、DPR、zoom、画面サイズ、視聴距離を確定する。

現時点では開発機Chromeを検収端末とする。PiのブラウザRSSを予算へ加えたり、Piの描画性能を測定済みとしたりしない。将来Piへブラウザを置く場合は、追加の端末・資源検収となる。

### 15.5 根拠の更新で修正した点

- 両案の旧Node780 MB前提を採らず、提示された161 MBを並走開始時の基準にした。
- 両案・旧文書の「全体保存4 MiB」をそのまま採らず、現物の16 MiBを確認した。新築では単位別予算へ分ける。
- RFの`durable`だけで保存分類せず、地震・速報の別経路の保存を取り込んだ。
- VPNO50→気象状態、VPOA50→速報状態の横断を保存単位へ収めた。
- 津波観測を一律EventID単位にせず、現物のVTSE51/52独立familyとstation identityを保持した。
- `source:"repo"`を原本証明として扱わない。
- card中心の旧提案を、中央地図と左右固定列へ置き換えた。
- 保存待ちで受理を止める経路を、Q2=Bに従う単一更新担当と非同期checkpointへ統合した。
- EEW currentのnon-durableと、Q4によるintent保存を分離して明文化した。

本書に記した性能値、容量開始値、新しい保存・表示・通知契約は仕様案だ。build/test、fault injection、実paint、Pi並走、personal実配線による検収は今後の各phaseで行う。

### 15.6 改訂差分（2026-09-10 夜、ヘルツ）

- J1＝A、J2＝B、J3＝A を裁定済みに変更した。Q5-a・Q5-b・Q7 は保留を維持した。
- 周期フォーカスと空カードを廃止し、全面地図・半透明カード・右下時計の構成へ変更した。
- ホバーを縁取り・名札・線 1 本に限定し、高さを変えない契約へ変更した。クリックで詳細を開閉する。
- 詳細を他カードへ重ね、列の並びを保つ契約にした。宣言高さによる下端補正と、隠れるカードの減光を追加した。
- 通常 214px・見出し 48px（帯 1 本）・伸縮・テロップの器と、あふれ時だけ最長 60 秒で巡回する推奨案を追加した。
- 受信時の flash→zoom→自動詳細→初期 6 秒後の復帰と、古い timeout の無効化を追加した。
- EEW の猶予秒を除き、震度 3 以上の全区域を収める zoom を明記した。
- 都道府県／市区町村の 2 層、県フォーカス、wheel・drag、LOD・描画品質・区域名生成の要件を追加した。
- 見出しの container／on／band と下辺の基準 4px 帯を継承し、縦リボンを不採用とした。
- 津波の左列大カード・海岸線表示・EEW 同時表示を未裁定の叩き台として追加し、3 点の裁定を §15.1 に分離した。
- display の構造検査と P4 受入条件を更新した。最終端末未定・開発機 Chrome 検収という §15.4 の条件は変更していない。
- （Liebe 反映）津波の T1〜T3 と避難文言・右ペインへの寄せを 2026-09-10 21:45 の裁定で確定に変更し、§8.7.2・§9.4.1・§15.1 を更新した。
- （Liebe 反映 22:05）見出しの器を 96px から帯 1 本 48px（本文なし・最上階級だけを 1 行）へ変更し、片側に寄せた状態の「全部見出し → 空きが許す限り上位から通常へ戻す」規則と、直近の地震の見出し化を §8.7.2 に追記した。


- （2026-09-11、display 改訂）独立レビュー（gpt-6-astra xhigh）の F01・F06〜F10・F19 を反映。ご主人裁定 F01=A（snapshot 超過は分野別に最小事実へ縮退・版付き個別取得）、F08=A（EEW 宣言高＋右列残余の見出し）、ページ送りの統一（「ほか N 件」撤回・クリック可能なドット）。§8.1〜8.8・§9.4 を差し替え、§9.8（台帳 36 項目対応表）を新設、§0.1・§0.2・§1.3・§3.5・§13・§14・§15 の旧記述を同期。
- （2026-09-11、engine 契約改訂）F02〜F05・F11〜F18 を反映。SSE／worker／意味鮮度の監視、履歴復元の副作用抑止、通知 timeout と EEW 優先、通常終了と最終保存確認、保存 3 秒境界、U-* 統合契約、公開 outcome・consumer 隔離を具体化した。
- EEW の P2 A/B 測定プロトコルを §7.5、性能・構造・Pi 資源の共通試験条件と判定式を §9.9 に集約した。経験的閾値は暫定とし、正式試験前の凍結担当・時期を指定した。
- §14 に最小実装・最小テストの規則を追加し、§14.1 に統合契約・先行依存・テスト対応表・未決事項の解決期限を追加した。
- 本改訂は契約文の補完であり、実装・build・test・実機検収の完了を意味しない。
- （2026-09-11 深夜、v3.1）同スレッドの scoped 再レビュー R01〜R13 を Liebe が反映。詳細の版束縛を対象分野の内容版へ緩和（R01）、U-E／U-T 縮退中の緊急表示維持（R02）、通常終了の期限凍結 `finalizationAt`（R03）、自動詳細の取得待機上限 5 秒（R04）、outcome の保存状態の順序（R05）、復元候補の照合を UnitState 参照へ（R06）、E06／E07／E18 の判定式（R07）、replay の副作用条件（R08）、P2 母集団の循環除去（R09）、`freshnessSuspect`（R10）、索引の同期（R11〜R13）。
