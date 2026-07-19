export type Vpta50SyntheticVariant =
  | "cancel"
  | "missingTimeSeries"
  | "missingSeriesForOneArea"
  | "duplicateCode"
  | "monotonicityViolation"
  | "oversized"
  | "reversedTimeDefines";

export function buildVpta50Synthetic(
  baseXml: string,
  variant: Vpta50SyntheticVariant,
): string {
  switch (variant) {
    case "cancel": {
      // InfoType を取消に置換し、Body 内の MeteorologicalInfos ごと空にする
      let out = baseXml.replace(
        /<InfoType>[^<]*<\/InfoType>/,
        "<InfoType>取消</InfoType>",
      );
      out = out.replace(
        /<MeteorologicalInfos type="台風情報">[\s\S]*<\/MeteorologicalInfos>/,
        `<MeteorologicalInfos type="台風情報"></MeteorologicalInfos>`,
      );
      return out;
    }

    case "missingTimeSeries": {
      // <TimeSeriesInfo>…</TimeSeriesInfo> ブロックを削除
      return baseXml.replace(/<TimeSeriesInfo>[\s\S]*?<\/TimeSeriesInfo>\s*/g, "");
    }

    case "missingSeriesForOneArea": {
      // TimeSeriesInfo 配下の最初の <FiftyKtWindProbabilityPart>…</> を空タグにする
      // TimeSeriesInfo ブロック内に限定して最初の1個だけを置換
      return baseXml.replace(
        /(<TimeSeriesInfo>[\s\S]*?<Item>[\s\S]*?)<FiftyKtWindProbabilityPart>[\s\S]*?<\/FiftyKtWindProbabilityPart>/,
        "$1<FiftyKtWindProbabilityPart></FiftyKtWindProbabilityPart>",
      );
    }

    case "duplicateCode": {
      // 「1日積算」セクションの最初の <Item>…</Item> をコピーして直後に挿入し
      // Area.Code 011011 が同セクション内で2回出現するようにする
      const sectionMarker = "（1日積算）";
      const idx = baseXml.indexOf(sectionMarker);
      if (idx < 0) return baseXml;
      const afterMarker = baseXml.slice(idx);
      const itemMatch = afterMarker.match(/<Item>[\s\S]*?<\/Item>/);
      if (itemMatch == null) return baseXml;
      const itemXml = itemMatch[0];
      const insertAt = idx + itemMatch.index! + itemXml.length;
      return baseXml.slice(0, insertAt) + itemXml + baseXml.slice(insertAt);
    }

    case "monotonicityViolation": {
      // 011011（宗谷北部）の 3日積算 の値を 15 に変更して非単調にする
      // 1日積算=0, 2日積算=0, 3日積算=15, 4日積算=0, 5日積算=0 → 非単調
      const marker3 = "（3日積算）";
      const marker4 = "（4日積算）";
      const idx3 = baseXml.indexOf(marker3);
      const idx4 = baseXml.indexOf(marker4);
      if (idx3 < 0 || idx4 < 0) return baseXml;
      const head = baseXml.slice(0, idx3);
      const section = baseXml.slice(idx3, idx4);
      const rest = baseXml.slice(idx4);
      // section 内の 011011 を含む Item の FiftyKtWindProbability 値を 15 に書き換え
      // 構造: <FiftyKtWindProbability unit="%">0</FiftyKtWindProbability> が先に来て
      //        その後に <Code>011011</Code> が来るので後方参照で狙う
      const replaced = section.replace(
        /<FiftyKtWindProbability unit="%">0<\/FiftyKtWindProbability>([\s\S]*?<Code>011011<\/Code>)/,
        '<FiftyKtWindProbability unit="%">15</FiftyKtWindProbability>$1',
      );
      return head + replaced + rest;
    }

    case "oversized": {
      // TimeSeriesInfo ブロックを繰り返して 6MB 以上に膨らます
      const tsMatch = baseXml.match(/<TimeSeriesInfo>[\s\S]*?<\/TimeSeriesInfo>/);
      if (tsMatch == null) return baseXml;
      const ts = tsMatch[0];
      const targetBytes = 6 * 1024 * 1024;
      const padding = ts.repeat(Math.ceil(targetBytes / ts.length));
      return baseXml.replace("</MeteorologicalInfos>", padding + "</MeteorologicalInfos>");
    }

    case "reversedTimeDefines": {
      // TimeDefine ノードを timeId の逆順 (40, 39, ..., 1) に並べ替える。
      // peak.time の解決が document order ではなく timeId ベースであることを検証するため。
      const tdBlockMatch = baseXml.match(/<TimeDefines>([\s\S]*?)<\/TimeDefines>/);
      if (tdBlockMatch == null) return baseXml;
      const tdBlock = tdBlockMatch[1];
      const tdNodes = [...tdBlock.matchAll(/<TimeDefine timeId="\d+">\s*<DateTime>[^<]*<\/DateTime>\s*<Duration>[^<]*<\/Duration>\s*<\/TimeDefine>/g)];
      if (tdNodes.length === 0) return baseXml;
      const reversed = [...tdNodes].reverse().map(m => m[0]).join("\n");
      return baseXml.replace(
        /<TimeDefines>[\s\S]*?<\/TimeDefines>/,
        `<TimeDefines>\n${reversed}\n</TimeDefines>`,
      );
    }

    default: {
      const _exhaustive: never = variant;
      throw new Error(`unhandled VPTA50 synthetic variant: ${_exhaustive as string}`);
    }
  }
}
