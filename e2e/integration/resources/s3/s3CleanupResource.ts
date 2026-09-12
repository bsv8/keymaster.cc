/**
 * E2E 资源配置的兼容入口。
 *
 * 清理算法和真实 AWS SDK 适配器位于 platform-storage testing 层，便于用
 * Vitest 单元测试覆盖边界；本目录只保留 E2E 配置类型与生命周期编排。
 */
export {
  createAwsS3Api,
  S3CleanupResource,
} from "../../../../packages/platform-storage/src/testing/s3CleanupResource.js";
export type {
  S3CleanupResourceConfig,
  S3CleanupSummary,
  S3Lease,
} from "../../../../packages/platform-storage/src/testing/s3CleanupResource.js";
