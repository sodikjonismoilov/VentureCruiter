# Cypher

Describe what you want to accomplish. Cypher coordinates AI models, connected apps, and background work in one workspace.

**[Open Cypher](https://cypher-agent.vercel.app)** · **[Development guide](CONTRIBUTING.md)** · **[Release guide](deployment/release-gate.md)**

## One app, one source

| Item | Canonical location |
| --- | --- |
| Source | [sodikjonismoilov/VentureCruiter](https://github.com/sodikjonismoilov/VentureCruiter) |
| Integration branch | `main` |
| Production app | [cypher-agent.vercel.app](https://cypher-agent.vercel.app) |
| Legacy app address | [open-grokbot.vercel.app](https://open-grokbot.vercel.app), kept on the same release |
| Deployment | Existing Vercel project `cypher`, using the repository-root `vercel.json` |
| Persistent state | The existing shared production PostgreSQL, used by both API and worker |

Feature branches are review work for this app. They are not separate production products. The former Open GrokBot repository and its outstanding proposals are indexed in [Legacy work](docs/LEGACY_WORK.md).

## What Cypher does

- Runs persistent tasks and conversations with automatic or manual model selection.
- Supports voice, files, media analysis, and image generation where the connected provider supports them.
- Connects apps through supported sign-in, API-key, and hosted MCP flows, with explicit access and readiness states.
- Runs background goals and scheduled routines; keeps reusable context and task instructions.
- Researches companies and SEC founder/investor records, with source links and outreach drafts for review.

App login, a saved connection, discovered tools, and a successful tool call are separate states. Research does not establish a verified contact, sent message, or booked meeting. Provider access, quotas, and billing depend on the connected account. The five-stage VC journey is a product direction, not evidence that automatic outreach and scheduling are implemented.

## Run the frontend locally

```sh
git clone https://github.com/sodikjonismoilov/VentureCruiter.git
cd VentureCruiter/frontend
npm ci
npm run dev
```

Open `http://localhost:3000`. This starts the frontend only. A working app also needs a configured backend, PostgreSQL, worker, and the required model/account access. `BACKEND_INTERNAL_URL` stays server-side; without a reachable backend, the interface shows connection recovery.

See [SETUP.md](SETUP.md) and [.env.example](.env.example) for the full environment. The Base44 development compose file additionally expects its managed `/run/base44/app.env`; it is not a universal local quick start. Keep disposable test fixtures separate from production data.

## Validate a change

```sh
cd frontend
node --test tests/*.test.mjs
npm run build
```

From the repository root, run the credential-free release-contract tests:

```sh
node --test scripts/release-smoke.test.mjs
```

Backend checks and environment setup are described in [CONTRIBUTING.md](CONTRIBUTING.md). CI passing does not certify a deployed backend, account grant, or worker.

## Release the whole app

Use one clean canonical checkout and the root `vercel.json`, which defines the Next.js frontend, private Python backend binding, and persistent worker. Integrate reviewed work once, then use the [exact-candidate release gate](deployment/release-gate.md).

The release owner stages the production build, checks the exact candidate, activates it, and verifies API/worker release parity and fresh persistent state on both app addresses. Preserve the existing PostgreSQL and account grants. A frontend-only deployment or Vercel READY status does not complete this process.

Public [health](https://cypher-agent.vercel.app/api/health) and [release identity](https://cypher-agent.vercel.app/api/release) are available for inspection. Runtime, conversation, and connected-account routes require the appropriate session.

## Repository map

| Path | Purpose |
| --- | --- |
| `frontend/` | Next.js interface and same-origin server routes |
| `backend/` | FastAPI, persistent state, agent execution, and worker |
| `deployment/` and `scripts/` | Release checks and operational instructions |
| `docs/` | Feature contracts and historical context |
| `verification/` | Explicitly isolated test fixtures and verification guidance |
| `lead-funnel/` | Preserved standalone founder/investor research CLI; see its own [README](lead-funnel/README.md) |

Cypher includes work derived from [Open GrokBot](https://github.com/ishandutta2007/open-grokbot). The original MIT copyright and license remain in [LICENSE](LICENSE).
