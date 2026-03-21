# UI モジュール仕様書

`src/ui/` 配下の8ファイルについて、設計・API・内部ロジックを記述する。

---

## formatter.ts

### 概要

共通表示ユーティリティモジュール。フレーム描画プリミティブ、テキスト処理、設定キャッシュ等を提供する。電文タイプ別の `display*` 関数は `eew-formatter.ts`, `earthquake-formatter.ts`, `volcano-formatter.ts` に分割されており、本ファイルには共通関数のみ残る。すべての表示を `FrameLevel` に基づく色・罫線スタイルで統一する。表示モード (`normal` / `compact`) による出力切り替え、フレーム幅のキャッシュ管理、CJK 文字を考慮した視覚幅計算も担う。

chalk による色付けは直接ハードコードせず、`theme.ts` のロールシステム経由で解決する設計とし、カラーカスタマイズに対応している。

**配信区分別のフォーマッタ分割構成:**
| ファイル | 内容 |
|---------|------|
| `formatter.ts` | 共通ユーティリティ (フレーム描画・テキスト処理・設定キャッシュ) |
| `eew-formatter.ts` | EEW 表示 (`displayEewInfo`) |
| `earthquake-formatter.ts` | 地震・津波・テキスト・南海トラフ・長周期 表示 |
| `volcano-formatter.ts` | 火山 表示 (`displayVolcanoInfo`) |

### エクスポートAPI

#### 設定キャッシュ操作

| シグネチャ | 説明 |
|---|---|
| `setFrameWidth(width: number): void` | フレーム幅を固定値に設定する。REPL の `tablewidth` コマンドから呼ばれる |
| `clearFrameWidth(): void` | フレーム幅を自動モード (ターミナル幅追従) に戻す |
| `setInfoFullText(value: boolean): void` | テキスト系電文の全文表示フラグを設定する |
| `getInfoFullText(): boolean` | `infoFullText` の現在値を返す |
| `setDisplayMode(mode: DisplayMode): void` | 表示モード (`"normal"` / `"compact"`) を設定する |
| `getDisplayMode(): DisplayMode` | 現在の表示モードを返す |
| `setMaxObservations(value: number \| null): void` | 観測点の最大表示件数を設定する (`null` で全件表示) |
| `getMaxObservations(): number \| null` | 観測点最大表示件数の現在値を返す |
| `setTruncation(value: TruncationLimits): void` | 省略表示の上限設定を更新する。REPL の `limit` コマンドから呼ばれる |
| `getTruncation(): TruncationLimits` | 省略表示上限の現在値を返す |

#### ユーティリティ

| シグネチャ | 説明 |
|---|---|
| `visualWidth(str: string): number` | ANSI エスケープ除去後の視覚的幅を計算。CJK 文字は幅 2 |
| `visualPadEnd(str: string, targetWidth: number): string` | 視覚幅を考慮したスペースパディング (`padEnd` の全角対応版) |
| `wrapFrameLines(level: FrameLevel, content: string, width: number, indent?: number): string[]` | フレーム内でコンテンツを折り返し、frameLine 付きの文字列配列を返す |
| `wrapTextLines(text: string, maxWidth: number): string[]` | テキストを文字単位で折り返す (フレーム装飾なし) |
| `collectHighlightSpans(line: string, rules: readonly HighlightRule[]): HighlightSpan[]` | テキスト行からキーワード強調の適用区間を収集する |
| `highlightAndWrap(line: string, rules: readonly HighlightRule[], maxWidth: number): string[]` | キーワード強調を適用しつつ折り返し済みの行配列を返す |
| `formatTimestamp(isoStr: string): string` | ISO 文字列を `"YYYY-MM-DD HH:MM:SS"` に整形 |
| `formatElapsedTime(ms: number): string` | ミリ秒を `"HH:MM:SS"` 形式に整形 |
| `intensityColor(intensity: string): chalk.Chalk` | 震度文字列に対応する chalk スタイルを返す (テーマロール経由) |
| `lgIntensityColor(lgInt: string): chalk.Chalk` | 長周期地震動階級に対応する chalk スタイルを返す |

#### 表示関数

| シグネチャ | 対応電文 | 説明 |
|---|---|---|
| `displayRawHeader(msg: WsDataMessage): void` | (フォールバック) | パース未対応電文のヘッダ簡易表示 |

**注:** `displayEarthquakeInfo`, `displayEewInfo`, `displayTsunamiInfo` 等の電文タイプ別表示関数は、それぞれ `earthquake-formatter.ts`, `eew-formatter.ts` に分割移動済み。火山電文の `displayVolcanoInfo` は `volcano-formatter.ts` に定義。

#### 型

| 名前 | 説明 |
|---|---|
| `EewDisplayContext` | EEW 表示時のコンテキスト。`activeCount` (同時発生件数)、`diff?: EewDiff` (前回との差分)、`colorIndex?: number` (バナー色インデックス) |

### 内部ロジック

#### FrameLevel による表示制御

`FrameLevel` は `"critical"` / `"warning"` / `"normal"` / `"info"` / `"cancel"` の 5 段階。各レベルが罫線文字セット (`FrameChars`) と色ロール (`FRAME_ROLE_MAP`) に対応する。

- `critical` / `warning`: 二重線 (`╔═╗`) を使用
- `normal` / `info` / `cancel`: 通常線 (`┌─┐`) を使用

各電文タイプごとにフレームレベル判定関数がある:

- `earthquakeFrameLevel`: 震度 6弱以上 → critical、震度 4 以上 → warning、取消 → cancel
- `eewFrameLevel`: 警報 → critical、取消 → cancel、予報 → warning
- `tsunamiFrameLevel`: 大津波警報 → critical、津波警報 → warning、取消 → cancel
- `nankaiTroughFrameLevel`: コード `120` → critical、`130`/`111`-`113`/`210`/`219` → warning、`190`/`200` → info
- `lgObservationFrameLevel`: LgInt4 → critical、LgInt3 → warning、LgInt2 → normal、その他 → info

#### フレーム描画

4 つのプリミティブ関数でフレームを構成する:
- `frameTop(level, width)` — 上辺
- `frameLine(level, content, width)` — コンテンツ行 (視覚幅でパディング)
- `frameDivider(level, width)` — セクション区切り
- `frameBottom(level, width)` — 下辺

フレーム幅は `getFrameWidth()` で決定。キャッシュ値があればそれを使い、なければ `process.stdout.columns` に追従する (下限 40、上限 200、フォールバック 60)。

#### コンパクトモード

`cachedDisplayMode === "compact"` の場合、各 `display*` 関数はフレーム描画をスキップし、1 行サマリー (`[レベルラベル]  電文種別  震源  規模  震度` 形式) を出力して早期 return する。

#### テーブル描画

`renderFrameTable()` はフレーム内にカラム区切りテーブルを描画する。津波情報で `width >= WIDE_TABLE_THRESHOLD (80)` の場合に使用される。カラム幅はヘッダ・データの最大視覚幅から自動計算し、合計がフレーム内幅を超える場合は最終カラムを縮小する。

#### 折り返し

`wrapFrameLines()` はカンマ+スペース / 日本語句読点 (`、`) / パイプ区切り (`│`) を基準にソフト折り返しを試み、分割できない場合は `wrapTextLines()` による文字単位ハード折り返しにフォールバックする。

#### EEW バナー

EEW 表示は通常のフレームの上にバナー (3 行の背景色付きブロック) を描画する。`colorIndex` により警報用 5 色 / 予報用 5 色のパレットから色を選択し、同時発生する複数 EEW を色で識別可能にする。PLUM 法の場合はバナーの装飾行 (1 行目・3 行目) に専用スタイルを適用する。

#### 本文キーワード強調

テキスト系電文と南海トラフ情報の本文表示で、重要キーワードをハイライト表示する機能。`HighlightRule` と `HighlightSpan` の2つの内部インターフェースで構成される。

```ts
interface HighlightRule {
  source: string;            // 正規表現のソース文字列
  flags: string;             // 正規表現のフラグ
  style: () => chalk.Chalk;  // 遅延評価のスタイル (テーマ再読込対応)
}

interface HighlightSpan {
  start: number;  // 文字インデックス開始位置
  end: number;    // 文字インデックス終了位置
  style: chalk.Chalk;
}
```

ルール定数:

| 定数名 | 対象電文 | 主なパターン |
|---|---|---|
| `NANKAI_COMMON_RULES` | 南海トラフ全般 | 巨大地震警戒・注意、マグニチュード、調査中/終了 等 |
| `NANKAI_VYSE52_EXTRA_RULES` | VYSE52 追加 | ゆっくりすべり、特段の変化なし |
| `SEISMIC_TEXT_RULES` | テキスト系 | 活発、最大マグニチュード、最大震度、防災上の留意事項 |

`collectHighlightSpans()` は行内の全ルールをマッチし、重複区間を排除（同一開始位置では長いマッチ優先）した上でソート済みの `HighlightSpan[]` を返す。`highlightAndWrap()` はまず平文で折り返し、各行の文字オフセットを追跡しながらスパンの ANSI スタイルを適用する。

`displaySeismicTextInfo()` と `displayNankaiTroughInfo()` が本文表示時にこれらの関数を使用する。

#### セキュリティ

外部由来の文字列は `sanitizeForTerminal()` で ANSI エスケープと制御文字 (改行・タブ以外) を除去してからターミナルに出力する。`displayRawHeader()` など、電文ヘッダをそのまま表示する箇所で使用する。

### 依存関係

- **インポート元**: `chalk`, `../types` (パース済み電文型, `DisplayMode`, `WsDataMessage`), `../engine/eew/eew-tracker` (`EewDiff` 型), `../logger`, `./theme` (ロール色の解決)
- **接続先**: `engine/messages/message-router.ts` から各 `display*` 関数が呼ばれる。`ui/repl.ts` から設定キャッシュ操作関数・ユーティリティ関数が呼ばれる

### 設計ノート

- 色のハードコードを避け、すべて `theme.getRoleChalk()` 経由とすることで、`theme.json` によるカスタマイズを実現している。
- 表示状態 (フレーム幅・表示モード・全文表示フラグ・観測点最大表示件数) はモジュールレベル変数でキャッシュし、各 `display*` 関数が引数なしで参照できるようにしている。これはパフォーマンスと API 簡潔性のトレードオフ。
- `FrameLevel` を全電文タイプ共通の抽象レベルとすることで、フレーム描画コードの重複を排除している。
- **レンダーバッファ**: 6つの `display*` 関数は `createRenderBuffer()` で行をバッファに蓄積し、`flushWithRecap()` で一括出力する。TTY かつ行数がターミナル高さを超える場合、フレーム下部直前に「▼ サマリー」セクション (タイトル行・カード行・ヘッドライン1行目) を再掲する。非TTY や行数が十分少ない場合はそのまま出力する。
- **観測点折りたたみ**: `cachedMaxObservations` が非 `null` の場合、震度一覧・予測震度一覧・津波予報/観測/推定・長周期地域リストの表示件数を制限し、超過分を「... 他 XX 地点」として表示する。REPL の `fold` コマンドまたは `fleq config set maxObservations` で設定する。
- `visualWidth()` は独自実装で Unicode コードポイント範囲を判定する。`wcwidth` 等の外部ライブラリを使わないことで依存を最小化している。

---

## repl.ts

### 概要

WebSocket 監視中にユーザーが対話的にコマンドを入力できる REPL (Read-Eval-Print Loop) モジュール。`readline` インターフェースの管理、プロンプト表示 (接続状態・経過時間の動的更新)、コマンドのディスパッチ、待機中ヒント表示のスケジューリングを担う。

設定変更系コマンド (`tablewidth`, `mode`, `notify` 等) は変更を即座に `formatter.ts` のキャッシュ・Notifier・EewEventLogger に反映し、同時に Config ファイルに永続化する。

### エクスポートAPI

#### ReplHandler クラス

```typescript
class ReplHandler {
  constructor(
    config: AppConfig,
    wsManager: WebSocketManager,
    notifier: Notifier,
    eewLogger: EewEventLogger,
    onQuit: () => void | Promise<void>,
    statusProviders?: PromptStatusProvider[],
    detailProviders?: DetailProvider[],
  )

  start(): void
  stop(): void
  refreshPrompt(): void
  setConnected(connected: boolean): void
  beforeDisplayMessage(): void
  afterDisplayMessage(): void
}
```

| メソッド | 説明 |
|---|---|
| `start()` | REPL を開始する。readline インターフェース作成、ログフック登録、ステータスタイマー (1 秒間隔) 開始 |
| `stop()` | REPL を停止する。タイマー停止、readline クローズ、ログフック解除 |
| `refreshPrompt()` | コマンド実行中でなければプロンプトを再描画する |
| `setConnected(connected: boolean)` | WebSocket 接続状態をプロンプトに反映する |
| `beforeDisplayMessage()` | 電文表示前に入力行をクリアし、プロンプト行を消去する |
| `afterDisplayMessage()` | 電文表示後に受信時刻を更新し、ヒントスケジュールをリセットし、プロンプトを再描画する |

### 内部ロジック

#### StatusLine クラス

プロンプト文字列を組み立てる内部クラス。以下の状態を管理する:

- `pulseOn`: 1 秒ごとにトグルし、接続中は `●` / `○` の点滅でヘルスを示す
- `connectedAt` / `lastMessageTime`: 経過時間計算用のタイムスタンプ
- `clockMode`: `"elapsed"` (経過時間) / `"clock"` (現在時刻) の表示切替

プロンプト形式: `FlEq [● HH:MM:SS | <ステータス> | ping in Ns]> `
- 未接続時: `FlEq [○ --:--:--]> `
- ping までの残り秒数は `wsManager.getStatus().heartbeatDeadlineAt` から算出
- ステータスセグメント: `PromptStatusProvider` から動的に収集し、`priority` 順 (昇順) で `|` 区切り表示。津波警報発令中は `津波警報` 等がテーマロール色付きで挿入される

#### コマンドシステム

コマンドは `Record<string, CommandEntry>` で登録される。各 `CommandEntry` は以下を持つ:

```typescript
interface CommandEntry {
  description: string
  detail?: string
  category: CommandCategory  // "info" | "status" | "settings" | "operation"
  handler: (args: string) => void | Promise<void>
}
```

登録コマンド一覧:

| コマンド | カテゴリ | 概要 |
|---|---|---|
| `help` / `?` | info | コマンド一覧・詳細表示 |
| `history` | info | dmdata.jp API から地震履歴を取得・テーブル表示 |
| `colors` | info | CUD パレット・震度色・フレームレベル色の一覧表示 |
| `detail` | info | 直近の津波情報を再表示 (`detail` / `detail tsunami`) |
| `status` | status | WebSocket 接続状態・SocketID・再接続試行回数の表示 |
| `config` | status | Config ファイルの設定一覧 |
| `contract` | status | dmdata.jp の契約区分一覧 (API 呼び出し) |
| `socket` | status | dmdata.jp のソケット一覧 (API 呼び出し) |
| `notify` | settings | カテゴリ別通知設定の表示・切替 |
| `eewlog` | settings | EEW ログ記録の ON/OFF・記録項目の管理 |
| `tablewidth` | settings | テーブル幅の表示・変更 (40-200 / auto) |
| `infotext` | settings | テキスト電文の全文/省略切替 |
| `tipinterval` | settings | 待機中ヒント間隔の変更 (0-1440 分) |
| `mode` | settings | 表示モード切替 (normal / compact) |
| `clock` | settings | プロンプト時計の切替 (elapsed / now) |
| `sound` | settings | 通知音の ON/OFF |
| `theme` | settings | カラーテーマの表示・管理 (path / show / reset / reload / validate) |
| `mute` | settings | 通知の一時ミュート (時間指定) |
| `fold` | settings | 観測点の表示件数制限 (`fold <N>`: 上位N件, `fold off`: 全件表示) |
| `limit` | settings | 省略表示上限の確認・変更 (`limit <key> <N>` / `limit <key> default` / `limit reset`) |
| `test` | operation | テスト機能 (`test sound [level]`: サウンドテスト、`test table [type] [番号]`: 表示形式テスト) |
| `clear` | operation | ターミナル画面クリア |
| `retry` | operation | WebSocket 手動再接続 |
| `quit` / `exit` | operation | アプリケーション終了 |

#### コマンドディスパッチ

`line` イベントで入力を空白分割し、先頭をコマンド名として `resolveCommand()` でハンドラを解決する。コマンド名の大文字小文字は区別しない (case-insensitive)。未知のコマンドにはレーベンシュタイン距離 (距離 2 以内) で typo 候補を提示する。

##### コマンド短縮形 (エイリアス)

長いコマンド名には短縮形が定義されており、`COMMAND_ALIASES` マップで管理する:

| コマンド | 短縮形 |
|---|---|
| history | hist |
| colors | cols |
| detail | det |
| status | stat |
| config | conf |
| contract | cont |
| socket | sock |
| notify | noti |
| eewlog | ewlg |
| tablewidth | tw |
| infotext | itxt |
| tipinterval | tint |
| sound | snd |
| theme | thm |
| backup | bkup |
| limit | lim |
| clear | cls |

##### 通知カテゴリ短縮形

`notify` コマンドのカテゴリ名にも短縮形がある (`CATEGORY_ALIASES`):

| カテゴリ | 短縮形 |
|---|---|
| earthquake | eq |
| tsunami | tsu |
| seismicText | st |
| nankaiTrough | nt |
| lgObservation | lgob |

`all:on` / `all:off` にも短縮形 `aon` / `aoff` がある。

##### test table 電文タイプ短縮形

`test table` の電文タイプ名にも同様の短縮形がある (`TABLE_TYPE_ALIASES`): `eq`, `tsu`, `st`, `nt`, `lgob`。

すべてのサブコマンド引数 (`on`/`off`/`full`/`short`/`normal`/`compact`/`elapsed`/`now`/`auto` 等) も大文字小文字を区別しない。

ハンドラが Promise を返す場合は `.catch()` + `.finally()` で非同期完了を待ち、完了後にプロンプトを再描画する。

#### 待機中ヒント

`maybeShowWaitingTip()` は 1 秒ごとのタイマー内で呼ばれ、以下の条件をすべて満たすときにヒントを表示する:

1. REPL が動作中 (`this.rl` あり)、コマンド実行中でない
2. `tipIntervalMs > 0` かつ `nextTipAt` に到達
3. WebSocket 接続中
4. 最終受信から 10 秒以上経過

ヒントは `WAITING_TIPS` 配列をラウンドロビンで表示する。初期インデックスはランダム。

#### 設定変更の永続化パターン

設定変更コマンド (`tablewidth`, `mode`, `notify` 等) は以下の 3 ステップで処理する:

1. ランタイム状態 (`this.config` + formatter/notifier/eewLogger) を即座に更新
2. `loadConfig()` で現在の Config ファイルを読み込み
3. 変更項目を上書きして `saveConfig()` で書き戻す

#### help コマンドの現在値表示

`getCurrentSettingValues()` が各設定コマンドの現在値と設定可能な値を `Record<string, { current, options? }>` で返す。`help` コマンド一覧の各行末に `[現在値] (選択肢)` を付与する。

#### ログフック連携

`start()` 時に `setLogPrefixBuilder()` と `setLogHooks()` を登録する。ログ出力前にプロンプト行をクリアし、出力後に再描画することで、ログとプロンプトの表示が衝突しないようにする。

### 依存関係

- **インポート元**: `readline`, `chalk`, `../types` (`AppConfig`, `DisplayMode`, `PromptClock`, `NotifyCategory`, `EewLogField`), `../dmdata/ws-client` (`WebSocketManager`), `../dmdata/rest-client` (`listEarthquakes`, `listContracts`, `listSockets`), `../config` (`loadConfig`, `saveConfig`, `printConfig`, `VALID_EEW_LOG_FIELDS`), `../engine/notification/notifier` (`Notifier`, `NOTIFY_CATEGORY_LABELS`), `../engine/eew/eew-logger` (`EewEventLogger`), `../engine/notification/sound-player` (`playSound`, `isSoundLevel`, `SOUND_LEVELS`), `./formatter` (設定キャッシュ操作・ユーティリティ), `./test-samples` (`TEST_TABLES`), `./theme` (テーマアクセサ), `../logger` (`setLogPrefixBuilder`, `setLogHooks`), `./waiting-tips` (`WAITING_TIPS`)
- **接続先**: `engine/monitor/monitor.ts` から dynamic import で生成・`start()` / `stop()` / `setConnected()` / `beforeDisplayMessage()` / `afterDisplayMessage()` が呼ばれる

### 設計ノート

- `ReplHandler` は状態を持つクラスとして実装されている。readline、タイマー、接続状態など複数の状態を管理するため、クロージャよりクラスが見通しやすい。
- `clearInput()` は readline 内部の `line` / `cursor` プロパティを直接書き換える。公開 API にはバッファクリア手段がないための回避策。
- 設定変更は「即座にランタイムに反映 + Config ファイルに永続化」の 2 段階にしており、アプリ再起動なしで設定が反映される。
- `beforeDisplayMessage()` / `afterDisplayMessage()` の対で電文表示を挟むことで、入力中テキストの消失やプロンプトの二重描画を防いでいる。

---

## waiting-tips.ts

### 概要

REPL 待機中に定期表示するヒントメッセージの定義ファイル。コマンドの使い方、防災知識、ツールの仕組み、歴史的地震・津波、今後想定される地震に関するヒントを `string[]` 配列として提供する。

ロジックは一切持たず、純粋なデータ定義のみを担う。表示制御は `repl.ts` の `maybeShowWaitingTip()` が行う。

### エクスポートAPI

| シグネチャ | 説明 |
|---|---|
| `const WAITING_TIPS: string[]` | ヒントメッセージの配列 (228 件)。各要素は `"Tip: ..."` 形式の文字列 |

### 内部ロジック

ロジックなし。配列リテラルのみ。

ヒントは以下のカテゴリに分類される (コメントで区切り):

| カテゴリ | 内容 |
|---|---|
| コマンド基本 | 各 REPL コマンドの基本的な使い方 |
| コマンド応用 | コマンドの応用テクニック・組み合わせ |
| 防災知識 | 地震・津波発生時の行動指針、備蓄、避難 |
| ツールの仕組み | FlEq の内部動作・電文処理の解説 |
| 地震・津波の雑学 | 震度・マグニチュード・津波の科学的知識 |
| 歴史的大地震・津波（日本） | 日本の歴史的地震事例 (貞観地震から能登半島地震まで) |
| 歴史的大地震・津波（世界） | 世界の歴史的地震事例 (リスボン地震からトルコ・シリア地震まで) |
| 今後想定される地震 | 南海トラフ地震、首都直下地震、日本海溝・千島海溝沿い地震等の想定 |

### 依存関係

- **インポート元**: なし
- **接続先**: `ui/repl.ts` が `WAITING_TIPS` をインポートして使用

### 設計ノート

- ロジックとデータを分離することで、ヒント文言の追加・編集が容易になっている。
- 配列のインデックスはランダム起点でラウンドロビン表示されるため、並び順は表示順と一致しない。

---

## theme.ts

### 概要

ターミナル表示の色をカスタマイズ可能にするテーマシステム。CUD (カラーユニバーサルデザイン) 推奨の 9 色パレットをデフォルトとし、ユーザーが `theme.json` でパレット色の上書きやロール (セマンティックな色割り当て) のカスタマイズを行える。

2 層構造を採用している:
1. **パレット層**: 9 色の RGB 値を名前で管理 (`PaletteColorName`)
2. **ロール層**: UI 要素ごとのスタイル定義。パレット名または HEX 値で色を参照 (`RoleName`)

テーマファイルからの読み込み時はバリデーションと警告出力を行い、不正な値はデフォルトにフォールバックする堅牢な設計。

### エクスポートAPI

#### 型

| 名前 | 定義 | 説明 |
|---|---|---|
| `PaletteColorName` | `"gray" \| "sky" \| "blue" \| "blueGreen" \| "yellow" \| "orange" \| "vermillion" \| "raspberry" \| "darkRed"` | パレット色名 (CUD 9 色) |
| `RgbTuple` | `readonly [number, number, number]` | RGB タプル |
| `RoleStyleDef` | `string \| { bg?: string; fg?: string; bold?: boolean }` | ロールスタイル定義 (ファイル形式)。文字列の場合は前景色のみ |
| `ResolvedStyle` | `{ fg?: RgbTuple; bg?: RgbTuple; bold: boolean }` | 解決済みスタイル |
| `ThemeFile` | `{ palette?: Partial<Record<string, string>>; roles?: Partial<Record<string, RoleStyleDef>> }` | テーマファイルの構造 |
| `ResolvedTheme` | `{ palette: Record<PaletteColorName, RgbTuple>; roles: Record<RoleName, ResolvedStyle> }` | 解決済みテーマ |
| `RoleName` | `keyof typeof DEFAULT_ROLES` | ロール名の型 (60+ 種のユニオン) |

#### 定数

| 名前 | 説明 |
|---|---|
| `DEFAULT_PALETTE: Record<PaletteColorName, RgbTuple>` | CUD 推奨色のデフォルト RGB 値 |
| `DEFAULT_ROLES` | 全ロールのデフォルトスタイル定義。フレーム色・震度色・長周期階級色・マグニチュード色・津波色・EEW バナー色・南海トラフ色・共通色を含む |

#### ユーティリティ関数

| シグネチャ | 説明 |
|---|---|
| `hexToRgb(hex: string): RgbTuple \| null` | `"#RRGGBB"` → RGB タプル。不正なら `null` |
| `rgbToHex(rgb: RgbTuple): string` | RGB タプル → `"#RRGGBB"` |

#### テーマ解決

| シグネチャ | 説明 |
|---|---|
| `resolveTheme(raw: ThemeFile, defaults): { theme: ResolvedTheme; warnings: string[] }` | 純粋関数。`ThemeFile` とデフォルト値からテーマを解決し、警告リストを返す |

#### テーマ I/O

| シグネチャ | 説明 |
|---|---|
| `getThemePath(): string` | `theme.json` のパスを返す (OS 別 Config ディレクトリ配下) |
| `loadTheme(): string[]` | `theme.json` を読み込み、キャッシュを更新する。警告リストを返す |
| `loadThemeFromPath(themePath: string): string[]` | パス指定でテーマを読み込む (テスト用) |
| `reloadTheme(): string[]` | テーマを再読込する |
| `resetTheme(): string[]` | デフォルト `theme.json` を書き出してリロードする |
| `validateThemeFile(): { valid: boolean; warnings: string[] }` | `theme.json` を検証し問題点を返す |
| `generateDefaultThemeJson(): string` | デフォルト `theme.json` の JSON 文字列を生成する |

#### テーマアクセサ

| シグネチャ | 説明 |
|---|---|
| `getPalette(): Record<PaletteColorName, RgbTuple>` | 解決済みパレットを返す |
| `getRole(name: RoleName): ResolvedStyle` | 指定ロールの解決済みスタイルを返す |
| `getRoleChalk(name: RoleName): chalk.Chalk` | ロール名に対応する `chalk.Chalk` インスタンスを返す (キャッシュ付き) |
| `isCustomized(): boolean` | `theme.json` が存在するか (カスタマイズ中か) |
| `getResolvedTheme(): ResolvedTheme` | 解決済みテーマ全体を返す |
| `getRoleNames(): RoleName[]` | 全ロール名の一覧を返す |
| `getPaletteNames(): PaletteColorName[]` | 全パレット色名の一覧を返す |

### 内部ロジック

#### テーマ解決フロー

1. `loadTheme()` / `loadThemeFromPath()` がファイルを読み込み、JSON パースする
2. `sanitizeThemeInput()` で `palette` / `roles` のトップレベル構造をバリデーション
3. `resolveTheme()` でパレット → ロールの順に解決:
   - パレット: ユーザー指定の HEX 値を `hexToRgb()` で検証し、デフォルトにマージ
   - ロール: 各ロールの `RoleStyleDef` を `resolveRoleStyle()` で `ResolvedStyle` に変換。色参照はパレット名ルックアップ → HEX パースの順で解決
4. 解決結果を `deepFreezeTheme()` でイミュータブルにし、`currentTheme` に格納

#### 色参照の解決

`resolveColorRef()` は文字列を以下の順で解決する:

1. パレット名に一致 → 対応する RGB タプルを返す
2. `#` で始まる → HEX パースを試行
3. いずれにも該当しない → 警告メッセージ付きで `null`

#### エラー耐性

- JSON パースエラー、ファイル読み込みエラー、不正な値はすべて警告リストに記録し、デフォルトにフォールバックする
- ロール単位でフォールバックするため、一部のロールが不正でも他のロールは正常に適用される
- 未知のキー (`palette` / `roles` ともに) は警告を出して無視する

#### chalk キャッシュ

`getRoleChalk()` は `chalk.level` とロール名をキーとするキャッシュ (`Map<string, chalk.Chalk>`) を持つ。テーマ再読込時にキャッシュをクリアする。`chalk.level` をキーに含めるのは、chalk v4 では `bgRgb()` 呼び出し時点の `level` で ANSI コードが確定するため。

#### ロール定義の構造

`DEFAULT_ROLES` は以下のグループでロールを定義する (合計 60 以上):

| グループ | ロール例 | 説明 |
|---|---|---|
| frame | `frameCritical`, `frameWarning`, `frameNormal`, `frameInfo`, `frameCancel` | フレーム罫線色 |
| intensity | `intensity1` 〜 `intensity7` | 震度色 (9 段階) |
| lgIntensity | `lgInt0` 〜 `lgInt4` | 長周期地震動階級色 (5 段階) |
| magnitude | `magnitudeLow`, `magnitudeHigh`, `magnitudeMax` | マグニチュード色 |
| tsunami | `tsunamiNone`, `tsunamiAdvisory`, `tsunamiWarning`, `tsunamiMajor` | 津波警報レベル色 |
| eew | `eewWarningBanner`, `eewForecastBanner`, `eewCancelBanner`, `plumLabel`, `arrivedLabel`, `cancelText` | EEW 表示色 |
| eew banner palette | `eewWarningBanner1`-`4`, `eewForecastBanner1`-`4` | 同時発生 EEW の色分けパレット |
| plum decor | `plumDecorWarning`, `plumDecorForecast` | PLUM 法バナー装飾色 |
| common | `testBadge`, `hypocenter`, `concurrent`, `nextAdvisory`, `warningComment`, `detailUri`, `textMuted` | 共通 UI 要素色 |
| nankai trough | `nankaiCriticalBanner`, `nankaiWarningBanner`, `nankaiSerialCritical`, `nankaiSerialWarning` | 南海トラフ情報色 |
| raw header | `rawHeaderLabel` | フォールバック表示色 |

### 依存関係

- **インポート元**: `fs`, `path`, `chalk`, `../config` (`getConfigDir`), `../logger`
- **接続先**: `ui/formatter.ts` が `getRoleChalk()` / `getRole()` 等を呼んで表示色を取得する。`ui/repl.ts` が `theme` サブコマンドで I/O 関数・アクセサを呼ぶ

### 設計ノート

- パレット + ロールの 2 層構造により、パレットの 1 色を変更するだけで関連するすべてのロールに波及する。たとえば `vermillion` の RGB を変えれば、震度 6弱・フレーム critical・EEW 警報バナー等がすべて連動する。
- `resolveTheme()` は純粋関数として実装され、副作用のないテスト容易な設計。モジュール状態 (`currentTheme`) への書き込みは `loadTheme*()` 系関数が担う。
- `deepFreezeTheme()` でテーマオブジェクトをフリーズすることで、意図しない変更を防止している。
- CUD 推奨色をデフォルトに採用することで、色覚特性に関わらず情報を区別しやすい配色を実現している。

---

## test-samples.ts

### 概要

REPL の `test table` コマンド用のテストデータとディスパッチマップを定義するモジュール。6種の電文タイプそれぞれについて複数のバリエーション（通常・警報・取消・PLUM法等）を提供し、番号指定で個別のバリエーションを表示できる。テストフィクスチャ XML からの動的読み込みとハードコード済みフォールバックデータの二段構えで、フィクスチャ不在環境でも動作する。

### エクスポートAPI

#### 型

| 名前 | 説明 |
|---|---|
| `TestTableVariant` | テストバリエーション定義 (`label: string`, `run: () => void`) |
| `TestTableEntry` | テスト表示エントリ (`label: string`, `variants: TestTableVariant[]`) |

#### 定数

| 名前 | 型 | 説明 |
|---|---|---|
| `SAMPLE_EARTHQUAKE` | `ParsedEarthquakeInfo` | 地震情報のデフォルトサンプル (震度7・critical) |
| `SAMPLE_EEW` | `ParsedEewInfo` | EEW のデフォルトサンプル (予報) |
| `SAMPLE_TSUNAMI` | `ParsedTsunamiInfo` | 津波情報のデフォルトサンプル (津波警報) |
| `SAMPLE_SEISMIC_TEXT` | `ParsedSeismicTextInfo` | テキスト系電文のデフォルトサンプル |
| `SAMPLE_NANKAI_TROUGH` | `ParsedNankaiTroughInfo` | 南海トラフ情報のデフォルトサンプル (コード120・調査中) |
| `SAMPLE_LG_OBSERVATION` | `ParsedLgObservationInfo` | 長周期地震動のデフォルトサンプル (階級4) |
| `TEST_TABLES` | `Record<string, TestTableEntry>` | テスト表示ディスパッチマップ |

#### TEST_TABLES のバリエーション

| キー | バリエーション数 | 内容 |
|---|---|---|
| `earthquake` | 6 | 震度7 / 震度4(warning) / 取消 / 遠地地震 / 震度速報 / 長周期階級付き |
| `eew` | 5 | 予報 / 警報(critical) / 取消 / PLUM法 / 最終報 |
| `tsunami` | 6 | 津波警報 / 大津波警報(critical) / 津波注意報 / 取消 / 観測情報 / 沖合観測 |
| `seismicText` | 2 | 通常発表 / 取消 |
| `nankaiTrough` | 3 | 調査中(critical) / 巨大地震注意(warning) / 調査終了(info) |
| `lgObservation` | 3 | 階級4(critical) / 階級3(warning) / 階級2(normal) |

### 内部ロジック

#### フィクスチャ読み込み

`loadFixture(filename)` は `test/fixtures/` ディレクトリから XML ファイルを読み込み、gzip 圧縮 + base64 エンコードして `WsDataMessage` を構築する。ファイル名から電文タイプ (`VXSE43` 等) と分類 (`eew.warning` 等) を自動推定する。`test/fixtures/selected_xml/` サブディレクトリもフォールバック先として探索する。

`fromFixture<T>(filename, parser)` はジェネリックなラッパーで、フィクスチャ読み込み + パースを一括で行い、失敗時は `null` を返す。電文タイプごとに `earthquakeFromFixture()`, `eewFromFixture()` 等のヘルパー関数がある。

#### フォールバックサンプル

各バリエーションにはハードコード済みのフォールバック定数（`FALLBACK_EARTHQUAKE_WARNING`, `FALLBACK_EEW_CANCEL` 等、15種以上）が定義されており、フィクスチャが存在しない環境（npm パッケージとしてインストールした場合等）でも `test table` コマンドが動作する。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `fs`, `path`, `zlib` | フィクスチャファイルの読み込み・圧縮 |
| `../types` | パース済み電文型、`WsDataMessage` |
| `./formatter` | 各種 `display*` 表示関数 |
| `../dmdata/telegram-parser` | 各種パース関数 |

### 設計ノート

- フィクスチャ優先 + フォールバックの二段構えにより、開発環境ではリアルな XML データでテストし、配布環境ではハードコードデータで動作保証する。
- 各バリエーションの `run()` は引数なしの `() => void` で統一されており、ディスパッチマップから番号で呼び出すだけの単純な設計。
- `TEST_TABLES` のキーは REPL の `test table <type>` コマンドの引数に対応する (`earthquake`, `eew`, `tsunami`, `seismicText`, `nankaiTrough`, `lgObservation`, `volcano`)。

---

## volcano-formatter.ts

### 概要

火山電文の表示を担当するモジュール。`displayVolcanoInfo()` をエントリポイントとし、5つの電文系統 (alert, eruption, ashfall, text, plume) ごとのレンダラを持つ。`formatter.ts` の共通ユーティリティ (`RenderBuffer`, `frameTop`, `frameLine` 等) と `theme.ts` のロールシステムを利用して、CUD 配色準拠の罫線フレーム表示を行う。

### エクスポートAPI

```ts
function displayVolcanoInfo(
  info: ParsedVolcanoInfo,
  presentation: VolcanoPresentation,
): void
```

`presentation.frameLevel` でフレームのスタイルを決定し、`info.kind` で内部レンダラを振り分ける。`infoType === "取消"` の場合は共通の取消表示を行う。

### 内部ロジック

#### 共通ヘッダー (`renderVolcanoHeader`)

すべてのレンダラの先頭で呼ばれ、以下を描画する:
- タイトル行 (テストモード時は `[TEST]` バッジ付き)
- 火山名 + 報告日時
- ヘッドライン (存在する場合)

#### 電文系統別レンダラ

| 関数 | 対象 kind | 主な表示内容 |
|------|----------|-------------|
| `renderAlert` | alert | レベル・アクション、前回レベル、対象市町村、本文 |
| `renderEruption` | eruption | 噴火速報バナー、現象、火口名、噴煙高度・流向、本文 |
| `renderAshfall` | ashfall | 火口名、噴煙高度、時間帯×地域の降灰予報データ、本文 |
| `renderText` | text | レベル、臨時バッジ、本文 (最大4行 + 省略)、NextAdvisory |
| `renderPlume` | plume | 現象、火口名、噴煙高度・流向、風向データ要約 |

#### テーマロール

15の火山専用テーマロールを使用:
- `volcanoLevel1`〜`volcanoLevel5` — 噴火警戒レベル (5段階)
- `volcanoPhenomenonExplosion/Eruption/Frequent/Possible` — 噴火現象 (4種)
- `volcanoAshfallLight/Moderate/Heavy/Ballistic` — 降灰量 (4段階)
- `volcanoAlertBanner`, `volcanoFlashBanner` — バナー

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `chalk` | テキスト色付け (テーマと併用) |
| `../types` | `ParsedVolcanoInfo` 各種 |
| `./formatter` | `FrameLevel`, `RenderBuffer`, フレーム描画プリミティブ, `formatTimestamp`, `wrapFrameLines` 等 |
| `./theme` | `getRoleChalk`, `RoleName` |
| `../engine/notification/volcano-presentation` | `VolcanoPresentation` |
