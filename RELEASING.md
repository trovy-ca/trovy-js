# Releasing

For maintainers. A release is a tag; everything after the tag is automatic, with
one human approval before npm.

## What happens when a tag is pushed

1. `release.yml` checks that the tag is `v` + the version in `package.json`.
2. It runs the whole of CI: lint, types, tests on two Reacts and three Nodes,
   the hygiene scan, the build, both gates, and the smoke test that installs the
   tarball into an empty project and builds the example app against it.
3. CI uploads the tarball that passed.
4. The `publish` job waits for a reviewer on the `npm` environment.
5. Once approved, it downloads that tarball and runs `npm publish` on it. It
   checks out no code and installs nothing, so nothing from the repository or
   the registry runs with the identity npm trusts.

A version with a hyphen (`0.2.0-rc.1`) is published under the `next` tag. Anything
else becomes `latest`.

There is no npm token anywhere. npm accepts the publish because of
[trusted publishing](https://docs.npmjs.com/trusted-publishers): a short-lived
identity that GitHub issues to this repository, this workflow file and this
environment, and to nothing else. It also signs the provenance statement shown
on the package's npm page.

## Cutting a release

```bash
# 1. On main, with a clean tree. Bump both: the gate fails if they disagree.
npm version 0.2.0 --no-git-tag-version
(cd examples/next-app-router && npm pkg set "dependencies.@trovy/sdk=0.2.0")

# 2. Move the changelog's notes under the new version, then prove it locally.
pnpm verify && pnpm smoke:example

# 3. Commit, and let CI pass on main before tagging.
git commit -am "Release 0.2.0" && git push

# 4. Tag. This is the release.
git tag v0.2.0 && git push origin v0.2.0
```

Then approve the `publish` job when it asks, and check the result:

```bash
npm view @trovy/sdk dist-tags
npm view @trovy/sdk@0.2.0 dist.attestations   # provenance is there
```

Finally, create a GitHub release from the tag with the changelog section as its
notes.

## When the API contract changes

The order is always: the API ships first, then the SDK, then anything that
documents the SDK. Contract changes are additive, so an SDK that is one step
behind keeps working.

1. `pnpm contract:drift` (or the daily workflow's issue) says the published
   contract has moved.
2. Replace `openapi/v1.json` with the new contract from the API's source. It is
   the one file that crosses into this repository, and it is copied by hand.
3. `pnpm codegen`, then `pnpm verify`. A new operation needs a method on the
   client, a row in `src/operations.ts` and a line in the README's API table;
   the tests say which.
4. Release.

## If a release is bad

- **Broken, not dangerous:** `npm deprecate @trovy/sdk@<version> "<what is wrong, which version to use>"`,
  move the tag back with `npm dist-tag add @trovy/sdk@<good version> latest`, and
  ship a fix as the next patch. Do not unpublish: every lockfile that names the
  version would break.
- **It leaked something:** unpublish within 72 hours (`npm unpublish @trovy/sdk@<version>`),
  and treat whatever leaked as public anyway: rotate it. The version number can
  never be used again.

## One-time setup

Done once, by an owner of the npm organisation and the GitHub repository.

1. **npm.** The `@trovy` organisation exists, with two-factor authentication
   required for the account and the organisation.
2. **The first version is published by hand**, because a trusted publisher can
   only be attached to a package that exists. From a clean clone:
   `pnpm install && pnpm setup:react-18 && pnpm verify`, then
   `npm publish artifacts/trovy-sdk-<version>.tgz --access public --tag next`.
3. **Attach the trusted publisher** in the package's settings on npmjs.com:
   organisation `trovy-ca`, repository `trovy-js`, workflow `release.yml`,
   environment `npm`. Then set publishing access to "Require two-factor
   authentication and disallow tokens".
4. **GitHub.** An environment named `npm` with a required reviewer and
   deployments limited to tags matching `v*`. A ruleset on `main` requiring
   pull requests and the CI checks, and one on `v*` tags restricting who can
   create them. Secret scanning, push protection and private vulnerability
   reporting switched on.
5. **Prove it:** tag the next release candidate and watch it publish with
   provenance.
