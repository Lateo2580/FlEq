/**
 * weather 経路の二重 parse 解消 (削減 spec
 * `docs/specs/2026-09-09-receipt-serialize-reduction.md` §3.1 E) の受入 A5。
 *
 * `processWeatherWithAdmission` が 1 回目の parse 結果を reducer 内の `processWeather` へ
 * 渡すので、**同じオブジェクトが受理経路と outcome 消費経路の両方で共有される**。
 * ここでは `parseWeatherWarning` の戻り値を deepFreeze してから電文を流し、
 * 誰も変異させないことを機械的に固定する (strict mode の frozen object への代入は
 * TypeError を投げる。ES module のコードは常に strict)。
 *
 * 併せて **parse 回数が電文 1 通あたり 1 回**であることも数える。回数が 2 に戻ったら
 * それは削減が外れた印で、Pi 実測 VPWS50 115KB の 1,177.9ms が復活する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `vi.mock` の factory は静的 import より先に巻き上げられるので、factory が触る値は
 * `vi.hoisted` に置く (module スコープの `const` を触ると TDZ で落ちる)。
 */
const hoisted = vi.hoisted(() => {
  const parseCalls: string[] = [];
  const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
    return Object.freeze(value);
  };
  return { parseCalls, deepFreeze };
});

vi.mock("../../../src/dmdata/weather-parser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/dmdata/weather-parser")>();
  return {
    ...actual,
    parseWeatherWarning: (msg: Parameters<typeof actual.parseWeatherWarning>[0]) => {
      hoisted.parseCalls.push(msg.head.type);
      return hoisted.deepFreeze(actual.parseWeatherWarning(msg));
    },
  };
});

import { createMessageHandler } from "../../../src/engine/messages/message-router";
import { StandbyPersistenceAdmissionCoordinator } from "../../../src/engine/display/standby-persistence-admission";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { FloodForecastStateHolder } from "../../../src/engine/messages/flood-forecast-state";
import { TelegramRevisionGate } from "../../../src/engine/messages/telegram-revision-gate";
import { TsunamiStateHolder } from "../../../src/engine/messages/tsunami-state";
import { VolcanoStateHolder } from "../../../src/engine/messages/volcano-state";
import { Vpws50StateHolder } from "../../../src/engine/messages/vpws50-state";
import { Vpww56StateHolder } from "../../../src/engine/messages/vpww56-state";
import {
  createMockWsDataMessageFromXml,
  FIXTURE_VPWS50_AGGREGATE,
  FIXTURE_VPWW55_OAME,
  FIXTURE_VPWW56_DOSHA,
  readFixture,
} from "../../helpers/mock-message";
import type { WsDataMessage } from "../../../src/types";

const parseCalls = hoisted.parseCalls;

const CLASSIFICATION_NOW = Date.parse("2025-06-30T00:00:00.000Z");

beforeEach(() => {
  parseCalls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeRouter() {
  const owners = {
    telegramRevisionGate: new TelegramRevisionGate(() => undefined),
    standbyStateStore: new StandbyStateStore(),
    vpws50State: new Vpws50StateHolder(),
    vpww56State: new Vpww56StateHolder(),
    tsunamiState: new TsunamiStateHolder(),
    volcanoState: new VolcanoStateHolder(),
    floodForecastState: new FloodForecastStateHolder(),
  };
  const coordinator = new StandbyPersistenceAdmissionCoordinator({ owners });
  const outcomes: unknown[] = [];
  const router = createMessageHandler({
    clock: { nowMs: () => CLASSIFICATION_NOW },
    persistenceAdmission: coordinator,
    revisionGate: owners.telegramRevisionGate,
    vpws50State: owners.vpws50State,
    vpww56State: owners.vpww56State,
    tsunamiState: owners.tsunamiState,
    volcanoState: owners.volcanoState,
    floodForecastState: owners.floodForecastState,
    outcomeTaps: [(outcome) => { outcomes.push(outcome); }],
    onVptaAdmissionCompletion: () => ({ kind: "notRequired" as const }),
    withStandbyDurableNotificationsSuppressed: (callback) => callback(),
  });
  return { handler: (message: WsDataMessage) => router.handler(message), outcomes, owners };
}

function fixtureMessage(fixture: string, headType: string, id: string): WsDataMessage {
  const message = createMockWsDataMessageFromXml(readFixture(fixture), headType);
  if (message.meta == null) throw new Error(`fixture meta missing: ${fixture}`);
  return {
    ...message,
    id,
    meta: { ...message.meta, messageId: id, receivedAtMs: CLASSIFICATION_NOW },
  };
}

const FIXTURES = [
  { name: "VPWS50 全国報", fixture: FIXTURE_VPWS50_AGGREGATE, headType: "VPWS50" },
  { name: "VPWS50 地域先行報 (VPWW55)", fixture: FIXTURE_VPWW55_OAME, headType: "VPWW55" },
  { name: "VPWW56 土砂災害警戒情報", fixture: FIXTURE_VPWW56_DOSHA, headType: "VPWW56" },
] as const;

describe("§4.3 A5: deepFreeze した parsed が受理経路と outcome 経路を素通りする", () => {
  it.each(FIXTURES)("A5: $name で例外なく流れ、parse は 1 回だけ走る", ({ fixture, headType }) => {
    const router = makeRouter();
    expect(() => router.handler(fixtureMessage(fixture, headType, `frozen-${headType}`)))
      .not.toThrow();
    expect(parseCalls).toEqual([headType]);
    expect(router.outcomes.length).toBeGreaterThan(0);
  });

  it("A5: 3 系統を連続で流しても parse は 1 通 1 回のまま", () => {
    const router = makeRouter();
    for (const entry of FIXTURES) {
      router.handler(fixtureMessage(entry.fixture, entry.headType, `frozen-seq-${entry.headType}`));
    }
    expect(parseCalls).toEqual(FIXTURES.map((entry) => entry.headType));
  });
});
