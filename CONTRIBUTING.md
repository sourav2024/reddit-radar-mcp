# Contributing

Thanks for considering it. This project is small and opinionated, so a quick read here
will save you time.

## Setup

```bash
git clone https://github.com/sourav2024/reddit-radar-mcp.git
cd reddit-radar-mcp
npm ci
npm run verify   # build + consistency + tests + MCP smoke test
```

No build step. Plain ESM on Node 20+.

## Before you open a PR

```bash
npm run verify
```

That runs a syntax check, the metadata consistency guard, the unit tests, and a smoke test
that drives the real MCP wire protocol over stdio. All four must pass.

## Things that will not be merged

These are deliberate exclusions, not gaps:

- **Posting, commenting, voting, or any account automation.** The read-only guarantee is
  the project's core promise and is enforced by tests.
- **Multi-account support.** Reddit's Responsible Builder Policy prohibits registering
  multiple accounts for the same use case.
- **Anything whose purpose is evading AI-content detection.** It does not work, and the
  quality gate exists to enforce genuine substance instead.
- **Removing the disclosure requirement by default.** It can be switched off in config for
  non-promotional use, but the default stays on.

## Code conventions

- **Explain the reasoning, not the mechanics.** A comment saying what a regex matches is
  noise; a comment saying *why the threshold is 5 and what broke when it was 3* is the
  reason this codebase is maintainable. Most of the scoring rules exist because a specific
  real-world case went wrong — say which one.
- **Scoring and gate changes need a test that captures the case.** If you are changing a
  weight or a pattern, add the post or draft that motivated it. Several existing tests are
  named after the production bug they lock down.
- **Keep the domain out of the engine.** Anything specific to one product or industry
  belongs in config, not in `src/`. A hardcoded vocabulary list is how the substance check
  silently broke for every domain except the one it was written for.
- **Deterministic over clever.** Both gates are rule-based on purpose. Do not replace a
  rule with an LLM call.

## Adding a rule pack

Packs live in [`src/gate/packs.js`](src/gate/packs.js). A useful pack is one nearly every
B2B product needs. Include:

- A doc comment explaining what failure mode it prevents and why it matters.
- `BLOCK` for a claim that is verifiably wrong or a policy violation; `WARN` for something
  that needs human judgment.
- A test in `test/gate.test.js` proving it blocks the bad case **and** allows the honest
  adjacent one. The denial test is the model to follow.

## Commit messages

Plain imperative present tense. A one-line summary is fine for a small change; explain the
reasoning in the body when the change is not obvious.

## Releasing

Maintainers only:

1. Update `CHANGELOG.md` under a new version heading.
2. Bump the version in `package.json` **and** `server.json` (twice — top level and the npm
   package entry). `npm run check:consistency` fails if they drift.
3. Tag `vX.Y.Z` and push. The release workflow verifies, publishes with provenance, and
   drafts release notes.
