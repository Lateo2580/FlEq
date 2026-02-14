import chalk from "chalk";
import { ParsedEarthquakeInfo, ParsedEewInfo, WsDataMessage } from "../types";
import * as log from "../utils/logger";

/** 区切り線 */
function separator(char = "─", len = 60): string {
  return chalk.gray(char.repeat(len));
}

/** 震度に応じた色を返す */
export function intensityColor(intensity: string): chalk.Chalk {
  const norm = intensity.replace(/\s+/g, "");
  switch (norm) {
    case "1":
      return chalk.gray;
    case "2":
      return chalk.blue;
    case "3":
      return chalk.green;
    case "4":
      return chalk.yellow;
    case "5-":
    case "5弱":
      return chalk.rgb(255, 165, 0); // orange
    case "5+":
    case "5強":
      return chalk.rgb(255, 100, 0);
    case "6-":
    case "6弱":
      return chalk.redBright;
    case "6+":
    case "6強":
      return chalk.red;
    case "7":
      return chalk.bgRed.white;
    default:
      return chalk.white;
  }
}

/** 電文タイプの日本語名 */
function typeLabel(type: string): string {
  const map: Record<string, string> = {
    VXSE51: "震度速報",
    VXSE52: "震源に関する情報",
    VXSE53: "震源・震度に関する情報",
    VXSE56: "地震の活動状況等に関する情報",
    VXSE60: "地震の活動状況等に関する情報",
    VXSE61: "地震回数に関する情報",
    VTSE41: "津波警報・注意報・予報",
    VTSE51: "津波情報",
    VTSE52: "沖合の津波情報",
    VXSE43: "緊急地震速報（警報）",
    VXSE44: "緊急地震速報（予報）",
    VXSE45: "緊急地震速報（地震動予報）",
  };
  return map[type] || type;
}

/** 地震情報を整形して表示 */
export function displayEarthquakeInfo(info: ParsedEarthquakeInfo): void {
  console.log();
  console.log(separator("═"));

  // テスト電文の場合
  if (info.isTest) {
    console.log(chalk.bgMagenta.white.bold(" ■ テスト電文 "));
  }

  // タイトル
  const label = typeLabel(info.type);
  console.log(
    chalk.bold.cyan(` 📋 ${label}`) +
      chalk.gray(` [${info.type}] `) +
      chalk.gray(`${info.infoType}`)
  );
  console.log(chalk.gray(` 発表: ${info.reportDateTime}  ${info.publishingOffice}`));

  // ヘッドライン
  if (info.headline) {
    console.log(separator());
    console.log(chalk.bold.white(` ${info.headline}`));
  }

  // 震源
  if (info.earthquake) {
    const eq = info.earthquake;
    console.log(separator());
    console.log(chalk.bold.white(` 🔴 震源情報`));
    console.log(
      chalk.white(`   震源地: `) + chalk.bold.yellow(eq.hypocenterName)
    );
    if (eq.originTime) {
      console.log(chalk.white(`   発生時刻: `) + chalk.white(eq.originTime));
    }
    if (eq.latitude && eq.longitude) {
      console.log(
        chalk.white(`   位置: `) +
          chalk.white(`${eq.latitude} ${eq.longitude}`)
      );
    }
    if (eq.depth) {
      console.log(chalk.white(`   深さ: `) + chalk.white(eq.depth));
    }
    if (eq.magnitude) {
      const mag = parseFloat(eq.magnitude);
      const magColor =
        mag >= 7.0
          ? chalk.bgRed.white.bold
          : mag >= 5.0
            ? chalk.red.bold
            : mag >= 3.0
              ? chalk.yellow
              : chalk.white;
      console.log(
        chalk.white(`   規模: `) + magColor(`M${eq.magnitude}`)
      );
    }
  }

  // 震度
  if (info.intensity) {
    console.log(separator());
    console.log(
      chalk.bold.white(` 📊 震度情報`) +
        chalk.white(` (最大震度: `) +
        intensityColor(info.intensity.maxInt).bold(info.intensity.maxInt) +
        chalk.white(")")
    );

    // 震度別にグループ化して表示
    const byIntensity = new Map<string, string[]>();
    for (const area of info.intensity.areas) {
      const key = area.intensity;
      if (!byIntensity.has(key)) byIntensity.set(key, []);
      byIntensity.get(key)!.push(area.name);
    }

    // 震度の大きい順にソート
    const order = ["7", "6+", "6強", "6-", "6弱", "5+", "5強", "5-", "5弱", "4", "3", "2", "1"];
    const sorted = [...byIntensity.entries()].sort((a, b) => {
      const ai = order.indexOf(a[0]);
      const bi = order.indexOf(b[0]);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    for (const [int, names] of sorted) {
      const color = intensityColor(int);
      console.log(
        color(`   震度${int}: `) + chalk.white(names.join(", "))
      );
    }
  }

  // 津波
  if (info.tsunami) {
    console.log(separator());
    console.log(chalk.bold.white(` 🌊 津波情報`));
    console.log(chalk.white(`   ${info.tsunami.text}`));
  }

  console.log(separator("═"));
  console.log();
}

/** EEW 表示時のコンテキスト情報 */
export interface EewDisplayContext {
  /** 現在アクティブなイベント数 */
  activeCount: number;
}

/** EEW情報を整形して表示 */
export function displayEewInfo(
  info: ParsedEewInfo,
  context?: EewDisplayContext
): void {
  console.log();

  const isCancelled = info.infoType === "取消";

  if (isCancelled) {
    // キャンセル報
    console.log(chalk.bgGreen.black.bold(" ".repeat(60)));
    console.log(
      chalk.bgGreen.black.bold(
        ` ✓ 緊急地震速報 取消`.padEnd(59) + " "
      )
    );
    console.log(chalk.bgGreen.black.bold(" ".repeat(60)));
  } else if (info.isWarning) {
    // 警報
    console.log(chalk.bgRed.white.bold(" ".repeat(60)));
    console.log(
      chalk.bgRed.white.bold(
        ` ⚠⚠⚠ 緊急地震速報（警報） ⚠⚠⚠`.padEnd(59) + " "
      )
    );
    console.log(chalk.bgRed.white.bold(" ".repeat(60)));
  } else {
    // 予報
    console.log(chalk.bgYellow.black.bold(" ".repeat(60)));
    console.log(
      chalk.bgYellow.black.bold(
        ` ⚡ 緊急地震速報（予報）`.padEnd(59) + " "
      )
    );
    console.log(chalk.bgYellow.black.bold(" ".repeat(60)));
  }

  if (info.isTest) {
    console.log(chalk.bgMagenta.white.bold(" ■ テスト電文 "));
  }

  // 複数イベント同時発生時は EventID を目立たせる
  const activeCount = context?.activeCount ?? 0;
  if (activeCount >= 2 && info.eventId) {
    console.log(
      chalk.bgCyan.black.bold(` Event: ${info.eventId} `) +
        chalk.gray(` 第${info.serial || "?"}報  ${info.infoType}`) +
        chalk.yellow(` [同時${activeCount}件]`)
    );
  } else {
    console.log(
      chalk.gray(
        ` 第${info.serial || "?"}報  EventID: ${info.eventId || "不明"}  ${info.infoType}`
      )
    );
  }
  console.log(chalk.gray(` 発表: ${info.reportDateTime}  ${info.publishingOffice}`));

  if (info.headline) {
    console.log(chalk.bold.white(` ${info.headline}`));
  }

  if (isCancelled && !info.earthquake) {
    // キャンセル報で震源情報がない場合
    console.log(separator());
    console.log(chalk.green(`   この地震についての緊急地震速報は取り消されました。`));
    console.log(separator("═"));
    console.log();
    return;
  }

  if (info.earthquake) {
    const eq = info.earthquake;
    console.log(separator());
    console.log(
      chalk.white(`   震源地: `) + chalk.bold.yellow(eq.hypocenterName)
    );
    if (eq.originTime) {
      console.log(chalk.white(`   発生時刻: `) + chalk.white(eq.originTime));
    }
    if (eq.depth) {
      console.log(chalk.white(`   深さ: `) + chalk.white(eq.depth));
    }
    if (eq.magnitude) {
      console.log(
        chalk.white(`   規模: `) + chalk.red.bold(`M${eq.magnitude}`)
      );
    }
  }

  if (isCancelled) {
    // キャンセル報で震源情報はあるが予測震度は省略
    console.log(separator());
    console.log(chalk.green(`   この地震についての緊急地震速報は取り消されました。`));
    console.log(separator("═"));
    console.log();
    return;
  }

  if (info.forecastIntensity && info.forecastIntensity.areas.length > 0) {
    console.log(separator());
    console.log(chalk.bold.white(` 📊 予測震度`));
    for (const area of info.forecastIntensity.areas) {
      const color = intensityColor(area.intensity);
      console.log(
        color(`   震度${area.intensity}: `) + chalk.white(area.name)
      );
    }
  }

  console.log(separator("═"));
  console.log();
}

/** xmlReport の情報だけで簡易表示（パース失敗時のフォールバック） */
export function displayRawHeader(msg: WsDataMessage): void {
  console.log();
  console.log(separator());
  console.log(
    chalk.cyan(`📨 電文受信: `) +
      chalk.white(msg.xmlReport?.control?.title || msg.head.type) +
      chalk.gray(` [${msg.head.type}]`)
  );
  if (msg.xmlReport) {
    const r = msg.xmlReport;
    console.log(chalk.gray(`   ${r.head.title}`));
    console.log(chalk.gray(`   ${r.head.reportDateTime}  ${r.control.publishingOffice}`));
    if (r.head.headline) {
      console.log(chalk.white(`   ${r.head.headline}`));
    }
  }
  console.log(separator());
}
