import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWeatherBriefing } from "../../../src/dmdata/briefing-parser";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { fromBriefingOutcome } from "../../../src/engine/presentation/events/from-briefing";
import { processBriefing } from "../../../src/engine/presentation/processors/process-briefing";
import {
  createMockWsDataMessage,
  FIXTURE_VPBS50_HJPNA202608270258,
  FIXTURE_VPBS50_HJPNB202608270308,
  FIXTURE_VPBS50_YJPNA202608270448,
  FIXTURE_VPBS50_YJPNB202608270448,
} from "../../helpers/mock-message";

const CORPUS_DIR = resolve(process.cwd(), "corpus-briefing-0827");
const FIXTURE_DIR = resolve(process.cwd(), "test/fixtures");

const PI_BRIEFING_CORPUS = [
  {
    fixture: FIXTURE_VPBS50_HJPNA202608270258,
    sourcePath: "~/dev/fleq-corpus-6b-latter/raw-briefing-0827/VPBS50_HJPNA202608270258.xml",
    retrievedAt: "2026-08-27 JST 朝; 統合担当が dmdata REST Telegram List v2→Data v1 で採取",
    eventId: "HJPNA202608270258_202608270258",
    reportDateTime: "2026-08-27T02:58:00+09:00",
    headline: "富山県西部では、線状降水帯による非常に激しい雨が同じ場所で降り続いています。命に危険が及ぶ災害発生の危険度が急激に高まっています。",
    sha256: "94a8b07689f4a3f45c47de269ed29bbac5b61ea0622febf730ab76997c00b886",
    bytes: 2031,
    kind: "linearRainObserved" as const,
    lead: "線状降水帯が発生",
    condition: "線状降水帯発生",
    editorialOffice: "富山地方気象台",
    areas: [{ name: "西部", code: "160020" }],
    eventName: "線状降水帯発生",
    at: "2026-08-27T02:50:00+09:00",
  },
  {
    fixture: FIXTURE_VPBS50_HJPNB202608270308,
    sourcePath: "~/dev/fleq-corpus-6b-latter/raw-briefing-0827/VPBS50_HJPNB202608270308.xml",
    retrievedAt: "2026-08-27 JST 朝; 統合担当が dmdata REST Telegram List v2→Data v1 で採取",
    eventId: "HJPNB202608270308_202608270308",
    reportDateTime: "2026-08-27T03:08:00+09:00",
    headline: "石川県加賀、能登では、線状降水帯による非常に激しい雨が同じ場所で降り続いています。命に危険が及ぶ災害発生の危険度が急激に高まっています。",
    sha256: "58e42add58835e6015ed36141568f1a4ebea7566691b04cbaf4ed7be4428cd57",
    bytes: 2447,
    kind: "linearRainObserved" as const,
    lead: "線状降水帯が発生",
    condition: "線状降水帯発生",
    editorialOffice: "金沢地方気象台",
    areas: [{ name: "加賀", code: "170010" }, { name: "能登", code: "170020" }],
    eventName: "線状降水帯発生",
    at: "2026-08-27T03:00:00+09:00",
  },
  {
    fixture: FIXTURE_VPBS50_YJPNA202608270448,
    sourcePath: "~/dev/fleq-corpus-6b-latter/raw-briefing-0827/VPBS50_YJPNA202608270448.xml",
    retrievedAt: "2026-08-27 JST 朝; 統合担当が dmdata REST Telegram List v2→Data v1 で採取",
    eventId: "YJPNA202608270448_202608270448",
    reportDateTime: "2026-08-27T04:48:00+09:00",
    headline: "富山県東部、西部では、今後３時間以内に線状降水帯が発生し、非常に激しい雨が同じ場所で降り続く可能性が高まっています。命に危険が及ぶ災害発生の危険度が急激に高まるおそれがあります。",
    sha256: "4fda526f9e00907a24afacf9f7ceefd1e91ee93f90cb77e2bf7afb1880d60528",
    bytes: 2516,
    kind: "linearRainPredicted" as const,
    lead: "３時間以内に線状降水帯発生のおそれ",
    condition: "線状降水帯直前",
    editorialOffice: "富山地方気象台",
    areas: [{ name: "東部", code: "160010" }, { name: "西部", code: "160020" }],
    eventName: "線状降水帯予想",
    at: "2026-08-27T04:40:00+09:00",
  },
  {
    fixture: FIXTURE_VPBS50_YJPNB202608270448,
    sourcePath: "~/dev/fleq-corpus-6b-latter/raw-briefing-0827/VPBS50_YJPNB202608270448.xml",
    retrievedAt: "2026-08-27 JST 朝; 統合担当が dmdata REST Telegram List v2→Data v1 で採取",
    eventId: "YJPNB202608270448_202608270448",
    reportDateTime: "2026-08-27T04:48:00+09:00",
    headline: "石川県能登では、今後３時間以内に線状降水帯が発生し、非常に激しい雨が同じ場所で降り続く可能性が高まっています。命に危険が及ぶ災害発生の危険度が急激に高まるおそれがあります。",
    sha256: "414b76ead006df1223e6503db12de8e8bc3636288e8730ebedf59f35aa6fe859",
    bytes: 2100,
    kind: "linearRainPredicted" as const,
    lead: "３時間以内に線状降水帯発生のおそれ",
    condition: "線状降水帯直前",
    editorialOffice: "金沢地方気象台",
    areas: [{ name: "能登", code: "170020" }],
    eventName: "線状降水帯予想",
    at: "2026-08-27T04:40:00+09:00",
  },
] as const;

describe("2026-08-27 Pi briefing corpus fixtures", () => {
  it.each(PI_BRIEFING_CORPUS)("provenance and tracked bytes: $fixture", (expected) => {
    const fixtureBytes = readFileSync(resolve(FIXTURE_DIR, expected.fixture));
    expect(fixtureBytes.byteLength).toBe(expected.bytes);
    expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe(expected.sha256);

    // staging は統合後に消える。存在する間だけ原本との strict byte equality を確認する。
    const stagingPath = resolve(CORPUS_DIR, expected.fixture);
    if (existsSync(stagingPath)) expect(fixtureBytes.equals(readFileSync(stagingPath))).toBe(true);
    expect(expected.sourcePath).toBe(`~/dev/fleq-corpus-6b-latter/raw-briefing-0827/${expected.fixture}`);
    expect(expected.retrievedAt).toContain("dmdata REST Telegram List v2→Data v1");
    expect(expected.fixture).toContain(expected.eventId.slice(0, 5));
  });

  it.each(PI_BRIEFING_CORPUS)("acceptance: $fixture keeps structured lead, condition, chips, and event facts", (expected) => {
    const message = createMockWsDataMessage(expected.fixture);
    const parsed = parseWeatherBriefing(message);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({ eventId: expected.eventId, headline: expected.headline, reportDateTime: expected.reportDateTime, editorialOffice: expected.editorialOffice, briefingConditions: [expected.condition], targetAreas: expected.areas });
    expect(parsed?.observations).toEqual(expect.arrayContaining(expected.areas.map((area) => expect.objectContaining({
      partKind: "event", locationName: area.name, locationCode: area.code, description: expected.eventName, time: expected.at,
    }))));

    const outcome = processBriefing(message);
    if (outcome == null) throw new Error("Pi briefing must reach presentation");
    const store = new StandbyStateStore();
    store.applyEvent(fromBriefingOutcome(outcome), Date.parse(outcome.parsed.reportDateTime) + 1);
    const entry = store.snapshotBriefingCard()?.data.entries[0];
    expect(entry).toMatchObject({ headline: expected.headline, reportDateTime: expected.reportDateTime, editorialOffice: expected.editorialOffice, targetAreas: expected.areas, summary: {
      mode: "structured", hasUnknownKind: false, items: [{ kind: expected.kind, lead: expected.lead }],
    } });
    expect(entry?.summary?.items[0]?.facts).toEqual(expected.areas.map((area) => ({
      kind: "event", label: expected.kind === "linearRainObserved" ? "発生" : "予想",
      areaName: area.name, areaCode: area.code, at: expected.at,
    })));
  });
});
