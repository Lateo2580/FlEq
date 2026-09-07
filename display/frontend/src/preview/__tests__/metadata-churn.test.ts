/**
 * preview 限定 metadata churn ハーネスの契約（Issue #15 / spec §3.4・分岐 5 A・§5.1）。
 *
 * 守るのは「既定無効」と「production 経路に影響しない」の二点。前者は純関数の単体で、
 * 後者は production entry（App.svelte とその読み込む main.ts）にハーネスの名前が
 * 一切現れないことを実ファイルの読み取りで固定する。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseMetadataChurnMs } from "../metadata-churn";

describe("parseMetadataChurnMs", () => {
  it("パラメータ非指定・不正値は無効 (既定無効)", () => {
    for (const raw of [null, undefined, "", " ", "abc", "0", "-1", "1.5", "500ms", "1e3", " 500"]) {
      expect(parseMetadataChurnMs(raw), `${String(raw)} must be disabled`).toBeNull();
    }
  });

  it("正整数のときだけ churn 間隔として有効になる", () => {
    expect(parseMetadataChurnMs("1")).toBe(1);
    expect(parseMetadataChurnMs("500")).toBe(500);
    expect(parseMetadataChurnMs("60000")).toBe(60_000);
  });
});

describe("production 経路への非流出", () => {
  const productionSources = ["../../App.svelte", "../../main.ts"] as const;

  for (const relative of productionSources) {
    it(`${relative} は metadataChurn を参照しない`, () => {
      const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
      expect(source).not.toContain("metadataChurn");
      expect(source).not.toContain("metadata-churn");
    });
  }
});
