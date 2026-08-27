import chalk from "chalk";
import { ParsedTyphoonAnalysis, TyphoonFrame } from "../types";
import * as theme from "./theme";
import {
  FrameLevel, getFrameWidth, SEVERITY_LABELS,
  frameTopColored, frameBottomColored, frameLineColored, frameDividerColored,
  createRenderBuffer, flushWithRecap, pushWrappedFrameLine, pushWrappedFrameTitle,
  renderFooter, visualWidth,
} from "./formatter";
import { getDisplaySeverityText } from "./weather-warning-level-theme";
import { pushFrameTable, FrameTableColumn } from "./frame-table-builder";
import { typhoonAnalysisFrameLevel } from "../engine/presentation/level-helpers";
import { movementSpeedQualitativeDisplay } from "../utils/numeric-special-value";

const WHITE_BORDER = chalk.rgb(232, 232, 232);

function classLabel(f: TyphoonFrame): string {
  const parts = [f.typhoonClass.intensity, f.typhoonClass.size, f.typhoonClass.category]
    .filter((x): x is string => !!x);
  return parts.join(" ") || "―";
}

function pushConfirmedBlock(
  buf: ReturnType<typeof createRenderBuffer>, level: FrameLevel, color: (s: string) => string,
  width: number, f: TyphoonFrame, heading: string,
): void {
  buf.push(frameDividerColored(level, color, width));
  pushWrappedFrameLine(
    buf,
    level,
    { width, purpose: "type", borderColor: color },
    `  ${chalk.bold.cyan(`▸ ${heading}`)}`,
  );
  const c = f.center;
  const qualitativeSpeed = movementSpeedQualitativeDisplay(c.moveSpeedKmhValue);
  const movement = c.moveDirection
    ? `移動 ${c.moveDirection} ${qualitativeSpeed?.text ?? `${c.moveSpeedKmh ?? "―"}km/h`}`
    : qualitativeSpeed == null ? "" : `移動 ${qualitativeSpeed.text}`;
  const lines = [
    `${classLabel(f)}   ${c.location ?? ""}`.trim(),
    [c.pressureHpa != null ? `中心気圧 ${c.pressureHpa} hPa` : "",
     movement]
      .filter(Boolean).join("   "),
    f.wind?.maxWindMs != null
      ? `最大風速 ${f.wind.maxWindMs} m/s` + (f.wind.maxGustMs != null ? ` (瞬間 ${f.wind.maxGustMs} m/s)` : "")
      : "",
    windAreaLine(f),
  ].filter(Boolean);
  for (const line of lines) {
    pushWrappedFrameLine(
      buf,
      level,
      { width, purpose: "prose", borderColor: color },
      `    ${chalk.white(line)}`,
    );
  }
}

function radius(area: { axes: { radiusKm: number | null }[] } | null): string {
  if (area == null) return "なし";
  const max = Math.max(...area.axes.map((a) => a.radiusKm ?? 0));
  return max > 0 ? `${max}km` : "なし";
}

function windAreaLine(f: TyphoonFrame): string {
  if (f.wind == null) return "";
  return `強風域 ${radius(f.wind.galeArea)} / 暴風域 ${radius(f.wind.stormArea)}`;
}

function rightAlign(values: string[]): string[] {
  const w = Math.max(0, ...values.map(visualWidth));
  return values.map((v) => " ".repeat(w - visualWidth(v)) + v);
}

export function displayTyphoonAnalysisInfo(info: ParsedTyphoonAnalysis): void {
  const level = typhoonAnalysisFrameLevel(info);
  const width = getFrameWidth();
  const isCancel = info.infoType === "取消";
  const color = isCancel ? getDisplaySeverityText("release") : WHITE_BORDER;

  const buf = createRenderBuffer();
  buf.pushEmpty();
  buf.push(frameTopColored(level, color, width));
  if (info.isTest) {
    if (chalk.level === 0) {
      buf.push(frameLineColored(level, color, " テスト電文 ", width));
    } else {
      pushWrappedFrameLine(
        buf,
        level,
        { width, purpose: "type", borderColor: color },
        theme.getRoleChalk("testBadge")(" テスト電文 "),
      );
    }
  }
  const nameLabel = info.name?.name
    ? `${info.name.name}${info.name.number ? ` (台風${info.name.number.slice(2)}号)` : ""}`
    : info.name?.remark || "";
  const titleBasePart = {
    text: chalk.bold("台風解析・予報情報"), priority: 0 as const, omission: "never" as const,
  };
  const titleInfoPart = {
    text: chalk.gray(info.infoType), priority: 1 as const, omission: "never" as const,
  };
  const titleSeverityPart = {
    text: chalk.gray(SEVERITY_LABELS[level]), priority: 2 as const, omission: "drop" as const,
  };
  const titleNamePart = nameLabel === "" ? null : {
    text: chalk.white(nameLabel), priority: 1 as const, omission: "never" as const,
  };
  const titleParts = titleNamePart == null
    ? [titleBasePart, titleInfoPart, titleSeverityPart]
    : [titleBasePart, titleInfoPart, titleSeverityPart, titleNamePart];
  pushWrappedFrameTitle(buf, level, { width, borderColor: color }, titleParts);

  if (isCancel) {
    buf.push(frameDividerColored(level, color, width));
    pushWrappedFrameLine(
      buf,
      level,
      { width, purpose: "diagnostic", borderColor: color },
      chalk.gray("この台風情報は取り消されました"),
    );
    renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, buf, color);
    buf.push(frameBottomColored(level, color, width));
    buf.pushEmpty();
    flushWithRecap(buf, level, width, color);
    return;
  }

  const confirmed = info.frames.filter((f) => f.kind === "実況" || f.kind === "推定");
  for (const f of confirmed) {
    const heading = f.kind === "実況"
      ? `実況 (${f.validTime.slice(5, 16).replace("T", " ")})`
      : f.label.replace(/\s+/g, "");
    pushConfirmedBlock(buf, level, color, width, f, heading);
  }

  const forecasts = info.frames.filter((f) => f.kind === "予報");
  if (forecasts.length > 0) {
    buf.push(frameDividerColored(level, color, width));
    pushWrappedFrameLine(
      buf,
      level,
      { width, purpose: "type", borderColor: color },
      `  ${chalk.bold.cyan("▸ ５日予報")}`,
    );
    const columns: FrameTableColumn[] = [
      { header: "時刻" }, { header: "階級" }, { header: "中心位置" },
      { header: "気圧" }, { header: "最大風速" }, { header: "予報円" },
    ];
    const press = rightAlign(forecasts.map((f) => f.center.pressureHpa != null ? String(f.center.pressureHpa) : "―"));
    const wind = rightAlign(forecasts.map((f) =>
      f.wind?.maxWindMs != null ? `${f.wind.maxWindMs}(${f.wind.maxGustMs ?? "―"})` : "―"));
    const circ = rightAlign(forecasts.map((f) =>
      f.center.forecastCircleRadiusKm != null ? `${f.center.forecastCircleRadiusKm}km` : "―"));
    const rows = forecasts.map((f, i) => [
      f.label.replace(/予報\s*/, "+").replace("時間後", "h"),
      f.typhoonClass.category?.replace(/[（(].*/, "") ?? "―",
      f.center.location ?? "―",
      press[i], wind[i], circ[i],
    ]);
    pushFrameTable(buf, level, width, columns, rows, color, 6);
  }

  renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, buf, color);
  buf.push(frameBottomColored(level, color, width));
  buf.pushEmpty();
  flushWithRecap(buf, level, width, color);
}
