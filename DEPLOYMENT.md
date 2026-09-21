# Deployment

simple timeline runs on the single-node minikube cluster on the Fedora host
(`kisimita@192.168.1.35`), built by the in-cluster Jenkins and served through
ingress-nginx behind the Cloudflare tunnel.

Conventions come from `~/Documents/Projects/k8s/k8s-deployment-standards.md` on
that host. This document records what was applied and why.

## Shape

```
GitHub (main)
   │  Jenkins job "simple_timeline" (Pipeline script from SCM → jenkins/Jenkinsfile)
   ▼
docker build  ──►  minikube docker daemon (tcp://192.168.49.2:2376)
   │                 image: simple-timeline:latest
   │  kubectl rollout restart (ServiceAccount, RBAC-limited)
   ▼
Deployment simple-timeline (ns: simple-timeline)  ──►  PVC simple-timeline-data (1Gi)
   ▲
ingress-nginx  ◄──  cloudflared tunnel  ◄──  https://timeline.kisimita.xyz
```

There is **no image registry**. Jenkins builds straight onto the daemon the
cluster pulls from, so `docker build` doubles as the image load — the same
approach as `secure_media`.

## What lives where

| Path | Purpose |
|---|---|
| `Dockerfile` | Two-stage build; runs typecheck + tests + client build |
| `jenkins/Jenkinsfile` | The pipeline. Source of truth — the job reads it from the branch |
| `deploy/simple-timeline.yaml` | Namespace, PVC, Deployment, Service, Ingress |
| `deploy/simple-timeline-netpol.yaml` | default-deny + DNS + ingress-nginx allow |
| `deploy/jenkins-simple-timeline-rbac.yaml` | Role/RoleBinding for the deploy step |
| `setup-jenkins-job.sh` | Installs the job and the minikube docker certs |

On the Fedora host, `~/Documents/Projects/k8s/simple_timeline/` holds a clone of
this repo under `gitsource/` with `deploy/`, `jenkins/` and the setup script
symlinked to it, mirroring the `secure_media` layout. The netpol and RBAC files
are also copied into `k8s-patches/` so the restore script can apply them.

## First-time setup (already done)

```bash
# on the Fedora host
cd ~/Documents/Projects/k8s
kubectl apply -f simple_timeline/deploy/simple-timeline.yaml
kubectl label namespace simple-timeline kubernetes.io/metadata.name=simple-timeline --overwrite
kubectl apply -f k8s-patches/simple-timeline-netpol.yaml
kubectl apply -f k8s-patches/jenkins-simple-timeline-rbac.yaml
cd simple_timeline && ./setup-jenkins-job.sh
```

### ingress-nginx must be told about the new namespace

Not obvious from the standards doc, and it will cost an hour if missed:
`k8s-patches/ingress-nginx-netpol.yaml` carries a **default-deny egress** policy
on the controller with an explicit allowlist of backend namespaces. A new service
is unreachable — nginx logs `upstream timed out`, the client sees a 504 — until
its namespace and port are added there:

```yaml
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: simple-timeline
      ports:
        - port: 8080
          protocol: TCP
```

## Deploying a change

Push to `main`, then **Build Now** on the `simple_timeline` job. The pipeline
checks out, builds (failing on a typecheck or test error before anything reaches
the cluster), rollout-restarts the deployment and smoke-tests the public URL.

Because the job reads `jenkins/Jenkinsfile` from the branch, changing the
pipeline is an ordinary commit — no need to re-run `setup-jenkins-job.sh`.

## After `minikube delete`

`restore-after-minikube-recreate.sh` step `[6d]` rebuilds the image and reapplies
everything. Two things it cannot bring back:

- **The PVC, and with it `timeline.db`.** Back it up first:
  ```bash
  kubectl -n simple-timeline exec deploy/simple-timeline -- \
    cat /app/data/timeline.db > timeline-backup.db
  ```
- **The minikube docker TLS certs in jenkins_home**, which rotate. Re-run
  `setup-jenkins-job.sh` (safe: the job is SCM-backed, so this cannot revert the
  pipeline the way the inline `secure_media` job did).

## Security posture

Applied per the standards: own namespace, default-deny NetworkPolicy with only
DNS egress and ingress-nginx ingress, non-root pod (UID 1000, all capabilities
dropped, `RuntimeDefault` seccomp), resource requests and limits, and a Jenkins
ServiceAccount that can patch exactly one deployment in one namespace and nothing
else. No secrets are needed — the app has no credentials of its own.

**The application itself has no authentication.** Anyone who can reach
`https://timeline.kisimita.xyz` has full create, edit and delete access to every
team's timeline. That was accepted deliberately when choosing public exposure.
Two ways to close it without touching the app:

- a Cloudflare Access policy on the hostname (Zero Trust → Access → Applications), or
- moving the ingress to a LAN-only host, as `secure-media-lan` does with `enclave.lan`.

## Operations

```bash
kubectl -n simple-timeline get pods
kubectl -n simple-timeline logs deploy/simple-timeline -f
kubectl -n simple-timeline rollout restart deployment/simple-timeline

# health, without leaving the host
kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 18080:80 &
curl -H 'Host: timeline.kisimita.xyz' http://127.0.0.1:18080/api/readyz
```

The host cannot curl the ingress on the node IP directly — traffic reaches
ingress-nginx through the cloudflared pod. Use the port-forward above to test
in-cluster routing.
