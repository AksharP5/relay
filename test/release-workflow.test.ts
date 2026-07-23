import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("release workflow", () => {
  it("runs a trusted PR-associated check for Release Please branches", async () => {
    const releaseWorkflow = await readFile(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    const pullRequestWorkflow = await readFile(
      new URL("../.github/workflows/release-pr-ci.yml", import.meta.url),
      "utf8",
    );

    expect(releaseWorkflow).not.toContain("gh workflow run ci.yml");
    expect(pullRequestWorkflow).toContain("pull_request_target:");
    expect(pullRequestWorkflow).toContain(
      "github.event.pull_request.user.login == 'github-actions[bot]'",
    );
    expect(pullRequestWorkflow).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(pullRequestWorkflow).toContain(
      "startsWith(github.event.pull_request.head.ref, 'release-please--branches--')",
    );
    expect(pullRequestWorkflow).toContain("'check' || 'release-pr-check-not-applicable'");
    expect(pullRequestWorkflow).toContain("ref: ${{ github.event.pull_request.head.sha }}");
    expect(pullRequestWorkflow).toContain("persist-credentials: false");
  });
});
