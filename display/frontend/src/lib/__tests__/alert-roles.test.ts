import { describe, expect, it } from "vitest";
import { isAlertRole } from "../alert-roles";

describe("isAlertRole (spec D5 判定表)", () => {
  it.each(["critical", "warning", "eewWarning", "tsunamiMajor", "tsunamiWarning", "quakeMajor", "weatherEmergency", "weatherWarning"])(
    "警報級 %s は true",
    (r) => expect(isAlertRole(r)).toBe(true),
  );
  it.each(["normal", "info", "cancel", "muted", "connectionOk", "connectionStale", "eewForecast", "tsunamiAdvisory", "weatherAdvisory"])(
    "平常・注意報級 %s は false",
    (r) => expect(isAlertRole(r)).toBe(false),
  );
  it("未知の role は警報級に倒す (fail-bright)", () => {
    expect(isAlertRole("someFutureRole")).toBe(true);
  });
});
