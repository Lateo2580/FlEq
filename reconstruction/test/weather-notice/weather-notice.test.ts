import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { AcquisitionOrigin, DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type { NotificationIntent } from "../../contracts/p2-shared-runtime.types";
import type { NotificationAttempt, NotificationDeliveryState } from "../../contracts/p2-notification-delivery.types";
import type { WeatherCurrentUnitState } from "../../contracts/p2-weather-current-unit.types";
import { INPUT_BOUNDARY_MAX_BYTES, LOSS_TALLY_MAX_BYTES, UNREADABLE_CARDS_MAX_BYTES, serializedEnvelope } from "../../src/checkpoint/checkpoint";
import { decodeMaterial } from "../../src/decode-material/decode-material";
import { ingestXmlData } from "../../src/ingress/ingress";
import { deliveryGrowth } from "../../src/notification-delivery/delivery-growth";
import { selectNotificationAttempt } from "../../src/notification-delivery/notification-delivery";
import { initialUnits } from "../../src/runtime/owner-runtime";
import { freshState, versionDigest } from "../../src/units/notice-mark";
import { noticeReserve } from "../../src/units/weather-current/weather-current-notice";
import { reduceWeatherCurrentUnit, weatherCurrentUnit, weatherCurrentUnitCodec } from "../../src/units/weather-current/weather-current-unit";

// P3-WEATHER-NOTICE-001（C20）: U-W の通知。全国報と府県の報の順・取消・段の無い特別警報・部分の終了は、公開の電文の
// ReportDateTime・InfoType・Kind/Code・区域を試験の中で書き換えて作る（新しい fixture は足さない、Q-WN-CORPUS）。

const NOW = Date.parse("2026-08-30T12:00:00+09:00");
const LIMIT = weatherCurrentUnitCodec.maxEnvelopeBytes!;
const L5 = "18_00_01_260830_VPWW55_fukui_L5", DOWN = "18_00_01_260830_VPWW55_fukui_downgrade", RELEASE = "18_00_01_260830_VPWW55_fukui_release";
const SWITCH = "18_00_01_260830_VPNO50_switch", NATIONAL = "15_18_01_250630_VPWS50", MATSUE = "15_17_01_251222_VPWW55", KYOTO = "15_16_02_251222_VPWW57";
const NAMES: Readonly<Record<string, string>> = { "33": "レベル５大雨特別警報", "43": "レベル４大雨危険警報", "03": "レベル３大雨警報" };

const clock = (wallTimeMs = NOW, monotonicMs = 0) => ({ wallTimeMs, monotonicMs });
const empty = (): WeatherCurrentUnitState => initialUnits["U-W"];
const text = (file: string) => readFileSync(`test/fixtures/${file}.xml`, "utf8");
function decodeXml(xml: string, headType: string, inputId: string, origin: AcquisitionOrigin = "replay"): DecodedMaterial {
  const entered = ingestXmlData({ inputId, inputSequence: 1, receivedAt: NOW, origin, kind: "replay", body: Buffer.from(xml), headType });
  if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
  return decoded.material;
}
const decode = (file: string, headType: string, change: (xml: string) => string = (xml) => xml, inputId = file, origin: AcquisitionOrigin = "replay") =>
  decodeXml(change(text(file)), headType, inputId, origin);
const receive = (state: WeatherCurrentUnitState, material: DecodedMaterial, at = clock()) =>
  reduceWeatherCurrentUnit(state, { kind: "receive", material, clock: at });

const retime = (time: string) => (xml: string) => xml.replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${time}</ReportDateTime>`);
const training = (xml: string) => xml.replace("<Status>通常</Status>", "<Status>訓練</Status>");
// 同じ ReportDateTime の取消（取消は同じ時刻の報に勝つ、P3-VM-AC03）。
const cancel = (xml: string) => xml.replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>").replace(/<Body[\s\S]*<\/Body>/, "<Body/>");
const areaOf = (item: string) => /<Area>\s*<Name>[^<]*<\/Name>\s*<Code>(\d+)<\/Code>/.exec(item)?.[1] ?? "";
// 全国報（15_18_01_250630_VPWS50）の Item の Kind を、codeOf が区域 Code に返す code 1 つにした報（undefined の区域は元のまま）。
function national(codeOf: (area: string) => string | undefined, time: string): string {
  const kind = (value: string) => `<Kind><Name>${NAMES[value] ?? value}</Name><Code>${value}</Code><Status>発表</Status></Kind>`;
  return retime(time)(text(NATIONAL)).replace(/<Item>([\s\S]*?)<\/Item>/g, (item: string, inner: string) => {
    const value = codeOf(areaOf(inner));
    return value == null ? item : `<Item>${inner.replace(/<Kind>[\s\S]*?<\/Kind>\s*/g, "").replace("<Area>", `${kind(value)}<Area>`)}</Item>`;
  });
}
const byPrefecture = (codes: Readonly<Record<string, string>>) => (area: string) => codes[area.slice(0, 2)];
// fukui_L5 で Kind/Code 33 の区域だけ（全国報が府県の報と同じ L5 を載せる場面）。
const FUKUI_L5 = new Set([...text(L5).matchAll(/<Item>([\s\S]*?)<\/Item>/g)].flatMap(([, inner]) =>
  /<Kind>\s*<Name>[^<]*<\/Name>\s*<Code>33<\/Code>/.test(inner) ? [areaOf(inner)] : []));
const asFukui = (code: string, also: Readonly<Record<string, string>> = {}) => (area: string) => FUKUI_L5.has(area) ? code : also[area.slice(0, 2)];
// 気象特別警報報知（終了）の区域をその府県に書き換えた報（官署は府県ごとに別の系列）。
const ending = (prefecture: string, time: string) => decodeXml(retime(time)(text(SWITCH)).replace("<Code>180000</Code>", `<Code>${prefecture}0000</Code>`)
  .replace(/<EditorialOffice>[^<]*<\/EditorialOffice>/, `<EditorialOffice>${prefecture}地方気象台</EditorialOffice>`), "VPNO50", `end-${prefecture}-${time}`);
// fukui_L5 を栃木県（09）の官署の報に写したもの（区域 Code の先頭 2 桁と府県名）。
const tochigi = (xml: string) => xml.replace(/<EditorialOffice>福井地方気象台<\/EditorialOffice>/, "<EditorialOffice>宇都宮地方気象台</EditorialOffice>")
  .replace(/<Code>18(\d{4,5})<\/Code>/g, "<Code>09$1</Code>").replace(/福井県/g, "栃木県");

const shape = (intents: readonly NotificationIntent[]) => intents.map((item) => [item.channel, item.payload.level]);
const delivered = (state: WeatherCurrentUnitState) => reduceWeatherCurrentUnit(state, { kind: "intentUpdate", clock: clock(), intentUpdate: state.intents.map((item) => ({
  id: item.id, attempts: 1, nextAttemptAt: item.nextAttemptAt, disposition: "delivered" as const, lastAttempt: null, replayed: false, expiresAt: item.expiresAt, lossReason: null })) }).state;
const prefecturesOf = (item: NotificationIntent) => {
  const targets = item.payload.targets;
  return Array.isArray(targets) ? [...new Set(targets.map((target) => Array.isArray(target) ? target[0] : null))] : [];
};

describe("P3-WEATHER-NOTICE-001 U-W notices", () => {
  // acceptance: AC01・AC02・AC04。
  it("P3-WN-T01 acceptance / AC01・AC02・AC04: fukui_L5 rings critical once; the downgrade and the release do not; training is desktop only", () => {
    const raised = receive(empty(), decode(L5, "VPWW55"));
    expect(raised.intents.map((item) => [item.channel, item.payload.level, item.priorityGroup, item.payload.title])).toEqual(
      ["desktop", "sound"].map((channel) => [channel, "critical", "other", "大雨特別警報（福井県）"]));
    expect(String(raised.intents[0].payload.body).startsWith("大雨特別警報 福井県嶺北")).toBe(true);
    const lowered = receive(raised.state, decode(DOWN, "VPWW55"));
    expect([lowered.intents, receive(lowered.state, decode(RELEASE, "VPWW55")).intents]).toEqual([[], []]);
    expect(shape(receive(empty(), decode(L5, "VPWW55", training, "training")).intents)).toEqual([["desktop", "critical"]]);
    // P3-USD-AC02 (3): 空の U-W に引下げだけを受けると、「特別警報から危険警報」の区域は数えず、直前も危険警報の坂井市・永平寺町だけで 1 件。
    const bodies = (change: (xml: string) => string, inputId: string) => receive(empty(), decode(DOWN, "VPWW55", change, inputId)).intents.map((item) => item.payload.body);
    expect(bodies((xml) => xml, "cold")).toEqual(["大雨危険警報 福井県坂井市、福井県永平寺町"]);
    // P3-USD-AC01 (5): 同じ区域の Item が 2 つなら、受理が採った後の行で読む（嶺北の後に「発表」の 43 の Item を足すと嶺北が上がる）。
    expect(bodies((xml) => xml.replace(/(<Body[\s\S]*?<Code>180010<\/Code>[\s\S]*?<\/Item>)/, "$1<Item><Kind><Name>レベル４大雨危険警報</Name><Code>43</Code><Status>発表</Status></Kind><Area><Name>嶺北</Name><Code>180010</Code></Area></Item>"), "duplicate")).toEqual(["大雨危険警報 福井県嶺北"]);
    // P3-USD-AC01 (2): 外すのは L4 の行だけ。嶺北を 43 で受けた後、新しい版が同じ区域を Code 33（Status は引下げのまま）にすると L5 に上がって鳴る。
    const toL5 = (xml: string) => { const at = xml.lastIndexOf("<Code>43</Code>", xml.indexOf("<Code>180010</Code>", xml.indexOf("<Body"))); return retime("2026-08-30T11:50:00+09:00")(xml.slice(0, at) + "<Code>33</Code>" + xml.slice(at + 15)); };
    expect(shape(receive(receive(empty(), decode(DOWN, "VPWW55", (xml) => xml, "before-l5")).state, decode(DOWN, "VPWW55", toL5, "to-l5")).intents)).toEqual([["desktop", "critical"], ["sound", "critical"]]);
  });

  // acceptance: AC01・AC03・AC06 (2)。
  it("P3-WN-T02 acceptance / AC01・AC03・AC06: landslide and ending make nothing, codes by the tens digit, and a pending lives while any target holds", () => {
    const fukui = receive(empty(), decode(L5, "VPWW55")).state;
    expect([receive(empty(), decode(NATIONAL, "VPWS50")).intents, receive(fukui, decode(SWITCH, "VPNO50")).intents]).toEqual([[], []]);
    expect(shape(receive(empty(), decode(L5, "VPWW55", (xml) => xml.replace(/<Code>33<\/Code>/g, "<Code>35</Code>"))).intents))
      .toEqual([["desktop", "critical"], ["sound", "critical"]]);
    expect(shape(receive(empty(), decode(DOWN, "VPWW55", (xml) => xml.replace(/<Code>43<\/Code>/g, "<Code>48</Code>").replace(/<Code>33<\/Code>/g, "<Code>03</Code>"))).intents))
      .toEqual([["desktop", "warning"]]);
    // 部分の終了（品質 r0 の P2-1）: 2 府県の L5 の pending は片方の終了では残り、両方の終了で外れる。
    const both = receive(empty(), decodeXml(national(byPrefecture({ 18: "33", "09": "33" }), "2026-08-30T10:00:00+09:00"), "VPWS50", "n-both"));
    expect(both.intents.map(prefecturesOf)).toEqual([["09", "18"], ["09", "18"]]);
    const endedA = receive(both.state, ending("18", "2026-08-30T11:40:00+09:00"));
    expect(endedA.state.intents.map((item) => item.id)).toEqual(both.state.intents.map((item) => item.id));
    expect(receive(endedA.state, ending("09", "2026-08-30T11:50:00+09:00")).state.intents).toEqual([]);
    // 品質 r1 の列: N1 で B（09）が L5 を配った後、N2 で A（18）が新しく L5（targets は A だけ）、A だけの終了で外れる。
    const first = delivered(receive(empty(), decodeXml(national(byPrefecture({ "09": "33" }), "2026-08-30T10:00:00+09:00"), "VPWS50", "n1")).state);
    const second = receive(first, decodeXml(national(byPrefecture({ 18: "33", "09": "33" }), "2026-08-30T10:10:00+09:00"), "VPWS50", "n2"));
    expect(second.intents.map(prefecturesOf)).toEqual([["18"], ["18"]]);
    expect(receive(second.state, ending("18", "2026-08-30T11:40:00+09:00")).state.intents).toEqual([]);
    // 府県の報 P の L5（pending）→ 同じ L5 を載せる全国報 N（差なし）→ P の取消（履歴なし）でも P の pending は残る。
    const carried = receive(receive(empty(), decode(L5, "VPWW55")).state, decodeXml(national(asFukui("33"), "2026-08-30T08:00:00+09:00"), "VPWS50", "n"));
    expect(carried.intents).toEqual([]);
    const withdrawn = receive(carried.state, decode(L5, "VPWW55", cancel, "p-cancel"));
    expect(withdrawn.state.intents.filter((item) => item.transition !== "cancelled").map((item) => item.id))
      .toEqual(carried.state.intents.map((item) => item.id));
  });

  // acceptance: AC02（P3-WN-D-MERGED=A）。
  it("P3-WN-T03 acceptance / AC02: a national report carrying the partial's L5 does not ring again in either order; a new prefecture rings alone", () => {
    const fukui = receive(empty(), decode(L5, "VPWW55")).state;
    expect(receive(fukui, decodeXml(national(asFukui("33"), "2026-08-30T08:00:00+09:00"), "VPWS50", "n")).intents).toEqual([]);
    const first = receive(empty(), decodeXml(national(asFukui("33"), "2026-08-30T08:00:00+09:00"), "VPWS50", "n"));
    expect([first.intents.length, receive(first.state, decode(L5, "VPWW55")).intents]).toEqual([2, []]);
    const other = receive(fukui, decodeXml(national(asFukui("33", { "09": "33" }), "2026-08-30T08:00:00+09:00"), "VPWS50", "n"));
    expect(other.intents.map((item) => [item.payload.title, String(item.payload.body).includes("福井"), prefecturesOf(item)])).toEqual(
      [["大雨特別警報（栃木県）", false, ["09"]], ["大雨特別警報（栃木県）", false, ["09"]]]);
  });

  // acceptance: AC03・AC04（P3-WN-D-CANCEL・CANCEL-HEARD=A）。
  it("P3-WN-T04 acceptance / AC03・AC04: the cancel channel follows the L5 of the versions before and after, and an unheard non-L4 series is silent", () => {
    const lowered = receive(receive(empty(), decode(L5, "VPWW55")).state, decode(DOWN, "VPWW55")).state;
    const back = receive(lowered, decode(DOWN, "VPWW55", cancel, "down-cancel"));
    expect(back.intents.map((item) => [item.channel, item.payload.level, item.payload.title])).toEqual(
      ["desktop", "sound"].map((channel) => [channel, "cancel", "[取消] 福井県大雨警報・注意報（11:40 発表）"]));
    const downOnly = receive(empty(), decode(DOWN, "VPWW55")).state;
    expect(shape(receive(downOnly, decode(DOWN, "VPWW55", cancel, "down-cancel")).intents)).toEqual([["desktop", "cancel"]]);
    const plain = receive(empty(), decode(MATSUE, "VPWW55"));
    expect(plain.intents).toEqual([]);
    expect(receive(plain.state, decode(MATSUE, "VPWW55", cancel, "m-cancel")).intents).toEqual([]);
    const series = plain.state.partials[0];
    const heard: WeatherCurrentUnitState = { ...plain.state, notices: [{ subject: series.subject, operation: series.operation,
      notice: { version: "0".repeat(16), kinds: ["report"], evidence: "possible" } }] };
    expect(shape(receive(heard, decode(MATSUE, "VPWW55", cancel, "m-cancel")).intents)).toEqual([["desktop", "cancel"]]);
  });

  // contractBoundary: AC06 (1)(2)。境界の state は直に組む（報を流すと同じ区域は段が上がらないので 128 件にならない）。
  it("P3-WN-T05 contractBoundary / AC06: 128 pending fit and 129 evict from the back of the A7 order", () => {
    const fresh = receive(empty(), decode(L5, "VPWW55")).intents;
    // 件数の境界は byte に届かない小さい pending で見る（targets は 1 件、文面は 1 文字）。
    const target = Array.isArray(fresh[0].payload.targets) ? fresh[0].payload.targets[0] : null;
    const seed = (count: number): NotificationIntent[] => Array.from({ length: count }, (_, index) => ({ ...fresh[0], id: `seed-${index}`,
      payload: { ...fresh[0].payload, title: "x", body: "x", targets: [target] }, createdAt: NOW - 1_000, expiresAt: NOW + 10_000_000 }));
    const fits = receive({ ...empty(), intents: seed(126) }, decode(L5, "VPWW55"));
    expect([fits.intents.length, fits.state.intents.length, fits.diagnostics]).toEqual([2, 128, []]);
    const over = receive({ ...empty(), intents: seed(127) }, decode(L5, "VPWW55"));
    expect([over.intents.length, over.state.intents.length, over.state.intents.some((item) => item.id === "seed-99"), over.diagnostics]).toEqual([2, 128, false,
      [{ level: "INFO", component: "weather-current", reason: "notificationCapacityEvicted", unit: "U-W", count: 1 }]]);
    // 新しい intent だけが外れるときも、pending の配列は変えずに欠けを数える（H39）。
    const busy: WeatherCurrentUnitState = { ...empty(), intents: seed(128).map((item) => ({ ...item, expiresAt: NOW + 1 })) };
    const dropped = receive(busy, decode(L5, "VPWW55", training, "busy"));
    expect([dropped.intents, dropped.state.intents === busy.intents, dropped.diagnostics]).toEqual([[], true,
      [{ level: "INFO", component: "weather-current", reason: "notificationCapacityEvicted", unit: "U-W", count: 1 }]]);
  });

  it("P3-WN-T05 contractBoundary / AC06: 131,072 bytes with the delivery reserve fit and one more byte evicts", () => {
    const fresh = receive(empty(), decode(L5, "VPWW55")).intents;
    const seed = (pad: number): NotificationIntent => ({ ...fresh[0], id: "seed", payload: { ...fresh[0].payload, title: "x".repeat(1 + pad) },
      createdAt: NOW - 1_000, expiresAt: NOW + 10_000_000 });
    const bytes = (items: readonly NotificationIntent[]) => Buffer.byteLength(JSON.stringify(items)) + items.reduce((sum, item) => sum + deliveryGrowth(item), 0);
    const pad = 131_072 - bytes([seed(0), ...fresh]);
    const exact = receive({ ...empty(), intents: [seed(pad)] }, decode(L5, "VPWW55"));
    expect([bytes(exact.state.intents), exact.diagnostics]).toEqual([131_072, []]);
    expect(() => weatherCurrentUnitCodec.encode(exact.state)).not.toThrow();
    const over = receive({ ...empty(), intents: [seed(pad + 1)] }, decode(L5, "VPWW55"));
    expect([over.state.intents.map((item) => item.id), over.diagnostics]).toEqual([fresh.map((item) => item.id),
      [{ level: "INFO", component: "weather-current", reason: "notificationCapacityEvicted", unit: "U-W", count: 1 }]]);
  });

  // 契約適合 r3 の P2: 印を失った系列の pending が残ったまま同じ報を受け直しても、同じ id の intent を足さない（encode が throw しない）。
  it("P3-WN-T05 contractBoundary / AC06 (2): a pending with the same id is not added twice", () => {
    const issued = receive(empty(), decode(L5, "VPWW55", training, "p")), first = issued.state;
    expect([issued.intents.length, first.intents.length]).toEqual([1, 1]); // training の desktop の pending が 1 件ある（ヘルツ r0 の P3）
    const lost: WeatherCurrentUnitState = { ...first, partials: [], histories: [], ownership: {}, unconfirmed: [], notices: [] };
    const again = receive(lost, decode(L5, "VPWW55", training, "p"));
    expect([again.intents, again.state.intents.map((item) => item.id)]).toEqual([[], first.intents.map((item) => item.id)]);
    expect(() => weatherCurrentUnitCodec.encode(again.state)).not.toThrow();
  });

  // contractBoundary: AC05・AC07。
  it("P3-WN-T06 contractBoundary / AC05・AC07: v8 round trip, v7 and broken marks are invalid, a started pending restores as unknown", () => {
    const issued = receive(empty(), decode(L5, "VPWW55")).state;
    const encoded = weatherCurrentUnitCodec.encode(issued);
    expect(weatherCurrentUnitCodec.decode(JSON.parse(JSON.stringify(encoded)))).toMatchObject({ kind: "restored",
      state: { notices: issued.notices, intents: issued.intents, partials: issued.partials } });
    const [mark] = encoded.notices;
    for (const broken of [{ ...encoded, schemaVersion: "p2-weather-current-unit-v7" }, { ...encoded, notices: [mark, mark] },
      { ...encoded, notices: [mark, { ...mark, subject: "normal/VPWW55/無い官署" }] }, { ...encoded, notices: [{ ...mark, notice: { ...mark.notice, evidence: "heard" } }] },
      // 型の 3 つの形のどれにも当たらない payload（targets の無い取消に取り直しの対）は invalid（契約適合 r0 の P3-3）。
      { ...encoded, intents: [{ ...encoded.intents[0], transition: "cancelled", payload: { domain: "weather", level: "cancel", title: "t", body: "b", reportDateTime: "x", recovered: true } }] }])
      expect(weatherCurrentUnitCodec.decode(JSON.parse(JSON.stringify(broken))).kind).toBe("invalid");
    const [desktop] = issued.intents;
    const started = reduceWeatherCurrentUnit(issued, { kind: "intentUpdate", clock: clock(), intentUpdate: { id: desktop.id, attempts: 1,
      nextAttemptAt: desktop.nextAttemptAt, disposition: "pending", lastAttempt: "started", replayed: false, expiresAt: desktop.expiresAt, lossReason: null } }).state;
    expect(started.notices[0].notice.evidence).toBe("possible");
    const restored = reduceWeatherCurrentUnit(empty(), { kind: "restore", persisted: weatherCurrentUnitCodec.encode(started), clock: clock(NOW + 1) });
    expect([restored.state.intents.map((item) => item.channel), restored.state.notices[0].notice.evidence, restored.diagnostics]).toEqual([["sound"], "unknown",
      [{ level: "INFO", component: "weather-current", reason: "notificationOutcomeUnknown", unit: "U-W", count: 1 }]]);
    expect(receive(restored.state, decode(L5, "VPWW55")).intents).toEqual([]);
  });

  // contractBoundary: AC06 (3)（P3-UWC-T08 の形）。
  it("P3-WN-T07 contractBoundary / AC06 (3): counting intents as 131,072 bytes evicts a normal history version and the L5 adoption still encodes", () => {
    const unused = (generation: number) => 62 + INPUT_BOUNDARY_MAX_BYTES + LOSS_TALLY_MAX_BYTES + UNREADABLE_CARDS_MAX_BYTES
      - (JSON.stringify(generation).length - 1) - (JSON.stringify(NOW).length - 1);
    const actual = (value: WeatherCurrentUnitState) => serializedEnvelope({ schemaVersion: value.schemaVersion, unit: "U-W",
      generation: value.persistence.currentGeneration, capturedAt: NOW, payload: weatherCurrentUnitCodec.encode(value), sha256: "0".repeat(64) }).byteLength
      + unused(value.persistence.currentGeneration);
    let state = empty();
    for (const minute of ["00", "10", "20"]) state = receive(state, decode(KYOTO, "VPWW57", retime(`2020-06-22T23:${minute}:00+09:00`), `v${minute}`)).state;
    const padded = (length: number): WeatherCurrentUnitState => ({ ...state, partials: [...state.partials, { ...state.partials[0], subject: "normal/VPWW55/詰め物",
      office: "詰め物", source: { ...state.partials[0].source, subject: "normal/VPWW55/詰め物", inputId: "pad" }, phenomena: { padding: "x".repeat(length) } }] });
    const candidate = decode(L5, "VPWW55");
    const probe = receive(padded(0), candidate);
    // 受理の器の判定は通知を足す前の state で、intents を 131,072 byte と数え、受けた報の系列の印 1 件の上界を足す。
    const atAdmission = actual({ ...probe.state, intents: [], notices: state.notices }) + 131_072 + noticeReserve(probe.decisions[0]);
    const accepted = receive(padded(LIMIT - atAdmission + 1), candidate);
    expect(accepted.diagnostics).toContainEqual({ level: "INFO", component: "weather-current", reason: "weatherCurrentCapacityEvicted", unit: "U-W", count: 1 });
    expect(shape(accepted.intents)).toEqual([["desktop", "critical"], ["sound", "critical"]]);
    expect(() => weatherCurrentUnitCodec.encode(accepted.state)).not.toThrow();
    expect(actual(accepted.state)).toBeLessThanOrEqual(LIMIT);
  });

  // acceptance: AC12（H27、P3-WN-D-UW-H27=A・H27-L4=A）。
  it("P3-WN-T11 acceptance / AC12: the recovery adoption rings one info, minus the same version and what live already holds", () => {
    const at = (live: WeatherCurrentUnitState) => ({ recoveryId: "r", clock: clock(), basis: "verified" as const, live, card: null });
    const notices = (open: WeatherCurrentUnitState, adopted: WeatherCurrentUnitState, where: ReturnType<typeof at>) => {
      const row = weatherCurrentUnit.recoveryNotices;
      if (row == null) throw new Error("U-W has no recoveryNotices");
      return row(open, adopted, where);
    };
    const recovered = (state: WeatherCurrentUnitState, material: DecodedMaterial) => receive(state, material).state;
    const fromRecovery = (file: string, headType: string, change: (xml: string) => string = (xml) => xml, inputId = `rec-${file}`) =>
      decode(file, headType, change, inputId, "recovery");
    const infos = (state: WeatherCurrentUnitState) => state.intents.filter((item) => item.payload.recovered === true);
    const l5 = recovered(empty(), fromRecovery(L5, "VPWW55"));
    expect(l5.intents).toEqual([]);
    expect(infos(notices(empty(), l5, at(empty()))).map((item) => [item.channel, item.payload.level, item.payload.title])).toEqual(
      ["desktop", "sound"].map((channel) => [channel, "info", "大雨特別警報（06:51 発表）"]));
    expect(shape(infos(notices(empty(), recovered(empty(), fromRecovery(DOWN, "VPWW55")), at(empty()))))).toEqual([["desktop", "info"], ["sound", "info"]]);
    expect(notices(l5, l5, at(l5))).toBe(l5);
    const series = l5.partials[0];
    const marked: WeatherCurrentUnitState = { ...l5, notices: [{ subject: series.subject, operation: series.operation,
      notice: { version: versionDigest(series.source), kinds: ["report"], evidence: "unattempted" } }] };
    expect(notices(empty(), marked, at(empty()))).toBe(marked);
    // live で fukui_L5 を知らせた後、取り直しで同じ 33 を載せる全国報を採っても info は無い（at.live が同じ段）。
    const live = receive(empty(), decode(L5, "VPWW55")).state;
    const nationalL5 = (time: string, id: string) => decodeXml(national(asFukui("33"), time), "VPWS50", id, "recovery");
    expect(infos(notices(empty(), recovered(live, nationalL5("2026-08-30T08:00:00+09:00", "rn")), at(live)))).toEqual([]);
    // 品質 r1: live の P（未配送）→ 取り直しで新しい全国報 N と P の取消 → P の pending が残り（N が支える）、info は無い。
    const r1 = notices(empty(), recovered(recovered(live, nationalL5("2026-08-30T08:00:00+09:00", "rn")), fromRecovery(L5, "VPWW55", cancel, "rp-cancel")), at(live));
    expect([r1.intents.map((item) => item.id), infos(r1)]).toEqual([live.intents.map((item) => item.id), []]);
    // 品質 r2: 取り直しの N が A を L3 へ下げ、P2 が L5 に戻す → P1 の pending は最終の candidate で残り、info は無い。
    const lowered = recovered(live, decodeXml(national(asFukui("03"), "2026-08-30T08:00:00+09:00"), "VPWS50", "rn3", "recovery"));
    const r2 = notices(empty(), recovered(lowered, fromRecovery(L5, "VPWW55", retime("2026-08-30T09:00:00+09:00"), "rp2")), at(live));
    expect([r2.intents.map((item) => item.id), infos(r2)]).toEqual([live.intents.map((item) => item.id), []]);
    // 品質 r3: N1 で A・B が L4 → N2 で A を外し B は継続（pending は B で残る）→ 取り直しの P が A を L4 → at.live の A は段なしなので info を 1 組。
    const n1 = receive(empty(), decodeXml(national(byPrefecture({ 18: "43", "09": "43" }), "2026-08-30T09:00:00+09:00"), "VPWS50", "n1")).state;
    const n2 = receive(n1, decodeXml(national(byPrefecture({ 18: "03", "09": "43" }), "2026-08-30T10:00:00+09:00"), "VPWS50", "n2")).state;
    expect(n2.intents.length).toBe(1);
    expect(shape(infos(notices(n2, recovered(n2, fromRecovery(DOWN, "VPWW55")), at(n2))))).toEqual([["desktop", "info"], ["sound", "info"]]);
    // dot のモデル検査の I1: 取り直しで上がった cell 全部を targets に持つので、A だけの終了でも info は B で残る。
    const both = notices(empty(), recovered(empty(), decodeXml(national(byPrefecture({ 18: "33", "09": "33" }), "2026-08-30T10:00:00+09:00"), "VPWS50", "rn-both", "recovery")), at(empty()));
    expect(infos(receive(both, ending("18", "2026-08-30T11:40:00+09:00")).state).length).toBe(2);
    const pair = recovered(recovered(empty(), fromRecovery(L5, "VPWW55")), fromRecovery(L5, "VPWW55", tochigi, "rec-tochigi"));
    const paired = notices(empty(), pair, at(empty()));
    expect([infos(paired).flatMap(prefecturesOf).sort(), infos(receive(paired, ending("18", "2026-08-30T11:40:00+09:00")).state).length]).toEqual([["09", "09", "18", "18"], 2]);
  });

  // 統合担当の決め（2026-11-01、r1）: 取り直しの H27 は operation ごとに 1 組（normal は desktop＋sound、training は【訓練】の desktop だけ）。
  it("P3-WN-T11 acceptance / AC12: the recovery raise is one info per operation", () => {
    const row = weatherCurrentUnit.recoveryNotices;
    if (row == null) throw new Error("U-W has no recoveryNotices");
    const normal = receive(empty(), decode(L5, "VPWW55", (xml) => xml, "rn", "recovery")).state;
    const both = receive(normal, decode(L5, "VPWW55", training, "rt", "recovery")).state;
    expect(row(empty(), both, { recoveryId: "r", clock: clock(), basis: "verified", live: empty(), card: null }).intents
      .map((item) => [item.operation, item.channel, item.payload.level, String(item.payload.title)])).toEqual([["normal", "desktop", "info", "大雨特別警報（06:51 発表）"],
      ["normal", "sound", "info", "大雨特別警報（06:51 発表）"], ["training", "desktop", "info", "【訓練】大雨特別警報（06:51 発表）"]]);
  });

  // contractBoundary（契約適合 r0 の証拠不足）: 器の際では H27 の印を足さない（足すと encode が throw し続ける）。境界は直に組む。
  it("P3-WN-T11 contractBoundary / AC12: an H27 mark that would overflow the generation is not added", () => {
    const row = weatherCurrentUnit.recoveryNotices;
    if (row == null) throw new Error("U-W has no recoveryNotices");
    const unused = (generation: number) => 62 + INPUT_BOUNDARY_MAX_BYTES + LOSS_TALLY_MAX_BYTES + UNREADABLE_CARDS_MAX_BYTES
      - (JSON.stringify(generation).length - 1) - (JSON.stringify(NOW).length - 1);
    // 受理と同じ予約込みの計量（intents は 131,072 byte、P3-WN-AC06 (3)）。
    const reserved = (value: WeatherCurrentUnitState) => serializedEnvelope({ schemaVersion: value.schemaVersion, unit: "U-W",
      generation: value.persistence.currentGeneration, capturedAt: NOW, payload: weatherCurrentUnitCodec.encode(value), sha256: "0".repeat(64) }).byteLength
      + unused(value.persistence.currentGeneration) + 131_072;
    const base = receive(empty(), decode(L5, "VPWW55", (xml) => xml, "rn", "recovery")).state;
    const padded = (length: number): WeatherCurrentUnitState => ({ ...base, partials: [...base.partials, { ...base.partials[0], subject: "normal/VPWW55/詰め物",
      office: "詰め物", source: { ...base.partials[0].source, subject: "normal/VPWW55/詰め物", inputId: "pad" }, phenomena: { padding: "x".repeat(length) } }] });
    const series = base.partials[0];
    const mark = Buffer.byteLength(JSON.stringify({ subject: series.subject, operation: series.operation,
      notice: { version: versionDigest(series.source), kinds: ["report"], evidence: "unattempted" } }));
    const at = { recoveryId: "r", clock: clock(), basis: "verified" as const, live: empty(), card: null };
    const exact = padded(LIMIT - mark - reserved(padded(0)));
    const fits = row(empty(), exact, at);
    expect([reserved(exact) + mark, fits.intents.length, fits.notices.length]).toEqual([LIMIT, 2, 1]);
    expect(() => weatherCurrentUnitCodec.encode(fits)).not.toThrow();
    const over = padded(LIMIT - mark - reserved(padded(0)) + 1);
    expect(row(empty(), over, at)).toBe(over);
  });

  // contractBoundary: AC11（P3-C10-T07 の形。人工の intent の代わりに本物の電文から U-W が作った intent）。
  it("P3-WN-T12 contractBoundary / AC11: the U-W critical from fukui_L5 is other, after EEW and tsunami emergency, and never aborts the running tsunami", () => {
    const now = { wallTimeMs: 1_000, monotonicMs: 1 };
    const [desktop] = receive(empty(), decode(L5, "VPWW55")).intents;
    const notice = (unit: NotificationIntent["unit"], domain: string, level: string, createdAt: number): NotificationIntent => ({
      id: unit, unit, subject: unit, operation: "normal", source: { inputId: unit, origin: "live", operation: "normal", family: unit, subject: unit,
        reportDateTimeRaw: "2020-06-22T23:00:00+09:00", controlDateTimeRaw: "2020-06-22T23:00:00+09:00", serialRaw: "", infoTypeRaw: "発表" }, transition: "activated",
      channel: "desktop", payload: { domain, level, title: unit, body: unit }, createdAt, expiresAt: createdAt + 180_000,
      nextAttemptAt: createdAt, attempts: 0, configRevision: "t12", disposition: "pending",
      ...freshState(unit, "normal", level === "warning" || level === "critical") });
    // U-W を最も古く作る（同じ群なら先に選ばれる位置）。
    const weather: NotificationIntent = { ...desktop, createdAt: -10, nextAttemptAt: -10, expiresAt: -10 + 180_000 };
    const tsunami = notice("U-T", "tsunami", "critical", 0), eew = notice("U-E", "earthquake-eew", "warning", 5);
    expect([weather.payload.level, weather.priorityGroup]).toEqual(["critical", "other"]);
    const deadlines = (intents: readonly NotificationIntent[]) => ({ desktop: Object.fromEntries(intents.map((item) =>
      [JSON.stringify([item.unit, item.id]), { retryAtMonotonicMs: 0, expiresAtMonotonicMs: 1e9 }])), sound: {} });
    const running: NotificationAttempt = { attemptId: "U-T:1", intentId: tsunami.id, unit: "U-T", subject: tsunami.subject, operation: "normal",
      channel: "desktop", priorityGroup: "normalTsunamiEmergency", payload: tsunami.payload, soundAsset: null, selectedAtMonotonicMs: 0,
      timeoutAtMonotonicMs: 5_000, expiresAt: tsunami.expiresAt };
    const trial: NotificationDeliveryState = { intents: [tsunami, weather], channels: { desktop: { kind: "running", attempt: running },
      sound: { kind: "idle" } }, deadlines: deadlines([tsunami, weather]) };
    expect(selectNotificationAttempt(trial, now).abortRequests).toEqual([]);
    let state: NotificationDeliveryState = { intents: [weather, tsunami, eew], channels: { desktop: { kind: "idle" }, sound: { kind: "idle" } },
      deadlines: deadlines([weather, tsunami, eew]) };
    const order: string[] = [];
    for (let round = 0; round < 3; round++) {
      const selection = selectNotificationAttempt(state, now);
      const [attempt] = selection.attempts;
      order.push(`${attempt.unit}:${attempt.priorityGroup}`);
      state = { ...selection.state, intents: selection.state.intents.filter((item) => item.id !== attempt.intentId),
        channels: { desktop: { kind: "idle" }, sound: { kind: "idle" } } };
    }
    expect(order).toEqual(["U-E:normalEew", "U-T:normalTsunamiEmergency", "U-W:other"]);
  });
});
