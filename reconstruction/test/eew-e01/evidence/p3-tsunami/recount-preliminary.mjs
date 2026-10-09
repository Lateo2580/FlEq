// Q-C6-IMPL-AMEND (11)・(12): 予備の raw（窓ごとの run-record.json）から、母集団ごとの stopCondition の入力（成立数・試行数・1 試行の所要）を数え直す。
//   node reconstruction/test/eew-e01/evidence/p3-tsunami/recount-preliminary.mjs <source の名前>=<窓の dir> ...
// 数える試行は正式（phase formal）のうち、parse 直後・encode 直後では較正の予測が初めて入った試行（trigger.predictedParseDelayMs か
// predictedEncodeDelayMs が null でない最初の attemptIndex）とそれ以後（予測の無い間の試行は送り方が違う）。fixedBacklog・eewTogether は正式の全部。
// 1 試行の所要は run-record の durationMs ÷ attempts（予備の集計の msPerAttempt と同じ）。
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

const inputs = process.argv.slice(2).map((arg) => {
  const at = arg.indexOf("=");
  const [source, dir] = [arg.slice(0, at), arg.slice(at + 1)];
  const record = JSON.parse(readFileSync(join(dir, "run-record.json"), "utf8"));
  const predicted = (t) => t.trigger?.predictedParseDelayMs ?? t.trigger?.predictedEncodeDelayMs ?? null;
  const calibrated = /maxVpws50ParseStarted|maxWeatherCheckpointEncodeStarted/.test(record.population);
  const first = calibrated ? record.trials.find((t) => predicted(t) != null)?.attemptIndex ?? null : null;
  const counted = record.trials.filter((t) => t.phase === "formal" && (!calibrated || (first != null && t.attemptIndex >= first)));
  return { population: record.population, source, window: basename(dir), firstPredictedAttempt: first, trials: counted.length,
    successes: counted.filter((t) => t.establishment?.established === true).length,
    msPerAttempt: Math.round((record.durationMs / record.attempts) * 1000) / 1000 };
});
process.stdout.write(`${JSON.stringify({ definition: "正式の試行のうち、parse 直後・encode 直後は較正の予測が初めて入った試行（attemptIndex）以後", inputs }, null, 2)}\n`);
