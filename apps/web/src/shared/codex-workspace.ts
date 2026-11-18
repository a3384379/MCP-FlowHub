const prefix = "/codex";
export const inCodexWorkspace = document.querySelector('meta[name="flowhub-codex-sidebar"]') !== null;
export const workspacePath = () => inCodexWorkspace ? location.pathname.slice(prefix.length) || "/" : location.pathname;
export const workspaceHref = (path: string) => inCodexWorkspace ? prefix + path : path;

export function readCodexLaunch() {
  if (!inCodexWorkspace || !location.hash) return undefined;
  const ticket = new URLSearchParams(location.hash.slice(1)).get("launch");
  history.replaceState(history.state, "", location.pathname + location.search);
  return ticket ?? undefined;
}

// Cross-origin frames cannot rely on window.confirm() or window.prompt().
export async function workspaceDialog(title: string, acceptLabel: string, fieldLabel?: string) {
  const dialog = document.createElement("dialog");
  dialog.className = "modal";
  dialog.setAttribute("aria-label", title);
  const form = document.createElement("form");
  form.method = "dialog";
  const heading = document.createElement("h2");
  heading.textContent = title;
  form.append(heading);
  const field = fieldLabel ? document.createElement("input") : undefined;
  if (field) {
    const label = document.createElement("label");
    label.className = "field";
    label.textContent = fieldLabel!;
    field.required = true;
    label.append(field);
    form.append(label);
  }
  const actions = document.createElement("div");
  actions.className = "actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "取消";
  cancel.autofocus = true;
  cancel.onclick = () => dialog.close();
  const accept = document.createElement("button");
  accept.className = "primary";
  accept.value = "accept";
  accept.textContent = acceptLabel;
  actions.append(cancel, accept);
  form.append(actions);
  dialog.append(form);
  document.body.append(dialog);
  const answer = new Promise<string | null>(resolve => {
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "accept" ? field?.value.trim() ?? "accept" : null);
      dialog.remove();
    }, { once: true });
  });
  dialog.showModal();
  return answer;
}
