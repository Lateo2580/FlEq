export type { ParserMailboxItem } from "../../contracts/p1-parser-boundary.types";

/** P2 owns scheduling; these fixed limits keep its future mailbox boundary compatible with §7.2. */
export const parserMailboxLimits = {
  items: 128,
  bytes: 16 * 1024 * 1024,
  normalItems: 120,
  normalBytes: 14 * 1024 * 1024,
} as const;
