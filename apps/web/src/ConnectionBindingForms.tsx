import { useEffect, useRef, useState } from "react";

type Value = Record<string, any>;
type Credential = { id: string; label: string; modelCredential?: boolean; eligibleForMcp?: boolean };
type FormProps = {
  value: Value;
  onChange: (value: Value) => void;
  onValidityChange?: (valid: boolean) => void;
  credentials?: Credential[];
  connections?: Value[];
  tools?: Value[];
  editing?: boolean;
  connection?: Value;
  binding?: Value;
};
const object = (value: unknown): value is Value =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const pointer = /^(?:\/(?:[^~/]|~[01])*)+$/;
const environmentLabels: Record<string, string> = {
  production: "生产",
  staging: "试运行",
  test: "测试",
};

// Keep callback identity out of effect dependencies: callers commonly pass an
// inline modal updater. Unmount removes this form's parent submission gate.
function useValidity(valid: boolean, callback?: (valid: boolean) => void) {
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(() => latest.current?.(valid), [valid]);
  useEffect(() => () => latest.current?.(true), []);
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  disabled = false,
  min,
  max,
}: {
  label: string;
  value: any;
  onChange: (value: string) => void;
  type?: string;
  disabled?: boolean;
  min?: number;
  max?: number;
}) {
  return (
    <label className="field">
      {label}
      <input
        aria-label={label}
        type={type}
        value={value ?? ""}
        disabled={disabled}
        min={min}
        max={max}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function Errors({ errors }: { errors: string[] }) {
  return errors.length ? (
    <ul className="error" aria-live="polite">
      {errors.map((error) => (
        <li key={error}>{error}</li>
      ))}
    </ul>
  ) : null;
}

function SecretSelect({
  label,
  value,
  credentials,
  onChange,
  optional = true,
}: {
  label: string;
  value?: string;
  credentials: Credential[];
  onChange: (value: string) => void;
  optional?: boolean;
}) {
  return (
    <label className="field">
      {label}
      <select
        aria-label={label}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{optional ? "无需凭据" : "请选择已登记凭据"}</option>
        {value &&
          !credentials.some((credential) => credential.id === value && credential.eligibleForMcp !== false && !credential.modelCredential) && (
            <option value={value}>原引用未登记或为模型专用，请重新选择</option>
          )}
        {credentials.filter(credential => credential.eligibleForMcp !== false && !credential.modelCredential).map((credential) => (
          <option key={credential.id} value={credential.id}>
            {credential.label} · {credential.id.slice(-8)}
          </option>
        ))}
      </select>
    </label>
  );
}

function StringArrayFields({
  label,
  values,
  onChange,
  max = 64,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  max?: number;
}) {
  return (
    <fieldset>
      <legend>{label}</legend>
      {values.map((value, index) => (
        <div className="row" key={index}>
          <Field
            label={`${label} ${index + 1}`}
            value={value}
            onChange={(next) =>
              onChange(values.map((entry, i) => (i === index ? next : entry)))
            }
          />
          <button
            type="button"
            aria-label={`移除${label} ${index + 1}`}
            onClick={() => onChange(values.filter((_, i) => i !== index))}
          >
            移除
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={values.length >= max}
        onClick={() => onChange([...values, ""])}
      >
        添加{label}
      </button>
    </fieldset>
  );
}

function JsonObjectField({
  label,
  value,
  onChange,
  onValidityChange,
}: {
  label: string;
  value: Value;
  onChange: (value: Value) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const serialized = JSON.stringify(value, null, 2);
  const [text, setText] = useState(serialized);
  const [error, setError] = useState("");
  const lastValue = useRef(serialized);
  useEffect(() => {
    if (lastValue.current !== serialized) {
      lastValue.current = serialized;
      setText(serialized);
      setError("");
    }
  }, [serialized]);
  useValidity(!error, onValidityChange);
  return (
    <label className="field">
      {label}
      <textarea
        aria-label={label}
        aria-invalid={!!error}
        value={text}
        rows={8}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          try {
            const parsed: unknown = JSON.parse(next);
            if (!object(parsed)) throw new Error("必须是 JSON 对象");
            lastValue.current = JSON.stringify(parsed, null, 2);
            setError("");
            onValidityChange(true);
            onChange(parsed);
          } catch {
            setError("JSON 必须是完整合法的对象；修复后才能提交。");
            onValidityChange(false);
          }
        }}
      />
      {error && (
        <small className="error" role="alert">
          {error}
        </small>
      )}
    </label>
  );
}

export function connectionFormErrors(
  value: Value,
  credentials: Credential[],
  transport: string,
) {
  const errors: string[] = [];
  if (
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 128
  )
    errors.push("请输入 1–128 字的连接名称。");
  if (!["modern", "legacy", "auto"].includes(value.protocolEra))
    errors.push("请选择协议代际。");
  const registered = (ref: unknown) =>
    credentials.some((credential) => credential.id === ref && credential.eligibleForMcp !== false && !credential.modelCredential);
  if (transport === "stdio") {
    if (
      typeof value.command !== "string" ||
      !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value.command) ||
      /\.(cmd|bat)$/i.test(value.command) ||
      /(^|[\\/])(sh|bash|cmd|powershell|pwsh)(\.exe)?$/i.test(value.command)
    )
      errors.push("请填写获准的绝对可执行文件路径，不能使用 shell 或批处理。");
    if (
      !Array.isArray(value.args) ||
      value.args.length > 64 ||
      value.args.some(
        (arg: unknown) => typeof arg !== "string" || arg.length > 4096,
      )
    )
      errors.push("命令参数须为至多 64 个独立字符串。");
    if (value.commandApproved !== true)
      errors.push("请核对完整命令并确认获准启动该程序。");
    if (
      !object(value.envRefs ?? {}) ||
      Object.entries(value.envRefs ?? {}).some(
        ([key, ref]) =>
          !/^[A-Z_][A-Z0-9_]*$/.test(key) ||
          /^(NODE_|LD_|DYLD_|PATH$|HOME$|SHELL$|COMSPEC$|PYTHON)/i.test(key) ||
          !registered(ref),
      )
    )
      errors.push("环境变量须使用允许的变量名和已登记凭据引用。");
  } else if (transport === "streamable_http") {
    try {
      const url = new URL(value.endpoint);
      if (
        url.username ||
        url.password ||
        url.hash ||
        !(
          url.protocol === "https:" ||
          (url.protocol === "http:" && url.hostname === "127.0.0.1")
        )
      )
        throw new Error();
      if (
        !Array.isArray(value.allowedHosts) ||
        !value.allowedHosts.includes(url.hostname) ||
        value.allowedHosts.length > 20 ||
        value.allowedHosts.some(
          (host: unknown) =>
            typeof host !== "string" || !host.trim() || /[\s/:?#@]/.test(host),
        )
      )
        throw new Error();
    } catch {
      errors.push(
        "请填写 HTTPS 端点（或 127.0.0.1 HTTP）及精确允许主机，不含用户名、密码或片段。",
      );
    }
    if (value.secretRef && !registered(value.secretRef))
      errors.push("HTTP 认证只能引用已登记的凭据。");
  } else errors.push("请选择连接传输方式。");
  return errors;
}

export function ConnectionForm({
  value,
  onChange,
  onValidityChange,
  credentials = [],
  connection,
  editing = false,
}: FormProps) {
  const transport = editing ? connection?.transport : value.transport;
  const [envName, setEnvName] = useState("");
  const [envSecret, setEnvSecret] = useState("");
  const [envError, setEnvError] = useState("");
  const errors = connectionFormErrors(value, credentials, transport);
  const pendingEnv = !!envName || !!envSecret;
  useValidity(
    !errors.length && (transport !== "stdio" || (!pendingEnv && !envError)),
    onValidityChange,
  );
  const change = (key: string, next: any, approveAgain = false) =>
    onChange({
      ...value,
      [key]: next,
      ...(approveAgain ? { commandApproved: false } : {}),
    });
  return (
    <div className="configuration-form">
      <p>
        登记连接 → 检测与同步工具 → 创建环境绑定 →
        独立验证。保存配置后，由你单独触发连接检测。
      </p>
      <Field
        label="连接名称"
        value={value.name}
        onChange={(next) => change("name", next)}
      />
      <label className="field">
        传输方式
        <select
          aria-label="传输方式"
          value={transport ?? ""}
          disabled={editing}
          onChange={(event) =>
            onChange({
              name: value.name,
              protocolEra: value.protocolEra ?? "modern",
              transport: event.target.value,
              ...(event.target.value === "stdio"
                ? { command: "", args: [], envRefs: {}, commandApproved: false }
                : { endpoint: "", allowedHosts: [] }),
            })
          }
        >
          <option value="">请选择传输方式</option>
          <option value="stdio">STDIO 本机程序</option>
          <option value="streamable_http">Streamable HTTP</option>
        </select>
      </label>
      <label className="field">
        协议代际
        <select
          aria-label="协议代际"
          value={value.protocolEra ?? ""}
          onChange={(event) => change("protocolEra", event.target.value)}
        >
          <option value="modern">Modern</option>
          <option value="legacy">Legacy</option>
          <option value="auto">Auto（认证失败不降级）</option>
        </select>
      </label>
      <p>
        环境用途在后续绑定中显式选择；同一连接可以建立独立的生产、试运行和测试绑定。
      </p>
      {transport === "stdio" ? (
        <>
          <Field
            label="绝对可执行文件路径"
            value={value.command}
            onChange={(next) => change("command", next, true)}
          />
          <StringArrayFields
            label="命令参数"
            values={value.args ?? []}
            onChange={(next) => change("args", next, true)}
          />
          <p>
            每项单独传递，不按 shell
            拆分。当前运行器不支持自定义工作目录；不要把 cwd
            或明文令牌塞进命令参数。
          </p>
          <fieldset>
            <legend>环境变量凭据引用（可选）</legend>
            {Object.entries(value.envRefs ?? {}).map(([name, ref]) => (
              <div className="row" key={name}>
                <SecretSelect
                  label={`环境变量 ${name}`}
                  value={String(ref)}
                  credentials={credentials}
                  optional={false}
                  onChange={(next) =>
                    change("envRefs", { ...value.envRefs, [name]: next }, true)
                  }
                />
                <button
                  type="button"
                  onClick={() =>
                    change(
                      "envRefs",
                      Object.fromEntries(
                        Object.entries(value.envRefs).filter(
                          ([key]) => key !== name,
                        ),
                      ),
                      true,
                    )
                  }
                >
                  移除 {name}
                </button>
              </div>
            ))}
            <Field
              label="新增环境变量名称"
              value={envName}
              onChange={(next) => {
                setEnvName(next);
                setEnvError("");
              }}
            />
            <SecretSelect
              label="新增环境变量的凭据"
              value={envSecret}
              credentials={credentials}
              optional={false}
              onChange={(next) => {
                setEnvSecret(next);
                setEnvError("");
              }}
            />
            <button
              type="button"
              onClick={() => {
                if (
                  !/^[A-Z_][A-Z0-9_]*$/.test(envName) ||
                  /^(NODE_|LD_|DYLD_|PATH$|HOME$|SHELL$|COMSPEC$|PYTHON)/i.test(
                    envName,
                  ) ||
                  !credentials.some(
                    (credential) => credential.id === envSecret,
                  ) ||
                  Object.hasOwn(value.envRefs ?? {}, envName)
                ) {
                  setEnvError("请使用未重复的安全变量名和已登记凭据。");
                  return;
                }
                change(
                  "envRefs",
                  { ...value.envRefs, [envName]: envSecret },
                  true,
                );
                setEnvName("");
                setEnvSecret("");
                setEnvError("");
              }}
            >
              添加环境变量引用
            </button>
            {pendingEnv && (
              <button
                type="button"
                onClick={() => {
                  setEnvName("");
                  setEnvSecret("");
                  setEnvError("");
                }}
              >
                放弃待添加变量
              </button>
            )}
            {envError && (
              <small role="alert" className="error">
                {envError}
              </small>
            )}
          </fieldset>
          <section className="info">
            <strong>待审核启动配置</strong>
            <pre>
              {JSON.stringify(
                {
                  command: value.command,
                  args: value.args ?? [],
                  envRefs: value.envRefs ?? {},
                },
                null,
                2,
              )}
            </pre>
          </section>
          <label>
            <input
              type="checkbox"
              checked={value.commandApproved === true}
              onChange={(event) =>
                change("commandApproved", event.target.checked)
              }
            />
            我已核对程序和每项参数，获准启动该本机程序
          </label>
        </>
      ) : transport === "streamable_http" ? (
        <>
          <Field
            label="精确 MCP 端点 URL"
            value={value.endpoint}
            onChange={(next) => change("endpoint", next)}
          />
          <StringArrayFields
            label="允许主机"
            values={value.allowedHosts ?? []}
            max={20}
            onChange={(next) => change("allowedHosts", next)}
          />
          <SecretSelect
            label="HTTP Bearer 凭据引用"
            value={value.secretRef}
            credentials={credentials}
            onChange={(next) => change("secretRef", next)}
          />
          <p>
            此运行器支持无认证或 Bearer 凭据引用；先在接入设置登记凭据。URL
            不填写令牌，表单只读取凭据标签和引用。
          </p>
          <section className="info">
            <strong>待连接端点</strong>
            <p>{value.endpoint || "尚未填写"}</p>
            <p>保存后再选择“检测与同步”，该操作会访问此端点。</p>
          </section>
        </>
      ) : null}
      <Errors errors={errors} />
    </div>
  );
}

function connectionTools(
  connectionId: string,
  connections: Value[],
  tools: Value[],
) {
  const connection = connections.find((entry) => entry.id === connectionId);
  return [
    ...new Map(
      [
        ...tools.filter((tool) => tool.connectionId === connectionId),
        ...(connection?.tools ?? []),
      ].map((tool) => [tool.name, tool]),
    ).values(),
  ];
}

export function bindingFormErrors(
  value: Value,
  connection: Value | undefined,
  tools: Value[],
  environment: string,
) {
  const errors: string[] = [];
  if (
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 128
  )
    errors.push("请输入 1–128 字的绑定名称。");
  if (!Object.hasOwn(environmentLabels, environment))
    errors.push("请显式选择绑定环境。");
  if (!connection || connection.disabled)
    errors.push("请选择已登记且启用的 MCP 连接。");
  if (
    !Array.isArray(value.allowedTools) ||
    !value.allowedTools.length ||
    value.allowedTools.length > 100 ||
    value.allowedTools.some(
      (name: string) => !tools.some((tool) => tool.name === name),
    )
  )
    errors.push("请从该连接已同步的工具中至少选择一项；缺失工具需重新同步。");
  if (
    !object(value.lockedArguments) ||
    !Object.keys(value.lockedArguments).length ||
    Object.keys(value.lockedArguments).length > 32 ||
    Object.keys(value.lockedArguments).some((key) => !pointer.test(key))
  )
    errors.push("至少锁定一个资源参数，参数路径使用 JSON Pointer。");
  if (
    value.lockedArguments?.["/environment"] !== undefined &&
    value.lockedArguments["/environment"] !== environment
  )
    errors.push("锁定的 environment 必须与绑定环境一致。");
  if (
    !Array.isArray(value.allowedQueryTemplates) ||
    value.allowedQueryTemplates.length > 30 ||
    value.allowedQueryTemplates.some(
      (entry: unknown) => typeof entry !== "string" || !entry.trim(),
    )
  )
    errors.push("查询模板须为至多 30 个非空模板 ID。");
  if (
    !Number.isInteger(value.maxRows) ||
    value.maxRows < 1 ||
    value.maxRows > 1000
  )
    errors.push("最大行数须为 1–1000 的整数。");
  if (
    !Number.isInteger(value.timeoutSeconds) ||
    value.timeoutSeconds < 1 ||
    value.timeoutSeconds > 120
  )
    errors.push("超时须为 1–120 秒的整数。");
  return errors;
}

export function BindingForm({
  value,
  onChange,
  onValidityChange,
  connections = [],
  tools = [],
  credentials = [],
  binding,
  editing = false,
}: FormProps) {
  const environment = editing ? binding?.environment : value.environment;
  const connectionId = editing ? binding?.connectionId : value.connectionId;
  const connection = connections.find((entry) => entry.id === connectionId);
  const available = connectionTools(connectionId, connections, tools);
  const [resourcePath, setResourcePath] = useState("");
  const [resourceValue, setResourceValue] = useState("");
  const [resourceError, setResourceError] = useState("");
  const [jsonValid, setJsonValid] = useState(true);
  const errors = bindingFormErrors(value, connection, available, environment);
  useValidity(
    !errors.length &&
      jsonValid &&
      !resourcePath &&
      !resourceValue &&
      !resourceError,
    onValidityChange,
  );
  const change = (key: string, next: any) =>
    onChange({ ...value, [key]: next });
  const credential = credentials.find(
    (entry) => entry.id === connection?.secretRef,
  );
  return (
    <div className="configuration-form">
      <Field
        label="绑定名称"
        value={value.name}
        onChange={(next) => change("name", next)}
      />
      <label className="field">
        绑定环境
        <select
          aria-label="绑定环境"
          value={environment ?? ""}
          disabled={editing}
          onChange={(event) =>
            onChange({
              ...value,
              environment: event.target.value,
              lockedArguments: {
                ...value.lockedArguments,
                "/environment": event.target.value,
              },
            })
          }
        >
          <option value="">请选择环境</option>
          {Object.entries(environmentLabels).map(([key, label]) => (
            <option value={key} key={key}>
              {label} · {key}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        MCP 连接
        <select
          aria-label="MCP 连接"
          value={connectionId ?? ""}
          disabled={editing}
          onChange={(event) =>
            onChange({
              ...value,
              connectionId: event.target.value,
              allowedTools: [],
            })
          }
        >
          <option value="">请选择已登记连接</option>
          {connections.map((entry) => (
            <option key={entry.id} value={entry.id} disabled={entry.disabled}>
              {entry.name}
              {entry.synthetic || entry.syntheticEvidence ? " · 合成 Mock" : ""}
              {entry.disabled ? " · 已禁用" : ""}
            </option>
          ))}
        </select>
      </label>
      {editing && <p>环境和连接已固定；需要更换时创建独立绑定。</p>}
      <p>
        凭据范围继承所选连接：
        {connection?.transport === "stdio"
          ? "使用该连接已登记的环境变量凭据引用"
          : credential
            ? `${credential.label} · 引用 ${credential.id.slice(-8)}`
            : connection?.secretRef
              ? "凭据引用未登记，先修复连接"
              : "无需 HTTP 凭据"}
        。
      </p>
      {(connection?.synthetic || connection?.syntheticEvidence) && (
        <p className="banner">
          合成 Mock 连接：验证最高只能得到 MOCK_VERIFIED，不授权真实生产访问。
        </p>
      )}
      <fieldset>
        <legend>允许工具</legend>
        {!available.length && (
          <p>尚无已同步工具。请先到 MCP 工具库执行“检测与同步”。</p>
        )}
        {available.map((tool) => (
          <label className="field" key={tool.name}>
            <span>
              <input
                type="checkbox"
                checked={value.allowedTools?.includes(tool.name) ?? false}
                onChange={(event) =>
                  change(
                    "allowedTools",
                    event.target.checked
                      ? [...(value.allowedTools ?? []), tool.name]
                      : value.allowedTools.filter(
                          (name: string) => name !== tool.name,
                        ),
                  )
                }
              />
              {tool.name}
            </span>
            <small>
              {tool.description || "无描述"} ·
              工具只读提示不能替代服务端权限证明
            </small>
          </label>
        ))}
        {(value.allowedTools ?? [])
          .filter(
            (name: string) => !available.some((tool) => tool.name === name),
          )
          .map((name: string) => (
            <p key={name} className="error">
              已选工具 {name} 不在当前目录中。
              <button
                type="button"
                onClick={() =>
                  change(
                    "allowedTools",
                    value.allowedTools.filter(
                      (entry: string) => entry !== name,
                    ),
                  )
                }
              >
                移除缺失工具
              </button>
            </p>
          ))}
      </fieldset>
      <fieldset>
        <legend>固定环境与资源参数</legend>
        {Object.entries(value.lockedArguments ?? {}).map(([key, entry]) => (
          <div key={key} className="row">
            {typeof entry === "string" ? (
              <Field
                label={`锁定参数 ${key}`}
                value={entry}
                disabled={key === "/environment"}
                onChange={(next) =>
                  change("lockedArguments", {
                    ...value.lockedArguments,
                    [key]: next,
                  })
                }
              />
            ) : (
              <p>
                <code>{key}</code> = {JSON.stringify(entry)}
                （复杂值在高级区修改）
              </p>
            )}
            {key !== "/environment" && (
              <button
                type="button"
                onClick={() =>
                  change(
                    "lockedArguments",
                    Object.fromEntries(
                      Object.entries(value.lockedArguments).filter(
                        ([path]) => path !== key,
                      ),
                    ),
                  )
                }
              >
                移除锁定参数 {key}
              </button>
            )}
          </div>
        ))}
        <Field
          label="新增资源参数路径"
          value={resourcePath}
          onChange={(next) => {
            setResourcePath(next);
            setResourceError("");
          }}
        />
        <Field
          label="新增资源标识"
          value={resourceValue}
          onChange={(next) => {
            setResourceValue(next);
            setResourceError("");
          }}
        />
        <small>
          填写工具输入中的资源参数路径（如
          /resourceId）和获准的资源标识；此处添加字符串值。
        </small>
        <button
          type="button"
          onClick={() => {
            if (
              !pointer.test(resourcePath) ||
              !resourceValue ||
              Object.hasOwn(value.lockedArguments ?? {}, resourcePath)
            ) {
              setResourceError("资源路径须有效且不重复，资源标识不能为空。");
              return;
            }
            change("lockedArguments", {
              ...value.lockedArguments,
              [resourcePath]: resourceValue,
            });
            setResourcePath("");
            setResourceValue("");
            setResourceError("");
          }}
        >
          添加资源锁
        </button>
        {(resourcePath || resourceValue) && (
          <button
            type="button"
            onClick={() => {
              setResourcePath("");
              setResourceValue("");
              setResourceError("");
            }}
          >
            放弃待添加资源
          </button>
        )}
        {resourceError && (
          <small role="alert" className="error">
            {resourceError}
          </small>
        )}
        <details>
          <summary>高级：复杂锁定参数 JSON</summary>
          <JsonObjectField
            label="锁定参数 JSON"
            value={value.lockedArguments ?? {}}
            onChange={(next) => change("lockedArguments", next)}
            onValidityChange={setJsonValid}
          />
        </details>
      </fieldset>
      <StringArrayFields
        label="允许查询模板 ID"
        values={value.allowedQueryTemplates ?? []}
        max={30}
        onChange={(next) => change("allowedQueryTemplates", next)}
      />
      <Field
        label="最大返回行数"
        type="number"
        min={1}
        max={1000}
        value={value.maxRows}
        onChange={(next) => change("maxRows", next === "" ? "" : Number(next))}
      />
      <Field
        label="调用超时（秒）"
        type="number"
        min={1}
        max={120}
        value={value.timeoutSeconds}
        onChange={(next) =>
          change("timeoutSeconds", next === "" ? "" : Number(next))
        }
      />
      <section className="info">
        <strong>只读策略与验证门禁</strong>
        <p>
          资源锁、工具白名单和限额由绑定固定。创建或修改后为
          UNVERIFIED；真实只读依据必须来自服务端权限和独立核验。保存不会证明真实只读，不会自动调用下游。
        </p>
      </section>
      {binding && <BindingVerificationStatus binding={binding} />}
      <Errors errors={errors} />
    </div>
  );
}

const pointerParts = (path: string) =>
  path
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
function atPointer(value: any, path: string): any {
  return pointerParts(path).reduce((entry, key) => entry?.[key], value);
}
function withPointer(value: Value, path: string, next: any): Value {
  const parts = pointerParts(path);
  const put = (current: any, index: number): any => {
    if (index === parts.length) return next;
    const key = parts[index];
    const copy =
      Array.isArray(current) && /^\d+$/.test(key)
        ? [...current]
        : object(current)
          ? { ...current }
          : /^\d+$/.test(key)
            ? []
            : {};
    Object.defineProperty(copy, key, {
      value: put(current?.[key], index + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
    return copy;
  };
  return put(value, 0);
}
export function bindingProbeDefaults(binding: Value): Value {
  let args: Value = {};
  for (const [path, value] of Object.entries(binding.lockedArguments ?? {}))
    if (pointer.test(path)) args = withPointer(args, path, value);
  return args;
}

export function BindingVerificationStatus({ binding }: { binding: Value }) {
  const labels: Record<string, string> = {
    UNVERIFIED: "未核验，不能用于真实生产",
    MOCK_VERIFIED: "模拟已验证，非真实联调",
    BINDING_VERIFIED: "此绑定已核验，仍受范围和时间限制",
    REVOKED: "已撤销，后续调用被阻止",
  };
  const record = binding.verification;
  return (
    <section className="info">
      <strong>
        验证等级：{binding.validationStatus ?? "UNVERIFIED"} ·{" "}
        {labels[binding.validationStatus] ?? labels.UNVERIFIED}
      </strong>
      {record ? (
        <dl>
          <dt>核验时间 / 操作者</dt>
          <dd>
            {record.at} / {record.actor}
          </dd>
          <dt>核验范围与独立只读依据</dt>
          <dd>{record.scope}</dd>
          <dt>服务端只读确认</dt>
          <dd>
            {record.serverEnforcedReadOnly
              ? "已由管理人员确认（见范围记录）"
              : "未确认"}
          </dd>
          <dt>探测摘要</dt>
          <dd>{record.probeHash}</dd>
          <dt>证据来源</dt>
          <dd>
            {record.synthetic
              ? "合成 Mock，不能用于真实生产"
              : "已登记连接的实际探测；以记录范围为准"}
          </dd>
        </dl>
      ) : (
        <p>尚无验证记录。正确环境哨兵、资源范围和只读权限尚待核验。</p>
      )}
      <p>
        错误环境拒绝、认证范围和独立权限证据应记录在核验范围中；本表单不自动推断这些证据已齐备，不执行危险写入测试。
      </p>
    </section>
  );
}

export function BindingVerificationForm({
  value,
  onChange,
  onValidityChange,
  binding,
  connections = [],
  tools = [],
}: FormProps) {
  const [jsonValid, setJsonValid] = useState(true);
  const available = connectionTools(
    binding?.connectionId,
    connections,
    tools,
  ).filter((tool) => binding?.allowedTools?.includes(tool.name));
  const tool = available.find((entry) => entry.name === value.probe?.toolName);
  const args = object(value.probe?.arguments) ? value.probe.arguments : {};
  const properties: Value = object(tool?.inputSchema?.properties)
    ? tool.inputSchema.properties
    : {};
  const required: string[] = tool?.inputSchema?.required ?? [];
  const errors: string[] = [];
  if (!binding || binding.revoked || binding.validationStatus === "REVOKED")
    errors.push("绑定缺失或已撤销，不能执行验证。");
  if (!tool) errors.push("请选择绑定允许且已同步的探测工具。");
  if (typeof value.scope !== "string" || !value.scope.trim())
    errors.push("请记录获准的核验范围、服务端只读依据和独立核验记录。");
  if (value.serverEnforcedReadOnly !== true)
    errors.push("独立确认服务端只读权限后才能开始验证。");
  if (
    typeof value.expectedEnvironmentPointer !== "string" ||
    !pointer.test(value.expectedEnvironmentPointer)
  )
    errors.push("请填写响应环境哨兵的 JSON Pointer。");
  if (!object(value.probe?.arguments)) errors.push("探测参数须为 JSON 对象。");
  if (required.some((key) => args[key] === undefined || args[key] === ""))
    errors.push("请补齐工具输入契约中的必填探测参数。");
  if (
    Object.entries(binding?.lockedArguments ?? {}).some(
      ([path, entry]) =>
        JSON.stringify(atPointer(args, path)) !== JSON.stringify(entry),
    )
  )
    errors.push("探测参数必须包含绑定中完全一致的环境和资源锁。");
  useValidity(!errors.length && jsonValid, onValidityChange);
  const change = (key: string, next: any) =>
    onChange({ ...value, [key]: next });
  const changeArgs = (next: Value) =>
    change("probe", { ...value.probe, arguments: next });
  return (
    <div className="configuration-form">
      {binding && (
        <>
          <p>
            固定环境：{environmentLabels[binding.environment]} ·{" "}
            {binding.environment}；连接修订 {binding.connectionRevision}；最大{" "}
            {binding.maxRows} 行 / {binding.timeoutSeconds} 秒。
          </p>
          <BindingVerificationStatus binding={binding} />
        </>
      )}
      {binding?.simulationOnly && (
        <p className="banner">合成 Mock 验证，结果不能授权真实生产访问。</p>
      )}
      <label className="field">
        获准的探测工具
        <select
          aria-label="获准的探测工具"
          value={value.probe?.toolName ?? ""}
          onChange={(event) =>
            change("probe", {
              toolName: event.target.value,
              arguments: binding ? bindingProbeDefaults(binding) : {},
            })
          }
        >
          <option value="">请选择工具</option>
          {available.map((entry) => (
            <option value={entry.name} key={entry.name}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>
      <p>
        工具 Schema：<code>{tool?.schemaHash ?? "尚未同步"}</code>
        。验证将重新同步目录，并向所选工具发出一次明确的小范围探测。
      </p>
      <p>
        探测若返回合成 Mock 证据，结果只能为
        MOCK_VERIFIED，不能升级为真实生产已验证。
      </p>
      {Object.entries(properties).map(([name, schema]) => {
        const path = "/" + name.replaceAll("~", "~0").replaceAll("/", "~1");
        const locked = Object.keys(binding?.lockedArguments ?? {}).some(
          (key) => key === path || key.startsWith(path + "/"),
        );
        const label = `探测参数 ${name}${required.includes(name) ? "（必填）" : ""}`;
        if (locked)
          return (
            <p key={name}>
              {label}：{JSON.stringify(args[name])}（由绑定锁定）
            </p>
          );
        if (Array.isArray(schema.enum))
          return (
            <label className="field" key={name}>
              {label}
              <select
                aria-label={label}
                value={
                  args[name] === undefined ? "" : JSON.stringify(args[name])
                }
                onChange={(event) =>
                  changeArgs({
                    ...args,
                    [name]:
                      event.target.value === ""
                        ? undefined
                        : JSON.parse(event.target.value),
                  })
                }
              >
                <option value="">请选择</option>
                {schema.enum.map((entry: any) => (
                  <option
                    key={JSON.stringify(entry)}
                    value={JSON.stringify(entry)}
                  >
                    {String(entry)}
                  </option>
                ))}
              </select>
            </label>
          );
        if (schema.type === "boolean")
          return (
            <label className="field" key={name}>
              {label}
              <select
                aria-label={label}
                value={args[name] === undefined ? "" : String(args[name])}
                onChange={(event) =>
                  changeArgs({
                    ...args,
                    [name]:
                      event.target.value === ""
                        ? undefined
                        : event.target.value === "true",
                  })
                }
              >
                <option value="">请选择</option>
                <option value="true">是</option>
                <option value="false">否</option>
              </select>
            </label>
          );
        if (["string", "number", "integer"].includes(schema.type))
          return (
            <Field
              key={name}
              label={label}
              type={schema.type === "string" ? "text" : "number"}
              value={args[name]}
              onChange={(next) =>
                changeArgs({
                  ...args,
                  [name]:
                    schema.type === "string"
                      ? next
                      : next === ""
                        ? undefined
                        : Number(next),
                })
              }
            />
          );
        return <p key={name}>{label}：复杂参数请在高级 JSON 区填写。</p>;
      })}
      <details>
        <summary>高级：完整探测参数</summary>
        <JsonObjectField
          label="探测参数 JSON"
          value={args}
          onChange={changeArgs}
          onValidityChange={setJsonValid}
        />
      </details>
      <Field
        label="响应环境哨兵路径"
        value={value.expectedEnvironmentPointer}
        onChange={(next) => change("expectedEnvironmentPointer", next)}
      />
      <Field
        label="预期环境哨兵值"
        value={value.expectedEnvironmentValue ?? binding?.environment}
        onChange={(next) => change("expectedEnvironmentValue", next)}
      />
      <label className="field">
        核验范围与独立只读依据
        <textarea
          aria-label="核验范围与独立只读依据"
          rows={5}
          value={value.scope ?? ""}
          onChange={(event) => change("scope", event.target.value)}
        />
      </label>
      <p>
        记录获准资源、账号权限来源、错误环境拒绝、输出上限和认证范围的核验结果与本机证据引用。仅工具声明的
        readOnlyHint 不构成只读依据；缺少证明时保持未核验。
      </p>
      <label>
        <input
          type="checkbox"
          checked={value.serverEnforcedReadOnly === true}
          onChange={(event) =>
            change("serverEnforcedReadOnly", event.target.checked)
          }
        />
        我已独立核对服务端只读权限，确认此探测在获准环境和资源范围内
      </label>
      <Errors errors={errors} />
    </div>
  );
}
