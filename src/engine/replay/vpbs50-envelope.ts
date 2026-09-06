import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { parseTelegramEnvelopeXml } from "../../dmdata/telegram-envelope";
import { normalizeTelegramMessage } from "../../dmdata/telegram-ingress";
import { deriveIsTest, parseStrictReportDateTime } from "../../dmdata/telegram-meta";
import type { WsDataMessage } from "../../types";

export const VPBS50_REPLAY_FIXTURES = [
  {
    path: "test/fixtures/replay/VPBS50_YJPNB202608270448.xml",
    sha256: "414b76ead006df1223e6503db12de8e8bc3636288e8730ebedf59f35aa6fe859",
    kind: "linearRainPredicted",
  },
  {
    path: "test/fixtures/replay/VPBS50_HJPNB202608270458.xml",
    sha256: "5ddd21f38f69bfcec04f4a0b55a8643ef1da65fa410e8e897122675820fa52b4",
    kind: "linearRainObserved",
  },
] as const;

export type Vpbs50ReplayKind = "linearRainPredicted" | "linearRainObserved";

export interface Vpbs50ReplayInput {
  ordinal: 1 | 2;
  fixturePath: string;
  fixtureRelativePath: string;
  xml: string;
  sha256: string;
  reportDateTime: string;
  reportDateTimeMs: number;
  kind: Vpbs50ReplayKind;
  message: WsDataMessage;
}

function nullable(value: string): string | null {
  return value === "" ? null : value;
}

function fixtureKind(xml: string): Vpbs50ReplayKind {
  const conditions = [...xml.matchAll(/<Condition>([^<]*)<\/Condition>/g)]
    .map((match) => match[1]?.normalize("NFKC") ?? "");
  if (conditions.some((value) => value.includes("線状降水帯発生"))) return "linearRainObserved";
  if (conditions.some((value) => value.includes("線状降水帯直前"))) return "linearRainPredicted";
  throw new Error("unsupported scenario: VPBS50 linear-rain kind is missing");
}

function posixRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

export function loadVpBs50ReplayInputs(
  fixturePaths: readonly string[],
  checkoutRoot = process.cwd(),
): [Vpbs50ReplayInput, Vpbs50ReplayInput] {
  if (fixturePaths.length !== 2) {
    throw new Error("unsupported scenario: exactly two VPBS50 fixtures are required");
  }
  const root = resolve(checkoutRoot);
  const inputs = VPBS50_REPLAY_FIXTURES.map((expected, index) => {
    const actualPath = resolve(root, fixturePaths[index]!);
    const expectedPath = resolve(root, expected.path);
    if (actualPath !== expectedPath) {
      throw new Error(`unsupported scenario: fixture ${index + 1} path is not approved`);
    }
    const bytes = readFileSync(actualPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== expected.sha256) {
      throw new Error(`unsupported scenario: fixture ${index + 1} SHA-256 mismatch`);
    }
    const xml = bytes.toString("utf8");
    const envelope = parseTelegramEnvelopeXml(xml);
    const reportMeta = parseStrictReportDateTime(
      envelope.head.reportDateTime === "" ? null : envelope.head.reportDateTime,
      Date.parse(envelope.head.reportDateTime),
    );
    if (!reportMeta.valid || reportMeta.epochMs == null) {
      throw new Error(`unsupported scenario: fixture ${index + 1} ReportDateTime is invalid`);
    }
    const ordinal = (index + 1) as 1 | 2;
    const raw: WsDataMessage = {
      type: "data",
      version: "2.0",
      classification: "telegram.weather",
      id: `replay-vpbs50:${ordinal}:${sha256}`,
      passing: [],
      head: {
        type: "VPBS50",
        author: envelope.control.publishingOffice,
        time: envelope.control.dateTime,
        designation: nullable(envelope.control.editorialOffice),
        test: deriveIsTest({ headTest: null, controlStatus: envelope.control.status }),
        xml: true,
      },
      xmlReport: {
        control: { ...envelope.control },
        head: {
          ...envelope.head,
          eventId: nullable(envelope.head.eventId),
          serial: nullable(envelope.head.serial),
          headline: nullable(envelope.head.headline),
        },
      },
      format: "xml",
      compression: null,
      encoding: "utf-8",
      body: xml,
    };
    const message = normalizeTelegramMessage(raw, reportMeta.epochMs).message;
    const kind = fixtureKind(xml);
    if (kind !== expected.kind) {
      throw new Error(`unsupported scenario: fixture ${index + 1} semantic kind mismatch`);
    }
    return {
      ordinal,
      fixturePath: actualPath,
      fixtureRelativePath: posixRelative(root, actualPath),
      xml,
      sha256,
      reportDateTime: envelope.head.reportDateTime,
      reportDateTimeMs: reportMeta.epochMs,
      kind,
      message,
    };
  });
  if (inputs[1].reportDateTimeMs < inputs[0].reportDateTimeMs) {
    throw new Error("unsupported scenario: fixture business time regresses");
  }
  if (inputs[1].reportDateTimeMs === inputs[0].reportDateTimeMs) {
    throw new Error("unsupported scenario: occurrence must be strictly newer than prediction");
  }
  if (
    inputs[0].message.xmlReport?.control.editorialOffice
    !== inputs[1].message.xmlReport?.control.editorialOffice
  ) {
    throw new Error("unsupported scenario: fixtures must share one editorial office");
  }
  return [inputs[0], inputs[1]];
}

export function vpbs50ReplayInputDigest(inputs: readonly Vpbs50ReplayInput[]): string {
  const hash = createHash("sha256");
  for (const input of inputs) {
    hash.update("VPBS50\0");
    hash.update(input.xml, "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
}
