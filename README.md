# Road to Devcon V — Problem 1: Tsering Archive

Minimal, auditable foundation for a censorship-resistant testimony archive on
[ETHSwarm](https://ethswarm.org), built on `bee-js` **v13** (namespaced API).

> Phase 1 scope: project foundation only. No publishing, no feed writes, no
> postage purchases are implemented yet. Nothing here fakes a feed address,
> reference, or batch value.

## Problem

Tsering (a fictional character for this exercise) needs to publish testimony
that survives takedowns: content must be content-addressed on Swarm, updated
through an append-only feed she controls, resolvable via a stable manifest,
and recoverable by anyone with the feed identity — even if the original
uploader disappears.

This repo will grow into:

```text
publish (file → Swarm ref) → feed append (owner+topic, sequential index)
  → manifest (stable /bzz/ URL) → recover (reader + reference → file)
```

with honest postage/status reporting throughout.

## Architecture (Phase 1)

```text
src/
  config.js     env + validation (BEE_API_URL, FEED_*, POSTAGE_BATCH_ID)
  bee.js        Bee client factory (new Bee(url), no I/O)
  feed.js       v13 feed helpers: makeReader/makeWriter, resolveNextIndex
  archive.js    pure payload build/parse (no network)
  recovery.js   live fetch wrapper + pure summary formatter
  postage.js    pure batch select/format over real stamp data
  status.js     live node status aggregation (status.* + connectivity.*)
  cli.js        status | batches | config | help (no simulation)
scripts/
  build.js      node --check gate over src/scripts/tests
  check-bee.js  live /health/readiness/versions/topology probe
  check-batch.js live stamp.getAll() probe
tests/
  unit.test.js        offline, deterministic (node:test)
  integration.test.js gated on live Bee (skips when down)
```

Key v13 decisions (see Phase 0 recon):

* `bee.feed.makeWriter/makeReader`, `uploadReference/downloadReference`,
  `bee.feed.createManifest`, `FeedIndex` sequencing — never v12 flat methods.
* `writer.upload()` / `reader.download()` are deprecated/ambiguous — forbidden.
* `bee.file.*`, `bee.data.*`, `bee.stamp.getAll()`, `bee.storage.*`,
  `bee.status.*`, `bee.connectivity.*` namespaces only.

## Prerequisites

* Node.js `>=18` (developed/verified on `v22.23.2`)
* npm `10.9.8` (yarn/pnpm also installed; **npm is canonical** for lockfile)
* A Bee node for *real* integration (not included, not running by default)

Dependencies (exact pins, see `package.json` + `package-lock.json`):

```text
@ethersphere/bee-js  13.1.0
dotenv                18.0.1
```

## Bee endpoint

Default: `http://localhost:1633` (`BEE_API_URL`, see `.env.example`).

```bash
cp .env.example .env   # then fill real values; never commit .env
```

## Current network limitation (honest status)

As of Phase 1 verification, **no Bee node answers at `localhost:1633`**
(connection refused; no listener/process). Therefore:

* `npm test` unit suite passes offline; integration test **skips**.
* `npm run check:bee` / `batches` fail loudly with `Bee unreachable` — by design.
* Ultra-light Bee nodes **cannot write** (`POST /bzz`, `/soc`, `/feeds`
  require full/light). Publishing additionally needs peers + a funded,
  `usable` postage batch with `remainingSize > 0`.

Do not interpret skipped/failed live checks as passing integration.

## Local development vs real Swarm integration

| | Local development (works now) | Real Swarm integration (needs Bee) |
|---|---|---|
| `npm install` | ✅ | ✅ |
| `npm run build` (`node --check`) | ✅ offline | ✅ |
| `npm test` (unit) | ✅ offline | ✅ |
| `npm test` (integration) | ⏭️ skips | ✅ reads live health |
| `node src/cli.js config` | ✅ no network | ✅ |
| `node src/cli.js status` | ❌ `Bee unreachable` | ✅ live status |
| `node src/cli.js batches` | ❌ `Bee unreachable` | ✅ live batches |
| publish / feed write / manifest | 🚫 not implemented (Phase 2) | 🚫 same |

## Security model

* Private keys come **only** from the environment (`FEED_PRIVATE_KEY`); the
  repo stores no keys, mnemonics, gift codes, or batch ids (`.env.example`
  holds placeholders).
* `.env` is git-ignored; `cli.js config` redacts the key as `<set>`.
* Feed control = private-key holder; anyone with `FEED_OWNER + FEED_TOPIC`
  (or manifest ref) can read — reads need no key.
* Uploads are client-explicit: no auto-buy/top-up of postage; batch selection
  requires `usable === true` and remaining space.
* Errors from Bee propagate unchanged — the code never masks “node down”,
  “feed empty”, or “no postage” with fabricated values.

## Development commands

```bash
npm install        # exact pinned install
npm run build      # syntax gate (node --check over src/scripts/tests)
npm test           # node --test (unit always; integration skips w/o Bee)
node src/cli.js help
node src/cli.js config
node src/cli.js status     # needs live Bee
node src/cli.js batches    # needs live Bee
npm run check:bee
npm run check:batch
```

## What is NOT here (on purpose)

* No publishing flow, no hard-coded references, owners, topics, or batch ids.
* No `^13.x` ranges — exact pins for reproducibility.
* No commits made by setup — review `git status` before committing.
