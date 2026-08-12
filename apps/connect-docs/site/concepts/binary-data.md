# Binary data

Connect wraps binary values explicitly so request objects cannot confuse bytes
with hex or base64 strings.

```ts
interface BinaryField {
  $type: "binary";
  bytes: ArrayBuffer;
  mime?: string;
}
```

Use the SDK helpers to copy caller-owned buffers safely:

```ts
import {
  binary,
  binaryBytes,
  binaryText,
  binaryToText
} from "@keymaster/connect";

const image = binary(fileBytes, "image/png");
const note = binaryText("private note");

const bytes = binaryBytes(result.content);
const text = binaryToText(result.content);
```

`binary()` copies the source view. Later mutations to the caller's buffer do not
change the request field.

Broadcast bodies are the deliberate exception: their public representation is
base64 text so messages remain stable across long-lived event delivery.
