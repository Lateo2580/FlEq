import type { RoleName } from "../../../src/ui/theme";

export interface RoleCategory {
  label: string; // タブ表示名
  roles: RoleName[];
}

/**
 * RoleEditor のタブ構成。theme.ts の DEFAULT_ROLES コメントグループを
 * UI 向けに 7 タブへ集約したもの。全ロール網羅は role-categories.test.ts が担保。
 */
export const ROLE_CATEGORIES: readonly RoleCategory[] = [
  {
    label: "枠・共通",
    roles: [
      // frame (5)
      "frameCritical",
      "frameWarning",
      "frameNormal",
      "frameInfo",
      "frameCancel",
      // common (8)
      "testBadge",
      "correctionBadge",
      "hypocenter",
      "concurrent",
      "nextAdvisory",
      "warningComment",
      "detailUri",
      "textMuted",
      // raw header (1)
      "rawHeaderLabel",
      // stats (8)
      "statsMuted",
      "statsCount",
      "statsCategoryEew",
      "statsCategoryEarthquake",
      "statsCategoryTsunami",
      "statsCategoryVolcano",
      "statsCategoryNankaiTrough",
      "statsCategoryOther",
    ],
  },
  {
    label: "地震",
    roles: [
      // intensity (9)
      "intensity1",
      "intensity2",
      "intensity3",
      "intensity4",
      "intensity5Lower",
      "intensity5Upper",
      "intensity6Lower",
      "intensity6Upper",
      "intensity7",
      // lgIntensity (5)
      "lgInt0",
      "lgInt1",
      "lgInt2",
      "lgInt3",
      "lgInt4",
      // magnitude (3)
      "magnitudeLow",
      "magnitudeHigh",
      "magnitudeMax",
    ],
  },
  {
    label: "EEW",
    roles: [
      // eew (6)
      "eewWarningBanner",
      "eewForecastBanner",
      "eewCancelBanner",
      "plumLabel",
      "arrivedLabel",
      "cancelText",
      // eew banner palette (8)
      "eewWarningBanner1",
      "eewWarningBanner2",
      "eewWarningBanner3",
      "eewWarningBanner4",
      "eewForecastBanner1",
      "eewForecastBanner2",
      "eewForecastBanner3",
      "eewForecastBanner4",
      // plum decor (2)
      "plumDecorWarning",
      "plumDecorForecast",
    ],
  },
  {
    label: "津波",
    roles: [
      // tsunami (4)
      "tsunamiNone",
      "tsunamiAdvisory",
      "tsunamiWarning",
      "tsunamiMajor",
      // tsunami banner (4)
      "tsunamiAdvisoryBanner",
      "tsunamiWarningBanner",
      "tsunamiMajorBanner",
      "tsunamiMajorBannerDecor",
    ],
  },
  {
    label: "南海トラフ",
    roles: [
      // nankai trough (4)
      "nankaiCriticalBanner",
      "nankaiWarningBanner",
      "nankaiSerialCritical",
      "nankaiSerialWarning",
    ],
  },
  {
    label: "火山",
    roles: [
      // volcano level (5)
      "volcanoLevel1",
      "volcanoLevel2",
      "volcanoLevel3",
      "volcanoLevel4",
      "volcanoLevel5",
      // volcano phenomenon (4)
      "volcanoPhenomenonExplosion",
      "volcanoPhenomenonEruption",
      "volcanoPhenomenonFrequent",
      "volcanoPhenomenonPossible",
      // volcano ashfall (4)
      "volcanoAshfallLight",
      "volcanoAshfallModerate",
      "volcanoAshfallHeavy",
      "volcanoAshfallBallistic",
      // volcano banner (2)
      "volcanoAlertBanner",
      "volcanoFlashBanner",
    ],
  },
  {
    label: "気象",
    roles: [
      // weather warning banner (取消のみ。Special/Warning は 2026-07-19 掃除で削除)
      "weatherWarningCancelBanner",
      // weather banner chip (8)
      "weatherBannerOfficialL5",
      "weatherBannerOfficialL4",
      "weatherBannerOfficialL3",
      "weatherBannerOfficialL2",
      "weatherBannerOfficialL1",
      "weatherBannerNonLevelSpecial",
      "weatherBannerNonLevelWarning",
      "weatherBannerNonLevelAdvisory",
    ],
  },
];
