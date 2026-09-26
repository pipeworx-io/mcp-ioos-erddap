interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}


/**
 * Shared client for ERDDAP servers (NOAA's Environmental Research Division
 * Data Access Program).
 *
 * ERDDAP is one wire format spoken by ~100 independent ocean/atmosphere data
 * providers — NOAA CoastWatch, the US IOOS regional associations, PacIOOS,
 * SECOORA, GCOOS and many university nodes. Every one of them serves
 * `GET /erddap/search/index.json?searchFor=`,
 * `GET /erddap/info/{dataset}/index.json`,
 * `GET /erddap/tabledap/{dataset}.json?vars&constraints` and
 * `GET /erddap/griddap/{dataset}.json?var[(time)][(lat)][(lon)]`
 * with the same vocabulary, so the per-pack code is a list of node URLs and
 * nothing else. "Build once, improve everything": a better error message or a
 * row cap lands in every ERDDAP pack at the same time.
 *
 * SELF-CONTAINED ON PURPOSE. `scripts/publish-pack.sh` inlines this file into
 * a pack's standalone npm bundle by stripping its `import` lines and its
 * `export` keywords. A helper that imports from another shared module
 * therefore ships with a dangling identifier that the monorepo typecheck
 * cannot see. So: no imports here, ever — not even from './http.js'.
 *
 * ── Six traps this file exists to absorb, all measured 2026-09-17 ─────────
 *
 * 1. ERDDAP REPORTS "NOTHING FOUND" AS HTTP 404, NOT AS AN EMPTY TABLE.
 *    A search that matches no dataset, and a tabledap query whose constraints
 *    exclude every row, both answer 404 with a plain-text `Error { code=...;
 *    message=... }` block. Read as an HTTP failure that is "the server is
 *    broken"; read as an empty result it is "this data does not exist". It is
 *    neither — it is a well-formed no-match. Worse, the body is NOT JSON, so
 *    a naive `JSON.parse` reports `Unexpected token E` and the caller never
 *    sees what ERDDAP actually said. Every function here parses that block and
 *    returns a structured empty result carrying the upstream's own sentence.
 *
 * 2. AND THAT SENTENCE USUALLY CONTAINS THE ANSWER. ERDDAP's no-match message
 *    names the real range: "No data matches time>=2050-01-01 because the
 *    numeric variable's source min=1970-02-26T20:00:00Z, max=2026-09-17".
 *    That is the single most useful string the server produces, so it is
 *    surfaced verbatim in `note` rather than flattened to "no results".
 *
 * 3. COLUMN ORDER IS EACH NODE'S OWN CHOICE. The search table from
 *    coastwatch.pfeg.noaa.gov carries 17 columns including "Accessible";
 *    coastwatch.noaa.gov's carries 15 and omits it. Indexing `rows[6]` gives
 *    you the title on one node and the ISO-19115 link on the other — a
 *    confident wrong answer, never an error. Everything here indexes by
 *    column NAME.
 *
 * 4. VARIABLE NAMES ARE CASE-SENSITIVE AND FREQUENTLY UPPERCASE. NDBC buoy
 *    data calls water temperature `WTMP`, not `wtmp`; a lowercase request is
 *    a 400 `Unrecognized variable="wtmp"`, which reads to a caller as "this
 *    buoy does not report water temperature". The error path names the info
 *    tool so the next call is the right one.
 *
 * 5. A GRIDDAP POINT CAN SUCCEED AND STILL HAVE NO NUMBER. Ask a regional
 *    ocean model for a point over land and it returns 200, one row, and
 *    `null` in the value column. That is a row count of 1 and a silent zero
 *    (docs/silent-zero-policy.md). `erddapGriddapPoint` reports
 *    `masked: true` and says the point is outside the model's water mask.
 *
 * 6. AN EMPTY `searchFor` IS A 404, NOT "EVERYTHING". ERDDAP refuses a blank
 *    search outright. Callers reach for it to enumerate a node's catalogue and
 *    get an error naming no fix, so `erddapSearch` rejects a blank query up
 *    front with a message that says to pass a subject word.
 */

/** One ERDDAP server. Packs define a small table of these and nothing else. */
interface ErddapNode {
  /** Short id a caller passes to choose this node, e.g. `pacioos`. */
  id: string;
  /**
   * ERDDAP root INCLUDING the `/erddap` path segment and with no trailing
   * slash, e.g. `https://coastwatch.pfeg.noaa.gov/erddap`. Some operators
   * mount ERDDAP at the domain root and some under a prefix, so the full
   * path belongs to the node definition rather than being assembled here.
   */
  baseUrl: string;
  /** Operator name, used verbatim in error text so a failure names its upstream. */
  name: string;
  /** What this node covers, one clause — shown alongside results. */
  coverage: string;
  /** Sent on every request; several nodes 403 a request with no User-Agent. */
  userAgent: string;
}

interface ErddapDatasetSummary {
  dataset_id: string;
  title: string | null;
  summary: string | null;
  institution: string | null;
  /** `griddap`, `tabledap`, or both — which access tool applies to this dataset. */
  protocols: string[];
  info_url: string | null;
  griddap_url: string | null;
  tabledap_url: string | null;
}

interface ErddapVariable {
  name: string;
  data_type: string | null;
  units: string | null;
  long_name: string | null;
  /** True for the axis variables of a griddap dataset (time/latitude/longitude/depth). */
  is_axis: boolean;
}

interface ErddapDatasetInfo {
  dataset_id: string;
  title: string | null;
  summary: string | null;
  institution: string | null;
  cdm_data_type: string | null;
  protocol: 'griddap' | 'tabledap' | 'unknown';
  time_coverage_start: string | null;
  time_coverage_end: string | null;
  license: string | null;
  variables: ErddapVariable[];
  axis_variables: string[];
}

/** An ERDDAP `.json` payload is always `{table:{columnNames,columnTypes,rows}}`. */
interface ErddapTable {
  column_names: string[];
  column_types: string[];
  column_units: (string | null)[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
}

const ERDDAP_TIMEOUT_MS = 45_000;
/** Hard ceiling on rows returned to a caller, whatever they asked for. */
const ERDDAP_MAX_ROWS = 1000;

function erddapTrim(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const s = value.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * ERDDAP's own error block, which arrives as text/plain on 400/404/500:
 *
 *     Error {
 *         code=404;
 *         message="Not Found: Your query produced no matching results. (...)";
 *     }
 *
 * Returns the message with the redundant status prefix removed, or null when
 * the body is not one of these (a proxy's HTML 502, say).
 */
function erddapParseError(body: string): string | null {
  const m = /message\s*=\s*"([\s\S]*?)"\s*;/.exec(body);
  if (!m) return null;
  return m[1]
    .replace(/\\"/g, '"')
    .replace(/^(?:Not Found|Bad Request|Internal Server Error|Unauthorized|Forbidden):\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A no-match from ERDDAP is a 404 whose message says so (trap 1). Anything
 * else on a 404 is a genuinely missing dataset or a wrong path.
 */
function erddapIsNoMatch(message: string): boolean {
  return /produced no matching results|no matching dataset/i.test(message);
}

class ErddapEmpty extends Error {
  /** ERDDAP's own sentence, which usually names the real range (trap 2). */
  readonly upstreamNote: string;
  constructor(upstreamNote: string) {
    super(upstreamNote);
    this.name = 'ErddapEmpty';
    this.upstreamNote = upstreamNote;
  }
}

/**
 * One bounded request returning a parsed ERDDAP table.
 *
 * The Workers runtime puts no ceiling on a bare `fetch`, so an ERDDAP node
 * that accepts the connection and then goes quiet — these are academic
 * servers running large NetCDF reads — would hold the Worker until its own
 * execution budget kills it, and the caller is told "timeout" by nobody in
 * particular. The abort names the node.
 */
async function erddapFetchTable(node: ErddapNode, url: string): Promise<ErddapTable> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ERDDAP_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': node.userAgent, Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const reason = err instanceof Error && err.name === 'AbortError'
      ? `did not answer within ${ERDDAP_TIMEOUT_MS / 1000}s`
      : `could not be reached (${err instanceof Error ? err.message : String(err)})`;
    throw new Error(`${node.name} ERDDAP ${reason}: ${url}`);
  }
  clearTimeout(timer);

  const body = await res.text();

  if (!res.ok) {
    const message = erddapParseError(body);
    if (message && erddapIsNoMatch(message)) throw new ErddapEmpty(message);
    if (message) throw new Error(`${node.name} ERDDAP refused the request: ${message}`);
    throw new Error(
      `${node.name} ERDDAP returned HTTP ${res.status}: ${erddapTrim(body, 300) ?? '(empty body)'}`,
    );
  }

  // A 200 can still carry an error block on some nodes; check before parsing,
  // because JSON.parse on it reports "Unexpected token E" and loses the text.
  if (!body.trimStart().startsWith('{')) {
    const message = erddapParseError(body);
    if (message && erddapIsNoMatch(message)) throw new ErddapEmpty(message);
    throw new Error(
      `${node.name} ERDDAP returned a non-JSON body: ${message ?? erddapTrim(body, 300) ?? '(empty)'}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`${node.name} ERDDAP returned malformed JSON: ${erddapTrim(body, 200)}`);
  }

  const table = (parsed as { table?: Record<string, unknown> } | null)?.table;
  if (!table || !Array.isArray(table.columnNames) || !Array.isArray(table.rows)) {
    throw new Error(`${node.name} ERDDAP returned no table for ${url}`);
  }

  const names = (table.columnNames as unknown[]).map((n) => String(n));
  const types = Array.isArray(table.columnTypes)
    ? (table.columnTypes as unknown[]).map((t) => String(t))
    : names.map(() => 'String');
  const units = Array.isArray(table.columnUnits)
    ? (table.columnUnits as unknown[]).map((u) => (typeof u === 'string' && u ? u : null))
    : names.map(() => null);

  const rows = (table.rows as unknown[]).filter(Array.isArray) as unknown[][];
  return {
    column_names: names,
    column_types: types,
    column_units: units,
    rows,
    row_count: rows.length,
    truncated: false,
  };
}

/** Index a table by column NAME, never by position (trap 3). */
function erddapColumn(table: ErddapTable, name: string): number {
  return table.column_names.indexOf(name);
}

function erddapCell(table: ErddapTable, row: unknown[], name: string): string | null {
  const i = erddapColumn(table, name);
  if (i < 0) return null;
  const v = row[i];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function erddapClampRows(limit: unknown, fallback: number): number {
  const n = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), ERDDAP_MAX_ROWS);
}

// ── search ────────────────────────────────────────────────────────────────

interface ErddapSearchResult {
  node: string;
  node_name: string;
  coverage: string;
  query: string;
  datasets: ErddapDatasetSummary[];
  count: number;
  note?: string;
  source: string;
}

/**
 * Full-text search over a node's dataset catalogue.
 *
 * `protocol` filters to `griddap` (gridded model/satellite fields) or
 * `tabledap` (point/timeseries observations) AFTER the upstream search, since
 * ERDDAP's own `protocol=` filter is only honoured by some versions.
 */
async function erddapSearch(
  node: ErddapNode,
  args: { query?: unknown; limit?: unknown; protocol?: unknown },
): Promise<ErddapSearchResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    // Trap 6: ERDDAP 404s a blank search rather than listing everything.
    throw new Error(
      `${node.name} ERDDAP requires search words — a blank search is rejected by the server, `
      + 'not treated as "list everything". Pass a subject such as "sea surface temperature", '
      + '"salinity", "glider" or "wave height".',
    );
  }
  const protocol = typeof args.protocol === 'string' ? args.protocol.trim().toLowerCase() : '';
  const limit = erddapClampRows(args.limit, 20);

  const url = `${node.baseUrl}/search/index.json?page=1&itemsPerPage=${Math.max(limit * 2, 20)}`
    + `&searchFor=${encodeURIComponent(query)}`;

  let table: ErddapTable;
  try {
    table = await erddapFetchTable(node, url);
  } catch (err) {
    if (err instanceof ErddapEmpty) {
      return {
        node: node.id,
        node_name: node.name,
        coverage: node.coverage,
        query,
        datasets: [],
        count: 0,
        note: `${node.name} has no dataset matching "${query}". ERDDAP said: ${err.upstreamNote} `
          + 'Try a broader subject word — ERDDAP searches dataset titles and summaries, not variable names.',
        source: url,
      };
    }
    throw err;
  }

  const datasets: ErddapDatasetSummary[] = [];
  for (const row of table.rows) {
    const id = erddapCell(table, row, 'Dataset ID');
    if (!id) continue;
    const griddap = erddapCell(table, row, 'griddap');
    const tabledap = erddapCell(table, row, 'tabledap');
    const protocols: string[] = [];
    if (griddap) protocols.push('griddap');
    if (tabledap) protocols.push('tabledap');
    if (protocol && !protocols.includes(protocol)) continue;
    datasets.push({
      dataset_id: id,
      title: erddapTrim(erddapCell(table, row, 'Title'), 300),
      summary: erddapTrim(erddapCell(table, row, 'Summary'), 600),
      institution: erddapCell(table, row, 'Institution'),
      protocols,
      info_url: erddapCell(table, row, 'Info'),
      griddap_url: griddap,
      tabledap_url: tabledap,
    });
    if (datasets.length >= limit) break;
  }

  const note = datasets.length === 0 && protocol
    ? `${node.name} matched datasets for "${query}" but none of them serve ${protocol}. `
      + 'Drop the protocol filter to see what it does serve.'
    : undefined;

  return {
    node: node.id,
    node_name: node.name,
    coverage: node.coverage,
    query,
    datasets,
    count: datasets.length,
    note,
    source: url,
  };
}

// ── info ──────────────────────────────────────────────────────────────────

async function erddapInfo(
  node: ErddapNode,
  datasetId: unknown,
): Promise<ErddapDatasetInfo & { node: string; node_name: string; source: string }> {
  const id = typeof datasetId === 'string' ? datasetId.trim() : '';
  if (!id) throw new Error(`${node.name} ERDDAP needs a dataset id (the "dataset_id" from a search result).`);

  const url = `${node.baseUrl}/info/${encodeURIComponent(id)}/index.json`;
  const table = await erddapFetchTable(node, url);

  const globals: Record<string, string> = {};
  const varTypes = new Map<string, string>();
  const varAttrs = new Map<string, Record<string, string>>();
  const axes: string[] = [];

  for (const row of table.rows) {
    const rowType = erddapCell(table, row, 'Row Type');
    const varName = erddapCell(table, row, 'Variable Name');
    const attrName = erddapCell(table, row, 'Attribute Name');
    const dataType = erddapCell(table, row, 'Data Type');
    const value = erddapCell(table, row, 'Value');
    if (!rowType || !varName) continue;

    if (rowType === 'attribute' && varName === 'NC_GLOBAL' && attrName && value) {
      globals[attrName] = value;
    } else if (rowType === 'variable' || rowType === 'dimension') {
      if (dataType) varTypes.set(varName, dataType);
      // A "dimension" row means a griddap axis. Nothing else distinguishes
      // an axis from a data variable in this payload.
      if (rowType === 'dimension' && !axes.includes(varName)) axes.push(varName);
    } else if (rowType === 'attribute' && attrName && value) {
      const bag = varAttrs.get(varName) ?? {};
      bag[attrName] = value;
      varAttrs.set(varName, bag);
    }
  }

  const variables: ErddapVariable[] = [...varTypes.keys()].map((name) => {
    const attrs = varAttrs.get(name) ?? {};
    return {
      name,
      data_type: varTypes.get(name) ?? null,
      units: attrs.units ?? null,
      long_name: erddapTrim(attrs.long_name ?? attrs.standard_name ?? null, 200),
      is_axis: axes.includes(name),
    };
  });

  const protocol: 'griddap' | 'tabledap' | 'unknown' = axes.length > 0
    ? 'griddap'
    : variables.length > 0 ? 'tabledap' : 'unknown';

  return {
    node: node.id,
    node_name: node.name,
    dataset_id: id,
    title: erddapTrim(globals.title ?? null, 300),
    summary: erddapTrim(globals.summary ?? null, 1200),
    institution: globals.institution ?? null,
    cdm_data_type: globals.cdm_data_type ?? null,
    protocol,
    time_coverage_start: globals.time_coverage_start ?? null,
    time_coverage_end: globals.time_coverage_end ?? null,
    license: erddapTrim(globals.license ?? null, 400),
    variables,
    axis_variables: axes,
    source: url,
  };
}

// ── tabledap ──────────────────────────────────────────────────────────────

interface ErddapRowsResult {
  node: string;
  node_name: string;
  dataset_id: string;
  columns: { name: string; type: string; units: string | null }[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
  note?: string;
  source: string;
}

/**
 * Point/timeseries query against a tabledap dataset.
 *
 * `constraints` are ERDDAP's own comparison strings, e.g.
 * `['time>=2026-09-14', 'station="46012"']`. They are joined with `&` exactly
 * as ERDDAP expects; string values need their own double quotes, which is the
 * server's convention rather than ours.
 */
async function erddapTabledap(
  node: ErddapNode,
  args: {
    dataset?: unknown;
    variables?: unknown;
    constraints?: unknown;
    limit?: unknown;
    infoToolName?: string;
  },
): Promise<ErddapRowsResult> {
  const id = typeof args.dataset === 'string' ? args.dataset.trim() : '';
  if (!id) throw new Error(`${node.name} ERDDAP needs a dataset id (the "dataset_id" from a search result).`);

  const variables = Array.isArray(args.variables)
    ? (args.variables as unknown[]).map((v) => String(v).trim()).filter(Boolean)
    : typeof args.variables === 'string' && args.variables.trim()
      ? args.variables.split(',').map((v) => v.trim()).filter(Boolean)
      : [];
  const constraints = Array.isArray(args.constraints)
    ? (args.constraints as unknown[]).map((c) => String(c).trim()).filter(Boolean)
    : typeof args.constraints === 'string' && args.constraints.trim()
      ? [args.constraints.trim()]
      : [];
  const limit = erddapClampRows(args.limit, 200);

  // ERDDAP's own row cap. Without it a busy buoy returns tens of thousands of
  // rows and the response is trimmed by something downstream that says nothing.
  //
  // THE FIRST `&`-SEGMENT IS POSITIONAL: ERDDAP reads it as the variable list
  // whatever it contains. So when the caller asks for every column, the empty
  // segment has to be KEPT — dropping it slides `orderByLimit(...)` into the
  // variable slot and the server answers `Unrecognized variable=
  // "orderByLimit("5")"`, which reads as a broken dataset rather than a
  // malformed URL. Measured against erddap.ioos.us, 2026-09-17.
  const query = [
    variables.join(','),
    ...constraints.map(erddapEncodeConstraint).filter(Boolean),
    `orderByLimit(%22${limit}%22)`,
  ].join('&');
  const url = `${node.baseUrl}/tabledap/${encodeURIComponent(id)}.json?${query}`;

  let table: ErddapTable;
  try {
    table = await erddapFetchTable(node, url);
  } catch (err) {
    if (err instanceof ErddapEmpty) {
      return {
        node: node.id,
        node_name: node.name,
        dataset_id: id,
        columns: [],
        rows: [],
        row_count: 0,
        truncated: false,
        // Trap 2: ERDDAP's no-match sentence names the real range. Keep it.
        note: `No rows matched. ${node.name} ERDDAP said: ${err.upstreamNote}`,
        source: url,
      };
    }
    // Trap 4: a case-wrong variable is an "Unrecognized variable" 400 that
    // reads as "this dataset has no such measurement".
    if (err instanceof Error && /Unrecognized variable/i.test(err.message)) {
      const hint = args.infoToolName
        ? ` Variable names are case-sensitive and often UPPERCASE (WTMP, not wtmp) — call ${args.infoToolName} on "${id}" for the exact spellings.`
        : ' Variable names are case-sensitive and often UPPERCASE (WTMP, not wtmp).';
      throw new Error(`${err.message}${hint}`);
    }
    throw err;
  }

  return {
    node: node.id,
    node_name: node.name,
    dataset_id: id,
    columns: table.column_names.map((name, i) => ({
      name,
      type: table.column_types[i] ?? 'String',
      units: table.column_units[i] ?? null,
    })),
    rows: table.rows,
    row_count: table.row_count,
    truncated: table.row_count >= limit,
    note: table.row_count >= limit
      ? `Capped at ${limit} rows. Narrow the time constraint or raise "limit" (max ${ERDDAP_MAX_ROWS}).`
      : undefined,
    source: url,
  };
}

/**
 * ERDDAP constraints must keep their operators literal but percent-encode the
 * characters a URL parser would otherwise eat — notably `"` around string
 * values and `+` inside timestamps.
 */
function erddapEncodeConstraint(c: string): string {
  return c
    .replace(/%/g, '%25')
    .replace(/"/g, '%22')
    .replace(/\+/g, '%2B')
    .replace(/ /g, '%20')
    .replace(/#/g, '%23')
    .replace(/&/g, '%26');
}

// ── griddap ───────────────────────────────────────────────────────────────

interface ErddapGridPointResult {
  node: string;
  node_name: string;
  dataset_id: string;
  variable: string;
  columns: { name: string; type: string; units: string | null }[];
  rows: unknown[][];
  row_count: number;
  /** True when every returned row has a null value — a point outside the model domain. */
  masked: boolean;
  note?: string;
  source: string;
}

/**
 * Read one gridded variable at one time/lat/lon (griddap's `[(value)]`
 * coordinate-subset syntax, which ERDDAP snaps to the nearest grid cell).
 *
 * `time` accepts an ISO timestamp or the literal `last`, which ERDDAP
 * resolves to the newest time step — the only way to read "current" without
 * first fetching the axis.
 */
async function erddapGriddapPoint(
  node: ErddapNode,
  args: {
    dataset?: unknown;
    variable?: unknown;
    time?: unknown;
    latitude?: unknown;
    longitude?: unknown;
    depth?: unknown;
    infoToolName?: string;
  },
): Promise<ErddapGridPointResult> {
  const id = typeof args.dataset === 'string' ? args.dataset.trim() : '';
  if (!id) throw new Error(`${node.name} ERDDAP needs a dataset id (the "dataset_id" from a search result).`);
  const variable = typeof args.variable === 'string' ? args.variable.trim() : '';
  if (!variable) {
    const hint = args.infoToolName ? ` Call ${args.infoToolName} on "${id}" to list them.` : '';
    throw new Error(`${node.name} ERDDAP needs a gridded variable name, e.g. "sst" or "analysed_sst".${hint}`);
  }

  const lat = Number(args.latitude);
  const lon = Number(args.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(`${node.name} ERDDAP needs numeric latitude and longitude (decimal degrees).`);
  }
  const time = typeof args.time === 'string' && args.time.trim() ? args.time.trim() : 'last';

  // Axis order in a griddap request is the dataset's own, and it is always
  // time first then (optionally) depth then latitude then longitude.
  const subsets = [`[(${time})]`];
  if (args.depth !== undefined && args.depth !== null && String(args.depth).trim() !== '') {
    subsets.push(`[(${Number(args.depth)})]`);
  }
  subsets.push(`[(${lat})]`, `[(${lon})]`);

  const expr = `${variable}${subsets.join('')}`;
  const url = `${node.baseUrl}/griddap/${encodeURIComponent(id)}.json?`
    + expr.replace(/\[/g, '%5B').replace(/\]/g, '%5D').replace(/ /g, '%20');

  let table: ErddapTable;
  try {
    table = await erddapFetchTable(node, url);
  } catch (err) {
    if (err instanceof ErddapEmpty) {
      return {
        node: node.id,
        node_name: node.name,
        dataset_id: id,
        variable,
        columns: [],
        rows: [],
        row_count: 0,
        masked: false,
        note: `No grid cell matched. ${node.name} ERDDAP said: ${err.upstreamNote}`,
        source: url,
      };
    }
    if (err instanceof Error && /Unrecognized variable|not.*axis/i.test(err.message)) {
      const hint = args.infoToolName
        ? ` Call ${args.infoToolName} on "${id}" for its variable names and axis order (some datasets have a depth axis, which must be supplied).`
        : '';
      throw new Error(`${err.message}${hint}`);
    }
    throw err;
  }

  // Trap 5: 200 + one row + a null value is a point outside the water mask.
  const valueIdx = erddapColumn(table, variable);
  const masked = table.row_count > 0
    && valueIdx >= 0
    && table.rows.every((r) => r[valueIdx] === null || r[valueIdx] === undefined);

  return {
    node: node.id,
    node_name: node.name,
    dataset_id: id,
    variable,
    columns: table.column_names.map((name, i) => ({
      name,
      type: table.column_types[i] ?? 'String',
      units: table.column_units[i] ?? null,
    })),
    rows: table.rows,
    row_count: table.row_count,
    masked,
    note: masked
      ? `The grid cell nearest ${lat}, ${lon} has no value for "${variable}" — for an ocean model that `
        + 'means the point falls on land or outside the model domain, not that the data is missing. '
        + 'Move the point offshore or use a dataset with wider coverage.'
      : undefined,
    source: url,
  };
}

/** Resolve a caller-supplied node id against a pack's table, with a real error. */
function erddapPickNode(
  nodes: readonly ErddapNode[],
  requested: unknown,
  fallbackId: string,
): ErddapNode {
  const want = typeof requested === 'string' && requested.trim()
    ? requested.trim().toLowerCase()
    : fallbackId;
  const found = nodes.find((n) => n.id === want);
  if (found) return found;
  throw new Error(
    `Unknown node "${want}". Available: ${nodes.map((n) => `${n.id} (${n.coverage})`).join('; ')}.`,
  );
}
/**
 * US IOOS — regional ocean observing data via ERDDAP.
 *
 * The Integrated Ocean Observing System is eleven regional associations, each
 * running its own ERDDAP, plus national aggregators for gliders and for the
 * in-situ sensor network. A dataset lives on exactly one of them, so the
 * `node` argument is the first thing a caller has to get right — hence a
 * `coverage` clause on every node and a real error listing them all when the
 * id is wrong.
 *
 * with the NOAA CoastWatch pack.
 */


const UA = 'pipeworx-mcp-ioos-erddap/1.0 (+https://pipeworx.io)';

const NODES: readonly ErddapNode[] = [
  {
    id: 'national',
    baseUrl: 'https://erddap.ioos.us/erddap',
    name: 'IOOS National ERDDAP',
    coverage: 'IOOS-wide inventories, asset and metric datasets',
    userAgent: UA,
  },
  {
    id: 'sensors',
    baseUrl: 'https://erddap.sensors.ioos.us/erddap',
    name: 'IOOS Sensor Map ERDDAP',
    coverage: 'the national in-situ sensor network — buoys, tide gauges, met stations',
    userAgent: UA,
  },
  {
    id: 'gliders',
    baseUrl: 'https://gliders.ioos.us/erddap',
    name: 'IOOS Glider Data Assembly Center',
    coverage: 'every US underwater glider deployment, temperature/salinity profiles',
    userAgent: UA,
  },
  {
    id: 'pacioos',
    baseUrl: 'https://pae-paha.pacioos.hawaii.edu/erddap',
    name: 'PacIOOS (University of Hawaii)',
    coverage: 'Hawaii and the Pacific Islands — ROMS and WRF model grids, reef monitoring',
    userAgent: UA,
  },
  {
    id: 'secoora',
    baseUrl: 'https://erddap.secoora.org/erddap',
    name: 'SECOORA',
    coverage: 'the US Southeast — North Carolina through Florida and the eastern Gulf',
    userAgent: UA,
  },
  {
    id: 'gcoos',
    baseUrl: 'https://erddap.gcoos.org/erddap',
    name: 'GCOOS',
    coverage: 'the Gulf of Mexico',
    userAgent: UA,
  },
];

const NODE_IDS = NODES.map((n) => n.id);
const NODE_ARG = {
  type: 'string' as const,
  enum: NODE_IDS,
  description:
    'Which IOOS ERDDAP to ask. Each regional association holds different datasets and a dataset '
    + 'id from one will not resolve on another. '
    + NODES.map((n) => `"${n.id}" = ${n.coverage}`).join('; ')
    + '. Default "sensors", the national in-situ network.',
};

const tools: McpToolExport['tools'] = [
  {
    name: 'ioos_erddap_search_datasets',
    description:
      'Full-text search a US IOOS regional ERDDAP for ocean observing datasets — buoys, tide '
      + 'gauges, gliders, HF radar currents, water quality, regional ocean model grids. '
      + 'AUTHORITATIVE for what a given IOOS regional association actually publishes and under '
      + 'which dataset id. PREFER OVER WEB SEARCH: IOOS data is scattered across eleven regional '
      + 'servers and web results point at portal pages rather than the live dataset ids the other '
      + 'tools here need. Start with this tool, then pass a dataset_id onward.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Subject words, e.g. "glider", "water temperature", "wave height", "salinity". '
            + 'ERDDAP searches titles and summaries, not variable names, and a blank query is '
            + 'rejected by the server rather than listing everything.',
        },
        protocol: {
          type: 'string',
          enum: ['griddap', 'tabledap'],
          description:
            'Restrict to gridded fields (griddap — model and radar rasters, read with '
            + 'ioos_erddap_griddap_point) or to tables (tabledap — station and glider timeseries, '
            + 'read with ioos_erddap_tabledap). Omit for both.',
        },
        node: NODE_ARG,
        limit: { type: 'number', description: 'Max datasets to return (default 20, max 1000).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'ioos_erddap_dataset_info',
    description:
      'Variable names, units, axes, time coverage and licence for one IOOS ERDDAP dataset. '
      + 'CALL THIS BEFORE QUERYING DATA: ERDDAP variable names are case-sensitive and vary by '
      + 'operator (sea_water_temperature on one node, WTMP on another), and a wrong spelling is an '
      + 'error that reads as "this station does not measure that". Also says whether the dataset is '
      + 'griddap or tabledap and whether it has a depth axis you must supply.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dataset_id: {
          type: 'string',
          description: 'ERDDAP dataset id from ioos_erddap_search_datasets, e.g. "processed_asset_inventory".',
        },
        node: NODE_ARG,
      },
      required: ['dataset_id'],
    },
  },
  {
    name: 'ioos_erddap_tabledap',
    description:
      'Rows from an IOOS tabledap dataset — station timeseries, glider profiles, water quality and '
      + 'asset inventories from a regional ocean observing association. AUTHORITATIVE for observed '
      + 'coastal conditions in US waters: this is the regional association\'s own quality-controlled '
      + 'archive. PREFER OVER WEB SEARCH for any "what did sensor X read" question.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dataset_id: { type: 'string', description: 'Tabledap dataset id from ioos_erddap_search_datasets.' },
        variables: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Columns to return, exactly as ioos_erddap_dataset_info spells them, e.g. '
            + '["time","sea_water_temperature","latitude","longitude"]. Omit for every column.',
        },
        constraints: {
          type: 'array',
          items: { type: 'string' },
          description:
            'ERDDAP constraint expressions, ANDed together. String values need their own double '
            + 'quotes: ["time>=2026-09-01", "station=\\"edu_ucsd_cdip_201\\""].',
        },
        node: NODE_ARG,
        limit: { type: 'number', description: 'Max rows (default 200, max 1000).' },
      },
      required: ['dataset_id'],
    },
  },
  {
    name: 'ioos_erddap_griddap_point',
    description:
      'One gridded value at one time, latitude and longitude from an IOOS regional model or radar '
      + 'grid — ocean temperature, salinity, currents, or WRF atmospheric fields. ERDDAP snaps to '
      + 'the nearest grid cell. AUTHORITATIVE for regional-resolution conditions that a global '
      + 'product misses: PacIOOS ROMS resolves individual Hawaiian channels, which no global grid does.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dataset_id: { type: 'string', description: 'Griddap dataset id, e.g. "roms_hiig" on the pacioos node.' },
        variable: {
          type: 'string',
          description: 'Gridded variable name, e.g. "temp" or "salt". Case-sensitive; see ioos_erddap_dataset_info.',
        },
        time: {
          type: 'string',
          description: 'ISO timestamp, or the literal "last" for the newest available step (default).',
        },
        latitude: { type: 'number', description: 'Decimal degrees north.' },
        longitude: { type: 'number', description: 'Decimal degrees east (negative for the western hemisphere).' },
        depth: {
          type: 'number',
          description:
            'Depth in metres — REQUIRED for 4-D ocean model grids such as PacIOOS ROMS, whose axes '
            + 'are time, depth, latitude, longitude. Omitting it on such a dataset is an axis error.',
        },
        node: NODE_ARG,
      },
      required: ['dataset_id', 'variable', 'latitude', 'longitude'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const node = erddapPickNode(NODES, args.node, 'sensors');
  switch (name) {
    case 'ioos_erddap_search_datasets':
      return erddapSearch(node, { query: args.query, limit: args.limit, protocol: args.protocol });
    case 'ioos_erddap_dataset_info':
      return erddapInfo(node, args.dataset_id);
    case 'ioos_erddap_tabledap':
      return erddapTabledap(node, {
        dataset: args.dataset_id,
        variables: args.variables,
        constraints: args.constraints,
        limit: args.limit,
        infoToolName: 'ioos_erddap_dataset_info',
      });
    case 'ioos_erddap_griddap_point':
      return erddapGriddapPoint(node, {
        dataset: args.dataset_id,
        variable: args.variable,
        time: args.time,
        latitude: args.latitude,
        longitude: args.longitude,
        depth: args.depth,
        infoToolName: 'ioos_erddap_dataset_info',
      });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
