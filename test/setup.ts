import { beforeEach, vi } from "vitest";

/**
 * notifyMock を vi.hoisted() で定義し、vi.mock ファクトリ内で参照可能にする。
 * vi.mock はファイル先頭にホイストされるため、通常の const 宣言は
 * ファクトリ実行時点で未初期化になる。vi.hoisted() で回避する。
 */
const { notifyMock } = vi.hoisted(() => ({
  notifyMock: vi.fn(),
}));

/**
 * node-notifier を直接モック (フォールバック安全策)
 */
vi.mock("node-notifier", () => ({
  default: { notify: notifyMock },
  notify: notifyMock,
}));

/**
 * node-notifier-loader モジュール自体をモックし、
 * loadNodeNotifier() が常にモック通知オブジェクトを返すようにする。
 * これにより、Notifier クラスが実際の node-notifier を require() する
 * パスを完全に遮断する。
 */
vi.mock("../src/engine/notification/node-notifier-loader", () => ({
  loadNodeNotifier: () => ({ notify: notifyMock }),
  setNodeNotifierOverride: vi.fn(),
}));

export { notifyMock };

beforeEach(() => {
  notifyMock.mockClear();
});
