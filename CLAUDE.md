# CLAUDE.md

Guidance for Claude Code (or any agent) working in this repository.

## What this repo is

SikuliX1 — a computer-vision-based GUI automation tool (image-match screen
elements, then drive them with simulated mouse/keyboard). This repo is an
**archived, read-only mirror**. Active development happens at
[oculix-org/Oculix](https://github.com/oculix-org/Oculix); see `README.md`
for the full heritage/lineage notes. Don't assume feature requests or
modern-Java work belongs here — confirm with the user whether a change
should actually target this mirror or the active fork.

## Layout

Maven multi-module project, aggregator `pom.xml` at the root:

- `API/` (`com.sikulix:sikulixapi`) — the core library: screen capture,
  image matching (OpenCV via `org.openpnp:opencv`), OCR (`tess4j`), native
  input/hotkeys (JNA, `jnativehook`, `jkeymaster`, `rococoa` on macOS,
  `jxgrabkey` on Linux), a Python bridge (`py4j`). Source under
  `API/src/main/java/org/sikuli/{script,basics,support,guide,hotkey,natives,util}`.
- `IDE/` (`com.sikulix:sikulixide`) — the script editor/runner, depends on
  `API`. Embeds Jython and (optionally) JRuby as scripting languages, plus
  an Undertow-based HTTP server for remote script execution
  (`org.sikuli.support.runner.SikulixServer`). Source under
  `IDE/src/main/java/org/sikuli/{ide,script,support,basics}`.
- `Support/` — packaging assets, build templates, archived docs.
- `pages/` — GitHub Pages site source (sikulix.com-style landing page).

## Build

```bash
mvn -pl API compile          # compile API only (matches CI's api-compile.yml)
mvn -pl API package          # build sikulixapi jar
mvn -pl IDE -P complete-lux-jar package -DskipTests   # Linux fat jar
mvn -pl IDE -P complete-win-jar package -DskipTests   # Windows fat jar
mvn -pl IDE -P complete-mac-jar package -DskipTests   # macOS fat jar
```

**Java version note:** `pom.xml`'s `maven-compiler-plugin` config (both
modules) targets Java **11**, and `.java-version` says `11`, but
`CONTRIBUTING.md` tells contributors to use Java **17**. This mismatch is
pre-existing — don't "fix" it by changing one to match the other without
checking which is actually correct for the active toolchain in CI
(`.github/workflows/*.yml` use JDK 11).

## Tests

There are **no automated tests** — no `src/test/` directories in either
module. The only test-shaped artifact is
`IDE/src/main/resources/scripts/testRun`, a manual smoke-test script.
Verifying a change means building the jar and running it, or compiling and
reasoning carefully about the diff — there's no `mvn test` safety net.

## Architecture notes / known gotchas

- `API/src/main/java/org/sikuli/script/Region.java` is a ~4800-line god
  class (geometry, matching, clicking, waiting, event observers all live
  here). Expect unrelated concerns interleaved when reading or editing it.
- `IDE/src/main/java/org/sikuli/support/runner/SikulixServer.java` runs an
  embedded HTTP server for triggering scripts remotely. It binds
  `0.0.0.0` by default (`serverIPdefault`) and the `-x`/`allowedIPs`
  option that's supposed to restrict client IPs is parsed (`makeAllowedIPs`)
  but **never actually checked** before handling a request — it's only
  used for logging (`exchange.getSourceAddress()` at the log call sites).
  In effect, anyone who can reach the port can trigger arbitrary script
  execution with no authentication. This is a real bug, but since this repo
  is a frozen historical mirror, don't silently patch it — flag/confirm
  with the user first, and check whether `oculix-org/Oculix` already
  fixed it upstream.
- Native libraries are extracted from jar resources into an appdata
  "SikulixLibs" folder and loaded with `System.load(...)`
  (`API/src/main/java/org/sikuli/support/Commons.java`) — paths are
  derived from fixed resource names, not user input, so this isn't an
  injection vector.
- Process execution (`org.sikuli.natives.CommandExecutorHelper`,
  `org.sikuli.support.runner.ProcessRunner`) consistently uses array-based
  `ProcessBuilder`/`Runtime.exec` args rather than shell string
  concatenation.
