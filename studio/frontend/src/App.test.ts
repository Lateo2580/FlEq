import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";

vi.mock("./lib/api", () => ({
  fetchFixtures: vi.fn().mockResolvedValue([
    { id: "a.xml", type: "VPWW55", label: "VPWW55 — a", supported: true },
  ]),
  renderFixture: vi.fn().mockResolvedValue({
    ansi: "\x1b[38;2;255;0;0m大雨警報\x1b[0m",
    warnings: [],
    durationMs: 3,
  }),
  renderDiff: vi.fn().mockResolvedValue({ before: "OLD", after: "NEW", warnings: [], durationMs: 1 }),
  getTheme: vi.fn().mockResolvedValue({
    paletteNames: ["vermillion"], roleNames: ["frameCritical"],
    categories: [{ label: "枠", roles: ["frameCritical"] }],
    defaults: { palette: { vermillion: "#D55E00" }, roles: { frameCritical: "vermillion" } },
    saved: null, warnings: [],
  }),
  saveTheme: vi.fn().mockResolvedValue({ ok: true, warnings: [] }),
  fetchDisplayReference: vi.fn().mockResolvedValue([]),
}));

import App from "./App.svelte";
import { fetchFixtures, renderFixture, renderDiff, getTheme, saveTheme, fetchDisplayReference } from "./lib/api";
import { themeStore } from "./lib/theme-store.svelte";
import type { ThemeCatalog } from "./lib/api";

const MOCK_CATALOG: ThemeCatalog = {
  paletteNames: ["vermillion"], roleNames: ["frameCritical"],
  categories: [{ label: "枠", roles: ["frameCritical"] }],
  defaults: { palette: { vermillion: "#D55E00" }, roles: { frameCritical: "vermillion" } },
  saved: null, warnings: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  (fetchFixtures as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "a.xml", type: "VPWW55", label: "VPWW55 — a", supported: true },
  ]);
  (renderFixture as ReturnType<typeof vi.fn>).mockResolvedValue({
    ansi: "\x1b[38;2;255;0;0m大雨警報\x1b[0m",
    warnings: [],
    durationMs: 3,
  });
  (getTheme as ReturnType<typeof vi.fn>).mockResolvedValue(structuredClone(MOCK_CATALOG));
  (renderDiff as ReturnType<typeof vi.fn>).mockResolvedValue({ before: "OLD", after: "NEW", warnings: [], durationMs: 1 });
  (saveTheme as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, warnings: [] });
  (fetchDisplayReference as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  // themeStore はモジュール singleton — 前テストの編集 state を持ち越さない
  themeStore.catalog = null;
  themeStore.edit = { palette: {}, roles: {} };
  themeStore.baseline = { palette: {}, roles: {} };
});

afterEach(() => {
  vi.useRealTimers(); // fake timers のテストが失敗しても後続に漏らさない
});

describe("App", () => {
  it("起動時に fixtures を読み込んで一覧表示する", async () => {
    render(App);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /VPWW55/ })).toBeTruthy();
    });
    expect(fetchFixtures).toHaveBeenCalledOnce();
  });

  it("fixture 選択で renderFixture が呼ばれプレビューに反映される", async () => {
    const { container } = render(App);
    await waitFor(() => screen.getByRole("button", { name: /VPWW55/ }));
    await fireEvent.click(screen.getByRole("button", { name: /VPWW55/ }));
    await waitFor(() => {
      expect(container.querySelector("pre.terminal")!.textContent).toContain("大雨警報");
    });
    expect(renderFixture).toHaveBeenCalledWith("a.xml", {
      compact: false, width: 100, noColor: false, nightMode: false,
    }, expect.anything());
  });

  it("render エラーはプレビューに [render error] として出る", async () => {
    (renderFixture as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("parse 失敗: a.xml"));
    const { container } = render(App);
    await waitFor(() => screen.getByRole("button", { name: /VPWW55/ }));
    await fireEvent.click(screen.getByRole("button", { name: /VPWW55/ }));
    await waitFor(() => {
      expect(container.querySelector("pre.terminal")!.textContent).toContain("[render error]");
      expect(container.querySelector("pre.terminal")!.textContent).toContain("parse 失敗");
    });
  });

  it("fixtures 読込失敗は picker 側に出る (render error とは区別)", async () => {
    (fetchFixtures as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("HTTP 500"));
    const { container } = render(App);
    await waitFor(() => {
      expect(container.querySelector(".load-error")!.textContent).toContain("HTTP 500");
    });
    // プレビューは render error 扱いにしない (レビュー反映)
    expect(container.querySelector("pre.terminal")!.textContent).not.toContain("[render error]");
  });

  it("パレット編集で debounce 後に再 render される (themeOverride 付き)", async () => {
    vi.useFakeTimers();
    render(App);
    await vi.waitFor(() => screen.getByRole("button", { name: /VPWW55/ }));
    await fireEvent.click(screen.getByRole("button", { name: /VPWW55/ }));
    await vi.waitFor(() => screen.getByLabelText("palette-vermillion"));
    (renderFixture as ReturnType<typeof vi.fn>).mockClear();

    const colorInput = screen.getByLabelText("palette-vermillion") as HTMLInputElement;
    await fireEvent.input(colorInput, { target: { value: "#ff00ff" } });
    expect(renderFixture).not.toHaveBeenCalled(); // debounce 中
    await vi.advanceTimersByTimeAsync(200);
    expect(renderFixture).toHaveBeenCalledTimes(1);
    const override = (renderFixture as ReturnType<typeof vi.fn>).mock.calls[0][2] as { palette: Record<string, string> };
    expect(override.palette.vermillion.toUpperCase()).toBe("#FF00FF");
    vi.useRealTimers();
  });

  it("Save ボタンは dirty 時のみ有効になり、押すと saveTheme が呼ばれる", async () => {
    render(App);
    await waitFor(() => screen.getByLabelText("palette-vermillion"));
    const saveBtn = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    await fireEvent.input(screen.getByLabelText("palette-vermillion"), { target: { value: "#ff00ff" } });
    await waitFor(() => { expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false); });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(saveTheme).toHaveBeenCalled();
      expect(screen.getByText(/保存しました/)).toBeTruthy();
    });
  });

  it("render warnings が WarningList に出る", async () => {
    // mockResolvedValueOnce にする (Value だと実装が後続テストへ漏れる — レビュー反映)
    (renderFixture as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ansi: "X", warnings: ["palette.vermillion: 不正なHEX値 \"x\""], durationMs: 1,
    });
    render(App);
    await waitFor(() => screen.getByRole("button", { name: /VPWW55/ }));
    await fireEvent.click(screen.getByRole("button", { name: /VPWW55/ }));
    await waitFor(() => { expect(screen.getByText(/不正なHEX値/)).toBeTruthy(); });
  });

  it("オプション変更 (compact ON) で即 re-render される", async () => {
    render(App);
    await waitFor(() => screen.getByRole("button", { name: /VPWW55/ }));
    await fireEvent.click(screen.getByRole("button", { name: /VPWW55/ }));
    (renderFixture as ReturnType<typeof vi.fn>).mockClear();
    await fireEvent.click(screen.getByLabelText("compact"));
    await waitFor(() => {
      expect(renderFixture).toHaveBeenCalledTimes(1);
      const opts = (renderFixture as ReturnType<typeof vi.fn>).mock.calls[0][1] as { compact: boolean };
      expect(opts.compact).toBe(true);
    });
  });

  it("fixture 選択で display-reference が取得され表示される", async () => {
    (fetchDisplayReference as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { heading: "気象警報・注意報 (VPWW55-61, VPWS50)", markdown: "spec text" },
    ]);
    render(App);
    await waitFor(() => screen.getByRole("button", { name: /VPWW55/ }));
    await fireEvent.click(screen.getByRole("button", { name: /VPWW55/ }));
    await waitFor(() => {
      expect(screen.getByText(/気象警報・注意報/)).toBeTruthy();
    });
  });

  it("diff トグルで DiffPane が出て renderDiff が呼ばれる", async () => {
    const { container } = render(App);
    await waitFor(() => screen.getByRole("button", { name: /VPWW55/ }));
    await fireEvent.click(screen.getByRole("button", { name: /VPWW55/ }));
    await fireEvent.click(screen.getByRole("button", { name: "diff" }));
    await waitFor(() => {
      expect(renderDiff).toHaveBeenCalled();
      expect(container.querySelector(".diff-pane")).not.toBeNull();
    });
  });

  it("diff モード解除で通常プレビューに戻る", async () => {
    const { container } = render(App);
    await waitFor(() => screen.getByRole("button", { name: /VPWW55/ }));
    await fireEvent.click(screen.getByRole("button", { name: /VPWW55/ }));
    await fireEvent.click(screen.getByRole("button", { name: "diff" }));
    await waitFor(() => container.querySelector(".diff-pane"));
    await fireEvent.click(screen.getByRole("button", { name: "diff" }));
    await waitFor(() => {
      expect(container.querySelector(".diff-pane")).toBeNull();
      expect(container.querySelector("pre.terminal")).not.toBeNull();
    });
  });
});
