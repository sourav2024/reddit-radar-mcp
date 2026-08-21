# reddit-radar-mcp

Find Reddit threads where your product genuinely fits, reconstruct the conversation, and
gate every drafted reply against a claim boundary you define.

**Read-only by design.** There is no code path that posts, votes, or acts as an account,
and a test asserts there never will be. Drafts are for a human to review, edit, and post.

[![CI](https://github.com/sourav2024/reddit-radar-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sourav2024/reddit-radar-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/reddit-radar-mcp)](https://www.npmjs.com/package/reddit-radar-mcp)
[![node](https://img.shields.io/node/v/reddit-radar-mcp)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/reddit-radar-mcp)](LICENSE)

```bash
npx reddit-radar-mcp          # run as an MCP server
npm install reddit-radar-mcp  # or use the scoring/gate functions directly
```

Requires Node 20.10+. No build step, no native dependencies.

## Why this exists

The usual "social listening" tool finds mentions. That is the easy half. The hard half is
everything after: is this thread actually relevant, what is the person really asking, and
is the reply you are about to post *true*?

This package is built around three claims that came out of running it in production:

1. **Keyword matching produces mostly garbage.** A recency + question-form + "any
   recommendations" heuristic scores 50/100 on literally any recent Reddit post. The fix
   is the anchor rule (below), and it is the most important thing here.
2. **Where a thread lives changes what you should say.** The same question in a buyer
   subreddit and an engineering subreddit warrant different comments, so subreddit tiers
   set *behaviour*, not just ranking.
3. **A model writing promotional copy is the worst possible judge of whether it
   overclaimed.** So the claim gate is deterministic, rule-based, and runs server-side.
   It refuses to hand back a blocked draft.

## Quick start

Write a config:

```js
// radar.config.js
import { defineConfig, packs, composePacks } from 'reddit-radar-mcp';

export default defineConfig({
  product: {
    name: 'Acme',
    what: 'CI/CD pipeline observability.',
    claims: ['flaky test detection', 'build timing breakdowns'],
  },

  queries: ['flaky tests', 'CI pipeline slow', 'build times'],

  // REQUIRED. Without it, every recent question looks like an opportunity.
  domainTerms: ['ci', 'pipeline', 'flaky', 'github actions', 'test suite'],

  // Words that mean something else outside your niche.
  ambiguousTerms: ['build', 'runner'],

  tiers: {
    tier1: { mode: 'PROMOTE',        weight: 20, subreddits: ['devops'] },
    tier2: { mode: 'PROMOTE_SOFT',   weight: 15, subreddits: ['sre', 'kubernetes'] },
    tier3: { mode: 'CONTRIBUTE',     weight: 8,  subreddits: ['ExperiencedDevs'] },
    tier4: { mode: 'TECHNICAL_ONLY', weight: 3,  subreddits: ['programming'] },
  },

  gate: {
    ...composePacks(packs.noPricing, packs.noFabricatedMetrics, packs.noCustomerNames),
    productPattern: /\bAcme\b/i,
    unsupported: [
      { term: /\bJenkins\b/i, why: 'No Jenkins integration exists.' },
    ],
  },
});
```

Register it as an MCP server:

```bash
claude mcp add radar --scope user \
  -e RADAR_CONFIG=/abs/path/radar.config.js \
  -- npx reddit-radar-mcp
```

Then just talk to your agent: *"run a sweep and show me what's worth replying to."*

## The anchor rule

The single most useful idea in this package.

A post is **anchored** only if something ties it to your domain: real domain vocabulary,
an unambiguous query match, or a configured subreddit. Signals that describe the *shape*
of a post — it is recent, it is a question, it says "recommendations" — can never carry a
post on their own.

Without this gate, those shape signals sum to 40+ and pass anything. With it, a post in
r/podcasts asking about a "POD episode" stops outranking a genuine buying question.

Two related behaviours fall out of the same idea:

- **Ambiguous terms** ("build", "POD", "detention") only count when a second domain signal
  is present — *or* when the post is in one of your subreddits, since the subreddit is
  itself domain context.
- **Venting is penalized hard** (-35). Rants out-engage buying questions, so without this
  the ranking inverts and you get "opportunities" that are people complaining about their
  coworkers.

## Engagement modes

Tiers attach a mode to every result, and the sweep output repeats it next to each thread:

| Mode | Meaning |
|---|---|
| `PROMOTE` | Name the product, describe the fitting capability, disclose affiliation. |
| `PROMOTE_SOFT` | Answer first. Mention the product only if they are asking for tooling. |
| `CONTRIBUTE` | Share insight. Product only as context for who you are. |
| `TECHNICAL_ONLY` | **Do not pitch.** Nobody there is buying; promo gets removed. |

## The draft gate

`check_draft` runs two independent checks and refuses to return a blocked draft.

**Claim gate** (`factCheck`) — deterministic rules over your claim boundary. Starter packs
cover the four common failure modes:

| Pack | Blocks |
|---|---|
| `noPricing` | Dollar figures, per-unit rates, price-tier comparisons |
| `noFabricatedMetrics` | Invented percentages, uptime/SLA claims, unverifiable scale |
| `noCustomerNames` | Client references (even anonymous), case studies with measured outcomes |
| `noMarketingSpeak` | "leverage", "seamless", "robust", "game-changing" (WARN) |
| `requireDisclosure` | Naming your product without disclosing affiliation |

Two behaviours worth knowing:

- **Denials are always allowed.** "We do not support Jenkins" passes. An early version
  blocked it, which pushed drafts toward silence about gaps — the opposite of the intent.
  Conceding a real limitation is the cheapest credibility available.
- **Capability checks are assertion-scoped.** "Jenkins is a solid choice if you need
  self-hosting" does not trip the gate, because it is not a claim about *your* product.

**Quality gate** (`styleCheck`) — catches text that reads as unedited generated filler:
em dashes, semicolons, curly quotes, negation framing ("not just X, it's Y"), marketing
vocabulary, flat sentence rhythm, and thin substance.

This is **not** AI-detection evasion. It cannot be and does not try to be. Many subreddits
ban *low-effort* content, and moderators read comments rather than running classifiers. So
the gate enforces what that rule actually asks for: real substance, no filler. The human
still edits and posts, and disclosure is always present.

Pass your domain vocabulary so the substance check knows what a specific noun looks like:

```js
styleCheck(draft, { anchorTerms: [...config.domainTerms, ...config.featureTerms] });
```

## MCP tools

| Tool | Does | LLM cost |
|---|---|---|
| `plan_sweep` | Returns search URLs + the page extractor to run on each | none |
| `ingest_sweep` | Dedupes, scores, ranks swept results into an opportunity list | none |
| `score_thread` | 0–100 score for one post with per-point reasoning | none |
| `analyze_thread` | Reconstructs a thread + returns binding claim constraints | none |
| `parse_thread_html` | Same, from client-side browser extraction | none |
| `check_draft` | **The enforcement point.** APPROVED or BLOCKED | none |
| `get_claim_boundary` | What may and may not be claimed | none |

Every tool is deterministic. The model supplies the writing; the server supplies the facts
and the veto.

## Reddit access

Three interchangeable adapters behind one interface:

- **`BrowserRedditClient`** — reads the same public pages a person reads, from your own
  browser tool. No credentials. This is the default path today.
- **`RedditApiClient`** — OAuth against the official Data API. Access is approval-gated;
  see [docs/REDDIT-ACCESS.md](docs/REDDIT-ACCESS.md).
- **`FixtureRedditClient`** — local JSON fixtures for tests and development.

Fixtures run through the **same normalizers** as live responses, so parsers are genuinely
exercised rather than first meeting real data in production.

A caveat worth stating plainly: browser mode depends on Reddit's DOM, and Reddit ships
redesigns. The extractors are written to fail loudly rather than silently return empty
threads that look like "no discussion found."

## Programmatic use

```js
import { scoreRelevance, factCheck, styleCheck, packs, composePacks } from 'reddit-radar-mcp';
import config from './radar.config.js';

const result = scoreRelevance(post, config, { matchedQueries: ['flaky tests'] });
if (result.passed) console.log(result.score, result.reasons);

const gate = factCheck(draft, config.gate);
if (!gate.allowed) console.log(gate.findings);
```

## Ethics and policy

This tool exists to help you find conversations you can genuinely contribute to. It will
not help you astroturf.

- **No posting automation.** Not implemented, and enforced by test.
- **Disclose affiliation.** `requireDisclosure` is on by default. Undisclosed vendor
  comments get removed and can earn a permanent ban, which ends the channel entirely.
- **One account.** Reddit's Responsible Builder Policy prohibits registering multiple
  accounts for the same use case. Do not use this to run a sockpuppet network.
- **Threads are scored, never people.** Nothing here profiles an author, in line with
  Reddit's prohibition on inferring user characteristics.
- **Respect subreddit rules.** `TECHNICAL_ONLY` exists because pitching in the wrong place
  is both rude and counterproductive.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `RADAR_CONFIG` | — | **Required.** Absolute path to your config (`.js` ESM with a default export, or `.json`). |
| `REDDIT_MODE` | `browser` | `browser`, `live`, or `fixture`. See [docs/REDDIT-ACCESS.md](docs/REDDIT-ACCESS.md). |
| `REDDIT_CLIENT_ID` | — | `live` mode only. |
| `REDDIT_CLIENT_SECRET` | — | `live` mode only. |
| `REDDIT_USER_AGENT` | — | `live` mode only. Must be `<platform>:<appid>:<version> (by /u/<user>)`. |
| `REDDIT_QPM` | `60` | Rate limit for `live` mode. Lower than Reddit's advertised 100 on purpose. |
| `RADAR_LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info`, `debug`. |
| `RADAR_LOG_FORMAT` | `json` | `json` or `text`. |

Full annotated list in [.env.example](.env.example).

Logs go to **stderr only**. On stdio transport stdout carries the JSON-RPC protocol, so
anything written there corrupts the stream. Credentials in URLs and sensitive keys are
redacted before logging.

## Troubleshooting

**Everything scores as an opportunity.** Your `domainTerms` are too generic or missing.
That list is what anchors a post to your domain, and without it the shape signals carry
posts on their own. Config validation treats an empty list as an error for this reason.

**Nothing scores at all.** Check that `domainTerms` uses words that actually appear in post
titles. Terms of 5+ characters match simple inflections (`pipeline` → `pipelines`); shorter
ones match exactly, so `app` will not match `apps`.

**A good draft is blocked as thin substance.** Pass your vocabulary as `anchorTerms` — the
MCP server does this from your config automatically, but a direct `styleCheck()` call needs
it explicitly.

**An honest limitation is blocked.** It should not be; denials are explicitly allowed.
Please [report it](https://github.com/sourav2024/reddit-radar-mcp/issues).

**Reddit shows "Prove your humanity".** A cold search can hit a JS challenge. Loading any
subreddit page first usually clears it for the session.

More in [SUPPORT.md](SUPPORT.md).

## Tests

```bash
npm test       # 33 unit tests
npm run smoke  # 14 checks over the real MCP wire protocol
npm run verify # everything, including the metadata consistency guard
```

The safety suite asserts that no client exposes a write method, no source file references
a Reddit write endpoint, and the package exports no posting function.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Note the permanent
exclusions listed there: posting automation, multi-account support, and AI-detection
evasion are deliberate non-goals rather than missing features.

- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)

## License

MIT — see [LICENSE](LICENSE).
