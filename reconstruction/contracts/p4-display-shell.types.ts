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
// 登録の 1 行。max はその関数が返すカードの最大の枚数（列のカードの数の上限 K は max の和、P4-DS-D-CARD-BOUND）。
export type ShellCardEntry = Readonly<{ source: ShellCardSource; max: number }>;

// 列の割りの結果。mark はページの表示（2 ページ以上の列だけ。dots は 7 ページまで、DS-PAGE-11・14）。右の列は cardId のカードの最後の行に置く。
export type ShellCardSlice = Readonly<{ id: string; rect: ShellRect; form: number; rows: readonly ShellRow[] }>;
export type ShellPageMark = Readonly<{ cardId: string; page: number; pages: number; dots: boolean }>;
export type ShellColumnPage = Readonly<{ cards: readonly ShellCardSlice[]; mark: ShellPageMark | null }>;
export type ShellColumnPages = Readonly<{ pages: readonly ShellColumnPage[] }>;

export type ShellTop = Readonly<{ id: string; rect: ShellRect }>;
export type ShellMiddle = Readonly<{ id: string; column: ShellColumn; rect: ShellRect }>;
// eew は緊急地震速報のカードの場所（場所の番号の順）、open は開いたカード（左の列の x の中で、緊急地震速報の場所と上がったカードに重ならない、DS-LAYER-23）、raised は上がったカードの id、middle は列のカードの割りの位置。
export type ShellLayerInput = Readonly<{ eew: readonly ShellMiddle[]; open: ShellTop | null; raised: readonly string[]; middle: readonly ShellMiddle[] }>;
// dimmed は暗い、shifted は中央寄りへ 96px ずらした（rect はずらした後）。under は下がった緊急地震速報のカードに重なる上がったカードの id（ほかは空）。
export type ShellPlacement = Readonly<{ id: string; layer: "top" | "middle"; rect: ShellRect; dimmed: boolean; shifted: boolean; under: readonly string[] }>;
// top は前から奥、middle は奥から手前（列のカード、その手前に下がった緊急地震速報のカード）の描く順。
// cover は最上層のカードの矩形と、宣言値で上下に隣り合う最上層の緊急地震速報の場所の間（17px・16px）で、中間の層はこの中を描かない。
export type ShellLayerResult = Readonly<{ top: readonly ShellPlacement[]; middle: readonly ShellPlacement[]; cover: readonly ShellRect[] }>;

// 押したことで変わる状態。raised は上がったカードの id（DS-LAYER-06・15）、eew は最後に見た緊急地震速報のカードの id の組（DS-LAYER-21）。
// 下がった緊急地震速報のカードは raised から導く（上がったカードに重なるもの）。
export type ShellState = Readonly<{ open: boolean; raised: readonly string[]; eew: readonly string[] }>;
// reduceShell の事象。press はその時の frame と押した点（1920×1080 の座標。相手は点に描かれた一番手前の面）。
// sync は snapshot を受けるたびと描く前に当てる、緊急地震速報のカードの id の組（slot の順。4 件目からは左の列）と、開けるカードがあるか（shellSync が作る）。
export type ShellEvent = Readonly<{ kind: "press"; frame: ShellFrame; x: number; y: number }> | Readonly<{ kind: "sync"; eew: readonly string[]; openable: boolean }>;

export type ShellDomainKey = keyof DisplayWireSnapshot["current"];
// 開いている詳細 1 件（D02）。refetch は対象分野の内容版か stream が変わったか、応答が 409 versionChanged だった。
// streamId は要求した時の stream。応答はこの object がまだ今の詳細で、stream が今と同じときだけ採る。
// failed は 409 以外で読めなかった（400・429・503・504・responseTooLarge・通信の失敗）。理由は main.ts が log に残す。
export type ShellDetail = Readonly<{ request: WireDetailRequest; streamId: string; status: "loading" | "ready" | "refetch" | "failed"; response: WireDetailResponse | null }>;
// detailAnswered に渡す応答。failed は main.ts が 200・409 以外の HTTP の応答と通信の失敗から作る（WireDetailResponse に responseTooLarge が無いため、表 §11）。
export type ShellDetailAnswer = WireDetailResponse | Readonly<{ kind: "failed"; reason: string }>;
// changed は直前の snapshot から contentRevision が変わった分野（stream が変われば全部）。
export type ShellClientState = Readonly<{ snapshot: DisplayWireSnapshot | null; unsupported: boolean; changed: readonly ShellDomainKey[]; detail: ShellDetail | null }>;

// 地図の塗りの役目と印（M0 が埋める。S0 は空を返す、Q-PWT3-ROWS-FN）。
export type ShellMapPaint = Readonly<{ code: string; token: string }>;
export type ShellMapMark = Readonly<{ id: string; lat: number; lon: number; token: string }>;
// 描く 1 枚。frame の cards は最上層（前から奥、開いたカードは先頭）、続けて中間の層（奥から手前）の順。openable は押して開けるカード。
// under は下がった緊急地震速報のカードだけが持つ、そのカードに重なる上がったカードの id（ほかは空）。
// mark はそのカードに描くページの表示（text は「2/4」の字、dots は点を描くか、at は見出しの行か最後の行か。DS-PAGE-11・14、DS-QROW-21）。
export type ShellDrawMark = Readonly<{ text: string; page: number; pages: number; dots: boolean; at: "head" | "last" }>;
export type ShellDrawCard = Readonly<{
  id: string; layer: "top" | "middle"; rect: ShellRect; dimmed: boolean; shifted: boolean; openable: boolean; under: readonly string[]; rows: readonly ShellRow[];
  mark: ShellDrawMark | null;
}>;
export type ShellFrameInput = Readonly<{ state: ShellClientState; nowMs: number; page: Readonly<Record<ShellColumn, number>>; shell: ShellState }>;
// DOM はこの値だけを描く（Q-PWT3-ROWS-FN）。status は札の字の並び（unsupported の札、詳細が failed の札の順。AC10 (3)）。shell はこの frame を組んだ時の ShellState（押下はこれが今の状態と同じ object のときだけ効く、DS-LAYER-23 の R2）。
export type ShellFrame = Readonly<{
  shell: ShellState;
  clock: Readonly<{ rect: ShellRect; text: string }>; status: readonly string[];
  cards: readonly ShellDrawCard[]; cover: readonly ShellRect[]; pageCount: Readonly<Record<ShellColumn, number>>; eew: readonly string[];
  map: readonly ShellMapPaint[]; marks: readonly ShellMapMark[];
  // source が max を越えて返したときの診断（越えるのは source の実装の誤り。前から max 枚を使う、P4-DS-D-CARD-BOUND）。
  diagnostics: readonly Readonly<{ reason: "cardSourceOverMax"; entry: number; returned: number; max: number }>[];
}>;
