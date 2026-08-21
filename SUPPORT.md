# Support

## Start here

1. **[README](README.md)** — configuration, the anchor rule, engagement modes, and the gate.
2. **[docs/REDDIT-ACCESS.md](docs/REDDIT-ACCESS.md)** — the three adapters and what each needs.
3. **[examples/devtools.config.js](examples/devtools.config.js)** — a complete config.

## Common problems

**"RADAR_CONFIG is not set"** — the server needs an absolute path to your config. There is
no auto-discovery, deliberately: a config file is executable code, so the path is explicit.

**Everything scores as an opportunity** — your `domainTerms` are probably too generic, or
missing. That list is what anchors a post to your domain; without it, shape signals
(recency, question form) carry posts on their own. Config validation errors on an empty
list for this reason.

**Nothing scores at all** — check that `domainTerms` uses words that actually appear in
post titles. Terms of 5+ characters match simple inflections (`pipeline` → `pipelines`),
but shorter ones match exactly.

**A good draft is blocked as thin substance** — pass your vocabulary so the check knows
what a specific noun looks like in your field:

```js
styleCheck(draft, { anchorTerms: [...config.domainTerms, ...config.featureTerms] });
```

The MCP server does this automatically from your config.

**An honest limitation is being blocked** — it should not be. Denials are explicitly
allowed ("we do not support X"). If a denial trips a rule, that is a bug worth reporting.

**Reddit shows "Prove your humanity"** — a cold search can hit a JS challenge. Loading any
subreddit page first usually clears it for the session.

## Asking for help

- **Questions and configuration help** —
  [Discussions](https://github.com/sourav2024/reddit-radar-mcp/discussions)
- **Bugs** — [Issues](https://github.com/sourav2024/reddit-radar-mcp/issues)
- **Security** — [private advisory](https://github.com/sourav2024/reddit-radar-mcp/security/advisories/new),
  not a public issue

When reporting, include the package version, your Node version, and a minimal config.
**Redact your claim boundary and any credentials** — a claim boundary often encodes
internal product detail.

## What this project will not help with

Automating posts or votes, running multiple accounts, or evading AI-content detection.
These are deliberate exclusions. See [CONTRIBUTING.md](CONTRIBUTING.md).
