# Getting started

Keymaster Connect gives browser applications typed access to identity, signing,
encryption, messaging, storage, broadcasts, and controlled BSV payments. Private
keys stay inside Keymaster.

## Install

```bash
pnpm add @keymaster/connect
```

The SDK requires a browser. It does not create a server connection and it does
not send private material to your application.

## Create a client

```ts
import { KeymasterConnectClient } from "@keymaster/connect";

const keymaster = new KeymasterConnectClient({
  targetOrigin: "https://keymaster.cc"
});
```

`targetOrigin` is normalized once and then used for every `postMessage` target
and origin check. Paths, query strings, and fragments are ignored.

## Log in

Call login from a user gesture so the browser can open the Session Window.

```ts
const session = await keymaster.login({
  text: "Sign in to Example",
  claims: ["profile.name", "profile.avatar"]
});

localStorage.setItem(
  "keymaster.connectSessionId",
  session.connectSessionId
);
```

The user chooses the owner identity in Keymaster. Your application cannot select
an owner public key in the login request.

## Call a capability

Every business request carries the persistent session id:

```ts
import { binaryText } from "@keymaster/connect";

const encrypted = await keymaster.request("cipher.encrypt", {
  text: "Encrypt my draft",
  contentType: "text/plain",
  content: binaryText("A private draft"),
  connectSessionId: session.connectSessionId
});
```

The method literal controls both parameter validation and the inferred result
type. There is no untyped RPC result cast in application code.

## Resume after the window closes

Closing a Session Window disconnects the browser transport. It does not revoke
the persistent authorization.

```ts
const resumed = await keymaster.resume(savedConnectSessionId);
```

Call `logout()` when the application intends to revoke the session:

```ts
await keymaster.logout(savedConnectSessionId);
keymaster.close();
```

## Next

- Learn the [session model](/concepts/sessions).
- Browse all [capability families](/guide/capabilities).
- Read the [`KeymasterConnectClient` API](/api/classes/KeymasterConnectClient).
