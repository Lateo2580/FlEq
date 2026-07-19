import { describe, it, expect } from "vitest";
import { keyCoastRows, keyObsRows } from "../tsunami-rows";
import type { DisplayTsunamiInputV1, DisplayTsunamiObservationV1 } from "../protocol";

type Coast = DisplayTsunamiInputV1["coasts"][number];
function coast(name: string, kind: string): Coast {
  return { name, kind, maxHeight: null, firstHeight: null };
}
function obs(stationName: string): DisplayTsunamiObservationV1 {
  return {
    areaName: null,
    areaKind: null,
    stationName,
    arrivalTime: null,
    initial: null,
    maxHeightValue: null,
    condition: null,
  };
}

describe("keyCoastRows (ordinal 採番、spec §2-c Medium 6 / 最終改稿 2)", () => {
  it("ユニークな行は ordinal 0 の基底キーになる", () => {
    const rows = keyCoastRows([coast("岩手県", "警報"), coast("宮城県", "警報")]);
    expect(rows.map((r) => r.key)).toEqual(["岩手県|警報|0", "宮城県|警報|0"]);
  });

  it("同一 name+kind の重複には出現順の ordinal が付く (決定的キー)", () => {
    const rows = keyCoastRows([
      coast("岩手県", "警報"),
      coast("岩手県", "警報"),
      coast("宮城県", "警報"),
    ]);
    expect(rows.map((r) => r.key)).toEqual(["岩手県|警報|0", "岩手県|警報|1", "宮城県|警報|0"]);
  });

  it("name が同じでも kind が違えば別基底キー (ordinal は基底ごとに独立)", () => {
    const rows = keyCoastRows([coast("A", "警報"), coast("A", "注意報"), coast("A", "警報")]);
    expect(rows.map((r) => r.key)).toEqual(["A|警報|0", "A|注意報|0", "A|警報|1"]);
  });

  it("無関係な行の途中挿入では既存行のキーが変わらない (先勝ち安定)", () => {
    const before = keyCoastRows([coast("A", "警報"), coast("B", "警報")]);
    const after = keyCoastRows([coast("A", "警報"), coast("X", "警報"), coast("B", "警報")]);
    expect(before[0].key).toBe(after[0].key); // A は不変
    expect(before[1].key).toBe(after[2].key); // B も不変 (基底が違うため index 挿入の影響を受けない)
  });

  it("row には元の要素がそのまま入る", () => {
    const c = coast("岩手県", "警報");
    expect(keyCoastRows([c])[0].row).toBe(c);
  });
});

describe("keyObsRows (ordinal 採番)", () => {
  it("同一観測点名の重複には出現順の ordinal が付く", () => {
    const rows = keyObsRows([obs("石巻"), obs("石巻"), obs("宮古")]);
    expect(rows.map((r) => r.key)).toEqual(["石巻|0", "石巻|1", "宮古|0"]);
  });

  it("無関係な観測点の途中挿入では既存キーが変わらない", () => {
    const before = keyObsRows([obs("石巻"), obs("宮古")]);
    const after = keyObsRows([obs("石巻"), obs("大洗"), obs("宮古")]);
    expect(before[0].key).toBe(after[0].key);
    expect(before[1].key).toBe(after[2].key);
  });
});
