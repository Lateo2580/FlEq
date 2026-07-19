import * as fs from "fs";
import * as path from "path";
import { Hono } from "hono";
import { resolveHeadings } from "../lib/display-reference-map";

const MD_PATH = path.resolve(__dirname, "../../../docs/display-reference.md");

/** md 全文から「heading 行 〜 次の ## 行の直前」を抽出する */
function extractSection(md: string, heading: string): string | null {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

export function displayReferenceRoute(): Hono {
  const app = new Hono();
  app.get("/", (c) => {
    const type = c.req.query("type");
    if (type == null || type === "") {
      return c.json({ error: "type クエリが必要です (例: ?type=VPWW55)" }, 400);
    }
    let md: string;
    try {
      md = fs.readFileSync(MD_PATH, "utf-8");
    } catch {
      return c.json({ error: "display-reference.md を読み込めません" }, 500);
    }
    const sections = resolveHeadings(type)
      .map((h) => ({ heading: h.replace(/^## /, ""), markdown: extractSection(md, h) }))
      .filter((s): s is { heading: string; markdown: string } => s.markdown != null);
    return c.json({ sections });
  });
  return app;
}
