import type { DisplayTyphoonV1 } from "./protocol";

export type TyphoonHeaderTone = "advisory" | "warning" | "emergency" | null;

const TONE_RANK: Record<Exclude<TyphoonHeaderTone, null>, number> = {
  advisory: 1,
  warning: 2,
  emergency: 3,
};

function toneForTyphoon(typhoon: DisplayTyphoonV1): TyphoonHeaderTone {
  if (typhoon.intensityClass === "猛烈な") return "emergency";
  if (typhoon.intensityClass === "非常に強い" || typhoon.sizeClass === "超大型") return "warning";
  if (typhoon.intensityClass === "強い" || typhoon.sizeClass === "大型") return "advisory";
  return null;
}

/** 同一カードでは全台風のうち最も注意を要する階級を見出しトーンにする。 */
export function typhoonHeaderTone(typhoons: readonly DisplayTyphoonV1[]): TyphoonHeaderTone {
  return typhoons.reduce<TyphoonHeaderTone>((current, typhoon) => {
    const candidate = toneForTyphoon(typhoon);
    if (candidate == null) return current;
    if (current == null || TONE_RANK[candidate] > TONE_RANK[current]) return candidate;
    return current;
  }, null);
}
