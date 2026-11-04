// P3-TERMINAL-OUTPUT-001（C19、B13）: 端末の出力の材料と、REPL（C18 の発注 3）へ渡す口。
// 見た目と文面の真実源は docs/specs/cli-terminal-output.md。値は電文の生の文字（scalar の文字そのまま、正規化しない）で、要素が無ければ null。
// 整形・特殊値の読み・半角への寄せは端末の側（reconstruction/src/terminal/）が持つ。
// TerminalReport は owner が decode した報から作り、inputDone の返信で publisher へ運ぶ（P3-TO-D-MATERIAL）。state・codec・view・診断・通知の payload に入れない。

import type { EewLogField } from "./p3-cli-repl.types";
import type { RuntimeUnitId } from "./p2-shared-runtime.types";

// Control と Head の共通の欄（P3-TO-AC01 (3)）。controlTitle は Control/Title、title は Head/Title。
export type TerminalHead = Readonly<{
  headType: string;
  controlTitle: string | null;
  title: string | null;
  headline: string | null;
  reportDateTimeRaw: string | null;
  infoType: string | null;
  status: string | null;
  eventId: string | null;
  serial: string | null;
  publishingOffice: string | null;
}>;

// 値と description・condition 属性（M・深さ・津波の高さ。特殊値の材料）。
export type TerminalValue = Readonly<{ raw: string; description: string | null; condition: string | null }>;

export type TerminalHypocenter = Readonly<{
  name: string | null;
  coordinate: TerminalValue | null;
  magnitude: TerminalValue | null;
}>;

// 地震情報の区域 1 つ（Intensity/Observation/Pref/Area）。VXSE62 は maxLgInt も持つ。
// maxIntCondition は MaxInt の condition 属性（例「未入電」。値の空いた MaxInt の特殊値、P3-TO-AC06 (3)）。
export type TerminalIntensityArea = Readonly<{ name: string; maxInt: string | null; maxIntCondition: string | null; maxLgInt: string | null }>;

// 津波予報・津波情報の区域 1 つ（Tsunami/Forecast/Item）。stations は VTSE51 の満潮時刻を持つ観測点だけ。
export type TerminalTsunamiArea = Readonly<{
  kindName: string | null;
  name: string;
  height: TerminalValue | null;
  arrivalTimeRaw: string | null;
  arrivalCondition: string | null;
  stations: readonly Readonly<{ name: string; highTideDateTimeRaw: string | null }>[];
}>;

// 観測点 1 つ（Tsunami/Observation/Item/Station）。VTSE52 の沖合の観測点も同じ形。
export type TerminalTsunamiStation = Readonly<{
  name: string;
  arrivalTimeRaw: string | null;
  initial: string | null;
  arrivalCondition: string | null;
  maxHeight: TerminalValue | null;
  maxHeightDateTimeRaw: string | null;
  maxHeightCondition: string | null;
}>;

// 1 報分。EEW（U-E）は作らない（材料は facts.report、P3-EEW-FACTS-001）。omitted は件数の上限（P3-TO-RES-02）で外した区域・観測点の数。
export type TerminalReport =
  | Readonly<{
      kind: "seismic";
      head: TerminalHead;
      hypocenter: TerminalHypocenter | null;
      maxInt: string | null;
      maxIntCondition: string | null;
      maxLgInt: string | null;
      originDateTimeRaw: string | null;
      areas: readonly TerminalIntensityArea[];
      forecastComment: string | null;
      uri: string | null;
      text: string | null;
      omitted: number;
    }>
  | Readonly<{
      kind: "tsunami";
      head: TerminalHead;
      hypocenter: TerminalHypocenter | null;
      areas: readonly TerminalTsunamiArea[];
      stations: readonly TerminalTsunamiStation[];
      estimations: readonly TerminalTsunamiArea[];
      warningComment: string | null;
      text: string | null;
      omitted: number;
    }>
  | Readonly<{ kind: "short"; unit: RuntimeUnitId; head: TerminalHead; target: string | null; level: TerminalBandLevel }>;

// 帯の段（spec §3、Q-TO-S-2）。重い順。
export type TerminalBandLevel = "purple" | "warning" | "caution" | "plain" | "cancel";

// C18 の発注 3 が REPL の入口から呼ぶ口（P3-TO-AC16）。値の検査と保存は C18、効き先は C19。
export type TerminalControl = Readonly<{
  setSummaryInterval: (minutes: number) => void;
  summaryNow: () => void;
  setTipInterval: (minutes: number) => void;
  setEewLog: (enabled: boolean, fields: Readonly<Partial<Record<EewLogField, boolean>>>) => void;
  clear: () => void;
  promptLabel: (clockMode: "elapsed" | "clock" | "uptime") => string;
}>;
