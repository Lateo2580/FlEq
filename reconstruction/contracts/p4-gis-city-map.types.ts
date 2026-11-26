// 市区町村（地震津波関係、7 桁）→ 市町村等（気象警報等、7 桁）の対応表の形（P4-GIS-CITY-MAP-001 の AC01）。
// 生成物 reconstruction/assets/gis/city-weather-map.v1.json はこの形で、C0・R0 は resolveJsonModule で import して代入で受ける（as を使わない）。
// JSON の import は字の literal を string に広げるので、relation は string で書く（値は same・within・part の 3 つ、build が止める）。

// 地震の区域の側から見た関係。same は同じ行、within は気象の区域 1 つの中、part は気象の区域が一部を受け持つ（p4-gis-city-map-tables.md §3）
export interface CityWeatherCity {
  readonly code: string;
  readonly relation: string;
}

// 1 行の候補は same 1 つ・within 1 つ・part 2 つ以上のどれか。候補はコードの昇順
export interface CityWeatherMapRow {
  readonly city: string;
  readonly weatherCities: readonly CityWeatherCity[];
}

export interface CityWeatherMapTable {
  readonly schemaVersion: number;
  readonly rows: readonly CityWeatherMapRow[];
}
