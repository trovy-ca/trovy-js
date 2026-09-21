import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The workflows are part of what is released: they decide what reaches npm under
 * this package's name. These are the properties a well-meant edit breaks.
 */
const dir = fileURLToPath(new URL("../../.github/workflows", import.meta.url));
const workflows = readdirSync(dir)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));

/** The text of one job: from its key to the next key at the same depth. */
function job(text: string, name: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) throw new Error(`no job named ${name}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line));
  return rest.slice(0, end === -1 ? undefined : end).join("\n");
}

describe("every workflow", () => {
  it("is one of the three this test knows about", () => {
    expect(workflows.map((workflow) => workflow.name).sort()).toEqual(["ci.yml", "contract-drift.yml", "release.yml"]);
  });

  // A tag can be moved to different code after it was reviewed. A commit cannot.
  it.each(workflows)("$name pins every action to a commit", ({ text }) => {
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((match) => match[1]!);

    expect(uses.length).toBeGreaterThan(0);
    for (const reference of uses.filter((value) => !value.startsWith("./"))) {
      expect(reference, reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
  });

  // It runs a fork's code with this repository's token.
  it.each(workflows)("$name never runs on pull_request_target", ({ text }) => {
    expect(text.replace(/#.*$/gm, "")).not.toContain("pull_request_target");
  });

  // Publishing uses a short-lived identity. A stored token is a thing to steal.
  it.each(workflows)("$name reads no stored secret", ({ text }) => {
    expect(text).not.toMatch(/\bsecrets\./);
  });

  it.each(workflows)("$name states its permissions, and never write-all", ({ text }) => {
    expect(text).toMatch(/^permissions:/m);
    expect(text).not.toMatch(/write-all/);
  });

  it.each(workflows.filter((workflow) => workflow.text.includes("actions/checkout@")))(
    "$name leaves no credentials behind after checkout",
    ({ text }) => {
      const checkouts = text.split("actions/checkout@").length - 1;
      const hardened = text.split("persist-credentials: false").length - 1;

      expect(hardened).toBe(checkouts);
    },
  );
});

describe("the publish job", () => {
  const release = workflows.find((workflow) => workflow.name === "release.yml")!.text;
  const publish = job(release, "publish");

  // Whatever it checked out or installed would run with the identity npm trusts.
  it("checks out nothing and installs nothing", () => {
    // What the job does, not what its comments say.
    const commands = publish.replace(/(^|\s)#.*$/gm, "");

    expect(commands).toContain("npm publish");
    expect(commands).not.toContain("actions/checkout");
    expect(commands).not.toMatch(/\b(pnpm|npm|yarn)\s+(install|ci|add|i)\b/);
    expect(commands).not.toMatch(/\bnpx\b|\bpnpm\s+(exec|dlx)\b/);
  });

  it("publishes the tarball CI verified, by name, and only after CI", () => {
    expect(publish).toContain("needs: ci");
    expect(publish).toContain("actions/download-artifact@");
    // With the leading "./": `npm publish dir/x.tgz` is read as the GitHub repository dir/x.tgz.
    expect(publish).toMatch(/npm publish "\.\/\$\{file\}"/);
  });

  it("waits for a person, and is the only job that can sign", () => {
    expect(publish).toContain("environment: npm");
    expect(publish).toContain("id-token: write");
    expect(release.split("id-token: write").length - 1).toBe(1);
    expect(release).toMatch(/^permissions: \{\}$/m);
  });

  it("never lets a release candidate become `latest`", () => {
    expect(publish).toMatch(/\*-\*\)\s+dist_tag="next"/);
    expect(publish).toContain('--tag "${dist_tag}"');
  });

  it("refuses a tag that does not match package.json before anyone is asked to approve", () => {
    expect(job(release, "ci")).toContain("needs: tag");
    expect(job(release, "tag")).toContain('"v${version}" != "${GITHUB_REF_NAME}"');
  });
});
