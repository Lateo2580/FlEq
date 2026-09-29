import { describe, expect, it } from "vitest";

import { C_CYCLE, WALL_ORIGIN_MS, cycleCFrames, nearCapacityFrames, validUntilMs } from "./frames.mjs";
import type { XmlInput } from "./frames.mjs";

const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? "";
// 製品の subject と同じ切り分け: 運用・電文種別・EventID（EEW）または官署（weather）。
const subject = (f: XmlInput) => `${tag(f.xml, "Status")}/${f.headType}/${tag(f.xml, "EventID") || tag(f.xml, "EditorialOffice")}`;
// 新旧の順序は製品の基準: EEW は Serial が先で同じ Serial なら報告時刻（eew.ts:330-355）、weather は報告時刻。
const order = (f: XmlInput) => [f.headType.startsWith("VXSE") ? Number(tag(f.xml, "Serial")) : 0, Date.parse(tag(f.xml, "ReportDateTime"))];
const newer = (a: number[], b: number[]) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

describe("P2-A10-T04 fixed cycle load C (AC08)", () => {
  it("連続 3 周期は各 subject を製品の順序で厳密に進め、取消・期限回収・入れ直しで周期の終わりの保持量を変えない", () => {
    const last = new Map(nearCapacityFrames({ mode: "cycleC" }).map((f) => [subject(f), order(f)]));
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
