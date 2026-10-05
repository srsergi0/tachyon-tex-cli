# Sessions

`background` equals `watch --background`: a detached process with persistent logs and loopback HTTP preview. The parent returns once the server is available, possibly before a PDF exists. Verify `status --json` before claiming success. Foreground `watch` stays attached and exits on Ctrl+C.

Status is an array with `input`, `state`, `pid`, `url`, `output`, `revision`, and `error`. States are `starting`, `compiling`, `ready`, `error`, and `stopped`. Revision increments only on successful builds. Changes during a build trigger another afterward. Failed builds retain the good PDF and show the error.

Use the same input path for `status`, `logs`, and `stop`. Canonical input/main identify a session. Repeating background returns that session. Select a path when multiple sessions exist. The URL works on the machine running the process; no public deployment is implied.

Stop uses a private session control token. Do not kill a PID copied from old status: PIDs are reused. An unavailable endpoint is reported as stopped. Preserve logs for startup failures. Verify shutdown status before claiming the process stopped. Leave previews running when requested; stop temporary verification sessions afterward.
