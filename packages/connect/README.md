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

Channel operations are provider-neutral. Connect Apps publish JSON content to
an exact channel and replace their own exact subscription set; Keymaster owns
the signing key, supplier selection, physical subscription, and private
protocol routing. Apps do not select Suppliers and do not receive SSP/SPI
configuration or raw protocol operations. A successful `channel.publish`
means that Keymaster accepted the local publish operation, not that a remote
recipient has received or read it.

The SDK has no default Keymaster hostname. Direct integrations must supply the
exact origin of the Keymaster instance they trust. Apps launched in appView
mode receive the Session Window origin from their launch URL.
