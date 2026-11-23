import { getSmoothStepPath, type Edge, type Node } from "@xyflow/react";

export const workflowNodeWidth = 260;
const fontFamily = "system-ui, 'Microsoft YaHei', 'PingFang SC', sans-serif";
const padding = 56;
const headerHeight = 62;
const edgeOffset = 20;
const branchLabelWidth = 82;

type DiagramNode = Pick<Node, "id" | "position" | "measured"> & {
  title: string;
  kind: string;
  icon: string;
};

function svgText(text: string) {
  return text
    .replace(
      /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu,
      "",
    )
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function buildWorkflowSvg(
  name: string,
  nodes: DiagramNode[],
  edges: Pick<Edge, "source" | "target" | "label">[],
) {
  if (!nodes.length) return;

  const canvas = document.createElement("canvas").getContext("2d");
  const measure = (value: string, size: number, weight: number) => {
    if (!canvas) return Array.from(value).length * size;
    canvas.font = `${weight} ${size}px ${fontFamily}`;
    return canvas.measureText(value).width;
  };
  const fit = (value: string, width: number, size: number, weight: number) =>
    measure(value, size, weight) > width
      ? ` textLength="${width}" lengthAdjust="spacingAndGlyphs"`
      : "";
  const cards = nodes.map(
    ({ id, position: { x, y }, measured, title, kind, icon }) => ({
      id,
      x,
      y,
      width: measured?.width ?? workflowNodeWidth,
      height: measured?.height ?? 80,
      title: title.replace(/\s+/g, " ").trim(),
      kind,
      icon,
    }),
  );
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const left = Math.min(...cards.map((card) => card.x));
  const top = Math.min(...cards.map((card) => card.y));
  const bottom = Math.max(...cards.map((card) => card.y + card.height));
  const height = Math.ceil(bottom - top + padding * 2 + headerHeight);

  const routes = edges.flatMap((edge) => {
    const source = cardById.get(edge.source);
    const target = cardById.get(edge.target);
    if (!source || !target) return [];
    const sourceX = source.x + source.width / 2;
    const targetX = target.x + target.width / 2;
    const label = typeof edge.label === "string" ? edge.label : "";
    if (label && sourceX === targetX) {
      // A branch that skips a card in the same column needs its own visible route.
      const sourceY = source.y + source.height / 2;
      const targetY = target.y + target.height / 2;
      const between = cards.filter(
        (card) =>
          card !== source &&
          card !== target &&
          card.x <= sourceX &&
          card.x + card.width >= sourceX &&
          card.y < Math.max(sourceY, targetY) &&
          card.y + card.height > Math.min(sourceY, targetY),
      );
      if (between.length) {
        const sourceRight = source.x + source.width;
        const targetRight = target.x + target.width;
        const x =
          Math.max(
            sourceRight,
            targetRight,
            ...between.map((card) => card.x + card.width),
          ) + branchLabelWidth / 2 + 12;
        return [
          {
            path: `M${sourceRight} ${sourceY}H${x}V${targetY}H${targetRight}`,
            x,
            y: (sourceY + targetY) / 2,
            label,
          },
        ];
      }
    }
    const [path, x, y] = getSmoothStepPath({
      sourceX,
      sourceY: source.y + source.height,
      targetX,
      targetY: target.y,
      offset: edgeOffset,
    });
    return [{ path, x, y, label }];
  });
  const right = Math.max(
    ...cards.map((card) => card.x + card.width),
    ...routes.map((route) => route.x),
  );
  const width = Math.ceil(Math.max(360, right - left + padding * 2));

  const nameText = name.replace(/\s+/g, " ").trim();
  // Smooth-step uses top and bottom handles. The padding also covers the route
  // offset when a node is dragged above its predecessor, and the branch labels.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="workflow-title" font-family="${fontFamily}">
  <title id="workflow-title">${svgText(nameText)}</title>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
      <path d="M0 0 10 5 0 10z" fill="#557db5"/>
    </marker>
  </defs>
  <rect width="${width}" height="${height}" fill="#f2f7ff"/>
  <rect width="${width}" height="${headerHeight}" fill="#ffffff"/>
  <path d="M0 ${headerHeight}H${width}" stroke="#cfdaeb"/>
  <text x="${padding}" y="39" fill="#15233b" font-size="22" font-weight="700"${fit(nameText, width - padding * 2, 22, 700)}>${svgText(nameText)}</text>
  <g transform="translate(${padding - left} ${headerHeight + padding - top})">
    <g class="workflow-edges" fill="none" stroke="#557db5" stroke-width="2" stroke-linejoin="round">
      ${routes.map(({ path }) => `<path d="${path}" marker-end="url(#arrow)"/>`).join("\n      ")}
    </g>
    <g class="workflow-branches" font-size="12" text-anchor="middle" fill="#274f86">
      ${routes
        .filter(({ label }) => label)
        .map(
          ({ x, y, label }) => `<g transform="translate(${x} ${y})">
        <rect x="${-branchLabelWidth / 2}" y="-11" width="${branchLabelWidth}" height="22" rx="7" fill="#ffffff" stroke="#c2d3eb"/>
        <text y="4">${svgText(label)}</text>
      </g>`,
        )
        .join("\n      ")}
    </g>
    <g class="workflow-nodes">
      ${cards
        .map(
          ({
            x,
            y,
            width: cardWidth,
            height: cardHeight,
            title,
            kind,
            icon,
          }) => {
            const titleWidth = cardWidth - 76;
            const titleSize = measure(title, 15, 600) > titleWidth ? 12 : 15;
            return `<g transform="translate(${x} ${y})">
        <title>${svgText(title)}</title>
        <rect width="${cardWidth}" height="${cardHeight}" rx="12" fill="#ffffff" stroke="#c4d4eb"/>
        <rect x="14" y="${cardHeight / 2 - 18}" width="36" height="36" rx="8" fill="#e8f0fd"/>
        <text x="32" y="${cardHeight / 2 + 7}" text-anchor="middle" fill="#2460bd" font-size="22">${svgText(icon)}</text>
        <text x="62" y="${cardHeight / 2 - 8}" fill="#526786" font-size="11">${svgText(kind)}</text>
        <text x="62" y="${cardHeight / 2 + 13}" fill="#15233b" font-size="${titleSize}" font-weight="600"${fit(title, titleWidth, titleSize, 600)}>${svgText(title)}</text>
      </g>`;
          },
        )
        .join("\n      ")}
    </g>
  </g>
</svg>`;

  const filename = Array.from(nameText.replace(/[<>:"/\\|?*\p{Cc}]+/gu, "_"))
    .slice(0, 50)
    .join("")
    .replace(/[. ]+$/g, "");
  return { filename: `${filename || "工作流"}-流程图.svg`, svg };
}
