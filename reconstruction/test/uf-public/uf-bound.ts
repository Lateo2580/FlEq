import type { WeatherTimeseriesSubject } from "../../contracts/p2-weather-timeseries-unit.types";

const utf8 = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
// P3-UFP-RES-01: b(k) <= 1,119 + 6J(office) + 2J(inputId) + 3J(report) + 3J(serial) + 4J(infoType) + sum(J(area) + 3).
const J = (text: string) => utf8(text) - 2;
function keyBound(item: WeatherTimeseriesSubject): number {
  const source = item.source!, office = item.subject.slice(`${item.operation}/VPWP50/`.length);
  const areas = [...new Set(item.periods.map((row) => item.strings[item.areas[row[1]].code]).filter((code) => code !== ""))];
  return 1_119 + 6 * J(office) + 2 * J(source.inputId) + 3 * J(source.reportDateTimeRaw) + 3 * J(source.serialRaw) + 4 * J(source.infoTypeRaw)
    + areas.reduce((sum, code) => sum + J(code) + 3, 0);
}

export { keyBound };
