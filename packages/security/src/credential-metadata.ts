import type { Repository } from "../../persistence/src/repository.js";
import { storedConfigurationFields } from "../../host-discovery/src/connection-fields.js";
import type { Json } from "../../contracts/src/domain.js";

/** Derive old records from actual references; labels are never used as types. */
export function credentialInventory(repo: Repository): Json[] {
  const usages = new Map<string, Json[]>();
  const add = (ref: string, usage: Json) => {
    if (ref) usages.set(ref, [...(usages.get(ref) ?? []), usage]);
  };
  for (const p of repo.all("model_profiles"))
    add(p.secretRef, { kind: "model_api", name: p.name, id: p.id });
  for (const c of repo.all("connections")) {
    const source = c.sourceId
      ? repo.get("capability_sources", c.sourceId)
      : null;
    const base = {
      name: source?.name ?? c.name,
      id: c.id,
      sourceId: c.sourceId ?? null,
    };
    add(c.secretRef, { ...base, kind: "mcp_auth" });
    const declared =
      source && source.sourceFingerprint === c.sourceFingerprint
        ? storedConfigurationFields(source)
        : [];
    for (const [name, ref] of Object.entries(c.envRefs ?? {})) {
      const kind =
        c.configurationKinds?.[name] ??
        declared.find((f) => f.name === name)?.kind;
      add(String(ref), {
        ...base,
        variable: name,
        kind:
          kind === "config"
            ? "mcp_config"
            : kind === "credential"
              ? "mcp_auth"
              : "unspecified",
      });
    }
  }
  return repo
    .all("secrets")
    .map(({ id, label, createdAt, purpose, sourceId, variable }) => {
      const usedBy = usages.get(id) ?? [];
      const modelCredential =
        purpose === "model_api" || usedBy.some((u) => u.kind === "model_api");
      const purposes = [
        ...new Set([
          ...(purpose ? [purpose] : []),
          ...usedBy.map((u) => u.kind),
        ]),
      ];
      return {
        id,
        label,
        createdAt,
        purpose:
          purpose && purpose !== "unspecified"
            ? purpose
            : purposes.filter((p) => p !== "unspecified").length === 1
              ? purposes.filter((p) => p !== "unspecified")[0]
              : "unspecified",
        purposes,
        sourceId: sourceId ?? null,
        variable: variable ?? null,
        usedBy,
        modelCredential,
        eligibleForMcp: !modelCredential,
      };
    });
}
