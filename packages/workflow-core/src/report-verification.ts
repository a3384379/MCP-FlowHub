import {
  ensure,
  hash,
  REPORT_HEADINGS,
  type Json,
} from "../../contracts/src/domain.js";

const artifactToken = /\bart_[A-Za-z0-9][A-Za-z0-9_-]*\b/g;
const artifactId = /^art_[A-Za-z0-9][A-Za-z0-9_-]*$/;
const digest = /^(?:sha256:)?([a-f0-9]{64})$/i;
const scalar = (value: string) => {
  const trimmed = value.trim();
  return /^`[^`]+`$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
};
type Declaration = { id: string; sha256: string; byteLength?: number };

function declaration(line: string): Declaration | undefined {
  const content = line.trim().replace(/^(?:[-+*]|\d+[.)])[ \t]+/, "");
  if (!content.startsWith("|") && !content.includes("/")) return;
  const cells = (
    content.startsWith("|")
      ? content.replace(/^\||\|$/g, "").split("|")
      : content
          .split(/[。；;，！？!?、）)\]】”’"']|[.,](?![0-9])/, 1)[0]!
          .split("/")
  ).map(scalar);
  if (!artifactId.test(cells[0] ?? "")) return;
  ensure(
    cells.length === 2 || cells.length === 3,
    "ARTIFACT_INVALID",
    "Evidence declarations require artifactId / sha256 / optional byteLength.",
  );
  const sha256 = digest.exec(cells[1]!);
  ensure(
    sha256,
    "ARTIFACT_INVALID",
    "Evidence index SHA-256 is missing or malformed.",
  );
  const result: Declaration = {
    id: cells[0]!,
    sha256: sha256[1]!.toLowerCase(),
  };
  if (cells[2] !== undefined) {
    const bytes = /^(0|[1-9][0-9]*)(?:[ \t]+bytes?)?$/i.exec(cells[2]);
    ensure(
      bytes && Number.isSafeInteger(Number(bytes[1])),
      "ARTIFACT_INVALID",
      "Evidence byte length must be a non-negative safe integer.",
    );
    result.byteLength = Number(bytes[1]);
  }
  return result;
}

/** The caller supplies only this run's authorized, unexpired stored artifacts. */
export function validateReportEvidence(
  text: string,
  evidenceRefs: string[],
  artifacts: Json[],
): void {
  const allowed = new Map<string, Json>();
  for (const artifact of artifacts) {
    ensure(
      !allowed.has(artifact.id),
      "ARTIFACT_INVALID",
      "Ambiguous stored evidence ID.",
    );
    allowed.set(artifact.id, artifact);
  }
  const refs = new Set(evidenceRefs);
  ensure(
    refs.size === evidenceRefs.length,
    "ARTIFACT_INVALID",
    "Report evidence references must be unique.",
  );
  const mentioned = new Set(text.match(artifactToken) ?? []);
  for (const ref of new Set([...refs, ...mentioned]))
    ensure(
      refs.has(ref) && mentioned.has(ref) && allowed.has(ref),
      "ARTIFACT_INVALID",
      "Every report artifact reference must be declared and belong to this run.",
    );

  const checked = new Set<string>();
  const check = (entry: Declaration) => {
    const artifact = allowed.get(entry.id);
    ensure(
      artifact && refs.has(entry.id),
      "ARTIFACT_INVALID",
      "Evidence declaration must reference this run's declared evidence.",
    );
    if (!checked.has(entry.id)) {
      ensure(
        typeof artifact.content === "string" &&
          typeof artifact.sha256 === "string" &&
          hash(artifact.content) === artifact.sha256 &&
          Buffer.byteLength(artifact.content) === artifact.byteLength,
        "ARTIFACT_INVALID",
        "Stored evidence metadata does not match its actual bytes.",
      );
      checked.add(entry.id);
    }
    ensure(
      entry.sha256 === artifact.sha256 &&
        (entry.byteLength === undefined ||
          entry.byteLength === artifact.byteLength),
      "ARTIFACT_INVALID",
      "Report evidence SHA-256 or byte length does not match stored evidence.",
    );
  };

  let indexCount = 0,
    indexDepth = 0,
    inIndex = false;
  let fence: { marker: string; length: number } | undefined;
  let comment = false;
  const indexed = new Set<string>(),
    chapters = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    // Explicit slash/table declarations elsewhere must not contradict the index.
    const rawEntry = declaration(rawLine);
    if (rawEntry) check(rawEntry);
    for (const match of rawLine.matchAll(artifactToken)) {
      const tail = rawLine
        .slice(match.index! + match[0].length)
        .replace(/^`+/, "");
      if (!/^[ \t]*\//.test(tail)) continue;
      const explicit = declaration(match[0] + tail);
      ensure(
        explicit,
        "ARTIFACT_INVALID",
        "Explicit evidence declaration is malformed.",
      );
      check(explicit);
    }
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(rawLine);
    if (fence) {
      if (
        delimiter &&
        delimiter[1]![0] === fence.marker &&
        delimiter[1]!.length >= fence.length &&
        !delimiter[2]!.trim()
      )
        fence = undefined;
      continue;
    }
    if (
      delimiter &&
      !comment &&
      (delimiter[1]![0] === "~" || !delimiter[2]!.includes("`"))
    ) {
      fence = { marker: delimiter[1]![0]!, length: delimiter[1]!.length };
      continue;
    }
    // Mask comments without moving text into an ATX heading's indentation.
    // Comment markers inside fenced code never reach this state machine.
    const startedInComment = comment;
    let line = "",
      cursor = 0;
    while (cursor < rawLine.length) {
      const start = comment ? cursor : rawLine.indexOf("<!--", cursor);
      if (start < 0) {
        line += rawLine.slice(cursor);
        break;
      }
      line += rawLine.slice(cursor, start);
      const end = rawLine.indexOf("-->", start + (comment ? 0 : 4));
      const through = end < 0 ? rawLine.length : end + 3;
      line += " ".repeat(through - start);
      comment = end < 0;
      cursor = through;
    }
    if (startedInComment) continue;
    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(line);
    if (heading) {
      const depth = heading[1]!.length,
        title = (heading[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
      const chapter = REPORT_HEADINGS.find((name) => {
        if (!title.startsWith(name)) return false;
        const suffix = title.slice(name.length).trim();
        return !suffix || /^(?:（.*）|\(.*\))$/.test(suffix);
      });
      if (chapter) chapters.add(chapter);
      if (inIndex && depth <= indexDepth) inIndex = false;
      if (chapter === "证据索引") {
        ensure(
          ++indexCount === 1,
          "ARTIFACT_INVALID",
          "Report must have one unambiguous evidence index.",
        );
        inIndex = true;
        indexDepth = depth;
      }
      continue;
    }
    if (!inIndex || !line.match(artifactToken)) continue;
    const entry = declaration(line);
    ensure(
      entry,
      "ARTIFACT_INVALID",
      "Evidence index must bind each artifact ID to its SHA-256.",
    );
    ensure(
      !indexed.has(entry.id),
      "ARTIFACT_INVALID",
      "Duplicate evidence index entry.",
    );
    indexed.add(entry.id);
  }
  ensure(
    REPORT_HEADINGS.every((heading) => chapters.has(heading)),
    "ARTIFACT_INVALID",
    "Missing visible report chapters.",
  );
  ensure(
    indexCount === 1 &&
      indexed.size === refs.size &&
      [...refs].every((ref) => indexed.has(ref)),
    "ARTIFACT_INVALID",
    "Every report evidence reference requires a matching SHA-256 in the evidence index.",
  );
}
