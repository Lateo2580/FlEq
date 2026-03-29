import { describe, it, expect } from "vitest";
import { PipelineController } from "../../../src/engine/filter-template/pipeline-controller";

describe("PipelineController", () => {
  it("初期状態で filter/template/focus が null", () => {
    const ctrl = new PipelineController();
    const p = ctrl.getPipeline();
    expect(p.filter).toBeNull();
    expect(p.template).toBeNull();
    expect(p.focus).toBeNull();
  });

  it("setFilter で filter を設定できる", () => {
    const ctrl = new PipelineController();
    ctrl.setFilter('domain = "eew"');
    expect(ctrl.getFilterExpr()).toBe('domain = "eew"');
    expect(ctrl.getPipeline().filter).not.toBeNull();
  });

  it("clearFilter で filter をクリアできる", () => {
    const ctrl = new PipelineController();
    ctrl.setFilter('domain = "eew"');
    ctrl.clearFilter();
    expect(ctrl.getPipeline().filter).toBeNull();
    expect(ctrl.getFilterExpr()).toBeNull();
  });

  it("setFocus で focus を設定できる", () => {
    const ctrl = new PipelineController();
    ctrl.setFocus('frameLevel >= "warning"');
    expect(ctrl.getFocusExpr()).toBe('frameLevel >= "warning"');
    expect(ctrl.getPipeline().focus).not.toBeNull();
  });

  it("clearFocus で focus をクリアできる", () => {
    const ctrl = new PipelineController();
    ctrl.setFocus('domain = "eew"');
    ctrl.clearFocus();
    expect(ctrl.getPipeline().focus).toBeNull();
    expect(ctrl.getFocusExpr()).toBeNull();
  });

  it("setTemplate で template を設定できる", () => {
    const ctrl = new PipelineController();
    ctrl.setTemplate("{{title}}");
    expect(ctrl.getTemplateExpr()).toBe("{{title}}");
    expect(ctrl.getPipeline().template).not.toBeNull();
  });

  it("clearTemplate で template をクリアできる", () => {
    const ctrl = new PipelineController();
    ctrl.setTemplate("{{title}}");
    ctrl.clearTemplate();
    expect(ctrl.getPipeline().template).toBeNull();
    expect(ctrl.getTemplateExpr()).toBeNull();
  });

  it("不正なフィルタ式で例外を投げる", () => {
    const ctrl = new PipelineController();
    expect(() => ctrl.setFilter("invalid %%")).toThrow();
  });

  it("不正なフォーカス式で例外を投げる", () => {
    const ctrl = new PipelineController();
    expect(() => ctrl.setFocus("invalid %%")).toThrow();
  });

  it("getPipeline は同じオブジェクト参照を返す（共有参照の維持）", () => {
    const ctrl = new PipelineController();
    const p1 = ctrl.getPipeline();
    const p2 = ctrl.getPipeline();
    expect(p1).toBe(p2);
  });

  it("setFilter 後に getPipeline の filter が即座に反映される", () => {
    const ctrl = new PipelineController();
    const p = ctrl.getPipeline();
    expect(p.filter).toBeNull();
    ctrl.setFilter('domain = "eew"');
    // 同じオブジェクト参照なので反映されている
    expect(p.filter).not.toBeNull();
  });

  it("初期 pipeline を渡して構築できる", () => {
    const ctrl = PipelineController.fromExpressions({
      filter: 'domain = "eew"',
      focus: 'frameLevel >= "warning"',
      template: "{{title}}",
    });
    expect(ctrl.getFilterExpr()).toBe('domain = "eew"');
    expect(ctrl.getFocusExpr()).toBe('frameLevel >= "warning"');
    expect(ctrl.getTemplateExpr()).toBe("{{title}}");
    expect(ctrl.getPipeline().filter).not.toBeNull();
    expect(ctrl.getPipeline().focus).not.toBeNull();
    expect(ctrl.getPipeline().template).not.toBeNull();
  });

  it("fromExpressions で null 値はスキップされる", () => {
    const ctrl = PipelineController.fromExpressions({});
    expect(ctrl.getPipeline().filter).toBeNull();
    expect(ctrl.getPipeline().template).toBeNull();
    expect(ctrl.getPipeline().focus).toBeNull();
  });
});
