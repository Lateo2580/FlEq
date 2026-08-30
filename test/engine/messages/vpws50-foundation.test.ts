import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramMeta } from "../../../src/dmdata/telegram-meta";
import {
  StandbyPersistence,
  standbyPersistenceV2Path,
  type PersistedStandbyStateV1,
  type PersistedStandbyStateV2,
} from "../../../src/engine/display/standby-persistence";
import { weatherAlertsFromVpws50 } from "../../../src/engine/display/weather-alert-view";
import { VPWS50_REVISION_FAMILY_POLICY } from "../../../src/engine/messages/revision-family-registry";
import {
  semanticPayloadFingerprint,
  TelegramRevisionGate,
  type TelegramRevisionDecision,
} from "../../../src/engine/messages/telegram-revision-gate";
import { Vpws50StateHolder } from "../../../src/engine/messages/vpws50-state";
import type { ParsedWeatherWarning, TelegramInfoTypeValue, TelegramMeta } from "../../../src/types";

const T1 = "2026-07-30T10:00:00+09:00";
const T2 = "2026-07-30T10:30:00+09:00";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleq-vpws-foundation-"));
  tempDirs.push(dir);
  return path.join(dir, "display-active-state-v1.json");
}

function legacyState(): PersistedStandbyStateV1 {
  return {
    version: 1,
    savedAt: "2026-07-30T11:00:00+09:00",
    heat: [], typhoons: [], volcanoes: [], floods: { events: [], seen: [] },
    weatherAlerts: [], tornado: [], longPeriod: [], quakeHost: null, nankaiTrough: null, seen: [],
  };
}

function meta(reportDateTime: string, serial: string | null, infoType: TelegramInfoTypeValue): TelegramMeta {
  return createTelegramMeta({
    messageId: `${reportDateTime}:${serial ?? ""}:${infoType}`,
    eventId: null,
    type: "VPWS50",
    reportDateTime,
    serial,
    infoType,
    receivedAtMs: Date.parse("2026-07-30T12:00:00+09:00"),
    status: "通常",
    isTest: false,
  });
}

function vpww55(
  reportDateTime: string,
  serial: string,
  publishingOffice: string,
  areaCode: string,
  infoType: TelegramInfoTypeValue = "発表",
): ParsedWeatherWarning {
  const m = createTelegramMeta({
    messageId: `VPWW55:${publishingOffice}:${reportDateTime}:${serial}`,
    eventId: null,
    type: "VPWW55",
    reportDateTime,
    serial,
    infoType,
    receivedAtMs: Date.parse("2026-07-30T12:00:00+09:00"),
    status: "通常",
    isTest: false,
  });
  return {
    ...weather(m, areaCode),
    type: "VPWW55",
    infoType,
    publishingOffice,
  };
}

function weather(m: TelegramMeta, areaCode: string): ParsedWeatherWarning {
  return {
    type: "VPWS50", infoType: m.infoType.value ?? "発表", title: "気象警報・注意報",
    reportDateTime: m.reportDateTime.raw ?? "", headline: null,
    publishingOffice: "気象庁", editorialOffice: "気象庁", controlTitle: "気象警報・注意報",
    layers: [{ type: "府県予報区等", items: [{
      areaName: `地域${areaCode}`, areaCode, changeStatus: "変化有", fullStatus: "全域",
      kinds: [{ name: "大雨警報", code: "03", severity: "warning" }], statuses: [],
    }] }],
    comments: [], maxSeverity: "warning", maxDisplaySeverity: "officialL3", maxSoundLevel: "warning",
    warningAreaCount: 1, advisoryAreaCount: 0, meta: m, isTest: false,
  };
}

function decide(
  gate: TelegramRevisionGate,
  parsed: ParsedWeatherWarning,
  cancellationTargetMatches = true,
  stateSubjectKey = "weather:vpws50",
): TelegramRevisionDecision {
  const p = VPWS50_REVISION_FAMILY_POLICY;
  return gate.decide({
    domain: p.domain,
    revisionFamily: p.revisionFamily,
    stateSubjectKey,
    meta: parsed.meta,
    comparator: p.comparator,
    cancellationPolicy: p.cancellationPolicy,
    terminal: false,
    deactivation: false,
    cancellationTargetMatches,
    durable: true,
    tombstoneRetentionMs: p.tombstoneRetentionMs,
    maxSubjects: p.maxSubjects,
    retainForFamilyCapacity: stateSubjectKey === "weather:vpws50",
    allowMissingSerial: true,
    payloadFingerprint: semanticPayloadFingerprint({ area: parsed.layers[0].items[0].areaCode }),
  });
}

function persistedFoundationFixture(): { file: string; expected: PersistedStandbyStateV2 } {
  const gate = new TelegramRevisionGate();
  const holder = new Vpws50StateHolder();
  const first = weather(meta(T1, "1", "発表"), "A");
  expect(decide(gate, first).accepted).toBe(true);
  holder.diffAndUpdate(first, "first", { reportDateTime: T1, serial: "1" });
  const legacy = legacyState();
  legacy.weatherAlerts = [{
    source: "vpws50",
    alerts: weatherAlertsFromVpws50(holder.getCurrentAreasForDisplay(), T1),
    revision: { reportTimeMs: Date.parse(T1), serial: "1" },
    expiresAtMs: Date.parse(T1) + 86_400_000,
  }];
  const file = tempPath();
  const persistence = new StandbyPersistence(file, 0, () => ({
    vpws50: {
      authoritative: true,
      state: holder.exportPersistedState(),
      gateEntries: gate.exportDurableEntries(),
    },
  }));
  persistence.save(legacy);
  const expected = JSON.parse(fs.readFileSync(standbyPersistenceV2Path(file), "utf8")) as PersistedStandbyStateV2;
  return { file, expected };
}

describe("VPWS50 common cancellation registry + persistence v2", () => {
  it("restart 後も restorePrevious と watermark を保ち、遅延旧報を拒否する", () => {
    const gate = new TelegramRevisionGate();
    const holder = new Vpws50StateHolder();
    const first = weather(meta(T1, "1", "発表"), "A");
    const second = weather(meta(T2, "2", "発表"), "B");
    expect(decide(gate, first).kind).toBe("accept");
    holder.diffAndUpdate(first, "first", { reportDateTime: T1, serial: "1" });
    expect(decide(gate, second).kind).toBe("accept");
    holder.diffAndUpdate(second, "second", { reportDateTime: T2, serial: "2" });

    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: {
        authoritative: true,
        state: holder.exportPersistedState(),
        gateEntries: gate.exportDurableEntries(),
      },
    }));
    const legacy = legacyState();
    legacy.weatherAlerts = [{
      source: "vpws50",
      alerts: [{ source: "vpws50", label: "気象警報", role: "weatherWarning", totalAreas: 1, items: [], updatedAt: T2 }],
      revision: { reportTimeMs: Date.parse(T2), serial: "2" },
      expiresAtMs: Date.parse(T2) + 86_400_000,
    }];
    persistence.save(legacy);
    const rollbackFile = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const canonicalFile = JSON.parse(fs.readFileSync(standbyPersistenceV2Path(file), "utf8")) as Record<string, unknown>;
    expect(rollbackFile).toMatchObject({ version: 1, weatherAlerts: legacy.weatherAlerts });
    expect(rollbackFile).not.toHaveProperty("telegramFoundation");
    expect(canonicalFile).toMatchObject({ version: 2, telegramFoundation: expect.any(Object) });
    const loaded = persistence.load();
    expect(loaded?.version).toBe(2);
    // rollback 互換 field も同時に残す。
    expect(loaded?.weatherAlerts).toEqual(legacy.weatherAlerts);

    const restoredGate = new TelegramRevisionGate();
    const restoredHolder = new Vpws50StateHolder();
    restoredGate.restoreDurableEntries(loaded!.telegramFoundation.vpws50.gateEntries);
    restoredHolder.restorePersistedState(loaded!.telegramFoundation.vpws50.state!);
    const cancel = weather(meta(T2, "2", "取消"), "B");
    expect(decide(restoredGate, cancel).kind).toBe("restorePrevious");
    restoredHolder.restorePrevious();
    expect(restoredHolder.getCurrentAreasForDisplay()?.kinds[0].areas[0].areaCode).toBe("A");
    expect(decide(restoredGate, first).kind).toBe("stale");
  });

  it("StandbyPersistence は全国取消 tombstone と active VPWW55 overlay を同時に復元する", () => {
    const gate = new TelegramRevisionGate();
    const holder = new Vpws50StateHolder();
    const base = weather(meta(T1, "1", "発表"), "A");
    expect(decide(gate, base).kind).toBe("accept");
    holder.diffAndUpdate(base, "base", { reportDateTime: T1, serial: "1" });
    expect(decide(gate, weather(meta(T1, "1", "取消"), "A-cancel")).kind)
      .toBe("restorePrevious");
    holder.restorePrevious();
    expect(holder.exportPersistedState()).toMatchObject({ current: null, history: [] });

    const office = "福井地方気象台";
    const subject = `weather:VPWW55:${office}`;
    const partial = vpww55(T2, "2", office, "180000");
    expect(decide(gate, partial, true, subject).kind).toBe("accept");
    holder.mergePartialWithDisplay(partial, "partial", {
      reportDateTime: T2,
      serial: "2",
    }, subject);

    const file = tempPath();
    new StandbyPersistence(file, 0, () => ({
      vpws50: {
        authoritative: true,
        state: holder.exportPersistedState(),
        gateEntries: gate.exportDurableEntries(),
      },
    })).save(legacyState());

    const loaded = new StandbyPersistence(file).load()!;
    expect(loaded.telegramFoundation.vpws50.gateEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ stateSubjectKey: "weather:vpws50", cancelled: true }),
      expect.objectContaining({ stateSubjectKey: subject, cancelled: false }),
    ]));
    const restoredGate = new TelegramRevisionGate();
    const restoredHolder = new Vpws50StateHolder();
    restoredGate.restoreDurableEntries(loaded.telegramFoundation.vpws50.gateEntries);
    restoredHolder.restorePersistedState(loaded.telegramFoundation.vpws50.state!);
    expect(restoredHolder.getCurrentAreasForDisplay()?.kinds[0]?.areas[0]?.areaCode).toBe("180000");
    const oldBase = weather(meta("2026-07-30T09:00:00+09:00", "0", "発表"), "old");
    expect(decide(restoredGate, oldBase)).toMatchObject({ kind: "stale", accepted: false });
  });

  it("StandbyPersistence は VPWW55 partialHistory を復元し、再起動後の取消で直前報へ戻す", () => {
    const gate = new TelegramRevisionGate();
    const holder = new Vpws50StateHolder();
    const office = "福井地方気象台";
    const subject = `weather:VPWW55:${office}`;
    const first = vpww55(T1, "1", office, "1820100");
    const second = vpww55(T2, "2", office, "1820200");
    expect(decide(gate, first, true, subject).kind).toBe("accept");
    holder.mergePartialWithDisplay(first, "first", { reportDateTime: T1, serial: "1" }, subject);
    expect(decide(gate, second, true, subject).kind).toBe("accept");
    holder.mergePartialWithDisplay(second, "second", { reportDateTime: T2, serial: "2" }, subject);

    const file = tempPath();
    new StandbyPersistence(file, 0, () => ({
      vpws50: {
        authoritative: true,
        state: holder.exportPersistedState(),
        gateEntries: gate.exportDurableEntries(),
      },
    })).save(legacyState());
    const loaded = new StandbyPersistence(file).load()!;
    expect(loaded.telegramFoundation.vpws50.state?.partialHistory?.[0]?.entries).toHaveLength(1);

    const restoredGate = new TelegramRevisionGate();
    const restoredHolder = new Vpws50StateHolder();
    restoredGate.restoreDurableEntries(loaded.telegramFoundation.vpws50.gateEntries);
    restoredHolder.restorePersistedState(loaded.telegramFoundation.vpws50.state!);
    expect(decide(restoredGate, vpww55(T2, "2", office, "1820200", "取消"), true, subject).kind)
      .toBe("restorePrevious");
    restoredHolder.restorePreviousPartial(subject);
    expect(restoredHolder.getCurrentAreasForDisplay()?.kinds[0]?.areas[0]?.areaCode).toBe("1820100");
  });

  it("取消で復元した VPWW55 subject は永続化後も別官署続報の active 同期から守る", () => {
    const gate = new TelegramRevisionGate();
    const holder = new Vpws50StateHolder();
    const fukuiSubject = "weather:VPWW55:福井地方気象台";
    const first = vpww55(T1, "1", "福井地方気象台", "1820100");
    const second = vpww55(T2, "2", "福井地方気象台", "1820200");
    expect(decide(gate, first, true, fukuiSubject).kind).toBe("accept");
    holder.mergePartialWithDisplay(first, "first", { reportDateTime: T1, serial: "1" }, fukuiSubject);
    expect(decide(gate, second, true, fukuiSubject).kind).toBe("accept");
    holder.mergePartialWithDisplay(second, "second", { reportDateTime: T2, serial: "2" }, fukuiSubject);
    expect(decide(gate, vpww55(T2, "2", "福井地方気象台", "1820200", "取消"), true, fukuiSubject).kind)
      .toBe("restorePrevious");
    holder.restorePreviousPartial(fukuiSubject);

    const file = tempPath();
    new StandbyPersistence(file, 0, () => ({
      vpws50: {
        authoritative: true,
        state: holder.exportPersistedState(),
        gateEntries: gate.exportDurableEntries(),
      },
    })).save(legacyState());
    const loaded = new StandbyPersistence(file).load()!;
    const restoredGate = new TelegramRevisionGate();
    const restoredHolder = new Vpws50StateHolder();
    restoredGate.restoreDurableEntries(loaded.telegramFoundation.vpws50.gateEntries);
    restoredHolder.restorePersistedState(loaded.telegramFoundation.vpws50.state!);

    const ishikawaSubject = "weather:VPWW55:金沢地方気象台";
    const ishikawa = vpww55("2026-07-30T10:40:00+09:00", "1", "金沢地方気象台", "1720100");
    expect(decide(restoredGate, ishikawa, true, ishikawaSubject).kind).toBe("accept");
    restoredHolder.mergePartialWithDisplay(
      ishikawa,
      "ishikawa",
      { reportDateTime: ishikawa.reportDateTime, serial: "1" },
      ishikawaSubject,
    );
    restoredHolder.retainActivePartialSubjects(
      restoredGate.activeRevisionFamilySubjects("weather", "VPWS50"),
    );
    expect(restoredHolder.getCurrentAreasForDisplay()?.kinds[0]?.areas).toEqual(expect.arrayContaining([
      expect.objectContaining({ areaCode: "1820100" }),
      expect.objectContaining({ areaCode: "1720100" }),
    ]));
  });

  it("VPNO50 emergency-clear watermark だけの foundation も保存し、再起動後の旧 L5 を抑制する", () => {
    const holder = new Vpws50StateHolder();
    const subject = "weather:VPWW55:福井地方気象台";
    holder.clearEmergencyPartialAreas(
      subject,
      ["180000"],
      { reportDateTime: "2026-08-30T11:40:00+09:00", serial: "2" },
    );
    const file = tempPath();
    new StandbyPersistence(file, 0, () => ({
      vpws50: { authoritative: true, state: holder.exportPersistedState(), gateEntries: [] },
    })).save(legacyState());
    const loaded = new StandbyPersistence(file).load()!;
    expect(loaded.telegramFoundation.vpws50.state?.emergencyClearWatermarks).toEqual([{
      subjectKey: subject,
      identity: { reportDateTime: "2026-08-30T11:40:00+09:00", serial: "2" },
    }]);

    const restoredHolder = new Vpws50StateHolder();
    restoredHolder.restorePersistedState(loaded.telegramFoundation.vpws50.state!);
    const oldSpecial = vpww55("2026-08-30T11:20:00+09:00", "1", "福井地方気象台", "1820100");
    oldSpecial.layers[0].items[0].kinds = [{ name: "大雨特別警報", code: "33", severity: "specialWarning" }];
    restoredHolder.mergePartialWithDisplay(
      oldSpecial,
      "late-old",
      { reportDateTime: oldSpecial.reportDateTime, serial: "1" },
      subject,
    );
    expect(restoredHolder.getCurrentAreasForDisplay()).toBeUndefined();
  });

  it("StandbyPersistence 復元後も全国 base を capacity eviction から保護する", () => {
    const gate = new TelegramRevisionGate();
    const holder = new Vpws50StateHolder();
    const base = weather(meta(T1, "1", "発表"), "A");
    expect(decide(gate, base).kind).toBe("accept");
    holder.diffAndUpdate(base, "base", { reportDateTime: T1, serial: "1" });

    const file = tempPath();
    new StandbyPersistence(file, 0, () => ({
      vpws50: {
        authoritative: true,
        state: holder.exportPersistedState(),
        gateEntries: gate.exportDurableEntries(),
      },
    })).save(legacyState());
    const loaded = new StandbyPersistence(file).load()!;
    const restoredGate = new TelegramRevisionGate();
    restoredGate.restoreDurableEntries(loaded.telegramFoundation.vpws50.gateEntries);

    const maxSubjects = VPWS50_REVISION_FAMILY_POLICY.maxSubjects;
    if (maxSubjects == null) throw new Error("VPWS50 family capacity is required");
    for (let index = 0; index < maxSubjects; index++) {
      const office = `試験地方気象台${index}`;
      const subject = `weather:VPWW55:${office}`;
      expect(decide(
        restoredGate,
        vpww55(T2, String(index + 1), office, String(100000 + index)),
        true,
        subject,
      ).accepted).toBe(true);
    }

    expect(restoredGate.exportDurableEntries()).toContainEqual(
      expect.objectContaining({ stateSubjectKey: "weather:vpws50" }),
    );
    const oldBase = weather(meta("2026-07-30T09:00:00+09:00", "0", "発表"), "old");
    expect(decide(restoredGate, oldBase)).toMatchObject({ kind: "stale", accepted: false });
  });

  it("取消対象不一致と invalid date/serial は current/watermark を変更しない", () => {
    const gate = new TelegramRevisionGate();
    const first = weather(meta(T1, "1", "発表"), "A");
    expect(decide(gate, first).accepted).toBe(true);
    expect(decide(gate, weather(meta(T1, "1", "取消"), "A"), false).kind).toBe("cancelTargetMismatch");
    expect(decide(gate, weather(meta("invalid", "2", "発表"), "B")).kind).toBe("invalidRevision");
    expect(decide(gate, weather(meta(T2, "2A", "発表"), "B")).kind).toBe("invalidRevision");
    expect(decide(gate, weather(meta(T2, "2", "発表"), "B")).kind).toBe("accept");
  });

  it("Serial 欠落は偽装せず、両側欠落だけ domain policy で比較する", () => {
    const missingGate = new TelegramRevisionGate();
    expect(decide(missingGate, weather(meta(T1, null, "発表"), "A")).kind).toBe("accept");
    expect(decide(missingGate, weather(meta(T1, null, "訂正"), "B"))).toMatchObject({
      kind: "replaceCorrection", relation: "equal",
    });
    expect(decide(missingGate, weather(meta(T1, "0", "訂正"), "C"))).toMatchObject({
      kind: "invalidRevision", relation: "unordered",
    });

    const numericGate = new TelegramRevisionGate();
    expect(decide(numericGate, weather(meta(T1, "0", "発表"), "A")).kind).toBe("accept");
    expect(decide(numericGate, weather(meta(T1, null, "訂正"), "B"))).toMatchObject({
      kind: "invalidRevision", relation: "unordered",
    });
    expect(decide(numericGate, weather(meta(T1, "0", "発表"), "A")).kind).toBe("duplicate");
  });

  it("同一 revision の訂正は history を増やさず、その取消で一つ前の報へ戻る", () => {
    const gate = new TelegramRevisionGate();
    const holder = new Vpws50StateHolder();
    const first = weather(meta(T1, "1", "発表"), "A");
    const second = weather(meta(T2, "2", "発表"), "B");
    const correction = weather(meta(T2, "2", "訂正"), "B-corrected");
    for (const [parsed, messageId] of [[first, "first"], [second, "second"]] as const) {
      expect(decide(gate, parsed).accepted).toBe(true);
      holder.diffAndUpdate(parsed, messageId, {
        reportDateTime: parsed.reportDateTime, serial: parsed.meta.serial.raw,
      });
    }
    const correctionDecision = decide(gate, correction);
    expect(correctionDecision.kind).toBe("replaceCorrection");
    holder.diffAndUpdate(correction, "correction", {
      reportDateTime: T2, serial: "2",
    }, { replaceCurrentRevision: correctionDecision.relation === "equal" });

    const cancel = weather(meta(T2, "2", "取消"), "cancel-payload");
    expect(decide(gate, cancel).kind).toBe("restorePrevious");
    holder.restorePrevious();
    expect(holder.getCurrentAreasForDisplay()?.kinds[0].areas[0].areaCode).toBe("A");
  });

  it("取消適用済みなら同一 revision の別 payload でも history を二度 pop しない", () => {
    const gate = new TelegramRevisionGate();
    const holder = new Vpws50StateHolder();
    const first = weather(meta(T1, "1", "発表"), "A");
    const second = weather(meta(T2, "2", "発表"), "B");
    expect(decide(gate, first).accepted).toBe(true);
    holder.diffAndUpdate(first, "first", { reportDateTime: T1, serial: "1" });
    expect(decide(gate, second).accepted).toBe(true);
    holder.diffAndUpdate(second, "second", { reportDateTime: T2, serial: "2" });

    expect(decide(gate, weather(meta(T2, "2", "取消"), "cancel-1")).kind).toBe("restorePrevious");
    holder.restorePrevious();
    expect(decide(gate, weather(meta(T2, "2", "取消"), "cancel-2")).kind).toBe("semanticDuplicate");
    expect(holder.getCurrentAreasForDisplay()?.kinds[0].areas[0].areaCode).toBe("A");
  });

  it("取消 latch を保存・復元した後も別 payload の重複取消で history を pop しない", () => {
    const gate = new TelegramRevisionGate();
    const holder = new Vpws50StateHolder();
    const first = weather(meta(T1, "1", "発表"), "A");
    const second = weather(meta(T2, "2", "発表"), "B");
    expect(decide(gate, first).accepted).toBe(true);
    holder.diffAndUpdate(first, "first", { reportDateTime: T1, serial: "1" });
    expect(decide(gate, second).accepted).toBe(true);
    holder.diffAndUpdate(second, "second", { reportDateTime: T2, serial: "2" });
    expect(decide(gate, weather(meta(T2, "2", "取消"), "cancel-1"))).toMatchObject({
      kind: "restorePrevious", accepted: true,
    });
    holder.restorePrevious();

    const legacy = legacyState();
    legacy.weatherAlerts = [{
      source: "vpws50",
      alerts: weatherAlertsFromVpws50(holder.getCurrentAreasForDisplay(), T1),
      revision: { reportTimeMs: Date.parse(T1), serial: "1" },
      expiresAtMs: Date.parse(T1) + 86_400_000,
    }];
    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: {
        authoritative: true,
        state: holder.exportPersistedState(),
        gateEntries: gate.exportDurableEntries(),
      },
    }));
    persistence.save(legacy);
    const loaded = persistence.load()!;
    expect(persistence.takeMigrationConflictCount()).toBe(0);
    const restoredGate = new TelegramRevisionGate();
    const restoredHolder = new Vpws50StateHolder();
    restoredGate.restoreDurableEntries(loaded.telegramFoundation.vpws50.gateEntries);
    restoredHolder.restorePersistedState(loaded.telegramFoundation.vpws50.state!);

    expect(decide(restoredGate, weather(meta(T2, "2", "取消"), "cancel-2")).kind)
      .toBe("semanticDuplicate");
    expect(restoredHolder.getCurrentAreasForDisplay()?.kinds[0].areas[0].areaCode).toBe("A");

    // rollback binary が読む standalone v1 でも、復元済み A の provenance を保持する。
    fs.rmSync(standbyPersistenceV2Path(file));
    const fallback = new StandbyPersistence(file).load()!;
    expect(fallback.telegramFoundation.vpws50).toMatchObject({
      authoritative: false,
      gateEntries: [{
        comparison: { revision: { reportDateTime: { raw: T1 }, serial: { raw: "1" } } },
      }],
    });
    const fallbackGate = new TelegramRevisionGate();
    fallbackGate.restoreDurableEntries(fallback.telegramFoundation.vpws50.gateEntries);
    expect(decide(fallbackGate, first).kind).toBe("duplicate");
  });

  it("取消 latch 後の同一 revision 訂正を拒否し、取消済み snapshot を復活させない", () => {
    const gate = new TelegramRevisionGate();
    const first = weather(meta(T1, "1", "発表"), "A");
    const second = weather(meta(T2, "2", "発表"), "B");
    expect(decide(gate, first).accepted).toBe(true);
    expect(decide(gate, second).accepted).toBe(true);
    expect(decide(gate, weather(meta(T2, "2", "取消"), "cancel")).accepted).toBe(true);
    expect(decide(gate, weather(meta(T2, "2", "訂正"), "B-corrected"))).toMatchObject({
      kind: "stale", relation: "equal", accepted: false,
    });
  });

  it("production provider の未受信 empty foundation を round-trip できる", () => {
    const holder = new Vpws50StateHolder();
    const gate = new TelegramRevisionGate();
    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: {
        authoritative: true,
        state: holder.exportPersistedState(),
        gateEntries: gate.exportDurableEntries(),
      },
    }));
    persistence.save(legacyState());

    expect(persistence.load()?.telegramFoundation.vpws50).toEqual({
      authoritative: true,
      state: holder.exportPersistedState(),
      gateEntries: [],
    });
    expect(persistence.takeMigrationConflictCount()).toBe(0);
  });

  it("注意報のみの snapshot (nonLevelAdvisory) を round-trip で破棄しない", () => {
    const gate = new TelegramRevisionGate();
    const holder = new Vpws50StateHolder();
    const advisory: ParsedWeatherWarning = {
      ...weather(meta(T1, null, "発表"), "A"),
      layers: [{ type: "府県予報区等", items: [{
        areaName: "地域A", areaCode: "A", changeStatus: "変化有", fullStatus: "全域",
        kinds: [{ name: "濃霧注意報", code: "20", severity: "advisory" }], statuses: [],
      }] }],
      maxSeverity: "advisory", maxDisplaySeverity: "nonLevelAdvisory", maxSoundLevel: "normal",
      warningAreaCount: 0, advisoryAreaCount: 1,
    };
    expect(decide(gate, advisory).accepted).toBe(true);
    holder.diffAndUpdate(advisory, "advisory", { reportDateTime: T1, serial: null });
    const exported = holder.exportPersistedState();
    expect(exported?.current?.snapshot.areas[0]?.kinds[0]?.displaySeverity).toBe("nonLevelAdvisory");

    const file = tempPath();
    const persistence = new StandbyPersistence(file, 0, () => ({
      vpws50: {
        authoritative: true,
        state: exported,
        gateEntries: gate.exportDurableEntries(),
      },
    }));
    persistence.save(legacyState());

    const loaded = new StandbyPersistence(file).load();
    expect(loaded?.telegramFoundation.vpws50.state).not.toBeNull();
    expect(loaded?.telegramFoundation.vpws50.gateEntries).toHaveLength(1);
    expect(loaded?.telegramFoundation.vpws50.state?.current?.snapshot.areas[0]?.kinds[0]?.displaySeverity)
      .toBe("nonLevelAdvisory");

    // officialL1 も型 DisplaySeverity の全値許容から欠落しないことを固定する
    const v2Path = standbyPersistenceV2Path(file);
    const raw = JSON.parse(fs.readFileSync(v2Path, "utf8")) as PersistedStandbyStateV2;
    raw.telegramFoundation.vpws50.state!.current!.snapshot.areas[0].kinds[0].displaySeverity = "officialL1";
    fs.writeFileSync(v2Path, JSON.stringify(raw), "utf8");
    const reloaded = new StandbyPersistence(file).load();
    expect(reloaded?.telegramFoundation.vpws50.state?.current?.snapshot.areas[0]?.kinds[0]?.displaySeverity)
      .toBe("officialL1");
  });

  it("pre-digest v2 の semantic key を reader で固定長へ移行する", () => {
    const { file, expected } = persistedFoundationFixture();
    expected.telegramFoundation.vpws50.gateEntries[0].semanticKeys = [
      `発表:${JSON.stringify({ area: "A", nested: { value: "legacy-payload" } })}`,
    ];
    fs.writeFileSync(standbyPersistenceV2Path(file), JSON.stringify(expected), "utf8");

    const [key] = new StandbyPersistence(file).load()!
      .telegramFoundation.vpws50.gateEntries[0].semanticKeys;
    expect(key).toMatch(/^発表:[0-9a-f]{64}$/);
    expect(key).not.toContain("legacy-payload");
    expect(key).toHaveLength("発表:".length + 64);
  });

  it("7日超の旧 pre-digest v2 でも取消 latch を無期限 policy へ移行して遅延旧報を拒否する", () => {
    const gate = new TelegramRevisionGate();
    const holder = new Vpws50StateHolder();
    const first = weather(meta(T1, "1", "発表"), "A");
    const second = weather(meta(T2, "2", "発表"), "B");
    expect(decide(gate, first).accepted).toBe(true);
    holder.diffAndUpdate(first, "first", { reportDateTime: T1, serial: "1" });
    expect(decide(gate, second).accepted).toBe(true);
    holder.diffAndUpdate(second, "second", { reportDateTime: T2, serial: "2" });
    expect(decide(gate, weather(meta(T2, "2", "取消"), "B-cancel")).kind).toBe("restorePrevious");
    holder.restorePrevious();

    const legacy = legacyState();
    legacy.weatherAlerts = [{
      source: "vpws50",
      alerts: weatherAlertsFromVpws50(holder.getCurrentAreasForDisplay(), T1),
      revision: { reportTimeMs: Date.parse(T1), serial: "1" },
      expiresAtMs: Date.parse(T1) + 86_400_000,
    }];
    const file = tempPath();
    new StandbyPersistence(file, 0, () => ({
      vpws50: {
        authoritative: true,
        state: holder.exportPersistedState(),
        gateEntries: gate.exportDurableEntries(),
      },
    })).save(legacy);

    const oldV2 = JSON.parse(
      fs.readFileSync(standbyPersistenceV2Path(file), "utf8"),
    ) as PersistedStandbyStateV2;
    const oldEntry = oldV2.telegramFoundation.vpws50.gateEntries[0];
    delete oldEntry.tombstoneRetentionMs;
    oldEntry.semanticKeys = [`取消:${JSON.stringify({ area: "B-cancel" })}`];
    fs.writeFileSync(standbyPersistenceV2Path(file), JSON.stringify(oldV2), "utf8");

    // 旧 entry の acceptedAtMs から 7 日超後に再起動する。
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(
      oldEntry.acceptedAtMs + 8 * 24 * 60 * 60_000,
    );
    const loaded = new StandbyPersistence(file).load()!;
    nowSpy.mockRestore();
    expect(loaded.telegramFoundation.vpws50.gateEntries[0]).toMatchObject({
      cancelled: true,
      tombstoneRetentionMs: null,
    });

    const restoredGate = new TelegramRevisionGate();
    restoredGate.restoreDurableEntries(loaded.telegramFoundation.vpws50.gateEntries);
    expect(decide(restoredGate, second)).toMatchObject({
      kind: "duplicate",
      accepted: false,
    });
  });

  it("v1 reader は根拠のない revisionOf(nowMs) を watermark に採用しない", () => {
    const old = legacyState();
    old.weatherAlerts = [{
      source: "vpws50",
      alerts: [{ source: "vpws50", label: "気象警報", role: "weatherWarning", totalAreas: 1, items: [], updatedAt: T1 }],
      // updatedAt と一致しないため provenance を証明できない旧 nowMs 値。
      revision: { reportTimeMs: Date.parse(T2), serial: "9" },
      expiresAtMs: Date.parse(T2) + 86_400_000,
    }];
    const file = tempPath();
    fs.writeFileSync(file, JSON.stringify(old), "utf8");
    const loaded = new StandbyPersistence(file).load();
    expect(loaded?.telegramFoundation.vpws50.authoritative).toBe(false);
    expect(loaded?.telegramFoundation.vpws50.gateEntries).toEqual([]);
    const gate = new TelegramRevisionGate();
    gate.restoreDurableEntries(loaded!.telegramFoundation.vpws50.gateEntries);
    expect(decide(gate, weather(meta(T1, "1", "発表"), "A")).kind).toBe("accept");
  });

  it("v1 reader は元 ReportDateTime で証明できる revision だけを trusted watermark にする", () => {
    const old = legacyState();
    old.weatherAlerts = [{
      source: "vpws50",
      alerts: [{ source: "vpws50", label: "気象警報", role: "weatherWarning", totalAreas: 1, items: [], updatedAt: T1 }],
      revision: { reportTimeMs: Date.parse(T1), serial: "1" },
      expiresAtMs: Date.parse(T1) + 86_400_000,
    }];
    const file = tempPath();
    fs.writeFileSync(file, JSON.stringify(old), "utf8");
    const loaded = new StandbyPersistence(file).load();
    expect(loaded?.telegramFoundation.vpws50.gateEntries).toHaveLength(1);
    const gate = new TelegramRevisionGate();
    gate.restoreDurableEntries(loaded!.telegramFoundation.vpws50.gateEntries);
    expect(decide(gate, weather(meta("2026-07-30T09:00:00+09:00", "0", "発表"), "old")).kind).toBe("stale");
    expect(decide(gate, weather(meta(T2, "2", "発表"), "new")).kind).toBe("accept");
  });

  it("v1 reader は空 Serial を明示的な missing として扱い、不正 savedAt は watermark にしない", () => {
    const old = legacyState();
    old.weatherAlerts = [{
      source: "vpws50",
      alerts: [{ source: "vpws50", label: "気象警報", role: "weatherWarning", totalAreas: 1, items: [], updatedAt: T1 }],
      revision: { reportTimeMs: Date.parse(T1), serial: "" },
      expiresAtMs: Date.parse(T1) + 86_400_000,
    }];
    const trustedFile = tempPath();
    fs.writeFileSync(trustedFile, JSON.stringify(old), "utf8");
    const trusted = new StandbyPersistence(trustedFile).load();
    expect(trusted?.telegramFoundation.vpws50.gateEntries[0].comparison.revision.serial)
      .toMatchObject({ raw: "", numeric: null, valid: false });

    old.weatherAlerts[0].revision.serial = " ";
    const whitespaceFile = tempPath();
    fs.writeFileSync(whitespaceFile, JSON.stringify(old), "utf8");
    expect(new StandbyPersistence(whitespaceFile).load()?.telegramFoundation.vpws50.gateEntries).toEqual([]);

    old.savedAt = "invalid";
    const untrustedFile = tempPath();
    fs.writeFileSync(untrustedFile, JSON.stringify(old), "utf8");
    const untrusted = new StandbyPersistence(untrustedFile).load();
    expect(untrusted?.telegramFoundation.vpws50.gateEntries).toEqual([]);
  });

  it("v1 表示復元状態は正規電文受理前の再保存でも authoritative に昇格しない", () => {
    const old = legacyState();
    old.weatherAlerts = [{
      source: "vpws50",
      alerts: [{ source: "vpws50", label: "気象警報", role: "weatherWarning", totalAreas: 1, items: [], updatedAt: T1 }],
      revision: { reportTimeMs: Date.parse(T1), serial: "1" },
      expiresAtMs: Date.parse(T1) + 86_400_000,
    }];
    const sourceFile = tempPath();
    fs.writeFileSync(sourceFile, JSON.stringify(old), "utf8");
    const migrated = new StandbyPersistence(sourceFile).load()!;
    const roundTripFile = tempPath();
    new StandbyPersistence(roundTripFile, 0, () => migrated.telegramFoundation).save(migrated);
    const reloaded = new StandbyPersistence(roundTripFile).load();
    expect(reloaded?.telegramFoundation.vpws50.authoritative).toBe(false);
    expect(reloaded?.weatherAlerts).toEqual(migrated.weatherAlerts);
  });

  it("snapshot 世代 marker が無い旧 holder state は対応する revision gate と一緒に破棄する", () => {
    const { file, expected } = persistedFoundationFixture();
    const snapshot = expected.telegramFoundation.vpws50.state!.current!.snapshot;
    snapshot.areas.push({
      ...structuredClone(snapshot.areas[0]),
      areaCode: "B",
      areaName: "地域B",
    });
    delete (snapshot as { generation?: number }).generation;
    fs.writeFileSync(standbyPersistenceV2Path(file), JSON.stringify(expected), "utf8");

    const loaded = new StandbyPersistence(file).load()!;
    expect(loaded.telegramFoundation.vpws50).toEqual({
      authoritative: true,
      state: null,
      gateEntries: [],
    });

    const restoredGate = new TelegramRevisionGate();
    const restoredHolder = new Vpws50StateHolder();
    restoredGate.restoreDurableEntries(loaded.telegramFoundation.vpws50.gateEntries);
    const municipalityReport = {
      ...weather(meta(T2, "2", "発表"), "120001"),
      layers: [{
        type: "気象警報・注意報（市町村等）",
        items: [{
          areaName: "市町村A", areaCode: "120001", changeStatus: "変化有", fullStatus: "全域",
          kinds: [{ name: "大雨警報", code: "03", severity: "warning" as const }], statuses: [],
        }],
      }],
    };
    expect(decide(restoredGate, municipalityReport).kind).toBe("accept");
    expect(restoredHolder.diffAndUpdate(
      municipalityReport,
      "municipality",
      { reportDateTime: T2, serial: "2" },
    )).toMatchObject({ confidence: "confirmed", isFirstReport: true });
    expect(restoredHolder.getCurrentAreasForDisplay()?.kinds[0]?.areas[0]?.areaName).toBe("市町村A");
  });

  it.each([
    ["current ReportDateTime", (state: PersistedStandbyStateV2) => {
      state.telegramFoundation.vpws50.state!.current!.identity.reportDateTime = "invalid";
    }],
    ["future current ReportDateTime", (state: PersistedStandbyStateV2) => {
      state.telegramFoundation.vpws50.state!.current!.identity.reportDateTime = "2027-07-30T10:00:00+09:00";
    }],
    ["current Serial", (state: PersistedStandbyStateV2) => {
      state.telegramFoundation.vpws50.state!.current!.identity.serial = "not-numeric";
    }],
    ["gate ReportDateTime", (state: PersistedStandbyStateV2) => {
      state.telegramFoundation.vpws50.gateEntries[0].comparison.revision.reportDateTime.raw = "invalid";
    }],
    ["gate Serial", (state: PersistedStandbyStateV2) => {
      state.telegramFoundation.vpws50.gateEntries[0].comparison.revision.serial = {
        raw: "not-numeric", numeric: null, valid: false,
      };
    }],
    ["gate EventID valid flag", (state: PersistedStandbyStateV2) => {
      state.telegramFoundation.vpws50.gateEntries[0].comparison.revision.eventId.valid = false;
    }],
    ["gate type valid flag", (state: PersistedStandbyStateV2) => {
      state.telegramFoundation.vpws50.gateEntries[0].comparison.revision.type.valid = false;
    }],
  ] as const)("v2 の不正な %s を trusted foundation state として復元しない", (_label, mutate) => {
    const { file, expected } = persistedFoundationFixture();
    mutate(expected);
    fs.writeFileSync(standbyPersistenceV2Path(file), JSON.stringify(expected), "utf8");
    const loaded = new StandbyPersistence(file).load();
    expect(loaded?.telegramFoundation.vpws50).toEqual({
      authoritative: true,
      state: null,
      gateEntries: [],
    });
  });

  it.each([
    ["複数 gate entry", (state: PersistedStandbyStateV2) => {
      state.telegramFoundation.vpws50.gateEntries.push(
        structuredClone(state.telegramFoundation.vpws50.gateEntries[0]),
      );
    }],
    ["cancelled:false watermark と current の不一致", (state: PersistedStandbyStateV2) => {
      state.telegramFoundation.vpws50.state!.current!.identity = {
        reportDateTime: T2,
        serial: "2",
      };
      state.weatherAlerts![0].alerts = state.weatherAlerts![0].alerts.map((alert) => ({
        ...alert,
        updatedAt: T2,
      }));
      state.weatherAlerts![0].revision = { reportTimeMs: Date.parse(T2), serial: "2" };
    }],
    ["cancelled:true watermark と current が同一", (state: PersistedStandbyStateV2) => {
      state.telegramFoundation.vpws50.gateEntries[0].cancelled = true;
    }],
    ["history revision の逆順", (state: PersistedStandbyStateV2) => {
      const current = structuredClone(state.telegramFoundation.vpws50.state!.current!);
      current.identity = { reportDateTime: T2, serial: "2" };
      state.telegramFoundation.vpws50.state!.history = [current];
    }],
    ["partialHistory subject が128件上限超過", (state: PersistedStandbyStateV2) => {
      const current = state.telegramFoundation.vpws50.state!.current!;
      state.telegramFoundation.vpws50.state!.partialHistory = Array.from({ length: 129 }, (_, index) => ({
        subjectKey: `weather:VPWW55:試験地方気象台${index}`,
        entries: [{
          messageId: `partial-${index}`,
          identity: structuredClone(current.identity),
          snapshot: structuredClone(current.snapshot),
        }],
      }));
    }],
  ] as const)("v2 holder/gate 相互不整合を拒否する: %s", (_label, mutate) => {
    const { file, expected } = persistedFoundationFixture();
    mutate(expected);
    fs.writeFileSync(standbyPersistenceV2Path(file), JSON.stringify(expected), "utf8");
    expect(new StandbyPersistence(file).load()?.telegramFoundation.vpws50).toEqual({
      authoritative: true,
      state: null,
      gateEntries: [],
    });
  });

  it.each([
    ["同一 revision の payload 差", (state: PersistedStandbyStateV2) => {
      state.weatherAlerts![0].alerts[0].label = "矛盾した見出し";
    }],
    ["新 current=null / 旧 payload あり", (state: PersistedStandbyStateV2) => {
      state.telegramFoundation.vpws50.state!.current = null;
      state.telegramFoundation.vpws50.gateEntries[0].cancelled = true;
    }],
    ["新 current あり / 旧 field 欠落", (state: PersistedStandbyStateV2) => {
      delete state.weatherAlerts;
    }],
  ] as const)("新旧矛盾 telemetry: %s", (_label, mutate) => {
    const { file, expected } = persistedFoundationFixture();
    mutate(expected);
    fs.writeFileSync(standbyPersistenceV2Path(file), JSON.stringify(expected), "utf8");
    const persistence = new StandbyPersistence(file);
    expect(persistence.load()?.telegramFoundation.vpws50.authoritative).toBe(true);
    expect(persistence.takeMigrationConflictCount()).toBe(1);
  });

  it("canonical と旧 path の v2 envelope 矛盾を load 単位で一回だけ計上する", () => {
    const { file, expected } = persistedFoundationFixture();
    const canonical = structuredClone(expected);
    canonical.weatherAlerts![0].alerts[0].label = "canonical 側の不一致";
    fs.writeFileSync(standbyPersistenceV2Path(file), JSON.stringify(canonical), "utf8");

    const standaloneV2 = structuredClone(expected);
    standaloneV2.weatherAlerts![0].alerts[0].label = "standalone 側の不一致";
    fs.writeFileSync(file, JSON.stringify(standaloneV2), "utf8");

    const persistence = new StandbyPersistence(file);
    expect(persistence.load()?.telegramFoundation.vpws50.authoritative).toBe(true);
    expect(persistence.takeMigrationConflictCount()).toBe(1);
  });

  it.each([
    ["v1 だけ別内容", (file: string) => {
      const standalone = JSON.parse(fs.readFileSync(file, "utf8")) as PersistedStandbyStateV1;
      standalone.savedAt = "2026-07-30T12:00:00+09:00";
      fs.writeFileSync(file, JSON.stringify(standalone), "utf8");
    }],
    ["v1 欠落", (file: string) => fs.rmSync(file)],
    ["v1 改変", (file: string) => fs.writeFileSync(file, "{}", "utf8")],
  ] as const)("standalone 新旧実体の矛盾 telemetry: %s", (_label, mutate) => {
    const { file, expected } = persistedFoundationFixture();
    mutate(file);
    const persistence = new StandbyPersistence(file);
    expect(persistence.load()).toEqual(expected);
    expect(persistence.takeMigrationConflictCount()).toBe(1);
  });
});
