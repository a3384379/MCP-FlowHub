import type { useVaultState } from "../../shared/useVaultState";

export function VaultNotice({
  vault,
  unlock,
}: {
  vault: ReturnType<typeof useVaultState>;
  unlock: () => void;
}) {
  if (!vault.locked) return null;
  return (
    <div className="vault-notice" role="status">
      <span>此工作区有旧版凭据。用原口令迁移一次，即可继续使用已保存的 Key。</span>
      <button type="button" onClick={unlock}>迁移旧版凭据</button>
    </div>
  );
}
