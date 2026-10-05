import { BUILTIN_PLUGIN_DEFINITIONS, PROTOCOL_METHODS, type ProtocolMethod } from "@keymaster/contracts";

type Provider = { readonly id: string; readonly units: readonly { readonly id?: string; readonly connect?: { readonly providerMethods: readonly string[] } }[] };
/** Only explicitly declared methods enter Connect. Namespace and private capabilities confer no publication rights. */
export function createProviderDispatch<T, R>(handlers: Record<ProtocolMethod, (request: T) => Promise<R>>, providers: readonly Provider[] = BUILTIN_PLUGIN_DEFINITIONS): ReadonlyMap<ProtocolMethod, (request: T) => Promise<R>> {
  const dispatch = new Map<ProtocolMethod, (request: T) => Promise<R>>();
  for (const provider of providers) for (const unit of provider.units) for (const name of unit.connect?.providerMethods ?? []) {
    if (!(PROTOCOL_METHODS as readonly string[]).includes(name)) throw new Error(`Unknown Connect method declared by ${provider.id}: ${name}`);
    const method = name as ProtocolMethod;
    if (dispatch.has(method)) throw new Error(`Duplicate Connect provider for ${method}`);
    if (!handlers[method]) throw new Error(`Missing Connect handler for ${method}`);
    dispatch.set(method, handlers[method]);
  }
  for (const method of PROTOCOL_METHODS) if (!dispatch.has(method)) throw new Error(`Missing Connect provider for ${method}`);
  return dispatch;
}
