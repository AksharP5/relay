import { readFile } from "node:fs/promises";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ReleasePrWorkflow = Schema.Struct({
  permissions: Schema.Struct({
    contents: Schema.Literal("read"),
  }),
  jobs: Schema.Struct({
    "release-check": Schema.Struct({
      name: Schema.String,
      if: Schema.String,
      steps: Schema.Array(Schema.Unknown),
    }),
  }),
});

const CheckoutStep = Schema.Struct({
  uses: Schema.String,
  with: Schema.Struct({
    "persist-credentials": Schema.Literal(false),
    ref: Schema.String,
  }),
});

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

    const workflow = Schema.decodeUnknownSync(ReleasePrWorkflow)(parse(pullRequestWorkflow));
    const releaseCheck = workflow.jobs["release-check"];
    const trustedRepository = "github.event.pull_request.head.repo.full_name == github.repository";
    const trustedBranch =
      "github.event.pull_request.head.ref == 'release-please--branches--main--components--relay'";

    expect(releaseCheck.if).toContain(trustedRepository);
    expect(releaseCheck.if).toContain(trustedBranch);
    expect(releaseCheck.if).not.toContain("github.event.pull_request.user.login");
    expect(releaseCheck.name).toContain(trustedRepository);
    expect(releaseCheck.name).toContain(trustedBranch);
    expect(releaseCheck.name).toContain("'check' || 'release-pr-check-not-applicable'");
    expect(workflow.permissions.contents).toBe("read");

    const checkout = Schema.decodeUnknownSync(CheckoutStep)(releaseCheck.steps[0]);
    expect(checkout.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(checkout.with.ref).toBe("${{ github.event.pull_request.head.sha }}");
    expect(checkout.with["persist-credentials"]).toBe(false);
  });
});
