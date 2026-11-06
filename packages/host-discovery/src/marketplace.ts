import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative } from "node:path";
import { ensure, hash, type Json } from "../../contracts/src/domain.js";

const identity = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
const text = (value: unknown, limit: number) => typeof value === "string" ? value.slice(0, limit) : "";
const object = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

/** Documented local catalogs only. A catalog is availability evidence, never an
 * installation or permission to read source.path, fetch packages or run hooks.
 * https://developers.openai.com/plugins/build/plugins#marketplace-metadata
 */
export async function addLocalMarketplaces(context: Json, components: Json[], report: (path: string, code: string) => void) {
  const entries = new Map<string, Json[]>();
  const paths = new Map<string, string>([
    [join(dirname(context.codexHome), ".agents/plugins/marketplace.json"), dirname(context.codexHome)],
  ]);
  if (context.projectTrusted) paths.set(join(context.canonicalCwd, ".agents/plugins/marketplace.json"), context.canonicalCwd);
  for (const [path, root] of paths) {
    let raw: string, catalog: Json;
    try {
      const actual = await realpath(path), child = relative(await realpath(root), actual);
      ensure(!child.startsWith("..") && !isAbsolute(child), "SOURCE_UNREADABLE", "Marketplace metadata escaped the registered root.");
      ensure((await stat(actual)).size <= 1048576, "SCHEMA_LIMIT", "Marketplace metadata exceeds the discovery limit.");
      raw = await readFile(actual, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") report(path, (error as NodeJS.ErrnoException).code === "SCHEMA_LIMIT" ? "PLUGIN_MARKETPLACE_UNSUPPORTED" : "SOURCE_UNREADABLE");
      continue;
    }
    try {
      catalog = JSON.parse(raw);
      ensure(object(catalog) && identity(catalog.name) && Array.isArray(catalog.plugins) && catalog.plugins.length <= 500 &&
        ["schemaVersion", "schema_version", "manifest_version"].every(key => catalog[key] === undefined),
      "PLUGIN_MARKETPLACE_UNSUPPORTED", "Unsupported local marketplace metadata.");
    } catch {
      report(path, "PLUGIN_MARKETPLACE_UNSUPPORTED");
      continue;
    }
    const seen = new Set<string>();
    for (const entry of catalog.plugins) {
      try {
        const localPath = typeof entry?.source === "string" ? entry.source : entry?.source?.source === "local" ? entry.source.path : null;
        ensure(object(entry) && identity(entry.name) && !seen.has(entry.name) && typeof localPath === "string" &&
          localPath.startsWith("./") && !localPath.includes("\\") && !/[\u0000-\u001f?#@]/.test(localPath) &&
          posix.resolve("/marketplace-root", localPath).startsWith("/marketplace-root/") &&
          ["AVAILABLE", "INSTALLED_BY_DEFAULT", "NOT_AVAILABLE"].includes(entry.policy?.installation) &&
          typeof entry.policy?.authentication === "string" && entry.policy.authentication.length <= 64 &&
          typeof entry.category === "string" && entry.category.length <= 128,
        "PLUGIN_MARKETPLACE_UNSUPPORTED", "Unsupported local marketplace entry.");
        seen.add(entry.name);
        const sourceKey = entry.name + "@" + catalog.name;
        const metadata = {
          path,
          name: entry.name,
          description: text(entry.description ?? entry.interface?.shortDescription, 8000),
          marketplaceName: catalog.name,
          marketplaceDisplayName: text(catalog.interface?.displayName, 256),
          marketplacePolicy: entry.policy.installation,
          authenticationPolicy: entry.policy.authentication,
          category: entry.category,
        };
        entries.set(sourceKey, [...(entries.get(sourceKey) ?? []), metadata]);
      } catch {
        report(path, "PLUGIN_MARKETPLACE_UNSUPPORTED");
      }
    }
  }
  for (const [sourceKey, values] of entries) {
    // Path order is stable provenance, never a personal/project precedence rule.
    const sources = values.sort((a, b) => a.path.localeCompare(b.path));
    const conflict = new Set(sources.map(({ path, ...metadata }) => hash(metadata))).size > 1;
    const provenance = {
      marketplaceRefs: sources.map(source => source.path), marketplaceSources: sources,
      marketplaceFingerprint: hash(sources), marketplaceConflict: conflict,
    };
    if (conflict) for (const source of sources) report(source.path, "PLUGIN_MARKETPLACE_AMBIGUOUS");
    const previousIndex = components.findIndex(component => component.kind === "plugin" && component.sourceKey === sourceKey);
    const previous = components[previousIndex];
    if (previous && previous.installed !== false) {
      // The installed cache is independent installation evidence. Catalog
      // disagreement cannot overwrite its manifest, enablement or components.
      Object.assign(previous, provenance);
      continue;
    }
    const common = (field: string) => sources.every(source => source[field] === sources[0]![field]) ? sources[0]![field] : null;
    const policy = common("marketplacePolicy");
    const candidate = {
      name: sources[0]!.name, sourceKey, kind: "plugin", installed: false, installation: "available_only", enabled: null,
      description: common("description") ?? "市场来源提供了不同介绍，请查看来源差异。",
      marketplaceName: sources[0]!.marketplaceName, marketplaceDisplayName: common("marketplaceDisplayName"),
      ...(policy !== null ? { marketplacePolicy: policy } : {}),
      category: common("category"), executor: "informational",
      availability: conflict ? "ambiguous" : policy === "NOT_AVAILABLE" ? "unavailable" : "available_only",
      ...(sources.length === 1 ? { path: sources[0]!.path } : {}),
      ...provenance, manifestHash: provenance.marketplaceFingerprint,
    };
    if (previousIndex >= 0) components[previousIndex] = candidate;
    else components.push(candidate);
  }
}
