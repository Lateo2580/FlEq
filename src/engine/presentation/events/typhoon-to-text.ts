import type {
  ParsedTyphoonAnalysis,
  ParsedTyphoonProbability,
  TyphoonCenter,
  TyphoonFrame,
  TyphoonName,
  TyphoonWind,
  TyphoonWindArea,
} from "../../../types";
import { aggregateByPrefecture } from "../typhoon-probability-aggregate";

// VPTW/VPTA は原文の自由文本文を持たない (実 XML 24 件で <Comment>・非空 <Text> ゼロ)。
// このモジュールは「原文全文」ではなく構造化電文を表示用に決定的に長文化する。
// 通知・統計の真実源は構造化データのままで、ここはテロップ表示専用の文章合成 (spec §2-2)。
// 走行テロップは体言止め列挙だと「表」に見えるため、述語単位で組む文章体を出す
// (座標・中心気圧・方位別半径などの数値列挙は出さず、行動判断に効く要素だけ文にする)。

function typhoonNameLabel(name: TyphoonName | null): string | null {
  if (name == null) return null;
  if (name.name != null && name.name !== "") {
    const num = name.number != null && name.number.length >= 2
      ? `台風${name.number.slice(2)}号`
      : null;
    return num != null ? `${name.name}（${num}）` : name.name;
  }
  if (name.remark != null && name.remark !== "") return name.remark;
  return null;
}

/** 階級記号「(TS)」「(TD)」等を落とした基底名詞。category 欠損時は「台風」。 */
function typhoonNoun(f: TyphoonFrame): string {
  const cat = f.typhoonClass.category;
  if (cat == null || cat === "") return "台風";
  return cat.replace(/[（(].*$/, "");
}

/** 実況/推定の主語「非常に強い大型の台風」。強さ・大きさが無ければ基底名詞のみ。 */
function analysisSubject(f: TyphoonFrame): string {
  const noun = typhoonNoun(f);
  const qualifier = [f.typhoonClass.intensity, f.typhoonClass.size]
    .filter((x): x is string => x != null && x !== "")
    .join("");
  return qualifier !== "" ? `${qualifier}の${noun}` : noun;
}

/**
 * 予報の階級を「階級記号なしの主語表現」に整える (analysisSubject と同型: qualifier+の+基底名詞)。
 * 階級情報が皆無なら null。前時点との変化検出もこの剥がした文字列で行う
 * (TS→STS のように記号を剥がすと同一表現になる変化は告知されないが、intensity 変化で伝わる)。
 */
function forecastClassLabel(f: TyphoonFrame): string | null {
  const hasClass = (f.typhoonClass.intensity != null && f.typhoonClass.intensity !== "")
    || (f.typhoonClass.size != null && f.typhoonClass.size !== "")
    || (f.typhoonClass.category != null && f.typhoonClass.category !== "");
  return hasClass ? analysisSubject(f) : null;
}

/**
 * 中心位置の名詞句。地名があれば「〜付近」、無ければ確定座標を「北緯..・東経..付近」に整える。
 * 予報 frame は coordinate=null (location のみ) なので地名側に落ちる。
 */
function centerPosition(c: TyphoonCenter): string | null {
  if (c.location != null && c.location !== "") return `${c.location}付近`;
  if (c.coordinate != null && c.coordinate !== "") {
    return `${c.coordinate.replace("東経", "・東経")}付近`;
  }
  return null;
}

/** 半径 0/欠損の軸しか無い風域は「域なし」扱いにする (condition="なし" → radiusKm=null)。 */
function hasWindArea(area: TyphoonWindArea | null): boolean {
  return area != null && area.axes.some((a) => a.radiusKm != null && a.radiusKm > 0);
}

/** 実況/推定の風速文 (事実形)。最大風速 0/欠損は省略。 */
function analysisWindSentence(w: TyphoonWind | null): string | null {
  if (w == null || w.maxWindMs == null || w.maxWindMs <= 0) return null;
  return w.maxGustMs != null && w.maxGustMs > 0
    ? `最大風速は${w.maxWindMs}m/s、最大瞬間風速は${w.maxGustMs}m/sです。`
    : `最大風速は${w.maxWindMs}m/sです。`;
}

/**
 * 実況/推定 1 frame を文章体 1 行にする。位置・移動・暴風域・風速を「述語単位の文」で足すため、
 * どれが欠けても助詞が破綻しない (座標・中心気圧・方位別半径は出さない、spec §2-2)。
 */
function framePhrase(f: TyphoonFrame): string | null {
  const subject = analysisSubject(f);
  const position = centerPosition(f.center);
  const c = f.center;

  // 移動句 (実況は事実形「進んでいます」)。速度 0/欠損なら方向のみ。
  let move: string | null = null;
  if (c.moveDirection != null && c.moveDirection !== "") {
    move = c.moveSpeedKmh != null && c.moveSpeedKmh > 0
      ? `${c.moveDirection}へ時速${c.moveSpeedKmh}kmで進んでいます`
      : `${c.moveDirection}へ進んでいます`;
  }
  const hasStorm = f.wind != null && hasWindArea(f.wind.stormArea);

  // 暴風域と移動を 1 述語にまとめる (実況は「伴って/伴っています」の事実形)。
  let predicate: string | null;
  if (hasStorm && move != null) predicate = `暴風域を伴って${move}`;
  else if (hasStorm) predicate = "暴風域を伴っています";
  else if (move != null) predicate = move;
  else predicate = null;

  const wind = analysisWindSentence(f.wind);
  // 位置も移動も暴風域も風速も階級も無い frame は行にしない (実況/推定は通常 position を持つ)。
  const hasClass = f.typhoonClass.intensity != null || f.typhoonClass.size != null
    || (f.typhoonClass.category != null && f.typhoonClass.category !== "");
  if (position == null && predicate == null && wind == null && !hasClass) return null;

  let head: string;
  if (position != null) {
    head = predicate != null
      ? `${subject}が${position}にあり、${predicate}。`
      : `${subject}が${position}にあります。`;
  } else {
    head = predicate != null ? `${subject}は${predicate}。` : `${subject}です。`;
  }
  const body = wind != null ? `${head}${wind}` : head;
  const heading = f.label.replace(/\s+/g, "");
  return `【${heading}】${body}`;
}

/** ISO 8601 (ローカル +09:00) から予報時点の「D日H時」を切り出す。TZ ずれ回避のため Date 解析しない。 */
function forecastTimeLabel(iso: string): string | null {
  const m = /-(\d{2})T(\d{2}):/.exec(iso);
  if (m == null) return null;
  return `${Number(m[1])}日${m[2]}時`;
}

/** 予報の述語を連用中止でつなぐための断片。mid=後続あり (連用形)、end=末尾 (「見込みです」)。 */
interface ForecastSegment {
  mid: string;
  end: string;
}

/** 予報の移動句。地名があれば「〜を」で前置。移動が無く位置だけあれば「〜にある」で拾う。 */
function forecastMoveSegment(c: TyphoonCenter, position: string | null): ForecastSegment | null {
  if (c.moveDirection != null && c.moveDirection !== "") {
    const place = position != null ? `${position}を` : "";
    const speed = c.moveSpeedKmh != null && c.moveSpeedKmh > 0 ? `時速${c.moveSpeedKmh}kmで` : "";
    return {
      mid: `${place}${c.moveDirection}へ${speed}進み`,
      end: `${place}${c.moveDirection}へ${speed}進む見込みです`,
    };
  }
  if (position != null) {
    return { mid: `${position}にあり`, end: `${position}にある見込みです` };
  }
  return null;
}

/** 予報の風速句。最大風速 0/欠損は省略。 */
function forecastWindSegment(w: TyphoonWind | null): ForecastSegment | null {
  if (w == null || w.maxWindMs == null || w.maxWindMs <= 0) return null;
  const core = w.maxGustMs != null && w.maxGustMs > 0
    ? `最大風速は${w.maxWindMs}m/s、最大瞬間風速は${w.maxGustMs}m/s`
    : `最大風速は${w.maxWindMs}m/s`;
  return { mid: `${core}で`, end: `${core}の見込みです` };
}

/**
 * 予報の警戒区域句。数値半径をやめ「〜を伴う見込み」の区域名に簡略化する。
 * 予報は暴風警戒域が主。念のため暴風域・強風域も同順で拾い、最も強い 1 区域だけ出す。
 */
function forecastAreaSegment(w: TyphoonWind | null): ForecastSegment | null {
  if (w == null) return null;
  const label = hasWindArea(w.stormWarningArea) ? "暴風警戒域"
    : hasWindArea(w.stormArea) ? "暴風域"
    : hasWindArea(w.galeArea) ? "強風域" : null;
  if (label == null) return null;
  return { mid: `${label}を伴い`, end: `${label}を伴う見込みです` };
}

/**
 * 予報 frame 群を【予報】1 見出しの文章体 1 行に畳む (§2b)。予報時点ごとに見出しを立てず改行も挟まないため、
 * 走行表示で「表」に見えず流れる文として読める。各予報時点は句点で区切り、時点内は述語を連用中止で繋ぐ。
 * 全予報時点を落とさず、階級 (持続情報) は前時点から変化したときだけ主語に出して定型連呼を畳む。
 * 実況の事実形「伴う」に対し、予報は予測なので末尾を必ず「見込みです」にする。
 * initialPrevClass は実況/推定の階級ラベル。先頭予報が「階級のみ・実況と同一」のときに
 * 変化なしと判定させ、誤って「〜に変わる見込み」と断定するのを防ぐ (実況が無い電文では null)。
 */
function forecastNarrative(frames: TyphoonFrame[], initialPrevClass: string | null): string | null {
  const sentences: string[] = [];
  let prevClass: string | null = initialPrevClass;
  for (const f of frames) {
    const timeLabel = forecastTimeLabel(f.validTime) ?? f.label.replace(/\s+/g, "");
    const cls = forecastClassLabel(f);
    const changed = cls != null && cls !== prevClass;
    if (cls != null) prevClass = cls;
    // 変化時のみ階級 (記号なし) を主語に、それ以外は「台風」で連呼を畳む。
    const subject = changed && cls != null ? cls : "台風";
    const position = centerPosition(f.center);

    const segments: ForecastSegment[] = [];
    const move = forecastMoveSegment(f.center, position);
    if (move != null) segments.push(move);
    const wind = forecastWindSegment(f.wind);
    if (wind != null) segments.push(wind);
    const area = forecastAreaSegment(f.wind);
    if (area != null) segments.push(area);
    if (segments.length === 0) {
      // 位置・移動・風速・風域が全欠損の簡略時点。階級変化があれば「〜に変わる見込み」で残し、
      // 階級変化も述語も無い時点 (時刻の見出しだけ) は従来どおり落とす。
      if (changed && cls != null) sentences.push(`${timeLabel}には、${cls}に変わる見込みです`);
      continue;
    }

    const parts = segments.map((s, i) => (i === segments.length - 1 ? s.end : s.mid));
    sentences.push(`${timeLabel}には、${subject}は${parts.join("、")}`);
  }
  if (sentences.length === 0) return null;
  return `【予報】${sentences.join("。")}。`;
}

/**
 * 台風解析・予報情報 (VPTW60/61/62) を構造化 frames[] から長文化する。
 * 実況・推定は 1 frame = 1 行、予報は文章体 1 行に畳む (§2b)。
 * 通常発表で非 null、取消・全 frame 空のとき null (→ tickerSentence フォールバック)。
 */
export function typhoonAnalysisToText(info: ParsedTyphoonAnalysis): string | null {
  if (info.infoType === "取消") return null;
  const lines: string[] = [];
  const forecastFrames: TyphoonFrame[] = [];
  // 予報の階級変化検出の起点。実況/推定の最後の階級を初期 prevClass にする。
  let baseClass: string | null = null;
  for (const f of info.frames) {
    if (f.kind === "予報") {
      forecastFrames.push(f);
      continue;
    }
    baseClass = forecastClassLabel(f) ?? baseClass;
    const phrase = framePhrase(f);
    if (phrase != null) lines.push(phrase);
  }
  const narrative = forecastNarrative(forecastFrames, baseClass);
  if (narrative != null) lines.push(narrative);
  if (lines.length === 0) return null;
  const nameLabel = typhoonNameLabel(info.name);
  const head = nameLabel != null ? `${nameLabel}\n` : "";
  return `${head}${lines.join("\n")}`;
}

/** ISO 8601 (ローカル +09:00) から「D日H時」を切り出す。TZ ずれ回避のため Date 解析しない。 */
function formatPeakTime(iso: string): string | null {
  const m = /-(\d{2})T(\d{2}):/.exec(iso);
  if (m == null) return null;
  return `${Number(m[1])}日${m[2]}時`;
}

/**
 * 台風の暴風域に入る確率 (VPTA50) を府県別確率から要約文にする。
 * 全地点を列挙すると 600 字級になり走行表示で読めないため、確率降順で上位 5 府県だけ出し、
 * ピーク時刻は最上位 1 件のみ添える。残りは「ほか◯府県」に畳む (代表地点は府県内最大地点)。
 * 通常発表 (active 府県あり) で非 null、取消・active 0 件のとき null。
 */
export function typhoonProbabilityToText(info: ParsedTyphoonProbability): string | null {
  if (info.infoType === "取消") return null;
  const active = aggregateByPrefecture(info.regions).filter((p) => p.maxDaily5 > 0);
  if (active.length === 0) return null;

  const nameLabel = typhoonNameLabel(info.name);
  const note = "5日以内";
  const subject = nameLabel != null
    ? `${nameLabel}の暴風域に入る確率（${note}）`
    : `暴風域に入る確率（${note}）`;

  const top = active.slice(0, 5);
  const items = top.map((p, i) => {
    // 府県名を出す (「北部」等の市区町村名だと何県か分からず、末尾「ほか◯府県」とも単位が揃わない)。
    const base = `${p.prefName} ${p.maxDaily5}%`;
    if (i !== 0) return base;
    // ピーク時刻は最上位 1 件のみ (行動判断の本命)。「◯日◯時ごろ」で概時刻を示す。
    const peakTime = p.worstPeak.kind === "value" ? formatPeakTime(p.worstPeak.time) : null;
    return peakTime != null ? `${base}（${peakTime}ごろ）` : base;
  });
  const remaining = active.length - top.length;
  const tail = remaining > 0 ? `、ほか${remaining}府県` : "";
  return `${subject}：${items.join("、")}${tail}。`;
}
