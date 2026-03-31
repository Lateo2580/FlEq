# UI モジュール仕様書

`src/ui/` 配下のファイル・3サブディレクトリ（`minimap/`, `repl-handlers/`, `summary/`）について、設計・API・内部ロジックを記述する。

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
| `renderGroupedItemList(options): void` | グループ化されたアイテムリスト (震度一覧等) をフレーム内に描画する |
| `renderSimpleNameList(options): void` | 名前リスト (津波予報区等) をフレーム内に描画する |
| `renderFooter(buf, level, width, event): void` | フレームフッター (URI・ヘッドライン等) を描画する |
| `formatTimestamp(isoStr: string): string` | ISO 文字列を `"YYYY-MM-DD HH:MM:SS"` に整形 |
| `formatElapsedTime(ms: number): string` | ミリ秒を `"HH:MM:SS"` 形式に整形 |
| `formatUptime(ms: number): string` | ミリ秒を `"DDD:HH:MM:SS"` 形式に整形 (未使用ゼロ桁は dim 表示) |
| `intensityColor(intensity: string): chalk.Chalk` | 震度文字列に対応する chalk スタイルを返す (テーマロール経由) |
| `lgIntensityColor(lgInt: string): chalk.Chalk` | 長周期地震動階級に対応する chalk スタイルを返す |

#### 表示関数

| シグネチャ | 対応電文 | 説明 |
|---|---|---|
| `displayRawHeader(msg: WsDataMessage): void` | (フォールバック) | パース未対応電文のヘッダ簡易表示 |

**注:** `displayEarthquakeInfo`, `displayEewInfo`, `displayTsunamiInfo` 等の電文タイプ別表示関数は、それぞれ `earthquake-formatter.ts`, `eew-formatter.ts` に分割移動済み。火山電文の `displayVolcanoInfo` は `volcano-formatter.ts` に定義。

#### 型

| 名前 | 定義場所 | 説明 |
|---|---|---|
| `FrameLevel` | `src/types.ts` で定義、`formatter.ts` が re-export | `"critical" \| "warning" \| "normal" \| "info" \| "cancel"` の 5 段階 |
| `EewDisplayContext` | `src/ui/eew-formatter.ts` で定義 | EEW 表示時のコンテキスト。`activeCount` (同時発生件数)、`diff?: EewDiff` (前回との差分)、`colorIndex?: number` (バナー色インデックス) |

### 内部ロジック

#### FrameLevel による表示制御

`FrameLevel` は `src/types.ts` で定義され、`formatter.ts` が `export type { FrameLevel } from "../types"` で re-export する。`"critical"` / `"warning"` / `"normal"` / `"info"` / `"cancel"` の 5 段階。各レベルが罫線文字セット (`FrameChars`) と色ロール (`FRAME_ROLE_MAP`) に対応する。

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

## display-adapter.ts

### 概要

engine 層の `DisplayCallbacks` インターフェースを実装する UI アダプター。すべての display 関数をここに集約し、engine→ui の逆方向依存を断つ。`monitor.ts` が `createDisplayAdapter()` で生成し、`createMessageHandler()` に `DisplayCallbacks` として注入する。

### エクスポートAPI

```ts
function createDisplayAdapter(): DisplayCallbacks
```

- `createDisplayAdapter()` — `DisplayCallbacks` の実装オブジェクトを返す。

### 内部ロジック

`displayOutcome()` は `outcome.domain` による `switch` 分岐で各ドメインの display 関数を呼び出す:

| domain | 呼び出し先 |
|--------|-----------|
| `eew` | `displayEewInfo(outcome.parsed, { activeCount, diff, colorIndex })` |
| `earthquake` | `displayEarthquakeInfo(outcome.parsed)` |
| `seismicText` | `displaySeismicTextInfo(outcome.parsed)` |
| `lgObservation` | `displayLgObservationInfo(outcome.parsed)` |
| `tsunami` | `displayTsunamiInfo(outcome.parsed)` |
| `nankaiTrough` | `displayNankaiTroughInfo(outcome.parsed)` |
| `raw` | `displayRawHeader(outcome.msg)` |

火山は `VolcanoRouteHandler` が `displayVolcano()` / `displayVolcanoBatch()` を直接呼ぶため、`displayOutcome()` には火山ケースがない。

### 依存関係

| インポート元 | 用途 |
|-------------|------|
| `../engine/messages/display-callbacks` | `DisplayCallbacks` 型 |
| `../engine/presentation/types` | `ProcessOutcome` |
| `../types` | `WsDataMessage`, `ParsedVolcanoInfo` |
| `../engine/notification/volcano-presentation` | `VolcanoPresentation` |
| `../engine/messages/volcano-vfvo53-aggregator` | `Vfvo53BatchItems` |
| `./formatter` | `displayRawHeader`, `getDisplayMode` |
| `./summary` | `renderSummaryLine` |
| `./eew-formatter` | `displayEewInfo` |
| `./earthquake-formatter` | 地震・津波・テキスト・南海トラフ・長周期の表示関数 |
| `./volcano-formatter` | `displayVolcanoInfo`, `displayVolcanoAshfallBatch` |

### 設計ノート

- engine 層の `message-router.ts` が `ui/` を直接 import しないようにするためのアダプター。Dependency Inversion Principle の適用。
- `monitor.ts` が `createDisplayAdapter()` を遅延ロード (`await import(...)`) して生成するため、CLI の軽量コマンド (`config show` 等) では UI モジュールがロードされない。

---

## repl.ts

### 概要

WebSocket 監視中にユーザーが対話的にコマンドを入力できる REPL (Read-Eval-Print Loop) モジュール。`readline` インターフェースの管理、プロンプト表示 (接続状態・経過時間の動的更新)、コマンドのディスパッチ、待機中ヒント表示のスケジューリングを担う。

コマンドハンドラは `repl-handlers/` サブディレクトリに分離されており、本ファイルは約 410 行の REPL 制御コアのみを担う (リファクタリング前は約 2500 行)。`buildContext()` で `ReplContext` を構築し、`buildCommandMap()` に遅延参照として渡す構造。

設定変更系コマンド (`tablewidth`, `mode`, `notify` 等) は変更を即座に `formatter.ts` のキャッシュ・Notifier・EewEventLogger に反映し、同時に Config ファイルに永続化する。

### エクスポートAPI

#### ReplHandler クラス

```typescript
class ReplHandler {
  constructor(
    config: AppConfig,
    wsManager: ConnectionManager,
    notifier: Notifier,
    eewLogger: EewEventLogger,
    onQuit: () => void | Promise<void>,
    stats: TelegramStats,
    statusProviders?: PromptStatusProvider[],
    detailProviders?: DetailProvider[],
    pipelineController?: PipelineController,
    summaryTracker?: SummaryWindowTracker,
  )

  start(): void
  stop(): void
  refreshPrompt(): void
  setConnected(connected: boolean): void
  beforeDisplayMessage(): void
  afterDisplayMessage(): void
  setSummaryTimerControl(control: SummaryTimerControl): void
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

プロンプト文字列を組み立てるクラス。`status-line.ts` に独立モジュールとして分離されている。以下の状態を管理する:

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
| `stats` | info | 電文統計を表示 |
| `colors` | info | CUD パレット・震度色・フレームレベル色の一覧表示 |
| `detail` | info | 直近の津波情報・火山警報状態を再表示 (`detail` / `detail tsunami` / `detail volcano`) |
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
| `filter` | settings | フィルタの表示・設定 (`filter set <expr>` / `filter clear` / `filter test <expr>`) |
| `focus` | settings | focus の表示・設定 (`focus <expr>` / `focus off`) |
| `clock` | settings | プロンプト時計の切替 (elapsed / now) |
| `night` | settings | ナイトモードの切替 (`night on` / `night off`) |
| `summary` | settings | 定期要約の表示・設定 (`summary on [N]` / `summary off` / `summary now`) |
| `sound` | settings | 通知音の ON/OFF |
| `theme` | settings | カラーテーマの表示・管理 (path / show / reset / reload / validate) |
| `mute` | settings | 通知の一時ミュート (時間指定) |
| `fold` | settings | 観測点の表示件数制限 (`fold <N>`: 上位N件, `fold off`: 全件表示) |
| `limit` | settings | 省略表示上限の確認・変更 (`limit <key> <N>` / `limit <key> default` / `limit reset`) |
| `test` | operation | テスト機能 (`test sound [level]`: サウンドテスト、`test table [type] [番号]`: 表示形式テスト) |
| `clear` | operation | ターミナル画面クリア |
| `backup` | operation | EEW副回線の起動/停止 (`backup on` / `backup off`) |
| `retry` | operation | WebSocket 手動再接続 |
| `quit` / `exit` | operation | アプリケーション終了 |

#### コマンドハンドラ構造 (repl-handlers/)

コマンドハンドラは `repl-handlers/` サブディレクトリに分離されている。以下のファイルで構成される:

| ファイル | 責務 |
|---------|------|
| `types.ts` | `CommandEntry`, `CommandCategory`, `SubcommandEntry`, `ReplContext` インターフェースの定義 |
| `command-definitions.ts` | `buildCommandMap()` ファクトリ関数。全コマンド定義を生成する |
| `info-handlers.ts` | 情報表示系コマンド (`help`, `history`, `stats`, `colors`, `detail`) とステータス系コマンド (`status`, `config`, `contract`, `socket`) のハンドラ。`COMMAND_ALIASES`, `CATEGORY_ALIASES`, `resolveCommand()` もここで定義 |
| `settings-handlers.ts` | 設定変更系コマンド (`notify`, `eewlog`, `tablewidth`, `mode`, `filter`, `focus`, `night`, `summary`, `sound`, `theme`, `mute`, `fold`, `limit` 等) のハンドラ |
| `operation-handlers.ts` | 操作系コマンド (`test`, `clear`, `backup`, `retry`, `quit`) のハンドラ |
| `index.ts` | 型と関数の re-export |

##### ReplContext インターフェース

`ReplContext` は `ReplHandler` の内部状態をコマンドハンドラに公開するためのインターフェース。`config`, `wsManager`, `notifier`, `eewLogger`, `statusLine`, `stats`, `pipeline`, `summaryTracker`, `commands` 等のフィールドと、`updateConfig()`, `buildPromptString()`, `stop()`, `resetTipSchedule()` 等のヘルパーメソッドを持つ。`summaryTimerControl`, `filterExpr`, `focusExpr` 等のミュータブルフィールドは getter/setter で双方向同期される。

##### buildCommandMap() ファクトリ関数

`buildCommandMap(getCtx: () => ReplContext)` は全コマンド定義を `Record<string, CommandEntry>` として返すファクトリ関数。`getCtx` は遅延参照されるため、構築時点で `ReplContext` が完成している必要はない。`ReplHandler` のコンストラクタ内で呼ばれ、`this.commands` に格納される。

#### コマンドディスパッチ

`line` イベントで入力を空白分割し、先頭をコマンド名として `resolveCommand()` (`info-handlers.ts` で定義) でハンドラを解決する。コマンド名の大文字小文字は区別しない (case-insensitive)。未知のコマンドには `findSuggestion()` がレーベンシュタイン距離 (距離 2 以内) で typo 候補を提示する。`buildContext()` は `ReplHandler` の内部状態を `ReplContext` インターフェースとして公開し、各ハンドラに渡す。

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

ヒントは `TipShuffler` (デッキベースシャッフル) から `next()` で取得する。カテゴリインターリーブにより同カテゴリ連続を回避し、デッキ消費後は自動再構築する。

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

- **インポート元**: `readline`, `chalk`, `../types` (`AppConfig`, `ConfigFile`, `PromptStatusProvider`, `DetailProvider`), `../dmdata/connection-manager` (`ConnectionManager`), `../config` (`loadConfig`, `saveConfig`), `../engine/notification/notifier` (`Notifier`), `../engine/eew/eew-logger` (`EewEventLogger`), `../engine/filter-template/pipeline` (`FilterTemplatePipeline`), `../engine/messages/telegram-stats` (`TelegramStats`), `../engine/messages/summary-tracker` (`SummaryWindowTracker`), `../engine/monitor/monitor` (`SummaryTimerControl`), `./status-line` (`StatusLine`), `./tip-shuffler` (`TipShuffler`), `./theme` (テーマアクセサ), `../logger` (`setLogPrefixBuilder`, `setLogHooks`), `./repl-handlers/types` (`CommandEntry`, `ReplContext`), `./repl-handlers/info-handlers` (`COMMAND_ALIASES`, `resolveCommand`), `./repl-handlers/command-definitions` (`buildCommandMap`)
- **接続先**: `engine/monitor/monitor.ts` から dynamic import で生成・`start()` / `stop()` / `setConnected()` / `beforeDisplayMessage()` / `afterDisplayMessage()` が呼ばれる

### 設計ノート

- `ReplHandler` は状態を持つクラスとして実装されている。readline、タイマー、接続状態など複数の状態を管理するため、クロージャよりクラスが見通しやすい。
- `clearInput()` は readline 内部の `line` / `cursor` プロパティを直接書き換える。公開 API にはバッファクリア手段がないための回避策。
- 設定変更は「即座にランタイムに反映 + Config ファイルに永続化」の 2 段階にしており、アプリ再起動なしで設定が反映される。
- `beforeDisplayMessage()` / `afterDisplayMessage()` の対で電文表示を挟むことで、入力中テキストの消失やプロンプトの二重描画を防いでいる。

---

## waiting-tips.ts

### 概要

REPL 待機中に定期表示するヒントメッセージの定義ファイル。コマンドの使い方、防災知識、ツールの仕組み、歴史的地震・津波、今後想定される地震に関するヒントをカテゴリ分類された構造体として提供する。

ロジックは一切持たず、純粋なデータ定義のみを担う。表示順序の制御は `tip-shuffler.ts` の `TipShuffler` が行う。

### エクスポートAPI

#### 型

| 名前 | 説明 |
|---|---|
| `TipCategoryId` | カテゴリ識別子のユニオン型 (`"commands-basic"` \| `"commands-advanced"` \| `"disaster-prevention"` \| `"tool-internals"` \| `"trivia"` \| `"history-japan"` \| `"history-world"` \| `"future-quakes"`) |
| `TipCategory` | カテゴリ定義 (`{ id: TipCategoryId; tips: readonly string[] }`) |

#### 定数

| シグネチャ | 説明 |
|---|---|
| `const TIP_CATEGORIES: readonly TipCategory[]` | 8 カテゴリ・計 247 件のヒントメッセージ。各要素は `"Tip: ..."` 形式の文字列 |

### 内部ロジック

ロジックなし。型定義と配列リテラルのみ。

ヒントは以下の 8 カテゴリに分類される:

| カテゴリ ID | 内容 |
|---|---|
| `commands-basic` | 各 REPL コマンドの基本的な使い方 |
| `commands-advanced` | コマンドの応用テクニック・組み合わせ |
| `disaster-prevention` | 地震・津波発生時の行動指針、備蓄、避難 |
| `tool-internals` | FlEq の内部動作・電文処理の解説 |
| `trivia` | 震度・マグニチュード・津波の科学的知識 |
| `history-japan` | 日本の歴史的地震事例 (貞観地震から能登半島地震まで) |
| `history-world` | 世界の歴史的地震事例 (リスボン地震からトルコ・シリア地震まで) |
| `future-quakes` | 南海トラフ地震、首都直下地震、日本海溝・千島海溝沿い地震等の想定 |

### 依存関係

- **インポート元**: なし
- **接続先**: `ui/tip-shuffler.ts` が `TIP_CATEGORIES` をインポートし、カテゴリインターリーブシャッフルに使用

### 設計ノート

- ロジックとデータを分離することで、ヒント文言の追加・編集が容易になっている。
- 旧 `WAITING_TIPS: string[]` (フラット配列) から `TIP_CATEGORIES: readonly TipCategory[]` (8 カテゴリ構造) にリファクタリングされた。カテゴリ情報を活用して `TipShuffler` が同カテゴリ連続を回避するインターリーブシャッフルを行う。

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

function displayVolcanoAshfallBatch(
  batch: Vfvo53BatchItems,
  presentation: VolcanoPresentation,
): void
```

- `displayVolcanoInfo` — `presentation.frameLevel` でフレームのスタイルを決定し、`info.kind` で内部レンダラを振り分ける。`infoType === "取消"` の場合は共通の取消表示を行う。
- `displayVolcanoAshfallBatch` — VFVO53 バッチのまとめ表示。テーブル形式（幅≥80）または1火山1行リスト（狭幅）で表示する。`やや多量(72)以上` / `小さな噴石(75)` の火山は色付き強調。compact モードでは1行要約。

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
| `../engine/messages/volcano-vfvo53-aggregator` | `Vfvo53BatchItems` |

---

## minimap/ ディレクトリ

**ファイルパス**: `src/ui/minimap/` (5 ファイル、`index.ts` 含む、約 526 行)

### 概要

地震・津波・EEW・長周期地震動の発表時に、47 都道府県のグリッドマップ上に最大震度や津波警報レベルを色付きで表示する ASCII ミニマップ機能。ターミナル幅 80 以上で、一定の条件を満たす電文に対して表示される。

### ファイル構成

| ファイル | 責務 |
|---------|------|
| `types.ts` | 型定義 (`PrefId`, `PrefDef`, `GridPos`, `PrefPlacement`, `MinimapCell`) |
| `grid-layout.ts` | 12×13 グリッド上の 47 都道府県配置定義 |
| `pref-mapping.ts` | エリア名から都道府県 ID への部分文字列マッチング |
| `minimap-renderer.ts` | ミニマップのセル構築・描画・表示条件判定 |
| `index.ts` | 型と関数の re-export |

### エクスポートAPI

#### 型 (types.ts)

| 名前 | 説明 |
|---|---|
| `PrefId` | 47 都道府県の 2 文字コード (`"HK"` \| `"AO"` \| ... \| `"OK"`) |
| `PrefDef` | 都道府県定義 (`id: PrefId`, `name: string`, `patterns: string[]`) |
| `GridPos` | グリッド座標 (`row: number`, `col: number`) |
| `PrefPlacement` | 都道府県のグリッド配置 (`id`, `cells: GridPos[]`, `anchor: GridPos`) |
| `MinimapCell` | ミニマップセル (`prefId`, `content: string`, `color?: chalk.Chalk`) |

#### 定数 (grid-layout.ts)

| 名前 | 説明 |
|---|---|
| `GRID_ROWS` | グリッド行数 (12) |
| `GRID_COLS` | グリッド列数 (13) |
| `PREF_PLACEMENTS: readonly PrefPlacement[]` | 47 都道府県のグリッド配置定義 |
| `ALL_PREF_IDS: readonly PrefId[]` | 全都道府県 ID の配列 (配置順) |

#### 関数 (pref-mapping.ts)

| シグネチャ | 説明 |
|---|---|
| `mapAreaToPref(areaName: string): PrefId \| null` | エリア名 (例: `"石川県能登地方"`) から都道府県 ID へマッピング。部分文字列マッチ |

#### 関数 (minimap-renderer.ts)

| シグネチャ | 説明 |
|---|---|
| `renderMinimapForEvent(event: PresentationEvent): string[] \| null` | 公開 API。表示条件を判定し、ミニマップ行配列を返す。非表示なら `null` |
| `shouldShowMinimap(event: PresentationEvent): boolean` | ミニマップ表示条件の判定 |
| `buildMinimapCells(event: PresentationEvent): MinimapCell[]` | `PresentationEvent` から 47 都道府県分のセル配列を構築 |
| `renderMinimap(cells: MinimapCell[]): string[]` | セル配列から 12 行のミニマップテキストを生成 |

### 内部ロジック

#### グリッドレイアウト

12×13 のグリッドに日本地図を模した配置で 47 都道府県を配置する。各セルは `CELL_WIDTH = 6` 文字幅 (`"AA:xx "` 形式)。複数セルを占める都道府県 (北海道 4×2、千葉 1×2、兵庫 1×2 等) はアンカーセルにラベルを、それ以外に継続マーカー (`·····`) を表示する。

グリッド左上の空き領域 (row 0-3, col 0-2) に凡例 (震度色 + 津波略称) をオーバーレイする。

#### 都道府県マッピング

`pref-mapping.ts` は全 47 都道府県の `PrefDef` を定義し、パターン文字列の長い順にソートした索引 (`patternIndex`) を事前構築する。長いパターン優先により、`"東京島しょ"` が `"東京"` より先にマッチする。鹿児島県は `["奄美", "鹿児島"]` の 2 パターンを持つ。

#### 表示条件 (shouldShowMinimap)

| ドメイン | 条件 |
|---------|------|
| earthquake | `areaCount > 0` かつ (`maxIntRank >= 4` または `areaCount >= 4`) |
| eew | `forecastAreaCount > 0` |
| tsunami | (`forecastAreaCount > 0` または `areaCount > 0`) かつ frameLevel が critical/warning/normal |
| lgObservation | (`areaCount > 0` または `observationCount > 0`) かつ (`maxIntRank >= 4` または count >= 4) |

共通条件: ターミナル幅 80 以上、取消電文は非表示。

#### セル構築 (buildMinimapCells)

- earthquake/lgObservation/eew: エリア名から都道府県にマッピングし、同一県内の最大震度を採用 (数値ランクで比較)
- tsunami: エリア名から都道府県にマッピングし、最も重い津波警報種別を採用。略称: `MJ` (大津波警報)、`WN` (津波警報)、`AD` (津波注意報)

### 依存関係

- **インポート元**: `chalk`, `../../engine/presentation/types` (`PresentationEvent`), `../formatter` (`intensityColor`, `intensityToNumeric`)
- **接続先**: `earthquake-formatter.ts`, `eew-formatter.ts` 等からミニマップ描画のために呼ばれる

### 設計ノート

- 型定義・グリッドレイアウト・マッピング・レンダリングを 4 ファイルに分離し、各責務を明確にしている。
- `PresentationEvent` を入力とすることで、電文タイプごとの分岐を `buildMinimapCells` に集約している。
- `patternIndex` はモジュール読み込み時に 1 回だけ構築し、以降のマッチングは O(n) の線形スキャンで行う。

---

## summary/ ディレクトリ

**ファイルパス**: `src/ui/summary/` (6 ファイル、`index.ts` 含む、約 482 行)

### 概要

`PresentationEvent` から幅適応型の 1 行サマリー文字列を生成するモジュール。compact モードやレンダーバッファの recap セクションで使用される。トークンベースのアダプティブレイアウトにより、ターミナル幅に応じて情報の取捨選択と短縮を自動で行う。

### ファイル構成

| ファイル | 責務 |
|---------|------|
| `types.ts` | 型定義 (`SummaryToken`, `SummaryModel`, `SummaryPriority`) |
| `summary-model.ts` | `PresentationEvent` → `SummaryModel` 変換 |
| `token-builders.ts` | ドメイン別トークン構築 (8 ドメイン対応) |
| `width-fit.ts` | トークン列の幅適応アルゴリズム |
| `summary-line.ts` | エントリポイント (`renderSummaryLine`) |
| `index.ts` | `renderSummaryLine` の re-export |

### エクスポートAPI

#### 型 (types.ts)

| 名前 | 説明 |
|---|---|
| `SummaryPriority` | `0 \| 1 \| 2 \| 3 \| 4`。0 が最高優先 |
| `SummaryToken` | トークン定義。`id`, `text`, `shortText?`, `priority: SummaryPriority`, `minWidth`, `preferredWidth`, `dropMode: "never" \| "shorten" \| "drop"` |
| `SummaryModel` | サマリーモデル。`domain`, `severity`, `title?`, `location?`, `magnitude?`, `maxInt?`, `maxLgInt?`, `headline?`, `volcanoName?`, `serial?`, `areaNames?` |

#### 関数

| シグネチャ | ファイル | 説明 |
|---|---|---|
| `buildSummaryModel(event: PresentationEvent): SummaryModel` | summary-model.ts | `PresentationEvent` から `SummaryModel` を構築。`FrameLevel` → severity ラベル変換 (`critical`→`"[緊急]"`, `warning`→`"[警告]"`, `normal`→`"[情報]"`, `info`→`"[通知]"`, `cancel`→`"[取消]"`) |
| `buildSummaryTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[]` | token-builders.ts | ドメイン別にトークン列を構築するディスパッチャ |
| `fitTokensToWidth(tokens: SummaryToken[], maxWidth: number): string` | width-fit.ts | トークン列を指定幅に収まるよう適応的に結合 |
| `renderSummaryLine(event: PresentationEvent, maxWidth?: number): string` | summary-line.ts | 公開エントリポイント。model→tokens→fit の 3 段パイプライン |

### 内部ロジック

#### ドメイン別トークンビルダー (token-builders.ts)

`buildSummaryTokens()` が `model.domain` で分岐し、8 つのドメイン別ビルダーを呼び出す:

| ビルダー | ドメイン | 主なトークン |
|---------|---------|-------------|
| `buildEewTokens` | eew | severity, kind (EEW警報/予報/取消), serial, hypocenter, maxInt, magnitude, depth, forecastAreaTop |
| `buildEarthquakeTokens` | earthquake | severity, type (VXSE51/52/53/61 別), hypocenter, magnitude, maxInt, maxLgInt, topAreas |
| `buildTsunamiTokens` | tsunami | severity, bannerKind, topAreas, areaCount, hypocenter, magnitude |
| `buildVolcanoTokens` | volcano | severity, type (VFVO50/52/53/51/60 別), volcanoName, alertLevel, areaCount, headline |
| `buildSeismicTextTokens` | seismicText | severity, type, headline |
| `buildLgObservationTokens` | lgObservation | severity, type, hypocenter, maxLgInt, maxInt, topAreas, magnitude, depth |
| `buildNankaiTroughTokens` | nankaiTrough | severity, type, headline |
| `buildRawTokens` | raw | severity, RAW, type, title, headline, office |

ヘルパー関数:
- `shortenHypocenter(name)`: 地方・県名の末尾パターン除去 (例: `"石川県能登地方"` → `"能登"`)
- `topAreaTokenParts(names, limit)`: 先頭 n 件を結合し、超過分は `"ほかN"` の shortText を生成

#### 幅適応アルゴリズム (width-fit.ts)

1. 全トークンの `preferredWidth` 合計 + セパレータ (`"  "`, 幅 2) がターミナル幅以内 → そのまま結合
2. 超過時: priority 4 → 3 → 2 の順で `dropMode === "drop"` のトークンを除去
3. まだ超過: `dropMode === "shorten"` かつ `shortText` ありのトークンを短縮版に置換
4. 結果をセパレータで結合して返す

### 依存関係

- **インポート元**: `../../engine/presentation/types` (`PresentationEvent`, `PresentationDomain`), `../formatter` (`FrameLevel`, `visualWidth`)
- **接続先**: `formatter.ts` の compact モード出力、`RenderBuffer` の recap セクションで使用

### 設計ノート

- トークンの `priority` と `dropMode` を組み合わせた段階的劣化 (graceful degradation) により、狭い幅でも重要情報を維持する。
- `SummaryModel` を中間表現として挟むことで、トークンビルダーが `PresentationEvent` の生データに直接依存しすぎない構造にしている。
- `renderSummaryLine` は `index.ts` 経由でのみ re-export され、内部モジュール (`summary-model`, `token-builders`, `width-fit`) は非公開。

---

## repl-handlers/ ディレクトリ

**ファイルパス**: `src/ui/repl-handlers/` (6 ファイル、`index.ts` 含む、約 2195 行)

### 概要

`repl.ts` から分離されたコマンドハンドラ群。型定義・コマンド定義ファクトリ・3 カテゴリのハンドラファイルで構成される。`ReplContext` インターフェースにより `ReplHandler` の内部状態へのアクセスを制御する。

### ファイル構成

| ファイル | 責務 | 行数目安 |
|---------|------|---------|
| `types.ts` | `CommandEntry`, `CommandCategory`, `SubcommandEntry`, `ReplContext`, `CATEGORY_LABELS` の定義 | ~70 |
| `command-definitions.ts` | `buildCommandMap()` ファクトリ。40 以上のコマンド定義を生成 | ~290 |
| `info-handlers.ts` | 情報・ステータス系 9 ハンドラ + `COMMAND_ALIASES` (17 件) + `CATEGORY_ALIASES` (6 件) + `resolveCommand()` | ~640 |
| `settings-handlers.ts` | 設定変更系 16 ハンドラ | ~650 |
| `operation-handlers.ts` | 操作系 5 ハンドラ | ~540 |
| `index.ts` | 型・関数の re-export | ~5 |

### エクスポートAPI

#### 型 (types.ts)

| 名前 | 説明 |
|---|---|
| `CommandCategory` | `"info" \| "status" \| "settings" \| "operation"` |
| `CATEGORY_LABELS` | カテゴリ日本語ラベル (`info`→`"情報"`, `status`→`"ステータス"`, `settings`→`"設定"`, `operation`→`"操作"`) |
| `SubcommandEntry` | サブコマンド定義 (`description`, `detail?`) |
| `CommandEntry` | コマンド定義 (`description`, `detail?`, `category`, `subcommands?`, `handler`) |
| `ReplContext` | コマンドハンドラが参照する REPL コンテキスト。`config`, `wsManager`, `notifier`, `eewLogger`, `statusLine`, `stats`, `pipelineController`, `summaryTracker`, `commands` 等のフィールドと `updateConfig()`, `buildPromptString()`, `stop()`, `resetTipSchedule()` のヘルパーメソッド |

#### ファクトリ (command-definitions.ts)

| シグネチャ | 説明 |
|---|---|
| `buildCommandMap(getCtx: () => ReplContext): Record<string, CommandEntry>` | 全コマンド定義を生成。`getCtx` は遅延参照 |

#### 情報系 (info-handlers.ts)

| シグネチャ | 説明 |
|---|---|
| `COMMAND_ALIASES: Record<string, string>` | 17 件のコマンド短縮形マップ |
| `CATEGORY_ALIASES: Record<string, NotifyCategory>` | 6 件の通知カテゴリ短縮形 (`eq`, `tsu`, `st`, `nt`, `lgob` + `aon`/`aoff`) |
| `resolveCommand(ctx: ReplContext, name: string): CommandEntry \| undefined` | コマンド名を正規化し、エイリアス解決後にハンドラを返す |
| `getCurrentSettingValues(ctx: ReplContext): Record<string, { current, options? }>` | 各設定コマンドの現在値と設定可能な値を返す |
| `handleHelp(ctx, args)` | help コマンド。引数なし: カテゴリ別一覧表示 (現在値・エイリアス付き)。引数あり: 個別コマンド詳細表示 |
| `handleHistory(ctx, args)` | dmdata.jp API から地震履歴をテーブル表示 |
| `handleStats(ctx)` | `displayStatistics()` で電文統計を表示 |
| `handleColors()` | CUD パレット・震度色・長周期階級色・フレームレベル色の一覧表示 |
| `handleDetail(ctx, args)` | DetailProvider 経由で津波/火山情報を再表示 |
| `handleStatus(ctx)` | WebSocket 接続状態表示 |
| `handleConfig()` | Config ファイルの設定一覧表示 |
| `handleContract(ctx)` | dmdata.jp 契約区分一覧表示 (API 呼び出し) |
| `handleSocket(ctx)` | dmdata.jp ソケット一覧表示 (API 呼び出し) |

#### 設定系 (settings-handlers.ts)

16 ハンドラ: `handleNotify`, `handleEewLog`, `handleTableWidth`, `handleInfoText`, `handleTipInterval`, `handleMode`, `handleFilter`, `handleFocus`, `handleClock`, `handleNight`, `handleSummary`, `handleSound`, `handleTheme`, `handleMute`, `handleFold`, `handleLimit`

各ハンドラは「引数なし → 現在値表示」「引数あり → ランタイム即時反映 + Config 永続化」の共通パターンに従う。

#### 操作系 (operation-handlers.ts)

5 ハンドラ: `handleTest`, `handleClear`, `handleBackup`, `handleRetry`, `handleQuit`

### 依存関係

| ファイル | 主なインポート元 |
|---------|----------------|
| `types.ts` | `../../types`, `../../dmdata/connection-manager`, `../../engine/notification/notifier`, `../../engine/eew/eew-logger`, `../status-line`, `../../engine/filter-template/pipeline-controller`, `../../engine/messages/telegram-stats`, `../../engine/messages/summary-tracker`, `../../engine/monitor/monitor` |
| `info-handlers.ts` | `../../types`, `../../dmdata/rest-client`, `../../config`, `../../engine/notification/notifier`, `../formatter`, `../theme`, `../statistics-formatter` |
| `settings-handlers.ts` | `../../types`, `../../config`, `../formatter`, `../theme`, `../../engine/notification/notifier`, `../../engine/filter` |
| `operation-handlers.ts` | `../test-samples`, `../../engine/notification/sound-player` |

### 設計ノート

- `ReplContext` インターフェースにより、ハンドラが `ReplHandler` の内部実装に直接依存しない。テスト時にモックコンテキストを渡すことが可能。
- `buildCommandMap()` は `getCtx` を遅延参照するため、`ReplHandler` のコンストラクタ内で呼んでも循環参照にならない。
- エイリアス解決は `resolveCommand()` に一元化され、コマンド名 → エイリアス名 → コマンドマップの 3 段階で解決する。

---

## night-overlay.ts

**ファイルパス**: `src/ui/night-overlay.ts` (約 61 行)

### 概要

ナイトモード時にテーマの全色を減光する純粋関数モジュール。`ResolvedTheme` を受け取り、パレットとロールの RGB 値を 50% に減衰させた新しい `ResolvedTheme` を返す。危険色ロールは減光対象外とし、緊急情報の視認性を維持する。

### エクスポートAPI

| シグネチャ | 説明 |
|---|---|
| `applyNightOverlay(theme: ResolvedTheme): ResolvedTheme` | テーマに夜間オーバーレイを適用。元のテーマは変更しない (純粋関数) |
| `getExemptRoles(): ReadonlySet<RoleName>` | 減光対象外のロール名一覧を返す (テスト用) |

### 内部ロジック

#### 減光処理

`dimRgb()` が各 RGB チャンネルを `Math.round(v * 0.5)` で半減する。パレットの全 9 色とロールの全スタイル (fg/bg) に適用される。

#### 減光免除ロール (EXEMPT_ROLES)

以下の 6 ロールは減光対象外:

| ロール | 理由 |
|-------|------|
| `frameCritical` | critical フレーム罫線 |
| `tsunamiMajor` | 大津波警報 |
| `eewWarningBanner` | EEW 警報バナー |
| `volcanoFlashBanner` | 噴火速報バナー |
| `intensity6Upper` | 震度 6 強 |
| `intensity7` | 震度 7 |

### 依存関係

- **インポート元**: `./theme` (`ResolvedTheme`, `ResolvedStyle`, `RoleName`)
- **接続先**: `theme.ts` の `loadTheme()` 系関数からナイトモード有効時に呼ばれる

### 設計ノート

- 純粋関数として実装され、副作用がない。テーマの immutable 性を維持する。
- 免除ロールをハードコードすることで、夜間でも緊急情報が通常輝度で表示される。

---

## statistics-formatter.ts

**ファイルパス**: `src/ui/statistics-formatter.ts` (約 247 行)

### 概要

電文受信統計をフレームボックス形式で表示するモジュール。REPL の `stats` コマンドから呼ばれ、カテゴリ別・電文タイプ別の受信件数をテーブル形式で出力する。

### エクスポートAPI

| シグネチャ | 説明 |
|---|---|
| `formatStatsDuration(ms: number): string` | ミリ秒を日本語の時間文字列に変換 (`"3日2時間"`, `"45分"` 等) |
| `displayStatistics(snapshot: StatsSnapshot, now?: Date): void` | 統計をフレームボックスで標準出力に表示 |

### 内部ロジック

#### 表示構成

`displayStatistics()` は `info` レベルのフレームボックスで統計を表示する:

1. **ヘッダー行**: 開始日時、経過時間、合計件数
2. **カテゴリセクション** (区切り線で分離): カテゴリ別件数ヘッダー + 電文タイプ行

#### 6 カテゴリ

| カテゴリ | ラベル |
|---------|--------|
| eew | EEW |
| earthquake | 地震 |
| tsunami | 津波 |
| volcano | 火山 |
| nankaiTrough | 南海トラフ |
| other | その他 |

表示順は上記の固定順。件数 0 のカテゴリは非表示。EEW カテゴリのみ `eewEventCount` (イベント数) も表示する。

#### 最大震度内訳

地震カテゴリに `earthquakeMaxIntByEvent` がある場合、震度別の内訳行を追加する。震度は `INTENSITY_ORDER` (`1`, `2`, ..., `7`) の順で表示。

#### TYPE_LABELS

27 種の電文タイプコード (`VXSE43`, `VTSE41`, `VFVO50` 等) に対応する日本語ラベル定数。

### 依存関係

- **インポート元**: `./formatter` (`frameTop`, `frameBottom`, `frameLine`, `frameDivider`, `visualWidth`, `FrameLevel`), `../engine/messages/telegram-stats` (`StatsSnapshot`, `StatsCategory`)
- **接続先**: `repl-handlers/info-handlers.ts` の `handleStats()` から呼ばれる

### 設計ノート

- フレーム幅はコンテンツ行の最大視覚幅から動的に計算する (`calcWidth`)。
- カウント列の幅は最大値の桁数に合わせ、右揃えで表示する。

---

## summary-interval-formatter.ts

**ファイルパス**: `src/ui/summary-interval-formatter.ts` (約 81 行)

### 概要

定期要約の出力をフォーマットするモジュール。`SummaryWindowSnapshot` からドメイン別件数と sparkline を生成する。REPL の `summary now` コマンドやタイマー駆動の定期要約で使用される。

### エクスポートAPI

| シグネチャ | 説明 |
|---|---|
| `buildSparkline(data: number[]): string` | 数値配列から 8 段階文字 (▁▂▃▄▅▆▇█) の sparkline 文字列を生成 |
| `formatSummaryInterval(snapshot: SummaryWindowSnapshot, intervalMinutes: number, sparkline: boolean): string` | 要約行をフォーマット。ドメイン別件数 + 最大震度 + sparkline |

### 内部ロジック

#### sparkline 生成

`buildSparkline()` は数値配列の最大値に対する比率で 8 段階の Unicode ブロック文字 (`SPARK_CHARS = "▁▂▃▄▅▆▇█"`) を選択する。全て 0 の場合は `▁` の繰り返し。

#### ドメインラベル

8 ドメインの日本語ラベルマップ:

| ドメイン | ラベル |
|---------|--------|
| eew | EEW |
| earthquake | 地震 |
| tsunami | 津波 |
| seismicText | テキスト |
| lgObservation | 長周期 |
| volcano | 火山 |
| nankaiTrough | 南海トラフ |
| raw | その他 |

#### 出力形式

```
── 10分要約 ── 地震 3件 | EEW 1件 (最大5弱)
受信 ▁▂▃▄▁▁▃▅  (60分)
```

1 行目: ヘッダー + ドメイン別件数 (`|` 区切り) + 最大震度。2 行目 (sparkline 有効時): sparkline + ウィンドウ幅。

### 依存関係

- **インポート元**: `chalk`, `../engine/messages/summary-tracker` (`SummaryWindowSnapshot`, `WINDOW_MINUTES`)
- **接続先**: `repl-handlers/settings-handlers.ts` の `handleSummary()` と `engine/monitor/monitor.ts` の要約タイマーから呼ばれる

---

## status-line.ts

**ファイルパス**: `src/ui/status-line.ts` (約 77 行)

### 概要

REPL プロンプトのプレフィックス文字列を組み立てるクラス。接続状態のパルス表示、経過時間/現在時刻の切替、最終受信時刻の追跡を担う。

### エクスポートAPI

#### StatusLine クラス

```typescript
class StatusLine {
  tick(): void
  setConnected(connected: boolean): void
  markMessageReceived(): void
  setClockMode(mode: PromptClock): void
  getClockMode(): PromptClock
  buildPrefix(options?: { noSuffix?: boolean }): string
  getLastMessageTime(): number | null
  getElapsedBase(): number | null
}
```

| メソッド | 説明 |
|---|---|
| `tick()` | パルス (`●`/`○`) をトグルする。1 秒タイマーから呼ばれる |
| `setConnected(connected)` | 接続/切断を記録。接続時に `connectedAt` を設定 |
| `markMessageReceived()` | 最終受信時刻を更新 |
| `setClockMode(mode)` | 時計モードを設定 (`"elapsed"` / `"clock"` / `"uptime"`) |
| `getClockMode()` | 現在の時計モードを返す |
| `buildPrefix(options?)` | プロンプトプレフィックスを生成。`noSuffix: true` で `"]> "` を省略可 |
| `getLastMessageTime()` | 最終受信時刻 (エポックミリ秒) を返す |
| `getElapsedBase()` | 経過時間の基準時刻 (`lastMessageTime ?? connectedAt`) を返す |

### 内部ロジック

#### プロンプト形式

- 接続中: `FlEq [● HH:MM:SS]> ` (パルス点滅)
- 未接続: `FlEq [○ --:--:--]> `
- `clockMode === "clock"`: 現在時刻を表示
- `clockMode === "elapsed"`: 最終受信からの経過時間を表示 (`formatElapsedTime` 使用)
- `clockMode === "uptime"`: プロセス起動からの稼働時間を表示 (`formatUptime` 使用、`process.uptime()` ベース)。未接続時でも表示される (接続状態非依存)

### 依存関係

- **インポート元**: `chalk`, `../types` (`PromptClock`), `../ui/formatter` (`formatElapsedTime`, `formatUptime`)
- **接続先**: `repl.ts` の `ReplHandler` がインスタンスを保持し、1 秒タイマーで `tick()` を呼ぶ。`repl-handlers/types.ts` の `ReplContext` 経由でハンドラからもアクセスされる

---

## tip-shuffler.ts

**ファイルパス**: `src/ui/tip-shuffler.ts` (約 92 行)

### 概要

待機中ヒントのデッキベースシャッフラ。全カテゴリの Tip をインターリーブしてデッキを構築し、同カテゴリの連続表示を回避する。デッキを使い切ったら自動で再構築する。タイミング制御は持たず、`next()` で次の Tip を返すだけの純粋な順序供給器。

### エクスポートAPI

#### TipShuffler クラス

```typescript
class TipShuffler {
  constructor(rng?: () => number)
  next(): string
}
```

| メソッド | 説明 |
|---|---|
| `constructor(rng?)` | RNG を注入可能 (デフォルト: `Math.random`)。構築時にデッキを初期生成 |
| `next()` | 次の Tip 文字列を返す。デッキが空なら自動再構築 |

### 内部ロジック

#### デッキ構築 (rebuildDeck)

1. `TIP_CATEGORIES` の各カテゴリの tips を Fisher-Yates シャッフル
2. カテゴリインデックス付きでフラット化
3. `interleave()` で同カテゴリ連続を回避しつつ 1 つのデッキに統合

#### インターリーブアルゴリズム

カテゴリごとのキューに分割し、直前に選んだカテゴリ以外からランダムに 1 つ選択して dequeue する。1 カテゴリしか残っていない場合はそのまま流し込む。

### 依存関係

- **インポート元**: `./waiting-tips` (`TIP_CATEGORIES`)
- **接続先**: `repl.ts` の `ReplHandler` がインスタンスを保持し、`maybeShowWaitingTip()` 内で `next()` を呼ぶ

### 設計ノート

- RNG を外部注入可能にすることで、テスト時に決定的な順序を再現できる。
- エポック方式 (全 Tip を 1 回ずつ消費してから再構築) により、同じ Tip が短期間に重複表示されない。
