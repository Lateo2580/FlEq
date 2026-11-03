import type { EewLogField, ReplParse, TerminalReplCommand } from "../../contracts/p3-cli-repl.types";
import type { Entry } from "./repl";
import { EEW_LOG_FIELDS } from "./settings";

// P3-CLI-AC21・AC22（P3-CLI-D-O3-PLACE）: C19 の端末の出力に頼る 5 入口の入口の表の行・引数の読み・状態を持たない返事の文。
// 状態・TerminalControl の呼び出し・保存は repl.ts の runRepl が持つ。返事の文は旧築 settings-handlers.ts の文を色なしで写す。

type ClockMode = NonNullable<Extract<TerminalReplCommand, { kind: "clock" }>["mode"]>;
type EewLogFields = Readonly<Partial<Record<EewLogField, boolean>>>;
// REPL の初めの値（P3-CLI-AC26 (1)）。cli.ts が起動の値から組んで runRepl に渡す。summaryMinutes の 0 は止めている。
type TerminalValues = Readonly<{ summaryMinutes: number; tipMinutes: number; clock: ClockMode; eewLog: boolean; eewLogFields: EewLogFields }>;

// 旧築 command-definitions.ts の 5 入口（並びも旧築の定義の順、別名は旧築 COMMAND_ALIASES）。eewlog の詳細の 1 行は P3-CLI-D-O3-SHOW、clock は旧築の文のまま（P3-CLI-D-O3-CLOCK=B）。
const TERMINAL_ENTRIES: readonly Entry[] = [
  { name: "eewlog", kind: "eewlog", group: "settings", description: "EEWログ記録の設定 (例: eewlog on / eewlog fields)", alias: "ewlg",
    detail: "eewlog: 現在のログ記録設定を表示\n  eewlog on: ログ記録を有効にする\n  eewlog off: ログ記録を無効にする\n  eewlog fields: 記録項目の一覧表示 (グループ別)\n"
      + "  eewlog fields <field>: 項目の今の状態を表示\n  eewlog fields <field> on/off: 項目の有効/無効\n  [震源] hypocenter, originTime, coordinates\n  [規模] magnitude\n"
      + "  [変化] diff, maxIntChangeReason\n  [予測概要] forecastIntensity, maxLgInt\n  [予測地域] forecastAreas, lgIntensity, isPlum, hasArrived",
    subcommands: { on: "ログ記録を有効にする", off: "ログ記録を無効にする", fields: "記録項目の一覧・切替" } },
  { name: "tipinterval", kind: "tipinterval", group: "settings", description: "待機中ヒント表示間隔の表示・変更 (例: tipinterval 15)", alias: "tint",
    detail: "tipinterval: 現在のヒント間隔(分)を表示\n  tipinterval <0〜1440>: ヒント間隔を分で変更 (0で無効)",
    subcommands: { "<0-1440>": "ヒント間隔を分で変更 (0で無効)" } },
  { name: "clock", kind: "clock", group: "settings", description: "プロンプト時計の切替 (例: clock / clock uptime)",
    detail: "clock: 経過時間→現在時刻→稼働時間をトグル切替\n  clock elapsed: 経過時間表示 (デフォルト)\n  clock now: 現在時刻表示\n  clock uptime: 稼働時間表示 (DDD:HH:MM:SS)",
    subcommands: { elapsed: "経過時間表示 (デフォルト)", now: "現在時刻表示", uptime: "稼働時間表示 (DDD:HH:MM:SS)" } },
  { name: "summary", kind: "summary", group: "settings", description: "定期要約の表示・設定 (on [分] で間隔指定可)",
    detail: "summary: 現在の設定を表示\n  summary on [N]: N分間隔で要約 (デフォルト10分)\n  summary off: 停止\n  summary now: 今すぐ要約表示",
    subcommands: { on: "定期要約を開始", off: "定期要約を停止", now: "今すぐ要約を表示" } },
  { name: "clear", kind: "clear", group: "operation", description: "ターミナル画面をクリア", alias: "cls" },
];

const SUMMARY_USAGE = "  使い方: summary on [N] / summary off / summary now";
const EEWLOG_USAGE = "  使い方: eewlog on/off / eewlog fields / eewlog fields <field> [on|off]";
const TIP_USAGE = "  使い方: tipinterval <0〜1440> (0で無効)";
// 旧築の summary on の既定（settings-handlers.ts の handleSummary）。
const SUMMARY_DEFAULT_MINUTES = 10;
const CLOCK_ARGS: ReadonlyMap<string, ClockMode> = new Map<string, ClockMode>([["elapsed", "elapsed"], ["now", "clock"], ["uptime", "uptime"]]);
const CLOCK_LABELS: Readonly<Record<ClockMode, string>> = { elapsed: "経過時間", clock: "現在時刻", uptime: "稼働時間" };
// 旧築 handleClock の順（P3-CLI-D-O3-CLOCK=B）。
const CLOCK_NEXT: Readonly<Record<ClockMode, ClockMode>> = { elapsed: "clock", clock: "uptime", uptime: "elapsed" };
// 旧築 EEW_LOG_FIELD_LABELS・EEW_LOG_FIELD_GROUPS（settings-handlers.ts）。
const FIELD_LABELS: Readonly<Record<EewLogField, string>> = {
  hypocenter: "震源情報", originTime: "発生時刻", coordinates: "緯度・経度", magnitude: "M値・深さ", forecastIntensity: "最大予測震度",
  maxLgInt: "最大予測長周期階級", forecastAreas: "予測震度地域リスト", lgIntensity: "地域別長周期階級", isPlum: "PLUM法フラグ",
  hasArrived: "主要動到達フラグ", diff: "差分情報", maxIntChangeReason: "震度変化理由",
};
const FIELD_GROUPS: readonly Readonly<{ label: string; fields: readonly EewLogField[] }>[] = [
  { label: "震源", fields: ["hypocenter", "originTime", "coordinates"] }, { label: "規模", fields: ["magnitude"] },
  { label: "変化", fields: ["diff", "maxIntChangeReason"] }, { label: "予測概要", fields: ["forecastIntensity", "maxLgInt"] },
  { label: "予測地域", fields: ["forecastAreas", "lgIntensity", "isPlum", "hasArrived"] },
];

// P3-CLI-D-O3-INVALID: 10 進の数字だけを受け、範囲は設定の欄と同じ。桁の多い数は Infinity になり範囲で断る。
const decimal = (text: string, low: number, high: number): number | null => {
  const value = /^[0-9]+$/.test(text) ? Number(text) : NaN;
  return value >= low && value <= high ? value : null;
};

/** 5 入口の引数を TerminalReplCommand か invalid の文にする（P3-CLI-AC21）。parseReplLine だけが呼ぶ。 */
function parseTerminalArgs(kind: TerminalReplCommand["kind"], args: readonly string[]): ReplParse {
  const command = (parsed: TerminalReplCommand): ReplParse => ({ kind: "command", command: parsed });
  const invalid = (message: string): ReplParse => ({ kind: "invalid", message });
  const sub = args[0]?.toLowerCase();
  switch (kind) {
    case "summary": {
      if (sub == null) return command({ kind, action: { kind: "show" } });
      if (sub === "on" && args.length <= 2) {
        const minutes = args.length === 1 ? SUMMARY_DEFAULT_MINUTES : decimal(args[1], 1, 1440);
        return minutes == null ? invalid("  summary on の間隔は 1〜1440 の整数（分）で指定してください。") : command({ kind, action: { kind: "on", minutes } });
      }
      return args.length === 1 && (sub === "off" || sub === "now") ? command({ kind, action: { kind: sub } }) : invalid(SUMMARY_USAGE);
    }
    case "eewlog": {
      if (sub == null) return command({ kind, action: { kind: "show" } });
      if (args.length === 1 && (sub === "on" || sub === "off")) return command({ kind, action: { kind: "enabled", enabled: sub === "on" } });
      if ((sub !== "fields" && sub !== "fld") || args.length > 3) return invalid(EEWLOG_USAGE);
      if (args.length === 1) return command({ kind, action: { kind: "fields" } });
      const field = EEW_LOG_FIELDS.find((name) => name.toLowerCase() === args[1].toLowerCase());
      if (field == null) return invalid(`  不明な項目: ${args[1]} (有効: ${EEW_LOG_FIELDS.join(", ")})`);
      const action = args[2]?.toLowerCase();
      if (action != null && action !== "on" && action !== "off") return invalid(EEWLOG_USAGE);
      return command({ kind, action: { kind: "field", field, enabled: action == null ? null : action === "on" } });
    }
    case "tipinterval": {
      if (sub == null) return command({ kind, minutes: null });
      const minutes = args.length === 1 ? decimal(args[0], 0, 1440) : null;
      return minutes == null ? invalid("  tipinterval は 0〜1440 の整数を指定してください。") : command({ kind, minutes });
    }
    case "clock": {
      if (sub == null) return command({ kind, mode: null });
      const mode = args.length === 1 ? CLOCK_ARGS.get(sub) : undefined;
      return mode == null ? invalid("  elapsed, now, uptime のいずれかを指定してください。") : command({ kind, mode });
    }
    // 旧築と同じく引数を見ない。
    case "clear": return command({ kind });
  }
}

const onOff = (on: boolean): string => on ? "ON" : "OFF";
// 欄の無い項目は on（旧築の既定 src/types.ts:436、C19 の eew-log と同じ）。
const fieldOn = (fields: EewLogFields, field: EewLogField): boolean => fields[field] !== false;
const fieldLines = (fields: EewLogFields): string[] => FIELD_GROUPS.flatMap((group) => [`  [${group.label}]`,
  ...group.fields.map((field) => `    ${field.padEnd(22)}${FIELD_LABELS[field]}  ${onOff(fieldOn(fields, field))}`)]);
/** eewlog（引数なし）の行（旧築 handleEewLog）。 */
const eewLogLines = (enabled: boolean, fields: EewLogFields): string[] =>
  ["", `  EEW ログ記録: ${onOff(enabled)}`, ...(enabled ? ["", ...fieldLines(fields)] : []), "", EEWLOG_USAGE, ""];
/** eewlog fields の行（on/off によらない）。 */
const eewFieldsLines = (fields: EewLogFields): string[] => ["", "  EEW ログ記録項目:", "", ...fieldLines(fields), ""];
const fieldHead = (field: EewLogField): string => `  ${FIELD_LABELS[field]} (${field}): `;
/** commands の [値]（旧築 getCurrentSettingValues の tipinterval・clock・eewlog、P3-CLI-AC22 (7)）。 */
const terminalValueTexts = (values: TerminalValues): Record<string, string> => ({
  tipinterval: values.tipMinutes === 0 ? "無効" : `${values.tipMinutes}分`, clock: CLOCK_LABELS[values.clock],
  eewlog: values.eewLog ? `ON (${EEW_LOG_FIELDS.filter((field) => fieldOn(values.eewLogFields, field)).length}/${EEW_LOG_FIELDS.length}項目)` : "OFF",
});

export { CLOCK_LABELS, CLOCK_NEXT, eewFieldsLines, eewLogLines, fieldHead, fieldOn, onOff, parseTerminalArgs, SUMMARY_USAGE, TERMINAL_ENTRIES, terminalValueTexts, TIP_USAGE };
export type { EewLogFields, TerminalValues };
