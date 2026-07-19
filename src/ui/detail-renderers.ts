import type {
  DetailKind,
  DetailSnapshot,
  DetailSnapshotOf,
} from "../types";
import { displayTsunamiInfo } from "./tsunami-formatter";
import { renderVolcanoDetail } from "./volcano-formatter";
import { displayVpws50FromState } from "./weather-formatter-vpws50";
import { displayVpwp50Detail } from "./vpwp50-detail-formatter";

type DetailRenderers = {
  [K in DetailKind]: (snapshot: DetailSnapshotOf<K>) => void;
};

const RENDERERS = {
  tsunami: (snapshot) => displayTsunamiInfo(snapshot.info),
  volcano: (snapshot) => renderVolcanoDetail(snapshot.entries),
  vpws50: (snapshot) => displayVpws50FromState(snapshot.display),
  vpwp50: (snapshot) => displayVpwp50Detail(snapshot.detail),
} satisfies DetailRenderers;

function assertNever(value: never): never {
  throw new Error(`Unknown detail snapshot: ${JSON.stringify(value)}`);
}

/** kind と renderer の対応を網羅的に dispatch する。 */
export function renderDetail(snapshot: DetailSnapshot): void {
  switch (snapshot.kind) {
    case "tsunami": return RENDERERS.tsunami(snapshot);
    case "volcano": return RENDERERS.volcano(snapshot);
    case "vpws50": return RENDERERS.vpws50(snapshot);
    case "vpwp50": return RENDERERS.vpwp50(snapshot);
    default: return assertNever(snapshot);
  }
}
