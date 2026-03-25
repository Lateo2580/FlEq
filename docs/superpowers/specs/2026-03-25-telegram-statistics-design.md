# 電文統計表示機能 設計書

## 概要

セッション中に受信した電文のタイプ別統計を REPL コマンド `stats` で表示する機能。セッション単位（メモリのみ、再起動でリセット）。

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
  eventId?: string | null;    // xmlReport.head.eventId（EEW・地震用）
}
```

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

| Route | StatsCategory | 含まれる headType |
|-------|---------------|------------------|
| `eew` | `eew` | VXSE43, VXSE44, VXSE45 |
| `earthquake` | `earthquake` | VXSE51, VXSE52, VXSE53, VXSE61 |
| `seismicText` | `earthquake` | VXSE56, VXSE60, VZSE40 |
| `lgObservation` | `earthquake` | VXSE62 |
| `tsunami` | `tsunami` | VTSE41, VTSE51, VTSE52 |
| `nankaiTrough` | `nankaiTrough` | VYSE50, VYSE51, VYSE52, VYSE60 |
| `volcano` | `volcano` | VFVO50-56, VFVO60, VFSVii, VZVO40 |
| `raw` | `other` | 未知の電文 |

`routeToCategory()` ヘルパー関数で変換する。`seismicText` と `lgObservation` は統計上 `earthquake` にまとめる。

## ルーター統合

### カウント記録のフック位置

`message-router.ts` の `createMessageHandler()` 内、`handler` 関数の `classifyMessage()` 直後・`switch (route)` 直前で `stats.record()` を呼ぶ。

```ts
const route = classifyMessage(msg.classification, msg.head.type);

stats.record({
  headType: msg.head.type,
  category: routeToCategory(route),
  eventId: msg.xmlReport?.head.eventId ?? null,
});

switch (route) { ... }
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
  desc: "電文統計を表示",
  category: "info",
  handler: () => this.handleStats(),
}
```

### ReplHandler への注入

- コンストラクタ引数に `stats: TelegramStats` を追加
- `monitor.ts` の `startMonitor()` 内で `createMessageHandler()` が返す `stats` を `ReplHandler` に渡す

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

## テスト方針

- `TelegramStats` のユニットテスト: record / updateMaxInt / getSnapshot の動作確認
- 最大震度の優先順位テスト: VXSE51 → VXSE53 の上書きが正しく動作すること
- EEW イベント数の独自集計テスト
- `displayStatistics()` のスナップショットテスト: 出力文字列の検証
- 0件時の表示テスト
