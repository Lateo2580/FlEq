import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { AreaAnchorTable, AreaCodeTable, AreaShapeLayer, CityTsunamiTable } from "../../contracts/p4-gis-assets.types";
import areaJson from "../../assets/gis/area-codes.v1.json";
import tsunamiJson from "../../assets/gis/tsunami-region.v1.json";

const areaCodes: AreaCodeTable = areaJson;
const tsunamiRegion: CityTsunamiTable = tsunamiJson;
const manifest = JSON.parse(readFileSync("reconstruction/assets/gis/manifest.json", "utf8"));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
// 形の file は大きいので import せず fs で読む
const readShape = (path: string): AreaShapeLayer => JSON.parse(readFileSync(path, "utf8"));

describe("P4-GIS 形と区域の表", () => {
  // P4-GIS-T04（acceptance: AC06・AC07・AC08・AC09・AC11）
  it("発注 2 の生成物の sha256 と件数が manifest と一致する", () => {
    const outputs: { path: string; sha256: string }[] = [manifest.areaCodes.output, manifest.tsunamiRegion.output, manifest.membership.output];
    for (const [id, layer] of Object.entries<{
      expectedCodeCount: number;
      knownGapsAndExclusions: { kind: string }[];
      outputs: Record<"overview" | "zoom" | "anchors", { path: string; sha256: string }>;
    }>(manifest.layers)) {
      outputs.push(layer.outputs.overview, layer.outputs.zoom, layer.outputs.anchors);
      const codes = layer.expectedCodeCount - layer.knownGapsAndExclusions.filter((e) => e.kind === "gap").length;
      for (const lod of ["overview", "zoom"] as const) {
        expect(new Set(readShape(layer.outputs[lod].path).features.map((f) => f.properties.code)).size, `${id} ${lod}`).toBe(codes);
      }
      const anchors: AreaAnchorTable = JSON.parse(readFileSync(layer.outputs.anchors.path, "utf8"));
      expect(anchors.anchors.length, `${id} anchors`).toBe(codes);
    }
    for (const o of outputs) expect(sha(readFileSync(o.path)), o.path).toBe(o.sha256);

    expect({
      prefecture: areaCodes.prefecture.length,
      weatherPrefecture: areaCodes.weatherPrefecture.length,
      weatherPrimary: areaCodes.weatherPrimary.length,
      weatherGroup: areaCodes.weatherGroup.length,
      weatherCity: areaCodes.weatherCity.length,
      floodCity: areaCodes.floodCity.length,
    }).toEqual(manifest.areaCodes.expectedCodeCount);
    expect(tsunamiRegion.rows.length).toBe(manifest.tsunamiRegion.expectedCodeCount.rows);
    const membership = JSON.parse(readFileSync(manifest.membership.output.path, "utf8"));
    expect({ city: membership.city.length, forecastLocalE: membership.forecastLocalE.length }).toEqual(manifest.membership.expectedCodeCount);
  });

  // P4-GIS-T05（regression: 旧築の build で港区・江東区が消え、大田区が欠片になった、p4-gis-assets-sources.md §7.2）
  it("市区町村の両方の LOD に港区・江東区・大田区があり、面積が向きを直した元の 0.5 倍以上", () => {
    // 経緯度の平面の面積（輪の符号つき面積の絶対値の和、度²）
    const ringArea = (ring: number[][]) => Math.abs(ring.reduce((s, [x, y], i) => s + x * ring[(i + 1) % ring.length][1] - ring[(i + 1) % ring.length][0] * y, 0)) / 2;
    type Geometry = { type: "Polygon"; coordinates: number[][][] } | { type: "MultiPolygon"; coordinates: number[][][][] };
    const rings = (g: Geometry) => (g.type === "Polygon" ? g.coordinates : g.coordinates.flat());
    const source: Record<string, number> = { "1310300": 2.0763e-3, "1310800": 4.4025e-3, "1311100": 6.1962e-3 };
    for (const lod of ["overview", "zoom"] as const) {
      const features: { properties: { code: string }; geometry: Geometry }[] = JSON.parse(readFileSync(manifest.layers.city.outputs[lod].path, "utf8")).features;
      for (const [code, area] of Object.entries(source)) {
        const mine = features.filter((f) => f.properties.code === code);
        expect(mine.length, `${lod} ${code}`).toBeGreaterThan(0);
        const sum = mine.flatMap((f) => rings(f.geometry)).reduce((s, r) => s + ringArea(r), 0);
        expect(sum, `${lod} ${code}`).toBeGreaterThanOrEqual(area * 0.5);
      }
    }
  });
});
