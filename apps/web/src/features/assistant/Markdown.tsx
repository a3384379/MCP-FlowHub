import { Fragment, type ReactNode } from "react";

function href(value: string) {
  const url = value.trim();
  return /^(?:https?:\/\/|mailto:|\/(?!\/)|#)/i.test(url) ? url : undefined;
}
function inline(text: string, depth = 0): ReactNode {
  if (depth > 4) return text;
  const pattern =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g;
  const out: ReactNode[] = [];
  let start = 0,
    match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    out.push(text.slice(start, match.index));
    const token = match[0],
      key = match.index;
    if (token.startsWith("`"))
      out.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("**"))
      out.push(
        <strong key={key}>{inline(token.slice(2, -2), depth + 1)}</strong>,
      );
    else if (token.startsWith("*"))
      out.push(<em key={key}>{inline(token.slice(1, -1), depth + 1)}</em>);
    else {
      const parts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
      const target = href(parts[2]);
      out.push(
        target ? (
          <a
            key={key}
            href={target}
            target={target.startsWith("http") ? "_blank" : undefined}
            rel="noreferrer noopener"
          >
            {parts[1]}
          </a>
        ) : (
          <Fragment key={key}>{parts[1]}</Fragment>
        ),
      );
    }
    start = pattern.lastIndex;
  }
  out.push(text.slice(start));
  return out;
}
/** Deliberate Markdown subset rendered as React nodes; model HTML is never executed. */
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n"),
    blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i],
      key = i;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const language = line.replace(/^\s*```/, "").trim(),
        code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]))
        code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push(
        <pre key={key} aria-label={language ? language + " 代码" : "代码"}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push(<h4 key={key}>{inline(heading[2])}</h4>);
      i++;
      continue;
    }
    const list = /^\s*(?:[-*+] |\d+\. )/.test(line);
    if (list) {
      const ordered = /^\s*\d+\. /.test(line),
        items: ReactNode[] = [];
      while (
        i < lines.length &&
        (ordered ? /^\s*\d+\. / : /^\s*[-*+] /).test(lines[i])
      ) {
        items.push(
          <li key={i}>
            {inline(lines[i].replace(/^\s*(?:[-*+] |\d+\. )/, ""))}
          </li>,
        );
        i++;
      }
      blocks.push(
        ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>,
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      blocks.push(
        <blockquote key={key}>{inline(line.replace(/^>\s?/, ""))}</blockquote>,
      );
      i++;
      continue;
    }
    const paragraph = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(?:```|#{1,4}\s|[-*+] |\d+\. |>)/.test(lines[i])
    )
      paragraph.push(lines[i++]);
    blocks.push(
      <p key={key}>
        {paragraph.map((part, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(part)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className="assistant-markdown">{blocks}</div>;
}
