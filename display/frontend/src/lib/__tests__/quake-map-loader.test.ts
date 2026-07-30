import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadQuakeMapAsset,
  parseQuakeMapAsset,
  prefetchQuakeMapAsset,
  resetQuakeMapLoaderForTest,
  scheduleQuakeMapAssetPrefetch,
} from "../quake-map-loader";

function asset(over: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    projectionInsetsVersion: "jma-quake-projection-insets-v1",
    dataset: "AreaForecastLocalE",
    codeType: "code",
    viewBox: [0, 0, 1000, 800],
    pathsByCode: { "440": "M0,0L10,0L10,10Z" },
    insets: [{
      id: "okinawa",
      label: "沖縄・先島",
      frame: [40, 600, 360, 170],
      labelPosition: [52, 632],
    }],
    ...over,
  };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

afterEach(() => {
  resetQuakeMapLoaderForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("quake map loader", () => {
  it("document.baseURI 基準で全国図だけを fetch し、schema 検証済み asset を返す", async () => {
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => response(asset()));
    vi.stubGlobal("fetch", fetchMock);

    const loaded = await loadQuakeMapAsset();
    expect(loaded.dataset).toBe("AreaForecastLocalE");
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("maps/quake/area-forecast-local-e.v1.json", document.baseURI).href,
      { cache: "force-cache" },
    );
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain("area-information-city-quake");
  });

  it("進行中 Promise と成功結果を module cache し、複数呼出しで再 fetch しない", async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);

    const first = loadQuakeMapAsset();
    const second = loadQuakeMapAsset();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(response(asset()));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(await loadQuakeMapAsset()).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reset 前に開始した未解決 load の完了は新 generation の cache を汚染しない", async () => {
    let resolveOld!: (value: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveOld = resolve;
      }))
      .mockResolvedValueOnce(response(asset({
        pathsByCode: { "441": "M10,0L20,0L20,10Z" },
      })));
    vi.stubGlobal("fetch", fetchMock);

    const oldLoad = loadQuakeMapAsset();
    resetQuakeMapLoaderForTest();
    resolveOld(response(asset({
      pathsByCode: { "440": "M0,0L10,0L10,10Z" },
    })));
    expect((await oldLoad).pathsByCode).toHaveProperty("440");

    const current = await loadQuakeMapAsset();
    expect(current.pathsByCode).toHaveProperty("441");
    expect(current.pathsByCode).not.toHaveProperty("440");
    expect(await loadQuakeMapAsset()).toBe(current);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("HTTP failure は表示時に失敗し、同じ失敗を無制限に再試行しない", async () => {
    const fetchMock = vi.fn(async () => response({}, 503));
    vi.stubGlobal("fetch", fetchMock);
    await expect(loadQuakeMapAsset()).rejects.toThrow("503");
    await expect(loadQuakeMapAsset()).rejects.toThrow("503");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("schema mismatch を拒否する", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(asset({ schemaVersion: 2 }))));
    await expect(loadQuakeMapAsset()).rejects.toThrow("schema");
  });

  it("idle prefetch 失敗後は表示時 fetch に一度 fallback して成功できる", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("prefetch offline"))
      .mockResolvedValueOnce(response(asset()));
    vi.stubGlobal("fetch", fetchMock);

    await prefetchQuakeMapAsset();
    const loaded = await loadQuakeMapAsset();
    expect(loaded.dataset).toBe("AreaForecastLocalE");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requestIdleCallback まで fetch せず、cancel 可能な idle prefetch を予約する", async () => {
    let idleCallback: (() => void) | null = null;
    const fetchMock = vi.fn(async () => response(asset()));
    vi.stubGlobal("fetch", fetchMock);
    const target = {
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      requestIdleCallback: vi.fn((callback: () => void) => {
        idleCallback = callback;
        return 7;
      }),
      cancelIdleCallback: vi.fn(),
    };

    const cancel = scheduleQuakeMapAssetPrefetch(target);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(idleCallback).not.toBeNull();
    (idleCallback as unknown as () => void)();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect((await loadQuakeMapAsset()).dataset).toBe("AreaForecastLocalE");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    cancel();
    expect(target.cancelIdleCallback).toHaveBeenCalledWith(7);
  });

  it("prefetch 失敗を同時に待つ表示呼出しも fallback Promise を共有する", async () => {
    let rejectPrefetch!: (reason: Error) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => {
        rejectPrefetch = reject;
      }))
      .mockResolvedValueOnce(response(asset()));
    vi.stubGlobal("fetch", fetchMock);

    const prefetch = prefetchQuakeMapAsset();
    const first = loadQuakeMapAsset();
    const second = loadQuakeMapAsset();
    rejectPrefetch(new Error("prefetch offline"));

    await expect(prefetch).resolves.toBeUndefined();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("path・viewBox・inset の構造不正を拒否する", () => {
    expect(() => parseQuakeMapAsset(asset({ pathsByCode: { "440": "" } }))).toThrow("path");
    expect(() => parseQuakeMapAsset(asset({ viewBox: [0, 0, 1000] }))).toThrow("schema");
    expect(() => parseQuakeMapAsset(asset({ insets: [{ id: "x" }] }))).toThrow("inset");
  });
});
