#!/usr/bin/env bash
# Install/refresh the `simple_timeline` Jenkins pipeline job on the in-cluster
# Jenkins (jenkins namespace, jenkins_home = ~/jenkins-data).
#
# Does three things:
#   1. Copies minikube's docker TLS client certs into jenkins_home so the
#      pipeline can build on tcp://192.168.49.2:2376.
#      >>> Re-run this script after every `minikube delete` — certs rotate. <<<
#   2. Generates the job config.xml from jenkins/Jenkinsfile (inline script).
#   3. Restarts the Jenkins deployment so it picks the job up from disk.
#      NOTE: restarting aborts any build currently running.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JENKINS_HOME=/home/kisimita/jenkins-data
JOB_NAME=simple_timeline
JENKINSFILE="$HERE/jenkins/Jenkinsfile"

echo "[1] Copying minikube docker TLS certs -> $JENKINS_HOME/minikube-docker-certs"
mkdir -p "$JENKINS_HOME/minikube-docker-certs"
cp ~/.minikube/certs/ca.pem ~/.minikube/certs/cert.pem ~/.minikube/certs/key.pem \
   "$JENKINS_HOME/minikube-docker-certs/"
chmod 700 "$JENKINS_HOME/minikube-docker-certs"
chmod 600 "$JENKINS_HOME/minikube-docker-certs/"*.pem

echo "[2] Generating job config.xml from jenkins/Jenkinsfile"
mkdir -p "$JENKINS_HOME/jobs/$JOB_NAME"
python3 - "$JENKINSFILE" > "$JENKINS_HOME/jobs/$JOB_NAME/config.xml" <<'PYEOF'
import sys
from xml.sax.saxutils import escape

script = escape(open(sys.argv[1]).read())
print(f"""<?xml version='1.1' encoding='UTF-8'?>
<flow-definition plugin="workflow-job">
  <description>Build simple_timeline on minikube&apos;s docker daemon and redeploy it to the simple-timeline namespace. Managed by ~/Documents/Projects/k8s/simple_timeline/setup-jenkins-job.sh — edit jenkins/Jenkinsfile there, not here.</description>
  <keepDependencies>false</keepDependencies>
  <properties/>
  <definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition" plugin="workflow-cps">
    <script>{script}</script>
    <sandbox>true</sandbox>
  </definition>
  <triggers/>
  <disabled>false</disabled>
</flow-definition>""")
PYEOF

echo "[3] Restarting Jenkins to load the job (aborts running builds!)"
kubectl -n jenkins rollout restart deployment/jenkins
kubectl -n jenkins rollout status deployment/jenkins --timeout=300s

echo ""
echo "Done. Job: http://127.0.0.1:8080/job/$JOB_NAME/ (via jenkins-forward)"
echo "First run: 'Build Now' — parameters appear from the second run onward."
