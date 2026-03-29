import type { PresentationEvent } from "../../engine/presentation/types";
import type { SummaryModel, SummaryToken, SummaryPriority } from "./types";
import { visualWidth } from "../formatter";

// ── Helper ──

function token(
  id: string,
  text: string,
  priority: SummaryPriority,
  dropMode: "never" | "shorten" | "drop",
  shortText?: string,
): SummaryToken {
  const minW = shortText != null ? visualWidth(shortText) : visualWidth(text);
  const prefW = visualWidth(text);
  return { id, text, shortText, priority, minWidth: minW, preferredWidth: prefW, dropMode };
}

/** 地方・県名の末尾パターンを除去する簡易短縮 */
function shortenHypocenter(name: string): string {
  return name
    .replace(/地方$/, "")
    .replace(/^.+県/, "");
}

/**
 * areaNames を先頭 n 件で結合し、残りがあれば「ほかN」の shortText を返す。
 */
function topAreaTokenParts(
  names: string[],
  limit: number,
): { text: string; shortText?: string } | null {
  if (names.length === 0) return null;
  const top = names.slice(0, limit);
  const text = top.join(",");
  if (names.length > limit) {
    const short = `${top[0]}ほか${names.length - 1}`;
    return { text, shortText: short };
  }
  return { text };
}

// ── Domain builders ──

function buildEewTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];

  tokens.push(token("severity", model.severity, 0, "never"));

  // kind
  if (event.isCancellation) {
    tokens.push(token("kind", "EEW取消", 0, "never"));
  } else if (event.isWarning) {
    tokens.push(token("kind", "EEW警報", 0, "never"));
  } else {
    tokens.push(token("kind", "EEW予報", 0, "never"));
  }

  // serial
  if (model.serial) {
    tokens.push(token("serial", model.serial, 1, "drop"));
  }

  // hypocenter
  if (event.hypocenterName) {
    const short = shortenHypocenter(event.hypocenterName);
    tokens.push(
      token("hypocenter", event.hypocenterName, 1, "shorten",
        short !== event.hypocenterName ? short : undefined),
    );
  }

  // maxInt
  const eewMaxInt = event.forecastMaxInt ? `震度${event.forecastMaxInt}` : (model.maxInt ?? "震度-");
  tokens.push(token("maxInt", eewMaxInt, 0, "never"));

  // maxLgInt
  if (model.maxLgInt) {
    tokens.push(token("maxLgInt", model.maxLgInt, 2, "drop"));
  }

  // magnitude
  if (model.magnitude) {
    tokens.push(token("magnitude", model.magnitude, 2, "shorten", model.magnitude));
  }

  // depth
  if (event.depth) {
    tokens.push(token("depth", `深さ${event.depth}`, 3, "drop"));
  }

  // forecastAreaTop
  if (event.forecastAreaNames.length > 0) {
    const parts = topAreaTokenParts(event.forecastAreaNames, 3);
    if (parts) {
      tokens.push(token("forecastAreaTop", parts.text, 3, "drop"));
    }
  }

  return tokens;
}

function buildEarthquakeTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];
  const headType = event.type;

  tokens.push(token("severity", model.severity, 0, "never"));

  if (headType === "VXSE51") {
    // 震度速報
    tokens.push(token("type", "震度速報", 0, "never"));
    if (model.maxInt) tokens.push(token("maxInt", model.maxInt, 0, "never"));
    const parts = topAreaTokenParts(event.areaNames, 2);
    if (parts) tokens.push(token("topAreas", parts.text, 1, "shorten", parts.shortText));
    if (event.headline && event.headline.includes("津波")) {
      tokens.push(token("tsunami", event.headline, 2, "drop"));
    }
  } else if (headType === "VXSE52") {
    // 震源情報
    tokens.push(token("type", "震源情報", 0, "never"));
    if (event.hypocenterName) {
      const short = shortenHypocenter(event.hypocenterName);
      tokens.push(token("hypocenter", event.hypocenterName, 1, "shorten",
        short !== event.hypocenterName ? short : undefined));
    }
    if (model.magnitude) tokens.push(token("magnitude", model.magnitude, 1, "shorten", model.magnitude));
    if (event.depth) tokens.push(token("depth", `深さ${event.depth}`, 2, "drop"));
    if (event.headline && event.headline.includes("津波")) {
      tokens.push(token("tsunami", event.headline, 2, "drop"));
    }
  } else if (headType === "VXSE53") {
    // 震源・震度情報
    tokens.push(token("type", "震源・震度情報", 0, "shorten", "震源震度"));
    if (event.hypocenterName) {
      const short = shortenHypocenter(event.hypocenterName);
      tokens.push(token("hypocenter", event.hypocenterName, 1, "shorten",
        short !== event.hypocenterName ? short : undefined));
    }
    if (model.magnitude) tokens.push(token("magnitude", model.magnitude, 1, "shorten", model.magnitude));
    if (model.maxInt) tokens.push(token("maxInt", model.maxInt, 0, "never"));
    if (model.maxLgInt) tokens.push(token("maxLgInt", model.maxLgInt, 2, "drop"));
    if (event.headline && event.headline.includes("津波")) {
      tokens.push(token("tsunami", event.headline, 2, "drop"));
    }
    const parts = topAreaTokenParts(event.areaNames, 2);
    if (parts) tokens.push(token("topAreas", parts.text, 2, "drop"));
  } else if (headType === "VXSE61") {
    // 遠地地震
    tokens.push(token("type", "遠地地震情報", 0, "shorten", "遠地地震"));
    if (event.hypocenterName) {
      const short = shortenHypocenter(event.hypocenterName);
      tokens.push(token("hypocenter", event.hypocenterName, 1, "shorten",
        short !== event.hypocenterName ? short : undefined));
    }
    if (model.magnitude) tokens.push(token("magnitude", model.magnitude, 1, "shorten", model.magnitude));
    if (model.maxInt) tokens.push(token("maxInt", model.maxInt, 0, "never"));
  } else {
    // その他の地震電文
    tokens.push(token("type", event.title, 0, "shorten"));
    if (event.hypocenterName) {
      const short = shortenHypocenter(event.hypocenterName);
      tokens.push(token("hypocenter", event.hypocenterName, 1, "shorten",
        short !== event.hypocenterName ? short : undefined));
    }
    if (model.maxInt) tokens.push(token("maxInt", model.maxInt, 0, "never"));
  }

  return tokens;
}

function buildTsunamiTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];

  tokens.push(token("severity", model.severity, 0, "never"));

  // bannerKind: headline から抽出、なければ title
  const bannerKind = event.headline ?? event.title;
  tokens.push(token("bannerKind", bannerKind, 0, "never"));

  // topAreas
  const parts = topAreaTokenParts(event.forecastAreaNames, 2);
  if (parts) tokens.push(token("topAreas", parts.text, 1, "shorten", parts.shortText));

  // areaCount
  if (event.forecastAreaCount > 0) {
    tokens.push(token("areaCount", `(${event.forecastAreaCount}地域)`, 1, "drop"));
  }

  // hypocenter
  if (event.hypocenterName) {
    tokens.push(token("hypocenter", event.hypocenterName, 3, "drop"));
  }

  // magnitude
  if (model.magnitude) {
    tokens.push(token("magnitude", model.magnitude, 3, "drop"));
  }

  return tokens;
}

function buildVolcanoTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];
  const headType = event.type;

  tokens.push(token("severity", model.severity, 0, "never"));

  if (headType === "VFVO50" || headType.startsWith("VFSV")) {
    // 火山警報
    tokens.push(token("type", event.title, 0, "shorten"));
    if (event.volcanoName) tokens.push(token("volcanoName", event.volcanoName, 0, "never"));
    if (event.alertLevel != null) {
      tokens.push(token("alertLevel", `Lv${event.alertLevel}`, 0, "shorten"));
    }
    if (event.areaCount > 0) {
      tokens.push(token("areaCount", `対象${event.areaCount}市町村`, 2, "drop"));
    }
  } else if (headType === "VFVO52" || headType === "VFVO56") {
    // 噴火速報 / 噴火情報
    tokens.push(token("type", event.title, 0, "never"));
    if (event.volcanoName) tokens.push(token("volcanoName", event.volcanoName, 0, "never"));
    // phenomenon/plumeHeight: try to extract from raw if available
    // Phase 3 - use available info only
  } else if (headType === "VFVO53" || headType === "VFVO54" || headType === "VFVO55") {
    // 降灰
    tokens.push(token("type", event.title, 0, "shorten"));
    if (event.volcanoName) tokens.push(token("volcanoName", event.volcanoName, 0, "never"));
    if (event.areaCount > 0) {
      tokens.push(token("areaCount", `対象${event.areaCount}地域`, 1, "drop"));
    }
  } else if (headType === "VFVO51" || headType === "VZVO40") {
    // 火山テキスト
    tokens.push(token("type", event.title, 0, "shorten"));
    if (event.volcanoName) tokens.push(token("volcanoName", event.volcanoName, 0, "never"));
    if (event.headline) {
      tokens.push(token("headline", event.headline, 1, "shorten"));
    }
    if (event.alertLevel != null) {
      tokens.push(token("alertLevel", `Lv${event.alertLevel}`, 2, "drop"));
    }
  } else if (headType === "VFVO60") {
    // 噴煙流向
    tokens.push(token("type", event.title, 0, "shorten"));
    if (event.volcanoName) tokens.push(token("volcanoName", event.volcanoName, 0, "never"));
  } else {
    // fallback
    tokens.push(token("type", event.title, 0, "shorten"));
    if (event.volcanoName) tokens.push(token("volcanoName", event.volcanoName, 0, "never"));
  }

  return tokens;
}

function buildSeismicTextTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];

  tokens.push(token("severity", model.severity, 0, "never"));
  tokens.push(token("type", event.title, 0, "shorten"));
  if (event.headline) {
    tokens.push(token("headline", event.headline, 1, "shorten"));
  }

  return tokens;
}

function buildLgObservationTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];

  tokens.push(token("severity", model.severity, 0, "never"));
  tokens.push(token("type", "長周期地震動観測情報", 0, "shorten", "長周期観測"));

  if (event.hypocenterName) {
    const short = shortenHypocenter(event.hypocenterName);
    tokens.push(token("hypocenter", event.hypocenterName, 1, "shorten",
      short !== event.hypocenterName ? short : undefined));
  }

  if (model.maxLgInt) {
    // "長周期4" → shortText "L4"
    const lgNum = model.maxLgInt.replace("長周期", "");
    tokens.push(token("maxLgInt", model.maxLgInt, 0, "shorten", `L${lgNum}`));
  }

  if (model.maxInt) {
    tokens.push(token("maxInt", model.maxInt, 1, "shorten"));
  }

  const parts = topAreaTokenParts(event.observationNames, 2);
  if (parts) tokens.push(token("topAreas", parts.text, 2, "drop"));

  if (model.magnitude) {
    tokens.push(token("magnitude", model.magnitude, 2, "drop"));
  }

  if (event.depth) {
    tokens.push(token("depth", `深さ${event.depth}`, 3, "drop"));
  }

  return tokens;
}

function buildNankaiTroughTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];

  tokens.push(token("severity", model.severity, 0, "never"));
  tokens.push(token("type", "南海トラフ臨時情報", 0, "shorten", "南海トラフ"));

  if (event.headline) {
    tokens.push(token("headline", event.headline, 1, "shorten"));
  }

  return tokens;
}

function buildRawTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  const tokens: SummaryToken[] = [];

  tokens.push(token("severity", model.severity, 0, "never"));
  tokens.push(token("RAW", "RAW", 0, "never"));
  tokens.push(token("type", event.type, 0, "never"));

  if (event.title) {
    tokens.push(token("title", event.title, 1, "shorten"));
  }

  if (event.headline) {
    tokens.push(token("headline", event.headline, 2, "drop"));
  }

  if (event.publishingOffice) {
    tokens.push(token("office", event.publishingOffice, 3, "drop"));
  }

  return tokens;
}

// ── Public API ──

export function buildSummaryTokens(event: PresentationEvent, model: SummaryModel): SummaryToken[] {
  switch (model.domain) {
    case "eew":
      return buildEewTokens(event, model);
    case "earthquake":
      return buildEarthquakeTokens(event, model);
    case "tsunami":
      return buildTsunamiTokens(event, model);
    case "volcano":
      return buildVolcanoTokens(event, model);
    case "seismicText":
      return buildSeismicTextTokens(event, model);
    case "lgObservation":
      return buildLgObservationTokens(event, model);
    case "nankaiTrough":
      return buildNankaiTroughTokens(event, model);
    case "raw":
      return buildRawTokens(event, model);
  }
}
