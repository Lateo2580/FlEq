// G0 発注 1 の既知コードの表の形（P4-GIS-ASSETS-001 の AC01〜AC03）。B0 の表 §1.1 の既知コード 3 種だけを持つ。
// 生成物 reconstruction/assets/gis/known-codes.v1.json はこの形で、B0・M0・R0 は resolveJsonModule で import して代入で受ける（as を使わない）。
// JSON の import は字の literal を string に広げるので、欄は string と number だけで書く。

// spec §3.5 の D01 の AreaName。名前は元資料の Name 列のまま（ふりがなは落とす）
export interface AreaName {
  readonly code: string;
  readonly name: string;
}

// 市区町村等（地震津波関係、7 桁）。所属の細分区域はコード表 sheet 24 の同じ行の 3 桁で、1 市区町村に 1 つ
export interface CityAreaName extends AreaName {
  readonly forecastLocalE: string;
}

// 津波予報区の結合表現・領域表現。電文では Head の Headline の Information にだけ出る（AC03）
export interface TsunamiAreaGroup extends AreaName {
  readonly members: readonly string[];
}

export interface KnownCodeTable {
  readonly schemaVersion: number;
  readonly forecastLocalE: readonly AreaName[];
  readonly city: readonly CityAreaName[];
  readonly tsunamiArea: readonly AreaName[];
  readonly tsunamiAreaGroup: readonly TsunamiAreaGroup[];
}

// ---- 発注 2（P4-GIS-AC06〜AC09・AC11）の生成物の形 ----
// 形の層は経緯度（JGD2011）の GeoJSON で、投影は M0 の関数が manifest の projection の値で当てる（P4-GIS-I-PROJECTION=A・P4-GIS-I-SHAPE-FORM）。
// 形の file は大きいので resolveJsonModule で import せず、M0 は読み込みの境界で確かめる。coordinates の入れ子の段は geometry.type で決まる
// （Polygon 3・MultiPolygon 4・LineString 2・MultiLineString 3）ので unknown[] で受ける。

// 1 地物。properties は区域のコードだけ（名前は既知コードの表と AreaCodeTable から引く、spec:1725）
export interface AreaGeometry {
  readonly type: string;
  readonly properties: { readonly code: string };
  readonly geometry: { readonly type: string; readonly coordinates: readonly unknown[] };
}

// 1 層の 1 LOD（reconstruction/assets/gis/shapes/<層>.<overview|zoom>.v1.json）。地物はコードの昇順で、同じコードの地物が複数あってよい
export interface AreaShapeLayer {
  readonly type: string;
  readonly features: readonly AreaGeometry[];
}

// 区域ごとの名札・引き出し線の代表点と範囲（経度・緯度）。LOD を替えても同じ点を使う（spec:1675）
export interface AreaAnchor {
  readonly code: string;
  readonly anchor: readonly number[];
  readonly bounds: readonly number[];
}

export interface AreaAnchorTable {
  readonly schemaVersion: number;
  readonly layer: string;
  readonly anchors: readonly AreaAnchor[];
}

// 気象の区域の所属。府県予報区等 ← 一次細分区域等 ← 市町村等をまとめた地域等 ← 市町村等（気象警報等）
export interface WeatherPrimaryName extends AreaName {
  readonly prefecture: string;
}

export interface WeatherGroupName extends AreaName {
  readonly primary: string;
}

export interface WeatherCityName extends AreaName {
  readonly group: string;
}

// 既知コードの表（KnownCodeTable、B0 が読む）に入れない区域のコードと名前。発注 2 の build の coverage と、M0・R0 の区域名が読む
export interface AreaCodeTable {
  readonly schemaVersion: number;
  readonly prefecture: readonly AreaName[];
  readonly weatherPrefecture: readonly AreaName[];
  readonly weatherPrimary: readonly WeatherPrimaryName[];
  readonly weatherGroup: readonly WeatherGroupName[];
  readonly weatherCity: readonly WeatherCityName[];
  readonly floodCity: readonly AreaName[];
}

// 市区町村・細分区域 → 都道府県（2 桁）。県の形の中に区域の代表点があることから作る（Q-G0-PREF-MEMBERSHIP）
export interface AreaPrefectureLink {
  readonly code: string;
  readonly prefecture: string;
}

export interface AreaMembershipTable {
  readonly schemaVersion: number;
  readonly city: readonly AreaPrefectureLink[];
  readonly forecastLocalE: readonly AreaPrefectureLink[];
}

// 市区町村（7 桁）→ 津波予報区（AC11）。2 つの予報区に分かれる市町村は 2 つを持つ
export interface CityTsunamiArea {
  readonly city: string;
  readonly tsunamiAreas: readonly string[];
}

export interface CityTsunamiTable {
  readonly schemaVersion: number;
  readonly rows: readonly CityTsunamiArea[];
}
