import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("cleanup preview shows every result-copy scope and submits only the reviewed hash", async ({
  page,
}) => {
  const initialized = (
    await (await page.request.get("/api/v1/auth/state")).json()
  ).data.initialized;
  const password = "Synthetic-browser-password-041";
  const login = await page.request.post(
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
  expect(login.ok()).toBe(true);
  // This is an injected preview for UI scope/confirmation coverage. The SQLite
  // cleanup and backup behavior is exercised independently by retention-copies.
  let preview: {runs:string[];resultRuns:string[];checkpoints:string[];artifacts:string[];hash:string;[key:string]:string|string[]|number[]} = {
    runs: ["run-metadata-expired"],
    resultRuns: ["run-results-expired", "run-derived-results-expired"],
    checkpoints: ["run-terminal-checkpoint"],
    artifacts: [
      "artifact-expired-1",
      "artifact-expired-2",
      "artifact-expired-3",
    ],
    hash: "synthetic-reviewed-preview-hash",
  };
  await page.route("**/api/v1/retention/preview", (route) =>
    route.fulfill({ json: { data: preview } }),
  );
  let submitted: unknown;
  await page.route("**/api/v1/retention/commit", async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({
      json: {
        data: {
          deletedRuns: preview.runs.length,
          deletedArtifacts: preview.artifacts.length,
          expiredResultRuns: preview.resultRuns.length,
          clearedCheckpoints: preview.checkpoints.length,
          ...(preview.hash==="v2-only-reviewed-hash"?{expiredAssistantTasks:1,deletedAssistantTasks:1,expiredTestRuns:1,deletedTestRuns:1,expiredLegacyAssistantMessages:1}:{}),
        },
      },
    });
  });
  await page.goto("/settings");
  await page.getByRole("button", { name: "预览清理范围", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "数据保留与清理预览" });
  await expect(dialog).toContainText("原始结果与副本：2 个运行");
  await expect(dialog).toContainText("遗留检查点：1 个运行");
  await expect(dialog).toContainText("运行元数据：1 个运行");
  await expect(dialog).toContainText("产物：3 份");
  await expect(dialog).toContainText("业务输入与运行元数据保留 30 天");
  await expect(dialog).toContainText("助手正文到期：0 个任务、0 条消息、0 份工具收据、0 个会话");
  await expect(dialog).toContainText("已有备份独立保留");
  await dialog.getByText("查看清理对象 ID", { exact: true }).click();
  for (const id of [
    ...preview.runs,
    ...preview.resultRuns,
    ...preview.checkpoints,
    ...preview.artifacts,
  ])
    await expect(dialog.locator("pre")).toContainText(id);
  await dialog.getByRole("button", { name: "确认清理", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "预览清理范围", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("status")).toContainText(
    "清理完成：2 个运行的原始结果，3 份产物，1 个运行的元数据",
  );
  expect(submitted).toEqual({ previewHash: preview.hash });
  await expect(page.getByRole("status")).not.toContainText("undefined");

  preview = {
    runs:[],resultRuns:[],checkpoints:[],artifacts:[],
    assistantResultTasks:["task-result"],assistantResultMessages:["message-result"],assistantLegacyResultMessages:["legacy-message-result"],assistantResultToolCalls:["call-result"],assistantResultSessions:["session-result"],
    assistantTasks:["task-metadata"],assistantMessages:["message-metadata"],assistantToolCalls:["call-metadata"],assistantSessions:["session-metadata"],
    workflowTestResultRuns:["test-result"],workflowTestRuns:["test-metadata"],applicationResultEvents:[9001],applicationEvents:[9002],hash:"v2-only-reviewed-hash",
  };
  await page.getByRole("button", { name: "预览清理范围", exact: true }).click();
  await expect(dialog).toContainText("助手正文到期：1 个任务、1 条消息、1 份工具收据、1 个会话");
  await expect(dialog).toContainText("来源到期会话中的历史未归属消息正文：1 条");
  await expect(dialog).toContainText("即使该消息刚刚创建");
  await expect(dialog).toContainText("助手元数据删除：1 个任务、1 条消息、1 份工具收据、1 个会话");
  await expect(dialog).toContainText("自测：1 份结果到期、1 条元数据删除");
  await expect(dialog).toContainText("应用事件：1 份正文到期、1 条元数据删除");
  await expect(dialog).toContainText("已保存的测试套件配置、发布版本与能力修订不受影响");
  await dialog.getByText("查看清理对象 ID", { exact: true }).click();
  for(const value of Object.values(preview))if(Array.isArray(value))for(const id of value)await expect(dialog.locator("pre")).toContainText(String(id));
  await expect(dialog.getByRole("button", { name: "确认清理", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "确认清理", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(submitted).toEqual({ previewHash: "v2-only-reviewed-hash" });
  await expect(page.getByRole("status")).toContainText("助手任务 1 份正文到期、1 条元数据删除，自测 1 份结果到期、1 条元数据删除");
  await expect(page.getByRole("status")).toContainText("历史未归属消息 1 条正文到期");

  preview = {
    runs: [],
    resultRuns: [],
    checkpoints: [],
    artifacts: [],
    assistantResultTasks:[],assistantResultMessages:[],assistantLegacyResultMessages:[],assistantResultToolCalls:[],assistantResultSessions:[],
    assistantTasks:[],assistantMessages:[],assistantToolCalls:[],assistantSessions:[],workflowTestResultRuns:[],workflowTestRuns:[],applicationResultEvents:[],applicationEvents:[],
    hash: "empty-preview",
  };
  await page.getByRole("button", { name: "预览清理范围", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "确认清理", exact: true }),
  ).toBeDisabled();
});
