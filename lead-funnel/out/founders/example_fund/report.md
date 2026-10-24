# Founder shortlist: Example Seed Fund

**Thesis:** Pre-seed and seed AI-native software for regulated industries

Generated 2026-10-24. Sources: SEC Form D, GitHub, Show HN, arXiv, startup websites, Claude.

## Funnel

| Stage | Leads |
|---|---:|
| All leads | 14,642 |
| Startups raising now (Form D, last 2 years, named officers) | 14,487 |
| Builders from GitHub (thesis keywords, recent) | 27 |
| Builders from Show HN (thesis keywords, recent) | 58 |
| Builders from arXiv (thesis keywords, recent) | 59 |
| Companies from akta.pro List Generation | 11 |
| Pass hard filters (recent, stage, founded, on-thesis keywords) | 2,003 |
| Sourced: stage, recency, relevance, traction, founder signals | 1,000 |
| Screened: language match to the thesis | 200 |
| Deep: websites, READMEs, warm paths | 50 |
| Shortlist | 15 |

- akta.pro list: 11 companies, 0 credits this run; 824 usable left this month.
- akta.pro company search (free): 65 lookups for startup websites.
- Websites found for 94 of 134 screened Form D startups.
- Claude Opus 5.5 via Nicrron: judged 50 of 50.
- Pre-round builders on the shortlist: 0 (places are kept only for builders Claude rates fit 3/5 or better; best builder fit this run: 2/5).
- Shown: 4 of 15 shortlisted founders. 11 with Claude fit under 3/5 or a thesis exclusion in Claude's summary are under Also considered.
- Weights: defaults (need 2+ yes and 2+ no labels; have 0 yes, 0 no).

| Feature | Weight |
|---|---:|
| stage_fit | 0.10 |
| recency | 0.10 |
| geo | 0.05 |
| relevance | 0.15 |
| traction | 0.15 |
| founder | 0.10 |
| text_sim | 0.15 |
| warm | 0.05 |
| claude | 0.30 |

## Founders

### 1. Jason Griffith · Undeniable Health AI Inc. · score 0.71

**Raising now** (Form D): Form D: $600K round, 13 investors so far, filed 2026-06-22

**What they build:** AI agents that act as digital billing employees, working healthcare claims end to end from charge entry through denials, appeals and AR follow-up for providers and billing companies.

**Why meet (Claude: fit 4/5, founder 4/5, stage pre-seed):** Undeniable Health builds end-to-end AI billing agents for healthcare revenue cycle teams and leads with HIPAA-by-design, an immutable six-year audit trail and human-in-the-loop autonomy. That matches the fund's belief that compliance is the moat. Both co-founders are repeat founders with stated exits (Alex Poon: x.ai, Visual Revenue; Jason Griffith: SiteCompli, Synco, Tripology), and there is an early customer testimonial from JAG Billing's CEO, which makes this worth a meeting despite thin public traction.

> Every action our AI takes is logged as an immutable event.
> — https://www.undeniablehealth.ai/ (verified)

**Shared beliefs:** Compliance and auditability are the moat in regulated AI, not the model; Small teams shipping weekly beat large early rounds

**Evidence:** team on filings: Jason Griffith, Alex Poon; site https://www.undeniablehealth.ai/ (from akta.pro company search); source https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0002130106.

**Watch out:** No open-source, GitHub or public traction signal; evidence is the company's own website plus a single customer testimonial.; Founders' healthcare depth is adjacent rather than from inside RCM: healthtech engineering leadership and payer consulting, not years running billing operations.; Exits and backgrounds are self-reported on the site and should be verified.; AI revenue cycle and denials management is a crowded category with well-funded competitors.; The agent-first managed service model may carry services-like margins and operational load.; Still in a 90-day pilot phase with a small number of partners; outcome metrics are not yet public.

**Score:** stage_fit 1.00 · recency 0.80 · geo 1.00 · relevance 0.30 · traction 0.87 · founder 0.45 · text_sim 0.97 · warm 0.00 · claude 0.75

`python run.py label co:0002130106 yes "why"` or `python run.py label co:0002130106 no "why"`

### 2. Charles Crawford · Loom Security, Inc. · score 0.67

**Raising now** (Form D): Form D: $4.6M round, 4 investors so far, filed 2026-08-20

**What they build:** CINQUE is a security posture observability layer that sits above existing identity and security tools and correlates their signals into behavioral findings and recommended fixes for human, machine and AI-agent identities.

**Why meet (Claude: fit 3/5, founder 3/5, stage seed):** Loom Security's CINQUE correlates identity, device, network, application and data signals, including baselines for AI agents. It sells into financial services, insurance and healthcare as "observed evidence for the examiner," which touches the fund's auditability belief, but it is a horizontal security platform that also targets manufacturing, energy, rail and retail rather than AI-native workflow software for regulated operators. Charles Crawford is flagged as a repeat founder and the site shows a shipped product with a partner program, so a meeting is worth taking to learn his background and see paying regulated customers.

> Observed evidence for the examiner who asks “show me” rather than “tell me.”
> — https://www.loomsecurity.io/ (verified)

**Shared beliefs:** Compliance and auditability are the moat in regulated AI, not the model

**Evidence:** repeat founder: Charles Crawford; site https://www.loomsecurity.io/ (guessed from the company name; check it is the same company); source https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0002038064.

**Watch out:** Horizontal cybersecurity product: regulated industries are only some of the eight verticals it targets, alongside manufacturing, energy, oil & gas, rail and retail.; No evidence that the founder comes from inside healthcare, insurance or financial services.; No open-source or public traction signal such as GitHub repos, named customers or usage metrics.; A $4.6M round with $3.4M sold is a fairly large seed, which cuts against the small-team, weekly-shipping belief.; Website was guessed from the company name, but its Lawrence, KS address matches the Form D location, so it is likely the same company; still worth confirming.; Little founder detail beyond the repeat-founder flag; the prior company is unknown.

**Score:** stage_fit 1.00 · recency 1.00 · geo 0.40 · relevance 0.30 · traction 0.68 · founder 1.00 · text_sim 0.99 · warm 0.00 · claude 0.50

`python run.py label co:0002038064 yes "why"` or `python run.py label co:0002038064 no "why"`

### 3. Benjamin Finch · WithAI Research, Inc. · score 0.65

**Raising now** (Form D): Form D: $4.0M round, 57 investors so far, filed 2026-07-06

**What they build:** Multiplier is an AI agent platform for asset managers that connects market data, research and portfolio systems into one command center and automates investment research on the firm's own cloud.

**Why meet (Claude: fit 3/5, founder 4/5, stage seed):** The CEO built LLM investment systems at Bridgewater, so this is an insider building AI agents for asset managers, with named CIO and co-founder testimonials and data controls like customer-hosted data and zero-retention inference. The product is pitched as research productivity rather than compliance or auditability, and the $6M seed is already announced, so the fit with the fund's moat thesis and entry stage is only partial.

> All data is hosted on your cloud, not an external provider's.
> — https://www.multiplier.ai/ (verified)

**Shared beliefs:** Founders from inside the industry beat generalists who discover it later

**Evidence:** team on filings: Benjamin Finch, Ian Mcinnis; site https://www.multiplier.ai/ (guessed from the company name; check it is the same company); source https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0002140890.

**Reach:** Ian McInnis

**Watch out:** The website was guessed, but it matches the Form D: the footer reads 'WithAI Research, Inc.' and Ian McInnis and Ben Finch appear on both.; Compliance and auditability are not the core value proposition; the pitch is analyst productivity and edge, with security as a feature.; Asset management research is less paperwork- and regulator-driven than the healthcare, insurance and banking workflows the thesis targets.; The blog announces a $6M seed while the Form D shows $3.98M sold from 57 investors, so the round may be largely closed and past the fund's entry point.; There is no open-source or public technical traction such as GitHub repos or launches; the traction evidence is customer testimonials and a backer list.; The consulting-style 'white-glove service' model may limit scalability.

**Score:** stage_fit 1.00 · recency 0.80 · geo 1.00 · relevance 0.30 · traction 1.00 · founder 0.45 · text_sim 0.73 · warm 0.00 · claude 0.57

`python run.py label co:0002140890 yes "why"` or `python run.py label co:0002140890 no "why"`

### 4. Craig Parker · Navidence, Inc. · score 0.65

**Raising now** (Form D): Form D: $4.5M round, 14 investors so far, filed 2025-12-29

**What they build:** A platform and library of expert-curated Computable Operational Definitions (code lists and phenotype algorithms) that life-sciences research teams use to design real-world evidence studies and assess data fitness in a way regulators accept.

**Why meet (Claude: fit 3/5, founder 4/5, stage seed):** Navidence builds computable, auditable study-design definitions that respond to FDA and ICH requirements for real-world evidence, and the team are deep insiders: Aaron Kamauu ran healthcare data strategy at Roche/Genentech and founded Anolinx, and CTO Craig Parker is an HL7 fellow and repeat founder. They have also shipped a product and signed partnerships with Datavant, Komodo Health, Panalgo, RTI and Trio Health. It is worth a meeting on the compliance and insider beliefs, but the evidence shows a curated knowledge and licensing business more than AI-native software, and there is no open-source or public technical signal.

> FDA guidances in 2021, 2023 and 2024 and ICH M4 guidances in 2025 all outline expectations that data definitions composed of standardized and mapped data elements and phenotype algorithm should be made available for each study design.
> — https://navidence.com (verified)

**Shared beliefs:** Compliance and auditability are the moat in regulated AI, not the model; Founders from inside the industry beat generalists who discover it later

**Evidence:** team on filings: Craig Parker, Aaron Kamauu; repeat founder: Craig Parker; site https://navidence.com (guessed from the company name; check it is the same company); source https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001997962.

**Reach:** Aaron Kamauu

**Watch out:** The AI-native angle is thin: the only AI mention is a Komodo Health partnership headline, and the core product looks like a curated content library and data licensing.; No GitHub, open-source or other public technical traction signal, which the fund treats as its best early signal.; The team is a C-suite of veteran consulting and CRO executives rather than a small, lean technical team shipping weekly.; The round may be largely allocated: $3.0M of $4.5M sold to 14 investors, with Nina Capital and Grand Ventures announced as seed investors.; The website was guessed from the company name, but it lists Craig Parker and Aaron Kamauu as on the Form D and announces a seed raise in January 2026, so it appears to be the same company.

**Score:** stage_fit 1.00 · recency 0.60 · geo 0.40 · relevance 0.30 · traction 0.88 · founder 1.00 · text_sim 0.79 · warm 0.00 · claude 0.57

`python run.py label co:0001997962 yes "why"` or `python run.py label co:0001997962 no "why"`

## Also considered

Shortlisted on score, but Claude rated the fit low or its summary names a thesis exclusion. `python run.py show <lead id>` has the full brief.

- **Andrew Howard · Lockchain Corp.** (`co:0001962104`, score 0.66): matches exclusion: digital assets. An AI-powered risk management, compliance and monitoring platform that helps financial institutions assess and track digital assets, protocols and counterparties.
- **Anders Brown · i2 Health Advisors Inc.** (`co:0002147485`, score 0.64): Claude fit 2/5, below 3. An AI-enabled consulting and system-integration firm that builds and operates automation workflows for health plans (prior auth, claims, risk adjustment, HEDIS, appeals) on top of Snowflake, UiPath, Salesforce and Anthropic.
- **Matthew Broccolo · ShredPay, Inc.** (`co:0002129999`, score 0.63): Claude fit 2/5, below 3; matches exclusion: crypto; matches exclusion: stablecoin. A non-custodial stablecoin and crypto app plus embedded onchain infrastructure for institutions, offering fiat on/off ramps, risk-rated DeFi yield vaults, swaps and USDC payments, with KYC/AML and audit trails built in.
- **Richard Saffir · Kavia AI, Inc.** (`co:0002134925`, score 0.63): Claude fit 2/5, below 3. An enterprise AI platform that builds a knowledge graph of complex codebases to support onboarding, impact analysis, spec generation, code changes, testing and review.
- **Anton Shumskikh · Neo Agent Inc.** (`co:0002152778`, score 0.61): Claude fit 2/5, below 3. An AI agent that works IT service desk tickets end to end for managed service providers, such as onboarding, password resets, triage and alert response, across their PSA, RMM and Microsoft stack, with technician approval and per-tool permissions.
- **Peymon Ghazi · Malcova, Inc** (`co:0002152940`, score 0.60): Claude fit 2/5, below 3. A low-dose Narrow-Beam CT imaging system for early detection of breast cancer in dense tissue and of stroke, supported by digital and physical twins and an AI assistant for radiologists.
- **Herbert Barrack · Limber Prosthetics, Inc.** (`co:0002072119`, score 0.59): Claude fit 2/5, below 3. Limber makes fully 3D-printed, monolithic transtibial prostheses (the Px1) produced through a digital scan-design-fabricate workflow for orthotics and prosthetics clinics.
- **Karim Pourak · ProcessMiner, Inc.** (`co:0002133227`, score 0.58): Claude fit 1/5, below 3. An AI platform that predicts product quality every 30 seconds in continuous-manufacturing plants, ranks root causes of drift and recommends or automates setpoint corrections.
- **Adolfo Velazquez · ROSE DIAGNOSTICS INC.** (`co:0002027716`, score 0.57): Claude fit 1/5, below 3. A portable 5-minute rapid diagnostic test and reader that tells clinicians during a lung biopsy whether the collected specimen is sufficient for analysis.
- **Derek Harn · COUNT Financial, Inc.** (`co:0002153764`, score 0.57): Claude fit 2/5, below 3. Unknown: the Form D describes only a 2024 Washington technology company named COUNT Financial, Inc., with no product details.
- **Shara Cohen · Carallel, Inc.** (`co:0001955339`, score 0.57): Claude fit 2/5, below 3. Carallel identifies family caregivers among health plan members, patients and employees and supports them through trained Care Advocates and a companion app.
