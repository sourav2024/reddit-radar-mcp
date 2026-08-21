# Security policy

## Reporting a vulnerability

Report privately via
[GitHub Security Advisories](https://github.com/sourav2024/reddit-radar-mcp/security/advisories/new).
Please do not open a public issue for a vulnerability.

Include what you did, what happened, and the impact you think it has. A proof of concept
helps. Expect an acknowledgement within a few days.

## Threat model

This package reads public Reddit pages and evaluates text locally. Understanding what it
does and does not touch should tell you where the risk actually is.

**It does not:**

- Post, comment, vote, message, or authenticate as a user account. There is no code path
  for it, and `test/safety.test.js` asserts there never will be. The one outbound POST in
  the codebase is the OAuth token request in `live` mode.
- Store credentials. Reddit credentials are read from the environment and used for an
  app-only OAuth token. Nothing is written to disk.
- Send your config, claim boundary, or drafts anywhere. All scoring and gating is local.

**It does:**

- Read config from a path you supply, via dynamic `import()`. **A config file is executable
  code.** Only point `RADAR_CONFIG` at a file you trust — the same care you would give any
  file you `require`. This is why there is no auto-discovery of configs in the working
  directory.
- Compile regular expressions from your config (`rules[].pattern`, `unsupported[].term`).
  A pathological pattern can cause catastrophic backtracking against a long draft. Patterns
  come from your own config rather than from untrusted input, so this is a footgun rather
  than a vulnerability — but keep patterns simple, and avoid nested unbounded quantifiers.
- Fetch Reddit URLs in `live` mode. Requests go only to `oauth.reddit.com` and
  `www.reddit.com`.

## What is explicitly out of scope

The claim gate is a **safety net, not a guarantee**. It catches the patterns it has rules
for. A draft that passes has not been proven true — a human still reviews and posts. Do not
build an automated pipeline that treats `APPROVED` as permission to publish; that defeats
the design.

Reports asking for help with account automation, multi-account operation, or AI-detection
evasion are not security issues and will be closed.

## Supported versions

The latest minor release receives security fixes. Given the pre-1.0 version, expect fixes
in a new minor rather than a backport.
