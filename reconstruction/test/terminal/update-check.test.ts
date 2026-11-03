import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRenderer } from "../../src/terminal/format";
import { checkForUpdate } from "../../src/terminal/update-check";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const directory = () => { const path = mkdtempSync(join(tmpdir(), "fleq-update-")); directories.push(path); return path; };
const base = { packageName: "@sayue_ltr/fleq", version: "4.1.0", now: () => 1_000_000 };

describe("P3-TO-T14 update check（spec §6.5、AC13）", () => {
  it("npm が失敗し GitHub が新しい版を返すと日本語の 1 行、24 時間の内の 2 回目は確かめに出ない", async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes("registry.npmjs.org")) throw new Error("HTTP 503");
      return { tag_name: "v4.2.0" };
    });
    const dir = directory();
    const found = await checkForUpdate({ ...base, directory: dir, env: {}, fetchJson });
    expect(fetchJson.mock.calls.map(([url]) => url)).toEqual(["https://registry.npmjs.org/@sayue_ltr%2Ffleq/latest", "https://api.github.com/repos/Lateo2580/FlEq/releases/latest"]);
    if (found == null) throw new Error("no update found");
    expect(createRenderer(0).render({ columns: 80, dropped: 0, units: [{ kind: "notice", notice: { kind: "update", ...found }, prompt: null }] }))
      .toBe("新しい版があります: v4.1.0 → v4.2.0  npm install -g @sayue_ltr/fleq@latest\n");
    fetchJson.mockClear();
    expect(await checkForUpdate({ ...base, now: () => 1_000_000 + 23 * 3_600_000, directory: dir, env: {}, fetchJson })).toMatchObject({ latest: "v4.2.0" });
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("FLEQ_NO_UPDATE_CHECK=1 と FLEQ_WS_URL のある起動は確かめに出ない", async () => {
    const fetchJson = vi.fn(async () => ({ version: "9.0.0" }));
    for (const env of [{ FLEQ_NO_UPDATE_CHECK: "1" }, { FLEQ_WS_URL: "ws://127.0.0.1:1/" }]) {
      expect(await checkForUpdate({ ...base, directory: directory(), env, fetchJson })).toBeNull();
    }
    expect(fetchJson).not.toHaveBeenCalled();
  });
});
