import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { EewEventLogger } from "../eew/eew-logger";
import { Notifier } from "../notification/notifier";

export interface ReplaySuppressionCounter {
  attempts: number;
  suppressed: number;
}

export interface ReplaySideEffects {
  eewLogger: EewEventLogger;
  notifier: Notifier;
  eew: ReplaySuppressionCounter;
  notifications: ReplaySuppressionCounter;
}

function counterProxy<T extends object>(
  prototype: object,
  counter: ReplaySuppressionCounter,
  countedPrefix: string,
): T {
  const target = Object.create(prototype) as T;
  return new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === "string" && property.startsWith(countedPrefix)) {
        return () => {
          counter.attempts += 1;
          counter.suppressed += 1;
          return false;
        };
      }
      return Reflect.get(object, property, receiver);
    },
  });
}

/** Constructor を一度も呼ばず、replay 内だけで attempt を数える sink を作る。 */
export function createReplaySideEffects(): ReplaySideEffects {
  const eew = { attempts: 0, suppressed: 0 };
  const notifications = { attempts: 0, suppressed: 0 };
  return {
    eewLogger: counterProxy<EewEventLogger>(EewEventLogger.prototype, eew, "log"),
    notifier: counterProxy<Notifier>(Notifier.prototype, notifications, "notify"),
    eew,
    notifications,
  };
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

export function prepareReplayStateDir(stateDir: string, checkoutRoot = process.cwd()): string {
  if (stateDir.trim() === "") throw new Error("--state-dir is required");
  const root = resolve(checkoutRoot);
  const resolved = resolve(root, stateDir);
  const productionRoots = [resolve(root, "data/runtime"), resolve(root, "eew-logs")];
  if (productionRoots.some((productionRoot) => isWithin(resolved, productionRoot))) {
    throw new Error("replay state directory must not be a production runtime root");
  }
  if (existsSync(resolved)) {
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink()) throw new Error("replay state directory must not be a symbolic link");
    if (!stat.isDirectory()) throw new Error("replay state path must be a directory");
    if (readdirSync(resolved).length !== 0) throw new Error("replay state directory must be empty");
    if (realpathSync(resolved) !== resolved) {
      throw new Error("replay state directory contains a symbolic-link traversal");
    }
  } else {
    const parent = dirname(resolved);
    if (!existsSync(parent)) throw new Error("replay state directory parent must exist");
    const parentReal = realpathSync(parent);
    if (parentReal !== parent) throw new Error("replay state directory parent must not traverse a symbolic link");
    mkdirSync(resolved);
  }
  writeFileSync(resolve(resolved, ".fleq-replay"), "phase=1\nscenario=vpbs50-fixed-2\n", {
    encoding: "utf8",
    flag: "wx",
  });
  return resolved;
}

export function stateRelative(stateDir: string, path: string): string {
  const resolvedRoot = resolve(stateDir);
  const resolvedPath = resolve(path);
  if (!isWithin(resolvedPath, resolvedRoot)) throw new Error("replay artifact escaped state directory");
  return relative(resolvedRoot, resolvedPath).split(sep).join("/");
}

export function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (typeof item !== "object" || item == null) return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([key, child]) => [key, normalize(child)]),
    );
  };
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}
