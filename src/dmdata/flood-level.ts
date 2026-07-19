import {
  type FloodLevel,
  type FloodKindCode,
  type FrameLevel,
  type SoundLevel,
  FLOOD_LEVEL_RANK,
  FLOOD_KIND_CODE_TO_LEVEL,
} from "../types";

export { FLOOD_LEVEL_RANK };

/**
 * Kind.Code → FloodLevel 解決. spec §3 の FLOOD_KIND_CODE_TO_LEVEL を引く.
 */
export function floodKindCodeToLevel(code: FloodKindCode): FloodLevel {
  return FLOOD_KIND_CODE_TO_LEVEL[code];
}

/**
 * 複数 FloodLevel から FLOOD_LEVEL_RANK 最大を返す. 空配列は "unknown".
 */
export function maxFloodLevel(levels: FloodLevel[]): FloodLevel {
  if (levels.length === 0) return "unknown";
  let best: FloodLevel = "unknown";
  let bestRank = FLOOD_LEVEL_RANK.unknown;
  for (const level of levels) {
    const rank = FLOOD_LEVEL_RANK[level];
    if (rank > bestRank) {
      best = level;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * FloodLevel → FrameLevel. spec §6.1 の対応表に従う.
 * L4/L5 = critical (VPWP50 Phase B Code 41 と同型).
 */
export function floodLevelToFrameLevel(level: FloodLevel): FrameLevel {
  switch (level) {
    case "release": return "cancel";
    case "L1": return "info";
    case "L2": return "normal";
    case "L3": return "warning";
    case "L4": return "critical";
    case "L5": return "critical";
    case "unknown": return "info";
  }
}

/**
 * FloodLevel → SoundLevel.
 * critical 音 = 特別警報の名を持つもののみ (memory vpww-phase-d-complete 原則).
 * L4 (氾濫危険警報) は表示 critical / 音 warning (heatAlert 同型).
 */
export function floodLevelToSoundLevel(level: FloodLevel): SoundLevel {
  switch (level) {
    case "release": return "cancel";
    case "L1": return "info";
    case "L2": return "normal";
    case "L3": return "warning";
    case "L4": return "warning";   // critical 表示だが音は warning
    case "L5": return "critical";
    case "unknown": return "info";
  }
}
