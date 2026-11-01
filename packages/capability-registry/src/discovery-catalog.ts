import {
  ensure,
  hash,
  now,
  validate,
  type Json,
} from "../../contracts/src/domain.js";
import { inputContract } from "../../contracts/src/index.js";
import type { Repository } from "../../persistence/src/repository.js";

const pluginId = (contextId: string, key: string) =>
  "plugin_" + hash([contextId, key]).slice(0, 24);
const hostServerId = (contextId: string, name: string) =>
  "host_" + hash([contextId, name]).slice(0, 24);
const text = (value: unknown) => (typeof value === "string" ? value : "");
export const catalogQuerySchema = {
  type: "object",
  properties: {
    contextId: { type: "string", minLength: 1 },
    query: { type: "string", maxLength: 2000 },
    kind: { enum: ["mcp_server", "mcp_tool", "skill", "plugin"] },
    executor: { enum: ["hub_direct", "codex_host", "informational"] },
    source: { enum: ["plugin", "independent"] },
    status: { type: "string", maxLength: 100 },
    parentId: { type: "string", maxLength: 256 },
    cursor: { type: "string", maxLength: 2000 },
    limit: { type: "integer", minimum: 1, maximum: 100 },
  },
  additionalProperties: false,
};

/** Read projection and optional translated display data; never an executor. */
export class DiscoveryCatalog {
  constructor(readonly repo: Repository) {}
  private entities(contextId?: string): Json[] {
    return (
      this.repo.db
        .prepare(
          "SELECT body FROM discovery_entities" +
            (contextId ? " WHERE json_extract(body,'$.contextId')=?" : "") +
            " ORDER BY id",
        )
        .all(...(contextId ? [contextId] : [])) as { body: string }[]
    ).map((row) => JSON.parse(row.body));
  }
  private latestPresentation(entityId: string): Json | undefined {
    const row = this.repo.db
      .prepare(
        "SELECT body FROM discovery_presentations WHERE json_extract(body,'$.entityId')=? AND json_extract(body,'$.locale')='zh-CN' ORDER BY revision DESC LIMIT 1",
      )
      .get(entityId) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  present(entity: Json): Json {
    const saved = this.latestPresentation(entity.id),
      context = this.repo.get("host_contexts", entity.contextId);
    const state = saved
      ? saved.sourceFingerprint !== entity.sourceFingerprint
        ? "stale"
        : saved.authorship === "manual"
          ? "manually_edited"
          : "localized"
      : /\p{Script=Han}/u.test(entity.description ?? "")
        ? "original"
        : "pending";
    const valid = saved && state !== "stale";
    const plugin = entity.pluginId
      ? this.repo.get("discovery_entities", entity.pluginId)
      : undefined;
    const pluginText = plugin ? this.latestPresentation(plugin.id) : undefined;
    const pluginDisplayName =
      pluginText?.sourceFingerprint === plugin?.sourceFingerprint
        ? pluginText?.displayName
        : plugin?.name;
    const imports = entity.capabilityId
      ? this.repo
          .all("bindings")
          .filter(
            (binding) =>
              binding.sourceCapabilityId === entity.capabilityId &&
              binding.sourceCapabilityRevision === entity.capabilityRevision,
          )
      : [];
    const verified = (binding: Json) => {
      const connection = this.repo.get("connections", binding.connectionId);
      return (
        connection &&
        !connection.disabled &&
        connection.revision === binding.connectionRevision
      );
    };
    return {
      ...entity,
      stale: entity.stale || !context || entity.contextRevision !== context.revision,
      entityId: entity.id,
      pluginDisplayName: pluginDisplayName ?? entity.pluginName ?? null,
      pluginPresentationRevision: pluginText?.revision ?? 0,
      importState: imports.length
        ? {
            count: imports.length,
            environments: [
              ...new Set(imports.map((binding) => binding.environment)),
            ],
            verified: imports.every(
              (binding) =>
                binding.validationStatus === "BINDING_VERIFIED" &&
                !binding.simulationOnly &&
                verified(binding),
            ),
            mockVerified: imports.every(
              (binding) =>
                binding.validationStatus === "MOCK_VERIFIED" &&
                verified(binding),
            ),
          }
        : null,
      displayName: valid ? saved.displayName : entity.name,
      summary: valid ? saved.summary : entity.description,
      presentation: { ...(saved ?? {}), state, revision: saved?.revision ?? 0 },
    };
  }
  /** Runs in the completed scan's transaction; readers never see half a catalog. */
  replace(context: Json, job: Json, sources: Json[], capabilities: Json[]) {
    const entities: Json[] = [],
      components: Json[] = job.components ?? [],
      seenSkills = new Set(
        components.filter((c) => c.kind === "skill").map((c) => c.sourceKey),
      );
    const base = {
      contextId: context.id,
      contextRevision: context.revision,
      scanId: job.id,
    };
    const add = (value: Json) => entities.push({ ...base, ...value });
    for (const component of components.filter((c) => c.kind === "plugin"))
      add({
        id: pluginId(context.id, component.sourceKey),
        entityKind: "plugin",
        name: component.name,
        description: component.description ?? "",
        enabled: component.enabled,
        executor: "informational",
        availability: "installed",
        installation: "installed",
        sourceKey: component.sourceKey,
        path: component.path,
        version: component.version,
        manifestHash: component.manifestHash ?? null,
        stale: false,
        evidenceRefs: ["plugin:manifest"],
      });
    for (const source of sources.filter((s) => s.kind === "mcp_server"))
      add({
        ...source,
        ...base,
        configurationRevision: source.revision,
        configurationFingerprint: source.sourceFingerprint,
        entityKind: "mcp_server",
        description: source.description ?? "",
        sourceId: source.id,
        pluginId: source.locator?.plugin
          ? pluginId(context.id, source.locator.plugin)
          : null,
        observed: source.lastObservation?.scanId === job.id,
        stale: source.stale || source.lastObservation?.scanId !== job.id,
        evidenceRefs: ["source:configuration"],
      });
    for (const cap of capabilities) {
      const source = sources.find(
        (s) => s.id === cap.sourceRefs?.[0]?.sourceId,
      );
      const component = components.find(
        (c) => "cap_" + hash([context.id, c.sourceKey]).slice(0, 24) === cap.id,
      );
      let parentId: string | null = null;
      if (cap.kind === "mcp_tool") {
        if (source?.kind === "mcp_server") parentId = source.id;
        else if (component?.serverSourceKey)
          parentId =
            sources.find((s) => s.sourceKey === component.serverSourceKey)
              ?.id ?? null;
        else if (
          cap.provenance?.serverSourceId &&
          entities.some((e) => e.id === cap.provenance.serverSourceId)
        )
          parentId = cap.provenance.serverSourceId;
        else if (cap.serverName) {
          parentId = hostServerId(context.id, cap.serverName);
          if (!entities.some((e) => e.id === parentId))
            add({
              id: parentId,
              entityKind: "mcp_server",
              name: cap.serverName,
              description: "",
              executor: "codex_host",
              availability: component?.ambiguousSource
                ? "ambiguous"
                : "host_only",
              enabled: !component?.ambiguousSource,
              stale: cap.stale,
              sourceKey: "app-server:" + cap.serverName,
              evidenceRefs: ["host:catalog"],
              ambiguousSource: component?.ambiguousSource ?? false,
            });
        }
      }
      const parent = entities.find((e) => e.id === parentId);
      add({
        id: cap.id,
        entityKind: cap.kind,
        name: cap.name,
        description: cap.description ?? "",
        capabilityId: cap.id,
        capabilityRevision: cap.revision,
        capabilityFingerprint: cap.sourceFingerprint,
        enabled: cap.enabled === "enabled",
        executor: cap.executor,
        availability: cap.availability,
        stale:
          cap.stale ||
          source?.stale ||
          parent?.stale ||
          source?.revision !== cap.sourceRefs?.[0]?.revision ||
          cap.contextRevision !== context.revision ||
          (cap.kind === "skill" && !seenSkills.has(source?.sourceKey)),
        parentId,
        pluginId: component?.parent
          ? pluginId(context.id, component.parent)
          : (parent?.pluginId ?? null),
        sourceId: source?.id,
        path: cap.provenance?.path,
        sourceKey: source?.sourceKey,
        dependencies: component?.dependencies ?? [],
        dependencyHash: component?.dependencyHash ?? null,
        mentions: component?.mentions ?? [],
        observed: cap.kind !== "skill" || seenSkills.has(source?.sourceKey),
        evidenceRefs: [
          cap.description ? "description" : null,
          cap.kind === "skill" ? "skill:SKILL.md" : "tool:catalog",
        ].filter(Boolean),
      });
    }
    // Bind by exact declared server identity. Duplicate names remain ambiguous.
    for (const skill of entities.filter((e) => e.entityKind === "skill")) {
      skill.relations = [
        ...(skill.dependencies ?? []).map((dep: Json) => {
          const matches = entities.filter(
            (e) =>
              e.entityKind === "mcp_server" && e.name === dep.name && !e.stale,
          );
          return {
            kind: "dependency",
            name: dep.name,
            targetId: matches.length === 1 ? matches[0]!.id : null,
            status:
              matches.length > 1
                ? "ambiguous"
                : !matches.length
                  ? "missing"
                  : matches[0]!.enabled
                    ? "matched"
                    : "disabled",
            evidence: dep.evidence,
            description: dep.description,
          };
        }),
        ...(skill.mentions ?? []).map((name: string) => ({
          kind: "mention",
          name,
          evidence: "SKILL.md#mcp-tool-reference",
        })),
      ];
    }
    for (const server of entities.filter(
      (e) => e.entityKind === "mcp_server",
    )) {
      const children = entities.filter(
        (e) =>
          e.parentId === server.id && e.entityKind === "mcp_tool" && !e.stale,
      );
      server.toolCount =
        server.discovery === "schema_discovered" || children.length
          ? children.length
          : null;
      server.catalogFingerprint = hash(
        children.map((e) => [e.id, e.capabilityFingerprint]).sort(),
      );
      server.evidenceRefs.push(...children.map((e) => "tool:" + e.id));
    }
    for (const entity of entities) {
      entity.pluginName =
        entities.find((e) => e.id === entity.pluginId)?.name ?? null;
      entity.sourceFingerprint = hash({
        ...entity,
        revision: undefined,
        sourceFingerprint: undefined,
        scanId: undefined,
        discoveredAt: undefined,
        lastCatalogAt: undefined,
        lastObservation: undefined,
        observed: undefined,
      });
      const previous = this.repo.get("discovery_entities", entity.id);
      entity.revision =
        previous?.sourceFingerprint === entity.sourceFingerprint
          ? previous.revision
          : (previous?.revision ?? 0) + 1;
      entity.searchText = [
        entity.name,
        entity.description,
        entity.pluginName,
      ].join(" ");
    }
    this.repo.tx(() => {
      for (const old of this.entities(context.id))
        if (!entities.some((e) => e.id === old.id)) {
          if (job.coverage === "complete")
            this.repo.remove("discovery_entities", old.id);
          else
            this.repo.put("discovery_entities", old.id, {
              ...old,
              stale: true,
              scanId: job.id,
            });
        }
      for (const entity of entities)
        this.repo.put("discovery_entities", entity.id, entity);
      this.repo.put("host_contexts", context.id, {
        ...this.repo.get("host_contexts", context.id),
        catalogScanId: job.id,
      });
    });
  }
  overview(contextId: string) {
    const context = this.repo.get("host_contexts", contextId);
    ensure(context, "NOT_FOUND", "Host context missing.", 404);
    const job = context.catalogScanId
      ? this.repo.get("discovery_jobs", context.catalogScanId)
      : undefined;
    const entities = this.entities(contextId),
      current = context.revision === job?.contextRevision;
    const count = (kind: string) =>
      !job || !current
        ? null
        : entities.filter((e) => e.entityKind === kind && !e.stale).length ||
          (job.coverage === "complete" ? 0 : null);
    const issues = current ? (job?.issues ?? []).filter((issue:Json)=>{
      const source=issue.sourceId?this.repo.get("capability_sources",issue.sourceId):null;
      if(!source)return true;
      if(issue.code==="CREDENTIALS_REQUIRED"&&source.preparedConnectionId)return false;
      if(["CONNECTION_FAILED","AUTH_REQUIRED","CREDENTIAL_LOCKED"].includes(issue.code)&&source.discovery==="schema_discovered"&&source.availability==="ready")return false;
      return true;
    }) : [],
      actionable = entities.filter(
        (e) =>
          current &&
          e.contextRevision === context.revision &&
          e.entityKind === "mcp_server" &&
          e.enabled &&
          !e.self &&
          !e.stale &&
          [
            "credentials_required",
            "unreachable",
            "unsupported",
            "not_checked",
            "ambiguous",
          ].includes(e.availability),
      );
    const stale = entities.filter(
      (e) =>
        (e.stale || !current || e.contextRevision !== context.revision) &&
        ["mcp_server", "skill", "plugin"].includes(e.entityKind),
    );
    const represented = new Set([...actionable, ...stale].map((e) => e.id));
    const problems = [
      ...actionable.map((e) => ({
        code:
          e.availability === "not_checked"
            ? "CATALOG_NOT_SYNCED"
            : e.availability,
        entityId: e.id,
        name: e.name,
        displayName: this.present(e).displayName,
        executor: e.executor,
        connectionSetup: e.connectionSetup,
        source: e.locator?.path ?? e.path,
      })),
      ...stale.map((e) => ({
        code: "SOURCE_STALE",
        entityId: e.id,
        name: e.name,
        source: e.locator?.path ?? e.path,
      })),
      ...issues
        .filter((i: Json) => !represented.has(i.sourceId))
        .map((issue: Json) => ({
          ...issue,
          ...(entities.some((e) => e.id === issue.sourceId)
            ? { entityId: issue.sourceId }
            : {}),
        })),
    ];
    return {
      contextId,
      contextRevision: context.revision,
      scanId: job?.id ?? null,
      snapshot: job ? hash(entities.map((e) => [e.id, e.revision])) : null,
      requiresScan: !job || !current,
      coverage: job?.coverage ?? "unknown",
      status: job?.status ?? "UNSCANNED",
      completedAt: job?.completedAt ?? null,
      counts: {
        mcp_server: count("mcp_server"),
        skill: count("skill"),
        plugin: count("plugin"),
        issues: job ? problems.length : null,
      },
      issues: problems,
      localization: {
        pending: entities.filter(
          (e) =>
            !e.stale &&
            ["pending", "stale"].includes(this.present(e).presentation.state),
        ).length,
        total: entities.filter((e) => !e.stale).length,
      },
    };
  }
  search(a: Json = {}) {
    validate(catalogQuerySchema, a);
    const all = this.entities(a.contextId).map((e) => this.present(e)),
      terms = text(a.query).toLowerCase().split(/\s+/).filter(Boolean);
    const items = all.filter(
      (e) =>
        !e.stale &&
        (!a.kind || e.entityKind === a.kind) &&
        (!a.executor || e.executor === a.executor) &&
        (!a.parentId ||
          e.parentId === a.parentId ||
          e.pluginId === a.parentId) &&
        (!a.status || e.availability === a.status) &&
        (!a.source || (a.source === "plugin" ? !!e.pluginId : !e.pluginId)) &&
        terms.every((term) =>
          [
            e.searchText,
            e.pluginDisplayName,
            e.displayName,
            e.summary,
            e.presentation.state !== "stale" ? e.presentation.description : "",
          ]
            .join(" ")
            .toLowerCase()
            .includes(term),
        ),
    );
    const snapshot = hash(
        items.map((e) => [e.id, e.revision, e.stale, e.presentation.revision]),
      ),
      filter = hash({ ...a, cursor: undefined, limit: undefined });
    let start = 0;
    if (a.cursor) {
      let cursor: Json;
      try {
        cursor = JSON.parse(Buffer.from(a.cursor, "base64url").toString());
      } catch {
        ensure(false, "INPUT_INVALID", "Invalid discovery cursor.");
      }
      ensure(
        cursor! &&
          typeof cursor! === "object" &&
          cursor!.filter === filter &&
          Number.isInteger(cursor!.offset) &&
          cursor!.offset >= 0,
        "INPUT_INVALID",
        "Discovery cursor filter changed.",
      );
      ensure(
        cursor!.snapshot === snapshot,
        "CAPABILITY_STALE",
        "Discovery result changed; reload the first page.",
        409,
      );
      start = cursor!.offset;
    }
    const limit = a.limit ?? 20;
    return {
      items: items.slice(start, start + limit),
      total: items.length,
      snapshot,
      nextCursor:
        start + limit < items.length
          ? Buffer.from(
              JSON.stringify({ filter, snapshot, offset: start + limit }),
            ).toString("base64url")
          : null,
    };
  }
  get(entityId: string) {
    const entity = this.repo.get("discovery_entities", entityId);
    ensure(
      entity,
      "NOT_FOUND",
      "Discovery entity missing; rescan the context.",
      404,
    );
    const all = this.entities(entity.contextId);
    const plugin = all.find((e) => e.id === entity.pluginId);
    return {
      ...this.present(entity),
      plugin: plugin ? this.present(plugin) : null,
      relatedSkills: all
        .filter(
          (e) =>
            e.entityKind === "skill" &&
            ((e.pluginId && e.pluginId === entity.pluginId) ||
              e.relations?.some(
                (r: Json) =>
                  r.targetId === entity.id ||
                  (r.kind === "mention" && r.name === entity.name),
              )),
        )
        .map((e) => ({
          ...this.present(e),
          relationKind: e.relations?.some((r: Json) => r.targetId === entity.id)
            ? "dependency"
            : e.relations?.some(
                  (r: Json) => r.kind === "mention" && r.name === entity.name,
                )
              ? "mention"
              : "same_plugin",
        })),
      children:
        entity.entityKind === "plugin"
          ? all
              .filter(
                (e) => e.pluginId === entity.id && e.entityKind !== "mcp_tool",
              )
              .map((e) => this.present(e))
          : [],
    };
  }
  submit(a: Json, owner: string, authorship: "codex" | "manual" = "codex") {
    ensure(
      Buffer.byteLength(JSON.stringify(a)) <= 131072,
      "SCHEMA_LIMIT",
      "Description batch exceeds 128 KiB.",
    );
    const schema = {
      ...inputContract.$defs.host_scan,
      $defs: inputContract.$defs,
    };
    validate(schema, a);
    ensure(
      a.action === "submit_descriptions",
      "INPUT_INVALID",
      "Select the description submission action.",
    );
    ensure(
      authorship !== "manual" || owner === "admin",
      "AUTH_REQUIRED",
      "Manual descriptions require local administrator access.",
      403,
    );
    return this.repo.command(
      owner,
      "discovery.descriptions",
      a.idempotencyKey,
      { ...a, authorship },
      () => {
        const context = this.repo.get("host_contexts", a.contextId),
          job = context?.catalogScanId
            ? this.repo.get("discovery_jobs", context.catalogScanId)
            : null;
        ensure(
          context && job,
          "NOT_FOUND",
          "Complete a scan before submitting descriptions.",
          404,
        );
        if (!["admin", "execution"].includes(owner)) {
          const client = this.repo.get("clients", owner);
          ensure(
            client &&
              !client.revoked &&
              client.scopes?.includes("workflow:author") &&
              job.owner === owner,
            "AUTH_REQUIRED",
            "This identity does not own the discovered context snapshot.",
            403,
          );
        }
        ensure(
          context.revision === a.expectedContextRevision &&
            job.contextRevision === context.revision,
          "CONTEXT_CHANGED",
          "Context changed; rescan before writing descriptions.",
          409,
        );
        const seen = new Set<string>(),
          saved: Json[] = [];
        for (const entry of a.entries) {
          ensure(
            !seen.has(entry.entityId),
            "INPUT_INVALID",
            "Duplicate entity in description batch.",
          );
          seen.add(entry.entityId);
          const entity = this.repo.get("discovery_entities", entry.entityId),
            prior = this.latestPresentation(entry.entityId);
          ensure(
            entity &&
              entity.contextId === context.id &&
              entity.entityKind === entry.entityKind &&
              !entity.stale &&
              entity.scanId === job.id,
            "CAPABILITY_STALE",
            "Entity is outside the current discovered snapshot.",
            409,
          );
          ensure(
            entity.revision === entry.expectedSourceRevision &&
              entity.sourceFingerprint === entry.sourceFingerprint,
            "CAPABILITY_STALE",
            "Original metadata changed.",
            409,
          );
          ensure(
            (prior?.revision ?? 0) === entry.expectedPresentationRevision,
            "REVISION_CONFLICT",
            "Chinese description changed; reload it before editing.",
            409,
          );
          ensure(
            !prior || prior.authorship !== "manual" || authorship === "manual",
            "PRESENTATION_MANUAL_CONFLICT",
            "Keep the user's manual description.",
            409,
          );
          ensure(
            entry.evidenceRefs.every((ref: string) =>
              entity.evidenceRefs.includes(ref),
            ),
            "INPUT_INVALID",
            "Description evidence must reference the discovered source.",
          );
          const cap = entity.capabilityId
            ? this.repo.get("capabilities", entity.capabilityId)
            : undefined;
          const pointers = new Set<string>();
          for (const parameter of entry.parameterDescriptions ?? []) {
            ensure(
              !pointers.has(parameter.pointer),
              "INPUT_INVALID",
              "Duplicate parameter description pointer.",
            );
            pointers.add(parameter.pointer);
            let target: Json = cap;
            for (const segment of parameter.pointer
              .slice(1)
              .split("/")
              .map((s: string) => s.replace(/~1/g, "/").replace(/~0/g, "~"))) {
              ensure(
                target &&
                  typeof target === "object" &&
                  Object.hasOwn(target, segment),
                "INPUT_INVALID",
                "Parameter pointer is absent from the original schema.",
              );
              target = target[segment];
            }
            ensure(
              target && typeof target === "object",
              "INPUT_INVALID",
              "Parameter descriptions must target a schema object.",
            );
          }
          const id =
            "zh_" +
            hash([
              context.id,
              entity.id,
              entity.sourceFingerprint,
              "zh-CN",
            ]).slice(0, 32);
          const value = {
            ...(prior?.sourceFingerprint === entity.sourceFingerprint
              ? Object.fromEntries(
                  [
                    "description",
                    "inputSummary",
                    "outputSummary",
                    "useCases",
                    "parameterDescriptions",
                  ]
                    .filter((key) => Object.hasOwn(prior, key))
                    .map((key) => [key, prior[key]]),
                )
              : {}),
            ...entry,
            id,
            entityId: entity.id,
            contextId: context.id,
            revision: (prior?.revision ?? 0) + 1,
            authorship,
            owner,
            updatedAt: now(),
          };
          this.repo.put("discovery_presentations", id, value);
          saved.push({
            entityId: entity.id,
            presentationRevision: value.revision,
          });
        }
        this.repo.changed("discovery.descriptions.changed", {
          contextId: context.id,
          entries: saved,
        });
        return { status: "descriptions_saved", saved, contextId: context.id };
      },
    );
  }
}
