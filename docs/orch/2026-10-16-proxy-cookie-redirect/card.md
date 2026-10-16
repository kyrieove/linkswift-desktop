# proxy-cookie-redirect — proxyRequest carries session cookies, follows redirects, returns finalUrl

## Goal
`proxyRequest` in `src/main/job.js` (a) sends the `persist:linkswift` session's cookies for each hop's URL (merged with any caller-given `Cookie` header, caller wins on same name), (b) writes every response `Set-Cookie` back into that session, (c) follows 3xx up to 10 hops, (d) returns `finalUrl` (fragment preserved). `tools/probe/check-proxy.js` (run with electron) asserts all of this and exits 0.

## Risk
medium

## Parameters
- Max redirect hops: 10.
- 301/302/303: next hop is GET, no body, drop Content-Length/Content-Type. 307/308: keep method and body.
- A `Location` whose resolved URL contains a `#` fragment (e.g. `http://x/login_success#access_token=abc&`): do NOT request it; return `{ status: 200, finalUrl: <that URL verbatim, fragment kept>, text: '' }` with ok true.
- Return object keeps existing fields (`ok,status,statusText,text,headers`) and adds `finalUrl` (string; equals the request url when no redirect).
- Existing 30 s timeout per hop stays.
- Keep native `https.request`/`http.request` (do not use fetch or electron net).
- Test partition name: Use an in-memory partition `check-proxy` (no `persist:` prefix) so no disk state is left.

## Files
may change: `src/main/job.js`, `src/main/main.js`, `tools/probe/check-proxy.js` (new), `package.json` / read-only: `src/preload/`, `src/shared/`, `DESIGN.md`, `docs/plans/`

## Steps (N = 5)
1. `src/main/job.js` → `proxyRequest`: new signature `proxyRequest({ url, method, headers, body }, ses)` where `ses` is an Electron `Session` (may be undefined: then behave as today, no cookie handling). Refactor the body into a loop: `hop()` does one request and resolves `{statusCode, statusMessage, rawHeaders, setCookie: string[], buffer}`; the outer async function loops up to 10 hops.
2. Cookie send: before each hop, if `ses`, `const jar = await ses.cookies.get({ url: current })`; build map name→value from jar; then parse caller `Cookie` header (split on `;`, first `=`), caller values override same name; join as `a=b; c=d`; set as `Cookie` header only when non-empty (header name case-insensitive: delete any existing `cookie`/`Cookie` key before setting).
3. Set-Cookie write-back: after each hop, for every `set-cookie` entry (`response.headers['set-cookie']`), parse `name=value` plus `Domain`, `Path`, `Expires`/`Max-Age`, `Secure`, `HttpOnly`; call `await ses.cookies.set({ url: current, name, value, domain (only if Domain attr present), path (default: omit), secure, httpOnly, expirationDate (only if Expires/Max-Age present) })`. Wrap each in try/catch and skip silently on failure.
4. Redirect: if status in 301,302,303,307,308 and `location` header exists: `const next = new URL(location, current)`. If `next.hash` is non-empty → return the final-fragment result per Parameters. Else continue loop with next url (method/body rules per Parameters; 10 hops exceeded → reject Error('重定向过多')). Final result includes `finalUrl: current.href` for the last hop (for fragment case, `next.href`). Wire the session: `Job` constructor takes `session` option, stored as `this.session`; `JobManager.submit` passes `session: session.fromPartition(this.partition)` (import `session` from electron at the top of job.js); `Job.handleHttp`-style call at job.js ~line 332 passes `this.session` as second arg. Check `src/main/main.js` needs no change (JobManager already has `partition`); only touch it if required. The preload relay `netdisk-preload.js` already forwards the whole command object, so `finalUrl` reaches the page; do not edit preload files.
5. `tools/probe/check-proxy.js` (new, runs under `electron tools/probe/check-proxy.js`, uses `node:assert`, no test framework): `app.whenReady()` → start a local `http` server with routes: `/echo` (replies JSON of received `cookie` header and sets `Set-Cookie: sid=new; Path=/`), `/r1` (302 → `/echo`), `/frag` (302 → `http://127.0.0.1:<port>/login_success#access_token=abc&`), `/post307` (307 → `/echo`). Use `session.fromPartition('check-proxy')`; seed `seed=1` for `http://127.0.0.1:<port>`. Assert: (1) request to `/echo` sends `seed=1`; (2) caller `Cookie: seed=9` overrides to `seed=9` while another session cookie is still sent; (3) after (1) session has cookie `sid=new`; (4) `/r1` → status 200, `finalUrl` ends with `/echo`; (5) `/frag` → `finalUrl` includes `access_token=abc`, status 200; (6) `/post307` with method POST body `x=1` reaches `/echo` still POST (have `/echo` also return `method`). Print `check-proxy OK` and `app.exit(0)`; on any failure print the error and `app.exit(1)`. Add script `"probe:proxy": "electron tools/probe/check-proxy.js"` to `package.json`.

## Check
`npx electron tools/probe/check-proxy.js`

## Expect
Check fails before the change (file absent / no finalUrl).

## Don't
- No commits, no other files, no refactors beyond the steps.
- Run scripts in the foreground and wait; before replying, stop any background task still running.
- Reuse existing functions; don't copy existing logic.
- No rm, no git push, no git checkout . / restore . / reset --hard.

## Acceptance
- verdict: accepted
- files: package.json, src/main/job.js, tools/probe/check-proxy.js
- check: `npx electron tools/probe/check-proxy.js` → exit 0 (run by run-card)
- tokens:
  - round 1: exec gemini-3.8-flash-high: fresh 164k, cached 2910k, out 52k  (agy-proxy-cookie-redirect.jsonl) · review gpt-6-luna: fresh 59k, cached 370k, out 1k  (codex-review-proxy-cookie-redirect.jsonl)
- review findings: 0 real / 2 false positive / 0 missed (medium, gpt-6-luna); finding 1: callerCookie is captured at job.js:197 before the delete, and check-proxy asserts the override; finding 2 refutes itself
- claude fix: none needed (review_fail was false positives)
- deferred: parseSetCookie hand parsing (P3)
