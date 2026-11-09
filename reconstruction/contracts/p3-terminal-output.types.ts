// P3-TERMINAL-OUTPUT-001（C19、B13）: 端末の出力の材料と、REPL（C18 の発注 3）へ渡す口。
// 見た目と文面の真実源は docs/specs/cli-terminal-output.md。値は電文の生の文字（scalar の文字そのまま、正規化しない）で、要素が無ければ null。
// 整形・特殊値の読み・半角への寄せは端末の側（reconstruction/src/terminal/）が持つ。
// TerminalReport は owner が decode した報から作り、inputDone の返信で publisher へ運ぶ（P3-TO-D-MATERIAL）。state・codec・view・診断・通知の payload に入れない。

import type { Operation } from "./p1-parser-boundary.types";
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
  operation: Operation; // 生の字でなく decode が確かめた運用区分。容量で退去した待ちの突き合わせに使う（P3-TRE-AC01）
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
  // reason は警報以上の段を決めた Kind（U-N は InfoSerial）の名前（P3-TL2-AC08）。帯の下に太字で 1 行出す材料で、保存しない。cancelText は取消の報の Body 直下の最初の Text（電文の取消の文、P3-TL3-AC05。取消でない報と Text の無い報は null）。monthly は全国の月間火山概況の表（P3-TL3-AC03、rows は電文の順の Item で label は Kind の Name の生の字、others は「ほか n 火山」の n）で、取消と他の報は null。flash は噴火速報（VFVO56）の活動の文（Body/VolcanoInfoContent/VolcanoActivity の生の字）と対象の市町村の名前の列（電文の順）と「ほか n 市町村」の n（P3-TL4-AC02。取消と他の報は null）。national は全国の集約通報（VPWS50）の表（P3-TL8-AC01 (8)）で、府県予報区等の層があり取消でない VPWS50 では必ず非 null（行が 0 の plain の報も）、ほかの報（取消・層の無い VPWS50 を含む）は null。端末はこの欄の有無で前の報と比べるかを決める（P3-TL8-AC04）。rows は最も重い段の Kind の Code の昇順で、label は Code の最初の Kind の Name、areas はその Kind を持つ予報区の Name（電文の順、注意報だけの報は空）、others は AREA_LIMIT を越えて読まなかった Item の数。risks は気象警報・注意報時系列情報（U-F の VPWP50）の予報の値の Significancy（SignificancyPart の Base と Local の直下。付加事項 Addition の中は入れない）の type 属性・Name・Code の字の組で、Code が 20〜59 のものを type ごとに最も重い 1 つ、type の並びは電文で先に現れた順、32 種類まで（P3-TL11-AC02）。取消でない VPWP50 では必ず非 null（並びが空のことも）、ほかの報（VPWP50 の取消を含む）は null。端末が便の束の種類の行を作る材料で、出す字は電文の type と Name のまま。released は気象警報・注意報（VPWW55〜61）の解除の行（P3-TL12-AC02）で、Body の Warning のうち type が「気象警報・注意報（市町村等をまとめた地域等）」の層の Item ごとに Status が「解除」の Kind を見て、Kind の Code（2 桁）ごとに 1 行、label は最初の Kind の Name、areas はその Kind が解除された区域の Area の Name（電文の順、1 つの Item は行ごとに 1 回）、行の並びは電文で先に現れた順。others は区域を全部は出せなかった Item の数（層の 257 個目からの Item、名前が無いか空か 32 字を越える区域・Kind、Code が 2 桁の数字でない Kind、区域の延べ 512 を越えた Kind を持つ Item）。取消でない VPWW55〜61 では必ず非 null（行が空のことも）、ほかの報（VPWW の取消を含む）は null。
  | Readonly<{ kind: "short"; unit: RuntimeUnitId; head: TerminalHead; target: string | null; level: TerminalBandLevel; reason: string | null; cancelText: string | null; monthly: Readonly<{ rows: readonly Readonly<{ label: string; areas: readonly string[] }>[]; others: number }> | null; flash: Readonly<{ activity: string | null; towns: readonly string[]; others: number }> | null; national: Readonly<{ rows: readonly Readonly<{ label: string; areas: readonly string[] }>[]; others: number }> | null; risks: readonly Readonly<{ type: string; name: string; code: string }>[] | null; released: Readonly<{ rows: readonly Readonly<{ label: string; areas: readonly string[] }>[]; others: number }> | null }>;

// 帯の段（spec §3、Q-TO-S-2、Q-TO3-TOP）。重い順に 最も重い・紫・警報・注意・普通と取消。
export type TerminalBandLevel = "top" | "purple" | "warning" | "caution" | "plain" | "cancel";

// C18 の発注 3 が REPL の入口から呼ぶ口（P3-TO-AC16）。値の検査と保存は C18、効き先は C19。
export type TerminalControl = Readonly<{
  setSummaryInterval: (minutes: number) => void;
  summaryNow: () => void;
  setTipInterval: (minutes: number) => void;
  setEewLog: (enabled: boolean, fields: Readonly<Partial<Record<EewLogField, boolean>>>) => void;
  clear: () => void;
  promptLabel: (clockMode: "elapsed" | "clock" | "uptime") => string;
}>;
