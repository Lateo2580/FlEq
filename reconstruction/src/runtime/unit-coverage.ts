import type { RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { CoverageClass, CoverageRow } from "../../contracts/p3-unit-table.types";
import type { ExecutionPlace } from "../../contracts/p3-execution-split.types";

// P3-UNIT-TABLE-001 (C0). The one list of implemented runtime units (ledger 52 ③): without it each
// loop re-spells the units and a new unit is silently skipped by the loops that were not updated.
// An element outside RuntimeUnitId fails `satisfies`; a missing RuntimeUnitId fails CoversAllUnits.
const runtimeUnits = ["U-E", "U-W", "U-F", "U-T", "U-Q", "U-N", "U-V", "U-L", "U-R"] as const satisfies readonly RuntimeUnitId[];
type CoversAllUnits<L extends readonly RuntimeUnitId[]> = [Exclude<RuntimeUnitId, L[number]>] extends [never] ? L : never;
const coveredUnits: CoversAllUnits<typeof runtimeUnits> = runtimeUnits;

// P3-C3A-PLACE-COLUMN: the execution place of each unit, next to the unit list. Without it the mailbox cannot
// tell which in-flight slot an input uses and urgent and non-urgent units would share an owner. Keyed: a new
// unit without its row fails to compile.
const executionPlaces: Readonly<Record<RuntimeUnitId, ExecutionPlace>> = {
  "U-E": "urgent", "U-W": "weatherCurrent", "U-F": "deferred", "U-T": "urgent", "U-Q": "urgent", "U-N": "urgent", "U-V": "urgent",
  "U-L": "deferred", "U-R": "deferred",
};

// Coverage: the subscribed XML headTypes (ranges expanded to single codes). A headType not listed here is
// "unlisted" at runtime and shows up as routeUnlisted (ledger 52 ①).
const coverageTable = {
  VXSE43: { status: "ready", unit: "U-E" },
  VXSE45: { status: "ready", unit: "U-E" },
  VPWS50: { status: "ready", unit: "U-W" },
  VPWW55: { status: "ready", unit: "U-W" },
  VPWW57: { status: "ready", unit: "U-W" },
  VPWW58: { status: "ready", unit: "U-W" },
  VPWW59: { status: "ready", unit: "U-W" },
  VPWW60: { status: "ready", unit: "U-W" },
  VPWW61: { status: "ready", unit: "U-W" },
  VPNO50: { status: "ready", unit: "U-W" },
  VPWP50: { status: "ready", unit: "U-F" },
  VXSE44: { status: "ignored", reason: "R27: 新築では非対応（緊急地震速報の旧テスト系）" },
  VXSE42: { status: "ignored", reason: "S3: 緊急地震速報のテスト報" },
  VPWW53: { status: "ignored", reason: "2028年頃終了予定かつ内容重複（spec §4.3 ignore行）" },
  VPWW54: { status: "ignored", reason: "2028年頃終了予定かつ内容重複（spec §4.3 ignore行）" },
  VPZJ50: { status: "ignored", reason: "2028年頃終了予定かつ内容重複（spec §4.3 ignore行）" },
  VPCJ50: { status: "ignored", reason: "2028年頃終了予定かつ内容重複（spec §4.3 ignore行）" },
  VPFJ50: { status: "ignored", reason: "2028年頃終了予定かつ内容重複（spec §4.3 ignore行）" },
  VMCJ50: { status: "ignored", reason: "2028年頃終了予定かつ内容重複（spec §4.3 ignore行）" },
  VMCJ51: { status: "ignored", reason: "2028年頃終了予定かつ内容重複（spec §4.3 ignore行）" },
  VMCJ52: { status: "ignored", reason: "2028年頃終了予定かつ内容重複（spec §4.3 ignore行）" },
  VXSE47: { status: "notPorted", candidate: "U-Q", reason: "C7で確認: checkoutに実電文・schema・旧築の実装が無く、購読区分はeew.realtimeでhostの既知区分に無い（host.ts:37）。候補unitがU-Qかどうかも未確認。購読の拡大（R54）の契約で中身と候補unitを確かめる" },
  VXSE51: { status: "ready", unit: "U-Q" },
  VXSE52: { status: "ready", unit: "U-Q" },
  VXSE53: { status: "ready", unit: "U-Q" },
  VXSE61: { status: "ready", unit: "U-Q" },
  VXSE62: { status: "ready", unit: "U-Q" },
  VXSE56: { status: "notPorted", candidate: "U-M", reason: "U-Mの移植待ち" },
  VXSE60: { status: "notPorted", candidate: "U-M", reason: "U-Mの移植待ち" },
  VZSE40: { status: "notPorted", candidate: "U-M", reason: "U-Mの移植待ち" },
  VPZJ51: { status: "notPorted", candidate: "U-M", reason: "U-Mの移植待ち" },
  VPCJ51: { status: "notPorted", candidate: "U-M", reason: "U-Mの移植待ち" },
  VPFJ51: { status: "notPorted", candidate: "U-M", reason: "U-Mの移植待ち" },
  VMCJ53: { status: "notPorted", candidate: "U-M", reason: "U-Mの移植待ち" },
  VMCJ54: { status: "notPorted", candidate: "U-M", reason: "U-Mの移植待ち" },
  VMCJ55: { status: "notPorted", candidate: "U-M", reason: "U-Mの移植待ち" },
  VPZI50: { status: "notPorted", candidate: "U-M", reason: "U-Mの移植待ち" },
  VPCI50: { status: "notPorted", candidate: "U-M", reason: "U-Mの移植待ち" },
  VPAW51: { status: "notPorted", candidate: "U-M", reason: "U-Mの移植待ち" },
  VPHW50: { status: "notPorted", candidate: "U-M", reason: "U-Mの移植待ち" },
  VPHW51: { status: "notPorted", candidate: "U-M", reason: "U-Mの移植待ち" },
  VXWW50: { status: "notPorted", candidate: "U-M", reason: "U-Mの移植待ち" },
  VPFT50: { status: "notPorted", candidate: "U-M", reason: "U-Mの移植待ち" },
  VYSE50: { status: "ready", unit: "U-N" },
  VYSE51: { status: "ready", unit: "U-N" },
  VYSE52: { status: "ready", unit: "U-N" },
  VYSE60: { status: "ready", unit: "U-N" },
  VTSE41: { status: "ready", unit: "U-T" },
  VTSE51: { status: "ready", unit: "U-T" },
  VTSE52: { status: "ready", unit: "U-T" },
  VFVO50: { status: "ready", unit: "U-V" },
  VFVO51: { status: "ready", unit: "U-V" },
  VFVO52: { status: "ready", unit: "U-V" },
  VFVO53: { status: "ready", unit: "U-V" },
  VFVO54: { status: "ready", unit: "U-V" },
  VFVO55: { status: "ready", unit: "U-V" },
  VFVO56: { status: "ready", unit: "U-V" },
  VFVO60: { status: "ready", unit: "U-V" },
  VFSV50: { status: "ready", unit: "U-V" },
  VFSV51: { status: "ready", unit: "U-V" },
  VFSV52: { status: "ready", unit: "U-V" },
  VFSV53: { status: "ready", unit: "U-V" },
  VFSV54: { status: "ready", unit: "U-V" },
  VFSV55: { status: "ready", unit: "U-V" },
  VFSV56: { status: "ready", unit: "U-V" },
  VFSV57: { status: "ready", unit: "U-V" },
  VFSV58: { status: "ready", unit: "U-V" },
  VFSV59: { status: "ready", unit: "U-V" },
  VFSV60: { status: "ready", unit: "U-V" },
  VFSV61: { status: "ready", unit: "U-V" },
  VZVO40: { status: "ready", unit: "U-V" },
  VPWW56: { status: "ready", unit: "U-L" },
  VPOA50: { status: "notPorted", candidate: "U-B", reason: "U-Bの移植待ち" },
  VPBS50: { status: "notPorted", candidate: "U-B", reason: "U-Bの移植待ち" },
  VPBS51: { status: "notPorted", candidate: "U-B", reason: "S3: 配信開始時期未定" },
  VPTW60: { status: "notPorted", candidate: "U-Y", reason: "U-Yの移植待ち" },
  VPTW61: { status: "notPorted", candidate: "U-Y", reason: "U-Yの移植待ち" },
  VPTW62: { status: "notPorted", candidate: "U-Y", reason: "U-Yの移植待ち" },
  VPTW63: { status: "notPorted", candidate: "U-Y", reason: "U-Yの移植待ち" },
  VPTW64: { status: "notPorted", candidate: "U-Y", reason: "U-Yの移植待ち" },
  VPTW65: { status: "notPorted", candidate: "U-Y", reason: "U-Yの移植待ち" },
  VPTA50: { status: "notPorted", candidate: "U-Y", reason: "U-Yの移植待ち" },
  VPTA51: { status: "notPorted", candidate: "U-Y", reason: "U-Yの移植待ち" },
  VPTA52: { status: "notPorted", candidate: "U-Y", reason: "U-Yの移植待ち" },
  VPTA53: { status: "notPorted", candidate: "U-Y", reason: "U-Yの移植待ち" },
  VPTA54: { status: "notPorted", candidate: "U-Y", reason: "U-Yの移植待ち" },
  VPTA55: { status: "notPorted", candidate: "U-Y", reason: "U-Yの移植待ち" },
  VXKO50: { status: "ready", unit: "U-R" },
  VXKO51: { status: "ready", unit: "U-R" },
  VXKO52: { status: "ready", unit: "U-R" },
  VXKO53: { status: "ready", unit: "U-R" },
  VXKO54: { status: "ready", unit: "U-R" },
  VXKO55: { status: "ready", unit: "U-R" },
  VXKO56: { status: "ready", unit: "U-R" },
  VXKO57: { status: "ready", unit: "U-R" },
  VXKO58: { status: "ready", unit: "U-R" },
  VXKO59: { status: "ready", unit: "U-R" },
  VXKO60: { status: "ready", unit: "U-R" },
  VXKO61: { status: "ready", unit: "U-R" },
  VXKO62: { status: "ready", unit: "U-R" },
  VXKO63: { status: "ready", unit: "U-R" },
  VXKO64: { status: "ready", unit: "U-R" },
  VXKO65: { status: "ready", unit: "U-R" },
  VXKO66: { status: "ready", unit: "U-R" },
  VXKO67: { status: "ready", unit: "U-R" },
  VXKO68: { status: "ready", unit: "U-R" },
  VXKO69: { status: "ready", unit: "U-R" },
  VXKO70: { status: "ready", unit: "U-R" },
  VXKO71: { status: "ready", unit: "U-R" },
  VXKO72: { status: "ready", unit: "U-R" },
  VXKO73: { status: "ready", unit: "U-R" },
  VXKO74: { status: "ready", unit: "U-R" },
  VXKO75: { status: "ready", unit: "U-R" },
  VXKO76: { status: "ready", unit: "U-R" },
  VXKO77: { status: "ready", unit: "U-R" },
  VXKO78: { status: "ready", unit: "U-R" },
  VXKO79: { status: "ready", unit: "U-R" },
  VXKO80: { status: "ready", unit: "U-R" },
  VXKO81: { status: "ready", unit: "U-R" },
  VXKO82: { status: "ready", unit: "U-R" },
  VXKO83: { status: "ready", unit: "U-R" },
  VXKO84: { status: "ready", unit: "U-R" },
  VXKO85: { status: "ready", unit: "U-R" },
  VXKO86: { status: "ready", unit: "U-R" },
  VXKO87: { status: "ready", unit: "U-R" },
  VXKO88: { status: "ready", unit: "U-R" },
  VXKO89: { status: "ready", unit: "U-R" },
  VXSU50: { status: "ready", unit: "U-R" },
  VXSU51: { status: "ready", unit: "U-R" },
  VXSU52: { status: "ready", unit: "U-R" },
  VXSU53: { status: "ready", unit: "U-R" },
  VXSU54: { status: "ready", unit: "U-R" },
  VXSU55: { status: "ready", unit: "U-R" },
  VXSU56: { status: "ready", unit: "U-R" },
  VXSU57: { status: "ready", unit: "U-R" },
  VXSU58: { status: "ready", unit: "U-R" },
  VXSU59: { status: "ready", unit: "U-R" },
} as const satisfies Readonly<Record<string, CoverageRow>>;

const rowsByHeadType: ReadonlyMap<string, CoverageRow> = new Map(Object.entries(coverageTable));

// Map.get is own-key only, so inherited names such as "toString" are never ready. O(1) per input.
function classifyHeadType(headType: string): CoverageClass {
  return rowsByHeadType.get(headType) ?? { status: "unlisted" };
}

// P3-C3A-NONREADY: an input that no ready unit owns (ignored, notPorted, unlisted) is decoded in "deferred".
function placeOfHeadType(headType: string): ExecutionPlace {
  const row = rowsByHeadType.get(headType);
  return row?.status === "ready" ? executionPlaces[row.unit] : "deferred";
}

export { classifyHeadType, executionPlaces, placeOfHeadType, runtimeUnits };
export type { CoversAllUnits };
