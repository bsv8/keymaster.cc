---
pageClass: capability-map-page
---

# SDK capability map

`@keymaster/connect` exposes seven capability groups through one
[`KeymasterConnectClient`](/api/classes/KeymasterConnectClient). This page is the
complete operation index: select an SDK method to read its call contract, or
select a Params/Result type to inspect every field.

## Shared call model

Every named operation delegates to the same type-safe protocol transport:

```ts
const result = await keymaster.identityGet(params, options);
```

- `params` is specific to the operation.
- [`KeymasterRequestOptions`](/api/interfaces/KeymasterRequestOptions) optionally
  supplies a request id, timeout, or `AbortSignal`.
- The returned promise resolves to the operation's Result type.
- Except for `connect.login` and `connect.launch`, capability requests belong to
  an existing `connectSessionId`.

## Connect

Create and manage the persistent session that binds the caller origin to a
Keymaster owner identity.

| Operation | Type contract | Purpose |
| --- | --- | --- |
| `connect.login`<br>[`login()`](/api/classes/KeymasterConnectClient#login) | [`ConnectLoginParams`](/api/interfaces/ConnectLoginParams) → [`ConnectLoginResult`](/api/interfaces/ConnectLoginResult) | Create a session after the user selects an owner identity. |
| `connect.resume`<br>[`resume()`](/api/classes/KeymasterConnectClient#resume) | [`ConnectResumeParams`](/api/interfaces/ConnectResumeParams) → [`ConnectResumeResult`](/api/interfaces/ConnectResumeResult) | Restore the unlock runtime for an existing session. |
| `connect.logout`<br>[`logout()`](/api/classes/KeymasterConnectClient#logout) | [`ConnectLogoutParams`](/api/interfaces/ConnectLogoutParams) → [`ConnectLogoutResult`](/api/interfaces/ConnectLogoutResult) | Revoke a persistent session. |
| `connect.launch`<br>[`launch()`](/api/classes/KeymasterConnectClient#launch) | [`ConnectLaunchParams`](/api/interfaces/ConnectLaunchParams) → [`ConnectLaunchResult`](/api/interfaces/ConnectLaunchResult) | Consume an appView launch token and establish its session. |

## Identity

Read signed claims or sign caller-provided content as an explicit,
human-readable intent.

| Operation | Type contract | Purpose |
| --- | --- | --- |
| `identity.get`<br>[`identityGet()`](/api/classes/KeymasterConnectClient#identityget) | [`IdentityGetParams`](/api/interfaces/IdentityGetParams) → [`IdentityGetResult`](/api/interfaces/IdentityGetResult) | Return a signed identity envelope and requested claims. |
| `intent.sign`<br>[`intentSign()`](/api/classes/KeymasterConnectClient#intentsign) | [`IntentSignParams`](/api/interfaces/IntentSignParams) → [`IntentSignResult`](/api/interfaces/IntentSignResult) | Sign application bytes inside a human-readable intent. |

Identity requests include `aud`, `iat`, and `exp`. `aud` must equal the caller's
exact browser origin.

## Cipher

Encrypt data for the session owner and exact caller origin, then decrypt it in
the same trust context.

| Operation | Type contract | Purpose |
| --- | --- | --- |
| `cipher.encrypt`<br>[`cipherEncrypt()`](/api/classes/KeymasterConnectClient#cipherencrypt) | [`CipherEncryptParams`](/api/interfaces/CipherEncryptParams) → [`CipherEncryptResult`](/api/interfaces/CipherEncryptResult) | Encrypt typed binary content. |
| `cipher.decrypt`<br>[`cipherDecrypt()`](/api/classes/KeymasterConnectClient#cipherdecrypt) | [`CipherDecryptParams`](/api/interfaces/CipherDecryptParams) → [`CipherDecryptResult`](/api/interfaces/CipherDecryptResult) | Recover the content type and original bytes. |

Use [`binary()`](/api/functions/binary),
[`binaryText()`](/api/functions/binaryText),
[`binaryBytes()`](/api/functions/binaryBytes), and
[`binaryToText()`](/api/functions/binaryToText) with the protocol's explicit
[`BinaryField`](/api/interfaces/BinaryField) representation.

## Transfer

Request a controlled P2PKH transfer or negotiate a persistent fee-pool draft.
Confirmation text and spending policy remain under Keymaster control.

| Operation | Type contract | Purpose |
| --- | --- | --- |
| `p2pkh.transfer`<br>[`p2pkhTransfer()`](/api/classes/KeymasterConnectClient#p2pkhtransfer) | [`P2pkhTransferParams`](/api/interfaces/P2pkhTransferParams) → [`P2pkhTransferResult`](/api/interfaces/P2pkhTransferResult) | Build, sign, and broadcast a controlled mainnet BSV transfer. |
| `feepool.prepare`<br>[`feepoolPrepare()`](/api/classes/KeymasterConnectClient#feepoolprepare) | [`FeepoolPrepareParams`](/api/interfaces/FeepoolPrepareParams) → [`FeepoolPrepareResult`](/api/interfaces/FeepoolPrepareResult) | Prepare the next fee-pool draft operation. |
| `feepool.commit`<br>[`feepoolCommit()`](/api/classes/KeymasterConnectClient#feepoolcommit) | [`FeepoolCommitParams`](/api/interfaces/FeepoolCommitParams) → [`FeepoolCommitResult`](/api/interfaces/FeepoolCommitResult) | Verify counterparty signatures and commit the prepared draft. |

## Channel

Publish JSON content to an exact channel and manage the exact channel set
contributed by the current Connect session.

| Operation | Type contract | Purpose |
| --- | --- | --- |
| `channel.publish`<br>[`channelPublish()`](/api/classes/KeymasterConnectClient#channelpublish) | [`ChannelPublishParams`](/api/interfaces/ChannelPublishParams) → [`ChannelPublishResult`](/api/interfaces/ChannelPublishResult) | Publish JSON content signed by the session owner. |
| `channel.subscription_set`<br>[`channelSubscriptionSet()`](/api/classes/KeymasterConnectClient#channelsubscriptionset) | [`ChannelSubscriptionSetParams`](/api/interfaces/ChannelSubscriptionSetParams) → [`ChannelSubscriptionSetResult`](/api/interfaces/ChannelSubscriptionSetResult) | Replace the caller's exact channel set; pass `[]` to release it. |

Channels are exact values: wildcards are not accepted. Physical Supplier
selection and subscriptions are owned by Keymaster's Coordinator, and the app
does not see SSP/SPI payloads or private inbox messages.

### Channel event

| Event | Payload | Delivery |
| --- | --- | --- |
| `channel.message_received` | [`ChannelMessageReceivedEventData`](/api/interfaces/ChannelMessageReceivedEventData) | [`KeymasterConnectOptions.onEvent`](/api/interfaces/KeymasterConnectOptions#onevent) |

The event contains verified JSON content for a channel currently subscribed by
this Connect session. It does not require a follow-up request.

## Storage

Manage directories and objects inside the verified application's namespace.
Provider credentials, buckets, and physical object keys are never exposed to
the caller.

| Operation | Type contract | Purpose |
| --- | --- | --- |
| `storage.list`<br>[`storageList()`](/api/classes/KeymasterConnectClient#storagelist) | [`StorageListParams`](/api/interfaces/StorageListParams) → [`StorageListResult`](/api/interfaces/StorageListResult) | List app-scoped directories and objects. |
| `storage.directory.create`<br>[`storageDirectoryCreate()`](/api/classes/KeymasterConnectClient#storagedirectorycreate) | [`StorageDirectoryParams`](/api/interfaces/StorageDirectoryParams) → [`StorageDirectoryResult`](/api/interfaces/StorageDirectoryResult) | Create a directory marker. |
| `storage.directory.delete`<br>[`storageDirectoryDelete()`](/api/classes/KeymasterConnectClient#storagedirectorydelete) | [`StorageDirectoryParams`](/api/interfaces/StorageDirectoryParams) → [`StorageDirectoryResult`](/api/interfaces/StorageDirectoryResult) | Delete a directory marker. |
| `storage.put`<br>[`storagePut()`](/api/classes/KeymasterConnectClient#storageput) | [`StoragePutParams`](/api/interfaces/StoragePutParams) → [`StoragePutResult`](/api/interfaces/StoragePutResult) | Write an object within the direct payload limit. |
| `storage.get`<br>[`storageGet()`](/api/classes/KeymasterConnectClient#storageget) | [`StorageGetParams`](/api/interfaces/StorageGetParams) → [`StorageGetResult`](/api/interfaces/StorageGetResult) | Read a complete object or byte range. |
| `storage.delete`<br>[`storageDelete()`](/api/classes/KeymasterConnectClient#storagedelete) | [`StorageDeleteParams`](/api/interfaces/StorageDeleteParams) → [`StorageDeleteResult`](/api/interfaces/StorageDeleteResult) | Delete an object. |
| `storage.upload.begin`<br>[`storageUploadBegin()`](/api/classes/KeymasterConnectClient#storageuploadbegin) | [`StorageUploadBeginParams`](/api/interfaces/StorageUploadBeginParams) → [`StorageUploadBeginResult`](/api/interfaces/StorageUploadBeginResult) | Start a multipart upload. |
| `storage.upload.part`<br>[`storageUploadPart()`](/api/classes/KeymasterConnectClient#storageuploadpart) | [`StorageUploadPartParams`](/api/interfaces/StorageUploadPartParams) → [`StorageUploadPartResult`](/api/interfaces/StorageUploadPartResult) | Upload one numbered part. |
| `storage.upload.complete`<br>[`storageUploadComplete()`](/api/classes/KeymasterConnectClient#storageuploadcomplete) | [`StorageUploadCompleteParams`](/api/interfaces/StorageUploadCompleteParams) → [`StoragePutResult`](/api/interfaces/StoragePutResult) | Assemble uploaded parts into the final object. |
| `storage.upload.abort`<br>[`storageUploadAbort()`](/api/classes/KeymasterConnectClient#storageuploadabort) | [`StorageUploadAbortParams`](/api/interfaces/StorageUploadAbortParams) → [`StorageUploadAbortResult`](/api/interfaces/StorageUploadAbortResult) | Discard an unfinished multipart upload. |

Storage requires a verified app identity whose requirements include `storage`.
The size and part limits are exported as SDK constants in the
[API reference](/api/#variables).

## Lower-level request API

[`request(method, params)`](/api/classes/KeymasterConnectClient#request) accepts
every [`ProtocolMethod`](/api/type-aliases/ProtocolMethod). Its generic
[`MethodParams`](/api/type-aliases/MethodParams) and
[`MethodResult`](/api/type-aliases/MethodResult) types provide the same
compile-time inference as the named methods.

All server-pushed events use the shared
[`ProtocolEventMessage`](/api/interfaces/ProtocolEventMessage) envelope.
