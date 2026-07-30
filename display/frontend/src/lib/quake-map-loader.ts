const NATIONAL_QUAKE_MAP_PATH = "maps/quake/area-forecast-local-e.v1.json";

export interface QuakeMapInsetV1 {
  id: string;
  label: string;
  frame: [number, number, number, number];
  labelPosition: [number, number];
}

export interface QuakeMapAssetV1 {
  schemaVersion: 1;
  projectionInsetsVersion: string;
  dataset: "AreaForecastLocalE";
  codeType: "code";
  viewBox: [number, number, number, number];
  pathsByCode: Record<string, string>;
  insets: QuakeMapInsetV1[];
}

type LoadKind = "prefetch" | "display";

interface InFlightLoad {
  kind: LoadKind;
  promise: Promise<QuakeMapAssetV1>;
}

interface IdleWindow {
  setTimeout(handler: () => void, timeout?: number): number;
  clearTimeout(handle: number): void;
  requestIdleCallback?: (callback: () => void) => number;
  cancelIdleCallback?: (handle: number) => void;
}

let cachedAsset: QuakeMapAssetV1 | null = null;
let inFlight: InFlightLoad | null = null;
let displayLoadError: Error | null = null;
let loadGeneration = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function isFiniteTuple(value: unknown, length: number): value is number[] {
  return Array.isArray(value)
    && value.length === length
    && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function parseInset(value: unknown): QuakeMapInsetV1 | null {
  if (
    !isRecord(value)
    || typeof value.id !== "string"
    || value.id.length === 0
    || typeof value.label !== "string"
    || value.label.length === 0
    || !isFiniteTuple(value.frame, 4)
    || !isFiniteTuple(value.labelPosition, 2)
  ) {
    return null;
  }
  return {
    id: value.id,
    label: value.label,
    frame: value.frame as QuakeMapInsetV1["frame"],
    labelPosition: value.labelPosition as QuakeMapInsetV1["labelPosition"],
  };
}

/** Fetch 結果を wire と切り離した読取専用 asset として検証する。 */
export function parseQuakeMapAsset(value: unknown): QuakeMapAssetV1 {
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || value.projectionInsetsVersion !== "jma-quake-projection-insets-v1"
    || value.dataset !== "AreaForecastLocalE"
    || value.codeType !== "code"
    || !isFiniteTuple(value.viewBox, 4)
    || !isRecord(value.pathsByCode)
    || !Array.isArray(value.insets)
  ) {
    throw new Error("全国震度地図 asset の schema が不正です");
  }

  const pathsByCode: Record<string, string> = {};
  for (const [code, path] of Object.entries(value.pathsByCode)) {
    if (
      code.length === 0
      || typeof path !== "string"
      || path.length === 0
      || !path.startsWith("M")
      || /NaN|Infinity/.test(path)
    ) {
      throw new Error("全国震度地図 asset の path が不正です");
    }
    pathsByCode[code] = path;
  }
  if (Object.keys(pathsByCode).length === 0) {
    throw new Error("全国震度地図 asset に区域 path がありません");
  }

  const insets = value.insets.map(parseInset);
  if (insets.some((inset) => inset == null)) {
    throw new Error("全国震度地図 asset の inset が不正です");
  }

  return {
    schemaVersion: 1,
    projectionInsetsVersion: value.projectionInsetsVersion,
    dataset: "AreaForecastLocalE",
    codeType: "code",
    viewBox: value.viewBox as QuakeMapAssetV1["viewBox"],
    pathsByCode,
    insets: insets as QuakeMapInsetV1[],
  };
}

function assetUrl(): string {
  return new URL(NATIONAL_QUAKE_MAP_PATH, document.baseURI).href;
}

async function fetchAsset(): Promise<QuakeMapAssetV1> {
  const response = await fetch(assetUrl(), { cache: "force-cache" });
  if (!response.ok) {
    throw new Error(`全国震度地図 asset の取得に失敗しました (${response.status})`);
  }
  return parseQuakeMapAsset(await response.json());
}

function startLoad(kind: LoadKind): Promise<QuakeMapAssetV1> {
  const generation = loadGeneration;
  const promise = fetchAsset()
    .then((asset) => {
      if (generation === loadGeneration) cachedAsset = asset;
      return asset;
    })
    .catch((error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (generation === loadGeneration && kind === "display") {
        displayLoadError = normalized;
      }
      throw normalized;
    })
    .finally(() => {
      if (generation === loadGeneration && inFlight?.promise === promise) {
        inFlight = null;
      }
    });
  inFlight = { kind, promise };
  return promise;
}

function currentDisplayLoad(): Promise<QuakeMapAssetV1> | null {
  return inFlight?.kind === "display" ? inFlight.promise : null;
}

/**
 * 表示時ロード。idle prefetch が失敗した場合だけ新しい fetch へ fallback し、
 * 表示時 fetch の失敗は cache して地震更新ごとの無制限再試行を防ぐ。
 */
export async function loadQuakeMapAsset(): Promise<QuakeMapAssetV1> {
  if (cachedAsset != null) return cachedAsset;
  if (displayLoadError != null) throw displayLoadError;
  if (inFlight?.kind === "display") return inFlight.promise;
  if (inFlight?.kind === "prefetch") {
    try {
      return await inFlight.promise;
    } catch {
      if (cachedAsset != null) return cachedAsset;
      if (displayLoadError != null) throw displayLoadError;
      const replacement = currentDisplayLoad();
      if (replacement != null) return replacement;
      return startLoad("display");
    }
  }
  return startLoad("display");
}

/** 起動時の先読み。失敗は表示時 fallback のために terminal error とせず吸収する。 */
export async function prefetchQuakeMapAsset(): Promise<void> {
  if (cachedAsset != null || displayLoadError != null) return;
  const promise = inFlight?.promise ?? startLoad("prefetch");
  try {
    await promise;
  } catch {
    // 表示が必要になった時点の loadQuakeMapAsset() が一度だけ再試行する。
  }
}

/** frontend 起動時に呼び、ブラウザの idle slot（未対応時は次 task）で全国図だけを先読みする。 */
export function scheduleQuakeMapAssetPrefetch(
  target: IdleWindow = window,
): () => void {
  let cancelled = false;
  const run = (): void => {
    if (!cancelled) void prefetchQuakeMapAsset();
  };

  if (target.requestIdleCallback != null) {
    const handle = target.requestIdleCallback(run);
    return () => {
      cancelled = true;
      target.cancelIdleCallback?.(handle);
    };
  }

  const handle = target.setTimeout(run, 0);
  return () => {
    cancelled = true;
    target.clearTimeout(handle);
  };
}

/** テスト間で module cache を隔離する。production からは呼ばない。 */
export function resetQuakeMapLoaderForTest(): void {
  loadGeneration += 1;
  cachedAsset = null;
  inFlight = null;
  displayLoadError = null;
}
