import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyMock } from "../setup";
import { testTelegramMeta } from "../helpers/telegram-meta";
import type { ParsedLegacyCounterpartInfo } from "../../src/types";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFile: execFileMock,
}));

// 既定の notify 設定では weather が無効で send まで届かないため、weather を有効にする
vi.mock("../../src/config", () => ({ loadConfig: vi.fn(() => ({ notify: { weather: true } })), saveConfig: vi.fn() }));

import { Notifier } from "../../src/engine/notification/notifier";

// 受入条件: Apple silicon でも通知が出るよう、darwin は node-notifier でなく osascript を argv 渡しで呼ぶ
describe("Notifier darwin", () => {
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  });

  it("osascript を argv で呼び、node-notifier を呼ばない", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const info: ParsedLegacyCounterpartInfo = {
      type: "VXWW50",
      infoType: "訂正",
      title: "旧形式情報",
      controlTitle: "旧形式情報",
      reportDateTime: "2026-08-11T09:00:00+09:00",
      headline: "訂正見出し",
      publishingOffice: "気象庁",
      editorialOffice: "気象庁",
      eventId: "LEGACY-2",
      serial: "2",
      areas: [],
      phenomena: [],
      kinds: [],
      severityEvidence: [],
      meta: testTelegramMeta(false),
      isTest: false,
    };
    expect(new Notifier().notifyLegacyCounterpart(info, true)).toBe(true);
    const [cmd, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("/usr/bin/osascript");
    const rest = args.slice(args.indexOf("--") + 1);
    expect(rest).toHaveLength(2);
    expect(rest[0]).toContain("[訂正]");
    expect(rest[1]).toContain("訂正:");
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
