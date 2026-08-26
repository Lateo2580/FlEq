import { describe, expect, it } from "vitest";
import {
  createMockWsDataMessage,
  createMockWsDataMessageFromXml,
  FIXTURE_VPHW50_ALT,
  FIXTURE_VPHW50_TOKYO,
  FIXTURE_VPHW51_SIGHTING,
  readFixture,
} from "../../../helpers/mock-message";
import { selectPreferredTornadoLayer } from "../../../../src/dmdata/tornado-parser";
import { projectDisplayEvent } from "../../../../src/engine/display/project-event";
import { StandbyStateStore } from "../../../../src/engine/display/standby-state-store";
import { fromTornadoOutcome } from "../../../../src/engine/presentation/events/from-tornado";
import { toPresentationEvent } from "../../../../src/engine/presentation/events/to-presentation-event";
import {
  formatTornadoFullScopeLabel,
  projectTornadoDisplay,
  readTornadoBodyCoverage,
} from "../../../../src/engine/presentation/events/tornado-display";
import { processTornado } from "../../../../src/engine/presentation/processors/process-tornado";
import { processMessage } from "../../../../src/engine/presentation/processors/process-message";
import { makeProcessDeps } from "../../../helpers/process-deps";

const fullScopeXml = `<?xml version="1.0" encoding="UTF-8"?>
<Report>
  <Control><Title>竜巻注意情報</Title><PublishingOffice>気象庁</PublishingOffice></Control>
  <Head><Title>石川県竜巻注意情報</Title><ReportDateTime>2026-08-27T05:00:00+09:00</ReportDateTime><ValidDateTime>2026-08-27T06:00:00+09:00</ValidDateTime><InfoType>発表</InfoType><Serial>1</Serial><Headline>
    <Information type="竜巻注意情報（発表細分）"><Item><Kind><Name>竜巻注意情報</Name><Code>1</Code></Kind><Areas><Area><Name>石川県</Name><Code>170000</Code></Area></Areas></Item></Information>
    <Information type="竜巻注意情報（一次細分区域等）"><Item><Kind><Name>竜巻注意情報</Name><Code>1</Code></Kind><Areas><Area><Name>加賀</Name><Code>170010</Code></Area></Areas></Item></Information>
    <Information type="竜巻注意情報（市町村等をまとめた地域等）"><Item><Kind><Name>竜巻注意情報</Name><Code>1</Code></Kind><Areas><Area><Name>金沢地域</Name><Code>170011</Code></Area></Areas></Item></Information>
    <Information type="竜巻注意情報（市町村等）"><Item><Kind><Name>竜巻注意情報</Name><Code>1</Code></Kind><Areas><Area><Name>金沢市</Name><Code>1720100</Code></Area></Areas></Item><Item><Kind><Name>竜巻注意情報</Name><Code>1</Code></Kind><Areas><Area><Name>野々市市</Name><Code>1721200</Code></Area></Areas></Item></Information>
  </Headline></Head>
  <Body>
    <Warning type="竜巻注意情報（発表細分）"><Item><Kind><Name>竜巻注意情報</Name><Code>1</Code><Status>発表</Status></Kind><Area><Name>石川県</Name><Code>170000</Code></Area></Item></Warning>
    <Warning type="竜巻注意情報（一次細分区域等）"><Item><Kind><Name>竜巻注意情報</Name><Code>1</Code><Status>発表</Status></Kind><Area><Name>加賀</Name><Code>170010</Code></Area></Item></Warning>
    <Warning type="竜巻注意情報（市町村等をまとめた地域等）"><Item><Kind><Name>竜巻注意情報</Name><Code>1</Code><Status>発表</Status></Kind><Area><Name>金沢地域</Name><Code>170011</Code></Area></Item></Warning>
    <Warning type="竜巻注意情報（市町村等）"><Item><Kind><Name>竜巻注意情報</Name><Code>1</Code><Status>発表</Status></Kind><Area><Name>金沢市</Name><Code>1720100</Code></Area></Item><Item><Kind><Name>竜巻注意情報</Name><Code>1</Code><Status>発表</Status></Kind><Area><Name>野々市市</Name><Code>1721200</Code></Area></Item></Warning>
  </Body>
</Report>`;

function outcomeFromXml(xml: string) {
  const outcome = processTornado(createMockWsDataMessageFromXml(xml, "VPHW50"));
  if (outcome == null) throw new Error("synthetic tornado was not accepted");
  return outcome;
}

function mutateBody(xml: string, mutate: (body: string) => string): string {
  const start = xml.indexOf("<Body>");
  const end = xml.indexOf("</Body>", start);
  if (start < 0 || end < 0) throw new Error("Body was not found");
  const body = xml.slice(start, end + "</Body>".length);
  return `${xml.slice(0, start)}${mutate(body)}${xml.slice(end + "</Body>".length)}`;
}

function tornadoXml(
  reportDateTime: string,
  serial: string,
  infoType = "発表",
  partial = false,
): string {
  const base = fullScopeXml
    .replace("2026-08-27T05:00:00+09:00", reportDateTime)
    .replace("<Serial>1</Serial>", `<Serial>${serial}</Serial>`)
    .replace("<InfoType>発表</InfoType>", `<InfoType>${infoType}</InfoType>`);
  return partial
    ? mutateBody(base, (body) => body.replace(
      '<Item><Kind><Name>竜巻注意情報</Name><Code>1</Code><Status>発表</Status></Kind><Area><Name>野々市市</Name><Code>1721200</Code></Area></Item>',
      '<Item><Kind><Name>なし</Name><Code>0</Code><Status>なし</Status></Kind><Area><Name>野々市市</Name><Code>1721200</Code></Area></Item>',
    ))
    : base;
}

function processGatedTornado(xml: string, deps: ReturnType<typeof makeProcessDeps>) {
  const outcome = processMessage(createMockWsDataMessageFromXml(xml, "VPHW50"), "tornado", deps);
  return outcome?.domain === "tornado" ? outcome : null;
}

describe("tornado Body coverage reader", () => {
  it("長崎と東京の Body roster を active/none を残して読む", () => {
    const nagasaki = readTornadoBodyCoverage(createMockWsDataMessage(FIXTURE_VPHW50_ALT));
    const tokyo = readTornadoBodyCoverage(createMockWsDataMessage(FIXTURE_VPHW50_TOKYO));
    const sighting = readTornadoBodyCoverage(createMockWsDataMessage(FIXTURE_VPHW51_SIGHTING));
    const counts = (layers: NonNullable<typeof nagasaki>) =>
      layers.map((layer) => [
        layer.areas.filter((area) => area.status === "active").length,
        layer.areas.filter((area) => area.status === "none").length,
      ]);
    expect(nagasaki).not.toBeNull();
    expect(tokyo).not.toBeNull();
    expect(sighting).not.toBeNull();
    expect(counts(nagasaki!)).toEqual([[1, 0], [4, 0], [11, 0], [24, 0]]);
    expect(counts(tokyo!)).toEqual([[1, 2], [1, 2], [5, 4], [53, 8]]);
    expect(counts(sighting!)).toEqual([[1, 2], [1, 2], [5, 4], [53, 8]]);
  });

  it("4 層が全て active の石川型合成電文を全域として証明する", () => {
    const outcome = outcomeFromXml(fullScopeXml);
    const event = fromTornadoOutcome(outcome);
    expect(event.tornadoDisplay).toEqual({
      aggregation: "proven-full-scope",
      areaNames: ["石川県内全域"],
      sourceAreaCount: 2,
    });
    expect(event.areaItems.map((area) => area.name)).toEqual(["金沢市", "野々市市"]);
    expect(event.areaNames).toEqual(["金沢市", "野々市市"]);
    expect(event.areaCount).toBe(2);
    expect(projectDisplayEvent(event, "竜巻注意情報").tickerDetail).toContain("金沢市");
  });

  it("長崎だけを集約し、東京 VPHW50/VPHW51 は細粒度へ fail-closed する", () => {
    const nagasaki = fromTornadoOutcome(processTornado(createMockWsDataMessage(FIXTURE_VPHW50_ALT))!);
    expect(nagasaki.tornadoDisplay).toEqual({
      aggregation: "proven-full-scope",
      areaNames: ["長崎県内全域"],
      sourceAreaCount: 24,
    });

    for (const fixture of [FIXTURE_VPHW50_TOKYO, FIXTURE_VPHW51_SIGHTING]) {
      const outcome = processTornado(createMockWsDataMessage(fixture))!;
      const event = fromTornadoOutcome(outcome);
      expect(event.tornadoDisplay?.aggregation).toBe("none");
      expect(event.tornadoDisplay?.areaNames).toEqual(
        selectPreferredTornadoLayer(outcome.parsed.layers)?.areas.map((area) => area.name),
      );
      expect(readTornadoBodyCoverage(outcome.msg)?.at(-1)?.areas.filter((area) => area.status === "active"), fixture)
        .toHaveLength(53);
    }
  });

  it("Body の証拠不全では parsed を変えず既存の細粒度へ戻す", () => {
    const mutations: Array<[string, (xml: string) => string]> = [
      ["Body 欠落", (xml) => xml.replace(/<Body>[\s\S]*<\/Body>/, "")],
      ["必要 layer 欠落", (xml) => mutateBody(xml, (body) => body.replace(/<Warning type="竜巻注意情報（一次細分区域等）">[\s\S]*?<\/Warning>/, ""))],
      ["空 Area.Code", (xml) => mutateBody(xml, (body) => body.replace("<Code>1720100</Code>", "<Code></Code>"))],
      ["空 Area.Name", (xml) => mutateBody(xml, (body) => body.replace("<Name>金沢市</Name>", "<Name></Name>"))],
      ["属性付き Area.Name", (xml) => mutateBody(xml, (body) => body.replace("<Name>石川県</Name>", '<Name type="unsafe">石川県</Name>'))],
      ["Kind 欠落", (xml) => mutateBody(xml, (body) => body.replace("<Kind><Name>竜巻注意情報</Name><Code>1</Code><Status>発表</Status></Kind>", ""))],
      ["重複 Warning type", (xml) => mutateBody(xml, (body) => body.replace("竜巻注意情報（一次細分区域等）", "竜巻注意情報（発表細分）"))],
      ["重複 code", (xml) => xml.replaceAll("1721200", "1720100")],
      ["active/none 競合", (xml) => mutateBody(xml, (body) => body.replace(
        '<Item><Kind><Name>竜巻注意情報</Name><Code>1</Code><Status>発表</Status></Kind><Area><Name>野々市市</Name><Code>1721200</Code></Area></Item>',
        '<Item><Kind><Name>なし</Name><Code>0</Code><Status>なし</Status></Kind><Area><Name>野々市市</Name><Code>1720100</Code></Area></Item>',
      ))],
      ["Name/Code/Status 不一致", (xml) => mutateBody(xml, (body) => body.replace("<Name>竜巻注意情報</Name><Code>1</Code><Status>発表</Status>", "<Name>竜巻注意情報</Name><Code>0</Code><Status>発表</Status>"))],
      ["未知 layer", (xml) => mutateBody(xml, (body) => body.replace("竜巻注意情報（市町村等をまとめた地域等）", "竜巻注意情報（未知）"))],
    ];
    for (const [name, mutate] of mutations) {
      const outcome = outcomeFromXml(mutate(fullScopeXml));
      const before = structuredClone(outcome.parsed);
      const event = fromTornadoOutcome(outcome);
      if (name === "重複 code" || name === "active/none 競合") {
        expect(readTornadoBodyCoverage(outcome.msg), name).not.toBeNull();
      } else {
        expect(readTornadoBodyCoverage(outcome.msg), name).toBeNull();
      }
      const preferred = selectPreferredTornadoLayer(outcome.parsed.layers);
      expect(event.tornadoDisplay, name).toEqual({
        aggregation: "none",
        areaNames: preferred?.areas.map((area) => area.name) ?? [],
        sourceAreaCount: preferred?.areas.length ?? 0,
      });
      expect(outcome.parsed, name).toEqual(before);
      expect(outcome.parsed.activeAreaCount, name).toBeGreaterThan(0);
    }
  });

  it("全域ラベルは suffix と入力順を保持する", () => {
    expect(["東京都", "北海道", "大阪府", "長崎県", "東京地方"].map(formatTornadoFullScopeLabel))
      .toEqual(["東京都内全域", "北海道内全域", "大阪府内全域", "長崎県内全域", "東京地方全域"]);
    const outcome = outcomeFromXml(fullScopeXml.replace(
      '<Warning type="竜巻注意情報（発表細分）"><Item><Kind><Name>竜巻注意情報</Name><Code>1</Code><Status>発表</Status></Kind><Area><Name>石川県</Name><Code>170000</Code></Area></Item></Warning>',
      '<Warning type="竜巻注意情報（発表細分）"><Item><Kind><Name>竜巻注意情報</Name><Code>1</Code><Status>発表</Status></Kind><Area><Name>東京地方</Name><Code>130010</Code></Area></Item><Item><Kind><Name>竜巻注意情報</Name><Code>1</Code><Status>発表</Status></Kind><Area><Name>石川県</Name><Code>170000</Code></Area></Item></Warning>',
    ));
    expect(projectTornadoDisplay(outcome.msg, outcome.parsed.layers, selectPreferredTornadoLayer(outcome.parsed.layers)).areaNames)
      .toEqual(["東京地方全域", "石川県内全域"]);
  });

  it("rider state は bridge を使い、同一系列の全域→部分続報で細粒度へ完全置換する", () => {
    const store = new StandbyStateStore();
    const first = fromTornadoOutcome(outcomeFromXml(fullScopeXml));
    store.applyEvent(first, Date.parse(first.reportDateTime));
    expect(store.snapshotItems().find((item) => item.kind === "tornado")?.data)
      .toEqual({ areas: ["石川県内全域"], isSighted: false });

    const partialXml = mutateBody(fullScopeXml, (body) => body.replace(
      '<Item><Kind><Name>竜巻注意情報</Name><Code>1</Code><Status>発表</Status></Kind><Area><Name>野々市市</Name><Code>1721200</Code></Area></Item>',
      '<Item><Kind><Name>なし</Name><Code>0</Code><Status>なし</Status></Kind><Area><Name>野々市市</Name><Code>1721200</Code></Area></Item>',
    )).replace("2026-08-27T05:00:00+09:00", "2026-08-27T05:01:00+09:00")
      .replace("<Serial>1</Serial>", "<Serial>2</Serial>");
    const followup = fromTornadoOutcome(outcomeFromXml(partialXml));
    expect(followup.tornadoDisplay?.aggregation).toBe("none");
    store.applyEvent(followup, Date.parse(followup.reportDateTime));
    expect(store.snapshotItems().find((item) => item.kind === "tornado")?.data)
      .toEqual({ areas: ["金沢市", "野々市市"], isSighted: false });
  });

  it("真の重複 code は code 集合が一致しても集約を拒否する", () => {
    const outcome = outcomeFromXml(fullScopeXml.replaceAll("1721200", "1720100"));
    const coverage = readTornadoBodyCoverage(outcome.msg);
    expect(coverage?.at(-1)?.areas.map((area) => area.code)).toEqual(["1720100", "1720100"]);
    expect(projectTornadoDisplay(outcome.msg, outcome.parsed.layers, selectPreferredTornadoLayer(outcome.parsed.layers)))
      .toMatchObject({ aggregation: "none" });
  });

  it("revision gate 経由で部分→全域を置換し、遅着した部分報で全域表示を巻き戻さない", () => {
    const deps = makeProcessDeps();
    const store = new StandbyStateStore();
    const partial = processGatedTornado(tornadoXml("2026-08-27T05:00:00+09:00", "1", "発表", true), deps);
    const full = processGatedTornado(tornadoXml("2026-08-27T05:01:00+09:00", "2"), deps);
    expect(partial).not.toBeNull();
    expect(full).not.toBeNull();
    if (partial == null || full == null) return;
    store.applyEvent(toPresentationEvent(partial), Date.parse(partial.parsed.reportDateTime));
    expect(store.snapshotItems().find((item) => item.kind === "tornado")?.data.areas)
      .toEqual(["金沢市", "野々市市"]);
    store.applyEvent(toPresentationEvent(full), Date.parse(full.parsed.reportDateTime));
    expect(store.snapshotItems().find((item) => item.kind === "tornado")?.data.areas)
      .toEqual(["石川県内全域"]);
    expect(processGatedTornado(tornadoXml("2026-08-27T05:00:00+09:00", "1", "発表", true), deps)).toBeNull();
    expect(store.snapshotItems().find((item) => item.kind === "tornado")?.data.areas)
      .toEqual(["石川県内全域"]);
  });

  it("revision gate は訂正 replay、取消後の旧全域復活、TTL 後の旧報を拒否する", () => {
    const correctionDeps = makeProcessDeps();
    const correctionStore = new StandbyStateStore();
    const first = processGatedTornado(tornadoXml("2026-08-27T05:00:00+09:00", "1"), correctionDeps);
    const correction = processGatedTornado(tornadoXml("2026-08-27T05:00:00+09:00", "1", "訂正", true), correctionDeps);
    expect(first).not.toBeNull();
    expect(correction).not.toBeNull();
    if (first == null || correction == null) return;
    correctionStore.applyEvent(toPresentationEvent(first), Date.parse(first.parsed.reportDateTime));
    correctionStore.applyEvent(toPresentationEvent(correction), Date.parse(correction.parsed.reportDateTime));
    expect(correctionStore.snapshotItems().find((item) => item.kind === "tornado")?.data.areas)
      .toEqual(["金沢市", "野々市市"]);
    expect(processGatedTornado(tornadoXml("2026-08-27T05:00:00+09:00", "1", "訂正", true), correctionDeps)).toBeNull();
    expect(correctionStore.snapshotItems().find((item) => item.kind === "tornado")?.data.areas)
      .toEqual(["金沢市", "野々市市"]);

    const cancellationDeps = makeProcessDeps();
    const cancellationStore = new StandbyStateStore();
    const active = processGatedTornado(tornadoXml("2026-08-27T05:00:00+09:00", "1"), cancellationDeps);
    const cancellation = processGatedTornado(tornadoXml("2026-08-27T05:01:00+09:00", "2", "取消"), cancellationDeps);
    expect(active).not.toBeNull();
    expect(cancellation).not.toBeNull();
    if (active == null || cancellation == null) return;
    cancellationStore.applyEvent(toPresentationEvent(active), Date.parse(active.parsed.reportDateTime));
    cancellationStore.applyEvent(toPresentationEvent(cancellation), Date.parse(cancellation.parsed.reportDateTime));
    expect(cancellationStore.snapshotItems().find((item) => item.kind === "tornado")).toBeUndefined();
    expect(processGatedTornado(tornadoXml("2026-08-27T05:00:00+09:00", "1"), cancellationDeps)).toBeNull();
    expect(cancellationStore.snapshotItems().find((item) => item.kind === "tornado")).toBeUndefined();

    const ttlDeps = makeProcessDeps();
    const ttlStore = new StandbyStateStore();
    const ttl = processGatedTornado(tornadoXml("2026-08-27T05:00:00+09:00", "1"), ttlDeps);
    expect(ttl).not.toBeNull();
    if (ttl == null) return;
    ttlStore.applyEvent(toPresentationEvent(ttl), Date.parse(ttl.parsed.reportDateTime));
    ttlStore.sweep(Date.parse("2026-08-27T06:01:00+09:00"));
    expect(ttlStore.snapshotItems().find((item) => item.kind === "tornado")).toBeUndefined();
    expect(processGatedTornado(tornadoXml("2026-08-27T05:00:00+09:00", "1"), ttlDeps)).toBeNull();
  });

  it("restore 後の durable revision gate も取消済み系列を古い全域報で復活させない", () => {
    const deps = makeProcessDeps();
    const store = new StandbyStateStore();
    const active = processGatedTornado(tornadoXml("2026-08-27T05:00:00+09:00", "1"), deps);
    const cancellation = processGatedTornado(tornadoXml("2026-08-27T05:01:00+09:00", "2", "取消"), deps);
    expect(active).not.toBeNull();
    expect(cancellation).not.toBeNull();
    if (active == null || cancellation == null) return;
    store.applyEvent(toPresentationEvent(active), Date.parse(active.parsed.reportDateTime));
    store.applyEvent(toPresentationEvent(cancellation), Date.parse(cancellation.parsed.reportDateTime));
    const restoredDeps = makeProcessDeps();
    restoredDeps.revisionGate.restoreDurableEntries(deps.revisionGate.exportDurableEntries());
    const restoredStore = new StandbyStateStore();
    restoredStore.restoreActiveState(store.exportActiveState(), Date.parse("2026-08-27T05:02:00+09:00"));
    expect(processGatedTornado(tornadoXml("2026-08-27T05:00:00+09:00", "1"), restoredDeps)).toBeNull();
    expect(restoredStore.snapshotItems().find((item) => item.kind === "tornado")).toBeUndefined();
  });
});
