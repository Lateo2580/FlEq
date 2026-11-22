// P4-DW-AC01・AC11: 新しい経路の試験の client（S0 までの新しい描画の代わり）。版の違う snapshot は描かず非対応を出す（spec §8.3）。
// 読むのは新しい wire の欄だけで、分野の名前で分岐しない。
type Rendered = Readonly<{ kind: "unsupported"; version: unknown }> | Readonly<{ kind: "rendered"; sequence: unknown }>;

const VERSION = "p4-display-wire-v2";

function renderWire(value: unknown): Rendered {
  if (typeof value !== "object" || value == null || !("schemaVersion" in value) || value.schemaVersion !== VERSION)
    return { kind: "unsupported", version: typeof value === "object" && value != null && "schemaVersion" in value ? value.schemaVersion : null };
  return { kind: "rendered", sequence: "sequence" in value ? value.sequence : null };
}

export { renderWire };
