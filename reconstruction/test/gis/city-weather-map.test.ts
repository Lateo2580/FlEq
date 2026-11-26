import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { CityWeatherMapTable } from "../../contracts/p4-gis-city-map.types";
import mapJson from "../../assets/gis/city-weather-map.v1.json";

const table: CityWeatherMapTable = mapJson;
const manifest = JSON.parse(readFileSync("reconstruction/assets/gis/manifest.json", "utf8")).cityWeatherMap;
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const lines = (path: string) => readFileSync(path, "utf8").split("\n").length - 2; // 見出しと末尾の改行を除く

describe("P4-GIS-CITY-MAP 市区町村→市町村等の対応表", () => {
  // P4-GCM-T01（acceptance: AC01・AC02・AC03・AC05）。組の照合は build が止める（試験で言い換えない）
  it("入力と出力の sha256・件数が manifest と一致し、読める値が引ける", () => {
    const [s1, s2] = manifest.source;
    const files: [string, string][] = [
      [manifest.output.path, manifest.output.sha256],
      [s1.inputPath, s1.inputSha256],
      [s2.inputPath, s2.inputSha256],
      [s2.transcriptionPath, s2.transcriptionSha256],
      [s2.expectedPairsPath, s2.expectedPairsSha256],
      [s2.matchPath, s2.matchSha256],
    ];
    for (const [path, want] of files) expect(sha(path), path).toBe(want);

    expect(table.schemaVersion).toBe(1);
    const rows = (relation: string) => table.rows.filter((r) => r.weatherCities[0]?.relation === relation).length;
    expect({
      rows: table.rows.length,
      same: rows("same"),
      withinRows: rows("within"),
      partRows: rows("part"),
      matchRows: lines(s2.matchPath),
      expectedPairs: lines(s2.expectedPairsPath),
      transcriptionItems: lines(s2.transcriptionPath),
    }).toEqual(manifest.expectedCodeCount);

    const get = (city: string) => table.rows.find((r) => r.city === city)?.weatherCities;
    const of = (relation: string, ...codes: string[]) => codes.map((code) => ({ code, relation }));
    expect(get("0110100")).toEqual(of("within", "0110000"));
    expect(get("0123600")).toEqual(of("same", "0123600"));
    expect(get("0148400")).toEqual(of("part", "0148401", "0148402"));
    expect(get("0120600")).toEqual(of("part", "0120601", "0120602", "0120603"));
    expect(get("0410100")).toEqual(of("part", "0410001", "0410002"));
    expect(get("1415100")).toEqual(of("within", "1415011"));
  });
});
