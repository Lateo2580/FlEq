import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import chalk from "chalk";
import { displayWeatherWarningCore } from "../../src/ui/weather-core-formatter";
import { parseWeatherWarning } from "../../src/dmdata/weather-parser";
import { createMockWsDataMessage } from "../helpers/mock-message";
import { setFrameWidth } from "../../src/ui/formatter";
import {
  DEFAULT_WEATHER_CORE_LAYOUT,
  type ResolvedWeatherCoreLayout,
} from "../../src/ui/display-layout";

const FIXTURE = "15_17_01_251222_VPWW55.xml";

function layoutWith(partial: Partial<ResolvedWeatherCoreLayout>): ResolvedWeatherCoreLayout {
  return {
    ...DEFAULT_WEATHER_CORE_LAYOUT,
    body: [...DEFAULT_WEATHER_CORE_LAYOUT.body],
    ...partial,
  };
}

describe("layout 指定時の displayWeatherWarningCore", () => {
  let logs: string[] = [];
  const originalLevel = chalk.level;
  const info = parseWeatherWarning(createMockWsDataMessage(FIXTURE))!;

  beforeEach(() => {
    logs = [];
    chalk.level = 0;
    setFrameWidth(80);
    vi.spyOn(console, "log").mockImplementation((s?: string) => logs.push(s ?? ""));
  });
  afterEach(() => {
    chalk.level = originalLevel;
    vi.restoreAllMocks();
  });

  function render(layout?: ResolvedWeatherCoreLayout): string {
    logs = [];
    displayWeatherWarningCore(info, layout);
    return logs.join("\n").replace(/[ \t]+$/gm, "");
  }

  it("layout 省略時と DEFAULT 明示渡しは同一出力 (per-call と singleton の整合)", () => {
    expect(render(layoutWith({}))).toBe(render(undefined));
  });

  it("body から actionGuide を外すと [行動の目安] が消える", () => {
    const base = render();
    const without = render(layoutWith({ body: ["table", "unknown", "comments"] }));
    expect(base).toContain("[行動の目安]");
    expect(without).not.toContain("[行動の目安]");
  });

  it("body の並び替えで出力順が変わる (actionGuide が table の前)", () => {
    const out = render(layoutWith({ body: ["actionGuide", "table", "unknown", "comments"] }));
    const guideIdx = out.indexOf("[行動の目安]");
    const tableIdx = out.indexOf("種別");  // テーブルヘッダ
    expect(guideIdx).toBeGreaterThanOrEqual(0);
    expect(tableIdx).toBeGreaterThanOrEqual(0);
    expect(guideIdx).toBeLessThan(tableIdx);
  });

  it("footer: false でフッタ行が消える", () => {
    const base = render();
    const without = render(layoutWith({ footer: false }));
    expect(base).toContain("VPWW55");          // footer に電文種別が出る
    expect(without.length).toBeLessThan(base.length);
  });

  it("banner: false でバナーが消える (最初の非空行がフレーム上辺になる)", () => {
    const base = render();
    const without = render(layoutWith({ banner: false }));
    const firstLine = (s: string) => s.split("\n").find((l) => l.trim().length > 0) ?? "";
    expect(firstLine(base)).not.toMatch(/^╔/);   // banner ON: バナー行が先頭
    expect(firstLine(without)).toMatch(/^╔/);    // banner OFF: フレーム上辺が先頭
  });

  it("非デフォルト構成 snapshot: 並び替え + footer OFF", () => {
    const out = render(layoutWith({
      body: ["actionGuide", "table", "unknown", "comments"],
      footer: false,
    }));
    expect(out).toMatchSnapshot();
  });

  it("非デフォルト構成 snapshot: unknown 非表示 (allowHiddenUnknown 相当の resolved 値)", () => {
    // resolver を通過済みの resolved 値を直接渡す (allowHiddenUnknown は resolver 段階で消費済み)
    const out = render(layoutWith({ body: ["table", "comments", "actionGuide"] }));
    expect(out).toMatchSnapshot();
  });

  it("非デフォルト構成 snapshot: narrow 幅 + tableOverflowDetail: false (spec §7)", () => {
    setFrameWidth(60); // ultra-narrow: こぼれ受けが出やすい幅で抑制を固定化
    const out = render(layoutWith({ tableOverflowDetail: false }));
    expect(out).toMatchSnapshot();
  });

  // ── 取消・解除のみ × layout (Codex 累積レビュー反映) ──
  // 取消パスは「早期 return・layout の影響を受けない (固定)」が設計
  // (weather-core-formatter.ts の取消パスコメント参照)。それをここで固定化する

  function renderInfo(target: typeof info, layout?: ResolvedWeatherCoreLayout): string {
    logs = [];
    displayWeatherWarningCore(target, layout);
    return logs.join("\n").replace(/[ \t]+$/gm, "");
  }

  it("取消は footer:false / body 並び替えの影響を受けない (固定パス)", () => {
    const cancelInfo = { ...info, infoType: "取消" };
    const base = renderInfo(cancelInfo);
    const overridden = renderInfo(cancelInfo, layoutWith({
      footer: false,
      body: ["actionGuide", "table", "unknown", "comments"],
    }));
    expect(base).toContain("取り消されました");
    expect(base).toContain("VPWW55");        // footer は取消パスでは常に出る
    expect(overridden).toBe(base);           // layout が効かないことの固定化
  });

  it("取消でも banner:false はバナーを消す (banner 判定は取消パスより前)", () => {
    const cancelInfo = { ...info, infoType: "取消" };
    const withBanner = renderInfo(cancelInfo);
    const withoutBanner = renderInfo(cancelInfo, layoutWith({ banner: false }));
    expect(withBanner).toContain("取り消されました");
    expect(withoutBanner).toContain("取り消されました");
    expect(withoutBanner.length).toBeLessThan(withBanner.length);
  });

  it("解除のみは通常パス — footer:false でフッタが消える", () => {
    const releaseOnly: typeof info = {
      ...info,
      infoType: "発表",
      layers: [{ type: "市町村等", items: [
        { areaName: "千葉県北西部", areaCode: "120001",
          kinds: [{ name: "大雨警報", code: "03", severity: "warning" }],
          statuses: [{ kindCode: "03", status: "解除" }],
          fullStatus: "全域" },
      ]}],
    } as typeof info;
    const base = renderInfo(releaseOnly);
    const without = renderInfo(releaseOnly, layoutWith({ footer: false }));
    expect(base).toContain("VPWW55");        // footer に電文種別
    expect(without).not.toContain("VPWW55"); // footer OFF が効く (取消パスとの対比)
    expect(without.length).toBeLessThan(base.length);
  });
});
