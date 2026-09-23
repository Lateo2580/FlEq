// 根音表 v1。旧築 scripts/render-sounds.mjs の tone/render/WAV 式だけを移植。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sampleRate = 44100;
const roots = { weather: 261.63, volcano: 392, "earthquake-eew": 523.25, tsunami: 698.46 };
const levels = ["info", "normal", "warning", "critical", "cancel"];
const frequency = (root, semitone) => root * 2 ** (semitone / 12);

function render(root, domain, level) {
  const minor = domain === "tsunami" ? [0, 1, 6] : [0, 3, 7];
  const hits = level === "info" ? [[0, [-3], 0.5]]
    : level === "normal" ? [[0, [0], 0.8]]
      : level === "warning" ? [[0, minor, 0.9], [0.12, minor, 0.9]]
        : level === "critical" ? [0, 0.14, 0.28].map((at) => [at, minor.map((n) => n + 12), 1])
          : [[0, [7], 0.6], [0.30, [0], 0.6]];
  const decay = level === "critical" ? 14 : level === "cancel" ? 8 : 9;
  const ring = Math.log(100) / decay + 0.03;
  const total = hits.at(-1)[0] + ring + 0.02;
  const samples = new Float64Array(Math.round(sampleRate * total));
  for (const [at, notes, gain] of hits) {
    const offset = Math.round(sampleRate * at);
    for (let i = 0; i < Math.round(sampleRate * ring); i++) {
      const t = i / sampleRate;
      const env = Math.min(1, t / 0.005) * Math.exp(-decay * t) * Math.min(1, (ring - t) / 0.03);
      let value = 0;
      for (const note of notes) {
        const f = frequency(root, note);
        value += Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t);
      }
      samples[offset + i] += value / notes.length * env * gain;
    }
  }
  return samples;
}

function wav(samples, peak) {
  const data = Buffer.alloc(44 + samples.length * 2);
  data.write("RIFF", 0); data.writeUInt32LE(data.length - 8, 4); data.write("WAVE", 8);
  data.write("fmt ", 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(sampleRate, 24); data.writeUInt32LE(sampleRate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(samples.length * 2, 40);
  const scale = 32767 * 10 ** (-3 / 20) / peak;
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(samples[i] * scale), 44 + i * 2);
  return data;
}

const output = process.argv[2] ?? "reconstruction/assets/sounds";
const rendered = Object.entries(roots).flatMap(([domain, root]) => levels.map((level) =>
  [join(output, `${domain}-${level}.wav`), render(root, domain, level)]));
let peak = 0;
for (const [, samples] of rendered) for (const value of samples) peak = Math.max(peak, Math.abs(value));
mkdirSync(output, { recursive: true });
for (const [path, samples] of rendered) writeFileSync(path, wav(samples, peak));
