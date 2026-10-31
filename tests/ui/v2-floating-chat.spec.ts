import { test, expect } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

async function fixture(
  page: any,
  respond: (body: any, res: ServerResponse, count: number) => void,
) {
  const password = "Synthetic-browser-password-041",
    state = (await (await page.request.get("/api/v1/auth/state")).json()).data;
  const auth = await page.request.post(
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
  expect(auth.ok()).toBeTruthy();
  const csrf = (await auth.json()).data.csrf;
  const api = async (path: string, method = "GET", data?: any) => {
    const response = await page.request.fetch(path, {
      method,
      headers: { "X-CSRF-Token": csrf },
      ...(data === undefined ? {} : { data }),
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return (await response.json()).data;
  };
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const part of req) text += part;
    const body = JSON.parse(text);
    requests.push(body);
    respond(body, res, requests.length);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const profile = await api("/api/v2/model-profiles", "POST", {
    name: "悬浮聊天验证 " + randomUUID().slice(0, 5),
    providerKind: "openai_compatible_chat",
    baseUrl: "http://127.0.0.1:" + (server.address() as any).port + "/v1",
    model: "synthetic-chat",
    apiKey: "synthetic-floating-chat-key",
    stream: true,
  });
  const open = async () => {
    await page
      .getByRole("button", { name: "打开 FlowHub 助手", exact: true })
      .click();
    await expect(page.getByLabel("使用模型", { exact: true })).toBeVisible();
    await expect(page.locator(".assistant-loading")).toHaveCount(0);
  };
  await page.goto("/connections");
  await open();
  const before = await page
    .getByRole("region", { name: "FlowHub 助手聊天窗口" })
    .getAttribute("data-session-id");
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await expect
    .poll(() =>
      page
        .getByRole("region", { name: "FlowHub 助手聊天窗口" })
        .getAttribute("data-session-id"),
    )
    .not.toBe(before);
  await page.getByLabel("使用模型", { exact: true }).selectOption(profile.id);
  return {
    api,
    requests,
    open,
    profile,
    close: async () => {
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections();
      await closed;
    },
  };
}
const textResponse = (res: ServerResponse, content: string) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(
    "data: " +
      JSON.stringify({
        choices: [{ delta: { content }, finish_reason: "stop" }],
      }) +
      "\n\ndata: [DONE]\n\n",
  );
};
const turns = (page: any, status: string) =>
  page.locator(`.assistant-turn[data-status="${status}"]`);

test("floating chat sends one question per turn, renders safe Markdown, retains drafts across routes and supports follow-up", async ({
  page,
}) => {
  const f = await fixture(page, (_body, res, count) =>
    textResponse(
      res,
      count === 1
        ? "**当前目录尚未扫描。**\n\n这是示例模型依据真实上下文的回复。\n\n[危险链接](javascript:alert(1))\n\n<img src=x onerror=alert(1)>"
        : "**不会修改源配置。**\n\n继续上一轮的 MCP 问题。",
    ),
  );
  try {
    await expect(page.getByLabel("助手模式")).toHaveCount(0);
    const input = page.getByLabel("发送给助手");
    await input.fill("当前 MCP 有哪些？");
    await input.press("Shift+Enter");
    expect(await input.inputValue()).toContain("\n");
    await input.evaluate((el) =>
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(f.requests).toHaveLength(0);
    await input.press("Enter");
    await expect(turns(page, "COMPLETED")).toHaveCount(1);
    await expect(page.locator(".assistant-markdown strong").first()).toHaveText(
      "当前目录尚未扫描。",
    );
    await expect(
      page.locator('.assistant-markdown a[href^="javascript:"]'),
    ).toHaveCount(0);
    await expect(page.locator(".assistant-markdown img")).toHaveCount(0);
    await expect(page.locator(".assistant-activity[open]")).toHaveCount(0);
    await input.fill("这会影响现有配置吗？");
    await page
      .getByRole("button", { name: "收起聊天窗口", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "FlowHub 助手聊天窗口" }),
    ).toBeHidden();
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await f.open();
    await expect(input).toHaveValue("这会影响现有配置吗？");
    await input.press("Enter");
    await expect(turns(page, "COMPLETED")).toHaveCount(2);
    expect(f.requests).toHaveLength(2);
    const context = JSON.parse(
      f.requests[0].messages[1].content.slice(
        "Selected context (data): ".length,
      ),
    );
    expect(context.projectState.status).toBe("checked");
    expect(JSON.stringify(f.requests[1].messages)).toContain(
      "当前 MCP 有哪些？",
    );
    await mkdir("docs/evidence/v2/chat", { recursive: true });
    await page.screenshot({ path: "docs/evidence/v2/chat/desktop.png" });
    for (const [width, height] of [
      [1366, 768],
      [390, 844],
      [320, 720],
    ] as const) {
      await page.setViewportSize({ width, height });
      // visualViewport resize is delivered asynchronously; wait for the new
      // visible rectangle while keeping all three original bounds assertions.
      await expect.poll(async () => page
        .getByRole("region", { name: "FlowHub 助手聊天窗口" })
        .evaluate((el) => {
          const r = el.getBoundingClientRect(),
            input = el.querySelector(".assistant-composer")!.getBoundingClientRect();
          return {
            widthFits: document.documentElement.scrollWidth <= innerWidth + 1,
            panelFits: r.bottom <= innerHeight + 1,
            composerFits: input.bottom <= innerHeight + 1,
          };
        })).toEqual({ widthFits: true, panelFits: true, composerFits: true });
      if (width === 390)
        await page.screenshot({ path: "docs/evidence/v2/chat/mobile.png" });
    }
    await input.press("Escape");
    await expect(
      page.getByRole("button", { name: "打开 FlowHub 助手", exact: true }),
    ).toBeFocused();
  } finally {
    await f.close();
  }
});

test("minimizing leaves a real streaming request active; stop and refresh preserve partial answer", async ({
  page,
}) => {
  const f = await fixture(page, (_body, res, count) => {
    if (count > 1) {
      textResponse(res, "已根据上一轮回执继续说明。");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      "data: " +
        JSON.stringify({
          choices: [
            {
              delta: { content: "已经输出的真实流式片段。" },
              finish_reason: null,
            },
          ],
        }) +
        "\n\n",
    );
  });
  try {
    await page.getByLabel("发送给助手").fill("解释当前目录");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".assistant-markdown")).toContainText(
      "已经输出的真实流式片段。",
    );
    const session = await page
      .getByRole("region", { name: "FlowHub 助手聊天窗口" })
      .getAttribute("data-session-id");
    await page
      .getByRole("button", { name: "收起聊天窗口", exact: true })
      .click();
    expect(
      (await f.api("/api/v2/assistant/sessions/" + session + "/tasks")).at(-1)
        .status,
    ).toBe("GENERATING");
    await f.open();
    await page.getByRole("button", { name: "停止回复", exact: true }).click();
    await expect(turns(page, "CANCELLED")).toHaveCount(1);
    await page.reload();
    await f.open();
    await expect(turns(page, "CANCELLED")).toHaveCount(1);
    await expect(page.locator(".assistant-markdown")).toHaveText(
      "已经输出的真实流式片段。",
    );
    expect(f.requests).toHaveLength(1);
    await page.getByRole("button", { name: "继续回复", exact: true }).click();
    await expect(turns(page, "COMPLETED")).toHaveCount(1);
    expect(f.requests).toHaveLength(2);
    expect(
      f.requests[1].tools.some((t: any) =>
        [
          "workflow_draft_patch",
          "workflow_start",
          "workflow_draft_create",
        ].includes(t.function.name),
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

test("lost acceptance retries the original idempotency key without a second draft write or model loop", async ({
  page,
}) => {
  const workflowId = "floating-retry-" + randomUUID().slice(0, 8),
    sent: any[] = [];
  const f = await fixture(page, (body, res) => {
    if (body.messages.some((m: any) => m.role === "tool")) {
      textResponse(res, "已根据工具回执保存。");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      "data: " +
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "one-write",
                    type: "function",
                    function: {
                      name: "workflow_draft_create",
                      arguments: JSON.stringify({
                        workflowId,
                        name: "重试验证",
                        environment: "test",
                        mode: "auto",
                        template: "blank",
                        idempotencyKey: workflowId,
                      }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  let blockReads = true;
  try {
    await page.route(
      "**/api/v2/assistant/sessions/*/conversation",
      async (route) => {
        if (blockReads) await route.abort("failed");
        else await route.continue();
      },
    );
    await page.route(
      "**/api/v2/assistant/sessions/*/messages",
      async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        sent.push(route.request().postDataJSON());
        if (sent.length === 1) {
          await route.fetch();
          await route.abort("failed");
        } else {
          blockReads = false;
          await route.continue();
        }
      },
    );
    await page
      .getByLabel("发送给助手")
      .fill("创建一个流程并保存，不发布不运行");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "重试发送", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "重试发送", exact: true }).click();
    await expect(turns(page, "COMPLETED")).toHaveCount(1);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual(sent[1]);
    expect(f.requests).toHaveLength(2);
    const draft = await f.api("/api/v2/workflows/" + workflowId + "/draft");
    expect(draft.revision).toBe(1);
    expect(draft.id).toBe(workflowId);
  } finally {
    blockReads = false;
    await f.close();
  }
});

test("missing-model chat retains local help and does not send a fabricated answer", async ({
  page,
}) => {
  const f = await fixture(page, (_body, res) =>
    textResponse(res, "must not be called"),
  );
  try {
    await page.route("**/api/v2/model-profiles", async (route) => {
      if (route.request().method() === "GET")
        await route.fulfill({ json: { data: [] } });
      else await route.continue();
    });
    await page.reload();
    await f.open();
    await page.getByLabel("发送给助手").fill("workflow_draft_create");
    await expect(
      page.getByRole("button", { name: "发送", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "检索本地帮助", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "本地资料检索" }),
    ).toContainText("workflow_draft_create");
    expect(f.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("assistant launcher drags with mouse and touch, docks at either edge, persists and keeps the same conversation", async ({
  page,
}) => {
  const f = await fixture(page, (_body, res) =>
    textResponse(res, "No model call expected."),
  );
  try {
    const window = page.getByRole("region", { name: "FlowHub 助手聊天窗口" }),
      root = page.locator(".assistant-launcher-position"),
      launcher = page.getByRole("button", {
        name: "打开 FlowHub 助手",
        exact: true,
      });
    const session = await window.getAttribute("data-session-id");
    await page
      .getByRole("button", { name: "收起聊天窗口", exact: true })
      .click();
    const dragTo = async (x: number, y: number) => {
      const r = (await launcher.boundingBox())!;
      await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
      await page.mouse.down();
      await page.mouse.move(x, y, { steps: 8 });
      await page.mouse.up();
    };
    await dragTo(30, 220);
    await expect(root).toHaveAttribute("data-side", "left");
    await expect(window).toBeHidden();
    const moved = (await root.boundingBox())!;
    expect(moved.y).toBeGreaterThan(150);
    expect(moved.y).toBeLessThan(250);
    await page
      .getByRole("button", { name: "将助手图标贴边收起", exact: true })
      .click();
    expect((await root.boundingBox())!.width).toBeLessThanOrEqual(24);
    expect((await root.boundingBox())!.x).toBe(0);
    await dragTo(1430, 450);
    await expect(root).toHaveAttribute("data-side", "right");
    await expect(root).toHaveClass(/is-docked/);
    await expect(window).toBeHidden();
    await mkdir("output/playwright/assistant-launcher", { recursive: true });
    await page.screenshot({
      path: "output/playwright/assistant-launcher/desktop-docked.png",
    });
    await page.reload();
    await expect(root).toHaveAttribute("data-side", "right");
    await expect(root).toHaveClass(/is-docked/);
    const before = (await root.boundingBox())!.y;
    await launcher.focus();
    await page.keyboard.press("ArrowUp");
    expect((await root.boundingBox())!.y).toBeLessThan(before);
    await page.keyboard.press("ArrowLeft");
    await expect(root).toHaveAttribute("data-side", "left");
    await launcher.click();
    await expect(window).toHaveAttribute("data-session-id", session!);
    expect((await window.boundingBox())!.x).toBeLessThan(50);
    await page
      .getByRole("button", { name: "收起聊天窗口", exact: true })
      .click();
    await page
      .getByRole("button", { name: "展开助手图标", exact: true })
      .click();
    expect((await root.boundingBox())!.width).toBeGreaterThan(40);
    await page.setViewportSize({ width: 320, height: 568 });
    await page
      .getByRole("button", { name: "将助手图标贴边收起", exact: true })
      .click();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    const r = (await launcher.boundingBox())!,
      touch = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [touch],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 306, y: 300 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(root).toHaveAttribute("data-side", "right");
    await expect(window).toBeHidden();
    const saved = await page.evaluate(() =>
      localStorage.getItem("flowhub.assistant.launcher.v1"),
    );
    const final = (await launcher.boundingBox())!;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: final.x + 10, y: final.y + 10 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 20, y: 150 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchCancel",
      touchPoints: [],
    });
    await expect(root).toHaveAttribute("data-side", "right");
    expect(
      await page.evaluate(() =>
        localStorage.getItem("flowhub.assistant.launcher.v1"),
      ),
    ).toBe(saved);
    await cdp.detach();
    const box = (await root.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(box.y + box.height).toBeLessThanOrEqual(568);
    await page.screenshot({
      path: "output/playwright/assistant-launcher/mobile-docked.png",
    });
    await page.setViewportSize({ width: 320, height: 300 });
    await expect
      .poll(async () => {
        const resized = (await root.boundingBox())!;
        return resized.y >= 0 && resized.y + resized.height <= 300;
      })
      .toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(f.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
});
