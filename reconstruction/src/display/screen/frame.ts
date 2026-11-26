// P4-DISPLAY-SHELL-001（S0）描く値を返す純粋な関数（Q-PWT3-ROWS-FN）。DOM はこの値だけを描く（P4-DS-AC08）。

import type {
  ShellCard, ShellClientState, ShellColumn, ShellColumnPages, ShellDrawCard, ShellEvent, ShellFrame, ShellFrameInput, ShellMiddle, ShellRow,
} from "../../../contracts/p4-display-shell.types";
import type { ShellPart } from "../../../contracts/p4-shell-types.types";
import { CARD_SOURCES } from "./cards.js";
import { clockRect, eewSlots, paginateColumn, placeLayers } from "./layout.js";
import { clockText } from "./time.js";
import { LAYOUT } from "./tokens.js";

const EEW_LIMIT = 6;
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

// ---- 割りの使い回し（AC08 (12)）: 列ごとに最後の 1 組。入力の全部が同じなら前の結果を返す。比べは行と字と束の数に比例 ----
// カードの token と inner は割りに効かないので sameCard で比べず、描く時に最新のカードから読む（P4-ST-AC02 (2)）

function samePart(a: ShellPart, b: ShellPart): boolean {
  switch (a.kind) {
    case "text": return b.kind === "text" && a.text === b.text && a.token === b.token;
    case "group": return b.kind === "group" && a.token === b.token && a.texts.length === b.texts.length
      && a.texts.every((text, k) => text.text === b.texts[k].text && text.token === b.texts[k].token);
  }
}
const sameRows = (a: readonly ShellRow[], b: readonly ShellRow[]): boolean => a.length === b.length && a.every((row, i) =>
  row.id === b[i].id && row.height === b[i].height && row.token === b[i].token && row.texts.length === b[i].texts.length && row.texts.every((part, k) => samePart(part, b[i].texts[k]))
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

// ---- screenFrame ----

function screenFrame(input: ShellFrameInput): ShellFrame {
  const { state, nowMs, shell } = input;
  const { cards, diagnostics } = collect(state, nowMs);
  const slotted = slotCards(cards);
  const slots = eewSlots(slotted.length);
  const eew: ShellMiddle[] = slotted.map((card, i) => ({ id: card.id, column: slots[i].x < LAYOUT.right.x ? "left" : "right", rect: slots[i] }));
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
  const innerPageCount: [string, number][] = [];
  // 列の外に描くカード（緊急地震速報の場所・開いたカード）の inner は、番号のページだけを描く。番号は own key の有限の整数だけ読み、ほかは 0、ページの数で丸める（P4-ST-AC04 (2)）
  const innerRows = (id: string, inner: NonNullable<ShellCard["inner"]>): readonly ShellRow[] => {
    const asked = Object.hasOwn(input.innerPage, id) ? input.innerPage[id] : undefined;
    const k = typeof asked === "number" && Number.isInteger(asked) ? asked : 0;
    innerPageCount.push([id, inner.length]);
    return inner[Math.min(Math.max(k, 0), inner.length - 1)];
  };
  const draw = (placement: (typeof layers.top)[number]): ShellDrawCard => {
    const card = byId.get(placement.id);
    const slice = slices.get(placement.id);
    const rows = slice != null ? slice.rows
      : card?.inner != null ? innerRows(card.id, card.inner)
        : placement.id === opener?.id && opener?.opened != null ? opener.opened.rows
          : card?.forms[0] == null ? [] : [...card.forms[0].head, ...card.forms[0].body];
    return { id: placement.id, layer: placement.layer, rect: placement.rect, dimmed: placement.dimmed, shifted: placement.shifted,
      openable: card?.opened != null, under: placement.under, rows, mark: slice?.mark ?? null, token: card?.token ?? null };
  };
  const drawn = [...layers.top, ...layers.middle].map(draw);
  const status = [...(state.unsupported ? [STATUS_UNSUPPORTED] : []), ...(state.detail?.status === "failed" ? [STATUS_DETAIL_FAILED] : [])];
  return {
    shell, clock: { rect: clockRect(eew.length), text: clockText(nowMs) }, status,
    cards: drawn, cover: layers.cover,
    // Object.fromEntries はキーを own の data として置く（カードの id が "__proto__" でも prototype を替えない）
    pageCount: { left: pages.left.pages.length, right: pages.right.pages.length }, innerPageCount: Object.fromEntries(innerPageCount), eew: eew.map((slot) => slot.id),
    map: [], marks: [], diagnostics,
  };
}

export { screenFrame, shellSync };
