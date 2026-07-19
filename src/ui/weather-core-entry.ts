// VPWW55-61 の entry 組み立て・層選択・遷移集計の実体は engine 層へ移動した
// (display 層が ui に依存できないため)。既存 UI からの import 互換のための re-export。
export {
  flattenEntries,
  pickStatusLayer,
  pickAreaSummaryLayer,
  summarizeTransitions,
  weatherCoreDisplaySeverity,
  weatherCoreFrameLevel,
  type WarningEntry,
  type TransitionCount,
  type DisplayMode,
} from "../engine/weather/weather-warning-core";
