import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSafeIdentifier } from "./ids.js";
import { runDataPath } from "./runData.js";

/** 只由真实 S3 setup/teardown/Journey 共享的非敏感状态。 */
export interface S3ResourceRunState {
  readonly version: 1;
  readonly runId: string;
  readonly configFingerprint: string;
  readonly s3LeaseAcquired: true;
  readonly createdAt: string;
}

export function s3ResourceStatePath(): string {
  return path.resolve(process.env.KEYMASTER_E2E_S3_RESOURCE_STATE_FILE ?? runDataPath("s3", "state", "real-s3-resource-state.json"));
}

export async function writeS3ResourceRunState(state: S3ResourceRunState): Promise<void> {
  const file = s3ResourceStatePath();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function readS3ResourceRunState(): Promise<S3ResourceRunState | null> {
  try {
    const value: unknown = JSON.parse(await readFile(s3ResourceStatePath(), "utf8"));
    if (!value || typeof value !== "object") throw new Error("invalid S3 resource state");
    const state = value as Partial<S3ResourceRunState>;
    if (
      state.version !== 1
      || typeof state.runId !== "string"
      || typeof state.configFingerprint !== "string"
      || !/^[0-9a-f]{16}$/iu.test(state.configFingerprint)
      || state.s3LeaseAcquired !== true
      || typeof state.createdAt !== "string"
      || Number.isNaN(Date.parse(state.createdAt))
    ) throw new Error("invalid S3 resource state");
    assertSafeIdentifier(state.runId, "S3 resource run_id");
    return state as S3ResourceRunState;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") return null;
    throw new Error("真实 S3 运行状态不可读");
  }
}

export async function removeS3ResourceRunState(): Promise<void> {
  await unlink(s3ResourceStatePath()).catch((error: unknown) => {
    if (!(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT")) throw error;
  });
}
