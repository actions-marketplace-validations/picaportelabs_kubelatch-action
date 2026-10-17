// A stand-in for kubelatch's CI exchange, for the self-test job of
// .github/workflows/test.yml: it accepts an id_token that GitHub issued for
// its own URL and answers with a kubeconfig, as kubelatch would. It checks
// the claims the action is responsible for (issuer, audience, repository),
// not the signature: kubelatch does that, and this job tests the action.
//   node tools/fake-kubelatch.js PORT_FILE
// writes the port it listens on to PORT_FILE and serves until killed.
import { writeFileSync } from 'node:fs';
import http from 'node:http';

const ISSUER = 'https://token.actions.githubusercontent.com';

function claims(jwt) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) throw new Error('not a JWT');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const answer = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.method !== 'POST' || req.url !== '/v1/ci/github-actions/token') return answer(404, { error: 'not found' });
    let c;
    try {
      c = claims(JSON.parse(body).token);
    } catch (err) {
      return answer(401, { error: `invalid token: ${err.message}` });
    }
    if (c.iss !== ISSUER) return answer(401, { error: `invalid token: issuer ${c.iss}` });
    if (c.aud !== base) return answer(401, { error: `invalid token: audience ${c.aud}, want ${base}` });
    if (c.repository !== process.env.GITHUB_REPOSITORY) return answer(403, { error: `repository ${c.repository}` });
    const token = `klt_selftest${Date.now()}`;
    answer(201, {
      credential: { id: 'self-test', kind: 'ci' },
      token,
      kubeconfig: `apiVersion: v1\nkind: Config\nclusters:\n- name: self-test\n  cluster:\n    server: ${base}/clusters/self-test\ncontexts:\n- name: self-test\n  context:\n    cluster: self-test\n    user: self-test\ncurrent-context: self-test\nusers:\n- name: self-test\n  user:\n    token: ${token}\n`,
      clusters: ['self-test'],
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
  });
});

server.listen(0, '127.0.0.1', () => writeFileSync(process.argv[2], String(server.address().port)));
