import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
const escapeHtml = markdown.utils.escapeHtml;

// Report documents have no external resources or navigation. Keep reference
// labels readable and show image descriptions without fetching their sources.
markdown.renderer.rules.link_open = (tokens, index) =>
  '<span class="reference" title="' + escapeHtml(String(tokens[index]?.attrGet("href") ?? "")) + '">';
markdown.renderer.rules.link_close = () => "</span>";
markdown.renderer.rules.image = (tokens, index) =>
  '<span class="reference">' + escapeHtml(tokens[index]?.content ?? "") + "</span>";

const legacyStart = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>FlowHub 排查报告</title><style>body{max-width:960px;margin:40px auto;padding:24px;font:15px/1.9 system-ui;color:#172b46}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}</style><pre>';
const legacyEnd = "</pre></html>";
const legacyEntities: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
};

export function legacyReportHtml(text: string) {
  return legacyStart + escapeHtml(text) + legacyEnd;
}

export const reportRenderer = "flowhub-markdown-v1";
const reportStart = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="flowhub-report" content="${reportRenderer}">`;
const styles = `
  *{box-sizing:border-box}
  body{margin:0;background:#eef3f8;color:#192c45;font:15px/1.65 system-ui,sans-serif;overflow-wrap:anywhere}
  header{background:#182d47;color:#fff;padding:12px max(16px,calc((100% - 1160px)/2));font-weight:650}
  .layout{display:grid;grid-template-columns:minmax(150px,220px) minmax(0,1fr);gap:20px;max-width:1192px;margin:auto;padding:20px 16px}
  .layout.single{display:block;max-width:960px}
  nav,main{background:#fff;border:1px solid #d6e0ec;border-radius:12px}
  nav{position:sticky;top:12px;align-self:start;max-height:calc(100vh - 24px);overflow:auto;padding:14px}
  nav p{margin:0 0 8px;color:#506580;font-size:13px;font-weight:650}
  nav a{display:block;padding:4px 7px;color:#245889;text-decoration:none;font-size:14px}
  nav a:hover,nav a:focus-visible{background:#eaf2ff}
  main{padding:clamp(16px,4vw,32px)}
  h1,h2,h3,h4,h5,h6{line-height:1.35;scroll-margin-top:16px}
  h1{font-size:clamp(22px,4vw,32px);margin:0 0 22px}
  h2{font-size:21px;margin:28px 0 12px;padding-bottom:8px;border-bottom:1px solid #dbe6f2}
  h3{font-size:17px;margin:22px 0 8px}
  :target{outline:2px solid #a7c5ec;outline-offset:4px}
  p,ul,ol{margin:10px 0 16px}
  ul,ol{padding-inline-start:1.65em}
  li+li{margin-top:4px}
  blockquote{margin:14px 0;padding:2px 14px;background:#f2f7fd;border-inline-start:3px solid #789fce}
  code{font:0.92em ui-monospace,Consolas,monospace;background:#eef3fa;border-radius:4px;padding:2px 4px}
  pre{margin:14px 0;background:#f2f6fb;border:1px solid #dce6f0;border-radius:8px;padding:12px;white-space:pre-wrap}
  pre code{background:none;padding:0}
  table{width:100%;border-collapse:collapse;margin:14px 0}
  th,td{border:1px solid #d6e0ec;padding:7px 10px;text-align:start;vertical-align:top}
  th{background:#eaf2fb}tbody tr:nth-child(even){background:#f7fafd}
  .reference{color:#245889;text-decoration:underline}
  @media(max-width:620px){.layout{grid-template-columns:minmax(0,1fr);gap:12px}nav{position:static;max-height:14rem}}
  @media print{body{background:#fff}header,nav{display:none}.layout{display:block;padding:0}main{border:0;padding:0}}
`;

export function renderReportHtml(text: string) {
  const env = {};
  const tokens = markdown.parse(text, env);
  const sections: { id: string; label: string }[] = [];
  let title: string | undefined;
  for (const [index, token] of tokens.entries()) {
    if (token.type !== "heading_open" || token.level !== 0) continue;
    const label = tokens[index + 1]?.children?.map((child) => child.content).join("").trim();
    if (!label) continue;
    if (token.tag === "h1" && !title) {
      title = label;
      continue;
    }
    const id = `section-${sections.length + 1}`;
    token.attrSet("id", id);
    sections.push({ id, label });
  }
  const name = "FlowHub 排查报告";
  const index = sections.length
    ? '<nav aria-label="报告目录"><p>报告目录</p>' +
      sections.map(({ id, label }) => `<a href="#${id}">${escapeHtml(label)}</a>`).join("") + "</nav>"
    : "";
  const body = markdown.renderer.render(tokens, markdown.options, env);
  return reportStart + `<title>${escapeHtml(title ?? name)}</title><style>${styles}</style></head>
    <body><header>${name}</header><div class="layout${index ? "" : " single"}">${index}<main>${title ? "" : `<h1>${name}</h1>`}${body}</main></div></body></html>`;
}

export function formattedReport(artifact: {
  mimeType: string;
  content: string;
  verification?: { reportRenderer?: string };
}) {
  const { mimeType, content } = artifact;
  if (mimeType === "text/markdown") return renderReportHtml(content);
  if (mimeType !== "text/html") return undefined;
  if (artifact.verification?.reportRenderer === reportRenderer && content.startsWith(reportStart))
    return content;
  if (!content.startsWith(legacyStart) || !content.endsWith(legacyEnd)) return undefined;
  const original = content.slice(legacyStart.length, -legacyEnd.length)
    .replace(/&(amp|lt|gt|quot);/g, (entity) => legacyEntities[entity]!);
  return renderReportHtml(original);
}
