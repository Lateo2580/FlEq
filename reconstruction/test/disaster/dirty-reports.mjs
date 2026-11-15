// P3-FINAL-GATE-001 発注 3a: 12 unit を同時に dirty にする報。pi-measure.mjs（--dirty all）と window.test.ts の T06 が同じ報を使うための 1 か所。
// fixture は owner-harness.ts の unitBodies と同じ 12 本（node だけで動く pi-measure は TS の owner-harness を import できないので名前を写す）。
import { fixtureText, shiftTimestamps } from "../eew-e01/frames.mjs";

const REPORTS = [["U-E", "VXSE43", "37_01_01_240613_VXSE43"], ["U-W", "VPWW57", "15_16_02_251222_VPWW57"],
  ["U-F", "VPWP50", "81_02_01_260605_VPWP50_high_severity"], ["U-T", "VTSE41", "32-39_11_02_250206_VTSE41"], ["U-Q", "VXSE53", "32-35_04_04_240613_VXSE53"],
  ["U-N", "VYSE50", "selected_xml/74_01_04_200512_VYSE50"], ["U-V", "VFVO50", "45_01_01_200522_VFVO50"], ["U-L", "VPWW56", "15_16_01_241031_VPWW56"],
  ["U-R", "VXKO50", "16_02_01_220728_VXKO50"], ["U-B", "VPBS50", "phase6b_VPBS50_KJPTK202608221709_202608221709"], ["U-M", "VPHW50", "19_03_01_130906_VPHW50"],
  ["U-Y", "VPTW60", "10_05_01_200826_VPTW60"]];
// 同じ EventID の報は前の報の続報になり採られないことがあるので、U-E・U-T・U-Q は呼ぶたびに替える（stem は 12 桁の数字、末尾 2 桁を unit で足す）。
const NEW_EVENT = { "U-E": "01", "U-T": "02", "U-Q": "03" };

// 全時刻を wallMs へ平行移動した 12 本（frames.mjs の shiftTimestamps と同じ規則、報の時刻 = wallMs）。
export function dirtyReports(wallMs, stem) {
  if (!/^\d{12}$/.test(stem)) throw new Error(`dirtyReports: stem must be 12 digits (${stem})`);
  return REPORTS.map(([unit, headType, fixture]) => {
    const text = fixtureText(fixture).toString("utf8");
    let xml = shiftTimestamps(text, wallMs - Date.parse(/<ReportDateTime>([^<]+)</.exec(text)[1]));
    if (NEW_EVENT[unit] != null) xml = xml.replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${stem}${NEW_EVENT[unit]}</EventID>`);
    return { unit, headType, xml };
  });
}
