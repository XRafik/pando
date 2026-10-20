package cli

import (
	"fmt"
	"net/url"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

// notifyCmd is what is particular to a notification adapter that connects to
// its provider — Slack, as Pando's own app — and posts to the channel each
// subscription chooses (R-374). One is added with `pando adapter add
// notify/slack`.
func notifyCmd(client func() (*Client, error)) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "notify",
		Short: "Connect notification adapters such as Slack, and list their channels",
		Long: "A Slack adapter posts as Pando's own Slack app, which connecting creates. Add the adapter with\n" +
			"`pando adapter add notify/slack`, connect it with `pando notify connect`, then subscribe with\n" +
			"`pando subscriptions create --adapter <id> --channel <channel>`.",
	}

	cmd.AddCommand(notifyListCmd(client), notifyConnectCmd(client), notifyChannelsCmd(client))
	return cmd
}

// notifyListCmd shows the notification adapters and whether each can send.
func notifyListCmd(client func() (*Client, error)) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "Show the notification adapters and whether each can send",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c, err := client()
			if err != nil {
				return err
			}
			var out struct {
				Adapters []struct {
					ID           string `json:"id"`
					Kind         string `json:"kind"`
					Problem      string `json:"problem"`
					Capabilities struct {
						Audience   string `json:"audience"`
						Authorized bool   `json:"authorized"`
						Web        bool   `json:"web_authorization"`
						Manual     bool   `json:"manual_authorization"`
					} `json:"capabilities"`
				} `json:"adapters"`
			}
			if err := c.Do("GET", "/notify", nil, &out); err != nil {
				return err
			}
			w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 0, 2, ' ', 0)
			fmt.Fprintln(w, "ID\tKIND\tREACHES\tSTATE")
			for _, a := range out.Adapters {
				state := "ready"
				switch {
				case a.Problem != "":
					state = a.Problem
				case !a.Capabilities.Authorized && (a.Capabilities.Web || a.Capabilities.Manual):
					state = "not connected: pando notify connect " + a.ID
				}
				fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", a.ID, a.Kind, a.Capabilities.Audience, state)
			}
			return w.Flush()
		},
	}
}

// notifyConnectCmd connects an adapter, such as Slack, to its provider.
func notifyConnectCmd(client func() (*Client, error)) *cobra.Command {
	var token, botToken string
	var manual bool
	connect := &cobra.Command{
		Use:   "connect <adapter>",
		Short: "Connect a notification adapter, such as Slack, to its provider",
		Long: "--token is a Slack configuration token: in Slack's app settings, under Your App Configuration\n" +
			"Tokens, choose Generate Token. Pando uses it once to create its app, and prints Slack's approval\n" +
			"page to open in a browser signed in to Pando. Slack returns only to an https address; without\n" +
			"one, --manual prints a link that creates the app in Slack, and --bot-token takes the bot token it\n" +
			"shows once installed.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]string{"mode": "web", "token": token}
			switch {
			case botToken != "":
				body = map[string]string{"mode": "manual", "token": botToken}
			case manual:
				body = map[string]string{"mode": "manual"}
			case token == "":
				return fmt.Errorf("give --token (a Slack configuration token), --manual, or --bot-token")
			}
			c, err := client()
			if err != nil {
				return err
			}
			var out struct {
				AuthorizeURL string `json:"authorize_url"`
				Status       string `json:"status"`
			}
			if err := c.Do("POST", "/notify/"+url.PathEscape(args[0])+"/authorize", body, &out); err != nil {
				return err
			}
			w := cmd.OutOrStdout()
			switch {
			case out.Status == "authorized":
				fmt.Fprintf(w, "Connected. Subscribe with `pando subscriptions create --adapter %s --channel <channel>`; `pando notify channels %s` lists them.\n", args[0], args[0])
			case manual:
				fmt.Fprintf(w, "Open this address, pick the workspace, choose Create, then Install to Workspace:\n\n  %s\n\n"+
					"Then run `pando notify connect %s --bot-token <token>` with the Bot User OAuth Token from OAuth & Permissions.\n", out.AuthorizeURL, args[0])
			default:
				fmt.Fprintf(w, "Pando created its Slack app. Open this address in a browser signed in to Pando, and choose Allow:\n\n  %s\n", out.AuthorizeURL)
			}
			return nil
		},
	}
	connect.Flags().StringVar(&token, "token", "", "A Slack configuration token, used once to create Pando's app")
	connect.Flags().BoolVar(&manual, "manual", false, "Print a link that creates the app in Slack, for a Pando without an https address")
	connect.Flags().StringVar(&botToken, "bot-token", "", "The bot token of an app created with --manual")
	return connect
}

// notifyChannelsCmd lists the channels a subscription to an adapter can name.
func notifyChannelsCmd(client func() (*Client, error)) *cobra.Command {
	var query string
	channels := &cobra.Command{
		Use:   "channels <adapter>",
		Short: "List the channels a subscription to the adapter can post to",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := client()
			if err != nil {
				return err
			}
			var out struct {
				Channels []struct {
					ID      string `json:"id"`
					Name    string `json:"name"`
					Private bool   `json:"private"`
				} `json:"channels"`
			}
			path := "/notify/" + url.PathEscape(args[0]) + "/channels"
			if query != "" {
				path += "?q=" + url.QueryEscape(query)
			}
			if err := c.Do("GET", path, nil, &out); err != nil {
				return err
			}
			if len(out.Channels) == 0 {
				fmt.Fprintln(cmd.OutOrStdout(), "No channels. A private channel is listed once Pando is invited to it with /invite @Pando.")
				return nil
			}
			w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 0, 2, ' ', 0)
			fmt.Fprintln(w, "ID\tNAME\tPRIVATE")
			for _, ch := range out.Channels {
				private := "no"
				if ch.Private {
					private = "yes"
				}
				fmt.Fprintf(w, "%s\t#%s\t%s\n", ch.ID, ch.Name, private)
			}
			return w.Flush()
		},
	}
	channels.Flags().StringVar(&query, "query", "", "Only channels whose names contain this")
	return channels
}
