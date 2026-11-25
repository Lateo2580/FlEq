import { describe, expect, it } from "vitest";

import type { WireDetailRequest } from "../../contracts/p4-display-wire.types";
import type { ShellClientState, ShellDetail } from "../../contracts/p4-display-shell.types";
import { acceptSnapshot, detailAnswered, detailRequested } from "../../src/display/screen/client";

const UNITS = { eew: "U-E", tsunami: "U-T", earthquake: "U-Q", weatherCurrent: "U-W", weatherTimeseries: "U-F", nankai: "U-N",
  volcano: "U-V", landslide: "U-L", flood: "U-R", briefing: "U-B", localBulletins: "U-M", typhoon: "U-Y" };
function wire(streamId: string, sequence: number, revisions: Record<string, string> = {}, extra: Record<string, unknown> = {}): string {
  const current = Object.fromEntries(Object.entries(UNITS).map(([key, unit]) => [key, { unit, contentRevision: revisions[key] ?? "r0" }]));
  return JSON.stringify({ schemaVersion: "p4-display-wire-v3", streamId, sequence, semanticRevision: "s", current, notices: [], ...extra });
}
const EMPTY: ShellClientState = { snapshot: null, unsupported: false, changed: [], detail: null };
const request: WireDetailRequest = { unit: "U-T", part: "index", revision: "1", page: 0 };
const opened = (state: ShellClientState): { state: ShellClientState; asked: ShellDetail } => {
  const next = detailRequested(state, request);
  return { state: next, asked: next.detail as ShellDetail };
};

// T05 契約境界（P4-DS-AC03・AC15）: 受け入れ・捨て・版の違い・changed・詳細の状態。
describe("P4-DS-T05 snapshot client", () => {
  // 外形の欠けは項目ごとに（schemaVersion が字でないときは状態を変えない）
  const broken: [string, (value: Record<string, unknown>) => void][] = [
    ["schemaVersion が字でない", (v) => { v.schemaVersion = 3; }], ["streamId が無い", (v) => { delete v.streamId; }],
    ["sequence が整数でない", (v) => { v.sequence = 1.5; }], ["semanticRevision が無い", (v) => { delete v.semanticRevision; }],
    ["current が無い", (v) => { delete v.current; }],
    ...Object.keys(UNITS).flatMap((key): [string, (value: Record<string, unknown>) => void][] => [
      [`${key} が無い`, (v) => { delete (v.current as Record<string, unknown>)[key]; }],
      [`${key} の unit が字でない`, (v) => { (v.current as Record<string, Record<string, unknown>>)[key].unit = 1; }],
      [`${key} の contentRevision が無い`, (v) => { delete (v.current as Record<string, Record<string, unknown>>)[key].contentRevision; }]]),
  ];
  it.each(broken)("外形の欠け（%s）は状態を変えない", (_name, mutate) => {
    const value = JSON.parse(wire("a", 1));
    mutate(value);
    expect(acceptSnapshot(EMPTY, JSON.stringify(value))).toBe(EMPTY);
  });

  it("読めない JSON・版の違い・古い sequence・別の stream を順に受ける", () => {
    expect(acceptSnapshot(EMPTY, "{not json")).toBe(EMPTY);
    const v2 = acceptSnapshot(EMPTY, JSON.stringify({ schemaVersion: "p4-display-wire-v2", streamId: "a", sequence: 1 }));
    expect(v2).toMatchObject({ unsupported: true, snapshot: null });

    const first = acceptSnapshot(v2, wire("a", 5));
    expect(first).toMatchObject({ unsupported: false, changed: Object.keys(UNITS) });
    expect(first.snapshot?.sequence).toBe(5);
    expect(acceptSnapshot(first, wire("a", 5))).toBe(first);
    expect(acceptSnapshot(first, wire("a", 4))).toBe(first);
    const second = acceptSnapshot(first, wire("a", 6, { tsunami: "r1" }));
    expect(second.changed).toEqual(["tsunami"]);
    const otherStream = acceptSnapshot(second, wire("b", 1));
    expect(otherStream.changed).toHaveLength(12);
    expect(otherStream.snapshot?.streamId).toBe("b");
  });

  it("metadata だけの 1,000 回の更新で changed は空のまま、詳細は初期化されない", () => {
    let { state } = opened(acceptSnapshot(EMPTY, wire("a", 0)));
    const detail = state.detail;
    for (let sequence = 1; sequence <= 1000; sequence++) {
      state = acceptSnapshot(state, wire("a", sequence));
      expect(state.changed).toEqual([]);
    }
    expect(state.detail).toBe(detail);
    expect(state.snapshot?.sequence).toBe(1000);
  });

  it("O11:8 取消の notice の直後に別の分野が更新されても、最新の snapshot の notices のままで、履歴を貯めない", () => {
    const cancel = { operation: "normal", text: "取消" };
    let state = acceptSnapshot(EMPTY, wire("a", 1, {}, { notices: [cancel] }));
    expect(state.snapshot?.notices).toEqual([cancel]);
    state = acceptSnapshot(state, wire("a", 2, { tsunami: "r1" }, { notices: [cancel] }));
    expect(state.changed).toEqual(["tsunami"]);
    expect(state.snapshot?.notices).toEqual([cancel]);
    state = acceptSnapshot(state, wire("a", 3, { tsunami: "r1", eew: "r1" }, { notices: [] }));
    expect(state.snapshot?.notices).toEqual([]);
    expect(Object.keys(state).sort()).toEqual(["changed", "detail", "snapshot", "unsupported"]);
  });

  it("詳細は、ほかの分野の更新では保ち、その分野の内容版と stream の変化で取り直し、409 で取り直し、旧い stream の応答は採らない", () => {
    const { state: loading, asked } = opened(acceptSnapshot(EMPTY, wire("a", 1)));
    expect(asked).toMatchObject({ status: "loading", streamId: "a" });
    expect(acceptSnapshot(loading, wire("a", 2, { eew: "r9" })).detail).toBe(asked);
    expect(acceptSnapshot(loading, wire("a", 2, { tsunami: "r9" })).detail?.status).toBe("refetch");
    expect(acceptSnapshot(loading, wire("b", 1)).detail?.status).toBe("refetch");
    // 詳細の unit の分野が新しい snapshot に無いときも取り直し
    const gone = JSON.parse(wire("a", 2));
    gone.current.tsunami.unit = "U-X";
    expect(acceptSnapshot(loading, JSON.stringify(gone)).detail?.status).toBe("refetch");

    const ok = detailAnswered(loading, asked, { kind: "ok", part: "comment", id: "i", revision: "1", text: "t" });
    expect(ok.detail).toMatchObject({ status: "ready", response: { part: "comment" } });
    expect(detailAnswered(loading, asked, { kind: "error", reason: "versionChanged", revision: "2" }).detail?.status).toBe("refetch");
    expect(detailAnswered(loading, asked, { kind: "failed", reason: "unavailable" }).detail).toMatchObject({ status: "failed", response: null });

    const moved = acceptSnapshot(loading, wire("b", 1));
    expect(detailAnswered(moved, asked, { kind: "ok", part: "comment", id: "i", revision: "1", text: "t" })).toBe(moved);
  });
});
