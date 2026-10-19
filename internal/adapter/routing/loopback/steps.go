package loopback

import "github.com/trypando/pando/internal/adapter/api"

// steps walk through setting up this kind (api.KindInfo.Steps).
func steps() []api.Step {
	return []api.Step{
		{ID: "address", Label: "Address", Title: "Where are apps reached?", Fields: []string{"base_url"}},
	}
}
