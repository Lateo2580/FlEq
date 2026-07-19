import { describe, expect, it } from "vitest";
import { createDimStore } from "../dim.svelte";

function memoryStorage(overrides?: Partial<Storage>): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
    ...overrides,
  } as Storage;
}

describe("createDimStore", () => {
  it("初期値は storage の '1' で true、それ以外は false", () => {
    const s = memoryStorage();
    s.setItem("fleq-display-dim", "1");
    expect(createDimStore(s).requested).toBe(true);
    expect(createDimStore(memoryStorage()).requested).toBe(false);
  });
  it("toggle で反転し storage に永続化される", () => {
    const s = memoryStorage();
    const store = createDimStore(s);
    store.toggle();
    expect(store.requested).toBe(true);
    expect(s.getItem("fleq-display-dim")).toBe("1");
  });
  it("getItem が throw したら既定 false で起動する (明るい側へ倒す)", () => {
    const s = memoryStorage({ getItem: () => { throw new Error("denied"); } });
    expect(createDimStore(s).requested).toBe(false);
  });
  it("setItem が throw してもセッション内の手動意思は維持される", () => {
    const s = memoryStorage({ setItem: () => { throw new Error("quota"); } });
    const store = createDimStore(s);
    store.toggle();
    expect(store.requested).toBe(true); // 永続化失敗が操作の取り消しにならない (spec D5)
  });
});
