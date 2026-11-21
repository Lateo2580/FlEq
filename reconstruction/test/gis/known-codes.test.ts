import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";

import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";

import { buildKnownCodes } from "../../tools/gis/build-known-codes.mjs";
import type { KnownCodeTable } from "../../contracts/p4-gis-assets.types";
import known from "../../assets/gis/known-codes.v1.json";

const table: KnownCodeTable = known;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const manifest = JSON.parse(readFileSync("reconstruction/assets/gis/manifest.json", "utf8")).knownCodes;

describe("P4-GIS 既知コードの表", () => {
  // P4-GIS-T01（acceptance: AC01・AC02 の件数・AC04）
  it("入力の xlsx から同じ byte の表が作られ、sha256 と件数が manifest と一致する", () => {
    const xlsx = readFileSync(manifest.source.inputPath);
    expect(sha(xlsx)).toBe(manifest.source.inputSha256);
    const built = buildKnownCodes(xlsx);
    expect(built).toBe(readFileSync(manifest.output.path, "utf8"));
    expect(sha(built)).toBe(manifest.output.sha256);
    expect({
      forecastLocalE: table.forecastLocalE.length,
      city: table.city.length,
      tsunamiArea: table.tsunamiArea.length,
      tsunamiAreaGroup: table.tsunamiAreaGroup.length,
    }).toEqual(manifest.expectedCodeCount);
    // ふりがなが付かず、先頭の 0 が残る
    expect(table.city.find((c) => c.code === "0123500")).toEqual({ code: "0123500", name: "石狩市", forecastLocalE: "100" });
  });

  // P4-GIS-T03（corpusHistory: AC03）
  it("corpus の VXSE・VTSE の Body の区域のコードのうち表に無いものが一覧と一致し、結合・領域表現は Body に出ない", () => {
    const files = readdirSync("test/fixtures", { recursive: true, encoding: "utf8" }).filter((f) => /(VXSE|VTSE)[^/]*\.xml$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    const parser = new XMLParser({ parseTagValue: false, removeNSPrefix: true, ignoreAttributes: false });
    const picked: Record<string, string[]> = {}; // fixture 名 -> 表に無いコード
    const tsunamiBodyCodes = new Set<string>();
    const has = {
      city: new Set(table.city.map((c) => c.code)),
      vxseArea: new Set(table.forecastLocalE.map((c) => c.code)),
      vtseArea: new Set(table.tsunamiArea.map((c) => c.code)),
    };
    // 属性の付いた Code（震央地名）は parseTagValue の文字列でなく object になるので、string だけが「属性なしで中身あり」
    const walk = (node: unknown, isVtse: boolean, name: string): void => {
      if (Array.isArray(node)) return node.forEach((n) => walk(n, isVtse, name));
      if (typeof node !== "object" || node == null) return;
      for (const [key, child] of Object.entries(node)) {
        for (const item of Array.isArray(child) ? child : [child]) {
          const code = typeof item === "object" && item != null && "Code" in item ? (item as { Code: unknown }).Code : undefined;
          if ((key === "City" || key === "Area") && typeof code === "string" && code !== "") {
            if (isVtse && key === "Area") tsunamiBodyCodes.add(code);
            const set = key === "City" ? has.city : isVtse ? has.vtseArea : has.vxseArea;
            if (!set.has(code)) (picked[name] ??= []).push(code);
          }
        }
        walk(child, isVtse, name);
      }
    };
    for (const f of files) {
      const name = basename(f, ".xml");
      walk(parser.parse(readFileSync(`test/fixtures/${f}`, "utf8")).Report?.Body, name.includes("VTSE"), name);
    }
    const actual = Object.fromEntries(Object.entries(picked).map(([k, v]) => [k, [...new Set(v)].sort()]));
    expect(actual).toEqual({
      "32-35_01_03_240613_VXSE53": ["1936100", "1936200", "2213100", "2213300", "2213500", "2213600", "2213700", "2236100", "2250300", "2348200", "2360300"],
      "32-35_04_04_240613_VXSE53": ["4320100", "4530100", "4536200", "4644300", "4699900"],
      "77_01_30_260101_VXSE45_FINAL": ["999"],
      synthetic_VXSE53_station_values: ["990", "9900100"],
      synthetic_phase4a_VXSE45_special: ["990", "991", "992"],
      synthetic_phase4a_VXSE51_special: ["990", "991"],
      synthetic_phase4a_VXSE53_special: ["990", "9900100", "9900200"],
      synthetic_phase4a_VXSE62_special: ["990", "991", "992"],
    });
    expect(tsunamiBodyCodes.size).toBeGreaterThan(0); // 拾えていないと下の 0 回が空振りで通る
    for (const g of table.tsunamiAreaGroup) expect(tsunamiBodyCodes.has(g.code)).toBe(false);
  });
});
