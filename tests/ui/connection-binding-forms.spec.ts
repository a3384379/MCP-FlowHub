import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const password = "Synthetic-browser-password-041";

async function admin(page: Page) {
  const state = (await (await page.request.get("/api/v1/auth/state")).json())
    .data;
  const login = await page.request.post(
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
  expect(login.ok(), await login.text()).toBe(true);
  const csrf = (await login.json()).data.csrf;
  return async (path: string, method = "GET", data?: unknown) => {
    const response = await page.request.fetch("/api/v1" + path, {
      method,
      headers: { "X-CSRF-Token": csrf },
      ...(data === undefined ? {} : { data }),
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).data;
  };
}

test("labelled STDIO registration, discovery, explicit environment binding and an approved Mock probe need no whole-configuration JSON", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const api = await admin(page);
  if ((await api("/auth/state")).vaultLocked)
    await api("/vault/unlock", "POST", { password });
  expect((await api("/auth/state")).vaultLocked).toBe(false);
  const settings = await api("/settings");
  const connectionName = "合成表单连接 " + randomUUID();
  const bindingName = "合成表单绑定 " + randomUUID();
  await page.goto("/connections");
  await page.getByRole("button", { name: "＋ 添加连接", exact: true }).click();
  const connectionDialog = page.getByRole("dialog", { name: "登记 MCP 连接" });
  await connectionDialog
    .getByLabel("连接名称", { exact: true })
    .fill(connectionName);
  await connectionDialog
    .getByLabel("传输方式", { exact: true })
    .selectOption("stdio");
  await connectionDialog
    .getByLabel("绝对可执行文件路径", { exact: true })
    .fill(settings.runtimePath);
  for (const [index, arg] of [settings.cliPath, "mock", "--stdio"].entries()) {
    await connectionDialog
      .getByRole("button", { name: "添加命令参数", exact: true })
      .click();
    await connectionDialog
      .getByLabel(`命令参数 ${index + 1}`, { exact: true })
      .fill(arg);
  }
  await expect(
    connectionDialog.getByRole("button", { name: "确认", exact: true }),
  ).toBeDisabled();
  await connectionDialog
    .getByLabel("我已核对程序和每项参数，获准启动该本机程序")
    .check();
  await connectionDialog
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await expect(connectionDialog).toHaveCount(0);
  const connection = (await api("/connections")).find(
    (entry: any) => entry.name === connectionName,
  );
  expect(connection).toMatchObject({
    transport: "stdio",
    command: settings.runtimePath,
    args: [settings.cliPath, "mock", "--stdio"],
  });
  expect(connection.endpoint).toBeUndefined();
  expect(connection.mode).toBeUndefined();
  const card = page.locator(".connection-grid > section").filter({
    has: page.getByRole("heading", { name: connectionName, exact: true }),
  });
  await card.getByRole("button", { name: "检测与同步", exact: true }).click();
  await expect(card).toContainText("4 工具");

  await page.getByRole("button", { name: "环境与资源", exact: true }).click();
  await page.getByRole("button", { name: "＋ 新建档案", exact: true }).click();
  const bindingDialog = page.getByRole("dialog", { name: "创建绑定档案" });
  await expect(
    bindingDialog.getByLabel("绑定环境", { exact: true }),
  ).toHaveValue("");
  await expect(
    bindingDialog.getByLabel("MCP 连接", { exact: true }),
  ).toHaveValue("");
  await expect(
    bindingDialog.getByRole("button", { name: "确认", exact: true }),
  ).toBeDisabled();
  await bindingDialog.getByLabel("绑定名称", { exact: true }).fill(bindingName);
  await bindingDialog
    .getByLabel("绑定环境", { exact: true })
    .selectOption("staging");
  await bindingDialog
    .getByLabel("MCP 连接", { exact: true })
    .selectOption(connection.id);
  await bindingDialog
    .getByRole("checkbox", { name: /huawei_log_search/ })
    .check();
  await bindingDialog
    .getByLabel("新增资源参数路径", { exact: true })
    .fill("/project");
  await bindingDialog
    .getByLabel("新增资源标识", { exact: true })
    .fill("DEMO-LOG-STAGING");
  await bindingDialog
    .getByRole("button", { name: "添加资源锁", exact: true })
    .click();
  await bindingDialog
    .getByRole("button", { name: "确认", exact: true })
    .click();
  const binding = (await api("/bindings")).find(
    (entry: any) => entry.name === bindingName,
  );
  expect(binding).toMatchObject({
    environment: "staging",
    validationStatus: "UNVERIFIED",
    allowedTools: ["huawei_log_search"],
    lockedArguments: {
      "/environment": "staging",
      "/project": "DEMO-LOG-STAGING",
    },
  });
  const bindingCard = page.locator(".binding-grid > section").filter({
    has: page.getByRole("heading", { name: bindingName, exact: true }),
  });
  await bindingCard.getByRole("button", { name: "编辑", exact: true }).click();
  const editDialog = page.getByRole("dialog", {
    name: "修改绑定（需重新验证）",
  });
  await expect(
    editDialog.getByLabel("绑定环境", { exact: true }),
  ).toBeDisabled();
  await expect(
    editDialog.getByLabel("MCP 连接", { exact: true }),
  ).toBeDisabled();
  await editDialog
    .getByText("高级：复杂锁定参数 JSON", { exact: true })
    .click();
  await editDialog.getByLabel("锁定参数 JSON", { exact: true }).fill("{");
  await expect(
    editDialog.getByRole("button", { name: "确认", exact: true }),
  ).toBeDisabled();
  await editDialog.getByLabel("最大返回行数", { exact: true }).fill("20");
  await expect(
    editDialog.getByLabel("锁定参数 JSON", { exact: true }),
  ).toHaveValue("{");
  await expect(
    editDialog.getByRole("button", { name: "确认", exact: true }),
  ).toBeDisabled();
  await editDialog
    .getByLabel("锁定参数 JSON", { exact: true })
    .fill(JSON.stringify(binding.lockedArguments));
  await editDialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect(editDialog).toHaveCount(0);
  await bindingCard.getByRole("button", { name: "验证", exact: true }).click();
  const verification = page.getByRole("dialog", { name: "独立验证只读绑定" });
  await expect(verification).toContainText("合成 Mock");
  await verification
    .getByLabel("获准的探测工具", { exact: true })
    .selectOption("huawei_log_search");
  for (const [field, value] of Object.entries({
    question: "合成表单探测",
    orderNo: "DEMO-FORMS",
    from: "2026-10-29T00:00:00Z",
    to: "2026-10-29T00:01:00Z",
  })) {
    await verification
      .getByLabel(`探测参数 ${field}（必填）`, { exact: true })
      .fill(value);
  }
  await verification
    .getByLabel("核验范围与独立只读依据", { exact: true })
    .fill(
      "本机合成 Mock：固定 staging / DEMO-LOG-STAGING；仅验证模拟边界，不宣称真实服务端权限。",
    );
  await expect(
    verification.getByRole("button", { name: "确认", exact: true }),
  ).toBeDisabled();
  await verification
    .getByLabel("我已独立核对服务端只读权限，确认此探测在获准环境和资源范围内")
    .check();
  await verification.getByRole("button", { name: "确认", exact: true }).click();
  await expect(verification).toHaveCount(0);
  await expect(bindingCard).toContainText("MOCK_VERIFIED");
  const verified = (await api("/bindings")).find(
    (entry: any) => entry.id === binding.id,
  );
  expect(verified.validationStatus).toBe("MOCK_VERIFIED");
  expect(verified.simulationOnly).toBe(true);
  expect(verified.verification.synthetic).toBe(true);
  expect(errors).toEqual([]);
});

test("HTTP registration accepts only registered credential references and keeps protocol separate from transport", async ({
  page,
}) => {
  const api = await admin(page);
  if ((await api("/auth/state")).vaultLocked)
    await api("/vault/unlock", "POST", { password });
  expect((await api("/auth/state")).vaultLocked).toBe(false);
  const secret = await api("/secrets", "POST", {
    label: "表单合成凭据 " + randomUUID(),
    value: "Synthetic-only-form-token-never-rendered-041",
  });
  await page.goto("/connections");
  await page.getByRole("button", { name: "＋ 添加连接", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "登记 MCP 连接" });
  const name = "HTTP 仅登记合成占位 " + randomUUID();
  await dialog.getByLabel("连接名称", { exact: true }).fill(name);
  await dialog
    .getByLabel("传输方式", { exact: true })
    .selectOption("streamable_http");
  await dialog.getByLabel("协议代际", { exact: true }).selectOption("legacy");
  await dialog
    .getByLabel("精确 MCP 端点 URL", { exact: true })
    .fill("http://127.0.0.1:49999/mcp");
  const hosts = dialog.getByLabel("允许主机 1", { exact: true });
  if (!(await hosts.count()))
    await dialog
      .getByRole("button", { name: "添加允许主机", exact: true })
      .click();
  await hosts.fill("127.0.0.1");
  await dialog
    .getByLabel("HTTP Bearer 凭据引用", { exact: true })
    .selectOption(secret.id);
  await expect(dialog).not.toContainText(
    "Synthetic-only-form-token-never-rendered-041",
  );
  expect(await dialog.locator('input[type="password"]').count()).toBe(0);
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  const connection = (await api("/connections")).find(
    (entry: any) => entry.name === name,
  );
  expect(connection).toMatchObject({
    transport: "streamable_http",
    protocolEra: "legacy",
    secretRef: secret.id,
    endpoint: "http://127.0.0.1:49999/mcp",
    allowedHosts: ["127.0.0.1"],
  });
  expect(connection.command).toBeUndefined();
  expect(connection.args).toBeUndefined();
  expect(connection.mode).toBeUndefined();
  expect(connection.tools).toEqual([]);
  expect(connection.verifiedAt).toBeUndefined();
  const card = page
    .locator(".connection-grid > section")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });
  await card.getByRole("button", { name: "编辑", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "修改连接（使验证失效）" });
  await expect(edit.getByLabel("传输方式", { exact: true })).toBeDisabled();
  await edit.getByLabel("协议代际", { exact: true }).selectOption("auto");
  await edit.getByRole("button", { name: "确认", exact: true }).click();
  const updated = (await api("/connections")).find(
    (entry: any) => entry.id === connection.id,
  );
  expect(updated.transport).toBe("streamable_http");
  expect(updated.protocolEra).toBe("auto");
  expect(updated.secretRef).toBe(secret.id);
});
