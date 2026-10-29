# NX Studio + OpenMontage integration (isolated development)

NX Studio remains the product name. OpenMontage is the proposed external video-production engine, not a replacement for the existing NX Image/GPU/backend stack.

Source: https://github.com/calesthio/OpenMontage
License: AGPL-3.0 (review obligations, especially before any network-served modified version).
Pinned upstream SHA: `e01dbf433f46eeb91d39bf905e194162921019a3`.

## Current status
The repository contains a bootstrap and doctor only. It **does not** yet expose OpenMontage through the NX Studio authenticated API, ship an Android APK, perform a real render, or establish a cloud installation.

The source checkout lives under `.nx/openmontage` (ignored by Git). No unreviewed dependency runs until `--setup` is invoked explicitly.

## Local development
Prerequisites: Git, Python 3.10+, compatible Node/npm, ffmpeg, make, sufficient disk space.
Run from NX Studio repo root:

```bash
node integrations/openmontage/engine.mjs --doctor
node integrations/openmontage/engine.mjs --fetch
node integrations/openmontage/engine.mjs --doctor
# Inspect fetched source and its AGPL license first.
node integrations/openmontage/engine.mjs --setup
# For local-only inspection after setup:
node integrations/openmontage/engine.mjs --backlot
```

These steps fetch third-party source and optionally install Python/npm packages. They do **not** provision servers or authorize billable APIs. Backlot is localhost-only and not a mobile-ready NX interface.

## Integration gates before release
1. Review the upstream commit, dependency supply chain and AGPL-3.0 obligations.
2. Test preflight without billable providers, then render a freely sourced short test with a measured budget of zero.
3. Define an authenticated adapter between NX Studio jobs and OpenMontage pipeline/checkpoint outputs.
4. Import final MP4 and provenance into NX Studio media/library; allow cancel, retry and visible failures.
5. Scope projects/asset access per user. No public Backlot port and no secrets in client bundles.
6. Validate mobile responsive layout and exported video on a real Galaxy S25+.
7. Obtain explicit approval for any paid provider, public publication or production deployment.

These gates are not yet passed. Existing NX Studio functionality must keep working.
