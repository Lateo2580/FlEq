import { describe, expect, it } from "vitest";
import {
  CLASSIFICATION_HEAD_TYPE_REGISTRY,
  clearVerifiedContractClassifications,
  getVerifiedContractClassifications,
  guaranteedHeadTypesForClassifications,
  setVerifiedContractClassifications,
} from "../../src/dmdata/delivery-capabilities";
import { AppConfig, DEFAULT_CONFIG } from "../../src/types";

function createConfig(): AppConfig {
  return {
    apiKey: "test-key",
    ...DEFAULT_CONFIG,
  };
}

describe("delivery capabilities", () => {
  it("registry は eew.forecast から VXSE45 を推測しない", () => {
    const guaranteed = guaranteedHeadTypesForClassifications(
      ["eew.forecast"],
      CLASSIFICATION_HEAD_TYPE_REGISTRY,
    );

    expect(guaranteed).toEqual(new Set(["VXSE44"]));
    expect(guaranteed.has("VXSE45")).toBe(false);
  });

  it("契約確認結果を config に混在させず、防御コピーで保持する", () => {
    const config = createConfig();
    setVerifiedContractClassifications(config, ["eew.forecast"]);

    const firstRead = getVerifiedContractClassifications(config);
    expect(firstRead).toEqual(["eew.forecast"]);
    const mutatedCopy = firstRead == null ? [] : [...firstRead];
    mutatedCopy.push("eew.warning");

    expect(getVerifiedContractClassifications(config)).toEqual(["eew.forecast"]);

    clearVerifiedContractClassifications(config);
    expect(getVerifiedContractClassifications(config)).toBeNull();
  });
});
