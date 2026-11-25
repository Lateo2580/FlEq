import type {
  ShellCard, ShellCardForm, ShellColumn, ShellDrawCard, ShellFrame, ShellLayerResult, ShellMiddle, ShellRect, ShellRow, ShellState,
} from "../../contracts/p4-display-shell.types";

const rect = (x: number, y: number, w: number, h: number): ShellRect => ({ x, y, w, h });
const row = (height: number, text = "", continuation: readonly ShellRow[] = []): ShellRow => ({ height, texts: text === "" ? [] : [{ text, token: null }], continuation });
const form = (head: number, body: readonly ShellRow[], maxPages: number | null = null, minBodyRows = 1): ShellCardForm =>
  ({ head: [row(head, "head")], body, maxPages, minBodyRows });
const rows = (count: number, height = 100, text = "r"): ShellRow[] => Array.from({ length: count }, (_, i) => row(height, `${text}${i + 1}`));
const card = (id: string, column: ShellColumn, extra: Partial<ShellCard> & { forms: readonly ShellCardForm[] }): ShellCard =>
  ({ id, column, place: 0, take: 0, slot: null, mayHide: false, opened: null, ...extra });
const middle = (id: string, column: ShellColumn, r: ShellRect): ShellMiddle => ({ id, column, rect: r });

// placeLayers の結果から frame を組む（押下の試験が使う、表 §5.3）
function frameOf(shell: ShellState, result: ShellLayerResult, openable: readonly string[] = []): ShellFrame {
  const draw = (placement: ShellLayerResult["top"][number]): ShellDrawCard => ({ ...placement, openable: openable.includes(placement.id), rows: [], mark: null });
  return { shell, clock: { rect: rect(40, 960, 540, 80), text: "" }, status: [], cards: [...result.top, ...result.middle].map(draw), cover: result.cover,
    pageCount: { left: 1, right: 1 }, eew: [], map: [], marks: [], diagnostics: [] };
}

export { card, form, frameOf, middle, rect, row, rows };
