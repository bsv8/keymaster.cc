# Call capabilities

`request(method, params)` is the canonical SDK operation. Its generic mapping is
derived from the same protocol contracts used by Keymaster.

## Identity and intent

| Method | Purpose |
| --- | --- |
| `identity.get` | Return a signed identity envelope and the requested claims. |
| `intent.sign` | Sign caller-provided bytes inside a human-readable intent. |

Identity requests include `aud`, `iat`, and `exp`. `aud` must equal the caller's
exact browser origin.

## Origin-bound cryptography

| Method | Purpose |
| --- | --- |
| `cipher.encrypt` | Encrypt bytes for the session owner and caller origin. |
| `cipher.decrypt` | Decrypt a previously returned ciphertext. |

The SDK exposes `binary()`, `binaryText()`, `binaryBytes()`, and `binaryToText()`
for the protocol's explicit binary representation.

## Application messages

| Method | Purpose |
| --- | --- |
| `appmsg.send` | Send an end-to-end sealed message. |
| `appmsg.list` | Incrementally list visible messages. |
| `appmsg.get` | Fetch one visible message. |

Incoming messages are delivered through `onEvent`; they do not occupy a request
slot and do not produce a result message.

## Broadcasts

| Method | Purpose |
| --- | --- |
| `broadcast.publish` | Publish a message signed by the session owner. |
| `broadcast.subscription_set` | Replace this caller's exact channel set. |
| `broadcast.subscription_list` | Read this caller's channel set. |

## Storage

Storage is available only to sessions with a verified app identity whose
requirements include `storage`.

| Method family | Purpose |
| --- | --- |
| `storage.list` | List app-scoped paths. |
| `storage.directory.*` | Create or delete directories. |
| `storage.put/get/delete` | Manage objects up to the direct payload limit. |
| `storage.upload.*` | Upload larger objects in fixed-size parts. |

Paths are relative to the verified application namespace. Provider credentials,
buckets, and physical object keys are never exposed to the caller.

## Payments

| Method | Purpose |
| --- | --- |
| `p2pkh.transfer` | Request a controlled mainnet P2PKH transfer. |
| `feepool.prepare` | Prepare the next fee-pool draft operation. |
| `feepool.commit` | Verify counterparty signatures and commit the draft. |

Payment confirmation text and policy are controlled by Keymaster, not by the
calling application.

See the complete [method parameter map](/api/interfaces/MethodParamsMap) and
[result map](/api/interfaces/MethodResultMap).
