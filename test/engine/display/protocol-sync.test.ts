import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// display/frontend/src/lib/protocol.ts は src/engine/display/protocol.ts の
// PROTOCOL-SYNC-BEGIN〜END 区間を手動複製したもの (Task 11)。この複製がずれていないかを検証する。
const SYNC_BEGIN = "// PROTOCOL-SYNC-BEGIN";
const SYNC_END = "// PROTOCOL-SYNC-END";

function extractSyncRegion(filePath: string): string {
  const raw = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
  const begin = raw.indexOf(SYNC_BEGIN);
  const end = raw.indexOf(SYNC_END);
  if (begin === -1 || end === -1) {
    throw new Error(`${filePath}: SYNC マーカーが見つからない`);
  }
  return raw.slice(begin, end + SYNC_END.length);
}

describe("protocol.ts 複製の同期", () => {
  it("src/engine/display/protocol.ts と display/frontend/src/lib/protocol.ts の SYNC 区間が完全一致する", () => {
    const source = extractSyncRegion(resolve(__dirname, "../../../src/engine/display/protocol.ts"));
    const copy = extractSyncRegion(resolve(__dirname, "../../../display/frontend/src/lib/protocol.ts"));
    expect(copy).toBe(source);
  });
});
