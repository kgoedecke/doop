# Gemini subscription cloud pilot

This prototype runs the official Gemini CLI in a separate cloud container for each pilot user.
Users can close their browser or laptop while a canvas task runs. Google login and refresh remain
inside Gemini CLI; Doop does not implement Google's OAuth flow, read Google tokens, or call the
Code Assist backend directly. No Gemini API key is needed.

The first PR uses the CLI's documented **headless JSON mode**, rather than ACP. The existing
resident task queue supplies the prompt and system instructions. A temporary MCP endpoint exposes
only that run's canvas tools, including screenshots. Canvas mutations and tool-driven status updates
use Doop's existing realtime channel; assistant text is collected at completion, not streamed.

This is an operator-managed pilot, disabled unless `DOOP_GEMINI_CLOUD_WORKERS` is set. It does not
include a browser terminal, a self-service Connect button, automatic worker provisioning, durable
job recovery, or a model picker. The CLI selects its default model according to the signed-in
account's access. Repository imports and subscription-backed image generation are outside this pilot.
Repository import requests return HTTP 409 before connection analysis, task metering or card creation.
The operator must remove pilot enrollment before the user can select a provider for those imports.

## Architecture

```text
Doop resident queue -> assigned user's worker POST /runs -> official Gemini CLI
         ^                                                   |
         +-------- /gemini-cloud/mcp/<run-id> <----------------+
                   short-lived canvas capability
```

- The operator maps a Doop user ID to a worker origin and a random worker secret. The mapping
  takes precedence over local Claude and connected API accounts for that pilot user. Other users
  keep their existing routing. Worker failures never fall back to a separately billed provider.
- The worker accepts one job at a time; concurrent jobs fail as busy and can be retried. Each job
  gets a fresh temporary directory, system prompt, and MCP configuration. No conversation is resumed
  between jobs. The persistent volume holds only that human's CLI state.
- Gemini's built-in filesystem/shell tools, hooks, skills, extensions and subagents are disabled for
  task execution. Only the run's Doop MCP server is allowed, and its tools are trusted for unattended
  execution. This configuration is an additional restriction, not a replacement for container isolation.
- Doop checks the run capability, canvas membership, pilot enrollment and account ban on tool
  requests, including immediately before queued tool execution. Tools execute serially. Completion
  revokes the capability and waits for already-running tool calls to settle.
- The worker kills the CLI after 29 minutes, on dispatcher disconnect, or after 1 MB of stdout.
  The dispatcher expires the capability after 30 minutes. There are no automatic HTTP job retries:
  edits may have completed before a connection failed.
- Free task credits are not consumed for pilot users. This does not mean unlimited Gemini usage:
  the account's model access and quotas still apply.

## Start one worker

Build from the repository root:

```sh
docker build -f workers/gemini/Dockerfile -t doop-gemini-pilot .
```

The image pins `@google/gemini-cli` to `0.61.0` and runs as the unprivileged `node` user. Create a
dedicated volume per user. On the cloud host, create a private env file, outside version control:

```dotenv
GEMINI_WORKER_TOKEN=<at-least-32-random-characters>
DOOP_ORIGIN=https://your-doop.example
```

Generate the worker secret with `openssl rand -hex 32`. Restrict the env file to its owner
(`chmod 600 /secure/gemini-alice.env`). `DOOP_ORIGIN` must reach the Doop server process that owns
the resident run; it cannot contain a path, query, credentials, or fragment.

```sh
docker volume create doop-gemini-alice
docker run -d --name doop-gemini-alice --init --restart unless-stopped \
  --env-file /secure/gemini-alice.env \
  --mount source=doop-gemini-alice,target=/home/node/.gemini \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory 2g --cpus 2 --pids-limit 128 \
  -p 127.0.0.1:4401:4401 doop-gemini-pilot
```

That port binding is for a Doop dispatcher on the same host. For separate hosts, use a private
network or authenticated HTTPS ingress and configure the worker URL accordingly. Do not expose
unencrypted bearer tokens to the public internet. Do not mount application data, the Docker socket,
or another user's home directory. Keep worker credentials on encrypted storage with restricted
backups. Workers need outbound access to Google and the configured Doop origin.

## Sign in and enroll the pilot user

Before enabling routing, the account owner uses a secure interactive terminal on the cloud host:

```sh
docker exec -it -w /tmp -e NO_BROWSER=true doop-gemini-alice gemini
```

Choose Google sign-in, open the CLI's authorization URL in the owner's browser, and paste Google's
authorization code into the CLI terminal. Exit the CLI after successful sign-in. Do not paste
tokens or authentication output into logs, issues, or PRs. This manual terminal step is the part a
later browser-based onboarding flow would replace.

Set the following secret on the **Doop server**, using the user's actual Doop ID and the worker
origin reachable from that server:

```dotenv
DOOP_GEMINI_CLOUD_WORKERS={"<doop-user-id>":{"url":"http://127.0.0.1:4401","token":"<same-worker-secret>"}}
```

Restart Doop, then create a canvas task as that user. The account status identifies the Gemini
cloud pilot. The worker secret only authenticates Doop to the worker; the independently generated
per-run token only authenticates the CLI to one run's canvas tools. Neither is a Google credential.
Add further users with separate workers, volumes, URLs and secrets; duplicate URLs or secrets are
rejected. Browser requests cannot supply worker destinations or change this mapping.

## Verification before promoting the draft

Automated tests use real HTTP/MCP transports and a fake CLI subprocess to verify authentication,
tool scope, image results, access revocation, concurrency, cancellation, output bounds, cleanup,
provider routing and metering. They do **not** establish that a live Google account works.

Complete this manual smoke test with an eligible account on the pinned CLI version:

1. Build and start the worker; sign in interactively without an API key.
2. Submit a small canvas-editing task and verify the edit and screenshot review complete.
3. Close the user's browser during a second task and verify it still finishes.
4. Restart the worker, preserving the volume; submit another task without signing in again.
5. Revoke canvas access during a task and verify subsequent tools are denied.
6. Stop the worker during a task; verify the task reports failure without invoking an API provider.

`/healthz` checks process liveness only, not Google sign-in or available quota. Failed sign-in/quota
runs return a generic error and never copy CLI stderr into shared logs or canvas summaries. Use an
owner-operated interactive CLI session to diagnose authentication failures. The worker must not run
unrelated CLI tasks or install extensions into the credential volume.

An application restart loses active run capabilities; a worker restart interrupts its current job.
Neither resumes the task automatically. Scale the dispatcher as a single process for this pilot,
consistent with the resident queue's in-memory ownership. Configure any intervening proxies to allow
the 30-minute dispatcher request and MCP calls. A failed run may have made partial canvas edits.

To disconnect, remove the user from `DOOP_GEMINI_CLOUD_WORKERS`, restart Doop, stop/remove their
worker, and remove their dedicated credential volume/backups. Revoke the CLI's Google access in
the account as appropriate. The normal account picker does not override this operator-managed
pilot mapping; remove enrollment to restore normal provider selection.

## Provider support boundary

Technical feasibility does not establish approval for this hosted, multi-user product. Confirm the
intended service arrangement with Google before public rollout. Google's published policy explicitly
prohibits third-party software directly accessing the backend using Gemini CLI OAuth. This prototype
uses the unmodified CLI's documented interfaces and leaves its authentication inside that process.

- [Gemini CLI authentication](https://geminicli.com/docs/get-started/authentication/)
- [Headless execution](https://geminicli.com/docs/cli/headless/)
- [MCP configuration](https://geminicli.com/docs/tools/mcp-server/)
- [Configuration reference](https://geminicli.com/docs/reference/configuration/)
- [Terms and privacy](https://geminicli.com/docs/resources/tos-privacy/)

After the smoke test and provider confirmation, follow-up work can add browser onboarding, worker
provisioning and deletion, durable jobs, explicit user provider selection, and ACP event streaming.
