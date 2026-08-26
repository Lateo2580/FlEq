import type { PresentationEvent } from "../presentation/types";
import { projectDisplayEvent, projectQuakeMapCommand } from "./project-event";
import {
  DisplayStateStore,
  type DisplayQuakeLifecyclePersistedV1,
} from "./state-store";

export type QuakeDisplayDurability = "debounced";

/**
 * map contribution／host／large-quake reference／revision を display runtime から切り離す。
 * 内部では既存 DisplayStateStore の確定済み mutation を再利用し、wire の二重実装を避ける。
 */
export class QuakeDisplayStore {
  private readonly store = new DisplayStateStore();
  private durableListeners = new Set<(durability: QuakeDisplayDurability) => void>();

  onDurable(listener: (durability: QuakeDisplayDurability) => void): () => void {
    this.durableListeners.add(listener);
    return () => this.durableListeners.delete(listener);
  }

  applyPresentationEvent(event: PresentationEvent, nowMs: number): boolean {
    // EventID 欠落電文は process lifecycle を越えて同一系列と証明できない。runtime の既存
    // single-event key に任せ、monitor 側で project を二重実行して sequence をずらさない。
    if (event.domain !== "earthquake" || event.eventId == null || event.eventId.trim() === "") return false;
    const before = JSON.stringify(this.store.exportQuakeLifecycle());
    const command = projectQuakeMapCommand(event, nowMs);
    const dto = projectDisplayEvent(event, "", command);
    this.store.applyEvent(dto, nowMs, undefined, command, undefined, event);
    const changed = JSON.stringify(this.store.exportQuakeLifecycle()) !== before;
    if (changed) this.notifyDurable();
    return changed;
  }

  sweep(nowMs: number): boolean {
    const before = JSON.stringify(this.store.exportQuakeLifecycle());
    this.store.sweep(nowMs, false);
    const changed = JSON.stringify(this.store.exportQuakeLifecycle()) !== before;
    if (changed) this.notifyDurable();
    return changed;
  }

  export(): DisplayQuakeLifecyclePersistedV1 {
    return this.store.exportQuakeLifecycle();
  }

  restore(state: DisplayQuakeLifecyclePersistedV1, nowMs: number): void {
    this.store.restoreQuakeLifecycle(state, nowMs);
  }

  private notifyDurable(): void {
    for (const listener of this.durableListeners) listener("debounced");
  }
}
