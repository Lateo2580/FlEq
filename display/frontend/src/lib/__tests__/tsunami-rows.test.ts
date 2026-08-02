import { describe, it, expect } from "vitest";
import { coastKindGroupKey, keyCoastRows, keyObsRows } from "../tsunami-rows";
import type { DisplayTsunamiInputV1, DisplayTsunamiObservationV1 } from "../protocol";

type Coast = DisplayTsunamiInputV1["coasts"][number];
function coast(
  name: string,
  kind: string,
  codes: { areaCode?: string | null; kindCode?: string | null } = {},
): Coast {
  return { name, kind, ...codes, maxHeight: null, firstHeight: null };
}
function obs(
  stationName: string,
  stationCode?: string | null,
): DisplayTsunamiObservationV1 {
  return {
    areaName: null,
    areaKind: null,
    ...(stationCode === undefined ? {} : { stationCode }),
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

  it("同じ code の名称変更では行キーを維持する", () => {
    const before = keyCoastRows([coast("旧名称", "警報", { areaCode: "210", kindCode: "51" })]);
    const after = keyCoastRows([coast("新名称", "津波警報", { areaCode: "210", kindCode: "51" })]);
    expect(before[0].key).toBe("code:210|51|0");
    expect(after[0].key).toBe(before[0].key);
  });

  it("同じ名称でも code が異なる行は分離する", () => {
    const rows = keyCoastRows([
      coast("同じ名称", "津波警報", { areaCode: "210", kindCode: "51" }),
      coast("同じ名称", "津波警報", { areaCode: "220", kindCode: "51" }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(["code:210|51|0", "code:220|51|0"]);
  });

  it("raw Kind.Code の前後空白を正規化せず、行・グループ identity を分離する", () => {
    const plain = coast("同じ名称", "同じ種別名", { areaCode: "210", kindCode: "53" });
    const spaced = coast("同じ名称", "同じ種別名", { areaCode: "210", kindCode: " 53 " });

    expect(keyCoastRows([plain, spaced]).map((r) => r.key)).toEqual([
      "code:210|53|0",
      "code:210| 53 |0",
    ]);
    expect([coastKindGroupKey(plain), coastKindGroupKey(spaced)]).toEqual([
      "kind-code:53",
      "kind-code: 53 ",
    ]);
  });

  it("code が欠落した旧 snapshot は名称キーへ fallback する", () => {
    expect(keyCoastRows([coast("岩手県", "警報")])[0].key).toBe("岩手県|警報|0");
    expect(keyCoastRows([coast("岩手県", "警報", { areaCode: "210" })])[0].key)
      .toBe("岩手県|警報|0");
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

  it("同じ stationCode の名称変更では行キーを維持する", () => {
    const before = keyObsRows([obs("旧名称", "21001")]);
    const after = keyObsRows([obs("新名称", "21001")]);
    expect(before[0].key).toBe("code:21001|0");
    expect(after[0].key).toBe(before[0].key);
  });

  it("同じ名称でも stationCode が異なる行は分離する", () => {
    const rows = keyObsRows([
      obs("同じ名称", "21001"),
      obs("同じ名称", "22001"),
    ]);
    expect(rows.map((r) => r.key)).toEqual(["code:21001|0", "code:22001|0"]);
  });

  it("同名別 code 行が増減しても残存行の ordinal を再割当しない", () => {
    const before = keyObsRows([obs("同じ名称", "22001")]);
    const expanded = keyObsRows([
      obs("同じ名称", "21001"),
      obs("同じ名称", "22001"),
    ]);
    const after = keyObsRows([obs("同じ名称", "22001")]);
    expect(expanded[1].key).toBe(before[0].key);
    expect(after[0].key).toBe(before[0].key);
    expect(after[0].key).toBe("code:22001|0");
  });

  it("stationCode が欠落した旧 snapshot は名称キーへ fallback する", () => {
    expect(keyObsRows([obs("石巻")])[0].key).toBe("石巻|0");
    expect(keyObsRows([obs("石巻", "  ")])[0].key).toBe("石巻|0");
  });
});
