#!/usr/bin/env node
/**
 * Capture real StandbyScreen layout-gate renders after its measurement epoch settles.
 *
 * Usage:
 *   node scripts/capture-legacy-standby.mjs
 *   CHROME_BIN=chrome node scripts/capture-legacy-standby.mjs --scenario 4 --viewport 1920x1080
 *   node scripts/capture-legacy-standby.mjs --url http://127.0.0.1:5199/preview.html
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPTURE_SCHEMA_VERSION,
  CaptureAssertionError,
  DOCUMENT_CAPTURE_EXPRESSION,
  assertViewportContract,
  canonicalJsonStringify,
  readinessFor,
  runCaptureBrowserSession,
} from "./capture-browser-session.mjs";

const DISPLAY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = join(DISPLAY_DIR, "dist");
const DEFAULT_SCENARIOS = ["quiet", "4", "7", "max", "max-floodWide"];
const SUPPORTED_SCENARIOS = [...DEFAULT_SCENARIOS];
const DEFAULT_VIEWPORTS = ["1920x1080", "1512x982", "1280x720", "960x620"];
const FLOOD_WIDE_VIEWPORTS = ["1920x1080", "1280x720"];
const RECENT_QUAKES_GAP_SUITE = "recent-quakes-gap";
const BRIEFING_PAGING_PAGE_COUNT = 3;
const ATTENTION_VISIBILITY_FIXTURES = new Set(["attention-visibility-standby", "attention-visibility-emergency", "attention-visibility-reduced-motion"]);
const MIME_TYPES = new Map([
  [".css", "text/css"], [".html", "text/html"], [".js", "text/javascript"],
  [".map", "application/json"], [".svg", "image/svg+xml"], [".woff2", "font/woff2"],
]);

function usage(message) {
  if (message != null) process.stderr.write(`${message}\n`);
  process.stderr.write("Usage: node scripts/capture-legacy-standby.mjs [--report] [--write-report PATH] [--assert-capture-report PATH] [--expect-suite normal|design-alignment|recent-quakes-gap|center-stack-pregate] [--expect-viewport-mode legacy-control|calibrated] [--expect-cells N] [--expect-mismatches N] [--verify-legacy-expectation-digest SHA256] [--viewport-mode legacy-control|calibrated] [--suite design-alignment|recent-quakes-gap|center-stack-pregate] [--write-baseline PATH|--baseline-report PATH] [--assert-from PATH] [--fixture overflow|rotation|cluster|cluster-calm|tornado-pages|tornado-aggregate|tornado-clip|tornado-epoch-release|recent-quakes-narrow|attention-visibility-standby|attention-visibility-emergency|attention-visibility-reduced-motion|briefing-pages|briefing-single-page] [--url URL] [--scenario quiet|4|7|max|max-floodWide] [--viewport WIDTHxHEIGHT] [--out-dir PATH]\n");
  process.exitCode = 2;
}

export function parseCaptureArgs(argv) {
  const result = {
    url: null, scenarios: [], viewports: [], outDir: null, report: false, fixture: null, suite: null,
    writeBaseline: null, baselineReport: null, assertFrom: null, viewportMode: "legacy-control", viewportModeExplicit: false,
    writeReport: null, assertCaptureReport: null, verifyLegacyExpectationDigest: null,
    expectSuite: null, expectViewportMode: null, expectCells: null, expectMismatches: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (["--url", "--scenario", "--viewport", "--out-dir", "--fixture", "--suite", "--write-baseline", "--baseline-report", "--assert-from", "--viewport-mode", "--write-report", "--assert-capture-report", "--verify-legacy-expectation-digest", "--expect-suite", "--expect-viewport-mode", "--expect-cells", "--expect-mismatches"].includes(argument)) {
      if (value == null) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--url") result.url = value;
      if (argument === "--scenario") result.scenarios.push(value);
      if (argument === "--viewport") result.viewports.push(value);
      if (argument === "--out-dir") result.outDir = value;
      if (argument === "--fixture") result.fixture = value;
      if (argument === "--suite") result.suite = value;
      if (argument === "--write-baseline") result.writeBaseline = value;
      if (argument === "--baseline-report") result.baselineReport = value;
      if (argument === "--assert-from") result.assertFrom = value;
      if (argument === "--viewport-mode") { result.viewportMode = value; result.viewportModeExplicit = true; }
      if (argument === "--write-report") result.writeReport = value;
      if (argument === "--assert-capture-report") result.assertCaptureReport = value;
      if (argument === "--verify-legacy-expectation-digest") result.verifyLegacyExpectationDigest = value;
      if (argument === "--expect-suite") result.expectSuite = value;
      if (argument === "--expect-viewport-mode") result.expectViewportMode = value;
      if (argument === "--expect-cells") result.expectCells = Number(value);
      if (argument === "--expect-mismatches") result.expectMismatches = Number(value);
      continue;
    }
    if (argument === "--help" || argument === "-h") return null;
    if (argument === "--report") { result.report = true; continue; }
    throw new Error(`unknown argument: ${argument}`);
  }
  if (!["legacy-control", "calibrated"].includes(result.viewportMode)) throw new Error("--viewport-mode must be legacy-control or calibrated");
  for (const [flag, value] of [["--expect-cells", result.expectCells], ["--expect-mismatches", result.expectMismatches]]) {
    if (value != null && (!Number.isInteger(value) || value < 0)) throw new Error(`${flag} must be a non-negative integer`);
  }
  return result;
}

export function viewportModeForSuite(options) {
  return ["design-alignment", RECENT_QUAKES_GAP_SUITE, "center-stack-pregate"].includes(options.suite) && !options.viewportModeExplicit ? "calibrated" : options.viewportMode;
}

function parseViewport(value) {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (match == null) throw new Error(`invalid viewport: ${value}`);
  return { label: value, width: Number(match[1]), height: Number(match[2]) };
}

async function startStaticServer() {
  await stat(join(DIST_DIR, "preview.html"));
  const server = createServer(async (request, response) => {
    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const relativePath = requestPath === "/" ? "preview.html" : requestPath.replace(/^\//, "");
    const pathname = normalize(relativePath);
    const filename = join(DIST_DIR, pathname);
    if (pathname.startsWith("..") || !filename.startsWith(`${DIST_DIR}/`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const contents = await readFile(filename);
      response.writeHead(200, { "content-type": MIME_TYPES.get(extname(filename)) ?? "application/octet-stream" }).end(contents);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("static server did not return a TCP address");
  return {
    url: `http://127.0.0.1:${address.port}/preview.html`,
    close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error == null ? resolveClose() : rejectClose(error))),
  };
}

export const LIVE_GEOMETRY_EXPRESSION = String.raw`(async () => {
        await (document.fonts?.ready ?? Promise.resolve());
        const pick = (selector) => [...document.querySelectorAll(selector)]
          .filter((node) => node.clientWidth > 0 && node.clientHeight > 0)
          .sort((left, right) => right.getBoundingClientRect().width * right.getBoundingClientRect().height - left.getBoundingClientRect().width * left.getBoundingClientRect().height)[0] ?? null;
        const measure = (node) => node == null ? null : (() => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          const chain = [];
          for (let parent = node.parentElement, depth = 0; parent != null && depth < 5; parent = parent.parentElement, depth += 1) chain.push(parent.className.split(" ").slice(0, 2).join("."));
          return {
            clientWidth: node.clientWidth, scrollWidth: node.scrollWidth,
            clientHeight: node.clientHeight, scrollHeight: node.scrollHeight,
            verticalBorderPx: (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(style.borderBottomWidth) || 0),
            width: rect.width, height: rect.height, maxHeight: style.maxHeight, cls: node.className, chain,
            hiddenAncestor: node.closest('[aria-hidden="true"], [hidden], [inert]') != null,
          };
        })();
        const styled = (node, properties) => node == null ? null : (() => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return {
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            ...Object.fromEntries(properties.map((property) => [property, style.getPropertyValue(property)])),
          };
        })();
        const overlap = (left, right) => left == null || right == null ? 0 : (() => {
          const a = left.getBoundingClientRect();
          const b = right.getBoundingClientRect();
          return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        })();
         const panels = [...document.querySelectorAll('.tsunami-panel, .quake-panel')]
           .filter((panel) => panel.clientWidth > 0 && panel.clientHeight > 0)
           .map((panel) => {
             const livePage = panel.querySelector('.page-fade');
             const probePage = panel.querySelector('[data-partition-probe-geometry="true"]');
             const body = livePage?.querySelector('.page-body, .page-list-body') ?? null;
             return {
               kind: panel.classList.contains('tsunami-panel') ? 'tsunami' : 'quake',
               panel: measure(panel),
               body: measure(body),
               chrome: measure(livePage?.querySelector('.page-frame, .page-header') ?? null),
               probeChrome: measure(probePage?.querySelector('.page-frame, .page-header') ?? null),
               probeBody: measure(probePage?.querySelector('.partition-probe-body') ?? null),
               indicatorBodyOverlap: overlap(livePage?.querySelector('.page-dots') ?? null, body),
             };
           });
        const briefingCards = [...document.querySelectorAll('.briefing-card')]
          .map((card) => {
            const shelf = card.closest('.measure-shelf, .center-measure-shelf');
            const surface = card.closest('[data-layout-motion-card]')?.getAttribute('data-layout-motion-card') ?? null;
            const placement = shelf == null
              ? surface?.endsWith(':center') ? 'center' : 'side'
              : shelf.classList.contains('center-measure-shelf') ? 'center' : 'side';
            return {
            shelf: shelf != null,
            placement,
            surface,
            probe: card.hasAttribute('data-page-probe-card'),
            probeFit: card.closest('[data-prefix-measure]')?.getAttribute('data-page-probe-fit') ?? null,
            probeId: card.closest('[data-prefix-measure]')?.getAttribute('data-prefix-measure') ?? null,
            probeComposition: card.closest('[data-prefix-measure]')?.getAttribute('data-page-probe-composition') ?? null,
            page: card.getAttribute('data-card-page') ?? '',
            range: card.getAttribute('data-briefing-page-range') ?? '',
            atomRange: card.querySelector('[data-briefing-page-atom]')?.getAttribute('data-briefing-page-atom-range') ?? '',
            shellHeightPx: Number.parseFloat(card.getAttribute('data-briefing-shell-height-px') ?? ''),
            card: measure(card),
            header: measure(card.querySelector('[data-briefing-card-header]')),
            footer: measure(card.querySelector('[data-card-page-footer]')),
            footerText: card.querySelector('[data-card-page-indicator]')?.textContent ?? '',
            pending: card.getAttribute('data-card-page-pending') ?? '',
            frameLevels: [...card.querySelectorAll('[data-briefing-page-atom-entry]')].map((entry) => entry.getAttribute('data-frame-level') ?? ''),
            entryKeys: [...card.querySelectorAll('[data-briefing-page-atom-entry]')].map((entry) => entry.getAttribute('data-briefing-entry') ?? ''),
            entryFacts: [...card.querySelectorAll('[data-briefing-page-atom-entry]')].map((entry) => ({
              precipitationStats: entry.querySelectorAll('[data-briefing-precipitation-stat]').length,
              precipitationLocations: entry.querySelectorAll('[data-briefing-precipitation-location]').length,
              precipitationAmounts: entry.querySelectorAll('[data-briefing-precipitation-amount]').length,
              precipitationTimes: entry.querySelectorAll('[data-briefing-precipitation-time]').length,
              vpoaHeadlines: entry.querySelectorAll('[data-briefing-vpoa-headline]').length,
              vpoaTokens: entry.querySelectorAll('[data-briefing-vpoa-token]').length,
            })),
            readable: [...card.querySelectorAll('[data-page-probe-readable]')].map(measure),
          };
          });
        const forecastCards = [...document.querySelectorAll('[data-weather-warning-forecast-card]')]
          .map((card) => {
            const shelf = card.closest('.measure-shelf, .center-measure-shelf');
            const atom = card.querySelector('[data-forecast-atom]');
            const footer = card.querySelector('[data-card-page-footer]');
            return {
              shelf: shelf != null,
              surface: card.closest('[data-layout-motion-card]')?.getAttribute('data-layout-motion-card') ?? null,
              page: card.getAttribute('data-card-page') ?? '',
              card: measure(card),
              header: measure(card.querySelector('.standby-card-header')),
              atom: measure(atom),
              footer: measure(footer),
              footerCount: card.querySelectorAll('[data-card-page-footer]').length,
              footerText: card.querySelector('[data-card-page-indicator]')?.textContent ?? '',
              atomFooterOverlap: overlap(atom, footer),
              periodCount: card.querySelectorAll('[data-forecast-period]').length,
              continuation: card.querySelector('.continuation')?.textContent ?? '',
              continuationVisibleCount: [...card.querySelectorAll('.continuation')]
                .filter((node) => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0).length,
            };
          });
        const standbyHeaders = [...document.querySelectorAll('.standby-card-header')].map((header) => {
          const outer = header.closest('.weather-card, .forecast-card, .briefing-card, .heat-card, .flood-card, .flood-wide-card, .typhoon-card, .volcano-card, .quake-card, .quake-replay-card, .tsunami-banner');
          const title = header.querySelector('.standby-card-header__title');
          const meta = header.querySelector('.standby-card-header__meta');
          const headerChildren = [...header.children].map((child, index) => ({
            index,
            kind: child.classList.contains('standby-card-header__title') ? 'title'
              : child.classList.contains('standby-card-header__meta') ? 'meta' : child.className,
            geometry: styled(child, ['display', 'flex', 'flex-shrink', 'overflow', 'text-overflow']),
          }));
          const metaChildren = meta == null ? [] : [...meta.children].map((child, index) => ({
            index,
            kind: child.classList.contains('restored-chip') ? 'restored-chip'
              : child.classList.contains('updated-stamp') ? 'updated-stamp'
                : child.classList.contains('date') ? 'date' : child.className,
            geometry: styled(child, ['display', 'flex-shrink', 'overflow', 'text-overflow']),
          }));
          return {
            card: outer?.className ?? '',
            shelf: outer?.closest('.measure-shelf, .center-measure-shelf') != null,
            outer: styled(outer, ['border-radius', 'overflow']),
            header: styled(header, ['padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'font-size', 'font-weight', 'line-height', 'background-color', 'color', 'border-bottom-width']),
            title: styled(title, ['display', 'flex', 'overflow', 'text-overflow', 'white-space']),
            meta: styled(meta, ['display', 'flex-shrink', 'position', 'overflow']),
            headerChildren,
            titleMetaOverlap: overlap(title, meta),
            metaChildOverlaps: meta == null ? [] : [...meta.children].flatMap((left, index, children) =>
              children.slice(index + 1).map((right) => ({
                left: left.className, right: right.className, overlap: overlap(left, right),
              }))),
            metaChildren,
          };
        });
        const signatureRoot = document.querySelector('.standby');
        const previewRoot = document.querySelector('main.preview-screen');
        const query = new URL(window.location.href).searchParams;
        const parseFiniteAttribute = (name) => {
          const raw = signatureRoot?.getAttribute(name) ?? null;
          const value = raw == null || raw === '' ? null : Number(raw);
          return Number.isFinite(value) ? value : null;
        };
        const candidateCountMap = new Map();
        for (const candidate of document.querySelectorAll('[data-layout-motion-card]')) {
          const key = candidate.getAttribute('data-layout-motion-card') ?? '';
          candidateCountMap.set(key, (candidateCountMap.get(key) ?? 0) + 1);
        }
        const fonts = [...(document.fonts ?? [])]
          .map((font) => ({ family: font.family, style: font.style, weight: font.weight, stretch: font.stretch, status: font.status }))
          .sort((left, right) => {
            const a = [left.family, left.style, left.weight, left.stretch, left.status];
            const b = [right.family, right.style, right.weight, right.stretch, right.status];
            for (let index = 0; index < a.length; index += 1) {
              if (a[index] < b[index]) return -1;
              if (a[index] > b[index]) return 1;
            }
            return 0;
          });
        const payloadAttribute = previewRoot?.getAttribute('data-design-alignment-payload-signature') ?? null;
        const payload = payloadAttribute == null ? {
          gateScenario: query.get('gateScenario'), gateFixture: query.get('gateFixture'),
          rotationTick: query.get('rotationTick'), cardPageTick: query.get('cardPageTick'),
          previewMode: previewRoot?.getAttribute('data-preview-mode') ?? null,
          tier: previewRoot?.getAttribute('data-tier') ?? null,
          backgroundTone: previewRoot?.getAttribute('data-background-tone') ?? null,
        } : JSON.parse(payloadAttribute);
        const signatures = {
          fonts,
          payload,
          candidates: [...candidateCountMap].map(([key, count]) => ({ key, count })).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
          capacity: {
            left: parseFiniteAttribute('data-left-capacity-px'), right: parseFiniteAttribute('data-right-capacity-px'), center: parseFiniteAttribute('data-center-capacity-px'),
            leftNaturalHeight: parseFiniteAttribute('data-left-natural-height-px'), rightNaturalHeight: parseFiniteAttribute('data-right-natural-height-px'), centerNaturalHeight: parseFiniteAttribute('data-center-natural-height-px'),
          },
        };
        return { heat: measure(pick('.heat-card')), tsunamiBanner: measure(pick('.tsunami-banner')), panels, briefingCards, forecastCards, standbyHeaders, signatures };
      })()`;

export function atomicSnapshotExpression(expressions) {
  const entries = Object.entries(expressions);
  if (entries.length === 0 || entries.some(([key, expression]) => !/^[A-Za-z_$][\w$]*$/.test(key) || typeof expression !== "string" || expression === "")) {
    throw new Error("atomic snapshot expressions must be named non-empty JavaScript expressions");
  }
  return `(async () => ({${entries.map(([key, expression]) => `${key}: await (${expression})`).join(",")}}))()`;
}

function withDocumentEvidence(snapshot) {
  const stableDom = snapshot.document.stableDom;
  if (typeof stableDom !== "string") throw new Error("capture document stableDom missing");
  return {
    ...snapshot,
    document: { ...snapshot.document, domSha256: createHash("sha256").update(Buffer.from(stableDom, "utf8")).digest("hex") },
    diagnostics: diagnosticsFromDom(snapshot.document.dom),
  };
}

export async function collectNormalSnapshot({ evaluate }) {
  return withDocumentEvidence(await evaluate(atomicSnapshotExpression({
    document: DOCUMENT_CAPTURE_EXPRESSION,
    liveGeometry: LIVE_GEOMETRY_EXPRESSION,
  })));
}

export const CENTER_STACK_PREGATE_SUITE = "center-stack-pregate";
export const CENTER_STACK_PREGATE_MANIFEST = Object.freeze(
  ["1920x1080", "1280x720", "960x620"].flatMap((viewport) => [1, 2].map((repetition) => ({
    recordKey: `standby-briefing-${viewport}-repeat-${repetition}`,
    scenario: "standby-briefing",
    viewport,
    repetition,
  }))),
);

const CENTER_STACK_PREGATE_EXPRESSION = String.raw`(async () => {
  await (document.fonts?.ready ?? Promise.resolve());
  const rect = (node) => node == null ? null : (() => {
    const value = node.getBoundingClientRect();
    return {
      x: value.x, y: value.y, left: value.left, top: value.top,
      right: value.right, bottom: value.bottom, width: value.width, height: value.height,
      clientWidth: node.clientWidth, clientHeight: node.clientHeight,
      scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight,
    };
  })();
  const union = (boxes) => boxes.length === 0 ? null : {
    x: Math.min(...boxes.map((box) => box.left)),
    y: Math.min(...boxes.map((box) => box.top)),
    left: Math.min(...boxes.map((box) => box.left)),
    top: Math.min(...boxes.map((box) => box.top)),
    right: Math.max(...boxes.map((box) => box.right)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
    width: Math.max(...boxes.map((box) => box.right)) - Math.min(...boxes.map((box) => box.left)),
    height: Math.max(...boxes.map((box) => box.bottom)) - Math.min(...boxes.map((box) => box.top)),
  };
  const identities = (root) => root == null ? [] : [...root.querySelectorAll('[data-recent-quake-id]')]
    .map((node) => node.getAttribute('data-recent-quake-id'));
  const root = document.querySelector('.standby');
  const screenArea = document.querySelector('.screen-area');
  const tickerFrame = document.querySelector('.ticker-frame');
  const tickerRoot = tickerFrame?.querySelector('.ticker') ?? null;
  const tickerRows = [...(tickerFrame?.querySelectorAll('.ticker-row') ?? [])];
  const tickerRowRects = tickerRows.map(rect).filter((value) => value != null);
  const shelfRecent = root?.querySelector('.center-measure-shelf > .quakes-card') ?? null;
  const shelfStats = root?.querySelector('.center-measure-shelf > .instrument-row-wrap') ?? null;
  const liveRecentCandidates = [...(root?.querySelectorAll('[data-layout-motion-card="recent-quakes:center"]') ?? [])];
  const liveRecent = liveRecentCandidates[0] ?? null;
  const liveStats = root?.querySelector('[data-layout-motion-card="stats:center"]') ?? null;
  const liveConnection = root?.querySelector('[data-layout-motion-card="connection:center"]') ?? null;
  const clock = root?.querySelector('.clock-face') ?? null;
  const nankai = root?.querySelector('.nankai-ticker') ?? null;
  const activeLiveSelector = liveRecent?.closest('.clock-landmark') != null
    ? '.clock-landmark [data-layout-motion-card="recent-quakes:center"]'
    : liveRecent?.closest('.center-card-region') != null
      ? '.center-card-region [data-layout-motion-card="recent-quakes:center"]'
      : null;
  const centerWidth = (node) => node == null ? null : ({
    token: getComputedStyle(node).getPropertyValue('--center-width').trim(),
    resolvedPx: node.getBoundingClientRect().width,
  });
  const surface = (node) => node == null ? null : (() => {
    const style = getComputedStyle(node);
    return {
      compressed: node.closest('.standby')?.classList.contains('ladder-compressed') ?? null,
      tokens: Object.fromEntries(['--edge', '--gap', '--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--center-width']
        .map((name) => [name, style.getPropertyValue(name).trim()])),
    };
  })();
  const fonts = [...(document.fonts ?? [])]
    .map((font) => ({ family: font.family, style: font.style, weight: font.weight, stretch: font.stretch, status: font.status }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const attributes = (node, names) => Object.fromEntries(names.map((name) => [name, node?.getAttribute(name) ?? null]));
  const diagnostics = attributes(root, [
    'data-ladder-stage', 'data-layout-unresolved', 'data-measurement-settled',
    'data-measurement-nonconverged', 'data-measurement-epoch', 'data-measurement-pass',
    'data-geometry-violation-count', 'data-center-cluster-hidden',
    'data-placement-left', 'data-placement-right', 'data-placement-center',
    'data-rotation-keys', 'data-rotation-active-key', 'data-rotation-position',
  ]);
  return {
    screenArea: rect(screenArea),
    standby: rect(root),
    ticker: {
      frame: rect(tickerFrame), root: rect(tickerRoot), rows: tickerRowRects, rowUnion: union(tickerRowRects),
    },
    centerStack: {
      clock: rect(clock),
      shelf: { recent: rect(shelfRecent), stats: rect(shelfStats), connection: null },
      live: { recent: rect(liveRecent), stats: rect(liveStats), connection: rect(liveConnection) },
      activeLiveSelector,
      activeLiveCount: liveRecentCandidates.length,
      quakes: {
        shelfIdentities: identities(shelfRecent),
        liveIdentities: identities(liveRecent),
        shelfCount: identities(shelfRecent).length,
        liveCount: identities(liveRecent).length,
        orderMatches: JSON.stringify(identities(shelfRecent)) === JSON.stringify(identities(liveRecent)),
      },
      surface: { shelf: surface(shelfRecent), live: surface(liveRecent) },
      centerWidth: { shelf: centerWidth(shelfRecent), live: centerWidth(liveRecent) },
      nankai: rect(nankai),
      diagnostics,
      plan: {
        stage: diagnostics['data-ladder-stage'],
        placement: {
          left: diagnostics['data-placement-left'],
          right: diagnostics['data-placement-right'],
          center: diagnostics['data-placement-center'],
        },
        rotation: {
          keys: diagnostics['data-rotation-keys'],
          activeKey: diagnostics['data-rotation-active-key'],
          position: diagnostics['data-rotation-position'],
        },
        hidden: diagnostics['data-center-cluster-hidden'],
      },
    },
    fonts: { status: document.fonts?.status ?? null, signature: fonts },
    payload: {
      hash: window.location.hash,
      search: window.location.search,
      previewMode: document.querySelector('.preview-screen')?.getAttribute('data-preview-mode') ?? null,
      tier: document.querySelector('.preview-screen')?.getAttribute('data-tier') ?? null,
      backgroundTone: document.querySelector('.preview-screen')?.getAttribute('data-background-tone') ?? null,
    },
  };
})()`;

export async function collectCenterStackPregateSnapshot({ evaluate }) {
  return withDocumentEvidence(await evaluate(atomicSnapshotExpression({
    document: DOCUMENT_CAPTURE_EXPRESSION,
    pregateGeometry: CENTER_STACK_PREGATE_EXPRESSION,
  })));
}

function gateUrl(baseUrl, scenario, rotationTick = null, fixture = null, cardPageTick = null) {
  const url = new URL(baseUrl);
  url.searchParams.set("nav", "0");
  url.searchParams.set("gateScenario", scenario);
  if (rotationTick != null) url.searchParams.set("rotationTick", String(rotationTick));
  if (fixture != null) url.searchParams.set("gateFixture", fixture);
  // The release of an epoch-held logical appearance consumes one, and only
  // one, dependent page step.  The fixture pins that post-release coordinate.
  if (fixture === "tornado-epoch-release") url.searchParams.set("cardPageTick", "1");
  else if (cardPageTick != null) url.searchParams.set("cardPageTick", String(cardPageTick));
  url.hash = fixture === "attention-visibility-emergency"
    ? fixture
    : fixture === "attention-visibility-reduced-motion"
      ? "standby-attention-visibility-reduced-motion"
      : "legacy-standby-gate";
  return url.toString();
}

function decodeHtmlAttribute(value) {
  return value.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function assertCompletePng(contents) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const iend = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  if (contents.length < signature.length + iend.length || !signature.every((byte, index) => contents[index] === byte) || !iend.every((byte, index) => contents[contents.length - iend.length + index] === byte)) {
    throw new Error("incomplete PNG artifact");
  }
}

function assertCompleteDom(dom) {
  if (!/<\/html>\s*$/i.test(dom)) throw new Error("incomplete DOM artifact");
}

function diagnosticsFromDom(dom) {
  const attributes = [
    "data-ladder-stage", "data-measurement-settled", "data-layout-unresolved", "data-measurement-nonconverged",
    "data-settle-trace",
    "data-rotation-keys", "data-flood-form", "data-expanded-counts", "data-placement-surplus-use",
    "data-left-track-width-px", "data-center-track-width-px", "data-right-track-width-px",
    "data-side-measure-shelf-width-px", "data-center-measure-shelf-width-px",
    "data-left-track-rect-width-px", "data-center-track-rect-width-px", "data-right-track-rect-width-px",
    "data-side-measure-shelf-rect-width-px", "data-center-measure-shelf-rect-width-px",
    "data-clock-horizontal-clipped", "data-clock-children-horizontal-clipped",
    "data-clock-center-delta-x-px", "data-clock-center-delta-y-px",
    "data-clock-seconds-within-cluster", "data-clock-date-within-cluster",
    "data-recent-hypocenters-horizontal-clipped",
    "data-weather-compact-side-height-px", "data-weather-compact-center-height-px",
    "data-center-cluster-hidden", "data-center-fixed-height-px",
    "data-recent-quakes-rect-top-px", "data-recent-quakes-rect-bottom-px",
    "data-nankai-rect-top-px", "data-nankai-rect-bottom-px", "data-recent-quakes-nankai-overlap-px",
    "data-rotation-active-key", "data-rotation-position", "data-rotation-slot-height-px", "data-rotation-indicator-height-px", "data-rotation-compact-max-height-px",
    "data-rotation-card-viewport-rect-height-px", "data-rotation-footer-rect-height-px", "data-rotation-viewport-footer-overlap-px",
    "data-card-overflow-count",
    "data-card-overflow-keys", "data-page-viewport-overflow-keys",
    "data-geometry-violation-count",
    "data-geometry-violation-keys",
    "data-right-track-scroll-height-px", "data-right-track-client-height-px",
    "data-weather-selected-height-px",
    "data-weather-live-height-px",
    "data-weather-probe-height-px", "data-weather-probe-width-px", "data-weather-live-width-px",
    "data-weather-probe-card-height-px", "data-weather-probe-card-width-px", "data-weather-live-card-height-px", "data-weather-live-card-width-px",
    "data-weather-selected-prefix-id",
    "data-typhoon-title-misalignment-px", "data-page-indicator-body-overlap-px", "data-page-indicator-rider-overlap-px",
    "data-flood-visibility-violation-keys", "data-flood-readable-overflow-keys",
    "data-flood-page", "data-flood-page-keys", "data-flood-page-identities", "data-flood-page-infeasible", "data-flood-page-footer", "data-flood-page-visible-count",
    "data-tornado-page", "data-tornado-page-keys", "data-tornado-page-identities", "data-tornado-page-infeasible", "data-tornado-page-footer", "data-tornado-page-visible-count",
    "data-tornado-page-host", "data-tornado-page-mode", "data-tornado-page-pending-appearance",
    "data-weather-warning-forecast-page", "data-weather-warning-forecast-page-keys", "data-weather-warning-forecast-page-identities",
    "data-weather-warning-forecast-page-host", "data-weather-warning-forecast-page-mode",
    "data-typhoon-variant",
    "data-preview-attention-visibility", "data-preview-reduced-motion", "data-preview-mode",
    "data-tsunami-page", "data-tsunami-page-unseen", "data-tsunami-page-infeasible",
    "data-tsunami-partition-stable", "data-tsunami-partition-diagnostic", "data-tsunami-partition-logical-passes",
    "data-quake-page", "data-quake-page-unseen", "data-quake-page-infeasible",
  ];
  const diagnostics = Object.fromEntries(attributes.map((attribute) => {
    const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`${escaped}="([^"]*)"`).exec(dom);
    return [attribute, match == null ? null : decodeHtmlAttribute(match[1])];
  }));
  if (diagnostics["data-preview-mode"] !== "emergency" && diagnostics["data-measurement-settled"] !== "true") throw new Error(`measurement did not settle: ${JSON.stringify(diagnostics)}`);
  return diagnostics;
}

export function captureStableProjection(snapshot) {
  const { dom: _dom, stableDom: _stableDom, ...document } = snapshot.document;
  return { ...snapshot, document };
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

function numberDiagnostic(diagnostics, name) {
  const raw = diagnostics[name];
  if (raw == null || raw === "") throw new Error(`missing numeric diagnostic: ${name}`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name}: expected a numeric diagnostic, got ${diagnostics[name]}`);
  return value;
}

function assertAttentionPage(diagnostics, prefix) {
  const page = diagnostics[`data-${prefix}-page`];
  const match = /^(\d+)\/(\d+)$/.exec(page ?? "");
  if (match == null || Number(match[2]) < 2) throw new Error(`${prefix} multi-page diagnostic missing: ${page}`);
  const unseen = Number(diagnostics[`data-${prefix}-page-unseen`]);
  if (!Number.isInteger(unseen) || unseen < 0 || unseen > Number(match[2])) throw new Error(`${prefix} unseen diagnostic invalid: ${diagnostics[`data-${prefix}-page-unseen`]}`);
  expectEqual(diagnostics[`data-${prefix}-page-infeasible`], "false", `${prefix} infeasible`);
}

function assertEmergencyGeometry(geometry) {
  const panels = geometry?.panels ?? [];
  if (panels.length < 2) throw new Error(`emergency panels were not measurably rendered: ${JSON.stringify(geometry)}`);
  for (const [index, entry] of panels.entries()) {
    for (const [name, box] of Object.entries({ panel: entry.panel, body: entry.body })) {
      if (box == null || box.clientWidth <= 0 || box.clientHeight <= 0
        || box.scrollWidth > box.clientWidth + 1 || box.scrollHeight > box.clientHeight + 1) {
        throw new Error(`emergency ${index} ${name} containment failed: ${JSON.stringify(box)}`);
      }
    }
    if (entry.indicatorBodyOverlap > 0) throw new Error(`emergency ${index} page indicator overlaps body: ${entry.indicatorBodyOverlap}`);
    if (entry.kind !== "tsunami") continue;
    const probeBody = entry.probeBody;
    if (probeBody == null || probeBody.clientWidth <= 0 || probeBody.clientHeight <= 0
      || probeBody.scrollWidth > probeBody.clientWidth + 1 || probeBody.scrollHeight > probeBody.clientHeight + 1) {
      throw new Error(`emergency ${index} probeBody containment failed: ${JSON.stringify(probeBody)}`);
    }
    if (entry.probeChrome == null || entry.chrome == null
      || entry.probeChrome.clientWidth <= 0 || entry.probeChrome.clientHeight <= 0
      || Math.abs(entry.probeChrome.height - entry.chrome.height) > 1) {
      throw new Error(`emergency ${index} probe/live chrome mismatch: ${JSON.stringify(entry)}`);
    }
    if (entry.probeBody == null || entry.body == null
      || Math.abs(entry.probeBody.width - entry.body.width) > 1) {
      throw new Error(`emergency ${index} probe/live body width mismatch: ${JSON.stringify(entry)}`);
    }
  }
}

function assertAttentionVisibilityFixture(dom, diagnostics, fixture, geometry = null, baselineGeometry = null) {
  expectEqual(diagnostics["data-preview-attention-visibility"], "true", "attention fixture marker");
  if (fixture === "attention-visibility-emergency") {
    expectEqual(diagnostics["data-preview-mode"], "emergency", "attention emergency mode");
    assertAttentionPage(diagnostics, "tsunami");
    assertAttentionPage(diagnostics, "quake");
    expectEqual(diagnostics["data-tsunami-partition-stable"], "true", "tsunami partition stable");
    expectEqual(diagnostics["data-tsunami-partition-diagnostic"], "", "tsunami partition diagnostic");
    assertEmergencyGeometry(geometry);
  } else {
    expectEqual(diagnostics["data-preview-mode"], "standby", "attention standby mode");
    if (!dom.includes("data-static-anchor")) throw new Error("attention fixture static anchor missing");
    if (!dom.includes("対象40")) throw new Error("attention fixture Heat 40-area anchor missing");
    const heat = geometry?.heat;
    if (heat == null || heat.clientHeight > 161 || heat.scrollHeight > heat.clientHeight + 1) throw new Error(`Heat live geometry violates 160px containment: ${JSON.stringify(heat)}`);
    const banner = geometry?.tsunamiBanner;
    const baseline = baselineGeometry?.tsunamiBanner;
    if (banner == null || baseline == null || Math.abs(banner.height - baseline.height) > 1) throw new Error(`tsunami banner baseline differs by more than 1px: ${JSON.stringify({ banner, baseline })}`);
    // Svelte scopes the class attribute (e.g. class="magnitude stat-value svelte-…"),
    // so match the leading token rather than the whole attribute value — and require
    // each of the three columns individually so 3 hits of one class cannot mask the rest.
    if (["magnitude", "depth", "time"].some((token) => !new RegExp(`class="${token}(?=["\\s])`).test(dom))) throw new Error("RecentQuakes statistics three columns missing");
    expectEqual(diagnostics["data-preview-reduced-motion"], fixture === "attention-visibility-reduced-motion" ? "true" : null, "attention reduced-motion marker");
  }
}

function assertNarrowGeometry(diagnostics, scenario, viewport) {
  if (viewport.label !== "960x620") return;
  if (scenario === "quiet") expectEqual(diagnostics["data-ladder-stage"], "0", "960px quiet stage");
  // Scenario 7 includes the tornado rider. Its 44vh contract height is
  // reserved before partition confirmation, so at 960px weather joins the
  // rotation slot just as max does.
  if (scenario === "max" || scenario === "7") {
    expectEqual(diagnostics["data-ladder-stage"], "3", `960px scenario-${scenario} stage (§5)`);
    const rotationKeys = scenario === "max"
      ? "weather,weatherWarningForecast,flood,typhoon,volcano,heat"
      : "weather,flood,typhoon,volcano,heat";
    expectEqual(diagnostics["data-rotation-keys"], rotationKeys, `960px scenario-${scenario} rotation set (§5)`);
    expectEqual(diagnostics["data-layout-unresolved"], "false", `960px scenario-${scenario} resolved layout (§5)`);
  }
  if (scenario !== "quiet") expectEqual(diagnostics["data-recent-hypocenters-horizontal-clipped"], "false", "960px recent-quake hypocenter clipping");
  if (scenario !== "quiet" && scenario !== "max") return;
  const left = numberDiagnostic(diagnostics, "data-left-track-width-px");
  const center = numberDiagnostic(diagnostics, "data-center-track-width-px");
  const right = numberDiagnostic(diagnostics, "data-right-track-width-px");
  const sideShelf = numberDiagnostic(diagnostics, "data-side-measure-shelf-width-px");
  const centerShelf = numberDiagnostic(diagnostics, "data-center-measure-shelf-width-px");
  const leftRect = numberDiagnostic(diagnostics, "data-left-track-rect-width-px");
  const centerRect = numberDiagnostic(diagnostics, "data-center-track-rect-width-px");
  const rightRect = numberDiagnostic(diagnostics, "data-right-track-rect-width-px");
  const sideShelfRect = numberDiagnostic(diagnostics, "data-side-measure-shelf-rect-width-px");
  const centerShelfRect = numberDiagnostic(diagnostics, "data-center-measure-shelf-rect-width-px");
  if (left < 280 || right < 280 || leftRect < 280 || rightRect < 280) throw new Error(`960px side track below readable width: ${left}/${right} diag, ${leftRect}/${rightRect} rect`);
  for (const [label, diagnostic, rect] of [["left", left, leftRect], ["center", center, centerRect], ["right", right, rightRect]]) {
    if (Math.abs(diagnostic - rect) > 1) throw new Error(`960px ${label} track diagnostic/rect mismatch: ${diagnostic}/${rect}`);
  }
  if (Math.abs(sideShelf - left) > 1 || Math.abs(sideShelfRect - leftRect) > 1) throw new Error(`960px side shelf/track mismatch: ${sideShelf}/${left} diag, ${sideShelfRect}/${leftRect} rect`);
  if (Math.abs(centerShelf - center) > 1 || Math.abs(centerShelfRect - centerRect) > 1) throw new Error(`960px center shelf/track mismatch: ${centerShelf}/${center} diag, ${centerShelfRect}/${centerRect} rect`);
  expectEqual(diagnostics["data-clock-horizontal-clipped"], "false", "960px clock horizontal clipping");
  expectEqual(diagnostics["data-clock-children-horizontal-clipped"], "false", "960px clock child horizontal clipping");
}

function stageZeroClockMismatches(diagnostics) {
  if (diagnostics["data-ladder-stage"] !== "0") return [];
  const dx = numberDiagnostic(diagnostics, "data-clock-center-delta-x-px");
  const dy = numberDiagnostic(diagnostics, "data-clock-center-delta-y-px");
  return [
    ...(dx <= 1 ? [] : [{ key: "clockCenterDeltaX", expected: "<=1", actual: String(dx) }]),
    ...(dy <= 1 ? [] : [{ key: "clockCenterDeltaY", expected: "<=1", actual: String(dy) }]),
    ...(diagnostics["data-clock-seconds-within-cluster"] === "true" ? [] : [{ key: "clockSecondsWithinCluster", expected: "true", actual: diagnostics["data-clock-seconds-within-cluster"] }]),
    ...(diagnostics["data-clock-date-within-cluster"] === "true" ? [] : [{ key: "clockDateWithinCluster", expected: "true", actual: diagnostics["data-clock-date-within-cluster"] }]),
  ];
}

function assertStageZeroClock(diagnostics) {
  const mismatches = stageZeroClockMismatches(diagnostics);
  if (mismatches.length > 0) throw new Error(`stage-0 clock geometry invalid: ${JSON.stringify(mismatches)}`);
}

function assertNankaiSeparation(diagnostics) {
  const overlap = numberDiagnostic(diagnostics, "data-recent-quakes-nankai-overlap-px");
  if (overlap > 0) throw new Error(`recent-quakes/Nankai overlap: ${overlap}px`);
}

function assertCardContainment(diagnostics) {
  const overflow = numberDiagnostic(diagnostics, "data-card-overflow-count");
  if (overflow !== 0) throw new CaptureAssertionError("CARD_SCROLL_CONTAINMENT", `card scroll containment invalid: ${overflow} overflowing card(s): ${diagnostics["data-card-overflow-keys"]}; paged viewport: ${diagnostics["data-page-viewport-overflow-keys"]}`);
}

export function assertForecastContinuationGeometry(geometry, diagnostics) {
  if (diagnostics["data-rotation-active-key"] !== "weatherWarningForecast") return;
  const cards = geometry?.forecastCards ?? [];
  const visible = cards.filter((entry) => !entry.shelf
    && entry.card?.clientWidth > 0 && entry.card?.clientHeight > 0);
  if (visible.length !== 1) throw new Error(`forecast continuation surface missing: ${JSON.stringify({ visible: visible.length, cards })}`);
  const entry = visible[0];
  const fits = (box) => box != null && box.clientWidth > 0 && box.clientHeight > 0
    && box.scrollWidth <= box.clientWidth + 1 && box.scrollHeight <= box.clientHeight + 1;
  if (!fits(entry.card) || !fits(entry.header) || !fits(entry.atom) || !fits(entry.footer)) {
    throw new Error(`forecast continuation containment failed: ${JSON.stringify(entry)}`);
  }
  if (!/^\d+\/32$/.test(entry.page) || entry.periodCount < 1 || entry.periodCount > 4
    || entry.atomFooterOverlap > 0 || entry.continuationVisibleCount !== 0 || entry.continuation !== ""
    || entry.footerCount !== 1 || entry.footerText !== entry.page || !/^\d+\/32$/.test(entry.footerText)) {
    throw new Error(`forecast continuation contract failed: ${JSON.stringify(entry)}`);
  }
  expectEqual(diagnostics["data-weather-warning-forecast-page"], entry.page, "forecast page diagnostic");
  expectEqual(diagnostics["data-weather-warning-forecast-page-mode"], "logical", "forecast page mode");
}

function assertBriefingPagingFixture(geometry, { expectedPage, expectedFooter, expectedEntryBoundary, expectTokenizedVpoa }) {
  const cards = geometry?.briefingCards ?? [];
  const live = cards.filter((card) => !card.shelf);
  const probes = cards.filter((card) => card.shelf && card.probe);
  if (live.length !== 1 || probes.length === 0) throw new Error(`briefing page atoms missing: ${JSON.stringify({ live: live.length, probes: probes.length })}`);
  const fits = (box) => box != null && box.clientWidth > 0 && box.clientHeight > 0
    && box.scrollWidth <= box.clientWidth + 1 && box.scrollHeight <= box.clientHeight + 1;
  // Match StandbyScreen's probe budget exactly: the declared live shell is
  // border-box, while shelf scrollHeight is padding-box. A natural probe's
  // own clientHeight is not a budget; use the live shell height instead.
  const liveShellHeight = live[0].shellHeightPx;
  const liveShellBorder = live[0].card?.verticalBorderPx ?? Number.NaN;
  if (!Number.isFinite(liveShellHeight) || !Number.isFinite(liveShellBorder)) {
    throw new Error(`briefing live shell budget missing: ${JSON.stringify(live[0])}`);
  }
  const liveShellContentBudget = Math.max(0, liveShellHeight - liveShellBorder);
  const briefingProbeFits = (box) => box != null && box.clientWidth > 0 && box.clientHeight > 0
    && box.scrollWidth <= box.clientWidth + 1
    && box.scrollHeight <= liveShellContentBudget + 1;
  if (live[0].pending !== "false") throw new Error(`briefing live partition remained pending: ${JSON.stringify(live[0])}`);
  if (!fits(live[0].card)) throw new Error(`briefing live card containment failed: ${JSON.stringify(live[0])}`);
  for (const card of [...live, ...probes]) {
    if (card.header == null || card.readable.length === 0 || card.readable.some((readable) => !fits(readable))) {
      throw new Error(`briefing atom readable containment failed: ${JSON.stringify(card)}`);
    }
  }
  for (const probe of probes) {
    if (probe.probeFit !== "true" && probe.probeFit !== "false"
      || briefingProbeFits(probe.card) !== (probe.probeFit === "true")) {
      throw new Error(`briefing probe card fit disagrees with measured result: ${JSON.stringify(probe)}`);
    }
  }
  // side and center shelves can produce the same logical range.  The live
  // card must only be compared with the probe from its actual surface; range
  // alone previously selected the first shelf entry nondeterministically.
  const matchingProbe = probes.find((probe) => probe.placement === live[0].placement
    && probe.range === live[0].range && probe.atomRange === live[0].atomRange);
  // Probes are natural-height measurements while the live card fills its
  // fixed shell, so their outer card heights deliberately differ. Compare the
  // atom itself instead: chrome, entry identity, and every readable body box.
  const sameValues = (left, right) => left.length === right.length
    && left.every((value, index) => value === right[index]);
  const readableHeightsMatch = matchingProbe != null
    && matchingProbe.readable.length === live[0].readable.length
    && matchingProbe.readable.every((readable, index) => {
      const liveReadable = live[0].readable[index];
      return readable != null && liveReadable != null
        && Math.abs(readable.height - liveReadable.height) <= 1;
    });
  if (matchingProbe == null || Math.abs(matchingProbe.card.width - live[0].card.width) > 1
    || !sameValues(matchingProbe.entryKeys, live[0].entryKeys)
    || !sameValues(matchingProbe.frameLevels, live[0].frameLevels)
    || !readableHeightsMatch
    || matchingProbe.header == null || Math.abs(matchingProbe.header.height - live[0].header.height) > 1
    || (matchingProbe.footer == null) !== (live[0].footer == null)
    || matchingProbe.footerText !== live[0].footerText
    || (matchingProbe.footer != null && live[0].footer != null
      && (Math.abs(matchingProbe.footer.width - live[0].footer.width) > 1
        || Math.abs(matchingProbe.footer.height - live[0].footer.height) > 1))) {
    throw new Error(`briefing probe/live atom mismatch: ${JSON.stringify({ live: live[0], matchingProbe })}`);
  }
  if (expectedEntryBoundary) {
    const frameLevels = new Set(probes.flatMap((card) => card.frameLevels));
    if (!frameLevels.has("critical") || !frameLevels.has("warning") || !probes.some((card) => card.frameLevels.length > 1)) {
      throw new Error(`briefing entry chrome boundary missing: ${JSON.stringify(probes)}`);
    }
  }
  if (live[0].page !== expectedPage || (live[0].footer != null) !== expectedFooter
    || !probes.every((card) => (card.footer != null) === expectedFooter)) {
    throw new Error(`briefing page footer contract failed: ${JSON.stringify({ expectedPage, expectedFooter, live: live[0], probes })}`);
  }
  const entryFacts = cards.flatMap((card) => card.entryFacts ?? []);
  if (!entryFacts.some((facts) => facts.precipitationStats > 0 && facts.precipitationLocations > 0
    && facts.precipitationAmounts > 0 && facts.precipitationTimes > 0)
    || expectTokenizedVpoa && (!entryFacts.some((facts) => facts.vpoaHeadlines > 0 && facts.vpoaTokens > 0)
      || entryFacts.some((facts) => facts.vpoaHeadlines > 0 && facts.precipitationStats > 0))) {
    throw new Error(`briefing fact selector contract failed: ${JSON.stringify(entryFacts)}`);
  }
}

function assertRecentQuakesNarrowFixture(diagnostics) {
  expectEqual(diagnostics["data-recent-hypocenters-horizontal-clipped"], "false", "recent-quakes-narrow hypocenter clipping");
}

function assertFloodReadability(diagnostics) {
  const visibilityKeys = diagnostics["data-flood-visibility-violation-keys"];
  if (visibilityKeys == null) throw new Error("flood visibility diagnostic is missing");
  if (visibilityKeys !== "") throw new Error(`flood visibility invalid: ${visibilityKeys}`);
  const overflowKeys = diagnostics["data-flood-readable-overflow-keys"];
  if (overflowKeys == null) throw new Error("flood readability diagnostic is missing");
  if (overflowKeys !== "") throw new Error(`flood readability invalid: ${overflowKeys}`);
}

function assertGeometry(diagnostics, { skipWeatherHeight = false } = {}) {
  const selectedWeather = numberDiagnostic(diagnostics, "data-weather-selected-height-px");
  const liveWeather = numberDiagnostic(diagnostics, "data-weather-live-height-px");
  if (!skipWeatherHeight && selectedWeather > 0 && liveWeather > 0 && Math.abs(selectedWeather - liveWeather) > 1) throw new Error(`weather probe/live height mismatch: ${selectedWeather} != ${liveWeather}`);
  const probeCardWidth = numberDiagnostic(diagnostics, "data-weather-probe-card-width-px");
  const liveCardWidth = numberDiagnostic(diagnostics, "data-weather-live-card-width-px");
  if (!skipWeatherHeight && probeCardWidth > 0 && liveCardWidth > 0 && Math.abs(probeCardWidth - liveCardWidth) > 1) throw new Error(`weather probe/live card-width mismatch: ${probeCardWidth} != ${liveCardWidth}`);
  const violations = numberDiagnostic(diagnostics, "data-geometry-violation-count");
  if (violations !== 0) throw new Error(`card/viewport/clock/nankai geometry invalid: ${violations} violation(s): ${diagnostics["data-geometry-violation-keys"]}`);
  if (numberDiagnostic(diagnostics, "data-typhoon-title-misalignment-px") > 2) throw new Error("typhoon title/location rows are misaligned");
  if (numberDiagnostic(diagnostics, "data-page-indicator-body-overlap-px") > 0) throw new Error("page indicator overlaps its body");
  if (numberDiagnostic(diagnostics, "data-page-indicator-rider-overlap-px") > 0) throw new Error("page indicator overlaps the tornado rider");
}

function assertClusterFixture(diagnostics, { requirePreRotation = false } = {}) {
  const hidden = (diagnostics["data-center-cluster-hidden"] ?? "").split(",");
  if (!hidden.includes("stats")) throw new Error("cluster fixture did not reduce stats");
  expectEqual(diagnostics["data-layout-unresolved"], "false", "cluster fixture resolved layout");
  if (numberDiagnostic(diagnostics, "data-recent-quakes-nankai-overlap-px") !== 0) throw new Error("cluster fixture overlaps Nankai band");
  if (requirePreRotation) {
    // data-center-fixed-height-px is the POST-reduction fixed cluster height:
    // once both stats and recent-quakes are hidden it legitimately reads 0.
    // The non-empty hidden list above already proves there was a cluster to
    // reduce, so only reject when nothing was hidden AND nothing is left.
    if (hidden.filter(Boolean).length === 0 && numberDiagnostic(diagnostics, "data-center-fixed-height-px") <= 0) throw new Error("cluster-calm fixture has no fixed cluster to reduce");
    if (Number(diagnostics["data-ladder-stage"]) > 2) throw new Error(`cluster-calm fixture escaped stage 0–2: ${diagnostics["data-ladder-stage"]}`);
  }
}

function assertClockHandoff(dom, diagnostics) {
  const stage = Number(diagnostics["data-ladder-stage"]);
  const tickerClock = /class="[^"]*ticker-clock[^"]*"/.test(dom);
  const centralAway = /class="[^"]*clock-landmark[^"]*clock-away[^"]*"/.test(dom);
  if (stage === 0 && (tickerClock || centralAway)) throw new Error("stage 0 clock handoff is not exclusive");
  if (stage >= 1 && (!tickerClock || !centralAway)) throw new Error("evacuated clock is not rendered in ticker exclusively");
}

function assertRotationDiagnostics(diagnostics, rotationTick) {
  if (rotationTick == null || diagnostics["data-ladder-stage"] !== "3") return;
  const keys = (diagnostics["data-rotation-keys"] ?? "").split(",").filter(Boolean);
  if (keys.length === 0) throw new Error("stage 3 has no rotation keys");
  const expectedKey = keys[rotationTick % keys.length];
  expectEqual(diagnostics["data-rotation-active-key"], expectedKey, `rotation tick ${rotationTick} active key`);
  expectEqual(diagnostics["data-rotation-position"], `${rotationTick % keys.length + 1}/${keys.length}`, `rotation tick ${rotationTick} position`);
  const slot = numberDiagnostic(diagnostics, "data-rotation-slot-height-px");
  const indicator = numberDiagnostic(diagnostics, "data-rotation-indicator-height-px");
  const compactMax = numberDiagnostic(diagnostics, "data-rotation-compact-max-height-px");
  if (Math.abs(slot - (compactMax + indicator)) > 1) throw new Error(`rotation slot reservation mismatch: ${slot} != ${compactMax} + ${indicator}`);
  const viewport = numberDiagnostic(diagnostics, "data-rotation-card-viewport-rect-height-px");
  const footer = numberDiagnostic(diagnostics, "data-rotation-footer-rect-height-px");
  const overlap = numberDiagnostic(diagnostics, "data-rotation-viewport-footer-overlap-px");
  if (viewport <= 0 || footer <= 0 || overlap > 0) throw new CaptureAssertionError("ROTATION_VIEWPORT_FOOTER_GEOMETRY", `rotation viewport/footer geometry invalid: viewport=${viewport}, footer=${footer}, overlap=${overlap}`);
}

const FLOOD_NONE = { floodForm: "none", floodPage: "0/0", floodPageKeys: "[]", floodPageIdentities: "[]", floodPageFooter: "false", floodVisibleCount: "0", floodInfeasible: "false" };
// 2026-08-23 Chrome observed values. The three forms cover every table cell:
// no rider, permanent weather host, and rotation-hosted weather.
const TORNADO_EXPECTATIONS = {
  none: { tornadoPage: "0/0", tornadoPageKeys: "[]", tornadoPageIdentities: "[]", tornadoInfeasible: "false", tornadoFooter: "false", tornadoVisibleCount: "0", tornadoHost: "", tornadoMode: "real", tornadoPendingAppearance: "false" },
  real: { tornadoPage: "1/1", tornadoPageKeys: '["宮崎県南部平野部"]', tornadoPageIdentities: '["tornado|宮崎県南部平野部|0"]', tornadoInfeasible: "false", tornadoFooter: "false", tornadoVisibleCount: "2", tornadoHost: "weather", tornadoMode: "real", tornadoPendingAppearance: "false" },
  logical: { tornadoPage: "1/1", tornadoPageKeys: '["宮崎県南部平野部"]', tornadoPageIdentities: '["tornado|宮崎県南部平野部|0"]', tornadoInfeasible: "false", tornadoFooter: "false", tornadoVisibleCount: "2", tornadoHost: "weather", tornadoMode: "logical", tornadoPendingAppearance: "false" },
};
const TORNADO_IMPOSSIBLE_AREA = "宮崎県南部平野部（竜巻注意情報の可読性とページ分割を確認するための極端に長い対象地域名）".repeat(8);
const TORNADO_IMPOSSIBLE_KEYS = JSON.stringify([TORNADO_IMPOSSIBLE_AREA]);
const TORNADO_IMPOSSIBLE_IDENTITIES = JSON.stringify([`tornado|${TORNADO_IMPOSSIBLE_AREA}|0`]);
// Dedicated real-Chrome cells, promoted only after observed output was checked
// against the §3.3 / §3.5 pager and infeasible contracts.
const TORNADO_FIXTURE_EXPECTATIONS = Object.freeze({
  "tornado-pages": { "7": { "1280x720": { tornadoPage: "1/5", tornadoPageKeys: '["宮崎県南部平野部","宮崎県北部平野部","鹿児島県大隅地方","熊本県球磨地方","大分県佐伯市"]', tornadoPageIdentities: '["tornado|宮崎県南部平野部|0","tornado|宮崎県北部平野部|0","tornado|鹿児島県大隅地方|0","tornado|熊本県球磨地方|0","tornado|大分県佐伯市|0"]', tornadoInfeasible: "false", tornadoFooter: "true", tornadoVisibleCount: "1", tornadoHost: "weather", tornadoMode: "logical", tornadoPendingAppearance: "false" } } },
  "tornado-aggregate": { "7": { "960x620": { tornadoPage: "1/1", tornadoPageKeys: TORNADO_IMPOSSIBLE_KEYS, tornadoPageIdentities: TORNADO_IMPOSSIBLE_IDENTITIES, tornadoInfeasible: "aggregate", tornadoFooter: "false", tornadoVisibleCount: "0", tornadoHost: "weather", tornadoMode: "logical", tornadoPendingAppearance: "false" } } },
  "tornado-clip": { "7": { "960x620": { tornadoPage: "1/1", tornadoPageKeys: TORNADO_IMPOSSIBLE_KEYS, tornadoPageIdentities: TORNADO_IMPOSSIBLE_IDENTITIES, tornadoInfeasible: "clip", tornadoFooter: "false", tornadoVisibleCount: "0", tornadoHost: "weather", tornadoMode: "logical", tornadoPendingAppearance: "false" } } },
  "tornado-epoch-release": { "7": { "1280x720": { tornadoPage: "2/5", tornadoPageKeys: '["宮崎県南部平野部","宮崎県北部平野部","鹿児島県大隅地方","熊本県球磨地方","大分県佐伯市"]', tornadoPageIdentities: '["tornado|宮崎県南部平野部|0","tornado|宮崎県北部平野部|0","tornado|鹿児島県大隅地方|0","tornado|熊本県球磨地方|0","tornado|大分県佐伯市|0"]', tornadoInfeasible: "false", tornadoFooter: "true", tornadoVisibleCount: "1", tornadoHost: "weather", tornadoMode: "logical", tornadoPendingAppearance: "false" } } },
});
function tornadoExpectation(scenario, viewport) {
  if (scenario === "quiet") return TORNADO_EXPECTATIONS.none;
  return (scenario === "4" && viewport.label === "960x620")
    || (scenario !== "4" && ["1280x720", "960x620"].includes(viewport.label))
    ? TORNADO_EXPECTATIONS.logical
    : TORNADO_EXPECTATIONS.real;
}
const FLOOD_CARD_TWO = { floodForm: "card", floodPage: "1/2", floodPageKeys: '["大淀川","五ヶ瀬川"]', floodPageIdentities: '["氾濫危険情報|大淀川|0|code:8303040001","氾濫警戒情報|五ヶ瀬川|0|code:8303040003"]', floodPageFooter: "true", floodVisibleCount: "2", floodInfeasible: "false" };
const FLOOD_CARD_ONE = { floodForm: "card", floodPage: "1/1", floodPageKeys: '["大淀川"]', floodPageIdentities: '["氾濫危険情報|大淀川|0|code:8303040001"]', floodPageFooter: "false", floodVisibleCount: "3", floodInfeasible: "false" };
const FLOOD_WIDE_EXPECTATIONS = {
  "1920x1080": { stage: "1", rotationKeys: "", typhoonVariant: "compact", floodForm: "card", floodPage: "1/3", floodPageKeys: '["大淀川","五ヶ瀬川","一ツ瀬川"]', floodPageIdentities: '["氾濫発生情報|大淀川|0|code:8303040001","氾濫危険情報|五ヶ瀬川|0|code:8303040003","氾濫警戒情報|一ツ瀬川|0|code:8303040005"]', floodPageFooter: "true", floodVisibleCount: "2", floodInfeasible: "false", expandedCounts: { quake: { count: 4, n: 3 }, weather: { "大雨警報(土砂災害)": { count: 24, n: 0 } } }, surplus: "21" },
  "1280x720": { stage: "3", rotationKeys: "weather,weatherWarningForecast,flood,typhoon,volcano,heat", typhoonVariant: "compact", floodForm: "card", floodPage: "1/2", floodPageKeys: '["大淀川","五ヶ瀬川"]', floodPageIdentities: '["氾濫発生情報|大淀川|0|code:8303040001","氾濫危険情報|五ヶ瀬川|0|code:8303040003"]', floodPageFooter: "true", floodVisibleCount: "0", floodRotationVisibleCount: "2", floodInfeasible: "false", expandedCounts: { quake: { count: 4, n: 3 }, weather: { "大雨警報(土砂災害)": { count: 3, n: 21 } } }, surplus: "0" },
};

// §5 / §11.1 fixed tables. --report emits this comparison without mutating
// either source of truth, so a newly measured table needs an explicit ruling.
const TABLE_EXPECTATIONS = {
  quiet: { "1920x1080": { stage: "0", rotationKeys: "", ...FLOOD_NONE }, "1512x982": { stage: "0", rotationKeys: "", ...FLOOD_NONE }, "1280x720": { stage: "0", rotationKeys: "", ...FLOOD_NONE }, "960x620": { stage: "0", rotationKeys: "", ...FLOOD_NONE } },
  "4": { "1920x1080": { stage: "0", rotationKeys: "", ...FLOOD_NONE }, "1512x982": { stage: "0", rotationKeys: "", ...FLOOD_NONE }, "1280x720": { stage: "2", rotationKeys: "", ...FLOOD_NONE }, "960x620": { stage: "3", rotationKeys: "weather,volcano,heat", ...FLOOD_NONE } },
  "7": { "1920x1080": { stage: "1", rotationKeys: "", ...FLOOD_CARD_TWO }, "1512x982": { stage: "1", rotationKeys: "", ...FLOOD_CARD_TWO }, "1280x720": { stage: "3", rotationKeys: "weather,flood,typhoon,volcano,heat", ...FLOOD_CARD_ONE, floodVisibleCount: "0" }, "960x620": { stage: "3", rotationKeys: "weather,flood,typhoon,volcano,heat", ...FLOOD_CARD_ONE, floodVisibleCount: "0" } },
  max: { "1920x1080": { stage: "1", rotationKeys: "", ...FLOOD_CARD_TWO }, "1512x982": { stage: "2", rotationKeys: "", ...FLOOD_CARD_ONE }, "1280x720": { stage: "3", rotationKeys: "weather,weatherWarningForecast,flood,typhoon,volcano,heat", ...FLOOD_CARD_ONE, floodVisibleCount: "0" }, "960x620": { stage: "3", rotationKeys: "weather,weatherWarningForecast,flood,typhoon,volcano,heat", ...FLOOD_CARD_ONE, floodVisibleCount: "0" } },
};
// §11.1 C, keyed independently of the §5 ladder table. Keeping the measured
// payload here makes --report reject a stage match with stale expansion data.
const UTIL_EXPECTATIONS = {
  // In §11.1's human table "−（不在）" is encoded as the always-emitted
  // diagnostic value "none"; absence is never represented by a missing attr.
  "4": { "1920x1080": ["none", "none", 7, 0, 12, 0, 13, "false"], "1512x982": ["none", "none", 7, 0, 12, 0, 13, "false"], "1280x720": ["none", "none", 7, 0, 12, 0, 13, "false"], "960x620": ["none", "none", 7, 0, 2, 10, 3, "false"] },
  "7": { "1920x1080": ["full", "card", 7, 0, 12, 0, 14, "false"], "1512x982": ["compact", "card", 7, 0, 12, 0, 13, "false"], "1280x720": ["compact", "card", 4, 3, 2, 10, 0, "false"], "960x620": ["compact", "card", 4, 3, 2, 10, 0, "false"] },
  // The forecast card is a fixed-column member before stage 3. Its measured
  // height consumes the former typhoon/quake expansion surplus at wide cells.
  max: { "1920x1080": ["compact", "card", 4, 3, 24, 0, 21, "false"], "1512x982": ["compact", "card", 4, 3, 24, 0, 21, "false"], "1280x720": ["compact", "card", 4, 3, 3, 21, 0, "false"], "960x620": ["compact", "card", 4, 3, 3, 21, 0, "false"] },
};

export function legacyExpectationDigest() {
  const expectations = { TABLE_EXPECTATIONS, UTIL_EXPECTATIONS, FLOOD_WIDE_EXPECTATIONS, TORNADO_EXPECTATIONS, TORNADO_FIXTURE_EXPECTATIONS };
  return createHash("sha256").update(Buffer.from(canonicalJsonStringify(expectations), "utf8")).digest("hex");
}

export function verifyLegacyExpectationDigest(expected) {
  const actual = legacyExpectationDigest();
  if (actual !== expected) throw new Error(`legacy expectation digest mismatch: expected ${expected}, got ${actual}`);
  return actual;
}

const EXPECTED_FAILURE_FIXTURES = new Set(["overflow", "rotation"]);

export function captureExpectationPolicy(fixture, scenario, viewportLabel) {
  if (fixture == null) return "normal-table";
  if (EXPECTED_FAILURE_FIXTURES.has(fixture)) return "expected-failure";
  if (TORNADO_FIXTURE_EXPECTATIONS[fixture]?.[scenario]?.[viewportLabel] != null) return "fixture-table";
  return "fixture-assertions-only";
}

export function tableMismatches(diagnostics, scenario, viewport, fixture = null) {
  const expectationPolicy = captureExpectationPolicy(fixture, scenario, viewport.label);
  if (expectationPolicy === "fixture-assertions-only" || expectationPolicy === "expected-failure") return [];
  const fixtureExpected = fixture == null ? null : TORNADO_FIXTURE_EXPECTATIONS[fixture]?.[scenario]?.[viewport.label];
  const baseExpected = scenario === "max-floodWide"
    ? FLOOD_WIDE_EXPECTATIONS[viewport.label]
    : (() => {
      const base = TABLE_EXPECTATIONS[scenario]?.[viewport.label];
      const util = UTIL_EXPECTATIONS[scenario]?.[viewport.label];
      const combined = base == null || util == null ? base : { ...base, typhoonVariant: util[0], floodForm: util[1], expandedCounts: { quake: { count: util[2], n: util[3] }, weather: { "大雨警報(土砂災害)": { count: util[4], n: util[5] } } }, surplus: String(util[6]), floodInfeasible: util[7] };
      return combined;
    })();
  const expected = fixtureExpected ?? (baseExpected == null ? null : { ...baseExpected, ...tornadoExpectation(scenario, viewport) });
  if (expected == null) return [];
  const rotationActiveKey = diagnostics["data-rotation-active-key"] ?? "";
  const rotationKeys = (diagnostics["data-rotation-keys"] ?? "").split(",").filter(Boolean);
  // Stage 3 keeps every logical pager registered while rendering one rotation
  // member. Visibility counts therefore follow the active host, rather than
  // the tick-0 table cell used to describe the stable partition itself.
  if (fixtureExpected == null && rotationKeys.length > 0) {
    expected.floodVisibleCount = rotationActiveKey === "flood" && baseExpected?.floodForm === "card"
      ? (baseExpected.floodRotationVisibleCount ?? FLOOD_CARD_ONE.floodVisibleCount)
      : "0";
    expected.tornadoVisibleCount = rotationActiveKey === "weather"
      ? tornadoExpectation(scenario, viewport).tornadoVisibleCount
      : "0";
  }
  const observed = {
    stage: diagnostics["data-ladder-stage"], rotationKeys: diagnostics["data-rotation-keys"],
    unresolved: diagnostics["data-layout-unresolved"], nonconverged: diagnostics["data-measurement-nonconverged"],
    centerClusterHidden: diagnostics["data-center-cluster-hidden"], floodForm: diagnostics["data-flood-form"], floodInfeasible: diagnostics["data-flood-page-infeasible"],
    floodPage: diagnostics["data-flood-page"], floodPageKeys: diagnostics["data-flood-page-keys"], floodPageIdentities: diagnostics["data-flood-page-identities"],
    floodPageFooter: diagnostics["data-flood-page-footer"], floodVisibleCount: diagnostics["data-flood-page-visible-count"],
    tornadoPage: diagnostics["data-tornado-page"], tornadoPageKeys: diagnostics["data-tornado-page-keys"], tornadoPageIdentities: diagnostics["data-tornado-page-identities"],
    tornadoInfeasible: diagnostics["data-tornado-page-infeasible"], tornadoFooter: diagnostics["data-tornado-page-footer"], tornadoVisibleCount: diagnostics["data-tornado-page-visible-count"],
    tornadoHost: diagnostics["data-tornado-page-host"], tornadoMode: diagnostics["data-tornado-page-mode"], tornadoPendingAppearance: diagnostics["data-tornado-page-pending-appearance"],
    typhoonVariant: diagnostics["data-typhoon-variant"], expandedCounts: diagnostics["data-expanded-counts"],
    surplus: diagnostics["data-placement-surplus-use"],
  };
  const expectedValues = fixtureExpected == null
    ? { stage: expected.stage, rotationKeys: expected.rotationKeys, unresolved: "false", nonconverged: "false", centerClusterHidden: "" }
    : {};
  for (const key of ["floodForm", "floodInfeasible", "floodPage", "floodPageKeys", "floodPageIdentities", "floodPageFooter", "floodVisibleCount", "typhoonVariant", "expandedCounts", "surplus", ...Object.keys(TORNADO_EXPECTATIONS.none)]) {
    if (expected[key] != null) expectedValues[key] = key === "expandedCounts" ? JSON.stringify(expected[key]) : expected[key];
  }
  return [
    ...Object.entries(expectedValues).flatMap(([key, value]) => observed[key] === value ? [] : [{ key, expected: value, actual: observed[key] }]),
    ...(fixtureExpected == null ? stageZeroClockMismatches(diagnostics) : []),
  ];
}

export function assertCaptureRecordSchemaV2(record, label = "capture record") {
  if (record?.schemaVersion !== CAPTURE_SCHEMA_VERSION) throw new Error(`${label}: schemaVersion must be 2`);
  for (const field of ["requestedBinary", "protocolVersion", "product", "revision", "userAgent", "jsVersion"]) {
    if (typeof record.browser?.[field] !== "string" || record.browser[field] === "") throw new Error(`${label}: browser.${field} missing`);
  }
  if (typeof record.viewport?.label !== "string" || !Number.isFinite(record.viewport?.width) || !Number.isFinite(record.viewport?.height)) throw new Error(`${label}: requested viewport missing`);
  const measured = record.geometry?.viewport;
  if (![measured?.innerWidth, measured?.innerHeight, measured?.devicePixelRatio].every((value) => Number.isFinite(value))) throw new Error(`${label}: measured viewport missing`);
  const readiness = record.geometry?.readiness;
  if (!['standby', 'emergency'].includes(readiness?.kind) || readiness.fontsLoaded !== true || readiness.stableSampleCount !== 2) throw new Error(`${label}: readiness missing`);
  if (readiness.kind === "standby" && readiness.measurementSettled !== true) throw new Error(`${label}: standby readiness incomplete`);
  if (readiness.kind === "emergency" && readiness.measurementSettled !== null) throw new Error(`${label}: emergency readiness invalid`);
  if (!["legacy-control", "calibrated"].includes(record.capture?.viewportMode)) throw new Error(`${label}: capture.viewportMode missing`);
  assertViewportContract(record.capture.viewportMode, record.viewport, measured);
}

function pregateApprox(actual, expected, tolerance, label) {
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ${expected} ±${tolerance}, got ${actual}`);
  }
}

function pregateRequiredDiagnostic(diagnostics, name, label, { allowEmpty = false } = {}) {
  const raw = diagnostics?.[name];
  if (typeof raw !== "string" || (!allowEmpty && raw === "")) throw new Error(`${label}: ${name} missing`);
  return raw;
}

function pregateNonNegativeIntegerDiagnostic(diagnostics, name, label) {
  const raw = pregateRequiredDiagnostic(diagnostics, name, label);
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new Error(`${label}: ${name} must be a canonical non-negative integer`);
  return Number(raw);
}

function pregateStageDiagnostic(diagnostics, label) {
  const raw = pregateRequiredDiagnostic(diagnostics, "data-ladder-stage", label);
  if (!/^[0-3]$/.test(raw)) throw new Error(`${label}: data-ladder-stage must be one of 0, 1, 2, or 3`);
  return Number(raw);
}

function pregateRect(box, label) {
  if (box == null) throw new Error(`${label}: rect missing`);
  for (const key of ["left", "top", "right", "bottom", "width", "height"]) {
    if (!Number.isFinite(box[key])) throw new Error(`${label}.${key}: non-finite rect`);
  }
  return box;
}

function pregateContains(outer, inner, tolerance, label) {
  if (inner.left < outer.left - tolerance || inner.top < outer.top - tolerance
    || inner.right > outer.right + tolerance || inner.bottom > outer.bottom + tolerance) {
    throw new Error(`${label}: inner rect escapes outer rect`);
  }
}

function pregateRectUnion(rects) {
  const boxes = rects.filter((box) => box != null);
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((box) => box.left));
  const top = Math.min(...boxes.map((box) => box.top));
  const right = Math.max(...boxes.map((box) => box.right));
  const bottom = Math.max(...boxes.map((box) => box.bottom));
  return { x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top };
}

function pregateIntersectionArea(left, right) {
  return Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left))
    * Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
}

export function deriveCenterStackPregateMetrics(record) {
  const geometry = record?.geometry;
  const ticker = geometry?.ticker;
  const center = geometry?.centerStack;
  const standby = pregateRect(geometry?.standby, "pregate standby");
  const frame = pregateRect(ticker?.frame, "pregate ticker frame");
  const root = pregateRect(ticker?.root, "pregate ticker root");
  const rowUnion = pregateRect(ticker?.rowUnion, "pregate ticker row union");
  const clock = pregateRect(center?.clock, "pregate clock");
  const recentShelf = pregateRect(center?.shelf?.recent, "pregate recent shelf");
  const recentLive = pregateRect(center?.live?.recent, "pregate recent live");
  const tickerOccupiedRect = pregateRectUnion([frame, root, rowUnion]);
  if (tickerOccupiedRect == null) throw new Error("pregate ticker occupied rect missing");
  const boundaryTopPx = center?.nankai == null ? standby.bottom : pregateRect(center.nankai, "pregate nankai").top;
  const lowerCapacityPx = Math.max(0, boundaryTopPx - clock.bottom);
  const lowerRequiredPx = (center?.shelf?.stats?.height ?? 0) + recentShelf.height;
  const lowerDeficitPx = Math.max(0, lowerRequiredPx - lowerCapacityPx);
  const lowerLiveOverflowPx = Math.max(0, recentLive.bottom - boundaryTopPx);
  const connection = center?.live?.connection;
  const upperCapacityPx = Math.max(0, clock.top - standby.top);
  const upperRequiredPx = connection == null ? 0 : Math.max(0, clock.top - pregateRect(connection, "pregate connection").top);
  const upperDeficitPx = Math.max(0, upperRequiredPx - upperCapacityPx);
  return {
    tickerOccupiedRect,
    tickerOccupiedTop: tickerOccupiedRect.top,
    recentTickerOverlapAreaPx: pregateIntersectionArea(recentLive, tickerOccupiedRect),
    budget: {
      boundaryTopPx,
      lower: { capacityPx: lowerCapacityPx, requiredPx: lowerRequiredPx, deficitPx: lowerDeficitPx, liveOverflowPx: lowerLiveOverflowPx },
      upper: { capacityPx: upperCapacityPx, requiredPx: upperRequiredPx, deficitPx: upperDeficitPx },
    },
  };
}

function assertPregateDerivedFields(record, derived, label) {
  pregateApprox(record.geometry?.ticker?.occupiedTop, derived.tickerOccupiedTop, 1, `${label} ticker occupied top`);
  pregateApprox(record.geometry?.ticker?.recentOverlapAreaPx, derived.recentTickerOverlapAreaPx, 1, `${label} recent/ticker overlap area`);
  const stored = record.geometry?.centerStack?.budget;
  pregateApprox(stored?.boundaryTopPx, derived.budget.boundaryTopPx, 1, `${label} boundary top`);
  for (const side of ["lower", "upper"]) {
    for (const field of ["capacityPx", "requiredPx", "deficitPx"]) {
      pregateApprox(stored?.[side]?.[field], derived.budget[side][field], 1, `${label} ${side} ${field}`);
    }
  }
  pregateApprox(stored?.lower?.liveOverflowPx, derived.budget.lower.liveOverflowPx, 1, `${label} lower live overflow`);
}

function assertPregateRecord(record, label) {
  assertCaptureRecordSchemaV2(record, label);
  if (record.capture?.viewportMode !== "calibrated") throw new Error(`${label}: calibrated capture required`);
  if (typeof record.recordKey !== "string" || record.recordKey === "") throw new Error(`${label}: recordKey missing`);
  if (![1, 2].includes(record.repetition)) throw new Error(`${label}: repetition missing`);
  const viewport = record.geometry.viewport;
  for (const [field, expected] of [["innerWidth", record.viewport.width], ["innerHeight", record.viewport.height], ["clientWidth", record.viewport.width], ["clientHeight", record.viewport.height]]) {
    pregateApprox(viewport[field], expected, 1, `${label} viewport ${field}`);
  }
  if (viewport.devicePixelRatio !== 1) throw new Error(`${label}: DPR must be 1`);
  const readiness = record.geometry.readiness;
  if (readiness.fontsLoaded !== true || readiness.stableSampleCount !== 2 || readiness.measurementSettled !== true) throw new Error(`${label}: stable readiness incomplete`);
  const evidence = record.captureEvidence;
  if (evidence?.stableSampleCount !== 2 || evidence.stableSamplesMatch !== true || evidence.screenshotStateMatch !== true
    || !Array.isArray(evidence.stableSampleHashes) || evidence.stableSampleHashes.length !== 2
    || evidence.stableSampleHashes[0] !== evidence.stableSampleHashes[1]
    || evidence.preScreenshotHash !== evidence.postScreenshotHash) {
    throw new Error(`${label}: screenshot/stable sample evidence incomplete`);
  }
  if (record.geometry.fonts?.status !== "loaded" || !Array.isArray(record.geometry.fonts?.signature)) throw new Error(`${label}: font status/signature missing`);
  const center = record.geometry.centerStack;
  const diagnostics = center?.diagnostics;
  if (diagnostics?.["data-measurement-settled"] !== "true" || diagnostics?.["data-measurement-nonconverged"] !== "false") {
    throw new Error(`${label}: settled/nonconverged diagnostics invalid`);
  }
  if (diagnostics?.["data-layout-unresolved"] !== "false") throw new Error(`${label}: unresolved diagnostic invalid`);
  const stage = pregateStageDiagnostic(diagnostics, label);
  pregateNonNegativeIntegerDiagnostic(diagnostics, "data-measurement-epoch", label);
  pregateNonNegativeIntegerDiagnostic(diagnostics, "data-measurement-pass", label);
  pregateNonNegativeIntegerDiagnostic(diagnostics, "data-geometry-violation-count", label);
  pregateRequiredDiagnostic(diagnostics, "data-center-cluster-hidden", label, { allowEmpty: true });
  for (const name of ["data-placement-left", "data-placement-right", "data-placement-center", "data-rotation-keys"]) {
    pregateRequiredDiagnostic(diagnostics, name, label, { allowEmpty: true });
  }
  for (const name of ["data-rotation-active-key", "data-rotation-position"]) {
    const raw = diagnostics?.[name];
    if (raw != null && typeof raw !== "string") throw new Error(`${label}: ${name} must be a string or null`);
  }
  const expectedPlan = {
    stage: diagnostics["data-ladder-stage"],
    placement: {
      left: diagnostics["data-placement-left"], right: diagnostics["data-placement-right"], center: diagnostics["data-placement-center"],
    },
    rotation: {
      keys: diagnostics["data-rotation-keys"], activeKey: diagnostics["data-rotation-active-key"], position: diagnostics["data-rotation-position"],
    },
    hidden: diagnostics["data-center-cluster-hidden"],
  };
  if (canonicalJsonStringify(center.plan) !== canonicalJsonStringify(expectedPlan)) throw new Error(`${label}: plan evidence mismatch`);
  const screenArea = pregateRect(record.geometry.screenArea, `${label} screenArea`);
  const standby = pregateRect(record.geometry.standby, `${label} standby`);
  const frame = pregateRect(record.geometry.ticker?.frame, `${label} ticker frame`);
  const tickerRoot = pregateRect(record.geometry.ticker?.root, `${label} ticker root`);
  const rows = record.geometry.ticker?.rows;
  if (!Array.isArray(rows) || rows.length !== 2) throw new Error(`${label}: exactly two ticker rows required`);
  rows.forEach((row, index) => pregateContains(frame, pregateRect(row, `${label} ticker row ${index}`), 1, `${label} ticker row ${index}`));
  const rowUnion = pregateRect(record.geometry.ticker?.rowUnion, `${label} ticker row union`);
  pregateContains(frame, tickerRoot, 1, `${label} ticker root`);
  pregateContains(frame, rowUnion, 1, `${label} ticker row union`);
  if (!Number.isFinite(tickerRoot.clientHeight) || !Number.isFinite(tickerRoot.scrollHeight)
    || tickerRoot.scrollHeight > tickerRoot.clientHeight + 1) throw new Error(`${label}: ticker root scroll overflow`);
  pregateApprox(screenArea.bottom, standby.bottom, 1, `${label} screenArea/standby boundary`);
  pregateApprox(standby.bottom, frame.top, 1, `${label} standby/ticker frame boundary`);
  const derived = deriveCenterStackPregateMetrics(record);
  pregateApprox(standby.bottom, derived.tickerOccupiedTop, 1, `${label} standby/ticker occupied boundary`);
  assertPregateDerivedFields(record, derived, label);
  const recentShelf = pregateRect(center?.shelf?.recent, `${label} recent shelf`);
  const recentLive = pregateRect(center?.live?.recent, `${label} recent live`);
  pregateApprox(recentShelf.width, recentLive.width, 1, `${label} recent shelf/live width`);
  pregateApprox(recentShelf.height, recentLive.height, 1, `${label} recent shelf/live height`);
  const quakes = center?.quakes;
  if (!Array.isArray(quakes?.shelfIdentities) || quakes.shelfIdentities.length !== 5
    || quakes.shelfCount !== 5 || quakes.liveCount !== 5 || quakes.orderMatches !== true
    || canonicalJsonStringify(quakes.shelfIdentities) !== canonicalJsonStringify(quakes.liveIdentities)) {
    throw new Error(`${label}: shelf/live quake identity count/order mismatch`);
  }
  const expectedSelector = stage === 0
    ? '.clock-landmark [data-layout-motion-card="recent-quakes:center"]'
    : '.center-card-region [data-layout-motion-card="recent-quakes:center"]';
  if (center.activeLiveCount !== 1 || center.activeLiveSelector !== expectedSelector) throw new Error(`${label}: active live selector mismatch`);
  const shelfSurface = center.surface?.shelf;
  const liveSurface = center.surface?.live;
  if (typeof shelfSurface?.compressed !== "boolean" || typeof liveSurface?.compressed !== "boolean") throw new Error(`${label}: compressed surface evidence missing`);
  if (shelfSurface.compressed !== liveSurface.compressed) throw new Error(`${label}: compressed surface mismatch`);
  const surfaceTokenNames = ["--edge", "--gap", "--space-1", "--space-2", "--space-3", "--space-4", "--space-5", "--center-width"];
  for (const [surfaceName, observed] of [["shelf", shelfSurface], ["live", liveSurface]]) {
    for (const name of surfaceTokenNames) {
      if (typeof observed.tokens?.[name] !== "string" || observed.tokens[name] === "") throw new Error(`${label}: ${surfaceName} surface token ${name} missing`);
    }
  }
  if (canonicalJsonStringify(shelfSurface.tokens) !== canonicalJsonStringify(liveSurface.tokens)) throw new Error(`${label}: computed surface token mismatch`);
  const shelfWidth = center.centerWidth?.shelf;
  const liveWidth = center.centerWidth?.live;
  if (typeof shelfWidth?.token !== "string" || shelfWidth.token === "" || shelfWidth.token !== liveWidth?.token) throw new Error(`${label}: --center-width token mismatch`);
  pregateApprox(shelfWidth.resolvedPx, recentShelf.width, 1, `${label} shelf --center-width`);
  pregateApprox(liveWidth?.resolvedPx, recentLive.width, 1, `${label} live --center-width`);
  return derived;
}

function pregateNumericProjection(value, path = "", result = {}) {
  if (typeof value === "number") result[path] = value;
  else if (Array.isArray(value)) value.forEach((entry, index) => pregateNumericProjection(entry, `${path}[${index}]`, result));
  else if (value != null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) pregateNumericProjection(entry, path === "" ? key : `${path}.${key}`, result);
  }
  return result;
}

function assertPregateRepetitionPair(records, viewport) {
  if (records.length !== 2) throw new Error(`${viewport} repetitions: expected exactly two records`);
  const [first, second] = records;
  const label = `${viewport} repetitions`;
  for (const [field, project] of [
    ["browser", (record) => record.browser],
    ["font signature", (record) => record.geometry.fonts],
    ["payload", (record) => record.geometry.payload],
    ["quake identity/order", (record) => record.geometry.centerStack.quakes],
    ["active surface", (record) => ({ selector: record.geometry.centerStack.activeLiveSelector, surface: record.geometry.centerStack.surface })],
    ["plan", (record) => record.geometry.centerStack.plan],
  ]) {
    if (canonicalJsonStringify(project(first)) !== canonicalJsonStringify(project(second))) throw new Error(`${label}: ${field} mismatch`);
  }
  const left = pregateNumericProjection(first.geometry);
  const right = pregateNumericProjection(second.geometry);
  if (canonicalJsonStringify(Object.keys(left).sort()) !== canonicalJsonStringify(Object.keys(right).sort())) throw new Error(`${label}: numeric field placement mismatch`);
  for (const key of Object.keys(left)) pregateApprox(right[key], left[key], 1, `${label} ${key}`);
}

function pregateGeometryViolationCount(record) {
  return pregateNonNegativeIntegerDiagnostic(
    record.geometry?.centerStack?.diagnostics,
    "data-geometry-violation-count",
    record.recordKey ?? "center-stack-pregate record",
  );
}

function assertPregateManifestRecord(record, entry, label) {
  const expectedViewport = parseViewport(entry.viewport);
  if (record.recordKey !== entry.recordKey || record.scenario !== entry.scenario || record.repetition !== entry.repetition || record.fixture !== null) {
    throw new Error(`${label}: manifest identity mismatch`);
  }
  if (record.viewport?.label !== expectedViewport.label || record.viewport?.width !== expectedViewport.width || record.viewport?.height !== expectedViewport.height) {
    throw new Error(`${label}: manifest viewport mismatch`);
  }
  if (record.urlIdentity !== "/preview.html?nav=0#standby-briefing") throw new Error(`${label}: target URL identity mismatch`);
  const payload = record.geometry?.payload;
  if (payload?.hash !== "#standby-briefing" || payload?.search !== "?nav=0" || payload?.previewMode !== "standby") {
    throw new Error(`${label}: target payload mismatch`);
  }
  if (record.capture?.sessionRole !== "primary") throw new Error(`${label}: primary capture session required`);
}

export function assertCenterStackPregateReport(report) {
  if (report?.schemaVersion !== CAPTURE_SCHEMA_VERSION || report?.suite !== CENTER_STACK_PREGATE_SUITE || !Array.isArray(report.records)) {
    throw new Error("invalid center-stack-pregate report");
  }
  const expectedKeys = CENTER_STACK_PREGATE_MANIFEST.map((entry) => entry.recordKey);
  const actualKeys = report.records.map((record) => record.recordKey);
  if (canonicalJsonStringify(actualKeys) !== canonicalJsonStringify(expectedKeys)) throw new Error("center-stack-pregate manifest coverage/order mismatch");
  const derivedByKey = new Map();
  report.records.forEach((record, index) => {
    const label = `center-stack-pregate record ${index}`;
    assertPregateManifestRecord(record, CENTER_STACK_PREGATE_MANIFEST[index], label);
    derivedByKey.set(record.recordKey, assertPregateRecord(record, label));
  });
  for (const viewport of ["1920x1080", "1280x720", "960x620"]) {
    assertPregateRepetitionPair(report.records.filter((record) => record.viewport.label === viewport), viewport);
  }
  const hd = report.records.filter((record) => record.viewport.label === "1280x720");
  const isN = hd.every((record) => {
    const derived = derivedByKey.get(record.recordKey);
    return record.geometry.centerStack.live.recent.bottom <= derived.tickerOccupiedTop + 1
      && derived.recentTickerOverlapAreaPx === 0 && derived.budget.lower.deficitPx <= 1
      && pregateGeometryViolationCount(record) === 0;
  });
  const isR = hd.every((record) => {
    const derived = derivedByKey.get(record.recordKey);
    return record.geometry.centerStack.live.recent.bottom > derived.tickerOccupiedTop + 1
      && derived.recentTickerOverlapAreaPx > 0 && derived.budget.lower.deficitPx > 1
      && record.geometry.centerStack.diagnostics["data-ladder-stage"] === "0"
      && Math.abs(derived.budget.lower.deficitPx - derived.budget.lower.liveOverflowPx) <= 1;
  });
  if (isN) {
    for (const record of report.records.filter((entry) => entry.viewport.label === "1920x1080")) {
      const derived = derivedByKey.get(record.recordKey);
      if (derived.recentTickerOverlapAreaPx !== 0 || pregateGeometryViolationCount(record) !== 0) throw new Error("1920x1080 N branch geometry gate failed");
    }
    return { branch: "N", records: report.records };
  }
  if (isR) return { branch: "R", records: report.records };
  throw new Error("center-stack-pregate 1280x720 is neither a valid N nor R branch");
}

export function assertCaptureReport(report, expectations = {}) {
  if (report?.schemaVersion !== CAPTURE_SCHEMA_VERSION) throw new Error("capture report wrapper schemaVersion must be 2");
  const suite = report.suite ?? "normal";
  if (expectations.expectSuite != null && suite !== expectations.expectSuite) throw new Error(`capture report suite mismatch: expected ${expectations.expectSuite}, got ${suite}`);
  const records = Array.isArray(report.cells) ? report.cells : Array.isArray(report.records) ? report.records : null;
  if (records == null) throw new Error("capture report records missing");
  records.forEach((record, index) => assertCaptureRecordSchemaV2(record, `${suite} record ${index}`));
  if (expectations.expectViewportMode != null && records.some((record) => record.capture.viewportMode !== expectations.expectViewportMode)) throw new Error(`capture report viewport mode mismatch: expected ${expectations.expectViewportMode}`);
  if (expectations.expectCells != null && records.length !== expectations.expectCells) throw new Error(`capture report cell count mismatch: expected ${expectations.expectCells}, got ${records.length}`);
  for (const [index, record] of records.entries()) {
    const expectedPolicy = ["design-alignment", RECENT_QUAKES_GAP_SUITE, CENTER_STACK_PREGATE_SUITE].includes(suite) ? "fixture-assertions-only" : captureExpectationPolicy(record.fixture, record.scenario, record.viewport.label);
    if (record.expectationPolicy !== expectedPolicy) throw new Error(`${suite} record ${index}: expectation policy mismatch`);
    if (!Array.isArray(record.mismatches)) throw new Error(`${suite} record ${index}: mismatches missing`);
  }
  const mismatchCount = records.reduce((sum, record) => sum + record.mismatches.length, 0);
  if (expectations.expectMismatches != null && mismatchCount !== expectations.expectMismatches) throw new Error(`capture report mismatch count: expected ${expectations.expectMismatches}, got ${mismatchCount}`);
  const pregate = suite === CENTER_STACK_PREGATE_SUITE ? assertCenterStackPregateReport(report) : null;
  return { suite, records, mismatchCount, ...(pregate == null ? {} : { branch: pregate.branch }) };
}

export function standardReportExitCode(records) {
  return records.some((record) => ["normal-table", "fixture-table"].includes(record.expectationPolicy) && record.mismatches.length > 0) ? 1 : 0;
}

export function createStandardReportResult({ results, reportMode, outDir }) {
  const cells = results.filter((result) => result.rotationTick === 0);
  return {
    report: reportMode
      ? { schemaVersion: CAPTURE_SCHEMA_VERSION, suite: "normal", outDir, cells }
      : { schemaVersion: CAPTURE_SCHEMA_VERSION, suite: "normal", outDir, results },
    exitCode: reportMode ? standardReportExitCode(results) : 0,
  };
}

export function createAttentionComparatorRecord({ primaryRecordKey, primaryBrowser, requestedViewport, viewportMode, session, snapshot, urlIdentity }) {
  if (session.capture?.sessionRole !== "comparator") throw new Error("attention comparator sessionRole must be comparator");
  if (session.capture.viewportMode !== viewportMode) throw new Error("attention comparator viewport mode mismatch");
  if (canonicalJsonStringify(session.browser) !== canonicalJsonStringify(primaryBrowser)) throw new Error("attention comparator browser metadata mismatch");
  const record = {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    primaryRecordKey,
    browser: session.browser,
    viewport: requestedViewport,
    // The former source contract was `geometry: attentionGeometry`; schema v2
    // keeps that live payload while adding viewport/readiness at the fixed path.
    geometry: {
      viewport: snapshot.document.viewport,
      readiness: readinessFor(snapshot.document, "standby"),
      ...snapshot.liveGeometry,
    },
    capture: session.capture,
    urlIdentity,
  };
  assertCaptureRecordSchemaV2(record, "attention comparator");
  return record;
}

function assertTableDiagnostics(diagnostics, scenario, viewport, fixture = null) {
  const mismatches = tableMismatches(diagnostics, scenario, viewport, fixture);
  if (mismatches.length > 0) throw new Error(`${viewport.label} scenario-${scenario} table mismatch: ${JSON.stringify(mismatches)}`);
}

function assertFloodWideDiagnostics(diagnostics, scenario, viewport) {
  if (scenario !== "max-floodWide") return;
  const expected = FLOOD_WIDE_EXPECTATIONS[viewport.label];
  if (expected == null) return;
  expectEqual(diagnostics["data-ladder-stage"], expected.stage, `${viewport.label} floodWide stage`);
  expectEqual(diagnostics["data-rotation-keys"], expected.rotationKeys, `${viewport.label} floodWide rotation keys`);
  expectEqual(diagnostics["data-flood-form"], expected.floodForm, `${viewport.label} floodWide form`);
  expectEqual(diagnostics["data-placement-surplus-use"], expected.surplus, `${viewport.label} floodWide surplus`);
  const expandedCounts = JSON.parse(diagnostics["data-expanded-counts"] ?? "null");
  if (JSON.stringify(expandedCounts) !== JSON.stringify(expected.expandedCounts)) throw new Error(`${viewport.label} floodWide expanded counts: expected ${JSON.stringify(expected.expandedCounts)}, got ${JSON.stringify(expandedCounts)}`);
  expectEqual(diagnostics["data-measurement-nonconverged"], "false", `${viewport.label} floodWide convergence`);
  if (viewport.label === "1280x720") expectEqual(diagnostics["data-flood-readable-overflow-keys"], "", "1280x720 flood station/kind readability");
}

async function capture({ chrome, profileDir, url, scenario, viewport, outDir, viewportMode = "legacy-control", rotationTick = null, cardPageTick = null, assertTable = true, fixture = null }) {
  const tickSuffix = rotationTick == null ? "" : `-tick-${rotationTick}`;
  const cardPageTickSuffix = cardPageTick == null ? "" : `-page-tick-${cardPageTick}`;
  const fixtureSuffix = fixture == null ? "" : `-${fixture}`;
  const stem = `legacy-standby-${scenario}-${viewport.label}${fixtureSuffix}${tickSuffix}${cardPageTickSuffix}`;
  const pngPath = join(outDir, `${stem}.png`);
  const jsonPath = join(outDir, `${stem}.json`);
  const readinessKind = fixture === "attention-visibility-emergency" ? "emergency" : "standby";
  const collectSnapshot = collectNormalSnapshot;
  const primarySession = await runCaptureBrowserSession({
    chrome, profileDir, url, requestedViewport: viewport, viewportMode, readinessKind,
    virtualTimeBudgetMs: 10_000, sessionRole: "primary", collectSnapshot, label: stem,
    initialDelayMs: 1_500, sampleDelayMs: 1_500, maxSamples: 15, stableProjection: captureStableProjection,
  });
  const snapshot = primarySession.preScreenshot;
  const dom = snapshot.document.dom;
  const attentionGeometry = snapshot.liveGeometry;
  await rm(pngPath, { force: true });
  await writeFile(pngPath, Buffer.from(primarySession.screenshotData, "base64"));
  assertCompletePng(await readFile(pngPath));
  assertCompleteDom(dom);
  const diagnostics = diagnosticsFromDom(dom);
  const attentionFixture = fixture != null && ATTENTION_VISIBILITY_FIXTURES.has(fixture);
  const clusterFixture = url.includes("gateFixture=cluster");
  const clusterCalmFixture = url.includes("gateFixture=cluster-calm");
  const forecastContinuationCapture = scenario === "max" && viewport.label === "960x620";
  let comparator = null;
  if (attentionFixture) {
    const baselineUrl = new URL(url);
    baselineUrl.search = "nav=0";
    baselineUrl.hash = "standby-cards";
    if (fixture !== "attention-visibility-emergency") {
      const comparatorSession = await runCaptureBrowserSession({
        chrome, profileDir, url: baselineUrl.toString(), requestedViewport: viewport, viewportMode, readinessKind: "standby",
        virtualTimeBudgetMs: 10_000, sessionRole: "comparator", collectSnapshot, label: `${stem}-comparator`,
        initialDelayMs: 1_500, sampleDelayMs: 1_500, maxSamples: 15, stableProjection: captureStableProjection,
      });
      comparator = createAttentionComparatorRecord({
        primaryRecordKey: stem, primaryBrowser: primarySession.browser, requestedViewport: viewport, viewportMode,
        session: comparatorSession, snapshot: comparatorSession.preScreenshot,
        urlIdentity: normalizeDesignAlignmentUrl(baselineUrl.toString()),
      });
    }
    assertAttentionVisibilityFixture(dom, diagnostics, fixture, attentionGeometry, comparator?.geometry ?? null);
  } else if (fixture === "briefing-pages" || fixture === "briefing-single-page") {
    assertBriefingPagingFixture(attentionGeometry, fixture === "briefing-pages"
      ? { expectedPage: `${(cardPageTick ?? 0) + 1}/${BRIEFING_PAGING_PAGE_COUNT}`, expectedFooter: true, expectedEntryBoundary: true, expectTokenizedVpoa: true }
      : { expectedPage: "1/1", expectedFooter: false, expectedEntryBoundary: false, expectTokenizedVpoa: false });
  }
  // EmergencyScreen has no StandbyScreen layout tracks. It instead runs the live panel
  // containment and indicator-overlap checks above; only track-specific probes are inapplicable.
  if (fixture !== "attention-visibility-emergency") {
    if (!clusterFixture) assertNarrowGeometry(diagnostics, scenario, viewport);
    assertNankaiSeparation(diagnostics);
    assertStageZeroClock(diagnostics);
    // With an explicit flood-bearing scenario (for example
    // --scenario 7 --fixture overflow), run this before generic containment so
    // the fixture proves the flood root-clipping diagnostic itself. The default
    // fixture starts at quiet, which has no flood card and intentionally falls
    // through to the generic containment counterexample.
    assertFloodReadability(diagnostics);
    assertCardContainment(diagnostics);
    if (forecastContinuationCapture) assertForecastContinuationGeometry(attentionGeometry, diagnostics);
    if (fixture === "recent-quakes-narrow") assertRecentQuakesNarrowFixture(diagnostics);
    assertGeometry(diagnostics, { skipWeatherHeight: clusterFixture });
    if (clusterFixture) assertClusterFixture(diagnostics, { requirePreRotation: clusterCalmFixture });
    assertClockHandoff(dom, diagnostics);
    if (!clusterFixture) assertRotationDiagnostics(diagnostics, rotationTick);
    if (assertTable && ["normal-table", "fixture-table"].includes(captureExpectationPolicy(fixture, scenario, viewport.label))) {
      assertTableDiagnostics(diagnostics, scenario, viewport, fixture);
      assertFloodWideDiagnostics(diagnostics, scenario, viewport);
    }
  }
  const expectationPolicy = captureExpectationPolicy(fixture, scenario, viewport.label);
  const mismatches = tableMismatches(diagnostics, scenario, viewport, fixture);
  const record = {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    scenario, fixture, rotationTick, cardPageTick, viewport, url, pngPath, jsonPath, diagnostics,
    browser: primarySession.browser,
    capture: primarySession.capture,
    geometry: {
      viewport: snapshot.document.viewport,
      readiness: readinessFor(snapshot.document, readinessKind),
      ...attentionGeometry,
    },
    expectationPolicy, mismatches,
    ...(comparator == null ? {} : { comparator }),
  };
  assertCaptureRecordSchemaV2(record);
  await writeFile(jsonPath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

const DESIGN_ALIGNMENT_CANDIDATE_COUNTS = {
  tsunami: 1, quake: 1, weather: 1, weatherWarningForecast: 1, briefing: 1,
  flood: 1, typhoon: 1, volcano: 1, heat: 1,
};
const DESIGN_ALIGNMENT_RIDER_COUNTS = { tornado: 1, longPeriod: 1, nankaiTrough: 1 };
export const DESIGN_ALIGNMENT_MAX_PLANS = {
  fhdMax: {
    viewport: "1920x1080",
    stage: 0,
    compressed: false,
    captureTickCount: 1,
  },
  hdMax: {
    viewport: "1280x720",
    stage: 3,
    compressed: true,
    captureTickCount: 3,
  },
};
/* 旧 import 利用者向けの hd alias。capture の正本は viewport keyed plans。 */
export const DESIGN_ALIGNMENT_MAX_PLAN = DESIGN_ALIGNMENT_MAX_PLANS.hdMax;
export const DESIGN_ALIGNMENT_COMPRESSED_PLANS = {
  "1280x720": {
    stage: 3,
    placementLeft: ["tsunami", "quake", "weatherWarningForecast"],
    placementRight: ["briefing"],
    placementCenter: ["weather"],
    rotationKeys: ["flood", "typhoon", "volcano", "heat"],
    typhoonVariant: "compact",
    briefingCaptureTick: 0,
    forecastCaptureTick: 0,
    typhoonCaptureTick: 1,
  },
  "960x620": {
    stage: 3,
    placementLeft: ["tsunami", "quake"],
    placementRight: [],
    placementCenter: [],
    rotationKeys: ["weather", "weatherWarningForecast", "briefing", "flood", "typhoon", "volcano", "heat"],
    typhoonVariant: "compact",
    briefingCaptureTick: 2,
    forecastCaptureTick: 1,
    typhoonCaptureTick: 4,
  },
};
export const DESIGN_ALIGNMENT_PAYLOAD_SIGNATURE = {
  weatherWarningForecast: { periodCount: 128, atomCount: 32, maxPeriodsPerAtom: 4, multipleAtomFooter: true },
  briefingFacts: [
    { locationName: "さいたま市", approximation: "approx", value: 100, unit: "mm", visibleText: "約100mm", at: "2026-07-07T14:20:00+09:00", duration: "1時間" },
    { locationName: "美幌町", approximation: "atLeast", value: 120, unit: "mm", visibleText: "120mm以上", at: "2026-07-07T14:25:00+09:00", duration: "1時間" },
  ],
  floodRiverCount: 3,
  typhoon: {
    count: 2, probabilityTyphoonKey: "TC2618", maxFiveDayProbability: 80, activePrefectureCount: 8,
    topPrefectures: [["東京都", 80], ["神奈川県", 70], ["千葉県", 60], ["埼玉県", 50], ["茨城県", 40], ["栃木県", 30]],
    worstArea: ["東京地方", 80],
  },
  volcanoCount: 5,
  heatAreaCount: 30,
};

const DESIGN_ALIGNMENT_FIXTURE_UPDATED_AT = "2026-07-07T14:32:00+09:00";
const DESIGN_ALIGNMENT_FIXTURE_WEATHER_AREAS = [
  "北海道石狩地方", "青森県津軽", "岩手県内陸北部", "宮城県北部", "秋田県沿岸", "山形県最上",
  "福島県会津", "茨城県北部", "栃木県北部", "群馬県北部", "埼玉県秩父地方", "東京都多摩西部",
  "神奈川県西部", "新潟県上越", "富山県東部", "石川県加賀", "福井県嶺北", "長野県北部",
  "岐阜県飛騨", "静岡県西部", "愛知県東部", "三重県北部", "滋賀県北部", "京都府北部",
];

/** Capture-side snapshot of the preview/gate raw inputs.  This intentionally
 * does not consume any card DOM field: those fields are the system under test. */
export const DESIGN_ALIGNMENT_PAGER_FIXTURE_SOURCE = {
  weather: {
    displaySeverity: "officialL3", kind: "大雨警報(土砂災害)",
    shownAreas: DESIGN_ALIGNMENT_FIXTURE_WEATHER_AREAS, omittedAreaCount: 0, compactShownAreaCount: 3,
  },
  tornado: { areas: ["宮崎県南部平野部", "宮崎県北部平野部"] },
  flood: { rivers: [
    { riverKey: "8303040001", riverName: "大淀川", kindName: "氾濫危険情報" },
    { riverKey: "8303040002", riverName: "小丸川", kindName: "氾濫警戒情報" },
    { riverKey: "8303040003", riverName: "五ヶ瀬川", kindName: "氾濫警戒情報" },
  ] },
  volcano: { codes: ["506", "550", "509", "501", "101"] },
  briefing: {
    key: "card:vpbs:design-alignment", title: "富山県気象防災速報（記録的短時間大雨）",
    targetAreaCodes: ["160020", "160010"],
    summaryItems: [{ sourceOrdinal: 0, facts: [
      { kind: "precipitation", locationCode: "11100" },
      { kind: "precipitation", locationCode: "01543" },
    ] }],
  },
  weatherWarningForecast: {
    sourceEventIds: ["preview-vpwp50-21", "preview-vpwp50-22"], updatedAt: DESIGN_ALIGNMENT_FIXTURE_UPDATED_AT,
    groups: [
      {
        keyPrefix: "group21", forecastLabel: "土砂災害（警戒レベル2）の予測", severity: "normal",
        target: { keyPrefix: "targetArea", scope: "area", name: "稚内市", parentAreaName: "稚内市", areaCode: "0121400", localCode: null,
          periods: { prefix: "area", count: 64, offset: 0, tsNum: 1, series: "3h" } },
      },
      {
        keyPrefix: "group22", forecastLabel: "土砂災害（警戒レベル2相当）の予測", severity: "normal",
        target: { keyPrefix: "targetLocal", scope: "local", name: "稚内海岸", parentAreaName: "稚内市", areaCode: "0121400", localCode: "L001",
          periods: { prefix: "local", count: 64, offset: 64, tsNum: 2, series: "24h" } },
      },
    ],
  },
};

function fixturePageIdentity({ kindKey, area, areaCode = null, occurrenceIndex }) {
  const base = `${kindKey}|${area}|${occurrenceIndex}`;
  return areaCode == null || areaCode === "" ? base : `${base}|code:${areaCode}`;
}

function fixtureForecastKey(prefix, index = 0) {
  return `${prefix}_${index.toString(36)}`.padEnd(43, "x").slice(0, 43);
}

function fixtureForecastPeriodLabel(startsAt, endsAt) {
  const parts = (iso) => {
    const value = new Date(Date.parse(iso) + 9 * 60 * 60_000);
    return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate(), hour: String(value.getUTCHours()).padStart(2, "0"), minute: String(value.getUTCMinutes()).padStart(2, "0") };
  };
  const start = parts(startsAt);
  const end = parts(endsAt);
  const short = (value) => `${value.month}月${value.day}日 ${value.hour}:${value.minute}`;
  if (start.year === end.year && start.month === end.month && start.day === end.day) return `${short(start)}–${end.hour}:${end.minute}`;
  if (start.year === end.year) return `${short(start)}–${short(end)}`;
  return `${start.year}年${short(start)}–${end.year}年${short(end)}`;
}

function fixtureForecastPeriods({ prefix, count, offset, tsNum, series }) {
  return Array.from({ length: count }, (_, index) => {
    const startsAt = new Date(Date.UTC(2026, 8, 1, 0) + (offset + index) * 2 * 60 * 60_000).toISOString();
    const endsAt = new Date(Date.parse(startsAt) + 60 * 60_000).toISOString();
    const pagerAnchorOrdinal = Math.floor(index / 4);
    return {
      key: fixtureForecastKey(`${prefix}period`, index), label: fixtureForecastPeriodLabel(startsAt, endsAt),
      startsAt, endsAt, tsNum, series, pagerAnchorKey: fixtureForecastKey(`${prefix}anchor`, pagerAnchorOrdinal),
      pagerAnchorOrdinal, pagerSlot: index % 4,
    };
  });
}

function fixtureForecastTargetLabel(target) {
  const parent = target.areaCode == null ? target.parentAreaName : `${target.parentAreaName}（${target.areaCode}）`;
  if (target.scope === "area") return parent;
  const local = target.localCode == null ? target.name : `${target.name}（${target.localCode}）`;
  return `${parent} / ${local}`;
}

function buildFixtureForecastAtoms(source) {
  const atoms = source.groups.flatMap((groupSource) => {
    const group = { key: fixtureForecastKey(groupSource.keyPrefix), forecastLabel: groupSource.forecastLabel, severity: groupSource.severity };
    const target = { ...groupSource.target, key: fixtureForecastKey(groupSource.target.keyPrefix) };
    const byAnchor = new Map();
    for (const period of fixtureForecastPeriods(groupSource.target.periods)) {
      const values = byAnchor.get(period.pagerAnchorKey) ?? [];
      values.push(period);
      byAnchor.set(period.pagerAnchorKey, values);
    }
    return [...byAnchor].sort((left, right) => left[1][0].pagerAnchorOrdinal - right[1][0].pagerAnchorOrdinal).map(([pagerAnchorKey, periods]) => ({
      identity: JSON.stringify([group.key, target.key, pagerAnchorKey]),
      label: `${group.forecastLabel} / ${fixtureForecastTargetLabel(target)}`,
      group, target, periods, pagerAnchorKey, pagerAnchorOrdinal: periods[0].pagerAnchorOrdinal,
    }));
  });
  return atoms.map((atom, index) => ({
    identity: atom.identity,
    fingerprint: JSON.stringify([
      atom.group.key, atom.target.key, atom.label, atom.pagerAnchorKey, atom.pagerAnchorOrdinal, atom.group.severity,
      ...atom.periods.map((period) => [period.key, period.label, period.startsAt, period.endsAt, period.tsNum, period.series, period.pagerSlot]),
      `続き ${index + 1}/${atoms.length}`,
    ]),
  }));
}

function cloneFixtureSequence(items) {
  return items.map((item) => Array.isArray(item) ? [...item] : item);
}

function pagerOracle(key, logicalItems, { logicalFingerprints = logicalItems, resetItems = logicalItems, kindKeys = null } = {}) {
  return {
    namespace: "card-page-coordinator",
    key,
    logicalItems: cloneFixtureSequence(logicalItems),
    logicalFingerprints: cloneFixtureSequence(logicalFingerprints),
    resetItems: cloneFixtureSequence(resetItems),
    sourceCount: logicalItems.length,
    kindKeys: kindKeys == null ? null : [...kindKeys],
  };
}

function buildFixtureWeatherPagerOracle(source, shownAreaCount = source.shownAreas.length) {
  const shownAreas = source.shownAreas.slice(0, shownAreaCount);
  const weatherKindKey = `${source.displaySeverity}|${source.kind}`;
  const weatherItems = [
    ...shownAreas.map((area, occurrenceIndex) => fixturePageIdentity({ kindKey: weatherKindKey, area, occurrenceIndex })),
    ["omittedAreaCount", weatherKindKey, source.omittedAreaCount + source.shownAreas.length - shownAreas.length],
  ];
  return pagerOracle("weather", weatherItems, { resetItems: weatherItems, kindKeys: [weatherKindKey] });
}

function buildDesignAlignmentPagerOracles(source) {
  const tornadoOccurrences = new Map();
  const tornadoItems = source.tornado.areas.map((area) => {
    const occurrenceIndex = tornadoOccurrences.get(area) ?? 0;
    tornadoOccurrences.set(area, occurrenceIndex + 1);
    return fixturePageIdentity({ kindKey: "tornado", area, occurrenceIndex });
  });
  const floodOccurrences = new Map();
  const floodItems = source.flood.rivers.map((river) => {
    const occurrenceKey = `${river.kindName}\0${river.riverName}`;
    const occurrenceIndex = floodOccurrences.get(occurrenceKey) ?? 0;
    floodOccurrences.set(occurrenceKey, occurrenceIndex + 1);
    return fixturePageIdentity({ kindKey: river.kindName, area: river.riverName, areaCode: river.riverKey, occurrenceIndex });
  });
  const briefingContext = /^(.+?[都道府県])気象防災速報/.exec(source.briefing.title)?.[1];
  if (briefingContext == null) throw new Error("design-alignment Briefing fixture title has no prefecture context");
  const briefingItems = [
    ...source.briefing.summaryItems.map((item) => `${source.briefing.key}:lead:lead:${item.sourceOrdinal}:0`),
    `${source.briefing.key}:areaContext:prefecture-context:0`,
    `${source.briefing.key}:area:area:${source.briefing.targetAreaCodes.join(",")}:0`,
    `${source.briefing.key}:meta:meta:0`,
    ...source.briefing.summaryItems.flatMap((item) => item.facts.map((fact, index) =>
      `${source.briefing.key}:fact:fact:${item.sourceOrdinal}:${fact.kind}:${fact.locationCode}:${index}:0`)),
  ];
  const forecastAtoms = buildFixtureForecastAtoms(source.weatherWarningForecast);
  const forecastItems = forecastAtoms.map((atom) => atom.identity);
  return {
    weather: buildFixtureWeatherPagerOracle(source.weather),
    tornado: pagerOracle("tornado", tornadoItems, { resetItems: source.tornado.areas }),
    weatherWarningForecast: pagerOracle("weatherWarningForecast", forecastItems, {
      logicalFingerprints: forecastAtoms.map((atom) => atom.fingerprint),
      resetItems: [...source.weatherWarningForecast.sourceEventIds, source.weatherWarningForecast.updatedAt],
    }),
    briefing: pagerOracle("briefing", briefingItems),
    flood: pagerOracle("flood", floodItems, { resetItems: source.flood.rivers.map((river) => river.riverKey) }),
    volcano: pagerOracle("volcano", source.volcano.codes.map((code) => `volcano:${code}|summary`)),
  };
}

export const DESIGN_ALIGNMENT_PAGER_ORACLES = buildDesignAlignmentPagerOracles(DESIGN_ALIGNMENT_PAGER_FIXTURE_SOURCE);
const DESIGN_ALIGNMENT_COMPACT_WEATHER_PAGER_ORACLE = buildFixtureWeatherPagerOracle(
  DESIGN_ALIGNMENT_PAGER_FIXTURE_SOURCE.weather,
  DESIGN_ALIGNMENT_PAGER_FIXTURE_SOURCE.weather.compactShownAreaCount,
);

const WEATHER_AUTO_PAGE_IDENTITY = "officialL3|大雨警報(土砂災害)|北海道石狩地方|0";
export const DESIGN_ALIGNMENT_WEATHER_AUTO_PROBES = {
  weatherAutoFooterNormal: {
    viewport: "1280x720", compressed: false,
    forcedRange: { start: 0, end: 1, tails: [], omittedAreaCount: 0 },
    page: "1/1", pageCount: 1, pageIdentities: [WEATHER_AUTO_PAGE_IDENTITY],
    activeIdentity: WEATHER_AUTO_PAGE_IDENTITY, pageKey: WEATHER_AUTO_PAGE_IDENTITY,
    naturalHeightDelta: 25,
  },
  weatherAutoFooterCompressed: {
    viewport: "1280x720", compressed: true,
    forcedRange: { start: 0, end: 1, tails: [], omittedAreaCount: 0 },
    page: "1/1", pageCount: 1, pageIdentities: [WEATHER_AUTO_PAGE_IDENTITY],
    activeIdentity: WEATHER_AUTO_PAGE_IDENTITY, pageKey: WEATHER_AUTO_PAGE_IDENTITY,
    naturalHeightDelta: 21,
  },
};

const DESIGN_ALIGNMENT_ALL_PAGER_CAPTURE_KEYS = ["weather", "tornado", "weatherWarningForecast", "briefing", "flood", "volcano"];
export const DESIGN_ALIGNMENT_PAGER_CAPTURE_KEYS_BY_SCENARIO = {
  "standby-briefing-design-alignment": ["briefing"],
  "standby-vpwp50-forecast": ["weatherWarningForecast"],
  "standby-vpta50-probability-muted": [],
  "standby-vpta50-probability-normal": [],
  weatherAutoFooterNormal: [],
  weatherAutoFooterCompressed: [],
  "standby-design-alignment-compressed": DESIGN_ALIGNMENT_ALL_PAGER_CAPTURE_KEYS,
  "legacy-standby-gate": ["weather", "tornado", "weatherWarningForecast", "flood", "volcano"],
};

function designAlignmentEntry(scenario, viewport, rotationTick = null, cardPageTick = null, query = null) {
  const pagerCaptureKeys = DESIGN_ALIGNMENT_PAGER_CAPTURE_KEYS_BY_SCENARIO[scenario];
  if (pagerCaptureKeys == null) throw new Error(`design-alignment pager capture keys missing for scenario: ${scenario}`);
  return { scenario, viewport, rotationTick, cardPageTick, query, pagerCaptureKeys: [...pagerCaptureKeys] };
}

export const DESIGN_ALIGNMENT_MANIFEST = [
  ...[0, 1, 2].map((page) => designAlignmentEntry("standby-briefing-design-alignment", "1280x720", null, page)),
  ...[0, 16].map((page) => designAlignmentEntry("standby-vpwp50-forecast", "1280x720", null, page)),
  designAlignmentEntry("standby-vpta50-probability-muted", "1280x720", null, 0),
  designAlignmentEntry("standby-vpta50-probability-normal", "1280x720", null, 0),
  ...Object.entries(DESIGN_ALIGNMENT_WEATHER_AUTO_PROBES).map(([scenario, probe]) =>
    designAlignmentEntry(scenario, probe.viewport, null, 0)),
  ...["1280x720", "960x620"].flatMap((viewport) => {
    const plan = DESIGN_ALIGNMENT_COMPRESSED_PLANS[viewport];
    return [
      ...plan.rotationKeys.map((_, tick) => designAlignmentEntry("standby-design-alignment-compressed", viewport, tick, 0)),
      designAlignmentEntry("standby-design-alignment-compressed", viewport, plan.briefingCaptureTick, 1),
      designAlignmentEntry("standby-design-alignment-compressed", viewport, plan.briefingCaptureTick, 2),
      designAlignmentEntry("standby-design-alignment-compressed", viewport, plan.forecastCaptureTick, 16),
    ];
  }),
  ...Object.entries(DESIGN_ALIGNMENT_MAX_PLANS).flatMap(([planKey, plan]) =>
    Array.from({ length: plan.captureTickCount }, (_, tick) => designAlignmentEntry("legacy-standby-gate", plan.viewport, tick, 0, `gateScenario=max&maxPlan=${planKey}`))),
];

const RECENT_QUAKES_GAP_TARGETS = [
  { name: "fhdMax", scenario: "legacy-standby-gate", viewport: "1920x1080", maxPlan: "fhdMax", narrow: false },
  { name: "hdMax", scenario: "legacy-standby-gate", viewport: "1280x720", maxPlan: "hdMax", narrow: false },
  {
    name: "compressed960", scenario: "standby-design-alignment-compressed", viewport: "960x620", maxPlan: null, narrow: true,
    stage: 3, compressed: true, resolvedSpaces: { resolvedSpace1: 2, resolvedSpace2: 4, resolvedSpace3: 6 },
  },
];

function matchesRecentQuakesGapTarget(value, target) {
  const viewport = typeof value.viewport === "string" ? value.viewport : value.viewport?.label;
  return value.scenario === target.scenario && viewport === target.viewport
    && value.rotationTick === 0 && value.cardPageTick === 0
    && new URLSearchParams(value.query ?? "").get("maxPlan") === target.maxPlan;
}

export const RECENT_QUAKES_GAP_MANIFEST = RECENT_QUAKES_GAP_TARGETS.map((target) => {
  const matches = DESIGN_ALIGNMENT_MANIFEST.filter((entry) => matchesRecentQuakesGapTarget(entry, target));
  if (matches.length !== 1) throw new Error(`${target.name}: expected exactly one shared design-alignment cell, got ${matches.length}`);
  return matches[0];
});

function manifestKey(value) {
  const viewport = typeof value.viewport === "string" ? value.viewport : value.viewport?.label;
  return [value.scenario, viewport, value.rotationTick ?? "-", value.cardPageTick ?? "-", value.query ?? ""].join("|");
}

const DESIGN_ALIGNMENT_MANIFEST_BY_KEY = new Map(DESIGN_ALIGNMENT_MANIFEST.map((entry) => [manifestKey(entry), entry]));

function expectedPagerCaptureKeysForRecord(record) {
  const key = record.manifestKey ?? manifestKey(record);
  const entry = DESIGN_ALIGNMENT_MANIFEST_BY_KEY.get(key);
  if (entry == null) throw new Error(`${key}: pager captureKey manifest entry missing`);
  return entry.pagerCaptureKeys;
}

export function normalizeDesignAlignmentUrl(value) {
  const url = new URL(value);
  return `${url.pathname}${url.search}${url.hash}`;
}

function designAlignmentUrl(baseUrl, entry) {
  const url = new URL(baseUrl);
  url.searchParams.set("nav", "0");
  if (entry.query != null) {
    for (const [key, value] of new URLSearchParams(entry.query)) url.searchParams.set(key, value);
  }
  if (entry.rotationTick != null) url.searchParams.set("rotationTick", String(entry.rotationTick));
  if (entry.cardPageTick != null) url.searchParams.set("cardPageTick", String(entry.cardPageTick));
  url.hash = entry.scenario;
  return url.toString();
}

export const DESIGN_ALIGNMENT_REPORT_EXPRESSION = String.raw`(async () => {
  await (document.fonts?.ready ?? Promise.resolve());
  const root = document.querySelector('.standby');
  const preview = document.querySelector('main.preview-screen');
  if (root == null || preview == null) return { ready: false, reason: 'standby root missing' };
  const all = (selector, parent = document) => [...parent.querySelectorAll(selector)];
  const numeric = (value) => {
    const parsed = Number.parseFloat(value ?? '');
    return Number.isFinite(parsed) ? parsed : null;
  };
  const attrNumber = (name) => numeric(root.getAttribute(name));
  const splitAttr = (name) => (root.getAttribute(name) ?? '').split(',').filter(Boolean);
  const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
  const compactText = (value) => clean(value).replace(/\s+/g, '');
  const jsonAttr = (node, name, fallback = null) => {
    const raw = node?.getAttribute?.(name);
    if (raw == null) return fallback;
    try { return JSON.parse(raw); } catch { return { parseError: raw }; }
  };
  const rect = (node) => {
    if (node == null) return null;
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
  };
  const lineCount = (node) => {
    if (node == null) return null;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rows = [];
    for (const box of range.getClientRects()) {
      if (box.width <= 0 || box.height <= 0) continue;
      const row = rows.find((candidate) => box.top < candidate.bottom - 1 && box.bottom > candidate.top + 1);
      if (row == null) rows.push({ top: box.top, bottom: box.bottom });
      else {
        row.top = Math.min(row.top, box.top);
        row.bottom = Math.max(row.bottom, box.bottom);
      }
    }
    return rows.length;
  };
  const measure = (node) => {
    if (node == null) return null;
    const style = getComputedStyle(node);
    return {
      rect: rect(node), clientWidth: node.clientWidth, scrollWidth: node.scrollWidth,
      clientHeight: node.clientHeight, scrollHeight: node.scrollHeight,
      overflowX: Math.max(0, node.scrollWidth - node.clientWidth),
      overflowY: Math.max(0, node.scrollHeight - node.clientHeight),
      borderTop: numeric(style.borderTopWidth) ?? 0, borderRight: numeric(style.borderRightWidth) ?? 0,
      borderBottom: numeric(style.borderBottomWidth) ?? 0, borderLeft: numeric(style.borderLeftWidth) ?? 0,
    };
  };
  const textMeasure = (node) => node == null ? null : {
    ...measure(node), text: clean(node.textContent), compactText: compactText(node.textContent), lineCount: lineCount(node),
    fontSize: numeric(getComputedStyle(node).fontSize), fontWeight: getComputedStyle(node).fontWeight,
    fontVariantNumeric: getComputedStyle(node).fontVariantNumeric,
  };
  const overlap = (left, right) => {
    if (left == null || right == null) return 0;
    const a = left.getBoundingClientRect(), b = right.getBoundingClientRect();
    return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
      * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  };
  const painted = (node) => node != null && node.closest('[hidden], [aria-hidden="true"], [inert]') == null
    && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
  const liveHosts = all('[data-layout-motion-card]', root).filter(painted);
  const componentSelectors = {
    tsunami: '.tsunami-banner', quake: '.quake-card', weather: '.weather-card',
    weatherWarningForecast: '[data-weather-warning-forecast-card]', briefing: '[data-briefing-card]',
    flood: '.flood-card, .flood-wide-card', typhoon: '.typhoon-card', volcano: '.volcano-card', heat: '.heat-card',
  };
  const componentIn = (parent, kind) => parent?.matches?.(componentSelectors[kind]) ? parent : parent?.querySelector?.(componentSelectors[kind]) ?? null;
  const liveComponent = (kind) => {
    for (const host of liveHosts) {
      const key = (host.getAttribute('data-layout-motion-card') ?? '').split(':')[0];
      if (key === kind) return componentIn(host, kind);
    }
    return null;
  };
  const sideShelf = root.querySelector(':scope > .measure-shelf');
  const compactMeasureItems = sideShelf == null ? [] : all(':scope > .measure-item[data-measure-variant="compact"]', sideShelf);
  const candidateCounts = {};
  const measurementWidths = {};
  for (const item of compactMeasureItems) {
    const kind = Object.keys(componentSelectors).find((candidate) => componentIn(item, candidate) != null) ?? null;
    if (kind == null) continue;
    candidateCounts[kind] = (candidateCounts[kind] ?? 0) + 1;
    measurementWidths[kind] = componentIn(item, kind).getBoundingClientRect().width;
  }
  const visibleCards = liveHosts.map((host) => {
    const token = host.getAttribute('data-layout-motion-card') ?? '';
    const boundary = token.lastIndexOf(':');
    const key = boundary < 0 ? token : token.slice(0, boundary);
    const surface = boundary < 0 ? '' : token.slice(boundary + 1);
    const component = componentIn(host, key);
    return { key, surface, host: measure(host), component: measure(component) };
  });
  const fragment = (node) => textMeasure(node);
  const briefingCard = liveComponent('briefing');
  const briefing = briefingCard == null ? null : (() => {
    const pageAtom = briefingCard.querySelector('[data-briefing-page-atom]');
    const pageAtomStyle = pageAtom == null ? null : getComputedStyle(pageAtom);
    const cardStyle = getComputedStyle(briefingCard);
    return {
    page: briefingCard.getAttribute('data-card-page') ?? '',
    pageKeys: JSON.parse(briefingCard.getAttribute('data-card-page-keys') ?? '[]'),
    pageIdentities: JSON.parse(briefingCard.getAttribute('data-card-page-identities') ?? '[]'),
    activeIdentity: briefingCard.getAttribute('data-card-page-active-identity'),
    range: briefingCard.getAttribute('data-briefing-page-range') ?? '',
    card: measure(briefingCard),
    cardDisplay: cardStyle.display,
    cardFlexDirection: cardStyle.flexDirection,
    pageAtom: pageAtom == null ? null : {
      node: measure(pageAtom), display: pageAtomStyle.display, flexGrow: numeric(pageAtomStyle.flexGrow),
      flexShrink: numeric(pageAtomStyle.flexShrink), flexBasis: pageAtomStyle.flexBasis,
      minHeight: numeric(pageAtomStyle.minHeight),
    },
    grids: all('.briefing-fact-grid', briefingCard).map((grid) => {
      const body = grid.closest('.body');
      const gridStyle = getComputedStyle(grid);
      const stats = all(':scope > .briefing-fact-stat', grid).map((stat) => {
        const role = stat.hasAttribute('data-briefing-precipitation-location') ? 'location'
          : stat.hasAttribute('data-briefing-precipitation-amount') ? 'amount'
          : stat.hasAttribute('data-briefing-precipitation-time') ? 'time'
          : stat.hasAttribute('data-briefing-precipitation-duration') ? 'duration' : 'unknown';
        const value = stat.querySelector('.briefing-fact-value');
        const token = stat.querySelector('.briefing-fact-token');
        return {
          role, stat: measure(stat), gap: numeric(getComputedStyle(stat).gap),
          label: clean(stat.querySelector('.briefing-fact-label')?.textContent), value: textMeasure(value),
          numberUnit: token == null ? null : { wrapper: textMeasure(token), value: fragment(token.querySelector('.nu-value')), unit: fragment(token.querySelector('.nu-unit')) },
        };
      });
      const location = stats.find((stat) => stat.role === 'location')?.value?.text ?? '';
      const amount = stats.find((stat) => stat.role === 'amount')?.value?.compactText ?? '';
      return {
        location, amount,
        approximation: amount.startsWith('約') ? 'approx' : amount.endsWith('以上') ? 'atLeast' : null,
        body: measure(body), bodyPadding: body == null ? null : {
          top: numeric(getComputedStyle(body).paddingTop), right: numeric(getComputedStyle(body).paddingRight),
          bottom: numeric(getComputedStyle(body).paddingBottom), left: numeric(getComputedStyle(body).paddingLeft),
        },
        grid: measure(grid), gridTemplateColumns: gridStyle.gridTemplateColumns,
        rowGap: numeric(gridStyle.rowGap), columnGap: numeric(gridStyle.columnGap),
        margin: { top: numeric(gridStyle.marginTop), right: numeric(gridStyle.marginRight), bottom: numeric(gridStyle.marginBottom), left: numeric(gridStyle.marginLeft) },
        stats,
      };
    }),
    };
  })();
  const forecastCard = liveComponent('weatherWarningForecast');
  const forecast = forecastCard == null ? null : (() => {
    const header = forecastCard.querySelector('.standby-card-header');
    const atom = forecastCard.querySelector('[data-forecast-atom]');
    const footer = forecastCard.querySelector('[data-card-page-footer]');
    const periods = forecastCard.querySelector('.periods');
    const target = forecastCard.querySelector('.target');
    const headerStyle = header == null ? null : getComputedStyle(header);
    const cardStyle = getComputedStyle(forecastCard);
    return {
      page: forecastCard.getAttribute('data-card-page') ?? '',
      pageKeys: JSON.parse(forecastCard.getAttribute('data-card-page-keys') ?? '[]'),
      pageIdentities: JSON.parse(forecastCard.getAttribute('data-card-page-identities') ?? '[]'),
      activeIdentity: forecastCard.getAttribute('data-card-page-active-identity'),
      identity: atom?.getAttribute('data-forecast-atom') ?? null,
      card: measure(forecastCard), header: measure(header), atom: measure(atom), footer: measure(footer), periods: measure(periods),
      headerPadding: headerStyle == null ? null : {
        top: numeric(headerStyle.paddingTop), right: numeric(headerStyle.paddingRight),
        bottom: numeric(headerStyle.paddingBottom), left: numeric(headerStyle.paddingLeft),
      },
      periodGap: periods == null ? null : numeric(getComputedStyle(periods).rowGap),
      periodKeys: all('[data-forecast-period]', forecastCard).map((period) => period.getAttribute('data-forecast-period')),
      periodCount: all('[data-forecast-period]', forecastCard).length,
      atomFooterOverlap: overlap(atom, footer),
      footerCount: all('[data-card-page-footer]', forecastCard).length,
      continuationVisibleCount: all('.continuation', forecastCard).filter(painted).length,
      visibleTarget: clean(target?.textContent), targetTitle: target?.getAttribute('title') ?? null,
      atomAccessibleName: atom?.getAttribute('aria-label') ?? null,
      cardAccessibleName: forecastCard.getAttribute('aria-label'),
      naturalHeight: forecastCard.scrollHeight + (numeric(cardStyle.borderTopWidth) ?? 0) + (numeric(cardStyle.borderBottomWidth) ?? 0),
    };
  })();
  const resolveCustomFontWeight = (context) => {
    if (context == null) return null;
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;font-weight:var(--num-weight)';
    context.append(probe);
    const result = getComputedStyle(probe).fontWeight;
    probe.remove();
    return result;
  };
  const resolveRoleMuted = () => {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--role-muted)';
    root.append(probe);
    const result = getComputedStyle(probe).color;
    probe.remove();
    return result;
  };
  const probabilityRole = (role, context, label) => {
    if (context == null) return null;
    const probabilityNumber = context.matches?.('.probability-number') ? context : context.querySelector('.probability-number');
    const nuValue = probabilityNumber?.querySelector('.nu-value') ?? null;
    const nuUnit = probabilityNumber?.querySelector('.nu-unit') ?? null;
    const legacyMatch = compactText(context.textContent).match(/(\d+)%/);
    return {
      role, label, legacyNode: textMeasure(context), probabilityNumber: textMeasure(probabilityNumber),
      nuValue: fragment(nuValue), nuUnit: fragment(nuUnit),
      value: nuValue == null ? (legacyMatch == null ? null : Number(legacyMatch[1])) : Number(clean(nuValue.textContent)),
      unit: nuUnit == null ? (legacyMatch == null ? null : '%') : clean(nuUnit.textContent),
    };
  };
  const typhoonCard = liveComponent('typhoon');
  const typhoon = typhoonCard == null ? null : (() => {
    const header = typhoonCard.querySelector('.standby-card-header');
    const headerStyle = header == null ? null : getComputedStyle(header);
    const compact = typhoonCard.classList.contains('compact');
    const roles = [];
    if (compact) {
      const summary = typhoonCard.querySelector('.probability-compact-summary');
      roles.push(probabilityRole('maximum', summary?.querySelector(':scope > .probability-number, :scope > strong') ?? null, 'maximum'));
      for (const prefecture of all('.probability-prefectures > span:not(.probability-omitted)', typhoonCard)) {
        roles.push(probabilityRole('prefecture', prefecture, clean(prefecture.childNodes[0]?.textContent)));
      }
    } else {
      roles.push(probabilityRole('maximum', typhoonCard.querySelector('.probability-maximum'), 'maximum'));
      for (const prefecture of all('.probability-prefecture-list > li', typhoonCard)) {
        roles.push(probabilityRole('prefecture', prefecture, clean(prefecture.firstElementChild?.textContent)));
      }
    }
    const worst = typhoonCard.querySelector('.probability-worst');
    roles.push(probabilityRole('worst', worst, clean(worst?.textContent).replace(/\s*\d+%.*$/, '')));
    const styleAttribute = header?.getAttribute('style') ?? '';
    return {
      scenario: window.location.hash.replace(/^#/, ''),
      displayMode: compact ? 'compact' : 'full', card: measure(typhoonCard), resolvedNumWeight: resolveCustomFontWeight(typhoonCard),
      header: header == null ? null : {
        node: measure(header), className: header.className, style: styleAttribute,
        customProperties: {
          container: header.style.getPropertyValue('--standby-header-container'),
          on: header.style.getPropertyValue('--standby-header-on'),
          band: header.style.getPropertyValue('--standby-header-band'),
        },
        background: headerStyle.backgroundColor, color: headerStyle.color,
        bandWidth: numeric(headerStyle.borderBottomWidth), roleMuted: resolveRoleMuted(),
      },
      roles: roles.filter(Boolean),
    };
  })();
  const describeWeatherCard = (card, host = null) => {
    if (card == null) return null;
    const style = getComputedStyle(card);
    const header = card.querySelector(':scope > .weather-card-header');
    const body = card.querySelector(':scope > ul');
    const footer = card.querySelector(':scope > .weather-page-footer');
    const rider = card.querySelector(':scope > .tornado-rider');
    const row = (node) => node == null ? null : {
      node: measure(node), gridArea: getComputedStyle(node).gridArea,
    };
    const children = [...card.children];
    const kindOf = (node) => node === header ? 'header' : node === body ? 'body'
      : node === footer ? 'footer' : node === rider ? 'rider' : 'other';
    const cardBox = measure(card);
    const maxHeight = numeric(style.maxHeight);
    const headerRow = row(header);
    const bodyRow = row(body);
    const footerRow = row(footer);
    const riderRow = row(rider);
    const innerOccupiedHeight = [headerRow, bodyRow, footerRow, riderRow]
      .reduce((sum, entry) => sum + (entry?.node?.rect?.height ?? 0), 0);
    return {
      host: host?.getAttribute?.('data-layout-motion-card') ?? null,
      shelf: card.closest('.measure-shelf, .center-measure-shelf') != null,
      painted: painted(card), card: cardBox,
      gridTemplateRows: style.gridTemplateRows,
      gridTemplateAreas: style.gridTemplateAreas,
      gridRowCount: style.gridTemplateRows.trim() === '' ? 0 : style.gridTemplateRows.trim().split(/\s+/).length,
      explicitHeight: card.style.height.trim() !== '', pagingContract: card.classList.contains('paging-contract'),
      maxHeight, maxHeightGap: cardBox == null || maxHeight == null ? null : maxHeight - cardBox.rect.height,
      nonClamped: cardBox != null && maxHeight != null && cardBox.rect.height < maxHeight - 1
        && cardBox.scrollHeight <= cardBox.clientHeight + 1,
      innerOccupiedHeight, innerContentHeight: cardBox?.clientHeight ?? null,
      footerCount: all(':scope > [data-card-page-footer]', card).length,
      riderCount: all(':scope > .tornado-rider', card).length,
      childOrder: children.map(kindOf),
      header: headerRow, body: bodyRow, footer: footerRow, rider: riderRow,
    };
  };
  const weatherCards = all('[data-layout-motion-card]', root).flatMap((host) => {
    const token = host.getAttribute('data-layout-motion-card') ?? '';
    if (token.split(':')[0] !== 'weather') return [];
    const card = componentIn(host, 'weather');
    return card == null ? [] : [describeWeatherCard(card, host)];
  });
  const naturalHeightProbes = all('[data-prefix-measure]', root).flatMap((probe) => {
    const card = probe.querySelector('.flood-card, .flood-wide-card, .briefing-card, .volcano-card');
    if (card == null) return [];
    const cardKind = card.matches('.flood-wide-card') ? 'floodWide' : card.matches('.flood-card') ? 'flood'
      : card.matches('.briefing-card') ? 'briefing' : 'volcano';
    const range = card.getAttribute('data-flood-page-range') ?? card.getAttribute('data-briefing-page-range')
      ?? card.getAttribute('data-volcano-page-range') ?? '';
    const cardStyle = getComputedStyle(card);
    return [{
      probeId: probe.getAttribute('data-prefix-measure') ?? '',
      composition: probe.getAttribute('data-page-probe-composition'),
      fit: probe.getAttribute('data-page-probe-fit'), cardKind, range,
      card: measure(card), naturalHeight: card.getBoundingClientRect().height,
      footerCount: all('[data-card-page-footer]', card).length,
      explicitHeight: card.style.height.trim() !== '', maxHeight: numeric(cardStyle.maxHeight),
    }];
  });
  const schedulerState = jsonAttr(root, 'data-scheduler-state', null);
  const layoutComponentFor = (kind) => {
    for (const host of all('[data-layout-motion-card]', root)) {
      const token = host.getAttribute('data-layout-motion-card') ?? '';
      if (token.split(':')[0] !== kind) continue;
      const component = componentIn(host, kind);
      if (component != null) return component;
    }
    return null;
  };
  const expectedPagerCaptureKeys = ${JSON.stringify(DESIGN_ALIGNMENT_PAGER_CAPTURE_KEYS_BY_SCENARIO)}[window.location.hash.replace(/^#/, '')] ?? [];
  const pagerDefinitions = [
    { key: 'weather', kind: 'weather', prefix: 'weather' },
    { key: 'tornado', kind: 'weather', prefix: 'tornado' },
    { key: 'weatherWarningForecast', kind: 'weatherWarningForecast', prefix: 'pager' },
    { key: 'briefing', kind: 'briefing', prefix: 'pager' },
    { key: 'flood', kind: 'flood', prefix: 'pager' },
    { key: 'volcano', kind: 'volcano', prefix: 'pager' },
  ];
  const pagerContracts = pagerDefinitions.filter((definition) => expectedPagerCaptureKeys.includes(definition.key)).map((definition) => {
    const state = schedulerState?.paging?.cards?.[definition.key];
    if (state == null || !Number.isFinite(state.pageCount) || state.pageCount <= 0) return { captureKey: definition.key, missingSchedulerState: true };
    const card = layoutComponentFor(definition.kind);
    if (card == null) return { captureKey: definition.key, missingComponent: true };
    const baseName = definition.prefix === 'pager' ? 'data-pager-' : 'data-' + definition.prefix + '-pager-';
    const logicalItems = jsonAttr(card, baseName + 'logical-items', null);
    const logicalFingerprints = jsonAttr(card, baseName + 'logical-fingerprints', null);
    const resetItems = jsonAttr(card, baseName + 'reset-items', null);
    const sourceCount = numeric(card.getAttribute(baseName + 'logical-source-count'));
    const itemKeys = Array.isArray(logicalItems) ? logicalItems.map((item) => JSON.stringify(item)) : [];
    const duplicateCount = itemKeys.length - new Set(itemKeys).size;
    const nullCount = Array.isArray(logicalItems) ? logicalItems.filter((item) => item == null).length : null;
    const pageRange = definition.key === 'weather' ? card.getAttribute('data-weather-page-range')
      : definition.key === 'tornado' ? card.getAttribute('data-tornado-page-range')
        : definition.key === 'briefing' ? card.getAttribute('data-briefing-page-range')
          : definition.key === 'flood' ? card.getAttribute('data-flood-page-range')
            : definition.key === 'volcano' ? card.getAttribute('data-volcano-page-range') : null;
    return {
      captureKey: definition.key,
      namespace: card.getAttribute(baseName + 'namespace'), key: card.getAttribute(baseName + 'key'),
      logicalItems, logicalFingerprints, resetItems, sourceCount,
      duplicateCount, nullCount,
      missingCount: Array.isArray(logicalItems) && Number.isFinite(sourceCount) ? Math.max(0, sourceCount - logicalItems.length) : null,
      kindKeys: definition.key === 'weather' ? jsonAttr(card, 'data-weather-pager-kind-keys', null) : null,
      diagnostics: {
        page: state.page, pageCount: state.pageCount, pageKeys: state.keys, pageIdentities: state.identities,
        activeIdentity: state.activeKey, rangeDerivedPageKey: state.activeKey, resetKey: state.resetKey,
        pageRange,
      },
    };
  });
  const weatherAutoRoot = root.hasAttribute('data-weather-auto-footer-probe') ? root : null;
  const weatherAutoCard = weatherAutoRoot?.querySelector(':scope > .weather-card') ?? null;
  const weatherAutoDescription = describeWeatherCard(weatherAutoCard);
  const weatherAutoPage = weatherAutoCard?.getAttribute('data-card-page') ?? '';
  const weatherAuto = weatherAutoRoot == null || weatherAutoCard == null ? null : {
    target: weatherAutoRoot.getAttribute('data-weather-auto-footer-probe'),
    compressed: weatherAutoRoot.classList.contains('ladder-compressed'),
    forcedRange: jsonAttr(weatherAutoRoot, 'data-weather-auto-forced-range', null),
    page: weatherAutoPage,
    pageCount: Number.parseInt(weatherAutoPage.split('/')[1] ?? '', 10),
    pageIdentities: jsonAttr(weatherAutoCard, 'data-card-page-identities', null),
    activeIdentity: weatherAutoCard.getAttribute('data-card-page-active-identity'),
    pageKey: weatherAutoCard.getAttribute('data-card-page-active-identity'),
    tornadoCount: all(':scope > .tornado-rider', weatherAutoCard).length,
    ...weatherAutoDescription,
  };
  const parsePreviewJson = (name) => {
    const raw = preview.getAttribute(name);
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch { return { parseError: raw }; }
  };
  const pageFooters = all('[data-card-page-footer]').map((footer) => {
    const card = footer.closest('.flood-card, .flood-wide-card, .briefing-card, [data-weather-warning-forecast-card], .volcano-card, .weather-card');
    const indicator = footer.querySelector('[data-card-page-indicator]');
    const rider = footer.nextElementSibling?.matches('.tornado-rider') ? footer.nextElementSibling : null;
    const style = getComputedStyle(footer);
    const indicatorStyle = indicator == null ? null : getComputedStyle(indicator);
    const riderStyle = rider == null ? null : getComputedStyle(rider);
    const previous = footer.previousElementSibling;
    const cardMeasure = measure(card);
    const footerMeasure = measure(footer);
    const indicatorMeasure = measure(indicator);
    const flowParent = footer.parentElement;
    const children = flowParent == null ? [] : [...flowParent.children];
    const footerIndex = children.indexOf(footer);
    const riderIndex = rider == null ? -1 : children.indexOf(rider);
    const probe = card?.closest('[data-prefix-measure]') ?? null;
    return {
      cardKind: card?.matches('.briefing-card') ? 'briefing' : card?.matches('[data-weather-warning-forecast-card]') ? 'weatherWarningForecast'
        : card?.matches('.volcano-card') ? 'volcano' : card?.matches('.weather-card') ? 'weather'
          : card?.matches('.flood-wide-card') ? 'floodWide' : 'flood',
      card: cardMeasure, footer: footerMeasure, indicator: indicatorMeasure, body: measure(previous), rider: measure(rider),
      footerCount: card == null ? 0 : all('[data-card-page-footer]', card).length,
      indicatorCount: card == null ? 0 : all('[data-card-page-indicator]', card).length,
      indicatorText: clean(indicator?.textContent), siblingOrder: [previous?.className ?? previous?.tagName ?? '', footer.className, rider?.className ?? rider?.tagName ?? ''],
      footerIndex, riderIndex, childCount: children.length,
      footerIsLast: footerIndex >= 0 && footerIndex === children.length - 1,
      riderIsLast: riderIndex >= 0 && riderIndex === children.length - 1,
      probeId: probe?.getAttribute('data-prefix-measure') ?? null,
      range: card?.getAttribute('data-flood-page-range') ?? card?.getAttribute('data-briefing-page-range')
        ?? card?.getAttribute('data-volcano-page-range') ?? card?.getAttribute('data-weather-page-range') ?? null,
      shelf: card?.closest('.measure-shelf, .center-measure-shelf') != null,
      painted: painted(card) && painted(footer) && painted(indicator),
      position: style.position, paddingTop: numeric(style.paddingTop), paddingRight: numeric(style.paddingRight), paddingBottom: numeric(style.paddingBottom), paddingLeft: numeric(style.paddingLeft),
      borderTop: numeric(style.borderTopWidth), background: style.backgroundColor,
      indicatorFontSize: indicatorStyle == null ? null : numeric(indicatorStyle.fontSize), indicatorColor: indicatorStyle?.color ?? null,
      indicatorLineHeight: indicatorStyle == null ? null : numeric(indicatorStyle.lineHeight), indicatorBackground: indicatorStyle?.backgroundColor ?? null,
      bodyFooterOverlap: overlap(previous, footer), footerRiderOverlap: overlap(footer, rider), indicatorBodyOverlap: overlap(indicator, previous), indicatorRiderOverlap: overlap(indicator, rider),
      footerBottomInset: cardMeasure == null || footerMeasure == null ? null : cardMeasure.rect.bottom - cardMeasure.borderBottom - footerMeasure.rect.bottom,
      indicatorBottomPaddingDelta: footerMeasure == null || indicatorMeasure == null ? null : footerMeasure.rect.bottom - (numeric(style.paddingBottom) ?? 0) - indicatorMeasure.rect.bottom,
      riderBottomInset: cardMeasure == null || rider == null ? null : cardMeasure.rect.bottom - cardMeasure.borderBottom - rider.getBoundingClientRect().bottom,
      riderRadiusTopLeft: riderStyle == null ? null : numeric(riderStyle.borderTopLeftRadius),
      riderRadiusTopRight: riderStyle == null ? null : numeric(riderStyle.borderTopRightRadius),
      riderRadiusBottomLeft: riderStyle == null ? null : numeric(riderStyle.borderBottomLeftRadius),
      riderRadiusBottomRight: riderStyle == null ? null : numeric(riderStyle.borderBottomRightRadius),
      riderBackground: riderStyle?.backgroundColor ?? null,
    };
  });
  const scenario = window.location.hash.replace(/^#/, '');
  const query = new URLSearchParams(window.location.search);
  const rotationTick = Number.parseInt(query.get('rotationTick') ?? '', 10);
  const cardPageTick = Number.parseInt(query.get('cardPageTick') ?? '', 10);
  const maxPlan = query.get('maxPlan');
  const recentQuakesTarget = ${JSON.stringify(RECENT_QUAKES_GAP_TARGETS)}.some((target) =>
    scenario === target.scenario && window.innerWidth + 'x' + window.innerHeight === target.viewport
      && rotationTick === 0 && cardPageTick === 0 && maxPlan === target.maxPlan);
  const recentQuakes = !recentQuakesTarget ? null : (() => {
    const host = all('[data-layout-motion-card="recent-quakes:center"]', root).find(painted) ?? null;
    const component = host?.querySelector('.recent-quakes') ?? null;
    const firstRow = component?.querySelector('.row') ?? null;
    const rowMain = firstRow?.querySelector('.row-main') ?? null;
    const stats = firstRow?.querySelector('.stats') ?? null;
    const magnitude = stats?.querySelector(':scope > .magnitude') ?? null;
    const depth = stats?.querySelector(':scope > .depth') ?? null;
    const time = stats?.querySelector(':scope > .time') ?? null;
    const componentStyle = component == null ? null : getComputedStyle(component);
    const statsStyle = stats == null ? null : getComputedStyle(stats);
    return {
      root: measure(component), firstRow: measure(firstRow), rowMain: measure(rowMain), stats: measure(stats),
      magnitude: measure(magnitude), depth: measure(depth), time: measure(time),
      rootInlineSize: componentStyle == null ? null : numeric(componentStyle.inlineSize),
      rowGap: statsStyle == null ? null : numeric(statsStyle.rowGap),
      columnGap: statsStyle == null ? null : numeric(statsStyle.columnGap),
      resolvedSpace1: componentStyle == null ? null : numeric(componentStyle.getPropertyValue('--space-1')),
      resolvedSpace2: componentStyle == null ? null : numeric(componentStyle.getPropertyValue('--space-2')),
      resolvedSpace3: componentStyle == null ? null : numeric(componentStyle.getPropertyValue('--space-3')),
      fontFamily: componentStyle?.fontFamily ?? null,
      statsFontFamily: statsStyle?.fontFamily ?? null,
      statOrder: stats == null ? [] : [...stats.children].map((child) => child.classList[0] ?? ''),
    };
  })();
  return {
    ready: document.fonts?.status === 'loaded', settled: root.getAttribute('data-measurement-settled') === 'true',
    viewport: { innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
    rootFontSize: numeric(getComputedStyle(root).fontSize),
    fontSignature: {
      status: document.fonts?.status ?? null,
      rootFamily: getComputedStyle(root).fontFamily,
      recentQuakesFamily: recentQuakes?.fontFamily ?? null,
      recentQuakesStatsFamily: recentQuakes?.statsFontFamily ?? null,
    },
    layout: {
      ladderStage: attrNumber('data-ladder-stage'), measurementGeometryStage: attrNumber('data-measurement-geometry-stage'),
      compressed: root.classList.contains('ladder-compressed'), unresolved: root.getAttribute('data-layout-unresolved'),
      nonconverged: root.getAttribute('data-measurement-nonconverged'),
      placementLeft: splitAttr('data-placement-left'), placementRight: splitAttr('data-placement-right'), placementCenter: splitAttr('data-placement-center'),
      rotationKeys: splitAttr('data-rotation-keys'), rotationOmittedCount: attrNumber('data-rotation-omitted-count'),
      rotationActiveKey: root.getAttribute('data-rotation-active-key') ?? '', rotationPosition: root.getAttribute('data-rotation-position') ?? '',
      typhoonVariant: root.getAttribute('data-typhoon-variant') ?? '',
      cardOverflowKeys: splitAttr('data-card-overflow-keys'), readableOverflowKeys: splitAttr('data-page-viewport-overflow-keys'),
      visibleCards, candidateCounts, measurementWidths,
      sideMeasureShelfWidth: attrNumber('data-side-measure-shelf-rect-width-px'),
    },
    riderReserveCounts: parsePreviewJson('data-design-alignment-rider-reserve-counts'),
    payloadSignature: parsePreviewJson('data-design-alignment-payload-signature'),
    tokens: { roleMuted: resolveRoleMuted() },
    briefing, forecast, typhoon, weatherCards, weatherAuto, naturalHeightProbes, pagerContracts, pageFooters, recentQuakes,
  };
})()`;

export async function collectDesignSnapshot({ evaluate }) {
  return withDocumentEvidence(await evaluate(atomicSnapshotExpression({
    document: DOCUMENT_CAPTURE_EXPRESSION,
    designGeometry: DESIGN_ALIGNMENT_REPORT_EXPRESSION,
  })));
}

export function runDesignCaptureSession({ chrome, profileDir, url, viewport, viewportMode, entry, sessionRunner = runCaptureBrowserSession }) {
  return sessionRunner({
    chrome, profileDir, url, requestedViewport: viewport, viewportMode, readinessKind: "standby",
    virtualTimeBudgetMs: null, sessionRole: "primary", label: `design-alignment ${manifestKey(entry)}`,
    collectSnapshot: collectDesignSnapshot,
    stableProjection: captureStableProjection,
  });
}

async function captureDesignAlignmentPage({ chrome, profileDir, url, viewport, viewportMode, outDir, entry, artifactPrefix = "design-alignment" }) {
  const suffix = `r${entry.rotationTick ?? "x"}-p${entry.cardPageTick ?? "x"}`;
  const pngPath = join(outDir, `${artifactPrefix}-${entry.scenario}-${viewport.label}-${suffix}.png`);
  const session = await runDesignCaptureSession({ chrome, profileDir, url, viewport, viewportMode, entry });
  const snapshot = session.preScreenshot;
  const geometry = {
    ...snapshot.designGeometry,
    viewport: snapshot.document.viewport,
    readiness: readinessFor(snapshot.document, "standby"),
  };
  await rm(pngPath, { force: true });
  await writeFile(pngPath, Buffer.from(session.screenshotData, "base64"));
  assertCompletePng(await readFile(pngPath));
  const record = {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    manifestKey: manifestKey(entry), scenario: entry.scenario, fixture: null,
    viewport, rotationTick: entry.rotationTick, cardPageTick: entry.cardPageTick, query: entry.query,
    urlIdentity: normalizeDesignAlignmentUrl(url), pngPath, browser: session.browser, capture: session.capture,
    geometry, expectationPolicy: "fixture-assertions-only", mismatches: [],
  };
  assertCaptureRecordSchemaV2(record);
  return record;
}

function centerStackPregateUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.search = "nav=0";
  url.hash = "standby-briefing";
  return url.toString();
}

function pregateSnapshotHash(snapshot) {
  return createHash("sha256").update(Buffer.from(canonicalJsonStringify(captureStableProjection(snapshot)), "utf8")).digest("hex");
}

export function runCenterStackPregateCaptureSession({ chrome, profileDir, url, viewport, entry, sessionRunner = runCaptureBrowserSession }) {
  return sessionRunner({
    chrome, profileDir, url, requestedViewport: viewport, viewportMode: "calibrated", readinessKind: "standby",
    virtualTimeBudgetMs: null, sessionRole: "primary", label: `center-stack-pregate ${entry.recordKey}`,
    collectSnapshot: collectCenterStackPregateSnapshot, stableProjection: captureStableProjection,
  });
}

async function captureCenterStackPregatePage({ chrome, profileDir, baseUrl, outDir, entry }) {
  const viewport = parseViewport(entry.viewport);
  const url = centerStackPregateUrl(baseUrl);
  const pngPath = join(outDir, `center-stack-pregate-${entry.viewport}-repeat-${entry.repetition}.png`);
  const jsonPath = join(outDir, `center-stack-pregate-${entry.viewport}-repeat-${entry.repetition}.json`);
  const session = await runCenterStackPregateCaptureSession({ chrome, profileDir, url, viewport, entry });
  const snapshot = session.preScreenshot;
  const draft = {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    recordKey: entry.recordKey,
    repetition: entry.repetition,
    scenario: entry.scenario,
    fixture: null,
    viewport,
    urlIdentity: `${new URL(url).pathname}${new URL(url).search}${new URL(url).hash}`,
    pngPath,
    jsonPath,
    browser: session.browser,
    capture: session.capture,
    captureEvidence: {
      stableSampleCount: session.stable.length,
      stableSampleHashes: session.stable.map(pregateSnapshotHash),
      stableSamplesMatch: pregateSnapshotHash(session.stable[0]) === pregateSnapshotHash(session.stable[1]),
      preScreenshotHash: pregateSnapshotHash(session.preScreenshot),
      postScreenshotHash: pregateSnapshotHash(session.postScreenshot),
      screenshotStateMatch: pregateSnapshotHash(session.preScreenshot) === pregateSnapshotHash(session.postScreenshot),
    },
    geometry: {
      ...snapshot.pregateGeometry,
      viewport: snapshot.document.viewport,
      readiness: readinessFor(snapshot.document, "standby"),
    },
    expectationPolicy: "fixture-assertions-only",
    mismatches: [],
  };
  const derived = deriveCenterStackPregateMetrics(draft);
  const record = {
    ...draft,
    geometry: {
      ...draft.geometry,
      ticker: {
        ...draft.geometry.ticker,
        occupiedTop: derived.tickerOccupiedTop,
        occupiedRect: derived.tickerOccupiedRect,
        recentOverlapAreaPx: derived.recentTickerOverlapAreaPx,
      },
      centerStack: { ...draft.geometry.centerStack, budget: derived.budget },
    },
  };
  await rm(pngPath, { force: true });
  await writeFile(pngPath, Buffer.from(session.screenshotData, "base64"));
  assertCompletePng(await readFile(pngPath));
  assertPregateRecord(record, entry.recordKey);
  await writeFile(jsonPath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value != null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function assertDeepEqual(actual, expected, label) {
  if (stableJson(actual) !== stableJson(expected)) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function designAlignmentCaptureEnvironmentSignature(record, label = record?.manifestKey ?? "design-alignment record") {
  const browser = {};
  for (const field of ["product", "revision"]) {
    const value = record?.browser?.[field];
    if (typeof value !== "string" || value === "") throw new Error(`${label}: browser.${field} missing`);
    browser[field] = value;
  }
  const devicePixelRatio = record?.geometry?.viewport?.devicePixelRatio;
  if (devicePixelRatio !== 1) throw new Error(`${label}: DPR must be 1, got ${devicePixelRatio}`);
  const fontSignature = record?.geometry?.fontSignature;
  if (fontSignature?.status !== "loaded") throw new Error(`${label}: font status must be loaded`);
  if (typeof fontSignature.rootFamily !== "string" || fontSignature.rootFamily === "") throw new Error(`${label}: root font family missing`);
  const hasRecentQuakes = record?.geometry?.recentQuakes != null;
  for (const field of ["recentQuakesFamily", "recentQuakesStatsFamily"]) {
    if (!Object.hasOwn(fontSignature, field)) throw new Error(`${label}: ${field} missing`);
    const value = fontSignature[field];
    if (hasRecentQuakes ? typeof value !== "string" || value === "" : value !== null) {
      throw new Error(`${label}: ${field} does not match the RecentQuakes report`);
    }
  }
  return { browser, fonts: fontSignature, devicePixelRatio };
}

export function assertDesignAlignmentApprox(actual, expected, tolerance, label) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) throw new Error(`${label}: expected ${expected} ±${tolerance}, got ${actual}`);
}

function assertBox(box, label) {
  if (box == null) throw new Error(`${label}: missing box`);
  for (const key of ["clientWidth", "scrollWidth", "clientHeight", "scrollHeight", "overflowX", "overflowY"]) {
    if (!Number.isFinite(box[key])) throw new Error(`${label}.${key}: non-finite geometry`);
  }
  if (box.rect == null) throw new Error(`${label}.rect: missing`);
  for (const key of ["x", "y", "left", "right", "top", "bottom", "width", "height"]) {
    if (!Number.isFinite(box.rect[key])) throw new Error(`${label}.rect.${key}: non-finite geometry`);
  }
}

function assertNoOverflow(box, label) {
  assertBox(box, label);
  if (box.overflowX > 1 || box.overflowY > 1) throw new Error(`${label}: client/scroll overflow ${box.overflowX}x${box.overflowY}`);
}

function recentQuakesTargetRecord(records, target) {
  const matches = records.filter((record) => matchesRecentQuakesGapTarget(record, target));
  if (matches.length !== 1) throw new Error(`${target.name}: expected exactly one RecentQuakes target record, got ${matches.length}`);
  return matches[0];
}

function actualHorizontalGap(left, right) {
  const value = right?.rect?.left - left?.rect?.right;
  return Number.isFinite(value) ? value : null;
}

function assertRecentQuakesGapPlanReport(record, target, label) {
  const layout = record.geometry?.layout;
  const plan = target.maxPlan == null ? target : DESIGN_ALIGNMENT_MAX_PLANS[target.maxPlan];
  if (layout == null || plan == null) throw new Error(`${label}: plan report missing`);
  if (layout.ladderStage !== plan.stage || layout.measurementGeometryStage !== plan.stage || layout.compressed !== plan.compressed) {
    throw new Error(`${label}: ${target.maxPlan == null ? "960 compressed" : "max"} stage/compressed contract failed`);
  }
  if (target.maxPlan == null) return;
  for (const name of ["placementLeft", "placementRight", "placementCenter", "rotationKeys", "visibleCards"]) {
    if (!Array.isArray(layout[name])) throw new Error(`${label}: ${name} report missing`);
  }
  if (!Number.isFinite(layout.rotationOmittedCount) || typeof layout.rotationActiveKey !== "string"
    || typeof layout.rotationPosition !== "string" || typeof layout.typhoonVariant !== "string") {
    throw new Error(`${label}: rotation/variant report missing`);
  }
  if (target.maxPlan === "fhdMax" && (layout.rotationKeys.length !== 0 || layout.rotationOmittedCount !== 0
    || layout.rotationActiveKey !== "" || layout.rotationPosition !== "")) {
    throw new Error(`${label}: fhdMax rotation must remain empty`);
  }
}

export function assertDesignAlignmentRecentQuakesReports(records, { mode }) {
  if (mode !== "baseline" && mode !== "after") throw new Error(`unknown RecentQuakes assertion mode: ${mode}`);
  for (const target of RECENT_QUAKES_GAP_TARGETS) {
    const record = recentQuakesTargetRecord(records, target);
    const report = record.geometry?.recentQuakes;
    const label = `${record.manifestKey}: RecentQuakes`;
    if (report == null) throw new Error(`${label} report missing`);
    designAlignmentCaptureEnvironmentSignature(record, label);
    assertRecentQuakesGapPlanReport(record, target, label);
    for (const name of ["root", "firstRow", "rowMain", "stats", "magnitude", "depth", "time"]) {
      assertNoOverflow(report[name], `${label} ${name}`);
      if (report[name].scrollWidth > report[name].clientWidth + 1 || report[name].scrollHeight > report[name].clientHeight + 1) {
        throw new Error(`${label} ${name}: scroll/client overflow`);
      }
    }
    for (const name of ["rootInlineSize", "rowGap", "columnGap", "resolvedSpace1", "resolvedSpace2", "resolvedSpace3"]) {
      if (!Number.isFinite(report[name])) throw new Error(`${label}.${name}: missing/non-finite`);
    }
    assertDesignAlignmentApprox(report.rootInlineSize, report.root.rect.width, 0.1, `${label} root inline-size`);
    assertDeepEqual(report.statOrder, ["magnitude", "depth", "time"], `${label} DOM order`);
    if (target.narrow) {
      for (const [name, expected] of Object.entries(target.resolvedSpaces)) {
        assertDesignAlignmentApprox(report[name], expected, 0.1, `${label} ${name}`);
      }
      if (report.rootInlineSize > 420) throw new Error(`${label}: 420px container query must match`);
      if (report.stats.rect.top <= report.rowMain.rect.top + 0.5 || report.stats.rect.top + 0.5 < report.rowMain.rect.bottom) {
        throw new Error(`${label}: row-main/stats must occupy different grid rows`);
      }
      for (const node of [report.depth, report.time]) {
        assertDesignAlignmentApprox(node.rect.top, report.magnitude.rect.top, 0.5, `${label} statistics top alignment`);
        assertDesignAlignmentApprox(node.rect.bottom, report.magnitude.rect.bottom, 0.5, `${label} statistics bottom alignment`);
      }
      assertDesignAlignmentApprox(report.rowGap, report.resolvedSpace1, 0.1, `${label} row gap`);
      if (mode === "baseline") {
        assertDesignAlignmentApprox(report.columnGap, report.resolvedSpace1, 0.1, `${label} baseline column gap`);
      } else {
        assertDesignAlignmentApprox(report.columnGap, report.resolvedSpace2, 0.1, `${label} column gap`);
        const expectedGap = Math.max(report.columnGap, report.resolvedSpace2);
        for (const [name, left, right] of [
          ["magnitude/depth", report.magnitude, report.depth],
          ["depth/time", report.depth, report.time],
        ]) {
          const gap = actualHorizontalGap(left, right);
          if (!Number.isFinite(gap) || gap < 0 || gap + 0.5 < expectedGap) throw new Error(`${label} ${name}: adjacent gap ${gap} is below ${expectedGap}`);
        }
      }
    } else {
      if (report.rootInlineSize <= 420) throw new Error(`${label}: 420px container query must not match`);
      assertDesignAlignmentApprox(report.rowGap, report.resolvedSpace3, 0.1, `${label} row gap`);
      assertDesignAlignmentApprox(report.columnGap, report.resolvedSpace3, 0.1, `${label} column gap`);
    }
  }
}

export function assertDesignAlignmentWeatherAutoBaselineProbe(record, expectation, label = record?.manifestKey ?? "weather auto baseline probe") {
  const probe = record?.geometry?.weatherAuto;
  if (probe == null) throw new Error(`${label}: weather auto-height report missing`);
  if (probe.target !== record.scenario || probe.compressed !== expectation.compressed) throw new Error(`${label}: target/compressed mismatch`);
  assertDeepEqual(probe.forcedRange, expectation.forcedRange, `${label}: forced measurementRange`);
  if (probe.tornadoCount !== 0 || probe.pagingContract !== false || probe.explicitHeight !== false) throw new Error(`${label}: auto-height probe must have no tornado/paging-contract/explicit height`);
  if (probe.page !== expectation.page || probe.pageCount !== expectation.pageCount) throw new Error(`${label}: forced page count mismatch`);
  assertDeepEqual(probe.pageIdentities, expectation.pageIdentities, `${label}: data-card-page-identities`);
  if (probe.footerCount !== 1) throw new Error(`${label}: forced weather footer missing`);
  assertNoOverflow(probe.card, `${label}: card`);
  if (!Number.isFinite(probe.maxHeight) || !Number.isFinite(probe.maxHeightGap)
    || probe.maxHeightGap <= 1 || probe.nonClamped !== true) throw new Error(`${label}: auto-height probe is clamped or max-height is unresolved`);
  return probe;
}

export function assertDesignAlignmentWeatherAutoProbe(record, expectation, label = record?.manifestKey ?? "weather auto probe") {
  const probe = assertDesignAlignmentWeatherAutoBaselineProbe(record, expectation, label);
  if (probe.activeIdentity !== expectation.activeIdentity || probe.pageKey !== expectation.pageKey) throw new Error(`${label}: forced active identity/page key mismatch`);
  if (probe.footer?.node == null) throw new Error(`${label}: forced weather footer missing`);
}

export function isDesignAlignmentSingleVisualLine(node, fragments = []) {
  if (node?.lineCount === 1) return true;
  const fragmentHeight = Math.max(...fragments.map((fragment) => fragment?.rect?.height).filter(Number.isFinite), 0);
  return Number.isFinite(node?.rect?.height) && fragmentHeight > 0 && node.rect.height <= fragmentHeight + 1;
}

function findRecords(records, scenario, viewport) {
  return records.filter((record) => record.scenario === scenario && record.viewport.label === viewport);
}

export function assertDesignAlignmentManifestCoverage(records) {
  const expected = DESIGN_ALIGNMENT_MANIFEST.map(manifestKey);
  const actual = records.map((record) => record.manifestKey ?? manifestKey(record));
  assertDeepEqual(actual, expected, "design-alignment manifest keys");
  if (new Set(actual).size !== actual.length) throw new Error("design-alignment manifest contains duplicate keys");
}

export function assertRecentQuakesGapManifestCoverage(records) {
  const expected = RECENT_QUAKES_GAP_MANIFEST.map(manifestKey);
  const actual = records.map((record) => record.manifestKey ?? manifestKey(record));
  assertDeepEqual(actual, expected, "recent-quakes-gap manifest keys");
  if (new Set(actual).size !== actual.length) throw new Error("recent-quakes-gap manifest contains duplicate keys");
}

export function assertDesignAlignmentBaselineStructure(records) {
  assertDesignAlignmentManifestCoverage(records);
  for (const record of records) assertRequiredReport(record, { allowLegacyTyphoonNodes: true });
  for (const [scenario, expectation] of Object.entries(DESIGN_ALIGNMENT_WEATHER_AUTO_PROBES)) {
    const record = findRecords(records, scenario, expectation.viewport)[0];
    if (record == null) throw new Error(`${scenario}: baseline auto-height record missing`);
    assertDesignAlignmentWeatherAutoBaselineProbe(record, expectation, `${scenario}: baseline`);
  }
  for (const viewport of ["1280x720", "960x620"]) {
    const plan = DESIGN_ALIGNMENT_COMPRESSED_PLANS[viewport];
    const cells = findRecords(records, "standby-design-alignment-compressed", viewport);
    const tickZeroPages = cells.filter((record) => record.cardPageTick === 0);
    assertDeepEqual(tickZeroPages.map((record) => record.rotationTick), [...Array(plan.rotationKeys.length).keys()], `${viewport} baseline rotation tick coverage`);
    for (const record of cells) {
      const layout = record.geometry.layout;
      assertDesignAlignmentCompressedStage(layout, plan, `${record.manifestKey}: baseline`);
    }
  }
  for (const [planKey, plan] of Object.entries(DESIGN_ALIGNMENT_MAX_PLANS)) {
    const maxCells = findRecords(records, "legacy-standby-gate", plan.viewport)
      .filter((record) => new URLSearchParams(record.query ?? "").get("maxPlan") === planKey);
    assertDeepEqual(maxCells.map((record) => record.rotationTick), [...Array(plan.captureTickCount).keys()], `${planKey} baseline max rotation tick coverage`);
    for (const record of maxCells) {
      const layout = record.geometry.layout;
      if (layout.ladderStage !== plan.stage || layout.measurementGeometryStage !== plan.stage || layout.compressed !== plan.compressed) throw new Error(`${record.manifestKey}: baseline max stage/compressed contract failed`);
    }
  }
  assertBaselineForecastCoverage(records);
  assertBaselineTyphoonCoverage(records);
}

function assertRequiredReport(record, { allowLegacyTyphoonNodes = false } = {}) {
  const report = record.geometry;
  if (report == null || report.ready !== true || report.settled !== true) throw new Error(`${record.manifestKey}: font/layout not ready`);
  assertDesignAlignmentApprox(report.rootFontSize, 16, 0.1, `${record.manifestKey} root font-size`);
  if (report.viewport.innerWidth !== record.viewport.width || report.viewport.innerHeight !== record.viewport.height || report.viewport.devicePixelRatio !== 1) throw new Error(`${record.manifestKey}: viewport mismatch`);
  if (report.fontSignature != null) designAlignmentCaptureEnvironmentSignature(record);
  for (const key of ["pageFooters", "naturalHeightProbes", "pagerContracts", "weatherCards"]) {
    if (!Array.isArray(report[key])) throw new Error(`${record.manifestKey}: required ${key} report field missing`);
  }
  if (typeof report.tokens?.roleMuted !== "string" || report.tokens.roleMuted === "") throw new Error(`${record.manifestKey}: role-muted token report missing`);
  if (Object.hasOwn(DESIGN_ALIGNMENT_WEATHER_AUTO_PROBES, record.scenario)) {
    if (report.weatherAuto == null) throw new Error(`${record.manifestKey}: required weather auto-height report missing`);
    return;
  }
  for (const key of ["ladderStage", "measurementGeometryStage", "rotationOmittedCount", "sideMeasureShelfWidth"]) {
    if (!Number.isFinite(report.layout[key])) throw new Error(`${record.manifestKey} layout.${key}: missing/non-finite`);
  }
  for (const key of ["placementLeft", "placementRight", "placementCenter", "rotationKeys", "cardOverflowKeys", "readableOverflowKeys", "visibleCards"]) {
    if (!Array.isArray(report.layout[key])) throw new Error(`${record.manifestKey} layout.${key}: missing`);
  }
  for (const visible of report.layout.visibleCards) {
    assertBox(visible.host, `${record.manifestKey} visible ${visible.key}:${visible.surface} host`);
    if (visible.component != null) assertBox(visible.component, `${record.manifestKey} visible ${visible.key}:${visible.surface} component`);
  }
  if (report.layout.unresolved !== "false" || report.layout.nonconverged !== "false") throw new Error(`${record.manifestKey}: unresolved/nonconverged layout`);
  if (report.layout.cardOverflowKeys.length !== 0 || report.layout.readableOverflowKeys.length !== 0) throw new Error(`${record.manifestKey}: generic containment failed`);
  const activeKind = record.scenario === "standby-design-alignment-compressed" || record.scenario === "legacy-standby-gate"
    ? report.layout.rotationActiveKey : record.scenario === "standby-briefing-design-alignment" ? "briefing"
      : record.scenario === "standby-vpwp50-forecast" ? "weatherWarningForecast"
        : record.scenario.startsWith("standby-vpta50-") ? "typhoon" : null;
  if (activeKind === "briefing" || report.briefing != null) {
    if (report.briefing == null || !Array.isArray(report.briefing.grids) || !Array.isArray(report.briefing.pageKeys) || !Array.isArray(report.briefing.pageIdentities)) throw new Error(`${record.manifestKey}: required Briefing report fields missing`);
    assertBox(report.briefing.card, `${record.manifestKey} briefing card`);
    if (report.briefing.pageAtom == null || typeof report.briefing.cardDisplay !== "string" || typeof report.briefing.cardFlexDirection !== "string") throw new Error(`${record.manifestKey}: Briefing flex ownership report missing`);
    assertBox(report.briefing.pageAtom.node, `${record.manifestKey} briefing page atom`);
    for (const [gridIndex, grid] of report.briefing.grids.entries()) {
      assertBox(grid.body, `${record.manifestKey} briefing grid ${gridIndex} body`);
      assertBox(grid.grid, `${record.manifestKey} briefing grid ${gridIndex}`);
      if (!Array.isArray(grid.stats)) throw new Error(`${record.manifestKey}: briefing grid stats missing`);
      for (const stat of grid.stats) {
        assertBox(stat.stat, `${record.manifestKey} briefing ${stat.role} stat`);
        assertBox(stat.value, `${record.manifestKey} briefing ${stat.role} value`);
        if (stat.role === "amount" && stat.numberUnit == null) throw new Error(`${record.manifestKey}: briefing amount NumberUnit report missing`);
      }
    }
  }
  if (activeKind === "weatherWarningForecast" || report.forecast != null) {
    if (report.forecast == null || !Array.isArray(report.forecast.periodKeys) || !Array.isArray(report.forecast.pageKeys) || !Array.isArray(report.forecast.pageIdentities)) throw new Error(`${record.manifestKey}: required forecast report fields missing`);
    for (const [name, box] of [["card", report.forecast.card], ["header", report.forecast.header], ["atom", report.forecast.atom], ["footer", report.forecast.footer], ["periods", report.forecast.periods]]) assertBox(box, `${record.manifestKey} forecast ${name}`);
    if (!Number.isFinite(report.forecast.naturalHeight) || !Number.isFinite(report.forecast.periodCount) || report.forecast.headerPadding == null) throw new Error(`${record.manifestKey}: forecast numeric fields missing`);
    for (const key of ["visibleTarget", "targetTitle", "atomAccessibleName", "cardAccessibleName", "footerCount", "continuationVisibleCount"]) {
      if (!Object.hasOwn(report.forecast, key) || report.forecast[key] == null) throw new Error(`${record.manifestKey}: forecast ${key} report missing`);
    }
  }
  if (activeKind === "typhoon") {
    if (report.typhoon == null || report.typhoon.scenario !== record.scenario || report.typhoon.header == null || !Array.isArray(report.typhoon.roles)) throw new Error(`${record.manifestKey}: required Typhoon report fields missing`);
    assertBox(report.typhoon.card, `${record.manifestKey} typhoon card`);
    for (const role of report.typhoon.roles) {
      for (const key of ["legacyNode", "probabilityNumber", "nuValue", "nuUnit"]) {
        if (!Object.hasOwn(role, key)) throw new Error(`${record.manifestKey}: Typhoon ${role.role}.${key} key missing`);
      }
      if (role.legacyNode != null) assertBox(role.legacyNode, `${record.manifestKey} Typhoon ${role.role} legacy node`);
      for (const key of ["probabilityNumber", "nuValue", "nuUnit"]) {
        if (role[key] == null) {
          if (!allowLegacyTyphoonNodes) throw new Error(`${record.manifestKey}: Typhoon ${role.role}.${key} missing`);
        } else assertBox(role[key], `${record.manifestKey} Typhoon ${role.role} ${key}`);
      }
    }
  }
}

export function requiresDesignAlignmentWidthMatch({ key, surface }) {
  return key === "briefing" || key === "weatherWarningForecast" || surface === "right" || surface === "rotation";
}

export function assertDesignAlignmentLiveMeasurementWidths(record) {
  const layout = record.geometry?.layout;
  if (layout == null || !Array.isArray(layout.visibleCards) || layout.measurementWidths == null) throw new Error(`${record.manifestKey}: width report missing`);
  for (const visible of layout.visibleCards.filter((card) => Object.hasOwn(DESIGN_ALIGNMENT_CANDIDATE_COUNTS, card.key) && requiresDesignAlignmentWidthMatch(card))) {
    const measuredWidth = layout.measurementWidths[visible.key];
    assertDesignAlignmentApprox(visible.component?.rect?.width, measuredWidth, 1, `${record.manifestKey} ${visible.key} live/measurement width`);
  }
}

export function assertDesignAlignmentCompressedStage(layout, plan, label) {
  if (layout?.ladderStage !== plan.stage || layout?.measurementGeometryStage !== plan.stage || layout.compressed !== true) {
    throw new Error(`${label}: compressed stage contract failed; expected ladder/measurement stage ${plan.stage}`);
  }
}

function assertCompressedPlan(records, viewport) {
  const plan = DESIGN_ALIGNMENT_COMPRESSED_PLANS[viewport];
  if (plan == null) throw new Error(`${viewport}: compressed plan missing`);
  const cells = findRecords(records, "standby-design-alignment-compressed", viewport);
  const expectedTicks = [...Array(plan.rotationKeys.length).keys()];
  const tickZeroPages = cells.filter((record) => record.cardPageTick === 0);
  assertDeepEqual(tickZeroPages.map((record) => record.rotationTick), expectedTicks, `${viewport} rotation tick coverage`);
  for (const record of cells) {
    const { layout } = record.geometry;
    assertDesignAlignmentCompressedStage(layout, plan, record.manifestKey);
    assertDeepEqual(layout.placementLeft, plan.placementLeft, `${record.manifestKey} left placement`);
    assertDeepEqual(layout.placementRight, plan.placementRight, `${record.manifestKey} right placement`);
    assertDeepEqual(layout.placementCenter, plan.placementCenter, `${record.manifestKey} center placement`);
    assertDeepEqual(layout.rotationKeys, plan.rotationKeys, `${record.manifestKey} rotation keys`);
    if (layout.rotationOmittedCount !== 0 || layout.typhoonVariant !== plan.typhoonVariant) throw new Error(`${record.manifestKey}: omitted rotation or Typhoon variant mismatch`);
    assertDeepEqual(layout.candidateCounts, DESIGN_ALIGNMENT_CANDIDATE_COUNTS, `${record.manifestKey} candidate counts`);
    assertDeepEqual(record.geometry.riderReserveCounts, DESIGN_ALIGNMENT_RIDER_COUNTS, `${record.manifestKey} rider/reserve counts`);
    assertDeepEqual(record.geometry.payloadSignature, DESIGN_ALIGNMENT_PAYLOAD_SIGNATURE, `${record.manifestKey} payload signature`);
    const active = plan.rotationKeys[record.rotationTick % plan.rotationKeys.length];
    if (layout.rotationActiveKey !== active || layout.rotationPosition !== `${record.rotationTick + 1}/${plan.rotationKeys.length}`) throw new Error(`${record.manifestKey}: active rotation mismatch`);
    const visibleCandidates = layout.visibleCards.filter((card) => Object.hasOwn(DESIGN_ALIGNMENT_CANDIDATE_COUNTS, card.key)).map(({ key, surface }) => ({ key, surface }));
    const expectedVisibleCount = plan.placementLeft.length + plan.placementRight.length + plan.placementCenter.length + 1;
    if (visibleCandidates.length !== expectedVisibleCount) throw new Error(`${record.manifestKey}: visible candidate count mismatch`);
    for (const [surface, expectedKeys] of [
      ["left", plan.placementLeft], ["right", plan.placementRight], ["center", plan.placementCenter], ["rotation", [active]],
    ]) {
      assertDeepEqual(visibleCandidates.filter((card) => card.surface === surface).map((card) => card.key), expectedKeys, `${record.manifestKey} visible ${surface} placement`);
    }
    assertDesignAlignmentLiveMeasurementWidths(record);
  }
}

export function assertDesignAlignmentMaxFixture(records) {
  for (const [planKey, plan] of Object.entries(DESIGN_ALIGNMENT_MAX_PLANS)) {
    const cells = findRecords(records, "legacy-standby-gate", plan.viewport)
      .filter((record) => new URLSearchParams(record.query ?? "").get("maxPlan") === planKey);
    if (cells.length === 0) continue;
    assertDeepEqual(cells.map((record) => record.rotationTick), [...Array(plan.captureTickCount).keys()], `${planKey} max rotation tick coverage`);
    for (const record of cells) {
      const { layout } = record.geometry;
      if (layout.ladderStage !== plan.stage || layout.measurementGeometryStage !== plan.stage || layout.compressed !== plan.compressed) throw new Error(`${record.manifestKey}: max stage/compressed mismatch`);
      assertDesignAlignmentLiveMeasurementWidths(record);
    }
  }
}

function statByRole(grid, role) {
  return grid.stats.find((stat) => stat.role === role);
}

function assertBriefingCaptureCoverage(records) {
  for (const [scenario, viewport, tick] of [
    ["standby-briefing-design-alignment", "1280x720", null],
    ["standby-design-alignment-compressed", "1280x720", DESIGN_ALIGNMENT_COMPRESSED_PLANS["1280x720"].briefingCaptureTick],
    ["standby-design-alignment-compressed", "960x620", DESIGN_ALIGNMENT_COMPRESSED_PLANS["960x620"].briefingCaptureTick],
  ]) {
    const cells = findRecords(records, scenario, viewport);
    if (scenario === "standby-design-alignment-compressed" && viewport === "1280x720" && cells.some((record) => record.geometry.briefing == null)) {
      throw new Error(`${scenario}/${viewport}: side Briefing was not visible for every rotation tick`);
    }
    const reports = cells
      .filter((record) => scenario !== "standby-design-alignment-compressed" || record.rotationTick === tick)
      .map((record) => record.geometry.briefing).filter(Boolean);
    const facts = reports.flatMap((report) => report.grids).map(({ location, amount, approximation }) => ({ location, amount, approximation }));
    for (const expected of [
      { location: "さいたま市", amount: "約100mm", approximation: "approx" },
      { location: "美幌町", amount: "120mm以上", approximation: "atLeast" },
    ]) {
      if (!facts.some((fact) => stableJson(fact) === stableJson(expected))) throw new Error(`${scenario}/${viewport}: required precipitation fact was not captured: ${JSON.stringify(expected)}`);
    }
  }
}

function assertBaselineForecastCoverage(records) {
  for (const [scenario, viewport, tick] of [
    ["standby-vpwp50-forecast", "1280x720", null],
    ["standby-design-alignment-compressed", "1280x720", DESIGN_ALIGNMENT_COMPRESSED_PLANS["1280x720"].forecastCaptureTick],
    ["standby-design-alignment-compressed", "960x620", DESIGN_ALIGNMENT_COMPRESSED_PLANS["960x620"].forecastCaptureTick],
  ]) {
    const cells = findRecords(records, scenario, viewport);
    if (scenario === "standby-design-alignment-compressed" && viewport === "1280x720" && cells.some((record) => record.geometry.forecast == null)) {
      throw new Error(`${scenario}/${viewport}: side forecast was not visible for every rotation tick`);
    }
    const forecast = cells.find((record) => record.rotationTick === tick && record.cardPageTick === 0)?.geometry.forecast;
    if (forecast == null || forecast.periodCount !== 4 || forecast.periodKeys.length !== 4 || forecast.footer == null || !/^\d+\/32$/.test(forecast.page)) throw new Error(`${scenario}/${viewport}: 128-period forecast max atom/footer was not captured`);
  }
}

function assertBaselineTyphoonCoverage(records) {
  const targets = [
    { scenario: "standby-vpta50-probability-muted", viewport: "1280x720", tick: null, mode: "full", prefectures: 5, tone: "muted" },
    { scenario: "standby-vpta50-probability-normal", viewport: "1280x720", tick: null, mode: "full", prefectures: 5, tone: "normal" },
    { scenario: "standby-design-alignment-compressed", viewport: "1280x720", tick: DESIGN_ALIGNMENT_COMPRESSED_PLANS["1280x720"].typhoonCaptureTick, mode: "compact", prefectures: 3, tone: null },
    { scenario: "standby-design-alignment-compressed", viewport: "960x620", tick: DESIGN_ALIGNMENT_COMPRESSED_PLANS["960x620"].typhoonCaptureTick, mode: "compact", prefectures: 3, tone: null },
  ];
  for (const target of targets) {
    const typhoon = findRecords(records, target.scenario, target.viewport).find((record) => record.rotationTick === target.tick && record.cardPageTick === 0)?.geometry.typhoon;
    if (typhoon == null || typhoon.displayMode !== target.mode) throw new Error(`${target.scenario}/${target.viewport}: ${target.mode} Typhoon was not captured`);
    const counts = Object.fromEntries(["maximum", "prefecture", "worst"].map((role) => [role, typhoon.roles.filter((entry) => entry.role === role).length]));
    assertDeepEqual(counts, { maximum: 1, prefecture: target.prefectures, worst: 1 }, `${target.scenario}/${target.viewport} baseline probability roles`);
    if (typhoon.roles.some((role) => role.legacyNode == null || role.unit !== "%")) throw new Error(`${target.scenario}/${target.viewport}: legacy probability node/value missing`);
    if (target.tone === "muted") {
      if (!typhoon.header.className.split(/\s+/).includes("standby-card-header--muted") || typhoon.header.customProperties.container !== "" || typhoon.header.customProperties.on !== "" || typhoon.header.customProperties.band !== "") throw new Error(`${target.scenario}: muted header fixture mismatch`);
    } else if (target.tone === "normal") {
      if ([typhoon.header.customProperties.container, typhoon.header.customProperties.on, typhoon.header.customProperties.band].some((value) => value === "") || typhoon.header.bandWidth !== 4) throw new Error(`${target.scenario}: VPTW header fixture mismatch`);
    }
  }
}

export function assertDesignAlignmentBriefingGrid(grid, expectation, label = "briefing grid") {
  if (grid == null) throw new Error(`${label}: missing`);
  assertNoOverflow(grid.body, `${label} body`);
  assertNoOverflow(grid.grid, `${label} grid`);
  assertDesignAlignmentApprox(grid.bodyPadding.left, expectation.padding, 0.1, `${label} body padding-left`);
  assertDesignAlignmentApprox(grid.bodyPadding.right, expectation.padding, 0.1, `${label} body padding-right`);
  assertDesignAlignmentApprox(grid.rowGap, expectation.rowGap, 0.1, `${label} row gap`);
  assertDesignAlignmentApprox(grid.columnGap, expectation.columnGap, 0.1, `${label} column gap`);
  assertDesignAlignmentApprox(grid.margin.left, 0, 0.1, `${label} margin-left`);
  assertDesignAlignmentApprox(grid.margin.right, 0, 0.1, `${label} margin-right`);
  const columns = grid.gridTemplateColumns.trim().split(/\s+/).map(Number.parseFloat);
  if (columns.length !== 2 || columns.some((column) => !Number.isFinite(column))) throw new Error(`${label}: grid did not resolve to exactly two columns`);
  for (const [index, column] of columns.entries()) assertDesignAlignmentApprox(column, expectation.statWidth, 1, `${label} grid column ${index + 1}`);
  assertDesignAlignmentApprox(grid.grid.rect.left, grid.body.rect.left + grid.bodyPadding.left, 1, `${label} left gutter`);
  assertDesignAlignmentApprox(grid.grid.rect.right, grid.body.rect.right - grid.bodyPadding.right, 1, `${label} right gutter`);
  assertDeepEqual(grid.stats.map((stat) => stat.role), ["location", "amount", "time", "duration"], `${label} stat DOM order`);
  const [location, amount, time, duration] = grid.stats;
  for (const stat of grid.stats) {
    assertNoOverflow(stat.stat, `${label} ${stat.role}`);
    assertDesignAlignmentApprox(stat.stat.rect.width, expectation.statWidth, 1, `${label} ${stat.role} width`);
    assertDesignAlignmentApprox(stat.gap, expectation.statGap, 0.1, `${label} ${stat.role} gap`);
    assertNoOverflow(stat.value, `${label} ${stat.role} value`);
  }
  assertDesignAlignmentApprox(location.stat.rect.top, amount.stat.rect.top, 1, `${label} first row`);
  assertDesignAlignmentApprox(time.stat.rect.top, duration.stat.rect.top, 1, `${label} second row`);
  if (time.stat.rect.top <= location.stat.rect.top + 1) throw new Error(`${label}: rows did not resolve as 2x2`);
  assertDesignAlignmentApprox(location.stat.rect.left, time.stat.rect.left, 1, `${label} left column`);
  assertDesignAlignmentApprox(amount.stat.rect.left, duration.stat.rect.left, 1, `${label} right column`);
  if (location.value.lineCount !== 1 || !isDesignAlignmentSingleVisualLine(amount.value, [amount.numberUnit?.value, amount.numberUnit?.unit])) throw new Error(`${label}: location/amount wrapped`);
  if (amount.numberUnit == null) throw new Error(`${label}: amount NumberUnit missing`);
  for (const [name, node] of Object.entries(amount.numberUnit)) {
    assertNoOverflow(node, `${label} NumberUnit ${name}`);
    const fragments = name === "wrapper" ? [amount.numberUnit.value, amount.numberUnit.unit] : [];
    if (!isDesignAlignmentSingleVisualLine(node, fragments)) throw new Error(`${label} NumberUnit ${name}: wrapped`);
  }
}

function assertBriefingMatrix(records) {
  const matrix = [
    { scenario: "standby-briefing-design-alignment", viewport: "1280x720", cardWidth: 307.2, padding: 16, rowGap: 4, columnGap: 12, statWidth: 130.6, statGap: 4 },
    { scenario: "standby-design-alignment-compressed", viewport: "1280x720", cardWidth: 321.28, padding: 8, rowGap: 2, columnGap: 6, statWidth: 148.64, statGap: 2 },
    { scenario: "standby-design-alignment-compressed", viewport: "960x620", cardWidth: 280, padding: 8, rowGap: 2, columnGap: 6, statWidth: 128, statGap: 2 },
  ];
  for (const condition of matrix) {
    const briefingTick = condition.scenario === "standby-design-alignment-compressed"
      ? DESIGN_ALIGNMENT_COMPRESSED_PLANS[condition.viewport].briefingCaptureTick : null;
    const relevant = findRecords(records, condition.scenario, condition.viewport)
      .filter((record) => condition.scenario !== "standby-design-alignment-compressed" || record.rotationTick === briefingTick);
    const briefingReports = relevant.map((record) => record.geometry.briefing).filter(Boolean);
    const grids = briefingReports.flatMap((briefing) => briefing.grids);
    const byLocation = new Map(grids.map((grid) => [grid.location, grid]));
    if (!byLocation.has("さいたま市") || !byLocation.has("美幌町")) throw new Error(`${condition.scenario}/${condition.viewport}: both real precipitation facts were not captured`);
    for (const [location, expectedAmount] of [["さいたま市", "約100mm"], ["美幌町", "120mm以上"]]) {
      const grid = byLocation.get(location);
      if (grid.amount !== expectedAmount) throw new Error(`${condition.scenario}/${condition.viewport}/${location}: expected ${expectedAmount}, got ${grid.amount}`);
      assertDesignAlignmentBriefingGrid(grid, condition, `${condition.scenario}/${condition.viewport}/${location}`);
      const amountStat = statByRole(grid, "amount");
      const expectedNumber = location === "さいたま市" ? "100" : "120";
      if (grid.approximation !== (location === "さいたま市" ? "approx" : "atLeast")
        || amountStat?.numberUnit?.value?.text !== expectedNumber || amountStat?.numberUnit?.unit?.text !== "mm") {
        throw new Error(`${condition.scenario}/${condition.viewport}/${location}: precipitation value/qualifier changed`);
      }
      const card = briefingReports.find((report) => report.grids.includes(grid))?.card;
      assertDesignAlignmentApprox(card?.rect?.width, condition.cardWidth, 1, `${condition.scenario}/${condition.viewport} card width`);
    }
    const measuredWidth = relevant[0]?.geometry.layout.measurementWidths.briefing;
    const liveWidth = briefingReports.find((report) => report.grids.length > 0)?.card?.rect?.width;
    assertDesignAlignmentApprox(liveWidth, measuredWidth, 1, `${condition.scenario}/${condition.viewport} briefing live/measurement width`);
  }
}

function assertForecastGeometry(forecast, compressed, label) {
  if (forecast == null) throw new Error(`${label}: forecast missing`);
  for (const [name, box] of [["card", forecast.card], ["header", forecast.header], ["atom", forecast.atom], ["footer", forecast.footer], ["periods", forecast.periods]]) assertNoOverflow(box, `${label} ${name}`);
  const block = compressed ? 4 : 8;
  const inline = compressed ? 8 : 16;
  assertDesignAlignmentApprox(forecast.headerPadding.top, block, 0.1, `${label} header padding-top`);
  assertDesignAlignmentApprox(forecast.headerPadding.bottom, block, 0.1, `${label} header padding-bottom`);
  assertDesignAlignmentApprox(forecast.headerPadding.left, inline, 0.1, `${label} header padding-left`);
  assertDesignAlignmentApprox(forecast.headerPadding.right, inline, 0.1, `${label} header padding-right`);
  assertDesignAlignmentApprox(forecast.periodGap, compressed ? 2 : 4, 0.1, `${label} period gap`);
  if (forecast.periodCount !== 4 || forecast.periodKeys.length !== 4 || forecast.footer == null || !/^\d+\/32$/.test(forecast.page)) throw new Error(`${label}: max atom/footer contract failed`);
  if (forecast.atomFooterOverlap > 1) throw new Error(`${label}: atom/footer overlap ${forecast.atomFooterOverlap}`);
}

function assertForecast(records, baseline) {
  const targets = [
    { scenario: "standby-vpwp50-forecast", viewport: "1280x720", tick: null, footerDelta: 9, compressed: false },
    { scenario: "standby-design-alignment-compressed", viewport: "1280x720", tick: DESIGN_ALIGNMENT_COMPRESSED_PLANS["1280x720"].forecastCaptureTick, footerDelta: 5, compressed: true },
    { scenario: "standby-design-alignment-compressed", viewport: "960x620", tick: DESIGN_ALIGNMENT_COMPRESSED_PLANS["960x620"].forecastCaptureTick, footerDelta: 5, compressed: true },
  ];
  for (const target of targets) {
    const afterRecord = findRecords(records, target.scenario, target.viewport).find((record) => record.rotationTick === target.tick && record.cardPageTick === 0);
    const beforeRecord = baseline.records.find((record) => record.manifestKey === afterRecord?.manifestKey);
    if (afterRecord == null || beforeRecord == null) throw new Error(`${target.scenario}/${target.viewport}: forecast comparison record missing`);
    const after = afterRecord.geometry.forecast;
    const before = beforeRecord.geometry.forecast;
    assertForecastGeometry(after, target.compressed, `${target.scenario}/${target.viewport}`);
    if (before == null) throw new Error(`${target.scenario}/${target.viewport}: baseline forecast missing`);
    assertDeepEqual(after.periodKeys, before.periodKeys, `${target.scenario}/${target.viewport} period keys`);
    assertDeepEqual(after.pageKeys, before.pageKeys, `${target.scenario}/${target.viewport} page keys`);
    assertDeepEqual(after.pageIdentities, before.pageIdentities, `${target.scenario}/${target.viewport} page identities`);
    if (after.identity !== before.identity) throw new Error(`${target.scenario}/${target.viewport}: atom identity changed`);
    assertDesignAlignmentApprox(after.header.rect.height - before.header.rect.height, 0, 1, `${target.scenario}/${target.viewport} forecast header height delta`);
    assertDesignAlignmentApprox(after.periods.rect.height - before.periods.rect.height, 0, 1, `${target.scenario}/${target.viewport} forecast periods height delta`);
    const footerDelta = after.footer.rect.height - before.footer.rect.height;
    assertDesignAlignmentApprox(footerDelta, target.footerDelta, 1, `${target.scenario}/${target.viewport} forecast footer height delta`);
    assertDesignAlignmentApprox(after.atom.rect.height - before.atom.rect.height, 0, 1, `${target.scenario}/${target.viewport} forecast atom height delta`);
    assertDesignAlignmentApprox(after.naturalHeight - before.naturalHeight, target.footerDelta, 1, `${target.scenario}/${target.viewport} forecast natural height delta`);
  }
}

export function assertDesignAlignmentTyphoonProbability(typhoon, { mode, valueFontSize, prefectureCount, header }, label = "typhoon") {
  if (typhoon == null || typhoon.displayMode !== mode) throw new Error(`${label}: expected ${mode} Typhoon`);
  assertNoOverflow(typhoon.card, `${label} card`);
  const counts = Object.fromEntries(["maximum", "prefecture", "worst"].map((role) => [role, typhoon.roles.filter((entry) => entry.role === role).length]));
  assertDeepEqual(counts, { maximum: 1, prefecture: prefectureCount, worst: 1 }, `${label} probability roles`);
  for (const role of typhoon.roles) {
    for (const [name, node] of [["probabilityNumber", role.probabilityNumber], ["nuValue", role.nuValue], ["nuUnit", role.nuUnit]]) {
      assertNoOverflow(node, `${label} ${role.role}/${role.label} ${name}`);
      const fragments = name === "probabilityNumber" ? [role.nuValue, role.nuUnit] : [];
      if (!isDesignAlignmentSingleVisualLine(node, fragments)) throw new Error(`${label} ${role.role}/${role.label} ${name}: wrapped`);
    }
    if (role.unit !== "%") throw new Error(`${label} ${role.role}/${role.label}: unit is not %`);
    assertDesignAlignmentApprox(role.nuValue.fontSize, valueFontSize, 0.1, `${label} ${role.role}/${role.label} value font-size`);
    assertDesignAlignmentApprox(role.nuUnit.fontSize, 12, 0.1, `${label} ${role.role}/${role.label} unit font-size`);
    if (role.nuValue.fontWeight !== typhoon.resolvedNumWeight) throw new Error(`${label} ${role.role}/${role.label}: --num-weight mismatch`);
    if (!role.nuValue.fontVariantNumeric.split(/\s+/).includes("tabular-nums") || role.nuUnit.fontVariantNumeric !== "normal") throw new Error(`${label} ${role.role}/${role.label}: NumberUnit font-variant hierarchy mismatch`);
  }
  const tone = typhoon.header;
  if (tone == null) throw new Error(`${label}: header missing`);
  if (header === "muted") {
    if (tone.customProperties.container !== "" || tone.customProperties.on !== "" || tone.customProperties.band !== "") throw new Error(`${label}: muted header has semantic custom properties`);
    if (!tone.className.split(/\s+/).includes("standby-card-header--muted") || tone.background !== "rgba(0, 0, 0, 0)" || tone.color !== tone.roleMuted || tone.bandWidth !== 0) throw new Error(`${label}: muted header rendering mismatch`);
  } else if (header === "normal") {
    if ([tone.customProperties.container, tone.customProperties.on, tone.customProperties.band].some((value) => value === "") || tone.background === "rgba(0, 0, 0, 0)") throw new Error(`${label}: VPTW header variables/background missing`);
    assertDesignAlignmentApprox(tone.bandWidth, 4, 0.1, `${label} header band`);
  }
}

function roleValues(typhoon) {
  return typhoon.roles.map(({ role, label, value, unit }) => ({ role, label, value, unit }));
}

function assertTyphoon(records) {
  const muted = findRecords(records, "standby-vpta50-probability-muted", "1280x720")[0]?.geometry.typhoon;
  const normal = findRecords(records, "standby-vpta50-probability-normal", "1280x720")[0]?.geometry.typhoon;
  assertDesignAlignmentTyphoonProbability(muted, { mode: "full", valueFontSize: 19, prefectureCount: 5, header: "muted" }, "VPTA muted");
  assertDesignAlignmentTyphoonProbability(normal, { mode: "full", valueFontSize: 19, prefectureCount: 5, header: "normal" }, "VPTA normal");
  assertDeepEqual(roleValues(muted), roleValues(normal), "VPTA probability/header independence");
  assertDeepEqual(muted.roles.map(({ role, value }) => ({ role, value })), [
    { role: "maximum", value: 80 },
    { role: "prefecture", value: 80 }, { role: "prefecture", value: 70 }, { role: "prefecture", value: 60 },
    { role: "prefecture", value: 50 }, { role: "prefecture", value: 40 },
    { role: "worst", value: 80 },
  ], "VPTA full visible values");
  for (const viewport of ["1280x720", "960x620"]) {
    const tick = DESIGN_ALIGNMENT_COMPRESSED_PLANS[viewport].typhoonCaptureTick;
    const compact = findRecords(records, "standby-design-alignment-compressed", viewport).find((record) => record.rotationTick === tick && record.cardPageTick === 0)?.geometry.typhoon;
    assertDesignAlignmentTyphoonProbability(compact, { mode: "compact", valueFontSize: 14, prefectureCount: 3, header: null }, `VPTA compact ${viewport}`);
    assertDeepEqual(compact.roles.map(({ role, value }) => ({ role, value })), [
      { role: "maximum", value: 80 },
      { role: "prefecture", value: 80 }, { role: "prefecture", value: 70 }, { role: "prefecture", value: 60 },
      { role: "worst", value: 80 },
    ], `VPTA compact ${viewport} visible values`);
  }
}

export function assertDesignAlignmentBaselineIdentity(records, baselineRecords) {
  if (!Array.isArray(baselineRecords)) throw new Error("design-alignment baseline records missing");
  const beforeByKey = new Map(baselineRecords.map((record) => [record.manifestKey, record]));
  for (const after of records) {
    const before = beforeByKey.get(after.manifestKey);
    if (before == null) throw new Error(`${after.manifestKey}: baseline record missing`);
    for (const key of ["scenario", "rotationTick", "cardPageTick", "query", "urlIdentity"]) {
      if (before[key] !== after[key]) throw new Error(`${after.manifestKey}: baseline ${key} mismatch`);
    }
    assertDeepEqual(before.viewport, after.viewport, `${after.manifestKey} baseline viewport`);
    const afterEnvironment = after.geometry?.fontSignature == null ? null : designAlignmentCaptureEnvironmentSignature(after);
    const beforeEnvironment = before.geometry?.fontSignature == null ? null : designAlignmentCaptureEnvironmentSignature(before);
    if (afterEnvironment != null && beforeEnvironment != null) {
      assertDeepEqual(afterEnvironment, beforeEnvironment, `${after.manifestKey}: baseline/after Chrome/font/DPR`);
    }
  }
  if (beforeByKey.size !== records.length) throw new Error("design-alignment baseline has extra records");
}

function numericComparison(before, after) {
  const base = Number.isFinite(before) ? before : null;
  const current = Number.isFinite(after) ? after : null;
  return { base, after: current, delta: base == null || current == null ? null : current - base };
}

function placementSnapshot(layout) {
  return {
    left: Array.isArray(layout?.placementLeft) ? layout.placementLeft : [],
    right: Array.isArray(layout?.placementRight) ? layout.placementRight : [],
    center: Array.isArray(layout?.placementCenter) ? layout.placementCenter : [],
  };
}

function placementMemberKeys(placement) {
  return [...placement.left, ...placement.right, ...placement.center].sort();
}

function rotationSnapshot(layout) {
  return {
    keys: Array.isArray(layout?.rotationKeys) ? layout.rotationKeys : [],
    omittedCount: Number.isFinite(layout?.rotationOmittedCount) ? layout.rotationOmittedCount : null,
    activeKey: layout?.rotationActiveKey ?? null,
    position: layout?.rotationPosition ?? null,
  };
}

function visibleCardSnapshot(layout) {
  if (!Array.isArray(layout?.visibleCards)) return [];
  return layout.visibleCards.map(({ key, surface }) => ({ key, surface }));
}

function visibleCardHeights(layout) {
  if (!Array.isArray(layout?.visibleCards)) return {};
  return Object.fromEntries(layout.visibleCards.map((card) => [
    card.key,
    Number.isFinite(card.component?.rect?.height) ? card.component.rect.height
      : Number.isFinite(card.host?.rect?.height) ? card.host.rect.height : null,
  ]));
}

function scalarComparison(before, after) {
  const base = before ?? null;
  const current = after ?? null;
  return { base, after: current, changed: base !== current };
}

function heightComparison(beforeLayout, afterLayout) {
  const base = visibleCardHeights(beforeLayout);
  const after = visibleCardHeights(afterLayout);
  const delta = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(after)])) delta[key] = numericComparison(base[key], after[key]).delta;
  return { base, after, delta };
}

function recentQuakesComparison(before, after) {
  if (before == null || after == null) return null;
  const rects = {};
  for (const name of ["root", "firstRow", "rowMain", "stats", "magnitude", "depth", "time"]) {
    rects[name] = Object.fromEntries(["x", "y", "left", "right", "top", "bottom", "width", "height"]
      .map((key) => [key, numericComparison(before[name]?.rect?.[key], after[name]?.rect?.[key])]));
  }
  return {
    rects,
    rootInlineSize: numericComparison(before.rootInlineSize, after.rootInlineSize),
    rowGap: numericComparison(before.rowGap, after.rowGap),
    columnGap: numericComparison(before.columnGap, after.columnGap),
    resolvedSpace1: numericComparison(before.resolvedSpace1, after.resolvedSpace1),
    resolvedSpace2: numericComparison(before.resolvedSpace2, after.resolvedSpace2),
    resolvedSpace3: numericComparison(before.resolvedSpace3, after.resolvedSpace3),
    actualGaps: {
      magnitudeDepth: numericComparison(actualHorizontalGap(before.magnitude, before.depth), actualHorizontalGap(after.magnitude, after.depth)),
      depthTime: numericComparison(actualHorizontalGap(before.depth, before.time), actualHorizontalGap(after.depth, after.time)),
    },
  };
}

export function buildDesignAlignmentComparison(records, baselineRecords) {
  assertDesignAlignmentBaselineIdentity(records, baselineRecords);
  const beforeByKey = new Map(baselineRecords.map((record) => [record.manifestKey, record]));
  return records.map((afterRecord) => {
    const beforeRecord = beforeByKey.get(afterRecord.manifestKey);
    const before = beforeRecord.geometry;
    const after = afterRecord.geometry;
    const basePlacement = placementSnapshot(before.layout);
    const afterPlacement = placementSnapshot(after.layout);
    const baseRotation = rotationSnapshot(before.layout);
    const afterRotation = rotationSnapshot(after.layout);
    const baseVisibleCards = visibleCardSnapshot(before.layout);
    const afterVisibleCards = visibleCardSnapshot(after.layout);
    return {
      manifestKey: afterRecord.manifestKey,
      scenario: afterRecord.scenario,
      viewport: afterRecord.viewport,
      rotationTick: afterRecord.rotationTick,
      cardPageTick: afterRecord.cardPageTick,
      query: afterRecord.query ?? null,
      stages: {
        ladder: numericComparison(before.layout?.ladderStage, after.layout?.ladderStage),
        measurementGeometry: numericComparison(before.layout?.measurementGeometryStage, after.layout?.measurementGeometryStage),
      },
      compressed: scalarComparison(before.layout?.compressed, after.layout?.compressed),
      rotationOmittedCount: numericComparison(before.layout?.rotationOmittedCount, after.layout?.rotationOmittedCount),
      placement: { base: basePlacement, after: afterPlacement, changed: stableJson(basePlacement) !== stableJson(afterPlacement) },
      rotation: { base: baseRotation, after: afterRotation, changed: stableJson(baseRotation) !== stableJson(afterRotation) },
      typhoonVariant: {
        base: before.layout?.typhoonVariant ?? null,
        after: after.layout?.typhoonVariant ?? null,
        changed: before.layout?.typhoonVariant !== after.layout?.typhoonVariant,
      },
      visibleCards: { base: baseVisibleCards, after: afterVisibleCards, changed: stableJson(baseVisibleCards) !== stableJson(afterVisibleCards) },
      cardHeights: heightComparison(before.layout, after.layout),
      forecastNaturalHeight: numericComparison(before.forecast?.naturalHeight, after.forecast?.naturalHeight),
      forecastGeometry: {
        header: numericComparison(before.forecast?.header?.rect?.height, after.forecast?.header?.rect?.height),
        atom: numericComparison(before.forecast?.atom?.rect?.height, after.forecast?.atom?.rect?.height),
        periods: numericComparison(before.forecast?.periods?.rect?.height, after.forecast?.periods?.rect?.height),
        footer: numericComparison(before.forecast?.footer?.rect?.height, after.forecast?.footer?.rect?.height),
      },
      recentQuakes: recentQuakesComparison(before.recentQuakes, after.recentQuakes),
    };
  });
}

function assertDesignAlignmentPlanComparison(comparison) {
  for (const [name, stage] of Object.entries(comparison.stages)) {
    if (stage.base == null || stage.after == null || stage.delta !== 0) throw new Error(`${comparison.manifestKey}: base/after ${name} stage must remain unchanged`);
  }
  const maxPlanKey = comparison.scenario === "legacy-standby-gate"
    ? new URLSearchParams(comparison.query ?? "").get("maxPlan") : null;
  const maxPlan = maxPlanKey == null ? null : DESIGN_ALIGNMENT_MAX_PLANS[maxPlanKey];
  const expectedCompressed = comparison.scenario === "standby-design-alignment-compressed" ? true : maxPlan?.compressed;
  if (expectedCompressed == null || (maxPlan != null && comparison.viewport.label !== maxPlan.viewport)) throw new Error(`${comparison.manifestKey}: max plan/comparison mismatch`);
  if (maxPlanKey === "fhdMax") {
    assertDeepEqual(placementMemberKeys(comparison.placement.base), placementMemberKeys(comparison.placement.after), `${comparison.manifestKey}: base/after visible placement set`);
    if (comparison.rotation.changed) throw new Error(`${comparison.manifestKey}: base/after rotation changed`);
    for (const [phase, rotation] of [["base", comparison.rotation.base], ["after", comparison.rotation.after]]) {
      if (rotation.keys.length !== 0 || rotation.omittedCount !== 0 || rotation.activeKey !== "" || rotation.position !== "") throw new Error(`${comparison.manifestKey}: ${phase} fhdMax rotation must remain empty`);
    }
  } else {
    for (const [name, snapshot] of [["placement", comparison.placement], ["rotation", comparison.rotation], ["visible cards", comparison.visibleCards]]) {
      if (snapshot.changed) throw new Error(`${comparison.manifestKey}: base/after ${name} changed`);
    }
  }
  if (comparison.typhoonVariant.changed) throw new Error(`${comparison.manifestKey}: base/after Typhoon variant changed`);
  if (comparison.compressed.base !== expectedCompressed || comparison.compressed.after !== expectedCompressed || comparison.compressed.changed) throw new Error(`${comparison.manifestKey}: base/after compressed state changed; expected ${expectedCompressed}`);
  const expectedOmittedCount = maxPlanKey === "fhdMax" ? 0 : comparison.rotationOmittedCount.base;
  if (expectedOmittedCount == null || comparison.rotationOmittedCount.base !== expectedOmittedCount || comparison.rotationOmittedCount.after !== expectedOmittedCount || comparison.rotationOmittedCount.delta !== 0) throw new Error(`${comparison.manifestKey}: base/after omitted rotation count changed`);
}

export function assertDesignAlignmentComparisonPolicy(comparisons) {
  for (const comparison of comparisons.filter((entry) => entry.scenario === "standby-design-alignment-compressed" || entry.scenario === "legacy-standby-gate")) {
    assertDesignAlignmentPlanComparison(comparison);
  }
  for (const target of [
    { scenario: "standby-vpwp50-forecast", viewport: "1280x720", tick: null, footerDelta: 9 },
    { scenario: "standby-design-alignment-compressed", viewport: "1280x720", tick: DESIGN_ALIGNMENT_COMPRESSED_PLANS["1280x720"].forecastCaptureTick, footerDelta: 5 },
    { scenario: "standby-design-alignment-compressed", viewport: "960x620", tick: DESIGN_ALIGNMENT_COMPRESSED_PLANS["960x620"].forecastCaptureTick, footerDelta: 5 },
  ]) {
    const comparison = comparisons.find((entry) => entry.scenario === target.scenario
      && entry.viewport.label === target.viewport && entry.rotationTick === target.tick && entry.cardPageTick === 0);
    if (comparison == null) throw new Error(`${target.scenario}/${target.viewport}: forecast comparison record missing`);
    assertDesignAlignmentApprox(comparison.forecastGeometry.header.delta, 0, 1, `${target.scenario}/${target.viewport} forecast header height delta`);
    assertDesignAlignmentApprox(comparison.forecastGeometry.periods.delta, 0, 1, `${target.scenario}/${target.viewport} forecast periods height delta`);
    assertDesignAlignmentApprox(comparison.forecastGeometry.footer.delta, target.footerDelta, 1, `${target.scenario}/${target.viewport} forecast footer height delta`);
    assertDesignAlignmentApprox(comparison.forecastGeometry.atom.delta, 0, 1, `${target.scenario}/${target.viewport} forecast atom height delta`);
    assertDesignAlignmentApprox(comparison.forecastNaturalHeight.delta, target.footerDelta, 1, `${target.scenario}/${target.viewport} forecast natural height delta`);
  }
}

export function assertRecentQuakesGapComparisonPolicy(comparisons) {
  if (comparisons.length !== RECENT_QUAKES_GAP_TARGETS.length) throw new Error(`recent-quakes-gap comparison count: expected ${RECENT_QUAKES_GAP_TARGETS.length}, got ${comparisons.length}`);
  for (const target of RECENT_QUAKES_GAP_TARGETS) {
    const matches = comparisons.filter((comparison) => matchesRecentQuakesGapTarget(comparison, target));
    if (matches.length !== 1) throw new Error(`${target.name}: expected exactly one RecentQuakes comparison, got ${matches.length}`);
    const comparison = matches[0];
    const recentQuakes = comparison.recentQuakes;
    if (recentQuakes == null) throw new Error(`${comparison.manifestKey}: RecentQuakes comparison missing`);
    for (const [name, token] of Object.entries({
      space1: recentQuakes.resolvedSpace1,
      space2: recentQuakes.resolvedSpace2,
      space3: recentQuakes.resolvedSpace3,
    })) {
      if (token.base == null || token.after == null || token.delta !== 0) throw new Error(`${comparison.manifestKey}: RecentQuakes ${name} base/after changed`);
    }
    if (target.narrow) {
      assertDesignAlignmentApprox(recentQuakes.columnGap.base, recentQuakes.resolvedSpace1.base, 0.1, `${comparison.manifestKey}: baseline column gap`);
      assertDesignAlignmentApprox(recentQuakes.columnGap.after, recentQuakes.resolvedSpace2.after, 0.1, `${comparison.manifestKey}: after column gap`);
      for (const [name, gap] of Object.entries(recentQuakes.actualGaps)) {
        const expectedGap = Math.max(recentQuakes.columnGap.after, recentQuakes.resolvedSpace2.after);
        if (!Number.isFinite(gap.after) || gap.after < 0 || gap.after + 0.5 < expectedGap) throw new Error(`${comparison.manifestKey}: RecentQuakes ${name} after gap ${gap.after} is below ${expectedGap}`);
      }
    } else {
      for (const [node, properties] of Object.entries(recentQuakes.rects)) {
        for (const [property, value] of Object.entries(properties)) {
          if (value.base == null || value.after == null || value.delta !== 0) throw new Error(`${comparison.manifestKey}: RecentQuakes ${node}.${property} base/after must remain 0px`);
        }
      }
    }
    const plan = target.maxPlan == null ? target : DESIGN_ALIGNMENT_MAX_PLANS[target.maxPlan];
    for (const [name, stage] of Object.entries(comparison.stages)) {
      if (stage.base !== plan.stage || stage.after !== plan.stage) throw new Error(`${comparison.manifestKey}: RecentQuakes ${name} stage must remain ${plan.stage}`);
    }
    if (target.maxPlan != null) {
      assertDesignAlignmentPlanComparison(comparison);
    } else if (comparison.compressed.base !== plan.compressed || comparison.compressed.after !== plan.compressed || comparison.compressed.changed) {
      throw new Error(`${comparison.manifestKey}: RecentQuakes compressed state must remain ${plan.compressed}`);
    }
  }
}

export function assertDesignAlignmentPageFooters(records) {
  const viewportCoverage = new Set();
  for (const record of records) {
    if (!Array.isArray(record.geometry?.pageFooters)) throw new Error(`${record.manifestKey}: pageFooters report missing`);
    for (const [index, footer] of record.geometry.pageFooters.entries()) {
      for (const key of [
        "cardKind", "card", "footer", "indicator", "body", "rider", "footerCount", "indicatorCount",
        "indicatorText", "siblingOrder", "footerIndex", "riderIndex", "childCount", "footerIsLast",
        "riderIsLast", "probeId", "range", "shelf", "painted", "position", "paddingTop", "paddingRight",
        "paddingBottom", "paddingLeft", "borderTop", "background", "indicatorFontSize", "indicatorColor",
        "indicatorLineHeight", "indicatorBackground", "bodyFooterOverlap", "footerRiderOverlap",
        "indicatorBodyOverlap", "indicatorRiderOverlap", "footerBottomInset", "indicatorBottomPaddingDelta",
        "riderBottomInset", "riderRadiusTopLeft", "riderRadiusTopRight", "riderRadiusBottomLeft",
        "riderRadiusBottomRight", "riderBackground",
      ]) {
        if (!Object.hasOwn(footer, key)) throw new Error(`${record.manifestKey}: footer ${index} ${key} report missing (field absent)`);
      }
      if (!Array.isArray(footer.siblingOrder)) throw new Error(`${record.manifestKey}: footer ${index} siblingOrder report invalid`);
      assertBox(footer.card, `${record.manifestKey}: footer ${index} card`);
      assertBox(footer.footer, `${record.manifestKey}: footer ${index} footer`);
      assertBox(footer.indicator, `${record.manifestKey}: footer ${index} indicator`);
      if (footer.body != null) assertBox(footer.body, `${record.manifestKey}: footer ${index} body`);
      if (footer.rider != null) assertBox(footer.rider, `${record.manifestKey}: footer ${index} rider`);
    }
    const compressed = record.geometry.layout?.compressed === true;
    const visibleRects = [
      ...(record.geometry.layout?.visibleCards ?? []).flatMap((card) => [card.component?.rect, card.host?.rect]),
      record.geometry.weatherAuto?.card?.rect,
    ].filter(Boolean);
    const liveFooters = record.geometry.pageFooters.filter((footer) => visibleRects.some((rect) =>
      ["left", "top", "width", "height"].every((key) => Math.abs(rect[key] - footer.card?.rect?.[key]) <= 1)));
    for (const footer of liveFooters) {
      viewportCoverage.add(record.viewport.label);
      if (footer.painted !== true || footer.footerCount !== 1 || footer.indicatorCount !== 1 || !/^\d+\/\d+$/.test(footer.indicatorText)) throw new Error(`${record.manifestKey}: footer count/text/paint contract failed`);
      if (footer.position !== "static") throw new Error(`${record.manifestKey}: footer is not normal flow`);
      const block = compressed ? 2 : 4;
      const inline = compressed ? 8 : 16;
      assertDesignAlignmentApprox(footer.paddingTop, block, 0.1, `${record.manifestKey}: footer padding-top`);
      assertDesignAlignmentApprox(footer.paddingBottom, block, 0.1, `${record.manifestKey}: footer padding-bottom`);
      assertDesignAlignmentApprox(footer.paddingLeft, inline, 0.1, `${record.manifestKey}: footer padding-left`);
      assertDesignAlignmentApprox(footer.paddingRight, inline, 0.1, `${record.manifestKey}: footer padding-right`);
      assertDesignAlignmentApprox(footer.borderTop, 1, 0.1, `${record.manifestKey}: footer border`);
      assertDesignAlignmentApprox(footer.indicatorFontSize, 12, 0.1, `${record.manifestKey}: indicator font-size`);
      assertDesignAlignmentApprox(footer.indicatorLineHeight, 12, 0.1, `${record.manifestKey}: indicator line-height`);
      if (footer.indicatorColor !== record.geometry.tokens.roleMuted) throw new Error(`${record.manifestKey}: indicator color is not role-muted`);
      if (footer.indicatorBackground !== "rgba(0, 0, 0, 0)" || footer.background !== "rgba(0, 0, 0, 0)") throw new Error(`${record.manifestKey}: footer/indicator background must be transparent`);
      if (footer.bodyFooterOverlap > 1 || footer.footerRiderOverlap > 1 || footer.indicatorBodyOverlap > 1 || footer.indicatorRiderOverlap > 1) throw new Error(`${record.manifestKey}: footer overlap`);
      if (footer.rider == null) {
        if (footer.footerIsLast !== true || footer.riderIsLast !== false) throw new Error(`${record.manifestKey}: footer is not the final flow child`);
        assertDesignAlignmentApprox(footer.footerBottomInset, 0, 1, `${record.manifestKey}: footer card inset`);
        assertDesignAlignmentApprox(footer.indicatorBottomPaddingDelta, 0, 1, `${record.manifestKey}: indicator bottom padding`);
      } else {
        if (footer.riderIsLast !== true || footer.riderIndex !== footer.footerIndex + 1 || footer.footer.rect.bottom > footer.rider.rect.top + 1) throw new Error(`${record.manifestKey}: footer/rider sibling order changed`);
        assertDesignAlignmentApprox(footer.riderBottomInset, 0, 1, `${record.manifestKey}: rider card inset`);
        assertDesignAlignmentApprox(footer.riderRadiusTopLeft, 0, 0.1, `${record.manifestKey}: rider top-left radius`);
        assertDesignAlignmentApprox(footer.riderRadiusTopRight, 0, 0.1, `${record.manifestKey}: rider top-right radius`);
        assertDesignAlignmentApprox(footer.riderRadiusBottomLeft, 15, 1, `${record.manifestKey}: rider bottom-left radius`);
        assertDesignAlignmentApprox(footer.riderRadiusBottomRight, 15, 1, `${record.manifestKey}: rider bottom-right radius`);
        if (typeof footer.riderBackground !== "string" || footer.riderBackground === "") throw new Error(`${record.manifestKey}: rider background report missing`);
      }
    }
  }
  for (const viewport of ["1920x1080", "1280x720", "960x620"]) if (!viewportCoverage.has(viewport)) throw new Error(`${viewport}: normal-flow footer was not captured`);
}

export function assertDesignAlignmentBriefingFlex(records) {
  let count = 0;
  for (const record of records) {
    const briefing = record.geometry?.briefing;
    if (briefing == null) continue;
    count += 1;
    if (briefing.cardDisplay !== "flex" || briefing.cardFlexDirection !== "column") throw new Error(`${record.manifestKey}: Briefing card flex ownership changed`);
    const atom = briefing.pageAtom;
    if (atom?.display !== "flex" || atom.flexGrow !== 1 || atom.flexShrink !== 1 || atom.flexBasis !== "auto" || atom.minHeight !== 0) throw new Error(`${record.manifestKey}: Briefing page atom does not own residual height`);
    assertNoOverflow(atom.node, `${record.manifestKey}: Briefing page atom`);
  }
  if (count === 0) throw new Error("Briefing flex ownership was not captured");
}

export function assertDesignAlignmentWeatherGrid(records) {
  const riderFooterCoverage = new Set();
  for (const record of records) {
    if (!Array.isArray(record.geometry?.weatherCards)) throw new Error(`${record.manifestKey}: weatherCards report missing`);
    for (const weather of record.geometry.weatherCards.filter((entry) => entry?.painted === true && entry.shelf === false)) {
      assertNoOverflow(weather.card, `${record.manifestKey}: Weather card`);
      if (weather.gridRowCount !== 4 || weather.gridTemplateAreas.replace(/\s+/g, " ").trim() !== '"header" "body" "footer" "rider"') throw new Error(`${record.manifestKey}: Weather four-row grid contract failed`);
      for (const [name, expectedArea] of [["header", "header"], ["body", "body"], ["footer", "footer"], ["rider", "rider"]]) {
        const row = weather[name];
        if (row != null && row.gridArea !== expectedArea) throw new Error(`${record.manifestKey}: Weather ${name} grid-area changed`);
      }
      const expectedOrder = ["header", ...(weather.body == null ? [] : ["body"]), ...(weather.footer == null ? [] : ["footer"]), ...(weather.rider == null ? [] : ["rider"] )];
      if (stableJson(weather.childOrder.filter((kind) => kind !== "other")) !== stableJson(expectedOrder)) throw new Error(`${record.manifestKey}: Weather child order changed`);
      if (weather.footerCount === 1 && weather.riderCount === 1) riderFooterCoverage.add(record.viewport.label);
    }
  }
  for (const viewport of ["1920x1080", "1280x720", "960x620"]) if (!riderFooterCoverage.has(viewport)) throw new Error(`${viewport}: Weather footer+rider was not captured together`);
}

export function assertDesignAlignmentWeatherFixedShell(records, baseline) {
  const baselineByKey = new Map((baseline?.records ?? []).map((record) => [record.manifestKey, record]));
  const viewportCoverage = new Set();
  const fixedShells = (record) => (record?.geometry?.weatherCards ?? []).filter((weather) =>
    weather?.painted === true && weather.shelf === false && weather.pagingContract === true
      && weather.footerCount === 1 && weather.riderCount === 1);
  for (const afterRecord of records) {
    const beforeRecord = baselineByKey.get(afterRecord.manifestKey);
    if (beforeRecord == null) throw new Error(`${afterRecord.manifestKey}: baseline Weather fixed-shell record missing`);
    const afterShells = fixedShells(afterRecord);
    const beforeShells = fixedShells(beforeRecord);
    if (afterShells.length !== beforeShells.length) throw new Error(`${afterRecord.manifestKey}: Weather fixed-shell count changed`);
    for (const [index, after] of afterShells.entries()) {
      const before = beforeShells[index];
      if (before == null) throw new Error(`${afterRecord.manifestKey}: baseline Weather fixed shell ${index} missing`);
      viewportCoverage.add(afterRecord.viewport.label);
      for (const [phase, weather] of [["baseline", before], ["after", after]]) {
        assertNoOverflow(weather.card, `${afterRecord.manifestKey}: ${phase} Weather fixed shell`);
        if (!Number.isFinite(weather.innerOccupiedHeight) || !Number.isFinite(weather.innerContentHeight)
          || weather.innerOccupiedHeight > weather.innerContentHeight + 1) {
          throw new Error(`${afterRecord.manifestKey}: ${phase} Weather fixed-shell rows exceed the inner content box`);
        }
      }
      assertDesignAlignmentApprox(after.card.rect.width - before.card.rect.width, 0, 1, `${afterRecord.manifestKey}: Weather fixed-shell width delta`);
      assertDesignAlignmentApprox(after.card.rect.height - before.card.rect.height, 0, 1, `${afterRecord.manifestKey}: Weather fixed-shell height delta`);
      assertDesignAlignmentApprox(after.card.clientHeight - before.card.clientHeight, 0, 1, `${afterRecord.manifestKey}: Weather fixed-shell clientHeight delta`);
      assertDesignAlignmentApprox(after.card.scrollHeight - before.card.scrollHeight, 0, 1, `${afterRecord.manifestKey}: Weather fixed-shell scrollHeight delta`);
    }
  }
  for (const viewport of ["1920x1080", "1280x720", "960x620"]) if (!viewportCoverage.has(viewport)) throw new Error(`${viewport}: Weather fixed footer+rider shell had zero comparison coverage`);
}

function recordCell(records, scenario, viewport, rotationTick = null, cardPageTick = 0) {
  return findRecords(records, scenario, viewport).find((record) => record.rotationTick === rotationTick && record.cardPageTick === cardPageTick);
}

function naturalProbeFor(record, target) {
  const candidates = (record?.geometry?.naturalHeightProbes ?? []).filter((probe) =>
    target.cardKinds.includes(probe.cardKind)
      && probe.range === "0:1"
      && probe.probeId.includes(":page-fit:0:1:")
      && probe.probeId.includes(":placement:side")
      && probe.footerCount === 1
      && probe.explicitHeight === false
      && (target.composition == null || probe.composition?.includes(target.composition)));
  return candidates.sort((left, right) => left.probeId.localeCompare(right.probeId))[0] ?? null;
}

export function assertDesignAlignmentNaturalHeightDeltaMatrix(records, baseline) {
  const targets = [
    { label: "Flood normal", scenario: "legacy-standby-gate", viewport: "1920x1080", tick: 0, cardKinds: ["flood", "floodWide"], delta: 0 },
    { label: "Flood compressed", scenario: "standby-design-alignment-compressed", viewport: "1280x720", tick: 0, cardKinds: ["flood", "floodWide"], delta: 0 },
    { label: "Volcano normal", scenario: "legacy-standby-gate", viewport: "1920x1080", tick: 0, cardKinds: ["volcano"], delta: 9 },
    { label: "Volcano compressed", scenario: "standby-design-alignment-compressed", viewport: "1280x720", tick: 0, cardKinds: ["volcano"], delta: 5 },
    { label: "Briefing normal", scenario: "standby-briefing-design-alignment", viewport: "1280x720", tick: null, cardKinds: ["briefing"], composition: "briefing-footer:present", delta: 15 },
    { label: "Briefing compressed", scenario: "standby-design-alignment-compressed", viewport: "1280x720", tick: 0, cardKinds: ["briefing"], composition: "briefing-footer:present", delta: 11 },
  ];
  for (const target of targets) {
    const afterRecord = recordCell(records, target.scenario, target.viewport, target.tick, 0);
    const beforeRecord = baseline?.records?.find((record) => record.manifestKey === afterRecord?.manifestKey);
    const after = naturalProbeFor(afterRecord, target);
    const before = naturalProbeFor(beforeRecord, target);
    if (after == null || before == null) throw new Error(`${target.label}: forced-range natural-height probe missing`);
    if (after.cardKind !== before.cardKind || after.range !== before.range) throw new Error(`${target.label}: forced-range probe identity changed`);
    assertNoOverflow(after.card, `${target.label}: after probe`);
    assertNoOverflow(before.card, `${target.label}: baseline probe`);
    for (const [phase, probe] of [["baseline", before], ["after", after]]) {
      if (Number.isFinite(probe.maxHeight) && probe.card.rect.height >= probe.maxHeight - 1) throw new Error(`${target.label}: ${phase} forced-range probe is max-height clamped`);
    }
    assertDesignAlignmentApprox(after.naturalHeight - before.naturalHeight, target.delta, 1, `${target.label} natural height delta`);
  }
}

export function assertDesignAlignmentWeatherAutoMatrix(records, baseline) {
  for (const [scenario, expectation] of Object.entries(DESIGN_ALIGNMENT_WEATHER_AUTO_PROBES)) {
    const after = findRecords(records, scenario, expectation.viewport)[0];
    const before = baseline?.records?.find((record) => record.manifestKey === after?.manifestKey);
    if (after == null || before == null) throw new Error(`${scenario}: base/after record missing`);
    assertDesignAlignmentWeatherAutoBaselineProbe(before, expectation, `${scenario}: baseline`);
    assertDesignAlignmentWeatherAutoProbe(after, expectation, `${scenario}: after`);
    assertDesignAlignmentApprox(
      after.geometry.weatherAuto.card.rect.height - before.geometry.weatherAuto.card.rect.height,
      expectation.naturalHeightDelta, 1, `${scenario}: natural height delta`,
    );
  }
}

export function assertDesignAlignmentForecastLabels(records) {
  const targets = [
    { page: 0, visible: "北海道 稚内市", full: "稚内市（0121400）" },
    { page: 16, visible: "北海道 稚内市 稚内海岸", full: "稚内市（0121400） / 稚内海岸（L001）" },
  ];
  const cells = [
    ...targets.map((target) => ({ ...target, scenario: "standby-vpwp50-forecast", viewport: "1280x720", tick: null })),
    ...["1280x720", "960x620"].flatMap((viewport) => targets.map((target) => ({
      ...target, scenario: "standby-design-alignment-compressed", viewport,
      tick: DESIGN_ALIGNMENT_COMPRESSED_PLANS[viewport].forecastCaptureTick,
    }))),
  ];
  for (const target of cells) {
    const forecast = recordCell(records, target.scenario, target.viewport, target.tick, target.page)?.geometry?.forecast;
    if (forecast == null) throw new Error(`${target.scenario}/${target.viewport}/page ${target.page}: forecast label report missing`);
    if (forecast.visibleTarget !== target.visible || forecast.targetTitle !== target.full
      || !forecast.atomAccessibleName?.includes(target.full) || !forecast.cardAccessibleName?.includes(target.full)) {
      throw new Error(`${target.scenario}/${target.viewport}/page ${target.page}: VPWP50 visible/title/ARIA contract failed`);
    }
    if (/0121400|L001/.test(forecast.visibleTarget) || forecast.continuationVisibleCount !== 0
      || forecast.footerCount !== 1 || !/^\d+\/32$/.test(forecast.page)) {
      throw new Error(`${target.scenario}/${target.viewport}/page ${target.page}: VPWP50 footer/continuation contract failed`);
    }
  }
}

function pagerInvariant(contract) {
  return {
    namespace: contract.namespace,
    key: contract.key,
    logicalItems: contract.logicalItems,
    logicalFingerprints: contract.logicalFingerprints,
    resetItems: contract.resetItems,
    sourceCount: contract.sourceCount,
    kindKeys: contract.kindKeys,
  };
}

function assertPagerContractShape(contract, expectedKey, label) {
  if (contract?.missingSchedulerState === true) throw new Error(`${label}: required scheduler state missing`);
  if (contract?.missingComponent === true || contract?.namespace !== "card-page-coordinator" || contract?.key !== expectedKey) throw new Error(`${label}: pager namespace/key missing or mismatched`);
  for (const key of ["logicalItems", "logicalFingerprints", "resetItems"]) if (!Array.isArray(contract[key])) throw new Error(`${label}: pager ${key} missing`);
  if (contract.logicalItems.length === 0 || contract.resetItems.length === 0 || contract.sourceCount !== contract.logicalItems.length
    || contract.duplicateCount !== 0 || contract.missingCount !== 0 || contract.nullCount !== 0) throw new Error(`${label}: pager logical sequence has duplicate/missing items`);
  if (contract.logicalFingerprints.length !== contract.logicalItems.length) throw new Error(`${label}: pager logical fingerprint sequence length changed`);
  if (contract.key === "weather") {
    if (!Array.isArray(contract.kindKeys) || contract.kindKeys.length === 0 || new Set(contract.kindKeys).size !== contract.kindKeys.length) throw new Error(`${label}: Weather kind keys missing/duplicated`);
    const sentinels = contract.logicalItems.filter(Array.isArray);
    const items = contract.logicalItems.filter((item) => typeof item === "string");
    if (sentinels.length !== contract.kindKeys.length || sentinels.some((item) => item.length !== 3 || item[0] !== "omittedAreaCount" || !contract.kindKeys.includes(item[1]) || !Number.isFinite(item[2]))) throw new Error(`${label}: Weather omittedAreaCount sentinels invalid`);
    if (items.length === 0 || items.some((item) => !contract.kindKeys.some((kind) => item.startsWith(kind + "|") && /\|\d+(?:\|code:.*)?$/.test(item)))) throw new Error(`${label}: Weather occurrence-aware area keys invalid`);
  }
}

function pagerContractsByCaptureKey(contracts, label, { requireKeys }) {
  const keyedContracts = contracts.filter((contract) => typeof contract?.captureKey === "string" && contract.captureKey !== "");
  if (requireKeys && keyedContracts.length !== contracts.length) throw new Error(`${label}: pager capture key missing`);
  const byKey = new Map(keyedContracts.map((contract) => [contract.captureKey, contract]));
  if (byKey.size !== keyedContracts.length) throw new Error(`${label}: duplicate pager capture keys`);
  return byKey;
}

function hasCompletePagerFields(contract) {
  return typeof contract?.namespace === "string" && typeof contract?.key === "string"
    && Array.isArray(contract.logicalItems) && Array.isArray(contract.logicalFingerprints)
    && Array.isArray(contract.resetItems) && Number.isFinite(contract.sourceCount)
    && (contract.key !== "weather" || Array.isArray(contract.kindKeys));
}

function pagerOracleForRecord(record, key) {
  if (key === "weather" && record.scenario === "standby-design-alignment-compressed" && record.viewport?.label === "960x620") {
    return DESIGN_ALIGNMENT_COMPACT_WEATHER_PAGER_ORACLE;
  }
  return DESIGN_ALIGNMENT_PAGER_ORACLES[key];
}

export function assertDesignAlignmentPagerContracts(records, baseline) {
  const baselineByKey = new Map((baseline?.records ?? []).map((record) => [record.manifestKey, record]));
  for (const afterRecord of records) {
    const beforeRecord = baselineByKey.get(afterRecord.manifestKey);
    if (beforeRecord == null) throw new Error(`${afterRecord.manifestKey}: baseline pager record missing`);
    const afterContracts = afterRecord.geometry?.pagerContracts;
    const beforeContracts = beforeRecord.geometry?.pagerContracts;
    if (!Array.isArray(afterContracts) || !Array.isArray(beforeContracts)) throw new Error(`${afterRecord.manifestKey}: pagerContracts report missing`);
    const afterByKey = pagerContractsByCaptureKey(afterContracts, `${afterRecord.manifestKey}: after`, { requireKeys: true });
    const expectedCaptureKeys = expectedPagerCaptureKeysForRecord(afterRecord);
    assertDeepEqual([...afterByKey.keys()].sort(), [...expectedCaptureKeys].sort(), `${afterRecord.manifestKey}: after pager captureKey set`);
    const beforeByKey = pagerContractsByCaptureKey(beforeContracts, `${afterRecord.manifestKey}: baseline`, { requireKeys: false });
    for (const key of expectedCaptureKeys) {
      const after = afterByKey.get(key);
      assertPagerContractShape(after, key, `${afterRecord.manifestKey}: after ${key}`);
      const oracle = pagerOracleForRecord(afterRecord, key);
      if (oracle == null) throw new Error(`${afterRecord.manifestKey}: ${key} pager oracle missing`);
      assertDeepEqual(pagerInvariant(after), oracle, `${afterRecord.manifestKey}: ${key} fixture pager oracle`);
      const before = beforeByKey.get(key);
      if (before != null && hasCompletePagerFields(before)) {
        assertPagerContractShape(before, key, `${afterRecord.manifestKey}: baseline ${key}`);
        assertDeepEqual(pagerInvariant(after), pagerInvariant(before), `${afterRecord.manifestKey}: ${key} baseline pager invariant`);
      }
    }
  }
}

export function resolveDesignAlignmentCaptureMode({ writeBaseline, baselineReport }, suite = "design-alignment") {
  if (writeBaseline != null && baselineReport != null) throw new Error("choose either --write-baseline or --baseline-report");
  if (writeBaseline != null) return "baseline";
  if (baselineReport != null) return "after";
  throw new Error(`${suite} suite requires --write-baseline or --baseline-report`);
}

export function resolveDesignAlignmentExecutionMode({ suite, assertFrom, writeBaseline, baselineReport }) {
  if (assertFrom == null) return "capture";
  if (!["design-alignment", RECENT_QUAKES_GAP_SUITE].includes(suite)) throw new Error("--assert-from requires --suite design-alignment or recent-quakes-gap");
  if (writeBaseline != null) throw new Error("--assert-from cannot be combined with --write-baseline");
  if (baselineReport == null) throw new Error("--assert-from requires --baseline-report");
  return "assert-from";
}

export function createDesignAlignmentRecordsArtifact({ mode, records, baseline }) {
  return { schemaVersion: CAPTURE_SCHEMA_VERSION, suite: "design-alignment", mode, records, baseline };
}

export function createRecentQuakesGapRecordsArtifact({ mode, records, baseline }) {
  return { schemaVersion: CAPTURE_SCHEMA_VERSION, suite: RECENT_QUAKES_GAP_SUITE, mode, records, baseline };
}

export function isDesignAlignmentScreenshotArtifact(name) {
  return name.startsWith("design-alignment-") && name.endsWith(".png");
}

export function isRecentQuakesGapScreenshotArtifact(name) {
  return name.startsWith(`${RECENT_QUAKES_GAP_SUITE}-`) && name.endsWith(".png");
}

async function cleanDesignAlignmentScreenshots(outDir) {
  const entries = await readdir(outDir, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && isDesignAlignmentScreenshotArtifact(entry.name))
    .map((entry) => rm(join(outDir, entry.name), { force: true })));
}

async function cleanRecentQuakesGapScreenshots(outDir) {
  const entries = await readdir(outDir, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && isRecentQuakesGapScreenshotArtifact(entry.name))
    .map((entry) => rm(join(outDir, entry.name), { force: true })));
}

export function assertDesignAlignmentManifest(records, { mode, baseline = null }) {
  if (mode === "baseline") {
    assertDesignAlignmentBaselineStructure(records);
    return null;
  }
  if (mode !== "after") throw new Error(`unknown design-alignment assertion mode: ${mode}`);
  if (baseline == null || baseline.suite !== "design-alignment") throw new Error("design-alignment baseline suite mismatch");
  if (baseline.mode != null && baseline.mode !== "baseline") throw new Error("design-alignment baseline mode mismatch");
  assertDesignAlignmentBaselineStructure(baseline.records ?? []);
  assertDesignAlignmentManifestCoverage(records);
  for (const record of records) assertRequiredReport(record);
  assertCompressedPlan(records, "1280x720");
  assertCompressedPlan(records, "960x620");
  assertDesignAlignmentMaxFixture(records);
  assertBriefingCaptureCoverage(records);
  assertBaselineForecastCoverage(records);
  assertBaselineTyphoonCoverage(records);
  const comparison = buildDesignAlignmentComparison(records, baseline.records);
  assertDesignAlignmentComparisonPolicy(comparison);
  assertBriefingMatrix(records);
  assertDesignAlignmentBriefingFlex(records);
  assertForecast(records, baseline);
  assertDesignAlignmentForecastLabels(records);
  assertTyphoon(records);
  assertDesignAlignmentPageFooters(records);
  assertDesignAlignmentWeatherGrid(records);
  assertDesignAlignmentWeatherFixedShell(records, baseline);
  assertDesignAlignmentWeatherAutoMatrix(records, baseline);
  assertDesignAlignmentNaturalHeightDeltaMatrix(records, baseline);
  assertDesignAlignmentPagerContracts(records, baseline);
  return comparison;
}

export function assertRecentQuakesGapManifest(records, { mode, baseline = null }) {
  if (mode !== "baseline" && mode !== "after") throw new Error(`unknown recent-quakes-gap assertion mode: ${mode}`);
  assertRecentQuakesGapManifestCoverage(records);
  assertDesignAlignmentRecentQuakesReports(records, { mode });
  if (mode === "baseline") return null;
  if (baseline == null || baseline.suite !== RECENT_QUAKES_GAP_SUITE) throw new Error("recent-quakes-gap baseline suite mismatch");
  if (baseline.mode != null && baseline.mode !== "baseline") throw new Error("recent-quakes-gap baseline mode mismatch");
  const baselineRecords = baseline.records ?? [];
  assertRecentQuakesGapManifestCoverage(baselineRecords);
  assertDesignAlignmentRecentQuakesReports(baselineRecords, { mode: "baseline" });
  const comparison = buildDesignAlignmentComparison(records, baselineRecords);
  assertRecentQuakesGapComparisonPolicy(comparison);
  return comparison;
}

export function assertDesignAlignmentSavedRecords(saved, baseline) {
  if (saved == null || saved.suite !== "design-alignment" || !Array.isArray(saved.records)) throw new Error("invalid design-alignment records file");
  if (saved.mode != null && saved.mode !== "after") throw new Error("design-alignment records file is not an after capture");
  const viewportMode = saved.records[0]?.capture?.viewportMode;
  assertCaptureReport(saved, { expectSuite: "design-alignment", expectViewportMode: viewportMode });
  assertCaptureReport(baseline, { expectSuite: "design-alignment", expectViewportMode: viewportMode });
  const baseAfterComparison = assertDesignAlignmentManifest(saved.records, { mode: "after", baseline });
  return { schemaVersion: CAPTURE_SCHEMA_VERSION, suite: "design-alignment", mode: "after", records: saved.records, baseAfterComparison };
}

async function runDesignAlignmentAssertionsFromFile(options) {
  const assertFrom = resolve(options.assertFrom);
  const baselineReport = resolve(options.baselineReport);
  const [saved, baseline] = await Promise.all([
    readFile(assertFrom, "utf8").then(JSON.parse),
    readFile(baselineReport, "utf8").then(JSON.parse),
  ]);
  const report = { ...assertDesignAlignmentSavedRecords(saved, baseline), assertFrom, baselineReport };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

export function assertRecentQuakesGapSavedRecords(saved, baseline) {
  if (saved == null || saved.suite !== RECENT_QUAKES_GAP_SUITE || !Array.isArray(saved.records)) throw new Error("invalid recent-quakes-gap records file");
  if (saved.mode != null && saved.mode !== "after") throw new Error("recent-quakes-gap records file is not an after capture");
  const viewportMode = saved.records[0]?.capture?.viewportMode;
  assertCaptureReport(saved, { expectSuite: RECENT_QUAKES_GAP_SUITE, expectViewportMode: viewportMode });
  assertCaptureReport(baseline, { expectSuite: RECENT_QUAKES_GAP_SUITE, expectViewportMode: viewportMode });
  const baseAfterComparison = assertRecentQuakesGapManifest(saved.records, { mode: "after", baseline });
  return { schemaVersion: CAPTURE_SCHEMA_VERSION, suite: RECENT_QUAKES_GAP_SUITE, mode: "after", records: saved.records, baseAfterComparison };
}

async function runRecentQuakesGapAssertionsFromFile(options) {
  const assertFrom = resolve(options.assertFrom);
  const baselineReport = resolve(options.baselineReport);
  const [saved, baseline] = await Promise.all([
    readFile(assertFrom, "utf8").then(JSON.parse),
    readFile(baselineReport, "utf8").then(JSON.parse),
  ]);
  const report = { ...assertRecentQuakesGapSavedRecords(saved, baseline), assertFrom, baselineReport };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function runDesignAlignmentSuite({ options, chrome, profileDir, baseUrl, outDir, viewportMode }) {
  const mode = resolveDesignAlignmentCaptureMode(options);
  await cleanDesignAlignmentScreenshots(outDir);
  const records = [];
  for (const entry of DESIGN_ALIGNMENT_MANIFEST) {
    const url = designAlignmentUrl(baseUrl, entry);
    records.push(await captureDesignAlignmentPage({
      chrome, profileDir, url, viewport: parseViewport(entry.viewport), viewportMode, outDir, entry,
    }));
  }
  const baseline = options.baselineReport == null ? null : JSON.parse(await readFile(options.baselineReport, "utf8"));
  if (baseline != null) assertCaptureReport(baseline, { expectSuite: "design-alignment", expectViewportMode: viewportMode });
  const recordsArtifactPath = join(outDir, "design-alignment-records.json");
  await writeFile(recordsArtifactPath, `${JSON.stringify(createDesignAlignmentRecordsArtifact({ mode, records, baseline }), null, 2)}\n`);
  const baseAfterComparison = assertDesignAlignmentManifest(records, { mode, baseline });
  const report = { schemaVersion: CAPTURE_SCHEMA_VERSION, suite: "design-alignment", mode, recordsArtifactPath, records, ...(baseAfterComparison == null ? {} : { baseAfterComparison }) };
  if (options.writeBaseline != null) await writeFile(options.writeBaseline, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function runRecentQuakesGapSuite({ options, chrome, profileDir, baseUrl, outDir, viewportMode }) {
  const mode = resolveDesignAlignmentCaptureMode(options, RECENT_QUAKES_GAP_SUITE);
  await cleanRecentQuakesGapScreenshots(outDir);
  const records = [];
  for (const entry of RECENT_QUAKES_GAP_MANIFEST) {
    const url = designAlignmentUrl(baseUrl, entry);
    records.push(await captureDesignAlignmentPage({
      chrome, profileDir, url, viewport: parseViewport(entry.viewport), viewportMode, outDir, entry,
      artifactPrefix: RECENT_QUAKES_GAP_SUITE,
    }));
  }
  const baseline = options.baselineReport == null ? null : JSON.parse(await readFile(options.baselineReport, "utf8"));
  if (baseline != null) assertCaptureReport(baseline, { expectSuite: RECENT_QUAKES_GAP_SUITE, expectViewportMode: viewportMode });
  const recordsArtifactPath = join(outDir, `${RECENT_QUAKES_GAP_SUITE}-records.json`);
  await writeFile(recordsArtifactPath, `${JSON.stringify(createRecentQuakesGapRecordsArtifact({ mode, records, baseline }), null, 2)}\n`);
  const baseAfterComparison = assertRecentQuakesGapManifest(records, { mode, baseline });
  const report = { schemaVersion: CAPTURE_SCHEMA_VERSION, suite: RECENT_QUAKES_GAP_SUITE, mode, recordsArtifactPath, records, ...(baseAfterComparison == null ? {} : { baseAfterComparison }) };
  if (options.writeBaseline != null) await writeFile(options.writeBaseline, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function runCenterStackPregateSuite({ options, chrome, profileDir, baseUrl, outDir }) {
  if (options.writeBaseline == null) throw new Error("center-stack-pregate suite requires --write-baseline");
  if (options.baselineReport != null || options.assertFrom != null) throw new Error("center-stack-pregate suite does not use --baseline-report or --assert-from");
  if (options.viewportModeExplicit && options.viewportMode !== "calibrated") throw new Error("center-stack-pregate suite requires calibrated viewport mode");
  const records = [];
  for (const entry of CENTER_STACK_PREGATE_MANIFEST) {
    records.push(await captureCenterStackPregatePage({ chrome, profileDir, baseUrl, outDir, entry }));
  }
  const recordsArtifactPath = join(outDir, "center-stack-pregate-records.json");
  const reportPath = resolve(options.writeBaseline);
  const report = { schemaVersion: CAPTURE_SCHEMA_VERSION, suite: CENTER_STACK_PREGATE_SUITE, recordsArtifactPath, records };
  await Promise.all([
    writeFile(recordsArtifactPath, `${JSON.stringify(report, null, 2)}\n`),
    mkdir(dirname(reportPath), { recursive: true }).then(() => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)),
  ]);
  const assertion = assertCenterStackPregateReport(report);
  const assertedReport = { ...report, branch: assertion.branch };
  await Promise.all([
    writeFile(recordsArtifactPath, `${JSON.stringify(assertedReport, null, 2)}\n`),
    writeFile(reportPath, `${JSON.stringify(assertedReport, null, 2)}\n`),
  ]);
  process.stdout.write(`${JSON.stringify(assertedReport, null, 2)}\n`);
}

async function main() {
  let options;
  try { options = parseCaptureArgs(process.argv.slice(2)); } catch (error) { usage(error.message); return; }
  if (options == null) { usage(); return; }
  if (options.verifyLegacyExpectationDigest != null) {
    const actual = verifyLegacyExpectationDigest(options.verifyLegacyExpectationDigest);
    process.stdout.write(`${actual}\n`);
    return;
  }
  if (options.assertCaptureReport != null) {
    const report = JSON.parse(await readFile(resolve(options.assertCaptureReport), "utf8"));
    const result = assertCaptureReport(report, options);
    process.stdout.write(`${JSON.stringify({ schemaVersion: CAPTURE_SCHEMA_VERSION, asserted: resolve(options.assertCaptureReport), suite: result.suite, cells: result.records.length, mismatches: result.mismatchCount, ...(result.branch == null ? {} : { branch: result.branch }) }, null, 2)}\n`);
    return;
  }
  if (options.suite != null && !["design-alignment", RECENT_QUAKES_GAP_SUITE, CENTER_STACK_PREGATE_SUITE].includes(options.suite)) throw new Error("unknown suite");
  if (resolveDesignAlignmentExecutionMode(options) === "assert-from") {
    if (options.suite === RECENT_QUAKES_GAP_SUITE) await runRecentQuakesGapAssertionsFromFile(options);
    else await runDesignAlignmentAssertionsFromFile(options);
    return;
  }
  const fixtureDefaults = {
    "tornado-pages": { scenario: "7", viewport: "1280x720" },
    "tornado-aggregate": { scenario: "7", viewport: "960x620" },
    "tornado-clip": { scenario: "7", viewport: "960x620" },
    "tornado-epoch-release": { scenario: "7", viewport: "1280x720" },
    "recent-quakes-narrow": { scenario: "quiet", viewport: "960x620" },
    "attention-visibility-standby": { scenario: "max", viewport: "1280x720" },
    "attention-visibility-emergency": { scenario: "max", viewport: "1280x720" },
    "attention-visibility-reduced-motion": { scenario: "max", viewport: "1280x720" },
    "briefing-pages": { scenario: "4", viewport: "1280x720" },
    "briefing-single-page": { scenario: "4", viewport: "1280x720" },
  };
  const fixtureDefault = options.fixture == null ? null : fixtureDefaults[options.fixture] ?? null;
  const scenarios = options.scenarios.length === 0
    ? fixtureDefault?.scenario != null ? [fixtureDefault.scenario] : DEFAULT_SCENARIOS
    : options.scenarios;
  if (scenarios.some((scenario) => !SUPPORTED_SCENARIOS.includes(scenario))) throw new Error("scenario must be quiet, 4, 7, max, or max-floodWide");
  if (options.fixture != null && !["overflow", "rotation", "cluster", "cluster-calm", "tornado-pages", "tornado-aggregate", "tornado-clip", "tornado-epoch-release", "recent-quakes-narrow", "attention-visibility-standby", "attention-visibility-emergency", "attention-visibility-reduced-motion", "briefing-pages", "briefing-single-page"].includes(options.fixture)) throw new Error("unknown fixture");
  if (options.fixture === "cluster-calm" && (scenarios.length !== 1 || scenarios[0] !== "4")) throw new Error("cluster-calm fixture requires --scenario 4: quiet has no fixed cluster to reduce");
  const requestedViewports = options.viewports.length === 0 ? null : options.viewports.map(parseViewport);
  const outDir = resolve(options.outDir ?? join(DISPLAY_DIR, "artifacts", "legacy-standby"));
  await mkdir(outDir, { recursive: true });
  const chrome = process.env.CHROME_BIN ?? "chrome";
  const viewportMode = viewportModeForSuite(options);
  const staticServer = options.url == null ? await startStaticServer() : null;
  const baseUrl = options.url ?? staticServer.url;
  const profileDir = await mkdtemp(join(outDir, ".chrome-profile-"));
  try {
    if (options.suite === "design-alignment") {
      await runDesignAlignmentSuite({ options, chrome, profileDir, baseUrl, outDir, viewportMode });
      return;
    }
    if (options.suite === RECENT_QUAKES_GAP_SUITE) {
      await runRecentQuakesGapSuite({ options, chrome, profileDir, baseUrl, outDir, viewportMode });
      return;
    }
    if (options.suite === CENTER_STACK_PREGATE_SUITE) {
      await runCenterStackPregateSuite({ options, chrome, profileDir, baseUrl, outDir });
      return;
    }
    const results = [];
    for (const scenario of scenarios) {
      const viewportLabels = requestedViewports == null
        ? fixtureDefault?.viewport != null ? [fixtureDefault.viewport]
          : scenario === "max-floodWide" ? FLOOD_WIDE_VIEWPORTS : options.report ? DEFAULT_VIEWPORTS : scenario === "quiet" ? ["960x620"] : DEFAULT_VIEWPORTS
        : requestedViewports.map((viewport) => viewport.label);
      const viewports = viewportLabels.map(parseViewport);
      for (const viewport of viewports) {
        const initialCardPageTick = options.fixture === "briefing-pages" || options.fixture === "briefing-single-page" ? 0 : null;
        const first = await capture({ chrome, profileDir, url: gateUrl(baseUrl, scenario, 0, options.fixture, initialCardPageTick), scenario, viewport, outDir, viewportMode, rotationTick: 0, cardPageTick: initialCardPageTick, assertTable: !options.report, fixture: options.fixture });
        results.push(first);
        if (options.fixture === "briefing-pages") {
          // Deterministically drive the real page coordinator through every
          // resolved briefing page, then prove the no-footer one-page branch
          // on its own live browser fixture.
          for (let pageTick = 1; pageTick < BRIEFING_PAGING_PAGE_COUNT; pageTick += 1) {
            results.push(await capture({
              chrome, profileDir, url: gateUrl(baseUrl, scenario, 0, options.fixture, pageTick), scenario, viewport, outDir,
              viewportMode, rotationTick: 0, cardPageTick: pageTick, assertTable: !options.report, fixture: options.fixture,
            }));
          }
          results.push(await capture({
            chrome, profileDir, url: gateUrl(baseUrl, scenario, 0, "briefing-single-page", 0), scenario, viewport, outDir,
            viewportMode, rotationTick: 0, cardPageTick: 0, assertTable: !options.report, fixture: "briefing-single-page",
          }));
        }
        const rotationKeys = (first.diagnostics["data-rotation-keys"] ?? "").split(",").filter(Boolean);
        if (first.diagnostics["data-ladder-stage"] === "3") {
          for (let rotationTick = 1; rotationTick < rotationKeys.length; rotationTick += 1) {
            results.push(await capture({ chrome, profileDir, url: gateUrl(baseUrl, scenario, rotationTick, options.fixture), scenario, viewport, outDir, viewportMode, rotationTick, assertTable: !options.report, fixture: options.fixture }));
          }
        }
      }
    }
    const { report, exitCode } = createStandardReportResult({ results, reportMode: options.report, outDir });
    if (options.writeReport != null) {
      const writeReportPath = resolve(options.writeReport);
      await mkdir(dirname(writeReportPath), { recursive: true });
      await writeFile(writeReportPath, `${JSON.stringify(report, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (options.report) process.exitCode = exitCode;
  } finally {
    // A SIGTERM-ed Chrome may still be flushing its profile while the recursive
    // rm walks it, surfacing ENOTEMPTY on macOS. Retry briefly, then leave the
    // stray profile behind rather than failing an otherwise-green run.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(profileDir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 4) process.stderr.write(`profile cleanup failed, leaving ${profileDir}: ${error}\n`);
        else await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      }
    }
    if (staticServer != null) await staticServer.close();
  }
}

const directlyInvoked = process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directlyInvoked) {
  main().catch((error) => {
    if (error instanceof CaptureAssertionError) process.stderr.write(`${JSON.stringify({ name: error.name, code: error.code, message: error.message })}\n`);
    else process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
