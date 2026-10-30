import { readFileSync } from "node:fs";
import { promises as fileSystem } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { ExecutionPlace } from "../../contracts/p3-execution-split.types";
import type {
  ClockReading, DiagnosticEvent, JsonValue, LossTally, RestoreUnitResult, RuntimeUnitId, RuntimeUnitStates, UnitCodec, UnreadableCard,
} from "../../contracts/p2-shared-runtime.types";
import {
  CheckpointCoordinator, LOCAL_BULLETINS_CARDS_MAX_BYTES, UNREADABLE_CARDS_MAX_BYTES, hashEnvelope, lossReasons, serializedEnvelope,
} from "../../src/checkpoint/checkpoint";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { envelope, harnessedRoot, park, startHarness, submit } from "../execution-split/owner-harness";
import { ingestXmlData } from "../../src/ingress/ingress";
import { linkedUnitCodecs, linkedUnitTable, nodeCheckpointFileSystem } from "../../src/runtime/composition-root";
import {
  capturedOwner, checkpointResultOwner, initialUnits, ownerViews, placeUnits, receiveOwner, restoreOwner,
} from "../../src/runtime/owner-runtime";
import type { OwnerState, ParserCompletion } from "../../src/runtime/owner-runtime";

// P3-UNREADABLE-MARK-001（K14）発注 3 の試験: H43 のカード（T10・T11・T21・T22。T13 は shared-runtime.test.ts）。

const T0 = Date.parse("2026-10-28T10:00:00+09:00");
const at = (wallTimeMs: number, monotonicMs = 0): ClockReading => ({ wallTimeMs, monotonicMs });
const xmlOf = (name: string) => readFileSync(`test/fixtures/${name}.xml`, "utf8");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const MARKER = "[truncated:fieldLimit]";

let sequence = 0;
function input(xml: string, headType: string, receivedAt = T0): ParserCompletion {
  const entered = ingestXmlData({ inputId: `input-${++sequence}`, inputSequence: sequence, receivedAt, origin: "replay", kind: "replay", headType,
    body: Buffer.from(xml) });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  return { runId: "run", inputId: entered.item.inputId, result: decodeMaterial(entered.item), headType, receivedAt };
}
function owner(place: ExecutionPlace): OwnerState {
  const restored: Partial<Record<RuntimeUnitId, RestoreUnitResult>> = {};
  for (const unit of placeUnits(place)) restored[unit] = { kind: "empty" };
  return restoreOwner({ runId: "run", place, clock: at(T0), restored }, linkedUnitTable, linkedUnitCodecs).state;
}
const receive = (state: OwnerState, completion: ParserCompletion, clock = at(T0)) => receiveOwner(state, completion, clock, linkedUnitTable);
const losses = (state: OwnerState, unit: RuntimeUnitId) =>
  Object.fromEntries((state.losses[unit] ?? []).map((row) => [row.reason, row.count]));
// 知らない種類の報。本文は 32,000 文字の地の文で、カードの原文は 16,384 byte（JSON、引用符込み）に切れる。
const unknownXml = (title: string, fill = 16_000) => `<?xml version="1.0" encoding="UTF-8"?><Report><Control><Title>t</Title>`
  + `<DateTime>2026-10-28T01:00:00Z</DateTime><Status>通常</Status></Control><Head><Title>${title}</Title>`
  + `<ReportDateTime>2026-10-28T10:00:00+09:00</ReportDateTime><Headline><Text>見出し</Text></Headline></Head>`
  + `<Body><A>${"a".repeat(fill)}</A><B>${"b".repeat(fill)}</B></Body></Report>`;
// VTSE41（32-39_11_02）の最初の予報区の Kind の Code を消す（K10 の (f)、U-T が断る。tsunami-unit.test.ts の拒否の表と同じ壊し方）。
const vtse41 = xmlOf("32-39_11_02_250206_VTSE41");
const kindless = vtse41.replace(/(<Body[\s\S]*?<Category>\s*<Kind><Name>[^<]*<\/Name>)<Code>\d+<\/Code>/, "$1");
const VTSE41_AT = at(Date.parse("2011-03-11T14:49:01+09:00"));

const temporary: string[] = [];
afterAll(async () => { for (const path of temporary) await fileSystem.rm(path, { recursive: true, force: true }); });
async function directory(): Promise<string> {
  const path = await fileSystem.mkdtemp(join(tmpdir(), "unreadable-card-"));
  temporary.push(path);
  return path;
}
type Codecs = Readonly<{ [Unit in keyof RuntimeUnitStates]?: UnitCodec<RuntimeUnitStates[Unit], JsonValue> }>;
function coordinator(path: string, wallTimeMs: number, codecs: Codecs = linkedUnitCodecs) {
  const events: DiagnosticEvent[] = [];
  return { events, checkpoint: new CheckpointCoordinator(path, codecs, nodeCheckpointFileSystem(), () => ({ wallTimeMs, monotonicMs: 1 }),
    (event) => { events.push(event); }) };
}
// capture → 書き込み → 読み戻し（製品の保存の経路）。capture が器を越えれば request が null。
async function saveAndRead(unit: RuntimeUnitId, state: unknown, cards: readonly UnreadableCard[], rows: readonly LossTally[] = [], wallTimeMs = T0 + 60_000) {
  const path = await directory();
  const { checkpoint } = coordinator(path, wallTimeMs);
  const correlation = { inputIds: ["input-0"], retryReason: "notRetry" as const };
  const captured = checkpoint.capture(unit, state, 1, "run", correlation, null, rows, cards);
  if (captured.request == null) return { captured, restored: null };
  const executed = await checkpoint.executeCheckpoint(captured.request, "run", correlation.inputIds, "notRetry");
  expect(executed.result.kind).toBe("acknowledged");
  return { captured, restored: coordinator(path, wallTimeMs).checkpoint.restoreUnit(unit) };
}
// envelope の unreadable を直接書いて読み戻す（AC16 (3)(b)(4)）。
async function readBack(unit: RuntimeUnitId, cards: readonly unknown[]): Promise<RestoreUnitResult["kind"]> {
  const path = await directory();
  const codec = linkedUnitCodecs[unit]!;
  const envelope = hashEnvelope({ schemaVersion: codec.schemaVersion, unit, generation: 1, capturedAt: T0, inputBoundary: null,
    payload: codec.encode(initialUnits[unit] as never), unreadable: cards as UnreadableCard[] });
  await fileSystem.writeFile(join(path, `${unit}-A.json`), serializedEnvelope(envelope));
  return coordinator(path, T0).checkpoint.restoreUnit(unit).kind;
}
// 合法な形の最長のカード（AC11 (12)）。
// rawDropped は count の前（保存の欄の順。読み戻しは再直列化と照合する）。
const longest = (index: number, raw: string | null, dropped = false): UnreadableCard => ({ kind: "unknownType",
  inputId: `input-${String(index).padStart(58, "0")}`, headType: "h".repeat(64), operation: "training", receivedAt: T0 + index, reason: "routeNotPorted",
  title: "t".repeat(1536), headline: "t".repeat(1536), reportDateTimeRaw: "d".repeat(64), raw, rawCut: true, ...dropped ? { rawDropped: true } : {},
  count: Number.MAX_SAFE_INTEGER });

describe("P3-UNREADABLE-MARK-001 order 3 (H43 cards)", () => {
  it("P3-UM-T10 acceptance / AC11,AC09: each kind of unreadable input becomes a card in its unit's envelope and survives capture and restore", async () => {
    // (a) U-T が断る VTSE41: U-T の envelope に unreadable のカード、負の証拠、H39 の unreadableReport。
    const urgent = owner("urgent");
    const a = receive(urgent, input(kindless, "VTSE41"), VTSE41_AT);
    const tsunamiCard = a.state.unreadable["U-T"]?.[0];
    expect([tsunamiCard?.kind, tsunamiCard?.reason, tsunamiCard?.headType, tsunamiCard?.operation, tsunamiCard?.title, tsunamiCard?.receivedAt,
      tsunamiCard?.raw?.startsWith("<Report"), losses(a.state, "U-T").unreadableReport, a.confirmationEvidence])
      .toEqual(["unreadable", "requiredStructureMissing", "VTSE41", "normal", "大津波警報・津波警報・津波注意報・津波予報", T0, true, 1,
        [{ source: "unreadableReport", scopes: [{ unit: "U-T", operation: "normal", kind: "unit" }] }]]);
    expect([a.diagnostics.map((item) => item.reason), a.generationInputIds["U-T"]]).toEqual([["requiredStructureMissing"], [tsunamiCard?.inputId]]);
    // (b) parser が断る VXSE43（XML を壊す）: U-E に unidentified のカード（原文は展開した本文の先頭、負の証拠なし）。
    const broken = xmlOf("37_01_01_240613_VXSE43").replace("</Head>", "</Hed>");
    const b = receive(a.state, input(broken, "VXSE43"));
    expect(b.state.unreadable["U-E"]?.map((card) => [card.kind, card.reason, card.operation, card.title, card.raw?.slice(0, 5), card.rawCut]))
      .toEqual([["unidentified", "xmlInvalid", null, null, "<?xml", false]]);
    expect([b.confirmationEvidence, b.generationInputIds["U-E"], losses(b.state, "U-E")])
      .toEqual([[], [b.state.unreadable["U-E"]?.[0].inputId], { unreadableReport: 1 }]);

    // (c) 知らない種類 2 通: U-M に unknownType 1 枚（count 2、中身は後の報）。(d) ignored の VXSE44 と壊した VXSE44 はカード無し。
    // (e) U-M が断る報（O02:56、synthetic_VPHW50_tokyo_empty）は U-M に unreadable 1 枚。
    let deferred = owner("deferred");
    const first = receive(deferred, input(unknownXml("最初"), "VZZZ99"));
    const second = receive(first.state, input(unknownXml("後"), "VZZZ99", T0 + 1_000), at(T0 + 1_000));
    expect(second.state.unreadable["U-M"]?.map((card) => [card.kind, card.reason, card.count, card.title, card.receivedAt, card.rawCut]))
      .toEqual([["unknownType", "routeUnlisted", 2, "後", T0 + 1_000, true]]);
    expect([first.confirmationEvidence, second.confirmationEvidence, losses(second.state, "U-M")])
      .toEqual([[], [], { unreadableReport: 2, unreadableDropped: 2 }]);
    // AC11 (8): view にカードを全部渡し、原文の本文は渡さない。
    const view = second.views.find((item) => item.unit === "U-M");
    const { raw: _raw, ...shown } = second.state.unreadable["U-M"]![0];
    expect(view?.unreadableCards).toEqual([{ ...shown, hasRaw: true }]);
    expect(JSON.stringify(view)).not.toContain("a".repeat(100));
    deferred = second.state;
    for (const xml of [xmlOf("36_01_10_240613_VXSE44"), xmlOf("36_01_10_240613_VXSE44").replace("</Head>", "</Hed>")]) {
      const ignored = receive(deferred, input(xml, "VXSE44"));
      expect([ignored.state.unreadable, ignored.changedUnits]).toEqual([deferred.unreadable, []]);
    }
    const e = receive(deferred, input(xmlOf("synthetic_VPHW50_tokyo_empty"), "VPHW50"), at(Date.parse("2014-02-12T13:50:01+09:00")));
    expect(e.state.unreadable["U-M"]?.map((card) => [card.kind, card.headType, card.count])).toEqual([["unknownType", "VZZZ99", 2],
      ["unreadable", "VPHW50", 1]]);
    expect(e.confirmationEvidence).toMatchObject([{ source: "unreadableReport", scopes: [{ unit: "U-M", kind: "unit" }] }]);

    // capture → restore でカードが戻る。
    const saved = await saveAndRead("U-M", e.state.units["U-M"], e.state.unreadable["U-M"]!, e.state.losses["U-M"]);
    if (saved.restored?.kind !== "restored") throw new Error("U-M did not restore");
    expect(saved.restored.envelope.unreadable).toEqual(e.state.unreadable["U-M"]);
    const back = restoreOwner({ runId: "run", place: "deferred", clock: at(T0 + 120_000), restored: { "U-F": { kind: "empty" }, "U-L": { kind: "empty" },
      "U-R": { kind: "empty" }, "U-B": { kind: "empty" }, "U-M": saved.restored, "U-Y": { kind: "empty" } } }, linkedUnitTable, linkedUnitCodecs);
    expect(back.state.unreadable["U-M"]).toEqual(e.state.unreadable["U-M"]);

    // 帰属（ヘルツ r0 の注）: 知らない種類と parser の拒否もカードを書いた unit の世代にその inputId が帰属し、カードの前の世代の保存の
    // ack が後から届いても、新しいカードの世代は保存済みにならない。
    const generation = e.state.units["U-M"]!.persistence.currentGeneration;
    const captured = capturedOwner(e.state, { unit: "U-M", attemptId: "save-1", generation, capturedAt: T0 + 2_000 }, linkedUnitTable).state;
    const later = input(unknownXml("三通目"), "VZZZ98", T0 + 3_000);
    const added = receive(captured, later, at(T0 + 3_000, 3_000));
    expect([added.generationInputIds, added.state.units["U-M"]!.persistence.currentGeneration, added.state.checkpointAttempts["U-M"]?.postCaptureDirtySince])
      .toEqual([{ "U-M": [later.inputId] }, generation + 1, 3_000]);
    const acked = checkpointResultOwner(added.state, { kind: "acknowledged", attemptId: "save-1", unit: "U-M", generation, ackAt: T0 + 4_000,
      encodedByteLength: 1 }, linkedUnitTable).state.units["U-M"]!.persistence;
    expect([acked.kind, acked.savedGeneration, acked.currentGeneration, acked.dirtySince]).toEqual(["pending", generation, generation + 1, 3_000]);
    const parserRejected = input(broken, "VXSE43");
    expect(receive(b.state, parserRejected).generationInputIds).toEqual({ "U-E": [parserRejected.inputId] });
  }, 30_000);

  // 実不具合（ヘルツ r0 の P2、thread 01a1804b の再現）: 24 時間を過ぎたカードを外す capture の後、保存の I/O の待ちの間に受けたカードが、
  // 遅れて届いた保存の返信（capture の時の view）で publisher の写しから消えない。
  it("P3-UM-T10 regression / AC11 (4)(8): a delayed save reply does not roll back the cards received after its capture", async () => {
    const path = await directory();
    const t0 = Date.parse("2026-10-28T01:00:00Z");
    let now = { wallTimeMs: t0, monotonicMs: 0 };
    const real = nodeCheckpointFileSystem();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let armed = false, parked = false;
    const h = harnessedRoot({ appName: "review", legacyAppName: "legacy", stateDirectory: join(path, "state"),
      legacyStateDirectory: join(path, "legacy"), diagnosticDirectory: join(path, "diagnostics") }, linkedUnitCodecs, {
      clock: () => now, checkpointFileSystem: { ...real, rename: async (from: string, to: string) => {
        if (armed && to.includes("U-E-")) { armed = false; parked = true; await park(gate); }
        await real.rename(from, to);
      } },
    });
    await startHarness(h, "review", now);
    const send = async (id: string, order: number) => submit(h, envelope("review", "VXSE43", id, Buffer.from("<Report>"), now, order));
    const mirror = () => h.root.state.mirror["U-E"].view.unreadableCards?.map((card) => card.inputId);
    await send("old", 1);
    expect(h.root.state.mirror["U-E"].persistence.kind).toBe("saved");
    now = { wallTimeMs: t0 + 86_400_001, monotonicMs: 100 };
    armed = true;
    await send("before-capture", 2);
    expect(parked).toBe(true);
    now = { wallTimeMs: now.wallTimeMs + 1, monotonicMs: 101 };
    await send("after-capture", 3);
    expect(mirror()).toEqual(["before-capture", "after-capture"]);
    release();
    await h.settle();
    const state = h.owners.get("urgent")!["state"]!;
    const canonical = ownerViews(state, linkedUnitTable).find((view) => view.unit === "U-E")?.unreadableCards?.map((card) => card.inputId);
    await h.root.diagnostics.flush();
    expect([mirror(), canonical]).toEqual([["before-capture", "after-capture"], ["before-capture", "after-capture"]]);
  });

  it("P3-UM-T11 contractBoundary / AC11,AC16: raw budget, card count, 24 hours and the envelope read-back of card shapes", async () => {
    // U-M: 原文の合計が 131,072 byte を越えると古いカードから原文が外れ、17 枚目で最古のカードが外れる（H39 の unreadableDropped）。
    let state = owner("deferred");
    const added: ReturnType<typeof receive>[] = [];
    for (let index = 1; index <= 17; index++) {
      const step = receive(state, input(unknownXml(`題${index}`), `VZZ${String(index).padStart(3, "0")}`, T0 + index * 1_000), at(T0 + index * 1_000));
      added.push(step);
      state = step.state;
    }
    const dropped = (step: ReturnType<typeof receive>) => losses(step.state, "U-M").unreadableDropped;
    const cardsAfter = (count: number) => added[count - 1].state.unreadable["U-M"]!;
    expect([cardsAfter(8).every((card) => card.raw != null && bytes(card.raw) === 16_384), dropped(added[7])]).toEqual([true, 8]);
    expect([cardsAfter(9)[0].raw, cardsAfter(9)[0].rawDropped, cardsAfter(9)[0].rawCut, dropped(added[8]) - dropped(added[7])])
      .toEqual([null, true, true, 2]);
    expect([cardsAfter(17).length, cardsAfter(17)[0].headType, dropped(added[16]) - dropped(added[15]),
      cardsAfter(17).reduce((sum, card) => sum + (card.raw == null ? 0 : bytes(card.raw)), 0)]).toEqual([16, "VZZ002", 3, 131_072]);
    expect(bytes(cardsAfter(17)) + ',"unreadable":'.length).toBeLessThanOrEqual(LOCAL_BULLETINS_CARDS_MAX_BYTES);
    // 原文を切って後で外したカード（rawCut と rawDropped が両方真）も読み戻しが通る。
    const saved = await saveAndRead("U-M", state.units["U-M"], cardsAfter(17), state.losses["U-M"], T0 + 60_000);
    expect(saved.restored?.kind).toBe("restored");
    // 24 時間を過ぎたカードは復元で外れ、H39 は増えない。
    if (saved.restored?.kind !== "restored") return;
    const day = restoreOwner({ runId: "run", place: "deferred", clock: at(T0 + 86_400_000 + 8_500), restored: { "U-F": { kind: "empty" },
      "U-L": { kind: "empty" }, "U-R": { kind: "empty" }, "U-B": { kind: "empty" }, "U-M": saved.restored, "U-Y": { kind: "empty" } } },
    linkedUnitTable, linkedUnitCodecs).state;
    expect([day.unreadable["U-M"]?.map((card) => card.headType), day.losses["U-M"]])
      .toEqual([["VZZ009", "VZZ010", "VZZ011", "VZZ012", "VZZ013", "VZZ014", "VZZ015", "VZZ016", "VZZ017"], state.losses["U-M"]]);

    // 読み戻しが拒むカードの形（AC16 (3)(b)・AC11 (12)）。基準のカードは通る。
    const base = longest(0, null, true);
    expect(await readBack("U-M", [base])).toBe("restored");
    for (const [label, card] of [
      ["unknownType with a rejection reason", { ...base, reason: "headMissing" }],
      ["unreadable counted twice", { ...base, kind: "unreadable", reason: "headMissing", count: 2 }],
      ["unidentified with a route reason", { ...base, kind: "unidentified", count: 1 }],
      ["count 0", { ...base, count: 0 }],
      ["raw kept after rawDropped", { ...base, raw: "x" }],
      ["headType over 66 bytes", { ...base, headType: "h".repeat(65) }],
      ["ReportDateTime over 66 bytes", { ...base, reportDateTimeRaw: "d".repeat(65) }],
      ["title over 1,538 bytes", { ...base, title: "t".repeat(1537) }],
      ["raw over 16,384 bytes", { ...longest(0, "r".repeat(16_383)) }],
      ["inputId outside validInputId", { ...base, inputId: "input 1" }],
      ["areas before order 4", { ...base, areas: [] }],
      ["extra key", { ...base, extra: 1 }],
    ] as const) expect(await readBack("U-M", [card]), label).toBe("unavailable");
    // 枚数（U-M は 16、ほかは 8）と原文の予算（U-M は 131,072 byte）。
    expect(await readBack("U-M", Array.from({ length: 17 }, (_, index) => longest(index, null)))).toBe("unavailable");
    expect(await readBack("U-L", Array.from({ length: 9 }, (_, index) => longest(index, null)))).toBe("unavailable");
    expect(await readBack("U-M", Array.from({ length: 8 }, (_, index) => longest(index, "r".repeat(16_382))))).toBe("restored");
    expect(await readBack("U-M", Array.from({ length: 9 }, (_, index) => longest(index, "r".repeat(16_382))))).toBe("unavailable");
  }, 60_000);

  it("P3-UM-T11・P3-UM-T22 contractBoundary / AC11 (10)(12): eight VTSE41 with a 16,384-character ReportDateTime keep each card within its bound", async () => {
    let state = owner("urgent");
    for (let index = 0; index < 8; index++)
      state = receive(state, input(vtse41.replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${"9".repeat(16_384)}</ReportDateTime>`),
        "VTSE41", T0 + index), VTSE41_AT).state;
    const cards = state.unreadable["U-T"]!;
    expect([cards.length, new Set(cards.map((card) => [card.reason, bytes(card.reportDateTimeRaw), card.reportDateTimeRaw?.endsWith(MARKER)].join())).size,
      cards[0].reportDateTimeRaw?.endsWith(MARKER), bytes(cards[0].reportDateTimeRaw)]).toEqual([8, 1, true, 66]);
    expect(bytes(cards) + ',"unreadable":'.length).toBeLessThanOrEqual(UNREADABLE_CARDS_MAX_BYTES);
    // 保存した 8 枚がそのまま戻る（復元の成功だけでは、カードを書かない保存でも通る。ヘルツ r0 の P3）。
    const saved = await saveAndRead("U-T", state.units["U-T"], cards, state.losses["U-T"]);
    expect(saved.restored?.kind === "restored" ? saved.restored.envelope.unreadable : saved.restored).toEqual(cards);
  }, 30_000);

  it("P3-UM-T21 contractBoundary / AC17: a receive on a U-M holding 16 cards does not serialize the state or its cards", () => {
    let state = owner("deferred");
    for (let index = 1; index <= 16; index++)
      state = receive(state, input(unknownXml(`題${index}`), `VZY${String(index).padStart(3, "0")}`, T0 + index), at(T0 + index)).state;
    const next = input(unknownXml("十七"), "VZY017", T0 + 17);
    const whole = new Set<unknown>([state, state.units, state.units["U-M"], state.unreadable, state.unreadable["U-M"], ...state.unreadable["U-M"]!]);
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const step = receive(state, next, at(T0 + 17));
      expect(step.state.unreadable["U-M"]).toHaveLength(16);
      expect(stringify.mock.calls.filter(([value]) => whole.has(value))).toEqual([]);
    } finally { stringify.mockRestore(); }
  });

  it("P3-UM-T22 contractBoundary / AC11 (10): a unit packed to its container still saves and restores eight full cards", async () => {
    // 記録を器の際まで詰めた U-T と U-W（decode が受ける最大の詰め物）に、原文の予算いっぱいの最長のカード 8 枚と全部の理由の最長の losses。
    const cards = Array.from({ length: 8 }, (_, index) => longest(index, "r".repeat(8_190)));
    expect(cards.reduce((sum, card) => sum + bytes(card.raw), 0)).toBe(65_536);
    const fullLosses = (unit: RuntimeUnitId): LossTally[] => lossReasons(unit).map((reason) => ({ reason, count: Number.MAX_SAFE_INTEGER, lastAt: T0 }));
    const packed = <S>(codec: UnitCodec<S, JsonValue>, make: (pad: number) => S): S => {
      const high = codec.maxEnvelopeBytes! - bytes(codec.encode(make(0)));
      // U-W の encode は境界の外で投げる（保存の守り）。
      const fits = (pad: number) => {
        try { return codec.decode(JSON.parse(JSON.stringify(codec.encode(make(pad)))) as JsonValue).kind === "restored"; } catch { return false; }
      };
      let low = Math.max(high - 400_000, 0), top = high;
      expect([fits(low), fits(top)]).toEqual([true, false]);
      while (top - low > 1) { const middle = Math.floor((low + top) / 2); if (fits(middle)) low = middle; else top = middle; }
      return make(low);
    };
    const tsunamiCodec = linkedUnitCodecs["U-T"]!;
    const seeded = receive(owner("urgent"), input(vtse41, "VTSE41"), VTSE41_AT).state.units["U-T"]!;
    const forecast = seeded.forecasts[0];
    const tsunami = packed(tsunamiCodec, (pad) => ({ ...seeded, forecasts: [{ ...forecast, areas: [{ ...forecast.areas[0],
      name: forecast.areas[0].name + "x".repeat(pad) }, ...forecast.areas.slice(1)] }] }));
    const t = await saveAndRead("U-T", tsunami, cards, fullLosses("U-T"));
    expect([t.captured.request == null ? t.captured.result : null, t.restored?.kind === "restored" ? t.restored.envelope.unreadable : t.restored])
      .toEqual([null, cards]);
    const weatherCodec = linkedUnitCodecs["U-W"]!;
    const national = receive(owner("weatherCurrent"), input(xmlOf("15_18_01_250630_VPWS50"), "VPWS50"),
      at(Date.parse("2025-06-30T12:00:00+09:00"))).state.units["U-W"]!;
    const normal = national.national.normal!;
    const weather = packed(weatherCodec, (pad) => ({ ...national, national: { ...national.national, normal: { ...normal,
      phenomena: { ...normal.phenomena, pad: "x".repeat(pad) } } } }));
    const w = await saveAndRead("U-W", weather, cards, fullLosses("U-W"));
    expect([w.captured.request == null ? w.captured.result : null, w.restored?.kind === "restored" ? w.restored.envelope.unreadable : w.restored])
      .toEqual([null, cards]);
  }, 120_000);

  it("P3-UM-T22 contractBoundary / AC16 (1): order-2 slots of the raised U-Q and U-W on both sides read as unknownSchema and the run saves nothing", async () => {
    // 版を上げた U-Q・U-W: 捨ててよい旧い版の一覧は空（P3-VM-AC05 の一覧の寿命、P3-MIG-AC01）なので、前の版（発注 2）の保存を両 slot に置くと
    // unknownSchema で読み、この run は保存しない（P3-VM-AC05 (4)。開発機の保存は配送の手順で消す、P3-MIG-AC02）。
    for (const [unit, previous] of [["U-Q", "p3-seismic-unit-v6"], ["U-W", "p2-weather-current-unit-v5"]] as const) {
      const path = await directory();
      for (const [side, generation] of [["A", 1], ["B", 2]] as const)
        await fileSystem.writeFile(join(path, `${unit}-${side}.json`), serializedEnvelope(hashEnvelope({ schemaVersion: previous, unit, generation,
          capturedAt: T0, inputBoundary: null, payload: { pad: "x".repeat(linkedUnitCodecs[unit]!.maxEnvelopeBytes! - 2_000) } })));
      const { checkpoint, events } = coordinator(path, T0 + 1_000);
      expect([linkedUnitCodecs[unit]!.discardableSchemaVersions, checkpoint.restoreUnit(unit), checkpoint.saves(unit),
        events.map((event) => event.reason)]).toEqual([undefined, { kind: "unavailable", reason: "unknownSchema" }, false, ["checkpointRestoreRejected"]]);
    }
  }, 120_000);
});
