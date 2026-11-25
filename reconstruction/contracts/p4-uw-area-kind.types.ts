import type { DisplayAreaSystem } from "./p2-snapshot-sse.types";
import type { WeatherCurrentPublicArea } from "./p3-uw-canon.types";

// P4-UW-AREA-KIND-001: 府県の行の勝った active の行から作る、区域ごとの種別。組の集合と並びは公開形の areas と同じ（層の名前の字の昇順 → Code の昇順）。
// kinds は Kind/Code（2 桁の数字）の重複なし・昇順で 1 つ以上。保存しない（合わせから作る派生の値）。
export type WeatherCurrentAreaKinds = readonly (readonly [system: DisplayAreaSystem, code: string, kinds: readonly string[]])[];
// 語彙 weatherCurrent.area の入力。公開形（view）は変えず、表示差分の行が運ぶ areaKinds を添える（P4-UAK-D-PLACE）。
export type WeatherCurrentVocabSource = WeatherCurrentPublicArea & Readonly<{ areaKinds: WeatherCurrentAreaKinds }>;
