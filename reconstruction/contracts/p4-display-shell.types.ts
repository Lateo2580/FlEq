import type { DisplayWireSnapshot, WireDetailRequest, WireDetailResponse } from "./p4-display-wire.types";

// P4-DISPLAY-SHELL-001（S0）: 新しい画面（reconstruction/src/display/screen/）の骨組みの公開の型。
// 座標と大きさは 1920×1080 の画面の px（DS-SCREEN-01。ほかの大きさの画面は全体ごと縮める）。中身を DOM で測らない（D-AC06）。
// 値の出どころと決まりは表 p4-display-shell-tables.md。

export type ShellRect = Readonly<{ x: number; y: number; w: number; h: number }>;
export type ShellColumn = "left" | "right";

// 字の 1 区切り。text は wire の字のまま text node でだけ入れる（P2-A9-AC08）。token は tokens.ts の固定表の鍵で、class へは表で写す。
export type ShellText = Readonly<{ text: string; token: string | null }>;
// 割りの単位（DS-PAGE-13）。height はカードが宣言した高さ。continuation は、この行からページが始まるときに前へ出し直す行（府県の見出しと種別の組など）。
export type ShellRow = Readonly<{ height: number; texts: readonly ShellText[]; continuation: readonly ShellRow[] }>;

// カードの形 1 つ。形は順に試し、条件に合う最初の形を使う（今日の地震の形の順 DS-QROW-18 を受ける）。
// maxPages はページの数の上限（null は上限なし）。minBodyRows は最後を除く全部のページに入る本文の行の数の下限。
export type ShellCardForm = Readonly<{ head: readonly ShellRow[]; body: readonly ShellRow[]; maxPages: number | null; minBodyRows: number }>;
// 登録したカードが返す 1 枚。place は列の上下の順（DS-LAYOUT-25）、take は高さを先に取る順（DS-PAGE-07）。
// slot は最上層の緊急地震速報の場所の番号（0 から、eewSlots の順）で、null なら中間の層で列に入る。
// mayHide は、どの形も入らないときに出さなくてよいカード（今日の地震だけ、DS-QROW-18）。
// opened は押して開けるカード（今日の地震、DS-LAYER-08）だけが返す、開いたときの矩形と行（矩形の決め方は DS-OPEN-65、C0）。
export type ShellCard = Readonly<{
  id: string; column: ShellColumn; place: number; take: number; slot: number | null; mayHide: boolean;
  forms: readonly ShellCardForm[]; opened: Readonly<{ rect: ShellRect; rows: readonly ShellRow[] }> | null;
}>;
// カードの契約が cards.ts に 1 行で登録する関数（計画:227）。分野の包みは要約・取得待ちのまま渡す。
export type ShellCardSource = (snapshot: DisplayWireSnapshot, nowMs: number) => readonly ShellCard[];

// 列の割りの結果。passes は組み直した回数（DS-PAGE-16）。
export type ShellCardSlice = Readonly<{ id: string; rect: ShellRect; form: number; rows: readonly ShellRow[] }>;
export type ShellColumnPage = Readonly<{ cards: readonly ShellCardSlice[] }>;
export type ShellColumnPages = Readonly<{ column: ShellColumn; pages: readonly ShellColumnPage[]; passes: number }>;

// 最上層の 1 枚。配列の順が前から奥（開いたカードと緊急地震速報の前後 DS-OPEN-46 は呼ぶ側が決める）。
export type ShellTop = Readonly<{ id: string; rect: ShellRect }>;
export type ShellMiddle = Readonly<{ id: string; column: ShellColumn; rect: ShellRect }>;
export type ShellLayerInput = Readonly<{ top: readonly ShellTop[]; middle: readonly ShellMiddle[] }>;
// dimmed は覆いの範囲と面が重なる。shifted は全体が覆いの範囲に入り、中央寄りへ 96px ずらした（rect はずらした後）。
export type ShellMiddlePlacement = Readonly<{ id: string; rect: ShellRect; dimmed: boolean; shifted: boolean }>;
// cover は覆いの範囲（最上層のカードの矩形と、上下に続く最上層のカードの間）。中間の層はこの中を描かない。
export type ShellLayerResult = Readonly<{ top: readonly ShellTop[]; middle: readonly ShellMiddlePlacement[]; cover: readonly ShellRect[] }>;

// 押した所（DOM が frame の矩形から決める）。dimmed は暗く、ずれていない中間の層のカード。
export type ShellHit = "opened" | "openable" | "shifted" | "dimmed" | "other";

export type ShellDomainKey = keyof DisplayWireSnapshot["current"];
// 開いている詳細 1 件（D02）。refetch は対象分野の内容版か stream が変わったか、応答が 409 versionChanged だった。
export type ShellDetail = Readonly<{ request: WireDetailRequest; status: "loading" | "ready" | "refetch"; response: WireDetailResponse | null }>;
// changed は直前の snapshot から contentRevision が変わった分野（stream が変われば全部）。
export type ShellClientState = Readonly<{ snapshot: DisplayWireSnapshot | null; unsupported: boolean; changed: readonly ShellDomainKey[]; detail: ShellDetail | null }>;

// 地図の塗りの役目と印（M0 が埋める。S0 は空を返す、Q-PWT3-ROWS-FN）。
export type ShellMapPaint = Readonly<{ code: string; token: string }>;
export type ShellMapMark = Readonly<{ id: string; lat: number; lon: number; token: string }>;
// 描く 1 枚。frame の cards の中の最上層は前から奥の順。
export type ShellDrawCard = Readonly<{ id: string; layer: "top" | "middle"; rect: ShellRect; dimmed: boolean; shifted: boolean; rows: readonly ShellRow[] }>;
// openFront は開いたカードを緊急地震速報のカードより前に置くか（DS-OPEN-46。S0 は決めず、呼ぶ側が渡す）。
export type ShellFrameInput = Readonly<{ state: ShellClientState; nowMs: number; page: Readonly<Record<ShellColumn, number>>; open: boolean; openFront: boolean }>;
// DOM はこの値だけを描く（Q-PWT3-ROWS-FN）。
export type ShellFrame = Readonly<{
  clock: Readonly<{ rect: ShellRect; text: string }>; status: readonly string[];
  cards: readonly ShellDrawCard[]; cover: readonly ShellRect[]; pageCount: Readonly<Record<ShellColumn, number>>;
  map: readonly ShellMapPaint[]; marks: readonly ShellMapMark[];
}>;
