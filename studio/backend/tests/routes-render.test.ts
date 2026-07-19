import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { renderRoute } from "../routes/render";

function makeApp() {
  const app = new Hono();
  app.route("/api/render", renderRoute());
  return app;
}

const DEFAULT_BODY = {
  fixtureId: "15_17_01_251222_VPWW55.xml",
  themeOverride: { palette: {}, roles: {} },
  options: { compact: false, width: 100, noColor: false, nightMode: false },
};

describe("POST /api/render", () => {
  it("VPWW55 を render して ANSI を返す", async () => {
    const app = makeApp();
    const res = await app.request("/api/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(DEFAULT_BODY),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ansi: string; warnings: string[]; durationMs: number };
    expect(body.ansi.length).toBeGreaterThan(0);
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(typeof body.durationMs).toBe("number");
  });

  it("未対応 fixture は 400 を返す", async () => {
    const app = makeApp();
    const res = await app.request("/api/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // VPTW60 (台風解析・予報情報) は Phase 4b 時点でも registry 未登録
      body: JSON.stringify({ ...DEFAULT_BODY, fixtureId: "10_04_03_170913_VPTW60.xml" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/未対応|unsupported/i);
  });

  it("Body が不正な JSON は 400 を返す", async () => {
    const app = makeApp();
    const res = await app.request("/api/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("必須フィールド欠落は 400 を返す", async () => {
    const app = makeApp();
    const res = await app.request("/api/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ themeOverride: {}, options: DEFAULT_BODY.options }),
    });
    expect(res.status).toBe(400);
  });

  it.each<[string, unknown]>([
    ["非数値 (文字列)", "100"],
    ["0", 0],
    ["負値", -5],
    ["過大値", 10000],
    ["非整数", 99.5],
  ])("width が不正 (%s) は 400 を返す", async (_label, width) => {
    const app = makeApp();
    const res = await app.request("/api/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...DEFAULT_BODY,
        options: { ...DEFAULT_BODY.options, width },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("themeOverride が配列は 400 を返す", async () => {
    const app = makeApp();
    const res = await app.request("/api/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...DEFAULT_BODY, themeOverride: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("compact: true は 200 で 1 行サマリーを返す (Phase 1d で対応)", async () => {
    const app = makeApp();
    const res = await app.request("/api/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...DEFAULT_BODY,
        options: { ...DEFAULT_BODY.options, compact: true, noColor: true },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ansi: string };
    expect(body.ansi.trimEnd()).not.toContain("\n");
  });
});
