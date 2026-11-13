import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { classifyHeadType } from "../../src/runtime/unit-coverage";
import { terminalReport } from "../../src/terminal/material";
import { width } from "../../src/terminal/format";
import type { TerminalUnit } from "../../src/terminal/format";
import { decodeFixture, eewUnits, plain, reportOf, reportUnit, terminal } from "./terminal-fixture";

// test/fixtures の全部を端末の単位にする（decode できない fixture は読み飛ばす）。名前は電文の地域名・観測点名（表に出るもの）。
type Sample = Readonly<{ path: string; units: TerminalUnit[]; names: string[]; hasEllipsis: boolean; tsunami: boolean }>;
function samples(): Sample[] {
  const root = "test/fixtures";
  const paths = (readdirSync(root, { recursive: true }) as string[]).filter((path) => path.endsWith(".xml")).sort();
  return paths.flatMap((path): Sample[] => {
    const headType = /(V[A-Z]{3}\d\d)/.exec(path)?.[1];
    const route = headType == null ? null : classifyHeadType(headType);
    if (route == null || route.status !== "ready") return [];
    const hasEllipsis = readFileSync(`${root}/${path}`, "utf8").includes("…");
    // 読み飛ばすのは decode できない fixture だけ（整形や unit の例外は隠さない）。
    try { decodeFixture(path); } catch { return []; }
    if (route.unit === "U-E") {
      const units = eewUnits([path]).flat();
      const names = units.flatMap((unit) => unit.kind !== "eew" ? [] : (unit.subject.facts.report as { areas?: { name: string }[] } | null)?.areas?.map((area) => area.name) ?? []);
      return [{ path, units, names, hasEllipsis, tsunami: false }];
    }
    const report = terminalReport(decodeFixture(path), route.unit);
    if (report == null) return [];
    const names = report.kind === "seismic" ? report.areas.map((area) => area.name)
      : report.kind === "tsunami" ? [...report.areas.filter((area) => !/^津波なし/.test(area.kindName ?? "")), ...report.estimations].map((area) => area.name) : [];
    return [{ path, units: [reportUnit(report)], names, hasEllipsis, tsunami: report.kind === "tsunami" }];
  });
}
const SAMPLES = samples();
const squash = (lines: readonly string[]): string => lines.join("").replace(/[ 　]/g, "");
const COLUMNS = [40, 56, 59, 60, 61, 80, 100, 120] as const;

describe("P3-TL-T05 全 fixture を 8 つの桁数・色 0 と 3 に通す（契約境界、AC02・AC03）", () => {
  it("fixture が 200 本以上読め、どの桁数でも線と本文は min(桁数, 100) を越えず、… の切り詰めが無く、電文の地域名が全部残る", () => {
    expect(SAMPLES.length).toBeGreaterThan(200);
    for (const level of [0, 3] as const) for (const columns of COLUMNS) {
      const shared = terminal(columns, level);
      for (const sample of SAMPLES) {
        // 名前は fixture ごとの端末で見る。共有の端末では同じ EventID で VXSE45 を受けた後の VXSE43 が畳まれて 0 行になり（format.ts の fold、P3-TL2-AC10）、
        // 合成の VXSE43 は path の順で 77_01_* の後に描かれる（P3-EEW-SAME-CORRECTION-001）。幅と … は続報の形も見るため共有の端末でも確かめる。
        const lines = terminal(columns, level)(sample.units).map(plain);
        for (const drawn of [lines, shared(sample.units).map(plain)]) {
          const over = drawn.filter((line) => !line.trim().startsWith("https://") && width(line) > Math.min(columns, 100));
          expect(over, `${sample.path} ${columns}/${level}`).toEqual([]);
          if (!sample.hasEllipsis) expect(drawn.some((line) => line.includes("…")), `${sample.path} ${columns}/${level} …`).toBe(false);
        }
        const joined = squash(lines);
        expect(sample.names.filter((name) => !joined.includes(name.replace(/[ 　]/g, ""))), `${sample.path} ${columns}/${level} names`).toEqual([]);
      }
    }
  });

  it("60 桁以上は、津波の fixture の全部で表が地域の行と値の行の 2 行の形に落ちない。56 桁でも 32-39_11_11 は 1 地域 1 行", () => {
    const tsunami = SAMPLES.filter((sample) => sample.tsunami);
    expect(tsunami.length).toBeGreaterThanOrEqual(20);
    const twoRow = (columns: number, level: 0 | 3, sample: Sample) => terminal(columns, level)(sample.units).map((line) => plain(line).trim())
      .filter((line) => line === "地域" || line === "観測点" || line === "沖合の観測点");
    for (const level of [0, 3] as const) for (const columns of [60, 61, 80, 100, 120]) {
      for (const sample of tsunami) expect(twoRow(columns, level, sample), `${sample.path} ${columns}/${level}`).toEqual([]);
    }
    const fiftySix = SAMPLES.find((sample) => sample.path.includes("32-39_11_11"))!;
    expect(twoRow(56, 0, fiftySix)).toEqual([]);
  });

  it("VTSE52 の最大波の高さは 40 桁でも全観測点に残る（監査 A1）", () => {
    const offshore = reportOf("32-39_12_05_250206_VTSE52.xml", "U-T");
    if (offshore.kind !== "tsunami") throw new Error(offshore.kind);
    const text = terminal(40, 0)([reportUnit(offshore)]).join("\n");
    expect(offshore.stations).toHaveLength(8);
    for (const station of offshore.stations) expect(text, station.name).toContain(`${station.maxHeight!.description!.normalize("NFKC")}（`);
  });
});
