import type { PresentationDomain } from "../../engine/presentation/types";

export type SummaryPriority = 0 | 1 | 2 | 3 | 4;

export interface SummaryToken {
  id: string;
  text: string;
  shortText?: string;
  priority: SummaryPriority;
  minWidth: number;
  preferredWidth: number;
  dropMode: "never" | "shorten" | "drop";
}

export interface SummaryModel {
  domain: PresentationDomain;
  severity: string;           // "[緊急]", "[警告]", "[情報]", "[通知]"
  title?: string;
  location?: string;
  magnitude?: string;
  maxInt?: string;
  maxLgInt?: string;
  headline?: string;
  statusLabel?: string;
  volcanoName?: string;
  serial?: string;
  areaNames?: string[];
  // diff は Phase 4 で追加
}
