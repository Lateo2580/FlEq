import type { ProcessOutcome, PresentationEvent } from "../types";
import { fromEewOutcome } from "./from-eew";
import { fromEarthquakeOutcome } from "./from-earthquake";
import { fromSeismicTextOutcome } from "./from-seismic-text";
import { fromLgObservationOutcome } from "./from-lg-observation";
import { fromTsunamiOutcome } from "./from-tsunami";
import { fromVolcanoOutcome } from "./from-volcano";
import { fromNankaiTroughOutcome } from "./from-nankai-trough";
import { fromRawOutcome } from "./from-raw";

/** ProcessOutcome → PresentationEvent に変換する */
export function toPresentationEvent(outcome: ProcessOutcome): PresentationEvent {
  switch (outcome.domain) {
    case "eew":
      return fromEewOutcome(outcome);
    case "earthquake":
      return fromEarthquakeOutcome(outcome);
    case "seismicText":
      return fromSeismicTextOutcome(outcome);
    case "lgObservation":
      return fromLgObservationOutcome(outcome);
    case "tsunami":
      return fromTsunamiOutcome(outcome);
    case "volcano":
      return fromVolcanoOutcome(outcome);
    case "nankaiTrough":
      return fromNankaiTroughOutcome(outcome);
    case "raw":
      return fromRawOutcome(outcome);
  }
}
