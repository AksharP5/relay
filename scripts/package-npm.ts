import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isNativeTarget, nativeTargets, type NativeTarget } from "./npm-platform.ts";

const repository = {
  type: "git",
  url: "git+https://github.com/AksharP5/relay.git",
} as const;

const sharedMetadata = {
  author: "Akshar Patel",
  license: "MIT",
  repository,
  homepage: "https://github.com/AksharP5/relay#readme",
  bugs: { url: "https://github.com/AksharP5/relay/issues" },
  publishConfig: { access: "public" },
} as const;

const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const resetDirectory = async (path: string) => {
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
};

const writeJson = (path: string, value: unknown) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");

const copyProjectFile = (name: string, outputDirectory: string) =>
  copyFile(resolve(name), join(outputDirectory, name));

export const readReleaseVersion = async (): Promise<string> => {
  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
    readonly version?: unknown;
  };
  if (typeof packageJson.version !== "string" || !semver.test(packageJson.version)) {
    throw new Error("package.json must contain a valid release version");
  }
  return packageJson.version;
};

export const createLauncherPackage = async (outputDirectory: string, version: string) => {
  if (!semver.test(version)) throw new Error(`Invalid npm package version: ${version}`);
  await resetDirectory(outputDirectory);
  const executable = join(outputDirectory, "bin", "relay");
  await mkdir(dirname(executable), { recursive: true });
  await copyFile(resolve("scripts/npm-launcher.sh"), executable);
  await chmod(executable, 0o755);

  const optionalDependencies = Object.fromEntries(
    Object.values(nativeTargets).map(({ packageName }) => [packageName, version]),
  );
  await writeJson(join(outputDirectory, "package.json"), {
    name: "@akshar5/relay",
    version,
    description: "Use the real Codex and OpenCode TUIs on one continuous coding task.",
    keywords: ["cli", "codex", "coding-agent", "opencode", "tui"],
    ...sharedMetadata,
    bin: { relay: "bin/relay" },
    files: ["bin", "README.md", "LICENSE"],
    os: ["darwin", "linux"],
    optionalDependencies,
  });
  await Promise.all([
    copyProjectFile("README.md", outputDirectory),
    copyProjectFile("LICENSE", outputDirectory),
  ]);
  return outputDirectory;
};

export const createNativePackage = async (
  target: NativeTarget,
  sourceExecutable: string,
  outputDirectory: string,
  version: string,
) => {
  if (!semver.test(version)) throw new Error(`Invalid npm package version: ${version}`);
  const metadata = nativeTargets[target];
  await resetDirectory(outputDirectory);
  const executable = join(outputDirectory, "bin", "relay");
  await mkdir(dirname(executable), { recursive: true });
  await copyFile(sourceExecutable, executable);
  await chmod(executable, 0o755);

  await writeJson(join(outputDirectory, "package.json"), {
    name: metadata.packageName,
    version,
    description: `Relay native executable for ${target}.`,
    ...sharedMetadata,
    files: ["bin/relay", "LICENSE"],
    os: [metadata.os],
    cpu: [metadata.cpu],
    ...(target.startsWith("linux-") ? { libc: ["glibc"] } : {}),
  });
  await copyProjectFile("LICENSE", outputDirectory);
  return outputDirectory;
};

const usage =
  "Usage:\n" +
  "  bun scripts/package-npm.ts launcher <output-directory>\n" +
  "  bun scripts/package-npm.ts native <target> <executable> <output-directory>";

if (import.meta.main) {
  const [kind, ...args] = process.argv.slice(2);
  const version = await readReleaseVersion();
  if (kind === "launcher" && args.length === 1) {
    await createLauncherPackage(resolve(args[0]!), version);
  } else if (kind === "native" && args.length === 3 && args[0] && isNativeTarget(args[0])) {
    await createNativePackage(args[0], resolve(args[1]!), resolve(args[2]!), version);
  } else {
    console.error(usage);
    process.exit(2);
  }
}
