// Node's test runner loads this reporter only for --test. A separate destination
// keeps build output out of the machine-readable acceptance receipts.
import {fileURLToPath} from "node:url";
import {executionSnapshot} from "./acceptance-evidence.mjs";
export default async function* acceptanceReporter(events) {
  yield JSON.stringify({type:"flowhub:execution_snapshot",...await executionSnapshot(fileURLToPath(new URL("../",import.meta.url)))})+"\n";
  for await (const {type, data} of events) {
    if (type === "test:pass" || type === "test:fail") {
      const error = data.details?.error;
      yield JSON.stringify({
        type,
        file: data.file ?? null,
        line: data.line ?? null,
        column: data.column ?? null,
        name: data.name,
        durationMs: data.details?.duration_ms ?? null,
        skip: data.skip ?? false,
        todo: data.todo ?? false,
        ...(error ? {error: {code: error.code ?? null, message: String(error.message).slice(0, 3000)}} : {}),
      }) + "\n";
    } else if (type === "test:summary") {
      yield JSON.stringify({type, ...data}) + "\n";
    }
  }
}
