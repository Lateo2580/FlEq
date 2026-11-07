import { mkdtempSync, rmSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JsonValue, ReportRef } from "../../contracts/p2-shared-runtime.types";
import type { DisplaySnapshot } from "../../contracts/p2-snapshot-sse.types";
import type { BulletinTextRequest, BulletinTextResponse } from "../../contracts/p3-bulletin-text-api.types";
import type { NankaiInformation, NankaiUnitState } from "../../contracts/p3-nankai-unit.types";
import type { VolcanoBulletin, VolcanoUnitState } from "../../contracts/p3-volcano-unit.types";
import { startDisplayServer } from "../../src/http-sse/http-sse";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { detailOwner, restoreOwner } from "../../src/runtime/owner-runtime";
import { nankaiUnitCodec, toNankaiView } from "../../src/units/nankai/nankai-unit";
import { toVolcanoView, volcanoUnitCodec } from "../../src/units/volcano/volcano-unit";
import { envelope, harnessedRoot, manualAdapter, startHarness, submit } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";
import * as nankai from "../nankai-unit/nankai-fixture";
import * as volcano from "../volcano-unit/volcano-fixture";

const STREAM = "00000000-0000-4000-8000-000000000000";
const healthy = { state: "healthy", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null } as const;
const GONE = { kind: "error", reason: "versionChanged", revision: null } as const;
const UNAVAILABLE = { kind: "error", reason: "unavailable", revision: null } as const;
const NATIONAL = "44_01_01_151008_VFVO51", NOTICE = "42_02_01_071130_VZVO40", FLOW = "79_01_01_210527_VFVO60";
const REGULAR = "75_01_04_200512_VYSE52", VYSE60 = "80_01_01_240821_VYSE60", CANCEL = "74_03_01_220318_VYSE50";

const revisionOf = (source: ReportRef) => JSON.stringify([source.inputId, source.reportDateTimeRaw, source.controlDateTimeRaw]);
const element = (xml: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1].trim();
const emptyOwner = () => restoreOwner({ runId: "run", place: "urgent", clock: volcano.clock(0), restored: { "U-E": { kind: "empty" },
  "U-T": { kind: "empty" }, "U-Q": { kind: "empty" }, "U-N": { kind: "empty" }, "U-V": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs).state;
const askVolcano = (state: VolcanoUnitState, id: string, revision: string) =>
  detailOwner({ ...emptyOwner(), units: { ...emptyOwner().units, "U-V": state } }, { unit: "U-V", part: "text", id, revision });
const askNankai = (state: NankaiUnitState, id: string, revision: string) =>
  detailOwner({ ...emptyOwner(), units: { ...emptyOwner().units, "U-N": state } }, { unit: "U-N", part: "text", id, revision });
const restoredVolcano = (state: VolcanoUnitState) => {
  const decoded = volcanoUnitCodec.decode(JSON.parse(JSON.stringify(volcanoUnitCodec.encode(state))) as JsonValue);
  if (decoded.kind !== "restored") throw new Error(decoded.reason);
  return decoded.state;
};
const restoredNankai = (state: NankaiUnitState) => {
  const decoded = nankaiUnitCodec.decode(JSON.parse(JSON.stringify(nankaiUnitCodec.encode(state))) as JsonValue);
  if (decoded.kind !== "restored") throw new Error(decoded.reason);
  return decoded.state;
};
// 見出しが view にある記録と ok の答えが同じ範囲になることを、記録ごとに確かめる（P3-BT-AC03 (7)）。
function expectVolcanoParity(state: VolcanoUnitState): void {
  const shown = new Set(toVolcanoView(state).bulletins.map((item) => item.subject));
  for (const item of state.bulletins) expect(askVolcano(state, item.subject, revisionOf(item.source)).kind === "ok").toBe(shown.has(item.subject));
}
function expectNankaiParity(state: NankaiUnitState): void {
  const shown = new Set(toNankaiView(state).information.map((item) => item.subject));
  for (const item of state.information) expect(askNankai(state, item.subject, revisionOf(item.source)).kind === "ok").toBe(shown.has(item.subject));
}

const directories: string[] = [];
const closers: (() => Promise<void>)[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of closers.splice(0)) await close();
  await Promise.allSettled(harnesses.splice(0).map((h) => h.root.diagnostics.flush()));
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fetchText(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path, agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    }).on("error", reject);
  });
}
function fake(answer: BulletinTextResponse) {
  const seen: unknown[] = [];
  return { seen, detail: (request: unknown) => { seen.push(request); return { response: Promise.resolve(answer), done: () => {} }; } };
}
async function server(detail?: Parameters<typeof startDisplayServer>[0]["detail"]) {
  const started = await startDisplayServer({ host: "127.0.0.1", port: 0, worker: healthy, detail });
  closers.push(() => started.close());
  return started;
}
const textPath = (unit: string, query: Readonly<Record<string, string>>) => `/api/display/domains/${unit}/detail?${new URLSearchParams(query).toString()}`;

describe("P3-BT-T01 acceptance (AC01): the text path over HTTP", () => {
  const id = "normal/VYSE50/a+b%c", revision = JSON.stringify(["input-1", "2020-05-12T16:30:00+09:00", "2020-05-12T07:30:05Z"]);
  const good = { streamId: STREAM, part: "text", id, revision };
  const ok: BulletinTextResponse = { kind: "ok", part: "text", id, revision, text: "本文", nextAdvisory: null };

  it("reads both units, decodes the query and adds the stream id to the answer", async () => {
    for (const unit of ["U-V", "U-N"] as const) {
      const port = fake(ok), started = await server(port.detail);
      const result = await fetchText(started.port, textPath(unit, good));
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ streamId: STREAM, ...ok });
      expect(port.seen).toEqual([{ streamId: STREAM, detail: { unit, part: "text", id, revision } }]);
    }
  });
  it("answers 400 before the root for anything out of shape", async () => {
    const port = fake(ok), started = await server(port.detail);
    const { streamId: _stream, ...noStream } = good;
    const prefix = `${textPath("U-V", good)}&x=`, tooLong = prefix + "a".repeat(1_025 - Buffer.byteLength(prefix));
    expect(Buffer.byteLength(tooLong)).toBe(1_025);
    const bad = [textPath("U-V", noStream), textPath("U-V", { ...good, part: "index" }), textPath("U-V", { ...good, id: "normal/VPWW54/1" }),
      textPath("U-V", { ...good, id: "normal/VFVO51/a\"b" }), textPath("U-V", { ...good, id: `normal/VFVO51/${"a".repeat(65)}` }),
      textPath("U-V", { ...good, revision: "input-1" }), textPath("U-V", { ...good, revision: "[\"input-1\",\"t\"]" }),
      textPath("U-V", { ...good, revision: "[\"input 1\",\"t\",\"t\"]" }), textPath("U-V", { ...good, revision: JSON.stringify(["i", "t".repeat(41), "t"]) }),
      `${textPath("U-V", good)}&part=text`, tooLong];
    for (const path of bad) {
      const result = await fetchText(started.port, path);
      expect([result.status, JSON.parse(result.body)]).toEqual([400, { kind: "error", reason: "invalidRequest", revision: null }]);
    }
    expect(port.seen).toEqual([]);
  });
  it("maps the root's errors to 409 / 429 / 503 / 504 and has no route without the port", async () => {
    const expected: [BulletinTextResponse, number][] = [[{ kind: "error", reason: "versionChanged", revision }, 409],
      [{ kind: "error", reason: "busy", revision: null }, 429], [UNAVAILABLE, 503], [{ kind: "error", reason: "timeout", revision: null }, 504]];
    for (const [answer, status] of expected) {
      const started = await server(fake(answer).detail);
      const result = await fetchText(started.port, textPath("U-N", good));
      expect([result.status, JSON.parse(result.body)]).toEqual([status, { streamId: STREAM, ...answer }]);
    }
    expect((await fetchText((await server()).port, textPath("U-V", good))).status).toBe(404);
  });
});

describe("P3-BT-T02 acceptance (AC03, AC04): the text the unit holds comes back as it is", () => {
  it("returns U-V bulletins with the telegram's characters, and null for a report without the field", () => {
    const national = volcano.send(volcano.emptyState(), NATIONAL).state, xml = volcano.fixtureXml(NATIONAL);
    const item = national.bulletins[0];
    const raw = element(xml, "VolcanoActivity")!;
    expect(raw).toMatch(/[\n　]/);
    expect(askVolcano(national, item.subject, revisionOf(item.source))).toEqual({ kind: "ok", part: "text", id: item.subject, revision: revisionOf(item.source),
      text: raw, nextAdvisory: element(xml, "NextAdvisory") ?? null });
    const notice = volcano.send(volcano.emptyState(), NOTICE).state, noticed = notice.bulletins[0];
    expect(askVolcano(notice, noticed.subject, revisionOf(noticed.source))).toMatchObject({ kind: "ok", text: element(volcano.fixtureXml(NOTICE).split("<Body")[1], "Text") });
    const flow = volcano.send(volcano.emptyState(), FLOW).state, flowed = flow.bulletins[0];
    expect(askVolcano(flow, flowed.subject, revisionOf(flowed.source))).toMatchObject({ kind: "ok", text: null, nextAdvisory: null });
  });
  it("returns U-N information with the telegram's characters", () => {
    for (const name of [REGULAR, VYSE60]) {
      const state = nankai.send(nankai.emptyState(), name).state, item = state.information[0];
      const info = /<EarthquakeInfo[\s\S]*<\/EarthquakeInfo>/.exec(nankai.fixtureXml(name))![0];
      expect(askNankai(state, item.subject, revisionOf(item.source))).toMatchObject({ kind: "ok", id: item.subject, text: element(info, "Text") });
    }
  });
});

describe("P3-BT-T03 contractBoundary (AC03): the answers when the text is not there", () => {
  it("U-V: unknown, replaced, cancelled and pending records, and nothing after a restart", () => {
    const first = volcano.send(volcano.emptyState(), NATIONAL).state, old = first.bulletins[0];
    const oldRevision = revisionOf(old.source);
    expect(askVolcano(first, "normal/VFVO51/none", oldRevision)).toEqual(GONE);
    const later = volcano.send(first, NATIONAL, volcano.sentLater).state;
    expect(later.bulletins).toHaveLength(1);
    const current = revisionOf(later.bulletins[0].source);
    expect(current).not.toBe(oldRevision);
    expect(askVolcano(later, old.subject, oldRevision)).toEqual({ kind: "error", reason: "versionChanged", revision: current });
    expect(askVolcano(later, old.subject, current)).toMatchObject({ kind: "ok" });
    const pending: VolcanoUnitState = { ...later, bulletins: later.bulletins.map((item): VolcanoBulletin => item.effective === "active" ? { ...item, expiryPending: true } : item) };
    expect(askVolcano(pending, old.subject, current)).toEqual(GONE);
    const { effective: _effective, ...kept } = later.bulletins[0];
    const cancelled: VolcanoUnitState = { ...later, bulletins: [{ subject: kept.subject, family: kept.family, eventId: kept.eventId, operation: kept.operation, source: kept.source, retainUntil: kept.retainUntil, effective: "cancelled" }] };
    expect(askVolcano(cancelled, old.subject, current)).toEqual(GONE);
    for (const state of [first, later, pending, cancelled]) expectVolcanoParity(state);
    expect(askVolcano(restoredVolcano(later), old.subject, current)).toEqual(GONE);
  });
  it("U-N: cancelled and pending records, and the same text after a restart", () => {
    const state = nankai.send(nankai.emptyState(), REGULAR).state, item = state.information[0], revision = revisionOf(item.source);
    const restored = restoredNankai(state);
    expect(askNankai(restored, item.subject, revision)).toEqual(askNankai(state, item.subject, revision));
    expect(askNankai(restored, item.subject, revision)).toMatchObject({ kind: "ok" });
    const pending: NankaiUnitState = { ...state, information: state.information.map((value): NankaiInformation => value.effective === "active" ? { ...value, expiryPending: true } : value) };
    expect(askNankai(pending, item.subject, revision)).toEqual(GONE);
    const cancelled = nankai.send(state, CANCEL, nankai.replaceTag("EventID", item.eventId)).state;
    const record = cancelled.information.find((value) => value.subject.endsWith(`/${item.eventId}`) && value.effective === "cancelled");
    expect(record).toBeDefined();
    expect(askNankai(cancelled, record!.subject, revisionOf(record!.source))).toEqual(GONE);
    for (const value of [state, pending, cancelled]) expectNankaiParity(value);
  });
  it("U-N: a correction with the restored report's input id does not answer the restored report's key", () => {
    const material = nankai.decodeFixture(REGULAR, undefined, "input-1");
    const a = nankai.receive(nankai.emptyState(), material, nankai.clock(Date.parse(material.reportDateTimeRaw))).state;
    const item = a.information[0], keyA = revisionOf(item.source);
    const correction = nankai.decodeFixture(REGULAR, (xml) => nankai.sentLater(xml).replace(/(<EarthquakeInfo[\s\S]*?<Text>)/, "$1訂正した本文"), "input-1");
    const b = nankai.receive(restoredNankai(a), correction, nankai.clock(Date.parse(correction.reportDateTimeRaw))).state;
    const replaced = b.information[0], keyB = revisionOf(replaced.source);
    expect(replaced.source.inputId).toBe(item.source.inputId);
    expect(keyB).not.toBe(keyA);
    expect(askNankai(b, item.subject, keyA)).toEqual({ kind: "error", reason: "versionChanged", revision: keyB });
    const answer = askNankai(b, item.subject, keyB);
    expect(answer).toMatchObject({ kind: "ok", revision: keyB });
    expect(answer.kind === "ok" && answer.part === "text" ? answer.text : null).toMatch(/^訂正した本文/);
  });
});

describe("P3-BT-T04 contractBoundary (AC02): the request runs on the shared detail line, bound for urgent", () => {
  async function boot() {
    const path = mkdtempSync(join(tmpdir(), "fleq-bt-"));
    directories.push(path);
    const xml = volcano.fixtureXml(NATIONAL);
    const at = { wallTimeMs: Date.parse(element(xml, "ReportDateTime")!) + 60_000, monotonicMs: 1 };
    const published: DisplaySnapshot[] = [];
    const h = harnessedRoot({ appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(path, "state"),
      legacyStateDirectory: join(path, "old"), diagnosticDirectory: join(path, "diagnostics") }, linkedUnitCodecs,
    { clock: () => at, notificationAdapter: manualAdapter().adapter, display: { publish: (snapshot) => { published.push(snapshot); } } });
    harnesses.push(h);
    await startHarness(h, "bt", at);
    let sequence = 0;
    const input = (name: string, headType: string) => envelope("bt", headType, `${name}-${++sequence}`, Buffer.from(volcano.fixtureXml(name)), at, sequence);
    await submit(h, input(NATIONAL, "VFVO51"));
    const snapshot = published.at(-1)!, domain = snapshot.current.volcano;
    if (domain.delivery !== "full") throw new Error("the volcano domain is not full");
    const item = domain.view.bulletins[0];
    const detail: BulletinTextRequest = { unit: "U-V", part: "text", id: item.subject, revision: revisionOf(item.source) };
    const ask = (streamId = snapshot.streamId) => h.root.requestDetail({ streamId, detail });
    const sentTo = (place: string) => h.sent.filter((value) => value.place === place && value.request.kind === "detail").length;
    return { h, input, ask, sentTo, published, streamId: snapshot.streamId, index: { part: "index", revision: snapshot.current.weatherTimeseries.contentRevision, page: 0 } as const };
  }

  it("goes to urgent with the view's identifiers, and only when urgent owes no input reply", async () => {
    const t = await boot();
    const release = t.h.hold((place, reply) => place === "urgent" && reply.kind === "inputDone");
    await submit(t.h, t.input(NOTICE, "VZVO40"));
    const waiting = t.ask();
    await t.h.settle();
    expect(t.sentTo("urgent")).toBe(0);
    release();
    t.h.release();
    await t.h.settle();
    expect(t.sentTo("urgent")).toBe(1);
    expect(await waiting.response).toMatchObject({ kind: "ok", part: "text", text: element(volcano.fixtureXml(NATIONAL), "VolcanoActivity") });
    waiting.done();
  });
  it("reads U-N through the root with the view's identifiers, on the same urgent owner", async () => {
    const t = await boot();
    await submit(t.h, t.input(`selected_xml/${REGULAR}`, "VYSE52"));
    const domain = t.published.at(-1)!.current.nankai;
    if (domain.delivery !== "full") throw new Error("the nankai domain is not full");
    const item = domain.view.information[0];
    const asked = t.h.root.requestDetail({ streamId: t.streamId, detail: { unit: "U-N", part: "text", id: item.subject, revision: revisionOf(item.source) } });
    await t.h.settle();
    expect(t.sentTo("urgent")).toBe(1);
    const info = /<EarthquakeInfo[\s\S]*<\/EarthquakeInfo>/.exec(nankai.fixtureXml(REGULAR))![0];
    expect(await asked.response).toMatchObject({ kind: "ok", part: "text", id: item.subject, text: element(info, "Text") });
    asked.done();
  });
  it("counts with U-F: the 9th is busy", async () => {
    const t = await boot();
    const unhold = t.h.holdRequests((_place, request) => request.kind === "detail");
    const asked = [0, 1, 2, 3, 4, 5, 6, 7].map((value) => value % 2 === 0 ? t.ask() : t.h.root.requestDetail({ streamId: t.streamId, detail: t.index }));
    expect(await t.ask().response).toEqual({ kind: "error", reason: "busy", revision: null });
    unhold();
    for (const item of asked) item.done();
  });
  it("ends with unavailable when urgent stops, and an old stream never reaches the owner", async () => {
    const t = await boot();
    const old = t.ask("another-run");
    expect(await old.response).toEqual(GONE);
    expect(t.sentTo("urgent")).toBe(0);
    const unhold = t.h.holdRequests((place, request) => place === "urgent" && request.kind === "detail");
    const inOwner = t.ask();
    await t.h.settle();
    t.h.root.ownerFailed("urgent", new Error("stopped"));
    expect(await inOwner.response).toEqual(UNAVAILABLE);
    expect(await t.ask().response).toEqual(UNAVAILABLE);
    unhold();
    inOwner.done();
  });
});

describe("P3-BT-T05 contractBoundary (AC04, RES-01, RES-05, RES-07): the largest legal text fits and keeps its characters", () => {
  const eventId = "%".repeat(64), id = `training/VFVO51/${eventId}`;
  // 復元が受ける最も伸びる字（長さ 40 字と Date.parse だけ）。
  const report = "49" + "\u000b".repeat(38), control = "2020-05-12T16:30:00+09:00";
  const revision = JSON.stringify(["i".repeat(64), report, control]);

  it("sends the full text in one body under 65,536 bytes", async () => {
    const text = `あ"\\\n${"　".repeat(4_092)}`, nextAdvisory = "い".repeat(512);
    const base = volcano.send(volcano.emptyState(), NATIONAL).state, record = base.bulletins[0];
    if (record.effective !== "active") throw new Error("the bulletin is not active");
    const source = { ...record.source, inputId: "i".repeat(64), reportDateTimeRaw: report, controlDateTimeRaw: control };
    const state: VolcanoUnitState = { ...base, bulletins: [{ ...record, subject: id, source, text, nextAdvisory }] };
    const answer = askVolcano(state, id, revision);
    expect(answer).toEqual({ kind: "ok", part: "text", id, revision, text, nextAdvisory });
    const started = await server(() => ({ response: Promise.resolve(answer), done: () => {} }));
    const result = await fetchText(started.port, textPath("U-V", { streamId: "s".repeat(64), part: "text", id, revision }));
    expect(result.status).toBe(200);
    expect(Buffer.byteLength(result.body)).toBeLessThanOrEqual(65_536);
    expect(JSON.parse(result.body)).toMatchObject({ streamId: "s".repeat(64), text, nextAdvisory });
  });
  it("keeps the 409 body within 534 bytes and the longest correct request within 1,024 bytes", async () => {
    const started = await server(fake({ kind: "error", reason: "versionChanged", revision }).detail);
    const path = textPath("U-V", { streamId: "s".repeat(36), part: "text", id, revision: JSON.stringify(["%".repeat(64), "\uffff".repeat(40), "%".repeat(40)]) });
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(1_024);
    const result = await fetchText(started.port, path);
    expect(result.status).toBe(409);
    expect(Buffer.byteLength(JSON.stringify({ ...JSON.parse(result.body), streamId: "s".repeat(64) }))).toBeLessThanOrEqual(534);
  });
});
