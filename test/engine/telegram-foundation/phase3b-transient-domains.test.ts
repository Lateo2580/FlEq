import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALL_REVISION_FAMILY_POLICIES,
  BRIEFING_REVISION_FAMILY_POLICY,
  CLIMATE_INFO_REVISION_FAMILY_POLICY,
  EARLY_WEATHER_REVISION_FAMILY_POLICY,
  EARTHQUAKE_REVISION_FAMILY_POLICY,
  RAW_REVISION_FAMILY_POLICY,
  routeHasExplicitRevisionFamilyPolicy,
  SEISMIC_TEXT_REVISION_FAMILY_POLICY,
  TRANSIENT_WEATHER_REVISION_FAMILY_POLICY,
  WEATHER_EXPLANATION_REVISION_FAMILY_POLICY,
} from "../../../src/engine/messages/revision-family-registry";
import { ROUTE_CATALOG, type Route } from "../../../src/engine/messages/route-catalog";
import { createMessageHandler } from "../../../src/engine/messages/message-router";
import { Notifier } from "../../../src/engine/notification/notifier";
import { DailyQuakeCounter } from "../../../src/engine/messages/daily-quake-counter";
import { projectRecentQuake } from "../../../src/engine/display/project-event";
import { toPresentationEvent } from "../../../src/engine/presentation/events/to-presentation-event";
import { processMessage } from "../../../src/engine/presentation/processors/process-message";
import { makeProcessDeps } from "../../helpers/process-deps";
import {
  createMockWsDataMessageFromXml,
  FIXTURE_VPBS50_LINEAR_OBSERVED,
  FIXTURE_VPAW51_HIGH_TEMP,
  FIXTURE_VPCJ51_KANTO_SNOW,
  FIXTURE_VPZI50_HOT_DRY,
  FIXTURE_VXSE51_SHINDO,
  FIXTURE_VXSE56_ACTIVITY_1,
  readFixture,
} from "../../helpers/mock-message";

const TRANSIENT_FIXTURES = [
  [FIXTURE_VXSE51_SHINDO, "VXSE51", "earthquake"],
  [FIXTURE_VXSE56_ACTIVITY_1, "VXSE56", "seismicText"],
  [FIXTURE_VPBS50_LINEAR_OBSERVED, "VPBS50", "briefing"],
  [FIXTURE_VPAW51_HIGH_TEMP, "VPAW51", "earlyWeather"],
  [FIXTURE_VPZI50_HOT_DRY, "VPZI50", "climateInfo"],
  [FIXTURE_VPCJ51_KANTO_SNOW, "VPCJ51", "weatherExplanation"],
] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Phase 3B transient domain registry", () => {
  it("declares markCancelled policy, finite runtime retention, and bounded subjects", () => {
    for (const policy of [
      EARTHQUAKE_REVISION_FAMILY_POLICY,
      SEISMIC_TEXT_REVISION_FAMILY_POLICY,
      BRIEFING_REVISION_FAMILY_POLICY,
      EARLY_WEATHER_REVISION_FAMILY_POLICY,
      CLIMATE_INFO_REVISION_FAMILY_POLICY,
      WEATHER_EXPLANATION_REVISION_FAMILY_POLICY,
      TRANSIENT_WEATHER_REVISION_FAMILY_POLICY,
      RAW_REVISION_FAMILY_POLICY,
    ]) {
      expect(policy).toMatchObject({
        cancellationPolicy: "markCancelled",
        durable: false,
        tombstoneRetentionMs: expect.any(Number),
        maxSubjects: expect.any(Number),
      });
      expect(policy.terminalPredicate({} as never, {} as never)).toBe(false);
      expect(policy.deactivationPredicate({} as never, {} as never)).toBe(false);
    }
  });

  it("gives every routed semantic head.type an explicit registry policy", () => {
    const policyHeadTypes = new Set(ALL_REVISION_FAMILY_POLICIES.flatMap((policy) => [...policy.headTypes]));
    for (const route of ROUTE_CATALOG) {
      if (route.route === "ignore") continue;
      expect(route.foundationHeadTypes.length, route.route).toBeGreaterThan(0);
      for (const headType of route.foundationHeadTypes) {
        expect(policyHeadTypes.has(headType), `${route.route}:${headType}`).toBe(true);
        expect(
          routeHasExplicitRevisionFamilyPolicy(route.route, headType),
          `${route.route}:${headType}:runtime`,
        ).toBe(true);
      }
      if (route.matcher.kind === "headTypeSet") {
        expect([...route.foundationHeadTypes].sort()).toEqual([...route.matcher.headTypes].sort());
      }
    }
  });

  it("rejects unregistered head.type values accepted by broad route matchers", () => {
    expect(routeHasExplicitRevisionFamilyPolicy("volcano", "VFVO54")).toBe(true);
    expect(routeHasExplicitRevisionFamilyPolicy("volcano", "VFVO99")).toBe(false);
    expect(routeHasExplicitRevisionFamilyPolicy("earthquake", "VXSE99")).toBe(false);
    expect(routeHasExplicitRevisionFamilyPolicy("raw", "VFVO99")).toBe(true);
  });

  it.each(TRANSIENT_FIXTURES)("gates real %s before presentation and suppresses a semantic replay", (fixture, type, route) => {
    const xml = readFixture(fixture);
    const deps = makeProcessDeps();
    const first = processMessage(createMockWsDataMessageFromXml(xml, type), route as Route, deps);
    const replay = processMessage(createMockWsDataMessageFromXml(`${xml}\n`, type), route as Route, deps);
    expect(first?.presentation.foundationMutationAccepted).toBe(true);
    expect(replay).toBeNull();
  });

  it("uses one EventID subject across VXSE51/52 while keeping both accepted", () => {
    const eventId = "20260801000100";
    const firstXml = readFixture(FIXTURE_VXSE51_SHINDO)
      .replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${eventId}</EventID>`)
      .replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, "<ReportDateTime>2026-08-01T00:01:00+09:00</ReportDateTime>")
      .replace(/<OriginTime>[^<]*<\/OriginTime>/, "<OriginTime>2026-08-01T00:00:00+09:00</OriginTime>")
      .replace(/<Serial(?:\s*\/|>[^<]*<\/Serial)>/, "<Serial>1</Serial>");
    const secondXml = readFixture("32-35_01_02_240613_VXSE52.xml")
      .replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${eventId}</EventID>`)
      .replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, "<ReportDateTime>2026-08-01T00:02:00+09:00</ReportDateTime>")
      .replace(/<OriginTime>[^<]*<\/OriginTime>/, "<OriginTime>2026-08-01T00:00:00+09:00</OriginTime>")
      .replace(/<Serial(?:\s*\/|>[^<]*<\/Serial)>/, "<Serial>2</Serial>");
    const deps = makeProcessDeps();
    const first = processMessage(createMockWsDataMessageFromXml(firstXml, "VXSE51"), "earthquake", deps);
    const second = processMessage(createMockWsDataMessageFromXml(secondXml, "VXSE52"), "earthquake", deps);
    expect(first?.domain).toBe("earthquake");
    expect(second?.domain).toBe("earthquake");
    expect(deps.revisionGate.activeRevisionFamilySubjects("earthquake", "earthquake"))
      .toEqual([`earthquake:${eventId}`]);
    if (first == null || second == null) return;
    const daily = new DailyQuakeCounter(Date.parse("2026-08-01T00:03:00+09:00"));
    daily.recordRecentQuake(projectRecentQuake(toPresentationEvent(first)), Date.parse("2026-08-01T00:03:00+09:00"));
    daily.recordRecentQuake(projectRecentQuake(toPresentationEvent(second)), Date.parse("2026-08-01T00:03:00+09:00"));
    expect(daily.getRecentQuakes(Date.parse("2026-08-01T00:03:00+09:00"))[0]).toMatchObject({
      eventId,
      maxInt: first.domain === "earthquake" ? first.parsed.intensity?.maxInt : undefined,
    });
  });

  it("earthquake cancellation の resolvedTrigger/policy を PresentationEvent まで一度だけ渡す", () => {
    const cancellationXml = readFixture(FIXTURE_VXSE51_SHINDO)
      .replace(/<InfoType>[^<]*<\/InfoType>/, "<InfoType>取消</InfoType>");
    const outcome = processMessage(
      createMockWsDataMessageFromXml(cancellationXml, "VXSE51"),
      "earthquake",
      makeProcessDeps(),
    );
    expect(outcome?.presentation).toMatchObject({
      foundationMutationAccepted: true,
      foundationResolvedTrigger: "explicitCancellation",
      foundationCancellationPolicy: "markCancelled",
    });
    if (outcome == null) return;
    expect(toPresentationEvent(outcome)).toMatchObject({
      foundationResolvedTrigger: "explicitCancellation",
      foundationCancellationPolicy: "markCancelled",
    });
  });

  it("does not join EventID-less reports and only suppresses an exact semantic replay", () => {
    const xml = readFixture(FIXTURE_VPZI50_HOT_DRY)
      .replace(/<EventID>[^<]*<\/EventID>/, "<EventID />");
    const changed = xml.replace(/<Headline>/, "<Headline><Text>別内容</Text>")
      .replace(/<\/Headline>/, "</Headline>");
    const deps = makeProcessDeps();
    expect(processMessage(createMockWsDataMessageFromXml(xml, "VPZI50"), "climateInfo", deps)).not.toBeNull();
    expect(processMessage(createMockWsDataMessageFromXml(changed, "VPZI50"), "climateInfo", deps)).not.toBeNull();
    expect(processMessage(createMockWsDataMessageFromXml(`${xml}\n`, "VPZI50"), "climateInfo", deps)).toBeNull();
    expect(deps.revisionGate.activeRevisionFamilySubjects("climateInfo", "climateInfo")).toEqual([]);
  });

  it("accepts one same-revision correction, marks it, and suppresses its replay", () => {
    const xml = readFixture(FIXTURE_VPZI50_HOT_DRY);
    const correction = xml.replace(/<InfoType>[^<]*<\/InfoType>/, "<InfoType>訂正</InfoType>");
    const deps = makeProcessDeps();
    expect(processMessage(createMockWsDataMessageFromXml(xml, "VPZI50"), "climateInfo", deps)).not.toBeNull();
    const accepted = processMessage(createMockWsDataMessageFromXml(correction, "VPZI50"), "climateInfo", deps);
    const replay = processMessage(createMockWsDataMessageFromXml(`${correction}\n`, "VPZI50"), "climateInfo", deps);
    expect(accepted?.presentation.acceptedCorrection).toBe(true);
    expect(replay).toBeNull();
  });

  it("applies transport dedup and correction notification at the router boundary", () => {
    const xml = readFixture(FIXTURE_VPZI50_HOT_DRY);
    const correction = xml.replace(/<InfoType>[^<]*<\/InfoType>/, "<InfoType>訂正</InfoType>");
    const outcomes = vi.fn();
    const notify = vi.spyOn(Notifier.prototype, "notifyClimateInfo");
    const { handler, stats } = createMessageHandler({ outcomeTaps: [outcomes] });
    const initial = createMockWsDataMessageFromXml(xml, "VPZI50");
    handler(initial);
    handler(initial);
    handler(createMockWsDataMessageFromXml(correction, "VPZI50"));
    handler(createMockWsDataMessageFromXml(`${correction}\n`, "VPZI50"));
    expect(outcomes).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0].infoType).toBe("訂正");
    const snapshot = stats.getSnapshot().foundation;
    expect(snapshot.transportDuplicate).toBeGreaterThanOrEqual(1);
    expect(snapshot.semanticDuplicate).toBeGreaterThanOrEqual(1);
    expect(snapshot.correctionNotified).toBeGreaterThanOrEqual(1);
  });

  it("routes unknown XML through raw markCancelled and suppresses semantic replay", () => {
    const xml = readFixture(FIXTURE_VXSE51_SHINDO);
    const deps = makeProcessDeps();
    const first = processMessage(createMockWsDataMessageFromXml(xml, "ZZZZ99"), "raw", deps);
    const replay = processMessage(createMockWsDataMessageFromXml(`${xml}\n`, "ZZZZ99"), "raw", deps);
    expect(first?.domain).toBe("raw");
    expect(first?.presentation.foundationMutationAccepted).toBe(true);
    expect(replay).toBeNull();
  });

  it("diagnoses invalid transient ReportDateTime before parser, notification, and presentation", () => {
    const xml = readFixture(FIXTURE_VPZI50_HOT_DRY)
      .replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, "<ReportDateTime>invalid</ReportDateTime>");
    const diagnostic = vi.fn();
    const outcomes = vi.fn();
    const notify = vi.spyOn(Notifier.prototype, "notifyClimateInfo");
    const { handler, stats } = createMessageHandler({
      display: { displayTelegramDiagnostic: diagnostic } as never,
      outcomeTaps: [outcomes],
    });
    handler(createMockWsDataMessageFromXml(xml, "VPZI50"));
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(outcomes).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(stats.getSnapshot().foundation.invalidDateDiagnosed).toBe(1);
  });
});
