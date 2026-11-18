import { randomBytes } from "node:crypto";
import { hash } from "../../contracts/src/domain.js";

// Issued by the bundled personal MCP connection, redeemed once by the
// same-origin document inside the Codex MCP App. No credentials enter the URL.
export class CodexLaunches {
  private pending = new Map<string, number>();

  issue() {
    const now = Date.now();
    for (const [key, expiry] of this.pending) {
      if (expiry <= now) this.pending.delete(key);
    }
    if (this.pending.size >= 32) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) this.pending.delete(oldest.value);
    }
    const ticket = randomBytes(32).toString("hex");
    this.pending.set(hash(ticket), now + 60_000);
    return ticket;
  }

  redeem(ticket: unknown) {
    if (typeof ticket !== "string" || !/^[a-f0-9]{64}$/.test(ticket)) return false;
    const key = hash(ticket);
    const expiry = this.pending.get(key);
    this.pending.delete(key);
    return expiry !== undefined && expiry > Date.now();
  }
}
