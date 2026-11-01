import type { useVaultState } from "../../shared/useVaultState";

export function VaultNotice({
  vault,
  unlock,
}: {
  vault: ReturnType<typeof useVaultState>;
  unlock: () => void;
}) {
  if (vault.locked === false || (vault.locked === null && !vault.error))
    return null;
  return (
    <div className="vault-notice" role="status">
      <span>
        {vault.locked === true
          ? "凭据库已锁定，已保存的 Key 仍保留。服务重启后需先解锁。"
          : "暂时无法确认凭据库状态，请重新读取。"}
      </span>
      {vault.locked === true ? (
        <button type="button" onClick={unlock}>
          解锁凭据库
        </button>
      ) : (
        <button type="button" onClick={() => void vault.refresh()}>
          重新读取凭据状态
        </button>
      )}
    </div>
  );
}
