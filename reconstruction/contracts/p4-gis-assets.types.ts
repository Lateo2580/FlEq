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
