import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface PackageJsonShape {
  overrides?: Record<string, string>;
}

interface LockPackageEntry {
  version?: string;
  resolved?: string;
}

interface PackageLockShape {
  packages?: Record<string, LockPackageEntry>;
}

function parseSemverTuple(version: string): [number, number, number] {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(`Invalid semver version: ${version}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isAtLeast(version: string, min: [number, number, number]): boolean {
  const [maj, minVer, pat] = parseSemverTuple(version);
  if (maj !== min[0]) return maj > min[0];
  if (minVer !== min[1]) return minVer > min[1];
  return pat >= min[2];
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../..");

describe("Dependency security overrides (GHSA-g3hv-75wg-m249)", () => {
  it("pins minimatch >= 11.0.1 in package.json overrides and package-lock.json", () => {
    const pkgRaw = fs.readFileSync(path.join(repoRoot, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw) as PackageJsonShape;
    const overrideSpec = pkg.overrides?.minimatch ?? "";
    expect(overrideSpec).toMatch(/^\^?11\./);

    const lockRaw = fs.readFileSync(
      path.join(repoRoot, "package-lock.json"),
      "utf8"
    );
    const lock = JSON.parse(lockRaw) as PackageLockShape;
    const packages = lock.packages ?? {};

    const minimatchEntries = Object.entries(packages).filter(
      ([key]) =>
        key === "node_modules/minimatch" ||
        key.endsWith("/node_modules/minimatch")
    );
    expect(minimatchEntries.length).toBeGreaterThan(0);

    for (const [, entry] of minimatchEntries) {
      expect(entry.version).toBeDefined();
      expect(isAtLeast(entry.version ?? "0.0.0", [11, 0, 1])).toBe(true);
    }

    for (const [, entry] of Object.entries(packages)) {
      if (entry.resolved && /^https?:\/\//.test(entry.resolved)) {
        expect(entry.resolved.startsWith("https://registry.npmjs.org/")).toBe(
          true
        );
      }
    }
  });

  it("exposes named minimatch and Minimatch APIs required by ESLint", () => {
    const require = createRequire(import.meta.url);
    const mod = require("minimatch") as {
      minimatch: (target: string, pattern: string, opts?: { dot?: boolean }) => boolean;
      Minimatch: new (pattern: string) => { match: (target: string) => boolean };
    };

    expect(typeof mod.minimatch).toBe("function");
    expect(typeof mod.Minimatch).toBe("function");
    expect(mod.minimatch("src/bot.ts", "src/**/*.ts", { dot: true })).toBe(true);
    const compiled = new mod.Minimatch("dist/**");
    expect(compiled.match("dist/index.js")).toBe(true);
    expect(compiled.match("src/index.ts")).toBe(false);
  });
});
