#!/bin/sh
# Writes the Kubernetes manifest a release ships: every file
# deploy/kubernetes/kustomization.yaml lists, in its order, as one document
# stream, with Pando's image pinned to the version and digest being released.
#
# The release attaches this the way it attaches the compose file, so the image a
# release names moves with the release itself and needs no pull request after
# it. Pando's image appears twice, the Deployment's and the ConfigMap's
# egress_gateway_image (R-187); both are replaced, and they must stay one image
# (TestR401_EveryShippedImageIsPinnedByDigest).
#
# usage: scripts/release-kubernetes.sh 0.3.0 sha256:<digest> [image] > pando-kubernetes.yaml
set -eu
version=${1:?usage: release-kubernetes.sh VERSION DIGEST [IMAGE]}
digest=${2:?usage: release-kubernetes.sh VERSION DIGEST [IMAGE]}
image=${3:-trypando/pando}
version=${version#v}
dir=$(dirname "$0")/../deploy/kubernetes

# On the whole string, not line by line: a newline is not a hex digit.
hex=${digest#sha256:}
case $hex in *[!0-9a-f]*) hex= ;; esac
if [ "sha256:$hex" != "$digest" ] || [ ${#hex} != 64 ]; then
  echo "release-kubernetes.sh: digest must be sha256: and 64 hex digits, got '$digest'" >&2
  exit 1
fi

resources=$(sed -n 's/^  - \([a-z-]*\.yaml\)$/\1/p' "$dir/kustomization.yaml")
if [ -z "$resources" ]; then
  echo "release-kubernetes.sh: $dir/kustomization.yaml lists no resources" >&2
  exit 1
fi

# Exactly two references to Pando's image. Anything else means the manifests
# changed shape and this substitution would ship something nobody reviewed.
count=0
for f in $resources; do
  n=$(grep -c 'trypando/pando:[^@[:space:]]*@sha256:[0-9a-f]\{64\}' "$dir/$f" || true)
  count=$((count + n))
done
if [ "$count" != 2 ]; then
  echo "release-kubernetes.sh: expected two pinned trypando/pando references in deploy/kubernetes, found $count" >&2
  exit 1
fi

cat <<EOF
# Pando ${version} on Kubernetes, from https://github.com/trypando/pando/releases/tag/v${version}
#
# Runs ${image}:${version}@${digest}. Set pod_cidr and service_cidr
# and create the two Secrets the pando section below describes, then
# \`kubectl apply -f\` this file. To upgrade, carry those settings into the newer
# release's file and apply it.
EOF
for f in $resources; do
  printf -- '---\n# deploy/kubernetes/%s\n' "$f"
  sed "s|trypando/pando:[^@[:space:]]*@sha256:[0-9a-f]\{64\}|${image}:${version}@${digest}|" "$dir/$f"
done
