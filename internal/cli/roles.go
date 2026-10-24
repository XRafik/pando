package cli

import (
	"fmt"
	"net/url"

	"github.com/spf13/cobra"
)

// roleCmd is `pando role`: editing a custom role and reading who holds one
// (R-082). Built-in roles are refused by the server (R-081).
func roleCmd(client func() (*Client, error)) *cobra.Command {
	cmd := &cobra.Command{Use: "role", Short: "Work with roles and who holds them"}

	var name string
	var verbs []string
	edit := &cobra.Command{
		Use:   "edit <role-id>",
		Short: "Rename a custom role, or replace its permissions",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{}
			if cmd.Flags().Changed("name") {
				body["name"] = name
			}
			if cmd.Flags().Changed("verbs") {
				body["verbs"] = verbs
			}
			if len(body) == 0 {
				return fmt.Errorf("say what to change: --name, --verbs, or both")
			}
			c, err := client()
			if err != nil {
				return err
			}
			var out map[string]any
			if err := c.Do("PATCH", "/roles/"+url.PathEscape(args[0]), body, &out); err != nil {
				return err
			}
			return printJSON(cmd.OutOrStdout(), out)
		},
	}
	edit.Flags().StringVar(&name, "name", "", "the role's new name")
	edit.Flags().StringSliceVar(&verbs, "verbs", nil, "every permission the role carries, comma-separated")
	cmd.AddCommand(edit)

	cmd.AddCommand(&cobra.Command{
		Use:   "holders <role-id>",
		Short: "Show the groups and accounts holding a role, directly or through a group",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := client()
			if err != nil {
				return err
			}
			return printAllPages(cmd, c, "/roles/"+url.PathEscape(args[0])+"/holders", "holders")
		},
	})
	return cmd
}
