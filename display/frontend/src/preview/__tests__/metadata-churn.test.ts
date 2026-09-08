/**
 * preview 限定 churn ハーネスの契約
 * (Issue #15 第 1 便 spec §3.4・分岐 5 A・§5.1、第 2 便 spec
 *  `docs/specs/2026-09-08-standby-resettle-residual-load.md` §3.0 段階 0)。
 *
 * 守るのは三点。
 *  1. 既定無効 — パラメータ非指定・不正値では preview の挙動が現行と完全に一致する
 *  2. reparse モードが本番形状 (SSE の JSON.parse、connection.svelte.ts:84) と同じく入れ子まで新オブジェクトを作る
 *  3. production 経路への非流出 — `src/main.ts` から静的 import で到達する全モジュールに
 *     ハーネスの名前が一切現れない (受入条件 A13)
 */
import { afterEach, describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/svelte";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  applyContentChurn,
  applyMetadataChurn,
  parseChurnProbeFlag,
  parseContentChurnMs,
  parseMetadataChurnMode,
  parseMetadataChurnMs,
  reparseSnapshot,
} from "../metadata-churn";
import { legacyStandbyGateSnapshot } from "../fixtures";
import PreviewApp from "../PreviewApp.svelte";
import { standbyLayoutKey } from "../../lib/legacy-standby/layout-key";
import type { DisplayStateSnapshotV1 } from "../../lib/protocol";

/** 計測に使う実 URL と同じ引数で fixture を作る (PreviewApp.svelte:438 の 2 引数呼び出しに揃える)。 */
const GATE_SCENARIO = "max";
const GATE_FIXTURE = undefined;
function gateBaseSnapshot(): DisplayStateSnapshotV1 {
  return legacyStandbyGateSnapshot(GATE_SCENARIO, GATE_FIXTURE);
}

/**
 * StandbyScreen の `standbyContentIdentity` (StandbyScreen.svelte:2059-2070) の部分集合。
 * 全 kind の分岐が `${kind}:${updatedAt}` を先頭に持つので、ここで差が出れば本体の identity にも
 * 必ず差が出る。テストのためだけに本体の分岐を複製しない。
 */
function contentIdentitySubset(snapshot: DisplayStateSnapshotV1): string {
  return snapshot.standbyItems?.map((item) => `${item.kind}:${item.updatedAt}`).join(",") ?? "";
}

/** 入力 effect (StandbyScreen.svelte:2074) が epoch を開くかどうかを決めるキー。 */
function epochInput(snapshot: DisplayStateSnapshotV1): string {
  return standbyLayoutKey(snapshot, contentIdentitySubset(snapshot));
}

describe("parseMetadataChurnMs", () => {
  it("パラメータ非指定・不正値は無効 (既定無効)", () => {
    for (const raw of [null, undefined, "", " ", "abc", "0", "-1", "1.5", "500ms", "1e3", " 500"]) {
      expect(parseMetadataChurnMs(raw), `${String(raw)} must be disabled`).toBeNull();
    }
  });

  it("正整数のときだけ churn 間隔として有効になる", () => {
    expect(parseMetadataChurnMs("1")).toBe(1);
    expect(parseMetadataChurnMs("500")).toBe(500);
    expect(parseMetadataChurnMs("60000")).toBe(60_000);
  });
});

describe("parseContentChurnMs", () => {
  it("metadataChurnMs と同じ規則で既定無効になる", () => {
    for (const raw of [null, undefined, "", " ", "abc", "0", "-1", "1.5", "500ms", "1e3", " 500"]) {
      expect(parseContentChurnMs(raw), `${String(raw)} must be disabled`).toBeNull();
    }
    expect(parseContentChurnMs("1")).toBe(1);
    expect(parseContentChurnMs("2000")).toBe(2000);
  });
});

describe("parseMetadataChurnMode", () => {
  it("非指定・不正値は shared (現行と完全に同一の参照共有 churn)", () => {
    for (const raw of [null, undefined, "", "shared", "Reparse", "REPARSE", "deep", "1"]) {
      expect(parseMetadataChurnMode(raw), `${String(raw)} must fall back to shared`).toBe("shared");
    }
  });

  it("reparse のときだけ本番形状モードになる", () => {
    expect(parseMetadataChurnMode("reparse")).toBe("reparse");
  });
});

describe("parseChurnProbeFlag", () => {
  it("非指定・不正値は false (観測 overhead を既定で載せない)", () => {
    for (const raw of [null, undefined, "", "0", "false", "yes", "on"]) {
      expect(parseChurnProbeFlag(raw), `${String(raw)} must be off`).toBe(false);
    }
  });

  it("1 / true のときだけ観測点が有効になる", () => {
    expect(parseChurnProbeFlag("1")).toBe(true);
    expect(parseChurnProbeFlag("true")).toBe(true);
  });
});

describe("applyMetadataChurn (shared モード = 現行動作)", () => {
  const base = gateBaseSnapshot();

  it("generatedAt と seq だけを書き換え、入れ子は同一参照のまま流す", () => {
    const churned = applyMetadataChurn(base, { tick: 3, generatedAt: "2026-09-08T12:00:00.000Z" });
    expect(churned.generatedAt).toBe("2026-09-08T12:00:00.000Z");
    expect(churned.seq).toBe(base.seq + 3);
    expect(churned).not.toBe(base);
    // 入れ子の参照共有こそが「現行ハーネスは本番より軽い」の実体 (spec §1.2)
    expect(churned.standbyItems).toBe(base.standbyItems);
    expect(churned.recentQuakes).toBe(base.recentQuakes);
    expect(churned.weatherAlerts).toBe(base.weatherAlerts);
    expect(churned.connection).toBe(base.connection);
  });

  it("base を書き換えない", () => {
    const before = JSON.stringify(base);
    applyMetadataChurn(base, { tick: 1, generatedAt: "2026-09-08T12:00:01.000Z" });
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe("reparseSnapshot (本番形状 = SSE の JSON.parse 相当)", () => {
  const base = gateBaseSnapshot();

  it("入れ子まで新オブジェクトになり、参照等価での打ち切りが起きない", () => {
    const reparsed = reparseSnapshot(base);
    expect(reparsed).not.toBe(base);
    expect(reparsed.standbyItems).not.toBe(base.standbyItems);
    expect(reparsed.recentQuakes).not.toBe(base.recentQuakes);
    expect(reparsed.weatherAlerts).not.toBe(base.weatherAlerts);
    expect(reparsed.connection).not.toBe(base.connection);
    const items = reparsed.standbyItems ?? [];
    const baseItems = base.standbyItems ?? [];
    expect(items.length).toBeGreaterThan(0);
    for (const [index, item] of items.entries()) {
      expect(item, `standbyItems[${index}] must be a fresh object`).not.toBe(baseItems[index]);
      expect(item.data, `standbyItems[${index}].data must be fresh`).not.toBe(baseItems[index]?.data);
    }
  });

  it("値としては元と同一 (見た目が変わらないことが churn の前提)", () => {
    expect(reparseSnapshot(base)).toEqual(JSON.parse(JSON.stringify(base)) as DisplayStateSnapshotV1);
  });

  it("shared churn の結果を reparse しても内容は一致する", () => {
    const churned = applyMetadataChurn(base, { tick: 2, generatedAt: "2026-09-08T12:00:02.000Z" });
    expect(reparseSnapshot(churned)).toEqual(JSON.parse(JSON.stringify(churned)) as DisplayStateSnapshotV1);
  });
});

describe("applyContentChurn (実電文相当の内容変化)", () => {
  const base = gateBaseSnapshot();

  it("gate max fixture で epoch 入力キーが tick ごとに変わる", () => {
    const keys = [0, 1, 2, 3, 4].map((tick) =>
      epochInput(applyContentChurn(base, { tick, generatedAt: `2026-09-08T12:00:0${tick}.000Z` })),
    );
    expect(new Set(keys).size).toBe(keys.length);
    // base とも必ず異なる (最初の churn でも epoch が開く)
    expect(keys).not.toContain(epochInput(base));
  });

  it("standbyItems の 1 枚だけが更新される (1 通の電文に相当)", () => {
    const churned = applyContentChurn(base, { tick: 0, generatedAt: "2026-09-08T12:00:00.000Z" });
    const baseItems = base.standbyItems ?? [];
    const items = churned.standbyItems ?? [];
    expect(items.length).toBe(baseItems.length);
    const changed = items.filter((item, index) => item.updatedAt !== baseItems[index]?.updatedAt);
    expect(changed.length).toBe(1);
    expect(changed[0]?.updatedAt).toBe("2026-09-08T12:00:00.000Z");
  });

  it("recentQuakes が回転して履歴カードの内容も動く", () => {
    expect(base.recentQuakes.length).toBeGreaterThanOrEqual(2);
    const churned = applyContentChurn(base, { tick: 0, generatedAt: "2026-09-08T12:00:00.000Z" });
    expect(churned.recentQuakes).not.toEqual(base.recentQuakes);
    expect(churned.recentQuakes.length).toBe(base.recentQuakes.length);
    // 並べ替えただけで集合としては同一 (fixture を作り替えない)
    expect([...churned.recentQuakes].map((q) => q.eventId).sort())
      .toEqual([...base.recentQuakes].map((q) => q.eventId).sort());
  });

  it("standbyItems / recentQuakes が無い snapshot でも落ちない", () => {
    const bare: DisplayStateSnapshotV1 = { ...base, standbyItems: undefined, recentQuakes: [] };
    const churned = applyContentChurn(bare, { tick: 1, generatedAt: "2026-09-08T12:00:01.000Z" });
    expect(churned.standbyItems).toBeUndefined();
    expect(churned.recentQuakes).toEqual([]);
    expect(churned.generatedAt).toBe("2026-09-08T12:00:01.000Z");
  });

  it("base を書き換えない", () => {
    const before = JSON.stringify(base);
    applyContentChurn(base, { tick: 7, generatedAt: "2026-09-08T12:00:07.000Z" });
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe("preview への配線 (既定無効の実 DOM 確認)", () => {
  const GATE_HASH = "#legacy-standby-gate";

  /**
   * `hash` を渡すと `#legacy-standby-gate` の実ゲート画面 (59 カード) で mount する。
   * PreviewApp は `currentHash === "#legacy-standby-gate"` でだけ `legacyStandbyGateSnapshot` を
   * 描くので (PreviewApp.svelte:253,438)、hash 無しだと quietSnapshot になり計測条件と違ってしまう。
   */
  function mountPreview(search: string, hash = ""): HTMLElement {
    const query = search === "" ? "/" : `/?${search}`;
    window.history.replaceState({}, "", `${query}${hash}`);
    const { container } = render(PreviewApp);
    const main = container.querySelector("main.preview-screen");
    if (!(main instanceof HTMLElement)) throw new Error("preview root not rendered");
    return main;
  }

  const CHURN_ATTRS = [
    "data-churn-mode",
    "data-churn-metadata-ms",
    "data-churn-metadata-tick",
    "data-churn-content-ms",
    "data-churn-content-tick",
    "data-churn-shelf-mutations",
    "data-churn-root-attr-mutations",
    "data-churn-live-mutations",
  ] as const;

  afterEach(() => {
    window.history.replaceState({}, "", "/");
    delete window.__fleqChurnProbe;
  });

  it("パラメータ非指定なら churn 属性も probe も出ない (現行 DOM と一致)", () => {
    const main = mountPreview("");
    for (const attr of CHURN_ATTRS) {
      expect(main.hasAttribute(attr), `${attr} must be absent by default`).toBe(false);
    }
    expect(window.__fleqChurnProbe).toBeUndefined();
  });

  it("metadataChurnMs 指定で mode と tick が読める (既定 shared)", () => {
    const main = mountPreview("metadataChurnMs=500");
    expect(main.getAttribute("data-churn-mode")).toBe("shared");
    expect(main.getAttribute("data-churn-metadata-ms")).toBe("500");
    expect(main.getAttribute("data-churn-metadata-tick")).toBe("0");
    expect(main.hasAttribute("data-churn-content-ms")).toBe(false);
    // probe 未指定なので観測カウンタは出さない (計測に overhead を載せない)
    expect(main.hasAttribute("data-churn-shelf-mutations")).toBe(false);
    expect(typeof window.__fleqChurnProbe).toBe("function");
    expect(window.__fleqChurnProbe?.()).toMatchObject({ mode: "shared", metadataChurnMs: 500, probe: 0 });
  });

  it("metadataChurnMode=reparse と contentChurnMs と churnProbe が同時に読める", () => {
    const main = mountPreview("metadataChurnMs=500&metadataChurnMode=reparse&contentChurnMs=2000&churnProbe=1");
    expect(main.getAttribute("data-churn-mode")).toBe("reparse");
    expect(main.getAttribute("data-churn-content-ms")).toBe("2000");
    expect(main.getAttribute("data-churn-content-tick")).toBe("0");
    for (const attr of ["data-churn-shelf-mutations", "data-churn-root-attr-mutations", "data-churn-live-mutations"]) {
      expect(main.getAttribute(attr), `${attr} must be a counter`).toBe("0");
    }
  });

  /** ゲート画面 (59 カード) が実際に描かれていることを、計測シェルフの中身で確かめる。 */
  function expectGateRendered(main: HTMLElement): Element {
    const shelf = main.querySelector(".measure-shelf");
    expect(shelf).toBeTruthy();
    expect(shelf?.children.length ?? 0).toBeGreaterThan(0);
    const standby = main.querySelector(".standby");
    expect(standby).toBeTruthy();
    if (standby == null) throw new Error("standby root not rendered");
    return standby;
  }

  it("contentChurn が実際に StandbyScreen の epoch を開く", async () => {
    const main = mountPreview(`gateScenario=${GATE_SCENARIO}&contentChurnMs=30`, GATE_HASH);
    const standby = expectGateRendered(main);
    const firstEpoch = standby.getAttribute("data-measurement-epoch") ?? "";
    await waitFor(
      () => {
        expect(standby.getAttribute("data-measurement-epoch")).not.toBe(firstEpoch);
      },
      { timeout: 4000 },
    );
    expect(Number(main.getAttribute("data-churn-content-tick"))).toBeGreaterThan(0);
  });

  it("metadataChurn だけでは epoch を開かない (第 1 便の回帰)", async () => {
    const main = mountPreview(`gateScenario=${GATE_SCENARIO}&metadataChurnMs=30&metadataChurnMode=reparse`, GATE_HASH);
    const standby = expectGateRendered(main);
    const firstEpoch = standby.getAttribute("data-measurement-epoch") ?? "";
    await waitFor(
      () => {
        expect(Number(main.getAttribute("data-churn-metadata-tick"))).toBeGreaterThanOrEqual(3);
      },
      { timeout: 4000 },
    );
    expect(standby.getAttribute("data-measurement-epoch")).toBe(firstEpoch);
  });
});

describe("production 経路への非流出 (A13)", () => {
  const HARNESS_TOKENS = ["metadataChurn", "metadata-churn", "contentChurn", "churnProbe"] as const;
  // Vite は `new URL("<文字列リテラル>", import.meta.url)` を静的にアセット URL へ書き換えるので、
  // リテラルを直接渡すと file: ではなく http://localhost:3000/... が返る。変数経由なら変換されない。
  const srcRootSpecifier = "../../";
  const srcRoot = fileURLToPath(new URL(srcRootSpecifier, import.meta.url));

  function resolveSpecifier(fromDir: string, specifier: string): string | null {
    const target = resolve(fromDir, specifier);
    const candidates = [
      target,
      `${target}.ts`,
      `${target}.svelte`,
      `${target}.svelte.ts`,
      `${target}.js`,
      resolve(target, "index.ts"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
  }

  /**
   * `src/main.ts` から到達する自プロジェクトのファイルを全部集める。
   * 拾うのは `from "..."` / `import("...")` / 副作用 import (`import "./theme.css"` の形) の 3 種。
   */
  const IMPORT_SPECIFIER = /from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

  function reachableFromProduction(): string[] {
    const seen = new Set<string>();
    const queue = [resolve(srcRoot, "main.ts")];
    while (queue.length > 0) {
      const file = queue.pop();
      if (file == null || seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      const specifiers = [...source.matchAll(IMPORT_SPECIFIER)]
        .map((match) => match[1] ?? match[2] ?? match[3])
        .filter((value): value is string => value != null && value.startsWith("."));
      for (const specifier of specifiers) {
        const resolved = resolveSpecifier(dirname(file), specifier);
        if (resolved != null) queue.push(resolved);
      }
    }
    return [...seen];
  }

  const productionFiles = reachableFromProduction();

  it("import graph が実際に辿れている (探索の空振り防止)", () => {
    expect(productionFiles.length).toBeGreaterThan(20);
    expect(productionFiles.some((file) => file.endsWith("App.svelte"))).toBe(true);
    expect(productionFiles.some((file) => file.endsWith("StandbyScreen.svelte"))).toBe(true);
    expect(productionFiles.some((file) => file.includes(`${"/"}preview${"/"}`))).toBe(false);
  });

  it("production パスのどのモジュールも churn ハーネスを参照しない", () => {
    const offenders: string[] = [];
    for (const file of productionFiles) {
      const source = readFileSync(file, "utf8");
      for (const token of HARNESS_TOKENS) {
        if (source.includes(token)) offenders.push(`${file.slice(srcRoot.length)}: ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
