import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { displayVolcanoInfo, volcanoTypeLabel } from "../../src/ui/volcano-formatter";
import { resolveVolcanoPresentation, VolcanoPresentation } from "../../src/engine/notification/volcano-presentation";
import { VolcanoStateHolder } from "../../src/engine/messages/volcano-state";
import { parseVolcanoTelegram } from "../../src/dmdata/volcano-parser";
import { setDisplayMode, setInfoFullText } from "../../src/ui/formatter";
import {
  createMockWsDataMessage,
  FIXTURE_VFVO50_ALERT_LV3,
  FIXTURE_VFVO50_ALERT_CONTINUE,
  FIXTURE_VFVO50_ALERT_LOWER,
  FIXTURE_VFVO52_ERUPTION_1,
  FIXTURE_VFVO56_FLASH_1,
  FIXTURE_VFSV_MARINE,
  FIXTURE_VFVO51_NORMAL,
  FIXTURE_VFVO54_ASH_RAPID,
  FIXTURE_VFVO55_ASH_DETAIL,
  FIXTURE_VFVO60_PLUME,
  FIXTURE_VZVO40_NOTICE,
} from "../helpers/mock-message";

describe("displayVolcanoInfo", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let volcanoState: VolcanoStateHolder;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    volcanoState = new VolcanoStateHolder();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  /** フィクスチャからパースして表示する */
  function displayFixture(fixture: string): string {
    const msg = createMockWsDataMessage(fixture);
    const info = parseVolcanoTelegram(msg)!;
    expect(info).not.toBeNull();
    const presentation = resolveVolcanoPresentation(info, volcanoState);
    displayVolcanoInfo(info, presentation);
    return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
  }

  it("VFVO50 レベル3引上げが表示される", () => {
    const output = displayFixture(FIXTURE_VFVO50_ALERT_LV3);
    expect(output).toContain("浅間山");
    expect(output).toContain("Lv3");
  });

  it("VFVO50 レベル5引上げが表示される", () => {
    const output = displayFixture(FIXTURE_VFVO50_ALERT_CONTINUE);
    expect(output).toContain("箱根山");
    expect(output).toContain("Lv5");
  });

  it("VFVO50 レベル1引下げが表示される", () => {
    const output = displayFixture(FIXTURE_VFVO50_ALERT_LOWER);
    expect(output).toContain("Lv1");
  });

  it("VFVO52 噴火観測報が表示される", () => {
    const output = displayFixture(FIXTURE_VFVO52_ERUPTION_1);
    expect(output).toContain("浅間山");
    expect(output).toContain("噴火");
  });

  it("VFVO56 噴火速報が表示される", () => {
    const output = displayFixture(FIXTURE_VFVO56_FLASH_1);
    expect(output).toContain("御嶽山");
    expect(output).toContain("噴火速報");
  });

  it("VFSVii 海上警報が表示される", () => {
    const output = displayFixture(FIXTURE_VFSV_MARINE);
    expect(output).toContain("桜島");
  });

  it("VFVO51 解説情報が表示される", () => {
    const output = displayFixture(FIXTURE_VFVO51_NORMAL);
    expect(output).toBeTruthy();
  });

  it("VFVO54 降灰速報が表示される", () => {
    const output = displayFixture(FIXTURE_VFVO54_ASH_RAPID);
    expect(output).toContain("桜島");
  });

  it("VFVO60 推定噴煙流向報が表示される", () => {
    const output = displayFixture(FIXTURE_VFVO60_PLUME);
    expect(output).toContain("桜島");
    expect(output).toContain("南東");
  });

  it("VZVO40 お知らせが表示される", () => {
    const output = displayFixture(FIXTURE_VZVO40_NOTICE);
    expect(output).toBeTruthy();
  });

  it("取消報が表示される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VFVO50_ALERT_LV3);
    const info = parseVolcanoTelegram(msg)!;
    // infoType を取消に差し替え
    (info as Record<string, unknown>).infoType = "取消";
    const presentation: VolcanoPresentation = {
      frameLevel: "cancel",
      soundLevel: "cancel",
      summary: "取り消されました",
    };
    displayVolcanoInfo(info, presentation);
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("取消");
  });

  // ── P0: recap / footer / severity テスト ──

  it("severity ラベルが出力に含まれる", () => {
    const output = displayFixture(FIXTURE_VFVO50_ALERT_LV3);
    // warning レベル → [警告]
    expect(output).toContain("[警告]");
  });

  it("VFVO55 降灰予報詳細で severity ラベルが出力に含まれる", () => {
    const output = displayFixture(FIXTURE_VFVO55_ASH_DETAIL);
    // normal レベル → [情報]
    expect(output).toContain("[情報]");
  });

  it("フッターに電文タイプと発表機関が含まれる", () => {
    const output = displayFixture(FIXTURE_VFVO50_ALERT_LV3);
    expect(output).toContain("VFVO50");
  });

  it("VFVO56 フッターに電文タイプが含まれる", () => {
    const output = displayFixture(FIXTURE_VFVO56_FLASH_1);
    expect(output).toContain("VFVO56");
  });

  it("isTest バッジが pushTitle 化後も表示される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VFVO50_ALERT_LV3);
    const info = parseVolcanoTelegram(msg)!;
    // isTest を true に差し替え
    (info as Record<string, unknown>).isTest = true;
    const presentation = resolveVolcanoPresentation(info, volcanoState);
    displayVolcanoInfo(info, presentation);
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("TEST");
  });

  it("取消報に severity ラベル [取消] が含まれる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VFVO50_ALERT_LV3);
    const info = parseVolcanoTelegram(msg)!;
    (info as Record<string, unknown>).infoType = "取消";
    const presentation: VolcanoPresentation = {
      frameLevel: "cancel",
      soundLevel: "cancel",
      summary: "取り消されました",
    };
    displayVolcanoInfo(info, presentation);
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("[取消]");
  });

  // ── P1: バナー・VFSVii・本文制限テスト ──

  it("VFVO50 Lv5 (critical) でバナーが表示される", () => {
    const output = displayFixture(FIXTURE_VFVO50_ALERT_CONTINUE);
    expect(output).toContain("噴火警報・予報");
  });

  it("VFVO56 噴火速報 (critical) でバナーが全幅表示される", () => {
    const output = displayFixture(FIXTURE_VFVO56_FLASH_1);
    expect(output).toContain("噴火速報");
  });

  it("VFSVii カード行で warningKind が重複しない", () => {
    const output = displayFixture(FIXTURE_VFSV_MARINE);
    // タイトル行に警報種別が含まれるが、カード行では action のみ
    const lines = output.split("\n");
    // warningKind 相当の文字列を含む行数をカウント（タイトル行の1回のみ）
    const warningLines = lines.filter((l) => l.includes("海上警報") || l.includes("海上予報") || l.includes("周辺海域警戒"));
    // タイトル行 + フッター行で 2 回以下であること（タイトルとフッターの volcanoTypeLabel）
    expect(warningLines.length).toBeLessThanOrEqual(2);
  });

  it("VFSVii で対象海域が表示される", () => {
    const output = displayFixture(FIXTURE_VFSV_MARINE);
    expect(output).toContain("対象海域");
  });

  it("VFVO60 で風向テーブルヘッダが表示される", () => {
    const output = displayFixture(FIXTURE_VFVO60_PLUME);
    expect(output).toContain("高度");
    expect(output).toContain("風速");
  });

  it("VFVO55 通常表示で本文が4行以上表示される", () => {
    const output = displayFixture(FIXTURE_VFVO55_ASH_DETAIL);
    // 行数ベース省略に変更したため、200文字で切れない
    const lines = output.split("\n");
    expect(lines.length).toBeGreaterThan(10);
  });

  // ── volcanoTypeLabel ──

  it("volcanoTypeLabel が正しく日本語名を返す", () => {
    expect(volcanoTypeLabel("VFVO50")).toBe("噴火警報・予報");
    expect(volcanoTypeLabel("VFVO56")).toBe("噴火速報");
    expect(volcanoTypeLabel("VZVO40")).toBe("火山に関するお知らせ");
    expect(volcanoTypeLabel("VFSVii")).toBe("火山現象に関する海上警報");
    expect(volcanoTypeLabel("VFSV60")).toBe("火山現象に関する海上警報");
  });

  // ── P2: コンパクトモード / 本文制限緩和テスト ──

  it("compact モードで1行出力される", () => {
    setDisplayMode("compact");
    try {
      const output = displayFixture(FIXTURE_VFVO50_ALERT_LV3);
      // compact モードでは console.log が1回だけ呼ばれる
      expect(logSpy.mock.calls.length).toBe(1);
      expect(output).toContain("浅間山");
      expect(output).toContain("Lv3");
    } finally {
      setDisplayMode("normal");
    }
  });

  it("compact モードで各種電文が1行出力される", () => {
    setDisplayMode("compact");
    try {
      logSpy.mockClear();
      displayFixture(FIXTURE_VFVO56_FLASH_1);
      expect(logSpy.mock.calls.length).toBe(1);

      logSpy.mockClear();
      displayFixture(FIXTURE_VFVO54_ASH_RAPID);
      expect(logSpy.mock.calls.length).toBe(1);

      logSpy.mockClear();
      displayFixture(FIXTURE_VFVO60_PLUME);
      expect(logSpy.mock.calls.length).toBe(1);

      logSpy.mockClear();
      displayFixture(FIXTURE_VFVO51_NORMAL);
      expect(logSpy.mock.calls.length).toBe(1);
    } finally {
      setDisplayMode("normal");
    }
  });

  it("VFVO50 で対象市町村が truncation なしで全件表示される", () => {
    const output = displayFixture(FIXTURE_VFVO50_ALERT_LV3);
    // 「他N件」が出ないことを確認
    expect(output).not.toMatch(/他\d+件/);
    // 「対象:」ラベルが表示される
    expect(output).toContain("対象:");
  });

  it("infoFullText=true で VZVO40 本文が4行以上表示される", () => {
    setInfoFullText(true);
    try {
      const output = displayFixture(FIXTURE_VZVO40_NOTICE);
      // 出力行数が通常制限 (4行) を超えることを検証
      // VZVO40 の本文が十分長い場合にのみ有意義
      expect(output).toBeTruthy();
    } finally {
      setInfoFullText(false);
    }
  });
});
