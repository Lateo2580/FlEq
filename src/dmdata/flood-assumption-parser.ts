import type { FloodAssumptionPart } from "../types";
import { dig, str } from "./telegram-parser";
import { listOf, nodeText, toNumberOrNull } from "./timeseries-common";

/**
 * Body.MeteorologicalInfos[type=氾濫水の予報] から `FloodAssumptionPart[]` を抽出。
 *
 * 構造例:
 *   <MeteorologicalInfos type="氾濫水の予報">
 *     <MeteorologicalInfo>
 *       <Item>
 *         <Kind>
 *           <Property>
 *             <Type>氾濫水</Type>
 *             <FloodAssumptionTable>
 *               <Area codeType="河川"><Name>○○川</Name><Code>...</Code></Area>
 *               <FloodAssumptionPart>
 *                 <FloodAssumptionArea>○市市役所</FloodAssumptionArea>
 *                 <AttainmentTime description="2時間後" dubious="頃">2019-...</AttainmentTime>
 *                 <jmx_eb:FloodDepth type="想定最大浸水深" unit="m" bound="以上">0</jmx_eb:FloodDepth>
 *                 <jmx_eb:FloodDepth type="想定最大浸水深" unit="m" bound="未満">0.5</jmx_eb:FloodDepth>
 *                 <AttainmentDeepestTime>...</AttainmentDeepestTime>
 *               </FloodAssumptionPart>
 *             </FloodAssumptionTable>
 *           </Property>
 *         </Kind>
 *       </Item>
 *     </MeteorologicalInfo>
 *   </MeteorologicalInfos>
 */
export function parseFloodAssumptions(body: unknown): FloodAssumptionPart[] {
  if (body == null) return [];
  const result: FloodAssumptionPart[] = [];
  const meteoInfos = listOf(dig(body, "MeteorologicalInfos"));
  const floodInfo = meteoInfos.find(
    (m) => str(dig(m, "@_type")) === "氾濫水の予報",
  );
  if (floodInfo == null) return result;

  const metInfos = listOf(dig(floodInfo, "MeteorologicalInfo"));
  for (const metInfo of metInfos) {
    if (metInfo == null) continue;
    const items = listOf(dig(metInfo, "Item"));
    for (const item of items) {
      if (item == null) continue;
      const kindNode = listOf(dig(item, "Kind"))[0];
      const propertyNode = listOf(dig(kindNode, "Property"))[0];
      const table = dig(propertyNode, "FloodAssumptionTable");
      if (table == null) continue;

      const areaNode = listOf(dig(table, "Area"))[0];
      const riverName = str(dig(areaNode, "Name")) || null;
      const assumptionAreaCodeRaw = str(dig(areaNode, "Code"));
      const assumptionAreaCode =
        assumptionAreaCodeRaw === "" ? null : assumptionAreaCodeRaw;

      const parts = listOf(dig(table, "FloodAssumptionPart"));
      for (const part of parts) {
        if (part == null) continue;
        const assumptionAreaName = str(dig(part, "FloodAssumptionArea")) || null;
        const attainmentTimeNode = dig(part, "AttainmentTime");
        const attainmentTime = nodeText(attainmentTimeNode) || null;
        const attainmentDescription =
          str(dig(attainmentTimeNode, "@_description")) || null;
        const attainmentDubious =
          str(dig(attainmentTimeNode, "@_dubious")) || null;

        const depthEls = listOf(dig(part, "jmx_eb:FloodDepth"));
        let depthMinM: number | null = null;
        let depthMaxM: number | null = null;
        for (const dEl of depthEls) {
          if (dEl == null) continue;
          const bound = str(dig(dEl, "@_bound"));
          const value = toNumberOrNull(nodeText(dEl));
          if (bound === "以上") depthMinM = value;
          else if (bound === "未満") depthMaxM = value;
        }

        const deepestNode = dig(part, "AttainmentDeepestTime");
        const attainmentDeepestTime = nodeText(deepestNode) || null;

        result.push({
          riverName,
          assumptionAreaName,
          assumptionAreaCode,
          attainmentTime,
          attainmentDescription,
          attainmentDubious,
          depthMinM,
          depthMaxM,
          attainmentDeepestTime,
        });
      }
    }
  }
  return result;
}
