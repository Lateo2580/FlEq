import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// display/frontend/src/lib/protocol.ts は src/engine/display/protocol.ts の
// PROTOCOL-SYNC-BEGIN〜END 区間を手動複製したもの (Task 11)。この複製がずれていないかを検証する。
const SYNC_BEGIN = "// PROTOCOL-SYNC-BEGIN";
const SYNC_END = "// PROTOCOL-SYNC-END";

function extractSyncRegion(filePath: string): string {
  const raw = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
  const begin = raw.indexOf(SYNC_BEGIN);
  const end = raw.indexOf(SYNC_END);
  if (begin === -1 || end === -1) {
    throw new Error(`${filePath}: SYNC マーカーが見つからない`);
  }
  return raw.slice(begin, end + SYNC_END.length);
}

function extractReconcileDefinition(filePath: string): string {
  const raw = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
  const begin = raw.indexOf("export interface DisplayReconcileMessageV1");
  const end = raw.indexOf("export type DisplayServerMessageWithReconcile", begin);
  if (begin === -1 || end === -1) {
    throw new Error(`${filePath}: reconcile wire 定義が見つからない`);
  }
  const semicolon = raw.indexOf(";", end);
  if (semicolon === -1) throw new Error(`${filePath}: reconcile wire union が閉じていない`);
  return raw.slice(begin, semicolon + 1);
}

describe("protocol.ts 複製の同期", () => {
  it("src/engine/display/protocol.ts と display/frontend/src/lib/protocol.ts の SYNC 区間が完全一致する", () => {
    const source = extractSyncRegion(resolve(__dirname, "../../../src/engine/display/protocol.ts"));
    const copy = extractSyncRegion(resolve(__dirname, "../../../display/frontend/src/lib/protocol.ts"));
    expect(copy).toBe(source);
  });

  it("protocol v1 のまま weatherWarningForecast kind と authoritative DTO を同期する", () => {
    const sourcePath = resolve(__dirname, "../../../src/engine/display/protocol.ts");
    const frontendPath = resolve(__dirname, "../../../display/frontend/src/lib/protocol.ts");
    for (const path of [sourcePath, frontendPath]) {
      const text = readFileSync(path, "utf8");
      expect(text).toContain("export const DISPLAY_PROTOCOL_VERSION = 1 as const");
      expect(text).toContain('kind: "weatherWarningForecast"');
      expect(text).toContain("interface DisplayWeatherWarningForecastPeriodV1");
      expect(text).toContain("pagerAnchorKey: string");
      const periodBegin = text.indexOf("export interface DisplayWeatherWarningForecastPeriodV1");
      const targetBegin = text.indexOf("export interface DisplayWeatherWarningForecastTargetV1", periodBegin);
      expect(periodBegin).toBeGreaterThanOrEqual(0);
      expect(targetBegin).toBeGreaterThan(periodBegin);
      expect(text.slice(periodBegin, targetBegin)).not.toContain("timeRef");
    }
  });

  it("台風数値の serializable rank union と semantic DTO が engine/frontend で一致する", () => {
    const source = extractSyncRegion(resolve(__dirname, "../../../src/engine/display/protocol.ts"));
    const copy = extractSyncRegion(resolve(__dirname, "../../../display/frontend/src/lib/protocol.ts"));
    const typhoonSemantic = (text: string): string => {
      const begin = text.indexOf("export type DisplayTyphoonNumericRankV1");
      const end = text.indexOf("export type DisplayLgIntensityRankV1", begin);
      if (begin === -1 || end === -1) throw new Error("typhoon numeric semantic contract が見つからない");
      return text.slice(begin, end);
    };

    expect(typhoonSemantic(copy)).toBe(typhoonSemantic(source));
    expect(typhoonSemantic(source)).toContain('{ kind: "value"; value: number }');
    expect(typhoonSemantic(source)).toContain('{ kind: "range"; lowerBound: number | null; upperBound: number | null }');
    expect(typhoonSemantic(source)).toContain('{ kind: "unranked" }');
  });

  it("reconcile wire 定義は engine/frontend で一致し、canonical DTO と exact source keys を一 frame で持つ", () => {
    const sourcePath = resolve(__dirname, "../../../src/engine/display/protocol.ts");
    const frontendPath = resolve(__dirname, "../../../display/frontend/src/lib/protocol.ts");
    const source = extractReconcileDefinition(sourcePath);
    const copy = extractReconcileDefinition(frontendPath);

    expect(copy).toBe(source);
    expect(source).toContain('type: "reconcile"');
    expect(source).toContain("event: DisplayEventDtoV1");
    expect(source).toContain("sourceEventKeys: readonly string[]");
  });
});
