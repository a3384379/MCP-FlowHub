import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const password = "Synthetic-browser-password-041";

async function admin(page: Page) {
  const state = (await (await page.request.get("/api/v1/auth/state")).json())
    .data;
  const response = await page.request.post(
    "/api/v1/auth/" + (state.initialized ? "session" : "bootstrap"),
    {
      data: state.initialized
        ? { password }
        : {
            password,
            setupToken: await readFile(
              process.env.FLOWHUB_UI_DATA_DIR + "/admin-setup-token",
              "utf8",
            ),
          },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
  const csrf = (await response.json()).data.csrf;
  return async (
    path: string,
    method = "GET",
    data?: unknown,
    revision?: number,
  ) => {
    const result = await page.request.fetch("/api/v1" + path, {
      method,
      headers: {
        "X-CSRF-Token": csrf,
        ...(revision === undefined ? {} : { "If-Match": String(revision) }),
      },
      ...(data === undefined ? {} : { data }),
    });
    expect(result.ok(), await result.text()).toBe(true);
    return (await result.json()).data;
  };
}

async function newWorkflow(page: Page, template: string, environment: string) {
  await page.goto("/workflows");
  await page
    .getByRole("button", { name: "＋ 新建工作流", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "新建工作流" });
  const id = "ui-editor-" + randomUUID();
  await dialog.getByLabel("工作流名称").fill("浏览器新建 " + id);
  await dialog.getByLabel("工作流 ID").fill(id);
  await dialog.getByLabel("固定环境").selectOption(environment);
  await dialog.getByLabel("起始模板").selectOption(template);
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page).toHaveURL("/workflows/" + id + "/editor");
  return id;
}

async function publish(page: Page) {
  await page.getByRole("button", { name: "发布版本", exact: true }).click();
  const review = page.getByRole("dialog", { name: "确认发布不可变版本" });
  await expect(review).toContainText("后端校验：通过");
  await review
    .getByLabel("变更说明")
    .fill("浏览器回归：核对固定环境、工具和绑定后发布");
  await review.getByRole("button", { name: "确认发布", exact: true }).click();
}

test("blank workflow requires an explicit environment and can save, publish and run without a binding", async ({
  page,
}) => {
  const api = await admin(page);
  await page.goto("/workflows");
  await page
    .getByRole("button", { name: "＋ 新建工作流", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "新建工作流" });
  await expect(dialog.getByLabel("固定环境")).toHaveValue("");
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect(dialog).toContainText("请选择固定环境");
  await dialog.getByLabel("工作流名称").fill(" ");
  await dialog.getByLabel("固定环境").selectOption("test");
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect(dialog).toContainText("请输入工作流名称");
  const id = "ui-blank-" + randomUUID();
  await dialog.getByLabel("工作流名称").fill("空白可发布流程");
  await dialog.getByLabel("工作流 ID").fill(id);
  await dialog
    .getByLabel("工作流描述")
    .fill("只返回明确输入，不访问任何下游系统");
  await dialog.getByLabel("起始模板").selectOption("blank");
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page).toHaveURL("/workflows/" + id + "/editor");
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("草稿已保存");
  await publish(page);
  await expect(page.getByRole("status")).toContainText("不可变版本已发布");
  const version = (await api("/workflows/" + id + "/versions"))[0];
  expect(version.snapshot.workflow).toMatchObject({
    environment: "test",
    mode: "auto",
    bindings: {},
  });
  expect(version.snapshot.bindings).toEqual([]);
  await page.getByRole("button", { name: "工作流", exact: true }).click();
  await page
    .locator("article")
    .filter({
      has: page.getByRole("heading", { name: "空白可发布流程", exact: true }),
    })
    .getByRole("button", { name: "启动", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await expect(page).toHaveURL(/\/runs\/run_/);
  const runId = new URL(page.url()).pathname.split("/").at(-1)!;
  await expect
    .poll(async () => (await api("/runs/" + runId)).state)
    .toBe("SUCCEEDED");
});

test("incident creation ignores modified source drafts and requires explicit binding and tool choices before publication", async ({
  page,
}) => {
  const api = await admin(page);
  const original = await api("/workflows/incident-production/draft");
  const modified = structuredClone(original.draft);
  modified.nodes.push({
    ...structuredClone(
      modified.nodes.find((n: { id: string }) => n.id === "log"),
    ),
    id: "user_added_tool",
    title: "用户新增工具",
  });
  await api(
    "/workflows/incident-production/draft",
    "PUT",
    { workflow: modified, layout: original.layout },
    original.revision,
  );
  try {
    const id = await newWorkflow(page, "incident", "staging");
    const fresh = await api("/workflows/" + id + "/draft");
    expect(fresh.draft.bindings).toEqual({});
    expect(
      fresh.draft.nodes.some((n: { id: string }) => n.id === "user_added_tool"),
    ).toBe(false);
    await page.getByRole("button", { name: "发布版本", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
      "ENVIRONMENT_OVERRIDE_DENIED",
    );
    expect(await api("/workflows/" + id + "/versions")).toEqual([]);
    await page
      .getByLabel("环境绑定 log", { exact: true })
      .selectOption("huawei-log-staging");
    await page
      .getByLabel("环境绑定 db", { exact: true })
      .selectOption("shared-db-staging-readonly");
    await page
      .locator(".react-flow__node")
      .filter({ hasText: "查询固定环境日志" })
      .click();
    await page.getByLabel("实际 MCP 工具").selectOption("huawei_log_search");
    await page
      .locator(".react-flow__node")
      .filter({ hasText: "查询固定模板的订单记录" })
      .click();
    await page.getByLabel("实际 MCP 工具").selectOption("query_template");
    await publish(page);
    await expect(page.getByRole("status")).toContainText("不可变版本已发布");
    const version = (await api("/workflows/" + id + "/versions"))[0];
    expect(version.snapshot.workflow.environment).toBe("staging");
    expect(
      version.snapshot.bindings.every(
        (b: { simulationOnly: boolean }) => b.simulationOnly,
      ),
    ).toBe(true);
  } finally {
    const current = await api("/workflows/incident-production/draft");
    await api(
      "/workflows/incident-production/draft",
      "PUT",
      { workflow: original.draft, layout: original.layout },
      current.revision,
    );
  }
});

test("deterministic creation supports production, explicit tools, and selecting then deleting a saved edge", async ({
  page,
}) => {
  const api = await admin(page);
  const id = await newWorkflow(page, "deterministic", "production");
  await page
    .getByLabel("环境绑定 log", { exact: true })
    .selectOption("aliyun-log-prod");
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "查询固定环境日志" })
    .click();
  await page.getByLabel("实际 MCP 工具").selectOption("aliyun_log_search");
  await publish(page);
  await expect(page.getByRole("status")).toContainText("不可变版本已发布");
  expect(
    (await api("/workflows/" + id + "/versions"))[0].snapshot.workflow.mode,
  ).toBe("auto");
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  const edgePath = page
    .locator(".react-flow__edge")
    .first()
    .locator(".react-flow__edge-interaction");
  const readEdgeGeometry = () =>
    edgePath.evaluate((element) => {
      const path = element as SVGPathElement;
      const length = path.getTotalLength();
      const matrix = path.getScreenCTM();
      const midpoint =
        matrix && length > 0
          ? path.getPointAtLength(length / 2).matrixTransform(matrix)
          : null;
      const point =
        midpoint && Number.isFinite(midpoint.x) && Number.isFinite(midpoint.y)
          ? { x: midpoint.x, y: midpoint.y }
          : null;
      const edge = path.closest(".react-flow__edge");
      const hit = point ? document.elementFromPoint(point.x, point.y) : null;
      const rect = (
        value:
          | { x: number; y: number; width: number; height: number }
          | undefined,
      ) =>
        value
          ? { x: value.x, y: value.y, width: value.width, height: value.height }
          : null;
      return {
        length,
        bbox: rect(path.getBBox()),
        edgeRect: rect(edge?.getBoundingClientRect()),
        canvasRect: rect(path.closest(".canvas")?.getBoundingClientRect()),
        point,
        hitClass: hit?.getAttribute("class"),
        reachable: edge !== null && hit?.closest(".react-flow__edge") === edge,
      };
    });
  let geometry = await readEdgeGeometry();
  let previousGeometry: string | undefined;
  try {
    // Straight SVG edges may have a zero-width/height box. Wait for their
    // actual stroke to stop moving and remain reachable by a real pointer.
    await expect
      .poll(
        async () => {
          geometry = await readEdgeGeometry();
          const currentGeometry = JSON.stringify({
            length: geometry.length,
            bbox: geometry.bbox,
            canvasRect: geometry.canvasRect,
            point: geometry.point,
          });
          const stable = currentGeometry === previousGeometry;
          previousGeometry = currentGeometry;
          return { stable, reachable: geometry.reachable };
        },
        {
          message: "saved edge stroke is stable and reachable by the pointer",
          intervals: [100, 250, 500],
        },
      )
      .toEqual({ stable: true, reachable: true });
  } finally {
    await test.info().attach("saved-edge-geometry", {
      body: JSON.stringify(geometry, null, 2),
      contentType: "application/json",
    });
  }
  expect(geometry.point).not.toBeNull();
  await page.mouse.click(geometry.point!.x, geometry.point!.y);
  await expect(page.locator(".react-flow__edge.selected")).toHaveCount(1);
  await page.keyboard.press("Delete");
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await page.getByRole("button", { name: "查看 DSL", exact: true }).click();
  expect(
    JSON.parse(await page.getByRole("dialog").locator("pre").innerText()).edges,
  ).toHaveLength(1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("草稿已保存");
  expect((await api("/workflows/" + id + "/draft")).draft.edges).toHaveLength(
    1,
  );
});

test("reviewed publication rejects a concurrent edit and offers comparison and a separate unbound draft", async ({
  page,
}) => {
  const api = await admin(page);
  const id = await newWorkflow(page, "blank", "test");
  await page.getByRole("button", { name: "发布版本", exact: true }).click();
  const review = page.getByRole("dialog", { name: "确认发布不可变版本" });
  await expect(review).toBeVisible();
  const current = await api("/workflows/" + id + "/draft");
  const remote = { ...current.draft, description: "另一标签页已修改" };
  await api(
    "/workflows/" + id + "/draft",
    "PUT",
    { workflow: remote, layout: current.layout },
    current.revision,
  );
  await review.getByRole("button", { name: "确认发布", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("REVISION_CONFLICT");
  expect(await api("/workflows/" + id + "/versions")).toEqual([]);
  await review
    .getByRole("button", { name: "关闭", exact: true })
    .last()
    .click();
  const recovery = page.getByRole("region", { name: "草稿冲突处理" });
  // Closing review can safely adopt a remote-only change. A real same-field
  // conflict below must remain available for comparison and save-as.
  if (await recovery.isVisible())
    await recovery.getByRole("button", { name: "重新尝试合并", exact: true }).click();
  await expect(recovery).toHaveCount(0);
  await page.locator(".react-flow__node").first().click();
  await page.getByLabel("节点名称", { exact: true }).fill("本地未保存节点");
  const latest = await api("/workflows/" + id + "/draft");
  const changed = structuredClone(latest.draft);
  changed.nodes[0].title = "远端同字段修改";
  await api("/workflows/" + id + "/draft", "PUT", {workflow: changed, layout: latest.layout}, latest.revision);
  await expect(recovery).toBeVisible();
  await recovery.getByRole("button", { name: "比较差异", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("远端同字段修改");
  await page.keyboard.press("Escape");
  await recovery.getByRole("button", { name: "另存草稿", exact: true }).click();
  const copy = page.getByRole("dialog", { name: "另存为新工作流" });
  const copyId = "ui-conflict-" + randomUUID();
  await copy.getByLabel("工作流 ID").fill(copyId);
  await copy.getByLabel("固定环境").selectOption("staging");
  await copy.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page).toHaveURL("/workflows/" + copyId + "/editor");
  expect((await api("/workflows/" + copyId + "/draft")).draft.bindings).toEqual(
    {},
  );
  expect((await api("/workflows/" + id + "/draft")).draft.description).toBe(
    "另一标签页已修改",
  );
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a slow draft response cannot replace the workflow reached through navigation", async ({
  page,
}) => {
  await admin(page);
  const first = await newWorkflow(page, "blank", "test");
  const second = await newWorkflow(page, "blank", "test");
  const requested = deferred(),
    release = deferred(),
    completed = deferred();
  await page.route("**/api/v1/workflows/" + first + "/draft", async (route) => {
    const response = await route.fetch();
    requested.resolve();
    await release.promise;
    await route.fulfill({ response }).catch(() => {});
    completed.resolve();
  });
  try {
    await page.goto("/workflows/" + first + "/editor", {
      waitUntil: "domcontentloaded",
    });
    await requested.promise;
    await page.getByRole("button", { name: "工作流", exact: true }).click();
    await page
      .locator("article")
      .filter({ hasText: second })
      .getByRole("button", { name: "打开编排", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "浏览器新建 " + second, exact: true }),
    ).toBeVisible();
    release.resolve();
    await completed.promise;
    await expect(page).toHaveURL("/workflows/" + second + "/editor");
    await expect(
      page.getByRole("heading", { name: "浏览器新建 " + second, exact: true }),
    ).toBeVisible();
    await page
      .locator(".react-flow__node")
      .filter({ hasText: "接收输入" })
      .click();
    await expect(page.getByLabel("节点 ID")).toHaveValue("input");
  } finally {
    release.resolve();
  }
});

test("a delayed save preserves newer edits and undo keeps the latest server revision", async ({
  page,
}) => {
  const api = await admin(page);
  const id = await newWorkflow(page, "blank", "test");
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "接收输入" })
    .click();
  await page.getByLabel("节点名称").fill("提交时的名称");
  const stored = deferred(),
    release = deferred();
  let firstSave = true;
  await page.route("**/api/v1/workflows/" + id + "/draft", async (route) => {
    if (route.request().method() !== "PUT" || !firstSave)
      return route.continue();
    firstSave = false;
    const response = await route.fetch();
    stored.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  try {
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith("/workflows/" + id + "/draft"),
    );
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    await stored.promise;
    await page.getByLabel("节点名称").fill("等待回包期间的新名称");
    release.resolve();
    await saved;
    await expect(
      page.getByRole("button", { name: "保存草稿", exact: true }),
    ).toBeEnabled();
    await expect(page.getByLabel("节点名称")).toHaveValue(
      "等待回包期间的新名称",
    );
    await expect(page.locator(".editor-toolbar")).toContainText("有未保存修改");
    expect(
      (await api("/workflows/" + id + "/draft")).draft.nodes[0].title,
    ).toBe("提交时的名称");
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("草稿已保存");
    const current = await api("/workflows/" + id + "/draft");
    expect(current.draft.nodes[0].title).toBe("等待回包期间的新名称");
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("草稿已保存");
    expect((await api("/workflows/" + id + "/draft")).revision).toBe(
      current.revision + 1,
    );
    await expect(
      page.getByRole("region", { name: "草稿冲突处理" }),
    ).toHaveCount(0);
  } finally {
    release.resolve();
  }
});

test("a save finishing after navigation cannot replace another workflow", async ({
  page,
}) => {
  const api = await admin(page);
  const first = await newWorkflow(page, "blank", "test");
  const second = await newWorkflow(page, "blank", "test");
  await page.goto("/workflows/" + first + "/editor");
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "接收输入" })
    .click();
  await page.getByLabel("节点名称").fill("离开前明确保存的名称");
  const stored = deferred(),
    release = deferred(),
    completed = deferred();
  await page.route("**/api/v1/workflows/" + first + "/draft", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const response = await route.fetch();
    stored.resolve();
    await release.promise;
    await route.fulfill({ response });
    completed.resolve();
  });
  try {
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    await stored.promise;
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "工作流", exact: true }).click();
    await page
      .locator("article")
      .filter({ hasText: second })
      .getByRole("button", { name: "打开编排", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "浏览器新建 " + second, exact: true }),
    ).toBeVisible();
    release.resolve();
    await completed.promise;
    await expect(page).toHaveURL("/workflows/" + second + "/editor");
    await expect(
      page.getByRole("heading", { name: "浏览器新建 " + second, exact: true }),
    ).toBeVisible();
    expect(
      (await api("/workflows/" + first + "/draft")).draft.nodes[0].title,
    ).toBe("离开前明确保存的名称");
  } finally {
    release.resolve();
  }
});

test("session expiry retains focused JSON text while a wrong vault password leaves the admin session active", async ({
  page,
}) => {
  await admin(page);
  await newWorkflow(page, "incident", "staging");
  await expect(
    page.getByRole("button", { name: "保存草稿", exact: true }),
  ).toBeEnabled();
  const requested = deferred(),
    release = deferred();
  let expire = true;
  await page.route("**/api/v1/workflows", async (route) => {
    if (!expire || route.request().method() !== "GET") return route.continue();
    expire = false;
    requested.resolve();
    await release.promise;
    await route.fulfill({
      status: 401,
      json: {
        error: {
          code: "AUTH_REQUIRED",
          message: "Administrator login required.",
        },
      },
    });
  });
  try {
    await page.getByRole("button", { name: "↻ 刷新", exact: true }).click();
    await requested.promise;
    await page
      .locator(".react-flow__node")
      .filter({ hasText: "查询固定环境日志" })
      .click();
    const editor = page.getByLabel("节点配置（映射 / Schema）");
    const config = JSON.parse(await editor.inputValue());
    config.argumentsMappings["/question"] = { value: "仍在焦点中的新内容" };
    const raw = JSON.stringify(config, null, 2);
    await editor.fill(raw);
    await page.context().clearCookies();
    release.resolve();
    await expect(
      page.getByRole("button", { name: "登录管理中心", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "导出未保存草稿", exact: true }),
    ).toBeVisible();
    await page.getByLabel("管理员密码").fill(password);
    await page
      .getByRole("button", { name: "登录管理中心", exact: true })
      .click();
    await expect(page.getByLabel("节点配置（映射 / Schema）")).toHaveValue(raw);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "系统设置", exact: true }).click();
    await page.getByRole("button", { name: "解锁", exact: true }).click();
    const unlock = page.getByRole("dialog", { name: "解锁凭据库" });
    await unlock.getByLabel("凭据库口令").fill("Wrong-synthetic-password");
    await unlock.getByRole("button", { name: "确认", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("AUTH_REQUIRED");
    await expect(
      page.getByRole("heading", { name: "系统设置", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "登录管理中心", exact: true }),
    ).toHaveCount(0);
    await unlock.getByLabel("凭据库口令").fill(password);
    await unlock.getByRole("button", { name: "确认", exact: true }).click();
    await expect(unlock).toHaveCount(0);
  } finally {
    release.resolve();
  }
});

test("schema fields, finite conditions and invalid mapping literals preserve the selected node", async ({
  page,
}) => {
  const api = await admin(page);
  const id = await newWorkflow(page, "incident", "staging");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "查询固定模板的订单记录" })
    .click();
  const literal = page.getByLabel("/templateId 常量", { exact: true });
  await literal.fill('"unfinished');
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("JSON 格式错误");
  expect(
    (await api("/workflows/" + id + "/draft")).draft.nodes.find(
      (node: { id: string }) => node.id === "db",
    ).config.argumentsMappings["/templateId"].value,
  ).toBe("order-by-number-v1");
  await literal.fill('"order-by-number-v1"');
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "是否需要只读数据库证据" })
    .click();
  await page
    .getByLabel("条件比较方式 condition", { exact: true })
    .selectOption("exists");
  await page
    .getByLabel("存在字段 condition 来源", { exact: true })
    .selectOption("input");
  await page
    .getByLabel("存在字段 condition 可用字段", { exact: true })
    .selectOption("/question");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("草稿已保存");
  expect(
    (await api("/workflows/" + id + "/draft")).draft.nodes.find(
      (node: { id: string }) => node.id === "need_db",
    ).config.expression,
  ).toEqual({
    op: "exists",
    value: { ref: { source: "input", pointer: "/question" } },
  });
  await page.getByRole("button", { name: "流程配置", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const workflow = JSON.parse(
    await dialog.getByLabel("配置 JSON").inputValue(),
  );
  workflow.nodes.find(
    (node: { id: string }) => node.id === "db",
  ).config.argumentsMappings["/templateId"] = null;
  await dialog.getByLabel("配置 JSON").fill(JSON.stringify(workflow));
  await expect(
    dialog.getByRole("button", { name: "确认", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("invalid JSON cannot submit the previous business inputs or replace the workflow with null", async ({
  page,
}) => {
  const api = await admin(page);
  const id = await newWorkflow(page, "blank", "test");
  await page.getByRole("button", { name: "流程配置", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("配置 JSON").fill("null");
  await expect(
    dialog.getByRole("button", { name: "确认", exact: true }),
  ).toBeDisabled();
  await expect(dialog).toContainText("工作流定义必须包含");
  await dialog
    .getByRole("button", { name: "关闭", exact: true })
    .last()
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await publish(page);
  await expect(page.getByRole("status")).toContainText("不可变版本已发布");
  await page.getByRole("button", { name: "工作流", exact: true }).click();
  await page
    .locator("article")
    .filter({ hasText: id })
    .getByRole("button", { name: "启动", exact: true })
    .click();
  const start = page.getByRole("dialog");
  await start.getByLabel("业务输入").fill("{invalid");
  await expect(
    start.getByRole("button", { name: "确认", exact: true }),
  ).toBeDisabled();
  await start.getByLabel("业务输入").blur();
  await expect(start).toContainText("JSON 格式错误");
  expect(
    (await api("/runs")).some(
      (r: { workflowId: string }) => r.workflowId === id,
    ),
  ).toBe(false);
});

test("invalid node JSON and literal text remain blocking after selecting another node", async ({
  page,
}) => {
  await admin(page);
  const id = await newWorkflow(page, "incident", "staging");
  let saves = 0;
  page.on("request", (request) => {
    if (
      request.method() === "PUT" &&
      new URL(request.url()).pathname === "/api/v1/workflows/" + id + "/draft"
    )
      saves++;
  });
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "查询固定环境日志" })
    .click();
  const editor = page.getByLabel("节点配置（映射 / Schema）");
  const original = await editor.inputValue();
  await editor.fill("{unfinished");
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "是否需要只读数据库证据" })
    .click();
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("未应用的 JSON");
  expect(saves).toBe(0);
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "查询固定环境日志" })
    .click();
  await expect(page.getByLabel("节点配置（映射 / Schema）")).toHaveValue(
    "{unfinished",
  );
  await page.getByLabel("节点配置（映射 / Schema）").fill(original);
  await page.getByLabel("节点配置（映射 / Schema）").blur();
  await expect(
    page.getByText("正在校验 JSON，完成后可继续保存", { exact: true }),
  ).toHaveCount(0);
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "查询固定模板的订单记录" })
    .click();
  await page
    .getByLabel("/templateId 常量", { exact: true })
    .fill('"unfinished');
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "是否需要只读数据库证据" })
    .click();
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("未应用的 JSON");
  expect(saves).toBe(0);
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "查询固定模板的订单记录" })
    .click();
  await expect(
    page.getByLabel("/templateId 常量", { exact: true }),
  ).toHaveValue('"unfinished');
});

test("an earlier node preview cannot consume raw text from a remounted editor", async ({
  page,
}) => {
  await admin(page);
  const id = await newWorkflow(page, "incident", "staging");
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "查询固定环境日志" })
    .click();
  const config = JSON.parse(
    await page.getByLabel("节点配置（映射 / Schema）").inputValue(),
  );
  config.argumentsMappings["/question"] = { value: "本次已验证的早先值" };
  const requested = deferred(),
    release = deferred();
  let first = true,
    saves = 0;
  page.on("request", (request) => {
    if (
      request.method() === "PUT" &&
      new URL(request.url()).pathname === "/api/v1/workflows/" + id + "/draft"
    )
      saves++;
  });
  await page.route("**/api/v1/workflow-imports/preview", async (route) => {
    if (!first) return route.continue();
    first = false;
    const response = await route.fetch();
    requested.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  try {
    await page
      .getByLabel("节点配置（映射 / Schema）")
      .fill(JSON.stringify(config, null, 2));
    await page.getByLabel("节点配置（映射 / Schema）").blur();
    await requested.promise;
    await page
      .locator(".react-flow__node")
      .filter({ hasText: "是否需要只读数据库证据" })
      .click();
    await page
      .locator(".react-flow__node")
      .filter({ hasText: "查询固定环境日志" })
      .click();
    await page
      .getByLabel("节点配置（映射 / Schema）")
      .fill("{newer-unfinished");
    release.resolve();
    await expect(
      page.getByLabel("/question 常量", { exact: true }),
    ).toHaveValue(JSON.stringify("本次已验证的早先值"));
    await expect(page.getByLabel("节点配置（映射 / Schema）")).toHaveValue(
      "{newer-unfinished",
    );
    await page
      .locator(".react-flow__node")
      .filter({ hasText: "是否需要只读数据库证据" })
      .click();
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
      /未应用的 JSON|JSON 格式错误/,
    );
    expect(saves).toBe(0);
  } finally {
    release.resolve();
  }
});
