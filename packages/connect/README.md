# @keymaster/connect

Official browser SDK for Keymaster Connect V1.

```ts
import { KeymasterConnectClient } from "@keymaster/connect";

const keymaster = new KeymasterConnectClient({
  targetOrigin: "https://keymaster.cc"
});

const session = await keymaster.login({
  text: "Sign in to Example"
});
```

The complete guides and API reference are built by `apps/connect-docs`.
