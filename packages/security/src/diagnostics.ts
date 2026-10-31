import type { Json } from "../../contracts/src/domain.js";

// Only for connection/catalog/diagnostic boundaries. Never apply to run business data.
export function protectDiagnostic(
  value: Json,
  secrets: readonly string[] = [],
): Json {
  // Known credentials are literal matches, never executable regular expressions.
  // Keep this context local to one operation; callers must not persist it.
  const literals = [
    ...new Set(
      secrets
        .filter((s) => s.length > 0)
        .flatMap((s) => [s, encodeURIComponent(s)]),
    ),
  ].sort((a, b) => b.length - a.length);
  const known = literals.length
    ? new RegExp(
        literals.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
        "g",
      )
    : undefined;
  const redactPrivateKeys = (text: string): string => {
    const begin = /-----BEGIN ((?:[A-Z0-9]+ )?PRIVATE KEY)-----/g;
    let result = "",
      offset = 0;
    for (let match = begin.exec(text); match; match = begin.exec(text)) {
      result += text.slice(offset, match.index) + "[REDACTED PRIVATE KEY]";
      const end = text.indexOf(
        "-----END " + match[1] + "-----",
        begin.lastIndex,
      );
      // Incomplete private keys are sensitive too. Consume the remainder once
      // instead of retrying every BEGIN against the same unbounded suffix.
      if (end === -1) return result;
      offset = end + ("-----END " + match[1] + "-----").length;
      begin.lastIndex = offset;
    }
    return result + text.slice(offset);
  };
  const cleanString = (text: string): string => {
    const result = known ? text.replace(known, "[REDACTED]") : text;
    return (
      redactPrivateKeys(result)
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi, "$1 [REDACTED]")
        // Consume the start boundary and the entire authority even without an @.
        // A dotted token is inspected once, never retried at each word boundary.
        .replace(
          /(^|[^a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)([^\s\/?#<>]*)/gi,
          (_match, prefix: string, scheme: string, authority: string) => {
            const at = authority.lastIndexOf("@");
            return (
              prefix +
              scheme +
              (at < 0 ? authority : "[REDACTED]@" + authority.slice(at + 1))
            );
          },
        )
        .replace(
          /(\b(?:password|passwd|pwd|api[_-]?key|x-api-key|client[_-]?secret|access[_-]?token|refresh[_-]?token|secret[_-]?access[_-]?key|access[_-]?key[_-]?secret|token|secret|dsn|connection[_-]?string)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;&}\]]+)/gi,
          "$1[REDACTED]",
        )
        .replace(
          /(\b(?:proxy-)?authorization\s*[:=]\s*)(?!\[REDACTED\])[^\r\n;]+/gi,
          "$1[REDACTED]",
        )
        .replace(/(\b(?:set-cookie|cookie)\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]")
    );
  };
  const sensitiveKey = (key: string, item: Json) => {
    // Retain conservative matching for unknown downstream credential fields.
    // Only explicit numeric diagnostics can bypass it, never string values.
    if (
      typeof item === "number" &&
      /^(?:tokenCount|tokenLimit|tokenBudget)$/i.test(key)
    )
      return false;
    return /password|passwd|authorization|api.?key|secret|token|dsn|connection.?string|private.?key|credentials?|cookie|^pwd$/i.test(
      key,
    );
  };
  const visit = (item: Json): Json => {
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([k, v]) => [
          cleanString(k),
          sensitiveKey(k, v) ? "[REDACTED]" : visit(v),
        ]),
      );
    return typeof item === "string" ? cleanString(item) : item;
  };
  return visit(value);
}
