// Keep the normal Windows process environment while isolating application tools
// and excluding CI credentials, provider keys and Node runtime injection flags.
export function windowsTestEnvironment(runtimeDirectory, input = process.env) {
  const keys = [
    "ALLUSERSPROFILE", "APPDATA", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432",
    "COMPUTERNAME", "ComSpec", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "LOGONSERVER",
    "NUMBER_OF_PROCESSORS", "OS", "PATHEXT", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER",
    "PROCESSOR_LEVEL", "PROCESSOR_REVISION", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
    "ProgramW6432", "PUBLIC", "SESSIONNAME", "SystemDrive", "SystemRoot", "TEMP", "TMP",
    "USERDOMAIN", "USERDOMAIN_ROAMINGPROFILE", "USERNAME", "USERPROFILE", "WINDIR",
  ];
  const source = new Map(Object.entries(input).map(([key, value]) => [key.toUpperCase(), value]));
  return { ...Object.fromEntries(keys.flatMap(key => source.has(key.toUpperCase()) ? [[key, source.get(key.toUpperCase())]] : [])), PATH: runtimeDirectory };
}
