import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/svelte";
import WarningList from "./WarningList.svelte";

describe("WarningList", () => {
  it("warnings を一覧表示する", () => {
    render(WarningList, { warnings: ["palette.vermillion: 不正なHEX値 \"x\"", "もう 1 件"] });
    expect(screen.getByText(/不正なHEX値/)).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("warnings が空なら何も描画しない", () => {
    const { container } = render(WarningList, { warnings: [] });
    expect(container.querySelector(".warning-list")).toBeNull();
  });
});
