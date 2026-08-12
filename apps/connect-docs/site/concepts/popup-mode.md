# Direct popup mode

Popup mode is the default for independently hosted web applications.

```ts
const keymaster = new KeymasterConnectClient({
  targetOrigin: keymasterDeploymentOrigin,
  mode: "popup"
});
```

The first `connect()` or `request()` call:

1. installs the message listener;
2. opens `/protocol/v1/popup` on the configured Keymaster origin;
3. waits for the popup's `ready` message;
4. begins request/result traffic.

The SDK reuses the same named Session Window. Call the first operation from a
click or another user activation so popup blockers permit it.

`close()` closes a popup owned by the SDK, rejects pending local promises, and
removes browser listeners. It does not call `connect.logout` implicitly.
