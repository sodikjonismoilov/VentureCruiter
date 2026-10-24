# Working on Cypher

## Start from the canonical app

Use `sodikjonismoilov/VentureCruiter`, with `main` as the integration branch. Create a focused branch from current main and keep unrelated changes out of the PR. Preserve other contributors' uncommitted work. Do not force-push or replace production with an older checkout.

Cypher has one production app and one existing persistent PostgreSQL. A local fixture, feature worktree, or review deployment must not replace that runtime or its account grants. See the [release guide](deployment/release-gate.md) before changing deployment configuration.

## Develop and test

Frontend dependencies and checks:

```sh
cd frontend
npm ci
node --test tests/*.test.mjs
npm run build
```

For Python development, use Python 3.12 or later and an isolated virtual environment. From the repository root:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e ./backend pytest pytest-asyncio
```

Follow [SETUP.md](SETUP.md) for backend/database configuration and choose backend tests appropriate to the change. Run tests from `backend/` with the virtual environment's Python. Tests requiring PostgreSQL or external accounts need their documented isolated prerequisites; never point disposable test suites at production.

The credential-free release checks run from the repository root:

```sh
node --test scripts/release-smoke.test.mjs
```

## Keep the interface honest

- Follow the current reference design and preserve keyboard, mobile, dark appearance, and reduced-motion behavior.
- Use actual task, account, and source data. Keep synthetic fixtures visibly separate from live evidence.
- Preserve the original brand asset and existing authentication, consent, encryption, and tenant boundaries.
- Distinguish configured, connected, discovered, and execution-tested states. An email draft is not a sent message; an outreach plan is not a booked meeting.
- Keep technical setup under advanced controls where possible, with plain-language recovery actions.

## Submit and release

Open one focused PR against `main`, explaining the resulting behavior and relevant validation. Coordinate ownership when another branch touches the same files. Preserve useful unfinished work rather than deleting or silently overwriting it.

The designated release owner combines approved changes in one clean checkout and uses [the release gate](deployment/release-gate.md). UI changes must keep the current backend, worker, voice, database, and provider flows intact. Do not create a competing production project, rewrite environment settings from a local file, or move aliases independently.

The [legacy-work index](docs/LEGACY_WORK.md) records proposals from the former repository. New implementation and review belong here.
