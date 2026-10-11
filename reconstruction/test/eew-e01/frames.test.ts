import { describe, expect, it } from "vitest";

import { C_CYCLE, WALL_ORIGIN_MS, cycleCFrames, nearCapacityFrames, shiftTimestamps, validUntilMs } from "./frames.mjs";
import type { XmlInput } from "./frames.mjs";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { initialUnits } from "../../src/runtime/owner-runtime";
import { reduceEewUnit } from "../../src/units/eew/eew-unit";

const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? "";
// 製品の subject と同じ切り分け: 運用・電文種別・EventID（EEW）または官署（weather）。
const subject = (f: XmlInput) => `${tag(f.xml, "Status")}/${f.headType}/${tag(f.xml, "EventID") || tag(f.xml, "EditorialOffice")}`;
// 新旧の順序は製品の基準: EEW は Serial が先で同じ Serial なら報告時刻（eew.ts:330-355）、weather は報告時刻。
const order = (f: XmlInput) => [f.headType.startsWith("VXSE") ? Number(tag(f.xml, "Serial")) : 0, Date.parse(tag(f.xml, "ReportDateTime"))];
const newer = (a: number[], b: number[]) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

describe("P2-A10-T04 fixed cycle load C (AC08)", () => {
  it("連続 3 周期は各 subject を製品の順序で厳密に進め、取消・期限回収・入れ直しで周期の終わりの保持量を変えない", () => {
    const last = new Map(nearCapacityFrames({ mode: "cycleC", eewReportAtMs: WALL_ORIGIN_MS }).map((f) => [subject(f), order(f)]));
    let expiredForecast: string | null = null;
    for (const c of [0, 1, 2]) {
      const start = WALL_ORIGIN_MS + 300_000 + c * C_CYCLE.periodMs;
      const frames = cycleCFrames(c, start);
      const [, restore, , , added, cancel, expiring] = frames;
      // 足した訓練 EventID は新しい subject で、同じ周期のうちに取消す（current は周期の終わりで一定）。
      expect(last.has(subject(added))).toBe(false);
      expect([tag(cancel.xml, "InfoType"), subject(cancel)]).toEqual(["取消", subject(added)]);
      // 前の周期で期限回収した U-F subject を、周期より長い有効期限で入れ直す。
      if (expiredForecast != null) expect(subject(restore)).toBe(expiredForecast);
      expect(validUntilMs(restore.xml)).toBeGreaterThan(start + C_CYCLE.periodMs);
      expect(validUntilMs(expiring.xml)).toBeGreaterThan(start + expiring.offsetMs);
      expect(validUntilMs(expiring.xml)).toBeLessThan(start + C_CYCLE.periodMs);
      expiredForecast = subject(expiring);
      for (const f of frames) {
        const key = subject(f);
        const previous = last.get(key);
        if (f !== added) expect(previous != null && newer(order(f), previous), key).toBe(true);
        last.set(key, order(f));
      }
    }
  });
});

// P3-MH-T01・T02: 付け直した U-E の充填と C の周期を製品の U-E の reducer に通す（K6 の horizon・寿命・容量）。
describe("P3-MH-T01/T02 retimed U-E fill and cycle C against the K6 reducer (AC01/AC02)", () => {
  const at = WALL_ORIGIN_MS + 120_000;
  const make = () => {
    let sequence = 0;
    let monotonicMs = 0;
    let state = initialUnits["U-E"];
    const step = (input: Parameters<typeof reduceEewUnit>[1]) => { const s = reduceEewUnit(state, input); state = s.state; return s; };
    const receive = (f: XmlInput, wallTimeMs: number) => {
      const entered = ingestXmlData({ inputId: `i-${++sequence}`, inputSequence: sequence, receivedAt: wallTimeMs, origin: "replay", kind: "replay", body: Buffer.from(f.xml), headType: f.headType });
      if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
      const decoded = decodeMaterial(entered.item);
      if (decoded.kind !== "decoded") throw new Error("decode failed");
      return step({ kind: "receive", material: decoded.material, clock: { wallTimeMs, monotonicMs: ++monotonicMs } });
    };
    const deadline = (wallTimeMs: number) => step({ kind: "deadline", clock: { wallTimeMs, monotonicMs: ++monotonicMs } });
    return { receive, deadline, state: () => state };
  };
  const reasons = (steps: { diagnostics: readonly { reason: string }[] }[], reason: string) => steps.flatMap((s) => s.diagnostics).filter((d) => d.reason === reason).length;
  const eew = <T extends XmlInput>(frames: T[]) => frames.filter((f) => f.headType.startsWith("VXSE"));
  const perFamily = (items: readonly { family: string }[]) => [items.filter((i) => i.family === "VXSE43").length, items.filter((i) => i.family === "VXSE45").length];

  it("T01: the retimed leaveRoomForP fill is adopted (512 per family, no stale); its currents expire at origin + 600 s while the gates stay, and a new normal EventID then evicts the oldest aged gate (P3-EVICT-AC07); the 2024 times are all eewHorizonStale", () => {
    const u = make();
    const fill = eew(nearCapacityFrames({ mode: "leaveRoomForP", room: { partials: 2, forecastSubjects: 1 }, eewReportAtMs: at }));
    const steps = fill.map((f) => u.receive(f, at + 1000));
    expect([steps.flatMap((s) => s.decisions).filter((d) => "reason" in d && d.reason === "stale").length, reasons(steps, "eewHorizonStale")]).toEqual([0, 0]);
    expect(perFamily(u.state().current)).toEqual([512, 512]);
    u.deadline(at + 600_000);
    expect([u.state().current.length, ...perFamily(u.state().gates)]).toEqual([0, 512, 512]);
    const late = u.receive({ headType: "VXSE43", xml: nearCapacityFrames({ mode: "full", eewReportAtMs: at + 600_000 })[0]!.xml.replace(/<EventID>[^<]*</, "<EventID>20261011000000<") }, at + 600_000);
    // P3-EVICT-AC07: 失効の後の gate は報時刻＋10 分を過ぎ current も intent も無いので、拒まず最古の gate を退去して受ける。
    expect([late.decisions.map((d) => d.decision), ...perFamily(u.state().gates)]).toEqual([["changed"], 512, 512]);
    expect(late.diagnostics).toContainEqual({ level: "INFO", component: "eew", reason: "eewCapacityEvicted", unit: "U-E", count: 1 });

    // 元の報時刻（VXSE43 23:14:59・VXSE45 23:14:57）のままなら全件 horizon 外（台帳76 の e02-P-run1〜3）。
    const original = { VXSE43: Date.parse("2024-04-17T23:14:59+09:00"), VXSE45: Date.parse("2024-04-17T23:14:57+09:00") } as Record<string, number>;
    const stale = make();
    const old = fill.map((f) => stale.receive({ headType: f.headType, xml: shiftTimestamps(f.xml, original[f.headType]! - at) }, at + 1000));
    expect([reasons(old, "eewHorizonStale"), stale.state().current.length]).toEqual([1024, 0]);
  });

  it("T02: after the fill expired, three retimed cycles have no stale input, evict one training gate per cycle and end each cycle with the same number of gates", () => {
    const u = make();
    for (const f of eew(nearCapacityFrames({ mode: "cycleC", eewReportAtMs: at }))) u.receive(f, at + 1000);
    u.deadline(at + 600_000);
    const gates: number[] = [];
    const evicted: number[] = [];
    let stale = 0;
    for (const c of [0, 1, 2]) {
      const start = at + 602_000 + c * C_CYCLE.periodMs;
      const steps = eew(cycleCFrames(c, start)).map((f) => u.receive(f, start + f.offsetMs));
      stale += reasons(steps, "eewHorizonStale");
      evicted.push(reasons(steps, "eewCapacityEvicted"));
      gates.push(u.state().gates.length);
    }
    expect([stale, evicted, gates]).toEqual([0, [1, 1, 1], [1024, 1024, 1024]]);
  });
});
