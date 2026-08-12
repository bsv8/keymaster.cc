# Errors and cancellation

The SDK separates browser transport failures from structured Keymaster
rejections.

```ts
import {
  KeymasterProtocolError,
  KeymasterTransportError
} from "@keymaster/connect";

try {
  await keymaster.resume(sessionId);
} catch (error) {
  if (error instanceof KeymasterProtocolError) {
    console.log(error.code, error.message);
  } else if (error instanceof KeymasterTransportError) {
    console.log(error.code);
  }
}
```

## Protocol rejection

`KeymasterProtocolError` means a valid result was received with `ok: false`.
Switch on `error.code`; do not parse the English diagnostic message.

User cancellation, local payment failures, and several policy failures are
intentionally collapsed so callers cannot infer sensitive wallet state.

## Transport failure

`KeymasterTransportError` describes popup blocking, window closure, readiness
timeouts, request timeouts, appView opener loss, or a local client shutdown.
These errors do not imply that a persistent Connect session has been revoked.

## AbortSignal

```ts
const controller = new AbortController();

const result = keymaster.request(
  "identity.get",
  params,
  { requestId: crypto.randomUUID(), signal: controller.signal }
);

controller.abort();
```

Aborting rejects the local promise immediately and sends a best-effort `cancel`
control message. Keymaster can cancel queued or confirming work; executing work
is not compensatable.
