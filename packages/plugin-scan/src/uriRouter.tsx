import { createElement } from "react";
import { ScopedPluginConsumerProvider as PluginConsumerProvider } from "@keymaster/runtime";
import { createScopedRegistryView } from "webloom-framework/advanced";
import { isIssuedKeymasterConsumer, useInstanceActive } from "@keymaster/runtime";
import { URI_ACTION_REGISTRY_CAPABILITY, URI_ACTION_RESOLVER_CAPABILITY, SCAN_UI_CAPABILITY,
  type UriActionHandler, type UriActionRegistry, type UriActionResolver, type UriActionResolution, type UriActionCandidate, type UriActionView, type ScanUiAccess } from "@keymaster/contracts";
import type { LifecycleScope, PluginConsumer } from "webloom-framework";

interface Entry { handler: UriActionHandler; consumer: PluginConsumer; scope: LifecycleScope }
interface Choice { entry: Entry; actionId: string; description: UriActionCandidate }
interface Session { id: string; input: string; scope: LifecycleScope; choices: Map<string, Choice> }
export function createUriRouter(providerScope: LifecycleScope) {
  const handlers = new Map<string, Entry>();
  const sessions = new Map<string, Session>();
  const listeners = new Set<() => void>();
  const resolverViews = new WeakMap<PluginConsumer, UriActionView>();
  let revision = 0;
  let ui: { scope: LifecycleScope; input?: string; selected?: { session: Session; choice: Choice } } | undefined;
  const live = (entry: Entry) => providerScope.state === "active" && entry.scope.state === "active" && entry.consumer.status === "active" && handlers.get(entry.handler.id) === entry;
  const changed = () => { revision++; for (const listener of [...listeners]) { try { listener(); } catch { /* 观察方不影响注册提交。 */ } } };
  const check = (consumer: PluginConsumer, scope: LifecycleScope, capability: typeof URI_ACTION_REGISTRY_CAPABILITY | typeof URI_ACTION_RESOLVER_CAPABILITY | typeof SCAN_UI_CAPABILITY) => {
    providerScope.assertActive(); scope.assertActive();
    if (!isIssuedKeymasterConsumer(consumer, scope) || consumer.status !== "active") throw new Error("URI access requires its issued consumer and Scope");
    consumer.capability(capability);
  };
  const registry: UriActionRegistry = {
    bind(consumer, scope) {
      check(consumer, scope, URI_ACTION_REGISTRY_CAPABILITY);
      const target = {
        register(handler: UriActionHandler & { ownerInstanceId?: string }) {
          check(consumer, scope, URI_ACTION_REGISTRY_CAPABILITY);
          if (handler.ownerInstanceId !== consumer.instanceId || !handler.id || typeof handler.resolve !== "function" || typeof handler.render !== "function" || (handler.order !== undefined && !Number.isFinite(handler.order))) throw new Error("Invalid URI handler ownership or definition");
          if (handlers.has(handler.id)) throw new Error("URI handler already registered");
          handlers.set(handler.id, { handler: Object.freeze({ ...handler }), consumer, scope }); changed();
        },
        unregister(id: string) {
          const entry = handlers.get(id);
          if (!entry || entry.consumer !== consumer) throw new Error("URI handler is not owned by this instance");
          handlers.delete(id);
          for (const session of sessions.values()) for (const [key, choice] of session.choices) if (choice.entry === entry) session.choices.delete(key);
          if (ui?.selected?.choice.entry === entry) { sessions.delete(ui.selected.session.id); ui = undefined; }
          changed();
        },
      };
      return createScopedRegistryView(target, scope, { name: "uri.action", registrations: [{ method: "register", idArgument: 0, unregisterMethod: "unregister", ownerInstanceIdProperty: "ownerInstanceId" }] });
    },
  };
  const resolver: UriActionResolver = {
    bind(consumer, scope) {
      check(consumer, scope, URI_ACTION_RESOLVER_CAPABILITY);
      const cached = resolverViews.get(consumer);
      if (cached) return cached;
      const owned = new Set<string>();
      scope.onRevoke(() => { for (const id of owned) sessions.delete(id); owned.clear(); if (ui?.scope === scope) ui = undefined; changed(); });
      const requireSession = (id: string) => {
        check(consumer, scope, URI_ACTION_RESOLVER_CAPABILITY);
        const session = sessions.get(id);
        if (!owned.has(id) || !session || session.scope !== scope) throw new Error("URI resolution expired or belongs to another instance");
        return session;
      };
      const view: UriActionView = {
        resolve(raw) {
          check(consumer, scope, URI_ACTION_RESOLVER_CAPABILITY);
          if (typeof raw !== "string" || !raw.trim() || raw.length > 16384) throw new Error("URI input must contain 1–16384 characters");
          // 当前视图最多保留 16 次解析；识别内容仅在内存，释放/撤销即删除。
          while (owned.size >= 16) { const id = owned.values().next().value!; owned.delete(id); sessions.delete(id); if (ui?.selected?.session.id === id) { ui = undefined; changed(); } }
          const session: Session = { id: crypto.randomUUID(), input: raw.trim(), scope, choices: new Map() };
          for (const entry of [...handlers.values()].sort((a,b) => (a.handler.order ?? 0) - (b.handler.order ?? 0) || a.handler.id.localeCompare(b.handler.id))) {
            if (!live(entry)) continue;
            try {
              const descriptions = entry.handler.resolve(session.input);
              if (!live(entry) || !Array.isArray(descriptions)) continue;
              const actionIds = new Set<string>();
              for (const descriptor of descriptions.slice(0, 32)) {
                if (!descriptor?.id || actionIds.has(descriptor.id) || !descriptor.label) continue;
                actionIds.add(descriptor.id);
                const id = crypto.randomUUID();
                const metadata = (label: typeof descriptor.label) => typeof label === "string" ? label : Object.freeze({ key: label.key, fallback: label.fallback });
                const description = Object.freeze({ id, pluginId: entry.consumer.pluginId, label: metadata(descriptor.label), ...(descriptor.description ? { description: metadata(descriptor.description) } : {}) });
                session.choices.set(id, { entry, actionId: descriptor.id, description });
              }
            } catch { /* 一个格式处理器失败不影响其它处理器，不记录原始输入。 */ }
          }
          while (sessions.size >= 128) { const id = sessions.keys().next().value!; sessions.delete(id); if (ui?.selected?.session.id === id) { ui = undefined; changed(); } }
          sessions.set(session.id, session); owned.add(session.id);
          return Object.freeze({ id: session.id, candidates: Object.freeze([...session.choices.values()].map(choice => choice.description)) }) satisfies UriActionResolution;
        },
        activate(id, choiceId) {
          const session = requireSession(id), choice = session.choices.get(choiceId);
          if (!choice || !live(choice.entry)) throw new Error("URI action is no longer available");
          // 执行前重新核对输入及动作；始终先进入提供方 UI，不直接执行业务。
          if (!choice.entry.handler.resolve(session.input).some(item => item.id === choice.actionId)) throw new Error("URI action no longer matches");
          check(consumer, scope, URI_ACTION_RESOLVER_CAPABILITY);
          if (!live(choice.entry) || !sessions.has(id)) throw new Error("URI action was revoked");
          const origin = consumer.pluginId === "scan" ? ui?.scope ?? scope : scope;
          origin.assertActive();
          ui = { scope: origin, selected: { session, choice } }; changed();
        },
        release(id) { requireSession(id); sessions.delete(id); owned.delete(id); if (ui?.selected?.session.id === id) ui = undefined; changed(); },
      };
      resolverViews.set(consumer, Object.freeze(view));
      return view;
    },
  };
  const scanUi: ScanUiAccess = { bind(consumer, scope) {
    check(consumer, scope, SCAN_UI_CAPABILITY);
    scope.onRevoke(() => { if (ui?.scope === scope) { if (ui.selected) sessions.delete(ui.selected.session.id); ui = undefined; changed(); } });
    return Object.freeze({ open(input?: string) { check(consumer, scope, SCAN_UI_CAPABILITY); if (input !== undefined && (typeof input !== "string" || input.length > 16384)) throw new Error("Invalid scan input"); if (ui?.selected) sessions.delete(ui.selected.session.id); ui = { scope, input }; changed(); } });
  } };
  function BusinessContents({ session, choice }: { session: Session; choice: Choice }) {
    return choice.entry.handler.render(choice.actionId, session.input, close);
  }
  function BusinessUi({ session, choice }: { session: Session; choice: Choice }) {
    const active = useInstanceActive(choice.entry.consumer, choice.entry.scope);
    const callerActive = session.scope.state === "active";
    return active && callerActive && live(choice.entry) ? createElement(PluginConsumerProvider, { consumer: choice.entry.consumer,
      children: createElement(BusinessContents, { session, choice }),
    }) : null;
  }
  function close() { if (ui?.selected) sessions.delete(ui.selected.session.id); ui = undefined; changed(); }
  providerScope.onRevoke(() => { handlers.clear(); sessions.clear(); ui = undefined; changed(); listeners.clear(); });
  return { registry: Object.freeze(registry), resolver: Object.freeze(resolver), scanUi: Object.freeze(scanUi), revision: () => revision,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => ui, close,
    renderSelected() { const selected = ui?.selected; return selected && sessions.get(selected.session.id) === selected.session && live(selected.choice.entry) ? createElement(BusinessUi, { key: selected.session.id + selected.choice.description.id, ...selected }) : null; },
  };
}
export type UriRouter = ReturnType<typeof createUriRouter>;
