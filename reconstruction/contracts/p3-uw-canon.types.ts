// P3-UW-CANON-001（③ U-W の正本の持ち方）: U-W の owner が publisher へ常に配る形と、範囲・版つきの詳細の口の型。
// 前例は P3-UF-PUBLIC-001（p2-weather-timeseries-unit.types.ts の WeatherTimeseriesPublicSubject と詳細の口）。
// 起草の commit では型を足すだけで、今の view・RuntimeDisplaySubject・OwnerRequest の欄は変えない（実装が P3-UWC-AC05・AC06 で付け替える）。
import type { Operation } from "./p1-parser-boundary.types";
import type { ReportRef } from "./p2-shared-runtime.types";
import type { DisplayAreaSystem } from "./p2-snapshot-sse.types";
import type { WeatherTimeseriesDetailError } from "./p2-weather-timeseries-unit.types";
import type { WeatherCurrentUnavailableReason } from "./p2-weather-current-unit.types";

// 府県（区域 Code の先頭 2 桁）×operation ごとに、全国報と partial を区域×Kind/Code で合わせた結果（P3-UWC-D-MERGE・D-GROUP）。
// 勝った行そのものは持たず、詳細の口（part: "areas"）が (id, revision) で読む。
export type WeatherCurrentPublicArea = Readonly<{
  // `${operation}/area/${prefecture}`。報の subject（operation/family/office）とは重ならない。
  subject: string;
  operation: Operation;
  prefecture: string;
  // JSON.stringify(["U-W", operation, subject]) の sha256 の小文字 hex64（P2-A8-NOTICE.identity の targetId と同じ作り方）。
  id: string;
  // この object を作った step の U-W の内容版（10 進、16 桁以下）。
  revision: string;
  // 勝った行の報のうち compareVersion で最も新しいもの（P3-VM-AC03）。
  source: ReportRef;
  // active の区域（解除・「なし」・Code 00 と、復元して未確認の報の行を除く）。[区域の層, Code] の重複なし・昇順。
  areas: readonly (readonly [system: DisplayAreaSystem, code: string])[];
  // active の行の Kind/Code ごとの区域の数（areas と同じ行から数える）。
  codes: Readonly<Record<string, number>>;
  // P3-TP-AC09: active の行の Kind/Code ごとの電文の Kind/Name（最初に見つけた空でない字のまま）。名前の無い Code は鍵を作らない。
  names: Readonly<Record<string, string>>;
  // 勝った行の数（解除の行と復元して未確認の報の行を含む）。詳細の pageCount の元。
  cellCount: number;
  // 勝った行のうち、復元して未確認の報（restoredUnconfirmed）の行の数。
  restoredCellCount: number;
}>;

// 監視の行（unavailable）の常に配る形。lastKnown の本文は持たず、詳細の口（part: "lastKnown"）が読む。
export type WeatherCurrentPublicUnavailable = Readonly<{
  subject: string;
  operation: Operation;
  reason: WeatherCurrentUnavailableReason;
  source: ReportRef | null;
  affectedScope: readonly string[];
  // lastKnown の行の数。lastKnown が無ければ null。
  lastKnownRows: number | null;
}>;

// 詳細の口（P3-UWC-AC06）。streamId は publisher が照合して外してから owner へ渡す。unit は U-F の要求との判別に使う。
export type WeatherCurrentDetailRequest =
  | Readonly<{ unit: "U-W"; part: "index"; revision: string; page: number }>
  | Readonly<{ unit: "U-W"; part: "areas" | "lastKnown"; id: string; revision: string; page: number }>;

// 詳細の 1 行。areas は合わせた後の勝った行、lastKnown は unavailable の lastKnown の行（Code の無い「なし」の行を含む）。
export type WeatherCurrentDetailRow = readonly [
  areaType: string, areaCode: string, code: string | null, status: string, name: string | null,
  reportDateTimeRaw: string, restored: boolean,
];

export type WeatherCurrentDetailIndexEntry = Readonly<{
  id: string;
  operation: Operation;
  part: "areas" | "lastKnown";
  // areas は府県の 2 桁、lastKnown は報の subject（UTF-8 で 256 byte 以下の先頭）。
  key: string;
  keyTruncated: boolean;
  revision: string;
  rowCount: number;
}>;

export type WeatherCurrentDetailResponse =
  | Readonly<{ kind: "ok"; part: "index"; revision: string; page: number; pageCount: number; entryCount: number;
      entries: readonly WeatherCurrentDetailIndexEntry[] }>
  | Readonly<{ kind: "ok"; part: "areas" | "lastKnown"; id: string; revision: string; page: number; pageCount: number;
      rowCount: number; rows: readonly Readonly<{ index: number; row: WeatherCurrentDetailRow }>[];
      omitted: readonly Readonly<{ index: number; reason: "pageBudget" }>[] }>
  | WeatherTimeseriesDetailError;
