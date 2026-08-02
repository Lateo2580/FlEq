import fs from "node:fs";
import path from "node:path";

const TEST_SANDBOX_NAME = /^\.(?:vitest-appdata|phase4a-contract)-(\d+)-/;

type ProcessProbe = (pid: number) => void;

export function testSandboxOwnerPid(name: string): number | null {
  const match = TEST_SANDBOX_NAME.exec(name);
  if (match == null) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function isProcessAlive(
  pid: number,
  probe: ProcessProbe = (candidatePid) => process.kill(candidatePid, 0),
): boolean {
  try {
    probe(pid);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error != null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    // ESRCH だけを死亡とみなす。EPERM や未知の probe failure は現役扱いで保護する。
    return code !== "ESRCH";
  }
}

export function cleanupStaleTestSandboxes(root: string): void {
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const ownerPid = testSandboxOwnerPid(entry.name);
      if (ownerPid == null || isProcessAlive(ownerPid)) continue;
      try {
        fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
      } catch {
        // best-effort: OS による競合や権限エラーは test 起動を妨げない。
      }
    }
  } catch {
    // best-effort: checkout 列挙に失敗しても通常の隔離 setup は続行する。
  }
}
