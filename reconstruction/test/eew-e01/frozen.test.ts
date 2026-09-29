import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { forecastWithinAllowance, parseChromeMarkerDetail, readSelfHashed, sealSelfHash, sha256Hex, verifyChromeSmokeConditions, verifyFrozenManifest } from "../../src/measurement/eew-e01/frozen";
import { H, makeManifest } from "./fixtures";

const ZERO = "0".repeat(64);
const CONVENTION = "sha256 of UTF-8 file bytes with meta.sha256 replaced by 64 ASCII zeroes";
const smokeText = readFileSync(join(__dirname, "evidence/chrome-smoke-conditions.json"), "utf8");

// 契約の保存 text: meta.sha256 を 0 置換した bytes の sha256 を自身の meta.sha256 に入れる（check-contract.mjs と同じ規約）。
function contractText(): { text: string; sha: string } {
  const at = (h: string) => `{"meta":{"draftedFromOid":"${"1".repeat(40)}","sha256":"${h}","hashConvention":"${CONVENTION}"}}`;
  const sha = sha256Hex(at(ZERO));
  return { text: at(sha), sha };
}

function frozenInputs(patch: (m: Record<string, unknown>) => void = () => {}, patchTrial: (t: Record<string, unknown>) => void = () => {}) {
  const contract = contractText();
  const trialObject: Record<string, unknown> = {
    schemaVersion: "p2-eew-trial-setup-v1", initialStateRef: "s.json", initialStateSha256: H,
    initialCheckpoints: { "U-E": { ref: null, sha256: null }, "U-W": { ref: "w.json", sha256: H }, "U-F": { ref: null, sha256: null } },
    clock: { wallTimeOriginMs: 0, monotonicOrigin: "runNodeClock" },
    resetBeforeEachTrial: ["reset"], prepareDirtyGeneration: ["dirty"], preventReplacementUntilPaintOrTimeout: ["hold"],
  };
  patchTrial(trialObject);
  const trialSetup = JSON.stringify(trialObject, null, 2);
  const smoke = verifyChromeSmokeConditions(smokeText);
  const m: Record<string, unknown> = {
    ...makeManifest(), manifestSha256: ZERO, contractSha256: { "P2-X": contract.sha }, trialSetupSha256: sha256Hex(trialSetup),
    smokeConditionsSha256: smoke.conditionsSha256, chrome: smoke.chrome, geometrySha256: smoke.geometrySha256, fixtureSha256: smoke.fixtureSha256,
  };
  patch(m);
  return { manifestText: sealSelfHash(JSON.stringify(m, null, 2), "manifestSha256"), trialSetupText: trialSetup, smokeConditionsText: smokeText, contractTexts: { "P2-X": contract.text } };
}

describe("P2-A10-T01 self-hash and freeze boundary", () => {
  it("凍結済みの実 smoke 条件ファイルが自己 hash 規約で PASS し、1 文字の改変は拒否される", () => {
    expect(verifyChromeSmokeConditions(smokeText).chrome.dpr).toBe(2);
    expect(() => verifyChromeSmokeConditions(smokeText.replace('"dpr": 2', '"dpr": 3'))).toThrow(/mismatch/);
  });

  it("置換するのはトップレベルの自己 hash だけ。入れ子の同名 field は不変、重複キー・大文字 hex は拒否", () => {
    const nested = sealSelfHash(`{"a":{"h":"${ZERO}"},"h":"${ZERO}"}`, "h");
    const upper = nested.replace(/("h":")([0-9a-f]{64})(?="\}$)/, (_, a: string, h: string) => a + h.toUpperCase());
    expect(readSelfHashed(nested, "h")).toMatchObject({ a: { h: ZERO } });
    expect(() => readSelfHashed(`{"h":"${ZERO}","h":"${ZERO}"}`, "h")).toThrow(/duplicate/);
    expect(() => readSelfHashed(upper, "h")).toThrow(/lowercase hex/);
  });

  it("manifest は trialSetup/smoke/使用契約の hash と一致する凍結物だけ通り、差異記録なしの smoke 差異・空手順・契約 hash 不一致を拒否する", () => {
    const ok = frozenInputs();
    expect(verifyFrozenManifest(ok).manifest.manifestId).toBe("m1");
    expect(() => verifyFrozenManifest(frozenInputs((m) => { m["chrome"] = { ...(m["chrome"] as object), dpr: 1 }; }))).toThrow(/differences/);
    expect(() => verifyFrozenManifest(frozenInputs(() => {}, (t) => { t["resetBeforeEachTrial"] = []; }))).toThrow(/non-empty/);
    expect(() => verifyFrozenManifest({ ...ok, contractTexts: { "P2-X": ok.contractTexts["P2-X"]!.replace("1".repeat(40), "2".repeat(40)) } })).toThrow(/contract digest/);
    expect(() => verifyFrozenManifest(frozenInputs((m) => { m["contractSha256"] = {}; }))).toThrow(/contractSha256/);
    expect(() => verifyFrozenManifest(frozenInputs((m) => { m["samplesPerRun"] = 999; }))).toThrow(/run counts/);
  });

  it("U-F が許容範囲を外れた試行は正式標本から除かず別条件として記録し、その run の正式 Pass を主張しない（判定式のみ。Pass を落とす処理は runner）", () => {
    const m = makeManifest();
    expect(forecastWithinAllowance(m, { subjects: 5, encodedBytes: 2000 })).toBe(true);
    expect(forecastWithinAllowance(m, { subjects: 6, encodedBytes: 100 })).toBe(false);
  });
});

describe("P2-A10-T08 marker boundary", () => {
  it("固定名 2 種の marker detail だけを受け、他の名前と欠けた候補は拒否する", () => {
    const dv = { streamId: "s", semanticRevision: "1", sequence: 1 };
    expect(parseChromeMarkerDetail({ name: "fleq:p2:eew:T5", displayVersion: dv })).not.toBeNull();
    expect(parseChromeMarkerDetail({ name: "fleq:p2:eew:T6-candidate", displayVersion: dv, operation: "normal", subject: "s", cardMarkerId: "c", mapMarkerId: "m", mapAreaCodes: [] })).not.toBeNull();
    const withTime = parseChromeMarkerDetail({ name: "fleq:p2:eew:T6-candidate", displayVersion: dv, operation: "normal", subject: "s", cardMarkerId: "c", mapMarkerId: "m", mapAreaCodes: [], startTime: 5 });
    expect(withTime).not.toBeNull();
    expect(withTime).not.toHaveProperty("startTime");
    expect(parseChromeMarkerDetail({ name: "fleq:p2:eew:T5", displayVersion: { ...dv, sequence: "1" } })).toBeNull();
    expect(parseChromeMarkerDetail({ name: "fleq:p2:eew:T6", displayVersion: dv })).toBeNull();
    expect(parseChromeMarkerDetail({ name: "fleq:p2:eew:T6-candidate", displayVersion: dv })).toBeNull();
  });
});
