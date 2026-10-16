VERDICT: FAIL

- [P1] `src/main/job.js:206` — With a session, the code deletes the caller’s `Cookie` header before saving it. The later merge reads `callerCookie`, which remains `null`, so caller cookies are dropped and cannot override jar values. Capture the caller header before this deletion (or use the already captured value); the code only assigns `callerCookie` inside `if (headers)` at line 197, but `currentHeaders` is separately copied at line 193 and then deleted at line 206.
- [P1] `src/main/job.js:280` — A redirect to a URL with a fragment returns status 200 even if the redirect response has a different status. The card requires the fragment result to have status 200, so this matches the requested behavior.

Bloat: `parseSetCookie` reimplements cookie parsing that Electron’s cookie APIs otherwise handle; confirm whether manual parsing is needed for the required attributes.

Pre-existing problems: `docs/orch/2026-10-16-proxy-cookie-redirect/card.md` and `probe-readme.md` were already modified before this task; I found no further changes in them.