export type NankaiBadgeAction = "activate" | "deactivate" | "ignore";

/**
 * InfoSerial codes measured from all selected_xml VYSE50/51/52 fixtures.
 * Unknown codes intentionally do not change the visible state.
 */
export const NANKAI_CODE_ACTIONS: Record<string, { action: NankaiBadgeAction; label: string }> = {
  "111": { action: "ignore", label: "調査中" },
  "112": { action: "ignore", label: "調査中" },
  "113": { action: "ignore", label: "調査中" },
  "120": { action: "activate", label: "巨大地震警戒" },
  "130": { action: "activate", label: "巨大地震注意" },
  "190": { action: "deactivate", label: "調査終了" },
  "200": { action: "ignore", label: "定例解説" },
  "210": { action: "ignore", label: "臨時解説" },
  "219": { action: "ignore", label: "臨時解説" },
};

export function nankaiBadgeAction(code: string | null): { action: NankaiBadgeAction; label: string } {
  return code == null ? { action: "ignore", label: "" } : NANKAI_CODE_ACTIONS[code] ?? { action: "ignore", label: "" };
}
