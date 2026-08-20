import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWeatherKindKeys as resolveEngineWeatherKindKeys } from "../../../src/engine/display/weather-expanded-kinds";
import { resolveWeatherKindKeys as resolveFrontendWeatherKindKeys } from "../../../display/frontend/src/lib/weather-expanded-kinds";

const SYNC_BEGIN = "// KINDS-SYNC-BEGIN";
const SYNC_END = "// KINDS-SYNC-END";

function extractSyncRegion(filePath: string): string {
  const raw = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
  const begin = raw.indexOf(SYNC_BEGIN);
  const end = raw.indexOf(SYNC_END);
  if (begin === -1 || end === -1) throw new Error(`${filePath}: SYNC マーカーが見つからない`);
  return raw.slice(begin, end + SYNC_END.length);
}

describe("weather-expanded-kinds.ts 複製の同期", () => {
  it("engine と frontend の KINDS 区間が完全一致する", () => {
    const source = extractSyncRegion(resolve(__dirname, "../../../src/engine/display/weather-expanded-kinds.ts"));
    const copy = extractSyncRegion(resolve(__dirname, "../../../display/frontend/src/lib/weather-expanded-kinds.ts"));
    expect(copy).toBe(source);
  });

  it("同一入力 fixture の正規化出力が engine/frontend で一致する", () => {
    const items = [
      { displaySeverity: "officialL4", kind: "L4 大雨警報", phenomenonKey: "大雨" },
      { displaySeverity: "officialL4", kind: "L4 大雨警報" },
      { displaySeverity: "officialL4", kind: "L4 洪水警報", phenomenonKey: "洪水" },
      { displaySeverity: "officialL4", kind: "L4 洪水警報", phenomenonKey: "河川洪水" },
      { displaySeverity: "officialL4", kind: "L4 洪水警報" },
      { displaySeverity: "officialL5", kind: "L5 大雨特別警報" },
    ];
    expect(resolveFrontendWeatherKindKeys(items)).toEqual(resolveEngineWeatherKindKeys(items));
    expect(resolveEngineWeatherKindKeys(items)).toEqual([
      "officialL4|大雨",
      "officialL4|大雨",
      "officialL4|洪水",
      "officialL4|河川洪水",
      "officialL4|L4 洪水警報",
      "officialL5|L5 大雨特別警報",
    ]);
  });
});
