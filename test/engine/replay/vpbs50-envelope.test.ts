import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadVpBs50ReplayInputs,
  VPBS50_REPLAY_FIXTURES,
  vpbs50ReplayInputDigest,
} from "../../../src/engine/replay/vpbs50-envelope";

describe("Phase 1 VPBS50 replay envelope", () => {
  it("固定2 fixture を無圧縮 UTF-8 の正規化済み WsDataMessage に包む", () => {
    const before = VPBS50_REPLAY_FIXTURES.map((fixture) =>
      readFileSync(resolve(fixture.path)),
    );
    const inputs = loadVpBs50ReplayInputs(VPBS50_REPLAY_FIXTURES.map((fixture) => fixture.path));

    expect(inputs.map((input) => input.message)).toEqual(inputs.map((input) => expect.objectContaining({
      type: "data",
      version: "2.0",
      classification: "telegram.weather",
      format: "xml",
      compression: null,
      encoding: "utf-8",
      head: expect.objectContaining({ type: "VPBS50", xml: true }),
      meta: expect.objectContaining({ receivedAtMs: input.reportDateTimeMs }),
    })));
    expect(inputs.map((input) => input.message.body)).toEqual(inputs.map((input) => input.xml));
    expect(inputs.map((input) => input.kind)).toEqual([
      "linearRainPredicted",
      "linearRainObserved",
    ]);
    const areaCodes = inputs.map((input) => [
      ...new Set([...input.xml.matchAll(/<Code>(17\d{4})<\/Code>/g)].map((match) => match[1]!)),
    ].sort());
    expect(areaCodes).toEqual([["170020"], ["170010", "170020"]]);
    expect(areaCodes[0]!.every((code) => areaCodes[1]!.includes(code))).toBe(true);
    expect(VPBS50_REPLAY_FIXTURES.map((fixture) => readFileSync(resolve(fixture.path)))).toEqual(before);
    expect(vpbs50ReplayInputDigest(inputs)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("provenance は元 hash と全時刻 shift を列挙し、記載外の byte 差分を持たない", () => {
    const provenance = JSON.parse(
      readFileSync(resolve("test/fixtures/replay/provenance.json"), "utf8"),
    ) as {
      schemaVersion: number;
      purpose: string;
      fixtures: Array<{
        role: string;
        file: string;
        sha256: string;
        sourcePath: string;
        sourceFile: string;
        sourceSha256: string;
        derivation: string;
        shift?: string;
        otherBytesUnchanged?: boolean;
        shiftedFields: Array<{ field: string; from: string; to: string }>;
      }>;
    };
    expect(provenance).toMatchObject({
      schemaVersion: 1,
      purpose: "Phase 1 fixed VPBS50 prediction-to-occurrence replay pair",
    });
    expect(provenance.fixtures.map((fixture) => fixture.role)).toEqual(["prediction", "occurrence"]);
    for (const fixture of provenance.fixtures) {
      const generated = readFileSync(resolve("test/fixtures/replay", fixture.file));
      const source = readFileSync(resolve(fixture.sourcePath));
      expect(createHash("sha256").update(generated).digest("hex")).toBe(fixture.sha256);
      expect(createHash("sha256").update(source).digest("hex")).toBe(fixture.sourceSha256);
      expect(fixture.sourceFile).toBe(fixture.sourcePath.split("/").at(-1));
    }
    expect(provenance.fixtures[0]).toMatchObject({
      derivation: "byte-identical-copy",
      shiftedFields: [],
    });
    expect(readFileSync(resolve("test/fixtures/replay", provenance.fixtures[0]!.file)))
      .toEqual(readFileSync(resolve(provenance.fixtures[0]!.sourcePath)));

    const occurrence = provenance.fixtures[1]!;
    expect(occurrence).toMatchObject({
      derivation: "datetime-shift",
      shift: "PT1H50M",
      otherBytesUnchanged: true,
    });
    let restored = readFileSync(resolve("test/fixtures/replay", occurrence.file), "utf8");
    expect(occurrence.shiftedFields.map((shift) => shift.field)).toEqual([
      "/Report/Control/DateTime",
      "/Report/Head/ReportDateTime",
      "/Report/Head/TargetDateTime",
      "/Report/Body/MeteorologicalInfos/MeteorologicalInfo/DateTime",
      "/Report/Body/MeteorologicalInfos/MeteorologicalInfo/Item[1]/Kind/Property/EventPart/Event/Time",
      "/Report/Body/MeteorologicalInfos/MeteorologicalInfo/Item[2]/Kind/Property/EventPart/Event/Time",
    ]);
    for (const shift of occurrence.shiftedFields) restored = restored.replace(shift.to, shift.from);
    expect(restored).toBe(readFileSync(resolve(occurrence.sourcePath), "utf8"));
  });

  it("元の実 XML 4 本は固定合成対ではないため fail-closed で拒否する", () => {
    const originals = [
      "test/fixtures/VPBS50_HJPNA202608270258.xml",
      "test/fixtures/VPBS50_HJPNB202608270308.xml",
      "test/fixtures/VPBS50_YJPNA202608270448.xml",
      "test/fixtures/VPBS50_YJPNB202608270448.xml",
    ];
    for (const original of originals) {
      expect(() => loadVpBs50ReplayInputs([original, VPBS50_REPLAY_FIXTURES[1].path]))
        .toThrow(/unsupported scenario/);
      expect(() => loadVpBs50ReplayInputs([VPBS50_REPLAY_FIXTURES[0].path, original]))
        .toThrow(/unsupported scenario/);
    }
  });

  it("件数・順序・別 path を runtime 構築前に fail-closed で拒否する", () => {
    expect(() => loadVpBs50ReplayInputs([])).toThrow(/exactly two/);
    expect(() => loadVpBs50ReplayInputs([VPBS50_REPLAY_FIXTURES[0].path])).toThrow(/exactly two/);
    expect(() => loadVpBs50ReplayInputs([
      VPBS50_REPLAY_FIXTURES[0].path,
      VPBS50_REPLAY_FIXTURES[1].path,
      VPBS50_REPLAY_FIXTURES[1].path,
    ])).toThrow(/exactly two/);
    expect(() => loadVpBs50ReplayInputs([
      VPBS50_REPLAY_FIXTURES[1].path,
      VPBS50_REPLAY_FIXTURES[0].path,
    ])).toThrow(/fixture 1 path/);
    expect(() => loadVpBs50ReplayInputs([
      "test/fixtures/VPBS50_YJPNB202608270448.xml",
      VPBS50_REPLAY_FIXTURES[1].path,
    ])).toThrow(/fixture 1 path/);
    for (const unsupported of [
      "test/fixtures/15_18_01_250630_VPWS50.xml",
      "test/fixtures/45_01_01_200522_VFVO50.xml",
      "test/fixtures/77_01_01_240613_VXSE45.xml",
    ]) {
      expect(() => loadVpBs50ReplayInputs([
        unsupported,
        VPBS50_REPLAY_FIXTURES[1].path,
      ])).toThrow(/fixture 1 path/);
    }
  });

  it("承認 path の内容が固定 SHA-256 と異なれば fail-closed で拒否する", () => {
    const checkoutRoot = resolve(`.tmp-replay-envelope-${process.pid}-${Date.now()}`);
    try {
      for (const fixture of VPBS50_REPLAY_FIXTURES) {
        const destination = resolve(checkoutRoot, fixture.path);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, readFileSync(resolve(fixture.path)));
      }
      writeFileSync(
        resolve(checkoutRoot, VPBS50_REPLAY_FIXTURES[0].path),
        Buffer.concat([
          readFileSync(resolve(VPBS50_REPLAY_FIXTURES[0].path)),
          Buffer.from("\n"),
        ]),
      );
      expect(() => loadVpBs50ReplayInputs(
        VPBS50_REPLAY_FIXTURES.map((fixture) => fixture.path),
        checkoutRoot,
      )).toThrow(/fixture 1 SHA-256 mismatch/);
    } finally {
      rmSync(checkoutRoot, { recursive: true, force: true });
    }
  });
});
