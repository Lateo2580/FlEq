import type NodeNotifier from "node-notifier";

export type NodeNotifierLike = Pick<typeof NodeNotifier, "notify">;

let nodeNotifierOverride: NodeNotifierLike | null | undefined;

export function setNodeNotifierOverride(
  notifier: NodeNotifierLike | null | undefined,
): void {
  nodeNotifierOverride = notifier;
}

export function loadNodeNotifier(): NodeNotifierLike | null {
  if (nodeNotifierOverride !== undefined) {
    return nodeNotifierOverride;
  }

  try {
    return require("node-notifier") as NodeNotifierLike;
  } catch {
    return null;
  }
}
