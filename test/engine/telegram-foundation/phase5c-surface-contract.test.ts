import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseVolcanoTelegram } from "../../../src/dmdata/volcano-parser";
import { buildTickerSentence } from "../../../src/engine/display/ticker-sentence";
import { StandbyPersistence } from "../../../src/engine/display/standby-persistence";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { Notifier } from "../../../src/engine/notification/notifier";
import { VolcanoStateHolder } from "../../../src/engine/messages/volcano-state";
import { fromVolcanoOutcome } from "../../../src/engine/presentation/events/from-volcano";
import { buildVolcanoOutcome } from "../../../src/engine/presentation/processors/process-volcano";
import { resolveVolcanoPresentation } from "../../../src/engine/presentation/volcano-presentation";
import { displayVolcanoInfo } from "../../../src/ui/volcano-formatter";
import { stripAnsi } from "../../../src/ui/formatter";
import { notifyMock } from "../../setup";
import {
  createMockWsDataMessageFromXml,
  readFixture,
} from "../../helpers/mock-message";

const FIXTURE = "synthetic_phase5c_plume_3000m_or_more.xml";
const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

describe("Phase 5C PlumeHeight transverse contract", () => {
  it.each([
    [
      "雲中",
      '<jmx_eb:PlumeHeightAboveCrater unit="m">雲中</jmx_eb:PlumeHeightAboveCrater>',
      "噴煙: 雲中",
      "噴煙高度雲中",
      "噴煙は雲中",
    ],
    [
      "観測できず",
      '<jmx_eb:PlumeHeightAboveCrater unit="m">観測できず</jmx_eb:PlumeHeightAboveCrater>',
      "噴煙: 高度観測できず",
      "噴煙高度観測できず",
      "噴煙は観測できず",
    ],
    [
      "不明",
      '<jmx_eb:PlumeHeightAboveCrater unit="m" condition="不明" />',
      "噴煙: 高度不明",
      "噴煙高度不明",
      "噴煙は不明",
    ],
    [
      "両側範囲",
      '<jmx_eb:PlumeHeightAboveCrater unit="m"><From>2000</From><To>4000</To>'
        + "</jmx_eb:PlumeHeightAboveCrater>",
      "噴煙: 火口上2000～4000m",
      "噴煙2000～4000m",
      "噴煙は火口上2000～4000m",
    ],
    [
      "空欄",
      '<jmx_eb:PlumeHeightAboveCrater unit="m"></jmx_eb:PlumeHeightAboveCrater>',
      "噴煙: （空欄）",
      null,
      null,
    ],
  ] as const)("%s を各 surface の規約どおり表示する", (
    _label,
    craterNode,
    cliExpected,
    notificationExpected,
    tickerExpected,
  ) => {
    const xml = readFixture(FIXTURE).replace(
      /<jmx_eb:PlumeHeightAboveCrater\b[^>]*>[\s\S]*?<\/jmx_eb:PlumeHeightAboveCrater>/,
      craterNode,
    );
    const msg = createMockWsDataMessageFromXml(xml, "VFVO52");
    const parsed = parseVolcanoTelegram(msg);
    expect(parsed?.kind).toBe("eruption");
    if (parsed?.kind !== "eruption") return;
    const holder = new VolcanoStateHolder();
    const presentation = resolveVolcanoPresentation(parsed, holder);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    displayVolcanoInfo(parsed, presentation);
    const cli = stripAnsi(log.mock.calls.map((call) => String(call[0] ?? "")).join("\n"));
    log.mockRestore();
    expect(cli).toContain(cliExpected);

    notifyMock.mockClear();
    const notifier = new Notifier();
    notifier.setSoundEnabled(false);
    notifier.notifyVolcano(parsed, presentation);
    const notification = String(notifyMock.mock.calls.at(-1)?.[0]?.message ?? "");
    if (notificationExpected == null) {
      expect(notification).not.toContain("噴煙");
    } else {
      expect(notification).toContain(notificationExpected);
    }

    const event = fromVolcanoOutcome(buildVolcanoOutcome(msg, parsed, holder));
    const ticker = buildTickerSentence(event);
    if (tickerExpected == null) {
      expect(ticker).not.toContain("噴煙は");
    } else {
      expect(ticker).toContain(tickerExpected);
    }
  });

  it("全角 exact は canonical を保持しても legacy scalar がない全 surface で省略する", () => {
    const xml = readFixture(FIXTURE).replace(
      /<jmx_eb:PlumeHeightAboveCrater\b[^>]*>[\s\S]*?<\/jmx_eb:PlumeHeightAboveCrater>/,
      '<jmx_eb:PlumeHeightAboveCrater unit="m">３０００</jmx_eb:PlumeHeightAboveCrater>',
    );
    const msg = createMockWsDataMessageFromXml(xml, "VFVO52");
    const parsed = parseVolcanoTelegram(msg);
    expect(parsed?.kind).toBe("eruption");
    if (parsed?.kind !== "eruption") return;
    expect(parsed.plumeHeight).toBeNull();
    expect(parsed.plumeHeightAboveCraterValue?.value).toMatchObject({
      raw: "３０００", value: 3000, presence: "value",
    });

    const holder = new VolcanoStateHolder();
    const presentation = resolveVolcanoPresentation(parsed, holder);
    expect(presentation.summary).not.toContain("噴煙");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    displayVolcanoInfo(parsed, presentation);
    const cli = stripAnsi(log.mock.calls.map((call) => String(call[0] ?? "")).join("\n"));
    log.mockRestore();
    expect(cli).not.toContain("噴煙:");
    expect(cli).not.toContain("3000m");

    notifyMock.mockClear();
    const notifier = new Notifier();
    notifier.setSoundEnabled(false);
    notifier.notifyVolcano(parsed, presentation);
    expect(String(notifyMock.mock.calls.at(-1)?.[0]?.message ?? "")).not.toContain("噴煙");

    const event = fromVolcanoOutcome(buildVolcanoOutcome(msg, parsed, holder));
    expect(buildTickerSentence(event)).not.toContain("噴煙は");
  });

  it.each([
    [
      "不正 unit の canonical missing",
      '<jmx_eb:PlumeHeightAboveCrater unit="km">3000</jmx_eb:PlumeHeightAboveCrater>',
      "missing",
      3000,
      "3000m",
    ],
    [
      "機械表現 NaN の canonical unknown",
      '<jmx_eb:PlumeHeightAboveCrater unit="m">NaN</jmx_eb:PlumeHeightAboveCrater>',
      "unknown",
      null,
      null,
    ],
  ] as const)("%s は全 surface で legacy 表示規則を維持する", (
    _label,
    craterNode,
    presence,
    legacyHeight,
    expected,
  ) => {
    const xml = readFixture(FIXTURE).replace(
      /<jmx_eb:PlumeHeightAboveCrater\b[^>]*>[\s\S]*?<\/jmx_eb:PlumeHeightAboveCrater>/,
      craterNode,
    );
    const msg = createMockWsDataMessageFromXml(xml, "VFVO52");
    const parsed = parseVolcanoTelegram(msg);
    expect(parsed?.kind).toBe("eruption");
    if (parsed?.kind !== "eruption") return;
    expect(parsed.plumeHeight).toBe(legacyHeight);
    expect(parsed.plumeHeightAboveCraterValue?.value.presence).toBe(presence);

    const holder = new VolcanoStateHolder();
    const presentation = resolveVolcanoPresentation(parsed, holder);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    displayVolcanoInfo(parsed, presentation);
    const cli = stripAnsi(log.mock.calls.map((call) => String(call[0] ?? "")).join("\n"));
    log.mockRestore();

    notifyMock.mockClear();
    const notifier = new Notifier();
    notifier.setSoundEnabled(false);
    notifier.notifyVolcano(parsed, presentation);
    const notification = String(notifyMock.mock.calls.at(-1)?.[0]?.message ?? "");
    const ticker = buildTickerSentence(fromVolcanoOutcome(
      buildVolcanoOutcome(msg, parsed, holder),
    ));
    if (expected == null) {
      expect(presentation.summary).not.toContain("噴煙");
      expect(cli).not.toContain("噴煙:");
      expect(notification).not.toContain("噴煙");
      expect(ticker).not.toContain("噴煙は");
    } else {
      expect(presentation.summary).toContain(`噴煙${expected}`);
      expect(cli).toContain(`噴煙: 火口上${expected}`);
      expect(notification).toContain(`噴煙${expected}`);
      expect(ticker).toContain(`噴煙は火口上${expected}`);
    }
  });

  it.each([
    ["数値接尾辞", "3000m", 3000],
    ["10進固定", "0x10", 0],
    ["桁あふれ", "9".repeat(400), Number.POSITIVE_INFINITY],
  ] as const)("unmapped qualitative %s は全 surface で legacy 数値表示へ戻す", (
    _label,
    raw,
    legacyHeight,
  ) => {
    const xml = readFixture(FIXTURE).replace(
      /<jmx_eb:PlumeHeightAboveCrater\b[^>]*>[\s\S]*?<\/jmx_eb:PlumeHeightAboveCrater>/,
      `<jmx_eb:PlumeHeightAboveCrater unit="m">${raw}</jmx_eb:PlumeHeightAboveCrater>`,
    );
    const msg = createMockWsDataMessageFromXml(xml, "VFVO52");
    const parsed = parseVolcanoTelegram(msg);
    expect(parsed?.kind).toBe("eruption");
    if (parsed?.kind !== "eruption") return;
    expect(parsed.plumeHeight).toBe(legacyHeight);
    expect(parsed.plumeHeightAboveCraterValue?.value).toMatchObject({
      raw,
      value: null,
      presence: "qualitative",
      diagnostics: ["unmappedSpecialValue"],
    });
    const expected = `${String(legacyHeight)}m`;
    const holder = new VolcanoStateHolder();
    const presentation = resolveVolcanoPresentation(parsed, holder);
    expect(presentation.summary).toContain(`噴煙${expected}`);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    displayVolcanoInfo(parsed, presentation);
    const cli = stripAnsi(log.mock.calls.map((call) => String(call[0] ?? "")).join("\n"));
    log.mockRestore();
    expect(cli).toContain(`噴煙: 火口上${expected}`);

    notifyMock.mockClear();
    const notifier = new Notifier();
    notifier.setSoundEnabled(false);
    notifier.notifyVolcano(parsed, presentation);
    expect(String(notifyMock.mock.calls.at(-1)?.[0]?.message ?? ""))
      .toContain(`噴煙${expected}`);

    const event = fromVolcanoOutcome(buildVolcanoOutcome(msg, parsed, holder));
    expect(buildTickerSentence(event)).toContain(`噴煙は火口上${expected}`);
    if (raw.length > 100) {
      expect(cli).not.toContain(raw);
      expect(presentation.summary).not.toContain(raw);
      expect(buildTickerSentence(event)).not.toContain(raw);
    }
  });

  it.each([
    ["self-closing", '<jmx_eb:PlumeHeightAboveCrater unit="m" />', ""],
    [
      "半角空白",
      '<jmx_eb:PlumeHeightAboveCrater unit="m">   </jmx_eb:PlumeHeightAboveCrater>',
      "   ",
    ],
    [
      "全角空白",
      '<jmx_eb:PlumeHeightAboveCrater unit="m">　　</jmx_eb:PlumeHeightAboveCrater>',
      "　　",
    ],
  ] as const)("empty raw %s を persistence で byte-for-byte 往復する", (
    _label,
    craterNode,
    raw,
  ) => {
    const xml = readFixture(FIXTURE).replace(
      /<jmx_eb:PlumeHeightAboveCrater\b[^>]*>[\s\S]*?<\/jmx_eb:PlumeHeightAboveCrater>/,
      craterNode,
    );
    const msg = createMockWsDataMessageFromXml(xml, "VFVO52");
    const parsed = parseVolcanoTelegram(msg);
    expect(parsed?.kind).toBe("eruption");
    if (parsed?.kind !== "eruption") return;
    expect(parsed.plumeHeightAboveCraterValue?.value).toMatchObject({
      raw, presence: "empty",
    });

    const event = fromVolcanoOutcome(buildVolcanoOutcome(
      msg,
      parsed,
      new VolcanoStateHolder(),
    ));
    const store = new StandbyStateStore();
    const nowMs = Date.parse("2026-08-10T09:00:01+09:00");
    store.applyEvent(event, nowMs);
    const sandbox = fs.mkdtempSync(path.join(process.cwd(), `.phase5c-empty-${process.pid}-`));
    sandboxes.push(sandbox);
    const persistence = new StandbyPersistence(path.join(sandbox, "display-active-state-v1.json"), 0);
    persistence.save(store.exportActiveState());
    expect(persistence.load()?.volcanoes[0]?.latestEvent).toMatchObject({
      plumeHeightAboveCraterSemantic: { raw, presence: "empty" },
    });
  });

  it("受理済み訂正を実 notifier の title/body 両方で明示する", () => {
    const xml = readFixture(FIXTURE).replace(
      "<InfoType>発表</InfoType>",
      "<InfoType>訂正</InfoType>",
    );
    const parsed = parseVolcanoTelegram(createMockWsDataMessageFromXml(xml, "VFVO52"));
    expect(parsed?.kind).toBe("eruption");
    if (parsed?.kind !== "eruption") return;
    expect(parsed.infoType).toBe("訂正");
    const notifier = new Notifier();
    notifier.setSoundEnabled(false);
    notifyMock.mockClear();
    notifier.notifyVolcano(parsed, resolveVolcanoPresentation(parsed, new VolcanoStateHolder()));
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining("[訂正]"),
      message: expect.stringContaining("訂正:"),
    }));
  });

  it("同一 XML を parser→CLI/通知/テロップ→wire→persistence で qualifier ごと維持する", () => {
    const msg = createMockWsDataMessageFromXml(readFixture(FIXTURE), "VFVO52");
    const parsed = parseVolcanoTelegram(msg);
    expect(parsed?.kind).toBe("eruption");
    if (parsed?.kind !== "eruption") return;
    expect(parsed.plumeHeightAboveCraterValue).toMatchObject({
      reference: "aboveCrater",
      unit: "m",
      value: {
        raw: "3000",
        presence: "range",
        condition: "以上",
        description: "火口上3000m以上",
        lowerBound: 3000,
      },
    });
    expect(parsed.plumeHeightAboveSeaLevelValue).toMatchObject({
      reference: "aboveSeaLevel", unit: "FT", value: { value: 12000 },
    });

    const holder = new VolcanoStateHolder();
    const presentation = resolveVolcanoPresentation(parsed, holder);
    expect(presentation).toMatchObject({
      frameLevel: "warning",
      summary: expect.stringContaining("噴煙3000m以上"),
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    displayVolcanoInfo(parsed, presentation);
    const cli = stripAnsi(log.mock.calls.map((call) => String(call[0] ?? "")).join("\n"));
    log.mockRestore();
    expect(cli).toContain("噴煙: 火口上3000m以上");
    expect(cli).not.toContain("12000");

    notifyMock.mockClear();
    const notifier = new Notifier();
    notifier.setSoundEnabled(false);
    notifier.notifyVolcano(parsed, presentation);
    expect(notifyMock.mock.calls.at(-1)?.[0]).toMatchObject({
      message: expect.stringContaining("噴煙3000m以上"),
    });

    const outcome = buildVolcanoOutcome(msg, parsed, holder);
    const event = fromVolcanoOutcome(outcome);
    expect(buildTickerSentence(event)).toContain("噴煙は火口上3000m以上");
    expect(buildTickerSentence(event)).not.toContain("12000");

    const store = new StandbyStateStore();
    const nowMs = Date.parse("2026-08-10T09:00:01+09:00");
    store.applyEvent(event, nowMs);
    const active = store.exportActiveState();
    const wireEvent = active.volcanoes[0]?.latestEvent;
    expect(wireEvent).toMatchObject({
      plumeHeightM: 3000,
      plumeHeightAboveCraterSemantic: {
        reference: "aboveCrater", unit: "m", label: "3000m以上",
        presence: "range", condition: "以上", lowerBound: 3000,
        upperBound: null, badge: "≥",
      },
      plumeHeightAboveSeaLevelSemantic: {
        reference: "aboveSeaLevel", unit: "FT", value: 12000,
      },
    });
    expect(JSON.parse(JSON.stringify(wireEvent))).toEqual(wireEvent);

    const sandbox = fs.mkdtempSync(path.join(process.cwd(), `.phase5c-contract-${process.pid}-`));
    sandboxes.push(sandbox);
    const persistence = new StandbyPersistence(path.join(sandbox, "display-active-state-v1.json"), 0);
    persistence.save(active);
    const restored = persistence.load();
    expect(restored?.volcanoes[0]?.latestEvent).toEqual(wireEvent);
  });
});
