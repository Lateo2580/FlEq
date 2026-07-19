import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchFixtures, renderFixture, getTheme, saveTheme, fetchDisplayReference, renderDiff } from "./api";

function mockFetchOnce(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api client", () => {
  it("fetchFixtures は /api/fixtures を GET して配列を返す", async () => {
    const fn = mockFetchOnce(200, {
      fixtures: [{ id: "a.xml", type: "VPWW55", label: "VPWW55 — a", supported: true }],
    });
    const fixtures = await fetchFixtures();
    expect(fn).toHaveBeenCalledWith("/api/fixtures");
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].id).toBe("a.xml");
  });

  it("fetchFixtures は非 2xx で throw する", async () => {
    mockFetchOnce(500, { error: "boom" });
    await expect(fetchFixtures()).rejects.toThrow(/500/);
  });

  it("renderFixture は /api/render に正しい body を POST する", async () => {
    const fn = mockFetchOnce(200, { ansi: "OUT", warnings: [], durationMs: 5 });
    const result = await renderFixture("a.xml", {
      compact: false, width: 100, noColor: false, nightMode: false,
    });
    expect(result.ansi).toBe("OUT");
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/render");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.fixtureId).toBe("a.xml");
    expect(body.themeOverride).toEqual({ palette: {}, roles: {} });
    expect((body.options as Record<string, unknown>).width).toBe(100);
  });

  it("renderFixture は themeOverride を引数で渡せる", async () => {
    const fn = mockFetchOnce(200, { ansi: "OUT", warnings: [], durationMs: 1 });
    await renderFixture("a.xml",
      { compact: false, width: 100, noColor: false, nightMode: false },
      { palette: { vermillion: "#FF00FF" } });
    const [, init] = fn.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { themeOverride: { palette: Record<string, string> } };
    expect(body.themeOverride.palette.vermillion).toBe("#FF00FF");
  });

  it("renderFixture は 400 で backend の error メッセージを throw する", async () => {
    mockFetchOnce(400, { error: "未対応の電文タイプ: x.xml" });
    await expect(
      renderFixture("x.xml", { compact: false, width: 100, noColor: false, nightMode: false }),
    ).rejects.toThrow("未対応の電文タイプ: x.xml");
  });
});

describe("api client (theme)", () => {
  it("getTheme は /api/theme を GET してカタログを返す", async () => {
    const fn = mockFetchOnce(200, {
      paletteNames: ["vermillion"], roleNames: ["frameCritical"],
      categories: [{ label: "枠", roles: ["frameCritical"] }],
      defaults: { palette: { vermillion: "#D55E00" }, roles: {} },
      saved: null, warnings: [],
    });
    const catalog = await getTheme();
    expect(fn).toHaveBeenCalledWith("/api/theme");
    expect(catalog.paletteNames).toEqual(["vermillion"]);
    expect(catalog.saved).toBeNull();
  });

  it("saveTheme は /api/theme/save に { theme } を POST する", async () => {
    const fn = mockFetchOnce(200, { ok: true, warnings: [] });
    const result = await saveTheme({ palette: { vermillion: "#FF00FF" } });
    expect(result.ok).toBe(true);
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/theme/save");
    const body = JSON.parse(init.body as string) as { theme: { palette: Record<string, string> } };
    expect(body.theme.palette.vermillion).toBe("#FF00FF");
  });

  it("saveTheme は非 2xx で error メッセージを throw する", async () => {
    mockFetchOnce(400, { error: "theme フィールドが不正です" });
    await expect(saveTheme({})).rejects.toThrow("theme フィールドが不正です");
  });
});

describe("api client (display-reference)", () => {
  it("fetchDisplayReference は type 付きで GET する", async () => {
    const fn = mockFetchOnce(200, { sections: [{ heading: "気象警報・注意報 (VPWW55-61, VPWS50)", markdown: "## ..." }] });
    const sections = await fetchDisplayReference("VPWW55");
    expect(fn).toHaveBeenCalledWith("/api/display-reference?type=VPWW55");
    expect(sections).toHaveLength(1);
  });
});

describe("api client (renderDiff)", () => {
  it("renderDiff は /api/diff に POST して DiffResult を返す", async () => {
    const fn = mockFetchOnce(200, {
      before: "OLD ANSI", after: "NEW ANSI", warnings: [], durationMs: 10,
    });
    const result = await renderDiff(
      "a.xml",
      { compact: false, width: 100, noColor: false, nightMode: false },
      { palette: { vermillion: "#FF00FF" } },
    );
    expect(result.before).toBe("OLD ANSI");
    expect(result.after).toBe("NEW ANSI");
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/diff");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.fixtureId).toBe("a.xml");
    expect((body.themeOverride as { palette: Record<string, string> }).palette.vermillion).toBe("#FF00FF");
  });

  it("renderDiff は非 2xx で backend の error メッセージを throw する", async () => {
    mockFetchOnce(400, { error: "未対応の電文タイプ: x.xml" });
    await expect(
      renderDiff("x.xml", { compact: false, width: 100, noColor: false, nightMode: false }, {}),
    ).rejects.toThrow("未対応の電文タイプ: x.xml");
  });
});
