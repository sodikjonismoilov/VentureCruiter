# Cypher charts — isolated feature handoff

Based on canonical c8c5fea. No deployment, environment or database changes. No shared WIP touched.

## Behavior

A validated create_chart tool renders bar, line, area, scatter and pie charts directly from numeric user data or actual tool output. Demonstration values must use data_origin=illustrative and receive a visible label. Tool-sourced data requires a source. Missing observations stay gaps and empty CSV cells; bar/area zero baselines are explicit and pie values must be nonnegative with positive total. Limits:200points×8series,24barcategories,12piecategories. No network calls, shell, sandbox, arbitrary code/HTML, or file-path input. Rendering runs off the async worker thread.

The output uses the existing durable _attachments contract: inline PNG, accessible SVG (title+description and point labels), spreadsheet-safe CSV. Numeric values are retained in the CSV; formula-like text is quoted. Both PNG and SVG are drawn from one geometry implementation. Inter Latin 400/600 assets derive from the app’s existing Fontsource package, with OFL license included and no runtime download. Unicode text remains in SVG/CSV; PNG font coverage is the bundled Latin subset.

The existing lazy MarkdownContent now renders images only from relative authenticated attachment routes, with alt text/full-size/download controls. Remote, data, script, protocol-relative and encoded escape image URLs remain text. Raw HTML remains disabled. Native audio/MessageBubble/ChatPanel/orchestrator/gateway are untouched.

## Integration required

Registry owner01a16f29 owns the separate narrow registration of create_chart from app.services.tools.charts using CHART_PARAMETERS, inclusion in existing media category (default team uses media), aliases charts/visualization, and replay_safe classification. Do not ship this feature without that registration. The handler returns success and _attachments using existing name/mime/data/disposition keys; existing orchestrator persists files and replaces them with real file URLs. Description/result instructs final answer to embed ![title](returned PNG URL) and link SVG/CSV. No tool from this file can fetch data or invent observations itself.

## Verification

27backendcharttests pass,151frontendtests pass, productionbuild passes (/workspace155kB first-load JS). Tests validate actual PNG/SVG/CSV bytes, missing/negative/zero data, numeric bounds, formula/XML injection, typed limits, and worker responsiveness. Existing voice/recovery tests remain passing. Detector returns[]. Desktop1440×1000 and mobile390×844 actual Next production-build fixture screenshots verify a loaded inline image and all four file links; CSV GET200 preserves values; mobilebody390px/image264px. Fixture data is explicitly illustrative and uses a local backend on3221, never production data. Local font-backed render samples24–38ms exclude model/queue/network time; not a production chat latency claim.

No live inference/tool invocation or production chart claim until registry integration and canonical release owner’s full-stack gate.
