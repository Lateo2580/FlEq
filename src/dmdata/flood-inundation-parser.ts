import type { InundationArea } from "../types";
import { dig, str } from "./telegram-parser";
import { listOf } from "./timeseries-common";

/**
 * Body 配下の Warning から 浸水想定地区 Item を抽出して `InundationArea[]` を組む。
 *
 * 構造例:
 *   <Warning type="指定河川洪水予報">
 *     <Item>
 *       <Kind><Name>浸水想定地区</Name><Code>1</Code>...</Kind>
 *       <Areas>
 *         <Area codeType="水位観測所">
 *           <Name>...</Name><Code>...</Code><Prefecture>...</Prefecture>
 *           <PrefectureCode>...</PrefectureCode><City>...</City>
 *           <CityCode>...</CityCode><SubCityList>...</SubCityList>
 *         </Area>
 *       </Areas>
 *     </Item>
 *   </Warning>
 *
 * axis fallback: @_codeType がない場合は CityCode の有無で municipality
 * 推定、Code (観測所コード相当) があれば station 推定、どちらもなければ unknown。
 */
export function parseInundationAreas(body: unknown): InundationArea[] {
  if (body == null) return [];
  const result: InundationArea[] = [];
  const warnings = listOf(dig(body, "Warning"));
  for (const warning of warnings) {
    if (warning == null) continue;
    const items = listOf(dig(warning, "Item"));
    for (const item of items) {
      if (item == null) continue;
      const kindNode = listOf(dig(item, "Kind"))[0];
      const kindName = str(dig(kindNode, "Name"));
      // 浸水想定地区 / 浸水想定地区（氾濫発生情報）に限定
      const isStandardInundation = kindName === "浸水想定地区";
      const isFloodOccurInundation = kindName === "浸水想定地区（氾濫発生情報）";
      if (!isStandardInundation && !isFloodOccurInundation) continue;
      const variant: InundationArea["variant"] = isFloodOccurInundation
        ? "氾濫発生情報"
        : "通常";

      const areasList = listOf(dig(item, "Areas"));
      for (const areasNode of areasList) {
        if (areasNode == null) continue;
        const areas = listOf(dig(areasNode, "Area"));
        for (const a of areas) {
          if (a == null) continue;
          const rawCodeTypeArea = str(dig(a, "@_codeType"));
          const rawCodeTypeOuter = str(dig(areasNode, "@_codeType"));
          const rawCodeType =
            rawCodeTypeArea !== ""
              ? rawCodeTypeArea
              : rawCodeTypeOuter !== ""
                ? rawCodeTypeOuter
                : null;

          const areaName = str(dig(a, "Name"));
          const areaCode = str(dig(a, "Code"));
          const prefName = str(dig(a, "Prefecture"));
          const prefCodeRaw = str(dig(a, "PrefectureCode"));
          const prefCode = prefCodeRaw === "" ? null : prefCodeRaw;
          const cityNameRaw = str(dig(a, "City"));
          const cityName = cityNameRaw === "" ? null : cityNameRaw;
          const cityCodeRaw = str(dig(a, "CityCode"));
          const cityCode = cityCodeRaw === "" ? null : cityCodeRaw;
          const subCityRaw = str(dig(a, "SubCityList"));
          const subCityList =
            subCityRaw === "" || subCityRaw === "-"
              ? []
              : subCityRaw.split(/\s+/).filter((s) => s !== "");

          // axis 推定
          let axis: InundationArea["axis"] = "unknown";
          let stationCode: string | null = null;
          if (rawCodeType === "水位観測所") {
            axis = "station";
            stationCode = areaCode === "" ? null : areaCode;
          } else if (cityCode != null) {
            axis = "municipality";
          } else if (areaCode !== "" && rawCodeType == null) {
            // station 寄りの推定 (Code はあるが codeType 不在)
            axis = "station";
            stationCode = areaCode;
          }

          result.push({
            variant,
            rawCodeType,
            axis,
            stationCode,
            cityCode,
            areaName,
            prefName,
            prefCode,
            cityName,
            subCityList,
          });
        }
      }
    }
  }
  return result;
}
