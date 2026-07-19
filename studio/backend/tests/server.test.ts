import { describe, it, expect } from "vitest";
import { buildApp } from "../server";

describe("server (buildApp)", () => {
  it("GET /api/health で {ok:true,phase:'1'} を返す", async () => {
    const app = buildApp();
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; phase: string };
    expect(body.ok).toBe(true);
    expect(body.phase).toBe("1");
  });

  it("GET /api/fixtures が接続されている", async () => {
    const app = buildApp();
    const res = await app.request("/api/fixtures");
    expect(res.status).toBe(200);
  });

  it("POST /api/render が接続されている (VPWW55)", async () => {
    const app = buildApp();
    const res = await app.request("/api/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fixtureId: "15_17_01_251222_VPWW55.xml",
        themeOverride: { palette: {}, roles: {} },
        options: { compact: false, width: 100, noColor: true, nightMode: false },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ansi: string };
    expect(body.ansi.length).toBeGreaterThan(0);
  });

  it("POST /api/diff が接続されている (VPWW55)", async () => {
    const app = buildApp();
    const res = await app.request("/api/diff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fixtureId: "15_17_01_251222_VPWW55.xml",
        themeOverride: { palette: {}, roles: {} },
        options: { compact: false, width: 80, noColor: true, nightMode: false },
      }),
    });
    expect(res.status).toBe(200);
  });
});
