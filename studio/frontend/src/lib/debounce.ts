export interface Debounced {
  (): void;
  cancel: () => void;
}

/** 末尾発火 debounce。引数なし関数専用 (Studio の用途は再 render トリガのみ) */
export function debounce(fn: () => void, waitMs: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = (() => {
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, waitMs);
  }) as Debounced;
  debounced.cancel = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
  };
  return debounced;
}
