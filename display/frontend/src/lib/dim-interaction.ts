// dim トグルの発火判定 (spec D4)。ブロックリスト (各コンポーネントの stopPropagation) から
// ガード反転 (受け手側で対話要素発を無視) へ。既存 stopPropagation は二重防御として残る。
const INTERACTIVE_ROLES = [
  "button", "link", "checkbox", "radio", "switch", "tab", "menuitem",
  "option", "slider", "spinbutton", "textbox", "combobox",
] as const;
const INTERACTIVE_SELECTOR = [
  "button", "a", "input", "select", "textarea",
  '[contenteditable]:not([contenteditable="false"])',
  ...INTERACTIVE_ROLES.map((r) => `[role="${r}"]`),
].join(", ");

export function shouldToggleDimOnClick(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  return target.closest(INTERACTIVE_SELECTOR) == null;
}

const EDITABLE_SELECTOR = 'input, select, textarea, [contenteditable]:not([contenteditable="false"])';

export function shouldToggleDimOnKey(
  e: Pick<KeyboardEvent, "key" | "repeat" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "target">,
): boolean {
  if (e.key.toLowerCase() !== "d") return false;
  if (e.repeat) return false; // 長押し反復で最終状態が不定になるのを防ぐ
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false; // 修飾キーは一律除外 (spec D4)
  if (e.target instanceof Element && e.target.closest(EDITABLE_SELECTOR) != null) return false;
  return true;
}

/** effectiveDim の合成則 (spec D5): 手動意思 && 警報非掲載。App の $derived から呼ぶ */
export function computeEffectiveDim(requested: boolean, alertActive: boolean): boolean {
  return requested && !alertActive;
}
