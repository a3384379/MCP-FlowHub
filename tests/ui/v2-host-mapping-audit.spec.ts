import { test, expect, type Page } from "@playwright/test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

async function request(page: Page) {
  const session = await page.request.post("/api/v1/auth/local-session", {
    data: {}, headers: { "X-FlowHub-Local": "1", Origin: "http://127.0.0.1:18479" },
  });
  expect(session.ok(), await session.text()).toBeTruthy();
  const { csrf } = (await session.json()).data;
  return async (path: string, data?: object, revision?: number) => {
    const response = await page.request.fetch(path, {
      method: data === undefined ? "GET" : "POST",
      data,
      headers: { "X-CSRF-Token": csrf, ...(revision === undefined ? {} : { "If-Match": String(revision) }) },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return (await response.json()).data;
  };
}

test("Codex node inspector maps nested local Schema references and edits receipt scopes", async ({ page }) => {
  const fixtures = await realpath(await mkdtemp(join(process.env.FLOWHUB_UI_DATA_DIR!, "host-mapping-audit-")));
  const home = join(fixtures, "home"), project = join(fixtures, "project"), cli = join(fixtures, "codex.mjs");
  const api = await request(page);
  const empty = { type: "object", properties: {}, additionalProperties: false };
  const logOutput = {
    type: "object", required: ["log"], properties: { log: { $ref: "#/$defs/log" } }, additionalProperties: false,
    $defs: { log: { type: "object", properties: { "trace/id": { type: "string" } }, required: ["trace/id"], additionalProperties: false } },
    examples: [{ log: { "trace/id": "synthetic-trace" } }],
  };
  const queryInput = {
    type: "object", properties: { query: { $ref: "#/$defs/query" }, note: { type: "string" } }, required: ["query"], additionalProperties: false,
    $defs: { query: { type: "object", properties: { traceId: { type: "string" } }, required: ["traceId"], additionalProperties: false } },
  };
  const queryOutput = { type: "object", properties: { traceId: { type: "string" } }, required: ["traceId"], additionalProperties: false };
  const tools = {
    read_logs: { name: "read_logs", inputSchema: empty, outputSchema: logOutput },
    check_trace: { name: "check_trace", inputSchema: queryInput, outputSchema: queryOutput },
  };
  try {
    await mkdir(home);
    await mkdir(project);
    await writeFile(join(home, "config.toml"), '[mcp_servers.synthetic]\nurl="http://127.0.0.1:1/mcp"\n');
    await writeFile(cli, `import readline from 'node:readline';
const args=process.argv.slice(2);
if(args.includes('--version'))console.log('codex-cli 0.169.0-alpha.11.1');
else if(args.includes('--help'))console.log('--json');
else if(args.includes('app-server'))readline.createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);
  if(request.id)console.log(JSON.stringify({id:request.id,result:request.method==='initialize'?{}:{data:request.method==='mcpServerStatus/list'?[{name:'synthetic',authStatus:'unsupported',tools:${JSON.stringify(tools)}}]:[]}}));
});
else console.log(JSON.stringify([{name:'synthetic',enabled:true,transport:{type:'http',url:'http://127.0.0.1:1/mcp'}}]));`);
    const context = await api("/api/v2/host-contexts", { codexHome: home, cwd: project, codexPath: cli, discoveryMode: "auto" });
    const scan = await api("/api/v2/host-scans", { contextId: context.id, depth: "host_catalog", idempotencyKey: randomUUID() });
    await expect.poll(async () => (await api("/api/v2/host-scans/" + scan.scanId)).status).toBe("SUCCEEDED");
    const { items } = await api("/api/v2/capabilities?contextId=" + context.id + "&executor=codex_host");
    const workflowId = "mapping-audit-" + randomUUID().slice(0, 8);
    await api("/api/v2/workflows", { workflowId, name: "合成宿主合同映射", environment: "test", mode: "guided", template: "blank", idempotencyKey: randomUUID() });
    await api("/api/v2/workflows/" + workflowId + "/operations", {
      expectedRevision: 1, idempotencyKey: randomUUID(), operations: [
        ...Object.values(tools).map((tool) => {
          const capability = items.find((item: { name: string }) => item.name === tool.name);
          const capabilityRef = { capabilityId: capability.id, revision: capability.revision };
          return {
            op: "add_node", nodeId: tool.name, title: tool.name, nodeType: "agent_task", capabilityRef,
            config: { kind: "host_tool", executorRef: "codex_host", requireHostReceipt: true, instructions: "Synthetic test only.", capabilityRef, inputMappings: {}, outputSchema: tool.outputSchema },
          };
        }),
        { op: "disconnect", source: "input", target: "end", port: "next" },
        { op: "connect", source: "input", target: "read_logs", port: "next" },
        { op: "connect", source: "read_logs", target: "check_trace", port: "next" },
        { op: "connect", source: "check_trace", target: "end", port: "next" },
      ],
    }, 1);

    await page.goto("/workflows/" + workflowId + "/editor");
    await page.locator('.react-flow__node[data-id="check_trace"]').click();
    const target = page.getByRole("combobox", { name: "目标参数", exact: true });
    await expect(target.locator('option[value="/query/traceId"]')).toHaveCount(1);
    await target.selectOption("/query/traceId");
    await page.getByRole("button", { name: /添加参数映射/ }).click();
    await page.getByLabel("/query/traceId 来源", { exact: true }).selectOption("node");
    await page.getByLabel("/query/traceId 可用字段", { exact: true }).selectOption("/log/trace~1id");
    await expect(page.getByText(/样例值 "synthetic-trace"/)).toBeVisible();

    await page.getByText("回执范围字段", { exact: true }).click();
    await expect(page.getByText("未配置回执范围比对。", { exact: true })).toBeVisible();
    await page.getByLabel("回执输出字段", { exact: true }).selectOption("/traceId");
    await page.getByLabel("对应调用参数", { exact: true }).selectOption("/query/traceId");
    await page.getByRole("button", { name: "添加范围比对", exact: true }).click();

    await target.selectOption("/note");
    await page.getByRole("button", { name: /添加参数映射/ }).click();
    await page.getByLabel("/note 来源", { exact: true }).selectOption("literal");
    await page.getByLabel("/note 常量", { exact: true }).fill("{");
    await expect(page.getByText(/常量必须是合法 JSON 值/)).toBeVisible();
    await page.getByRole("button", { name: "移除映射 /note", exact: true }).click();
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect.poll(async () => (await api("/api/v2/workflows/" + workflowId + "/draft")).revision).toBe(3);
    const saved = await api("/api/v2/workflows/" + workflowId + "/draft");
    expect(saved.issues).toEqual([]);
    expect(saved.draft.nodes.find((node: { id: string }) => node.id === "check_trace").config).toMatchObject({
      inputMappings: { "/query/traceId": { ref: { source: "node", nodeId: "read_logs", pointer: "/log/trace~1id" } } },
      receiptScopeMappings: { "/traceId": "/query/traceId" },
    });
  } finally {
    await rm(fixtures, { recursive: true, force: true });
  }
});
