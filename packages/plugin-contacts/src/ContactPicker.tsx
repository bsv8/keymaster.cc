// packages/plugin-contacts/src/ContactPicker.tsx
// 联系人选择器。
// 设计缘由：让 transfer 等页面通过 capability / slot 接入，禁止直接 import 该组件源码。
//
// 硬切换 008 收尾：listContacts 失败时（all 模式 / 无 active key）展示空 options，
// 不让转账 widget 因联系人插件报错而影响转账。
//
// 硬切换 003：label / placeholder 走 i18n。

import { useEffect, useState } from "react";
import { Select } from "@keymaster/ui";
import { useCapability, useI18n } from "@keymaster/runtime";
import type { Contact, ContactsService } from "@keymaster/contracts";

export interface ContactPickerProps {
  value?: string;
  onChange: (address: string) => void;
  placeholder?: string;
}

export function ContactPicker({ value, onChange, placeholder }: ContactPickerProps) {
  const service = useCapability<ContactsService>("contacts.service");
  const { t } = useI18n();
  useI18n().language();
  const [contacts, setContacts] = useState<Contact[]>([]);

  useEffect(() => {
    let mounted = true;
    service.listContacts()
      .then((list) => {
        if (!mounted) return;
        setContacts(list);
      })
      .catch(() => {
        if (mounted) setContacts([]);
      });
    return () => {
      mounted = false;
    };
  }, [service]);

  return (
    <Select
      label={t("contacts.picker.label", { defaultValue: "联系人" })}
      value={value ?? ""}
      onChange={(e) => onChange(e.currentTarget.value)}
      options={[
        {
          label: placeholder ?? t("contacts.picker.placeholder", { defaultValue: "选择联系人" }),
          value: ""
        },
        ...contacts.map((c) => ({ label: `${c.name} - ${c.address}`, value: c.address }))
      ]}
    />
  );
}
