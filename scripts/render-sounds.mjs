// FlEq 通知音レンダラ（依存なし・Node 単体）。規則は docs/specs/sound-design-system.md
// usage: node scripts/render-sounds.mjs [outDir=assets/sounds]
// 5 段階（critical / warning / normal / info / cancel）を同じ音色で WAV に書き出す。
// 重大度は音色ではなく「回数・高さ・長さ」で表す。単音か和音のみ。

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const SR = 44100;
const NOTE = { A4: 440.0, C5: 523.25, Eb5: 622.25, E5: 659.25, G5: 783.99, A5: 880.0, C6: 1046.5, Eb6: 1244.5, E6: 1318.5, G6: 1568.0 };

// ── 音色（全 level 共通）──
// サイン波に第 2 倍音を少し足し、立ち上がり 5ms・指数減衰。
function tone(freqs, durSec, gain, decay = 6) {
  const n = Math.round(SR * durSec);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // 立ち上がり 5ms・指数減衰・最後の 30ms はリリースでゼロへ（ぶつ切りのクリック防止）
    const release = Math.min(1, (durSec - t) / 0.03);
    const env = Math.min(1, t / 0.005) * Math.exp(-decay * t) * release;
    let s = 0;
    for (const f of freqs) s += Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(2 * Math.PI * 2 * f * t);
    out[i] = (s / freqs.length) * env * gain;
  }
  return out;
}

// ── モチーフ定義（データ）──
// decay: 減衰の速さ（全打音共通、残響が揃う）、hits: { at: 発音時刻(秒), notes, gain? }
// 各打音は同じ減衰で鳴り切り（振幅 1% まで）、重ねて合成する。
const MOTIFS = {
  info:     { decay: 9,  hits: [{ at: 0, notes: ["A4"], gain: 0.5 }] },
  normal:   { decay: 9,  hits: [{ at: 0, notes: ["C5"], gain: 0.8 }] },
  warning:  { decay: 9,  hits: [{ at: 0, notes: ["C5", "Eb5", "G5"], gain: 0.9 }, { at: 0.12, notes: ["C5", "Eb5", "G5"], gain: 0.9 }] },
  critical: { decay: 14, hits: [
    { at: 0.00, notes: ["C6", "Eb6", "G6"], gain: 1.0 },
    { at: 0.14, notes: ["C6", "Eb6", "G6"], gain: 1.0 },
    { at: 0.28, notes: ["C6", "Eb6", "G6"], gain: 1.0 },
  ] },
  cancel:   { decay: 8,  hits: [{ at: 0, notes: ["G5"], gain: 0.6 }, { at: 0.30, notes: ["C5"], gain: 0.6 }] },
};

function render(motif) {
  const ring = Math.log(100) / motif.decay + 0.03; // 1% まで減衰する時間＋リリース
  const total = Math.max(...motif.hits.map((h) => h.at)) + ring + 0.02;
  const buf = new Float64Array(Math.round(SR * total));
  for (const h of motif.hits) {
    const part = tone(h.notes.map((n) => NOTE[n]), ring, h.gain, motif.decay);
    const off = Math.round(SR * h.at);
    for (let i = 0; i < part.length; i++) buf[off + i] += part[i];
  }
  return buf;
}

// ピーク正規化（-3 dBFS）。gain は level 間の相対差として残す。
function toWav(samples, peakDb = -3) {
  const peak = 1; // 呼び出し側で全 level 共通のピークに揃えてある
  const target = Math.pow(10, peakDb / 20);
  const pcm = Buffer.alloc(44 + samples.length * 2);
  pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + samples.length * 2, 4); pcm.write("WAVE", 8);
  pcm.write("fmt ", 12); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(SR, 24); pcm.writeUInt32LE(SR * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34);
  pcm.write("data", 36); pcm.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(Math.round((samples[i] / peak) * target * 32767), 44 + i * 2);
  return pcm;
}

const outDir = process.argv[2] ?? "assets/sounds";
mkdirSync(outDir, { recursive: true });
// level 間の相対音量を保つため、全体で 1 つのピーク基準を使う
const rendered = Object.fromEntries(Object.entries(MOTIFS).map(([k, m]) => [k, render(m)]));
const globalPeak = Math.max(...Object.values(rendered).map((s) => Math.max(...s.map(Math.abs))));
for (const [level, samples] of Object.entries(rendered)) {
  const scaled = samples.map((v) => v / globalPeak);
  writeFileSync(join(outDir, `${level}.wav`), toWav(scaled, -3));
  console.log(`${level}.wav ${(samples.length / SR).toFixed(2)}s`);
}
