import type { WeatherTimeseriesDetailError } from "./p2-weather-timeseries-unit.types";

// 火山の解説と南海トラフの情報の本文を返す API（P3-BULLETIN-TEXT-API-001）。streamId は publisher が照合して外してから owner へ渡す。
// id は view の subject。revision は view の source の inputId・reportDateTimeRaw・controlDateTimeRaw を順に並べた JSON 配列の文字列で、
// 時刻の欄を含めるのは、inputId の採番が起動ごとに戻り、復元した報と新しい報が同じ inputId になりうるから（P3-BT-D-KEY）。
// 1 件が 1 応答に収まる（P3-BT-RES-01）ので page を持たない。
export type BulletinTextRequest = Readonly<{ unit: "U-V" | "U-N"; part: "text"; id: string; revision: string }>;

// text と nextAdvisory は state の字のまま。電文に無い欄は null。切り詰めの有無は view の見出しの truncated で読む。
export type BulletinTextResponse =
  | Readonly<{ kind: "ok"; part: "text"; id: string; revision: string; text: string | null; nextAdvisory: string | null }>
  | WeatherTimeseriesDetailError;
