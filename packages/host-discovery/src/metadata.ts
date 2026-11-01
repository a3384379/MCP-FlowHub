import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { parseDocument } from "yaml";
import { ensure, hash, type Json } from "../../contracts/src/domain.js";

/** Parse data only. Tags, aliases, scripts and instructions never execute. */
function yaml(text: string): Json {
  ensure(
    Buffer.byteLength(text) <= 131072,
    "SCHEMA_LIMIT",
    "Skill metadata exceeds the discovery limit.",
  );
  const document = parseDocument(text, {
    schema: "core",
    uniqueKeys: true,
    stringKeys: true,
  });
  ensure(
    !document.errors.length && !document.warnings.length,
    "SKILL_METADATA_INVALID",
    "Invalid or unsupported Skill YAML.",
  );
  const value = document.toJS({ maxAliasCount: 0 });
  ensure(
    value && typeof value === "object" && !Array.isArray(value),
    "SKILL_METADATA_INVALID",
    "Skill metadata must be an object.",
  );
  return value;
}
const textValue = (v: unknown, limit = 8000) =>
  typeof v === "string" ? v.slice(0, limit).trim() : "";

export async function skillMetadata(
  path: string,
  text: string,
  report: (path: string, code: string) => void,
) {
  let meta: Json = {},
    dependencies: Json[] = [],
    dependencyHash: string | null = null;
  const frontmatter = text.match(
    /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/,
  );
  if (frontmatter)
    try {
      meta = yaml(frontmatter[1]!);
    } catch {
      report(path, "SKILL_METADATA_INVALID");
    }
  const root = dirname(path),
    declaration = resolve(root, "agents/openai.yaml");
  try {
    const actual = await realpath(declaration),
      child = relative(await realpath(root), actual);
    ensure(
      !child.startsWith("..") && !isAbsolute(child),
      "SOURCE_UNREADABLE",
      "Skill dependency declaration escaped its root.",
    );
    const raw = await readFile(actual, "utf8"),
      data = yaml(raw);
    const tools = data.dependencies?.tools;
    ensure(
      tools === undefined || (Array.isArray(tools) && tools.length <= 100),
      "SKILL_DEPENDENCY_INVALID",
      "Expected a bounded dependency list.",
    );
    for (const tool of tools ?? []) {
      if (tool?.type !== "mcp") continue;
      ensure(
        typeof tool.value === "string" &&
          tool.value.length > 0 &&
          tool.value.length <= 256,
        "SKILL_DEPENDENCY_INVALID",
        "MCP dependency identity is required.",
      );
      // URLs/auth/commands in a declaration are not imported, fetched or executed.
      dependencies.push({
        name: tool.value,
        description: textValue(tool.description, 1000),
        evidence: "agents/openai.yaml#dependencies.tools",
      });
    }
    dependencyHash = hash(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      report(declaration, "SKILL_DEPENDENCY_INVALID");
  }
  const mentions = [
    ...new Set(
      [...text.matchAll(/\bmcp__([a-zA-Z0-9_-]+)__/g)].map(
        (match) => match[1]!,
      ),
    ),
  ].slice(0, 100);
  return {
    name: textValue(meta.name, 256),
    description: textValue(meta.description),
    dependencies,
    dependencyHash,
    mentions,
  };
}
