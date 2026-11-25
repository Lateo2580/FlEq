// P4-DISPLAY-SHELL-001（S0）描く値を返す純粋な関数（Q-PWT3-ROWS-FN）。DOM はこの値だけを描く（P4-DS-AC08）。

import type {
  ShellCard, ShellClientState, ShellColumn, ShellColumnPages, ShellDrawCard, ShellEvent, ShellFrame, ShellFrameInput, ShellMiddle, ShellRow,
} from "../../../contracts/p4-display-shell.types";
import { CARD_SOURCES } from "./cards.js";
import { clockRect, eewSlots, paginateColumn, placeLayers } from "./layout.js";

const EEW_LIMIT = 6;
const JST_OFFSET_MS = 32_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const STATUS_UNSUPPORTED = "受け取った情報を表示できません";
const STATUS_DETAIL_FAILED = "詳細を表示できません";

// 集め方（screenFrame と shellSync が同じく使う、AC08 (3)）。snapshot が無いか unsupported ならカード無し。
// source が max を越えて返したら前から max 枚だけを使い、診断を残す（黙って落とさない）。
function collect(state: ShellClientState, nowMs: number): { cards: ShellCard[]; diagnostics: ShellFrame["diagnostics"] } {
  const cards: ShellCard[] = [];
  const diagnostics: ShellFrame["diagnostics"][number][] = [];
  const snapshot = state.snapshot;
  if (snapshot == null || state.unsupported) return { cards, diagnostics };
  CARD_SOURCES.forEach((entry, index) => {
    const returned = entry.source(snapshot, nowMs);
    if (returned.length > entry.max) diagnostics.push({ reason: "cardSourceOverMax", entry: index, returned: returned.length, max: entry.max });
    cards.push(...returned.slice(0, entry.max));
  });
  return { cards, diagnostics };
}

const slotCards = (cards: readonly ShellCard[]): ShellCard[] =>
  cards.filter((card) => card.slot != null).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0)).slice(0, EEW_LIMIT);

function shellSync(state: ShellClientState, nowMs: number): ShellEvent {
  const { cards } = collect(state, nowMs);
  return { kind: "sync", eew: slotCards(cards).map((card) => card.id), openable: cards.some((card) => card.opened != null) };
}

// ---- 割りの使い回し（AC08 (12)）: 列ごとに最後の 1 組。入力の全部が同じなら前の結果を返す。比べは行の数に比例 ----

const sameRows = (a: readonly ShellRow[], b: readonly ShellRow[]): boolean => a.length === b.length && a.every((row, i) =>
  row.height === b[i].height && row.texts.length === b[i].texts.length && row.texts.every((t, k) => t.text === b[i].texts[k].text && t.token === b[i].texts[k].token)
  && sameRows(row.continuation, b[i].continuation));
const sameCard = (a: ShellCard, b: ShellCard): boolean => a.id === b.id && a.column === b.column && a.place === b.place && a.take === b.take
  && a.slot === b.slot && a.mayHide === b.mayHide && a.forms.length === b.forms.length
  && a.forms.every((form, i) => form.maxPages === b.forms[i].maxPages && form.minBodyRows === b.forms[i].minBodyRows
    && sameRows(form.head, b.forms[i].head) && sameRows(form.body, b.forms[i].body))
  && (a.opened == null ? b.opened == null : b.opened != null && sameRows(a.opened.rows, b.opened.rows)
    && a.opened.rect.x === b.opened.rect.x && a.opened.rect.y === b.opened.rect.y && a.opened.rect.w === b.opened.rect.w && a.opened.rect.h === b.opened.rect.h);
const memo: Record<ShellColumn, { cards: readonly ShellCard[]; pages: ShellColumnPages } | null> = { left: null, right: null };

function paginateMemo(column: ShellColumn, cards: readonly ShellCard[]): ShellColumnPages {
  const last = memo[column];
  if (last != null && last.cards.length === cards.length && cards.every((card, i) => sameCard(card, last.cards[i]))) return last.pages;
  const pages = paginateColumn(column, cards);
  memo[column] = { cards, pages };
  return pages;
}

// ---- 時刻（P2-A9-AC10）: epoch ms に 32,400,000 を足して getUTC* で読む。端末の時差に依らない ----

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
const OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function jst(epochMs: number): Date | null {
  const shifted = new Date(epochMs + JST_OFFSET_MS);
  return Number.isFinite(shifted.getTime()) ? shifted : null;
}

function formatJst(value: number | string | null): string {
  const epoch = typeof value === "number" ? value : typeof value === "string" && OFFSET_ISO.test(value) ? Date.parse(value) : Number.NaN;
  const at = Number.isFinite(epoch) ? jst(epoch) : null;
  return at == null ? "時刻不明" : `${pad(at.getUTCFullYear(), 4)}/${pad(at.getUTCMonth() + 1)}/${pad(at.getUTCDate())} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`;
}

function clockText(epochMs: number): string {
  const at = jst(epochMs);
  if (at == null) return "時刻不明";
  return `${pad(at.getUTCFullYear(), 4)}/${pad(at.getUTCMonth() + 1)}/${pad(at.getUTCDate())} (${WEEKDAYS[at.getUTCDay()]}) ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
}

// ---- screenFrame ----

function screenFrame(input: ShellFrameInput): ShellFrame {
  const { state, nowMs, shell } = input;
  const { cards, diagnostics } = collect(state, nowMs);
  const slotted = slotCards(cards);
  const slots = eewSlots(slotted.length);
  const eew: ShellMiddle[] = slotted.map((card, i) => ({ id: card.id, column: slots[i].x < 1000 ? "left" : "right", rect: slots[i] }));
  const opener = shell.open ? cards.find((card) => card.opened != null) ?? null : null;

  const pages: Record<ShellColumn, ShellColumnPages> = { left: { pages: [] }, right: { pages: [] } };
  const middle: ShellMiddle[] = [];
  const slices = new Map<string, { rows: readonly ShellRow[]; mark: ShellDrawCard["mark"] }>();
  for (const column of ["left", "right"] as const) {
    // 開いている間は、中間の層に開いたカードを渡さない（DS-LAYER-16）
    const own = cards.filter((card) => card.slot == null && card.column === column && !(opener != null && card.opened != null));
    pages[column] = paginateMemo(column, own);
    const list = pages[column].pages;
    const page = list[Math.min(Math.max(input.page[column], 0), list.length - 1)];
    const hideable = new Set(own.filter((card) => card.mayHide).map((card) => card.id));
    const mayHide = page.cards.find((slice) => hideable.has(slice.id));
    for (const slice of page.cards) {
      middle.push({ id: slice.id, column, rect: slice.rect });
      const mark = page.mark;
      // 右の列は一番下のカードの最後の行、左の列は今日の地震の見出しの行に、字だけで置く（AC08 (11)）
      const owns = mark != null && (column === "right" ? slice.id === mark.cardId : slice.id === mayHide?.id);
      slices.set(slice.id, { rows: slice.rows, mark: owns && mark != null
        ? { text: `${mark.page + 1}/${mark.pages}`, page: mark.page, pages: mark.pages, dots: column === "right" && mark.dots, at: column === "right" ? "last" : "head" } : null });
    }
  }

  const raisedIds = new Set(middle.map((card) => card.id));
  const layers = placeLayers({
    eew, open: opener?.opened == null ? null : { id: opener.id, rect: opener.opened.rect },
    raised: shell.raised.filter((id) => raisedIds.has(id)), middle,
  });
  const byId = new Map(cards.map((card) => [card.id, card] as const));
  const draw = (placement: (typeof layers.top)[number]): ShellDrawCard => {
    const card = byId.get(placement.id);
    const slice = slices.get(placement.id);
    const rows = slice != null ? slice.rows
      : placement.id === opener?.id && opener?.opened != null ? opener.opened.rows
        : card?.forms[0] == null ? [] : [...card.forms[0].head, ...card.forms[0].body];
    return { id: placement.id, layer: placement.layer, rect: placement.rect, dimmed: placement.dimmed, shifted: placement.shifted,
      openable: card?.opened != null, under: placement.under, rows, mark: slice?.mark ?? null };
  };
  const status = [...(state.unsupported ? [STATUS_UNSUPPORTED] : []), ...(state.detail?.status === "failed" ? [STATUS_DETAIL_FAILED] : [])];
  return {
    shell, clock: { rect: clockRect(eew.length), text: clockText(nowMs) }, status,
    cards: [...layers.top, ...layers.middle].map(draw), cover: layers.cover,
    pageCount: { left: pages.left.pages.length, right: pages.right.pages.length }, eew: eew.map((slot) => slot.id),
    map: [], marks: [], diagnostics,
  };
}

export { clockText, formatJst, screenFrame, shellSync };
