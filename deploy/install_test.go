package deploy

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

func TestInstallSelectsReleaseTag(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("cloud-init and server installation use Bash on Linux")
	}
	git := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	origin := t.TempDir()
	git(origin, "init", "-b", "main")
	git(origin, "config", "user.name", "Test")
	git(origin, "config", "user.email", "test@example.invalid")
	marker := filepath.Join(origin, "release-marker")
	if err := os.WriteFile(marker, []byte("release"), 0o600); err != nil {
		t.Fatal(err)
	}
	git(origin, "add", "release-marker")
	git(origin, "commit", "-m", "Release")
	git(origin, "tag", "v1.2.3")
	release := git(origin, "rev-parse", "HEAD")
	if err := os.WriteFile(marker, []byte("branch"), 0o600); err != nil {
		t.Fatal(err)
	}
	git(origin, "commit", "-am", "Branch")
	git(origin, "branch", "v1.2.3")
	git(origin, "branch", "v1.2.4") // no release tag for this branch

	read := func(name string) string {
		t.Helper()
		b, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	readme := read("../README.md")
	if strings.Contains(readme, "git clone --branch") {
		t.Fatal("release installation must name the tag explicitly")
	}
	var scripts []string
	for _, block := range regexp.MustCompile("(?ms)^```(?:bash|sh)\\n(.*?)\\n```[ \\t]*$").FindAllStringSubmatch(readme, -1) {
		if start := strings.Index(block[1], "git clone "); start >= 0 && strings.Contains(block[1], "refs/tags/") {
			scripts = append(scripts, block[1][start:])
		}
	}
	if len(scripts) != 3 {
		t.Fatalf("expected the two server installers and the frontend installer, got %d", len(scripts))
	}
	var cloud []string
	for _, line := range strings.Split(read("cloud-init.yaml"), "\n") {
		if line = strings.TrimSpace(line); strings.HasPrefix(line, "git ") {
			cloud = append(cloud, line)
		}
	}
	if len(cloud) != 2 {
		t.Fatalf("expected cloud-init clone and checkout, got %v", cloud)
	}
	scripts = append(scripts, strings.Join(cloud, "\n"))
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'" }
	for i, script := range scripts {
		for _, version := range []string{"v1.2.3", "v1.2.4"} {
			dir := t.TempDir()
			checkout := filepath.Join(dir, "nullbin")
			script := strings.ReplaceAll(script, "https://github.com/jacobzymet/nullbin-go.git", quote(origin))
			script = strings.ReplaceAll(script, "/opt/nullbin", quote(checkout))
			script = strings.ReplaceAll(script, "v1.2.3", version)
			// The setup examples enter deploy/ after checkout.
			script = strings.ReplaceAll(script, "cd nullbin/deploy", "cd nullbin")
			cmd := exec.Command("bash", "-euc", "VERSION="+version+"; version=$VERSION\n"+script)
			cmd.Dir = dir
			out, err := cmd.CombinedOutput()
			if version == "v1.2.4" {
				if err == nil {
					t.Fatalf("installer %d accepted a branch without a release tag", i)
				}
				if _, err := os.Stat(filepath.Join(checkout, "release-marker")); !os.IsNotExist(err) {
					t.Fatalf("installer %d checked out files without a release tag", i)
				}
				continue
			}
			if err != nil {
				t.Fatalf("installer %d: %v\n%s", i, err, out)
			}
			if got := git(checkout, "rev-parse", "HEAD"); got != release {
				t.Fatalf("installer %d selected %s instead of release %s", i, got, release)
			}
			if err := exec.Command("git", "-C", checkout, "symbolic-ref", "-q", "HEAD").Run(); err == nil {
				t.Fatalf("installer %d did not detach HEAD", i)
			}
		}
	}
}
