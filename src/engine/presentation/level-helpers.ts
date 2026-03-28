import type { FrameLevel } from "../../ui/formatter";
import type { SoundLevel } from "../notification/sound-player";
import type {
  ParsedEewInfo,
  ParsedEarthquakeInfo,
  ParsedSeismicTextInfo,
  ParsedLgObservationInfo,
  ParsedTsunamiInfo,
  ParsedNankaiTroughInfo,
} from "../../types";
import { intensityToRank } from "../../utils/intensity";

// ── frameLevel ──

export function eewFrameLevel(info: ParsedEewInfo): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  if (info.isWarning) return "critical";
  return "warning";
}

export function earthquakeFrameLevel(info: ParsedEarthquakeInfo): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  if (info.intensity) {
    const rank = intensityToRank(info.intensity.maxInt);
    if (rank >= 7) return "critical";
    if (rank >= 4) return "warning";
  }
  return "normal";
}

export function tsunamiFrameLevel(info: ParsedTsunamiInfo): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  const kinds = (info.forecast || []).map((f) => f.kind);
  if (kinds.some((kind) => kind.includes("大津波警報"))) return "critical";
  if (kinds.some((kind) => kind.includes("津波警報"))) return "warning";
  return "normal";
}

export function seismicTextFrameLevel(info: ParsedSeismicTextInfo): FrameLevel {
  return info.infoType === "取消" ? "cancel" : "info";
}

export function nankaiTroughFrameLevel(
  info: ParsedNankaiTroughInfo,
): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  if (!info.infoSerial) return "warning";
  const code = info.infoSerial.code;
  if (code === "120") return "critical";
  if (code === "130") return "warning";
  if (code === "111" || code === "112" || code === "113") return "warning";
  if (code === "210" || code === "219") return "warning";
  if (code === "190" || code === "200") return "info";
  return "warning";
}

export function lgObservationFrameLevel(
  info: ParsedLgObservationInfo,
): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  if (info.maxLgInt) {
    const num = Number(info.maxLgInt);
    if (!Number.isNaN(num)) {
      if (num >= 4) return "critical";
      if (num >= 3) return "warning";
      if (num >= 2) return "normal";
    }
  }
  return "info";
}

// ── soundLevel ──

export function eewSoundLevel(info: ParsedEewInfo): SoundLevel {
  return info.isWarning ? "critical" : "warning";
}

export function earthquakeSoundLevel(info: ParsedEarthquakeInfo): SoundLevel {
  if (!info.intensity) return "normal";
  if (intensityToRank(info.intensity.maxInt) >= 4) return "warning";
  return "normal";
}

export function tsunamiSoundLevel(info: ParsedTsunamiInfo): SoundLevel {
  if (!info.forecast || info.forecast.length === 0) return "normal";
  const kinds = info.forecast.map((f) => f.kind);
  if (kinds.some((k) => k.includes("津波") && !k.includes("解除")))
    return "critical";
  if (kinds.some((k) => k.includes("解除"))) return "warning";
  return "normal";
}

export function seismicTextSoundLevel(
  _info: ParsedSeismicTextInfo,
): SoundLevel {
  return "info";
}

export function nankaiTroughSoundLevel(
  info: ParsedNankaiTroughInfo,
): SoundLevel {
  return info.infoSerial?.code === "120" ? "critical" : "warning";
}

export function lgObservationSoundLevel(
  info: ParsedLgObservationInfo,
): SoundLevel {
  if (!info.maxLgInt) return "normal";
  if (info.maxLgInt === "4" || info.maxLgInt === "3") return "critical";
  if (info.maxLgInt === "2" || info.maxLgInt === "1") return "warning";
  return "normal";
}
