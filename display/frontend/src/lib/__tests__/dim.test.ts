import { describe, expect, it } from "vitest";
import { createDimStore } from "../dim.svelte";

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => data.clear(),
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    get length() {
      return data.size;
    },
  };
}

describe("createDimStore", () => {
  it("⑤ 初期値は false (storage 未設定)", () => {
    const store = createDimStore(fakeStorage());
    expect(store.requested).toBe(false);
  });

  it("⑥ toggle で true になり storage に書かれる", () => {
    const storage = fakeStorage();
    const store = createDimStore(storage);
    store.toggle();
    expect(store.requested).toBe(true);
    expect(storage.getItem("fleq-display-dim")).toBe("1");
  });

  it("⑦ storage 既存値 \"1\" なら初期 true", () => {
    const store = createDimStore(fakeStorage({ "fleq-display-dim": "1" }));
    expect(store.requested).toBe(true);
  });
});
