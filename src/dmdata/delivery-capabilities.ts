import type { AppConfig } from "../types";

/** 配送保証の根拠。unknown は抑止に使ってはならない。 */
export type DeliveryCapabilitySource =
  | "socket-start"
  | "contract-and-socket"
  | "unknown";

/** 現在の接続経路から安全側に解決した配送 capability。 */
export interface DeliveryCapabilities {
  connected: boolean;
  effectiveClassifications: readonly string[];
  guaranteedHeadTypes: ReadonlySet<string>;
  source: DeliveryCapabilitySource;
}

/** classification から配送が保証される head.type の registry。 */
export type ClassificationHeadTypeRegistry = ReadonlyMap<
  string,
  readonly string[]
>;

/**
 * 根拠が確認済みの classification → head.type 対応だけを列挙する。
 *
 * eew.forecast → VXSE45 は Phase 6A 着手時点で根拠未確認のため登録しない。
 * VXSE44 の capability 抑止へ使える保証を、名称や設定値から推測しない。
 */
export const CLASSIFICATION_HEAD_TYPE_REGISTRY: ClassificationHeadTypeRegistry =
  new Map<string, readonly string[]>([
    ["eew.warning", Object.freeze(["VXSE43"])],
    ["eew.forecast", Object.freeze(["VXSE44"])],
  ]);

/** registry の別名。呼出側が「配送 capability の registry」と明示できるようにする。 */
export const DELIVERY_CAPABILITY_REGISTRY = CLASSIFICATION_HEAD_TYPE_REGISTRY;

/** start 未確認・切断中など、保証根拠を持たない snapshot を生成する。 */
export function createUnknownDeliveryCapabilities(
  connected = false,
): DeliveryCapabilities {
  return {
    connected,
    effectiveClassifications: [],
    guaranteedHeadTypes: new Set<string>(),
    source: "unknown",
  };
}

/** capability を外部へ渡すために防御コピーする。 */
export function cloneDeliveryCapabilities(
  capabilities: DeliveryCapabilities,
): DeliveryCapabilities {
  return {
    connected: capabilities.connected,
    effectiveClassifications: [...capabilities.effectiveClassifications],
    guaranteedHeadTypes: new Set(capabilities.guaranteedHeadTypes),
    source: capabilities.source,
  };
}

/** 複数 classification の registry 上の保証を集合として解決する。 */
export function guaranteedHeadTypesForClassifications(
  classifications: readonly string[],
  registry: ClassificationHeadTypeRegistry = CLASSIFICATION_HEAD_TYPE_REGISTRY,
): ReadonlySet<string> {
  const guaranteed = new Set<string>();
  for (const classification of classifications) {
    const headTypes = registry.get(classification);
    if (headTypes == null) continue;
    for (const headType of headTypes) guaranteed.add(headType);
  }
  return guaranteed;
}

/**
 * 契約 API が成功した結果を AppConfig に混在させず、同一 config instance にだけ紐付ける。
 * WebSocketManager は生成時にこの値を読み、以後は runtime-only の immutable snapshot として使う。
 */
const verifiedClassificationsByConfig = new WeakMap<
  AppConfig,
  readonly string[]
>();

export function setVerifiedContractClassifications(
  config: AppConfig,
  classifications: readonly string[],
): void {
  verifiedClassificationsByConfig.set(
    config,
    Object.freeze([...classifications]),
  );
}

export function clearVerifiedContractClassifications(config: AppConfig): void {
  verifiedClassificationsByConfig.delete(config);
}

/** 未確認なら null。空配列は API 成功済みの空契約と区別して保持する。 */
export function getVerifiedContractClassifications(
  config: AppConfig,
): readonly string[] | null {
  const classifications = verifiedClassificationsByConfig.get(config);
  return classifications == null ? null : [...classifications];
}
