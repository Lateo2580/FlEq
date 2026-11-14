import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { Operation } from "../../../contracts/p1-parser-boundary.types";
import type { ReportRef, SubjectOutcome } from "../../../contracts/p2-shared-runtime.types";
import type { DisplayAreaSystem } from "../../../contracts/p2-snapshot-sse.types";
import type { WeatherCurrentSnapshot, WeatherCurrentUnitState } from "../../../contracts/p2-weather-current-unit.types";
import type {
  WeatherCurrentDetailIndexEntry,
  WeatherCurrentDetailRequest,
  WeatherCurrentDetailResponse,
  WeatherCurrentDetailRow,
  WeatherCurrentPublicArea,
  WeatherCurrentPublicUnavailable,
} from "../../../contracts/p3-uw-canon.types";
import { compareVersion } from "../../contracts-revision/version";
import { WARNING_TYPES, parseScopeToken } from "../../domains/weather-current/weather-current";
// 復元して未確認の印（restoredAt）は unit の module だけが持つので、判定はそこから借りる（呼ぶのは実行時だけで、循環は読み込みに効かない）。
import { restoredSnapshot } from "./weather-current-unit";

type State = WeatherCurrentUnitState;
type Unavailable = State["unavailable"][number];

// 合わせの 1 行（区域×Kind/Code）。詳細の行はここから作る。
type Cell = Readonly<{
  type: number; areaCode: string; code: string | null; status: string; name: string | null;
  source: ReportRef; restored: boolean;
}>;
type Entry = Readonly<{ area: WeatherCurrentPublicArea; cells: readonly Cell[] }>;
type Merged = Readonly<{ national: State["national"]; entries: ReadonlyMap<string, Entry> }>;

// P3-UWC-AC04: view-projector の WEATHER_AREA_SYSTEM と同じ対応（owner は publisher の module を読まないので写す）。
const AREA_SYSTEMS: readonly DisplayAreaSystem[] = ["prefecture", "primary", "municipalityGroup", "municipality", "stormSurge"];
const NOT_CURRENT = new Set(["解除", "発表警報・注意報はなし"]);
const ROW_PAGE = 256, INDEX_PAGE = 32, RESPONSE_BYTES = 65_536, KEY_BYTES = 256, STREAM_ID = "x".repeat(64);
// P3-USD-AC03 (2): Kind/Code → その Code を出す府県の報の種類（気象庁の R06 解説資料の別表 1・別表 3）。表に無い Code（洪水・土砂・予約）は全国報の行を残す。
const CODE_FAMILY: ReadonlyMap<string, string> = new Map(Object.entries({
  VPWW55: ["03", "10", "33", "43"], VPWW57: ["08", "19", "38", "48"], VPWW58: ["02", "05", "13", "15", "32", "35"],
  VPWW59: ["07", "16", "37"], VPWW60: ["06", "12", "36"], VPWW61: ["14", "17", "20", "21", "22", "23", "24", "25", "26", "27"],
}).flatMap(([family, codes]) => codes.map((code) => [code, family] as const)));

const entryKey = (operation: Operation, prefecture: string) => `${operation}\u0000${prefecture}`;
const regionKey = (cell: Cell) => `${cell.type}\u0000${cell.areaCode}`;
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

// 報の object ごとに 1 回だけ、行を府県（区域 Code の先頭 2 桁）へ振り分ける（P3-UWC-AC09 の「府県の判定は報の object ごとの cache」）。
// 府県ごとに、その報が載せる区域（行が空の区域を含む）も持つ。終了で行が空になった全国報の区域も全国報が載せる区域のまま
// （無いと、全国報より古い partial の行がその区域で勝者に戻る、r0 品質の P2）。
const cellCache = new WeakMap<WeatherCurrentSnapshot, ReadonlyMap<string, readonly Cell[]>>();
const regionCache = new WeakMap<WeatherCurrentSnapshot, ReadonlyMap<string, ReadonlySet<string>>>();
function regionsOf(snapshot: WeatherCurrentSnapshot, prefecture: string): ReadonlySet<string> {
  cellsOf(snapshot);
  return regionCache.get(snapshot)?.get(prefecture) ?? new Set();
}
function cellsOf(snapshot: WeatherCurrentSnapshot): ReadonlyMap<string, readonly Cell[]> {
  const cached = cellCache.get(snapshot);
  if (cached != null) return cached;
  const result = new Map<string, Cell[]>(), regions = new Map<string, Set<string>>(), restored = restoredSnapshot(snapshot);
  for (const [token, rows] of Object.entries(snapshot.phenomena)) {
    const tuple = parseScopeToken(token);
    const type = tuple == null ? -1 : (WARNING_TYPES as readonly string[]).indexOf(tuple[3]);
    if (tuple == null || type < 0 || !Array.isArray(rows)) continue;
    const prefecture = tuple[4].slice(0, 2);
    const list = result.get(prefecture) ?? [], seen = regions.get(prefecture) ?? new Set<string>();
    seen.add(`${type}\u0000${tuple[4]}`);
    regions.set(prefecture, seen);
    for (const row of rows) {
      if (row == null || typeof row !== "object" || Array.isArray(row)) continue;
      const status = row.status, code = row.code, name = row.name;
      if (typeof status !== "string" || !(code === null || typeof code === "string") || !(name == null || typeof name === "string")) continue;
      list.push({ type, areaCode: tuple[4], code, status, name: name ?? null, source: snapshot.source, restored });
    }
    result.set(prefecture, list);
  }
  cellCache.set(snapshot, result);
  regionCache.set(snapshot, regions);
  return result;
}

const compareCell = (left: Cell, right: Cell) => left.type - right.type || compareText(left.areaCode, right.areaCode)
  || compareText(left.code ?? "", right.code ?? "") || compareText(left.source.subject, right.source.subject);

// P3-UWC-AC04 (1): 区域×Code の勝者は、全国報が載せる区域では全国報の行（無ければ全国報の版）を基にし、partial を compareSnapshot の順に見て、
// 今の勝者の報より newer な報の行だけが置き換える（same・undecidable は前の勝者のまま、Q-UWC-MERGE-TIE (1)）。Code の無い行は置き換えも
// 置き換えられもせず、全国報が載せる区域では全国報の行だけを残す。
function mergeCells(national: WeatherCurrentSnapshot | undefined, partials: readonly WeatherCurrentSnapshot[], prefecture: string): Cell[] {
  const cells = new Map<string, Cell>(), covered = new Set<string>(), spoken = new Set<string>();
  for (const region of national == null ? [] : regionsOf(national, prefecture)) covered.add(region);
  // P3-USD-AC03 (1): 全国報より newer な partial が語った区域（『なし』・解除だけの区域も）では、その報の種類の Code の全国報の行を外して合わせる。
  if (national != null) for (const partial of partials) if (compareVersion(national.source, partial.source) === "newer")
    for (const region of regionsOf(partial, prefecture)) spoken.add(`${region}\u0000${partial.source.family}`);
  for (const cell of national == null ? [] : cellsOf(national).get(prefecture) ?? []) {
    const family = cell.code == null ? undefined : CODE_FAMILY.get(cell.code);
    if (family != null && spoken.has(`${regionKey(cell)}\u0000${family}`)) continue;
    const key = `${regionKey(cell)}\u0000${cell.code ?? `-${cell.source.subject}`}`;
    if (!cells.has(key)) cells.set(key, cell);
  }
  for (const partial of partials) for (const cell of cellsOf(partial).get(prefecture) ?? []) {
    const region = regionKey(cell), base = covered.has(region) ? national!.source : null;
    if (cell.code == null) {
      if (base == null && !cells.has(`${region}\u0000-${cell.source.subject}`)) cells.set(`${region}\u0000-${cell.source.subject}`, cell);
      continue;
    }
    const key = `${region}\u0000${cell.code}`, winner = cells.get(key)?.source ?? base;
    if (winner == null || compareVersion(winner, cell.source) === "newer") cells.set(key, cell);
  }
  return [...cells.values()].sort(compareCell);
}

const detailRow = (cell: Cell): WeatherCurrentDetailRow =>
  [WARNING_TYPES[cell.type], cell.areaCode, cell.code, cell.status, cell.name, cell.source.reportDateTimeRaw, cell.restored];

// active の行（復元して未確認・解除・なし・Code 00 を除く。view-projector の weatherTally の述語と同じ）。
const activeCell = (cell: Cell) => !cell.restored && cell.code != null && cell.code !== "00" && !NOT_CURRENT.has(cell.status);

// P3-UWC-AC05 (3): 公開形。前の object と勝った行の列・欄が同じなら前の object を使い回す（Q-UWC-MERGE-TIE (3)）。
function publicArea(operation: Operation, prefecture: string, cells: readonly Cell[], revision: string, previous: Entry | undefined): Entry {
  const areas = new Map<string, readonly [DisplayAreaSystem, string]>(), regions = new Map<string, Set<string>>(), names = new Map<string, string>();
  let source: ReportRef | null = null, restoredCellCount = 0;
  for (const cell of cells) {
    if (source == null || compareVersion(source, cell.source) === "newer") source = cell.source;
    if (cell.restored) restoredCellCount++;
    if (!activeCell(cell)) continue;
    areas.set(`${cell.type}\u0000${cell.areaCode}`, [AREA_SYSTEMS[cell.type], cell.areaCode]);
    const seen = regions.get(cell.code!) ?? new Set<string>();
    seen.add(regionKey(cell));
    regions.set(cell.code!, seen); if (cell.name != null && cell.name !== "" && !names.has(cell.code!)) names.set(cell.code!, cell.name); // P3-TP-AC09: 空の字は名前なし
  }
  const subject = `${operation}/area/${prefecture}`;
  const fields = { subject, operation, prefecture, id: sha256(["U-W", operation, subject]), source: source!,
    areas: [...areas.values()].sort((left, right) => compareText(left[0], right[0]) || compareText(left[1], right[1])),
    codes: Object.fromEntries([...regions].sort(([left], [right]) => compareText(left, right)).map(([code, seen]) => [code, seen.size])), names: Object.fromEntries(names),
    cellCount: cells.length, restoredCellCount };
  if (previous != null && previous.cells.length === cells.length && isDeepStrictEqual({ ...previous.area, revision: "" }, { ...fields, revision: "" })
    && previous.cells.every((cell, index) => isDeepStrictEqual(detailRow(cell), detailRow(cells[index])))) return previous;
  return { area: { ...fields, revision }, cells };
}

// そのoperationの府県の partial を compareSnapshot の順（報時刻→operation→subject→inputId、state だけで決まる全順序）で返す。
function compareSnapshot(left: WeatherCurrentSnapshot, right: WeatherCurrentSnapshot): number {
  return Date.parse(left.source.reportDateTimeRaw) - Date.parse(right.source.reportDateTimeRaw)
    || compareText(left.operation, right.operation) || compareText(left.subject, right.subject) || compareText(left.source.inputId, right.source.inputId);
}

// targets（operation\0府県）の府県だけを after の state から作り直す。partial は 1 回の走査で府県へ振り分ける（P3-UWC-AC09 (1)(2)）。
function rebuild(state: State, base: Merged | null, targets: ReadonlySet<string> | null, revision: string): Merged {
  const byTarget = new Map<string, { operation: Operation; prefecture: string; partials: WeatherCurrentSnapshot[] }>();
  const wanted = (key: string) => targets == null || targets.has(key);
  for (const partial of state.partials) for (const prefecture of cellsOf(partial).keys()) {
    const key = entryKey(partial.operation, prefecture);
    if (!wanted(key)) continue;
    const found = byTarget.get(key);
    if (found == null) byTarget.set(key, { operation: partial.operation, prefecture, partials: [partial] }); else found.partials.push(partial);
  }
  for (const national of Object.values(state.national)) if (national != null) for (const prefecture of cellsOf(national).keys()) {
    const key = entryKey(national.operation, prefecture);
    if (wanted(key) && !byTarget.has(key)) byTarget.set(key, { operation: national.operation, prefecture, partials: [] });
  }
  const entries = new Map(targets == null ? [] : base?.entries ?? []);
  for (const key of targets ?? []) entries.delete(key);
  for (const [key, { operation, prefecture, partials }] of byTarget) {
    const cells = mergeCells(state.national[operation], partials.sort(compareSnapshot), prefecture);
    // 勝つ行が 0 の府県は行を作らない（Q-UWC-MERGE-TIE (2)）。
    if (cells.length !== 0) entries.set(key, publicArea(operation, prefecture, cells, revision, base?.entries.get(key)));
  }
  return { national: state.national, entries };
}

// 合わせは保存しない派生の値（P3-UWC-AC04 (3)）。partials の配列と national の object が同じ state は同じ結果を共有する
// （期限・intent・保存の状態だけが変わった state で作り直さない）。
const mergedCache = new WeakMap<readonly WeatherCurrentSnapshot[], WeakMap<State["national"], Merged>>();
function remember(state: State, value: Merged): Merged {
  const byNational = mergedCache.get(state.partials) ?? new WeakMap<State["national"], Merged>();
  byNational.set(state.national, value);
  mergedCache.set(state.partials, byNational);
  return value;
}
function merged(state: State): Merged {
  return mergedCache.get(state.partials)?.get(state.national) ?? remember(state, rebuild(state, null, null, String(state.contentRevision)));
}

// unit の reduce が呼ぶ: before から after へ、変わった報の府県（keys）だけを作り直して after の cache に置く（before が null なら全部）。
// 新しい object の版は revision（その step の内容版）。
function advanceAreas(before: State | null, after: State, keys: ReadonlySet<string> | null, revision: string): void {
  if (before != null && after.partials === before.partials && after.national === before.national) return;
  remember(after, rebuild(after, before == null ? null : merged(before), before == null ? null : keys, revision));
}

// 報の object が載せる府県（鍵は operation\0府県）。
function areaKeys(snapshot: WeatherCurrentSnapshot): readonly Readonly<{ key: string; operation: Operation; prefecture: string }>[] {
  return [...cellsOf(snapshot).keys()].map((prefecture) => ({ key: entryKey(snapshot.operation, prefecture), operation: snapshot.operation, prefecture }));
}

function areaEntry(state: State, key: string): Entry | null {
  return merged(state).entries.get(key) ?? null;
}

function weatherCurrentAreas(state: State): readonly WeatherCurrentPublicArea[] {
  return [...merged(state).entries.values()].map((entry) => entry.area);
}

const outcomeCache = new WeakMap<WeatherCurrentPublicArea, SubjectOutcome>();
function areaOutcome(area: WeatherCurrentPublicArea): SubjectOutcome {
  let outcome = outcomeCache.get(area);
  if (outcome == null) {
    outcome = { subject: area.subject, operation: area.operation, informationType: area.source.infoTypeRaw,
      transition: area.cellCount === area.restoredCellCount ? "restoredUnconfirmed" : "active", severity: null,
      source: area.source, facts: { prefecture: area.prefecture }, changedFields: [] };
    outcomeCache.set(area, outcome);
  }
  return outcome;
}

// unavailable の記録の公開形と版。記録の object ごとに 1 つ（rowChanges が参照で比べる）。版は unit の reduce が新しい記録に付ける。
const unavailableCache = new WeakMap<Unavailable, WeatherCurrentPublicUnavailable>();
const unavailableRevision = new WeakMap<Unavailable, string>();
function publicUnavailable(record: Unavailable): WeatherCurrentPublicUnavailable {
  let value = unavailableCache.get(record);
  if (value == null) {
    value = { subject: record.subject, operation: record.operation, reason: record.reason, source: record.source,
      affectedScope: record.affectedScope, lastKnownRows: record.lastKnown == null ? null : lastKnownCells(record.lastKnown).length };
    unavailableCache.set(record, value);
  }
  return value;
}
function markUnavailable(record: Unavailable, revision: string): void {
  if (!unavailableRevision.has(record)) unavailableRevision.set(record, revision);
}

const lastKnownCache = new WeakMap<WeatherCurrentSnapshot, readonly Cell[]>();
function lastKnownCells(snapshot: WeatherCurrentSnapshot): readonly Cell[] {
  let cells = lastKnownCache.get(snapshot);
  if (cells == null) {
    cells = [...cellsOf(snapshot).values()].flat().sort(compareCell);
    lastKnownCache.set(snapshot, cells);
  }
  return cells;
}

// P3-UWC-AC06 (1): 索引の key の切り方（U-F の officePrefix と同じ。UTF-8 で 256 byte 以下の先頭、孤立したサロゲートは U+FFFD）。
function keyPrefix(value: string): Readonly<{ text: string; truncated: boolean }> {
  let text = "", size = 0;
  for (const char of value) {
    const point = char.codePointAt(0)!;
    const scalar = point >= 0xd800 && point <= 0xdfff ? "�" : char;
    const width = Buffer.byteLength(scalar);
    if (size + width > KEY_BYTES) return { text, truncated: true };
    text += scalar;
    size += width;
  }
  return { text, truncated: false };
}

const versionChanged = (revision: string | null): WeatherCurrentDetailResponse => ({ kind: "error", reason: "versionChanged", revision });
const invalid: WeatherCurrentDetailResponse = { kind: "error", reason: "invalidRequest", revision: null };
const commas = (count: number) => Math.max(count - 1, 0);

// P3-UWC-AC06: 詳細の 1 ページ。読むだけで、state も期限も動かさない。
function weatherCurrentDetail(state: State, request: WeatherCurrentDetailRequest,
  view: Readonly<{ contentRevision: string }>): WeatherCurrentDetailResponse {
  const pageOf = (count: number, size: number) => {
    const pageCount = Math.max(1, Math.ceil(count / size));
    return Number.isSafeInteger(request.page) && request.page >= 0 && request.page < pageCount ? pageCount : null;
  };
  if (request.part === "index") {
    if (request.revision !== view.contentRevision) return versionChanged(view.contentRevision);
    const all: WeatherCurrentDetailIndexEntry[] = [
      ...[...merged(state).entries.values()].map(({ area }) => ({ id: area.id, operation: area.operation, part: "areas" as const,
        key: area.prefecture, keyTruncated: false, revision: area.revision, rowCount: area.cellCount })),
      ...state.unavailable.flatMap((record) => record.lastKnown == null ? [] : [(() => {
        const key = keyPrefix(record.subject);
        return { id: sha256(["U-W", record.operation, record.subject]), operation: record.operation, part: "lastKnown" as const,
          key: key.text, keyTruncated: key.truncated, revision: unavailableRevision.get(record) ?? String(state.contentRevision),
          rowCount: lastKnownCells(record.lastKnown!).length };
      })()]),
    ].sort((left, right) => compareText(left.operation, right.operation) || compareText(left.part, right.part) || compareText(left.key, right.key));
    const pageCount = pageOf(all.length, INDEX_PAGE);
    if (pageCount == null) return invalid;
    return { kind: "ok", part: "index", revision: view.contentRevision, page: request.page, pageCount, entryCount: all.length,
      entries: all.slice(request.page * INDEX_PAGE, (request.page + 1) * INDEX_PAGE) };
  }
  let found: Readonly<{ revision: string; cells: readonly Cell[] }> | null = null;
  if (request.part === "areas") {
    for (const entry of merged(state).entries.values()) if (entry.area.id === request.id) found = { revision: entry.area.revision, cells: entry.cells };
  } else for (const record of state.unavailable) if (record.lastKnown != null && sha256(["U-W", record.operation, record.subject]) === request.id)
    found = { revision: unavailableRevision.get(record) ?? String(state.contentRevision), cells: lastKnownCells(record.lastKnown) };
  if (found == null) return versionChanged(null);
  if (request.revision !== found.revision) return versionChanged(found.revision);
  const rowCount = found.cells.length, pageCount = pageOf(rowCount, ROW_PAGE);
  if (pageCount == null) return invalid;
  const start = request.page * ROW_PAGE, end = Math.min(rowCount, start + ROW_PAGE);
  // P3-UWC-AC06 (3): HTTP の本文（streamId は最大の 64 文字）の全部を加算で数え、置いた行と残りを全部省略にしたときの和が上限以下の行だけを置く。
  const wrapper = Buffer.byteLength(JSON.stringify({ streamId: STREAM_ID, kind: "ok", part: request.part, id: request.id, revision: found.revision,
    page: request.page, pageCount, rowCount, rows: [], omitted: [] }));
  const omittedBytes = (index: number) => Buffer.byteLength(JSON.stringify({ index, reason: "pageBudget" }));
  const rest = new Array<number>(end - start + 1).fill(0);
  for (let index = end - 1; index >= start; index--) rest[index - start] = rest[index - start + 1] + omittedBytes(index);
  const rows: { index: number; row: WeatherCurrentDetailRow }[] = [];
  const omitted: { index: number; reason: "pageBudget" }[] = [];
  let rowBytes = 0, omittedSoFar = 0;
  for (let index = start; index < end; index++) {
    const row = { index, row: detailRow(found.cells[index]) };
    const size = Buffer.byteLength(JSON.stringify(row)), later = end - index - 1;
    const total = wrapper + rowBytes + size + commas(rows.length + 1) + omittedSoFar + rest[index - start + 1] + commas(omitted.length + later);
    if (total <= RESPONSE_BYTES) { rows.push(row); rowBytes += size; } else { omitted.push({ index, reason: "pageBudget" }); omittedSoFar += omittedBytes(index); }
  }
  return { kind: "ok", part: request.part, id: request.id, revision: found.revision, page: request.page, pageCount, rowCount, rows, omitted };
}

export {
  advanceAreas, areaEntry, areaKeys, areaOutcome, markUnavailable, publicUnavailable, weatherCurrentAreas, weatherCurrentDetail,
};
