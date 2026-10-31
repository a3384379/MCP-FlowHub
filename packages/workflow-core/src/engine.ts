import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  projectRoot,
  type ToolName,
  type Arguments,
} from "../../contracts/src/index.js";
import {
  ensure,
  HubError,
  id,
  now,
  hash,
  clone,
  validate,
  mappings,
  resolveValue,
  condition,
  set,
  get,
  REPORT_HEADINGS,
  type Json,
  workflowSchema,
  type Workflow,
  type Node,
} from "../../contracts/src/domain.js";
import type { Repository } from "../../persistence/src/repository.js";
import type { Vault } from "../../security/src/index.js";
import type { Connectors } from "../../mcp-connectors/src/registry.js";
import { validateWorkflow } from "./validate.js";
import { queryScopes } from "./query-scope.js";
import { schemaAt } from "./mapping-schema.js";
import { MCP_RAW_RESULT } from "../../mcp-connectors/src/results.js";
import { validateReportEvidence } from "./report-verification.js";
const terminal = new Set([
  "SUCCEEDED",
  "FAILED",
  "REJECTED",
  "CANCELLED",
  "OUTCOME_UNKNOWN",
]);
export class Engine {
  private busy = new Set<string>();
  private pending = new Set<string>();
  private stopped = false;
  private inFlight = new Map<string, Promise<void>>();
  private databaseOwners = new Map<string, string>();
  private databaseWaiters = new Map<string, string[]>();
  constructor(
    public repo: Repository,
    public vault: Vault,
    public connectors: Connectors,
  ) {}
  async seed() {
    if (this.repo.get("settings", "seeded")) return;
    const existingConnection = this.repo.get("connections", "synthetic");
    ensure(
      !existingConnection || existingConnection.synthetic === true,
      "SEED_CONFLICT",
      "The built-in synthetic connection ID is already in use.",
    );
    const conn = await this.connectors.discover(
      existingConnection ?? {
        id: "synthetic",
        name: "FlowHub 合成 MCP",
        transport: "stdio",
        synthetic: true,
        protocolEra: "modern",
        revision: 1,
        disabled: false,
        tools: [],
      },
    );
    const fixture = JSON.parse(
      readFileSync(
        resolve(projectRoot, "examples/bindings.example.json"),
        "utf8",
      ),
    );
    // No SQLite transaction is held across external discovery. All seed records
    // and the completion marker commit together; legacy partial seeds resume
    // without replacing existing bindings, drafts or immutable versions.
    this.repo.tx(() => {
      if (this.repo.get("settings", "seeded")) return;
      this.repo.put("connections", conn.id, conn, existingConnection?.revision);
      for (const original of fixture.bindings) {
        const binding = {
          id: original.bindingRef,
          name: original.displayName,
          connectionId: conn.id,
          connectionRevision: conn.revision,
          environment: original.environment,
          allowedTools: original.allowedTools,
          lockedArguments: original.lockedArguments,
          allowedQueryTemplates: original.allowedQueryTemplates,
          simulationOnly: true,
          validationStatus: "MOCK_VERIFIED",
          revision: 1,
          maxRows: 100,
          timeoutSeconds: 30,
          verification: {
            synthetic: true,
            at: now(),
            scope: "Built-in synthetic protocol server only",
          },
        };
        const existing = this.repo.get("bindings", original.bindingRef);
        if (existing) {
          ensure(
            [
              "connectionId",
              "environment",
              "allowedTools",
              "lockedArguments",
              "allowedQueryTemplates",
              "simulationOnly",
            ].every(
              (key) => hash(existing[key]) === hash((binding as Json)[key]),
            ) && !existing.revoked &&
              ["MOCK_VERIFIED", "UNVERIFIED"].includes(existing.validationStatus),
            "SEED_CONFLICT",
            "An existing record conflicts with a built-in synthetic binding.",
          );
          if (existing.validationStatus === "UNVERIFIED") {
            ensure(conn.synthetic === true && conn.catalogSafetyVersion === 1 &&
              existing.verification === null && existing.connectionRevision < conn.revision,
              "SEED_CONFLICT", "An unverified synthetic binding requires an isolated legacy catalog.");
            // The connector quarantined an old catalog before seed recovery.
            // A freshly screened built-in Mock can re-establish only this exact
            // fixture scope. Keep user limits/names and immutable versions.
            this.repo.put("bindings", existing.id, {
              ...existing,
              connectionRevision: conn.revision,
              validationStatus: "MOCK_VERIFIED",
              verification: binding.verification,
              revision: existing.revision + 1,
            }, existing.revision);
          }
        } else this.repo.insert("bindings", original.bindingRef, binding);
      }
      for (const environment of ["production", "staging"]) {
        const w: Workflow = JSON.parse(
          readFileSync(
            resolve(projectRoot, "examples/incident-" + environment + ".json"),
            "utf8",
          ),
        );
        w.description =
          "纯合成演示：固定环境日志 → Agent 分析 → 只读核对 → 报告。不会连接企业系统。";
        w.tags.push("排查", "日志", "报告");
        for (const n of w.nodes)
          if (n.type === "mcp_tool")
            n.config.toolSchemaHash = conn.tools.find(
              (t: Json) => t.name === n.config.toolName,
            ).schemaHash;
        const existing = this.repo.get("workflows", w.workflowId),
          version = this.repo.get("versions", w.workflowId + "@" + w.version);
        // An interrupted old seed may already contain an immutable legacy
        // workflow. Preserve it for explicit copy migration instead of replacing it.
        if (existing?.draft?.nodes?.some((node: Node) => node.type === "approval") ||
          version?.snapshot?.workflow?.nodes?.some((node: Node) => node.type === "approval")) continue;
        ensure(
          !version || hash(version.snapshot.workflow) === hash(w),
          "SEED_CONFLICT",
          "An existing immutable version conflicts with a built-in workflow.",
        );
        if (!existing) this.saveDraft(w, undefined, {});
        if (!version) {
          ensure(
            !existing || hash(existing.draft) === hash(w),
            "SEED_CONFLICT",
            "An existing draft conflicts with an incomplete built-in workflow.",
          );
          this.publish(w.workflowId);
        } else if (existing && !existing.defaultVersion) {
          this.repo.put(
            "workflows",
            w.workflowId,
            {
              ...existing,
              defaultVersion: version.version,
              revision: existing.revision + 1,
            },
            existing.revision,
          );
        }
      }
      this.repo.put("settings", "seeded", { version: 1, at: now() });
    });
  }
  recover() {
    for (const run of this.repo.all("runs")) {
      if (terminal.has(run.state)) continue;
      if (run.state === "WAITING_APPROVAL" || run.snapshot?.workflow?.nodes?.some((node: Node) => node.type === "approval")) {
        // Never resume an old snapshot under changed execution semantics.
        this.repo.tx(() => {
          if (run.dispatch) {
            const attempt = this.repo.get("attempts", run.dispatch);
            if (attempt?.state === "DISPATCHED") this.repo.put("attempts", attempt.id,
              { ...attempt, state: "OUTCOME_UNKNOWN", errorCode: "LEGACY_WORKFLOW_RETIRED", finishedAt: now() });
          }
          run.state = run.dispatch ? "OUTCOME_UNKNOWN" : "CANCELLED";
          run.steps[run.current] = run.state;
          run.errorCode = "LEGACY_WORKFLOW_RETIRED";
          delete run.checkpoint;
          this.save(run, "LEGACY_WORKFLOW_RETIRED", run.current);
        });
        continue;
      }
      if (run.dispatch) {
        this.repo.tx(() => {
          const attempt = this.repo.get("attempts", run.dispatch);
          if (attempt?.runId === run.id && attempt.nodeId === run.current && attempt.state === "DISPATCHED")
            this.repo.put("attempts", attempt.id, {
              ...attempt, state: "OUTCOME_UNKNOWN", errorCode: "OUTCOME_UNKNOWN", finishedAt: now(),
            });
          run.state = "OUTCOME_UNKNOWN";
          run.errorCode = "OUTCOME_UNKNOWN";
          run.steps[run.current] = "OUTCOME_UNKNOWN";
          run.revision++;
          this.repo.put("runs", run.id, run);
          this.repo.event(run.id, "OUTCOME_UNKNOWN", {
            reason: "Interrupted after dispatch; no exactly-once assumption.",
          });
        });
      } else if (run.state === "RUNNING" || run.state === "QUEUED")
        this.schedule(run.id);
    }
  }
  saveDraft(w: Workflow, expected: number | undefined, layout: Json) {
    validate(workflowSchema, w);
    const old = this.repo.get("workflows", w.workflowId);
    ensure(
      old ? expected === old.revision : expected === undefined,
      "REVISION_CONFLICT",
      "Draft changed. Reload before saving.",
      409,
    );
    const next = {
      id: w.workflowId,
      name: w.name,
      description: w.description,
      environment: w.environment,
      tags: w.tags,
      draft: clone(w),
      layout,
      revision: (old?.revision ?? 0) + 1,
      defaultVersion: old?.defaultVersion ?? null,
      enabled: old?.enabled ?? true,
      createdAt: old?.createdAt ?? now(),
      updatedAt: now(),
    };
    this.repo.put("workflows", w.workflowId, next, old?.revision);
    return next;
  }
  validateDraft(w: Workflow) {
    return validateWorkflow(
      w,
      this.repo.all("bindings"),
      this.repo.all("connections"),
    );
  }
  publish(
    workflowId: string,
    expectedRevision?: number,
    changeNote = "",
    expectedBindingRevisions?: Record<string, number>,
  ) {
    return this.repo.tx(() => {
      const wf = this.repo.get("workflows", workflowId);
      ensure(wf, "NOT_FOUND", "Workflow missing.", 404);
      ensure(expectedRevision === undefined || wf.revision === expectedRevision,
        "REVISION_CONFLICT", "Draft changed before publication.", 409);
      if (expectedBindingRevisions !== undefined) {
        const bindingIds = [
          ...new Set(Object.values(wf.draft.bindings).map(String)),
        ];
        ensure(
          expectedBindingRevisions &&
            typeof expectedBindingRevisions === "object" &&
            !Array.isArray(expectedBindingRevisions) &&
            Object.keys(expectedBindingRevisions).length === bindingIds.length &&
            bindingIds.every(
              (bindingId) =>
                Object.hasOwn(expectedBindingRevisions, bindingId) &&
                expectedBindingRevisions[bindingId] ===
                  this.repo.get("bindings", bindingId)?.revision,
            ),
          "REVISION_CONFLICT",
          "Bindings changed before publication; review the candidate again.",
          409,
        );
      }
      this.validateDraft(wf.draft);
      const bindingSnapshot = Object.values(wf.draft.bindings).map((ref) =>
        clone(this.repo.get("bindings", String(ref))),
      );
      const snapshot = {
        workflow: clone(wf.draft),
        bindings: bindingSnapshot,
        ...(wf.draft.schemaVersion === "flowhub.workflow/v2" ? { capabilities: wf.draft.nodes.flatMap((n: Node) => {
          const ref=n.config.capabilityRef;
          return ref ? [clone(this.repo.get("capability_revisions",ref.capabilityId+"@"+ref.revision))] : [];
        }) } : {}),
        policyVersion: 1,
        reportContract: REPORT_HEADINGS,
      };
      const version = {
        id: workflowId + "@" + wf.draft.version,
        workflowId,
        version: wf.draft.version,
        snapshot,
        contentHash: "sha256:" + hash(snapshot),
        publishedAt: now(),
        publishedBy: "admin",
        changeNote: changeNote,
      };
      this.repo.insert("versions", version.id, version);
      this.repo.put(
        "workflows",
        workflowId,
        { ...wf, defaultVersion: version.version, revision: wf.revision + 1 },
        wf.revision,
      );
      this.repo.audit("admin", "publish", version.id);
      return version;
    });
  }
  private version(workflowId: string, version?: string) {
    const wf = this.repo.get("workflows", workflowId);
    ensure(
      wf && wf.enabled,
      "WORKFLOW_NOT_AVAILABLE",
      "Workflow unavailable.",
      404,
    );
    const v = this.repo.get(
      "versions",
      workflowId + "@" + (version ?? wf.defaultVersion),
    );
    ensure(v, "VERSION_MISMATCH", "Exact published version unavailable.", 409);
    ensure(!v.snapshot.workflow.nodes.some((node: Node) => node.type === "approval"),
      "LEGACY_WORKFLOW_RETIRED", "Create and publish a migrated workflow copy before starting this legacy version.", 409);
    return v;
  }
  private allowed(workflowId: string, owner: string) {
    if (owner === "execution") return true;
    const c = this.repo.get("clients", owner);
    return !!c && !c.revoked && c.workflowAllowlist.includes(workflowId);
  }
  search(args: Arguments, owner = "execution") {
    const query = String(args.query).toLocaleLowerCase(),
      filterHash = hash({
        query,
        environment: args.environment ?? null,
        tags: args.tags ?? [],
        owner,
      });
    const keywords = [
      ...new Set([
        ...(query.match(/[a-z0-9_-]+/g) ?? []),
        ...[
          "生产",
          "试运行",
          "排查",
          "支付",
          "数据库",
          "日志",
          "报告",
          "订单",
          "异常",
          "核对",
        ].filter((word) => query.includes(word)),
      ]),
    ];
    let offset = 0;
    if (args.cursor) {
      const cursor = this.repo.get("settings", "cursor:" + String(args.cursor));
      ensure(
        cursor &&
          cursor.filterHash === filterHash &&
          cursor.expires > Date.now(),
        "INPUT_INVALID",
        "Cursor expired or belongs to another search.",
      );
      offset = cursor.offset;
    }
    const ranked = this.repo
      .all("workflows")
      .filter((w) => w.enabled && w.defaultVersion && this.allowed(w.id, owner) &&
        !this.repo.get("versions", w.id + "@" + w.defaultVersion)?.snapshot.workflow.nodes.some((node: Node) => node.type === "approval"))
      .map((w) => {
        const v = this.version(w.id),
          flow = v.snapshot.workflow;
        let score = 0;
        const matchedBy = [];
        if (
          flow.workflowId.toLowerCase() === query ||
          flow.name.toLowerCase() === query
        ) {
          score += 100;
          matchedBy.push("exact");
        }
        if (
          [
            flow.workflowId,
            flow.name,
            flow.description,
            ...flow.tags,
            ...flow.nodes.map((node: Node) => node.title),
          ].some((x: string) => x.toLowerCase().includes(query))
        ) {
          score += 10;
          matchedBy.push("keyword");
        }
        const text = [
          flow.workflowId,
          flow.name,
          flow.description,
          ...flow.tags,
          ...flow.nodes.map((node: Node) => node.title),
        ]
          .join(" ")
          .toLowerCase();
        for (const word of keywords)
          if (text.includes(word)) {
            score += word === "生产" || word === "试运行" ? 5 : 1;
            matchedBy.push("keyword:" + word);
          }
        if (args.environment === flow.environment) {
          score += 5;
          matchedBy.push("environment");
        }
        return { flow, v, score, matchedBy };
      })
      .filter(
        (x) =>
          x.score > 0 &&
          (!args.environment || x.flow.environment === args.environment) &&
          (!args.tags ||
            (args.tags as string[]).every((tag) => x.flow.tags.includes(tag))),
      )
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.flow.workflowId.localeCompare(b.flow.workflowId),
      );
    const limit = Number(args.limit ?? 10),
      page = ranked.slice(offset, offset + limit);
    let nextCursor = null;
    if (offset + limit < ranked.length) {
      nextCursor = randomBytes(24).toString("hex");
      this.repo.put("settings", "cursor:" + nextCursor, {
        filterHash,
        offset: offset + limit,
        expires: Date.now() + 300000,
      });
    }
    return {
      needsEnvironmentConfirmation:
        !args.environment &&
        !query.includes("生产") &&
        !query.includes("试运行") &&
        new Set(page.map((item) => item.flow.environment)).size > 1,
      items: page.map(({ flow, v, matchedBy }) => ({
        workflowId: flow.workflowId,
        name: flow.name,
        version: v.version,
        environment: flow.environment,
        mode: flow.mode,
        tags: flow.tags,
        requires: flow.inputSchema.required,
        matchedBy,
        demoOnly: v.snapshot.bindings.every((b: Json) => b.simulationOnly),
        validationStatus: v.snapshot.bindings.every(
          (b: Json) => b.simulationOnly,
        )
          ? "MOCK_VERIFIED"
          : "BINDING_VERIFIED",
      })),
      nextCursor,
    };
  }
  private bindingsReady(snapshot: Json) {
    for (const b of snapshot.bindings) {
      const current = this.repo.get("bindings", b.id),
        c = this.repo.get("connections", b.connectionId);
      ensure(
        current &&
          current.validationStatus !== "REVOKED" &&
          current.revision === b.revision &&
          c &&
          !c.disabled &&
          c.revision === b.connectionRevision,
        "BINDING_REVOKED",
        "Binding or connection changed/revoked.",
      );
      ensure(
        c.verifiedSdk && Date.parse(c.verifiedAt) + 86400000 > Date.now(),
        "PROTOCOL_REVERIFY_REQUIRED",
        "Revalidate downstream connection.",
      );
      if (!b.simulationOnly)
        ensure(
          !this.vault.locked,
          "CREDENTIAL_LOCKED",
          "Unlock vault before real calls.",
          423,
        );
    }
  }
  start(args: Arguments, owner = "execution", retryOfRunId?: string) {
    const response = this.repo.command(
      owner,
      "start",
      String(args.idempotencyKey),
      args,
      () => {
        ensure(
          this.allowed(String(args.workflowId), owner),
          "WORKFLOW_NOT_AVAILABLE",
          "Workflow unavailable.",
          404,
        );
        const v = this.version(String(args.workflowId), String(args.version)),
          w: Workflow = v.snapshot.workflow;
        this.validateDraft(w);
        this.bindingsReady(v.snapshot);
        ensure(
          args.mode === w.mode,
          "MODE_NOT_SUPPORTED",
          "Requested mode differs from published version.",
        );
        validate(w.inputSchema, args.inputs);
        const inputs = args.inputs as Json;
        const dateTimeRange = w.inputSchema.properties?.from?.type === "string" &&
          w.inputSchema.properties.from.format === "date-time" &&
          w.inputSchema.properties?.to?.type === "string" &&
          w.inputSchema.properties.to.format === "date-time";
        if (dateTimeRange && (Object.hasOwn(inputs, "from") || Object.hasOwn(inputs, "to")))
          ensure(
            Number.isFinite(Date.parse(inputs.from)) &&
              Number.isFinite(Date.parse(inputs.to)) &&
              Date.parse(inputs.to) >= Date.parse(inputs.from) &&
              Date.parse(inputs.to) - Date.parse(inputs.from) <= 86400000,
            "INPUT_INVALID",
            "Time window must be ordered and at most 24 hours.",
          );
        ensure(
          !w.nodes.some((n) => n.type === "agent_task") || !this.vault.locked,
          "CREDENTIAL_LOCKED",
          "Unlock vault to deliver encrypted checkpoints.",
          423,
        );
        ensure(
          this.repo.all("runs").filter((r) => !terminal.has(r.state)).length <
            100,
          "BUDGET_EXCEEDED",
          "Too many active runs.",
        );
        const run = {
          id: id("run"),
          owner,
          workflowId: w.workflowId,
          version: w.version,
          environment: w.environment,
          snapshot: clone(v.snapshot),
          snapshotHash: v.contentHash,
          inputs: clone(inputs),
          outputs: {},
          steps: Object.fromEntries(w.nodes.map((n) => [n.id, "PENDING"])),
          state: "QUEUED",
          revision: 1,
          current: w.nodes.find((n) => n.type === "input")!.id,
          createdAt: now(),
          updatedAt: now(),
          activeMs: 0,
          toolCalls: 0,
          nodeExecutions: 0,
          agentCheckpoints: 0,
          totalBytes: 0,
          retryOfRunId: retryOfRunId ?? null,
        };
        this.repo.insert("runs", run.id, run);
        this.repo.event(run.id, "RUN_CREATED", {
          workflowId: w.workflowId,
          environment: w.environment,
        });
        return {
          runId: run.id,
          workflowId: w.workflowId,
          version: w.version,
          state: run.state,
          revision: run.revision,
          snapshotHash: run.snapshotHash,
          pollAfterMs: 500,
        };
      },
    );
    this.schedule(response.runId);
    return response;
  }
  private owned(runId: string, owner: string) {
    const r = this.repo.get("runs", runId);
    ensure(
      r && r.owner === owner,
      "WORKFLOW_NOT_AVAILABLE",
      "Run unavailable.",
      404,
    );
    return r;
  }
  status(runId: string, owner = "execution", after = 0, limit = 50) {
    const r = this.owned(runId, owner);
    if (
      r.checkpoint &&
      r.checkpoint.expiresAt < Date.now() &&
      !terminal.has(r.state)
    ) {
      r.state = "FAILED";
      r.errorCode = "CHECKPOINT_EXPIRED";
      delete r.checkpoint;
      r.revision++;
      this.repo.put("runs", r.id, r);
      this.repo.event(r.id, "CHECKPOINT_EXPIRED");
    }
    const artifacts = this.repo
      .all("artifacts")
      .filter((a) => a.runId === r.id)
      .map(({ content, ...a }) => a);
    let checkpoint;
    if (r.checkpoint) {
      const { delivery, tokenHash, ...info } = r.checkpoint;
      checkpoint = {
        ...info,
        ...(!this.vault.locked
          ? { token: this.vault.decrypt(delivery, r.id + ":" + info.id) }
          : {}),
        ...(Object.keys(r.operationalOutputs ?? {}).length ? {
          inputs: this.vault.locked ? undefined : mappings(
            r.snapshot.workflow.nodes.find((node: Node) => node.id === info.nodeId)?.config.inputMappings,
            r.inputs, this.operationalOutputs(r)),
        } : {}),
        availableEvidence: artifacts,
        nodeOutcomes: r.steps,
      };
    }
    return {
      runId: r.id,
      workflowId: r.workflowId,
      version: r.version,
      environment: r.environment,
      snapshotHash: r.snapshotHash,
      state: r.state,
      revision: r.revision,
      currentNode: r.current,
      steps: r.steps,
      checkpoint,
      events: this.repo.events(r.id, after, limit),
      artifacts,
      waitingReason: r.errorCode ?? null,
      vaultLocked: this.vault.locked,
      createdAt: r.createdAt,
      inputs: r.inputs,
      outputs: this.vault.locked && Object.keys(r.operationalOutputs ?? {}).length ? undefined : this.operationalOutputs(r),
      outputAvailability: this.vault.locked && Object.keys(r.operationalOutputs ?? {}).length ? "VAULT_LOCKED" : "AVAILABLE",
      nodeDetails: (r.snapshot?.workflow?.nodes ?? []).map((node: Node) => {
        const attempts = this.repo.all("attempts").filter(a => a.runId === r.id && a.nodeId === node.id);
        let arguments_;
        if (!r.resultsExpiredAt && node.type === "mcp_tool" && r.steps[node.id] !== "PENDING" && r.steps[node.id] !== "SKIPPED") {
          try { arguments_ = this.resolveArguments(r, node); } catch { /* Historical raw data may need vault unlock. */ }
        }
        return { nodeId: node.id, title: node.title, toolName: node.config.toolName, arguments: arguments_,
          durationMs: attempts.reduce((sum, a) => sum + (a.finishedAt ? Math.max(0, Date.parse(a.finishedAt) - Date.parse(a.createdAt)) : 0), 0),
          errorCode: attempts.at(-1)?.errorCode };
      }),
      retryOfRunId: r.retryOfRunId,
    };
  }
  advance(args: Arguments, owner = "execution") {
    const response = this.repo.command(
      owner,
      "advance",
      String(args.idempotencyKey),
      args,
      () => {
        const r = this.owned(String(args.runId), owner),
          cp = r.checkpoint;
        ensure(
          r.state === "WAITING_AGENT" && cp,
          "REVISION_CONFLICT",
          "No active Agent checkpoint.",
          409,
        );
        ensure(
          r.revision === args.expectedRevision && cp.id === args.checkpointId,
          "REVISION_CONFLICT",
          "Stale checkpoint/revision.",
          409,
        );
        ensure(
          cp.expiresAt > Date.now() &&
            cp.tokenHash === hash(String(args.checkpointToken)),
          "CHECKPOINT_EXPIRED",
          "Checkpoint expired or invalid.",
          409,
        );
        ensure(
          !this.vault.locked,
          "CREDENTIAL_LOCKED",
          "Unlock vault to advance.",
          423,
        );
        this.bindingsReady(r.snapshot);
        const n: Node = r.snapshot.workflow.nodes.find(
            (n: Node) => n.id === r.current,
          ),
          submission = args.submission as Json;
        let payload: Json;
        if (submission.type === "host_skill_unavailable") {
          ensure(
            n.config.kind === "host_skill" &&
              n.config.fallbackTemplateRef === "incident-markdown/v1" &&
              submission.useDeclaredFallback === true,
            "HOST_SKILL_UNAVAILABLE",
            "No explicitly selected declared fallback.",
          );
          payload = {
            reportMarkdown: this.renderReport(r, n),
            evidenceRefs: this.evidenceIds(r.id),
          };
        } else {
          payload = this.validateQueryScope(r, n, submission.payload);
          validate(n.config.outputSchema, payload);
        }
        this.validateEvidence(r, payload);
        this.storeOutput(r, n.id, payload);
        if (n.config.kind === "host_skill")
          this.storeReport(
            r,
            n,
            payload,
            submission.type === "agent_result" ? "host_reported" : "not_used",
          );
        r.steps[n.id] = "SUCCEEDED";
        delete r.checkpoint;
        r.current = this.next(r, n.id);
        r.state = "RUNNING";
        r.revision++;
        this.repo.put("runs", r.id, r);
        this.repo.event(r.id, "AGENT_RESULT_ACCEPTED", { nodeId: n.id });
        return { runId: r.id, acceptedRevision: r.revision };
      },
    );
    this.schedule(response.runId);
    return response;
  }
  cancel(args: Arguments, owner = "execution") {
    const response = this.repo.command(
      owner,
      "cancel",
      String(args.idempotencyKey),
      args,
      () => {
        const r = this.owned(String(args.runId), owner);
        ensure(
          r.revision === args.expectedRevision,
          "REVISION_CONFLICT",
          "Stale run revision.",
          409,
        );
        if (!terminal.has(r.state)) {
          r.state = r.dispatch ? "CANCEL_REQUESTED" : "CANCELLED";
          delete r.checkpoint;
          r.revision++;
          this.repo.put("runs", r.id, r);
          this.repo.event(r.id, "CANCEL_REQUESTED", {
            reason: String(args.reason),
          });
        }
        return {
          runId: r.id,
          state: r.state,
          revision: r.revision,
          inFlight: !!r.dispatch,
        };
      },
    );
    if (response.state === "CANCELLED")
      this.releaseDatabase(String(args.runId));
    return response;
  }
  resume(runId: string) {
    const r = this.repo.get("runs", runId);
    ensure(
      r && r.state === "BLOCKED",
      "STATE_INVALID",
      "Only blocked runs can resume.",
    );
    this.bindingsReady(r.snapshot);
    ensure(!this.vault.locked, "CREDENTIAL_LOCKED", "Unlock vault.", 423);
    r.state = "RUNNING";
    delete r.errorCode;
    r.revision++;
    this.repo.put("runs", r.id, r);
    this.schedule(r.id);
    return { runId: r.id };
  }
  review(runId: string, request: Json) {
    const r = this.repo.get("runs", runId);
    ensure(
      r &&
        ["OUTCOME_UNKNOWN", "FAILED", "REJECTED", "CANCELLED"].includes(
          r.state,
        ),
      "STATE_INVALID",
      "Review requires a terminal unsuccessful run.",
    );
    ensure(
      typeof request.reason === "string" && request.reason.length > 0,
      "INPUT_INVALID",
      "Review reason required.",
    );
    this.repo.audit("admin", "review", r.id);
    return this.start(
      {
        workflowId: r.workflowId,
        version: r.version,
        mode: r.snapshot.workflow.mode,
        inputs: r.inputs,
        idempotencyKey: request.idempotencyKey,
      },
      r.owner,
      r.id,
    );
  }
  readArtifact(args: Arguments, owner = "execution") {
    this.owned(String(args.runId), owner);
    const a = this.repo.get("artifacts", String(args.artifactId));
    ensure(
      a && a.runId === args.runId && a.expiresAt > Date.now(),
      "ARTIFACT_NOT_AVAILABLE",
      "Artifact unavailable.",
      404,
    );
    const bytes = Buffer.from(a.content, "utf8"),
      offset = Number(args.offset ?? 0),
      max = Number(args.maxBytes ?? 65536);
    ensure(
      offset <= bytes.length &&
        (offset === bytes.length || (bytes[offset]! & 192) !== 128),
      "INPUT_INVALID",
      "Offset must be a UTF-8 boundary.",
    );
    let end = Math.min(bytes.length, offset + max);
    while (end < bytes.length && (bytes[end]! & 192) === 128) end--;
    ensure(
      end > offset || offset === bytes.length,
      "INPUT_INVALID",
      "Chunk too small for next UTF-8 character.",
    );
    return {
      artifactId: a.id,
      runId: a.runId,
      mimeType: a.mimeType,
      sha256: a.sha256,
      byteLength: bytes.length,
      content: bytes.subarray(offset, end).toString("utf8"),
      offset,
      nextOffset: end,
      eof: end === bytes.length,
      verification: a.verification,
    };
  }
  private evidenceIds(runId: string) {
    return this.repo
      .all("artifacts")
      .filter((a) => a.runId === runId && a.expiresAt > Date.now())
      .map((a) => a.id);
  }
  private validateEvidence(r: Json, payload: Json) {
    const allowed = new Set(this.evidenceIds(r.id));
    const check = (x: Json) => {
      if (!x || typeof x !== "object") return;
      if (x.evidenceRefs)
        for (const ref of x.evidenceRefs)
          ensure(
            allowed.has(ref),
            "ARTIFACT_INVALID",
            "Evidence must belong to this run.",
          );
      if (x.kind === "confirmed")
        ensure(
          x.evidenceRefs?.length > 0,
          "ARTIFACT_INVALID",
          "Confirmed finding requires evidence.",
        );
      for (const child of Object.values(x))
        if (typeof child === "object")
          if (Array.isArray(child)) child.forEach(check);
          else check(child);
    };
    check(payload);
  }
  private storeArtifact(
    r: Json,
    nodeId: string,
    content: string,
    mimeType: string,
    verification: Json = {},
  ) {
    const bytes = Buffer.byteLength(content);
    ensure(
      bytes <= Math.min(r.snapshot.workflow.budgets.maxOutputBytes, 262144) &&
        r.totalBytes + bytes <= 10485760,
      "BUDGET_EXCEEDED",
      "Artifact exceeds byte budget.",
    );
    const a = {
      id: id("art"),
      runId: r.id,
      nodeId,
      content,
      mimeType,
      sha256: hash(content),
      byteLength: bytes,
      createdAt: now(),
      expiresAt: Date.now() + 7 * 86400000,
      verification,
    };
    this.repo.insert("artifacts", a.id, a);
    r.totalBytes += bytes;
    r.artifactBytes = (r.artifactBytes ?? r.totalBytes - bytes) + bytes;
    return a;
  }
  private storeOutput(r: Json, nodeId: string, value: Json) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    ensure(
      bytes <= Math.min(r.snapshot.workflow.budgets.maxOutputBytes, 262144),
      "BUDGET_EXCEEDED",
      "Node output exceeds byte budget.",
    );
    const output = clone(value);
    const protectedOutputs = { ...(r.operationalOutputs ?? {}) };
    delete protectedOutputs[nodeId];
    const outputBytes =
      Object.entries(r.outputs)
        .filter(([key]) => key !== nodeId)
        .reduce(
          (sum, [, output]) => sum + Buffer.byteLength(JSON.stringify(output)),
          0,
        ) + Buffer.byteLength(JSON.stringify(output)) +
      (Object.keys(protectedOutputs).length ? Buffer.byteLength(JSON.stringify(protectedOutputs)) : 0);
    // Output JSON and artifact bytes are separate persisted representations.
    // Each is counted once; end-node references do not create another output.
    const artifactBytes = r.artifactBytes ?? r.totalBytes;
    ensure(
      outputBytes + artifactBytes <= 10485760,
      "BUDGET_EXCEEDED",
      "Stored run outputs and artifacts exceed byte budget.",
    );
    r.outputs[nodeId] = output;
    if (Object.keys(protectedOutputs).length) r.operationalOutputs = protectedOutputs;
    else delete r.operationalOutputs;
    r.outputBytes = outputBytes;
    r.artifactBytes = artifactBytes;
    r.totalBytes = outputBytes + artifactBytes;
  }
  private operationalOutputs(r: Json) {
    const outputs = { ...r.outputs };
    for (const [nodeId, envelope] of Object.entries(r.operationalOutputs ?? {}))
      outputs[nodeId] = JSON.parse(this.vault.decrypt(envelope, r.id + ":output:" + nodeId));
    return outputs;
  }
  private validateQueryScope(r: Json, n: Node, submitted: Json) {
    const payload = clone(submitted);
    for (const scope of queryScopes(r.snapshot.workflow, r.snapshot.bindings).filter((scope) => scope.nodeId === n.id)) {
      const expected = resolveValue(scope.source, r.inputs, {});
      let actual: Json;
      try { actual = get(payload, scope.pointer); }
      catch { continue; } // The output schema reports missing required fields.
      ensure(hash(actual) === hash(expected),
        "SCOPE_OVERRIDE_DENIED", "Agent cannot change a declared query input scope.");
    }
    return payload;
  }
  private storeReport(r: Json, n: Node, payload: Json, skillExecution: string) {
    const text = payload.reportMarkdown;
    ensure(
      typeof text === "string" && text.trim().length > 0,
      "ARTIFACT_INVALID",
      "Actual Markdown bytes required.",
    );
    const ids = this.evidenceIds(r.id);
    ensure(
      (payload.evidenceRefs ?? []).every((ref: string) => text.includes(ref)),
      "ARTIFACT_INVALID",
      "Report evidence references must be present in actual bytes.",
    );
    const inline = text.match(/art_[a-f0-9-]+/g) ?? [];
    ensure(
      inline.every((ref: string) => ids.includes(ref)),
      "ARTIFACT_INVALID",
      "Report references an unknown artifact.",
    );
    const clean = text,
      verification = {
        contentStored: true,
        formatValidated: true,
        evidenceReferencesValidated: true,
        skillExecution,
        factualReview: "not_performed",
      };
    const evidence = this.repo.all("artifacts").filter((artifact) =>
      artifact.runId === r.id && artifact.expiresAt > Date.now());
    validateReportEvidence(text, payload.evidenceRefs ?? [], evidence);
    validateReportEvidence(clean, payload.evidenceRefs ?? [], evidence);
    const markdown = this.storeArtifact(
      r,
      n.id,
      clean,
      "text/markdown",
      verification,
    );
    const escaped = clean
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
    const html =
      '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>FlowHub 排查报告</title><style>body{max-width:960px;margin:40px auto;padding:24px;font:15px/1.9 system-ui;color:#172b46}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}</style><pre>' +
      escaped +
      "</pre></html>";
    this.storeArtifact(r, n.id, html, "text/html", {
      ...verification,
      sourceMarkdownArtifact: markdown.id,
    });
  }
  private renderReport(r: Json, n: Node) {
    const input = mappings(n.config.inputMappings, r.inputs, this.operationalOutputs(r)),
      analysis = input.analysis ?? {},
      evidence = this.repo
        .all("artifacts")
        .filter((a) => a.runId === r.id && a.expiresAt > Date.now()),
      tools: Node[] = r.snapshot.workflow.nodes.filter(
        (node: Node) => node.type === "mcp_tool",
      ),
      databaseNodes = tools.filter((node) => {
        const binding = r.snapshot.bindings.find(
          (b: Json) =>
            b.id === r.snapshot.workflow.bindings[node.config.bindingKey],
        );
        return (
          binding?.allowedQueryTemplates?.length > 0 ||
          node.config.outputSchemaRef ===
            "flowhub://schemas/query-template-result/v1" ||
          Array.isArray(r.outputs[node.id]?.rows)
        );
      }),
      succeededEvidence = (node: Node) =>
        r.steps[node.id] === "SUCCEEDED"
          ? evidence.filter(
              (a) => a.nodeId === node.id && a.mimeType === "application/json",
            )
          : [],
      logEvidence = tools
        .filter(
          (node) =>
            node.config.outputSchemaRef ===
              "flowhub://schemas/log-search-result/v1" ||
            Array.isArray(r.outputs[node.id]?.logs),
        )
        .flatMap(succeededEvidence),
      databaseEvidence = databaseNodes.flatMap(succeededEvidence);
    const sections: Record<string, string> = {
      问题摘要:
        [input.question, analysis.summary].filter(Boolean).join("\n\n") ||
        "确定性运行",
      环境与范围:
        "固定环境：" +
        r.environment +
        "；订单：" +
        (input.orderNo ??
          "未映射；运行范围：" + (r.inputs.orderNo ?? "未提供")) +
        "；范围：" +
        (input.from ?? "未映射") +
        " → " +
        (input.to ?? "未映射") +
        "（含时区）。",
      时间线: this.repo
        .events(r.id, 0, 200)
        .map((e) => "- " + e.createdAt + " " + e.type)
        .join("\n"),
      日志证据:
        logEvidence.map((a) => "- " + a.id + " / " + a.sha256).join("\n") ||
        "未取得日志证据。",
      数据库核对: databaseEvidence.length
        ? "已执行数据库核对；空结果不表示排除问题。\n" +
          databaseEvidence
            .map(
              (a) =>
                "- 节点 " +
                a.nodeId +
                "：SUCCEEDED；证据 " +
                a.id +
                "；返回 " +
                (r.outputs[a.nodeId]?.rows?.length ?? "未知") +
                " 行。",
            )
            .join("\n")
        : "数据库未查询：没有成功执行的数据库核对证据；不能认定正常。" +
          databaseNodes
            .map((node) => "\n- 节点 " + node.id + "：" + r.steps[node.id])
            .join(""),
      判断与置信依据: JSON.stringify(
        analysis.findings ?? [
          {
            kind: "unknown",
            statement: "证据不足，未形成判断。",
            evidenceRefs: [],
          },
        ],
        null,
        2,
      ),
      尚未验证的假设:
        "未经过人工事实复核；截断或未覆盖范围仍有证据缺口。" +
        (r.snapshot.bindings.some((b: Json) => b.simulationOnly)
          ? "合成演示不代表实际生产系统结论。"
          : "真实系统结论仍需独立核验。"),
      建议下一步: (
        analysis.nextActions ?? ["人工核验结论与缺失证据，扩大范围前重新授权。"]
      ).join("\n"),
      证据索引:
        evidence
          .map(
            (a) =>
              "- " + a.id + " / " + a.sha256 + " / " + a.byteLength + " bytes",
          )
          .join("\n") || "无证据。",
      运行版本与限制:
        r.workflowId +
        "@" +
        r.version +
        "\n" +
        r.snapshotHash +
        "\nrunId: " +
        r.id +
        "\n未使用宿主 Skill（显式声明模板）；人工事实审查未执行。",
    };
    return (
      "# 问题排查报告\n\n" +
      REPORT_HEADINGS.map((h) => "## " + h + "\n\n" + sections[h]).join("\n\n")
    );
  }
  private resolveArguments(r: Json, n: Node) {
    const b = r.snapshot.bindings.find(
      (b: Json) => b.id === r.snapshot.workflow.bindings[n.config.bindingKey],
    );
    const schema = this.repo.get("connections", b.connectionId)?.tools?.find((tool: Json) => tool.name === n.config.toolName)?.inputSchema;
    const arrayAt = (pointer: string) => {
      const type = schemaAt(schema, pointer).type;
      return Array.isArray(type) ? type.includes("array") : type === "array";
    };
    const args = mappings(n.config.argumentsMappings, r.inputs, this.operationalOutputs(r), arrayAt);
    for (const [key, v] of Object.entries(b.lockedArguments)) set(args, key, v, arrayAt);
    if (b.allowedQueryTemplates.length)
      ensure(
        b.allowedQueryTemplates.includes(args.templateId),
        "TEMPLATE_LOCKED",
        "Template changed.",
      );
    return args;
  }
  private next(r: Json, nodeId: string, port = "next") {
    return r.snapshot.workflow.edges.find(
      (e: Json) => e.source === nodeId && e.port === port,
    )?.target;
  }
  private save(r: Json, type: string, nodeId?: string) {
    r.revision++;
    r.updatedAt = now();
    this.repo.put("runs", r.id, r);
    this.repo.event(r.id, type, nodeId ? { nodeId } : {});
  }
  private retryLimit(r: Json, code: string, details: Json) {
    if (r.state !== "RUNNING" || !["TOOL_FAILED", "TOOL_TIMEOUT"].includes(code)) return 0;
    if (code === "TOOL_TIMEOUT" && details?.dispatched !== false && details?.outcomeKnown !== true) return 0;
    const node = r.snapshot.workflow.nodes.find((item: Node) => item.id === r.current);
    if (node?.type !== "mcp_tool") return 0;
    const binding = r.snapshot.bindings.find((item: Json) => item.id === r.snapshot.workflow.bindings[node.config.bindingKey]);
    const connection = binding && this.repo.get("connections", binding.connectionId);
    const safeRead = (binding?.simulationOnly && (connection?.synthetic || connection?.syntheticEvidence)) ||
      binding?.verification?.serverEnforcedReadOnly === true;
    return safeRead ? Math.min(2, r.snapshot.workflow.budgets.maxRetries) : 0;
  }
  private acquireDatabase(r: Json, n: Node) {
    if (r.environment !== "production" || n.type !== "mcp_tool") return true;
    const b = r.snapshot.bindings.find(
      (binding: Json) =>
        binding.id === r.snapshot.workflow.bindings[n.config.bindingKey],
    );
    if (!b.allowedQueryTemplates.length) return true;
    const owner = this.databaseOwners.get(b.connectionId);
    if (!owner || owner === r.id) {
      this.databaseOwners.set(b.connectionId, r.id);
      return true;
    }
    const waiters = this.databaseWaiters.get(b.connectionId) ?? [];
    if (!waiters.includes(r.id)) waiters.push(r.id);
    this.databaseWaiters.set(b.connectionId, waiters);
    r.state = "QUEUED";
    r.steps[n.id] = "READY";
    this.save(r, "DATABASE_QUEUED", n.id);
    return false;
  }
  private releaseDatabase(runId: string) {
    for (const [connectionId, owner] of this.databaseOwners) {
      if (owner !== runId) continue;
      this.databaseOwners.delete(connectionId);
      const waiters = this.databaseWaiters.get(connectionId) ?? [];
      let next: string | undefined;
      while ((next = waiters.shift())) {
        const run = this.repo.get("runs", next);
        if (run?.state !== "QUEUED") continue;
        this.databaseOwners.set(connectionId, next);
        this.schedule(next);
        break;
      }
      if (!waiters.length) this.databaseWaiters.delete(connectionId);
    }
  }
  schedule(runId: string) {
    if (this.stopped) return;
    this.pending.add(runId);
    queueMicrotask(() => this.drain());
  }
  private drain() {
    if (this.stopped) return;
    for (const runId of this.pending) {
      if (this.busy.size >= 3) break;
      if (this.busy.has(runId)) continue;
      this.pending.delete(runId);
      this.busy.add(runId);
      const task = this.execute(runId).finally(() => {
        this.busy.delete(runId);
        this.inFlight.delete(runId);
        this.drain();
      });
      this.inFlight.set(runId, task);
    }
  }
  private async execute(runId: string) {
    let r = this.repo.get("runs", runId);
    let activeStarted: number | undefined;
    try {
      while (!this.stopped && r && ["QUEUED", "RUNNING"].includes(r.state)) {
        const w: Workflow = r.snapshot.workflow,
          n = w.nodes.find((n) => n.id === r.current)!;
        ensure(
          this.allowed(r.workflowId, r.owner),
          "CLIENT_REVOKED",
          "Client execution permission revoked.",
        );
        this.bindingsReady(r.snapshot);
        ensure(
          r.nodeExecutions < w.budgets.maxNodeExecutions &&
            r.activeMs < w.budgets.maxRunSeconds * 1000,
          "BUDGET_EXCEEDED",
          "Run active budget exceeded.",
        );
        ensure(n, "GRAPH_INVALID", "No executable next node.");
        if (!this.acquireDatabase(r, n)) return;
        r.state = "RUNNING";
        r.nodeExecutions++;
        if (n.type === "agent_task") {
          ensure(
            !this.vault.locked,
            "CREDENTIAL_LOCKED",
            "Unlock vault to create checkpoint.",
            423,
          );
          ensure(
            ++r.agentCheckpoints <= w.budgets.maxAgentCheckpoints,
            "BUDGET_EXCEEDED",
            "Checkpoint budget exceeded.",
          );
          const token = randomBytes(32).toString("hex"),
            cpId = id("cp");
          r.revision++;
          r.checkpoint = {
            id: cpId,
            nodeId: n.id,
            kind: n.config.kind,
            instruction: n.config.instructions,
            skillRef: n.config.skillRef,
            reportContract:
              n.config.kind === "host_skill" ? REPORT_HEADINGS : undefined,
            requiredOutputSchema: n.config.outputSchema,
            inputs: mappings(n.config.inputMappings, r.inputs, this.operationalOutputs(r)),
            expiresAt: Date.now() + 86400000,
            expectedRevision: r.revision,
            tokenHash: hash(token),
            delivery: this.vault.encrypt(token, r.id + ":" + cpId),
          };
          r.steps[n.id] = "WAITING_AGENT";
          r.state = "WAITING_AGENT";
          this.repo.put("runs", r.id, r);
          this.repo.event(r.id, "WAITING_AGENT", { nodeId: n.id });
          return;
        }
        if (n.type === "condition") {
          const selected = condition(n.config.expression, r.inputs, this.operationalOutputs(r));
          const reachable = (start: string) => {
            const seen = new Set<string>();
            const visit = (nodeId: string) => {
              if (seen.has(nodeId)) return;
              seen.add(nodeId);
              for (const edge of w.edges.filter(
                (edge) => edge.source === nodeId,
              ))
                visit(edge.target);
            };
            visit(start);
            return seen;
          };
          const chosen = reachable(
            this.next(r, n.id, selected ? "true" : "false"),
          );
          for (const rejected of reachable(
            this.next(r, n.id, selected ? "false" : "true"),
          ))
            if (!chosen.has(rejected) && r.steps[rejected] === "PENDING")
              r.steps[rejected] = "SKIPPED";
          this.storeOutput(r, n.id, selected);
          r.steps[n.id] = "SUCCEEDED";
          r.current = this.next(r, n.id, selected ? "true" : "false");
          this.save(r, "CONDITION_SELECTED", n.id);
          continue;
        }
        if (n.type === "mcp_tool") {
          const binding = r.snapshot.bindings.find(
              (b: Json) => b.id === w.bindings[n.config.bindingKey],
            ),
            args = this.resolveArguments(r, n);
          const attempt = {
            id: id("attempt"),
            runId: r.id,
            nodeId: n.id,
            attempt: (r.retryCounts?.[n.id] ?? 0) + 1,
            state: "DISPATCHED",
            inputHash: hash(args),
            createdAt: now(),
          };
          r.steps[n.id] = "RUNNING";
          this.save(r, "TOOL_PREPARING", n.id);
          const started = Date.now();
          activeStarted = started;
          const timeout = Math.min(
            Math.min(w.budgets.maxToolSeconds, binding.timeoutSeconds) * 1000,
            w.budgets.maxRunSeconds * 1000 - r.activeMs,
          );
          let value: Json;
          try {
            value = await this.connectors.call(binding, n, args, timeout, () =>
              this.repo.tx(() => {
                const current = this.repo.get("runs", r.id);
                ensure(
                  !this.stopped,
                  "ENGINE_STOPPED",
                  "Daemon stopped before tool dispatch.",
                );
                ensure(
                  current?.state === "RUNNING" &&
                    current.current === n.id &&
                    !current.dispatch,
                  "STATE_INVALID",
                  "Run stopped or changed before tool dispatch.",
                );
                ensure(
                  this.allowed(current.workflowId, current.owner),
                  "CLIENT_REVOKED",
                  "Client execution permission revoked.",
                );
                this.bindingsReady(current.snapshot);
                ensure(
                  Date.now() - started < timeout &&
                    current.activeMs + Date.now() - started <
                      w.budgets.maxRunSeconds * 1000 &&
                    current.toolCalls < w.budgets.maxToolCalls,
                  "BUDGET_EXCEEDED",
                  "Execution budget expired before tool dispatch.",
                );
                ensure(
                  hash(this.resolveArguments(current, n)) === attempt.inputHash,
                  "ARGUMENTS_CHANGED",
                  "Resolved arguments changed before tool dispatch.",
                );
                current.toolCalls++;
                current.dispatch = attempt.id;
                this.repo.insert("attempts", attempt.id, attempt);
                this.save(current, "TOOL_DISPATCH", n.id);
                r = current;
              }),
            );
          } catch (error) {
            const latest = this.repo.get("runs", r.id);
            r = latest;
            throw error;
          }
          const latest = this.repo.get("runs", r.id);
          r = latest;
          r.activeMs += Date.now() - started;
          activeStarted = undefined;
          // Persist result even when cancellation arrived during an in-flight read.
          ensure(
            !this.stopped,
            "OUTCOME_UNKNOWN",
            "Shutdown interrupted dispatch.",
          );
          ensure(
            !this.vault.locked ||
              (binding.simulationOnly && this.repo.all("secrets").length === 0),
            "CREDENTIAL_LOCKED",
            "Vault locked after dispatch; secure execution cannot continue.",
          );
          ensure(
            (value.rows?.length ?? value.logs?.length ?? 0) <=
              Math.min(w.budgets.maxRows, binding.maxRows),
            "BUDGET_EXCEEDED",
            "Result exceeds row budget.",
          );
          if (n.config.outputSchemaRef) {
            const definition =
              n.config.outputSchemaRef ===
              "flowhub://schemas/log-search-result/v1"
                ? "logSearchResult"
                : n.config.outputSchemaRef ===
                    "flowhub://schemas/query-template-result/v1"
                  ? "queryTemplateResult"
                  : null;
            ensure(
              definition,
              "SCHEMA_INVALID",
              "Unknown output registry schema.",
            );
            validate(
              {
                $ref:
                  "https://flowhub.example.invalid/contracts/" +
                  (binding.simulationOnly
                    ? "mock-results"
                    : "runtime-results") +
                  ".schema.json#/$defs/" +
                  definition,
              },
              value,
            );
          }
          this.repo.tx(() => {
            this.storeOutput(r, n.id, value);
            if(value[MCP_RAW_RESULT])this.storeArtifact(r,n.id,JSON.stringify(value[MCP_RAW_RESULT]),"application/mcp+json",{contentStored:true,synthetic:binding.simulationOnly});
            this.storeArtifact(
              r,
              n.id,
              JSON.stringify(value, null, 2),
              "application/json",
              {
                contentStored: true,
                synthetic: binding.simulationOnly,
                truncated: value.truncated ?? false,
              },
            );
            this.repo.put("attempts", attempt.id, {
              ...attempt,
              state: "SUCCEEDED",
              finishedAt: now(),
            });
            delete r.dispatch;
            r.steps[n.id] = "SUCCEEDED";
            if (r.state === "CANCEL_REQUESTED") r.state = "CANCELLED";
            else r.current = this.next(r, n.id);
            this.save(r, "TOOL_SUCCEEDED", n.id);
          });
          this.releaseDatabase(r.id);
          continue;
        }
        if (n.type === "input") this.storeOutput(r, n.id, r.inputs);
        if (n.type === "report_template") {
          const payload = {
            reportMarkdown: this.renderReport(r, n),
            evidenceRefs: this.evidenceIds(r.id),
          };
          validate(n.config.outputSchema, payload);
          this.repo.tx(() => {
            this.storeOutput(r, n.id, payload);
            this.storeReport(r, n, payload, "not_used");
          });
        }
        r.steps[n.id] = "SUCCEEDED";
        if (n.type === "end") {
          resolveValue(n.config.resultRef, r.inputs, this.operationalOutputs(r));
          for (const node of w.nodes)
            if (r.steps[node.id] === "PENDING") r.steps[node.id] = "SKIPPED";
          r.state = "SUCCEEDED";
          this.save(r, "RUN_SUCCEEDED", n.id);
          return;
        }
        r.current = this.next(r, n.id);
        this.save(r, "NODE_SUCCEEDED", n.id);
      }
    } catch (error) {
      if (!r) return;
      const e =
        error instanceof HubError
          ? error
          : new HubError(
              "OUTCOME_UNKNOWN",
              "Downstream result could not be established.",
            );
      r = this.repo.get("runs", runId);
      if (!r || terminal.has(r.state)) return;
      if (activeStarted !== undefined) r.activeMs += Date.now() - activeStarted;
      if (this.stopped && !r.dispatch) {
        this.repo.put("runs", r.id, r);
        return;
      }
      r.errorCode = e.code;
      if (e.details?.dispatched === false && r.dispatch) {
        const attempt = this.repo.get("attempts", r.dispatch);
        if (attempt)
          this.repo.put("attempts", attempt.id, {
            ...attempt,
            state: "NOT_DISPATCHED",
            finishedAt: now(),
          });
        delete r.dispatch;
      }
      if (r.dispatch && (["TOOL_FAILED", "INPUT_INVALID", "ENVIRONMENT_MISMATCH"].includes(e.code) ||
        (e.code === "TOOL_TIMEOUT" && e.details?.outcomeKnown === true))) {
        const attempt = this.repo.get("attempts", r.dispatch);
        if (attempt) this.repo.put("attempts", attempt.id, {
          ...attempt, state: "FAILED", errorCode: e.code, finishedAt: now(),
        });
        delete r.dispatch;
      }
      const retryCount = r.retryCounts?.[r.current] ?? 0;
      if (!r.dispatch && retryCount < this.retryLimit(r, e.code, e.details)) {
        const backoffMs = 100 * 2 ** retryCount;
        r.retryCounts = { ...(r.retryCounts ?? {}), [r.current]: retryCount + 1 };
        r.steps[r.current] = "PENDING";
        delete r.errorCode;
        this.save(r, "TOOL_FAILED", r.current);
        this.repo.event(r.id, "TOOL_RETRY_SCHEDULED", {
          nodeId: r.current, errorCode: e.code, attempt: retryCount + 2, backoffMs,
        });
        const started = Date.now();
        await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
        const latest = this.repo.get("runs", r.id);
        if (latest?.state === "RUNNING" && latest.current === r.current) {
          latest.activeMs += Date.now() - started;
          this.repo.put("runs", latest.id, latest);
          this.schedule(latest.id);
        }
        return;
      }
      r.state =
        r.state === "CANCEL_REQUESTED" && !r.dispatch
          ? "CANCELLED"
          : r.dispatch && e.code === "CREDENTIAL_LOCKED"
          ? "OUTCOME_UNKNOWN"
          : [
                "CLIENT_REVOKED",
                "CREDENTIAL_LOCKED",
                "AUTH_REQUIRED",
                "BINDING_REVOKED",
                "PROTOCOL_REVERIFY_REQUIRED",
                "TOOL_SCHEMA_DRIFT",
              ].includes(e.code)
            ? "BLOCKED"
            : r.dispatch &&
                ![
                  "TOOL_FAILED",
                  "INPUT_INVALID",
                  "ENVIRONMENT_MISMATCH",
                ].includes(e.code)
              ? "OUTCOME_UNKNOWN"
              : "FAILED";
      if (r.state === "OUTCOME_UNKNOWN" && r.dispatch) {
        const a = this.repo.get("attempts", r.dispatch);
        this.repo.put("attempts", a.id, {
          ...a,
          state: "OUTCOME_UNKNOWN",
          finishedAt: now(),
        });
      }
      r.steps[r.current] = r.state === "BLOCKED" ? "PENDING" : r.state;
      this.save(r, "RUN_" + r.state, r.current);
    } finally {
      this.releaseDatabase(runId);
    }
  }
  async close() {
    this.stopped = true;
    this.pending.clear();
    await Promise.allSettled(this.inFlight.values());
  }
  handle(name: ToolName, args: Arguments, owner = "execution"): Json {
    if (name === "workflow_search") return this.search(args, owner);
    if (name === "workflow_get") {
      ensure(
        this.allowed(String(args.workflowId), owner),
        "WORKFLOW_NOT_AVAILABLE",
        "Workflow unavailable.",
        404,
      );
      const v = this.version(
          String(args.workflowId),
          args.version ? String(args.version) : undefined,
        ),
        w = v.snapshot.workflow;
      return {
        workflowId: w.workflowId,
        name: w.name,
        version: w.version,
        description: w.description,
        environment: w.environment,
        mode: w.mode,
        inputSchema: w.inputSchema,
        nodes: w.nodes.map((n: Node) => ({
          id: n.id,
          title: n.title,
          type: n.type,
        })),
        reportContract: REPORT_HEADINGS,
        snapshotHash: v.contentHash,
        demoOnly: v.snapshot.bindings.every((b: Json) => b.simulationOnly),
      };
    }
    if (name === "workflow_start") return this.start(args, owner);
    if (name === "workflow_advance") return this.advance(args, owner);
    if (name === "workflow_status")
      return this.status(
        String(args.runId),
        owner,
        Number(args.afterEventSeq ?? 0),
        Number(args.limit ?? 50),
      );
    if (name === "workflow_cancel") return this.cancel(args, owner);
    return this.readArtifact(args, owner);
  }
}
