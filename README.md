# Road to Devcon V — Problem 1: Tsering Archive

Minimal, auditable foundation for a censorship-resistant testimony archive on
[ETHSwarm](https://ethswarm.org), built on `bee-js` **v13** (namespaced API).

> Phase 4 scope: independent stranger recovery (owner + topic → latest feed
> entry → manifest → every folio, read-only, no private key, no postage).
> Network tests report BLOCKED instead of pretending PASS — no live Bee node
> was reachable during this phase, so live stranger recovery is implemented
> and offline-tested but NOT yet verified against a live network.

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

## Architecture (Phase 2)

```text
feed.json       TRACKED public identity: topic + owner (no secrets)
src/
  config.js     env + validation (BEE_API_URL, FEED_*, POSTAGE_BATCH_ID)
  bee.js        Bee client factory (new Bee(url), no I/O)
  feed.js       v13 feed core: loadFeedIdentity, readLatestEntry,
                resolveNextIndex, appendReference (safe append, no index arg)
  archive.js    pure payload build/parse (Phase 1) + versioned
                tsering-archive manifest build/parse/validate (Phase 3)
  publish.js    archive input collection, postage resolution, content +
                manifest upload via bee.data.upload, publish/update through
                the Phase 2 safe feed append (Phase 3)
  recovery.js   stranger recovery: recoverArchive / recoverArchiveToDirectory
                (owner+topic → feed → manifest → every folio; read-only,
                key-free, path-safe) + pure summary formatter
  postage.js    node-derived status (getPostageStatus: NO_POSTAGE /
                NO_USABLE_POSTAGE / USABLE), batchTTL-seconds lifetime,
                strict validation — never invents batches or lifetimes
  status.js     live node status aggregation (status.* + connectivity.*)
  cli.js        status | batches | postage | config | feed | feed:read | feed:append
                publish <archive> | update <archive> | recover <owner> <topic> <outdir>
scripts/
  build.js      node --check gate over src/scripts/tests
  init-feed.js  local-dev identity setup (key → .env, owner+topic → feed.json)
  check-bee.js  live /health/readiness/versions/topology probe
  check-batch.js live stamp.getAll() probe
tests/
  unit.test.js        offline, deterministic (node:test)
  feed.test.js        offline proofs + BLOCKED-gated live feed tests
  archive.test.js     offline manifest proofs (creation, parsing, versions,
                      determinism, malformed rejection, multi-chunk fixture)
  publish.test.js     offline publish proofs (postage, upload, ref-not-bytes)
                      + BLOCKED-gated live publication tests
  recovery.test.js    offline stranger proofs (empty feed, manifest,
                      malformed, traversal, multi-file, delete-the-app)
                      + BLOCKED-gated live recovery tests
  postage.test.js     offline postage proofs (states, configured-batch
                      validation, seconds-lifetime, utilization, publish
                      gating, no invented batches) + BLOCKED-gated live test
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

## Feed identity (Phase 2)

```text
Archive → Swarm upload → Archive reference → Swarm Feed → Owner + Topic
```

* **Topic** (deterministic, documented): `tsering-archive-v1`, stored in
  tracked `feed.json`. Reproduced by `npm run feed:init`.
* **Owner** (public address, no private key needed to read): stored in tracked
  `feed.json`. Reading (`feed:read`) requires only owner + topic.
* **Private key**: lives ONLY in untracked `.env` as `FEED_PRIVATE_KEY`
  (created by `npm run feed:init`, local-dev keypair). Writing requires it;
  nothing in the repo exposes it — `feed.json` is asserted secret-free in tests.
* Production MUST generate a fresh keypair and update `feed.json` owner.

### Safe append rule (next index is always network-derived)

Verified against installed `@ethersphere/bee-js@13.1.0`
(`dist/mjs/feed/index.js`): `updateFeedWithReference` computes
`options?.index ?? (await findNextIndex(...))` — i.e. omitting `index` makes
the SDK fetch the latest update over the network and use `feedIndexNext`
(or `0` on empty feed) immediately before the write. Therefore
`appendReference()` calls `writer.uploadReference(batchId, ref)` with **no
index argument**. Explicit indexes, local counters, `index++`, `localStorage`,
and JSON index files are forbidden (static-audited; see Phase 2 report).
Single-publisher assumption: the lookup is read-then-write, not atomic, so
concurrent writers could race — out of scope for this archive.

## Current network limitation (honest status)

As of Phase 3 verification, **no Bee node answers at `localhost:1633`**
(connection refused; no listener/process). Therefore:

* `npm test` offline suites pass (58 pass); all 7 live tests **skip** as
  BLOCKED — none fake a PASS.
* `npm run check:bee` / `batches` fail loudly with `Bee unreachable` — by design.
* `npm run publish` / `update` fail loudly before any fabrication
  (`Bee unreachable` or `No usable postage batch is available`).
* Real network publication has NOT been performed yet (see below).

Do not interpret skipped/failed live checks as passing integration.

## Archive format

The manifest is a versioned, deterministic JSON document
(`src/archive.js`: `buildArchiveManifest` / `parseArchiveManifest`):

```json
{
  "schema": "tsering-archive",
  "version": 1,
  "name": "Tsering Manuscript Archive",
  "updatedAt": "2026-03-01T00:00:00.000Z",
  "items": [
    {
      "id": "folio-0001",
      "name": "folio-0001.jpg",
      "size": 1234,
      "reference": "<64-hex Swarm ref from bee.data.upload>"
    }
  ]
}
```

Rules:

* `schema` must be `"tsering-archive"`, `version` must be `1` — anything else
  is rejected with an explicit error (forward-compatible version gate).
* Every item needs a unique non-empty `id`, a non-empty `name`, and a valid
  Swarm reference (64-hex unencrypted, 128-hex encrypted accepted); `size`
  (bytes) is optional metadata.
* Serialization is deterministic: fixed key order, items sorted by `id` —
  identical logical input yields byte-identical JSON.
* No references are ever invented: the builder requires one per item, and
  real references come only from `bee.data.upload` responses.
* The offline single-entry helpers `buildArchivePayload`/`parseArchivePayload`
  (Phase 1) are kept for compatibility but are NOT part of the feed flow.

## Publishing

```bash
npm run publish -- <archive-file-or-directory>
# e.g. npm run publish -- ./manuscripts
```

The workflow (`src/publish.js: publishArchive`):

1. Validate the input (`collectArchiveEntries`): single file or directory of
   files, sorted by name; missing paths, empty directories, and zero-byte
   files are rejected before any network call.
2. Resolve a usable postage batch against the live node (`bee.stamp.getAll`):
   a configured `POSTAGE_BATCH_ID` must exist, be `usable`, and have space;
   otherwise the first usable batch is auto-selected.
3. Upload each file via `bee.data.upload(batchId, bytes)` → per-file refs.
4. Build the manifest (pure, deterministic) and upload it via
   `bee.data.upload(batchId, manifestJson)` → archive (manifest) reference.
5. Append the archive reference to the feed through the Phase 2 safe append
   (`writer.uploadReference(batchId, ref)` with NO index option — the SDK
   derives the next index from the network per call).
6. Read back the latest entry (best-effort, for display) and print:

```text
Tsering Archive Published

Feed Owner:
...

Feed Topic:
...

Archive Reference:
...

Feed Index:
...

Postage:
...
```

SUCCESS is printed only after the network operations actually succeed.

## Updating

```bash
npm run update -- <archive-file-or-directory>
```

Feeds are append-only, so an update is a fresh publication: the new files
are uploaded separately, a new manifest is built and uploaded, and the new
archive reference is appended through the **same** Phase 2 safe mechanism.
No local counter is introduced and no `latestIndex + 1` is computed locally
— `updateArchive` delegates to `publishArchive` by design.

## Feed relationship

```text
Archive files
     ↓  bee.data.upload (content, chunked by Swarm past ~4 KiB)
Archive/manifest reference (32 bytes)
     ↓  writer.uploadReference — reference only, never payload bytes
Swarm Feed
     ↓
Stable Owner + Topic (feed.json)
```

The feed MUST NOT contain the archive payload: the writer is always called
with exactly `(batchId, 64-hex reference)` — asserted in tests, including a
multi-chunk fixture whose manifest exceeds one Swarm chunk (~4 KiB) yet still
reaches the feed as a single 32-byte reference.

## Postage

A postage batch is Swarm's prepaid storage lease: every upload (file bytes,
manifest bytes, feed update chunk) spends batch capacity, and content stays
pinned only while its batch lives. Publication therefore requires a **usable
funded batch with remaining space** — reads (status, recovery) need none.

Discovery is exclusively node-derived: `bee.stamp.getAll()` (verified
bee-js 13.1.0) returns live `PostageBatch` entries — `batchID` (64-hex),
`usable` (boolean), `utilization`/`usage`/`usageText`, `depth`,
`bucketDepth`, `blockNumber`, `amount`, plus `duration` and
`remainingSize`. No batch id is ever invented or hard-coded, and a
configured `POSTAGE_BATCH_ID` is validated against the live list before
use — a configured value alone proves nothing.

Remaining lifetime comes straight from the node: Bee reports `batchTTL`
per batch, which bee-js exposes as `batch.duration` in **seconds** (see
`dist/mjs/utils/stamps.js`: `Duration.fromSeconds(batchTTL)`). The project
reports those seconds first (`86400s`) with an explicitly labeled day
estimate (`~about 1 day, estimated from node seconds`) — blocks are never
confused with days, and no calendar expiry is claimed beyond the node's
seconds. A missing duration renders as `unknown`, never a guess.

`npm run postage` (read-only, spends nothing) distinguishes three states:

```text
Bee: unreachable at http://localhost:1633   # node down — NOT "no postage"
Cannot determine postage state.
```

```text
Bee: reachable at …
Batches discovered: 0                        # NO_POSTAGE
Publishing is blocked until a usable postage batch is available.
```

```text
Bee: reachable at …
Batches discovered: N                        # USABLE or NO_USABLE_POSTAGE
Batch: …
Usable: yes/no
Remaining lifetime: …
Utilization: …
```

Resolution order for publishing (before ANY upload is attempted):

1. `POSTAGE_BATCH_ID` if configured — must be found live and `usable`.
2. Otherwise the first `usable === true` batch with remaining space.
3. Otherwise hard failure:

```text
No usable postage batch is available.
Fund a Bee postage batch before publishing.
```

Never claim the archive is permanently persisted: Swarm guarantees storage
only for the batch's remaining lifetime, so persistence holds while a
funding batch with reported remaining seconds covers the content — check
`npm run postage` for the observed values. No live batch has been observed
in this environment yet.

## Failure states

| Condition | Behavior |
|---|---|
| Bee unreachable | Command exits 1 with `Bee unreachable …`; nothing is printed as published. |
| No usable postage | `No usable postage batch is available. Fund a Bee postage batch before publishing.` |
| Invalid archive (missing/empty) | Rejected before any network call. |
| Item upload fails | Error names the item and counts progress; `partial.uploadedItems` lists what landed. |
| Manifest upload fails | Error preserves `partial.uploadedItems`; re-run retries the manifest step. |
| Feed append fails | Error reports the live `archiveReference` in `partial` — content is on Swarm, only the feed pointer is pending; re-run to point the feed at it. |
| Index read-back fails | Publication still counts as success; index prints as `unknown …`. |

Where full rollback is impossible (content already stored), the error message
states exactly what succeeded and what remains — partial state is never
presented as success.

## Public recovery

A stranger needs exactly two public values — **owner + topic** — plus any
Bee endpoint. Recovery (`src/recovery.js: recoverArchive`) is read-only:

```text
Owner + Topic
     ↓  reader.downloadReference() — latest network update, no index arg
archive reference
     ↓  bee.data.download(archiveReference)
manifest JSON (parsed + validated by the existing archive logic)
     ↓  bee.data.download(item.reference) for EVERY item
folio bytes (size-checked against the manifest, sha256-recorded)
```

```bash
npm run recover -- <owner> <topic> <output-directory>
```

The CLI prints staged progress and only prints `Recovery complete.` after
every network read and validation succeeds. Recovery loads no
`FEED_PRIVATE_KEY`, needs no postage batch (reads are free), computes no
feed index, and consults no local archive, cache, or state file. Identifier
strings (`"<owner> <topic>"`, `"<owner>/<topic>"`, or JSON) are accepted as
convenience spellings of the same owner + topic semantics — never a URL.

## Delete-the-app scenario

Tsering can hand someone `owner + topic`, then delete the application, and
that person still retrieves every folio: the recovery path intentionally
depends only on published identifiers and public network data — never on
the private feed key, `.env`, `feed.json`, a remembered index, the original
archive directory, or any upload cache. This is proven by the offline
delete-the-app test (`tests/recovery.test.js`): publish into a simulated
network, erase the originals and the key, hand a fresh client only
`{ owner, topic }`, and verify every folio byte-for-byte.

## Live verification

* **Offline recovery tests** (`tests/recovery.test.js`, 12 suites): empty
  feed, manifest recovery, malformed manifests, bad item refs, every-folio
  retrieval + order, no-key/no-state proofs, identifier parsing, path
  traversal, multi-file reconstruction, delete-the-app — all PASS.
* **Live recovery tests** (same file, gated): end-to-end recovery from the
  tracked identity, plus a full live delete-the-app cycle behind the
  explicit `TSERING_LIVE_RECOVERY=1` opt-in (publishing side needs
  `FEED_PRIVATE_KEY` + `POSTAGE_BATCH_ID`; the recovery side uses neither).
* **Blocked live tests**: with no Bee at `localhost:1633` they report
  `BLOCKED — Bee unreachable`, an empty feed reports `BLOCKED — feed has no
  published archive`, and missing publish credentials report `BLOCKED — no
  live publication available`. No mocked result is ever reported as live.

Persistence is NOT claimed until real Bee publication and independent
retrieval have been verified against a live network.

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
| `npm run postage` | ❌ `Bee unreachable` (distinct from no-postage) | ✅ node-derived status + lifetimes |
| `node src/cli.js feed` | ✅ reads tracked feed.json | ✅ |
| `node src/cli.js feed:read` | ❌ `Bee unreachable` | ✅ live entry or `empty` |
| `node src/cli.js feed:append <ref>` | ❌ needs Bee + key + postage | ✅ network-indexed append |
| `npm run publish -- <archive>` | ❌ needs Bee + key + postage | ✅ content+manifest upload, feed stores ref |
| `npm run update -- <archive>` | ❌ needs Bee + key + postage | ✅ same safe-append path, new manifest ref |
| `npm run recover -- <owner> <topic> <outdir>` | ❌ needs Bee (no key, no postage) | ✅ every folio from owner+topic only |
| publish (file→ref) / manifest | ✅ offline build/validate works; live upload needs Bee | ✅ same |

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
npm test           # offline proofs pass; live tests SKIP as BLOCKED w/o Bee
npm run feed:init  # local-dev feed identity (key → .env, owner+topic → feed.json)
node src/cli.js help
node src/cli.js config
node src/cli.js feed           # tracked identity, no network
node src/cli.js feed:read      # needs live Bee
node src/cli.js feed:append <64-hex-ref>  # needs live Bee + key + postage
npm run publish -- <archive>   # needs live Bee + key + postage
npm run update -- <archive>    # needs live Bee + key + postage
npm run recover -- <owner> <topic> <outdir>  # needs live Bee; no key, no postage
node src/cli.js status     # needs live Bee
node src/cli.js batches    # needs live Bee (raw batch list)
npm run postage            # needs live Bee; read-only status + lifetimes
npm run check:bee
npm run check:batch
```

Live feed-mutating tests (real publication/update) additionally require
`TSERING_LIVE_PUBLISH=1` as an explicit opt-in, plus `FEED_PRIVATE_KEY` and
`POSTAGE_BATCH_ID` — otherwise they report BLOCKED like all other live tests.
The live delete-the-app recovery cycle likewise requires
`TSERING_LIVE_RECOVERY=1`, and the live postage read requires
`TSERING_LIVE_POSTAGE=1`.

## What is NOT here (on purpose)

* No hard-coded references, owners, topics, or batch ids.
* No live network publication/recovery/postage claims — real publish/update/
  recover/postage reads against Bee are implemented but UNVERIFIED (no Bee
  node reachable in this phase).
* No `^13.x` ranges — exact pins for reproducibility.
* No commits made by setup — review `git status` before committing.
