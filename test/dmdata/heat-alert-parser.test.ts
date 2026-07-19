import { describe, it, expect } from "vitest";
import { parseHeatAlert, extractLeadSentence } from "../../src/dmdata/heat-alert-parser";
import {
  createMockWsDataMessage,
  FIXTURE_VPFT50_SAITAMA,
  FIXTURE_VPFT50_CANCEL,
  FIXTURE_VPFT50_NO_BODY,
} from "../helpers/mock-message";

describe("parseHeatAlert - 熱中症警戒アラート (VPFT50)", () => {
  it("基本フィールドが取得される", () => {
    const result = parseHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_SAITAMA));
    expect(result).not.toBeNull();
    expect(result!.type).toBe("VPFT50");
    expect(result!.infoType).toBe("発表");
    expect(result!.title).toBe("埼玉県熱中症警戒アラート");
    expect(result!.controlTitle).toBe("熱中症警戒アラート");
    // publishingOffice は mock の xmlReport ("気象庁") が優先されるので truthy 検証のみ
    // (実電文では xmlReport.control.publishingOffice = "環境省 気象庁" が来る)
    expect(result!.publishingOffice).toBeTruthy();
    expect(result!.editorialOffice).toBe("熊谷地方気象台");
    expect(result!.eventId).toBe("JPTC240001");
    expect(result!.serial).toBe("2");
    expect(result!.reportDateTime).toBe("2024-08-11T05:00:00+09:00");
  });

  it("targetAreaName が Title から抽出される", () => {
    const result = parseHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_SAITAMA));
    expect(result!.targetAreaName).toBe("埼玉県");
  });

  it("Headline.Text が空のとき headline は null", () => {
    const result = parseHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_SAITAMA));
    expect(result!.headline).toBeNull();
  });

  it("Comment 本文が bodyText に入る", () => {
    const result = parseHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_SAITAMA));
    expect(result!.bodyText).toContain("熱中症による人の健康に係る被害");
    expect(result!.bodyText).toContain("ＷＢＧＴ");
  });

  it("取消電文がパースされる", () => {
    const result = parseHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_CANCEL));
    expect(result!.infoType).toBe("取消");
  });

  it("Comment 本文が空のとき bodyText は null", () => {
    const result = parseHeatAlert(createMockWsDataMessage(FIXTURE_VPFT50_NO_BODY));
    expect(result!.bodyText).toBeNull();
    expect(result!.headline).toBeNull();
  });
});

describe("parseHeatAlert - 異常系", () => {
  /** XML を gzip+base64 化して mock body に流し込むためのヘルパー */
  function makeMsg(xml: string) {
    // require は test 内で十分 (zlib は CommonJS)。
    const zlib = require("zlib");
    const body = zlib.gzipSync(Buffer.from(xml, "utf-8")).toString("base64");
    return createMockWsDataMessage(FIXTURE_VPFT50_SAITAMA, { body });
  }

  it("Head が欠落した XML では null を返す", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control><Title>熱中症警戒アラート</Title></Control>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/" />
</Report>`;
    expect(parseHeatAlert(makeMsg(xml))).toBeNull();
  });

  it("InfoType 単独欠落でも null を返す", () => {
    // InfoType が空・無い場合、取消判定不能となるため必須扱い (VPZI50 R1 教訓)
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control><Title>熱中症警戒アラート</Title></Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>埼玉県熱中症警戒アラート</Title>
    <ReportDateTime>2024-08-11T05:00:00+09:00</ReportDateTime>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/" />
</Report>`;
    expect(parseHeatAlert(makeMsg(xml))).toBeNull();
  });

  it("Title 単独欠落でも null を返す", () => {
    // Title が空・無い場合、通知タイトルが空になるリスクのため必須扱い (VPZI50 R1 教訓)
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control><Title>熱中症警戒アラート</Title></Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <ReportDateTime>2024-08-11T05:00:00+09:00</ReportDateTime>
    <InfoType>発表</InfoType>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/" />
</Report>`;
    expect(parseHeatAlert(makeMsg(xml))).toBeNull();
  });

  it("壊れた XML では null を返す (例外を投げない)", () => {
    expect(parseHeatAlert(makeMsg("<<<broken"))).toBeNull();
  });
});

describe("parseHeatAlert - 境界値 (合成 XML)", () => {
  function makeMsg(xml: string) {
    const zlib = require("zlib");
    const body = zlib.gzipSync(Buffer.from(xml, "utf-8")).toString("base64");
    return createMockWsDataMessage(FIXTURE_VPFT50_SAITAMA, { body });
  }

  it("Title がアラート形式にマッチしないとき targetAreaName は null", () => {
    // 将来の題名変更や同種電文への寛容性: パース自体は成功し、府県名抽出だけ null に倒す
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control><Title>熱中症警戒アラート</Title></Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>全国高温情報</Title>
    <ReportDateTime>2024-08-11T05:00:00+09:00</ReportDateTime>
    <InfoType>発表</InfoType>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/" />
</Report>`;
    const result = parseHeatAlert(makeMsg(xml));
    expect(result).not.toBeNull();
    expect(result!.title).toBe("全国高温情報");
    expect(result!.targetAreaName).toBeNull();
  });

  it("Comment.Text が複数のとき type=本文 が優先採用される", () => {
    // extractBodyText の防衛分岐: 本文 type があれば他 type (お知らせ等) は混ぜない
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control><Title>熱中症警戒アラート</Title></Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>埼玉県熱中症警戒アラート</Title>
    <ReportDateTime>2024-08-11T05:00:00+09:00</ReportDateTime>
    <InfoType>発表</InfoType>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/">
    <Comment>
      <Text type="本文">本文テキストです。</Text>
      <Text type="お知らせ">お知らせテキストです。</Text>
    </Comment>
  </Body>
</Report>`;
    const result = parseHeatAlert(makeMsg(xml));
    expect(result).not.toBeNull();
    expect(result!.bodyText).toBe("本文テキストです。");
    expect(result!.bodyText).not.toContain("お知らせ");
  });
});

describe("extractLeadSentence", () => {
  it("最初の「。」までを返す", () => {
    expect(extractLeadSentence("暑い。とても暑い。")).toBe("暑い。");
  });
  it("「。」が無ければ先頭 100 文字", () => {
    const long = "あ".repeat(150);
    expect(extractLeadSentence(long)).toBe("あ".repeat(100));
  });
  it("null/空文字は null", () => {
    expect(extractLeadSentence(null)).toBeNull();
    expect(extractLeadSentence("  \n ")).toBeNull();
  });
});
