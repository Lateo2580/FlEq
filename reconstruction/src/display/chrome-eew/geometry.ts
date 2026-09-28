// P2-A9-AC03 / meta.questionResolutions[P2-A9-GEOMETRY]: VXSE43採用snapshot専用の固定測定geometry。
// canonical JSONのkey順・空白なしはAC03のsha256照合対象。P4のGISには使わない。

const GEOMETRY_SCHEMA_VERSION = "p2-eew-minimal-geometry-v1";
const GEOMETRY_SOURCE_FIXTURE_ID = "test__fixtures__37_01_01_240613_VXSE43";

export type GeometryRect = readonly [number, number, number, number];
type GeometryArea = Readonly<{ code: string; rect: GeometryRect }>;

// 契約 meta.questionResolutions[P2-A9-GEOMETRY].paintExpectations の rect と同一。順序もそのまま。
const GEOMETRY_AREAS: readonly GeometryArea[] = [
  { code: "622", rect: [0, 0, 100, 100] },
  { code: "632", rect: [100, 0, 100, 100] },
  { code: "752", rect: [200, 0, 100, 100] },
  { code: "751", rect: [0, 100, 100, 100] },
  { code: "621", rect: [100, 100, 100, 100] },
  { code: "750", rect: [200, 100, 100, 100] },
  { code: "620", rect: [0, 200, 100, 100] },
  { code: "703", rect: [100, 200, 100, 100] },
  { code: "592", rect: [200, 200, 100, 100] },
];

const GEOMETRY_RECT_BY_CODE: ReadonlyMap<string, GeometryRect> =
  new Map(GEOMETRY_AREAS.map((area) => [area.code, area.rect]));

// AC03のsha256照合対象そのもの。
// キー順 schemaVersion,sourceFixtureId,areas / area毎に code,rect。空白・改行なし。
function canonicalGeometryJson(): string {
  return JSON.stringify({
    schemaVersion: GEOMETRY_SCHEMA_VERSION,
    sourceFixtureId: GEOMETRY_SOURCE_FIXTURE_ID,
    areas: GEOMETRY_AREAS.map((area) => ({ code: area.code, rect: area.rect })),
  });
}

export { canonicalGeometryJson, GEOMETRY_AREAS, GEOMETRY_RECT_BY_CODE };
