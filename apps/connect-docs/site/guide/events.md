# Handle events

Keymaster can push verified JSON messages for the exact channels subscribed by
the current Session Window.

```ts
const keymaster = new KeymasterConnectClient({
  targetOrigin: keymasterDeploymentOrigin,
  onEvent(event) {
    if (event.event === "channel.message_received") {
      const { channel, publisherPublicKeyHex, messageId, content } = event.data;
      // Route verified JSON content to the matching local channel.
    }
  }
});
```

Events are independent of request/result correlation:

- They do not consume a pending request id.
- They may arrive between any two result messages.
- They are accepted only from the configured origin and current Session Window.
- They stop when the transport becomes disconnected.

Events are live delivery only. Persist any application state that must survive
a disconnected Session Window and restore the exact subscription set after
reconnecting.
