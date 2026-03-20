import {
  WsDataMessage,
  ParsedVolcanoInfo,
  ParsedVolcanoAlertInfo,
  ParsedVolcanoEruptionInfo,
  ParsedVolcanoAshfallInfo,
  ParsedVolcanoTextInfo,
  ParsedVolcanoPlumeInfo,
  VolcanoHeadType,
  VolcanoAction,
  VolcanoMunicipality,
  AshForecastPeriod,
  AshArea,
  WindProfileEntry,
} from "../types";
import { decodeBody, parseXml, dig, str, first } from "./telegram-parser";
import * as log from "../logger";

// ── 共通ヘルパー ──

/** Report ノードを取得 */
function findReport(parsed: Record<string, unknown>): unknown {
  return (
    dig(parsed, "Report") ||
    dig(parsed, "jmx:Report") ||
    dig(parsed, "jmx_seis:Report")
  );
}

/** レベルコード → 数値 ("11"→1, "12"→2, ..., "15"→5, それ以外→null) */
function levelCodeToNumber(code: string): 1 | 2 | 3 | 4 | 5 | null {
  if (!code) return null;
  const map: Record<string, 1 | 2 | 3 | 4 | 5> = {
    "11": 1, "12": 2, "13": 3, "14": 4, "15": 5,
  };
  return map[code] ?? null;
}

/** XML の Condition + infoType → VolcanoAction への正規化 */
function conditionToAction(condition: string, infoType: string): VolcanoAction {
  if (infoType === "取消") return "cancel";
  const normalized = condition.replace(/\s+/g, "");
  if (normalized === "引上げ") return "raise";
  if (normalized === "引下げ") return "lower";
  if (normalized === "解除") return "release";
  if (normalized === "継続") return "continue";
  if (normalized === "発表" || normalized === "特別警報") return "issue";
  return "issue";
}

/** 火山名の VolcanoInfo (type="...（対象火山）") から火山情報を抽出 */
function extractVolcanoBase(
  report: unknown,
  headType: VolcanoHeadType,
  msg: WsDataMessage,
): Omit<ParsedVolcanoAlertInfo, "kind" | "type" | "alertLevel" | "alertLevelCode" | "action" | "previousLevelCode" | "warningKind" | "municipalities" | "bodyText" | "preventionText" | "isMarine"> {
  const head = dig(report, "Head");
  const body = dig(report, "Body");

  const infoType = str(dig(head, "InfoType"));
  const title = str(dig(head, "Title"));
  const reportDateTime = str(dig(head, "ReportDateTime"));
  const headline = str(dig(head, "Headline", "Text")) || null;
  const publishingOffice = msg.xmlReport?.control?.publishingOffice || "";

  // 火山名・コード・座標を Body > VolcanoInfo から取得
  let volcanoName = "";
  let volcanoCode = "";
  let coordinate: string | null = null;
  let eventDateTime: string | null = null;

  const volcanoInfos = dig(body, "VolcanoInfo");
  const infos = Array.isArray(volcanoInfos) ? volcanoInfos : volcanoInfos ? [volcanoInfos] : [];
  for (const vi of infos) {
    const items = dig(vi, "Item");
    const itemList = Array.isArray(items) ? items : items ? [items] : [];
    for (const item of itemList) {
      const areas = dig(item, "Areas");
      const codeType = str(dig(areas, "@_codeType"));
      if (codeType === "火山名") {
        const areaList = dig(areas, "Area");
        const area = Array.isArray(areaList) ? areaList[0] : areaList;
        if (area) {
          volcanoName = volcanoName || str(dig(area, "Name"));
          volcanoCode = volcanoCode || str(dig(area, "Code"));
          if (!coordinate) {
            const coord = str(
              dig(area, "Coordinate", "#text") ||
              dig(area, "Coordinate")
            );
            coordinate = coord || null;
          }
        }
      }
      // EventTime
      if (!eventDateTime) {
        const et = str(dig(item, "EventTime", "EventDateTime", "#text") || dig(item, "EventTime", "EventDateTime"));
        if (et) eventDateTime = et;
      }
    }
  }

  // TargetDateTime をフォールバック
  if (!eventDateTime) {
    const target = str(dig(head, "TargetDateTime"));
    if (target) eventDateTime = target;
  }

  return {
    domain: "volcano" as const,
    infoType,
    title,
    reportDateTime,
    eventDateTime,
    headline,
    publishingOffice,
    volcanoName,
    volcanoCode,
    coordinate,
    isTest: msg.head.test,
  };
}

/** 噴煙観測データを抽出 */
function extractPlumeObservation(body: unknown): {
  plumeHeight: number | null;
  plumeHeightUnknown: boolean;
  plumeDirection: string | null;
  craterName: string | null;
} {
  const obs = dig(body, "VolcanoObservation");
  const colorPlume = dig(obs, "ColorPlume");

  let plumeHeight: number | null = null;
  let plumeHeightUnknown = false;
  let plumeDirection: string | null = null;

  if (colorPlume) {
    // 火口上噴煙高度
    const heightNode =
      dig(colorPlume, "jmx_eb:PlumeHeightAboveCrater") ||
      dig(colorPlume, "PlumeHeightAboveCrater");
    const heightVal = typeof heightNode === "object"
      ? str(dig(heightNode, "#text"))
      : str(heightNode);
    const heightCondition = typeof heightNode === "object"
      ? str(dig(heightNode, "@_condition"))
      : "";

    if (heightCondition === "不明" || heightVal === "" || heightVal === "不明") {
      plumeHeightUnknown = true;
    } else {
      const parsed = parseInt(heightVal, 10);
      if (!isNaN(parsed)) plumeHeight = parsed;
    }

    // 流向
    const dirNode =
      dig(colorPlume, "jmx_eb:PlumeDirection") ||
      dig(colorPlume, "PlumeDirection");
    const dirVal = typeof dirNode === "object"
      ? str(dig(dirNode, "#text"))
      : str(dirNode);
    if (dirVal && dirVal !== "流向不明") {
      plumeDirection = dirVal;
    }
  }

  // 火口名
  let craterName: string | null = null;
  // VolcanoInfo 内から取得
  const volcanoInfos = dig(body, "VolcanoInfo");
  const infos = Array.isArray(volcanoInfos) ? volcanoInfos : volcanoInfos ? [volcanoInfos] : [];
  for (const vi of infos) {
    const items = dig(vi, "Item");
    const itemList = Array.isArray(items) ? items : items ? [items] : [];
    for (const item of itemList) {
      const areas = dig(item, "Areas");
      const areaList = dig(areas, "Area");
      const area = Array.isArray(areaList) ? areaList[0] : areaList;
      if (area) {
        const cn = str(dig(area, "CraterName"));
        if (cn) { craterName = cn; break; }
      }
    }
    if (craterName) break;
  }
  // VolcanoObservation > OtherObservation の "火口：" からも取得
  if (!craterName) {
    const otherObs = str(dig(obs, "OtherObservation"));
    const match = otherObs.match(/火口[：:](.+?)[\n\r]/);
    if (match) craterName = match[1].trim();
  }

  return { plumeHeight, plumeHeightUnknown, plumeDirection, craterName };
}

// ── 電文タイプ別パーサ ──

/** VFVO50 / VFSVii: 噴火警報・予報 / 海上警報 */
function parseVolcanoAlert(
  report: unknown,
  headType: "VFVO50" | "VFSVii",
  msg: WsDataMessage,
): ParsedVolcanoAlertInfo {
  const base = extractVolcanoBase(report, headType, msg);
  const body = dig(report, "Body");

  // Head > Headline > Information (対象火山) から Kind/LastKind を取得
  const headInfo = dig(report, "Head", "Headline", "Information");
  const headInfoList = Array.isArray(headInfo) ? headInfo : headInfo ? [headInfo] : [];

  let alertLevelCode: string | null = null;
  let previousLevelCode: string | null = null;
  let condition = "";
  let warningKind = "";
  let isMarine = false;

  // Body > VolcanoInfo (対象火山) からも取得
  const volcanoInfos = dig(body, "VolcanoInfo");
  const infos = Array.isArray(volcanoInfos) ? volcanoInfos : volcanoInfos ? [volcanoInfos] : [];
  for (const vi of infos) {
    const viType = str(dig(vi, "@_type"));
    if (viType.includes("対象火山")) {
      const items = dig(vi, "Item");
      const itemList = Array.isArray(items) ? items : items ? [items] : [];
      const item = itemList[0];
      if (item) {
        const kind = dig(item, "Kind");
        const kindObj = Array.isArray(kind) ? kind[0] : kind;
        alertLevelCode = str(dig(kindObj, "Code")) || null;
        condition = str(dig(kindObj, "Condition"));
        warningKind = str(dig(kindObj, "Name"));

        const lastKind = dig(item, "LastKind");
        const lastKindObj = Array.isArray(lastKind) ? lastKind[0] : lastKind;
        previousLevelCode = str(dig(lastKindObj, "Code")) || null;
      }
    }
    // 海上警報判定
    if (viType.includes("海上")) {
      isMarine = true;
    }
  }

  // Head の Information からも海上判定
  for (const info of headInfoList) {
    const infoType = str(dig(info, "@_type"));
    if (infoType.includes("海上")) {
      isMarine = true;
      // 海上電文の場合、alertLevelCode を Head から補完
      if (!alertLevelCode) {
        const items = dig(info, "Item");
        const itemList = Array.isArray(items) ? items : items ? [items] : [];
        const item = itemList[0];
        if (item) {
          const kind = dig(item, "Kind");
          const kindObj = Array.isArray(kind) ? kind[0] : kind;
          alertLevelCode = str(dig(kindObj, "Code")) || null;
          condition = condition || str(dig(kindObj, "Condition"));
          warningKind = warningKind || str(dig(kindObj, "Name"));

          const lastKind = dig(item, "LastKind");
          const lastKindObj = Array.isArray(lastKind) ? lastKind[0] : lastKind;
          previousLevelCode = previousLevelCode || str(dig(lastKindObj, "Code")) || null;
        }
      }
    }
  }

  const alertLevel = alertLevelCode ? levelCodeToNumber(alertLevelCode) : null;
  const action = conditionToAction(condition, base.infoType);

  // 対象市町村
  const municipalities: VolcanoMunicipality[] = [];
  for (const vi of infos) {
    const viType = str(dig(vi, "@_type"));
    if (viType.includes("対象市町村等")) {
      const items = dig(vi, "Item");
      const itemList = Array.isArray(items) ? items : items ? [items] : [];
      for (const item of itemList) {
        const kind = dig(item, "Kind");
        const kindObj = Array.isArray(kind) ? kind[0] : kind;
        const kindName = str(dig(kindObj, "Name"));
        const areas = dig(item, "Areas");
        const areaList = dig(areas, "Area");
        const areaArr = Array.isArray(areaList) ? areaList : areaList ? [areaList] : [];
        for (const area of areaArr) {
          municipalities.push({
            name: str(dig(area, "Name")),
            code: str(dig(area, "Code")),
            kind: kindName,
          });
        }
      }
    }
  }

  // VolcanoInfoContent
  const content = dig(body, "VolcanoInfoContent");
  const bodyText = str(dig(content, "VolcanoActivity"));
  const preventionText = str(dig(content, "VolcanoPrevention"));

  return {
    ...base,
    kind: "alert",
    type: headType,
    alertLevel,
    alertLevelCode,
    action,
    previousLevelCode,
    warningKind,
    municipalities,
    bodyText,
    preventionText,
    isMarine,
  };
}

/** VFVO52 / VFVO56: 噴火に関する火山観測報 / 噴火速報 */
function parseVolcanoEruption(
  report: unknown,
  headType: "VFVO52" | "VFVO56",
  msg: WsDataMessage,
): ParsedVolcanoEruptionInfo {
  const base = extractVolcanoBase(report, headType, msg);
  const body = dig(report, "Body");

  // Kind (現象コード)
  let phenomenonCode = "";
  let phenomenonName = "";
  const volcanoInfos = dig(body, "VolcanoInfo");
  const infos = Array.isArray(volcanoInfos) ? volcanoInfos : volcanoInfos ? [volcanoInfos] : [];
  for (const vi of infos) {
    const items = dig(vi, "Item");
    const itemList = Array.isArray(items) ? items : items ? [items] : [];
    for (const item of itemList) {
      const kind = dig(item, "Kind");
      const kindObj = Array.isArray(kind) ? kind[0] : kind;
      const code = str(dig(kindObj, "Code"));
      if (code) {
        phenomenonCode = code;
        phenomenonName = str(dig(kindObj, "Name"));
        break;
      }
    }
    if (phenomenonCode) break;
  }

  const plume = extractPlumeObservation(body);

  // VolcanoInfoContent
  const content = dig(body, "VolcanoInfoContent");
  const bodyText = str(dig(content, "VolcanoActivity"));

  return {
    ...base,
    kind: "eruption",
    type: headType,
    phenomenonCode,
    phenomenonName,
    craterName: plume.craterName,
    plumeHeight: plume.plumeHeight,
    plumeHeightUnknown: plume.plumeHeightUnknown,
    plumeDirection: plume.plumeDirection,
    isFlashReport: headType === "VFVO56",
    bodyText,
  };
}

/** VFVO53 / VFVO54 / VFVO55: 降灰予報 */
function parseVolcanoAshfall(
  report: unknown,
  headType: "VFVO53" | "VFVO54" | "VFVO55",
  msg: WsDataMessage,
): ParsedVolcanoAshfallInfo {
  const base = extractVolcanoBase(report, headType, msg);
  const body = dig(report, "Body");

  const subKindMap: Record<string, "scheduled" | "rapid" | "detailed"> = {
    VFVO53: "scheduled",
    VFVO54: "rapid",
    VFVO55: "detailed",
  };

  // AshInfos から降灰予報データを抽出
  const ashForecasts: AshForecastPeriod[] = [];
  const ashInfos = dig(body, "AshInfos");
  if (ashInfos) {
    const ashInfoList = dig(ashInfos, "AshInfo");
    const ashArr = Array.isArray(ashInfoList) ? ashInfoList : ashInfoList ? [ashInfoList] : [];
    for (const ashInfo of ashArr) {
      const startTime = str(dig(ashInfo, "StartTime"));
      const endTime = str(dig(ashInfo, "EndTime"));
      const areas: AshArea[] = [];

      const items = dig(ashInfo, "Item");
      const itemList = Array.isArray(items) ? items : items ? [items] : [];
      for (const item of itemList) {
        const kind = dig(item, "Kind");
        const kindObj = Array.isArray(kind) ? kind[0] : kind;
        const ashName = str(dig(kindObj, "Name"));
        const ashCode = str(dig(kindObj, "Code"));
        const sizeVal = str(dig(kindObj, "Property", "Size", "#text") || dig(kindObj, "Property", "Size"));
        const thickness = sizeVal ? parseFloat(sizeVal) : null;

        const itemAreas = dig(item, "Areas");
        const areaList = dig(itemAreas, "Area");
        const areaArr = Array.isArray(areaList) ? areaList : areaList ? [areaList] : [];
        for (const area of areaArr) {
          areas.push({
            name: str(dig(area, "Name")),
            code: str(dig(area, "Code")),
            ashCode,
            ashName,
            thickness: thickness != null && !isNaN(thickness) ? thickness : null,
          });
        }
      }

      if (startTime || endTime) {
        ashForecasts.push({ startTime, endTime, areas });
      }
    }
  }

  // 噴煙情報
  const plume = extractPlumeObservation(body);

  // VolcanoInfoContent
  const content = dig(body, "VolcanoInfoContent");
  const bodyText = str(dig(content, "VolcanoActivity") || dig(content, "VolcanoHeadline"));

  return {
    ...base,
    kind: "ashfall",
    type: headType,
    subKind: subKindMap[headType],
    craterName: plume.craterName,
    ashForecasts,
    plumeHeight: plume.plumeHeight,
    plumeDirection: plume.plumeDirection,
    bodyText,
  };
}

/** VZVO40 / VFVO51: 火山に関するお知らせ / 火山の状況に関する解説情報 */
function parseVolcanoText(
  report: unknown,
  headType: "VZVO40" | "VFVO51",
  msg: WsDataMessage,
): ParsedVolcanoTextInfo {
  const base = extractVolcanoBase(report, headType, msg);
  const head = dig(report, "Head");
  const body = dig(report, "Body");

  // VZVO40 は Body > Text 直下にテキスト
  // VFVO51 は Body > VolcanoInfoContent > VolcanoActivity にテキスト
  let bodyText = "";
  if (headType === "VZVO40") {
    bodyText = str(dig(body, "Text"));
  } else {
    const content = dig(body, "VolcanoInfoContent");
    bodyText = str(dig(content, "VolcanoActivity"));
  }

  // レベル情報 (VFVO51 のみ)
  let alertLevelCode: string | null = null;
  if (headType === "VFVO51") {
    const headInfo = dig(head, "Headline", "Information");
    const headInfoList = Array.isArray(headInfo) ? headInfo : headInfo ? [headInfo] : [];
    for (const info of headInfoList) {
      const infoType = str(dig(info, "@_type"));
      if (infoType.includes("対象火山")) {
        const items = dig(info, "Item");
        const itemList = Array.isArray(items) ? items : items ? [items] : [];
        // 最も高いレベルを採用（複数火山のケース）
        // レベルコード 11〜15 のみ比較対象とし、海上警報コード等は除外
        for (const item of itemList) {
          const kind = dig(item, "Kind");
          const kindObj = Array.isArray(kind) ? kind[0] : kind;
          const code = str(dig(kindObj, "Code"));
          if (code && levelCodeToNumber(code) != null) {
            if (!alertLevelCode || Number(code) > Number(alertLevelCode)) {
              alertLevelCode = code;
            }
          }
        }
      }
    }
  }

  const alertLevel = alertLevelCode ? levelCodeToNumber(alertLevelCode) : null;

  // 臨時判定: タイトルに「臨時」を含むか InfoKind に「臨時」を含む
  const infoKind = str(dig(head, "InfoKind"));
  const isExtraordinary = base.title.includes("臨時") || infoKind.includes("臨時");

  // NextAdvisory
  const nextAdvisory = str(dig(body, "NextAdvisory"));

  return {
    ...base,
    kind: "text",
    type: headType,
    alertLevel,
    alertLevelCode,
    isExtraordinary,
    bodyText,
    nextAdvisory: nextAdvisory ? nextAdvisory.trim() : null,
  };
}

/** VFVO60: 推定噴煙流向報 */
function parseVolcanoPlume(
  report: unknown,
  msg: WsDataMessage,
): ParsedVolcanoPlumeInfo {
  const base = extractVolcanoBase(report, "VFVO60", msg);
  const body = dig(report, "Body");

  // Kind (現象コード)
  let phenomenonCode = "";
  const volcanoInfos = dig(body, "VolcanoInfo");
  const infos = Array.isArray(volcanoInfos) ? volcanoInfos : volcanoInfos ? [volcanoInfos] : [];
  for (const vi of infos) {
    const items = dig(vi, "Item");
    const itemList = Array.isArray(items) ? items : items ? [items] : [];
    for (const item of itemList) {
      const kind = dig(item, "Kind");
      const kindObj = Array.isArray(kind) ? kind[0] : kind;
      const code = str(dig(kindObj, "Code"));
      if (code) { phenomenonCode = code; break; }
    }
    if (phenomenonCode) break;
  }

  const plume = extractPlumeObservation(body);

  // WindAboveCrater
  const windProfile: WindProfileEntry[] = [];
  const obs = dig(body, "VolcanoObservation");
  const windAbove = dig(obs, "WindAboveCrater");
  if (windAbove) {
    const elements = dig(windAbove, "WindAboveCraterElements");
    const elemArr = Array.isArray(elements) ? elements : elements ? [elements] : [];
    for (const elem of elemArr) {
      const altitude = str(
        dig(elem, "jmx_eb:WindHeightAboveSeaLevel", "@_description") ||
        dig(elem, "WindHeightAboveSeaLevel", "@_description") ||
        dig(elem, "@_description")
      );
      const degreeVal = str(
        dig(elem, "jmx_eb:WindDegree", "#text") ||
        dig(elem, "jmx_eb:WindDegree") ||
        dig(elem, "WindDegree", "#text") ||
        dig(elem, "WindDegree")
      );
      const speedVal = str(
        dig(elem, "jmx_eb:WindSpeed", "#text") ||
        dig(elem, "jmx_eb:WindSpeed") ||
        dig(elem, "WindSpeed", "#text") ||
        dig(elem, "WindSpeed")
      );
      const degree = degreeVal ? parseInt(degreeVal, 10) : null;
      const speed = speedVal ? parseInt(speedVal, 10) : null;
      windProfile.push({
        altitude: altitude || "",
        degree: degree != null && !isNaN(degree) ? degree : null,
        speed: speed != null && !isNaN(speed) ? speed : null,
      });
    }
  }

  const bodyText = str(dig(body, "Text"));

  return {
    ...base,
    kind: "plume",
    type: "VFVO60",
    phenomenonCode,
    craterName: plume.craterName,
    plumeHeight: plume.plumeHeight,
    plumeDirection: plume.plumeDirection,
    windProfile,
    bodyText,
  };
}

// ── 公開 API ──

/** 火山電文をパース (全10種類の head.type に対応) */
export function parseVolcanoTelegram(
  msg: WsDataMessage,
): ParsedVolcanoInfo | null {
  try {
    const xmlStr = decodeBody(msg);
    const parsed = parseXml(xmlStr);
    const report = findReport(parsed);

    if (!report) {
      log.debug("Report ノードが見つかりません (火山電文)");
      return null;
    }

    const headType = msg.head.type as VolcanoHeadType;

    switch (headType) {
      case "VFVO50":
        return parseVolcanoAlert(report, "VFVO50", msg);
      case "VFSVii":
        return parseVolcanoAlert(report, "VFSVii", msg);
      case "VFVO52":
        return parseVolcanoEruption(report, "VFVO52", msg);
      case "VFVO56":
        return parseVolcanoEruption(report, "VFVO56", msg);
      case "VFVO53":
        return parseVolcanoAshfall(report, "VFVO53", msg);
      case "VFVO54":
        return parseVolcanoAshfall(report, "VFVO54", msg);
      case "VFVO55":
        return parseVolcanoAshfall(report, "VFVO55", msg);
      case "VZVO40":
        return parseVolcanoText(report, "VZVO40", msg);
      case "VFVO51":
        return parseVolcanoText(report, "VFVO51", msg);
      case "VFVO60":
        return parseVolcanoPlume(report, msg);
      default:
        log.debug(`未対応の火山電文タイプ: ${headType}`);
        return null;
    }
  } catch (err) {
    log.error(
      `火山電文パースエラー: ${err instanceof Error ? err.message : err}`
    );
    return null;
  }
}
