import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, RequestOptions } from "node:http";
import type { AddressInfo } from "node:net";
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

// P3-FRF-T05（P3-TO-AC13 (1)）: npm の 200 の本文が途中で切れても待ちを解き、GitHub の確かめへ進む（P3-FINAL-REVIEW-FIX-001）。
// 既定の https の GET を 127.0.0.1 の http へ向ける（npm・GitHub へは出ない）。ほかの試験は fetchJson を差し替えるので https を通らない。
const local = vi.hoisted(() => ({ port: 0 }));
vi.mock("node:https", async (importOriginal) => {
  const http = await import("node:http");
  return { ...await importOriginal<typeof import("node:https")>(),
    get: (url: string, options: RequestOptions, callback: (response: IncomingMessage) => void) => http.get(`http://127.0.0.1:${local.port}${new URL(url).pathname}`, options, callback) };
});
describe("P3-FRF-T05 update check の本文の途切れ", () => {
  it("regression / AC06: npm の 200 の本文が途中で切れると、GitHub の版で知らせる", async () => {
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/repos/") === true) { response.end(JSON.stringify({ tag_name: "v4.2.0" })); return; }
      response.writeHead(200, { "content-type": "application/json", "content-length": "100" });
      response.write("{\"version\":\"4.", () => response.socket?.destroy());
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    local.port = (server.address() as AddressInfo).port;
    try {
      // 直す前は本文の途切れで待ちが解けない（reject されず GitHub へも進まない）ので、2 秒で "pending" として落とす。
      const found = await Promise.race([checkForUpdate({ ...base, directory: directory(), env: {} }), new Promise((done) => { setTimeout(() => done("pending"), 2_000); })]);
      expect(found).toEqual({ current: "4.1.0", latest: "v4.2.0", packageName: "@sayue_ltr/fleq" });
    } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  });
});

// P4-TET2-T03（台帳 142）: 版は末尾まで semver の字だけのものに限り、後ろに字が続く版は知らせない（P4-TERMINAL-EXTERNAL-TEXT-002、P4-TET2-D-VERSION）。
describe("P4-TET2-T03 版の末尾", () => {
  it("regression / AC03: 1.2.3 と 1.3.0-beta.1 は知らせ、1.2.3 の後に ESC[2J・空白と字・BEL・CR・U+0085 が続く版と頭に TAB のある版は知らせない", async () => {
    const check = (latest: string) => checkForUpdate({ ...base, version: "1.0.0", directory: directory(), env: {}, fetchJson: async () => ({ version: latest }) });
    const bad = ["1.2.3\u001b[2J", "1.2.3 abc", "1.2.3\u0007", "\t1.2.3", "1.2.3\r", "1.2.3\u0085"];
    expect([await check("1.2.3"), await check("1.3.0-beta.1"), ...await Promise.all(bad.map(check))]).toEqual([{ current: "1.0.0", latest: "1.2.3", packageName: "@sayue_ltr/fleq" },
      { current: "1.0.0", latest: "1.3.0-beta.1", packageName: "@sayue_ltr/fleq" }, ...bad.map(() => null)]);
  });
});
