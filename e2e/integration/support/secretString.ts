/**
 * Node Resource 使用的短生命周期秘密容器。
 *
 * 它不实现可序列化的公开值；`toString()`/`toJSON()` 只返回固定脱敏文本，
 * 需要读取时必须显式调用 `read()`，调用方完成后应调用 `clear()`。
 */
export class SecretString {
  #value: string | undefined;

  constructor(value: string) {
    this.#value = value;
  }

  read(): string {
    if (this.#value === undefined) throw new Error("secret has been cleared");
    return this.#value;
  }

  clear(): void {
    this.#value = undefined;
  }

  toString(): string {
    return "[REDACTED_SECRET]";
  }

  toJSON(): string {
    return "[REDACTED_SECRET]";
  }
}
