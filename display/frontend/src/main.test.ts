import { afterEach, describe, expect, it, vi } from "vitest";

const mountMock = vi.hoisted(() => vi.fn());

vi.mock("svelte", async (importOriginal) => {
  const actual = await importOriginal<typeof import("svelte")>();
  return { ...actual, mount: mountMock };
});
vi.mock("./App.svelte", () => ({ default: {} }));

afterEach(async () => {
  const { resetQuakeMapLoaderForTest } = await import("./lib/quake-map-loader");
  resetQuakeMapLoaderForTest();
  mountMock.mockReset();
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.innerHTML = "";
});

describe("frontend entrypoint", () => {
  it("mount を待たせず idle prefetch を起動配線する", async () => {
    let idleCallback: IdleRequestCallback | null = null;
    const idleMock = vi.fn((callback: IdleRequestCallback) => {
      idleCallback = callback;
      return 7;
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        schemaVersion: 1,
        projectionInsetsVersion: "jma-quake-projection-insets-v1",
        dataset: "AreaForecastLocalE",
        codeType: "code",
        viewBox: [0, 0, 1000, 800],
        pathsByCode: { "440": "M0,0L10,0L10,10Z" },
        insets: [],
      }),
    } as unknown as Response));
    vi.stubGlobal("requestIdleCallback", idleMock);
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    vi.stubGlobal("fetch", fetchMock);
    document.body.innerHTML = '<div id="app"></div>';

    await import("./main");

    expect(idleMock).toHaveBeenCalledOnce();
    expect(mountMock).toHaveBeenCalledOnce();
    expect(idleMock.mock.invocationCallOrder[0])
      .toBeLessThan(mountMock.mock.invocationCallOrder[0]!);
    expect(fetchMock).not.toHaveBeenCalled();

    (idleCallback as unknown as IdleRequestCallback)({
      didTimeout: false,
      timeRemaining: () => 10,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  });
});
