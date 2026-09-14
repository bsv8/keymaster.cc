// SharedWorker 只使用 Contacts 的纯业务服务与在线探测任务。
// 不从这里导入 manifest、页面或 React，避免把 UI 装配带进 Coordinator。

export { createContactsService, createContactsPresenceTask } from "./contactsService.js";
export type { ContactsServiceDeps, ContactsPresenceTaskDeps } from "./contactsService.js";
