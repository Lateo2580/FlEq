# Phase 1: PresentationEvent 共通層 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全電文の業務処理結果を ProcessOutcome discriminated union で返し、統一的な中間表現 PresentationEvent に変換する共通層を導入する。

**Architecture:** 既存の `handleXxx()` を `processXxx()` に改め、パース・状態更新・レベル判定の結果を ProcessOutcome として返す。ルーターは outcome を使って統計記録→表示→通知のパイプラインを実行する。PresentationEvent は Phase 2 以降の filter/template/compact が参照する。

**Tech Stack:** TypeScript strict, vitest, chalk v4 (CommonJS)

**Spec:** `docs/superpowers/specs/2026-03-28-fleq-cli-enhancement-unified.md` Section 4

---

## File Structure

```
src/engine/presentation/
  types.ts                         # PresentationDomain, ProcessOutcome 系型, PresentationEvent 型
  level-helpers.ts                 # frameLevel/soundLevel 判定関数（フォーマッター/通知から抽出）
  processors/
    process-eew.ts                 # EEW 業務処理 → EewOutcome
    process-earthquake.ts          # 地震 → EarthquakeOutcome
    process-seismic-text.ts        # テキスト系 → SeismicTextOutcome
    process-lg-observation.ts      # 長周期 → LgObservationOutcome
    process-tsunami.ts             # 津波 → TsunamiOutcome
    process-nankai-trough.ts       # 南海トラフ → NankaiTroughOutcome
    process-volcano.ts             # 火山(単発) → VolcanoOutcome
    process-raw.ts                 # フォールバック → RawOutcome
    process-message.ts             # ルート→processXxx ディスパッチャ
  events/
    to-presentation-event.ts       # ProcessOutcome → PresentationEvent ディスパッチャ
    from-eew.ts                    # EewOutcome → PresentationEvent
    from-earthquake.ts             # EarthquakeOutcome → PresentationEvent
    from-seismic-text.ts           # SeismicTextOutcome → PresentationEvent
    from-lg-observation.ts         # LgObservationOutcome → PresentationEvent
    from-tsunami.ts                # TsunamiOutcome → PresentationEvent
    from-volcano.ts                # VolcanoOutcome/VolcanoBatchOutcome → PresentationEvent
    from-nankai-trough.ts          # NankaiTroughOutcome → PresentationEvent
    from-raw.ts                    # RawOutcome → PresentationEvent

test/engine/presentation/
  level-helpers.test.ts
  processors/
    process-eew.test.ts
    process-earthquake.test.ts
    process-seismic-text.test.ts
    process-lg-observation.test.ts
    process-tsunami.test.ts
    process-nankai-trough.test.ts
    process-volcano.test.ts
    process-raw.test.ts
    process-message.test.ts
  events/
    to-presentation-event.test.ts
    from-eew.test.ts
    from-earthquake.test.ts
    (各 from-xxx.test.ts)
```

**Modify:**
- `src/engine/messages/message-router.ts` — processMessage + dispatchOutcome に書き換え
- `src/ui/earthquake-formatter.ts` — frameLevel 関数を export or re-export
- `src/ui/eew-formatter.ts` — eewFrameLevel を export or re-export
- `test/engine/message-router.test.ts` — 統計テストの更新

---

## 背景知識

### 既存の電文処理フロー

```
WsDataMessage → classifyMessage(route) → handleXxx()
  handleXxx 内部:
    1. parseXxxTelegram(msg) → ParsedXxxInfo | null
    2. 状態更新 (eewTracker/tsunamiState/volcanoState)
    3. displayXxxInfo(parsedInfo)  ← frameLevel をフォーマッター内で判定
    4. notifier.notifyXxx(parsedInfo) ← soundLevel を Notifier 内で判定
```

### Phase 1 後のフロー

```
WsDataMessage → classifyMessage(route) → processXxx()
  → ProcessOutcome (パース結果 + 状態 + レベル判定 + stats 情報)
  → dispatchOutcome():
    1. stats.record() / stats.updateMaxInt()  ← outcome.stats から
    2. displayXxxInfo(outcome.parsed)          ← 既存フォーマッターそのまま
    3. notifier.notifyXxx(outcome.parsed, ...) ← 既存通知そのまま
    4. toPresentationEvent(outcome)            ← Phase 2+ 用（生成のみ）
```

### frameLevel 判定の現在位置

| 電文 | 判定場所 | 関数名 |
|------|---------|--------|
| EEW | `src/ui/eew-formatter.ts:84` | `eewFrameLevel()` (export 済み) |
| 地震 | `src/ui/earthquake-formatter.ts:79` | `earthquakeFrameLevel()` (非 export) |
| 津波 | `src/ui/earthquake-formatter.ts:143` | `tsunamiFrameLevel()` (非 export) |
| テキスト系 | `src/ui/earthquake-formatter.ts:641` | inline `info.infoType === "取消" ? "cancel" : "info"` |
| 南海トラフ | `src/ui/earthquake-formatter.ts:194` | `nankaiTroughFrameLevel()` (非 export) |
| 長周期 | `src/ui/earthquake-formatter.ts:210` | `lgObservationFrameLevel()` (非 export) |
| 火山 | `src/engine/notification/volcano-presentation.ts:20` | `resolveVolcanoPresentation()` (export 済み) |

### soundLevel 判定の現在位置

| 電文 | 判定場所 |
|------|---------|
| EEW | `notifier.ts:170` inline `info.isWarning ? "critical" : "warning"` |
| 地震 | `notifier.ts:332` `earthquakeSoundLevel()` (private) |
| 津波 | `notifier.ts:339` `tsunamiSoundLevel()` (private) |
| テキスト系 | `notifier.ts:238` inline `"info"` |
| 南海トラフ | `notifier.ts:249` inline `nankaiInfo.infoSerial?.code === "120" ? "critical" : "warning"` |
| 長周期 | `notifier.ts:350` `lgObservationSoundLevel()` (private) |
| 火山 | `volcano-presentation.ts` — VolcanoPresentation.soundLevel |

### コーディング規約

- `== null` で null/undefined チェック（`=== null || === undefined` ではなく）
- `any` 禁止（strict TypeScript）
- namespace import: `import * as log from "../../logger"`
- テストは vitest (`npm test -- --run`)

---

## Task 1: Foundation Types

**Files:**
- Create: `src/engine/presentation/types.ts`
- Test: (型のみのため実行時テスト不要。コンパイルで検証)

### 目的

ProcessOutcome 系と PresentationEvent の全型定義を1ファイルにまとめる。ロジックは含めない。

- [ ] **Step 1: ディレクトリ作成**

```bash
mkdir -p src/engine/presentation/processors src/engine/presentation/events
mkdir -p test/engine/presentation/processors test/engine/presentation/events
```

- [ ] **Step 2: types.ts を作成**

```ts
// src/engine/presentation/types.ts

import type { FrameLevel } from "../../ui/formatter";
import type { SoundLevel } from "../notification/sound-player";
import type { NotifyCategory, WsDataMessage } from "../../types";
import type { ParsedEewInfo, ParsedEarthquakeInfo, ParsedSeismicTextInfo, ParsedLgObservationInfo, ParsedTsunamiInfo, ParsedNankaiTroughInfo, ParsedVolcanoInfo, ParsedVolcanoAshfallInfo } from "../../types";
import type { EewDiff, EewUpdateResult } from "../eew/eew-tracker";
import type { VolcanoPresentation } from "../notification/volcano-presentation";

// ── PresentationDomain ──

export type PresentationDomain =
  | "eew"
  | "earthquake"
  | "seismicText"
  | "lgObservation"
  | "tsunami"
  | "volcano"
  | "nankaiTrough"
  | "raw";

// ── ProcessOutcome ──

export interface ProcessOutcomeBase {
  domain: PresentationDomain;
  msg: WsDataMessage;
  headType: string;
  /** 統計記録用のカテゴリ（ルート由来。パース失敗→raw フォールバック時も元カテゴリを保持） */
  statsCategory: StatsCategory;
  stats: {
    shouldRecord: boolean;
    eventId?: string | null;
    maxIntUpdate?: { eventId: string; maxInt: string; headType: string };
  };
  presentation: {
    frameLevel: FrameLevel;
    soundLevel?: SoundLevel;
    notifyCategory?: NotifyCategory;
  };
}

export interface EewOutcome extends ProcessOutcomeBase {
  domain: "eew";
  parsed: ParsedEewInfo;
  state: {
    activeCount: number;
    colorIndex: number;
    isDuplicate: boolean;
    isCancelled: boolean;
    diff?: EewDiff;
  };
  /** 通知用に EewUpdateResult 原本も保持 */
  eewResult: EewUpdateResult;
}

export interface EarthquakeOutcome extends ProcessOutcomeBase {
  domain: "earthquake";
  parsed: ParsedEarthquakeInfo;
  state?: {
    eventId?: string | null;
    representativeMaxInt?: string;
  };
}

export interface SeismicTextOutcome extends ProcessOutcomeBase {
  domain: "seismicText";
  parsed: ParsedSeismicTextInfo;
}

export interface LgObservationOutcome extends ProcessOutcomeBase {
  domain: "lgObservation";
  parsed: ParsedLgObservationInfo;
}

export interface TsunamiOutcome extends ProcessOutcomeBase {
  domain: "tsunami";
  parsed: ParsedTsunamiInfo;
  state: {
    levelBefore: string | null;
    levelAfter: string | null;
    changed: boolean;
  };
}

export interface VolcanoOutcome extends ProcessOutcomeBase {
  domain: "volcano";
  parsed: ParsedVolcanoInfo;
  volcanoPresentation: VolcanoPresentation;
  state: {
    isRenotification: boolean;
    trackedBefore?: string | null;
    trackedAfter?: string | null;
  };
}

export interface VolcanoBatchOutcome extends ProcessOutcomeBase {
  domain: "volcano";
  parsed: ParsedVolcanoAshfallInfo[];
  isBatch: true;
  volcanoPresentation: VolcanoPresentation;
  batchReportDateTime: string;
  batchIsTest: boolean;
}

export interface NankaiTroughOutcome extends ProcessOutcomeBase {
  domain: "nankaiTrough";
  parsed: ParsedNankaiTroughInfo;
}

export interface RawOutcome extends ProcessOutcomeBase {
  domain: "raw";
  parsed: null;
}

export type ProcessOutcome =
  | EewOutcome
  | EarthquakeOutcome
  | SeismicTextOutcome
  | LgObservationOutcome
  | TsunamiOutcome
  | VolcanoOutcome
  | VolcanoBatchOutcome
  | NankaiTroughOutcome
  | RawOutcome;

// ── PresentationEvent ──

export interface PresentationAreaItem {
  name: string;
  code?: string;
  kind?: string;
  maxInt?: string;
  maxLgInt?: string;
  flags?: string[];
}

export type EventStateSnapshot =
  | { kind: "eew"; activeCount: number; colorIndex: number; isCancelled: boolean; diff?: EewDiff }
  | { kind: "tsunami"; levelBefore: string | null; levelAfter: string | null; changed: boolean }
  | { kind: "volcano"; isRenotification: boolean };

export type ParsedTelegramUnion =
  | ParsedEewInfo
  | ParsedEarthquakeInfo
  | ParsedSeismicTextInfo
  | ParsedLgObservationInfo
  | ParsedTsunamiInfo
  | ParsedNankaiTroughInfo
  | ParsedVolcanoInfo
  | ParsedVolcanoAshfallInfo[]
  | null;

export interface PresentationEvent {
  // 識別
  id: string;
  classification: string;
  domain: PresentationDomain;
  type: string;
  subType?: string;

  // 共通メタ
  infoType: string;
  title: string;
  headline: string | null;
  reportDateTime: string;
  publishingOffice: string;
  isTest: boolean;

  // レベル
  frameLevel: FrameLevel;
  soundLevel?: SoundLevel;
  notifyCategory?: NotifyCategory;

  // 状態フラグ
  isCancellation: boolean;
  isWarning?: boolean;
  isFinal?: boolean;
  isAssumedHypocenter?: boolean;
  isRenotification?: boolean;

  // イベント追跡
  eventId?: string | null;
  serial?: string | null;
  volcanoCode?: string | null;
  volcanoName?: string | null;

  // 震源情報
  originTime?: string | null;
  hypocenterName?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  depth?: string | null;
  magnitude?: string | null;

  // 強度
  maxInt?: string | null;
  maxIntRank?: number | null;
  maxLgInt?: string | null;
  maxLgIntRank?: number | null;
  forecastMaxInt?: string | null;
  forecastMaxIntRank?: number | null;
  alertLevel?: number | null;

  // 付帯情報
  nextAdvisory?: string | null;
  warningComment?: string | null;
  bodyText?: string | null;

  // 地域集約
  areaNames: string[];
  forecastAreaNames: string[];
  municipalityNames: string[];
  observationNames: string[];
  areaCount: number;
  forecastAreaCount: number;
  municipalityCount: number;
  observationCount: number;

  areaItems: PresentationAreaItem[];

  // filter 用
  tsunamiKinds?: string[];
  infoSerialCode?: string | null;

  // 原本
  raw: ParsedTelegramUnion;

  // 状態スナップショット
  stateSnapshot?: EventStateSnapshot;
}
```

- [ ] **Step 3: コンパイル確認**

Run: `npx tsc --noEmit`
Expected: エラーなし（型のみなのでインポート解決だけ確認）

- [ ] **Step 4: コミット**

```bash
git add src/engine/presentation/types.ts
git commit -m "feat(presentation): add ProcessOutcome and PresentationEvent type definitions"
```

---

## Task 2: Level Determination Helpers

**Files:**
- Create: `src/engine/presentation/level-helpers.ts`
- Create: `test/engine/presentation/level-helpers.test.ts`
- Modify: `src/ui/earthquake-formatter.ts` — 既存関数を export に変更するか、level-helpers から re-export

### 目的

frameLevel/soundLevel の判定関数を `level-helpers.ts` に集約する。既存フォーマッターの非 export 関数を export 化して re-export するか、ロジックを移動する。フォーマッター側はヘルパーを import する形にする。

- [ ] **Step 1: テスト作成**

```ts
// test/engine/presentation/level-helpers.test.ts

import { describe, it, expect } from "vitest";
import {
  eewFrameLevel,
  earthquakeFrameLevel,
  tsunamiFrameLevel,
  seismicTextFrameLevel,
  nankaiTroughFrameLevel,
  lgObservationFrameLevel,
  eewSoundLevel,
  earthquakeSoundLevel,
  tsunamiSoundLevel,
  seismicTextSoundLevel,
  nankaiTroughSoundLevel,
  lgObservationSoundLevel,
} from "../../../src/engine/presentation/level-helpers";
import type { ParsedEarthquakeInfo, ParsedEewInfo, ParsedTsunamiInfo, ParsedSeismicTextInfo, ParsedNankaiTroughInfo, ParsedLgObservationInfo } from "../../../src/types";

// ── frameLevel ──

describe("eewFrameLevel", () => {
  it("取消 → cancel", () => {
    expect(eewFrameLevel({ infoType: "取消" } as ParsedEewInfo)).toBe("cancel");
  });
  it("警報 → critical", () => {
    expect(eewFrameLevel({ infoType: "発表", isWarning: true } as ParsedEewInfo)).toBe("critical");
  });
  it("予報 → warning", () => {
    expect(eewFrameLevel({ infoType: "発表", isWarning: false } as ParsedEewInfo)).toBe("warning");
  });
});

describe("earthquakeFrameLevel", () => {
  it("取消 → cancel", () => {
    expect(earthquakeFrameLevel({ infoType: "取消" } as ParsedEarthquakeInfo)).toBe("cancel");
  });
  it("震度6弱以上 → critical", () => {
    expect(earthquakeFrameLevel({ infoType: "発表", intensity: { maxInt: "6弱" } } as ParsedEarthquakeInfo)).toBe("critical");
  });
  it("震度4 → warning", () => {
    expect(earthquakeFrameLevel({ infoType: "発表", intensity: { maxInt: "4" } } as ParsedEarthquakeInfo)).toBe("warning");
  });
  it("震度なし → normal", () => {
    expect(earthquakeFrameLevel({ infoType: "発表" } as ParsedEarthquakeInfo)).toBe("normal");
  });
});

describe("tsunamiFrameLevel", () => {
  it("取消 → cancel", () => {
    expect(tsunamiFrameLevel({ infoType: "取消" } as ParsedTsunamiInfo)).toBe("cancel");
  });
  it("大津波警報 → critical", () => {
    expect(tsunamiFrameLevel({ infoType: "発表", forecast: [{ kind: "大津波警報" }] } as unknown as ParsedTsunamiInfo)).toBe("critical");
  });
  it("津波警報 → warning", () => {
    expect(tsunamiFrameLevel({ infoType: "発表", forecast: [{ kind: "津波警報" }] } as unknown as ParsedTsunamiInfo)).toBe("warning");
  });
});

describe("seismicTextFrameLevel", () => {
  it("取消 → cancel", () => {
    expect(seismicTextFrameLevel({ infoType: "取消" } as ParsedSeismicTextInfo)).toBe("cancel");
  });
  it("通常 → info", () => {
    expect(seismicTextFrameLevel({ infoType: "発表" } as ParsedSeismicTextInfo)).toBe("info");
  });
});

describe("nankaiTroughFrameLevel", () => {
  it("取消 → cancel", () => {
    expect(nankaiTroughFrameLevel({ infoType: "取消" } as ParsedNankaiTroughInfo)).toBe("cancel");
  });
  it("code 120 → critical", () => {
    expect(nankaiTroughFrameLevel({ infoType: "発表", infoSerial: { code: "120" } } as unknown as ParsedNankaiTroughInfo)).toBe("critical");
  });
  it("code 190 → info", () => {
    expect(nankaiTroughFrameLevel({ infoType: "発表", infoSerial: { code: "190" } } as unknown as ParsedNankaiTroughInfo)).toBe("info");
  });
  it("VYSE60 (infoSerial なし) → warning", () => {
    expect(nankaiTroughFrameLevel({ infoType: "発表", infoSerial: null } as unknown as ParsedNankaiTroughInfo)).toBe("warning");
  });
});

describe("lgObservationFrameLevel", () => {
  it("取消 → cancel", () => {
    expect(lgObservationFrameLevel({ infoType: "取消" } as ParsedLgObservationInfo)).toBe("cancel");
  });
  it("LgInt 4 → critical", () => {
    expect(lgObservationFrameLevel({ infoType: "発表", maxLgInt: "4" } as ParsedLgObservationInfo)).toBe("critical");
  });
  it("LgInt 2 → normal", () => {
    expect(lgObservationFrameLevel({ infoType: "発表", maxLgInt: "2" } as ParsedLgObservationInfo)).toBe("normal");
  });
});

// ── soundLevel ──

describe("eewSoundLevel", () => {
  it("警報 → critical", () => {
    expect(eewSoundLevel({ isWarning: true } as ParsedEewInfo)).toBe("critical");
  });
  it("予報 → warning", () => {
    expect(eewSoundLevel({ isWarning: false } as ParsedEewInfo)).toBe("warning");
  });
});

describe("earthquakeSoundLevel", () => {
  it("震度4+ → warning", () => {
    expect(earthquakeSoundLevel({ intensity: { maxInt: "4" } } as ParsedEarthquakeInfo)).toBe("warning");
  });
  it("震度なし → normal", () => {
    expect(earthquakeSoundLevel({} as ParsedEarthquakeInfo)).toBe("normal");
  });
});

describe("tsunamiSoundLevel", () => {
  it("津波含む → critical", () => {
    expect(tsunamiSoundLevel({ forecast: [{ kind: "津波警報" }] } as unknown as ParsedTsunamiInfo)).toBe("critical");
  });
  it("forecast なし → normal", () => {
    expect(tsunamiSoundLevel({ forecast: [] } as unknown as ParsedTsunamiInfo)).toBe("normal");
  });
});
```

- [ ] **Step 2: テスト失敗確認**

Run: `npm test -- --run test/engine/presentation/level-helpers.test.ts`
Expected: FAIL（モジュール未存在）

- [ ] **Step 3: level-helpers.ts 実装**

```ts
// src/engine/presentation/level-helpers.ts

/**
 * frameLevel / soundLevel 判定関数の集約モジュール。
 * 既存フォーマッター・通知に散在していたレベル判定ロジックを一元化する。
 */

import type { FrameLevel } from "../../ui/formatter";
import type { SoundLevel } from "../notification/sound-player";
import type {
  ParsedEewInfo,
  ParsedEarthquakeInfo,
  ParsedSeismicTextInfo,
  ParsedLgObservationInfo,
  ParsedTsunamiInfo,
  ParsedNankaiTroughInfo,
} from "../../types";
import { intensityToRank } from "../../utils/intensity";

// ── 内部ヘルパー ──

/** 長周期地震動レベルを数値化 */
function lgIntToNumeric(lgInt: string): number {
  const n = Number(lgInt);
  return Number.isNaN(n) ? 0 : n;
}

// ── frameLevel ──

export function eewFrameLevel(info: ParsedEewInfo): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  if (info.isWarning) return "critical";
  return "warning";
}

export function earthquakeFrameLevel(info: ParsedEarthquakeInfo): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  if (info.intensity) {
    const rank = intensityToRank(info.intensity.maxInt);
    if (rank >= 7) return "critical";  // 6弱以上
    if (rank >= 4) return "warning";   // 4以上
  }
  return "normal";
}

export function tsunamiFrameLevel(info: ParsedTsunamiInfo): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  const kinds = (info.forecast || []).map((f) => f.kind);
  if (kinds.some((kind) => kind.includes("大津波警報"))) return "critical";
  if (kinds.some((kind) => kind.includes("津波警報"))) return "warning";
  return "normal";
}

export function seismicTextFrameLevel(info: ParsedSeismicTextInfo): FrameLevel {
  return info.infoType === "取消" ? "cancel" : "info";
}

export function nankaiTroughFrameLevel(info: ParsedNankaiTroughInfo): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  if (!info.infoSerial) return "warning";
  const code = info.infoSerial.code;
  if (code === "120") return "critical";
  if (code === "130") return "warning";
  if (code === "111" || code === "112" || code === "113") return "warning";
  if (code === "210" || code === "219") return "warning";
  if (code === "190" || code === "200") return "info";
  return "warning";
}

export function lgObservationFrameLevel(info: ParsedLgObservationInfo): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  if (info.maxLgInt) {
    const num = lgIntToNumeric(info.maxLgInt);
    if (num >= 4) return "critical";
    if (num >= 3) return "warning";
    if (num >= 2) return "normal";
  }
  return "info";
}

// ── soundLevel ──

export function eewSoundLevel(info: ParsedEewInfo): SoundLevel {
  return info.isWarning ? "critical" : "warning";
}

export function earthquakeSoundLevel(info: ParsedEarthquakeInfo): SoundLevel {
  if (!info.intensity) return "normal";
  if (intensityToRank(info.intensity.maxInt) >= 4) return "warning";
  return "normal";
}

export function tsunamiSoundLevel(info: ParsedTsunamiInfo): SoundLevel {
  if (!info.forecast || info.forecast.length === 0) return "normal";
  const kinds = info.forecast.map((f) => f.kind);
  if (kinds.some((k) => k.includes("津波") && !k.includes("解除"))) return "critical";
  if (kinds.some((k) => k.includes("解除"))) return "warning";
  return "normal";
}

export function seismicTextSoundLevel(_info: ParsedSeismicTextInfo): SoundLevel {
  return "info";
}

export function nankaiTroughSoundLevel(info: ParsedNankaiTroughInfo): SoundLevel {
  return info.infoSerial?.code === "120" ? "critical" : "warning";
}

export function lgObservationSoundLevel(info: ParsedLgObservationInfo): SoundLevel {
  if (!info.maxLgInt) return "normal";
  if (info.maxLgInt === "4" || info.maxLgInt === "3") return "critical";
  if (info.maxLgInt === "2" || info.maxLgInt === "1") return "warning";
  return "normal";
}
```

**注意**: 既存フォーマッター (`earthquake-formatter.ts`) 内の `earthquakeFrameLevel` 等は private 関数として残し、`level-helpers.ts` のものと重複する。Phase 1 ではフォーマッター内の関数は変更しない（既存テストを壊さないため）。将来的にフォーマッターが level-helpers を import する形に統合する。

`eew-formatter.ts` の `eewFrameLevel` は既に export されているので重複するが、level-helpers 版を正として追加する。

- [ ] **Step 4: テスト通過確認**

Run: `npm test -- --run test/engine/presentation/level-helpers.test.ts`
Expected: PASS

- [ ] **Step 5: 全テスト確認**

Run: `npm test -- --run`
Expected: 全テスト PASS（既存コードは変更なし）

- [ ] **Step 6: コミット**

```bash
git add src/engine/presentation/level-helpers.ts test/engine/presentation/level-helpers.test.ts
git commit -m "feat(presentation): add centralized frameLevel/soundLevel helpers"
```

---

## Task 3: processEew

**Files:**
- Create: `src/engine/presentation/processors/process-eew.ts`
- Create: `test/engine/presentation/processors/process-eew.test.ts`

### 目的

EEW 業務処理を `handleEew()` から抽出。パース→重複検出→ログ記録→レベル判定を行い、EewOutcome を返す。重複報や パース失敗では null を返す。

- [ ] **Step 1: テスト作成**

```ts
// test/engine/presentation/processors/process-eew.test.ts

import { describe, it, expect, vi, beforeEach } from "vitest";
import { processEew } from "../../../../src/engine/presentation/processors/process-eew";
import { EewTracker } from "../../../../src/engine/eew/eew-tracker";
import { EewEventLogger } from "../../../../src/engine/eew/eew-logger";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE43_WARNING_S1,
  FIXTURE_VXSE43_WARNING_S2,
  FIXTURE_VXSE45_S1,
  FIXTURE_VXSE45_CANCEL,
} from "../../../helpers/mock-message";

// fs モック (EewEventLogger のファイル書き込みを抑制)
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    appendFileSync: vi.fn(),
    existsSync: (p: string) => {
      if (typeof p === "string" && p.includes("eew-logs")) return true;
      return actual.existsSync(p);
    },
    mkdirSync: vi.fn(),
    promises: { ...actual.promises, appendFile: vi.fn().mockResolvedValue(undefined) },
  };
});

describe("processEew", () => {
  let eewTracker: EewTracker;
  let eewLogger: EewEventLogger;

  beforeEach(() => {
    eewTracker = new EewTracker();
    eewLogger = new EewEventLogger();
  });

  it("正常な EEW を処理して EewOutcome を返す", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
    const outcome = processEew(msg, eewTracker, eewLogger);

    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("eew");
    expect(outcome!.parsed.isWarning).toBe(true);
    expect(outcome!.presentation.frameLevel).toBe("critical");
    expect(outcome!.stats.shouldRecord).toBe(true);
    expect(outcome!.stats.eventId).toBeDefined();
  });

  it("重複報は null を返す", () => {
    const msg1 = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
    processEew(msg1, eewTracker, eewLogger);

    const msg2 = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
    const outcome = processEew(msg2, eewTracker, eewLogger);

    expect(outcome).toBeNull();
  });

  it("異なる Serial は処理する", () => {
    const msg1 = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
    processEew(msg1, eewTracker, eewLogger);

    const msg2 = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S2);
    const outcome = processEew(msg2, eewTracker, eewLogger);

    expect(outcome).not.toBeNull();
  });

  it("パース失敗は null を返す", () => {
    const msg = {
      type: "data" as const,
      version: "2.0",
      classification: "eew.forecast",
      id: "test-bad",
      passing: [],
      head: { type: "VXSE45", author: "気象庁", time: new Date().toISOString(), test: false, xml: true },
      format: "xml" as const,
      compression: null,
      encoding: "utf-8" as const,
      body: "invalid-xml",
    };
    const outcome = processEew(msg, eewTracker, eewLogger);
    expect(outcome).toBeNull();
  });

  it("stats.shouldRecord が true、category は eew", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE45_S1);
    const outcome = processEew(msg, eewTracker, eewLogger);

    expect(outcome!.stats.shouldRecord).toBe(true);
  });

  it("取消報の frameLevel は cancel", () => {
    // まず初報を送る
    const first = createMockWsDataMessage(FIXTURE_VXSE45_S1);
    processEew(first, eewTracker, eewLogger);

    const cancel = createMockWsDataMessage(FIXTURE_VXSE45_CANCEL);
    const outcome = processEew(cancel, eewTracker, eewLogger);

    expect(outcome).not.toBeNull();
    expect(outcome!.presentation.frameLevel).toBe("cancel");
  });
});
```

- [ ] **Step 2: テスト失敗確認**

Run: `npm test -- --run test/engine/presentation/processors/process-eew.test.ts`
Expected: FAIL

- [ ] **Step 3: processEew 実装**

```ts
// src/engine/presentation/processors/process-eew.ts

import type { WsDataMessage } from "../../../types";
import type { EewOutcome } from "../types";
import { parseEewTelegram } from "../../../dmdata/telegram-parser";
import { EewTracker } from "../../eew/eew-tracker";
import { EewEventLogger } from "../../eew/eew-logger";
import { eewFrameLevel, eewSoundLevel } from "../level-helpers";
import * as log from "../../../logger";

/**
 * EEW 電文を処理し EewOutcome を返す。
 * パース失敗または重複報の場合は null を返す。
 */
export function processEew(
  msg: WsDataMessage,
  eewTracker: EewTracker,
  eewLogger: EewEventLogger,
): EewOutcome | null {
  const eewInfo = parseEewTelegram(msg);
  if (!eewInfo) return null;

  const result = eewTracker.update(eewInfo);
  if (result.isDuplicate) {
    log.debug(`EEW 重複報スキップ: EventID=${eewInfo.eventId} 第${eewInfo.serial}報`);
    return null;
  }

  // ログ記録
  eewLogger.logReport(eewInfo, result);
  if (result.isCancelled && eewInfo.eventId) {
    eewLogger.closeEvent(eewInfo.eventId, "取消");
  }
  if (eewInfo.nextAdvisory && eewInfo.eventId && !result.isCancelled) {
    eewLogger.closeEvent(eewInfo.eventId, "最終報");
    eewTracker.finalizeEvent(eewInfo.eventId);
  }

  return {
    domain: "eew",
    msg,
    headType: msg.head.type,
    parsed: eewInfo,
    eewResult: result,
    stats: {
      shouldRecord: true,
      eventId: eewInfo.eventId,
    },
    presentation: {
      frameLevel: eewFrameLevel(eewInfo),
      soundLevel: eewSoundLevel(eewInfo),
      notifyCategory: "eew",
    },
  };
}
```

- [ ] **Step 4: テスト通過確認**

Run: `npm test -- --run test/engine/presentation/processors/process-eew.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/engine/presentation/processors/process-eew.ts test/engine/presentation/processors/process-eew.test.ts
git commit -m "feat(presentation): add processEew processor"
```

---

## Task 4: processEarthquake, processSeismicText, processLgObservation

**Files:**
- Create: `src/engine/presentation/processors/process-earthquake.ts`
- Create: `src/engine/presentation/processors/process-seismic-text.ts`
- Create: `src/engine/presentation/processors/process-lg-observation.ts`
- Create: `test/engine/presentation/processors/process-earthquake.test.ts`
- Create: `test/engine/presentation/processors/process-seismic-text.test.ts`
- Create: `test/engine/presentation/processors/process-lg-observation.test.ts`

### 目的

地震系3種の業務処理関数を実装する。

- [ ] **Step 1: processEarthquake テスト作成**

```ts
// test/engine/presentation/processors/process-earthquake.test.ts

import { describe, it, expect, vi } from "vitest";
import { processEarthquake } from "../../../../src/engine/presentation/processors/process-earthquake";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE53_ENCHI,
  FIXTURE_VXSE51_CANCEL,
} from "../../../helpers/mock-message";

vi.mock("../../../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

describe("processEarthquake", () => {
  it("正常な地震電文を処理して EarthquakeOutcome を返す", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const outcome = processEarthquake(msg);

    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("earthquake");
    expect(outcome!.parsed).toBeDefined();
    expect(outcome!.stats.shouldRecord).toBe(true);
    expect(outcome!.presentation.frameLevel).toBeDefined();
  });

  it("stats.maxIntUpdate が eventId + maxInt 付きで設定される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const outcome = processEarthquake(msg);

    // VXSE53 の震度情報がある場合
    if (outcome && outcome.parsed.intensity?.maxInt) {
      expect(outcome.stats.maxIntUpdate).toBeDefined();
      expect(outcome.stats.maxIntUpdate!.headType).toBe("VXSE53");
    }
  });

  it("取消報の frameLevel は cancel", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE51_CANCEL);
    const outcome = processEarthquake(msg);

    expect(outcome).not.toBeNull();
    expect(outcome!.presentation.frameLevel).toBe("cancel");
  });

  it("パース失敗は null を返す", () => {
    const msg = {
      type: "data" as const,
      version: "2.0",
      classification: "telegram.earthquake",
      id: "test-bad",
      passing: [],
      head: { type: "VXSE53", author: "気象庁", time: new Date().toISOString(), test: false, xml: true },
      format: "xml" as const,
      compression: null,
      encoding: "utf-8" as const,
      body: "invalid-xml",
    };
    const outcome = processEarthquake(msg);
    expect(outcome).toBeNull();
  });
});
```

- [ ] **Step 2: processEarthquake 実装**

```ts
// src/engine/presentation/processors/process-earthquake.ts

import type { WsDataMessage } from "../../../types";
import type { EarthquakeOutcome } from "../types";
import { parseEarthquakeTelegram } from "../../../dmdata/telegram-parser";
import { earthquakeFrameLevel, earthquakeSoundLevel } from "../level-helpers";

export function processEarthquake(msg: WsDataMessage): EarthquakeOutcome | null {
  const eqInfo = parseEarthquakeTelegram(msg);
  if (!eqInfo) return null;

  const eventId = msg.xmlReport?.head.eventId ?? null;
  const maxIntUpdate =
    eventId && eqInfo.intensity?.maxInt
      ? { eventId, maxInt: eqInfo.intensity.maxInt, headType: msg.head.type }
      : undefined;

  return {
    domain: "earthquake",
    msg,
    headType: msg.head.type,
    parsed: eqInfo,
    stats: {
      shouldRecord: true,
      eventId,
      maxIntUpdate,
    },
    presentation: {
      frameLevel: earthquakeFrameLevel(eqInfo),
      soundLevel: earthquakeSoundLevel(eqInfo),
      notifyCategory: "earthquake",
    },
  };
}
```

- [ ] **Step 3: processSeismicText テスト + 実装**

```ts
// test/engine/presentation/processors/process-seismic-text.test.ts

import { describe, it, expect, vi } from "vitest";
import { processSeismicText } from "../../../../src/engine/presentation/processors/process-seismic-text";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE56_ACTIVITY_1,
} from "../../../helpers/mock-message";

vi.mock("../../../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

describe("processSeismicText", () => {
  it("正常なテキスト系電文を処理して SeismicTextOutcome を返す", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE56_ACTIVITY_1);
    const outcome = processSeismicText(msg);

    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("seismicText");
    expect(outcome!.stats.shouldRecord).toBe(true);
    expect(outcome!.presentation.frameLevel).toBe("info");
  });

  it("パース失敗は null を返す", () => {
    const msg = {
      type: "data" as const,
      version: "2.0",
      classification: "telegram.earthquake",
      id: "test-bad",
      passing: [],
      head: { type: "VXSE56", author: "気象庁", time: new Date().toISOString(), test: false, xml: true },
      format: "xml" as const,
      compression: null,
      encoding: "utf-8" as const,
      body: "invalid-xml",
    };
    const outcome = processSeismicText(msg);
    expect(outcome).toBeNull();
  });
});
```

```ts
// src/engine/presentation/processors/process-seismic-text.ts

import type { WsDataMessage } from "../../../types";
import type { SeismicTextOutcome } from "../types";
import { parseSeismicTextTelegram } from "../../../dmdata/telegram-parser";
import { seismicTextFrameLevel, seismicTextSoundLevel } from "../level-helpers";

export function processSeismicText(msg: WsDataMessage): SeismicTextOutcome | null {
  const textInfo = parseSeismicTextTelegram(msg);
  if (!textInfo) return null;

  return {
    domain: "seismicText",
    msg,
    headType: msg.head.type,
    parsed: textInfo,
    stats: {
      shouldRecord: true,
      eventId: msg.xmlReport?.head.eventId ?? null,
    },
    presentation: {
      frameLevel: seismicTextFrameLevel(textInfo),
      soundLevel: seismicTextSoundLevel(textInfo),
      notifyCategory: "seismicText",
    },
  };
}
```

- [ ] **Step 4: processLgObservation テスト + 実装**

```ts
// test/engine/presentation/processors/process-lg-observation.test.ts

import { describe, it, expect, vi } from "vitest";
import { processLgObservation } from "../../../../src/engine/presentation/processors/process-lg-observation";

vi.mock("../../../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

describe("processLgObservation", () => {
  it("パース失敗は null を返す", () => {
    const msg = {
      type: "data" as const,
      version: "2.0",
      classification: "telegram.earthquake",
      id: "test-bad",
      passing: [],
      head: { type: "VXSE62", author: "気象庁", time: new Date().toISOString(), test: false, xml: true },
      format: "xml" as const,
      compression: null,
      encoding: "utf-8" as const,
      body: "invalid-xml",
    };
    const outcome = processLgObservation(msg);
    expect(outcome).toBeNull();
  });
});
```

```ts
// src/engine/presentation/processors/process-lg-observation.ts

import type { WsDataMessage } from "../../../types";
import type { LgObservationOutcome } from "../types";
import { parseLgObservationTelegram } from "../../../dmdata/telegram-parser";
import { lgObservationFrameLevel, lgObservationSoundLevel } from "../level-helpers";

export function processLgObservation(msg: WsDataMessage): LgObservationOutcome | null {
  const lgInfo = parseLgObservationTelegram(msg);
  if (!lgInfo) return null;

  return {
    domain: "lgObservation",
    msg,
    headType: msg.head.type,
    parsed: lgInfo,
    stats: {
      shouldRecord: true,
      eventId: msg.xmlReport?.head.eventId ?? null,
    },
    presentation: {
      frameLevel: lgObservationFrameLevel(lgInfo),
      soundLevel: lgObservationSoundLevel(lgInfo),
      notifyCategory: "lgObservation",
    },
  };
}
```

- [ ] **Step 5: テスト通過確認**

Run: `npm test -- --run test/engine/presentation/processors/process-earthquake.test.ts test/engine/presentation/processors/process-seismic-text.test.ts test/engine/presentation/processors/process-lg-observation.test.ts`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add src/engine/presentation/processors/process-earthquake.ts \
        src/engine/presentation/processors/process-seismic-text.ts \
        src/engine/presentation/processors/process-lg-observation.ts \
        test/engine/presentation/processors/process-earthquake.test.ts \
        test/engine/presentation/processors/process-seismic-text.test.ts \
        test/engine/presentation/processors/process-lg-observation.test.ts
git commit -m "feat(presentation): add earthquake/seismicText/lgObservation processors"
```

---

## Task 5: processTsunami, processNankaiTrough

**Files:**
- Create: `src/engine/presentation/processors/process-tsunami.ts`
- Create: `src/engine/presentation/processors/process-nankai-trough.ts`
- Create: `test/engine/presentation/processors/process-tsunami.test.ts`
- Create: `test/engine/presentation/processors/process-nankai-trough.test.ts`

- [ ] **Step 1: processTsunami テスト + 実装**

```ts
// test/engine/presentation/processors/process-tsunami.test.ts

import { describe, it, expect, vi } from "vitest";
import { processTsunami } from "../../../../src/engine/presentation/processors/process-tsunami";
import { TsunamiStateHolder } from "../../../../src/engine/messages/tsunami-state";
import {
  createMockWsDataMessage,
  FIXTURE_VTSE41_WARN,
  FIXTURE_VTSE41_CANCEL,
} from "../../../helpers/mock-message";

vi.mock("../../../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

describe("processTsunami", () => {
  it("正常な津波電文を処理して TsunamiOutcome を返す", () => {
    const tsunamiState = new TsunamiStateHolder();
    const msg = createMockWsDataMessage(FIXTURE_VTSE41_WARN);
    const outcome = processTsunami(msg, tsunamiState);

    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("tsunami");
    expect(outcome!.stats.shouldRecord).toBe(true);
  });

  it("VTSE41 で tsunamiState を更新し、before/after を記録する", () => {
    const tsunamiState = new TsunamiStateHolder();
    const msg = createMockWsDataMessage(FIXTURE_VTSE41_WARN);
    const outcome = processTsunami(msg, tsunamiState);

    expect(outcome!.tsunamiLevelBefore).toBeNull(); // 初回は null
    expect(outcome!.tsunamiLevelAfter).not.toBeNull();
  });

  it("パース失敗は null を返す", () => {
    const tsunamiState = new TsunamiStateHolder();
    const msg = {
      type: "data" as const,
      version: "2.0",
      classification: "telegram.earthquake",
      id: "test-bad",
      passing: [],
      head: { type: "VTSE41", author: "気象庁", time: new Date().toISOString(), test: false, xml: true },
      format: "xml" as const,
      compression: null,
      encoding: "utf-8" as const,
      body: "invalid-xml",
    };
    const outcome = processTsunami(msg, tsunamiState);
    expect(outcome).toBeNull();
  });
});
```

```ts
// src/engine/presentation/processors/process-tsunami.ts

import type { WsDataMessage } from "../../../types";
import type { TsunamiOutcome } from "../types";
import { parseTsunamiTelegram } from "../../../dmdata/telegram-parser";
import { TsunamiStateHolder } from "../../messages/tsunami-state";
import { tsunamiFrameLevel, tsunamiSoundLevel } from "../level-helpers";

export function processTsunami(
  msg: WsDataMessage,
  tsunamiState: TsunamiStateHolder,
): TsunamiOutcome | null {
  const tsunamiInfo = parseTsunamiTelegram(msg);
  if (!tsunamiInfo) return null;

  const levelBefore = tsunamiState.getLevel();

  // VTSE41 のみ状態更新
  if (msg.head.type === "VTSE41") {
    tsunamiState.update(tsunamiInfo);
  }

  const levelAfter = tsunamiState.getLevel();

  return {
    domain: "tsunami",
    msg,
    headType: msg.head.type,
    parsed: tsunamiInfo,
    tsunamiLevelBefore: levelBefore,
    tsunamiLevelAfter: levelAfter,
    stats: {
      shouldRecord: true,
      eventId: msg.xmlReport?.head.eventId ?? null,
    },
    presentation: {
      frameLevel: tsunamiFrameLevel(tsunamiInfo),
      soundLevel: tsunamiSoundLevel(tsunamiInfo),
      notifyCategory: "tsunami",
    },
  };
}
```

- [ ] **Step 2: processNankaiTrough テスト + 実装**

```ts
// test/engine/presentation/processors/process-nankai-trough.test.ts

import { describe, it, expect, vi } from "vitest";
import { processNankaiTrough } from "../../../../src/engine/presentation/processors/process-nankai-trough";

vi.mock("../../../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

describe("processNankaiTrough", () => {
  it("パース失敗は null を返す", () => {
    const msg = {
      type: "data" as const,
      version: "2.0",
      classification: "telegram.earthquake",
      id: "test-bad",
      passing: [],
      head: { type: "VYSE50", author: "気象庁", time: new Date().toISOString(), test: false, xml: true },
      format: "xml" as const,
      compression: null,
      encoding: "utf-8" as const,
      body: "invalid-xml",
    };
    const outcome = processNankaiTrough(msg);
    expect(outcome).toBeNull();
  });
});
```

```ts
// src/engine/presentation/processors/process-nankai-trough.ts

import type { WsDataMessage } from "../../../types";
import type { NankaiTroughOutcome } from "../types";
import { parseNankaiTroughTelegram } from "../../../dmdata/telegram-parser";
import { nankaiTroughFrameLevel, nankaiTroughSoundLevel } from "../level-helpers";

export function processNankaiTrough(msg: WsDataMessage): NankaiTroughOutcome | null {
  const nankaiInfo = parseNankaiTroughTelegram(msg);
  if (!nankaiInfo) return null;

  return {
    domain: "nankaiTrough",
    msg,
    headType: msg.head.type,
    parsed: nankaiInfo,
    stats: {
      shouldRecord: true,
      eventId: msg.xmlReport?.head.eventId ?? null,
    },
    presentation: {
      frameLevel: nankaiTroughFrameLevel(nankaiInfo),
      soundLevel: nankaiTroughSoundLevel(nankaiInfo),
      notifyCategory: "nankaiTrough",
    },
  };
}
```

- [ ] **Step 3: テスト通過確認**

Run: `npm test -- --run test/engine/presentation/processors/process-tsunami.test.ts test/engine/presentation/processors/process-nankai-trough.test.ts`
Expected: PASS

- [ ] **Step 4: コミット**

```bash
git add src/engine/presentation/processors/process-tsunami.ts \
        src/engine/presentation/processors/process-nankai-trough.ts \
        test/engine/presentation/processors/process-tsunami.test.ts \
        test/engine/presentation/processors/process-nankai-trough.test.ts
git commit -m "feat(presentation): add tsunami/nankaiTrough processors"
```

---

## Task 6: processVolcano

**Files:**
- Create: `src/engine/presentation/processors/process-volcano.ts`
- Create: `test/engine/presentation/processors/process-volcano.test.ts`

### 目的

火山電文の単発処理を processVolcano として抽出する。VFVO53 アグリゲータとの統合は Task 8（ルーター書き換え）で行う。ここでは単発の VolcanoOutcome 生成にフォーカスする。

**重要**: 現行の `handleVolcano` は `parseVolcanoTelegram` → `aggregator.handle()` で、aggregator の emit コールバック内で volcano-presentation → display → state → notify を行う。Phase 1 では:
- `processVolcano` は単発火山電文（非 VFVO53 および VFVO53 取消）の VolcanoOutcome を返す
- VFVO53 バッファリング対象は引き続き aggregator が管理し、aggregator のコールバック内で VolcanoOutcome/VolcanoBatchOutcome を生成する

- [ ] **Step 1: テスト作成**

```ts
// test/engine/presentation/processors/process-volcano.test.ts

import { describe, it, expect, vi } from "vitest";
import { processVolcano } from "../../../../src/engine/presentation/processors/process-volcano";
import { VolcanoStateHolder } from "../../../../src/engine/messages/volcano-state";
import {
  createMockWsDataMessage,
  FIXTURE_VFVO54_ASH_RAPID,
} from "../../../helpers/mock-message";

vi.mock("../../../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

describe("processVolcano", () => {
  it("VFVO54 を処理して VolcanoOutcome を返す", () => {
    const volcanoState = new VolcanoStateHolder();
    const msg = createMockWsDataMessage(FIXTURE_VFVO54_ASH_RAPID);
    const outcome = processVolcano(msg, volcanoState);

    expect(outcome).not.toBeNull();
    expect(outcome!.domain).toBe("volcano");
    expect(outcome!.parsed).toBeDefined();
    expect(outcome!.volcanoPresentation).toBeDefined();
    expect(outcome!.presentation.frameLevel).toBeDefined();
  });

  it("パース失敗は null を返す", () => {
    const volcanoState = new VolcanoStateHolder();
    const msg = {
      type: "data" as const,
      version: "2.0",
      classification: "telegram.volcano",
      id: "test-bad",
      passing: [],
      head: { type: "VFVO50", author: "気象庁", time: new Date().toISOString(), test: false, xml: true },
      format: "xml" as const,
      compression: null,
      encoding: "utf-8" as const,
      body: "invalid-xml",
    };
    const outcome = processVolcano(msg, volcanoState);
    expect(outcome).toBeNull();
  });
});
```

- [ ] **Step 2: processVolcano 実装**

```ts
// src/engine/presentation/processors/process-volcano.ts

import type { WsDataMessage, ParsedVolcanoInfo } from "../../../types";
import type { VolcanoOutcome } from "../types";
import { parseVolcanoTelegram } from "../../../dmdata/telegram-parser";
import { VolcanoStateHolder } from "../../messages/volcano-state";
import { resolveVolcanoPresentation } from "../../notification/volcano-presentation";

/**
 * 火山電文を処理し VolcanoOutcome を返す。
 * パース失敗は null。
 * 注意: VFVO53 アグリゲータとの連携はルーター側で行う。
 */
export function processVolcano(
  msg: WsDataMessage,
  volcanoState: VolcanoStateHolder,
): VolcanoOutcome | null {
  const volcanoInfo = parseVolcanoTelegram(msg);
  if (!volcanoInfo) return null;

  return buildVolcanoOutcome(msg, volcanoInfo, volcanoState);
}

/** パース済み火山情報から VolcanoOutcome を構築する (aggregator コールバックからも使用) */
export function buildVolcanoOutcome(
  msg: WsDataMessage,
  volcanoInfo: ParsedVolcanoInfo,
  volcanoState: VolcanoStateHolder,
): VolcanoOutcome {
  const presentation = resolveVolcanoPresentation(volcanoInfo, volcanoState);
  const isRenotification =
    volcanoInfo.kind === "alert" ? volcanoState.isRenotification(volcanoInfo) : false;

  return {
    domain: "volcano",
    msg,
    headType: msg.head.type,
    parsed: volcanoInfo,
    volcanoPresentation: presentation,
    isRenotification,
    stats: {
      shouldRecord: true,
      eventId: msg.xmlReport?.head.eventId ?? null,
    },
    presentation: {
      frameLevel: presentation.frameLevel,
      soundLevel: presentation.soundLevel,
      notifyCategory: "volcano",
    },
  };
}
```

- [ ] **Step 3: テスト通過確認**

Run: `npm test -- --run test/engine/presentation/processors/process-volcano.test.ts`
Expected: PASS

- [ ] **Step 4: コミット**

```bash
git add src/engine/presentation/processors/process-volcano.ts \
        test/engine/presentation/processors/process-volcano.test.ts
git commit -m "feat(presentation): add volcano processor"
```

---

## Task 7: processRaw + processMessage Dispatcher

**Files:**
- Create: `src/engine/presentation/processors/process-raw.ts`
- Create: `src/engine/presentation/processors/process-message.ts`
- Create: `test/engine/presentation/processors/process-raw.test.ts`
- Create: `test/engine/presentation/processors/process-message.test.ts`

### 目的

フォールバック用の processRaw と、ルートからプロセッサを選択する processMessage ディスパッチャ。

- [ ] **Step 1: processRaw 実装**

```ts
// src/engine/presentation/processors/process-raw.ts

import type { WsDataMessage } from "../../../types";
import type { RawOutcome } from "../types";

/** フォールバック: 認識できない電文の ProcessOutcome */
export function processRaw(msg: WsDataMessage): RawOutcome {
  return {
    domain: "raw",
    msg,
    headType: msg.head.type,
    parsed: null,
    stats: {
      shouldRecord: true,
    },
    presentation: {
      frameLevel: "info",
    },
  };
}
```

- [ ] **Step 2: processMessage ディスパッチャ実装**

```ts
// src/engine/presentation/processors/process-message.ts

import type { WsDataMessage } from "../../../types";
import type { ProcessOutcome } from "../types";
import { EewTracker } from "../../eew/eew-tracker";
import { EewEventLogger } from "../../eew/eew-logger";
import { TsunamiStateHolder } from "../../messages/tsunami-state";
import { VolcanoStateHolder } from "../../messages/volcano-state";
import { processEew } from "./process-eew";
import { processEarthquake } from "./process-earthquake";
import { processSeismicText } from "./process-seismic-text";
import { processLgObservation } from "./process-lg-observation";
import { processTsunami } from "./process-tsunami";
import { processNankaiTrough } from "./process-nankai-trough";
import { processVolcano } from "./process-volcano";
import { processRaw } from "./process-raw";

/** processMessage に必要な依存群 */
export interface ProcessDeps {
  eewTracker: EewTracker;
  eewLogger: EewEventLogger;
  tsunamiState: TsunamiStateHolder;
  volcanoState: VolcanoStateHolder;
}

/**
 * ルートに応じた processXxx を呼び出し ProcessOutcome を返す。
 * パース失敗の場合は RawOutcome にフォールバックする。
 *
 * 注意: route === "volcano" の場合、VFVO53 アグリゲータとの連携は
 * 呼び出し側（ルーター）の責務。ここでは単純にパース→Outcomeを返す。
 */
export function processMessage(
  msg: WsDataMessage,
  route: string,
  deps: ProcessDeps,
): ProcessOutcome {
  switch (route) {
    case "eew": {
      const outcome = processEew(msg, deps.eewTracker, deps.eewLogger);
      // null = パース失敗 or 重複 → EEW はフォールバックせず null 扱い
      // ただし ProcessOutcome は non-null を返す必要がある
      // パース失敗は displayRawHeader で表示するため RawOutcome
      // 重複は表示不要だが、ルーター側で outcome === rawOutcome かつ
      // EEW ルートだった場合にスキップ判定する
      return outcome ?? processRaw(msg);
    }
    case "earthquake": {
      return processEarthquake(msg) ?? processRaw(msg);
    }
    case "seismicText": {
      return processSeismicText(msg) ?? processRaw(msg);
    }
    case "lgObservation": {
      return processLgObservation(msg) ?? processRaw(msg);
    }
    case "tsunami": {
      return processTsunami(msg, deps.tsunamiState) ?? processRaw(msg);
    }
    case "nankaiTrough": {
      return processNankaiTrough(msg) ?? processRaw(msg);
    }
    case "volcano": {
      return processVolcano(msg, deps.volcanoState) ?? processRaw(msg);
    }
    default: {
      return processRaw(msg);
    }
  }
}
```

- [ ] **Step 3: テスト作成**

```ts
// test/engine/presentation/processors/process-raw.test.ts

import { describe, it, expect } from "vitest";
import { processRaw } from "../../../../src/engine/presentation/processors/process-raw";
import type { WsDataMessage } from "../../../../src/types";

describe("processRaw", () => {
  it("RawOutcome を返す", () => {
    const msg = {
      type: "data" as const,
      version: "2.0",
      classification: "unknown",
      id: "test-raw",
      passing: [],
      head: { type: "ZZZZ99", author: "テスト", time: new Date().toISOString(), test: false, xml: true },
      format: "xml" as const,
      compression: null,
      encoding: "utf-8" as const,
      body: "raw",
    };
    const outcome = processRaw(msg);
    expect(outcome.domain).toBe("raw");
    expect(outcome.parsed).toBeNull();
    expect(outcome.stats.shouldRecord).toBe(true);
    expect(outcome.presentation.frameLevel).toBe("info");
  });
});
```

```ts
// test/engine/presentation/processors/process-message.test.ts

import { describe, it, expect, vi } from "vitest";
import { processMessage, ProcessDeps } from "../../../../src/engine/presentation/processors/process-message";
import { EewTracker } from "../../../../src/engine/eew/eew-tracker";
import { EewEventLogger } from "../../../../src/engine/eew/eew-logger";
import { TsunamiStateHolder } from "../../../../src/engine/messages/tsunami-state";
import { VolcanoStateHolder } from "../../../../src/engine/messages/volcano-state";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE53_ENCHI,
  FIXTURE_VXSE45_S1,
} from "../../../helpers/mock-message";

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    appendFileSync: vi.fn(),
    existsSync: (p: string) => {
      if (typeof p === "string" && p.includes("eew-logs")) return true;
      return actual.existsSync(p);
    },
    mkdirSync: vi.fn(),
    promises: { ...actual.promises, appendFile: vi.fn().mockResolvedValue(undefined) },
  };
});

vi.mock("../../../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

function makeDeps(): ProcessDeps {
  return {
    eewTracker: new EewTracker(),
    eewLogger: new EewEventLogger(),
    tsunamiState: new TsunamiStateHolder(),
    volcanoState: new VolcanoStateHolder(),
  };
}

describe("processMessage", () => {
  it("earthquake ルートで EarthquakeOutcome を返す", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const outcome = processMessage(msg, "earthquake", makeDeps());
    expect(outcome.domain).toBe("earthquake");
  });

  it("eew ルートで EewOutcome を返す", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE45_S1);
    const outcome = processMessage(msg, "eew", makeDeps());
    expect(outcome.domain).toBe("eew");
  });

  it("unknown ルートで RawOutcome にフォールバック", () => {
    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI, {
      classification: "unknown",
      head: { type: "ZZZZ99", author: "テスト", time: new Date().toISOString(), test: false, xml: true },
    });
    const outcome = processMessage(msg, "unknown", makeDeps());
    expect(outcome.domain).toBe("raw");
  });
});
```

- [ ] **Step 4: テスト通過確認**

Run: `npm test -- --run test/engine/presentation/processors/`
Expected: 全 PASS

- [ ] **Step 5: コミット**

```bash
git add src/engine/presentation/processors/process-raw.ts \
        src/engine/presentation/processors/process-message.ts \
        test/engine/presentation/processors/process-raw.test.ts \
        test/engine/presentation/processors/process-message.test.ts
git commit -m "feat(presentation): add processRaw and processMessage dispatcher"
```

---

## Task 8: Router Rewiring

**Files:**
- Modify: `src/engine/messages/message-router.ts`
- Modify: `test/engine/message-router.test.ts`

### 目的

`createMessageHandler` 内のハンドラを ProcessOutcome ベースに書き換える。既存の display/notify 関数は引き続き outcome.parsed データで呼び出す。

**重要な方針**:
- `handleXxx()` 関数を削除し、`processXxx()` + `dispatchOutcome()` パターンに置き換える
- VFVO53 アグリゲータのコールバック内でも `buildVolcanoOutcome()` を使って統一的に処理する
- 統計記録は `outcome.stats` から行う
- 表示・通知は既存関数をそのまま使う（引数は outcome から取り出す）

- [ ] **Step 1: message-router.ts のハンドラ関数群を削除し processMessage + dispatchOutcome に置き換え**

以下の関数を削除:
- `handleEew` (lines 89-137)
- `handleSeismicText` (lines 140-148)
- `handleLgObservation` (lines 151-159)
- `handleEarthquake` (lines 162-174)
- `handleTsunami` (lines 177-193)
- `handleNankaiTrough` (lines 196-204)
- `handleVolcano` (lines 207-217)

新たに追加:

```ts
// ── Outcome ディスパッチ ──

import { processMessage, ProcessDeps } from "../presentation/processors/process-message";
import { buildVolcanoOutcome } from "../presentation/processors/process-volcano";
import type { ProcessOutcome, VolcanoOutcome, VolcanoBatchOutcome } from "../presentation/types";

/**
 * ProcessOutcome に基づいて表示・通知を実行する。
 * 統計記録は呼び出し側で行う。
 */
function dispatchDisplay(outcome: ProcessOutcome, notifier: Notifier): void {
  switch (outcome.domain) {
    case "eew": {
      displayEewInfo(outcome.parsed, {
        activeCount: outcome.eewResult.activeCount,
        diff: outcome.eewResult.diff,
        colorIndex: outcome.eewResult.colorIndex,
      });
      notifier.notifyEew(outcome.parsed, outcome.eewResult);
      break;
    }
    case "earthquake": {
      displayEarthquakeInfo(outcome.parsed);
      notifier.notifyEarthquake(outcome.parsed);
      break;
    }
    case "seismicText": {
      displaySeismicTextInfo(outcome.parsed);
      notifier.notifySeismicText(outcome.parsed);
      break;
    }
    case "lgObservation": {
      displayLgObservationInfo(outcome.parsed);
      notifier.notifyLgObservation(outcome.parsed);
      break;
    }
    case "tsunami": {
      displayTsunamiInfo(outcome.parsed);
      notifier.notifyTsunami(outcome.parsed);
      break;
    }
    case "nankaiTrough": {
      displayNankaiTroughInfo(outcome.parsed);
      notifier.notifyNankaiTrough(outcome.parsed);
      break;
    }
    case "raw": {
      displayRawHeader(outcome.msg);
      break;
    }
    // volcano は aggregator 経由なので dispatchDisplay では扱わない
    // (aggregator コールバック内で直接 display/notify する)
  }
}

/** outcome.stats に基づいて統計を記録する */
function recordStats(outcome: ProcessOutcome, stats: TelegramStats): void {
  if (outcome.stats.shouldRecord) {
    stats.record({
      headType: outcome.headType,
      category: routeToCategory(outcome.domain === "raw" ? "raw" : outcome.domain),
      eventId: outcome.stats.eventId,
    });
  }
  if (outcome.stats.maxIntUpdate) {
    const u = outcome.stats.maxIntUpdate;
    stats.updateMaxInt(u.eventId, u.maxInt, u.headType);
  }
}
```

`createMessageHandler` の handler クロージャを書き換え:

```ts
const handler = (msg: WsDataMessage): void => {
  // XML 電文でない場合はヘッダ情報のみ表示
  if (msg.format !== "xml" || !msg.head.xml) {
    displayRawHeader(msg);
    return;
  }

  const route = classifyMessage(msg.classification, msg.head.type);

  // 火山は aggregator 経由の特殊パス
  if (route === "volcano") {
    const volcanoInfo = parseVolcanoTelegram(msg);
    if (volcanoInfo) {
      vfvo53Aggregator.handle(volcanoInfo);
    } else {
      displayRawHeader(msg);
    }
    // 火山の統計記録は aggregator コールバック内で行う
    // (非 VFVO53 は emitSingle 内、VFVO53 はバッチ flush 内)
    // ただし routeToCategory を使って即座にカウントする
    stats.record({
      headType: msg.head.type,
      category: routeToCategory(route),
      eventId: msg.xmlReport?.head.eventId ?? null,
    });
    return;
  }

  const outcome = processMessage(msg, route, processDeps);

  // EEW ルートでパース失敗 → raw にフォールバック。
  // ただし EEW 重複報で processEew が null → processRaw で
  // domain が "raw" になった場合、stats は記録しない
  if (route === "eew" && outcome.domain === "raw") {
    // EEW パース失敗 → displayRawHeader のみ、統計記録なし
    displayRawHeader(msg);
    return;
  }

  recordStats(outcome, stats);
  dispatchDisplay(outcome, notifier);
};
```

aggregator コールバックも outcome ベースに更新:

```ts
// emitSingle コールバック
(info, opts) => {
  const volcOutcome = buildVolcanoOutcome(
    // aggregator は msg を保持しないので、簡易 msg を構築する必要がある
    // → aggregator を変更して msg も保持するか、info から必要な情報を取り出す
    // Phase 1 では既存のまま display/notify を直接呼ぶ
    info as ParsedVolcanoInfo, // ← 実際は ParsedVolcanoInfo
    volcanoState,
  );
  // 既存の表示・通知パイプラインを維持
  const presentation = resolveVolcanoPresentation(info, volcanoState);
  displayVolcanoInfo(info, presentation);
  volcanoState.update(info);
  if (opts?.notify !== false) {
    notifier.notifyVolcano(info, presentation);
  }
},
```

**注意**: 火山 aggregator は WsDataMessage を保持しないため、完全な ProcessOutcome は構築できない。Phase 1 では aggregator コールバック内は既存の表示・通知パイプラインを維持し、統計記録のみルーター側で行う。aggregator の ProcessOutcome 化は Phase 2 以降で対応する。

- [ ] **Step 2: ProcessDeps インスタンスの構築**

`createMessageHandler` 内に追加:

```ts
const processDeps: ProcessDeps = {
  eewTracker,
  eewLogger,
  tsunamiState,
  volcanoState,
};
```

- [ ] **Step 3: 既存テストの更新**

`test/engine/message-router.test.ts` の統計テストは、新しいフローでも同じ結果を返すことを確認する。テストのアサーション自体は変更不要（外部動作は同じ）。

- [ ] **Step 4: テスト通過確認**

Run: `npm test -- --run`
Expected: 全テスト PASS

- [ ] **Step 5: コミット**

```bash
git add src/engine/messages/message-router.ts
git commit -m "refactor(router): rewrite handler to use processMessage + dispatchOutcome"
```

---

## Task 9: PresentationEvent Converters

**Files:**
- Create: `src/engine/presentation/events/from-eew.ts`
- Create: `src/engine/presentation/events/from-earthquake.ts`
- Create: `src/engine/presentation/events/from-seismic-text.ts`
- Create: `src/engine/presentation/events/from-lg-observation.ts`
- Create: `src/engine/presentation/events/from-tsunami.ts`
- Create: `src/engine/presentation/events/from-volcano.ts`
- Create: `src/engine/presentation/events/from-nankai-trough.ts`
- Create: `src/engine/presentation/events/from-raw.ts`
- Create: `src/engine/presentation/events/to-presentation-event.ts`
- Create: `test/engine/presentation/events/from-eew.test.ts`
- Create: `test/engine/presentation/events/to-presentation-event.test.ts`

### 目的

ProcessOutcome → PresentationEvent 変換関数群を実装する。Phase 2 の filter/template がこの PresentationEvent を参照する。

**共通パターン**: 各 `fromXxxOutcome()` は outcome から PresentationEvent のフィールドを埋める。共通フィールド（id, classification, infoType, title, headline 等）は xmlReport から取り出す。ドメイン固有フィールドは parsed データから取り出す。

- [ ] **Step 1: 共通ヘルパーを含む from-raw.ts から実装**

```ts
// src/engine/presentation/events/from-raw.ts

import type { RawOutcome } from "../types";
import type { PresentationEvent } from "../types";

export function fromRawOutcome(outcome: RawOutcome): PresentationEvent {
  const xmlReport = outcome.msg.xmlReport;
  return {
    id: outcome.msg.id,
    classification: outcome.msg.classification,
    domain: "raw",
    type: outcome.headType,

    infoType: xmlReport?.head.infoType ?? "不明",
    title: xmlReport?.head.title ?? outcome.headType,
    headline: xmlReport?.head.headline ?? null,
    reportDateTime: xmlReport?.head.reportDateTime ?? outcome.msg.head.time,
    publishingOffice: xmlReport?.control.publishingOffice ?? outcome.msg.head.author,
    isTest: outcome.msg.head.test,

    frameLevel: outcome.presentation.frameLevel,
    isCancellation: false,

    areaNames: [],
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames: [],
    areaCount: 0,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: 0,
    areaItems: [],

    raw: null,
  };
}
```

- [ ] **Step 2: from-eew.ts 実装**

```ts
// src/engine/presentation/events/from-eew.ts

import type { EewOutcome } from "../types";
import type { PresentationEvent } from "../types";
import { intensityToRank } from "../../../utils/intensity";

export function fromEewOutcome(outcome: EewOutcome): PresentationEvent {
  const { parsed: info, msg, eewResult } = outcome;
  const xmlReport = msg.xmlReport;

  // 予測最大震度の取得
  const forecastAreas = info.forecastIntensity?.areas ?? [];
  let forecastMaxInt: string | null = null;
  let forecastMaxIntRank: number | null = null;
  if (forecastAreas.length > 0) {
    let maxRank = 0;
    for (const area of forecastAreas) {
      const rank = intensityToRank(area.intensity);
      if (rank > maxRank) {
        maxRank = rank;
        forecastMaxInt = area.intensity;
        forecastMaxIntRank = rank;
      }
    }
  }

  return {
    id: msg.id,
    classification: msg.classification,
    domain: "eew",
    type: outcome.headType,

    infoType: info.infoType,
    title: info.title,
    headline: xmlReport?.head.headline ?? null,
    reportDateTime: xmlReport?.head.reportDateTime ?? msg.head.time,
    publishingOffice: xmlReport?.control.publishingOffice ?? msg.head.author,
    isTest: msg.head.test,

    frameLevel: outcome.presentation.frameLevel,
    soundLevel: outcome.presentation.soundLevel,
    notifyCategory: "eew",

    isCancellation: info.infoType === "取消",
    isWarning: info.isWarning,
    isFinal: info.nextAdvisory != null,
    isAssumedHypocenter: info.isAssumedHypocenter,

    eventId: info.eventId,
    serial: info.serial,

    hypocenterName: info.hypocenterName ?? null,
    latitude: info.latitude ?? null,
    longitude: info.longitude ?? null,
    depth: info.depth ?? null,
    magnitude: info.magnitude ?? null,

    forecastMaxInt,
    forecastMaxIntRank,

    nextAdvisory: info.nextAdvisory ?? null,
    warningComment: info.warningComment ?? null,

    areaNames: forecastAreas.map((a) => a.name),
    forecastAreaNames: forecastAreas.map((a) => a.name),
    municipalityNames: [],
    observationNames: [],
    areaCount: forecastAreas.length,
    forecastAreaCount: forecastAreas.length,
    municipalityCount: 0,
    observationCount: 0,
    areaItems: forecastAreas.map((a) => ({
      name: a.name,
      code: a.code,
      kind: "forecast",
      maxInt: a.intensity,
    })),

    raw: info,
    stateSnapshot: {
      kind: "eew",
      activeCount: eewResult.activeCount,
      colorIndex: eewResult.colorIndex,
      isCancelled: eewResult.isCancelled,
      diff: eewResult.diff,
    },
  };
}
```

- [ ] **Step 3: from-earthquake.ts, from-seismic-text.ts, from-lg-observation.ts, from-tsunami.ts, from-volcano.ts, from-nankai-trough.ts を実装**

各コンバータは同じパターンに従う:
1. outcome.parsed から PresentationEvent のフィールドを取り出す
2. 地域リスト (areaNames 等) を parsed データのリストから抽出
3. `raw` に parsed データを格納
4. 該当する stateSnapshot を設定

**実装者への指示**: 各 `fromXxxOutcome()` 関数は `from-eew.ts` と `from-raw.ts` のパターンに従って実装する。共通フィールド（id, classification, infoType, title, headline, reportDateTime, publishingOffice, isTest, isCancellation）は xmlReport から取り出す。ドメイン固有フィールドは parsed データの型定義 (`src/types.ts`) を参照して正しくマッピングする。

各ファイルの具体的なマッピング:

**from-earthquake.ts**: `info.earthquake?.hypocenter` から震源情報、`info.intensity` から震度情報、`info.intensity?.prefectures` → areaNames

**from-seismic-text.ts**: `info.bodyText` → bodyText、地域情報は空

**from-lg-observation.ts**: `info.maxLgInt` → maxLgInt、`info.observations` → observationNames/areaItems

**from-tsunami.ts**: `info.forecast` → forecastAreaNames/areaItems、`tsunamiKinds` → 各 forecast.kind のリスト、stateSnapshot に tsunami 状態

**from-volcano.ts**: `info.volcanoCode/volcanoName` → volcanoCode/volcanoName、`info.alertLevel` → alertLevel、stateSnapshot に volcano 状態

**from-nankai-trough.ts**: `info.infoSerial?.code` → infoSerialCode、`info.bodyText` → bodyText

- [ ] **Step 4: to-presentation-event.ts ディスパッチャ実装**

```ts
// src/engine/presentation/events/to-presentation-event.ts

import type { ProcessOutcome, PresentationEvent } from "../types";
import { fromEewOutcome } from "./from-eew";
import { fromEarthquakeOutcome } from "./from-earthquake";
import { fromSeismicTextOutcome } from "./from-seismic-text";
import { fromLgObservationOutcome } from "./from-lg-observation";
import { fromTsunamiOutcome } from "./from-tsunami";
import { fromVolcanoOutcome } from "./from-volcano";
import { fromNankaiTroughOutcome } from "./from-nankai-trough";
import { fromRawOutcome } from "./from-raw";

export function toPresentationEvent(outcome: ProcessOutcome): PresentationEvent {
  switch (outcome.domain) {
    case "eew":
      return fromEewOutcome(outcome);
    case "earthquake":
      return fromEarthquakeOutcome(outcome);
    case "seismicText":
      return fromSeismicTextOutcome(outcome);
    case "lgObservation":
      return fromLgObservationOutcome(outcome);
    case "tsunami":
      return fromTsunamiOutcome(outcome);
    case "volcano":
      if ("isBatch" in outcome) {
        return fromVolcanoOutcome(outcome);
      }
      return fromVolcanoOutcome(outcome);
    case "nankaiTrough":
      return fromNankaiTroughOutcome(outcome);
    case "raw":
      return fromRawOutcome(outcome);
  }
}
```

- [ ] **Step 5: テスト作成**

```ts
// test/engine/presentation/events/from-eew.test.ts

import { describe, it, expect, vi } from "vitest";
import { fromEewOutcome } from "../../../../src/engine/presentation/events/from-eew";
import { processEew } from "../../../../src/engine/presentation/processors/process-eew";
import { EewTracker } from "../../../../src/engine/eew/eew-tracker";
import { EewEventLogger } from "../../../../src/engine/eew/eew-logger";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE43_WARNING_S1,
} from "../../../helpers/mock-message";

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    appendFileSync: vi.fn(),
    existsSync: (p: string) => {
      if (typeof p === "string" && p.includes("eew-logs")) return true;
      return actual.existsSync(p);
    },
    mkdirSync: vi.fn(),
    promises: { ...actual.promises, appendFile: vi.fn().mockResolvedValue(undefined) },
  };
});

describe("fromEewOutcome", () => {
  it("EewOutcome を PresentationEvent に変換する", () => {
    const eewTracker = new EewTracker();
    const eewLogger = new EewEventLogger();
    const msg = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
    const outcome = processEew(msg, eewTracker, eewLogger)!;
    const event = fromEewOutcome(outcome);

    expect(event.domain).toBe("eew");
    expect(event.id).toBe(msg.id);
    expect(event.isWarning).toBe(true);
    expect(event.frameLevel).toBe("critical");
    expect(event.raw).toBe(outcome.parsed);
    expect(event.stateSnapshot?.kind).toBe("eew");
  });
});
```

```ts
// test/engine/presentation/events/to-presentation-event.test.ts

import { describe, it, expect, vi } from "vitest";
import { toPresentationEvent } from "../../../../src/engine/presentation/events/to-presentation-event";
import { processMessage, ProcessDeps } from "../../../../src/engine/presentation/processors/process-message";
import { EewTracker } from "../../../../src/engine/eew/eew-tracker";
import { EewEventLogger } from "../../../../src/engine/eew/eew-logger";
import { TsunamiStateHolder } from "../../../../src/engine/messages/tsunami-state";
import { VolcanoStateHolder } from "../../../../src/engine/messages/volcano-state";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE53_ENCHI,
} from "../../../helpers/mock-message";

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    appendFileSync: vi.fn(),
    existsSync: (p: string) => {
      if (typeof p === "string" && p.includes("eew-logs")) return true;
      return actual.existsSync(p);
    },
    mkdirSync: vi.fn(),
    promises: { ...actual.promises, appendFile: vi.fn().mockResolvedValue(undefined) },
  };
});

vi.mock("../../../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

describe("toPresentationEvent", () => {
  it("EarthquakeOutcome を PresentationEvent に変換", () => {
    const deps: ProcessDeps = {
      eewTracker: new EewTracker(),
      eewLogger: new EewEventLogger(),
      tsunamiState: new TsunamiStateHolder(),
      volcanoState: new VolcanoStateHolder(),
    };
    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const outcome = processMessage(msg, "earthquake", deps);
    const event = toPresentationEvent(outcome);

    expect(event.domain).toBe("earthquake");
    expect(event.type).toBe("VXSE53");
    expect(event.id).toBe(msg.id);
  });
});
```

- [ ] **Step 6: テスト通過確認**

Run: `npm test -- --run test/engine/presentation/events/`
Expected: PASS

- [ ] **Step 7: 全テスト確認**

Run: `npm test -- --run`
Expected: 全テスト PASS

- [ ] **Step 8: コミット**

```bash
git add src/engine/presentation/events/ test/engine/presentation/events/
git commit -m "feat(presentation): add PresentationEvent converters and toPresentationEvent dispatcher"
```

---

## Task 10: Integration Verification + Spec Sync

**Files:**
- Modify: `docs/superpowers/specs/2026-03-28-fleq-cli-enhancement-unified.md` — Phase 1 ステータス更新

- [ ] **Step 1: 全テスト実行**

Run: `npm test -- --run`
Expected: 全テスト PASS

- [ ] **Step 2: ビルド確認**

Run: `npm run build`
Expected: エラーなし

- [ ] **Step 3: コミット**

最終的なクリーンアップがあれば実施し、コミット。

```bash
git commit -m "chore(presentation): Phase 1 integration verification complete"
```
