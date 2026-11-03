import { describe, expect, it } from "vitest";

import { width } from "../../src/terminal/format";
import { allThirteen, reportOf, terminal } from "./terminal-fixture";

const NARROW_HEADERS = ["地域", "震度", "長周期階級", "観測点", "沖合の観測点"];
const isUrl = (line: string) => line.startsWith("https://");
const linesAt = (columns: number) => {
  const print = terminal(columns);
  return allThirteen().map((unit) => print([unit]));
};

describe("P3-TO-T04 60 桁の境目と 80 桁の止め（AC04）", () => {
  it("59 桁は発表時刻を次の行に出して桁を越えず、60 桁は図の形、100 桁は罫線が 80 桁。VTSE52 の 59 桁に最大波の高さが残る", () => {
    for (const lines of linesAt(59)) {
      expect(lines.filter((line) => !isUrl(line) && width(line) > 59), lines[0]).toEqual([]);
      expect(lines[0], lines[0]).not.toContain("発表");
      expect(lines[1], lines[0]).toMatch(/^\d{2}:\d{2}:\d{2} 発表$/);
    }
    const sixty = linesAt(60);
    for (const lines of sixty) {
      expect(lines.filter((line) => !isUrl(line) && width(line) > 60), lines[0]).toEqual([]);
      expect(lines.filter((line) => line.startsWith("─")).every((line) => line === "─".repeat(60)), lines[0]).toBe(true);
      expect(lines.filter((line) => NARROW_HEADERS.includes(line)), lines[0]).toEqual([]);
    }
    // 帯の題名が 60 桁に入らない VTSE41（42 桁）だけ、発表時刻を次の行に出す。
    expect(sixty.filter((lines) => !lines[0].includes("発表")).map((lines) => lines[0])).toEqual([`━ 大津波警報・津波警報・津波注意報・津波予報 ${"━".repeat(15)}`]);
    for (const lines of linesAt(100)) {
      expect(width(lines[0]), lines[0]).toBe(80);
      expect(lines.filter((line) => line.startsWith("─")).every((line) => line === "─".repeat(80)), lines[0]).toBe(true);
    }
    const offshore = reportOf("32-39_12_05_250206_VTSE52.xml", "U-T");
    if (offshore.kind !== "tsunami") throw new Error(offshore.kind);
    const narrow = linesAt(59).at(-1)!.join("\n");
    for (const station of offshore.stations) expect(narrow, station.name).toContain(`${station.maxHeight!.description!.normalize("NFKC")}（`);
    expect(offshore.stations).toHaveLength(8);
  });
});
