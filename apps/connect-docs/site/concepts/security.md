# Security model

The SDK makes transport checks explicit, but Keymaster remains the authority for
identity, policy, confirmation, and private-key execution.

## Exact origin

The configured Keymaster target is normalized to an HTTP(S) origin. Incoming
messages must match both that exact origin and the current Session Window object.
Messages from another same-page iframe or popup are ignored.

## Session-bound owner

Business methods never fall back to a global wallet key. Keymaster resolves the
owner from the supplied session id and rejects origin or owner mismatches.

## Application identity

A signed app identity proof binds publisher, app metadata, and requested
requirements. Storage access requires a verified proof and a matching session
snapshot; a plain unauthenticated session cannot acquire it later by adding a
parameter.

## Human confirmation

Applications describe identity, signing, and encryption intent. Payment text and
approval policy remain controlled by Keymaster so a caller cannot disguise a
transfer as a harmless prompt.

## No key export

The SDK receives public identity, envelopes, signatures, ciphertext, messages,
and operation results. It never receives an owner private key or reusable raw
shared secret.
