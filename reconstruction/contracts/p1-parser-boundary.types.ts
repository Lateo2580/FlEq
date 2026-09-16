export type Operation = "normal" | "training" | "test";

export type AcquisitionOrigin = "live" | "recovery" | "replay";

export type OperationRejectionReason =
  | "operationMissing"
  | "operationInvalid"
  | "operationMismatch"
  | "operationAmbiguous";

export type OperationSourceEvidence<T> =
  | Readonly<{ kind: "provided"; value: T }>
  | Readonly<{ kind: "notProvided" }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "invalid"; observed: string | boolean | null }>;

export type OperationEvidence = Readonly<{
  headTest: OperationSourceEvidence<boolean>;
  controlStatus: OperationSourceEvidence<Operation>;
  envelopeStatus: OperationSourceEvidence<Operation>;
}>;

export type OperationResolution =
  | Readonly<{
      kind: "resolved";
      operation: Operation;
      sources: OperationEvidence;
    }>
  | Readonly<{
      kind: "rejected";
      reason: OperationRejectionReason;
      sources: OperationEvidence;
    }>;

export type XmlAttribute = Readonly<{
  name: string;
  value: string;
}>;

export type XmlText = Readonly<{
  kind: "text";
  value: string;
}>;

export type XmlElement = Readonly<{
  kind: "element";
  name: string;
  attributes: readonly XmlAttribute[];
  children: readonly XmlNode[];
}>;

export type XmlNode = XmlElement | XmlText;

export type MaterialValue =
  | Readonly<{ kind: "number"; value: number; raw: string }>
  | Readonly<{ kind: "text"; value: string; raw: string }>
  | Readonly<{ kind: "empty"; raw: string }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "unknown"; raw: string }>
  | Readonly<{
      kind: "range";
      bound: "lower" | "upper";
      value: number;
      raw: string;
    }>;

export type ProcessingMarks = Readonly<{
  // §9.4: 同一プロセスの単調時計による所要時間ms。未実行区間はnull。
  // §7.5の受信→実paint時刻T0〜T6はP2以降の別計測。
  ingressJsonMs: number | null;
  base64DecodeMs: number | null;
  decompressionMs: number | null;
  fullXmlParseMs: number | null;
  metadataSpecialValueMs: number | null;
  domainExtractionMs: number | null;
  workerTransferMs: number | null;
}>;

export type ParserMailboxItem = Readonly<{
  inputId: string;
  inputSequence: number;
  receivedAt: number;
  origin: AcquisitionOrigin;
  // dmdata envelope head.type（VPWS50 等）。JMA XML 本文には電文種別コードが無いので B03 が運ぶ。
  headType: string;
  // dmdata envelope の encoding／compression。B03 が許可値で検証して載せ、REST 本文・replay 生 XML は utf-8／null。
  // encodedBody は無加工の bytes で、B04 は先頭 bytes から形式を推測しない。
  encoding: "base64" | "utf-8";
  compression: "gzip" | "zip" | null;
  encodedBody: Uint8Array;
  encodedByteLength: number;
  headTest: OperationSourceEvidence<boolean>;
  envelopeStatus: OperationSourceEvidence<Operation>;
}>;

export type DecodedMaterial = Readonly<{
  inputId: string;
  origin: AcquisitionOrigin;
  operation: Operation;
  headType: string;
  reportDateTimeRaw: string;
  eventIdRaw: string;
  serialRaw: string;
  infoTypeRaw: string;
  xml: XmlElement;
  decodedByteLength: number;
  expandedByteLength: number;
  marks: ProcessingMarks;
}>;

export type ParserDiagnostic = Readonly<{
  inputId: string;
  reason: OperationRejectionReason | string;
  // 本文を読めない拒否で架空のControl.Status判定を作らないため必要。
  operation: OperationResolution | Readonly<{
    kind: "undetermined";
    sources: Partial<OperationEvidence>;
  }>;
  encodedByteLength: number;
  expandedByteLength: number | null;
}>;

export type ParserMailboxResult =
  | Readonly<{ kind: "decoded"; material: DecodedMaterial }>
  | Readonly<{ kind: "rejected"; diagnostic: ParserDiagnostic }>;
