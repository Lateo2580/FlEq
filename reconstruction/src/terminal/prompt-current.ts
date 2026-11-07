import type { Operation } from "../../contracts/p1-parser-boundary.types";
import type { RuntimeUnitView } from "../../contracts/p2-shared-runtime.types";
import type { NankaiCurrentStatus } from "../../contracts/p3-nankai-unit.types";
import type { TsunamiAreaClass } from "../../contracts/p3-tsunami-unit.types";
import { KIND_CLASS } from "../domains/tsunami/tsunami";
import { UNREAD_TEXT } from "../units/unreadable";
import { BAND_ROLES } from "./color";
import type { Paint, Role } from "./color";
import { width } from "./format";

// P3-TERMINAL-PROMPT-001: 入力の行の現況。今も有効かは view の値だけで決める（時計で判定しない、AC08 (2)）。
type Band = "top" | "warning" | "caution";
// text は行の字の全部、kind はその頭の区分の字（太字にする所）。同じ字のまとめは text で比べる。
type PromptItem = Readonly<{ band: Band; kind: string; text: string }>;
type PromptUnit = "U-T" | "U-N" | "U-V" | "U-W" | "U-R" | "U-L";
// AC01: 載せる 6 unit だけを読む（U-E・U-Q は型でも読めない）。
type PromptMirror = Readonly<Record<PromptUnit, Readonly<{ view: RuntimeUnitView }>>>;
// 括弧の中の字。full は今の字、narrow は入らないときの項目の枠の頭、spare は足す最後の 1 枠、bare は時計を外した頭（切断中は外さないので null）。
// role はこの字の色（Q-TO6-COLOR: 切断の字は connLost、時計・回線の印・ミュートの字は色なし）。
type PromptForms = Readonly<{ full: string; narrow: string; spare: string | null; bare: string | null; role: Role | null }>;

// AC02 (2): 段の中の分野の順。
const UNITS: readonly PromptUnit[] = ["U-T", "U-N", "U-V", "U-W", "U-R", "U-L"];
const BANDS: readonly Band[] = ["top", "warning", "caution"];
const ROTATE_MS = 5_000;
const TSUNAMI_BANDS: ReadonlyMap<TsunamiAreaClass, Band> = new Map<TsunamiAreaClass, Band>([
  ["majorWarning", "top"], ["warning", "warning"], ["unknown", "warning"], ["advisory", "caution"]]);
const item = (band: Band, kind: string, place = ""): PromptItem => ({ band, kind, text: place === "" ? kind : `${kind} ${place}` });
// AC01 (2): status から書く（title と infoSerial は 7 日の移行で報の字のまま残る）。
const NANKAI_ITEMS: Readonly<Record<NankaiCurrentStatus, PromptItem>> = {
  megaquakeWarning: item("top", "南海トラフ地震臨時情報（巨大地震警戒）"),
  megaquakeAdvisory: item("warning", "南海トラフ地震臨時情報（巨大地震注意）"),
  investigating: item("warning", "南海トラフ地震臨時情報（調査中）"),
};
// AC01 (3): 24・25 は level が null なので level でなく Code で読む。
const VOLCANO_CODES: ReadonlySet<string> = new Set(["14", "15", "24", "25"]);
const SPECIAL_WARNING = /^3\d$/;
// P3-TP-AC09: Kind/Name の無い報で特別警報が行から消えないようにする逃げ。
const UNNAMED_SPECIAL = "特別警報";

const kindText = (name: string): string => name === "" ? UNREAD_TEXT : name;
function normalRows<T extends Readonly<{ subject: string; operation: Operation }>>(rows: readonly T[]): T[] {
  return rows.filter((row) => row.operation === "normal").sort((left, right) => left.subject < right.subject ? -1 : left.subject > right.subject ? 1 : 0);
}
// 区分は「：」より前（format.ts の kindOf と同じ、AC01 (1)）。
function tsunamiItem(areaClass: TsunamiAreaClass, area: Readonly<{ name: string; kindName: string }>): readonly PromptItem[] {
  const band = TSUNAMI_BANDS.get(areaClass);
  return band == null ? [] : [item(band, kindText(area.kindName.split("：")[0]), kindText(area.name))];
}

function itemsOf(view: RuntimeUnitView): readonly PromptItem[] {
  switch (view.unit) {
    case "U-T":
      return normalRows(view.forecasts).flatMap((forecast) => [
        ...forecast.areas.flatMap((area) => tsunamiItem(area.areaClass, area)),
        ...forecast.unkeyedAreas.flatMap((area) => tsunamiItem(KIND_CLASS.get(area.kindCode) ?? "unknown", area))]);
    case "U-N": {
      const rows = normalRows(view.currents);
      return [...rows.flatMap((row) => row.line === "nankai" ? [NANKAI_ITEMS[row.status]] : []),
        ...rows.flatMap((row): readonly PromptItem[] => row.line === "VYSE60" ? [item("warning", row.title)] : [])];
    }
    case "U-V":
      // kind だけを読むと、Lv5 の後の VFSV で kind が 36 に替わったときに解除の前に消える（AC01 (3)）。
      return normalRows(view.alerts).flatMap((alert) => {
        const kind = [alert.kind, alert.landKind].find((candidate) => candidate != null && VOLCANO_CODES.has(candidate.code));
        return kind == null ? [] : [item("top", kindText(kind.name), kindText(alert.volcanoName))];
      });
    case "U-W":
      return normalRows(view.areas).flatMap((area) => Object.keys(area.codes).filter((code) => SPECIAL_WARNING.test(code))
        .map((code) => item("top", area.names[code] ?? UNNAMED_SPECIAL)));
    case "U-R":
      return normalRows(view.currents).flatMap((current) => current.kinds.filter((group) => group.level === 5).flatMap((group) =>
        (group.rivers.length === 0 ? [current.areaName] : group.rivers.map((river) => river.name === "" ? current.areaName : river.name))
          .map((place) => item("top", kindText(group.name), place))));
    case "U-L":
      return normalRows(view.currents).flatMap((current) => current.kinds.filter((group) => group.level === 5).map((group) => item("top", kindText(group.name))));
    case "U-E": case "U-F": case "U-Q": case "U-B": case "U-M": case "U-Y":
      return [];
  }
}

// AC06 (4)(5): view の参照が同じ unit は memo の項目を使い、読まない。AC02: 最も重い段だけを、同じ字をまとめて返す。
function currentItems(mirror: PromptMirror, memo: WeakMap<RuntimeUnitView, readonly PromptItem[]>): readonly PromptItem[] {
  const rows = UNITS.flatMap((unit) => {
    const { view } = mirror[unit];
    const known = memo.get(view);
    if (known != null) return known;
    const built = itemsOf(view);
    memo.set(view, built);
    return built;
  });
  const band = BANDS.find((candidate) => rows.some((row) => row.band === candidate));
  return [...new Map(rows.filter((row) => row.band === band).map((row) => [row.text, row])).values()];
}

const noPaint: Paint = (_role, text) => text;

// AC03・AC04・AC05: 位置は時計の値から計算する（タイマーと位置の覚えを持たない）。
function promptFrame(items: readonly PromptItem[], forms: PromptForms, columns: number, wallTimeMs: number, paint: Paint): string {
  const wrap = (inner: string): string => `FlEq [${inner}]> `;
  if (items.length === 0) return wrap(paint(forms.role, forms.full));
  const framed = (ink: Paint, head: string, index: number): string => {
    const { band, kind, text } = items[index], role = BAND_ROLES[band].rule;
    return wrap(`${ink(forms.role, head)} ${ink("strong", ink(role, kind))}${ink(role, text.slice(kind.length))}${items.length > 1 ? ` ${ink("dim", `${index + 1}/${items.length}`)}` : ""}`);
  };
  // 幅は色と太字の符号を含まない字で数える（Q-TO6-COLOR）。
  const fits = (head: string): boolean => items.every((_, index) => width(framed(noPaint, head, index)) < columns);
  const wide = fits(forms.full);
  const head = wide ? forms.full : forms.bare == null || fits(forms.narrow) ? forms.narrow : forms.bare;
  const spare = wide ? null : forms.spare;
  const index = Math.floor(wallTimeMs / ROTATE_MS) % (items.length + (spare == null ? 0 : 1));
  return spare != null && index === items.length ? wrap(paint(forms.role, spare)) : framed(paint, head, index);
}

export { currentItems, itemsOf, promptFrame };
export type { PromptForms, PromptItem, PromptMirror };
