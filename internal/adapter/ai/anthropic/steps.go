package anthropic

import (
	"github.com/trypando/pando/internal/adapter/ai/aikit"
	"github.com/trypando/pando/internal/adapter/api"
)

// steps walk through the key and the model. Pando sends no
// anthropic-workspace-id header, so the key has to be scoped to one
// workspace: a key that is not is refused by the API.
func steps() []api.Step {
	return []api.Step{
		aikit.KeyStep(api.Link{Label: "Open API keys", URL: "https://platform.claude.com/settings/keys"},
			api.Action{Text: "In the Claude Console, open **API keys** and choose **Create key**."},
			api.Action{Text: "Name the key and choose an expiration."},
			api.Action{Text: "Set **Linked account** to a service account, or to yourself."},
			api.Action{Text: "Scope the key to one workspace."},
			api.Action{Text: "Copy the key, which starts with `sk-ant-`."},
		),
		aikit.ModelStep([]api.Link{{Label: "Compare models", URL: "https://platform.claude.com/docs/en/models/overview"}}),
	}
}
