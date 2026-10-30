// P3-CLI-REPL-001（C18）【発注 1】: 新築の設定ファイル（spec:487、§11.5）の中身。置き場は旧築と別の directory（spec §10.2、P3-CLI-D-SETTINGS-PLACE）。
// 旧築の key のうち互換必須の入口が使うものを、旧築と同じ名前・同じ値の形で持つ。効き先は【発注 2】【発注 3】（P3-CLI-D-KEYS）。
import type { DmdataClassification, DmdataTestMode } from "./p3-dmdata-connect.types";

// 旧築 src/types.ts の NotifyCategory の 18 個。値の形は旧築のまま運び、unit への読み替えと H11 の既定は【発注 2】が決める。
export type LegacyNotifyCategory =
  | "eew" | "earthquake" | "tsunami" | "seismicText" | "nankaiTrough" | "lgObservation" | "volcano" | "weather" | "tornado"
  | "briefing" | "earlyWeather" | "weatherWarningTimeseries" | "climateInfo" | "weatherExplanation" | "heatAlert"
  | "typhoonAnalysis" | "typhoonProbability" | "floodForecast";

// 旧築 src/config.ts の VALID_EEW_LOG_FIELDS の 12 個（REPL の eewlog、【発注 3】）。
export type EewLogField =
  | "hypocenter" | "originTime" | "coordinates" | "magnitude" | "forecastIntensity" | "maxLgInt" | "forecastAreas"
  | "lgIntensity" | "isPlum" | "hasArrived" | "diff" | "maxIntChangeReason";

// H50・spec 16.2.1（2026-10-31 作者）: all＝全部出して「設定した地域は対象外」を添える（暫定の既定）、regionOnly＝設定した地域の情報だけを出す。
// 何を出さなくなるかと見た目は P4 が決める。C18 は値と検査と移行だけを持つ。
export type RegionScope = "all" | "regionOnly";

// 設定ファイル（JSON の object 1 つ）の型。欄が無いことは「未設定」で、既定は読む側が当てる（旧築と同じ）。
export type FleqSettings = Readonly<{
  apiKey?: string;
  // 旧築（fleq）とも、旧築の設定の appName とも、ほかの稼働端末とも重ならない名前。既定は置かない（spec §10.1、P3-CLI-D-APPNAME）。
  appName?: string;
  classifications?: readonly DmdataClassification[];
  testMode?: DmdataTestMode;
  display?: boolean;
  // 既定は 7789（旧築の 7788 と分ける、spec §10.2）。旧築の値は移行で写さない（P3-CLI-D-DISPLAY）。
  displayPort?: number;
  // P4 で認証ができるまでは 127.0.0.1 だけ（host が渡せる bind が 127.0.0.1 だけ、P3-CLI-D-DISPLAY）。
  displayHost?: string;
  // 旧築の値は移行で写さない（spec §10.2 の display token の分離）。
  displayToken?: string;
  summaryInterval?: number;
  promptClock?: "elapsed" | "clock" | "uptime";
  waitTipIntervalMin?: number;
  // notify・sound は発注 1 では保存だけで、発注 1 の起動は通知と音を出さない（P3-CLI-D-SILENT）。効くのは発注 2 から。
  notify?: Readonly<Partial<Record<LegacyNotifyCategory, boolean>>>;
  sound?: boolean;
  eewLog?: boolean;
  eewLogFields?: Readonly<Partial<Record<EewLogField, boolean>>>;
  // 自宅の市区町村（spec 16.2.1）。書いた文字をそのまま持ち、区域の対応表の契約がコードの体系と存在の検査を足す。
  region?: string;
  regionScope?: RegionScope;
}>;
