import { describe, expect, it } from "vitest";
import { initialState, reduce, setSseConnected } from "../store";
import type {
  DisplayConnectionStateV1,
  DisplayEventDtoV1,
  DisplayStateSnapshotV1,
} from "../protocol";

function connection(): DisplayConnectionStateV1 {
  return { dmdata: "connected", lastReceivedAt: null, disconnectedSince: null, reason: null };
}

function tickerEvent(over: Partial<DisplayEventDtoV1> & { id: string }): DisplayEventDtoV1 {
  return {
    version: 1,
    seq: 0,
    eventKey: `k-${over.id}`,
    groupKey: null,
    domain: "weather",
    type: "VPWW53",
    infoType: "発表",
    reportDateTime: "2026-07-06T21:00:00+09:00",
    title: "t",
    headline: null,
    publishingOffice: "気象庁",
    isTest: false,
    frameLevel: "info",
    isCancellation: false,
    summary: { text: "t", role: "info" },
    emergency: null,
    recentQuake: null,
    latestQuake: null,
    tickerDetail: null,
    ...over,
  };
}

function snapshot(over: Partial<DisplayStateSnapshotV1> = {}): DisplayStateSnapshotV1 {
  return {
    version: 1,
    generatedAt: "2026-07-06T21:00:00+09:00",
    seq: 0,
    activeEews: [],
    tsunami: null,
    largeQuakes: [],
    weatherAlerts: [],
    recentQuakes: [],
    latestQuake: null,
    stats: null,
    severityTier: "calm",
    connection: connection(),
    recentTicker: [],
    ...over,
  };
}

describe("reduce", () => {
  it("① snapshot 受信で state を初期化し recentTicker (新しい順) がそのまま ticker になる", () => {
    const snap = snapshot({
      seq: 3,
      recentTicker: [tickerEvent({ id: "e3" }), tickerEvent({ id: "e2" }), tickerEvent({ id: "e1" })],
    });
    const next = reduce(initialState(), { type: "snapshot", snapshot: snap });
    expect(next.snapshot).toEqual({
      ...snap,
      mapLayers: { quake: { events: [], nonEmergencyHost: null } },
    });
    expect(next.ticker.map((e) => e.id)).toEqual(["e3", "e2", "e1"]);
    expect(next.lastSeq).toBe(3);
  });

  it("② event 受信で ticker 先頭に積まれ 200 で丸まる (snapshot 由来と並び順が一貫)", () => {
    const snap = snapshot({ recentTicker: [tickerEvent({ id: "e2" }), tickerEvent({ id: "e1" })] });
    let state = reduce(initialState(), { type: "snapshot", snapshot: snap });
    state = reduce(state, { type: "event", event: tickerEvent({ id: "e3" }) });
    // 新しい順の先頭は最後に届いた event。snapshot 由来の並びはそのまま後続に残る
    expect(state.ticker.map((e) => e.id)).toEqual(["e3", "e2", "e1"]);

    // 200 件を超えた分は切り捨てられる
    let filled = initialState();
    for (let i = 0; i < 205; i++) {
      filled = reduce(filled, { type: "event", event: tickerEvent({ id: `f${i}` }) });
    }
    expect(filled.ticker.length).toBe(200);
    expect(filled.ticker[0].id).toBe("f204"); // 最後に積んだものが先頭
    expect(filled.ticker[filled.ticker.length - 1].id).toBe("f5"); // 古い 5 件 (f0-f4) が落ちる
  });

  it("③ event 受信は snapshot 内の recentQuakes 等を変更しない (state/snapshot だけが差し替える)", () => {
    const snap = snapshot({ recentQuakes: [{ eventId: "Q1", reportDateTime: "t", originTime: null, hypocenterName: null, magnitude: null, maxInt: null, maxIntRank: null, depth: null, tsunamiWarning: false }] });
    const afterSnapshot = reduce(initialState(), { type: "snapshot", snapshot: snap });
    const afterEvent = reduce(afterSnapshot, { type: "event", event: tickerEvent({ id: "e9" }) });
    expect(afterEvent.snapshot).toBe(afterSnapshot.snapshot);
    expect(afterEvent.snapshot?.recentQuakes).toEqual(snap.recentQuakes);
  });

  it("④ seq が単調でない event が来ても壊れず lastSeq は最大値を保つ", () => {
    let state = initialState();
    state = reduce(state, { type: "event", event: tickerEvent({ id: "a", seq: 10 }) });
    expect(state.lastSeq).toBe(10);
    // 再接続の取りこぼし境界: 過去の seq が届く
    state = reduce(state, { type: "event", event: tickerEvent({ id: "b", seq: 3 }) });
    expect(state.lastSeq).toBe(10);
    expect(state.ticker.map((e) => e.id)).toEqual(["b", "a"]);
    // さらに新しい seq が届けば更新される
    state = reduce(state, { type: "event", event: tickerEvent({ id: "c", seq: 15 }) });
    expect(state.lastSeq).toBe(15);
  });

  describe("seqGapDetected (backpressure 等での event 欠落検知、2026-07-10 / lastEventSeq 分離 2026-07-10 追補)", () => {
    it("event の seq が lastEventSeq+1 を跳び越えると seqGapDetected が立つ", () => {
      let state = reduce(initialState(), { type: "event", event: tickerEvent({ id: "a", seq: 1 }) });
      expect(state.seqGapDetected).toBe(false);
      // 2 が欠落して 3 が届く (backpressure スキップ等で 2 が失われた想定)
      state = reduce(state, { type: "event", event: tickerEvent({ id: "c", seq: 3 }) });
      expect(state.seqGapDetected).toBe(true);
    });

    it("古い/重複 seq の event は gap として扱わない", () => {
      // baseline は実運用どおり snapshot で確立する (snapshot は必ず gap を false にクリアするので、
      // 初回メッセージが event 単体で来る非現実的な順序を避ける)
      let state = reduce(initialState(), { type: "snapshot", snapshot: snapshot({ seq: 10 }) });
      state = reduce(state, { type: "event", event: tickerEvent({ id: "b", seq: 3 }) });
      expect(state.seqGapDetected).toBe(false);
    });

    it("【レビュー再指摘の off-by-one 回帰】event が 1 件だけ欠落し、直後に同じ次番の state が "
      + "届くケースでも gap を検知する。hub は ingest 成功ごとに必ず event を broadcast してから "
      + "seq を進める (hub.ts:64,75) ため、state.snapshot.seq は「最後に確実に届いた event の seq」 "
      + "(lastEventSeq) を 1 件でも上回っていれば即 gap 確定であり、+1 の遊びは要らない。"
      + "旧実装 (state も更新する lastSeq を +1 閾値で比較) はこの 1 件欠落だけを見逃していた "
      + "(`2 > 1+1` = false)", () => {
      let state = reduce(initialState(), { type: "snapshot", snapshot: snapshot({ seq: 1 }) });
      expect(state.seqGapDetected).toBe(false);
      // event seq=2 が backpressure でスキップされ (client には一切届かない)、
      // hub の seq カウンタだけが進んだ状態で次の定期 state (seq=2、event の次番と同値) が届く
      state = reduce(state, { type: "state", snapshot: snapshot({ seq: 2 }) });
      expect(state.seqGapDetected).toBe(true);
    });

    it("通常フロー (event→state で欠落なし) では state.seq が lastEventSeq と同値でも "
      + "gap を誤検知しない (偽陽性回帰)", () => {
      let state = reduce(initialState(), { type: "snapshot", snapshot: snapshot({ seq: 1 }) });
      state = reduce(state, { type: "event", event: tickerEvent({ id: "e2", seq: 2 }) }); // 正常受信
      expect(state.seqGapDetected).toBe(false);
      // hub は event を先に broadcast してから state を配信するため、event を全部受信できていれば
      // state.seq は lastEventSeq 以下になる (同値がちょうど「欠落なし」の境界)
      state = reduce(state, { type: "state", snapshot: snapshot({ seq: 2 }) });
      expect(state.seqGapDetected).toBe(false);
    });

    it("state の snapshot.seq が lastEventSeq を跳び越えても gap として検知する "
      + "(定期 state はもう recentTicker を運ばないので、ここが欠落を検知できる唯一の経路になる)", () => {
      let state = reduce(initialState(), { type: "snapshot", snapshot: snapshot({ seq: 5 }) });
      expect(state.seqGapDetected).toBe(false);
      // 6,7 の event が backpressure でスキップされ、8 で定期 state が飛んでくる
      state = reduce(state, { type: "state", snapshot: snapshot({ seq: 8 }) });
      expect(state.seqGapDetected).toBe(true);
    });

    it("snapshot 受信で seqGapDetected がクリアされる (ticker を全再構築するため)", () => {
      let state = reduce(initialState(), { type: "event", event: tickerEvent({ id: "a", seq: 1 }) });
      state = reduce(state, { type: "event", event: tickerEvent({ id: "c", seq: 3 }) });
      expect(state.seqGapDetected).toBe(true);
      state = reduce(state, { type: "snapshot", snapshot: snapshot({ seq: 3 }) });
      expect(state.seqGapDetected).toBe(false);
    });

    it("一度立った seqGapDetected は snapshot が来るまで後続の event/state で消えない", () => {
      let state = reduce(initialState(), { type: "event", event: tickerEvent({ id: "a", seq: 1 }) });
      state = reduce(state, { type: "event", event: tickerEvent({ id: "c", seq: 3 }) }); // gap
      state = reduce(state, { type: "event", event: tickerEvent({ id: "d", seq: 4 }) }); // gap 無しの通常 event
      expect(state.seqGapDetected).toBe(true);
    });

    it("【hub 再起動の seq 巻き戻り回帰】snapshot は lastEventSeq を Math.max でなく代入で "
      + "リセットする。hub の seq はプロセス内カウンタなので再起動で巻き戻る (実経路)。max だと "
      + "旧接続の高水位 (例 100) が残り、巻き戻り後の欠落 (snapshot 1 → event 2 欠落 → state 2) が "
      + "`2 > 100` = false で永久に検知できなくなる", () => {
      // 旧接続で lastEventSeq が高水位まで進んだ状態
      let state = reduce(initialState(), { type: "snapshot", snapshot: snapshot({ seq: 90 }) });
      state = reduce(state, { type: "event", event: tickerEvent({ id: "old", seq: 100 }) });
      // hub 再起動 → seq が 1 から再開した新 snapshot (再接続経路)
      state = reduce(state, { type: "snapshot", snapshot: snapshot({ seq: 1 }) });
      // event seq=2 が欠落し、同値の定期 state が届く → 巻き戻り後 baseline (1) で正しく検知
      state = reduce(state, { type: "state", snapshot: snapshot({ seq: 2 }) });
      expect(state.seqGapDetected).toBe(true);
    });
  });

  it("state メッセージは snapshot を置き換えるが、ticker は据え置く (recentTicker は無視する)", () => {
    // hub は定期 state に recentTicker を積まない (空配列) 前提。それでも ticker を巻き戻さない
    const snap = snapshot({ seq: 7, recentTicker: [] });
    const withTicker = reduce(initialState(), {
      type: "snapshot",
      snapshot: snapshot({ seq: 3, recentTicker: [tickerEvent({ id: "e1" })] }),
    });
    const next = reduce(withTicker, { type: "state", snapshot: snap });
    expect(next.snapshot).toEqual({
      ...snap,
      mapLayers: { quake: { events: [], nonEmergencyHost: null } },
    });
    expect(next.ticker).toBe(withTicker.ticker); // 参照そのまま = 据え置き
    expect(next.ticker.map((e) => e.id)).toEqual(["e1"]);
    expect(next.lastSeq).toBe(7);
  });

  it("state メッセージが (縮退等で) recentTicker を持っていても tickerSynced が無ければ ticker に反映しない", () => {
    const withTicker = reduce(initialState(), {
      type: "snapshot",
      snapshot: snapshot({ seq: 1, recentTicker: [tickerEvent({ id: "e1" })] }),
    });
    const stateWithTicker = snapshot({ seq: 2, recentTicker: [tickerEvent({ id: "should-be-ignored" })] });
    const next = reduce(withTicker, { type: "state", snapshot: stateWithTicker });
    expect(next.ticker.map((e) => e.id)).toEqual(["e1"]);
    expect(next.tickerGeneration).toBe(withTicker.tickerGeneration); // 据え置きなので進まない
  });

  describe("tickerSynced (spec §3-2、レビュー Important 対応: サーバ sweepTicker の一発同期)", () => {
    it("state.tickerSynced=true なら recentTicker で ticker を丸ごと差し替え、tickerGeneration を進める", () => {
      const withTicker = reduce(initialState(), {
        type: "snapshot",
        snapshot: snapshot({ seq: 1, recentTicker: [tickerEvent({ id: "e1" }), tickerEvent({ id: "e2" })] }),
      });
      const synced = snapshot({ seq: 2, recentTicker: [tickerEvent({ id: "e2" })], tickerSynced: true });
      const next = reduce(withTicker, { type: "state", snapshot: synced });
      expect(next.ticker.map((e) => e.id)).toEqual(["e2"]); // sweep で e1 が消えた構成に差し替わる
      expect(next.tickerGeneration).toBe(withTicker.tickerGeneration + 1);
    });

    it("state.tickerSynced=true かつ recentTicker=[] は「全滅」を意味し ticker を空にする (空=除外との区別)", () => {
      const withTicker = reduce(initialState(), {
        type: "snapshot",
        snapshot: snapshot({ seq: 1, recentTicker: [tickerEvent({ id: "e1" })] }),
      });
      const synced = snapshot({ seq: 2, recentTicker: [], tickerSynced: true });
      const next = reduce(withTicker, { type: "state", snapshot: synced });
      expect(next.ticker).toEqual([]);
    });

  });
});

describe("setSseConnected", () => {
  it("sseConnected だけを変更し他のフィールドは維持する", () => {
    const state = initialState();
    const next = setSseConnected(state, true);
    expect(next.sseConnected).toBe(true);
    expect(next.snapshot).toBe(state.snapshot);
    expect(next.ticker).toBe(state.ticker);
    expect(next.lastSeq).toBe(state.lastSeq);
  });
});

  it("event: tickerSuppressed はテロップに積まず seq 系は進む", () => {
    const withTicker = reduce(initialState(), {
      type: "snapshot", snapshot: snapshot({ seq: 1, recentTicker: [tickerEvent({ id: "e1" })] }),
    });
    const suppressed = { ...tickerEvent({ id: "sup" }), seq: 2, tickerSuppressed: true };
    const next = reduce(withTicker, { type: "event", event: suppressed });
    expect(next.ticker.map((t) => t.id)).toEqual(["e1"]);
    expect(next.lastEventSeq).toBe(2);
    expect(next.seqGapDetected).toBe(false);
  });

describe("mapLayers protocol compatibility", () => {
  it("旧 snapshot/state の mapLayers 欠落を空レイヤーとして扱う", () => {
    let state = reduce(initialState(), { type: "snapshot", snapshot: snapshot({ seq: 1 }) });
    expect(state.snapshot?.mapLayers?.quake).toEqual({ events: [], nonEmergencyHost: null });
    state = reduce(state, { type: "state", snapshot: snapshot({ seq: 2 }) });
    expect(state.snapshot?.mapLayers?.quake).toEqual({ events: [], nonEmergencyHost: null });
  });

  it("snapshot/state が持つ quake layer をそのまま置換する", () => {
    const quake = {
      events: [{
        eventKey: "earthquake:E1",
        eventId: "E1",
        sourceType: "VXSE53",
        revision: { reportTimeMs: 1, serial: "1" },
        reportDateTime: "2026-07-30T12:00:00+09:00",
        originTime: null,
        hypocenterName: null,
        depth: null,
        magnitude: null,
        maxInt: "4",
        maxIntRank: 4,
        tsunamiWarning: false,
        intensityGroups: [],
        localAreas: [{ code: "440", rank: 4 }],
        updatedAtMs: 1,
      }],
      nonEmergencyHost: { eventKey: "earthquake:E1", expiresAtMs: 2 },
    };
    const state = reduce(initialState(), {
      type: "snapshot",
      snapshot: snapshot({ mapLayers: { quake } }),
    });
    expect(state.snapshot?.mapLayers?.quake).toEqual(quake);
  });
});
