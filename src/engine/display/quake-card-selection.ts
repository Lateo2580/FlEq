import { QUAKE_CARD_TTL_HIGH_MIN, QUAKE_CARD_TTL_LOW_MIN, QUAKE_CARD_TTL_MID_MIN } from "./constants";
import { intensityToRank } from "../../utils/intensity";

const MIN_MS = 60_000;
const QUAKE_CARD_HIGH_RANK = intensityToRank("5弱");
const QUAKE_CARD_MID_RANK = intensityToRank("3");

interface QuakeCardCandidate {
  eventId: string | null;
  maxIntRank: number | null | undefined;
}

interface CurrentQuakeHost extends QuakeCardCandidate {
  expiresAtMs: number;
}

export function quakeCardTtlMs(rank: number): number {
  if (rank >= QUAKE_CARD_HIGH_RANK) return QUAKE_CARD_TTL_HIGH_MIN * MIN_MS;
  if (rank >= QUAKE_CARD_MID_RANK) return QUAKE_CARD_TTL_MID_MIN * MIN_MS;
  return QUAKE_CARD_TTL_LOW_MIN * MIN_MS;
}

export function shouldReplaceLatestQuake(
  current: QuakeCardCandidate | null,
  candidate: QuakeCardCandidate,
): boolean {
  if (current == null) return true;
  if (current.eventId != null && current.eventId === candidate.eventId) return true;
  // 別地震は常に最新を表示する。強い地震は緊急画面の保持と履歴カードで担保する。
  return true;
}

export function shouldReplaceQuakeHost(
  current: CurrentQuakeHost | null,
  candidate: QuakeCardCandidate,
  nowMs: number,
): boolean {
  if (current == null) return true;
  if (current.eventId != null && current.eventId === candidate.eventId) return true;
  if (nowMs > current.expiresAtMs) return true;
  return (candidate.maxIntRank ?? 0) >= (current.maxIntRank ?? 0);
}
