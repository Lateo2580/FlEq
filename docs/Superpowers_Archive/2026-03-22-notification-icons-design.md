# Notification Icons per Category & Level

## Overview

通知バナーに表示するアイコンを、通知カテゴリと深刻度レベルの組み合わせで切り替える。
現状は全通知で固定の `assets/icons/icon.png` を使用しているが、これをカテゴリ×レベルの
フォールバック探索に置き換える。

## Icon Resolution

### Fallback Chain

アイコンパスは以下の優先順で解決する:

```
1. assets/icons/{prefix}-{level}.png   (例: tsunami-critical.png)
2. assets/icons/{prefix}.png           (例: tsunami.png)
3. assets/icons/default.png
4. アイコンなし (icon プロパティを省略)
```

各段階で `fs.existsSync()` による存在チェックを行い、最初に見つかったパスを採用する。

> **キャッシュについて:** 通知はイベント駆動で低頻度のため、`fs.existsSync()` のキャッシュは不要。
> アイコンファイルの追加・削除を再起動なしで反映できるメリットもある。

### Category-to-Prefix Mapping

`NotifyCategory` の camelCase キーを kebab-case に変換したものをプレフィックスとする。

| NotifyCategory   | Prefix           |
| ---------------- | ---------------- |
| `eew`            | `eew`            |
| `earthquake`     | `earthquake`     |
| `tsunami`        | `tsunami`        |
| `seismicText`    | `seismic-text`   |
| `nankaiTrough`   | `nankai-trough`  |
| `lgObservation`  | `lg-observation` |
| `volcano`        | `volcano`        |

### SoundLevel (既存)

`sound-player.ts` で定義済みの5段階をそのまま使用する:

`critical` / `warning` / `normal` / `info` / `cancel`

### Full Icon Matrix

ユーザーが用意可能なアイコン一覧 (全て任意、フォールバックあり)。
以下は各カテゴリで実際に使用されるレベルに基づく代表例。
列挙されていないカテゴリ×レベルの組み合わせ (例: `earthquake-normal.png`) も
配置すればフォールバックより優先して使用される。

> **Note:** `earthquake-critical.png` は現状リストにない。これは意図的で、
> `earthquakeSoundLevel()` が `"warning"` / `"normal"` のみを返すため。
> 将来 critical レベルを追加する場合はアイコンも追加可能。

```
assets/icons/
├── default.png
│
├── eew.png
├── eew-critical.png           # EEW 警報
├── eew-warning.png            # EEW 予報
├── eew-cancel.png             # EEW 取消
│
├── earthquake.png
├── earthquake-warning.png     # 震度4以上
├── earthquake-cancel.png      # 取消
│
├── tsunami.png
├── tsunami-critical.png       # 大津波警報
├── tsunami-warning.png        # 津波警報
├── tsunami-normal.png         # 津波注意報
├── tsunami-cancel.png         # 取消
│
├── seismic-text.png
├── seismic-text-cancel.png    # 取消
│
├── nankai-trough.png
├── nankai-trough-warning.png  # 巨大地震注意等
├── nankai-trough-cancel.png   # 取消
│
├── lg-observation.png
├── lg-observation-critical.png # 階級3-4
├── lg-observation-warning.png  # 階級1-2
├── lg-observation-cancel.png   # 取消
│
├── volcano.png
├── volcano-critical.png       # 噴火速報・Lv4-5
├── volcano-warning.png        # Lv2-3引上げ等
└── volcano-cancel.png         # 取消
```

## Code Changes

### Scope

変更ファイルは `src/engine/notification/notifier.ts` のみ。
`Notifier` クラスの public API (メソッドシグネチャ) は変更しない。
呼び出し元 (`message-router.ts` 等) への影響はない。

### Imports

新規 import は不要。`fs`, `path` は既にインポート済み。
`ICONS_DIR` のパス深度 (`../../../`) は `sound-player.ts` の `CUSTOM_SOUNDS_DIR` と同じで、
コンパイル後の `dist/engine/notification/notifier.js` からプロジェクトルートへの相対パスに対応する。

### New Constants & Functions

```typescript
/** アイコンディレクトリ */
const ICONS_DIR = path.resolve(__dirname, "../../../assets/icons");

/** NotifyCategory → アイコンファイル名プレフィックス */
const CATEGORY_ICON_PREFIX: Record<NotifyCategory, string> = {
  eew: "eew",
  earthquake: "earthquake",
  tsunami: "tsunami",
  seismicText: "seismic-text",
  nankaiTrough: "nankai-trough",
  lgObservation: "lg-observation",
  volcano: "volcano",
};

/**
 * カテゴリとレベルからアイコンパスを解決する。
 * 3段フォールバック: {prefix}-{level}.png → {prefix}.png → default.png
 * いずれも見つからなければ undefined を返す。
 */
export function resolveIconPath(
  category: NotifyCategory,
  level?: SoundLevel,
): string | undefined {
  const prefix = CATEGORY_ICON_PREFIX[category];
  const candidates: string[] = [];

  if (level) {
    candidates.push(path.join(ICONS_DIR, `${prefix}-${level}.png`));
  }
  candidates.push(path.join(ICONS_DIR, `${prefix}.png`));
  candidates.push(path.join(ICONS_DIR, "default.png"));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
```

### Modified: `send()` Method

```typescript
// Before
private send(title: string, message: string, level?: SoundLevel): void

// After
private send(title: string, message: string, category: NotifyCategory, level?: SoundLevel): void
```

`send()` 内部で `resolveIconPath(category, level)` を呼び出し、結果を `icon` に渡す。

### Modified: Each `notify*()` Method

各メソッドの `this.send()` 呼び出しに自身のカテゴリを追加する。

対象の全 `this.send()` 呼び出し (15箇所):

| メソッド | 呼び出し箇所 | category |
| --- | --- | --- |
| `notifyEew` | 取消パス (L131) | `"eew"` |
| `notifyEew` | 通常パス (L147) | `"eew"` |
| `notifyEarthquake` | 取消パス (L154) | `"earthquake"` |
| `notifyEarthquake` | 通常パス (L168) | `"earthquake"` |
| `notifyTsunami` | 取消パス (L175) | `"tsunami"` |
| `notifyTsunami` | 通常パス (L191) | `"tsunami"` |
| `notifySeismicText` | 取消パス (L198) | `"seismicText"` |
| `notifySeismicText` | 通常パス (L203) | `"seismicText"` |
| `notifyNankaiTrough` | 取消パス (L210) | `"nankaiTrough"` |
| `notifyNankaiTrough` | 通常パス (L215) | `"nankaiTrough"` |
| `notifyLgObservation` | 取消パス (L223) | `"lgObservation"` |
| `notifyLgObservation` | 通常パス (L238) | `"lgObservation"` |
| `notifyVolcano` | 取消パス (L245) | `"volcano"` |
| `notifyVolcano` | 通常パス (L249) | `"volcano"` |
| `notifyVolcanoBatch` | 通常パス (L254) | `"volcano"` |

例 (`notifyTsunami`):
```typescript
// Before
this.send(info.title, parts.join(" / "), soundLevel);

// After
this.send(info.title, parts.join(" / "), "tsunami", soundLevel);
```

### Removed

- `NOTIFY_ICON_PATH` 定数 (`resolveIconPath` に統合)

## Testing

既存の `test/engine/notifier.test.ts` にテストケースを追加する。

### `resolveIconPath()` Unit Tests

`fs.existsSync` をモックし、ファイルシステム非依存でテストする。

| Case | existsSync returns | Expected |
| --- | --- | --- |
| `{prefix}-{level}.png` exists | 1st candidate → true | そのパス |
| category-only exists | 1st → false, 2nd → true | `{prefix}.png` パス |
| default-only exists | 1st,2nd → false, 3rd → true | `default.png` パス |
| nothing exists | all → false | `undefined` |
| level is undefined | skip 1st candidate | `{prefix}.png` or fallback |

### `send()` Integration Test

`nn.notify()` に渡される `icon` プロパティが `resolveIconPath()` の結果と一致することを検証する。
