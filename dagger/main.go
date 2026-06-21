package main

import (
	"context"
	"fmt"
	"strings"

	"dagger/talkd/internal/dagger"
)

const (
	workdir  = "/src"
	bunImage = "oven/bun:1.3.8-debian"
	goImage  = "golang:1.24-bookworm"
)

var sourceExcludes = []string{
	".git",
	".turbo",
	"**/.turbo",
	"node_modules",
	"**/node_modules",
	"talkd-service/bin",
	".talkd",
	"sherpa-models",
	"kokoro-en",
	"kokoro.cpp",
	"whisper.cpp",
	"go-kokoro",
	"go-sherpa-stt",
	"*.wav",
	"*.pcm",
	"whisper-output*.txt",
	"stt-test*.txt",
}

// Talkd defines the distribution CI pipeline for the Talkd monorepo.
type Talkd struct{}

// Check runs TypeScript checks for the Pi package and Go tests for the service.
func (m *Talkd) Check(ctx context.Context, source *dagger.Directory) (string, error) {
	pi, err := m.PiCheck(ctx, source)
	if err != nil {
		return pi, err
	}
	service, err := m.ServiceCheck(ctx, source)
	if err != nil {
		return pi + service, err
	}
	return pi + service + "check completed\n", nil
}

// Build builds the Pi package and Linux service/client binaries.
func (m *Talkd) Build(ctx context.Context, source *dagger.Directory) (string, error) {
	pi, err := m.PiBuild(ctx, source)
	if err != nil {
		return pi, err
	}
	service, err := m.ServiceBuild(ctx, source)
	if err != nil {
		return pi + service, err
	}
	return pi + service + "build completed\n", nil
}

// Test runs the repository test suite. The Pi package currently has no test script;
// service tests cover the Go STT/TTS protocol/service code.
func (m *Talkd) Test(ctx context.Context, source *dagger.Directory) (string, error) {
	out, err := m.ServiceTest(ctx, source)
	if err != nil {
		return out, err
	}
	return out + "test completed\n", nil
}

// Ci runs the distribution gate: checks, builds, and static distribution validation.
func (m *Talkd) Ci(ctx context.Context, source *dagger.Directory) (string, error) {
	var b strings.Builder
	for _, step := range []struct {
		name string
		run  func(context.Context, *dagger.Directory) (string, error)
	}{
		{"check", m.Check},
		{"build", m.Build},
		{"validate-distribution", m.ValidateDistribution},
	} {
		b.WriteString(fmt.Sprintf("==> %s\n", step.name))
		out, err := step.run(ctx, source)
		b.WriteString(out)
		if err != nil {
			return b.String(), err
		}
	}
	b.WriteString("ci completed\n")
	return b.String(), nil
}

// PiCheck runs the TypeScript no-emit check for @talkd/pi-voice.
func (m *Talkd) PiCheck(ctx context.Context, source *dagger.Directory) (string, error) {
	return bunDeps(source).
		WithExec([]string{"bun", "--cwd", "packages/pi-voice", "run", "check"}).
		WithExec([]string{"bash", "-lc", "echo pi check completed"}).
		Stdout(ctx)
}

// PiBuild builds @talkd/pi-voice with tsc.
func (m *Talkd) PiBuild(ctx context.Context, source *dagger.Directory) (string, error) {
	return bunDeps(source).
		WithExec([]string{"bun", "--cwd", "packages/pi-voice", "run", "build"}).
		WithExec([]string{"bash", "-lc", "echo pi build completed"}).
		Stdout(ctx)
}

// ServiceCheck runs go test ./... for the service. It is equivalent to the service check script.
func (m *Talkd) ServiceCheck(ctx context.Context, source *dagger.Directory) (string, error) {
	return serviceBase(source).
		WithExec([]string{"go", "test", "./..."}).
		WithExec([]string{"bash", "-lc", "echo service check completed"}).
		Stdout(ctx)
}

// ServiceTest runs go test ./... for the service test suite.
func (m *Talkd) ServiceTest(ctx context.Context, source *dagger.Directory) (string, error) {
	return serviceBase(source).
		WithExec([]string{"go", "test", "./..."}).
		WithExec([]string{"bash", "-lc", "echo service test completed"}).
		Stdout(ctx)
}

// ServiceBuild builds Linux talkd-service and talkd-client binaries.
func (m *Talkd) ServiceBuild(ctx context.Context, source *dagger.Directory) (string, error) {
	return serviceBuild(source).
		WithExec([]string{"bash", "-lc", "test -x bin/talkd-service && test -x bin/talkd-client && echo service build completed"}).
		Stdout(ctx)
}

// ServiceBinaries returns the Linux service/client binaries built by the Dagger pipeline.
// Export with: dagger call service-binaries --source=. export --path ./dist/service
func (m *Talkd) ServiceBinaries(source *dagger.Directory) *dagger.Directory {
	return serviceBuild(source).Directory("/src/talkd-service/bin")
}

// ValidateDistribution runs static checks for the source distribution surface.
func (m *Talkd) ValidateDistribution(ctx context.Context, source *dagger.Directory) (string, error) {
	return sourceBase(source, bunImage).
		WithExec([]string{"bash", "-lc", distributionValidationScript}).
		Stdout(ctx)
}

func bunDeps(source *dagger.Directory) *dagger.Container {
	return sourceBase(source, bunImage).
		WithEnvVariable("TALKD_PI_VOICE_SKIP_SETUP", "1").
		WithMountedCache("/root/.bun/install/cache", dag.CacheVolume("talkd-bun-install-cache")).
		WithExec([]string{"bun", "install", "--frozen-lockfile"})
}

func serviceBase(source *dagger.Directory) *dagger.Container {
	return sourceBase(source, goImage).
		WithMountedCache("/go/pkg/mod", dag.CacheVolume("talkd-go-mod-cache")).
		WithMountedCache("/root/.cache/go-build", dag.CacheVolume("talkd-go-build-cache")).
		WithWorkdir("/src/talkd-service")
}

func serviceBuild(source *dagger.Directory) *dagger.Container {
	return serviceBase(source).
		WithExec([]string{"go", "build", "-o", "bin/talkd-service", "./cmd/talkd-service"}).
		WithExec([]string{"go", "build", "-o", "bin/talkd-client", "./cmd/talkd-client"})
}

func sourceBase(source *dagger.Directory, image string) *dagger.Container {
	return dag.Container().
		From(image).
		WithDirectory(workdir, source, dagger.ContainerWithDirectoryOpts{Exclude: sourceExcludes}).
		WithWorkdir(workdir)
}

const distributionValidationScript = `set -euo pipefail

for path in \
  packages/pi-voice/src/index.ts \
  packages/pi-voice/src/voice-controller.ts \
  packages/pi-voice/src/voice-agent.ts \
  packages/pi-voice/src/side-agent-skill.ts \
  packages/pi-voice/side-agent-skills/talkd-side-agent-voice-copilot/SKILL.md \
  packages/pi-voice/skills/talkd-voice-copilot/SKILL.md \
  talkd-service/cmd/talkd-service/main.go \
  talkd-service/internal/speech/engine.go \
  scripts/install-runtime.sh \
  scripts/install-binary.sh; do
  test -f "$path"
done

for stale in go-kokoro go-sherpa-stt kokoro.cpp whisper.cpp sherpa-models kokoro-en packages/pi-voice/src/runtime-guidance.ts packages/pi-voice/src/voice-overlay.ts talkd-service/internal/audio; do
  test ! -e "$stale"
done

bash -n scripts/install-runtime.sh
bash -n scripts/install-binary.sh
bash -n packages/pi-voice/scripts/setup-talkd-runtime.sh

if grep -R -n -E 'runtime-guidance|TALKD_RUNTIME|VoiceOverlay|startRawAudioInput|RawAudioInputHandle|internal/audio' README.md packages/pi-voice talkd-service scripts; then
  echo "stale runtime/distribution reference found" >&2
  exit 1
fi

bun -e '
const fs = require("fs");
const root = JSON.parse(fs.readFileSync("package.json", "utf8"));
const pi = JSON.parse(fs.readFileSync("packages/pi-voice/package.json", "utf8"));
if (!root.scripts["dagger:ci"] || !root.scripts.ci) throw new Error("missing Dagger root scripts");
if (!pi.pi || !Array.isArray(pi.pi.extensions) || !pi.pi.extensions.includes("./src/index.ts")) throw new Error("missing Pi extension entry");
if (!Array.isArray(pi.pi.skills) || !pi.pi.skills.includes("./skills")) throw new Error("missing Pi skill entry");
'

echo distribution validation completed
`
