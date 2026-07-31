import fs from "fs";
import path from "path";
import zlib from "zlib";
import { WsDataMessage } from "../../src/types";
import type { ParsedWeatherWarningTimeseriesInfo } from "../../src/types";
import { normalizeTelegramMessage } from "../../src/dmdata/telegram-ingress";
import { deriveIsTest } from "../../src/dmdata/telegram-meta";
import { parseTelegramEnvelopeXml } from "../../src/dmdata/telegram-envelope";

/** フィクスチャディレクトリのパス */
const FIXTURES_DIR = path.resolve(__dirname, "../fixtures");

// ── フィクスチャパス定数 ──

/** VXSE51 震度速報 (最大4) */
export const FIXTURE_VXSE51_SHINDO = "32-35_08_03_100915_VXSE51.xml";

/** VXSE51 震度速報 (別パターン) */
export const FIXTURE_VXSE51_SHINDO_2 = "32-35_07_01_100915_VXSE51.xml";

/** VXSE51 取消報 */
export const FIXTURE_VXSE51_CANCEL = "32-35_10_01_220510_VXSE51.xml";

/** VXSE53 遠地地震 (フィジー Mj7.1) */
export const FIXTURE_VXSE53_ENCHI = "32-35_01_03_100514_VXSE53.xml";

/** VXSE53 遠地地震 取消報 */
export const FIXTURE_VXSE53_CANCEL = "32-39_05_12_100915_VXSE53.xml";

/** VXSE53 震源・震度情報 (訓練) */
export const FIXTURE_VXSE53_DRILL_1 = "32-35_01_03_240613_VXSE53.xml";

/** VXSE53 震源・震度情報 (訓練 別報) */
export const FIXTURE_VXSE53_DRILL_2 = "32-35_04_04_240613_VXSE53.xml";

/** VXSE44 EEW予報 Serial=10 */
export const FIXTURE_VXSE44_S10 = "36_01_10_240613_VXSE44.xml";

/** VXSE43 EEW警報 Serial=1 */
export const FIXTURE_VXSE43_WARNING_S1 = "37_01_01_240613_VXSE43.xml";

/** VXSE43 EEW警報 Serial=2 */
export const FIXTURE_VXSE43_WARNING_S2 = "37_01_02_240613_VXSE43.xml";

/** VXSE43 EEW警報 Serial=3 */
export const FIXTURE_VXSE43_WARNING_S3 = "37_01_03_240613_VXSE43.xml";

/** VXSE45 EEW地震動予報 Serial=1 初報 */
export const FIXTURE_VXSE45_S1 = "77_01_01_240613_VXSE45.xml";

/** VXSE45 EEW地震動予報 Serial=26 */
export const FIXTURE_VXSE45_S26 = "77_01_26_240613_VXSE45.xml";


/** VXSE45 EEW地震動予報 取消報 Serial=32 */
export const FIXTURE_VXSE45_CANCEL = "77_01_33_240613_VXSE45.xml";

/** VXSE52 震源に関する情報 */
export const FIXTURE_VXSE52_HYPO_1 = "32-35_01_02_240613_VXSE52.xml";

/** VXSE52 震源に関する情報 (別報) */
export const FIXTURE_VXSE52_HYPO_2 = "32-35_04_03_240613_VXSE52.xml";

/** VXSE52 震源に関する情報 */
export const FIXTURE_VXSE52_HYPO_3 = "32-35_06_02_100915_VXSE52.xml";

/** VXSE52 震源に関する情報 */
export const FIXTURE_VXSE52_HYPO_4 = "33_12_01_240613_VXSE52.xml";

/** VXSE56 地震活動情報 */
export const FIXTURE_VXSE56_ACTIVITY_1 = "32-35_09_01_191111_VXSE56.xml";

/** VXSE56 地震活動情報 (別報) */
export const FIXTURE_VXSE56_ACTIVITY_2 = "32-35_09_02_220316_VXSE56.xml";

/** VXSE60 地震回数情報 */
export const FIXTURE_VXSE60_1 = "32-35_03_01_100514_VXSE60.xml";

/** VXSE60 地震回数情報 取消 */
export const FIXTURE_VXSE60_CANCEL = "32-35_10_02_220510_VXSE60.xml";

/** VXSE61 震源要素更新 */
export const FIXTURE_VXSE61_1 = "32-35_03_02_240613_VXSE61.xml";

/** VXSE61 震源要素更新 取消 */
export const FIXTURE_VXSE61_CANCEL = "32-35_06_10_100915_VXSE61.xml";

/** VTSE41 津波警報・注意報 */
export const FIXTURE_VTSE41_WARN = "32-39_11_02_250206_VTSE41.xml";

/** VTSE41 津波警報・注意報 取消 */
export const FIXTURE_VTSE41_CANCEL = "38-39_03_01_210805_VTSE41.xml";

/** VTSE51 津波情報 */
export const FIXTURE_VTSE51_INFO = "32-39_11_03_250206_VTSE51.xml";

/** VTSE52 沖合の津波情報 */
export const FIXTURE_VTSE52_OFFSHORE = "61_11_01_250206_VTSE52.xml";

/** VTSE51 津波観測に関する情報 (Observation が予報区名付き、MaxHeight に TsunamiHeight 実測値あり) */
export const FIXTURE_VTSE51_OBSERVATION_MAXHEIGHT = "32-39_11_10_250206_VTSE51.xml";

/** VXSE45 PLUM法のみ (仮定震源要素) */
export const FIXTURE_VXSE45_PLUM = "77_02_01_260101_VXSE45_PLUM.xml";

/** VXSE45 混合 (通常推定 + PLUM法地域) */
export const FIXTURE_VXSE45_MIXED = "77_02_02_260101_VXSE45_MIXED.xml";

/** VZSE40 地震・津波に関するお知らせ */
export const FIXTURE_VZSE40_NOTICE = "42_01_01_100514_VZSE40.xml";

/** VZSE40 地震・津波に関するお知らせ (取消) */
export const FIXTURE_VZSE40_CANCEL = "42_03_01_220402_VZSE40.xml";

/** VYSE50 南海トラフ地震臨時情報 (調査中 Code=111) */
export const FIXTURE_VYSE50_INVESTIGATION = "74_01_01_200512_VYSE50.xml";

/** VYSE50 南海トラフ地震臨時情報 (巨大地震警戒 Code=120) */
export const FIXTURE_VYSE50_ALERT = "74_01_04_200512_VYSE50.xml";

/** VYSE50 南海トラフ地震臨時情報 (巨大地震注意 Code=130) */
export const FIXTURE_VYSE50_CAUTION = "74_01_06_200512_VYSE50.xml";

/** VYSE50 南海トラフ地震臨時情報 (調査終了 Code=190) */
export const FIXTURE_VYSE50_CLOSED = "74_01_07_200512_VYSE50.xml";

/** VYSE50 南海トラフ地震臨時情報 (取消) */
export const FIXTURE_VYSE50_CANCEL = "74_03_01_220318_VYSE50.xml";

/** VYSE51 南海トラフ地震関連解説情報 (臨時 Code=210) */
export const FIXTURE_VYSE51_ADVISORY = "75_01_01_200512_VYSE51.xml";

/** VYSE52 南海トラフ地震関連解説情報 (定例 Code=200) */
export const FIXTURE_VYSE52_REGULAR = "75_01_04_200512_VYSE52.xml";

/** VXSE62 長周期地震動に関する観測情報 */
export const FIXTURE_VXSE62_LGOBS = "78_01_01_240613_VXSE62.xml";

/** VYSE60 北海道・三陸沖後発地震注意情報 */
export const FIXTURE_VYSE60_AFTERSHOCK = "80_01_01_240821_VYSE60.xml";

/** VXSE45 EEW地震動予報 最終報 (NextAdvisory付き) */
export const FIXTURE_VXSE45_FINAL = "77_01_30_260101_VXSE45_FINAL.xml";

// ── 火山フィクスチャ ──

/** VFVO50 噴火警報 (レベル3 引上げ) */
export const FIXTURE_VFVO50_ALERT_LV3 = "45_01_01_200522_VFVO50.xml";

/** VFVO50 噴火警報 (レベル3 継続) */
export const FIXTURE_VFVO50_ALERT_CONTINUE = "45_02_01_200522_VFVO50.xml";

/** VFVO50 噴火警報 (レベル1 引下げ) */
export const FIXTURE_VFVO50_ALERT_LOWER = "45_03_01_200731_VFVO50.xml";

/** VFVO51 火山の状況に関する解説情報 (臨時) */
export const FIXTURE_VFVO51_EXTRA = "44_01_01_151008_VFVO51.xml";

/** VFVO51 火山の状況に関する解説情報 (通常) */
export const FIXTURE_VFVO51_NORMAL = "44_02_01_200522_VFVO51.xml";

/** VFVO51 火山の状況に関する解説情報 (別パターン) */
export const FIXTURE_VFVO51_3 = "44_03_01_200731_VFVO51.xml";

/** VFVO52 噴火に関する火山観測報 */
export const FIXTURE_VFVO52_ERUPTION_1 = "43_01_01_200522_VFVO52.xml";

/** VFVO52 噴火に関する火山観測報 (別パターン) */
export const FIXTURE_VFVO52_ERUPTION_2 = "43_02_01_200522_VFVO52.xml";

/** VFVO52 噴火に関する火山観測報 (別パターン) */
export const FIXTURE_VFVO52_ERUPTION_3 = "43_03_01_200522_VFVO52.xml";

/** VFSVii 火山海上警報 */
export const FIXTURE_VFSV_MARINE = "46_01_01_170103_VFSVii.xml";

/** VFVO53 降灰予報 (定時) */
export const FIXTURE_VFVO53_ASH_REGULAR = "66_01_01_210517_VFVO53.xml";

/** VFVO54 降灰予報 (速報) */
export const FIXTURE_VFVO54_ASH_RAPID = "66_01_02_210514_VFVO54.xml";

/** VFVO55 降灰予報 (詳細) */
export const FIXTURE_VFVO55_ASH_DETAIL = "66_01_03_210514_VFVO55.xml";

/** VFVO56 噴火速報 */
export const FIXTURE_VFVO56_FLASH_1 = "67_01_01_140927_VFVO56.xml";

/** VFVO56 噴火速報 (2報目) */
export const FIXTURE_VFVO56_FLASH_2 = "67_01_02_140927_VFVO56.xml";

/** VFVO56 噴火速報 (3報目) */
export const FIXTURE_VFVO56_FLASH_3 = "67_01_03_140927_VFVO56.xml";

/** VFVO56 噴火速報 (4報目) */
export const FIXTURE_VFVO56_FLASH_4 = "67_01_04_140927_VFVO56.xml";

/** VFVO60 推定噴煙流向報 */
export const FIXTURE_VFVO60_PLUME = "79_01_01_210527_VFVO60.xml";

/** VZVO40 火山に関するお知らせ */
export const FIXTURE_VZVO40_NOTICE = "42_02_01_071130_VZVO40.xml";

// ── 気象警報・注意報 (VPWW55-61, VPWS50) ──

/** VPWW55 大雨警報・注意報 (島根県) */
export const FIXTURE_VPWW55_OAME = "15_17_01_251222_VPWW55.xml";

/** VPWW56 土砂災害警戒情報 (宗谷地方) */
export const FIXTURE_VPWW56_DOSHA = "15_16_01_241031_VPWW56.xml";

/** VPWW57 高潮警報・注意報 */
export const FIXTURE_VPWW57_KOCHO = "15_16_02_251222_VPWW57.xml";

/** VPWW58 暴風・暴風雪警報・注意報 */
export const FIXTURE_VPWW58_BOFU = "15_16_04_251222_VPWW58.xml";

/** VPWW59 波浪警報・注意報 */
export const FIXTURE_VPWW59_HARO = "15_16_05_241226_VPWW59.xml";

/** VPWW60 大雪警報・注意報 */
export const FIXTURE_VPWW60_OYUKI = "15_16_06_241226_VPWW60.xml";

/** VPWW61 その他気象警報・注意報 */
export const FIXTURE_VPWW61_OTHER = "15_16_07_250825_VPWW61.xml";

/** VPWS50 気象警報・注意報 (全国集約) */
export const FIXTURE_VPWS50_AGGREGATE = "15_18_01_250630_VPWS50.xml";

// ── 竜巻注意情報 (VPHW50, VPHW51) ──

/** VPHW50 竜巻注意情報 (東京都) */
export const FIXTURE_VPHW50_TOKYO = "19_01_01_091210_VPHW50.xml";

/** VPHW50 竜巻注意情報 (別パターン) */
export const FIXTURE_VPHW50_ALT = "19_03_01_130906_VPHW50.xml";

/** VPHW51 竜巻注意情報 (目撃情報付き) */
export const FIXTURE_VPHW51_SIGHTING = "19_04_01_140425_VPHW51.xml";

// ── 気象防災速報 (VPBS50) ──

/** VPBS50 気象防災速報 (線状降水帯発生 - 千葉県) */
export const FIXTURE_VPBS50_LINEAR_OBSERVED = "82_01_01_260324_VPBS50.xml";

/** VPBS50 気象防災速報 (線状降水帯直前予測 - 福岡県) */
export const FIXTURE_VPBS50_LINEAR_PREDICTED = "82_03_01_260324_VPBS50.xml";

/** VPBS50 気象防災速報 (記録的短時間大雨 - 網走) */
export const FIXTURE_VPBS50_RECORD_RAIN = "82_01_02_250630_VPBS50.xml";

/** VPBS50 気象防災速報 (短時間大雪 - 滋賀) */
export const FIXTURE_VPBS50_SHORT_SNOW = "82_01_03_241031_VPBS50.xml";

/** VPBS50 人工: 複数 Condition (先頭=短時間大雪、後続=記録的短時間大雨。先頭単一採用の沈黙バグ回帰用) */
export const FIXTURE_VPBS50_SYNTH_MULTI = "synthetic_VPBS50_multi.xml";

/** VPBS50 人工: 情報タグ由来の未分類 Condition (謎の現象 → unknownConditions 昇格) */
export const FIXTURE_VPBS50_SYNTH_UNKNOWN = "synthetic_VPBS50_unknown-tag.xml";

/** VPBS50 人工: fallback 由来 (その他情報) の未分類 Condition (none 扱い、昇格しない) */
export const FIXTURE_VPBS50_SYNTH_FALLBACK = "synthetic_VPBS50_fallback-tag.xml";

/** VPBS50 人工: Condition 0 件 (Kind から Condition 削除) */
export const FIXTURE_VPBS50_SYNTH_EMPTY = "synthetic_VPBS50_empty.xml";

/** VPBS50 人工: InfoType="取消" (Headline.Information 削除) */
export const FIXTURE_VPBS50_SYNTH_CANCEL = "synthetic_VPBS50_cancel.xml";

// ── 早期天候情報 (VPAW51) ──

/** VPAW51 早期天候情報 (高温 - 東北地方) */
export const FIXTURE_VPAW51_HIGH_TEMP = "72_01_01_190327_VPAW51.xml";

/** VPAW51 早期天候情報 (低温 - 東北地方) */
export const FIXTURE_VPAW51_LOW_TEMP = "72_02_01_190327_VPAW51.xml";

/** VPAW51 早期天候情報 (大雪 - 東北地方) */
export const FIXTURE_VPAW51_HEAVY_SNOW = "72_03_01_190327_VPAW51.xml";

/** VPAW51 早期天候情報 (雪 - 東北地方) */
export const FIXTURE_VPAW51_SNOW = "72_04_01_190327_VPAW51.xml";

/** VPAW51 早期天候情報 (低温と大雪 複合 - 東北地方) */
export const FIXTURE_VPAW51_LOWTEMP_HEAVYSNOW = "72_05_01_190327_VPAW51.xml";

/** VPAW51 早期天候情報 (低温と雪 複合 - 東北地方) */
export const FIXTURE_VPAW51_LOWTEMP_SNOW = "72_06_01_190327_VPAW51.xml";

/** VPAW51 早期天候情報 (高温と大雪 複合 - 東北地方) */
export const FIXTURE_VPAW51_HIGHTEMP_HEAVYSNOW = "72_07_01_190327_VPAW51.xml";

/** VPAW51 早期天候情報 (高温と雪 複合 - 東北地方) */
export const FIXTURE_VPAW51_HIGHTEMP_SNOW = "72_08_01_190327_VPAW51.xml";

// ── VPWP50 気象警報・注意報時系列情報 (実物 4 件) ──

/** VPWP50 気象警報・注意報時系列情報 (長野県 - Pi 実機 2026-06-05 19:55:00 受信) */
export const FIXTURE_VPWP50_NAGANO = "81_09_01_260605_VPWP50.xml";

/** VPWP50 気象警報・注意報時系列情報 (宗谷地方 #1 - 426KB) */
export const FIXTURE_VPWP50_SOYA_01 = "81_01_01_260129_VPWP50.xml";

/** VPWP50 気象警報・注意報時系列情報 (宗谷地方 #2 - 377KB) */
export const FIXTURE_VPWP50_SOYA_02 = "81_01_02_260129_VPWP50.xml";

/** VPWP50 気象警報・注意報時系列情報 (宗谷地方 #3 - 328KB) */
export const FIXTURE_VPWP50_SOYA_03 = "81_01_03_260129_VPWP50.xml";

/** VPWP50 気象警報・注意報時系列情報 (宗谷地方 #4 - 272KB) */
export const FIXTURE_VPWP50_SOYA_04 = "81_01_04_251222_VPWP50.xml";

/** VPWP50 人工: 高 severity (Code 30/41/50 + PeakTime) */
export const FIXTURE_VPWP50_HIGH_SEVERITY =
  "81_02_01_260605_VPWP50_high_severity.xml";

/** VPWP50 人工: 未知 Code 99 と 12 を含む (本体最大 L3、unknownCodes 分離確認) */
export const FIXTURE_VPWP50_UNKNOWN_CODE =
  "81_03_01_260605_VPWP50_unknown_code.xml";

/** VPWP50 人工: InfoType="取消" */
export const FIXTURE_VPWP50_CANCEL = "81_04_01_260605_VPWP50_cancel.xml";

/** VPWP50 人工: Head 欠落 (null fallback 確認) */
export const FIXTURE_VPWP50_HEAD_MISSING =
  "81_05_01_260605_VPWP50_head_missing.xml";

/** VPWP50 人工: CriteriaPeriod + Local + PeakTime 同居 (土砂 L4 + 高潮 Local 分割) */
export const FIXTURE_VPWP50_CRITERIA_PERIOD =
  "81_06_01_260605_VPWP50_criteria_period.xml";

/** VPWP50 人工: 高潮以外の Local (風速 + 視程 + 湿度 lowerIsWorse) */
export const FIXTURE_VPWP50_LOCAL_AREA =
  "81_07_01_260605_VPWP50_local_area.xml";

/** VPWP50 人工: CriteriaPeriod が Property 直下兄弟として出現 + CriteriaClass nest 形 [R1 #1 / R2 Info #3] */
export const FIXTURE_VPWP50_CRITERIA_PROPERTY_SIBLING =
  "81_08_01_260605_VPWP50_criteria_property_sibling.xml";

// ── 全般天候情報 (VPZI50) ──

/** VPZI50 全般天候情報 (東日本・西日本の高温と少雨) */
export const FIXTURE_VPZI50_HOT_DRY = "29_01_01_140129_VPZI50.xml";

// ── 地方天候情報 (VPCI50) ──

/** VPCI50 地方天候情報 (関東甲信地方 梅雨明け — EventDatePart に Date/Normal/LastYear) */
export const FIXTURE_VPCI50_KANTO_TSUYU = "30_01_01_100915_VPCI50.xml";

/** VPCI50 地方天候情報 (東北地方 梅雨明け — EventDatePart 2 件) */
export const FIXTURE_VPCI50_TOHOKU_TSUYU = "30_02_01_100915_VPCI50.xml";

/** VPCI50 地方天候情報 (東北地方 梅雨明け非発表 — EventDatePart に Date 無し、Normal/LastYear のみ) */
export const FIXTURE_VPCI50_TOHOKU_NO_TSUYUAKE = "30_03_01_091210_VPCI50.xml";

/** VPCI50 人工: InfoType="取消" (30_01 ベース、Body 空殻) */
export const FIXTURE_VPCI50_CANCEL = "synthetic_VPCI50_cancel.xml";

// ── 地方気象解説情報 (VPCJ51) ──

/** VPCJ51 地方気象解説情報 (関東甲信地方 強い冬型・大雪) */
export const FIXTURE_VPCJ51_KANTO_SNOW = "84_01_01_260129_VPCJ51.xml";

/** VPCJ51 地方気象解説情報 (東北地方 高温) */
export const FIXTURE_VPCJ51_TOHOKU_HOT = "84_02_01_241226_VPCJ51.xml";

// ── 全般気象解説情報 (VPZJ51) ──

/** VPZJ51 全般気象解説情報 (線状降水帯半日前予測 — 四国・九州北部) */
export const FIXTURE_VPZJ51_SENJOU = "83_01_01_250630_VPZJ51.xml";
/** VPZJ51 全般気象解説情報 (線状降水帯半日前予測 — 12 県) */
export const FIXTURE_VPZJ51_SENJOU_2 = "83_02_01_260324_VPZJ51.xml";
/** VPZJ51 全般気象解説情報 (台風第10号 — 風/雨/波 定量予想 + 台風コード) */
export const FIXTURE_VPZJ51_TYPHOON = "83_02_02_250630_VPZJ51.xml";

// ── 府県気象解説情報 (VPFJ51) ──

/** VPFJ51 府県気象解説情報 (東京都 台風) */
export const FIXTURE_VPFJ51_KANTO = "85_01_01_250630_VPFJ51.xml";

/** VPFJ51 府県気象解説情報 (福井県 大雪初報) */
export const FIXTURE_VPFJ51_FUKUI_SNOW_INITIAL = "85(82)_02_01_250630_VPFJ51.xml";

/** VPFJ51 府県気象解説情報 (福井県 大雪追加報) */
export const FIXTURE_VPFJ51_FUKUI_SNOW_UPDATE = "85(82)_02_04_260326_VPFJ51.xml";

/** VPFJ51 府県気象解説情報 (福井県 大雪続報) */
export const FIXTURE_VPFJ51_FUKUI_SNOW_CONTINUE = "85(82)_02_07_260326_VPFJ51.xml";

// ── 気象解説情報（潮位） (VMCJ53/54/55) ──

/** VMCJ53 全般気象解説情報（潮位） (大潮 - 全国) */
export const FIXTURE_VMCJ53_OSHIO = "87_01_01_250630_VMCJ53.xml";

/** VMCJ54 地方気象解説情報（潮位） (大潮 - 九州北部地方) */
export const FIXTURE_VMCJ54_OSHIO = "88_01_01_250630_VMCJ54.xml";

/** VMCJ55 府県気象解説情報（潮位） (副振動 - 胆振・日高地方、TidalLevelPart 実況+予想) */
export const FIXTURE_VMCJ55_FUKUSHINDO = "89_01_01_250630_VMCJ55.xml";

/** VMCJ55 府県気象解説情報（潮位） (大潮 - 千葉県) */
export const FIXTURE_VMCJ55_OSHIO_CHIBA = "89_02_01_250630_VMCJ55.xml";

// ── 熱中症警戒アラート (VPFT50) ──

/** VPFT50 熱中症警戒アラート (埼玉県 当日5時発表 第2号) */
export const FIXTURE_VPFT50_SAITAMA = "57_03_01_240401_VPFT50.xml";

/** VPFT50 人工: InfoType="取消" (Comment 空殻) */
export const FIXTURE_VPFT50_CANCEL = "synthetic_VPFT50_cancel.xml";

/** VPFT50 人工: Head.Title 題名昇格 (frame critical フェイルセーフ確認用) */
export const FIXTURE_VPFT50_TITLE_ESCALATION = "synthetic_VPFT50_title_escalation.xml";

/** VPFT50 人工: 発表のまま Body 空殻 (Notice/Comment とも空) */
export const FIXTURE_VPFT50_NO_BODY = "synthetic_VPFT50_no_body.xml";

// ── 台風解析・予報情報 (VPTW60 / VPTW61 / VPTW62) ──

/** VPTW60 台風解析・予報情報（５日予報）（Ｈ３０） 2020年 台風第10号 */
export const FIXTURE_VPTW60_2020 = "10_05_01_200826_VPTW60.xml";

/** VPTW60 台風解析・予報情報（５日予報）（Ｈ３０） 2017年 台風第18号 (TALIM) */
export const FIXTURE_VPTW60_2017 = "10_04_03_170913_VPTW60.xml";

/** VPTW61 台風解析・予報情報（７日予報） */
export const FIXTURE_VPTW61 = "10_05_05_200826_VPTW61.xml";

/** VPTW62 台風解析・予報情報（５日予報・傾向） */
export const FIXTURE_VPTW62 = "10_05_06_200826_VPTW62.xml";

/** VPTW60 人工: InfoType="取消" (10_05_01 ベース) */
export const FIXTURE_VPTW60_CANCEL = "synthetic_VPTW60_cancel.xml";

// ── 台風の暴風域に入る確率 (VPTA50) ──

/** DAMREY (TC2001) 直撃級 — max確率 100%、≥50%府県:21 */
export const FIXTURE_VPTA50_DAMREY = "76_01_01_200630_VPTA50.xml";

/** JANGMI (TC2606, Serial 41) 接近段階 — max 100%、≥50%府県:13 */
export const FIXTURE_VPTA50_JANGMI_APPROACH = "76_01_02_260531_VPTA50.xml";

/** JANGMI (TC2606, Serial 87) 暴風域消滅 — 全16,875値ゼロ */
export const FIXTURE_VPTA50_JANGMI_GONE = "76_01_03_260602_VPTA50.xml";

// ── 指定河川洪水予報 (VXKO50) ──

export const FIXTURE_VXKO50_16_01_01 = "16_01_01_220728_VXKO50.xml";
export const FIXTURE_VXKO50_16_02_01 = "16_02_01_220728_VXKO50.xml";
export const FIXTURE_VXKO50_16_02_02 = "16_02_02_220728_VXKO50.xml";
export const FIXTURE_VXKO50_16_03_01 = "16_03_01_220728_VXKO50.xml";
export const FIXTURE_VXKO50_16_04_01 = "16_04_01_220728_VXKO50.xml";
export const FIXTURE_VXKO50_16_05_01 = "16_05_01_210630_VXKO50.xml";
export const FIXTURE_VXKO50_16_06_01 = "16_06_01_220728_VXKO50.xml";
export const FIXTURE_VXKO50_16_07_01 = "16_07_01_220728_VXKO50.xml";
export const FIXTURE_VXKO50_16_10_01 = "16_10_01_260312_VXKO50.xml";
export const FIXTURE_VXKO50_16_11_01 = "16_11_01_260312_VXKO50.xml";
export const FIXTURE_VXKO50_16_11_02 = "16_11_02_260312_VXKO50.xml";
export const FIXTURE_VXKO50_16_12_01 = "16_12_01_260312_VXKO50.xml";
export const FIXTURE_VXKO50_16_14_01 = "16_14_01_251222_VXKO50.xml";

// ── 水位周知河川に関する情報 (VXSU50) ──

export const FIXTURE_VXSU50_91_01_01 = "91_01_01_241031_VXSU50.xml";

// ── synthetic 洪水水位系 (Task 7 で追加) ──

export const FIXTURE_SYNTHETIC_VXKO50_CANCEL = "synthetic_VXKO50_cancel.xml";
export const FIXTURE_SYNTHETIC_VXKO50_CORRECTION = "synthetic_VXKO50_correction.xml";
export const FIXTURE_SYNTHETIC_VXKO50_CODE31 = "synthetic_VXKO50_code31.xml";
export const FIXTURE_SYNTHETIC_VXSU50_CANCEL = "synthetic_VXSU50_cancel.xml";

/** フィクスチャXMLを読み込む (fixtures/ → selected_xml/ フォールバック) */
export function readFixture(filename: string): string {
  const primaryPath = path.join(FIXTURES_DIR, filename);
  if (fs.existsSync(primaryPath)) {
    return fs.readFileSync(primaryPath, "utf-8");
  }
  const fallbackPath = path.join(FIXTURES_DIR, "selected_xml", filename);
  return fs.readFileSync(fallbackPath, "utf-8");
}

/** XMLをgzip+base64エンコードする */
export function encodeXml(xml: string): string {
  const compressed = zlib.gzipSync(Buffer.from(xml, "utf-8"));
  return compressed.toString("base64");
}

function nullableXmlText(text: string): string | null {
  return text === "" ? null : text;
}

function fixtureEnvelope(xml: string, type: string): Pick<
  WsDataMessage,
  "head" | "xmlReport"
> {
  const { control, head } = parseTelegramEnvelopeXml(xml);
  const status = control.status;
  const publishingOffice = control.publishingOffice;
  const controlDateTime = control.dateTime;
  return {
    head: {
      type,
      author: publishingOffice,
      time: controlDateTime,
      test: deriveIsTest({ headTest: null, controlStatus: status }),
      xml: true,
    },
    xmlReport: {
      control: {
        title: control.title,
        dateTime: controlDateTime,
        status,
        editorialOffice: control.editorialOffice,
        publishingOffice,
      },
      head: {
        title: head.title,
        reportDateTime: head.reportDateTime,
        targetDateTime: head.targetDateTime,
        eventId: nullableXmlText(head.eventId),
        serial: nullableXmlText(head.serial),
        infoType: head.infoType,
        infoKind: head.infoKind,
        infoKindVersion: head.infoKindVersion,
        headline: nullableXmlText(head.headline),
      },
    },
  };
}

/**
 * フィクスチャXMLから WsDataMessage を構築する。
 * overrides で任意のフィールドを上書き可能。
 * opts.publishingOffice は envelope (xmlReport.control) 側の発表官署を差し替える。
 * parser は envelope を XML 本体の Control.PublishingOffice より優先するため、
 * 官署別ストリームを明示的に検証するテストだけがここを変える。
 * 既定の Control／Head metadata は実 XML から構成する。
 */
export function createMockWsDataMessage(
  fixtureName: string,
  overrides?: Partial<WsDataMessage>,
  opts: { publishingOffice?: string } = {},
): WsDataMessage {
  const xml = readFixture(fixtureName);
  const body = encodeXml(xml);

  // ファイル名から type を推定
  const typeMatch = fixtureName.match(/(V[TXYZ]SE\d+|VFVO\d+|VFSVii|VZVO\d+|VPWW\d+|VPWS\d+|VPHW\d+|VPBS\d+|VPAW\d+|VPWP\d+|VPZI\d+|VPCI\d+|VPCJ\d+|VPZJ\d+|VPFJ\d+|VMCJ\d+|VPFT\d+|VPTW\d+|VPTA\d+|VXKO\d+|VXSU\d+)/);
  const type = typeMatch ? typeMatch[1] : "VXSE53";
  const classification = type === "VXSE43"
    ? "eew.warning"
    : (type === "VXSE44" || type === "VXSE45")
      ? "eew.forecast"
      : (type.startsWith("VFVO") || type.startsWith("VFSV") || type === "VZVO40")
        ? "telegram.volcano"
        : (type.startsWith("VPWW") || type.startsWith("VPWS") || type.startsWith("VPHW") || type.startsWith("VPBS") || type.startsWith("VPAW") || type.startsWith("VPWP") || type.startsWith("VPZI") || type.startsWith("VPCI") || type.startsWith("VPCJ") || type.startsWith("VPZJ") || type.startsWith("VPFJ") || type.startsWith("VMCJ") || type.startsWith("VPFT") || type.startsWith("VPTW") || type.startsWith("VPTA") || type.startsWith("VXKO") || type.startsWith("VXSU"))
          ? "telegram.weather"
          : "telegram.earthquake";
  const envelope = fixtureEnvelope(xml, type);

  const base: WsDataMessage = {
    type: "data",
    version: "2.0",
    classification,
    id: "test-id-001",
    passing: [{ name: "test", time: new Date().toISOString() }],
    head: envelope.head,
    xmlReport: envelope.xmlReport == null
      ? undefined
      : {
          ...envelope.xmlReport,
          control: {
            ...envelope.xmlReport.control,
            publishingOffice:
              opts.publishingOffice ?? envelope.xmlReport.control.publishingOffice,
          },
        },
    format: "xml",
    compression: "gzip",
    encoding: "base64",
    body,
  };

  return normalizeTelegramMessage({ ...base, ...overrides } as WsDataMessage).message;
}

/**
 * 生 XML 文字列から WsDataMessage を構築する (synthetic-XML テスト用)。
 * createMockWsDataMessage がフィクスチャ名を受け取るのに対し、こちらは XML 本体を直接受け取る。
 * VPTA50 等の synthetic variant を `msg as any` ではなく型付きで渡すためのヘルパー。
 */
export function createMockWsDataMessageFromXml(
  xml: string,
  type: string,
  overrides: { test?: boolean; publishingOffice?: string } = {},
): WsDataMessage {
  const body = encodeXml(xml);
  const classification = type === "VXSE43"
    ? "eew.warning"
    : (type === "VXSE44" || type === "VXSE45")
      ? "eew.forecast"
      : (type.startsWith("VFVO") || type.startsWith("VFSV") || type === "VZVO40")
        ? "telegram.volcano"
        : (type.startsWith("VPWW") || type.startsWith("VPWS") || type.startsWith("VPHW") || type.startsWith("VPBS") || type.startsWith("VPAW") || type.startsWith("VPWP") || type.startsWith("VPZI") || type.startsWith("VPCI") || type.startsWith("VPCJ") || type.startsWith("VPZJ") || type.startsWith("VPFJ") || type.startsWith("VMCJ") || type.startsWith("VPFT") || type.startsWith("VPTW") || type.startsWith("VPTA") || type.startsWith("VXKO") || type.startsWith("VXSU"))
          ? "telegram.weather"
          : "telegram.earthquake";
  const envelope = fixtureEnvelope(xml, type);

  const message: WsDataMessage = {
    type: "data",
    version: "2.0",
    classification,
    id: "test-id-001",
    passing: [{ name: "test", time: new Date().toISOString() }],
    head: {
      ...envelope.head,
      test: overrides.test ?? envelope.head.test,
    },
    xmlReport: envelope.xmlReport == null
      ? undefined
      : {
          ...envelope.xmlReport,
          control: {
            ...envelope.xmlReport.control,
            publishingOffice:
              overrides.publishingOffice ?? envelope.xmlReport.control.publishingOffice,
          },
        },
    format: "xml",
    compression: "gzip",
    encoding: "base64",
    body,
  };
  return normalizeTelegramMessage(message).message;
}

/**
 * Codex R1 #2 ガードレール用。
 * base info (長野 fixture など) の全 area に大雨警報 (Code 30) を追加し、
 * 全域警報シナリオを再現する。`pushFrameTable` の幅検査・fallback が正しく
 * トリガされるかを検証する用途。
 */
export function createSyntheticGlobalWarningInfo(
  base: ParsedWeatherWarningTimeseriesInfo,
): ParsedWeatherWarningTimeseriesInfo {
  const synthesizedAreas = base.areas.map((area) => ({
    ...area,
    kinds: {
      ...area.kinds,
      1: [
        {
          type: "大雨",
          partKind: "Significancy" as const,
          significancyWorst: {
            base: {
              info: { code: "30", compact: "大雨警報", label: "大雨警報", known: true, severity: "warning" } as never,
              timeRef: "1",
              timeWindow: { startName: "朝", endName: "夕方", count: 4, contiguous: true },
            },
            locals: [],
          },
        },
        ...area.kinds[1],
      ],
    },
  }));
  return { ...base, areas: synthesizedAreas };
}
