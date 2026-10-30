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
  redact as redactValue,
} from "../../contracts/src/domain.js";
import type { Repository } from "../../persistence/src/repository.js";
import { hasPlaintextCredentials } from "../../mcp-connectors/src/connection-config.js";
const derive = (password: string, salt: string) =>
  scryptSync(password, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
export function passwordHash(password: string) {
  ensure(
    typeof password === "string" &&
      password.length >= 12 &&
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
  initialize(password: string) {
    ensure(
      !this.initialized,
      "VAULT_EXISTS",
      "Vault already initialized.",
      409,
    );
    passwordHash(password);
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
    try { this.migrateProtectedData(); }
    catch {
      this.lock();
      throw new HubError("MIGRATION_BLOCKED", "Vault authenticated, but legacy data migration failed. Keep a local backup and repair the affected records before retrying.", 409);
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
  addSecret(label: string, value: string) {
    ensure(
      typeof value === "string" && value.length > 0 && value.length < 16384,
      "INPUT_INVALID",
      "Invalid secret.",
    );
    const ref = "secret_" + randomBytes(16).toString("hex");
    this.repo.tx(() => {
      this.repo.insert("secrets", ref, {
      id: ref,
      label,
      encrypted: this.encrypt(value, ref),
      createdAt: now(),
      });
      this.migrateProtectedData();
    });
    this.generation++;
    return { id: ref, label };
  }
  protectInputs(run: Json) {
    const original = this.inputs(run), clean = this.redact(original);
    const unchanged = run.inputSafetyVersion === 1 && hash(clean) === hash(run.inputs);
    run.inputs = clean;
    run.inputSafetyVersion = 1;
    if (hash(clean) !== hash(original)) {
      if (!unchanged || !run.operationalInputs)
        run.operationalInputs = this.encrypt(JSON.stringify(original), run.id + ":inputs");
    }
    else delete run.operationalInputs;
  }
  inputs(run: Json): Json {
    ensure(!run.inputsExpiredAt, "ARTIFACT_EXPIRED", "Exact run inputs expired; start a new run with freshly confirmed inputs.", 410);
    if (run.operationalInputs)
      return JSON.parse(this.decrypt(run.operationalInputs, run.id + ":inputs"));
    ensure(run.inputSafetyVersion === 1 || !this.locked,
      "CREDENTIAL_LOCKED", "Unlock Vault to migrate legacy run inputs; plaintext fallback is disabled.", 423);
    return structuredClone(run.inputs);
  }
  inputView(run: Json): Json {
    if (run.inputSafetyVersion !== 1 && this.locked)
      return { notice: "Legacy inputs withheld until Vault is unlocked and migration completes." };
    return this.redact(run.inputs);
  }
  private migrateProtectedData() {
    // Preserve exact values as authenticated ciphertext. No records, historical
    // backups or immutable publication snapshots are deleted by this migration.
    this.repo.tx(() => {
      for (const run of this.repo.all("runs")) {
        if (!Object.hasOwn(run, "inputs")) continue;
        const previous = hash(run);
        if (run.inputsExpiredAt) run.inputs = this.redact(run.inputs);
        else this.protectInputs(run);
        if (hash(run) !== previous) this.repo.put("runs", run.id, run);
      }
      for (const c of this.repo.all("connections")) {
        if (!hasPlaintextCredentials(c)) continue;
        const next = { ...c, endpoint: "", args: [], secretRef: undefined, envRefs: {}, disabled: true, tools: [], history: [], discovery: undefined,
          verifiedAt: null, verifiedSdk: null, revision: c.revision + 1,
          quarantinedConfiguration: this.encrypt(JSON.stringify(c), "connection:" + c.id),
          configurationWarning: "PLAINTEXT_CREDENTIAL_DENIED: replace configuration with Vault references and reverify." };
        this.repo.put("connections", c.id, next, c.revision);
        for (const b of this.repo.all("bindings").filter((b) => b.connectionId === c.id))
          this.repo.put("bindings", b.id, { ...b, revision: b.revision + 1,
            validationStatus: b.revoked || b.validationStatus === "REVOKED" ? "REVOKED" : "UNVERIFIED", verification: null }, b.revision);
      }
    });
  }
  secret(ref: string): string {
    const s = this.repo.get("secrets", ref);
    ensure(s, "AUTH_REQUIRED", "Secret unavailable.", 401);
    return this.decrypt(s.encrypted, ref);
  }
  redact(value: Json): Json {
    // Decrypt only inside this call. No plaintext matcher survives vault lock,
    // password rotation, or the operation that stores the sanitized result.
    const secrets = this.locked
      ? []
      : this.repo.all("secrets").map((s) => this.decrypt(s.encrypted, s.id));
    return redactValue(value, secrets);
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
      : this.repo.all("secrets").map((s) => this.decrypt(s.encrypted, s.id));
    const inspect = (item: Json, schema = false): void => {
      if (typeof item === "string")
        ensure(
          redactValue(item, secrets) === item,
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
              redactValue({ [key]: "catalog-field" })[key] !== "[REDACTED]",
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
        (r) => r.checkpoint || r.operationalInputs || Object.keys(r.operationalOutputs ?? {}).length,
      )
      .map((r) => ({
        record: r,
        inputs: r.operationalInputs ? this.decrypt(r.operationalInputs, r.id + ":inputs") : undefined,
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
    const configurations = this.repo.all("connections").filter((c) => c.quarantinedConfiguration)
      .map((c) => ({ record: c, text: this.decrypt(c.quarantinedConfiguration, "connection:" + c.id) }));
    const oldKey = Buffer.from(this.key!),
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
          if (c.inputs !== undefined)
            c.record.operationalInputs = this.encrypt(c.inputs, c.record.id + ":inputs");
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
        for (const c of configurations)
          this.repo.put("connections", c.record.id, { ...c.record,
            quarantinedConfiguration: this.encrypt(c.text, "connection:" + c.record.id) });
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
  private sessions = new Map<string, { csrf: string; expires: number }>();
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(private repo: Repository) {}
  get initialized() {
    return !!this.repo.get("settings", "admin");
  }
  setup(password: string) {
    ensure(!this.initialized, "ADMIN_EXISTS", "Admin already configured.", 409);
    this.repo.insert("settings", "admin", passwordHash(password));
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
  login(password: string) {
    this.throttle("login");
    const admin = this.repo.get("settings", "admin");
    ensure(
      admin && passwordMatches(password, admin),
      "AUTH_REQUIRED",
      "Invalid administrator password.",
      401,
    );
    this.attempts.delete("login");
    return this.session();
  }
  session() {
    for (const [key, value] of this.sessions)
      if (value.expires < Date.now()) this.sessions.delete(key);
    ensure(
      this.sessions.size < 64,
      "RATE_LIMITED",
      "Session limit reached.",
      429,
    );
    const token = randomBytes(32).toString("hex"),
      csrf = randomBytes(24).toString("hex");
    this.sessions.set(hash(token), { csrf, expires: Date.now() + 8 * 3600000 });
    return { token, csrf };
  }
  check(cookie: string | undefined, csrf?: string, write = false) {
    const token = cookie?.match(/(?:^|;\s*)flowhub_session=([^;]+)/)?.[1] ?? "",
      session = this.sessions.get(hash(token));
    ensure(
      session && session.expires > Date.now(),
      "AUTH_REQUIRED",
      "Administrator login required.",
      401,
    );
    if (write)
      ensure(csrf === session.csrf, "CSRF_DENIED", "CSRF token required.", 403);
    return session;
  }
  logout(cookie: string | undefined) {
    const token = cookie?.match(/flowhub_session=([^;]+)/)?.[1];
    if (token) this.sessions.delete(hash(token));
  }
  close() {
    this.sessions.clear();
  }
}
