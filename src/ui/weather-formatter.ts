import chalk from "chalk";
import {
  ParsedWeatherWarning,
  WeatherAreaLayer,
  WeatherItem,
  WeatherKind,
  WeatherSeverity,
  Vpws50Diff,
} from "../types";
import * as theme from "./theme";
import {
  FrameLevel,
  getFrameWidth,
  SEVERITY_LABELS,
  frameTop,
  frameLine,
  frameDivider,
  frameBottom,
  frameTopColored,
  frameLineColored,
  frameDividerColored,
  frameBottomColored,
  createRenderBuffer,
  flushWithRecap,
  wrapFrameLines,
  wrapFrameLinesColored,
  renderFooter,
} from "./formatter";
import {
  drawSeverityBanner,
  getDisplaySeverityText,
} from "./weather-warning-level-theme";
import { weatherFrameLevel } from "../engine/presentation/level-helpers";
import { selectPreferredWeatherLayer } from "../dmdata/weather-parser";
import {
  displayVpws50List,
  displayVpws50Unchanged,
  hasForecastZoneLayer,
  aggregateVpws50ByForecastZone,
  vpws50BannerSeverity,
  buildVpws50BannerText,
} from "./weather-formatter-vpws50";

/** 電文タイプの日本語名 (気象警報・注意報) */
function weatherTypeLabel(type: string): string {
  const map: Record<string, string> = {
    VPWW55: "大雨警報・注意報",
    VPWW56: "土砂災害警戒情報",
    VPWW57: "高潮警報・注意報",
    VPWW58: "暴風・暴風雪警報・注意報",
    VPWW59: "波浪警報・注意報",
    VPWW60: "大雪警報・注意報",
    VPWW61: "その他気象警報・注意報",
    VPWS50: "気象警報・注意報（全国集約）",
  };
  return map[type] ?? "気象警報・注意報";
}

/** Severity の見出しラベル */
const SEVERITY_HEADER: Record<WeatherSeverity, string> = {
  specialWarning: "特別警報",
  warning: "警報",
  advisory: "注意報",
  release: "解除",
  unknown: "その他",
};

/** Severity の表示順 (上から重大度順) */
const SEVERITY_DISPLAY_ORDER: WeatherSeverity[] = [
  "specialWarning",
  "warning",
  "advisory",
  "release",
  "unknown",
];

/** 1 つの severity グループ内で表示する最大地域数 */
const MAX_AREAS_PER_SEVERITY_GROUP = 30;

/** layer の items 数がこれを超えると上位レイヤーにフォールバック (VPWS50 等の大量集約対策) */
const PREFERRED_LAYER_AREA_THRESHOLD = 200;

/**
 * 表示用レイヤーを選ぶ。最も粒度の細かい層を優先するが、items 数が閾値を超える場合
 * (VPWS50 など全国集約電文) は上位レイヤーにフォールバックして表示量を抑える。
 */
function pickDisplayableLayer(
  layers: import("../types").WeatherAreaLayer[],
  finePreferred: import("../types").WeatherAreaLayer | undefined,
): import("../types").WeatherAreaLayer | undefined {
  if (!finePreferred) return undefined;
  if (finePreferred.items.length <= PREFERRED_LAYER_AREA_THRESHOLD) {
    return finePreferred;
  }
  // 上位レイヤーへフォールバック: まとめた地域 → 一次細分 → 府県予報区 → 最後の選択肢
  const grouped =
    layers.find((l) => l.type.includes("市町村等をまとめた地域等")) ??
    layers.find((l) => l.type.includes("一次細分区域等")) ??
    layers.find((l) => l.type.includes("府県予報区等")) ??
    finePreferred;
  // 上位レイヤーも閾値を超える場合は finePreferred で諦める (省略でカバー)
  return grouped.items.length <= PREFERRED_LAYER_AREA_THRESHOLD
    ? grouped
    : finePreferred;
}

/** Severity に応じた色付け */
function severityColor(severity: WeatherSeverity): (s: string) => string {
  switch (severity) {
    case "specialWarning":
      return chalk.bgRed.white.bold;
    case "warning":
      return chalk.yellow.bold;
    case "advisory":
      return chalk.cyan;
    case "release":
      return chalk.gray;
    default:
      return chalk.white;
  }
}

/** Severity の優先度ランク (高いほど重大) */
const SEVERITY_RANK: Record<WeatherSeverity, number> = {
  specialWarning: 4,
  warning: 3,
  advisory: 2,
  release: 1,
  unknown: 0,
};

/** Item の中で最も重大な severity を返す */
function itemMaxSeverity(item: WeatherItem): WeatherSeverity {
  let max: WeatherSeverity = "unknown";
  for (const k of item.kinds) {
    if (SEVERITY_RANK[k.severity] > SEVERITY_RANK[max]) max = k.severity;
  }
  return max;
}

/** Item の Kind 群を「警報名(severity)」形式で整形 */
function formatKinds(kinds: WeatherKind[]): string {
  return kinds
    .map((k) => {
      const color = severityColor(k.severity);
      return color(k.name);
    })
    .join("、");
}

/**
 * 階層内の Items を severity 別にグルーピングする。
 * 同じ severity の Item が複数あれば配列にまとめる。
 */
function groupItemsBySeverity(
  layer: WeatherAreaLayer,
): Map<WeatherSeverity, WeatherItem[]> {
  const grouped = new Map<WeatherSeverity, WeatherItem[]>();
  for (const item of layer.items) {
    const sev = itemMaxSeverity(item);
    const list = grouped.get(sev) ?? [];
    list.push(item);
    grouped.set(sev, list);
  }
  return grouped;
}

/**
 * normal モード: フレーム付きで階層別に表示する。
 * 最も粒度の細かい階層を選び、severity 別にグルーピングして表示する。
 */
export function displayWeatherWarning(info: ParsedWeatherWarning, diff?: Vpws50Diff): void {
  // Plan-R1: VPWS50 で「変化なし + 再掲対象でない」場合はフレームを生成せず compact 1 行で早期 return
  // (フレームを描いてから内側で console.log すると外側がフレーム継続 flush するため、ここで逃がす)
  // displayVpws50Unchanged は仕様上常に info レベル (level 引数を持たない)
  if (info.type === "VPWS50" && diff?.isUnchanged && !diff.shouldRecap) {
    displayVpws50Unchanged(info);
    return;
  }

  let level = weatherFrameLevel(info);
  // Codex 最終レビュー F-1: processWeather の unsafe 昇格 (process-weather.ts) と同期。
  // unsafe (layer_missing 等) は maxDisplaySeverity=null で weatherFrameLevel が info に
  // 落ちるため、表示側でも frameLevel="warning" に補正する (安全側の情報を UI に届ける)
  if (info.type === "VPWS50" && diff?.confidence === "unsafe") level = "warning";
  const label = weatherTypeLabel(info.type);
  const width = getFrameWidth();

  // ── VPWS50 全国集約電文 専用パス ──
  // Plan-R2: VPWS50 専用 renderer に通す条件を拡張。
  // unsafe (layer 不在の可能性) と cancel rollback (layer 空の可能性) でも
  // VPWS50 専用分岐に入る必要がある (差分レンダラが現況/取消表示を担う)
  const isVpws50Special = info.type === "VPWS50" &&
    (diff?.confidence === "unsafe" || diff?.isCancelRollback === true);
  if (info.type === "VPWS50" && (hasForecastZoneLayer(info) || isVpws50Special)) {
    // normal: フレーム + ヘッダ準備 + リスト本体 + フッタ
    const buf = createRenderBuffer();

    // Phase C Task 8 配色言語 (VPWW/VPWP50 と共通、目視ゲート確定済み):
    //   取消                  → フレーム全体 release 単色 (二色割れさせない)
    //   平常 (maxDS null)     → フレーム全体 白系単色
    //   本文あり (maxDS・非取消) → 上辺+タイトル系 = maxDS 色 / section = section 色 /
    //                             footer 直前 divider + 下辺 = 白系
    const WHITE_BORDER = chalk.rgb(232, 232, 232);
    const isCancel = info.infoType === "取消";
    const maxDs = info.maxDisplaySeverity;
    const headColor: (s: string) => string =
      isCancel ? getDisplaySeverityText("release")
      : maxDs == null ? WHITE_BORDER
      : getDisplaySeverityText(maxDs);
    const tailColor: (s: string) => string =
      isCancel ? getDisplaySeverityText("release") : WHITE_BORDER;

    buf.pushEmpty();
    // バナー (発火条件は vpws50BannerSeverity: 取消 / added・upgraded の L5・L4・特別警報級 /
    // 初回起動の現況 max 同等。解除のみ・降格のみは発火しない)
    const bannerSeverity = vpws50BannerSeverity(info, diff);
    if (bannerSeverity != null) {
      const text = buildVpws50BannerText(bannerSeverity, info, diff, width - 2);
      const banner = drawSeverityBanner(bannerSeverity, text, width);
      buf.push(banner[0]);
      buf.push(banner[1]);
      buf.push(banner[2]);
    }

    buf.push(frameTopColored(level, headColor, width));

    if (info.isTest) {
      buf.push(frameLineColored(level, headColor, theme.getRoleChalk("testBadge")(" テスト電文 "), width));
    }

    const titleContent =
      chalk.bold(label) +
      chalk.gray(`  ${info.infoType}`) +
      chalk.gray(`  ${SEVERITY_LABELS[level]}`);
    buf.pushTitle(frameLineColored(level, headColor, titleContent, width));

    if (info.title && info.title !== label) {
      buf.push(frameLineColored(level, headColor, chalk.white(info.title), width));
    }

    // 取消ロールバック (diff.isCancelRollback) は VPWS50 専用 renderer に通すため、
    // ここでは既存 (旧パス) の取消短絡描画を行わない。
    // 取消は headColor = tailColor = release でフレーム全体単色。
    if (info.infoType === "取消" && !diff?.isCancelRollback) {
      buf.push(frameDividerColored(level, headColor, width));
      buf.push(frameLineColored(level, headColor, chalk.gray("この情報は取り消されました"), width));
      renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, buf, tailColor);
      buf.push(frameBottomColored(level, tailColor, width));
      buf.pushEmpty();
      flushWithRecap(buf, level, width, tailColor);
      return;
    }

    if (info.headline) {
      buf.push(frameDividerColored(level, headColor, width));
      const headlineWrapped = wrapFrameLinesColored(level, headColor, chalk.bold.white(info.headline), width);
      for (let i = 0; i < headlineWrapped.length; i++) {
        if (i === 0) buf.pushHeadline(headlineWrapped[i]);
        else buf.push(headlineWrapped[i]);
      }
    }

    // サマリー行 (集約電文なので「予報区」単位)。
    // diff が無い fallback パスでのみ表示する (差分パスは renderCurrentSummary に集約)
    if (diff == null) {
      const { rows } = aggregateVpws50ByForecastZone(info);
      const warnZones = rows.filter(
        (r) => r.maxSeverity === "warning" || r.maxSeverity === "specialWarning",
      ).length;
      const advZones = rows.filter((r) => r.maxSeverity === "advisory").length;
      const summaryParts: string[] = [];
      if (warnZones > 0) summaryParts.push(severityColor("warning")(`警報 ${warnZones}予報区`));
      if (advZones > 0) summaryParts.push(severityColor("advisory")(`注意報 ${advZones}予報区`));
      if (summaryParts.length > 0) {
        buf.push(frameDividerColored(level, tailColor, width));
        buf.push(frameLineColored(level, tailColor, summaryParts.join("  "), width));
      }
    }

    // リスト本体 (6 状態分岐 or legacy fallback) + 凡例 + 解除セクション
    // 各分岐内で必要に応じて divider を入れる (本文罫線 = tail 色を注入)
    displayVpws50List(info, diff, level, width, buf, { tail: tailColor });

    // フッタ (footer 直前 divider + 下辺 = tail 色)
    renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, buf, tailColor);
    buf.push(frameBottomColored(level, tailColor, width));
    buf.pushEmpty();
    flushWithRecap(buf, level, width, tailColor);
    return;
  }

  // compact モード
  const buf = createRenderBuffer();

  buf.pushEmpty();
  buf.push(frameTop(level, width));

  // テスト電文バッジ
  if (info.isTest) {
    buf.push(
      frameLine(level, theme.getRoleChalk("testBadge")(" テスト電文 "), width),
    );
  }

  // タイトル行
  const titleContent =
    chalk.bold(label) +
    chalk.gray(`  ${info.infoType}`) +
    chalk.gray(`  ${SEVERITY_LABELS[level]}`);
  buf.pushTitle(frameLine(level, titleContent, width));

  // info.title が typeLabel と異なる場合 (例: "島根県大雨警報・注意報") はサブタイトルとして表示
  if (info.title && info.title !== label) {
    buf.push(frameLine(level, chalk.white(info.title), width));
  }

  // 取消の場合はそれだけ目立たせて終了
  if (info.infoType === "取消") {
    buf.push(frameDivider(level, width));
    buf.push(
      frameLine(level, chalk.gray("この情報は取り消されました"), width),
    );
    renderFooter(level, info.type, info.reportDateTime, info.publishingOffice, width, buf);
    buf.push(frameBottom(level, width));
    buf.pushEmpty();
    flushWithRecap(buf, level, width);
    return;
  }

  // ヘッドライン (先頭行は pushHeadline で recap 用にマーク)
  if (info.headline) {
    buf.push(frameDivider(level, width));
    const headlineWrapped = wrapFrameLines(
      level,
      chalk.bold.white(info.headline),
      width,
    );
    for (let i = 0; i < headlineWrapped.length; i++) {
      if (i === 0) {
        buf.pushHeadline(headlineWrapped[i]);
      } else {
        buf.push(headlineWrapped[i]);
      }
    }
  }

  // サマリー行 (警報○地域 / 注意報○地域)
  const summaryParts: string[] = [];
  if (info.warningAreaCount > 0) {
    summaryParts.push(severityColor("warning")(`警報 ${info.warningAreaCount}地域`));
  }
  if (info.advisoryAreaCount > 0) {
    summaryParts.push(severityColor("advisory")(`注意報 ${info.advisoryAreaCount}地域`));
  }
  if (summaryParts.length > 0) {
    buf.push(frameDivider(level, width));
    buf.push(frameLine(level, summaryParts.join("  "), width));
  }

  // 階層別表示: 最も粒度の細かい層を選ぶ。ただし items が大量の場合 (VPWS50 集約等) は
  // 上位レイヤーにフォールバックして表示量を抑える。
  const fineLayer = selectPreferredWeatherLayer(info.layers);
  const displayLayer = pickDisplayableLayer(info.layers, fineLayer);
  if (displayLayer && displayLayer.items.length > 0) {
    buf.push(frameDivider(level, width));
    buf.push(
      frameLine(level, chalk.gray(`[${displayLayer.type}]`), width),
    );

    const grouped = groupItemsBySeverity(displayLayer);

    for (const severity of SEVERITY_DISPLAY_ORDER) {
      const items = grouped.get(severity);
      if (!items || items.length === 0) continue;

      const header = severityColor(severity)(`■ ${SEVERITY_HEADER[severity]}`);
      buf.push(frameLine(level, header, width));

      const limit = MAX_AREAS_PER_SEVERITY_GROUP;
      const visible = items.slice(0, limit);
      const omitted = items.length - visible.length;

      for (const item of visible) {
        const kindsText = formatKinds(item.kinds);
        const line = `  ${chalk.white(item.areaName)} — ${kindsText}`;
        for (const wrapped of wrapFrameLines(level, line, width)) {
          buf.push(wrapped);
        }
      }
      if (omitted > 0) {
        buf.push(
          frameLine(
            level,
            chalk.gray(`  ... 他 ${omitted} 地域 (省略)`),
            width,
          ),
        );
      }
    }
  }

  // 補足コメント
  if (info.comments.length > 0) {
    buf.push(frameDivider(level, width));
    for (const comment of info.comments) {
      if (comment.type) {
        buf.push(
          frameLine(level, chalk.gray(`[${comment.type}]`), width),
        );
      }
      for (const line of wrapFrameLines(level, chalk.white(comment.text), width)) {
        buf.push(line);
      }
    }
  }

  // フッター
  renderFooter(
    level,
    info.type,
    info.reportDateTime,
    info.publishingOffice,
    width,
    buf,
  );

  buf.push(frameBottom(level, width));
  buf.pushEmpty();

  flushWithRecap(buf, level, width);
}
