import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, vi } from "vitest";
import { resetDisplayLayoutForTest } from "../src/ui/display-layout";
import { cleanupStaleTestSandboxes } from "./helpers/test-sandbox-owner";

// vi.hoisted はテストファイルの mock と静的 import より前に評価される。
// config.ts が legacy path を探索しないよう、ここで checkout 内の config を先に作る。
const testEnvironment = vi.hoisted(() => {
  const nodeFs = require("node:fs") as typeof import("node:fs");
  const nodePath = require("node:path") as typeof import("node:path");
  const originalAppData = process.env.APPDATA;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const isolatedAppData = nodeFs.mkdtempSync(
    nodePath.join(process.cwd(), `.vitest-appdata-${process.pid}-`),
  );
  process.env.APPDATA = isolatedAppData;
  process.env.XDG_CONFIG_HOME = isolatedAppData;
  const isolatedConfigDir = nodePath.join(isolatedAppData, "fleq");
  nodeFs.mkdirSync(isolatedConfigDir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(isolatedConfigDir, "config.json"), "{}\n", "utf8");
  return { originalAppData, originalXdgConfigHome, isolatedAppData };
});

const { originalAppData, originalXdgConfigHome, isolatedAppData } = testEnvironment;

// 強制終了で残った checkout 内の sandbox だけを掃除する。
// owner PID が生存中の directory は、作成時刻にかかわらず別 worker の現役領域として保護する。
cleanupStaleTestSandboxes(process.cwd());

/**
 * notifyMock を vi.hoisted() で定義し、vi.mock ファクトリ内で参照可能にする。
 * vi.mock はファイル先頭にホイストされるため、通常の const 宣言は
 * ファクトリ実行時点で未初期化になる。vi.hoisted() で回避する。
 */
const { notifyMock } = vi.hoisted(() => ({
  notifyMock: vi.fn(),
}));

/**
 * node-notifier を直接モック (フォールバック安全策)
 */
vi.mock("node-notifier", () => ({
  default: { notify: notifyMock },
  notify: notifyMock,
}));

/**
 * node-notifier-loader モジュール自体をモックし、
 * loadNodeNotifier() が常にモック通知オブジェクトを返すようにする。
 * これにより、Notifier クラスが実際の node-notifier を require() する
 * パスを完全に遮断する。
 */
vi.mock("../src/engine/notification/node-notifier-loader", () => ({
  loadNodeNotifier: () => ({ notify: notifyMock }),
  setNodeNotifierOverride: vi.fn(),
}));

/**
 * playSound をグローバルにモックし、通知経路を素通しするテスト
 * (router → dispatchNotify → Notifier) が実行環境で実際に音を再生する
 * パスを遮断する (2026-07-31: sound-player を個別モックしない新規テストが
 * npm test 中に critical.mp3 を実再生した事故の恒久対策)。
 * playSound 以外の export (SOUND_LEVELS 等) は実装のまま残す。
 * sound-player 自身の unit test は vi.unmock で本物に戻す。
 */
vi.mock("../src/engine/notification/sound-player", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/engine/notification/sound-player")>();
  return { ...actual, playSound: vi.fn() };
});

export { notifyMock };

beforeEach(() => {
  notifyMock.mockClear();
  resetDisplayLayoutForTest();  // layout singleton の順序依存・外部 config 汚染を防ぐ
});

afterAll(() => {
  if (originalAppData == null) {
    delete process.env.APPDATA;
  } else {
    process.env.APPDATA = originalAppData;
  }

  if (originalXdgConfigHome == null) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }

  fs.rmSync(isolatedAppData, { recursive: true, force: true });
});
