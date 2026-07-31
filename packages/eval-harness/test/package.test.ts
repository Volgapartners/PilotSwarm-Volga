import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

/**
 * Minimal caret-range satisfaction check (no new dependency).
 * Handles the `^x.y.z` form used by workspace peer ranges, including the
 * 0.x semantics where the minor acts as the breaking-change boundary.
 */
function caretRangeSatisfies(range: string, version: string): boolean {
  const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  if (!match) throw new Error(`Unsupported range for this check: ${range}`);
  const [, rMajor, rMinor, rPatch] = match.map(Number) as unknown as number[];
  const vMatch = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!vMatch) throw new Error(`Unsupported version for this check: ${version}`);
  const [, vMajor, vMinor, vPatch] = vMatch.map(Number) as unknown as number[];

  if (vMajor !== rMajor) return false;
  // ^0.y.z is bounded to the same minor.
  if (rMajor === 0 && vMinor !== rMinor) return false;
  if (vMinor < rMinor) return false;
  if (vMinor === rMinor && vPatch < rPatch) return false;
  return true;
}

describe("package API", () => {
  it("exports the v0 public API names", () => {
    const expectedRuntimeExports = [
      "discoverScenarios",
      "runScenario",
      "runManifest",
      "registerScenarioKind",
      "registerCheckType",
      "registerTool",
      "registerDriver",
      "registerReporter",
    ];
    for (const name of expectedRuntimeExports) expect(api).toHaveProperty(name);
  });

  it("re-exports registration types from the public entrypoint", async () => {
    const source = await readFile("src/index.ts", "utf8");
    const expectedTypeExports = [
      "Reporter",
      "Driver",
      "ToolRegistration",
      "ScenarioKindRegistration",
    ];
    for (const name of expectedTypeExports) expect(source).toContain(name);
  });

  it("is a private source-workspace package with buildable metadata", async () => {
    const [pkgRaw, license] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile("LICENSE", "utf8"),
    ]);

    const pkg = JSON.parse(pkgRaw) as {
      private?: boolean;
      scripts?: Record<string, string>;
      files?: string[];
      main?: string;
      types?: string;
      exports?: Record<string, unknown>;
      publishConfig?: Record<string, unknown>;
    };
    expect(pkg.private).toBe(true);
    expect(pkg.publishConfig).toBeUndefined();
    expect(pkg.scripts?.build).toContain("tsc");
    expect(pkg.scripts?.prepack).toBe("npm run build");
    expect(pkg.main).toBe("./dist/src/index.js");
    expect(pkg.types).toBe("./dist/src/index.d.ts");
    expect(pkg.exports).toHaveProperty(".");
    expect(pkg.files).toContain("dist/**/*");
    expect(pkg.files).toContain("runs/**/*");
    expect(pkg.files).toContain("scenarios/**/*");
    expect(pkg.files).toContain("LICENSE");
    expect(license).toContain("MIT License");
  });

  it("declares a pilotswarm-sdk peer range satisfied by the workspace SDK version", async () => {
    const [pkgRaw, sdkPkgRaw] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile("../sdk/package.json", "utf8"),
    ]);

    const pkg = JSON.parse(pkgRaw) as { peerDependencies?: Record<string, string> };
    const sdkPkg = JSON.parse(sdkPkgRaw) as { version: string };

    const peerRange = pkg.peerDependencies?.["pilotswarm-sdk"];
    expect(peerRange).toBeTruthy();
    expect(
      caretRangeSatisfies(peerRange!, sdkPkg.version),
      `peerDependencies["pilotswarm-sdk"] = ${peerRange} does not accept the workspace SDK version ${sdkPkg.version}; ` +
        "a clean `npm install` would fail with ERESOLVE without --legacy-peer-deps",
    ).toBe(true);
  });
});
