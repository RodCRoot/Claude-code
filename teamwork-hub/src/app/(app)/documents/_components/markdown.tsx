import { parseMarkdown, type Inline } from "@/lib/forms/markdown";
import { Badge } from "@/components/ui";

/** Renders form Markdown via React elements only — no raw HTML is ever injected. */
export function FormMarkdown({ source }: { source: string }) {
  const blocks = parseMarkdown(source);
  return (
    <div className="space-y-3 text-sm leading-relaxed text-ink">
      {blocks.map((b, i) => {
        switch (b.type) {
          case "heading": {
            const cls = b.level === 1 ? "text-xl font-bold" : b.level === 2 ? "pt-2 text-base font-semibold" : "text-sm font-semibold";
            const H = b.level === 1 ? "h3" : b.level === 2 ? "h4" : "h5";
            return (
              <H key={i} className={cls}>
                <Inlines inlines={b.inlines} />
              </H>
            );
          }
          case "paragraph":
            return (
              <p key={i}>
                <Inlines inlines={b.inlines} />
              </p>
            );
          case "list": {
            const L = b.ordered ? "ol" : "ul";
            return (
              <L key={i} className={b.ordered ? "list-decimal space-y-1 pl-6" : "list-disc space-y-1 pl-6"}>
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Inlines inlines={it} />
                  </li>
                ))}
              </L>
            );
          }
          case "rule":
            return <hr key={i} className="border-edge" />;
        }
      })}
    </div>
  );
}

function Inlines({ inlines }: { inlines: Inline[] }) {
  return (
    <>
      {inlines.map((x, i) =>
        x.bold && x.italic ? (
          <strong key={i}>
            <em>{x.text}</em>
          </strong>
        ) : x.bold ? (
          <strong key={i}>{x.text}</strong>
        ) : x.italic ? (
          <em key={i}>{x.text}</em>
        ) : (
          <span key={i}>{x.text}</span>
        ),
      )}
    </>
  );
}

export function SampleTextBanner({ isSample }: { isSample: boolean }) {
  if (!isSample) return null;
  return (
    <div role="note" className="rounded-lg border-2 border-warn bg-warn/10 px-4 py-3 text-sm font-bold text-warn">
      SAMPLE TEXT — replace with Teamwork-approved language
      <span className="mt-0.5 block text-xs font-medium text-ink-2">
        This wording is a placeholder written for the pilot. An owner or admin must replace it and mark it approved before it is relied on.
      </span>
    </div>
  );
}

export function SampleBadge({ isSample }: { isSample: boolean }) {
  return isSample ? (
    <Badge variant="yellow" title="SAMPLE TEXT — replace with Teamwork-approved language">
      SAMPLE TEXT
    </Badge>
  ) : (
    <Badge variant="green">Approved text</Badge>
  );
}

export function Hash({ value, short = false }: { value: string | null | undefined; short?: boolean }) {
  if (!value) return <span className="text-ink-3">—</span>;
  return (
    <code className="break-all rounded bg-surface-2 px-1 font-mono text-[11px]" title={value}>
      {short ? `${value.slice(0, 12)}…` : value}
    </code>
  );
}
