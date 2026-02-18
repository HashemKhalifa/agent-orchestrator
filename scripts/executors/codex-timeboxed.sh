#!/usr/bin/env bash
set -euo pipefail

MODULE_ID="${1:-}"
TITLE="${2:-}"
PART_FILE="${3:-}"
REQUEST_PATH="${4:-}"

if [[ -z "$MODULE_ID" || -z "$PART_FILE" ]]; then
  echo "usage: codex-timeboxed.sh <moduleId> <title> <partFile> <requestPath>" >&2
  exit 2
fi

CODEX_CMD="${ORCHESTRATOR_CODEX_EXECUTABLE:-codex exec --full-auto}"
TIMEOUT_MS="${ORCHESTRATOR_PROVIDER_TIMEOUT_MS:-180000}"
HEARTBEAT_MS="${ORCHESTRATOR_PROVIDER_HEARTBEAT_MS:-10000}"

PROMPT=$(cat <<PROMPT_EOF
DAG module: $MODULE_ID
Title: $TITLE
Request path: $REQUEST_PATH
Part file: $PART_FILE
Execute the requested migration safely. Include commands and validation evidence.
PROMPT_EOF
)

STDOUT_FILE="$(mktemp)"
STDERR_FILE="$(mktemp)"
cleanup() {
  rm -f "$STDOUT_FILE" "$STDERR_FILE"
}
trap cleanup EXIT

STATUS=0
STREAMED_OUTPUT=false
if command -v python3 >/dev/null 2>&1; then
  STREAMED_OUTPUT=true
  set +e
  python3 - "$TIMEOUT_MS" "$HEARTBEAT_MS" "$MODULE_ID" "$CODEX_CMD" "$PROMPT" "$STDOUT_FILE" "$STDERR_FILE" <<'PY'
import os
import shlex
import signal
import subprocess
import sys
import time
import selectors

timeout_ms = int(sys.argv[1])
heartbeat_ms = int(sys.argv[2])
module_id = sys.argv[3]
command = sys.argv[4]
prompt = sys.argv[5]
stdout_path = sys.argv[6]
stderr_path = sys.argv[7]

argv = shlex.split(command) + [prompt]
timeout_s = max(1, timeout_ms) / 1000.0
heartbeat_s = max(0.5, heartbeat_ms / 1000.0)

def write_chunk(stream, file_obj, chunk):
    if not chunk:
        return
    file_obj.write(chunk)
    file_obj.flush()
    stream.buffer.write(chunk)
    stream.buffer.flush()

with open(stdout_path, "wb") as stdout_f:
    with open(stderr_path, "wb") as stderr_f:
        proc = subprocess.Popen(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            preexec_fn=os.setsid,
        )

        for pipe in (proc.stdout, proc.stderr):
            if pipe is None:
                continue
            os.set_blocking(pipe.fileno(), False)

        selector = selectors.DefaultSelector()
        if proc.stdout is not None:
            selector.register(proc.stdout, selectors.EVENT_READ, data=("stdout", stdout_f, sys.stdout))
        if proc.stderr is not None:
            selector.register(proc.stderr, selectors.EVENT_READ, data=("stderr", stderr_f, sys.stderr))

        started = time.monotonic()
        deadline = started + timeout_s
        last_heartbeat = started
        timed_out = False

        while True:
            now = time.monotonic()
            if proc.poll() is not None and len(selector.get_map()) == 0:
                break

            if proc.poll() is None and now >= deadline:
                timed_out = True
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    proc.wait()

            if now - last_heartbeat >= heartbeat_s and proc.poll() is None:
                elapsed_s = int(now - started)
                sys.stderr.write(f"[{module_id}] heartbeat elapsed={elapsed_s}s timeout={int(timeout_s)}s\n")
                sys.stderr.flush()
                last_heartbeat = now

            wait_s = 0.25
            if proc.poll() is None:
                wait_s = max(0.05, min(0.25, deadline - now))
            events = selector.select(timeout=wait_s)

            for key, _ in events:
                pipe = key.fileobj
                kind, file_obj, stream = key.data
                try:
                    chunk = os.read(pipe.fileno(), 4096)
                except BlockingIOError:
                    continue

                if not chunk:
                    selector.unregister(pipe)
                    continue

                write_chunk(stream, file_obj, chunk)

        for pipe, file_obj, stream in (
            (proc.stdout, stdout_f, sys.stdout),
            (proc.stderr, stderr_f, sys.stderr),
        ):
            if pipe is None:
                continue
            while True:
                try:
                    chunk = os.read(pipe.fileno(), 4096)
                except BlockingIOError:
                    break
                if not chunk:
                    break
                write_chunk(stream, file_obj, chunk)

        rc = proc.returncode if not timed_out else 124

sys.exit(rc)
PY
  STATUS="$?"
  set -e
else
  set +e
  # shellcheck disable=SC2086
  $CODEX_CMD "$PROMPT" >"$STDOUT_FILE" 2>"$STDERR_FILE"
  STATUS="$?"
  set -e
fi

if [[ "$STREAMED_OUTPUT" != "true" ]]; then
  cat "$STDOUT_FILE"
  cat "$STDERR_FILE" >&2
fi

if [[ "$STATUS" -eq 124 ]]; then
  echo "provider timeout reached after ${TIMEOUT_MS}ms (codex-timeboxed.sh)" >&2
fi

bash "$(dirname "$0")/emit-token-receipt.sh" "codex" "$STDOUT_FILE" "$STDERR_FILE" || true

exit "$STATUS"
