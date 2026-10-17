# kubelatch credentials

A GitHub Action that gives a job a short-lived [kubelatch](https://kubelatch.com) credential and a kubeconfig, with no secret stored in GitHub. It asks GitHub for the job's OIDC token, exchanges it at your kubelatch for a credential of the bot your trust rule names, and points `KUBECONFIG` at the result: `kubectl`, `helm` and the rest of the job reach your clusters through kubelatch, which records every request.

## Usage

```yaml
permissions:
  id-token: write   # lets the job request its OIDC token
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    # environment: prod   # when the trust rule sets an environment
    steps:
      - uses: picaportelabs/kubelatch-action@v1
        with:
          url: https://kubelatch.example.com
      - run: kubectl get pods -n default
```

Before the first run, an administrator of your kubelatch creates a bot with a permission on the cluster you need, and a trust rule that matches this repository: see [CI: trust rules](https://docs.kubelatch.com/operate/ci/). The manual's page [Credentials for GitHub Actions](https://docs.kubelatch.com/use/github-actions/) has the whole walk-through.

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `url` | yes | The URL of your kubelatch, exactly its `KUBELATCH_BASE_URL`: it is the OIDC token's audience. A trailing slash is ignored. |

## Outputs

| Output | Description |
| --- | --- |
| `kubeconfig` | Path of the kubeconfig written for this job. `KUBECONFIG` already points at it. |
| `expires-at` | When the credential expires, in RFC 3339. |
| `clusters` | The ids of the clusters the credential reaches, as a JSON array. |

## What it does

1. It asks GitHub for the job's OIDC token, with `url` as its audience. GitHub's endpoint fails now and then, so a network error, a 429 or a 5xx is tried again, three times at most.
2. It masks that token in the log, and sends it to `<url>/v1/ci/github-actions/token`. kubelatch checks the token and the trust rule, and answers with a credential once: it never accepts the same token twice.
3. It masks the credential before printing anything else.
4. It writes the kubeconfig to a directory of its own under `RUNNER_TEMP`, readable by the job's user alone (the runner empties it after the job), never to `~/.kube/config`, and exports `KUBECONFIG`.

The credential lasts one hour unless your administrator changed it (`KUBELATCH_CI_TOKEN_TTL`); a job that runs longer uses the action again.

The action has no dependencies: two short files of JavaScript on Node 24, [`src/main.js`](src/main.js) and [`src/action.js`](src/action.js), short enough to read before you trust it. Pin it by commit SHA if your policy asks for that.

## Network

The runner must reach kubelatch over https. The action trusts what a `curl` on the runner trusts: the system's certificate store, where a self-hosted runner keeps its organisation's CA, plus Node's own and `NODE_EXTRA_CA_CERTS`. It goes through `HTTPS_PROXY` (kubelatch and GitHub are both https) unless `NO_PROXY` leaves kubelatch out.

## When it fails

The step's error carries kubelatch's own message and a link to [If something fails](https://docs.kubelatch.com/use/github-actions/#if-something-fails). A `403` that no trust rule matches names the owner and repository ids, the ref and the environment a rule must match; a `401` almost always means `url` is not exactly the server's `KUBELATCH_BASE_URL`.

## Versions

`v1` moves with the latest 1.x release; `v1.0.0` and the other full versions never move. Any kubelatch with CI trust rules works with it.

## Support and security

Questions and ideas go to [kubelatch's Discussions](https://github.com/picaportelabs/kubelatch/discussions); a bug of the action, to this repository's issues. Report a vulnerability to `security@kubelatch.com` or through this repository's private vulnerability reporting, never in a public issue: see [SECURITY.md](SECURITY.md).

## License

This action is MIT-licensed. kubelatch itself is proprietary software with a free edition: [kubelatch.com](https://kubelatch.com).
