import type { PresentationTsunamiObservation } from "../presentation/types";
import type { DisplayTsunamiObservationV1 } from "./types";
import { projectTsunamiHeightSemantic } from "./tsunami-height-semantic";

type DisplayTsunamiObservationSource =
  | PresentationTsunamiObservation
  | DisplayTsunamiObservationV1;

function isPresentationObservation(
  observation: DisplayTsunamiObservationSource,
): observation is PresentationTsunamiObservation {
  return Object.hasOwn(observation, "maxHeight");
}

/**
 * Presentation 内部の結合用 field を display protocol v1 の明示 field へ投影する境界。
 * TypeScript の構造的型付けは余剰 property を実行時に除去しないため、spread／clone は使わない。
 */
export function projectDisplayTsunamiObservation(
  observation: DisplayTsunamiObservationSource,
): DisplayTsunamiObservationV1 {
  const maxHeightSemantic = isPresentationObservation(observation)
    ? projectTsunamiHeightSemantic(observation.maxHeight, observation.maxHeightValue)
    : observation.maxHeightSemantic;
  return {
    areaName: observation.areaName,
    ...(Object.hasOwn(observation, "areaCode")
      ? { areaCode: observation.areaCode ?? null }
      : {}),
    areaKind: observation.areaKind,
    ...(Object.hasOwn(observation, "stationCode")
      ? { stationCode: observation.stationCode ?? null }
      : {}),
    stationName: observation.stationName,
    arrivalTime: observation.arrivalTime,
    initial: observation.initial,
    maxHeightValue: observation.maxHeightValue,
    ...(maxHeightSemantic == null ? {} : { maxHeightSemantic }),
    condition: observation.condition,
    ...(Object.hasOwn(observation, "heightCondition")
      ? { heightCondition: observation.heightCondition ?? null }
      : {}),
  };
}

export function projectDisplayTsunamiObservations(
  observations: readonly DisplayTsunamiObservationSource[],
): DisplayTsunamiObservationV1[] {
  return observations.map(projectDisplayTsunamiObservation);
}
