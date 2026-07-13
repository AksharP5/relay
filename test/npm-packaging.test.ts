import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  it.each([
    ["darwin-arm64", "@akshar5/relay-darwin-arm64", "darwin", "arm64", undefined],
    ["darwin-x64", "@akshar5/relay-darwin-x64", "darwin", "x64", undefined],
    ["linux-x64-gnu", "@akshar5/relay-linux-x64-gnu", "linux", "x64", ["glibc"]],
    ["linux-arm64-gnu", "@akshar5/relay-linux-arm64-gnu", "linux", "arm64", ["glibc"]],
  ] as const)(
    "assembles the constrained %s native package",
    async (target, name, os, cpu, libc) => {
      const root = await temporaryDirectory();
      const source = join(root, "source-relay");
      const output = join(root, "package");
      await writeFile(source, "native payload", "utf8");
      await createNativePackage(target, source, output, "1.2.3");

      const manifest = JSON.parse(await readFile(join(output, "package.json"), "utf8"));
      expect(manifest).toMatchObject({
        name,
        version: "1.2.3",
        os: [os],
        cpu: [cpu],
        ...(libc ? { libc } : {}),
        publishConfig: { access: "public" },
      });
      expect((await stat(join(output, "bin", "relay"))).mode & 0o111).not.toBe(0);
    },
  );

  it("assembles one launcher with exact native dependency versions", async () => {
    const root = await temporaryDirectory();
    const launcher = join(root, "launcher");
    await createLauncherPackage(launcher, "1.2.3+build.1");

    const manifest = JSON.parse(await readFile(join(launcher, "package.json"), "utf8"));
    expect(manifest.optionalDependencies).toEqual(
      Object.fromEntries(
        Object.values(nativeTargets).map(({ packageName }) => [packageName, "1.2.3+build.1"]),
      ),
    );
    await expect(createLauncherPackage(launcher, "01.2.3")).rejects.toThrow("Invalid npm");
  });

  it.each([
    ["Darwin", "arm64", "relay-darwin-arm64", "nested", "ok"],
    ["Darwin", "x86_64", "relay-darwin-x64", "hoisted", "ok"],
    ["Linux", "x86_64", "relay-linux-x64-gnu", "nested", "ok"],
    ["Linux", "aarch64", "relay-linux-arm64-gnu", "hoisted", "missing"],
  ] as const)(
    "resolves a relative npm symlink for %s/%s",
    async (system, machine, packageBasename, layout, getconf) => {
      const root = await temporaryDirectory();
      const launcher = join(root, "launcher");
      await createLauncherPackage(launcher, "1.2.3");
      const nativeRoot =
        layout === "nested"
          ? join(launcher, "node_modules", "@akshar5", packageBasename)
          : join(launcher, "..", packageBasename);
      await mkdir(join(nativeRoot, "bin"), { recursive: true });
      const nativeExecutable = join(nativeRoot, "bin", "relay");
      await writeFile(nativeExecutable, "#!/bin/sh\nprintf 'native:%s' \"$1\"\n", "utf8");
      await chmod(nativeExecutable, 0o755);

      const fakeBin = join(root, "fake-bin");
      await mkdir(fakeBin);
      await writeFile(
        join(fakeBin, "uname"),
        '#!/bin/sh\ncase "$1" in -s) echo "$FAKE_SYSTEM" ;; -m) echo "$FAKE_MACHINE" ;; *) exit 2 ;; esac\n',
      );
      await writeFile(join(fakeBin, "getconf"), `#!/bin/sh\n[ "${getconf}" = ok ]\n`);
      await chmod(join(fakeBin, "uname"), 0o755);
      await chmod(join(fakeBin, "getconf"), 0o755);
      const bin = join(root, "bin");
      await mkdir(bin);
      await symlink("../launcher/bin/relay", join(bin, "relay"));

      const result = await execFileAsync(join(bin, "relay"), ["ok"], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          FAKE_SYSTEM: system,
          FAKE_MACHINE: machine,
        },
      });
      expect(result.stdout).toBe("native:ok");
    },
  );

  it("explains how to recover when npm did not install the native dependency", async () => {
    const root = await temporaryDirectory();
    const launcher = join(root, "launcher");
    await createLauncherPackage(launcher, "1.2.3");

    await expect(execFileAsync(join(launcher, "bin", "relay"))).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("--include=optional"),
    });
  });
});
