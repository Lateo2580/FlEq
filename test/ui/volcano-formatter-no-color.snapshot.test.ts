import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import chalk from "chalk";
import { displayVolcanoInfo, displayVolcanoAshfallBatch } from "../../src/ui/volcano-formatter";
import {
  resolveVolcanoPresentation,
  resolveVolcanoBatchPresentation,
} from "../../src/engine/presentation/volcano-presentation";
import { VolcanoStateHolder } from "../../src/engine/messages/volcano-state";
import { parseVolcanoTelegram } from "../../src/dmdata/volcano-parser";
import type { Vfvo53BatchItems } from "../../src/engine/messages/volcano-vfvo53-aggregator";
import type { ParsedVolcanoAshfallInfo } from "../../src/types";
import { setFrameWidth } from "../../src/ui/formatter";
import {
  createMockWsDataMessage,
  FIXTURE_VFVO50_ALERT_LV3,
  FIXTURE_VFVO52_ERUPTION_1,
  FIXTURE_VFVO53_ASH_REGULAR,
  FIXTURE_VFVO60_PLUME,
} from "../helpers/mock-message";

/** VFVO53 fixture ベースの synthetic バッチ (バッチ golden は本 Phase 新設。Studio 非対応の代替担保) */
function makeSyntheticBatch(): Vfvo53BatchItems {
  const base = parseVolcanoTelegram(
    createMockWsDataMessage(FIXTURE_VFVO53_ASH_REGULAR),
  ) as ParsedVolcanoAshfallInfo;
  const second: ParsedVolcanoAshfallInfo = {
    ...base,
    volcanoName: "合成山",
    volcanoCode: "999",
    ashForecasts: base.ashForecasts.map((p) => ({
      ...p,
      areas: p.areas.map((a) => ({ ...a, ashCode: "73", ashName: "多量" })),
    })),
  };
  return { reportDateTime: base.reportDateTime, isTest: false, items: [base, second] };
}

interface SnapCase {
  label: string;
  render: () => void;
}

function renderFixture(fixture: string): void {
  const info = parseVolcanoTelegram(createMockWsDataMessage(fixture))!;
  // 初回状態 (isRenotification=false) のプレビュー。fresh holder で決定的
  displayVolcanoInfo(info, resolveVolcanoPresentation(info, new VolcanoStateHolder()));
}

const CASES: SnapCase[] = [
  { label: "VFVO50-Lv3-alert", render: () => renderFixture(FIXTURE_VFVO50_ALERT_LV3) },
  { label: "VFVO52-eruption", render: () => renderFixture(FIXTURE_VFVO52_ERUPTION_1) },
  { label: "VFVO53-ashfall-regular", render: () => renderFixture(FIXTURE_VFVO53_ASH_REGULAR) },
  { label: "VFVO60-plume", render: () => renderFixture(FIXTURE_VFVO60_PLUME) },
  {
    label: "VFVO53-batch-synthetic",
    render: () => {
      const batch = makeSyntheticBatch();
      displayVolcanoAshfallBatch(batch, resolveVolcanoBatchPresentation(batch));
    },
  },
];

// 3 段 breakpoint の代表幅: ultra-narrow / standard / wide
const MODES: Record<string, number> = { "ultra-narrow": 60, standard: 140, wide: 180 };

describe("NO_COLOR golden snapshot (chalk.level=0)", () => {
  let logs: string[] = [];
  const originalLevel = chalk.level;
  beforeEach(() => {
    logs = [];
    chalk.level = 0;
    vi.spyOn(console, "log").mockImplementation((s?: string) => logs.push(s ?? ""));
  });
  afterEach(() => {
    chalk.level = originalLevel;
    setFrameWidth(60);
    vi.restoreAllMocks();
  });

  for (const c of CASES) {
    for (const [modeName, w] of Object.entries(MODES)) {
      it(`${c.label} @ ${modeName}=${w}`, () => {
        setFrameWidth(w);
        c.render();
        const out = logs.join("\n").replace(/[ \t]+$/gm, "");
        expect(out).toMatchSnapshot();
      });
    }
  }
});
