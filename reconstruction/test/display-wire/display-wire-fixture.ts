import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";

import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { EewUnitState } from "../../contracts/p2-eew-unit.types";
import type { RuntimeDisplayChange } from "../../contracts/p2-shared-runtime.types";
import type { SnapshotProjectionInput, SnapshotProjectionState } from "../../contracts/p2-snapshot-sse.types";
import type { SeismicUnitState } from "../../contracts/p3-seismic-unit.types";
import type { TsunamiUnitState } from "../../contracts/p3-tsunami-unit.types";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { reduceEewUnit, toEewView } from "../../src/units/eew/eew-unit";
import { emptyDaily, toSeismicView } from "../../src/units/seismic/seismic-unit";
import { toTsunamiView } from "../../src/units/tsunami/tsunami-unit";
import { projectDisplayWire } from "../../src/view-projector/display-wire";
import type { DisplayWireInput, DisplayWireResult, DisplayWireState } from "../../src/view-projector/display-wire";
import { projectSnapshot } from "../../src/view-projector/view-projector";
import { projectionInput, startup } from "../snapshot-sse/projection-fixture";

// P4-DISPLAY-WIRE-001 の試験の共通部。射影は unit の view と表示差分だけを読むので、unit の reducer の step をそのまま渡す。

const saved = { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null, savedAckAt: null, dirtySince: null } as const;
const emptyEew = (): EewUnitState => ({ schemaVersion: "p2-eew-unit-v5", contentRevision: 0, current: [], gates: [], intents: [], notices: [],
  unreadableNotices: [], persistence: saved });
const emptyTsunami = (): TsunamiUnitState => ({ schemaVersion: "p3-tsunami-unit-v9", contentRevision: 0, forecasts: [], observations: [], intents: [],
  failureMarks: [], unreadableNotices: [], persistence: saved });
const emptyQuake = (): SeismicUnitState => ({ schemaVersion: "p3-seismic-unit-v10", contentRevision: 0, earthquakes: [], longPeriods: [], daily: emptyDaily,
  intents: [], failureMarks: [], persistence: saved });

let sequence = 0;
function material(xml: string, headType: string): DecodedMaterial {
  const entered = ingestXmlData({ inputId: `input-${++sequence}`, inputSequence: 1, receivedAt: 0, origin: "replay", kind: "replay", headType, body: Buffer.from(xml) });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return decoded.material;
}
const fixture = (file: string) => readFileSync(`test/fixtures/${file}.xml`, "utf8");
const reportTime = (xml: string) => Date.parse(/<ReportDateTime>([^<]+)/.exec(xml)![1]);

type EewArea = readonly [code: string, from: string, to: string, kind?: string];
// 合成の VXSE43/45（形は 37_01_01 の Body と同じ）。区域は [コード, From, To, Kind/Code] の並びで、同じコードを重ねてもよい。
function eewXml(options: Readonly<{ eventId: string; at: string; serial?: number; status?: "通常" | "訓練" | "試験"; family?: "VXSE43" | "VXSE45";
  areas?: readonly EewArea[]; hypocenter?: string; cancel?: boolean; body?: (body: string) => string }>): string {
  const family = options.family ?? "VXSE43";
  const areas = (options.areas ?? []).map(([code, from, to, kind]) => `<Pref><Name>県</Name><Code>9380</Code><Area><Name>区域${code}</Name><Code>${code}</Code>`
    + `<Category><Kind><Name>緊急地震速報（警報）</Name><Code>${kind ?? "10"}</Code></Kind></Category><ForecastInt><From>${from}</From><To>${to}</To></ForecastInt></Area></Pref>`).join("");
  const body = options.cancel === true ? "<Text>緊急地震速報を取り消します。</Text>"
    : `<Earthquake><OriginTime>${options.at}</OriginTime><ArrivalTime>${options.at}</ArrivalTime><Hypocenter><Area><Name>${options.hypocenter ?? "豊後水道"}</Name>`
      + "<Code type=\"震央地名\">681</Code><jmx_eb:Coordinate description=\"北緯３３．２度　東経１３２．４度　深さ　３０ｋｍ\">+33.2+132.4-30000/</jmx_eb:Coordinate></Area></Hypocenter>"
      + "<jmx_eb:Magnitude type=\"Mj\" description=\"Ｍ５．８\">5.8</jmx_eb:Magnitude></Earthquake>"
      + `<Intensity><Forecast><ForecastInt><From>5-</From><To>5-</To></ForecastInt><ForecastLgInt><From>1</From><To>1</To></ForecastLgInt>${areas}</Forecast></Intensity>`;
  const title = family === "VXSE43" ? "緊急地震速報（警報）" : "緊急地震速報（予報）";
  return `<?xml version="1.0" encoding="UTF-8"?><Report xmlns="http://xml.kishou.go.jp/jmaxml1/"><Control><Title>${title}</Title>`
    + `<DateTime>${new Date(Date.parse(options.at) + (options.serial ?? 1)).toISOString()}</DateTime><Status>${options.status ?? "通常"}</Status>`
    + "<EditorialOffice>気象庁本庁</EditorialOffice><PublishingOffice>気象庁</PublishingOffice></Control>"
    + `<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/"><Title>${title}</Title><ReportDateTime>${options.at}</ReportDateTime>`
    + `<TargetDateTime>${options.at}</TargetDateTime><EventID>${options.eventId}</EventID><InfoType>${options.cancel === true ? "取消" : "発表"}</InfoType>`
    + `<Serial>${options.serial ?? 1}</Serial><InfoKind>緊急地震速報</InfoKind><InfoKindVersion>1.2_0</InfoKindVersion><Headline><Text>合成</Text></Headline></Head>`
    + `<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">${(options.body ?? ((text) => text))(body)}</Body></Report>`;
}
function eewStep(state: EewUnitState, xml: string, family: "VXSE43" | "VXSE45" = "VXSE43") {
  return reduceEewUnit(state, { kind: "receive", material: material(xml, family), clock: { wallTimeMs: reportTime(xml) + 1000, monotonicMs: 0 } });
}

// 射影の入力の共通部（空の起動の 1 step）。旧の射影の state は分野の items と画面のお知らせの出どころとしてだけ渡す。
type Base = Readonly<{ input: SnapshotProjectionInput; old: SnapshotProjectionState }>;
let base: Promise<Base> | null = null;
async function baseInput(): Promise<Base> {
  base ??= (async () => {
    const at = { wallTimeMs: Date.parse("2099-01-01T00:00:00+09:00"), monotonicMs: 1 };
    const input = projectionInput(await startup(at), at.wallTimeMs);
    return { input, old: projectSnapshot(input, null).state };
  })();
  return base;
}
type Units = Readonly<{ eew?: EewUnitState; tsunami?: TsunamiUnitState; quake?: SeismicUnitState }>;
// edit は worker を越えた写し（structuredClone）やカードの付いた view を試験が作るための口。
// P4-REMOVAL-LOSS-001 の材料の既定（件数・欠け・H28 の区間の無い publisher）。
const noRows = { losses: [] };
const quietLosses: DisplayWireInput["removalLoss"] = { at: 0, restored: false, hole: () => null, eewWindow: { count: 0, from: null, to: null },
  mirror: { "U-E": noRows, "U-W": noRows, "U-F": noRows, "U-T": noRows, "U-Q": noRows, "U-N": noRows, "U-V": noRows, "U-L": noRows, "U-R": noRows, "U-B": noRows, "U-M": noRows, "U-Y": noRows } };
async function wire(units: Units, changes: readonly RuntimeDisplayChange[], previous: DisplayWireState | null,
  edit: (views: DisplayWireInput["views"]) => DisplayWireInput["views"] = (views) => views, removalLoss = quietLosses): Promise<DisplayWireResult> {
  const { input, old } = await baseInput();
  const unitViews = { eew: toEewView(units.eew ?? emptyEew()), tsunami: toTsunamiView(units.tsunami ?? emptyTsunami()), earthquake: toSeismicView(units.quake ?? emptyQuake()) };
  const views = edit({ ...previous == null ? covering(unitViews, changes) : unitViews,
    weatherCurrent: input.weatherCurrent, weatherTimeseries: input.weatherTimeseries, nankai: input.nankai, volcano: input.volcano, landslide: input.landslide,
    flood: input.flood, briefing: input.briefing, localBulletins: input.localBulletins, typhoon: input.typhoon });
  return projectDisplayWire({ projection: { ...input, displayChanges: changes },
    views, confirmation: input.confirmation, notices: old.notices, removalLoss }, previous);
}
// 新しい経路は包みの items を自分の projectDomain で数え、最初の射影の差分が view を覆わないと止まる（startup の検査、P4-DV-AC11）。製品の起動の step は
// 全部の subject を足すので覆う。試験の手製の差分（合成の長周期・複製した報）に合わせ、保護 3 分野の view の要素と subjects を差分の after から組み直す
// （wire の中身は表示差分から作るので期待は変わらない、P4-DV-AC07 (3)）。
type Protected = Readonly<{ eew: DisplayWireInput["views"]["eew"]; tsunami: DisplayWireInput["views"]["tsunami"]; earthquake: DisplayWireInput["views"]["earthquake"] }>;
function covering(views: Protected, changes: readonly RuntimeDisplayChange[]): Protected {
  const last = new Map<string, RuntimeDisplayChange>();
  for (const change of changes) last.set(JSON.stringify([change.unit, change.operation, change.subject]), change);
  const afters = [...last.values()].flatMap((change) => change.after == null ? [] : [change.after]);
  const eew = afters.flatMap((after) => after.unit === "U-E" && after.current != null ? [after] : []);
  const tsunami = afters.flatMap((after) => after.unit === "U-T" && after.current != null ? [after] : []);
  const quake = afters.flatMap((after) => after.unit === "U-Q" && after.current != null ? [after] : []);
  return {
    eew: { ...views.eew, subjects: eew.flatMap((after) => after.subjects), current: eew.flatMap((after) => after.current == null ? [] : [after.current]) },
    tsunami: { ...views.tsunami, subjects: tsunami.flatMap((after) => after.subjects),
      forecasts: tsunami.flatMap((after) => after.current == null || "stations" in after.current ? [] : [after.current]),
      observations: tsunami.flatMap((after) => after.current != null && "stations" in after.current ? [after.current] : []) },
    earthquake: { ...views.earthquake, subjects: quake.flatMap((after) => after.subjects),
      earthquakes: quake.flatMap((after) => after.current != null && "sources" in after.current ? [after.current] : []),
      longPeriods: quake.flatMap((after) => after.current == null || "sources" in after.current ? [] : [after.current]) },
  };
}
function projected(result: DisplayWireResult): Extract<DisplayWireResult, { kind: "projected" }> {
  if (result.kind !== "projected") throw new Error("expected projected");
  return result;
}

export { baseInput, eewStep, eewXml, emptyEew, emptyQuake, emptyTsunami, fixture, material, projected, quietLosses, reportTime, wire };
export type { EewArea, Units };
