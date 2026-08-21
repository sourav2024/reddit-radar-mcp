# Reddit access

Three adapters, one interface. Pick with `REDDIT_MODE`.

## browser (default today)

Reads the same public pages a person reads, using your agent's own browser tool. No
credentials required.

`plan_sweep` returns the URLs plus an extractor function to run on each page; you navigate
and run it, then hand the rows to `ingest_sweep`. Thread pages work the same way via
`parse_thread_html`.

Known behaviour: Reddit may serve a "Prove your humanity" interstitial on a cold search.
Loading any subreddit page first typically clears the JS challenge for the session.

**Tradeoff, stated plainly:** this depends on Reddit's DOM, and Reddit ships redesigns.
The extractors are written to fail loudly — returning nothing and naming the selector that
missed — rather than silently returning empty threads that look like "no discussion found."

## live (official API)

```bash
REDDIT_MODE=live
REDDIT_CLIENT_ID=...
REDDIT_CLIENT_SECRET=...
REDDIT_USER_AGENT="macos:my-radar:v1.0.0 (by /u/your-username)"
```

Access is **approval-gated** under Reddit's Responsible Builder Policy. The policy's first
line is "Approval is required," and reported queues run 2–4 weeks. Commercial use is a
separate track with per-call billing.

Two things worth knowing before you build against it:

- The old public `.json` endpoints are dead. `reddit.com/search.json` returns `403` with an
  HTML body. Code that assumes otherwise fails *silently* by parsing HTML as data, so the
  client explicitly rejects non-JSON responses.
- The `403` is credential-gating, not User-Agent filtering. There is no workaround, and
  this package does not look for one.

Rate limiting defaults to 60 QPM rather than Reddit's advertised 100, since practitioner
reports put the sustainable rate lower once burst and reset behaviour are accounted for.
The limiter defers to Reddit's `x-ratelimit-*` headers when present.

## fixture

Local JSON in Reddit's raw wire format, run through the same normalizers as live
responses. Used by the test suite and useful for development without network access.
