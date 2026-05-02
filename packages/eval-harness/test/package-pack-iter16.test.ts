import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, "..");

describe("iter16 WS8 — pack hygiene", () => {
  it("locks private:true (internal package — see iter16 conductor report)", () => {
    const pkg = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8"));
    expect(pkg.private).toBe(true);
  });

  it("npm pack excludes sourcemaps and stays under entry-count baseline", () => {
    const out = execSync("npm pack --dry-run --json --ignore-scripts", {
      cwd: pkgDir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    const parsed = JSON.parse(out);
    const tarball = Array.isArray(parsed) ? parsed[0] : parsed;
    const files: { path: string }[] = tarball.files ?? [];

    const maps = files.filter((f) => f.path.endsWith(".map"));
    expect(maps, `sourcemaps must not be packed: ${maps.map((m) => m.path).join(", ")}`).toEqual([]);

    const tsbuildinfo = files.filter((f) => f.path.endsWith(".tsbuildinfo"));
    expect(tsbuildinfo).toEqual([]);

    expect(tarball.entryCount).toBeLessThan(150);
  });
});
