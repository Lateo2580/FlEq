// P3-WEATHER-NOTICE-001（C20、H11）: U-W（全国の気象警報）の通知の payload と、系列ごとの通知の印。
// 起草の commit では型を足すだけで、今の state・Persisted の欄は変えない（実装が P3-WN-AC05・AC07 で付け替える）。
import type { Operation } from "./p1-parser-boundary.types";
import type { NoticeMark } from "./p2-shared-runtime.types";

// 気象の音（分野別根音表の気象 C4）。危険警報（L4）は desktop だけで warning、特別警報（L5）は desktop＋sound で critical、
// 取消は cancel（P3-WN-AC01・AC03）。level は音を作らない desktop にも付く（mute の条件の段、notification-gate.ts の LEVEL_RANK）。
type WeatherCurrentPayloadBase = Readonly<{
  domain: "weather";
  level: "info" | "warning" | "critical" | "cancel";
  title: string;
  body: string;
}>;
// 引上げの intent が知らせる cell と段（P3-WN-AC01 の (5)・AC06 の (2)、Q-WN-PENDING-TARGETS）。
// [府県（区域 Code の先頭 2 桁）, 層の番号（WARNING_TYPES の順、0〜4）, 区域の Code, 現象（Kind/Code の一の位）, 段]。
// 引上げの pending は、どの target も後の合わせでその段以上で成り立たないときだけ外れる。取消の通知は持たない。
export type WeatherCurrentNoticeTarget = readonly [prefecture: string, layer: number, areaCode: string, phenomenon: string, level: 4 | 5];
type WeatherCurrentRaisePayload = WeatherCurrentPayloadBase & Readonly<{ targets: readonly WeatherCurrentNoticeTarget[] }>;
// 取り直しで拾った引上げ（H27、P3-WN-D-UW-H27=A、作者裁定 2026-11-01）は発表時刻と「取り直しで拾った」印を対で持つ（U-L と同じ形）。
export type WeatherCurrentNotificationPayload = WeatherCurrentPayloadBase
  | WeatherCurrentRaisePayload
  | (WeatherCurrentRaisePayload & Readonly<{ reportDateTime: string; recovered: true }>);

// 系列（報の subject・operation）ごとに 1 件。unconfirmed の印と同じ系列の集合（seriesExists）で生き、同じ所で消える（P3-WN-AC05）。
export type WeatherCurrentNotice = Readonly<{ subject: string; operation: Operation; notice: NoticeMark }>;
