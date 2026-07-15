import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLaunchDirectory } from "../src/launch-directory.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("resolveLaunchDirectory", () => {
  it("resolves relative, absolute, and symlinked directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-directory-"));
    roots.push(root);
    const project = join(root, "project");
    const link = join(root, "linked-project");
    await mkdir(project);
    await writeFile(join(project, ".keep"), "", "utf8");
    await symlink(project, link);
    const canonicalProject = await realpath(project);

    expect(await resolveLaunchDirectory("project", root)).toBe(canonicalProject);
    expect(await resolveLaunchDirectory(project, tmpdir())).toBe(canonicalProject);
    expect(await resolveLaunchDirectory("linked-project", root)).toBe(canonicalProject);
  });

  it("rejects missing paths and files before native startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-directory-invalid-"));
    roots.push(root);
    const file = join(root, "not-a-directory");
    await writeFile(file, "file", "utf8");

    await expect(resolveLaunchDirectory("missing", root)).rejects.toThrow(
      "Relay directory does not exist",
    );
    await expect(resolveLaunchDirectory(file, root)).rejects.toThrow(
      "Relay path is not a directory",
    );
  });
});
