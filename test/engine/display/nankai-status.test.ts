import { describe, expect, it } from "vitest";
import { NANKAI_CODE_ACTIONS, nankaiBadgeAction } from "../../../src/engine/display/nankai-status";

describe("NANKAI_CODE_ACTIONS (selected_xml fixture measurements)", () => {
  it("contains every InfoSerial code observed in the twelve VYSE50/51/52 fixtures", () => {
    expect(NANKAI_CODE_ACTIONS).toEqual({
      "111": { action: "ignore", label: "調査中" },
      "112": { action: "ignore", label: "調査中" },
      "113": { action: "ignore", label: "調査中" },
      "120": { action: "activate", label: "巨大地震警戒" },
      "130": { action: "activate", label: "巨大地震注意" },
      "190": { action: "deactivate", label: "調査終了" },
      "200": { action: "ignore", label: "定例解説" },
      "210": { action: "ignore", label: "臨時解説" },
      "219": { action: "ignore", label: "臨時解説" },
    });
  });

  it("does not turn an unknown or absent code into a deactivation", () => {
    expect(nankaiBadgeAction("999")).toEqual({ action: "ignore", label: "" });
    expect(nankaiBadgeAction(null)).toEqual({ action: "ignore", label: "" });
  });
});
