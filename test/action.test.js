import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ActionError, audience, escapeData, run, TROUBLESHOOTING } from '../src/action.js';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.js');
const ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.id-token-payload.signature';
const TOKEN = 'klt_0123456789abcdefghijklmnopqrstuv';
const KUBECONFIG = `apiVersion: v1\nkind: Config\nusers:\n- name: bot\n  user:\n    token: ${TOKEN}\n`;
const GRANTED = {
  credential: { id: 'cred-1', kind: 'ci' },
  token: TOKEN,
  kubeconfig: KUBECONFIG,
  clusters: ['cluster-a', 'cluster-b'],
  expires_at: '2026-10-17T12:00:00Z',
};

function reply(res, { status, body }) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' });
  res.end(text);
}

// fake serves GitHub's OIDC token endpoint (/oidc) and kubelatch's exchange
// (any path ending in the exchange path) on one loopback port, and records
// what each was asked. oidc is a queue of answers; once empty, a token.
async function fake(t, { oidc = [], exchange = { status: 201, body: GRANTED } } = {}) {
  const seen = { oidc: [], exchange: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const u = new URL(req.url, 'http://fake');
      if (u.pathname === '/oidc') {
        seen.oidc.push({
          authorization: req.headers.authorization,
          audience: u.searchParams.get('audience'),
          apiVersion: u.searchParams.get('api-version'),
        });
        reply(res, oidc.length > 0 ? oidc.shift() : { status: 200, body: { value: ID_TOKEN } });
      } else if (req.method === 'POST' && u.pathname.endsWith('/v1/ci/github-actions/token')) {
        seen.exchange.push({ path: u.pathname, contentType: req.headers['content-type'], body: JSON.parse(body) });
        reply(res, exchange);
      } else {
        reply(res, { status: 404, body: '404 page not found' });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

// job gives a runner's environment: the inputs, the OIDC request variables
// pointing at the fake, empty command files and an empty RUNNER_TEMP.
function job(t, srv, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kubelatch-action-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = { env: join(dir, 'github_env'), output: join(dir, 'github_output'), temp: join(dir, 'runner_temp') };
  writeFileSync(files.env, '');
  writeFileSync(files.output, '');
  mkdirSync(files.temp);
  const env = {
    INPUT_URL: srv.url,
    ACTIONS_ID_TOKEN_REQUEST_URL: `${srv.url}/oidc?api-version=2.0`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-bearer',
    GITHUB_ENV: files.env,
    GITHUB_OUTPUT: files.output,
    RUNNER_TEMP: files.temp,
    ...extra,
  };
  return { env, files };
}

// commands reads a runner command file written as NAME<<DELIMITER blocks.
function commands(file) {
  const text = readFileSync(file, 'utf8');
  const out = {};
  const re = /^([^\n<]+)<<(ghadelimiter_[0-9a-f-]{36})\n([\s\S]*?)\n\2\n/gm;
  let consumed = 0;
  for (const m of text.matchAll(re)) {
    out[m[1]] = m[3];
    consumed += m[0].length;
  }
  assert.equal(consumed, text.length, `${file} holds something besides delimited commands`);
  return out;
}

class Sink {
  text = '';
  write(chunk) {
    this.text += chunk;
    return true;
  }
}

const noSleep = async () => {};

test('audience normalises the url as kubelatch normalises KUBELATCH_BASE_URL', () => {
  const cases = [
    ['https://kubelatch.example.com', 'https://kubelatch.example.com'],
    ['https://kubelatch.example.com/', 'https://kubelatch.example.com'],
    ['  https://Kubelatch.Example.COM//  ', 'https://kubelatch.example.com'],
    ['https://kubelatch.example.com:443/', 'https://kubelatch.example.com'],
    ['https://kubelatch.example.com:8443', 'https://kubelatch.example.com:8443'],
    ['https://example.com/kubelatch/', 'https://example.com/kubelatch'],
    ['http://127.0.0.1:8080/', 'http://127.0.0.1:8080'],
    ['http://localhost:8080', 'http://localhost:8080'],
    ['http://[::1]:8080', 'http://[::1]:8080'],
  ];
  for (const [input, want] of cases) assert.equal(audience(input), want, input);
});

test('audience refuses a url kubelatch could not have as its base URL', () => {
  const cases = [
    ['', /input url is required/],
    [undefined, /input url is required/],
    ['kubelatch.example.com', /not an absolute URL/],
    ['http://kubelatch.example.com', /must be https/],
    ['ftp://kubelatch.example.com', /must be https/],
    ['https://user:pass@kubelatch.example.com', /user info/],
    ['https://kubelatch.example.com/?a=1', /query/],
    ['https://kubelatch.example.com/#x', /fragment/],
  ];
  for (const [input, want] of cases) {
    assert.throws(() => audience(input), (err) => err instanceof ActionError && want.test(err.message), String(input));
  }
});

test('a granted exchange writes the kubeconfig, points KUBECONFIG at it and sets the outputs', async (t) => {
  const srv = await fake(t);
  const { env, files } = job(t, srv, { INPUT_URL: `${srv.url}/` });
  const out = new Sink();
  await run(env, out, { sleep: noSleep });

  assert.deepEqual(srv.seen.oidc, [{ authorization: 'Bearer request-bearer', audience: srv.url, apiVersion: '2.0' }]);
  assert.deepEqual(srv.seen.exchange, [
    { path: '/v1/ci/github-actions/token', contentType: 'application/json', body: { token: ID_TOKEN } },
  ]);

  const exported = commands(files.env);
  assert.deepEqual(Object.keys(exported), ['KUBECONFIG']);
  const path = exported.KUBECONFIG;
  assert.ok(path.startsWith(files.temp), `${path} is not under RUNNER_TEMP`);
  assert.equal(readFileSync(path, 'utf8'), KUBECONFIG);
  if (process.platform !== 'win32') {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  }
  assert.deepEqual(commands(files.output), {
    kubeconfig: path,
    'expires-at': '2026-10-17T12:00:00Z',
    clusters: '["cluster-a","cluster-b"]',
  });
});

test('both secrets are masked before anything else is printed, and never printed otherwise', async (t) => {
  const srv = await fake(t);
  const { env } = job(t, srv);
  const out = new Sink();
  await run(env, out, { sleep: noSleep });

  const lines = out.text.trimEnd().split('\n');
  assert.equal(lines[0], `::add-mask::${ID_TOKEN}`);
  assert.equal(lines[1], `::add-mask::${TOKEN}`);
  for (const line of lines.slice(2)) {
    assert.ok(!line.includes(ID_TOKEN) && !line.includes(TOKEN), `a secret printed unmasked: ${line}`);
  }
  assert.match(lines.at(-1), /^kubelatch credential for 2 clusters, expires at 2026-10-17T12:00:00Z; KUBECONFIG=/);
});

test('a base URL with a path keeps it for the audience and the exchange', async (t) => {
  const srv = await fake(t);
  const { env } = job(t, srv, { INPUT_URL: `${srv.url}/kubelatch/` });
  await run(env, new Sink(), { sleep: noSleep });
  assert.equal(srv.seen.oidc[0].audience, `${srv.url}/kubelatch`);
  assert.equal(srv.seen.exchange[0].path, '/kubelatch/v1/ci/github-actions/token');
});

test('two steps in one job get two kubeconfigs', async (t) => {
  const srv = await fake(t);
  const { env, files } = job(t, srv);
  await run(env, new Sink(), { sleep: noSleep });
  await run(env, new Sink(), { sleep: noSleep });
  assert.equal(readdirSync(files.temp).length, 2);
});

test('without id-token: write the action says so and asks nobody', async (t) => {
  const srv = await fake(t);
  const { env, files } = job(t, srv);
  delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  await assert.rejects(run(env, new Sink(), { sleep: noSleep }), /id-token: write/);
  assert.equal(srv.seen.exchange.length, 0);
  assert.equal(readFileSync(files.env, 'utf8'), '');
});

test('outside a runner the action fails before it spends a token', async (t) => {
  const srv = await fake(t);
  const { env } = job(t, srv);
  delete env.GITHUB_OUTPUT;
  await assert.rejects(run(env, new Sink(), { sleep: noSleep }), /GITHUB_OUTPUT/);
  assert.equal(srv.seen.oidc.length, 0);
});

test('a refused exchange explains itself, links the manual and leaves nothing behind', async (t) => {
  const cases = [
    [{ status: 401, body: { error: 'invalid token', code: 'ci.bad_token' } }, /refused the token \(401 invalid token\): url must be exactly your kubelatch's KUBELATCH_BASE_URL/],
    [
      { status: 403, body: { error: 'no trust rule matches this workflow (repository_owner_id 1, repository_id 2, ref refs/heads/main, environment none)' } },
      /kubelatch answered 403: no trust rule matches this workflow \(repository_owner_id 1, repository_id 2, ref refs\/heads\/main, environment none\)/,
    ],
    [{ status: 429, body: { error: 'too many attempts' } }, /429 \(too many attempts\): too many exchanges/],
    [{ status: 404, body: '404 page not found' }, /has no CI exchange \(404\): is url your kubelatch\?/],
    [{ status: 503, body: { error: 'the CI exchange is not configured' } }, /kubelatch answered 503: the CI exchange is not configured/],
    [{ status: 201, body: { token: '', kubeconfig: '' } }, /answered 201 without a credential/],
  ];
  for (const [answer, want] of cases) {
    const srv = await fake(t, { exchange: answer });
    const { env, files } = job(t, srv);
    await assert.rejects(run(env, new Sink(), { sleep: noSleep }), (err) => {
      assert.ok(err instanceof ActionError);
      assert.match(err.message, want);
      if (answer.status !== 201) assert.ok(err.message.endsWith(`See ${TROUBLESHOOTING}`), err.message);
      return true;
    });
    assert.deepEqual(readdirSync(files.temp), [], `status ${answer.status} left a kubeconfig`);
    assert.equal(readFileSync(files.env, 'utf8'), '');
    assert.equal(readFileSync(files.output, 'utf8'), '');
  }
});

test("GitHub's OIDC endpoint is tried again after a 5xx or a 429, three times at most", async (t) => {
  const srv = await fake(t, { oidc: [{ status: 500, body: 'oops' }, { status: 429, body: 'slow down' }] });
  const { env } = job(t, srv);
  const waits = [];
  await run(env, new Sink(), { sleep: async (ms) => waits.push(ms) });
  assert.equal(srv.seen.oidc.length, 3);
  assert.deepEqual(waits, [1000, 2000]);

  const down = await fake(t, { oidc: [500, 502, 503, 200].map((status) => ({ status, body: 'oops' })) });
  const second = job(t, down);
  await assert.rejects(run(second.env, new Sink(), { sleep: noSleep }), /GitHub answered the OIDC token request with 503/);
  assert.equal(down.seen.oidc.length, 3);
  assert.equal(down.seen.exchange.length, 0);
});

test("GitHub's other refusals are not tried again", async (t) => {
  const srv = await fake(t, { oidc: [{ status: 403, body: 'forbidden' }] });
  const { env } = job(t, srv);
  await assert.rejects(run(env, new Sink(), { sleep: noSleep }), /GitHub answered the OIDC token request with 403/);
  assert.equal(srv.seen.oidc.length, 1);
});

test('an unreachable kubelatch is named, with the network error', async (t) => {
  const srv = await fake(t);
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  const { env } = job(t, srv, { INPUT_URL: `http://127.0.0.1:${port}` });
  await assert.rejects(run(env, new Sink(), { sleep: noSleep }), new RegExp(`could not reach kubelatch at http://127\\.0\\.0\\.1:${port}: .*ECONNREFUSED`));
});

test('requests go through HTTP_PROXY when the runner sets one', async (t) => {
  const srv = await fake(t);
  const proxied = [];
  const proxy = http.createServer((req, res) => {
    proxied.push(req.url);
    const upstream = http.request(req.url, { method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    req.pipe(upstream);
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => proxy.close());
  const { env } = job(t, srv, { HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}` });
  await run(env, new Sink(), { sleep: noSleep });
  assert.deepEqual(
    proxied.map((u) => new URL(u).pathname),
    ['/oidc', '/v1/ci/github-actions/token'],
  );
});

test('escapeData keeps server text from ending a workflow command', () => {
  assert.equal(escapeData('100% done\r\n::set-env name=X::y'), '100%25 done%0D%0A::set-env name=X::y');
});

// spawnMain runs src/main.js as the runner does and resolves to its exit
// code and output. The child keeps this process's environment (Windows needs
// SystemRoot and the like for sockets) minus what the runner running these
// tests sets for its own job, and gets the test's job on top.
function spawnMain(env) {
  const own = Object.entries(process.env).filter(([name]) => !/^(ACTIONS_|GITHUB_|INPUT_|RUNNER_)|_PROXY$/i.test(name));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN], { env: { ...Object.fromEntries(own), ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('main exits 0 when the credential is granted', async (t) => {
  const srv = await fake(t);
  const { env, files } = job(t, srv);
  const { code, stdout } = await spawnMain(env);
  assert.equal(code, 0, stdout);
  assert.ok(commands(files.env).KUBECONFIG);
});

test('main turns a refusal into one escaped error annotation and exit 1', async (t) => {
  const srv = await fake(t, { exchange: { status: 403, body: { error: 'denied\n::set-env name=PWNED::1' } } });
  const { env } = job(t, srv);
  const { code, stdout } = await spawnMain(env);
  assert.equal(code, 1);
  const errors = stdout.split('\n').filter((line) => line.startsWith('::error'));
  assert.equal(errors.length, 1, stdout);
  assert.match(errors[0], /^::error title=kubelatch::kubelatch answered 403: denied%0A::set-env name=PWNED::1\. See /);
  assert.ok(!stdout.split('\n').some((line) => line.startsWith('::set-env')), stdout);
});
