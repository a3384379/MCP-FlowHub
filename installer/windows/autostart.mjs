import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const taskScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
$name = 'MCP-FlowHub-' + $env:FLOWHUB_TASK_KEY + '-' + $sid
$marker = 'MCP FlowHub current-user autostart ' + $env:FLOWHUB_TASK_KEY
$path = '\'
$task = Get-ScheduledTask | Where-Object { $_.TaskPath -eq $path -and $_.TaskName -eq $name }
if ($task) {
  $taskIdentity = $task.Principal.UserId
  if ($taskIdentity -ne $sid) {
    try { $taskIdentity = [System.Security.Principal.NTAccount]::new($taskIdentity).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
  }
  $ownsTask = $task.Description -eq $marker -and $taskIdentity -eq $sid -and $task.Actions.Count -eq 1 -and
    $task.Actions[0].Execute -eq $env:FLOWHUB_TASK_NODE -and
    $task.Actions[0].WorkingDirectory -eq $env:FLOWHUB_TASK_PROGRAM -and
    $task.Actions[0].Arguments -match ('^' + [regex]::Escape($env:FLOWHUB_TASK_ARGUMENTS) + ' [0-9]{1,5}$')
  if (-not $ownsTask) {
    [ordered]@{ state = 'different_installation'; taskName = $name } | ConvertTo-Json -Compress
    exit
  }
}
switch ($env:FLOWHUB_TASK_ACTION) {
  'enable' {
    $account = $identity.Name
    $principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $account
    $action = New-ScheduledTaskAction -Execute $env:FLOWHUB_TASK_NODE -Argument ($env:FLOWHUB_TASK_ARGUMENTS + ' ' + $env:FLOWHUB_TASK_PORT) -WorkingDirectory $env:FLOWHUB_TASK_PROGRAM
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $task = Register-ScheduledTask -TaskName $name -TaskPath $path -Description $marker -Trigger $trigger -Principal $principal -Action $action -Settings $settings -Force:([bool]$task)
    [ordered]@{ state = 'registered'; taskName = $name; schedulerState = [string]$task.State } | ConvertTo-Json -Compress
  }
  'disable' {
    if ($task) { Unregister-ScheduledTask -TaskName $name -TaskPath $path -Confirm:$false }
    [ordered]@{ state = 'disabled'; taskName = $name } | ConvertTo-Json -Compress
  }
  'status' {
    if ($task) {
      $info = Get-ScheduledTaskInfo -TaskName $name -TaskPath $path
      [ordered]@{ state = 'registered'; taskName = $name; schedulerState = [string]$task.State; lastTaskResult = $info.LastTaskResult } | ConvertTo-Json -Compress
    } else {
      [ordered]@{ state = 'disabled'; taskName = $name } | ConvertTo-Json -Compress
    }
  }
}
`;

function localWindowsDirectory(path) {
  if (
    typeof path !== "string" ||
    !/^[a-z]:[\\/]/i.test(path) ||
    /[<>|"*?\x00-\x1f]/.test(path)
  )
    throw new Error(
      "PLUGIN_AUTOSTART_PATH: use an absolute local Windows directory.",
    );
  const normalized = win32.normalize(path).replace(/\\+$/, "");
  if (
    normalized.length <= 2 ||
    normalized
      .split("\\")
      .slice(1)
      .some((part) => /[: .]$/.test(part) || part.includes(":"))
  )
    throw new Error(
      "PLUGIN_AUTOSTART_PATH: use a regular program and data directory below a drive root.",
    );
  return normalized;
}

export function taskDefinition({ programDir, dataDir, port = "18473" }) {
  const program = localWindowsDirectory(programDir),
    data = localWindowsDirectory(dataDir);
  const programKey = program.toLowerCase(),
    dataKey = data.toLowerCase();
  if (
    programKey === dataKey ||
    programKey.startsWith(dataKey + "\\") ||
    dataKey.startsWith(programKey + "\\")
  )
    throw new Error(
      "PLUGIN_AUTOSTART_PATH: program and data directories must be independent.",
    );
  if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error("PLUGIN_AUTOSTART_PORT: choose a port from 1 to 65535.");
  return {
    key: createHash("sha256")
      .update(data.toLowerCase())
      .digest("hex")
      .slice(0, 20),
    node: win32.join(program, "runtime", "node.exe"),
    program,
    argumentsPrefix:
      '"' +
      win32.join(program, "dist", "apps", "daemon", "src", "cli.js") +
      '" serve --data-dir "' +
      data +
      '" --port',
    port: String(port),
  };
}

export async function windowsAutostart(action, options, run = exec) {
  if (process.platform !== "win32" && run === exec)
    return { state: "unsupported_platform" };
  if (!["enable", "disable", "status"].includes(action))
    throw new Error("PLUGIN_AUTOSTART_INPUT: use enable, disable or status.");
  const task = taskDefinition(options);
  const powershell = win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  let output;
  try {
    const execution = run(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", taskScript],
      {
        timeout: 20000,
        windowsHide: true,
        env: {
          ...process.env,
          FLOWHUB_TASK_ACTION: action,
          FLOWHUB_TASK_KEY: task.key,
          FLOWHUB_TASK_NODE: task.node,
          FLOWHUB_TASK_PROGRAM: task.program,
          FLOWHUB_TASK_ARGUMENTS: task.argumentsPrefix,
          FLOWHUB_TASK_PORT: task.port,
        },
      },
    );
    execution.child?.stdin?.end();
    output = JSON.parse((await execution).stdout.trim());
  } catch (error) {
    const diagnostic = String(error.stderr || error.message)
      .trim()
      .split(/\r?\n/)
      .slice(0, 3)
      .join(" ")
      .slice(0, 600);
    throw new Error(
      "PLUGIN_AUTOSTART_FAILED: " + diagnostic + " 可使用前台 start 启动。",
    );
  }
  if (output?.state === "different_installation" && action === "enable")
    throw new Error(
      "PLUGIN_AUTOSTART_CONFLICT: 此数据目录已有其他安装的启动任务。请从原安装入口关闭后再登记。",
    );
  return output;
}
