import { SPRING_SPATIAL_DEFAULT_MS, springSpatialOut } from "../motion";
import type { CardKey } from "./types";

type Timer = ReturnType<typeof setTimeout>;

export type LayoutMotionSurface = "left" | "right" | "center" | "rotation";

export interface LayoutMotionIdentity {
  key: CardKey;
  surface: LayoutMotionSurface;
}

export interface LayoutMotionRunOptions {
  skipMotion?: boolean;
}

export interface LayoutMotionCoordinatorOptions {
  root: () => HTMLElement | null;
  reducedMotion?: () => boolean;
  durationMs?: number;
}

interface RectSnapshot {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface CapturedCard {
  identity: LayoutMotionIdentity;
  rect: RectSnapshot;
  text: string;
  shell: HTMLElement;
}

interface RegisteredCard {
  identity: LayoutMotionIdentity;
  node: HTMLElement;
}

interface ActiveRun {
  epoch: string;
  token: number;
  animations: Set<Animation>;
  pendingFinished: Set<Animation>;
  shells: Set<HTMLElement>;
  deadline: Timer | null;
  fallback: Timer | null;
  fallbackRequired: boolean;
  complete: () => void;
}

const FRAME_COUNT = 24;

function identityKey(identity: LayoutMotionIdentity): string {
  return `${identity.key}:${identity.surface}`;
}

function snapshotRect(rect: DOMRect): RectSnapshot {
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

function visible(node: HTMLElement): boolean {
  return node.isConnected && !node.hidden && node.closest("[hidden]") == null;
}

function stripDuplicateIds(shell: HTMLElement): void {
  shell.removeAttribute("id");
  for (const node of shell.querySelectorAll<HTMLElement>("[id]")) node.removeAttribute("id");
}

function motionFrames(
  fromX: number,
  fromY: number,
  opacityFrom: number,
  opacityTo: number,
): Keyframe[] {
  return Array.from({ length: FRAME_COUNT + 1 }, (_, index) => {
    const offset = index / FRAME_COUNT;
    const eased = springSpatialOut(offset);
    return {
      offset,
      translate: `${fromX * (1 - eased)}px ${fromY * (1 - eased)}px`,
      opacity: opacityFrom + (opacityTo - opacityFrom) * offset,
    };
  });
}

function shellFrames(from: RectSnapshot, to: RectSnapshot, removed: boolean): Keyframe[] {
  const deltaX = to.left - from.left;
  const deltaY = to.top - from.top;
  return Array.from({ length: FRAME_COUNT + 1 }, (_, index) => {
    const offset = index / FRAME_COUNT;
    const eased = springSpatialOut(offset);
    return {
      offset,
      width: `${from.width + (to.width - from.width) * eased}px`,
      height: `${from.height + (to.height - from.height) * eased}px`,
      translate: `${deltaX * eased}px ${deltaY * eased + (removed ? -6 * eased : 0)}px`,
      opacity: 1 - offset,
    };
  });
}

export class LayoutMotionCoordinator {
  private readonly root: () => HTMLElement | null;
  private readonly reducedMotion: () => boolean;
  private readonly durationMs: number;
  private registrations = new Map<HTMLElement, RegisteredCard>();
  private capture = new Map<string, CapturedCard>();
  private captureEpoch: string | null = null;
  private run: ActiveRun | null = null;
  private nextToken = 0;
  private disposed = false;

  constructor(options: LayoutMotionCoordinatorOptions) {
    this.root = options.root;
    this.durationMs = options.durationMs ?? SPRING_SPATIAL_DEFAULT_MS;
    this.reducedMotion = options.reducedMotion ?? (() => typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  register(node: HTMLElement, identity: LayoutMotionIdentity): { update: (next: LayoutMotionIdentity) => void; destroy: () => void } {
    if (!this.disposed) this.registrations.set(node, { node, identity });
    return {
      update: (next) => {
        if (!this.disposed) this.registrations.set(node, { node, identity: next });
      },
      destroy: () => {
        this.registrations.delete(node);
      },
    };
  }

  preEpochCapture(epoch: string): void {
    if (this.disposed) return;
    // A running WAAPI translate participates in getBoundingClientRect(). Read
    // that visible position before canceling the old run, otherwise a
    // supersede starts from the underlying layout position and visibly jumps.
    const nextCapture = new Map<string, CapturedCard>();
    for (const registration of this.registrations.values()) {
      if (!visible(registration.node)) continue;
      const shell = registration.node.cloneNode(true) as HTMLElement;
      stripDuplicateIds(shell);
      nextCapture.set(identityKey(registration.identity), {
        identity: { ...registration.identity },
        rect: snapshotRect(registration.node.getBoundingClientRect()),
        text: registration.node.textContent ?? "",
        shell,
      });
    }
    this.cancelActiveRun();
    this.capture = nextCapture;
    this.captureEpoch = epoch;
  }

  runForEpoch(epoch: string, complete: () => void, options: LayoutMotionRunOptions = {}): void {
    if (this.disposed) return;
    this.cancelActiveRun();
    const token = ++this.nextToken;
    const run: ActiveRun = {
      epoch,
      token,
      animations: new Set(),
      pendingFinished: new Set(),
      shells: new Set(),
      deadline: null,
      fallback: null,
      fallbackRequired: false,
      complete,
    };
    this.run = run;

    if (this.captureEpoch !== epoch) this.capture.clear();
    this.captureEpoch = null;

    if (options.skipMotion === true || this.reducedMotion()) {
      this.capture.clear();
      this.completeRun(token);
      return;
    }

    const finalCards = [...this.registrations.values()].filter((registration) => visible(registration.node));
    const unusedCapture = new Set(this.capture.keys());
    const capturedByKey = new Map<CardKey, CapturedCard[]>();
    for (const captured of this.capture.values()) {
      const entries = capturedByKey.get(captured.identity.key) ?? [];
      entries.push(captured);
      capturedByKey.set(captured.identity.key, entries);
    }

    for (const finalCard of finalCards) {
      const exactKey = identityKey(finalCard.identity);
      const exact = this.capture.get(exactKey);
      const captured = exact ?? capturedByKey.get(finalCard.identity.key)?.find((entry) => unusedCapture.has(identityKey(entry.identity)));
      const finalRect = snapshotRect(finalCard.node.getBoundingClientRect());
      if (captured == null) {
        if (this.canAnimate(finalCard.node)) this.animate(run, finalCard.node, motionFrames(0, 8, 0, 1));
        else run.fallbackRequired = true;
        continue;
      }
      unusedCapture.delete(identityKey(captured.identity));
      const moved = captured.rect.left !== finalRect.left || captured.rect.top !== finalRect.top;
      const resized = captured.rect.width !== finalRect.width || captured.rect.height !== finalRect.height;
      const contentChanged = captured.text !== (finalCard.node.textContent ?? "");
      const surfaceChanged = captured.identity.surface !== finalCard.identity.surface;
      if (!moved && !resized && !contentChanged && !surfaceChanged) continue;

      if (this.canAnimate(finalCard.node) && (!(contentChanged || resized) || this.canAnimate(captured.shell))) {
        if (contentChanged || resized) {
          this.attachShell(run, captured.shell, captured.rect);
          this.animate(run, captured.shell, shellFrames(captured.rect, finalRect, false));
        }
        this.animate(
          run,
          finalCard.node,
          motionFrames(captured.rect.left - finalRect.left, captured.rect.top - finalRect.top, contentChanged || resized ? 0 : 1, 1),
        );
      } else {
        run.fallbackRequired = true;
      }
    }

    for (const key of unusedCapture) {
      const captured = this.capture.get(key);
      if (captured == null) continue;
      if (this.canAnimate(captured.shell)) {
        this.attachShell(run, captured.shell, captured.rect);
        this.animate(run, captured.shell, shellFrames(captured.rect, captured.rect, true));
      } else {
        run.fallbackRequired = true;
      }
    }
    this.capture.clear();

    if (run.animations.size === 0) {
      if (run.fallbackRequired) run.fallback = setTimeout(() => this.completeRun(token), this.durationMs);
      else this.completeRun(token);
      return;
    }
    run.deadline = setTimeout(() => this.completeRun(token, true), this.durationMs * 2);
    if (run.pendingFinished.size === 0) {
      run.fallback = setTimeout(() => this.completeRun(token), this.durationMs);
    }
  }

  diagnostics(): { epoch: string | null; inFlight: boolean; animations: number; shells: number; captured: number } {
    return {
      epoch: this.run?.epoch ?? null,
      inFlight: this.run != null,
      animations: this.run?.animations.size ?? 0,
      shells: this.run?.shells.size ?? 0,
      captured: this.capture.size,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelActiveRun();
    this.capture.clear();
    this.captureEpoch = null;
    this.registrations.clear();
  }

  private attachShell(run: ActiveRun, shell: HTMLElement, rect: RectSnapshot): void {
    const root = this.root();
    if (root == null) return;
    shell.setAttribute("data-layout-motion-shell", "true");
    shell.setAttribute("aria-hidden", "true");
    shell.inert = true;
    Object.assign(shell.style, {
      position: "fixed",
      top: `${rect.top}px`,
      left: `${rect.left}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      margin: "0",
      overflow: "hidden",
      pointerEvents: "none",
      zIndex: "5",
    });
    root.append(shell);
    run.shells.add(shell);
  }

  private animate(run: ActiveRun, node: HTMLElement, frames: Keyframe[]): void {
    let animation: Animation;
    try {
      animation = node.animate(frames, { duration: this.durationMs });
    } catch {
      run.fallbackRequired = true;
      return;
    }
    run.animations.add(animation);
    const finished = animation.finished;
    if (finished == null || typeof finished.then !== "function") return;
    run.pendingFinished.add(animation);
    void finished.then(
      () => this.animationFinished(run.token, animation),
      () => {},
    );
  }

  private canAnimate(node: HTMLElement): boolean {
    return typeof Animation !== "undefined"
      && "finished" in Animation.prototype
      && typeof node.animate === "function";
  }

  private animationFinished(token: number, animation: Animation): void {
    const run = this.run;
    if (run == null || run.token !== token || !run.pendingFinished.has(animation) || !run.animations.has(animation)) return;
    run.pendingFinished.delete(animation);
    if (run.pendingFinished.size === 0) this.completeRun(token);
  }

  private completeRun(token: number, cancelAnimations = false): void {
    const run = this.run;
    if (run == null || run.token !== token || this.disposed) return;
    this.run = null;
    if (run.deadline != null) clearTimeout(run.deadline);
    if (run.fallback != null) clearTimeout(run.fallback);
    if (cancelAnimations) {
      for (const animation of run.animations) animation.cancel();
    }
    for (const shell of run.shells) shell.remove();
    run.complete();
  }

  private cancelActiveRun(): void {
    const run = this.run;
    if (run == null) return;
    this.run = null;
    this.nextToken += 1;
    if (run.deadline != null) clearTimeout(run.deadline);
    if (run.fallback != null) clearTimeout(run.fallback);
    for (const animation of run.animations) animation.cancel();
    for (const shell of run.shells) shell.remove();
  }
}

export function createLayoutMotionCoordinator(options: LayoutMotionCoordinatorOptions): LayoutMotionCoordinator {
  return new LayoutMotionCoordinator(options);
}
