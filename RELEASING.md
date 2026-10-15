# Release and repository policy

## Local gates

```sh
npm ci --ignore-scripts
npm run repo:check
npm run check
```

The repository check validates required documentation, package/lock/plugin
versions, selected credential patterns, sensitive file types, symlinks, merge
markers and immutable workflow action references. It examines tracked files
plus non-ignored untracked files, including tracked files that later became
ignored. Reports use fixed codes, numeric file indices and line numbers, never
matching values or filenames. Numeric indices refer to the combined Git file
listing used by the checker. It is a bounded heuristic, not a complete secret
scanner or proof that a repository contains no sensitive information.

Limits: 10,000 files, 8 MiB per file and 64 MiB aggregate. Git errors, missing
files and malformed required metadata block the check. Run against a workspace
you control; this is not a sandbox for arbitrary repositories or Git config.

## Version and package

Update package.json and package-lock.json together. Plugin repositories must
also update their loader manifests. Align the CLI version/help where applicable,
then document the change in CHANGELOG.md. Commit the reviewed result.

```sh
npm run release:build
```

This requires a clean checkout and creates an ignored `.release/` directory:
the committed source archive, SHA256SUMS, release-manifest.json and static release
notes. The archive is generated from the verified commit with `git archive`,
not by copying the working directory. Rebuilding the same commit in the same
supported runtime produces the same archive checksum. Runtime/zlib upgrades
may change compression; the manifest always identifies the exact commit.

The checksum detects byte changes relative to the manifest; it is not an
independent cryptographic signature. Keep database files, environment files,
credentials and runtime outputs outside version control. Approved fictional
`.env` examples remain subject to content checks.

## Publish from a version tag

After the main-branch CI is green, tag that reviewed commit with `v` plus the
manifest version and push the tag. The Release workflow:

1. Runs repository checks, tag/version validation and the project's checks on
   Windows/Ubuntu with the supported Node matrix.
2. Builds the source archive from a clean checkout of that exact tag/commit.
3. Transfers only the prepared release files through a pinned GitHub artifact
   action. Build/test jobs have read-only repository permissions.
4. Publishes a GitHub Release in a separate job with `contents: write`, using
   GitHub's ephemeral token. The publishing job checks out no source and executes
   no repository code. No custom token or embedded credential is required.

The publisher refuses an existing release rather than replacing assets. Never
move an already published tag: correct the issue with a new patch version.
This workflow publishes source assets to GitHub; it does not publish to npm.
No release workflow runs for untrusted pull requests.

## Ongoing maintenance

Dependabot proposes grouped GitHub Actions updates on a monthly schedule with
a low open-PR limit. Proposals still need review and passing CI; auto-merge is
not enabled. Workflow actions are pinned to full commit SHAs.

CI runs documentation-only changes too, has bounded runtime and cancels older
runs of the same branch. The policy scripts are vendored in each project so
validation works without a network-fetched shared script. Keep policy changes
and their regression tests aligned across the developer-tool repositories.
