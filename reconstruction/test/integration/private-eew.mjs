import { AsyncLocalStorage } from "node:async_hooks";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import latency from "../notification-delivery/r32-latency.cjs";

const require = createRequire(import.meta.url);
const clock = () => ({ wallTimeMs: Date.now(), monotonicMs: performance.now() });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const blocked = (reason) => { throw Object.assign(new Error(reason), { blocked: true }); };
const validText = (value) => typeof value === "string" && value.trim().length > 0;
const iso = (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
  && Number.isFinite(Date.parse(value));
const hex = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const channels = ["desktop", "sound"];
const opportunities = ["firstReport", "warningUpgrade", "hazardIncrease", "cancellation", "correction", "finalReport"];

let out = null;
const evidence = { status: "blocked", reason: "preflightIncomplete", environment: null, reports: [], intents: [],
  generation: null, unavailable: null, shutdown: null };
function finish(code) {
  try {
    if (out != null) writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  } catch {
    evidence.status = "blocked";
    evidence.reason = "resultWriteFailed";
    code = 2; // Never retry a failed or partially completed result write.
  }
  process.stdout.write(`${JSON.stringify({ status: evidence.status, reason: evidence.reason,
    reportCount: evidence.reports.length, intentCount: evidence.intents.length })}\n`);
  process.exitCode = code;
}

function preflight() {
  // PRIVATE-EEW-EVIDENCE: no output path is adopted until its canonical location is safe.
  let args;
  try { args = parseArgs({ options: { "private-corpus": { type: "string" }, out: { type: "string" },
    "mac-notification-confirmed": { type: "boolean" } } }).values; }
  catch { blocked("argumentsInvalid"); }
  if (typeof args["private-corpus"] !== "string" || typeof args.out !== "string"
    || !isAbsolute(args["private-corpus"]) || !isAbsolute(args.out) || !args.out.endsWith(".json"))
    blocked("argumentsInvalid");
  const corpus = realpathSync(resolve(args["private-corpus"]));
  if (!lstatSync(corpus).isDirectory()) blocked("corpusMissing");
  const requestedOut = resolve(args.out);
  const candidate = join(realpathSync(dirname(requestedOut)), basename(requestedOut));
  const fromCorpus = relative(corpus, candidate);
  if (fromCorpus === "" || fromCorpus !== ".." && !fromCorpus.startsWith(`..${sep}`) && !isAbsolute(fromCorpus))
    blocked("outputInvalid");
  try { lstatSync(candidate); blocked("outputExists"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  accessSync(dirname(candidate), constants.W_OK);
  out = candidate;
  if (process.platform === "darwin" && args["mac-notification-confirmed"] !== true)
    blocked("macNotificationConfirmationRequired");
  const manifestPath = join(corpus, "manifest.json");
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
  catch (error) { if (error instanceof SyntaxError) blocked("manifestInvalid"); throw error; }
  if (manifest?.schema !== "fleq-private-eew-corpus-v1" || manifest.eventId !== "20240417231454"
    || manifest.headType !== "VXSE45" || manifest.controlStatus !== "通常"
    || !validText(manifest.source) || !hex(manifest.archiveSha256) || !iso(manifest.retrievedAt)
    || !validText(manifest.distribution) || !validText(manifest.expectedNote)
    || !Array.isArray(manifest.reports) || manifest.reports.length !== 33
    || !Array.isArray(manifest.expectedOpportunities) || manifest.expectedOpportunities.length === 0)
    blocked("manifestFieldsInvalid");
  const expected = new Map();
  for (const item of manifest.expectedOpportunities) {
    if (!Number.isInteger(item?.serial) || item.serial < 1 || item.serial > 33
      || !opportunities.includes(item.opportunity) || !["予報", "警報"].includes(item.expectedStage)
      || !validText(item.basis) || expected.has(item.serial))
      blocked("opportunitiesInvalid");
    expected.set(item.serial, item);
  }
  const bodies = [];
  const files = new Set();
  for (const [index, report] of manifest.reports.entries()) {
    if (report?.serial !== index + 1 || !validText(report.file) || basename(report.file) !== report.file
      || !/^VXSE45_[\w.-]+\.xml$/.test(report.file) || files.has(report.file)
      || !iso(report.reportDateTime) || !hex(report.sha256)
      || !Number.isSafeInteger(report.byteLength) || report.byteLength < 1 || report.byteLength > 8 * 1024 * 1024)
      blocked("reportFieldsInvalid");
    files.add(report.file);
    const file = join(corpus, report.file);
    if (!existsSync(file) || !lstatSync(file).isFile()) blocked("reportMissing");
    const body = readFileSync(file);
    if (body.length !== report.byteLength || sha256(body) !== report.sha256) blocked("reportIntegrityMismatch");
    bodies.push(body);
  }
  const dist = "reconstruction/dist/src";
  const modules = ["runtime/composition-root.js", "ingress/ingress.js", "decode-material/decode-material.js",
    "notification-delivery/adapter.js"];
  if (modules.some((module) => !existsSync(join(dist, module)))) blocked("reconstructionDistMissing");
  const { ingestXmlData } = require(`../../dist/src/ingress/ingress.js`);
  const { decodeMaterial } = require(`../../dist/src/decode-material/decode-material.js`);
  const materials = bodies.map((body, index) => {
    const report = manifest.reports[index];
    const entered = ingestXmlData({ inputId: `private-${report.serial}`, inputSequence: report.serial,
      receivedAt: 0, origin: "replay", kind: "replay", headType: manifest.headType, body });
    if (entered.kind !== "accepted") blocked("xmlIngressInvalid");
    const decoded = decodeMaterial(entered.item);
    if (decoded.kind !== "decoded") blocked("xmlDecodeInvalid");
    const material = decoded.material;
    if (material.eventIdRaw !== manifest.eventId || material.headType !== manifest.headType
      || material.serialRaw !== String(report.serial)
      || Date.parse(material.reportDateTimeRaw) !== Date.parse(report.reportDateTime)
      || material.operation !== "normal") blocked("xmlMetadataMismatch");
    return material;
  });
  bodies.length = 0;

  return { expected, materials, macNotificationConfirmed: args["mac-notification-confirmed"] === true };
}

async function main() {
  let input;
  try { input = preflight(); }
  catch (error) { if (error?.blocked) throw error; blocked("preflightIoFailed"); }
  const { expected, materials, macNotificationConfirmed } = input;
  const backendPaths = process.platform === "darwin" ? ["/usr/bin/osascript", "/usr/bin/afplay"]
    : process.platform === "linux" && ["arm", "arm64"].includes(process.arch)
      ? ["/usr/bin/notify-send", "/usr/bin/ffplay", "/usr/bin/paplay", "/usr/bin/aplay"] : [];
  if (backendPaths.length === 0) blocked("osUnsupported");
  try {
    evidence.environment = { os: process.platform, arch: process.arch, node: process.version,
      backendCandidates: backendPaths.map((path) => ({ path, present: existsSync(path),
        sha256: existsSync(path) ? sha256(readFileSync(path)) : null })), usedBackends: [],
      macNotificationPermission: process.platform === "darwin"
        ? { confirmed: macNotificationConfirmed, basis: "operator confirmation (--mac-notification-confirmed)" } : null };
  } catch { blocked("backendInspectionFailed"); }
  const directory = await mkdtemp(join(tmpdir(), "fleq-r33-"));
  let root;
  let started = false;
  let timer;
  let savePromise = null;
  let savingStopped = false;
  let executionError = null;
  const spawned = new Map(), closed = new Map(), terminals = new Map(), adopted = new Map(), expired = new Set(), runs = [];
  const attempts = [];
  evidence.markers = [];
  // A4 terminal records expire during this 33-second replay. Retain each last A1 state observation.
  const observe = (step) => {
    const unit = step.state.units["U-E"];
    for (const item of unit.intents) adopted.set(item.id, { disposition: item.disposition,
      basis: "A1 state intent", generation: unit.persistence.currentGeneration });
    for (const item of unit.deliveryRecords) adopted.set(item.intentId, { disposition: item.disposition,
      basis: "A1 state deliveryRecords", generation: unit.persistence.currentGeneration });
    for (const outcome of step.outcomes) for (const subject of outcome.subjects)
      if (subject.transition === "expired" && typeof subject.facts?.intentId === "string")
        expired.add(subject.facts.intentId);
  };
  // E21/R32: observe actual child creation/close; async context also follows sound fallback callbacks.
  const context = new AsyncLocalStorage();
  const childProcess = require("node:child_process");
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function (...args) {
    const attempt = context.getStore();
    const at = clock();
    const handle = originalSpawn.apply(this, args);
    const marker = { attemptId: attempt?.attemptId ?? null, intentId: attempt?.intentId ?? null,
      channel: attempt?.channel ?? "sound", executable: args[0], probe: attempt == null };
    evidence.markers.push({ ...marker, kind: "spawn", clock: at, pid: handle.pid ?? null });
    if (handle.pid != null) {
      const backend = evidence.environment.backendCandidates.find((item) => item.path === args[0]);
      if (backend == null || backend.sha256 == null) executionError = new Error("unrecorded backend");
      else if (!evidence.environment.usedBackends.some((item) => item.path === backend.path))
        evidence.environment.usedBackends.push({ path: backend.path, sha256: backend.sha256 });
      if (attempt != null && !spawned.has(attempt.intentId))
        spawned.set(attempt.intentId, { at: at.monotonicMs, attemptId: attempt.attemptId });
    }
    handle.once("close", (code, signal) => {
      const at = clock();
      if (attempt != null) closed.set(attempt.attemptId, at.monotonicMs);
      evidence.markers.push({ ...marker, kind: "close", clock: at, code, signal });
    });
    return handle;
  };
  const runId = `r33-${Date.now()}`;
  try {
    // Both imports follow instrumentation: composition-root itself imports the adapter.
    const { runNotificationAttempt, abortNotificationAttempt } = require("../../dist/src/notification-delivery/adapter.js");
    const { RuntimeCompositionRoot, linkedUnitCodecs } = require("../../dist/src/runtime/composition-root.js");
    root = new RuntimeCompositionRoot({ appName: "fleq-p2", legacyAppName: "fleq",
      stateDirectory: join(directory, "state"), legacyStateDirectory: join(directory, "legacy"),
      diagnosticDirectory: join(directory, "diagnostics") }, linkedUnitCodecs, {
      clock,
      notificationAdapter: {
        run(attempt, readClock) {
          attempts.push({ attemptId: attempt.attemptId, intentId: attempt.intentId,
            channel: attempt.channel, priorityGroup: attempt.priorityGroup });
          const running = context.run(attempt, () => runNotificationAttempt(attempt, readClock));
          runs.push(running.then((result) => {
            const history = terminals.get(attempt.intentId) ?? [];
            history.push(result);
            terminals.set(attempt.intentId, history);
            return result;
          }));
          return running;
        },
        abort: abortNotificationAttempt,
      },
    });
    const dispatch = root.dispatch.bind(root);
    root.dispatch = (...args) => { const step = dispatch(...args); observe(step); return step; };
    const probe = await root.probeNotificationChannels();
    evidence.environment.probe = probe;
    if (probe.sound.kind !== "idle" || process.platform === "darwin" && probe.desktop.kind !== "idle")
      blocked("backendUnavailable");
    if (process.platform === "linux" && probe.desktop.kind !== "unavailable") blocked("r34DesktopMustBeUnavailable");
    const start = clock();
    const m0 = start.monotonicMs + 1_000;
    evidence.environment.start = start;
    evidence.environment.M0 = m0;
    evidence.environment.W0 = start.wallTimeMs + 1_000;
    observe(root.startRuntime(runId, start, probe));
    started = true;

    // A3-AC11: saving verifies persistence/shutdown; notification start does not wait for it.
    function save() {
      if (savingStopped || savePromise != null) return;
      savePromise = (async () => {
        for (let index = 0; index < 3; index++) {
          const scheduled = root.scheduleCheckpoint(root.state, clock(), runId);
          if (scheduled == null) break;
          if (scheduled.request == null) {
            root.applyCheckpointResult(root.state, scheduled.result, clock());
            continue;
          }
          const correlation = scheduled.measurements[0];
          if (correlation == null) throw new Error("checkpoint correlation unavailable");
          const result = await root.executeCheckpoint(scheduled.request, runId,
            correlation.inputIds, correlation.retryReason);
          root.applyCheckpointResult(root.state, result.result, clock());
        }
      })().catch((error) => { executionError = error; }).finally(() => { savePromise = null; });
    }
    timer = setInterval(() => {
      try { root.tick(root.state, clock()); save(); }
      catch (error) { executionError = error; }
    }, 50);
    for (const [index, material] of materials.entries()) {
      const scheduledAt = m0 + index * 1_000;
      await wait(Math.max(0, scheduledAt - clock().monotonicMs));
      if (executionError != null) throw executionError;
      const at = clock();
      const before = new Set(root.state.units["U-E"].intents.map((item) => item.id));
      const step = root.dispatch(root.state, { kind: "mailboxCompleted", clock: at,
        completion: { kind: "parser", messageId: material.inputId, inputId: material.inputId, runId,
          encodedByteLength: material.decodedByteLength, startedMonotonicMs: at.monotonicMs,
          completedMonotonicMs: at.monotonicMs, inputSequence: index + 1, result: { kind: "decoded", material } } });
      const created = step.state.units["U-E"].intents.filter((item) => !before.has(item.id));
      for (const intent of created) {
        const serial = index + 1;
        const oracle = expected.get(serial);
        const stage = oracle?.expectedStage;
        const opportunity = oracle?.opportunity;
        const payload = intent.payload;
        const payloadValid = Object.keys(payload).sort().join(",") === "body,domain,level,title"
          && payload.domain === "earthquake-eew"
          && payload.level === (opportunity === "cancellation" ? "cancel" : stage === "警報" ? "critical" : "warning")
          && stage != null && payload.title === (opportunity === "cancellation" ? "[取消] 緊急地震速報"
            : `${opportunity === "correction" ? "[訂正] " : ""}緊急地震速報（${stage}）`)
          && validText(payload.body) && (opportunity === "cancellation"
            ? payload.body === "緊急地震速報は取り消されました。"
            : opportunity === "correction" ? payload.body.startsWith("訂正: ")
              : opportunity === "hazardIncrease" ? payload.body.startsWith("続報: ")
                : !/^(?:【訓練】|【試験】|訓練の電文|試験の電文|訂正:|続報:)/.test(payload.body))
          && created.every((other) => other.payload.domain === payload.domain && other.payload.level === payload.level
            && other.payload.title === payload.title && other.payload.body === payload.body);
        evidence.intents.push({ serial, oracleOpportunity: opportunity ?? null, channel: intent.channel,
          intentId: intent.id, createdAtMonotonicMs: at.monotonicMs, payloadValid, disposition: null });
      }
      evidence.reports.push({ serial: index + 1, scheduledAtMonotonicMs: scheduledAt,
        receivedAtMonotonicMs: at.monotonicMs, accepted: step.outcomes.some((outcome) => outcome.kind === "accepted"
          && outcome.change !== "deliveryOnly" && outcome.subjects.some((subject) => subject.source?.inputId === material.inputId)),
        contributesToSave: step.generationInputIds["U-E"]?.includes(material.inputId) ?? false,
        generatedCount: created.length });
      save();
    }
    const pendingUntil = clock().monotonicMs + 20_000;
    while (clock().monotonicMs < pendingUntil) {
      if (executionError != null) throw executionError;
      const intents = root.state.units["U-E"].intents;
      if (savePromise == null && intents.every((item) => item.disposition !== "pending")
        && channels.every((channel) => !["running", "stopping"].includes(root.state.notificationChannels[channel].kind))) break;
      await wait(50);
    }
    savingStopped = true;
    clearInterval(timer); timer = null;
    await savePromise;
    if (executionError != null) throw executionError;
    const finalState = root.state;
    const expectedSet = [...expected.keys()].flatMap((serial) => channels.map((channel) => `${serial}:${channel}`)).sort();
    const actualSet = evidence.intents.map((item) => `${item.serial}:${item.channel}`).sort();
    evidence.generation = { expected: expectedSet, actual: actualSet,
      status: JSON.stringify(actualSet) === JSON.stringify(expectedSet) ? "pass" : "fail" };
    const byChannel = { desktop: [], sound: [] };
    for (const item of evidence.intents) byChannel[item.channel].push(item);
    for (const channel of channels) {
      let predecessor = null;
      for (const item of byChannel[channel]) {
        const first = spawned.get(item.intentId);
        const predecessorFirst = predecessor == null ? null : spawned.get(predecessor.intentId);
        const predecessorClosed = predecessorFirst == null ? null : closed.get(predecessorFirst.attemptId);
        const firstAttempt = attempts.find((attempt) => attempt.attemptId === first?.attemptId);
        const previousAttempt = attempts.find((attempt) => attempt.attemptId === predecessorFirst?.attemptId);
        const competing = predecessorFirst != null && predecessorClosed != null
          && predecessorClosed > item.createdAtMonotonicMs
          && firstAttempt?.priorityGroup === previousAttempt?.priorityGroup;
        Object.assign(item, latency.judgeLatency(item.createdAtMonotonicMs, first?.at,
          competing ? predecessorFirst.at : null, competing ? predecessorClosed : null, competing));
        item.predecessorAttemptId = predecessorFirst?.attemptId ?? null;
        item.predecessorClosedAt = predecessorClosed ?? null;
        item.spawnedAtMonotonicMs = first?.at ?? null;
        item.firstAttemptClosedAtMonotonicMs = first == null ? null : closed.get(first.attemptId) ?? null;
        item.adapterTerminals = terminals.get(item.intentId) ?? [];
        item.lastA1State = adopted.get(item.intentId) ?? null;
        item.disposition = expired.has(item.intentId) ? "expired" : item.lastA1State?.disposition ?? "missing";
        if (first != null) predecessor = item;
      }
    }
    const unavailableDesktop = process.platform === "linux" && probe.desktop.kind === "unavailable";
    if (unavailableDesktop) {
      const desktop = evidence.intents.filter((item) => item.channel === "desktop");
      evidence.unavailable = { channel: "desktop", attemptCount: attempts.filter((item) => item.channel === "desktop").length,
        expiredCount: desktop.filter((item) => item.disposition === "expired").length,
        supersededCount: desktop.filter((item) => item.disposition === "superseded").length,
        expectedCount: desktop.length, pendingAfter: finalState.units["U-E"].intents.filter((item) => item.channel === "desktop" && item.disposition === "pending").length };
    }
    const verdicts = evidence.intents.filter((item) => !unavailableDesktop || item.channel === "sound");
    const complete = verdicts.every((item) => item.status === "pass" && item.disposition === "delivered"
      && item.firstAttemptClosedAtMonotonicMs != null && item.firstAttemptClosedAtMonotonicMs >= item.spawnedAtMonotonicMs
      && item.adapterTerminals.length > 0 && item.adapterTerminals.every((result) => result.kind === "delivered"))
      && (!unavailableDesktop || evidence.unavailable.attemptCount === 0
        && evidence.unavailable.expiredCount + evidence.unavailable.supersededCount === evidence.unavailable.expectedCount && evidence.unavailable.pendingAfter === 0)
      && channels.every((channel) => ["idle", "unavailable"].includes(finalState.notificationChannels[channel].kind));
    evidence.shutdown = await root.shutdownRuntime(root.state, 33, clock());
    evidence.status = evidence.reports.every((report) => report.accepted) && evidence.generation.status === "pass"
      && evidence.intents.every((item) => item.payloadValid) && complete && evidence.shutdown.code === 0 ? "pass" : "fail";
    evidence.reason = evidence.status === "pass" ? null : "generationDeliveryOrShutdownFailed";
  } finally {
    savingStopped = true;
    if (timer != null) clearInterval(timer);
    await savePromise;
    if (started && root.state.shutdown.stage === "running") {
      try { evidence.shutdown = await root.shutdownRuntime(root.state, evidence.reports.length, clock()); }
      catch { /* Keep the original failure. */ }
    }
    try { await Promise.allSettled(runs); }
    finally { childProcess.spawn = originalSpawn; await rm(directory, { recursive: true, force: true }); }
  }
}

let exitCode;
try { await main(); exitCode = evidence.status === "pass" ? 0 : 1; }
catch (error) { evidence.status = error?.blocked ? "blocked" : "fail";
  evidence.reason = error?.blocked ? error.message : "executionFailed";
  exitCode = error?.blocked ? 2 : 1; }
finish(exitCode);
