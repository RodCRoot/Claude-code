/**
 * Minimal, safe Markdown for form bodies.
 *
 * The parser produces a small AST (headings, paragraphs, lists, rules, inline
 * bold/italic). It never passes raw HTML through: angle brackets are just text,
 * and the React renderer escapes everything. The same AST feeds the PDF renderer,
 * so the signed PDF shows the same words the signer saw.
 */

export type Inline = { text: string; bold?: boolean; italic?: boolean };
export type Block =
  | { type: "heading"; level: 1 | 2 | 3; inlines: Inline[] }
  | { type: "paragraph"; inlines: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "rule" };

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  // Tokens: **bold**, __bold__, *italic*, _italic_. Unmatched markers stay literal.
  const re = /(\*\*|__)(.+?)\1|(\*|_)(?!\s)(.+?)(?<!\s)\3/g;
  let last = 0;
  for (const m of src.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ text: src.slice(last, idx) });
    if (m[1]) out.push({ text: m[2], bold: true });
    else out.push({ text: m[4], italic: true });
    last = idx + m[0].length;
  }
  if (last < src.length) out.push({ text: src.slice(last) });
  return out.filter((i) => i.text.length > 0);
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) blocks.push({ type: "paragraph", inlines: parseInline(para.join(" ").trim()) });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push({ type: "list", ordered: list.ordered, items: list.items.map((i) => parseInline(i)) });
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (!t) {
      flushPara();
      flushList();
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(t);
    if (h) {
      flushPara();
      flushList();
      blocks.push({ type: "heading", level: h[1].length as 1 | 2 | 3, inlines: parseInline(h[2]) });
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      flushPara();
      flushList();
      blocks.push({ type: "rule" });
      continue;
    }
    const ul = /^[-*+]\s+(.*)$/.exec(t);
    const ol = /^\d+[.)]\s+(.*)$/.exec(t);
    if (ul || ol) {
      flushPara();
      const ordered = !!ol;
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push((ul ?? ol)![1]);
      continue;
    }
    if (list && /^\s{2,}/.test(raw)) {
      // Continuation of the previous list item.
      list.items[list.items.length - 1] += " " + t;
      continue;
    }
    flushList();
    para.push(t);
  }
  flushPara();
  flushList();
  return blocks;
}

export function inlinesToText(inlines: Inline[]): string {
  return inlines.map((i) => i.text).join("");
}
