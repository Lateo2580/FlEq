// P4-DISPLAY-SHELL-001（S0）DOM の入口。ここだけが DOM・EventSource・performance・timer を触る（P4-DS-AC01 (1)）。
// 描くのは screenFrame が返した値だけで、行の字と矩形を DOM の側で作らない（P4-DS-AC08 (2)）。

import type { ShellClientState, ShellColumn, ShellDrawCard, ShellFrame, ShellRect, ShellRow, ShellState, ShellText } from "../../../contracts/p4-display-shell.types";
import type { ShellPart } from "../../../contracts/p4-shell-types.types";
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
const topEl = requireElement("cards-top");
const middleEl = requireElement("cards-middle");
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
// ページの番号を替えるのは S1（自動のページ送り）。S0 は 0 のまま
const page: Record<ShellColumn, number> = { left: 0, right: 0 };
// カードの中のページの番号（カードの id → 番号）を替えるのも S1。今は空で、全部のカードが 1 ページ目（P4-ST-AC04 (1)）
const innerPage: Readonly<Partial<Record<string, number>>> = {};
let frame: ShellFrame | null = null;
// E04 の印は版ごとに 2 つ増えるので、直近 MARK_KEEP 版だけ残す（72 時間の稼働で印が増え続けるのを防ぐ）
const MARK_KEEP = 64;
// 版の名前は streamId と sequence の両方で作る（host の起動し直しで streamId が替わり、sequence は 1 から振り直されるため。掃除が新しい stream の印を消さない）
const received: string[] = [];
const painted: string[] = [];
const markName = (kind: "received" | "painted", version: string) => `fleq:s0:${kind}:${version}`;

// ---- 描画 ----
type Drawn = { node: HTMLElement; key: string };
let clipKey = "";
const drawn = new Map<string, Drawn>();
const loggedDiagnostics = new Set<string>();
let statusEl: HTMLElement | null = null;

// 描画の鍵（P4-ST-AC03 (3)）。字と token は「長さ:字」、null は長さを持たない「-」で並べ、区切りの字を含む字どうしでも鍵が重ならない
const keyOf = (value: string | null): string => (value == null ? "-" : `${value.length}:${value}`);
function partKey(part: ShellPart): string {
  switch (part.kind) {
    case "text": return `t${keyOf(part.token)}${keyOf(part.text)}`;
    case "group": return `g${keyOf(part.token)}${part.texts.length}:${part.texts.map((text) => keyOf(text.token) + keyOf(text.text)).join("")}`;
  }
}
const rowsKey = (rows: readonly ShellRow[]): string => rows.map((row) => `${row.height}|${keyOf(row.token)}${row.texts.map(partKey).join("")}`).join("");
const px = (value: number): string => `${value}px`;
// class は tokens.ts の固定表の値だけ。表に無い token には付けない（P4-DS-AC09 (1)）
const tokenClass = (token: string | null): string | null => (token != null && Object.hasOwn(TOKEN_CLASS, token) ? TOKEN_CLASS[token] : null);

function textNode(text: ShellText): HTMLElement {
  const span = document.createElement("span");
  span.textContent = text.text;
  const name = tokenClass(text.token);
  if (name != null) span.className = name;
  return span;
}

function partNode(part: ShellPart): HTMLElement {
  switch (part.kind) {
    case "text": return textNode(part);
    case "group": {
      const span = document.createElement("span");
      const name = tokenClass(part.token);
      if (name != null) span.className = name;
      span.append(...part.texts.map(textNode));
      return span;
    }
  }
}

function rowNode(row: ShellRow): HTMLElement {
  const node = document.createElement("div");
  const name = tokenClass(row.token);
  node.className = name != null ? `row ${name}` : "row";
  node.style.height = px(row.height);
  node.append(...row.texts.map(partNode));
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

// 中間の層は cover（最上層のカードとその間）の中を描かず、地図を見せる（AC06 (9)）。layout は読まず、frame の矩形から切り抜きの字を作る
function clipMiddle(cover: readonly ShellRect[]): void {
  const hole = (r: ShellRect) => `M${r.x} ${r.y}h${r.w}v${r.h}h${-r.w}Z`;
  const key = cover.length === 0 ? "none" : `path(evenodd, "M0 0H${LAYOUT.screen.w}V${LAYOUT.screen.h}H0Z ${cover.map(hole).join(" ")}")`;
  if (key === clipKey) return;
  clipKey = key;
  middleEl.style.clipPath = key === "none" ? "none" : key;
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
    }
    // 最上層と中間の層は別の container。層が替わったカードは移す
    const container = card.layer === "top" ? topEl : middleEl;
    if (entry.node.parentElement !== container) container.append(entry.node);
    const key = `${rowsKey(card.rows)}\u0004${card.mark == null ? "" : `${card.mark.text}|${card.mark.dots}|${card.mark.at}`}`;
    if (key !== entry.key) {
      entry.key = key;
      const children: HTMLElement[] = card.rows.map(rowNode);
      const mark = markNode(card);
      if (mark != null) children.push(mark);
      entry.node.replaceChildren(...children);
    }
    const cardClass = tokenClass(card.token);
    entry.node.className = `${card.dimmed ? "card dim" : "card"}${cardClass != null ? ` ${cardClass}` : ""}`;
    entry.node.style.left = px(card.rect.x);
    entry.node.style.top = px(card.rect.y);
    entry.node.style.width = px(card.rect.w);
    entry.node.style.height = px(card.rect.h);
    entry.node.style.zIndex = String(card.layer === "top" ? topCount - topIndex++ : 1 + middleIndex++);
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
  const next = screenFrame({ state: client, nowMs: now, page, innerPage, shell });
  clipMiddle(next.cover);
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
  const version = received.pop();
  // 描く前に合流して消えた版の received は消す
  for (const skipped of received.splice(0)) performance.clearMarks(markName("received", skipped));
  if (version != null) {
    painted.push(version);
    const old = painted.length > MARK_KEEP ? painted.shift() : undefined;
    if (old != null) { performance.clearMarks(markName("received", old)); performance.clearMarks(markName("painted", old)); }
    nextPaint(() => { performance.mark(markName("painted", version)); });
  }
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
    const accepted = next.snapshot != null && next.snapshot !== client.snapshot ? `${next.snapshot.streamId}:${next.snapshot.sequence}` : null;
    client = next;
    if (accepted != null) { performance.mark(markName("received", accepted), { startTime: receivedAt }); received.push(accepted); }
    // 描画の止まる間（隠れた tab）も印を溜めない
    const dropped = received.length > MARK_KEEP ? received.shift() : undefined;
    if (dropped != null) performance.clearMarks(markName("received", dropped));
    // snapshot を採るたびに sync を当てる（合流しない。D3）
    shell = reduceShell(shell, shellSync(client, Date.now()));
    requestFrame();
  });
  armClock();
  requestFrame();
}

boot();
