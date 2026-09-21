// evidence.mjs は dist/ を require する素の JS（report.mjs が node から直接使う）ので
// .ts 化できない。テストから使う 3 つの export だけに型を与える。
// 実装を変えたらここも合わせて直すこと（tsc は .mjs 本体を検査しない）。
import type { classifyMaterial, decodeMaterial } from "../../src/decode-material/decode-material";
import type { ingestXmlData } from "../../src/ingress/ingress";

type Api = Readonly<{
  ingestXmlData: typeof ingestXmlData;
  // classifyCorpus は rejected 側から kind と diagnostic.reason しか読まないので、
  // 差し替え用のスタブは本物の ParserMailboxResult を組み立てなくてよい
  decodeMaterial: (item: Parameters<typeof decodeMaterial>[0]) =>
    | ReturnType<typeof decodeMaterial>
    | Readonly<{ kind: "rejected"; diagnostic: Readonly<{ reason: string }> }>;
  classifyMaterial: typeof classifyMaterial;
}>;

type ClassifiedRow = Readonly<{
  fixtureId: string;
  role: string;
  expected: unknown;
  actual:
    | Readonly<{ kind: "rejected"; reason: string }>
    | Readonly<{ kind: "decoded"; classification: string; headType: string;
        reportDateTimeRaw: string | null; targetDateTimeRaw: string | null }>;
  difference: Readonly<{ expected: unknown; actual: unknown }> | null;
}>;

type Measurement = Readonly<{
  inputId: string;
  fixtureId: string;
  encodedByteLength: number;
  decodedByteLength: number;
  expandedByteLength: number;
  nodes: number;
  depth: number;
  attributes: number;
  attributeCharacters: number;
  maxAttributes: number;
  maxAttributeValue: number;
  textCharacters: number;
  maxText: number;
  marks: Readonly<Record<string, number | null>>;
  unexecutedReasons: Readonly<Record<string, string>>;
  transfer: Readonly<{ inputBytes: number; resultInputId: string; resultNodes: number }>;
  classification: Readonly<{ route: string; family: string }>;
}>;

export declare function classifyCorpus(api?: Api): ClassifiedRow[];
export declare function envelope(body: Uint8Array, headType?: string,
  extras?: Readonly<Record<string, unknown>>): Buffer;
export declare function measure(input: Parameters<typeof ingestXmlData>[0],
  fixtureId: string, api?: Api): Promise<Measurement>;
