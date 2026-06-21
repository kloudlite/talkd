# Talkd Dagger workflow

This directory contains the Go SDK implementation for the Talkd distribution pipeline.

## Commands

From the repository root:

```bash
bun run ci                 # check + build + distribution validation
bun run dagger:check
bun run dagger:build
bun run dagger:test
bun run dagger:validate
```

Export Linux service/client binaries:

```bash
dagger call service-binaries --source=. export --path ./dist/service
```

## What runs in Dagger

- `PiCheck`: `bun --cwd packages/pi-voice run check`
- `PiBuild`: `bun --cwd packages/pi-voice run build`
- `ServiceCheck`: `go test ./...` in `talkd-service`
- `ServiceTest`: same Go test command, available as an explicit standalone target
- `ServiceBuild`: Linux container build of `talkd-service` and `talkd-client`
- `ValidateDistribution`: static checks for stale runtime-guidance/overlay leftovers, deleted experimental folders, package metadata, side-agent skills, and installer script syntax

The pipeline sets `TALKD_PI_VOICE_SKIP_SETUP=1` during `bun install` so container checks do not download runtime models or install `~/.talkd` assets.

## Requirements

- Dagger `0.21+`
- Docker or another compatible container engine running locally

## GitHub Actions

The repository workflow at `.github/workflows/ci.yml` runs `bun run ci` on `ubuntu-latest`. It assumes the standard GitHub-hosted Ubuntu runner with Docker available at `/var/run/docker.sock`; Dagger uses that Docker daemon to start its engine container. The workflow installs Dagger CLI `0.21.7` and Bun `1.3.8` before invoking the repository wrapper.

If Dagger fails locally with `Cannot connect to the Docker daemon` or `start engine: failed to run command [docker version]`, start Docker/OrbStack/Colima first, then rerun the command.

If generated Go bindings are missing after a fresh checkout or Dagger upgrade, run:

```bash
dagger develop
```
