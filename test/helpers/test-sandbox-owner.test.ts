import { describe, expect, it, vi } from "vitest";
import { isProcessAlive, testSandboxOwnerPid } from "./test-sandbox-owner";

describe("test sandbox owner", () => {
  it.each([
    [`.vitest-appdata-${process.pid}-abc`, process.pid],
    [`.phase4a-contract-${process.pid}-xyz`, process.pid],
    [".vitest-appdata-legacy", null],
    [".phase4a-contract-0-invalid", null],
    ["unrelated", null],
  ])("directory 名 %s から owner PID を安全に読む", (name, expected) => {
    expect(testSandboxOwnerPid(name)).toBe(expected);
  });

  it("probe 成功時は現役 PID と判定する", () => {
    const probe = vi.fn();
    expect(isProcessAlive(123, probe)).toBe(true);
    expect(probe).toHaveBeenCalledWith(123);
  });

  it("ESRCH のみ死亡 PID と判定する", () => {
    expect(isProcessAlive(123, () => {
      throw Object.assign(new Error("missing"), { code: "ESRCH" });
    })).toBe(false);
  });

  it.each(["EPERM", "UNKNOWN"])("%s probe failure は現役扱いで保護する", (code) => {
    expect(isProcessAlive(123, () => {
      throw Object.assign(new Error("probe failed"), { code });
    })).toBe(true);
  });
});
