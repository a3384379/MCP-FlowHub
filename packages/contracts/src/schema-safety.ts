import { ensure, type Json } from "./domain.js";

/** A deliberately small regex language with bounded, linear backtracking.
 * No groups, alternatives, backreferences or lookarounds. Fixed repetitions
 * may coexist; at most one variable repetition is allowed. All repetition is
 * anchored to avoid searching every possible input starting position.
 */
export function assertSafePattern(pattern: unknown) {
  ensure(
    typeof pattern === "string" && pattern.length <= 512,
    "SCHEMA_INVALID",
    "Schema patterns must be strings of at most 512 characters.",
  );
  let atom = false,
    quantified = false,
    variable = 0,
    expansion = 0;
  let anchoredStart = false,
    anchoredEnd = false,
    repeated = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      const escaped = pattern[++i];
      ensure(
        escaped && /[dDwWsS\\.^$|?*+()[\]{}-]/.test(escaped),
        "SCHEMA_INVALID",
        "Unsupported schema pattern escape.",
      );
      atom = true;
      quantified = false;
    } else if (ch === "[") {
      let closed = false;
      for (i++; i < pattern.length; i++) {
        if (pattern[i] === "\\") {
          const escaped = pattern[++i];
          ensure(
            escaped && /[dDwWsS\\.^$|?*+()[\]{}-]/.test(escaped),
            "SCHEMA_INVALID",
            "Unsupported character-class escape.",
          );
        } else if (pattern[i] === "]") {
          closed = true;
          break;
        } else
          ensure(
            pattern[i] !== "[",
            "SCHEMA_INVALID",
            "Nested character classes are unsupported.",
          );
      }
      ensure(
        closed,
        "SCHEMA_INVALID",
        "Unclosed schema pattern character class.",
      );
      atom = true;
      quantified = false;
    } else if (ch === "^" || ch === "$") {
      ensure(
        ch === "^" ? i === 0 : i === pattern.length - 1,
        "SCHEMA_INVALID",
        "Schema pattern anchors must be at the boundaries.",
      );
      if (ch === "^") anchoredStart = true;
      else anchoredEnd = true;
      atom = false;
      quantified = false;
    } else if (["*", "+", "?", "{"].includes(ch)) {
      repeated = true;
      ensure(
        atom && !quantified,
        "SCHEMA_INVALID",
        "Invalid or repeated schema quantifier.",
      );
      if (ch === "{") {
        const match = pattern
          .slice(i)
          .match(/^\{([0-9]{1,4})(?:,([0-9]{0,4}))?\}/);
        ensure(match, "SCHEMA_INVALID", "Unsupported schema repetition bound.");
        const minimum = Number(match[1]),
          maximum =
            match[2] === undefined
              ? minimum
              : match[2] === ""
                ? Infinity
                : Number(match[2]);
        ensure(
          minimum <= 4096 &&
            maximum >= minimum &&
            (maximum === Infinity || maximum <= 4096),
          "SCHEMA_INVALID",
          "Schema repetition exceeds limits.",
        );
        if (minimum !== maximum) variable++;
        else expansion += minimum;
        i += match[0].length - 1;
      } else variable++;
      ensure(
        variable <= 1 && expansion <= 4096,
        "SCHEMA_INVALID",
        "Schema patterns permit at most one variable repetition and 4096 fixed repetitions.",
      );
      quantified = true;
    } else {
      ensure(
        !["(", ")", "|", "]", "}"].includes(ch),
        "SCHEMA_INVALID",
        "Schema pattern groups and alternatives are unsupported.",
      );
      atom = true;
      quantified = false;
    }
  }
  ensure(
    !repeated || (anchoredStart && anchoredEnd),
    "SCHEMA_INVALID",
    "Schema repetitions require start and end anchors.",
  );
  try {
    new RegExp(pattern, "u");
  } catch {
    ensure(false, "SCHEMA_INVALID", "Invalid schema pattern.");
  }
}

export function assertSafeSchemaPatterns(schema: Json, depth = 0) {
  ensure(depth <= 24, "SCHEMA_LIMIT", "Schema nesting exceeds limit.");
  if (!schema || typeof schema !== "object") return;
  if (Object.hasOwn(schema, "pattern")) assertSafePattern(schema.pattern);
  for (const pattern of Object.keys(schema.patternProperties ?? {}))
    assertSafePattern(pattern);
  for (const value of Object.values(schema))
    if (value && typeof value === "object")
      assertSafeSchemaPatterns(value, depth + 1);
}
