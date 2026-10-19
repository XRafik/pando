package multidocker

import (
	"strconv"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/hostagent"
)

// Info describes this kind of adapter for the forms that configure one
// (api.KindInfo, R-261).
func Info() api.KindInfo {
	return api.KindInfo{
		Category: api.CategoryRuntime,
		Kind:     Kind,
		Name:     "Docker on several hosts",
		Description: "Runs apps as containers on several Docker hosts. Each app is placed on one host and stays there: " +
			"a new app goes to the host with the most free memory that fits it. Pando reaches each host's apps " +
			"through a forwarding agent it runs there, which accepts only Pando's certificate. Built images reach " +
			"the hosts through the install's image registry.",
		IDPrefix: "rt_",
		Fields: []api.Field{
			{Key: "hosts", Label: "Hosts", Type: "string", Multiline: true, Required: true,
				Help: "The hosts as a JSON list. Each has a name; an endpoint (unix:///var/run/docker.sock, tcp://host:2376 " +
					"with the Docker TLS credential, or ssh://user@host with the SSH key and the host's ssh_host_key); an " +
					"agent_address where Pando reaches the host's agent; and optionally no_placement to keep new apps off it. " +
					"Exactly one is \"control\": true, the host Pando runs on.",
				Placeholder: `[{"name":"control","control":true,"agent_address":"10.0.0.5:7443"},{"name":"app-1","endpoint":"tcp://10.0.0.6:2376"}]`},
			{Key: "agent_authority", Label: "Agent certificate authority", Type: "string", Multiline: true, Credential: true, Required: true,
				Help: "The output of `pando host-agent new-authority`. Pando issues its own certificate and each agent's from it."},
			{Key: "docker_tls", Label: "Docker TLS client certificate", Type: "string", Multiline: true, Credential: true,
				Help: "For tcp:// hosts: the CA (ca.pem), the client certificate (cert.pem) and its key (key.pem), pasted together."},
			{Key: "ssh_key", Label: "SSH private key", Type: "string", Multiline: true, Credential: true,
				Help: "For ssh:// hosts: an unencrypted private key for a user in the docker group, or root."},
			{Key: "agent_image", Label: "Agent image", Type: "string", Advanced: true,
				Help:    "The image of Pando each host's agent and each restricted app's egress gateway run. Every host must be able to pull it.",
				Default: "The image Pando's own container runs"},
			{Key: "agent_port", Label: "Agent port", Type: "int", Advanced: true,
				Help:    "The one port each host publishes, for its agent. Restrict it to the control host's address with the host's firewall.",
				Default: strconv.Itoa(hostagent.DefaultPort)},
			{Key: "network_pool", Label: "App network range", Type: "string", Advanced: true,
				Help:    "The IPv4 range each host's app networks take their addresses from. Each host uses the whole range for its own apps. Cannot be \"off\" here.",
				Default: defaultNetworkPool},
			{Key: "network_block_bits", Label: "App network size", Type: "int", Advanced: true,
				Help:    "The size of each app's private network, as a prefix length from 24 to 29.",
				Default: "28"},
			{Key: "oci_runtime", Label: "Container runtime", Type: "string", Advanced: true,
				Help:    "The runtime every host's Docker starts apps with, by the name it is registered under in daemon.json, such as runsc.",
				Default: "Docker's default, runc"},
		},
		Steps: []api.Step{
			{ID: "access", Label: "Docker access", Title: "Open each host's Docker API",
				Do: []api.Action{
					{Text: "Install Docker Engine on each host. Use hosts of one CPU architecture."},
					{Text: "For a `tcp://` host, follow **Use TLS (HTTPS) to protect the Docker daemon socket** to run `dockerd --tlsverify` on port `2376`, and paste `ca.pem`, `cert.pem` and `key.pem` below."},
					{Text: "For an `ssh://` host, run `ssh-keygen -t ed25519 -f pando-docker -N \"\"`."},
					{Text: "On each `ssh://` host, add a user to the `docker` group with `sudo usermod -aG docker <user>` and add `pando-docker.pub` to its `~/.ssh/authorized_keys`."},
					{Text: "Paste `pando-docker` below."},
				},
				Links: []api.Link{
					{Label: "Open Docker's install guide", URL: "https://docs.docker.com/engine/install/"},
					{Label: "Open Docker's TLS guide", URL: "https://docs.docker.com/engine/security/protect-access/#use-tls-https-to-protect-the-docker-daemon-socket"},
				},
				Fields: []string{"docker_tls", "ssh_key"}},
			{ID: "hosts", Label: "Hosts", Title: "List the hosts",
				Do: []api.Action{
					{Text: "On each host, allow port `" + strconv.Itoa(hostagent.DefaultPort) + "` from the control host's address only."},
					{Text: "On each host, let Docker pull from the install's image registry: trust its certificate, or list it under `insecure-registries` in `/etc/docker/daemon.json`."},
					{Text: "Give each host a `name` and an `endpoint`: `tcp://<host>:2376` or `ssh://<user>@<host>`."},
					{Text: "Mark the host Pando runs on with `\"control\": true` and give it an `agent_address`, such as `10.0.0.5:" + strconv.Itoa(hostagent.DefaultPort) + "`."},
					{Text: "For each `ssh://` host, set `ssh_host_key` to its line from `ssh-keyscan -t ed25519 <host>`."},
				},
				Fields: []string{"hosts"}},
			{ID: "authority", Label: "Authority", Title: "Create the agent certificate authority",
				Do: []api.Action{
					{Text: "On the host Pando runs on, run `pando host-agent new-authority`, or `docker compose exec pando pando host-agent new-authority` with Docker Compose."},
					{Text: "Paste its output below."},
				},
				Fields: []string{"agent_authority"}},
		},
	}
}
