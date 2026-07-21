import type { ContactPublicKeyAction, ContactPublicKeyActionRegistry } from "@keymaster/contracts";

export function createContactPublicKeyActionRegistry(): ContactPublicKeyActionRegistry {
  const actions = new Map<string, ContactPublicKeyAction>();
  return {
    register(action) {
      if (actions.has(action.id)) throw new Error(`Contact public-key action already registered: ${action.id}`);
      actions.set(action.id, action);
    },
    unregister(id) {
      if (!actions.has(id)) throw new Error(`Contact public-key action not registered: ${id}`);
      actions.delete(id);
    },
    list() {
      return [...actions.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    },
    get(id) { return actions.get(id); },
    _ids() { return [...actions.keys()]; }
  };
}
