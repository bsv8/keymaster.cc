# Sessions

Connect deliberately separates three lifetimes.

## Browser transport

The Session Window carries `postMessage` traffic. It moves from `opening` to
`connected` after the readiness handshake, and to `disconnected` when either
side closes.

## Persistent authorization

`connect.login` creates a session bound to:

- the caller's exact origin;
- the owner public key selected by the user;
- an optional verified app identity.

The resulting `connectSessionId` survives Session Window closure and is required
by every business method. Store it according to the security policy of your
application.

## Unlock runtime

A persistent authorization does not mean the current window can use private-key
capabilities immediately. After a refresh or new popup, `connect.resume` restores
the short-lived owner runtime without selecting a different identity.

```text
Session Window closes
        │
        ├── transport: disconnected
        ├── unlock runtime: gone
        └── Connect session: still authorized
                              │
                              └── connect.resume(sessionId)
```

Only `connect.logout` revokes the persistent session.
