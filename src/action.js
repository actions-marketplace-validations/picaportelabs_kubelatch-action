// The kubelatch GitHub Action: it exchanges the job's GitHub Actions OIDC
// token for a short-lived kubelatch credential and writes its kubeconfig. It
// does what the two curl steps of the kubelatch manual do, with no
// dependency: Node's own http, https, tls and fs, and the runner's file
// commands (GITHUB_ENV, GITHUB_OUTPUT).
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';

export const EXCHANGE_PATH = '/v1/ci/github-actions/token';
export const TROUBLESHOOTING = 'https://docs.kubelatch.com/use/github-actions/#if-something-fails';
const USER_AGENT = 'kubelatch-action';
const TIMEOUT_MS = 30_000;
const ID_TOKEN_ATTEMPTS = 3;

// ActionError is a failure the person who runs the workflow can act on: its
// message becomes the step's error as it is.
export class ActionError extends Error {}

// audience turns the url input into kubelatch's base URL, normalised as the
// server normalises KUBELATCH_BASE_URL: lower-case scheme and host, no
// default port, no trailing slash. It is the OIDC token's audience and the
// base of the exchange. Plain http is accepted for a loopback address alone.
export function audience(raw) {
  const value = (raw ?? '').trim();
  if (value === '') {
    throw new ActionError('the input url is required: the URL of your kubelatch, its KUBELATCH_BASE_URL');
  }
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new ActionError(`url is not an absolute URL: ${value}`);
  }
  if (u.username || u.password || u.search || u.hash) {
    throw new ActionError('url must not carry user info, a query or a fragment');
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname))) {
    throw new ActionError(`url must be https, since kubelatch answers with a credential (got ${u.protocol}//${u.host})`);
  }
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname);
}

// trustedCAs is what a curl on the runner trusts: Node's bundled CAs and
// NODE_EXTRA_CA_CERTS, plus the system's store, where a self-hosted runner
// keeps its organisation's CA. Undefined leaves Node's defaults.
let cas;
function trustedCAs() {
  if (cas === undefined) {
    try {
      cas = [...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])];
    } catch {
      cas = null;
    }
  }
  return cas ?? undefined;
}

// proxyEnv is the part of the environment Node's built-in proxy support
// reads: HTTPS_PROXY, HTTP_PROXY and NO_PROXY, in either case.
function proxyEnv(env) {
  const out = {};
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']) {
    if (env[name]) out[name] = env[name];
  }
  return out;
}

// request sends one HTTP request and resolves to its status and body as text.
export function request(url, { method = 'GET', headers = {}, body, env = {} } = {}) {
  const u = new URL(url);
  const secure = u.protocol === 'https:';
  const mod = secure ? https : http;
  const agent = new mod.Agent({ proxyEnv: proxyEnv(env), ...(secure ? { ca: trustedCAs() } : {}) });
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method, headers: { 'User-Agent': USER_AGENT, ...headers }, agent, timeout: TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', (err) => {
        agent.destroy();
        reject(err);
      });
      res.on('end', () => {
        agent.destroy();
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`no answer in ${TIMEOUT_MS / 1000} seconds`)));
    req.on('error', (err) => {
      agent.destroy();
      reject(err);
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// describe names a network error the way a person can look it up: the
// system or TLS code first (ENOTFOUND, SELF_SIGNED_CERT_IN_CHAIN...).
function describe(err) {
  const code = err?.code ?? err?.cause?.code;
  const message = err?.message ?? String(err);
  return code && !message.includes(code) ? `${code}: ${message}` : message;
}

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// requestIDToken asks GitHub for the job's OIDC token with kubelatch's URL
// as its audience. GitHub's endpoint fails now and then: a network error, a
// 429 or a 5xx is tried again, up to three times.
export async function requestIDToken(env, aud, sleep = wait) {
  const endpoint = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!endpoint || !bearer) {
    throw new ActionError('this job cannot ask GitHub for an OIDC token: give the workflow or the job the permission `id-token: write`');
  }
  const u = new URL(endpoint);
  u.searchParams.set('audience', aud);
  let last;
  for (let attempt = 1; attempt <= ID_TOKEN_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await request(u.toString(), { headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' }, env });
    } catch (err) {
      last = new ActionError(`could not ask GitHub for an OIDC token: ${describe(err)}`);
    }
    if (res?.status === 200) {
      const value = parseJSON(res.body)?.value;
      if (typeof value !== 'string' || value === '') {
        throw new ActionError('GitHub answered the OIDC token request without a token');
      }
      return value;
    }
    if (res) {
      last = new ActionError(`GitHub answered the OIDC token request with ${res.status}`);
      if (res.status !== 429 && res.status < 500) throw last;
    }
    if (attempt < ID_TOKEN_ATTEMPTS) await sleep(attempt * 1000);
  }
  throw last;
}

// exchange trades the OIDC token for a credential at kubelatch. It is tried
// once: kubelatch accepts each token once, so a second try after an answer
// that got lost would be refused anyway.
export async function exchange(base, idToken, env) {
  let res;
  try {
    res = await request(base + EXCHANGE_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token: idToken }),
      env,
    });
  } catch (err) {
    throw new ActionError(
      `could not reach kubelatch at ${base}: ${describe(err)}. The runner must reach it over https, with a certificate it trusts. See ${TROUBLESHOOTING}`,
    );
  }
  const body = parseJSON(res.body);
  if (res.status === 201) {
    if (typeof body?.token !== 'string' || body.token === '' || typeof body?.kubeconfig !== 'string' || body.kubeconfig === '') {
      throw new ActionError(`${base} answered 201 without a credential: is url your kubelatch?`);
    }
    return body;
  }
  const said = typeof body?.error === 'string' ? body.error : res.body.trim().slice(0, 300);
  let message;
  switch (res.status) {
    case 401:
      message = `kubelatch refused the token (401 ${said}): url must be exactly your kubelatch's KUBELATCH_BASE_URL, which is the token's audience`;
      break;
    case 403:
      message = `kubelatch answered 403: ${said}`;
      break;
    case 404:
      message = `${base} has no CI exchange (404): is url your kubelatch?`;
      break;
    case 429:
      message = `kubelatch answered 429 (${said}): too many exchanges from this runner's address; run the job again in a minute`;
      break;
    default:
      message = `kubelatch answered ${res.status}: ${said}`;
  }
  throw new ActionError(`${message}. See ${TROUBLESHOOTING}`);
}

// writeKubeconfig writes the kubeconfig into a directory of its own under
// RUNNER_TEMP, which the runner empties after the job, readable by this
// job's user alone. Never ~/.kube/config.
export function writeKubeconfig(env, kubeconfig) {
  const dir = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'kubelatch-'));
  const path = join(dir, 'kubeconfig');
  writeFileSync(path, kubeconfig, { mode: 0o600, flag: 'wx' });
  return path;
}

// escapeData escapes a workflow command's data, so text that came from a
// server can neither end the command nor start another.
export function escapeData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function mask(out, secret) {
  if (/[\r\n]/.test(secret)) throw new ActionError('refusing to mask a value with a line break');
  out.write(`::add-mask::${secret}\n`);
}

// fileCommand appends NAME=VALUE to one of the runner's command files, with
// a random delimiter as the runner's own toolkit does.
function fileCommand(file, name, value) {
  const delimiter = `ghadelimiter_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, 'utf8');
}

// run is the whole action. Nothing is printed before both secrets are masked.
export async function run(env, out, { sleep = wait } = {}) {
  const base = audience(env.INPUT_URL);
  for (const name of ['GITHUB_ENV', 'GITHUB_OUTPUT']) {
    if (!env[name]) throw new ActionError(`the runner set no ${name}: run this action as a step of a GitHub Actions job`);
  }
  const idToken = await requestIDToken(env, base, sleep);
  mask(out, idToken);
  const answer = await exchange(base, idToken, env);
  mask(out, answer.token);

  const path = writeKubeconfig(env, answer.kubeconfig);
  const clusters = Array.isArray(answer.clusters) ? answer.clusters.map(String) : [];
  const expiresAt = typeof answer.expires_at === 'string' ? answer.expires_at : '';
  fileCommand(env.GITHUB_ENV, 'KUBECONFIG', path);
  fileCommand(env.GITHUB_OUTPUT, 'kubeconfig', path);
  fileCommand(env.GITHUB_OUTPUT, 'expires-at', expiresAt);
  fileCommand(env.GITHUB_OUTPUT, 'clusters', JSON.stringify(clusters));
  const n = clusters.length === 1 ? '1 cluster' : `${clusters.length} clusters`;
  out.write(`kubelatch credential for ${n}, expires at ${expiresAt || 'an unknown time'}; KUBECONFIG=${path}\n`);
}
