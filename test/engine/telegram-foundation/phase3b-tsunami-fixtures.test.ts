import { describe, expect, it } from "vitest";
import { parseTsunamiTelegram } from "../../../src/dmdata/telegram-parser";
import { TSUNAMI_REVISION_FAMILY_POLICIES } from "../../../src/engine/messages/revision-family-registry";
import { TelegramRevisionGate } from "../../../src/engine/messages/telegram-revision-gate";
import { TsunamiStateHolder } from "../../../src/engine/messages/tsunami-state";
import { processTsunami } from "../../../src/engine/presentation/processors/process-tsunami";
import {
  createMockWsDataMessage,
  createMockWsDataMessageFromXml,
  FIXTURE_VTSE51_OBSERVATION_MAXHEIGHT,
  readFixture,
} from "../../helpers/mock-message";

describe("Phase 3B tsunami fragment corpus", () => {
  it("VTSE51 実 fixture の station code を authoritative item key にする", () => {
    const parsed = parseTsunamiTelegram(
      createMockWsDataMessage(FIXTURE_VTSE51_OBSERVATION_MAXHEIGHT),
    );
    expect(parsed).not.toBeNull();
    const station = parsed?.observations?.find((item) => item.name === "釜石");
    expect(station).toBeDefined();
    expect(TSUNAMI_REVISION_FAMILY_POLICIES.VTSE51.itemSubjectKey(parsed!.meta, station!))
      .toBe("21003");
  });

  it("VTSE52 実 fixture の station code と独立 family を固定する", () => {
    const parsed = parseTsunamiTelegram(
      createMockWsDataMessage("61_11_02_250206_VTSE52.xml"),
    );
    expect(parsed).not.toBeNull();
    const station = parsed?.observations?.find((item) => item.name === "岩手沖９０ｋｍＡ");
    expect(station).toBeDefined();
    expect(TSUNAMI_REVISION_FAMILY_POLICIES.VTSE52.itemSubjectKey(parsed!.meta, station!))
      .toBe("21050");
    expect(TSUNAMI_REVISION_FAMILY_POLICIES.VTSE52.revisionFamily).not.toBe(
      TSUNAMI_REVISION_FAMILY_POLICIES.VTSE51.revisionFamily,
    );
  });

  it("実 VTSE51 取消 fixture は観測 family を clear し、遅着旧報を復活させない", () => {
    const shared = {
      tsunamiState: new TsunamiStateHolder(),
      revisionGate: new TelegramRevisionGate(),
    };
    const activeXml = readFixture(FIXTURE_VTSE51_OBSERVATION_MAXHEIGHT)
      .replace(/<ReportDateTime>[^<]+<\/ReportDateTime>/, "<ReportDateTime>2021-08-05T12:55:00+09:00</ReportDateTime>")
      .replace(/<EventID>[^<]+<\/EventID>/, "<EventID>20210805103531</EventID>");
    const active = createMockWsDataMessageFromXml(activeXml, "VTSE51");
    const cancellation = createMockWsDataMessage("38-39_03_03_210805_VTSE51.xml");
    expect(processTsunami(active, shared).kind).toBe("ok");
    expect(shared.tsunamiState.getObservationGroups().VTSE51.length).toBeGreaterThan(0);
    expect(processTsunami(cancellation, shared).kind).toBe("ok");
    expect(shared.tsunamiState.getObservationGroups().VTSE51).toEqual([]);
    expect(processTsunami({ ...active, id: `${active.id}-delayed` }, shared))
      .toEqual({ kind: "suppressed" });
  });
});
