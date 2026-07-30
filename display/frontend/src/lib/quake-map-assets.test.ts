import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const displayRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const assetRoot = resolve(displayRoot, "frontend/public/maps/quake");
const goldenPath = resolve(displayRoot, "maps/quake/golden-codes.v1.json");
const sourceLockPath = resolve(displayRoot, "maps/quake/source.lock.json");

interface MapAsset {
  schemaVersion: number;
  projectionInsetsVersion: string;
  dataset: string;
  viewBox: [number, number, number, number];
  pathsByCode: Record<string, string>;
  insets: Array<{
    id: string;
    label: string;
    frame: [number, number, number, number];
    labelPosition: [number, number];
  }>;
}

interface Manifest {
  schemaVersion: number;
  projectionInsetsVersion: string;
  projectionReferencePoints: Array<{
    source: [number, number];
    projected: [number, number];
  }>;
  assets: Array<{
    dataset: string;
    file: string;
    sha256: string;
    bytes: number;
    featureCount: number;
    codeCount: number;
    sizeBudgetBytes: number;
  }>;
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function pathCoordinates(path: string): Array<[number, number]> {
  const numbers = [...path.matchAll(/-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi)]
    .map((match) => Number(match[0]));
  return Array.from({ length: numbers.length / 2 }, (_, index) => [
    numbers[index * 2],
    numbers[index * 2 + 1],
  ]);
}

describe("quake-map generated assets", () => {
  const manifest = loadJson<Manifest>(resolve(assetRoot, "manifest.json"));
  const assets = new Map(
    manifest.assets.map((entry) => [
      entry.dataset,
      {
        entry,
        asset: loadJson<MapAsset>(resolve(assetRoot, entry.file)),
      },
    ]),
  );

  it("manifestの件数・hash・サイズ予算と両assetのprojection/inset契約が一致する", () => {
    const sourceLock = loadJson<{
      inputs: Array<{
        dataset: string;
        expectedCodeCount: number;
        crsControlPoints: unknown[];
      }>;
    }>(sourceLockPath);
    const lockedInputs = new Map(sourceLock.inputs.map((input) => [input.dataset, input]));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.projectionInsetsVersion).toBe("jma-quake-projection-insets-v1");
    expect(manifest.projectionReferencePoints.length).toBeGreaterThan(0);
    expect([...assets.keys()].sort()).toEqual(["AreaForecastLocalE", "AreaInformationCity_quake"]);
    const insetJson = new Set<string>();
    const viewBoxJson = new Set<string>();
    for (const { entry, asset } of assets.values()) {
      const path = resolve(assetRoot, entry.file);
      expect(asset.schemaVersion).toBe(1);
      expect(asset.projectionInsetsVersion).toBe(manifest.projectionInsetsVersion);
      expect(Object.keys(asset.pathsByCode)).toHaveLength(entry.codeCount);
      expect(entry.codeCount).toBe(lockedInputs.get(entry.dataset)?.expectedCodeCount);
      expect(lockedInputs.get(entry.dataset)?.crsControlPoints).toHaveLength(3);
      expect(entry.featureCount).toBeGreaterThanOrEqual(entry.codeCount);
      expect(readFileSync(path).byteLength).toBe(entry.bytes);
      expect(entry.bytes).toBeLessThanOrEqual(entry.sizeBudgetBytes);
      expect(sha256(path)).toBe(entry.sha256);
      expect(Object.values(asset.pathsByCode).every((pathValue) => pathValue.length > 0 && !/NaN|Infinity/.test(pathValue))).toBe(true);
      insetJson.add(JSON.stringify(asset.insets));
      viewBoxJson.add(JSON.stringify(asset.viewBox));
    }
    expect(insetJson.size).toBe(1);
    expect(viewBoxJson.size).toBe(1);
  });

  it("手動抽出したrepresentative VXSE Area/City codeが対応assetに存在する", () => {
    const golden = loadJson<{
      basis: string;
      localAreas: Array<{ code: string }>;
      municipalities: Array<{ code: string }>;
    }>(goldenPath);
    expect(golden.basis).toContain("Manually transcribed");
    const local = assets.get("AreaForecastLocalE")?.asset.pathsByCode ?? {};
    const city = assets.get("AreaInformationCity_quake")?.asset.pathsByCode ?? {};
    for (const { code } of golden.localAreas) expect(local).toHaveProperty(code);
    for (const { code } of golden.municipalities) expect(city).toHaveProperty(code);
  });

  it("境界をまたぐ774/4630400をfeature単位で沖縄insetだけへ投影する", () => {
    for (const [dataset, code] of [
      ["AreaForecastLocalE", "774"],
      ["AreaInformationCity_quake", "4630400"],
    ] as const) {
      const asset = assets.get(dataset)?.asset;
      expect(asset).toBeDefined();
      if (asset == null) throw new Error(`${dataset} asset is missing`);
      const inset = asset.insets.find(({ id }) => id === "okinawa");
      expect(inset).toBeDefined();
      if (inset == null) throw new Error(`${dataset} Okinawa inset is missing`);
      const [x, y, width, height] = inset.frame;
      const coordinates = pathCoordinates(asset.pathsByCode[code] ?? "");
      expect(coordinates.length).toBeGreaterThan(0);
      expect(coordinates.every(([pathX, pathY]) => (
        pathX >= x && pathX <= x + width && pathY >= y && pathY <= y + height
      ))).toBe(true);
    }
  });

  it("配布NOTICEはspecどおりNOTICE.txtで生成される", () => {
    expect(readFileSync(resolve(assetRoot, "NOTICE.txt"), "utf8")).toContain("出典: 気象庁");
  });
});
