import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { Application } from "../../packages/application/src/index.js";
import { nodeScriptRuntime } from "../helpers/discovery-runtime.js";
import { hash } from "../../packages/contracts/src/domain.js";
import {
  TOOL_NAMES,
  validArguments,
} from "../../packages/contracts/src/index.js";

async function setup(t: any) {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), "flowhub-中文发现-")),
    ),
    home = join(root, "home"),
    cwd = join(root, "project"),
    cli = join(root, "codex.mjs");
  await mkdir(home);
  await mkdir(cwd);
  await writeFile(
    join(home, "config.toml"),
    '[plugins."dev@market"]\nenabled = true\n',
  );
  await writeFile(
    cli,
    `const a=process.argv.slice(2);console.log(a.includes('--version')?'codex-fixture':a.includes('--help')?'--json':'[]');`,
  );
  const plugin = join(home, "plugins/cache/market/dev/1"),
    skill = join(plugin, "skills/review");
  await mkdir(join(plugin, ".codex-plugin"), { recursive: true });
  await mkdir(join(skill, "agents"), { recursive: true });
  await writeFile(
    join(plugin, ".codex-plugin/plugin.json"),
    JSON.stringify({
      name: "dev",
      description: "Developer collaboration tools and instructions.",
      mcpServers: "./.mcp.json",
    }),
  );
  await writeFile(
    join(plugin, ".mcp.json"),
    JSON.stringify({
      mcpServers: { github: { url: "https://synthetic.invalid/mcp" } },
    }),
  );
  const original =
    "---\nname: review\ndescription: >-\n  Read pull requests and\n  report actionable findings.\n---\nUse mcp__github__read to inspect the request.\n";
  await writeFile(join(skill, "SKILL.md"), original);
  await writeFile(
    join(skill, "agents/openai.yaml"),
    "dependencies:\n  tools:\n    - type: mcp\n      value: github\n      description: Read source changes\n",
  );
  await mkdir(join(home, "skills/report"), { recursive: true });
  await writeFile(
    join(home, "skills/report/SKILL.md"),
    "---\nname: report\ndescription: Write reports from provided results.\n---\nDo not execute during discovery.",
  );
  const db = new Database(":memory:"),
    repo = new Repository(db),
    vault = new Vault(repo),
    engine = new Engine(repo, vault, new Connectors(repo, vault));
  const app = new Application(engine, {
    hostDiscoveryRuntime: nodeScriptRuntime,
  });
  let calls = 0;
  engine.connectors.discover = async (connection) => {
    calls++;
    return {
      ...connection,
      tools: [
        {
          name: "read",
          description: "Read a pull request",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
          schemaHash:
            "sha256:" +
            hash({ type: "object", properties: { query: { type: "string" } } }),
        },
      ],
    };
  };
  const context = await app.registry.context({
    codexHome: home,
    cwd,
    codexPath: cli,
  });
  const scan = async (key: string, depth = "catalog", owner = "execution") => {
    const accepted = await app.handle(
      "host_scan",
      { contextId: context.id, depth, idempotencyKey: key },
      owner,
    );
    await app.registry.idle();
    return app.registry.status(accepted.scanId, owner);
  };
  t.after(async () => {
    await app.close();
    await engine.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    app,
    repo,
    context,
    scan,
    home,
    root,
    skill,
    original,
    calls: () => calls,
  };
}
const entry = (entity: any, patch: any = {}) => ({
  entityId: entity.id,
  entityKind: entity.entityKind,
  expectedSourceRevision: entity.revision,
  sourceFingerprint: entity.sourceFingerprint,
  expectedPresentationRevision: entity.presentation.revision,
  locale: "zh-CN",
  displayName: "审查助手",
  summary: "读取改动并整理审查意见。",
  evidenceRefs: [entity.evidenceRefs[0]],
  ...patch,
});
const submission = (f: any, entries: any[], key: string) => ({
  contextId: f.context.id,
  expectedContextRevision: f.context.revision,
  action: "submit_descriptions",
  entries,
  idempotencyKey: key,
});

test("real source metadata distinguishes plugin ownership, declared dependencies, mentions and independent Skills", async (t) => {
  const f = await setup(t),
    job = await f.scan("relations");
  assert.equal(job.status, "SUCCEEDED");
  const list = f.app.registry.catalog.search({ contextId: f.context.id }),
    plugin = list.items.find((e: any) => e.entityKind === "plugin"),
    server = list.items.find((e: any) => e.entityKind === "mcp_server"),
    skill = list.items.find((e: any) => e.name === "review"),
    report = list.items.find((e: any) => e.name === "report");
  assert.equal(
    skill.description,
    "Read pull requests and report actionable findings.",
  );
  assert.equal(skill.pluginId, plugin.id);
  assert.equal(server.pluginId, plugin.id);
  assert.equal(
    skill.relations.find((r: any) => r.kind === "dependency").targetId,
    server.id,
  );
  assert.equal(
    skill.relations.find((r: any) => r.kind === "dependency").status,
    "matched",
  );
  assert.equal(
    skill.relations.find((r: any) => r.kind === "mention").name,
    "github",
  );
  assert.equal(report.pluginId, null);
  assert.deepEqual(report.relations, []);
  assert.equal(
    f.app.registry.catalog.get(server.id).relatedSkills[0].relationKind,
    "dependency",
  );
  assert.equal(f.app.registry.catalog.get(plugin.id).children.length, 2);
  assert.equal(server.toolCount, 1);
  assert.throws(
    () =>
      f.app.registry.get({
        capabilityId: server.id,
        revision: server.revision + 1,
      }),
    { code: "CAPABILITY_STALE" },
  );
  assert.equal(
    f.app.registry.get({ capabilityId: server.id, revision: server.revision })
      .id,
    server.id,
  );
  const tool = list.items.find((e: any) => e.entityKind === "mcp_tool");
  assert.throws(
    () =>
      f.app.registry.get({
        capabilityId: tool.id,
        revision: 99999,
        includeSchemas: true,
      }),
    { code: "NOT_FOUND" },
  );
  assert.equal(
    f.app.registry.catalog.overview(f.context.id).counts.mcp_server,
    1,
  );
  assert.equal(await readFile(join(f.skill, "SKILL.md"), "utf8"), f.original);
});

test("Chinese submission persists through rescan, searches both languages and leaves execution identities and schemas unchanged", async (t) => {
  const f = await setup(t);
  await f.scan("before");
  const tool = f.app.registry.catalog.search({
    contextId: f.context.id,
    kind: "mcp_tool",
  }).items[0];
  const raw = f.app.registry.get({
      capabilityId: tool.id,
      includeSchemas: true,
    }),
    before = hash([
      f.repo.all("capabilities"),
      f.repo.all("capability_revisions"),
      f.repo.all("connections"),
      f.repo.all("versions"),
    ]);
  const a = submission(
    f,
    [
      entry(tool, {
        displayName: "读取拉取请求",
        summary: "检索指定仓库的改动详情。",
        parameterDescriptions: [
          {
            pointer: "/inputSchema/properties/query",
            description: "仓库与拉取请求查询条件",
          },
        ],
      }),
    ],
    "zh",
  );
  assert.equal(validArguments("host_scan", a), true);
  const receipt = await f.app.handle("host_scan", a);
  assert.equal(receipt.status, "descriptions_saved");
  assert.deepEqual(await f.app.handle("host_scan", a), receipt);
  assert.equal(
    hash([
      f.repo.all("capabilities"),
      f.repo.all("capability_revisions"),
      f.repo.all("connections"),
      f.repo.all("versions"),
    ]),
    before,
  );
  assert.deepEqual(
    f.app.registry.get({ capabilityId: tool.id, includeSchemas: true }),
    raw,
  );
  assert.equal(
    f.app.registry.search({ contextId: f.context.id, query: "改动详情" })
      .items[0].name,
    "read",
  );
  assert.ok(
    f.app.registry
      .search({ contextId: f.context.id, query: "read" })
      .items.some((e: any) => e.id === tool.id),
  );
  const entityBefore = f.app.registry.catalog.get(tool.id);
  await f.scan("metadata", "metadata");
  const entityAfter = f.app.registry.catalog.get(tool.id);
  assert.equal(entityAfter.revision, entityBefore.revision);
  assert.equal(entityAfter.presentation.state, "localized");
  assert.equal(entityAfter.displayName, "读取拉取请求");
  assert.equal(f.calls(), 1);
  f.app.registry.catalog.submit(
    submission(
      f,
      [entry(entityAfter, { displayName: "手工修改工具名称" })],
      "manual-name-only",
    ),
    "admin",
    "manual",
  );
  assert.deepEqual(
    f.app.registry.catalog.get(tool.id).presentation.parameterDescriptions,
    [
      {
        pointer: "/inputSchema/properties/query",
        description: "仓库与拉取请求查询条件",
      },
    ],
  );
  assert.equal(TOOL_NAMES.length, 21);
  const plugin = f.app.registry.catalog.search({
    contextId: f.context.id,
    kind: "plugin",
  }).items[0];
  await f.app.handle(
    "host_scan",
    submission(
      f,
      [
        entry(plugin, {
          displayName: "开发协作工具包",
          summary: "开发协作工具与技能说明",
        }),
      ],
      "plugin-chinese",
    ),
  );
  assert.ok(
    f.app.registry
      .search({ contextId: f.context.id, query: "开发协作工具包" })
      .items.some((item: any) => item.id === tool.id),
  );
  assert.equal(
    f.app.registry.catalog.search({
      contextId: f.context.id,
      kind: "mcp_server",
      query: "开发协作工具包",
    }).items.length,
    1,
  );
});

test("description batches are atomic, versioned, idempotent and cannot invent entities, evidence or parameters", async (t) => {
  const f = await setup(t);
  await f.scan("validate");
  const skill = f.app.registry.catalog.search({
      contextId: f.context.id,
      kind: "skill",
    }).items[0],
    tool = f.app.registry.catalog.search({
      contextId: f.context.id,
      kind: "mcp_tool",
    }).items[0];
  for (const [index, bad] of [
    { sourceFingerprint: "wrong" },
    { expectedSourceRevision: 999 },
    { entityId: "invented" },
    { evidenceRefs: ["https://invented.invalid"] },
    { expectedPresentationRevision: 9 },
  ].entries()) {
    await assert.rejects(
      f.app.handle(
        "host_scan",
        submission(f, [entry(tool), entry(skill, bad)], "bad-" + index),
      ),
    );
    assert.equal(f.repo.all("discovery_presentations").length, 0);
  }
  await assert.rejects(
    f.app.handle(
      "host_scan",
      submission(
        f,
        [
          entry(tool, {
            parameterDescriptions: [
              {
                pointer: "/inputSchema/properties/invented",
                description: "不存在",
              },
            ],
          }),
        ],
        "pointer",
      ),
    ),
    { code: "INPUT_INVALID" },
  );
  assert.equal(
    validArguments("host_scan", {
      ...submission(f, [entry(tool)], "mix"),
      depth: "metadata",
    }),
    false,
  );
  assert.equal(
    validArguments("host_scan", {
      contextId: f.context.id,
      depth: "metadata",
      entries: [],
      idempotencyKey: "mix2",
    }),
    false,
  );
  const a = submission(f, [entry(tool)], "success");
  await f.app.handle("host_scan", a);
  await assert.rejects(
    f.app.handle("host_scan", {
      ...a,
      entries: [entry(tool, { summary: "changed" })],
    }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
});

test("manual Chinese edits win over Codex; changed source is stale and cannot silently reuse an old translation", async (t) => {
  const f = await setup(t);
  await f.scan("manual-start");
  let skill = f.app.registry.catalog
    .search({ contextId: f.context.id, kind: "skill" })
    .items.find((e: any) => e.name === "review");
  f.app.registry.catalog.submit(
    submission(f, [entry(skill, { displayName: "我的审查技能" })], "manual"),
    "admin",
    "manual",
  );
  skill = f.app.registry.catalog.get(skill.id);
  await assert.rejects(
    f.app.handle("host_scan", submission(f, [entry(skill)], "overwrite")),
    { code: "PRESENTATION_MANUAL_CONFLICT" },
  );
  await writeFile(
    join(f.skill, "SKILL.md"),
    f.original.replace("actionable findings", "version two findings"),
  );
  await f.scan("changed");
  skill = f.app.registry.catalog.get(skill.id);
  assert.equal(skill.presentation.state, "stale");
  assert.equal(skill.displayName, "review");
  assert.equal(skill.presentation.displayName, "我的审查技能");
  assert.equal(
    f.app.registry.catalog.search({
      contextId: f.context.id,
      query: "我的审查技能",
    }).items.length,
    0,
  );
  await assert.rejects(
    f.app.handle("host_scan", submission(f, [entry(skill)], "overwrite-stale")),
    { code: "PRESENTATION_MANUAL_CONFLICT" },
  );
  f.app.registry.catalog.submit(
    submission(
      f,
      [entry(skill, { displayName: "我的新审查技能" })],
      "manual-new",
    ),
    "admin",
    "manual",
  );
  assert.equal(
    f.app.registry.catalog.get(skill.id).presentation.state,
    "manually_edited",
  );
});

test("missing/ambiguous dependencies and malformed YAML remain explicit; no dependency URL or Skill instruction executes", async (t) => {
  const f = await setup(t);
  await writeFile(
    join(f.skill, "agents/openai.yaml"),
    "dependencies:\n  tools:\n    - type: mcp\n      value: absent\n      url: https://never-fetch.invalid/mcp\n",
  );
  let job = await f.scan("missing");
  let skill = f.app.registry.catalog
    .search({ contextId: f.context.id, kind: "skill" })
    .items.find((e: any) => e.name === "review");
  assert.equal(skill.relations[0].status, "missing");
  assert.equal(f.calls(), 1);
  const duplicate = join(f.home, "plugins/cache/market/duplicate/1");
  await mkdir(join(duplicate, ".codex-plugin"), { recursive: true });
  await writeFile(
    join(duplicate, ".codex-plugin/plugin.json"),
    JSON.stringify({ name: "duplicate", mcpServers: "./.mcp.json" }),
  );
  await writeFile(
    join(duplicate, ".mcp.json"),
    JSON.stringify({
      mcpServers: { github: { url: "https://second-synthetic.invalid/mcp" } },
    }),
  );
  await writeFile(
    join(f.home, "config.toml"),
    '[plugins."dev@market"]\nenabled = true\n[plugins."duplicate@market"]\nenabled = true\n',
  );
  await writeFile(
    join(f.skill, "agents/openai.yaml"),
    "dependencies:\n  tools:\n    - type: mcp\n      value: github\n",
  );
  await f.scan("ambiguous", "metadata");
  skill = f.app.registry.catalog.get(skill.id);
  assert.equal(
    skill.relations.find((r: any) => r.kind === "dependency").status,
    "ambiguous",
  );
  assert.equal(
    skill.relations.find((r: any) => r.kind === "dependency").targetId,
    null,
  );
  await writeFile(join(f.skill, "agents/openai.yaml"), "dependencies: [broken");
  job = await f.scan("broken", "metadata");
  assert.equal(job.status, "PARTIAL");
  assert.ok(job.issues.some((i: any) => i.code === "SKILL_DEPENDENCY_INVALID"));
  assert.equal(await readFile(join(f.skill, "SKILL.md"), "utf8"), f.original);
});

test("restricted owners cannot submit into another owner's snapshot or change context revisions", async (t) => {
  const f = await setup(t);
  for (const id of ["author-a", "author-b"])
    f.repo.put("clients", id, {
      id,
      scopes: ["workflow:author"],
      workflowAllowlist: [],
      revoked: false,
    });
  await f.scan("owner", "metadata", "author-a");
  const skill = f.app.registry.catalog.search({
    contextId: f.context.id,
    kind: "skill",
  }).items[0];
  await assert.rejects(
    f.app.handle(
      "host_scan",
      submission(f, [entry(skill)], "foreign"),
      "author-b",
    ),
    { code: "AUTH_REQUIRED" },
  );
  await assert.rejects(
    f.app.handle(
      "host_scan",
      { ...submission(f, [entry(skill)], "ctx"), expectedContextRevision: 99 },
      "author-a",
    ),
    { code: "CONTEXT_CHANGED" },
  );
  assert.equal(
    (
      await f.app.handle(
        "host_scan",
        submission(f, [entry(skill)], "own"),
        "author-a",
      )
    ).status,
    "descriptions_saved",
  );
});

test("catalog pages invalidate on localized changes, preserve snapshot during an in-progress scan and reject malformed cursors", async (t) => {
  const f = await setup(t);
  await f.scan("snapshot");
  const catalog = f.app.registry.catalog,
    first = catalog.search({ contextId: f.context.id, limit: 1 });
  assert.ok(first.nextCursor);
  const second = catalog.search({
    contextId: f.context.id,
    limit: 1,
    cursor: first.nextCursor,
  });
  assert.notEqual(first.items[0].id, second.items[0].id);
  for (const cursor of [
    "bad",
    Buffer.from("null").toString("base64url"),
    Buffer.from("{}").toString("base64url"),
  ])
    assert.throws(() => catalog.search({ contextId: f.context.id, cursor }), {
      code: "INPUT_INVALID",
    });
  await f.app.handle(
    "host_scan",
    submission(f, [entry(first.items[0])], "change-page"),
  );
  assert.throws(
    () =>
      catalog.search({
        contextId: f.context.id,
        limit: 1,
        cursor: first.nextCursor,
      }),
    { code: "CAPABILITY_STALE" },
  );
  const before = catalog.overview(f.context.id);
  let release!: () => void;
  f.app.engine.connectors.discover = async () => {
    await new Promise<void>((r) => (release = r));
    return { tools: [] };
  };
  f.app.registry.scan({
    contextId: f.context.id,
    depth: "catalog",
    idempotencyKey: "slow",
  });
  for (let i = 0; i < 100 && !release; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(catalog.overview(f.context.id).scanId, before.scanId);
  release();
  await f.app.registry.idle();
  assert.notEqual(catalog.overview(f.context.id).scanId, before.scanId);
});

test("cached host tools keep their proven server parent during metadata refresh and become unavailable after parent disable", async (t) => {
  const f = await setup(t),
    cli = join(f.root, "codex.mjs"),
    tool = {
      name: "host-read",
      description: "Read with host",
      inputSchema: { type: "object", properties: {} },
    };
  await writeFile(
    cli,
    `import readline from 'node:readline';const a=process.argv.slice(2);if(a.includes('--version'))console.log('codex-cli 0.164.0-alpha.11.1');else if(a.includes('--help'))console.log('--json');else if(a.includes('app-server')){readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id)console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:m.method==='mcpServerStatus/list'?{data:[{name:'github',tools:{read:${JSON.stringify(tool)}}}]}:{data:[]}}));});}else console.log('[]');`,
  );
  const context = await f.app.registry.context({
    codexHome: f.home,
    cwd: join(f.root, "project"),
    codexPath: cli,
    useAppServer: true,
    expectedRevision: f.context.revision,
  });
  const scan = async (key: string, depth: string) => {
    f.app.registry.scan({ contextId: context.id, depth, idempotencyKey: key });
    await f.app.registry.idle();
  };
  await scan("host-catalog", "catalog");
  let host = f.app.registry.catalog.search({
    contextId: context.id,
    kind: "mcp_tool",
    executor: "codex_host",
  }).items[0];
  const parent = host.parentId;
  assert.ok(parent);
  assert.equal(f.app.registry.catalog.get(parent).name, "github");
  await scan("host-metadata", "metadata");
  host = f.app.registry.catalog.search({
    contextId: context.id,
    kind: "mcp_tool",
    executor: "codex_host",
  }).items[0];
  assert.equal(host.parentId, parent);
  await writeFile(
    join(f.home, "config.toml"),
    '[plugins."dev@market"]\nenabled = false\n',
  );
  await scan("host-disabled", "metadata");
  assert.equal(
    f.app.registry.catalog.search({
      contextId: context.id,
      kind: "mcp_tool",
      executor: "codex_host",
    }).items.length,
    0,
  );
  await assert.rejects(
    f.app.registry.import({
      capabilityId: host.capabilityId,
      expectedSourceRevision: host.capabilityRevision,
      target: "codex_host",
      environment: "test",
      lockedArguments: {},
      idempotencyKey: "disabled-host-import",
    }),
    { code: "CAPABILITY_STALE" },
  );
});

test("long documentation paragraphs retain searchable Chinese tail text without widening query budgets", async (t) => {
  const { ProjectKnowledge, tokens } = await import(
    "../../packages/project-knowledge/src/index.js"
  );
  const f = await setup(t),
    document =
      Array.from({ length: 750 }, (_, i) => "word" + i).join(" ") +
      " 末尾检索标识";
  await writeFile(join(f.root, "README.md"), "# Current help\n" + document);
  const { projectRoot } = await import("../../packages/contracts/src/index.js");
  await mkdir(join(f.root, "contracts"));
  await writeFile(
    join(f.root, "contracts/mcp-v2-tool-inputs.schema.json"),
    await readFile(
      join(projectRoot, "contracts/mcp-v2-tool-inputs.schema.json"),
    ),
  );
  const knowledge = new ProjectKnowledge(f.repo, f.root);
  assert.ok(
    knowledge
      .search({ query: "末尾检索标识", limit: 5 })
      .excerpts.some((e: any) => e.content.includes("末尾检索标识")),
  );
  assert.equal(tokens(document).length, 500);
  assert.ok(tokens(document, 20000).includes("标识"));
});
