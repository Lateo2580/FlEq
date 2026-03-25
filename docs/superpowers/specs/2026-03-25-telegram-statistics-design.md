# 電文統計表示機能 設計書

## 概要

セッション中に受信した電文のタイプ別統計を REPL コマンド `stats` で表示する機能。セッション単位（メモリのみ、再起動でリセット）。

### 統計対象の範囲

- **XML 電文のみ**を統計対象とする。非 XML メッセージ（`msg.format !== "xml"` や `!msg.head.xml`）は統計に含めない
- **テスト電文**（`msg.head.test === true`）も通常電文と同様にカウントする（テストモードで稼働時に統計が空になるのを避けるため）
- **EEW 重複報**（`EewTracker` が `isDuplicate` と判定した報）は統計に**含めない**。ユーザーに表示されなかった電文をカウントしても意味がないため
- **パース失敗**で `displayRawHeader()` にフォールバックした電文は、EEW 以外は統計に**含める**（`record()` がパース前に呼ばれるため）。**EEW のパース失敗**は統計に**含めない**（EEW は重複報スキップとの整合のため `handleEew()` 内でパース・重複判定後に記録するので、パース失敗時点では `record()` が呼ばれない）

## データモデル

### `TelegramStats` クラス

**配置**: `src/engine/messages/telegram-stats.ts`

#### 統計カテゴリ

```ts
type StatsCategory = "eew" | "earthquake" | "tsunami" | "volcano" | "nankaiTrough" | "other";
```

#### 記録入力

```ts
interface StatsRecord {
  headType: string;           // "VXSE53", "VTSE41" など
  category: StatsCategory;    // ルーターが判定済みのカテゴリ
  eventId?: string | null;    // EEW・地震の eventId（情報源は後述）
}
```

**`eventId` の情報源**:
- **EEW**: `record()` の呼び出し位置は `switch (route)` の前だが、EEW の場合は重複報スキップとの整合を取るため、`handleEew()` 内でパース後に `stats.record()` を呼ぶ。`eventId` は `parseEewTelegram()` が返す `eewInfo.eventId` を使用する（既存の EewTracker と同じ情報源）
- **地震**: `msg.xmlReport?.head.eventId` を使用する。`updateMaxInt()` も同じ経路

#### 内部状態

| フィールド | 型 | 用途 |
|-----------|-----|------|
| `startTime` | `Date` | セッション開始時刻 |
| `countByType` | `Map<string, number>` | headType ごとの受信件数 |
| `categoryByType` | `Map<string, StatsCategory>` | headType → カテゴリの逆引き |
| `eewEventIds` | `Set<string>` | EEW ユニークイベント数集計用 |
| `earthquakeMaxIntByEvent` | `Map<string, { maxInt: string; priority: number }>` | 地震イベントごとの代表最大震度 |

#### メソッド

| メソッド | 説明 |
|---------|------|
| `record(rec: StatsRecord)` | headType カウント加算。EEW の場合は eventId を Set に追加 |
| `updateMaxInt(eventId: string, maxInt: string, headType: string)` | 地震イベントの代表最大震度を更新。優先順: VXSE53 > VXSE61 > VXSE51（高優先で上書き） |
| `getSnapshot(): StatsSnapshot` | 表示用の読み取り専用スナップショットを返す |

#### 最大震度の優先順位

同一 eventId に対して複数の電文が到着した場合、代表最大震度は以下の優先順で決定する:

| headType | priority (大きい方が優先) |
|----------|------------------------|
| VXSE53 | 3 |
| VXSE61 | 2 |
| VXSE51 | 1 |

既存エントリより priority が高い、または同等の場合に上書きする。

## カテゴリ分類

ルーターの既存 `Route` → `StatsCategory` のマッピング:

| Route | StatsCategory | 既知の headType 例 |
|-------|---------------|-------------------|
| `eew` | `eew` | VXSE43, VXSE44, VXSE45 |
| `earthquake` | `earthquake` | VXSE51, VXSE52, VXSE53, VXSE61 |
| `seismicText` | `earthquake` | VXSE56, VXSE60, VZSE40 |
| `lgObservation` | `earthquake` | VXSE62 |
| `tsunami` | `tsunami` | VTSE41, VTSE51, VTSE52 |
| `nankaiTrough` | `nankaiTrough` | VYSE50, VYSE51, VYSE52, VYSE60 |
| `volcano` | `volcano` | VFVO50-56, VFVO60, VFSVii, VZVO40 |
| `raw` | `other` | （分類不能な電文） |

`routeToCategory()` ヘルパー関数は **Route 値のみ**で変換する（headType による分岐は行わない）。headType 列は既知の例であり、新しい headType が追加されてもルーターの `classifyMessage()` が正しく Route を返せば統計側の変更は不要。`seismicText` と `lgObservation` は統計上 `earthquake` にまとめる。

## ルーター統合

### カウント記録のフック位置

`message-router.ts` の `createMessageHandler()` 内、`handler` 関数で統計を記録する。

**記録タイミング**:
- **EEW 以外**: `classifyMessage()` 直後・`switch (route)` 直前で `stats.record()` を呼ぶ。非 XML チェック（`msg.format !== "xml"`）の後なので、非 XML 電文は統計に入らない
- **EEW**: 重複報スキップ後に `handleEew()` 内で呼ぶ（重複報を除外するため）

```ts
// handler 関数内
if (msg.format !== "xml" || !msg.head.xml) {
  displayRawHeader(msg);
  return;
}

const route = classifyMessage(msg.classification, msg.head.type);

// EEW 以外はここで記録（EEW は handleEew 内で記録）
if (route !== "eew") {
  stats.record({
    headType: msg.head.type,
    category: routeToCategory(route),
    eventId: msg.xmlReport?.head.eventId ?? null,
  });
}

switch (route) { ... }
```

**EEW の記録** (`handleEew()` 内):
```ts
const result = eewTracker.update(eewInfo);
if (result.isDuplicate) { return; }  // 重複報はスキップ

// 重複でない場合のみ統計に記録
stats.record({
  headType: msg.head.type,
  category: "eew",
  eventId: eewInfo.eventId,  // パース結果の eventId を使用
});
```

### 最大震度の更新

`handleEarthquake()` 内でパース後に `stats.updateMaxInt()` を呼ぶ:

```ts
function handleEarthquake(msg: WsDataMessage, notifier: Notifier, stats: TelegramStats): void {
  const eqInfo = parseEarthquakeTelegram(msg);
  if (eqInfo) {
    const eventId = msg.xmlReport?.head.eventId;
    if (eventId && eqInfo.intensity?.maxInt) {
      stats.updateMaxInt(eventId, eqInfo.intensity.maxInt, msg.head.type);
    }
    displayEarthquakeInfo(eqInfo);
    notifier.notifyEarthquake(eqInfo);
  } else {
    displayRawHeader(msg);
  }
}
```

### `MessageHandlerResult` への追加

```ts
export interface MessageHandlerResult {
  handler: (msg: WsDataMessage) => void;
  eewLogger: EewEventLogger;
  notifier: Notifier;
  tsunamiState: TsunamiStateHolder;
  volcanoState: VolcanoStateHolder;
  stats: TelegramStats;                    // 追加
  flushAndDisposeVolcanoBuffer: () => void;
}
```

## 表示フォーマッター

### `displayStatistics()` 関数

**配置**: `src/ui/statistics-formatter.ts`（新規）

### フレーム設定

- `FrameLevel`: `"info"`
- フレーム幅: 表示内容から動的に算出（グローバルの `cachedFrameWidth` は使わない）

### フレーム幅の算出ロジック

1. 全表示行の視覚幅（`visualWidth()` で計算）の最大値を求める
   - ヘッダ行: `開始: YYYY/MM/DD HH:mm  経過: XXX  合計: NNN件`
   - カテゴリ見出し行: `[EEW] N件 / Mイベント`
   - type 行: `  VXSE53  震源・震度に関する情報  :  NNN`
   - 最大震度内訳行: `  最大震度内訳  1:N  2:N  3:N ...`
2. 最長行 + 左右パディングでフレーム幅を決定
3. 最小幅はヘッダ行が収まる幅

### 表示構成

```
┌──────────────────────────────────────────────┐
│ 統計                                          │
│ 開始: 2026/03/22 18:36  経過: 1時間12分       │
│ 合計: 27件                                    │
├──────────────────────────────────────────────┤
│ [EEW] 6件 / 2イベント                         │
│   VXSE43  緊急地震速報(警報)            :   1 │
│   VXSE45  緊急地震速報(地震動予報)      :   5 │
├──────────────────────────────────────────────┤
│ [地震] 18件                                   │
│   VXSE51  震度速報                      :   7 │
│   VXSE53  震源・震度に関する情報        :   7 │
│   最大震度内訳  1:8  2:6  3:1  4:3           │
├──────────────────────────────────────────────┤
│ [津波] 2件                                    │
│   VTSE41  津波警報・注意報・予報        :   1 │
│   VTSE52  沖合の津波観測に関する情報    :   1 │
└──────────────────────────────────────────────┘
```

### 表示ルール

| ルール | 詳細 |
|--------|------|
| 0件のカテゴリ・type | 省略 |
| 受信0件全体 | `「まだ電文を受信していません」` の1行のみ |
| カテゴリ間区切り | `frameDivider()` |
| カテゴリ表示順 | 固定: EEW → 地震 → 津波 → 火山 → 南海トラフ → その他 |
| 件数の右寄せ幅 | 最小4桁、全 type の最大桁数に動的対応 |
| EEW イベント数 | カテゴリ見出しに `N件 / Mイベント` で併記 |
| 最大震度内訳 | 地震セクション末尾に `1:N  2:N  3:N ...` 形式で1行表示。0件の震度は省略 |
| リキャップ | 不要（表示量が限られるため `flushWithRecap()` は使わない） |

### 経過時間のフォーマット

| 条件 | 表示例 |
|------|--------|
| 1時間未満 | `32分` |
| 1日未満 | `1時間12分` |
| 1日以上 | `2日4時間` |

### headType → 表示名マッピング

静的テーブル `TYPE_LABELS` で定義。未知の type はそのまま headType を表示。

```ts
const TYPE_LABELS: Record<string, string> = {
  VXSE43: "緊急地震速報(警報)",
  VXSE44: "緊急地震速報(予報)",
  VXSE45: "緊急地震速報(地震動予報)",
  VXSE51: "震度速報",
  VXSE52: "震源に関する情報",
  VXSE53: "震源・震度に関する情報",
  VXSE56: "地震の活動状況等に関する情報",
  VXSE60: "地震解説",
  VXSE61: "顕著な地震の震度速報",
  VXSE62: "長周期地震動に関する観測情報",
  VZSE40: "地震回数に関する情報",
  VTSE41: "津波警報・注意報・予報",
  VTSE51: "津波情報",
  VTSE52: "沖合の津波観測に関する情報",
  VYSE50: "南海トラフ地震臨時情報",
  VYSE51: "南海トラフ地震関連解説情報(臨時)",
  VYSE52: "南海トラフ地震関連解説情報(定例)",
  VYSE60: "南海トラフ地震関連解説情報(経過)",
  VFVO50: "噴火警報・予報",
  VFVO51: "火山の状況に関する解説情報",
  VFVO52: "噴火に関する火山観測報",
  VFVO53: "降灰予報(定時)",
  VFVO54: "降灰予報(速報)",
  VFVO55: "降灰予報(詳細)",
  VFVO56: "噴火速報",
  VFVO60: "推定噴煙流向報",
  VFSVii: "火山現象に関する海上警報",
  VZVO40: "火山に関するお知らせ",
};
```

## REPL コマンド統合

### コマンド登録

`repl.ts` の `commands` レジストリに追加:

```ts
stats: {
  description: "電文統計を表示",
  category: "info",
  handler: () => this.handleStats(),
}
```

### ReplHandler への注入

`ReplHandler` のコンストラクタに `stats: TelegramStats` 引数を追加する。既存のシグネチャ:

```ts
constructor(
  config: AppConfig,
  wsManager: ConnectionManager,
  notifier: Notifier,
  eewLogger: EewEventLogger,
  onQuit: () => void | Promise<void>,
  statusProviders: PromptStatusProvider[] = [],
  detailProviders: DetailProvider[] = [],
)
```

`stats` は `onQuit` の後、`statusProviders` の前に挿入する（デフォルト値を持つ引数の前に置く）:

```ts
constructor(
  config: AppConfig,
  wsManager: ConnectionManager,
  notifier: Notifier,
  eewLogger: EewEventLogger,
  onQuit: () => void | Promise<void>,
  stats: TelegramStats,
  statusProviders: PromptStatusProvider[] = [],
  detailProviders: DetailProvider[] = [],
)
```

`monitor.ts` の呼び出し箇所も対応して更新する:

```ts
// 現行
replHandler = new ReplHandler(config, manager, notifier, eewLogger, shutdown,
  [tsunamiState, volcanoState], [tsunamiState, volcanoState]);

// 変更後
replHandler = new ReplHandler(config, manager, notifier, eewLogger, shutdown,
  stats, [tsunamiState, volcanoState], [tsunamiState, volcanoState]);
```

### handleStats() の実装

```ts
private handleStats(): void {
  const snapshot = this.stats.getSnapshot();
  displayStatistics(snapshot);
}
```

## 変更対象ファイル一覧

| ファイル | 変更種別 | 内容 |
|---------|---------|------|
| `src/engine/messages/telegram-stats.ts` | **新規** | TelegramStats クラス、StatsRecord、StatsSnapshot 型 |
| `src/ui/statistics-formatter.ts` | **新規** | displayStatistics() 関数、TYPE_LABELS、経過時間フォーマット |
| `src/engine/messages/message-router.ts` | 変更 | TelegramStats インスタンス化、record() / updateMaxInt() 呼び出し、MessageHandlerResult に stats 追加 |
| `src/ui/repl.ts` | 変更 | stats コマンド登録、TelegramStats をコンストラクタで受け取り |
| `src/engine/monitor/monitor.ts` | 変更 | stats の受け渡し（createMessageHandler → ReplHandler） |
| `test/ui/repl.test.ts` | 変更 | ReplHandler コンストラクタの stats 引数追加に伴う全呼び出し箇所の更新 |

## テスト方針

### テストファイル

| ファイル | 対象 |
|---------|------|
| `test/engine/telegram-stats.test.ts` | **新規** — TelegramStats クラスのユニットテスト |
| `test/ui/statistics-formatter.test.ts` | **新規** — displayStatistics() の出力テスト |
| `test/engine/message-router.test.ts` | 変更 — stats 記録の統合テスト追加 |

### TelegramStats テストケース

- `record()`: headType ごとのカウント加算、カテゴリの逆引き登録
- `record()` + EEW: eventId が `eewEventIds` に追加されること
- `record()` + EEW: eventId が null の場合はイベント数に加算しないこと
- `updateMaxInt()`: VXSE53 > VXSE61 > VXSE51 の優先順で上書きされること
- `updateMaxInt()`: 低優先の type では既存エントリを上書きしないこと
- `getSnapshot()`: 内部状態を正しく反映したスナップショットを返すこと
- 0件時: 空のスナップショットを返すこと

### displayStatistics() テストケース

- 0件: 「まだ電文を受信していません」が表示されること
- 単一カテゴリ: フレーム幅がコンテンツに合わせて算出されること
- 複数カテゴリ: カテゴリ間が `frameDivider()` で区切られること
- 最大震度内訳: 地震セクション末尾に表示されること
- EEW イベント数: カテゴリ見出しに「N件 / Mイベント」で表示されること
- 出力検証は `stripAnsi()` で ANSI エスケープを除去して文字列比較

### message-router 統合テストケース

- EEW 重複報は統計に含まれないこと
- EEW パース失敗時は統計に含まれないこと
- EEW 以外のパース失敗でフォールバックした電文は統計に含まれること
- 非 XML メッセージ（`msg.format !== "xml"`）は統計に含まれないこと
- テスト電文（`msg.head.test === true`）は通常電文と同様にカウントされること

### 既存テストへの影響

`ReplHandler` のコンストラクタシグネチャ変更により、`test/ui/repl.test.ts` の全 `new ReplHandler(...)` 呼び出しに `stats` 引数の追加が必要。テスト用には `new TelegramStats()` を渡す。

また、`stats` コマンド自体の統合テストも `test/ui/repl.test.ts` に追加する:
- `stats` コマンド実行時に `displayStatistics()` が呼ばれること
- コマンドが `commands` レジストリに登録されていること

### テストヘルパーの拡張

`createMockWsDataMessage()` は `xmlReport.head.eventId` がデフォルトで `null` のため、EEW イベント数や最大震度のテストでは `eventId` を明示的に設定したモックを作成する必要がある。EEW の場合は `parseEewTelegram()` 経由で `eewInfo.eventId` を取得するため、フィクスチャ XML 内の `<EventID>` 要素から自動で取れる。
