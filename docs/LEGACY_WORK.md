# Legacy work and repository history

Current Cypher development and releases use [sodikjonismoilov/VentureCruiter](https://github.com/sodikjonismoilov/VentureCruiter), branch `main`. The app is [cypher-agent.vercel.app](https://cypher-agent.vercel.app).

[HIveAppDeveloper/open-grokbot](https://github.com/HIveAppDeveloper/open-grokbot) is the former Cypher development repository. Its history and branches retain earlier work; they are not another production app or release source. The original upstream project and MIT attribution remain separate from the current canonical app.

## Proposals opened in the former repository

These links preserve review context. They describe proposed work, not a guarantee that every feature is implemented or live. Before continuing a proposal, compare it with current canonical main and create only the missing focused change here.

| Former PR | Subject |
| --- | --- |
| [#26](https://github.com/HIveAppDeveloper/open-grokbot/pull/26) | Vercel Speed Insights monitoring |
| [#25](https://github.com/HIveAppDeveloper/open-grokbot/pull/25) | Cypher UI and backend integration |
| [#16](https://github.com/HIveAppDeveloper/open-grokbot/pull/16) | Website-first, persisted public-source prospecting |
| [#11](https://github.com/HIveAppDeveloper/open-grokbot/pull/11) | Territory Pulse prospecting demo |
| [#6](https://github.com/HIveAppDeveloper/open-grokbot/pull/6) | Website connections, media links, and outreach proposals |
| [#5](https://github.com/HIveAppDeveloper/open-grokbot/pull/5) | Earlier desktop/mobile/login review evidence |

The older Territory Pulse documentation in [CIPHER.md](CIPHER.md) is historical. The current `/cipher` route redirects to the workspace; the supported company research and VC screens are `/prospecting` and `/prospecting/investors`.

## Branch policy

`main` is the integration source. Keep unfinished feature branches while their work is under review. After a change is integrated and its remaining work is accounted for, close the superseded PR and remove the merged branch through the normal review process. Keep old commits and release evidence available; branch names alone do not establish what is deployed.
