import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createLauncherPackage, createNativePackage } from "../scripts/package-npm.ts";
import { nativePackageFor, nativeTargets } from "../scripts/npm-platform.ts";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

const temporaryDirectory = async () => {
  const path = await mkdtemp(join(tmpdir(), "relay-npm-test-"));
  temporaryDirectories.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("npm platform selection", () => {
  it.each([
    ["darwin", "arm64", undefined, "@akshar5/relay-darwin-arm64"],
    ["darwin", "x64", undefined, "@akshar5/relay-darwin-x64"],
    ["linux", "x64", "glibc", "@akshar5/relay-linux-x64-gnu"],
    ["linux", "arm64", "glibc", "@akshar5/relay-linux-arm64-gnu"],
  ] as const)("maps %s/%s to its one native package", (platform, arch, libc, expected) => {
    expect(nativePackageFor({ platform, arch, ...(libc ? { libc } : {}) })).toBe(expected);
  });

  it("rejects unsupported systems before trying to load a package", () => {
    expect(() => nativePackageFor({ platform: "linux", arch: "x64", libc: "other" })).toThrow(
      "requires glibc",
    );
    expect(() => nativePackageFor({ platform: "win32", arch: "x64" })).toThrow("win32/x64");
  });
});

describe("npm package assembly", () => {
  it("assembles a constrained native package with an executable payload", async () => {
    const root = await temporaryDirectory();
    const source = join(root, "source-relay");
    const output = join(root, "package");
    await writeFile(source, "native payload", "utf8");
    await createNativePackage("linux-x64-gnu", source, output, "1.2.3");

    const manifest = JSON.parse(await readFile(join(output, "package.json"), "utf8"));
    expect(manifest).toMatchObject({
      name: "@akshar5/relay-linux-x64-gnu",
      version: "1.2.3",
      os: ["linux"],
      cpu: ["x64"],
      libc: ["glibc"],
      publishConfig: { access: "public" },
    });
    expect((await stat(join(output, "bin", "relay"))).mode & 0o111).not.toBe(0);
  });

  it("assembles a launcher that resolves and executes only the local native package", async () => {
    const root = await temporaryDirectory();
    const launcher = join(root, "launcher");
    await createLauncherPackage(launcher, "1.2.3");

    const manifest = JSON.parse(await readFile(join(launcher, "package.json"), "utf8"));
    expect(manifest.optionalDependencies).toEqual(
      Object.fromEntries(
        Object.values(nativeTargets).map(({ packageName }) => [packageName, "1.2.3"]),
      ),
    );

    const report = process.report?.getReport() as
      | { readonly header?: { readonly glibcVersionRuntime?: string } }
      | undefined;
    const libc =
      process.platform === "linux"
        ? report?.header?.glibcVersionRuntime
          ? "glibc"
          : "other"
        : undefined;
    const nativePackage = nativePackageFor({
      platform: process.platform,
      arch: process.arch,
      ...(libc ? { libc } : {}),
    });
    const nativeRoot = join(launcher, "node_modules", ...nativePackage.split("/"));
    await mkdir(join(nativeRoot, "bin"), { recursive: true });
    await writeFile(join(nativeRoot, "package.json"), JSON.stringify({ name: nativePackage }));
    const nativeExecutable = join(nativeRoot, "bin", "relay");
    await writeFile(nativeExecutable, "#!/bin/sh\nprintf 'native:%s' \"$1\"\n", "utf8");
    await chmod(nativeExecutable, 0o755);

    const result = await execFileAsync(join(launcher, "bin", "relay"), ["ok"]);
    expect(result.stdout).toBe("native:ok");
  });
});
