import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("release workflow", () => {
  it("dispatches release PR checks without relying on a local checkout", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain(
      'gh workflow run ci.yml --repo "$GITHUB_REPOSITORY" --ref "$head_ref"',
    );
  });
});
