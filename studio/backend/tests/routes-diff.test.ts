import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { diffRoute } from "../routes/diff";

function makeApp() {
  const app = new Hono();
  app.route("/api/diff", diffRoute());
  return app;
}

const BODY = {
  fixtureId: "15_17_01_251222_VPWW55.xml",
  themeOverride: { palette: { vermillion: "#FF00FF" } },
  options: { compact: false, width: 80, noColor: false, nightMode: false },
};

describe("POST /api/diff", () => {
  it("before/after/warnings を返す", async () => {
    const res = await makeApp().request("/api/diff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { before: string; after: string; warnings: string[] };
    expect(body.before.length).toBeGreaterThan(0);
    expect(body.after).toContain("255;0;255");
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it("Body 不正は 400、未対応 fixture は 400", async () => {
    const bad = await makeApp().request("/api/diff", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ fixtureId: 1 }),
    });
    expect(bad.status).toBe(400);
    const unsupported = await makeApp().request("/api/diff", {
      method: "POST", headers: { "content-type": "application/json" },
      // VPTW60 (台風解析・予報情報) は Phase 4b 時点でも registry 未登録
      body: JSON.stringify({ ...BODY, fixtureId: "10_04_03_170913_VPTW60.xml" }),
    });
    expect(unsupported.status).toBe(400);
  });
});
