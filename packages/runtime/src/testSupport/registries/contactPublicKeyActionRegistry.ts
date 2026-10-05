import type { ContactPublicKeyAction, ContactPublicKeyActionRegistry } from "@keymaster/contracts";

export function createContactPublicKeyActionRegistry(): ContactPublicKeyActionRegistry {
  const actions = new Map<string, ContactPublicKeyAction>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of [...listeners]) { try { listener(); } catch { /* 观察故障不能破坏注册。 */ } } };
  return {
    register(action) {
      if (actions.has(action.id)) throw new Error(`Contact public-key action already registered: ${action.id}`);
      actions.set(action.id, action);
      notify();
    },
    unregister(id) {
      if (!actions.has(id)) throw new Error(`Contact public-key action not registered: ${id}`);
      actions.delete(id);
      notify();
    },
    list() {
      return [...actions.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    },
    get(id) { return actions.get(id); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    _ids() { return [...actions.keys()]; }
  };
}
