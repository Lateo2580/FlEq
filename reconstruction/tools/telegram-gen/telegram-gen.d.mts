// telegram-gen.mjs の口の型（P3-RW2-AC07）。
export type Family = "VXSE43" | "VXSE45" | "VXSE51" | "VXSE52" | "VXSE53" | "VTSE41" | "VTSE51" | "VTSE52";
export type GenerateInput = {
  family: string; originTime?: string; placeCode?: string; lat?: number; lon?: number; depthKm?: number; magnitude?: number;
  maxInt?: string; areaCode?: string; serial?: number; reports?: number; end?: string; cancel?: boolean;
};
export type Generated = { kind: "generated"; headType: Family; eventId: string; originTime: string; reports: { serial: number | null; xml: string }[] };
export type Reason = "unknownFamily" | "originTimeInvalid" | "placeUnknown" | "coordinateOutOfRange" | "depthOutOfRange" | "magnitudeOutOfRange" | "intensityOutOfRange"
  | "areaUnknown" | "serialOutOfRange" | "reportsOutOfRange" | "endInvalid" | "fieldNotInFamily" | "cancelWithContent" | "cancelTemplateMissing" | "missingField";
export type Rejected = { kind: "rejected"; reason: Reason; field: string };
export function generateTelegrams(input: GenerateInput): Generated | Rejected;
export function choices(family: string): { places: { code: string; name: string }[]; areas: { code: string; name: string }[] };
