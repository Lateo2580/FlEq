// P4-DISPLAY-SHELL-001（S0）DOM の入口。ここだけが DOM・EventSource・performance・timer を触る（P4-DS-AC01 (1)）。
// 描くのは screenFrame が返した値だけで、行の字と矩形を DOM の側で作らない（P4-DS-AC08 (2)）。

import type { ShellClientState, ShellColumn, ShellDrawCard, ShellFrame, ShellRow, ShellState } from "../../../contracts/p4-display-shell.types";
import { acceptSnapshot } from "./client.js";
import { screenFrame, shellSync } from "./frame.js";
import { reduceShell } from "./layout.js";
import { COLORS, LAYOUT, TOKEN_CLASS } from "./tokens.js";

// ---- 破棄の表（R52）: 購読は全部ここに登録して張り、まとめて外す ----
const live = new Set<() => void>();
function track(release: () => void): () => void {
  live.add(release);
  return () => { live.delete(release); };
}
function listen(target: EventTarget, type: string, handler: (event: Event) => void): void {
  target.addEventListener(type, handler);
  track(() => target.removeEventListener(type, handler));
}
function teardown(): void {
  for (const release of [...live]) { live.delete(release); release(); }
}

function requireElement(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node == null) throw new Error(`missing element #${id}`);
  return node;
}
const screenEl = requireElement("screen");
const cardsEl = requireElement("cards");
const clockEl = requireElement("clock");
const clockDate = requireElement("clock-date");
const clockTime = requireElement("clock-time");

// 起動の時に 1 回だけ、tokens.ts の値を CSS の変数へ入れる（P4-DS-AC01 (5)）
function cssVariables(): void {
  const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  const put = (name: string, value: string) => document.documentElement.style.setProperty(name, value);
  const walk = (prefix: string, value: unknown): void => {
    if (typeof value === "number") put(`--${prefix}`, prefix === "dim" ? String(value) : `${value}px`);
    else if (typeof value === "object" && value !== null && !Array.isArray(value))
      for (const [key, inner] of Object.entries(value)) walk(prefix === "" ? kebab(key) : `${prefix}-${kebab(key)}`, inner);
  };
  walk("", LAYOUT);
  for (const [name, color] of Object.entries(COLORS)) put(`--c-${name}`, color);
}

// 画面の大きさを読むのは、起動の時と resize の handler だけ（P4-DS-AC11 (3)）
let scale = 1;
function readViewport(): void {
  scale = Math.min(window.innerWidth / LAYOUT.screen.w, window.innerHeight / LAYOUT.screen.h);
  screenEl.style.transform = `scale(${scale})`;
}

// ---- 状態 ----
let client: ShellClientState = { snapshot: null, unsupported: false, changed: [], detail: null };
let shell: ShellState = { open: false, raised: [], eew: [] };
const page: Record<ShellColumn, number> = { left: 0, right: 0 };
let frame: ShellFrame | null = null;
let paintSequence: number | null = null;

// ---- 描画 ----
type Drawn = { node: HTMLElement; key: string };
const drawn = new Map<string, Drawn>();
const loggedDiagnostics = new Set<string>();
let statusEl: HTMLElement | null = null;

const rowsKey = (rows: readonly ShellRow[]): string =>
  rows.map((row) => `${row.height}|${row.texts.map((text) => `${text.token ?? ""}\u0001${text.text}`).join("\u0002")}`).join("\u0003");
const px = (value: number): string => `${value}px`;

function rowNode(row: ShellRow): HTMLElement {
  const node = document.createElement("div");
  node.className = "row";
  node.style.height = px(row.height);
  for (const text of row.texts) {
    const span = document.createElement("span");
    span.textContent = text.text;
    // class は tokens.ts の固定表の値だけ。表に無い token には付けない（P4-DS-AC09 (1)）
    if (text.token != null && Object.hasOwn(TOKEN_CLASS, text.token)) span.className = TOKEN_CLASS[text.token];
    node.append(span);
  }
  return node;
}

function markNode(card: ShellDrawCard): HTMLElement | null {
  const mark = card.mark;
  if (mark == null) return null;
  const node = document.createElement("div");
  node.className = `mark ${mark.at}`;
  const label = document.createElement("span");
  label.textContent = mark.text;
  node.append(label);
  if (mark.dots) for (let i = 0; i < mark.pages; i++) {
    const dot = document.createElement("span");
    dot.className = i === mark.page ? "dot on" : "dot";
    node.append(dot);
  }
  return node;
}

function drawCards(cards: readonly ShellDrawCard[]): void {
  const topCount = cards.filter((card) => card.layer === "top").length;
  let topIndex = 0, middleIndex = 0;
  const seen = new Set<string>();
  for (const card of cards) {
    seen.add(card.id);
    let entry = drawn.get(card.id);
    if (entry == null) {
      const node = document.createElement("div");
      entry = { node, key: "" };
      drawn.set(card.id, entry);
      cardsEl.append(node);
    }
    const key = `${rowsKey(card.rows)}\u0004${card.mark == null ? "" : `${card.mark.text}|${card.mark.dots}|${card.mark.at}`}`;
    if (key !== entry.key) {
      entry.key = key;
      const children: HTMLElement[] = card.rows.map(rowNode);
      const mark = markNode(card);
      if (mark != null) children.push(mark);
      entry.node.replaceChildren(...children);
    }
    entry.node.className = card.dimmed ? "card dim" : "card";
    entry.node.style.left = px(card.rect.x);
    entry.node.style.top = px(card.rect.y);
    entry.node.style.width = px(card.rect.w);
    entry.node.style.height = px(card.rect.h);
    entry.node.style.zIndex = String(card.layer === "top" ? 1000 + topCount - topIndex++ : 1 + middleIndex++);
  }
  for (const [id, entry] of drawn) if (!seen.has(id)) { entry.node.remove(); drawn.delete(id); }
}

function drawStatus(status: readonly string[]): void {
  if (status.length === 0) { statusEl?.remove(); statusEl = null; return; }
  statusEl ??= Object.assign(document.createElement("div"), { id: "status" });
  statusEl.replaceChildren(...status.map((text) => Object.assign(document.createElement("div"), { textContent: text })));
  screenEl.append(statusEl);
}

function render(): void {
  const now = Date.now();
  shell = reduceShell(shell, shellSync(client, now));
  const next = screenFrame({ state: client, nowMs: now, page, shell });
  drawCards(next.cards);
  const { rect, text } = next.clock;
  clockEl.style.left = px(rect.x); clockEl.style.top = px(rect.y); clockEl.style.width = px(rect.w); clockEl.style.height = px(rect.h);
  // 時計の字は frame の字を年月日と時分に分けて入れるだけ
  clockDate.textContent = text.slice(0, -5); clockTime.textContent = text.slice(-5);
  drawStatus(next.status);
  for (const item of next.diagnostics) {
    const key = `${item.reason}:${item.entry}:${item.returned}:${item.max}`;
    if (!loggedDiagnostics.has(key)) { loggedDiagnostics.add(key); console.warn(item.reason, item); }
  }
  frame = next;
  // E04: 描いた後の最初の paint に印を置く（P4-DS-AC12）
  const sequence = paintSequence;
  paintSequence = null;
  if (sequence != null) nextPaint(() => { performance.mark(`fleq:s0:painted:${sequence}`); });
}

let frameRelease: (() => void) | null = null;
function requestFrame(): void {
  if (frameRelease != null) return;
  const id = requestAnimationFrame(() => { const drop = frameRelease; frameRelease = null; drop?.(); render(); });
  const drop = track(() => cancelAnimationFrame(id));
  frameRelease = drop;
}
function nextPaint(task: () => void): void {
  const id = requestAnimationFrame(() => { drop(); task(); });
  const drop = track(() => cancelAnimationFrame(id));
}

// 時計は分の変わり目に 1 回だけ字を替える（timer 1 本）
function armClock(): void {
  const id = setTimeout(() => { drop(); requestFrame(); armClock(); }, 60_000 - (Date.now() % 60_000) + 20);
  const drop = track(() => clearTimeout(id));
}

function boot(): void {
  cssVariables();
  readViewport();
  listen(window, "resize", readViewport);
  // 押した点は画面の倍率で割って 1920×1080 の座標にし、いま描いている frame と一緒に reduceShell へ渡す
  listen(window, "pointerdown", (event) => {
    if (!(event instanceof PointerEvent) || frame == null) return;
    const next = reduceShell(shell, { kind: "press", frame, x: event.clientX / scale, y: event.clientY / scale });
    if (next !== shell) { shell = next; requestFrame(); }
  });
  listen(window, "pagehide", teardown);
  // 再接続はブラウザの自動の再接続に任せ、listener は 1 度だけ張る（P4-DS-AC11 (1)）
  const source = new EventSource("/api/display/wire/events");
  track(() => source.close());
  listen(source, "snapshot", (event) => {
    const receivedAt = performance.now();
    if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
    const next = acceptSnapshot(client, event.data);
    if (next === client) return;
    const accepted = next.snapshot != null && next.snapshot !== client.snapshot ? next.snapshot.sequence : null;
    client = next;
    if (accepted != null) { performance.mark(`fleq:s0:received:${accepted}`, { startTime: receivedAt }); paintSequence = accepted; }
    // snapshot を採るたびに sync を当てる（合流しない。D3）
    shell = reduceShell(shell, shellSync(client, Date.now()));
    requestFrame();
  });
  armClock();
  requestFrame();
}

boot();

// smoke と後の契約（S1 のページ送り）が使う入口。ページの番号を替えて描き直す
Object.assign(window, { fleqScreenSetPage: (column: ShellColumn, index: number) => { page[column] = index; requestFrame(); } });
