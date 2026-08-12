# appView mode

appView is used when Keymaster launches an application and provides a one-time
launch token. The application reuses `window.opener` as its Session Window.

```ts
const keymaster = new KeymasterConnectClient({
  targetOrigin: sessionWindowOrigin,
  mode: "appView"
});

await keymaster.connect();

const session = await keymaster.launch({
  launchToken,
  appIdentity
});
```

In this mode the SDK:

- adopts the existing opener;
- sends the child readiness message after installing its listener;
- never calls `window.open()` as a fallback;
- never closes the opener from `close()`;
- fails closed when the opener is absent or lost.

`connect.launch` is intentionally rejected in popup mode. A consumed or invalid
launch token cannot fall back to `connect.login`.
