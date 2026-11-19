import { join, resolve } from "node:path";
import { execWithoutInput } from "../installer/windows/install-helper.mjs";

function runZip(command, archive, directory, timeout) {
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; " + command;
  return execWithoutInput(
    powershell,
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    {
      env: {
        ...process.env,
        FLOWHUB_ZIP_ARCHIVE: resolve(archive),
        FLOWHUB_ZIP_DIRECTORY: resolve(directory),
      },
      windowsHide: true,
      timeout,
    },
  );
}

export function createWindowsZip(directory, archive) {
  return runZip(
    "[System.IO.Compression.ZipFile]::CreateFromDirectory($env:FLOWHUB_ZIP_DIRECTORY,$env:FLOWHUB_ZIP_ARCHIVE,[System.IO.Compression.CompressionLevel]::Optimal,$true)",
    archive,
    directory,
    120_000,
  );
}

export function extractWindowsZip(archive, directory) {
  return runZip(
    "[System.IO.Compression.ZipFile]::ExtractToDirectory($env:FLOWHUB_ZIP_ARCHIVE,$env:FLOWHUB_ZIP_DIRECTORY)",
    archive,
    directory,
    120_000,
  );
}
