import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import {
  ensure,
  hash,
  now,
  type Json,
  HubError,
} from "../../contracts/src/domain.js";
import type { Repository } from "../../persistence/src/repository.js";
import { credentialInventory } from "./credential-metadata.js";
import { protectDiagnostic } from "./diagnostics.js";
const derive = (password: string, salt: string) =>
  scryptSync(password, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
export const DEFAULT_ADMIN_USERNAME = "admin";
export const DEFAULT_ADMIN_PASSWORD = "admin";

export function passwordHash(password: string, allowDefaultAdmin = false) {
  ensure(
    typeof password === "string" &&
      (password.length >= 12 || allowDefaultAdmin && password === DEFAULT_ADMIN_PASSWORD) &&
      password.length <= 256,
    "PASSWORD_WEAK",
    "Password must contain 12–256 characters.",
  );
  const salt = randomBytes(16).toString("hex");
  return { salt, digest: derive(password, salt).toString("hex") };
}
export function passwordMatches(password: string, stored: Json): boolean {
  if (typeof password !== "string" || password.length > 256) return false;
  return timingSafeEqual(
    derive(password, stored.salt),
    Buffer.from(stored.digest, "hex"),
  );
}
export class Vault {
  private key: Buffer | undefined;
  private generation = 0;
  constructor(private repo: Repository) {}
  get initialized() {
    return !!this.repo.get("settings", "vault");
  }
  get locked() {
    return !this.key;
  }
  initialize(password: string, allowDefaultAdmin = false) {
    ensure(
      !this.initialized,
      "VAULT_EXISTS",
      "Vault already initialized.",
      409,
    );
    passwordHash(password, allowDefaultAdmin);
    const salt = randomBytes(16).toString("hex");
    this.key = derive(password, salt);
    this.generation++;
    this.repo.put("settings", "vault", {
      salt,
      verifier: this.encrypt("flowhub-vault-v1", "verifier"),
      version: 1,
    });
  }
  unlock(password: string) {
    const meta = this.repo.get("settings", "vault");
    ensure(meta, "VAULT_UNINITIALIZED", "Initialize vault first.", 409);
    ensure(
      typeof password === "string" && password.length <= 256,
      "AUTH_REQUIRED",
      "Invalid password.",
      401,
    );
    this.lock();
    this.key = derive(password, meta.salt);
    try {
      ensure(
        this.decrypt(meta.verifier, "verifier") === "flowhub-vault-v1",
        "AUTH_REQUIRED",
        "Invalid vault password.",
        401,
      );
    } catch {
      this.lock();
      throw new HubError("AUTH_REQUIRED", "Invalid vault password.", 401);
    }
  }
  lock() {
    this.generation++;
    this.key?.fill(0);
    this.key = undefined;
  }
  encrypt(value: string, aad: string) {
    ensure(this.key, "CREDENTIAL_LOCKED", "Unlock the vault first.", 423);
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      ciphertext: bytes.toString("base64"),
    };
  }
  decrypt(record: Json, aad: string): string {
    ensure(this.key, "CREDENTIAL_LOCKED", "Unlock the vault first.", 423);
    const cipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(record.iv, "hex"),
    );
    cipher.setAAD(Buffer.from(aad));
    cipher.setAuthTag(Buffer.from(record.tag, "hex"));
    return Buffer.concat([
      cipher.update(Buffer.from(record.ciphertext, "base64")),
      cipher.final(),
    ]).toString("utf8");
  }
  addSecret(label: string, value: string, metadata: Json = {}) {
    ensure(metadata.purpose === undefined || ["unspecified", "model_api", "mcp_auth", "mcp_config"].includes(metadata.purpose), "INPUT_INVALID", "Invalid credential purpose.");
    ensure(
      typeof value === "string" && (value.length > 0 || metadata.purpose === "mcp_config") && value.length < 16384,
      "INPUT_INVALID",
      "Invalid secret.",
    );
    const ref = "secret_" + randomBytes(16).toString("hex");
    this.repo.insert("secrets", ref, {
      id: ref,
      label,
      encrypted: this.encrypt(value, ref),
      createdAt: now(),
      purpose: metadata.purpose ?? "unspecified",
      ...(metadata.sourceId ? { sourceId: metadata.sourceId } : {}),
      ...(metadata.variable ? { variable: metadata.variable } : {}),
    });
    this.generation++;
    return { id: ref, label };
  }
  secret(ref: string): string {
    const s = this.repo.get("secrets", ref);
    ensure(s, "AUTH_REQUIRED", "Secret unavailable.", 401);
    return this.decrypt(s.encrypted, ref);
  }
  private sensitiveRecords() {
    const metadata=credentialInventory(this.repo);
    return this.repo.all("secrets").filter(s=>{
      const meta=metadata.find(m=>m.id===s.id),normal=s.purpose==="mcp_config"||(!s.purpose||s.purpose==="unspecified")&&meta.usedBy.length>0&&meta.usedBy.every((u:Json)=>u.kind==="mcp_config");
      return !normal||meta.usedBy.some((u:Json)=>["model_api","mcp_auth"].includes(u.kind));
    });
  }
  protectDiagnostic(value: Json): Json {
    // Decrypt only inside this call. No plaintext matcher survives vault lock,
    // password rotation, or the operation that stores the sanitized result.
    const secrets = this.locked
      ? []
      : this.sensitiveRecords().map((s) => this.decrypt(s.encrypted, s.id));
    return protectDiagnostic(value, secrets);
  }
  /** Reject known authentication values without rewriting ordinary business data. */
  assertNoCredentialLeak(value: Json, errorCode: string) {
    this.catalogContext();
    // Match decoded strings directly. Serializing JSON first would escape quotes,
    // newlines and backslashes in credentials, and miss those literal values.
    const secrets = this.locked
      ? []
      : this.sensitiveRecords().map((s) => this.decrypt(s.encrypted, s.id));
    const pending: Json[] = [value];
    while (pending.length) {
      const item = pending.pop();
      if (typeof item === "string")
        ensure(
          !secrets.some((secret) => secret.length > 0 && item.includes(secret)),
          errorCode,
          "Model data contains a protected credential.",
        );
      else if (Array.isArray(item))
        for (const child of item) pending.push(child);
      else if (item && typeof item === "object")
        for (const [key, child] of Object.entries(item)) pending.push(key, child);
    }
  }
  catalogContext() {
    ensure(
      !this.locked || this.repo.all("secrets").length === 0,
      "CREDENTIAL_LOCKED",
      "Unlock the vault before inspecting a downstream catalog.",
      423,
    );
    return this.generation;
  }
  assertCatalogSafe(value: Json, context: number) {
    ensure(
      this.catalogContext() === context,
      "CREDENTIAL_LOCKED",
      "Vault credentials changed during catalog discovery; retry discovery.",
      423,
    );
    // Inspect strings individually: treating schema property names as output
    // fields would redact declarations such as `properties.password` and alter
    // the actual tool contract. Reject the entire catalog instead of rewriting.
    const secrets = this.locked
      ? []
      : this.sensitiveRecords().map((s) => this.decrypt(s.encrypted, s.id));
    const inspect = (item: Json, schema = false): void => {
      if (typeof item === "string")
        ensure(
          protectDiagnostic(item, secrets) === item,
          "CATALOG_SENSITIVE",
          "Downstream catalog contains credentials or private data; no catalog was stored.",
        );
      else if (Array.isArray(item))
        item.forEach((child) => inspect(child, schema));
      else if (item && typeof item === "object")
        for (const [key, child] of Object.entries(item)) {
          inspect(key);
          const childSchema =
            schema || ["inputSchema", "outputSchema"].includes(key);
          if (!childSchema)
            ensure(
              protectDiagnostic({ [key]: "catalog-field" })[key] !== "[REDACTED]",
              "CATALOG_SENSITIVE",
              "Downstream catalog contains a credential field; no catalog was stored.",
            );
          inspect(child, childSchema);
        }
    };
    inspect(value);
  }
  changePassword(oldPassword: string, newPassword: string) {
    this.unlock(oldPassword);
    passwordHash(newPassword);
    const secrets = this.repo
      .all("secrets")
      .map((s) => ({ record: s, text: this.decrypt(s.encrypted, s.id) }));
    const protectedRuns = this.repo
      .all("runs")
      .filter(
        (r) => r.checkpoint || Object.keys(r.operationalOutputs ?? {}).length,
      )
      .map((r) => ({
        record: r,
        checkpoint: r.checkpoint
          ? this.decrypt(r.checkpoint.delivery, r.id + ":" + r.checkpoint.id)
          : undefined,
        outputs: Object.entries(r.operationalOutputs ?? {}).map(
          ([nodeId, encrypted]) => ({
            nodeId,
            text: this.decrypt(encrypted, r.id + ":output:" + nodeId),
          }),
        ),
      }));
    // Only these documented operational fields contain Vault envelopes. Do not
    // walk arbitrary business JSON looking for token/password/ciphertext names.
    // Decrypt every envelope before changing keys or writing any record, so one
    // corrupt historical receipt fails the whole rotation with the old key live.
    const continuations = this.repo.all("assistant_tasks")
      .filter((task) => task.providerContinuation != null)
      .map((record) => ({record,text:this.decrypt(record.providerContinuation,record.id+":provider")}));
    const receipts = this.repo.all("assistant_tool_calls")
      .filter((call) => call.result?.checkpoint?.tokenDelivery !== undefined)
      .map((record) => ({record,text:this.decrypt(record.result.checkpoint.tokenDelivery,record.id)}));
    const oldKey = this.key!,
      salt = randomBytes(16).toString("hex");
    this.key = derive(newPassword, salt);
    try {
      this.repo.tx(() => {
        for (const s of secrets)
          this.repo.put("secrets", s.record.id, {
            ...s.record,
            encrypted: this.encrypt(s.text, s.record.id),
          });
        for (const c of protectedRuns) {
          if (c.checkpoint !== undefined)
            c.record.checkpoint.delivery = this.encrypt(
              c.checkpoint,
              c.record.id + ":" + c.record.checkpoint.id,
            );
          for (const output of c.outputs)
            c.record.operationalOutputs[output.nodeId] = this.encrypt(
              output.text,
              c.record.id + ":output:" + output.nodeId,
            );
          this.repo.put("runs", c.record.id, c.record);
        }
        for (const continuation of continuations) {
          continuation.record.providerContinuation=this.encrypt(continuation.text,continuation.record.id+":provider");
          this.repo.put("assistant_tasks",continuation.record.id,continuation.record);
        }
        for (const receipt of receipts) {
          receipt.record.result.checkpoint.tokenDelivery=this.encrypt(receipt.text,receipt.record.id);
          this.repo.put("assistant_tool_calls",receipt.record.id,receipt.record);
        }
        this.repo.put("settings", "vault", {
          salt,
          verifier: this.encrypt("flowhub-vault-v1", "verifier"),
          version: 1,
        });
      });
      oldKey.fill(0);
    } catch (e) {
      this.key.fill(0);
      this.key = oldKey;
      throw e;
    }
  }
}
export class AdminAuth {
  private sessions = new Map<string, { csrf: string; expires: number; codex: boolean }>();
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(private repo: Repository) {}
  get initialized() {
    return !!this.repo.get("settings", "admin");
  }
  setup(password: string, allowDefaultAdmin = false) {
    ensure(!this.initialized, "ADMIN_EXISTS", "Admin already configured.", 409);
    this.repo.insert("settings", "admin", passwordHash(password, allowDefaultAdmin));
  }
  throttle(key: string) {
    const old = this.attempts.get(key);
    ensure(
      !old || old.until < Date.now() || old.count < 5,
      "RATE_LIMITED",
      "Too many attempts; wait one minute.",
      429,
    );
    this.attempts.set(key, {
      count: old && old.until > Date.now() ? old.count + 1 : 1,
      until: Date.now() + 60000,
    });
  }
  resetThrottle(key: string) {
    this.attempts.delete(key);
  }
  login(password: string, username = DEFAULT_ADMIN_USERNAME) {
    this.throttle("login");
    const admin = this.repo.get("settings", "admin");
    ensure(
      username === DEFAULT_ADMIN_USERNAME && admin && passwordMatches(password, admin),
      "AUTH_REQUIRED",
      "Invalid administrator password.",
      401,
    );
    this.resetThrottle("login");
    return this.session();
  }
  session(codex = false) {
    for (const [key, value] of this.sessions)
      if (value.expires < Date.now()) this.sessions.delete(key);
    // Browser contexts can disappear without closing their server-side session.
    if (this.sessions.size >= 64) {
      const oldest = this.sessions.keys().next();
      if (!oldest.done) this.sessions.delete(oldest.value);
    }
    const token = randomBytes(32).toString("hex"),
      csrf = randomBytes(24).toString("hex");
    this.sessions.set(hash(token), { csrf, expires: Date.now() + 8 * 3600000, codex });
    return { token, csrf };
  }
  private sessionKey(cookie: string | undefined, codex?: boolean) {
    const matches = cookie?.matchAll(/(?:^|;\s*)flowhub_(codex_)?session=([a-f0-9]{64})(?=;|$)/g) ?? [];
    for (const [, codexPrefix, token] of matches) {
      const key = hash(token!);
      const session = this.sessions.get(key);
      if (session?.codex === Boolean(codexPrefix) &&
          (codex === undefined || session.codex === codex) &&
          session.expires > Date.now()) return key;
    }
    return "";
  }
  check(cookie: string | undefined, csrf?: string, write = false, codex?: boolean) {
    const key = this.sessionKey(cookie, codex),
      session = this.sessions.get(key);
    ensure(
      session && session.expires > Date.now(),
      "AUTH_REQUIRED",
      "Local workspace session required.",
      401,
    );
    if (write)
      ensure(csrf === session.csrf, "CSRF_DENIED", "CSRF token required.", 403);
    this.sessions.delete(key);
    this.sessions.set(key, session);
    return session;
  }
  logout(cookie: string | undefined) {
    this.sessions.delete(this.sessionKey(cookie));
  }
  close() {
    this.sessions.clear();
  }
}
