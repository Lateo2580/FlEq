import { vi } from "vitest";

// テスト中にトースト通知が表示されるのを抑制
vi.mock("node-notifier", () => ({
  default: { notify: vi.fn() },
  notify: vi.fn(),
}));
