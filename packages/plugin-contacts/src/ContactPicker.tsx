// packages/plugin-contacts/src/ContactPicker.tsx
// 联系人选择器。
//
// 设计缘由：
//   - 对外只返回 publicKeyHex；
//   - 展示文本用 name + 短公钥；
//   - 允许 transfer / message 等消费方只拿身份，不拿地址投影。

import { useCapability, useI18n, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import { Select } from "@keymaster/ui";
import { formatShortPublicKey, type Contact } from "@keymaster/contracts";

export interface ContactPickerProps {
  value?: string;
  onChange: (publicKeyHex: string) => void;
  placeholder?: string;
}

export function ContactPicker({ value, onChange, placeholder }: ContactPickerProps) {
  const host = usePluginHost();
  const { t } = useI18n();
  const contacts = useResourceSelector<Contact[], Contact[]>(
    host.resourceStore, "contacts.list", [],
    (snapshot) => snapshot.data ?? [],
    (a, b) => a === b
  );

  return (
    <Select
      label={t("contacts.picker.label", { defaultValue: "Contacts" })}
      value={value ?? ""}
      onChange={(e) => onChange(e.currentTarget.value)}
      options={[
        {
          label: placeholder ?? t("contacts.picker.placeholder", { defaultValue: "Pick a contact" }),
          value: ""
        },
        ...contacts.map((c) => ({
          label: `${c.name} - ${formatShortPublicKey(c.publicKeyHex)}`,
          value: c.publicKeyHex
        }))
      ]}
    />
  );
}
