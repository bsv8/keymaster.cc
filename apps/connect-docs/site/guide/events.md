# Handle events

Keymaster can push application messages and subscribed broadcasts while the
Session Window remains connected.

```ts
const keymaster = new KeymasterConnectClient({
  targetOrigin: "https://keymaster.cc",
  onEvent(event) {
    switch (event.event) {
      case "appmsg.message_received":
        // Merge the complete message into the local inbox.
        break;
      case "broadcast.message_received":
        // Route the complete broadcast to the matching channel.
        break;
    }
  }
});
```

Events are independent of request/result correlation:

- They do not consume a pending request id.
- They may arrive between any two result messages.
- They are accepted only from the configured origin and current Session Window.
- They stop when the transport becomes disconnected.

Use the relevant list method after reconnecting when the application needs to
reconcile events that may have arrived while its window was closed.
