import type { BsvNetwork } from "@keymaster/contracts";
import { useId } from "react";

/** 仅身份创建/导入页使用，既有身份不提供网络编辑入口。 */
export function NetworkIdentitySelect({ value, onChange }: { value: BsvNetwork; onChange(network: BsvNetwork): void }) {
  const id = useId();

  return (
    <fieldset className="vault-network" aria-describedby={`${id}-hint`}>
      <legend className="vault-network__title">BSV 网络</legend>
      <div className="vault-network__options">
        {([
          { network: "main", title: "主网", subtitle: "Mainnet" },
          { network: "test", title: "测试网", subtitle: "Testnet" },
        ] as const).map(({ network, title, subtitle }) => (
          <label key={network} className="vault-network__option">
            <input
              type="radio"
              name={`${id}-network`}
              value={network}
              checked={value === network}
              onChange={() => onChange(network)}
            />
            <span className="vault-network__content">
              <strong>{title}</strong>
              <span>{subtitle}</span>
            </span>
          </label>
        ))}
      </div>
      <p id={`${id}-hint`} className="vault-network__hint">网络在创建钱包后不可修改。</p>
    </fieldset>
  );
}
