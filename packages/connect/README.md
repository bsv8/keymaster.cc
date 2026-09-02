# @keymaster/connect

Official browser SDK for Keymaster Connect V1.

```ts
import { KeymasterConnectClient } from "@keymaster/connect";

// Read this from your application's deployment configuration.
const keymasterDeploymentOrigin = getRequiredConfig("KEYMASTER_ORIGIN");

const keymaster = new KeymasterConnectClient({
  targetOrigin: keymasterDeploymentOrigin
});

const session = await keymaster.login({
  text: "Sign in to Example"
});
```

The complete guides and API reference are built by `apps/connect-docs`.

`appmsg.*` is provider-neutral: Keymaster may use HubMsg or its trusted
SatSubscription provider according to the user's settings. Connect Apps do not
select Suppliers and do not receive SSP/SPI configuration or raw protocol
operations. A successful `appmsg.send` is an accepted local send result, not a
delivery or read receipt.

The SDK has no default Keymaster hostname. Direct integrations must supply the
exact origin of the Keymaster instance they trust. Apps launched in appView
mode receive the Session Window origin from their launch URL.
