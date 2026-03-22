# Notification Icons per Category & Level — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通知バナーのアイコンをカテゴリ×深刻度レベルで切り替え、3段フォールバックで解決する

**Architecture:** `notifier.ts` に `resolveIconPath()` を追加し、`send()` にカテゴリ引数を追加。既存の `SoundLevel` と `NotifyCategory` をそのまま活用。public API は変更なし。

**Tech Stack:** TypeScript, vitest, node-notifier, fs.existsSync

**Spec:** `docs/superpowers/specs/2026-03-22-notification-icons-design.md`

---

## File Structure

| Action | File | Responsibility |
| --- | --- | --- |
| Modify | `src/engine/notification/notifier.ts` | `resolveIconPath()` 追加、`send()` シグネチャ変更、全 `notify*()` 更新 |
| Modify | `test/engine/notifier.test.ts` | `resolveIconPath()` ユニットテスト + `send()` 結合テスト追加 |

---

### Task 1: `resolveIconPath()` のテストを書く

**Files:**
- Modify: `test/engine/notifier.test.ts`

- [ ] **Step 1: `resolveIconPath` のテストケースを追加**

`test/engine/notifier.test.ts` の末尾に以下の describe ブロックを追加する。
`fs.existsSync` をスパイし、パスに応じて存在/不在を制御する。

```typescript
import { resolveIconPath } from "../../src/engine/notification/notifier";
import * as fs from "fs";

describe("resolveIconPath", () => {
  it("returns {prefix}-{level}.png when it exists", () => {
    const spy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const result = resolveIconPath("tsunami", "critical");
    expect(result).toMatch(/tsunami-critical\.png$/);
    spy.mockRestore();
  });

  it("falls back to {prefix}.png when level-specific icon is missing", () => {
    const spy = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      return String(p).endsWith("tsunami.png");
    });
    const result = resolveIconPath("tsunami", "critical");
    expect(result).toMatch(/tsunami\.png$/);
    expect(result).not.toMatch(/tsunami-critical/);
    spy.mockRestore();
  });

  it("falls back to default.png when category icon is also missing", () => {
    const spy = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      return String(p).endsWith("default.png");
    });
    const result = resolveIconPath("tsunami", "critical");
    expect(result).toMatch(/default\.png$/);
    spy.mockRestore();
  });

  it("returns undefined when no icon files exist", () => {
    const spy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const result = resolveIconPath("tsunami", "critical");
    expect(result).toBeUndefined();
    spy.mockRestore();
  });

  it("skips level-specific candidate when level is undefined", () => {
    const calls: string[] = [];
    const spy = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      calls.push(String(p));
      return String(p).endsWith("earthquake.png");
    });
    const result = resolveIconPath("earthquake");
    expect(result).toMatch(/earthquake\.png$/);
    // level-specific candidate should NOT appear in calls
    expect(calls.some((c) => c.includes("earthquake-"))).toBe(false);
    spy.mockRestore();
  });

  it("maps camelCase categories to kebab-case prefixes", () => {
    const spy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const result = resolveIconPath("seismicText", "info");
    expect(result).toMatch(/seismic-text-info\.png$/);
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npm test -- test/engine/notifier.test.ts`
Expected: FAIL — `resolveIconPath` が存在しないためインポートエラー

- [ ] **Step 3: コミット**

```bash
git add test/engine/notifier.test.ts
git commit -m "test: add resolveIconPath unit tests (red phase)"
```

---

### Task 2: `resolveIconPath()` と定数を実装する

**Files:**
- Modify: `src/engine/notification/notifier.ts:23-24` (NOTIFY_ICON_PATH 置換)

- [ ] **Step 1: `NOTIFY_ICON_PATH` を `ICONS_DIR` + `CATEGORY_ICON_PREFIX` + `resolveIconPath()` に置き換え**

`src/engine/notification/notifier.ts` で以下を変更する。

**削除** (L23-24):
```typescript
/** 通知アイコンのパス (assets/icons/icon.png が存在する場合に使用) */
const NOTIFY_ICON_PATH = path.resolve(__dirname, "../../../assets/icons/icon.png");
```

**追加** (同じ位置に):
```typescript
/** 通知アイコンディレクトリ */
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

注意: `SoundLevel` は L18 で `import { playSound, SoundLevel } from "./sound-player"` として既にインポート済み。新規 import は不要。

- [ ] **Step 2: テストを実行して成功を確認**

Run: `npm test -- test/engine/notifier.test.ts`
Expected: resolveIconPath テスト 6件 PASS

- [ ] **Step 3: コミット**

```bash
git add src/engine/notification/notifier.ts test/engine/notifier.test.ts
git commit -m "feat: add resolveIconPath with 3-step fallback"
```

---

### Task 3: `send()` にカテゴリ引数を追加し、全 `notify*()` を更新する

**Files:**
- Modify: `src/engine/notification/notifier.ts:271-292` (send メソッド)

- [ ] **Step 1: `send()` のシグネチャを変更しアイコン解決を組み込む**

`src/engine/notification/notifier.ts` の `send()` メソッドを変更する。

**Before** (L271):
```typescript
  private send(title: string, message: string, level?: SoundLevel): void {
    if (this.isMuted()) return;
    try {
      const nn = this.getNotifier();
      if (nn) {
        nn.notify({
          title,
          message,
          sound: false,
          appID: NOTIFY_APP_NAME,
          ...(fs.existsSync(NOTIFY_ICON_PATH) ? { icon: NOTIFY_ICON_PATH } : {}),
        });
      }
```

**After**:
```typescript
  private send(title: string, message: string, category: NotifyCategory, level?: SoundLevel): void {
    if (this.isMuted()) return;
    try {
      const nn = this.getNotifier();
      if (nn) {
        const iconPath = resolveIconPath(category, level);
        nn.notify({
          title,
          message,
          sound: false,
          appID: NOTIFY_APP_NAME,
          ...(iconPath ? { icon: iconPath } : {}),
        });
      }
```

- [ ] **Step 2: 全 `notify*()` メソッドの `this.send()` 呼び出しにカテゴリを追加**

全15箇所を更新する。各メソッドの `this.send(...)` 呼び出しで、第3引数にカテゴリ文字列を挿入する。

`notifyEew` (2箇所):
```typescript
// L131 取消パス
this.send("[取消] 緊急地震速報", "緊急地震速報は取り消されました", "eew", "cancel");
// L147 通常パス
this.send(title, body, "eew", soundLevel);
```

`notifyEarthquake` (2箇所):
```typescript
// 取消パス
this.send(`[取消] ${info.title}`, "この情報は取り消されました", "earthquake", "cancel");
// 通常パス
this.send(info.title, parts.length > 0 ? parts.join(" / ") : (info.headline ?? info.title), "earthquake", soundLevel);
```

`notifyTsunami` (2箇所):
```typescript
// 取消パス
this.send(`[取消] ${info.title}`, "この情報は取り消されました", "tsunami", "cancel");
// 通常パス
this.send(info.title, parts.length > 0 ? parts.join(" / ") : info.title, "tsunami", soundLevel);
```

`notifySeismicText` (2箇所):
```typescript
// 取消パス
this.send(`[取消] ${info.title}`, "この情報は取り消されました", "seismicText", "cancel");
// 通常パス
this.send(info.title, body, "seismicText", "info");
```

`notifyNankaiTrough` (2箇所):
```typescript
// 取消パス
this.send(`[取消] ${info.title}`, "この情報は取り消されました", "nankaiTrough", "cancel");
// 通常パス
this.send(info.title, body, "nankaiTrough", "warning");
```

`notifyLgObservation` (2箇所):
```typescript
// 取消パス
this.send(`[取消] ${info.title}`, "この情報は取り消されました", "lgObservation", "cancel");
// 通常パス
this.send(info.title, parts.length > 0 ? parts.join(" / ") : info.title, "lgObservation", soundLevel);
```

`notifyVolcano` (2箇所):
```typescript
// 取消パス
this.send(`[取消] ${info.title}`, "この情報は取り消されました", "volcano", "cancel");
// 通常パス
this.send(info.title, presentation.summary, "volcano", presentation.soundLevel);
```

`notifyVolcanoBatch` (1箇所):
```typescript
this.send("降灰予報（定時）", presentation.summary, "volcano", presentation.soundLevel);
```

- [ ] **Step 3: ビルドが通ることを確認**

Run: `npm run build`
Expected: エラーなし

- [ ] **Step 4: 既存テストが通ることを確認**

Run: `npm test -- test/engine/notifier.test.ts`
Expected: 全テスト PASS

- [ ] **Step 5: コミット**

```bash
git add src/engine/notification/notifier.ts
git commit -m "feat: pass category to send() and update all 15 call sites"
```

---

### Task 4: `send()` 結合テストを追加する

**Files:**
- Modify: `test/engine/notifier.test.ts`

- [ ] **Step 1: `send()` がカテゴリに応じた icon を渡すことをテスト**

`test/engine/notifier.test.ts` の既存の `Notifier` describe ブロック内に追加する。

```typescript
  it("passes category-specific icon to node-notifier", () => {
    const spy = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      return String(p).endsWith("earthquake.png");
    });

    const notifier = new Notifier();
    notifier.setSoundEnabled(false);

    const info: ParsedEarthquakeInfo = {
      type: "VXSE",
      infoType: "発表",
      title: "震源・震度情報",
      reportDateTime: "2026-03-11T12:34:56+09:00",
      headline: null,
      publishingOffice: "気象庁",
      earthquake: {
        originTime: "2026-03-11T12:34:00+09:00",
        hypocenterName: "東京都",
        latitude: "35.0",
        longitude: "139.0",
        depth: "10km",
        magnitude: "4.0",
      },
      intensity: {
        maxInt: "3",
        areas: [{ name: "東京都", intensity: "3" }],
      },
      isTest: false,
    };

    notifier.notifyEarthquake(info);

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        icon: expect.stringMatching(/earthquake\.png$/),
      }),
    );

    spy.mockRestore();
  });

  it("omits icon property when no icon file exists", () => {
    const spy = vi.spyOn(fs, "existsSync").mockReturnValue(false);

    const notifier = new Notifier();
    notifier.setSoundEnabled(false);

    const info: ParsedEarthquakeInfo = {
      type: "VXSE",
      infoType: "発表",
      title: "震源・震度情報",
      reportDateTime: "2026-03-11T12:34:56+09:00",
      headline: null,
      publishingOffice: "気象庁",
      earthquake: {
        originTime: "2026-03-11T12:34:00+09:00",
        hypocenterName: "東京都",
        latitude: "35.0",
        longitude: "139.0",
        depth: "10km",
        magnitude: "4.0",
      },
      intensity: {
        maxInt: "3",
        areas: [{ name: "東京都", intensity: "3" }],
      },
      isTest: false,
    };

    notifier.notifyEarthquake(info);

    const callArg = notifyMock.mock.calls[0][0];
    expect(callArg).not.toHaveProperty("icon");

    spy.mockRestore();
  });
```

注意: `import * as fs from "fs"` は Task 1 で追加済み。重複追加しないこと。

- [ ] **Step 2: 全テストを実行して成功を確認**

Run: `npm test -- test/engine/notifier.test.ts`
Expected: 全テスト PASS (resolveIconPath 6件 + Notifier 3件 = 9件)

- [ ] **Step 3: コミット**

```bash
git add test/engine/notifier.test.ts
git commit -m "test: add send() integration tests for category-specific icons"
```

---

### Task 5: 全テストスイートの実行と最終確認

**Files:** なし (確認のみ)

- [ ] **Step 1: 全テストスイートを実行**

Run: `npm test`
Expected: 全テスト PASS、エラーなし

- [ ] **Step 2: ビルドを確認**

Run: `npm run build`
Expected: エラーなし

- [ ] **Step 3: 旧 `NOTIFY_ICON_PATH` / `icon.png` への参照が残っていないことを確認**

Run: `grep -r "NOTIFY_ICON_PATH" src/` と `grep -r "icon\.png" src/`
Expected: ヒットなし (テストファイルや docs は除く)
