import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import { Vpwp50DetailCache } from "../../../src/engine/messages/vpwp50-detail-cache";
import { handleDetail } from "../../../src/ui/repl-handlers/info-handlers";

chalk.level = 0;

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vpwp50-test-"));
}

function cleanupTmpRoot(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function makeMinimalInfo(): unknown {
  return {
    type: "VPWP50",
    infoType: "発表",
    title: "気象警報・注意報時系列情報",
    controlTitle: "気象警報・注意報時系列情報",
    reportDateTime: "2026-06-05T15:18:00+09:00",
    publishingOffice: "気象庁",
    editorialOffice: "気象庁",
    eventId: null,
    serial: null,
    headline: null,
    targetArea: { name: "長野県", code: "200000" },
    areas: [],
    maxKnownSignificancy: null,
    unknownCodes: [],
    fallback: "none",
    isTest: false,
  };
}

describe("Vpwp50DetailCache", () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    while (tmpRoots.length > 0) {
      const r = tmpRoots.pop();
      if (r != null) cleanupTmpRoot(r);
    }
  });

  it("初期状態は hasDetail()=false", () => {
    const root = makeTmpRoot();
    tmpRoots.push(root);
    const cache = new Vpwp50DetailCache({ persistRoot: root });
    expect(cache.hasDetail()).toBe(false);
    expect(cache.category).toBe("vpwp50");
  });

  it("rememberLatest 後は hasDetail()=true", () => {
    const root = makeTmpRoot();
    tmpRoots.push(root);
    const cache = new Vpwp50DetailCache({ persistRoot: root });
    cache.rememberLatest(makeMinimalInfo() as never);
    expect(cache.hasDetail()).toBe(true);
  });

  it("showDetail() は console.log を呼ぶ", () => {
    const root = makeTmpRoot();
    tmpRoots.push(root);
    const cache = new Vpwp50DetailCache({ persistRoot: root });
    cache.rememberLatest(makeMinimalInfo() as never);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    let called = false;
    try {
      cache.showDetail();
      called = spy.mock.calls.length > 0;
    } finally {
      spy.mockRestore();
    }
    expect(called).toBe(true);
  });
});

describe("Vpwp50DetailCache 永続化", () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    while (tmpRoots.length > 0) {
      const r = tmpRoots.pop();
      if (r != null) cleanupTmpRoot(r);
    }
  });

  it("rememberLatest 後、別インスタンスで復元できる", () => {
    const root = makeTmpRoot();
    tmpRoots.push(root);
    const cache1 = new Vpwp50DetailCache({ persistRoot: root });
    cache1.rememberLatest(makeMinimalInfo() as never);
    expect(cache1.hasDetail()).toBe(true);

    const cache2 = new Vpwp50DetailCache({ persistRoot: root });
    expect(cache2.hasDetail()).toBe(true);
  });

  it("破損 JSON は無視されて hasDetail()=false (load 失敗で例外を投げない)", () => {
    const root = makeTmpRoot();
    tmpRoots.push(root);
    const persistDir = path.join(root, "data", "runtime");
    fs.mkdirSync(persistDir, { recursive: true });
    fs.writeFileSync(
      path.join(persistDir, "vpwp50-latest.json"),
      "{ not valid json",
      "utf8",
    );
    const cache = new Vpwp50DetailCache({ persistRoot: root });
    expect(cache.hasDetail()).toBe(false);
  });

  it("entries[].severity が無効な値の persisted JSON を破棄 (Codex R4 #1)", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vpwp50-test-"));
    try {
      fs.mkdirSync(path.join(tmpRoot, "data/runtime"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "data/runtime/vpwp50-latest.json"),
        JSON.stringify({
          version: 2, // 現行 version (v1 は version ゲートで先に弾かれるため、severity 検証を通すには v2)
          savedAt: "2026-06-06T00:00:00.000Z",
          reportDateTime: "",
          targetArea: "長野県",
          entries: [
            {
              windows: [],
              areaName: "北部",
              code: "30",
              phenomenon: "大雨",
              kindLabel: "大雨警報",
              severity: "below", // 無効値 (WeatherSeverity に含まれない)
              displaySeverity: "nonLevelWarning",
              officialAlertLevel: null,
              resolutionSource: "map",
            },
          ],
          unknownCodes: [],
          infoType: "発表",
          frameLevel: "warning",
        }),
        "utf8",
      );
      const cache = new Vpwp50DetailCache({ persistRoot: tmpRoot });
      expect(cache.hasDetail()).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("version 不一致は破棄される", () => {
    const root = makeTmpRoot();
    tmpRoots.push(root);
    const persistDir = path.join(root, "data", "runtime");
    fs.mkdirSync(persistDir, { recursive: true });
    fs.writeFileSync(
      path.join(persistDir, "vpwp50-latest.json"),
      JSON.stringify({
        version: 999,
        savedAt: "2026-06-05T00:00:00Z",
        reportDateTime: "",
        targetArea: "長野県",
        entries: [],
        unknownCodes: [],
        infoType: "発表",
        frameLevel: "info",
      }),
      "utf8",
    );
    const cache = new Vpwp50DetailCache({ persistRoot: root });
    expect(cache.hasDetail()).toBe(false);
  });

  it("schema v1 (displaySeverity 欠落) は version ゲートで静かに破棄される — warn を出さない (Phase B)", () => {
    // v1 → v2 は予定された世代交代。構造検証より先に version ゲートで弾き、
    // log.warn ではなく log.debug (デフォルト LogLevel.INFO では沈黙) で破棄する
    const root = makeTmpRoot();
    tmpRoots.push(root);
    const persistDir = path.join(root, "data", "runtime");
    fs.mkdirSync(persistDir, { recursive: true });
    fs.writeFileSync(
      path.join(persistDir, "vpwp50-latest.json"),
      JSON.stringify({
        version: 1, // 旧バージョン (現在は 2)
        savedAt: "2026-06-05T00:00:00Z",
        reportDateTime: "",
        targetArea: "長野県",
        entries: [
          {
            windows: [],
            areaName: "北部",
            code: "30",
            phenomenon: "大雨",
            kindLabel: "大雨警報",
            severity: "warning",
            // displaySeverity / officialAlertLevel / resolutionSource なし (v1 形式)
          },
        ],
        unknownCodes: [],
        infoType: "発表",
        frameLevel: "warning",
      }),
      "utf8",
    );
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    let cache: Vpwp50DetailCache;
    try {
      cache = new Vpwp50DetailCache({ persistRoot: root });
    } finally {
      spy.mockRestore();
    }
    expect(cache.hasDetail()).toBe(false);
    // 世代交代は沈黙 (message-router 統合テストの「無視ルートは出力なし」を壊さない)
    expect(logs.join("\n")).toBe("");
  });

  it("現行 version (2) だが構造不正 (displaySeverity 無効値) → warn + 破棄 (Phase B)", () => {
    const root = makeTmpRoot();
    tmpRoots.push(root);
    const persistDir = path.join(root, "data", "runtime");
    fs.mkdirSync(persistDir, { recursive: true });
    fs.writeFileSync(
      path.join(persistDir, "vpwp50-latest.json"),
      JSON.stringify({
        version: 2,
        savedAt: "2026-06-06T00:00:00.000Z",
        reportDateTime: "",
        targetArea: "長野県",
        entries: [
          {
            windows: [],
            areaName: "北部",
            code: "30",
            phenomenon: "大雨",
            kindLabel: "大雨警報",
            severity: "warning",
            displaySeverity: "INVALID_VALUE", // 無効値
            officialAlertLevel: null,
            resolutionSource: "map",
          },
        ],
        unknownCodes: [],
        infoType: "発表",
        frameLevel: "warning",
      }),
      "utf8",
    );
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    let cache: Vpwp50DetailCache;
    try {
      cache = new Vpwp50DetailCache({ persistRoot: root });
    } finally {
      spy.mockRestore();
    }
    expect(cache.hasDetail()).toBe(false);
    // 現行 version で構造が壊れているのは異常 → warn に値する
    expect(logs.join("\n")).toContain("persist structure validation 失敗");
  });
});

describe("detail vpwp50 統合", () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    while (tmpRoots.length > 0) {
      const r = tmpRoots.pop();
      if (r != null) cleanupTmpRoot(r);
    }
  });

  it("handleDetail で 'vpwp50' が KNOWN カテゴリに含まれる", () => {
    const root = makeTmpRoot();
    tmpRoots.push(root);
    const cache = new Vpwp50DetailCache({ persistRoot: root });
    cache.rememberLatest(makeMinimalInfo() as never);
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s: unknown) => {
      logs.push(String(s));
    });
    handleDetail(
      {
        detailProviders: [cache],
      } as never,
      "vpwp50",
    );
    spy.mockRestore();
    expect(logs.join("\n")).toContain("長野県");
  });
});
