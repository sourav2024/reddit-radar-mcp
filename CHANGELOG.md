# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [0.1.0] — 2026-08-21

First public release.

### Added

- **Relevance scoring with an anchor rule.** `scoreRelevance()` scores a post 0–100 and
  returns the reasoning for every point awarded. The important part is the anchor rule: a
  post only accumulates context-free bonuses (recency, question form, generic intent) if
  something first ties it to your domain — real domain vocabulary, an unambiguous query
  match, or a configured subreddit.

  Without that gate those signals sum past the default threshold on their own, which
  passes any recent Reddit question regardless of topic. Two related behaviours fall out
  of it: **ambiguous terms** only count alongside a second domain signal (or inside one of
  your subreddits, since the subreddit is itself context), and **venting is penalized
  hard** because rants out-engage buying questions and otherwise invert the ranking.

  Everything domain-specific comes from config. All 14 scoring weights are overridable.

- **Subreddit tiers that set behaviour, not just ranking.** Each tier attaches an
  engagement mode to every result — `PROMOTE`, `PROMOTE_SOFT`, `CONTRIBUTE`, or
  `TECHNICAL_ONLY` — and the sweep output repeats it next to each thread. The same
  question in a buyer subreddit and an engineering subreddit warrant different comments,
  and `TECHNICAL_ONLY` exists because a product pitch in the wrong place gets removed.

- **A deterministic claim gate.** `factCheck()` runs rule-based checks over a draft and
  refuses to return a blocked one. Rule-based on purpose: a model writing promotional copy
  is the least reliable judge of whether it overclaimed, so an LLM pass can run in addition
  but never instead.

  Two behaviours worth knowing. **Denials are always allowed** — "we do not support X"
  passes, because an earlier design blocked it and that pushed drafts toward silence about
  gaps. And **capability checks are assertion-scoped**, so discussing a competitor's
  feature does not trip a rule about your own.

- **Five starter rule packs** so the gate is useful without writing rules from scratch:
  `noPricing`, `noFabricatedMetrics`, `noCustomerNames`, `noMarketingSpeak`, and
  `requireDisclosure`. Compose them with `composePacks()`, then add your own. The packs
  are plain objects — inspect, edit, or discard any rule.

- **A draft quality gate.** `styleCheck()` catches text that reads as unedited generated
  filler: em dashes, semicolons, curly quotes, negation framing, marketing vocabulary,
  flat sentence rhythm, and thin substance. Pass your domain vocabulary via `anchorTerms`
  so the substance check knows what a specific noun looks like in your field.

  This is not AI-detection evasion, which is out of scope and would not work. Many
  subreddits ban *low-effort* content and moderators read rather than run classifiers, so
  the gate enforces what such a rule actually asks for.

- **Three interchangeable Reddit adapters** behind one interface: `BrowserRedditClient`
  (public pages via your agent's browser tool, no credentials), `RedditApiClient` (OAuth
  Data API), and `FixtureRedditClient` (local JSON). Fixtures run through the same
  normalizers as live responses, so parsers are exercised rather than first meeting real
  data in production.

- **Thread reconstruction** that ranks comments so OP replies and moderator notes survive
  the cap ahead of a high-scoring joke, detects competing products, and reports how many
  branches were not retrieved — so the model is told when it has not seen a whole thread
  instead of silently assuming it has.

- **Seven MCP tools**: `plan_sweep`, `ingest_sweep`, `score_thread`, `analyze_thread`,
  `parse_thread_html`, `check_draft`, `get_claim_boundary`. All deterministic, no LLM cost.

- **Config validation** that fails loudly at startup. Missing `domainTerms` is an error
  rather than a warning, because a radar with no anchor vocabulary silently reports every
  recent question as an opportunity.

- **Structured logging** to stderr only, since stdout carries the JSON-RPC protocol on
  stdio transport. JSON by default, `text` for humans, with URL credentials and sensitive
  keys redacted.

### Safety

- **No posting, voting, or account automation**, enforced by tests rather than promised in
  prose. `test/safety.test.js` asserts no client exposes a write method, no source file
  references a Reddit write endpoint, and the package exports no posting function. The
  smoke test independently verifies no advertised MCP tool name looks like a write.
- **Disclosure required by default.** `requireDisclosure` is on, because undisclosed
  vendor comments get removed and can earn a permanent ban — which ends the channel
  entirely.
- **Threads are scored, never people.** Nothing profiles an author, in line with Reddit's
  prohibition on inferring user characteristics.

[Unreleased]: https://github.com/sourav2024/reddit-radar-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sourav2024/reddit-radar-mcp/releases/tag/v0.1.0
