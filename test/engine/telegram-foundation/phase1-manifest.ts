/**
 * Phase 3B まで温存する legacy `revisionOf()` の invalid/future date → nowMs
 * 昇格経路。呼出元の増減は contract test でこの一覧と双方向照合する。
 */
export const LEGACY_INVALID_DATE_NOW_PATHS = {
  helper: {
    sourceFile: "src/engine/display/standby-registry.ts",
    symbol: "revisionOf",
    fallbackNeedle:
      "Number.isNaN(parsed) || parsed > nowMs + FUTURE_TOLERANCE_MS ? nowMs : parsed",
  },
  callers: [
    {
      sourceFile: "src/engine/display/flood-active-reducer.ts",
      callCount: 1,
      statePath: "flood active event/tombstone revision",
    },
    {
      sourceFile: "src/engine/display/project-event.ts",
      callCount: 1,
      statePath: "earthquake map layer revision",
    },
    {
      sourceFile: "src/engine/display/quake-extreme-store.ts",
      callCount: 1,
      statePath: "震度7 background revision",
    },
    {
      sourceFile: "src/engine/display/standby-state-store.ts",
      callCount: 9,
      statePath:
        "weather/nankai/tornado/long-period/quake host/typhoon/volcano seed/heat standby revisions",
    },
  ],
} as const;

export const PHASE1_COMMON_HELPERS = [
  "src/dmdata/special-value.ts",
  "src/dmdata/telegram-meta.ts",
  "src/dmdata/xml-shape.ts",
] as const;

/**
 * Shadow 比較は fixture の見かけ上の値ではなく、旧 runtime 返却型が
 * SpecialValue の状態を区別して運べるかで分類する。
 */
export const PHASE1_SHADOW_CLASSIFICATION_CONTRACT = {
  preserved:
    "旧返却型が observed state を他 state（特に missing/empty）と区別し、raw・属性・bounds を欠落なく保持する",
  "partially-preserved":
    "observed state の値または表示意味は他 state と区別して残るが、raw・属性・bounds の一部を失う",
  collapsed:
    "observed state が旧返却型で別 state と同じ表現へ潰れる。missing/empty の同一化や、本文を捨て同じ rank・属性・派生値だけを返す経路を含む",
  unproven:
    "完全な Report を既存 runtime parser に通せず、返却型との比較を実証できない",
} as const;
