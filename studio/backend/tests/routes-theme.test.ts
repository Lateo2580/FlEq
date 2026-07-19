import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { Hono } from "hono";
import { themeRoute } from "../routes/theme";
import { getThemePath, getRoleNames, getPaletteNames, loadTheme } from "../../../src/ui/theme";

function makeApp() {
  const app = new Hono();
  app.route("/api/theme", themeRoute());
  return app;
}

// setup.ts が XDG_CONFIG_HOME を tmp に隔離しているため、
// getThemePath() はテスト専用ディレクトリを指す (実環境の theme.json には触れない)
function writeUserTheme(content: string): void {
  const p = getThemePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

afterEach(() => {
  try { fs.unlinkSync(getThemePath()); } catch { /* none */ }
  try { fs.unlinkSync(getThemePath() + ".bak"); } catch { /* none */ }
  loadTheme(); // singleton をファイル状態に同期 (ファイル無し → デフォルト)
});

describe("GET /api/theme", () => {
  it("カタログ (paletteNames/roleNames/categories/defaults) を返す", async () => {
    const res = await makeApp().request("/api/theme");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      paletteNames: string[];
      roleNames: string[];
      categories: Array<{ label: string; roles: string[] }>;
      defaults: { palette: Record<string, string>; roles: Record<string, unknown> };
      saved: unknown;
      warnings: string[];
    };
    expect(body.paletteNames).toEqual([...getPaletteNames()]);
    expect(body.roleNames).toEqual([...getRoleNames()]);
    expect(body.categories.length).toBeGreaterThanOrEqual(5);
    expect(body.defaults.palette.vermillion).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(Object.keys(body.defaults.roles).length).toBe(getRoleNames().length);
    expect(body.saved).toBeNull(); // theme.json 無し
    expect(body.warnings).toEqual([]);
  });

  it("theme.json がある場合は saved に raw 内容が入る", async () => {
    writeUserTheme(JSON.stringify({ palette: { vermillion: "#FF00FF" } }));
    const res = await makeApp().request("/api/theme");
    const body = await res.json() as { saved: { palette?: Record<string, string> } | null };
    expect(body.saved).not.toBeNull();
    expect(body.saved!.palette!.vermillion).toBe("#FF00FF");
  });

  it("不正な theme.json は saved: null + warnings で返す (500 にしない)", async () => {
    writeUserTheme("{ broken");
    const res = await makeApp().request("/api/theme");
    expect(res.status).toBe(200);
    const body = await res.json() as { saved: unknown; warnings: string[] };
    expect(body.saved).toBeNull();
    expect(body.warnings.length).toBeGreaterThan(0);
  });

  it("不正 HEX を含む有効 JSON の theme.json は saved + warnings の両方が返る (レビュー反映)", async () => {
    writeUserTheme(JSON.stringify({ palette: { vermillion: "not-a-hex" } }));
    const res = await makeApp().request("/api/theme");
    const body = await res.json() as { saved: unknown; warnings: string[] };
    expect(body.saved).not.toBeNull();
    expect(body.warnings.some((w) => w.includes("vermillion"))).toBe(true);
  });

  it("palette が非オブジェクトの theme.json は saved: null + warnings (レビュー反映)", async () => {
    writeUserTheme(JSON.stringify({ palette: "x" }));
    const res = await makeApp().request("/api/theme");
    const body = await res.json() as { saved: unknown; warnings: string[] };
    expect(body.saved).toBeNull();
    expect(body.warnings.length).toBeGreaterThan(0);
  });
});

describe("POST /api/theme/save", () => {
  const SAVE_BODY = { theme: { palette: { vermillion: "#FF00FF" } } };

  function postSave(body: unknown) {
    return makeApp().request("/api/theme/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("theme.json が無い状態の save: 新規書込 + .bak は作らない", async () => {
    const res = await postSave(SAVE_BODY);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; warnings: string[] };
    expect(body.ok).toBe(true);
    const written = JSON.parse(fs.readFileSync(getThemePath(), "utf-8")) as { palette: Record<string, string> };
    expect(written.palette.vermillion).toBe("#FF00FF");
    expect(fs.existsSync(getThemePath() + ".bak")).toBe(false);
  });

  it("既存 theme.json がある save: .bak に旧内容が退避される", async () => {
    writeUserTheme(JSON.stringify({ palette: { sky: "#111111" } }));
    const res = await postSave(SAVE_BODY);
    expect(res.status).toBe(200);
    const bak = JSON.parse(fs.readFileSync(getThemePath() + ".bak", "utf-8")) as { palette: Record<string, string> };
    expect(bak.palette.sky).toBe("#111111");
    const written = JSON.parse(fs.readFileSync(getThemePath(), "utf-8")) as { palette: Record<string, string> };
    expect(written.palette.vermillion).toBe("#FF00FF");
  });

  it("不正 HEX を含む theme は保存されるが warnings が返る (spec: 警告つき継続)", async () => {
    const res = await postSave({ theme: { palette: { vermillion: "not-a-hex" } } });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; warnings: string[] };
    expect(body.ok).toBe(true);
    expect(body.warnings.some((w) => w.includes("vermillion"))).toBe(true);
  });

  it("theme フィールド欠落 / 非オブジェクトは 400", async () => {
    expect((await postSave({})).status).toBe(400);
    expect((await postSave({ theme: "x" })).status).toBe(400);
    expect((await postSave({ theme: [] })).status).toBe(400);
  });

  it("型として壊れた値は 400 (palette 値が数値 / role 定義の未知キー・型不正)", async () => {
    expect((await postSave({ theme: { palette: { vermillion: 42 } } })).status).toBe(400);
    expect((await postSave({ theme: { roles: { frameCritical: { fg: "#ffffff", evil: true } } } })).status).toBe(400);
    expect((await postSave({ theme: { roles: { frameCritical: { bold: "yes" } } } })).status).toBe(400);
    expect((await postSave({ theme: { roles: { frameCritical: 42 } } })).status).toBe(400);
  });

  it("palette/roles 以外の未知キーは保存されない (正規化)", async () => {
    const res = await postSave({ theme: { palette: { vermillion: "#FF00FF" }, garbage: { a: 1 } } });
    expect(res.status).toBe(200);
    const written = JSON.parse(fs.readFileSync(getThemePath(), "utf-8")) as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(["palette", "roles"]);
  });

  it("save 後に .tmp が残らない (tmp+rename 書込)", async () => {
    const res = await postSave(SAVE_BODY);
    expect(res.status).toBe(200);
    expect(fs.existsSync(getThemePath() + ".tmp")).toBe(false);
    expect(fs.existsSync(getThemePath())).toBe(true);
  });

  it("save 後に studio プロセスの theme singleton が保存内容に追従する", async () => {
    await postSave(SAVE_BODY);
    const { getRole } = await import("../../../src/ui/theme");
    expect(getRole("frameCritical").fg).toEqual([0xff, 0x00, 0xff]); // vermillion 上書きが効く
  });
});
