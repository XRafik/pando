package oidc

import "github.com/trypando/pando/internal/adapter/api"

// Info describes this kind of adapter for the console and CLI forms.
//
// The presets are where each provider's quirks live, stated once: Entra's
// sub claim differs per application, so it matches on oid; Google sends no
// groups and admits any Google account unless the domain is fixed. A preset is
// only settings — choosing one is the same as typing them.
func Info() api.KindInfo {
	return api.KindInfo{
		Category:    api.CategoryIdentity,
		Kind:        Kind,
		Name:        "OpenID Connect",
		Description: "Sign in through any OpenID Connect provider: Okta, Microsoft Entra ID, Google Workspace, Keycloak, Authentik and others.",
		IDPrefix:    "idp_",
		Fields: []api.Field{
			{Key: "issuer", Label: "Issuer URL", Type: "string", Required: true,
				Help:        "The provider's issuer. Pando reads <issuer>/.well-known/openid-configuration for the rest.",
				Placeholder: "https://example.okta.com"},
			{Key: "client_id", Label: "Client ID", Type: "string", Required: true,
				Help: "The client ID of the web application you registered for Pando."},
			{Key: "client_secret", Label: "Client secret", Type: "string", Credential: true,
				Help: "The application's client secret. Stored encrypted and never shown again."},
			{Key: "scopes", Label: "Scopes", Type: "string", Advanced: true, Default: "openid email profile",
				Help: "Space-separated. Add groups if your provider needs a scope to send them."},
			{Key: "groups_claim", Label: "Groups claim", Type: "string", Default: "groups",
				Help: "The claim that lists the person's groups. Each one becomes a synced group in Pando."},
			{Key: "subject_claim", Label: "Subject claim", Type: "string", Advanced: true, Default: "sub",
				Help: "The claim that identifies a person and never changes. Microsoft Entra ID needs oid."},
			{Key: "username_claim", Label: "Username claim", Type: "string", Advanced: true, Default: "preferred_username",
				Help: "The claim holding the person's username in Pando."},
			{Key: "email_claim", Label: "Email claim", Type: "string", Advanced: true, Default: "email",
				Help: "The claim holding the person's email address."},
			{Key: "name_claim", Label: "Name claim", Type: "string", Advanced: true, Default: "name",
				Help: "The claim holding the person's display name. When it is empty, given_name and family_name are used."},
			{Key: "hosted_domain", Label: "Google Workspace domain", Type: "string", Presets: []string{"google"},
				Help:        "Only accept Google accounts from this domain. Without it, anyone with a Google account can sign in.",
				Placeholder: "example.com"},
			{Key: "prompt", Label: "Prompt", Type: "select", Default: "",
				Help: "Ask the provider to always show its sign-in form or account chooser.",
				Options: []api.Option{
					{Value: "", Label: "Provider's choice"},
					{Value: "login", Label: "Always ask for credentials"},
					{Value: "select_account", Label: "Always offer an account choice"},
				}},
			{Key: "disable_userinfo", Label: "Skip the userinfo endpoint", Type: "bool", Advanced: true,
				Help: "Use only the ID token's claims. By default Pando fills in missing claims from userinfo."},
			{Key: "session_max_lifetime", Label: "Session length", Type: "string", Advanced: true, Default: "12h",
				Help: "How long a sign-in lasts. Without SCIM this is also how long access can outlive its removal at the provider."},
		},
		Presets: []api.Preset{
			{ID: "okta", Label: "Okta",
				Values: map[string]string{"issuer": "https://{your-okta-domain}", "groups_claim": "groups",
					"scopes": "openid email profile groups"}},
			{ID: "entra", Label: "Microsoft Entra ID",
				Help: "Groups arrive as object IDs, and Entra does not vouch for email addresses, so accounts are never linked by email.",
				Values: map[string]string{"issuer": "https://login.microsoftonline.com/{tenant-id}/v2.0",
					"subject_claim": "oid", "groups_claim": "groups", "scopes": "openid email profile"}},
			{ID: "google", Label: "Google Workspace",
				Help: "Google sends no groups, so access is given through Pando's own groups.",
				Values: map[string]string{"issuer": "https://accounts.google.com",
					"scopes": "openid email profile"}},
			{ID: "keycloak", Label: "Keycloak",
				Values: map[string]string{"issuer": "https://{keycloak-host}/realms/{realm}", "groups_claim": "groups"}},
			{ID: "authentik", Label: "Authentik",
				Help: "Authentik sends group names in the profile scope.",
				Values: map[string]string{"issuer": "https://{authentik-host}/application/o/{application-slug}/",
					"groups_claim": "groups"}},
		},
		OtherPreset: "Another provider",
		Steps:       steps(),
	}
}

// steps walk through registering Pando with each provider. The redirect URI
// is core's callback for this provider (idp.Service.Endpoints); the adapter
// asks for openid plus the configured scopes and sends PKCE, so any client
// type that allows the authorization code flow works.
func steps() []api.Step {
	okta, entra, google := []string{"okta"}, []string{"entra"}, []string{"google"}
	keycloak, authentik, other := []string{"keycloak"}, []string{"authentik"}, []string{api.PresetOther}
	return []api.Step{
		{ID: "okta_app", Label: "Application", Title: "Create an app integration", Presets: okta,
			Do: []api.Action{
				{Text: "In the Admin Console, open **Applications and Resources** → **Applications**."},
				{Text: "Choose **Create App Integration**, then **Classic experience**."},
				{Text: "Choose **OIDC - OpenID Connect**, then **Web Application**, then **Next**."},
				{Text: "Set **Sign-in redirect URIs** to `{callback_url}`."},
				{Text: "Under **Assignments**, choose who can sign in, then choose **Save**."},
				{Text: "On the **General** tab, copy the **Client ID** and the client secret."},
			},
			Links:  []api.Link{{Label: "Okta OIDC app integrations", URL: "https://help.okta.com/en-us/content/topics/apps/apps_app_integration_wizard_oidc.htm"}},
			Fields: []string{"issuer", "client_id", "client_secret"}},
		{ID: "okta_groups", Label: "Groups", Title: "Add a groups claim", Presets: okta,
			Do: []api.Action{
				{Text: "On the app's **Sign On** tab, choose **Edit** under **OpenID Connect ID Token**."},
				{Text: "Set **Group claims filter** to `groups`, **Matches regex** and `.*`, then choose **Save**."},
			},
			Links:  []api.Link{{Label: "Okta groups claim", URL: "https://developer.okta.com/docs/guides/customize-tokens-groups-claim/main/"}},
			Fields: []string{"groups_claim"}},

		{ID: "entra_app", Label: "App registration", Title: "Register an application", Presets: entra,
			Do: []api.Action{
				{Text: "In the Microsoft Entra admin center, open **Entra ID** → **App registrations** and choose **New registration**."},
				{Text: "Under **Supported account types**, choose **Single tenant only**, then choose **Register**."},
				{Text: "Copy the **Application (client) ID** and **Directory (tenant) ID** from **Overview**."},
				{Text: "Under **Manage**, open **Authentication** and choose **Add Redirect URI**."},
				{Text: "Choose **Web**, set **Redirect URI** to `{callback_url}`, and choose **Configure**."},
			},
			Links:  []api.Link{{Label: "Open App registrations", URL: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"}},
			Fields: []string{"issuer", "client_id"}},
		{ID: "entra_secret", Label: "Client secret", Title: "Create a client secret", Presets: entra,
			Do: []api.Action{
				{Text: "Open **Certificates & secrets** → **Client secrets** and choose **New client secret**."},
				{Text: "Choose an expiry, then choose **Add**."},
				{Text: "Copy its **Value**, not its **Secret ID**."},
			},
			Links:  []api.Link{{Label: "Entra client secrets", URL: "https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials"}},
			Fields: []string{"client_secret"}},
		{ID: "entra_groups", Label: "Groups", Title: "Add a groups claim", Presets: entra,
			Do: []api.Action{
				{Text: "Under **Manage**, open **Token configuration** and choose **Add groups claim**."},
				{Text: "Choose **Groups assigned to the application**, then choose **Add**."},
				{Text: "In **Entra ID** → **Enterprise apps**, open the app and set **Assignment required?** to **Yes** under **Properties**."},
				{Text: "Under **Users and groups**, choose **Add user/group** and add the groups that use Pando."},
			},
			Links:  []api.Link{{Label: "Entra groups claim", URL: "https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims#configure-groups-optional-claims"}},
			Fields: []string{"groups_claim"}},

		{ID: "google_client", Label: "OAuth client", Title: "Create an OAuth client", Presets: google,
			Do: []api.Action{
				{Text: "In Google Cloud, open **Google Auth Platform** → **Clients** and choose **Create client**."},
				{Text: "Set **Application type** to **Web application**."},
				{Text: "Under **Authorized redirect URIs**, add `{callback_url}`, then choose **Create**."},
				{Text: "Copy the **Client ID** and **Client secret**. Google shows the secret once."},
			},
			Links:  []api.Link{{Label: "Open Google Auth Platform clients", URL: "https://console.cloud.google.com/auth/clients"}},
			Fields: []string{"client_id", "client_secret"}},
		{ID: "google_domain", Label: "Domain", Title: "Limit sign-in to your domain", Presets: google,
			Do:     []api.Action{{Text: "On **Audience**, set **User type** to **Internal**."}},
			Links:  []api.Link{{Label: "Open Google Auth Platform audience", URL: "https://console.cloud.google.com/auth/audience"}},
			Fields: []string{"hosted_domain"}},

		{ID: "keycloak_client", Label: "Client", Title: "Create a client", Presets: keycloak,
			Do: []api.Action{
				{Text: "In the Admin Console, choose your realm, then **Clients** → **Create client**."},
				{Text: "Set **Client type** to **OpenID Connect**, enter a **Client ID**, and choose **Next**."},
				{Text: "Turn on **Client authentication**, keep **Standard flow** on, and choose **Next**."},
				{Text: "Set **Valid redirect URIs** to `{callback_url}`, then choose **Save**."},
				{Text: "On the **Credentials** tab, copy the **Client Secret**."},
			},
			Links:  []api.Link{{Label: "Keycloak OIDC clients", URL: "https://www.keycloak.org/docs/latest/server_admin/#proc-creating-oidc-client_server_administration_guide"}},
			Fields: []string{"issuer", "client_id", "client_secret"}},
		{ID: "keycloak_groups", Label: "Groups", Title: "Add a groups mapper", Presets: keycloak,
			Do: []api.Action{
				{Text: "On the client's **Client scopes** tab, open the scope ending `-dedicated`."},
				{Text: "Choose **Configure a new mapper**, or **Add mapper** → **By configuration**, then **Group Membership**."},
				{Text: "Set **Name** and **Token Claim Name** to `groups`, turn off **Full group path**, and choose **Save**."},
			},
			Links:  []api.Link{{Label: "Keycloak protocol mappers", URL: "https://www.keycloak.org/docs/latest/server_admin/#_protocol-mappers"}},
			Fields: []string{"groups_claim"}},

		{ID: "authentik_app", Label: "Application", Title: "Create an application and provider", Presets: authentik,
			Do: []api.Action{
				{Text: "In the Admin interface, open **Applications** → **Applications** and choose **New Application**."},
				{Text: "Name the application, note its **Slug**, and choose **Next**."},
				{Text: "Choose **OAuth2/OpenID Connect**, then choose **Next**."},
				{Text: "Set **Client type** to **Confidential**."},
				{Text: "Add a **Strict** redirect URI of `{callback_url}`."},
				{Text: "Choose a **Signing Key**."},
				{Text: "Copy the **Client ID** and **Client Secret**, then choose **Submit**."},
			},
			Links:  []api.Link{{Label: "Authentik OAuth2 provider", URL: "https://docs.goauthentik.io/add-secure-apps/providers/oauth2/create-oauth2-provider/"}},
			Fields: []string{"issuer", "client_id", "client_secret"}},

		{ID: "other_client", Label: "Application", Title: "Register Pando as a web application", Presets: other,
			Do: []api.Action{
				{Text: "In your provider, create an OpenID Connect web application that uses the authorization code flow."},
				{Text: "Set its redirect URI to `{callback_url}`."},
				{Text: "Copy its issuer, client ID and client secret."},
			},
			Fields: []string{"issuer", "client_id", "client_secret"}},
		{ID: "other_groups", Label: "Groups", Title: "Send groups", Presets: other,
			Do:     []api.Action{{Text: "Add a claim listing the person's groups to the ID token or userinfo."}},
			Fields: []string{"groups_claim"}},
		{ID: "other_signin", Label: "Sign-in", Title: "Choose sign-in options", Presets: other,
			Fields: []string{"prompt"}},
	}
}
