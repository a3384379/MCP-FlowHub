import { ensure, type Json } from "../../contracts/src/domain.js";

// Conservative recognition of explicit authentication configuration, not a
// universal secret detector. Secret values belong in Vault references.
const authName =
  /^(?:api[-_]?key|x[-_]?api[-_]?key|(?:access|refresh|auth|bearer|id)[-_]?token|token|secret|client[-_]?secret|password|passwd|pwd|authorization|cookie|credentials?|auth|key|sig|signature|x-amz-(?:signature|credential))$/i;
const decode = (text: string) => {
  try {
    for (let i = 0; i < 8; i++) {
      const next = decodeURIComponent(text);
      if (next === text) break;
      text = next;
    }
  } catch {
    /* Keep the last decodable form. */
  }
  return text;
};
export function hasPlaintextCredentials(c: Json): boolean {
  if (
    c.secretRef &&
    (typeof c.secretRef !== "string" ||
      !/^secret_[0-9a-f]{32}$/.test(c.secretRef))
  )
    return true;
  if (
    c.envRefs &&
    Object.values(c.envRefs).some(
      (ref) => typeof ref !== "string" || !/^secret_[0-9a-f]{32}$/.test(ref),
    )
  )
    return true;
  if (typeof c.endpoint === "string") {
    try {
      const url = new URL(c.endpoint);
      if (url.username || url.password) return true;
      for (const key of url.searchParams.keys())
        if (authName.test(decode(key))) return true;
    } catch {
      /* Invalid endpoints are rejected by transport validation. */
    }
  }
  return (c.args ?? []).some((arg: unknown) => {
    if (typeof arg !== "string") return true;
    const text = decode(arg);
    if (authName.test(text.replace(/^--?/, "").split(/[=:]/, 1)[0]!))
      return true;
    if (
      /(?:^|[\s?&{,])["']?(?:--?)?(?:api[-_]?key|access[-_]?token|token|password|client[-_]?secret|authorization|cookie)["']?\s*[:=]/i.test(
        text,
      )
    )
      return true;
    if (/^(?:Bearer|Basic)\s+\S+/i.test(text)) return true;
    for (const url of text.match(/https?:\/\/[^\s"']+/gi) ?? [])
      if (hasPlaintextCredentials({ endpoint: url })) return true;
    try {
      return hasPlaintextCredentials({ endpoint: text });
    } catch {
      return false;
    }
  });
}
export function assertConnectionCredentials(c: Json) {
  ensure(
    !hasPlaintextCredentials(c),
    "PLAINTEXT_CREDENTIAL_DENIED",
    "Authentication in endpoint query parameters or command arguments is unsupported. Store credentials in Vault and use secretRef/envRefs.",
  );
}
export function safeConnectionView(c: Json): Json {
  const { quarantinedConfiguration, ...safe } = c;
  if (!hasPlaintextCredentials(c) && !c.configurationWarning) return safe;
  return {
    id: c.id,
    name: "已隔离的旧连接",
    revision: c.revision,
    transport: c.transport,
    protocolEra: c.protocolEra,
    endpoint: "",
    args: [],
    allowedHosts: [],
    tools: [],
    disabled: true,
    configurationWarning:
      "PLAINTEXT_CREDENTIAL_DENIED: legacy configuration withheld; unlock Vault, replace with secretRef/envRefs, then reverify bindings.",
  };
}
