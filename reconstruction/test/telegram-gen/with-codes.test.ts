import { describe, expect, it } from "vitest";

import { decodeMaterial } from "../../src/decode-material/decode-material";
import { parseSeismic } from "../../src/domains/seismic/seismic";
import { ingestXmlData } from "../../src/ingress/ingress";
import { reduceEewUnit } from "../../src/units/eew/eew-unit";
import type { GenerateInput } from "../../tools/telegram-gen/telegram-gen.mjs";
import { choices, generateTelegrams } from "../../tools/telegram-gen/telegram-gen.mjs";

// 作者の手元の 地震火山関連コード表.xlsx を FLEQ_JMA_CODES に渡した回だけ走る（CI では skip）。実在のコードを期待に書くのはこの file だけ（D-CODES）。
describe.skipIf(!process.env.FLEQ_JMA_CODES)("with the real code table", () => {
  const ORIGIN = "2026-11-01T21:10:00+09:00";
  const source = { originTime: ORIGIN, placeCode: "301", lat: 36.0, lon: 140.0, depthKm: 10, magnitude: 5.5, maxInt: "5-" };
  let sequence = 0;
  const decode = (xml: string, headType: string) => {
    const entered = ingestXmlData({ inputId: `codes-${++sequence}`, inputSequence: 1, receivedAt: 0, origin: "replay", kind: "replay", headType, body: Buffer.from(xml) });
    if (entered.kind !== "accepted") throw new Error(entered.diagnostic.reason);
    const decoded = decodeMaterial(entered.item);
    if (decoded.kind !== "decoded") throw new Error(decoded.diagnostic.reason);
    return decoded.material;
  };

  // P3-RW2-T15 acceptance (AC07・AC09・AC11)
  it("counts the choices and builds a Tochigi-south and an Ibaraki-south telegram", () => {
    const eewCodes = choices("VXSE45").areas.map((a) => a.code);
    expect([choices("VXSE53").areas.length, choices("VXSE53").places.length, eewCodes.length]).toEqual([188, 343, 125]);
    expect(eewCodes).toEqual(expect.arrayContaining(["310", "311"]));
    expect(eewCodes).not.toContain("100");
    expect(generateTelegrams({ family: "VXSE45", ...source, areaCode: "100" } as GenerateInput)).toMatchObject({ kind: "rejected", reason: "areaUnknown" });
    expect(generateTelegrams({ family: "VXSE53", ...source, areaCode: "100" } as GenerateInput).kind).toBe("generated");

    for (const areaCode of ["301", "311"]) {
      const name = choices("VXSE53").areas.find((a) => a.code === areaCode)!.name;
      const placeName = choices("VXSE53").places.find((p) => p.code === "301")!.name;
      const quake = generateTelegrams({ family: "VXSE53", ...source, areaCode } as GenerateInput);
      if (quake.kind !== "generated") throw new Error(quake.reason);
      const parsed = parseSeismic(decode(quake.reports[0].xml, "VXSE53"));
      if (parsed.kind !== "accepted" || parsed.candidate.kind !== "earthquake") throw new Error("not accepted");
      const { hypocenter, intensity } = parsed.candidate.contribution;
      expect([hypocenter!.name, hypocenter!.code]).toEqual([placeName, "301"]);
      const area = intensity!.items.find((item) => item.level === "area")!;
      expect([area.code, area.name]).toEqual([areaCode, name]);
      // 311 はシート 24 の 19 市町村（作者の手元で数えた値）
      if (areaCode === "311") expect(intensity!.items.filter((item) => item.level === "city")).toHaveLength(19);

      const eew = generateTelegrams({ family: "VXSE45", ...source, areaCode } as GenerateInput);
      if (eew.kind !== "generated") throw new Error(eew.reason);
      const step = reduceEewUnit({ schemaVersion: "p2-eew-unit-v5", contentRevision: 0, current: [], gates: [], intents: [], notices: [], unreadableNotices: [],
        persistence: { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null, savedAckAt: null, dirtySince: null } },
      { kind: "receive", material: decode(eew.reports[0].xml, "VXSE45"), clock: { wallTimeMs: Date.parse(eew.reports[0].xml.match(/<ReportDateTime>([^<]+)</)![1]), monotonicMs: 0 } });
      expect(step.state.current[0].prediction.areas.map((a) => a.code)).toEqual([areaCode]);
    }
  });
});
