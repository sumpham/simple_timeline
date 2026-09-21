#!/usr/bin/env bash
# Install/refresh the `simple_timeline` Jenkins pipeline job on the in-cluster
# Jenkins (jenkins namespace, jenkins_home = ~/jenkins-data).
#
# The job is configured as "Pipeline script from SCM", pointing at
# jenkins/Jenkinsfile in the GitHub repo — NOT as an inline script. That matters:
# an inline job freezes a copy of the pipeline inside config.xml, so re-running a
# setup script later silently reverts the live pipeline to whatever the script
# happened to hold. (That is exactly what went wrong with secure_media; see the
# warning in restore-after-minikube-recreate.sh step [6c].) With SCM, the pipeline
# is whatever is on the branch, and this script is safe to re-run any time.
#
# Does three things:
#   1. Copies minikube's docker TLS client certs into jenkins_home so the
#      pipeline can build on tcp://192.168.49.2:2376.
#      >>> Re-run this script after every `minikube delete` — certs rotate. <<<
#   2. Writes the job config.xml (SCM-backed).
#   3. Restarts Jenkins so it picks the job up from disk.
#      NOTE: restarting aborts any build currently running.
set -euo pipefail

JENKINS_HOME=${JENKINS_HOME:-/home/kisimita/jenkins-data}
JOB_NAME=simple_timeline
GIT_URL=${GIT_URL:-https://github.com/sumpham/simple_timeline.git}
GIT_BRANCH=${GIT_BRANCH:-main}
CREDENTIALS_ID=${CREDENTIALS_ID:-github-token}

echo "[1] Copying minikube docker TLS certs -> $JENKINS_HOME/minikube-docker-certs"
mkdir -p "$JENKINS_HOME/minikube-docker-certs"
cp ~/.minikube/certs/ca.pem ~/.minikube/certs/cert.pem ~/.minikube/certs/key.pem \
   "$JENKINS_HOME/minikube-docker-certs/"
chmod 700 "$JENKINS_HOME/minikube-docker-certs"
chmod 600 "$JENKINS_HOME/minikube-docker-certs/"*.pem

echo "[2] Writing job config.xml (Pipeline script from SCM: jenkins/Jenkinsfile)"
mkdir -p "$JENKINS_HOME/jobs/$JOB_NAME"
cat > "$JENKINS_HOME/jobs/$JOB_NAME/config.xml" <<XML
<?xml version='1.1' encoding='UTF-8'?>
<flow-definition plugin="workflow-job">
  <description>Build simple_timeline on minikube&apos;s docker daemon and redeploy it to the simple-timeline namespace. Pipeline lives in jenkins/Jenkinsfile in the repo — edit it there, not here. Job managed by ~/Documents/Projects/k8s/simple_timeline/setup-jenkins-job.sh.</description>
  <keepDependencies>false</keepDependencies>
  <properties/>
  <definition class="org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition" plugin="workflow-cps">
    <scm class="hudson.plugins.git.GitSCM" plugin="git">
      <configVersion>2</configVersion>
      <userRemoteConfigs>
        <hudson.plugins.git.UserRemoteConfig>
          <url>${GIT_URL}</url>
          <credentialsId>${CREDENTIALS_ID}</credentialsId>
        </hudson.plugins.git.UserRemoteConfig>
      </userRemoteConfigs>
      <branches>
        <hudson.plugins.git.BranchSpec>
          <name>*/${GIT_BRANCH}</name>
        </hudson.plugins.git.BranchSpec>
      </branches>
      <doGenerateSubmoduleConfigurations>false</doGenerateSubmoduleConfigurations>
      <submoduleCfg class="empty-list"/>
      <extensions/>
    </scm>
    <scriptPath>jenkins/Jenkinsfile</scriptPath>
    <lightweight>true</lightweight>
  </definition>
  <triggers/>
  <disabled>false</disabled>
</flow-definition>
XML

echo "[3] Restarting Jenkins to load the job (aborts running builds!)"
kubectl -n jenkins rollout restart deployment/jenkins
kubectl -n jenkins rollout status deployment/jenkins --timeout=300s

echo ""
echo "Done. Job: http://127.0.0.1:8080/job/$JOB_NAME/ (via jenkins-forward)"
echo "Pipeline source: $GIT_URL ($GIT_BRANCH) -> jenkins/Jenkinsfile"
echo "First run: 'Build Now' — parameters appear from the second run onward."
