const DIM_STORAGE_KEY = "fleq-display-dim";

// 手動トグル意思 (requestedDim)。実効値 (effectiveDim = requested && !警報掲載中) は App が合成する
// (spec D5)。storage 例外は握って明るい側へ倒す: 読めなければ false 起動、書けなくても
// セッション内の意思は維持し、再起動時だけ既定の明状態へ戻る。
export function createDimStore(storage: Storage = window.localStorage): {
  readonly requested: boolean;
  toggle(): void;
} {
  let requested = $state(safeRead(storage));

  return {
    get requested() {
      return requested;
    },
    toggle(): void {
      requested = !requested;
      try {
        storage.setItem(DIM_STORAGE_KEY, requested ? "1" : "0");
      } catch {
        // 永続化失敗は無視 (セッション内の意思を優先)
      }
    },
  };
}

function safeRead(storage: Storage): boolean {
  try {
    return storage.getItem(DIM_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}
