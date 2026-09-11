import { readFileSync } from "node:fs";
import { join } from "node:path";

const rootPackage = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
const configuredVersion = process.env.WEBLOOM_RELEASE_VERSION?.trim()
  || rootPackage.config?.webloomFrameworkReleaseVersion;

if (typeof configuredVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(configuredVersion)) {
  throw new Error("WEBLOOM_RELEASE_VERSION or package.json config.webloomFrameworkReleaseVersion must be an exact semver");
}

export const webLoomReleaseVersion = configuredVersion;
