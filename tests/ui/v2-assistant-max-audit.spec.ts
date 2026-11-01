import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";

// Browser contexts are isolated, but the shared daemon retains sessions until logout.
// Release only this test's session so the full suite exercises the real 64-session limit.
test.afterEach(async ({ page }) => {
  const response = await page.request.get("/api/v1/auth/session");
  if (response.ok()) {
    const csrf = (await response.json()).data.csrf;
    const closed = await page.request.delete("/api/v1/auth/session", { headers: { "X-CSRF-Token": csrf } });
    expect(closed.ok(), await closed.text()).toBeTruthy();
  }
});

type Data = Record<string, any>;
async function authenticated(page: Page) {
  const password = "Synthetic-browser-password-041";
  const initialized = (
    await (await page.request.get("/api/v1/auth/state")).json()
  ).data.initialized;
  const response = await page.request.post(
    "/api/v1/auth/" + (initialized ? "session" : "bootstrap"),
    {
      data: initialized
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
  expect(response.ok()).toBeTruthy();
  const csrf = (await response.json()).data.csrf;
  return async (path: string, method = "GET", body?: Data) => {
    const response = await page.request.fetch(path, {
      method,
      headers: { "X-CSRF-Token": csrf },
      ...(body === undefined ? {} : { data: body }),
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return (await response.json()).data;
  };
}
const sessionId = (page: Page) =>
  page.locator("#flowhub-assistant-window").getAttribute("data-session-id");
const completed = (page: Page) =>
  page.locator('.assistant-turn[data-status="COMPLETED"]');
const composer = (page: Page) => page.getByLabel("发送给助手", { exact: true });
const modelSelect = (page: Page) =>
  page.getByRole("combobox", { name: "使用模型", exact: true });
async function openFreshChat(page: Page, profile: string) {
  await page.goto("/workflows");
  await page
    .getByRole("button", { name: "打开 FlowHub 助手", exact: true })
    .click();
  await expect(page.locator(".assistant-loading")).toHaveCount(0);
  await modelSelect(page).selectOption(profile);
  const previous = await sessionId(page);
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await expect.poll(() => sessionId(page)).not.toBe(previous);
  await expect(composer(page)).toBeEnabled();
}
async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
}
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
};
function reply(res: ServerResponse, content: string, calls: Data[] = []) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [
        {
          finish_reason: calls.length ? "tool_calls" : "stop",
          message: { content, tool_calls: calls },
        },
      ],
    }),
  );
}
const call = (name: string, args: Data) => ({
  id: randomUUID(),
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const prompt = (body: Data) =>
  body.messages
    .filter(
      (m: Data) =>
        m.role === "user" && !m.content.startsWith("Selected context"),
    )
    .at(-1)?.content ?? "";
async function provider(
  handler: (body: Data, res: ServerResponse, req: IncomingMessage) => void,
) {
  const requests: Data[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const part of req) text += part;
    const body = JSON.parse(text);
    requests.push(body);
    handler(body, res, req);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    baseUrl: "http://127.0.0.1:" + (server.address() as any).port + "/v1",
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
async function profile(
  api: Awaited<ReturnType<typeof authenticated>>,
  baseUrl: string,
  name: string,
  stream = false,
) {
  return api("/api/v2/model-profiles", "POST", {
    name,
    providerKind: "openai_compatible_chat",
    baseUrl,
    model: name,
    apiKey: "synthetic-max-audit-key",
    stream,
  });
}

for (const lateReceipt of ["success", "failure"] as const) {
  test(`late A ${lateReceipt} cannot discard B's key after SSE recovery and a lost B receipt`, async ({
    page,
  }) => {
    const api = await authenticated(page),
      prefix = "max-race-" + randomUUID().slice(0, 8);
    const model = await provider((body, res) => {
      if (
        prompt(body) === "创建 B 草稿并保存" &&
        !body.messages.some((m: Data) => m.role === "tool")
      ) {
        const workflowId = prefix + "-" + randomUUID().slice(0, 8);
        reply(res, "", [
          call("workflow_draft_create", {
            workflowId,
            name: workflowId,
            environment: "test",
            mode: "auto",
            template: "blank",
            idempotencyKey: randomUUID(),
          }),
        ]);
      } else reply(res, "已处理 " + prompt(body));
    });
    const releaseA = gate(),
      aHeld = gate(),
      aDelivered = gate(),
      releaseB = gate(),
      bHeld = gate(),
      bLost = gate();
    let blockReads = false;
    const bPosts: Data[] = [];
    await page.route(
      "**/api/v2/assistant/sessions/*/conversation",
      async (route) => (blockReads ? route.abort("failed") : route.continue()),
    );
    await page.route(
      "**/api/v2/assistant/sessions/*/messages",
      async (route) => {
        const body = route.request().postDataJSON();
        if (body.text === "首轮 A") {
          const response = await route.fetch();
          aHeld.release();
          await releaseA.promise;
          if (lateReceipt === "success") await route.fulfill({ response });
          else await route.abort("failed");
          aDelivered.release();
        } else if (body.text === "创建 B 草稿并保存") {
          bPosts.push(body);
          if (bPosts.length === 1) {
            bHeld.release();
            await releaseB.promise;
            await route.fetch();
            await route.abort("failed");
            bLost.release();
          } else await route.continue();
        } else await route.continue();
      },
    );
    try {
      const selected = await profile(api, model.baseUrl, prefix);
      await openFreshChat(page, selected.id);
      const id = await sessionId(page);
      await send(page, "首轮 A");
      await aHeld.promise;
      await expect(completed(page)).toHaveCount(1);
      await expect(modelSelect(page)).toBeEnabled();
      blockReads = true;
      await send(page, "创建 B 草稿并保存");
      await bHeld.promise;
      await composer(page).fill("B 尚未确认时输入的新草稿文字");
      releaseA.release();
      await aDelivered.promise;
      await expect(
        page.locator('.assistant-turn[data-status="SUBMITTING"]'),
      ).toHaveCount(1);
      await expect(
        page.getByRole("button", { name: "发送", exact: true }),
      ).toBeDisabled();
      await expect(composer(page)).toHaveValue("B 尚未确认时输入的新草稿文字");
      releaseB.release();
      await bLost.promise;
      await expect(
        page.getByRole("button", { name: "重试发送", exact: true }),
      ).toBeEnabled();
      await expect
        .poll(
          async () =>
            (await api("/api/v2/assistant/sessions/" + id + "/tasks")).filter(
              (t: Data) =>
                t.text === "创建 B 草稿并保存" && t.status === "COMPLETED",
            ).length,
        )
        .toBe(1);
      expect(
        (await api("/api/v1/workflows")).filter((w: Data) =>
          w.id.startsWith(prefix),
        ),
      ).toHaveLength(1);
      // The retry intentionally ignores newly typed text and recovers the same request.
      await page.getByRole("button", { name: "重试发送", exact: true }).click();
      await expect.poll(() => bPosts.length).toBe(2);
      expect(bPosts[1]!.idempotencyKey).toBe(bPosts[0]!.idempotencyKey);
      expect(bPosts[1]!.text).toBe("创建 B 草稿并保存");
      blockReads = false;
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(completed(page)).toHaveCount(2);
      await expect(composer(page)).toHaveValue("B 尚未确认时输入的新草稿文字");
      expect(
        (await api("/api/v1/workflows")).filter((w: Data) =>
          w.id.startsWith(prefix),
        ),
      ).toHaveLength(1);
      expect(
        model.requests.filter((body) => prompt(body) === "创建 B 草稿并保存"),
      ).toHaveLength(2); // one tool round, one answer round
    } finally {
      releaseA.release();
      releaseB.release();
      blockReads = false;
      await page.unrouteAll({ behavior: "wait" });
      await model.close();
    }
  });
}

test("a definitive 422 releases the rejected request while preserving text and allowing a corrected model/input", async ({
  page,
}) => {
  const api = await authenticated(page),
    model = await provider((body, res) => reply(res, "回答 " + prompt(body)));
  try {
    const first = await profile(
      api,
      model.baseUrl,
      "max-reject-A-" + randomUUID().slice(0, 6),
    );
    const second = await profile(
      api,
      model.baseUrl,
      "max-reject-B-" + randomUUID().slice(0, 6),
    );
    await openFreshChat(page, first.id);
    const posts: Data[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /\/assistant\/sessions\/[^/]+\/messages$/.test(request.url())
      )
        posts.push(request.postDataJSON());
    });
    const text = "a".repeat(16001),
      response = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith("/messages"),
      );
    await send(page, text);
    expect((await response).status()).toBe(422);
    await expect(
      page.getByRole("alert").filter({ hasText: "INPUT_INVALID" }),
    ).toBeVisible();
    await expect(
      page.locator('.assistant-turn[data-status="SUBMISSION_FAILED"]'),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "重试发送", exact: true }),
    ).toHaveCount(0);
    await expect(composer(page)).toHaveValue(text);
    await expect(modelSelect(page)).toBeEnabled();
    await modelSelect(page).selectOption(second.id);
    await send(page, "解释项目");
    await expect(completed(page)).toHaveCount(1);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.text).toBe("解释项目");
    expect(posts[1]!.modelProfileId).toBe(second.id);
    expect(posts[1]!.idempotencyKey).not.toBe(posts[0]!.idempotencyKey);
    expect(model.requests).toHaveLength(1);
  } finally {
    await model.close();
  }
});

test("continue on historical cancelled A sends A's task/context and only explains its receipt after B/C", async ({
  page,
}) => {
  const api = await authenticated(page),
    prefix = "max-continue-" + randomUUID().slice(0, 7),
    workflowA = prefix + "-a",
    workflowB = prefix + "-b";
  const model = await provider((body, res) => {
    const streamedReply = (text: string, calls: Data[] = []) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        "data: " +
          JSON.stringify({
            choices: [
              {
                delta: {
                  content: text,
                  ...(calls.length
                    ? {
                        tool_calls: calls.map((tool, index) => ({
                          ...tool,
                          index,
                        })),
                      }
                    : {}),
                },
                finish_reason: calls.length ? "tool_calls" : "stop",
              },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    };
    if (prompt(body) === "修改 A 并保存草稿") {
      if (body.messages.some((m: Data) => m.role === "tool")) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          "data: " +
            JSON.stringify({
              choices: [{ delta: { content: "早期 A 的部分正文" } }],
            }) +
            "\n\n",
        );
        return; // The selected run is cancelled while this actual partial stream is open.
      }
      streamedReply("", [
        call("workflow_draft_patch", {
          workflowId: workflowA,
          expectedRevision: 1,
          idempotencyKey: randomUUID(),
          operations: [
            { op: "set_metadata", changes: { description: "A saved receipt" } },
          ],
        }),
      ]);
    } else streamedReply("回答 " + prompt(body));
  });
  try {
    const selected = await profile(api, model.baseUrl, prefix, true),
      other = await profile(api, model.baseUrl, prefix + "-other");
    for (const workflowId of [workflowA, workflowB])
      await api("/api/v2/workflows", "POST", {
        workflowId,
        name: workflowId,
        environment: "test",
        mode: "auto",
        template: "blank",
        idempotencyKey: randomUUID(),
      });
    await openFreshChat(page, selected.id);
    await page
      .getByRole("button", { name: "发送上下文与模型状态", exact: true })
      .click();
    await page.getByLabel("关联流程", { exact: true }).selectOption(workflowA);
    await send(page, "修改 A 并保存草稿");
    await expect
      .poll(
        async () =>
          (await api("/api/v2/workflows/" + workflowA + "/draft")).revision,
      )
      .toBe(2);
    await expect(
      page.getByText("早期 A 的部分正文", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "停止回复", exact: true }).click();
    const original = page.locator('.assistant-turn[data-status="CANCELLED"]');
    await expect(original).toHaveCount(1);
    const originalId = await original.getAttribute("data-task-id");
    await page.getByLabel("关联流程", { exact: true }).selectOption(workflowB);
    let laterReplies = 0;
    for (const text of ["后续 B", "后续 C"]) {
      await send(page, text);
      await expect(completed(page)).toHaveCount(++laterReplies);
      await expect(modelSelect(page)).toBeEnabled();
    }
    await expect(completed(page)).toHaveCount(2);
    const posted = page.waitForRequest(
      (request) =>
        request.method() === "POST" && request.url().endsWith("/messages"),
    );
    await original
      .getByRole("button", { name: "继续回复", exact: true })
      .click();
    const continuation = (await posted).postDataJSON();
    expect(continuation.continueTaskId).toBe(originalId);
    expect(continuation.context.workflowId).toBe(workflowA);
    expect(continuation.requestedActions).toEqual([]);
    expect(continuation.mode).toBe("help");
    await expect(completed(page)).toHaveCount(3);
    const selectedContextMessage = model.requests
      .at(-1)!
      .messages.find((m: Data) =>
        m.content?.startsWith("Selected context (data): "),
      );
    const selectedContext = JSON.parse(
      selectedContextMessage.content.slice("Selected context (data): ".length),
    );
    expect(JSON.stringify(selectedContext.previousTurnResults)).toContain(
      "早期 A 的部分正文",
    );
    expect(JSON.stringify(selectedContext.previousTurnResults)).not.toContain(
      "后续 B",
    );
    expect(JSON.stringify(selectedContext.previousTurnResults)).not.toContain(
      "后续 C",
    );
    expect(
      (await api("/api/v2/workflows/" + workflowA + "/draft")).revision,
    ).toBe(2);
    // An explicit mismatch is explained without silently switching models or submitting.
    await modelSelect(page).selectOption(other.id);
    await composer(page).fill("保留新的提问");
    const count = model.requests.length;
    await original
      .getByRole("button", { name: "继续回复", exact: true })
      .click();
    await expect(
      page.getByRole("alert").filter({ hasText: "继续此轮需要选择原模型" }),
    ).toBeVisible();
    await expect(composer(page)).toHaveValue("保留新的提问");
    expect(model.requests).toHaveLength(count);
  } finally {
    await model.close();
  }
});

test("read-only workflow status does not claim a saved draft while a real authoring patch still does", async ({
  page,
}) => {
  const api = await authenticated(page),
    workflowId = "max-status-" + randomUUID().slice(0, 8);
  await api("/api/v2/workflows", "POST", {
    workflowId,
    name: workflowId,
    environment: "test",
    mode: "auto",
    template: "blank",
    idempotencyKey: randomUUID(),
  });
  await api("/api/v2/workflows/" + workflowId + "/publish", "POST", {
    expectedRevision: 1,
    version: "1.0.0",
    expectedBindingRevisions: {},
    expectedCapabilityRevisions: {},
    idempotencyKey: randomUUID(),
  });
  const run = await api("/api/v1/runs", "POST", {
    workflowId,
    version: "1.0.0",
    mode: "auto",
    inputs: {},
    idempotencyKey: randomUUID(),
  });
  const revisionBefore = (await api("/api/v2/workflows/" + workflowId + "/draft")).revision;
  const model = await provider((body, res) => {
    if (body.messages.some((m: Data) => m.role === "tool"))
      return reply(res, "工具已完成。");
    reply(res, "", [
      prompt(body) === "读取当前运行状态"
        ? call("workflow_status", { runId: run.runId })
        : call("workflow_draft_patch", {
            workflowId,
            expectedRevision: revisionBefore,
            idempotencyKey: randomUUID(),
            operations: [
              {
                op: "set_metadata",
                changes: { description: "real authoring write" },
              },
            ],
          }),
    ]);
  });
  try {
    const selected = await profile(api, model.baseUrl, workflowId);
    await openFreshChat(page, selected.id);
    await page
      .getByRole("button", { name: "发送上下文与模型状态", exact: true })
      .click();
    await page.getByLabel("关联运行", { exact: true }).selectOption(run.runId);
    await send(page, "读取当前运行状态");
    await expect(completed(page)).toHaveCount(1);
    const read = completed(page).first();
    await expect(read.locator(".assistant-result-actions")).toHaveCount(0);
    await expect(
      read.getByRole("button", { name: "查看改动", exact: true }),
    ).toHaveCount(0);
    expect(
      (await api("/api/v2/workflows/" + workflowId + "/draft")).revision,
    ).toBe(revisionBefore);
    const task = (
      await api(
        "/api/v2/assistant/sessions/" + (await sessionId(page)) + "/tasks",
      )
    )[0];
    expect(task.tools[0].name).toBe("workflow_status");
    expect(task.tools[0].result.workflowId).toBe(workflowId);
    expect(Number.isInteger(task.tools[0].result.revision)).toBe(true);
    await send(page, "修改当前流程并保存草稿");
    await expect(completed(page)).toHaveCount(2);
    const written = completed(page).last();
    await expect(
      written.getByRole("button", { name: "查看改动", exact: true }),
    ).toBeVisible();
    await expect(
      written.getByRole("button", { name: "撤销改图", exact: true }),
    ).toBeVisible();
    await expect(written.getByText(`已保存 r${revisionBefore + 1}`, { exact: true })).toBeVisible();
    expect(
      (await api("/api/v2/workflows/" + workflowId + "/draft")).revision,
    ).toBe(revisionBefore + 1);
  } finally {
    await model.close();
  }
});

async function controlsInsideVisibleViewport(page: Page) {
  const geometry = await page.evaluate(() => {
    const visual = window.visualViewport!;
    const viewport = {
      left: visual.offsetLeft,
      top: visual.offsetTop,
      right: visual.offsetLeft + visual.width,
      bottom: visual.offsetTop + visual.height,
    };
    const panel = document
      .querySelector("#flowhub-assistant-window")!
      .getBoundingClientRect();
    const result = ["发送", "收起聊天窗口"].map((label) => {
      const el = document.querySelector<HTMLButtonElement>(
        `#flowhub-assistant-window button[aria-label="${label}"]`,
      )!;
      const box = el.getBoundingClientRect(),
        hit = document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2,
        );
      return {
        label,
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        hittable: !!hit && el.contains(hit),
      };
    });
    return {
      viewport,
      panel: {
        left: panel.left,
        top: panel.top,
        right: panel.right,
        bottom: panel.bottom,
      },
      controls: result,
    };
  });
  for (const box of [geometry.panel, ...geometry.controls]) {
    expect(box.left).toBeGreaterThanOrEqual(geometry.viewport.left - 1);
    expect(box.right).toBeLessThanOrEqual(geometry.viewport.right + 1);
    expect(box.top).toBeGreaterThanOrEqual(geometry.viewport.top - 1);
    expect(box.bottom).toBeLessThanOrEqual(geometry.viewport.bottom + 1);
  }
  for (const control of geometry.controls)
    expect(control.hittable, JSON.stringify(geometry)).toBe(true);
}

for (const scenario of [
  {
    name: "landscape single line",
    width: 844,
    height: 390,
    mobile: false,
    scale: 1,
    lines: 1,
  },
  {
    name: "short mobile multiline",
    width: 390,
    height: 350,
    mobile: true,
    scale: 1,
    lines: 10,
  },
  {
    name: "desktop real pinch 2x and pan",
    width: 1440,
    height: 900,
    mobile: false,
    scale: 2,
    lines: 10,
  },
  {
    name: "mobile real pinch 2x and pan",
    width: 390,
    height: 844,
    mobile: true,
    scale: 2,
    lines: 10,
  },
  {
    name: "desktop real pinch 3x and pan",
    width: 1440,
    height: 900,
    mobile: false,
    scale: 3,
    lines: 10,
  },
]) {
  test(`assistant controls remain visible and clickable on both sides: ${scenario.name}`, async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      baseURL: String(testInfo.project.use.baseURL),
      viewport: { width: scenario.width, height: scenario.height },
      isMobile: scenario.mobile,
      hasTouch: true,
    });
    const page = await context.newPage(),
      api = await authenticated(page),
      model = await provider((_body, res) => reply(res, "可视区合成回复"));
    try {
      await page.bringToFront();
      const selected = await profile(
        api,
        model.baseUrl,
        "viewport-" + randomUUID().slice(0, 8),
      );
      await openFreshChat(page, selected.id);
      await page
        .getByRole("button", { name: "收起聊天窗口", exact: true })
        .click();
      const cdp = await context.newCDPSession(page);
      if (scenario.scale > 1) {
        await cdp.send("Emulation.setPageScaleFactor", {
          pageScaleFactor: scenario.scale,
        });
        await expect
          .poll(() => page.evaluate(() => visualViewport!.width))
          .toBeCloseTo(scenario.width / scenario.scale, 0);
        const gesture = await page.evaluate(() => ({
          x: visualViewport!.width * 0.75,
          y: visualViewport!.height * 0.35,
        }));
        // Dispatch actual touch input. Chromium's synthetic scroll command can
        // scroll a document/container without panning its zoomed visual viewport.
        await cdp.send("Input.dispatchTouchEvent", { type:"touchStart", touchPoints:[gesture] });
        for(let step=1;step<=12;step++) {
          await cdp.send("Input.dispatchTouchEvent", { type:"touchMove", touchPoints:[{x:gesture.x-50*step/12,y:gesture.y-40*step/12}] });
          // Pace input in the test process: a backgrounded headless page may
          // suspend requestAnimationFrame indefinitely during a touch gesture.
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await cdp.send("Input.dispatchTouchEvent", { type:"touchEnd", touchPoints:[] });
        await expect
          .poll(() =>
            page.evaluate(
              () => visualViewport!.offsetLeft + visualViewport!.offsetTop,
            ),
          )
          .toBeGreaterThan(0);
      }
      let answers = 0;
      for (const side of ["left", "right"] as const) {
        const launcher = page.getByRole("button", {
          name: "打开 FlowHub 助手",
          exact: true,
        });
        await launcher.focus();
        await launcher.press(side === "left" ? "ArrowLeft" : "ArrowRight");
        await launcher.click();
        await expect(page.locator("#flowhub-assistant-window")).toBeVisible();
        await composer(page).fill(
          Array.from(
            { length: scenario.lines },
            (_, index) => `${side} 可视区输入 ${index + 1}`,
          ).join("\n"),
        );
        await expect
          .poll(async () => {
            try {
              await controlsInsideVisibleViewport(page);
              return true;
            } catch {
              return false;
            }
          })
          .toBe(true);
        await controlsInsideVisibleViewport(page);
        await page.getByRole("button", { name: "发送", exact: true }).click();
        await expect(completed(page)).toHaveCount(++answers);
        await composer(page).fill("收起后保留的草稿 " + side);
        await page
          .getByRole("button", { name: "收起聊天窗口", exact: true })
          .click();
        await expect(page.locator("#flowhub-assistant-window")).toBeHidden();
        await page
          .getByRole("button", { name: "打开 FlowHub 助手", exact: true })
          .click();
        await expect(composer(page)).toHaveValue("收起后保留的草稿 " + side);
        await page
          .getByRole("button", { name: "收起聊天窗口", exact: true })
          .click();
      }
      expect(model.requests).toHaveLength(2);
      await cdp.detach();
    } finally {
      await context.close();
      await model.close();
    }
  });
}
