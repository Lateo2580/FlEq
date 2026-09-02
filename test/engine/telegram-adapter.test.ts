import { describe, it, expect } from "vitest";
import { TelegramListItem } from "../../src/types";
import {
  toWsDataMessage,
  toWsDataMessageFromRestBody,
} from "../../src/engine/startup/telegram-adapter";

const XML = '<?xml version="1.0" encoding="UTF-8"?>\n<Report><Head/></Report>';

/** 実 API の一覧 item 形（body / compression / encoding を持たない） */
function realListItem(overrides: Partial<TelegramListItem> = {}): TelegramListItem {
  return {
    serial: 53456065,
    id: "e34c5754b921e7bd6f2514d519727e4af820b08170273f079c44c288318c7a322887f729371e026b22266d91269eabbf",
    classification: "telegram.volcano",
    head: {
      type: "VFVO50",
      author: "JPFK",
      time: "2026-09-01T07:00:00.000Z",
      designation: null,
      test: false,
    },
    receivedTime: "2026-09-01T07:00:24.105Z",
    xmlReport: {
      control: {
        title: "噴火警報・予報",
        dateTime: "2026-09-01T07:00:23Z",
        status: "通常",
        editorialOffice: "福岡管区気象台",
        publishingOffice: "福岡管区気象台",
      },
      head: {
        title: "火山名  阿蘇山  噴火警報（火口周辺）",
        reportDateTime: "2026-09-01T16:00:00+09:00",
        targetDateTime: "2026-09-01T16:00:00+09:00",
        eventId: "503",
        serial: null,
        infoType: "発表",
        infoKind: "噴火警報・予報",
        infoKindVersion: "1.0_0",
        headline: null,
      },
    },
    format: "xml",
    compression: null,
    encoding: null,
    url: "https://data.api.dmdata.jp/v1/e34c5754b921e7bd6f2514d519727e4af820b08170273f079c44c288318c7a322887f729371e026b22266d91269eabbf",
    ...overrides,
  };
}

describe("toWsDataMessageFromRestBody", () => {
  it("compression: null / encoding: utf-8 を立てる", () => {
    const message = toWsDataMessageFromRestBody(realListItem(), XML, 1_756_712_424_105);
    expect(message.compression).toBeNull();
    expect(message.encoding).toBe("utf-8");
    expect(message.body).toBe(XML);
  });

  it("一覧 item の compression / encoding を読まない", () => {
    const message = toWsDataMessageFromRestBody(
      // 実 API には無い欄だが、混入しても無視することを固定する
      realListItem({ compression: "gzip", encoding: "base64" }),
      XML,
      1_756_712_424_105,
    );
    expect(message.compression).toBeNull();
    expect(message.encoding).toBe("utf-8");
  });

  it("format が無いときは xml を既定にする", () => {
    const message = toWsDataMessageFromRestBody(realListItem({ format: null }), XML, 1);
    expect(message.format).toBe("xml");
  });

  it("xmlReport をそのまま引き渡す (meta の唯一の供給源)", () => {
    const item = realListItem();
    const message = toWsDataMessageFromRestBody(item, XML, 1_756_712_424_105);
    expect(message.xmlReport).toEqual(item.xmlReport);
    expect(message.id).toBe(item.id);
    expect(message.classification).toBe(item.classification);
    expect(message.head).toEqual(item.head);
  });

  it("既存の toWsDataMessage は item の compression/encoding を写す挙動のまま", () => {
    const message = toWsDataMessage(
      realListItem({ compression: "gzip", encoding: "base64" }),
      "dGVzdA==",
      1,
    );
    expect(message.compression).toBe("gzip");
    expect(message.encoding).toBe("base64");
  });
});
