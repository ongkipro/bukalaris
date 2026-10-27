import type { ReactNode } from "react";

/**
 * Markdown-lite → React elements (SEC-8): headings (#, ##, ###), paragraphs, bullet and
 * numbered lists, **bold**, *italic*, [text](https://…). Text is always rendered as text;
 * no HTML is ever parsed or injected. Links allow http(s), mailto and same-site paths only.
 */
const SAFE_HREF = /^(https?:\/\/|mailto:|\/(?!\/))/i;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1] !== undefined) out.push(<strong key={k}>{m[1]}</strong>);
    else if (m[2] !== undefined) out.push(<em key={k}>{m[2]}</em>);
    else if (m[3] !== undefined && m[4] !== undefined) {
      out.push(
        SAFE_HREF.test(m[4]) ? (
          <a key={k} href={m[4]} rel={/^https?:/i.test(m[4]) ? "noopener noreferrer" : undefined} className="underline underline-offset-4">{m[3]}</a>
        ) : (
          m[3]
        ),
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MarkdownLite({ body, className = "" }: { body: string; className?: string }) {
  const blocks: ReactNode[] = [];
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  let n = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") { i++; continue; }
    const key = `b${n++}`;
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const text = inline(heading[2]!, key);
      blocks.push(level === 1 ? <h2 key={key}>{text}</h2> : level === 2 ? <h3 key={key}>{text}</h3> : <h4 key={key}>{text}</h4>);
      i++;
      continue;
    }
    const bullet = /^\s*[-*]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    const listRe = bullet.test(line) ? bullet : numbered.test(line) ? numbered : null;
    if (listRe) {
      const items: ReactNode[] = [];
      while (i < lines.length && listRe.test(lines[i]!)) {
        items.push(<li key={`${key}-${items.length}`}>{inline(lines[i]!.replace(listRe, ""), `${key}-${items.length}`)}</li>);
        i++;
      }
      blocks.push(listRe === bullet ? <ul key={key}>{items}</ul> : <ol key={key}>{items}</ol>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !/^(#{1,3})\s/.test(lines[i]!) && !bullet.test(lines[i]!) && !numbered.test(lines[i]!)) {
      para.push(lines[i]!.trim());
      i++;
    }
    blocks.push(<p key={key}>{inline(para.join(" "), key)}</p>);
  }
  return <div className={`prose-lite ${className}`}>{blocks}</div>;
}
