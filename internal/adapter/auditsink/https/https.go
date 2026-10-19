// Package https is the audit sink adapter for a SIEM's HTTPS ingest endpoint
// (R-382, design 12 §5.1): one POST per batch, in the body shape the
// destination reads — newline-delimited JSON, a JSON array, Splunk HEC's
// envelope, or Elastic's bulk action lines.
//
// The provider's vocabulary stays here (R-251). Presets fill it in for Splunk,
// Datadog, Elastic, Sumo Logic and Azure Monitor; core knows none of them.
package https

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/trypando/pando/internal/adapter/api"
	"github.com/trypando/pando/internal/adapter/auditsink/sinkkit"
	"github.com/trypando/pando/internal/errs"
	"github.com/trypando/pando/internal/secret"
)

// Kind is the adapter's kind string.
const Kind = "https"

// DefaultMaxBatch is how many events one POST carries unless max_batch says.
const DefaultMaxBatch = 500

// Body shapes.
const (
	BodyNDJSON      = "ndjson"
	BodyJSONArray   = "json_array"
	BodySplunkHEC   = "splunk_hec"
	BodyElasticBulk = "elastic_bulk"
)

// SchemeNone sends the token as the whole header value, as Datadog's
// DD-API-KEY wants. A named value rather than an empty one, because an empty
// setting means the default, Bearer.
const SchemeNone = "none"

// snippetLimit is how much of a refusing answer an error quotes.
const snippetLimit = 300

// Config is the adapter's configuration.
type Config struct {
	Credentials Credentials `json:"credentials,omitzero"`
	sinkkit.Common

	URL            string `json:"url,omitempty"`
	AllowHTTP      bool   `json:"allow_http,omitempty"`
	Body           string `json:"body,omitempty"`
	AuthHeader     string `json:"auth_header,omitempty"`
	AuthScheme     string `json:"auth_scheme,omitempty"`
	ExtraHeaders   string `json:"extra_headers,omitempty"`
	SourceType     string `json:"sourcetype,omitempty"`
	CACertificate  string `json:"ca_certificate,omitempty"`
	TimeoutSeconds int    `json:"timeout_seconds,omitempty"`
}

// Credentials is what this adapter keeps secret (R-190).
//
// SecretURL is for a destination whose URL is itself the credential — a Sumo
// Logic HTTP source embeds its token in the path. Set, it replaces url, and
// only its host is ever shown.
type Credentials struct {
	Token     secret.Value `json:"token,omitzero"`
	SecretURL secret.Value `json:"secret_url,omitzero"`
}

// Adapter posts batches to one endpoint.
type Adapter struct {
	cfg      Config
	target   *url.URL
	headers  http.Header
	endpoint string
	client   *http.Client
}

// New returns an unconfigured adapter.
func New() *Adapter { return &Adapter{} }

func (a *Adapter) Kind() string           { return Kind }
func (a *Adapter) Category() api.Category { return api.CategoryAuditSink }

// AuditSinkCapabilities reports how core feeds this adapter (R-254).
func (a *Adapter) AuditSinkCapabilities() api.AuditSinkCapabilities {
	return a.cfg.Capabilities("https", a.endpoint)
}

// Configure reads the configuration core assembled.
func (a *Adapter) Configure(_ context.Context, raw json.RawMessage) error {
	if err := sinkkit.RefuseInline(Kind, raw, "token", "secret_url"); err != nil {
		return err
	}
	var cfg Config
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &cfg); err != nil {
			return fmt.Errorf("https: reading configuration: %w", err)
		}
	}
	if err := cfg.Normalize(Kind, DefaultMaxBatch); err != nil {
		return err
	}

	target, err := parseTarget(cfg)
	if err != nil {
		return err
	}

	switch cfg.Body {
	case "":
		cfg.Body = BodyNDJSON
	case BodyNDJSON, BodyJSONArray, BodySplunkHEC, BodyElasticBulk:
	default:
		return fmt.Errorf("https: %q is not a body shape. Valid answers: ndjson, json_array, splunk_hec, elastic_bulk", cfg.Body)
	}
	if cfg.SourceType == "" {
		cfg.SourceType = "pando:audit"
	}
	if cfg.AuthHeader == "" {
		cfg.AuthHeader = "Authorization"
	}
	if !validHeaderName(cfg.AuthHeader) {
		return fmt.Errorf("https: %q is not a header name. Use one such as Authorization or DD-API-KEY", cfg.AuthHeader)
	}
	if cfg.AuthScheme == "" {
		cfg.AuthScheme = "Bearer"
	}
	if strings.ContainsAny(cfg.AuthScheme, " \t\r\n") {
		return fmt.Errorf("https: %q is not an authorization scheme. Use one word such as Bearer, Splunk or ApiKey, or none to send the token as the whole header value", cfg.AuthScheme)
	}

	headers, err := parseExtraHeaders(cfg.ExtraHeaders, cfg.AuthHeader)
	if err != nil {
		return err
	}
	if cfg.TimeoutSeconds <= 0 {
		cfg.TimeoutSeconds = 15
	}
	pool, err := sinkkit.CertPool(Kind, cfg.CACertificate)
	if err != nil {
		return err
	}

	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	a.cfg, a.target, a.headers, a.endpoint = cfg, target, headers, target.Host
	a.client = &http.Client{
		Transport: transport,
		Timeout:   time.Duration(cfg.TimeoutSeconds) * time.Second,
		// A redirect is answered as a refusal, not followed: following one
		// would carry the audit log, and perhaps the token, somewhere the
		// operator did not name.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return nil
}

// parseTarget reads url, or secret_url in its place, and refuses one Pando
// should not post an audit log to. A secret URL is never quoted back.
func parseTarget(cfg Config) (*url.URL, error) {
	raw, secretURL := strings.TrimSpace(cfg.URL), !cfg.Credentials.SecretURL.IsZero()
	switch {
	case secretURL && raw != "":
		return nil, errors.New("https: both url and the secret_url credential are set. Set one: secret_url for a destination whose URL carries its token, such as a Sumo Logic HTTP source, and url otherwise")
	case secretURL:
		raw = strings.TrimSpace(cfg.Credentials.SecretURL.Reveal())
	case raw == "":
		return nil, errors.New("https: no url is set. Set url to the destination's ingest endpoint, such as https://splunk.example.com:8088/services/collector/event")
	}
	shown := fmt.Sprintf("%q", raw)
	if secretURL {
		shown = "The secret_url credential"
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, fmt.Errorf("https: %s is not an address Pando can post to. Use a URL such as https://siem.example.com/ingest", shown)
	}
	if u.User != nil {
		// Not quoted even for url: the part refused is a password.
		return nil, errors.New("https: the URL carries a user name or password before its host, where it would be stored unencrypted. Remove it and set the token credential instead")
	}
	if u.Scheme == "http" && !cfg.AllowHTTP {
		return nil, errors.New("https: the URL is http, which would send the audit log and its token across the network unencrypted. Use https, or set allow_http for a destination on a trusted network")
	}
	u.Fragment = ""
	return u, nil
}

// reserved are headers extra_headers may not set: the adapter sets them, and
// a second Authorization in plain configuration would be a stored secret.
var reserved = []string{"Authorization", "Content-Type", "Content-Length", "Host"}

// parseExtraHeaders reads "Name: value" lines.
func parseExtraHeaders(text, authHeader string) (http.Header, error) {
	h := http.Header{}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		name, value, ok := strings.Cut(line, ":")
		name, value = strings.TrimSpace(name), strings.TrimSpace(value)
		if !ok || !validHeaderName(name) {
			return nil, fmt.Errorf("https: extra_headers has a line that is not a header. Write one per line as Name: value, such as X-Source: pando")
		}
		for _, r := range append(reserved, authHeader) {
			if strings.EqualFold(name, r) {
				return nil, fmt.Errorf("https: extra_headers sets %s, which Pando sets itself or which carries the token. Remove it; set the token as a credential instead", name)
			}
		}
		h.Add(name, value)
	}
	return h, nil
}

// validHeaderName reports whether s is an HTTP token (RFC 9110 §5.6.2).
func validHeaderName(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r > 126 || r <= 32 || strings.ContainsRune(`"(),/:;<=>?@[\]{}`, r) {
			return false
		}
	}
	return true
}

// HealthCheck succeeds once configured. It posts nothing: a probe would be an
// event the SIEM indexes, and a destination that is down shows up as failed
// deliveries soon enough, with the answer it gave.
func (a *Adapter) HealthCheck(context.Context) error {
	if a.client == nil {
		return errors.New("https: not configured")
	}
	return nil
}

// Send posts the batch as one request.
func (a *Adapter) Send(ctx context.Context, b api.AuditBatch) error {
	if a.client == nil {
		return errs.New(errs.AdapterUnavailable, "The HTTPS audit sink is not configured.")
	}
	if len(b.Events) == 0 {
		return nil
	}
	body, contentType, err := a.encode(b.Events)
	if err != nil {
		return errs.Wrap(errs.AdapterFailed, "An audit event could not be wrapped for the destination's body shape.", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.target.String(), bytes.NewReader(body))
	if err != nil {
		return errs.New(errs.AdapterFailed, "The audit sink's URL could not be used.")
	}
	for k, v := range a.headers {
		req.Header[k] = v
	}
	req.Header.Set("Content-Type", contentType)
	if tok := a.cfg.Credentials.Token; !tok.IsZero() {
		value := tok.Reveal()
		if a.cfg.AuthScheme != SchemeNone {
			value = a.cfg.AuthScheme + " " + value
		}
		req.Header.Set(a.cfg.AuthHeader, value)
	}

	resp, err := a.client.Do(req)
	if err != nil {
		// Not wrapped: *url.Error quotes the URL, which may be the secret one.
		var ue *url.Error
		cause := err
		if errors.As(err, &ue) {
			cause = ue.Err
		}
		return errs.Wrap(errs.AdapterFailed, "Pando could not reach the audit sink at "+a.endpoint+". The events will be sent again.", cause)
	}
	defer func() { _ = resp.Body.Close() }()
	answer, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return errs.Newf(errs.AdapterFailed, "The audit sink at %s answered %d: %s", a.endpoint, resp.StatusCode, a.snippet(answer))
	}
	if a.cfg.Body == BodyElasticBulk {
		return a.bulkErrors(answer)
	}
	return nil
}

// bulkErrors reads Elastic's _bulk answer, which is 200 even when items in it
// failed. A batch with a failed item is not accepted, so core sends it again.
func (a *Adapter) bulkErrors(answer []byte) error {
	var r struct {
		Errors bool `json:"errors"`
		Items  []map[string]struct {
			Status int `json:"status"`
			Error  struct {
				Type   string `json:"type"`
				Reason string `json:"reason"`
			} `json:"error"`
		} `json:"items"`
	}
	// A 2xx answer that is not a bulk response (a proxy's, say) is taken as
	// accepted: only Elastic's own word that an item failed refuses a batch.
	readable := json.Unmarshal(answer, &r) == nil
	if !readable || !r.Errors {
		return nil
	}
	for _, item := range r.Items {
		for _, res := range item {
			if res.Status > 299 {
				return errs.Newf(errs.AdapterFailed, "Elasticsearch at %s refused an audit event with %d %s: %s. Check that the URL names a data stream, such as logs-pando.audit-default, and that the API key may write to it.",
					a.endpoint, res.Status, res.Error.Type, a.snippet([]byte(res.Error.Reason)))
			}
		}
	}
	return errs.Newf(errs.AdapterFailed, "Elasticsearch at %s reported errors in the batch.", a.endpoint)
}

// snippet is the start of an answer, fit to quote in an error: on one line,
// short, and with the token and secret URL removed if the destination echoed
// them back (R-194). Redacted before it is cut, so a cut cannot leave half a
// token behind.
func (a *Adapter) snippet(answer []byte) string {
	s := string(answer)
	for _, v := range []secret.Value{a.cfg.Credentials.Token, a.cfg.Credentials.SecretURL} {
		if !v.IsZero() {
			s = strings.ReplaceAll(s, v.Reveal(), secret.Redacted)
		}
	}
	if !a.cfg.Credentials.SecretURL.IsZero() && a.target.Path != "" && a.target.Path != "/" {
		s = strings.ReplaceAll(s, a.target.Path, secret.Redacted)
	}
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > snippetLimit {
		s = strings.ToValidUTF8(s[:snippetLimit], "") + "…"
	}
	if s == "" {
		s = "(no body)"
	}
	return s
}

// encode builds the body in the configured shape.
func (a *Adapter) encode(events []json.RawMessage) ([]byte, string, error) {
	var buf bytes.Buffer
	switch a.cfg.Body {
	case BodyJSONArray:
		buf.WriteByte('[')
		for i, ev := range events {
			if i > 0 {
				buf.WriteByte(',')
			}
			buf.Write(ev)
		}
		buf.WriteByte(']')
		return buf.Bytes(), "application/json", nil
	case BodySplunkHEC:
		// HEC's batch format: envelopes one after another (Splunk accepts any
		// whitespace between them).
		for _, ev := range events {
			line, err := json.Marshal(struct {
				Event      json.RawMessage `json:"event"`
				SourceType string          `json:"sourcetype"`
				Source     string          `json:"source"`
			}{ev, a.cfg.SourceType, "pando"})
			if err != nil {
				return nil, "", err
			}
			buf.Write(line)
			buf.WriteByte('\n')
		}
		return buf.Bytes(), "application/json", nil
	case BodyElasticBulk:
		// A data stream takes only create; the trailing newline is required.
		for _, ev := range events {
			buf.WriteString("{\"create\":{}}\n")
			buf.Write(ev)
			buf.WriteByte('\n')
		}
		return buf.Bytes(), "application/x-ndjson", nil
	default:
		for _, ev := range events {
			buf.Write(ev)
			buf.WriteByte('\n')
		}
		return buf.Bytes(), "application/x-ndjson", nil
	}
}

var _ api.AuditSinkAdapter = (*Adapter)(nil)

// Info describes this kind of adapter for the forms that configure one.
func Info() api.KindInfo {
	fields := []api.Field{
		{Key: "url", Label: "URL", Type: "string", Placeholder: "https://siem.example.com/ingest",
			Help: "The destination's ingest endpoint. Empty when Secret URL is set."},
		{Key: "secret_url", Label: "Secret URL", Type: "string", Credential: true,
			Help: "The whole URL, for a destination whose URL carries its token, such as a Sumo Logic HTTP source."},
		{Key: "token", Label: "Token", Type: "string", Credential: true,
			Help: "The API key or token the destination checks."},
		{Key: "body", Label: "Body", Type: "select", Default: BodyNDJSON,
			Help: "The shape of each POST's body.",
			Options: []api.Option{
				{Value: BodyNDJSON, Label: "NDJSON", Description: "One event per line."},
				{Value: BodyJSONArray, Label: "JSON array", Description: "The batch as one array."},
				{Value: BodySplunkHEC, Label: "Splunk HEC", Description: "Each event in a HEC envelope with a sourcetype."},
				{Value: BodyElasticBulk, Label: "Elastic bulk", Description: "A create action before each event, for a data stream's _bulk endpoint."},
			}},
		{Key: "auth_header", Label: "Auth header", Type: "string", Default: "Authorization",
			Help: "The header the token is sent in."},
		{Key: "auth_scheme", Label: "Auth scheme", Type: "select", Default: "Bearer", Other: true,
			Help: "The word before the token in the header.",
			Options: []api.Option{
				{Value: "Bearer", Label: "Bearer"}, {Value: "Splunk", Label: "Splunk"}, {Value: "ApiKey", Label: "ApiKey"},
				{Value: SchemeNone, Label: "None", Description: "The token is the whole header value."},
			}},
		{Key: "ca_certificate", Label: "CA certificate", Type: "string", Multiline: true,
			Help: "PEM certificates to trust for a destination on a private certificate authority. Empty trusts the system's."},
		{Key: "extra_headers", Label: "Extra headers", Type: "string", Multiline: true, Placeholder: "X-Source: pando",
			Help: "Headers to add, one per line as Name: value. Not encrypted, so not for anything secret."},
		{Key: "sourcetype", Label: "Splunk sourcetype", Type: "string", Default: "pando:audit", Advanced: true,
			ShownWhen: &api.Condition{Key: "body", Values: []string{BodySplunkHEC}},
			Help:      "The sourcetype each HEC envelope names."},
		{Key: "allow_http", Label: "Allow http", Type: "bool", Advanced: true,
			Help: "Post over plain http, unencrypted. Only for a destination on a trusted network."},
		{Key: "timeout_seconds", Label: "Timeout", Type: "int", Default: "15", Advanced: true,
			Help: "Seconds to wait for the destination to answer a batch."},
	}
	return api.KindInfo{
		Category: api.CategoryAuditSink,
		Kind:     Kind,
		Name:     "HTTPS",
		Description: "Posts every audit event, in batches as it is written, to a SIEM's HTTPS ingest endpoint: Splunk, Datadog, Elastic, Sumo Logic, Microsoft Sentinel, or anything that takes JSON with a token. " +
			"A copy of the audit log leaves this installation.",
		IDPrefix:    "as_",
		Fields:      append(fields, sinkkit.Fields(DefaultMaxBatch)...),
		Presets:     presets(),
		OtherPreset: "Another SIEM",
		Steps:       steps(),
	}
}

// steps guide setup: which SIEM first, then that SIEM's own steps. Another
// SIEM is asked for everything.
func steps() []api.Step {
	splunk, datadog, elastic, sumo, azure := []string{"splunk_hec"}, []string{"datadog"}, []string{"elastic"}, []string{"sumo_logic"}, []string{"azure_monitor"}
	other := []string{api.PresetOther}
	return []api.Step{
		{ID: "splunk_token", Label: "Token", Title: "Create an HEC token", Presets: splunk,
			Do: []api.Action{
				{Text: "In Splunk, open **Settings** → **Data inputs** → **HTTP Event Collector**."},
				{Text: "Under **Global Settings**, set **All Tokens** to **Enabled**."},
				{Text: "Choose **New Token**, finish it, and copy its value."},
			},
			Links:  []api.Link{{Label: "Splunk HEC", URL: "https://help.splunk.com/en/splunk-enterprise/get-started/get-data-in/9.4/get-data-with-http-event-collector/set-up-and-use-http-event-collector-in-splunk-web"}},
			Fields: []string{"token"}},
		{ID: "splunk_url", Label: "Endpoint", Title: "Enter the HEC endpoint", Presets: splunk,
			Do: []api.Action{
				{Text: "Use your Splunk host on the HEC port, usually `8088`, ending `/services/collector/event`."},
				{Text: "On Splunk Cloud, use `https://http-inputs-<stack>.splunkcloud.com/services/collector/event`."},
			},
			Fields: []string{"url"}},
		{ID: "datadog_key", Label: "API key", Title: "Create an API key", Presets: datadog,
			Do:     []api.Action{{Text: "In Datadog, open **Organization Settings** → **API Keys** and choose **New Key**."}},
			Links:  []api.Link{{Label: "Open Datadog API keys", URL: "https://app.datadoghq.com/organization-settings/api-keys"}},
			Fields: []string{"token"}},
		{ID: "datadog_site", Label: "Site", Title: "Choose your Datadog site", Presets: datadog,
			Do:     []api.Action{{Text: "Outside US1, change the host to your site's intake host, such as `http-intake.logs.datadoghq.eu`."}},
			Links:  []api.Link{{Label: "Datadog sites", URL: "https://docs.datadoghq.com/getting_started/site/"}},
			Fields: []string{"url"}},
		{ID: "elastic_key", Label: "API key", Title: "Create an API key", Presets: elastic,
			Do: []api.Action{
				{Text: "In Kibana, open **API keys** and choose **Create API key**."},
				{Text: "Grant `create_doc` and `auto_configure` on the data stream."},
				{Text: "Copy the **Encoded** value."},
			},
			Links:  []api.Link{{Label: "Elastic API keys", URL: "https://www.elastic.co/docs/deploy-manage/api-keys/elasticsearch-api-keys"}},
			Fields: []string{"token"}},
		{ID: "elastic_url", Label: "Endpoint", Title: "Enter the bulk endpoint", Presets: elastic,
			Do:     []api.Action{{Text: "Use your Elasticsearch endpoint, then a data stream such as `logs-pando.audit-default`, then `/_bulk`."}},
			Fields: []string{"url"}},
		{ID: "sumo_source", Label: "HTTP source", Title: "Add an HTTP source", Presets: sumo,
			Do: []api.Action{
				{Text: "In Sumo Logic, open **Data Management** → **Data Collection** → **Collection**."},
				{Text: "Choose **Add Source** beside a hosted collector, then **HTTP Logs & Metrics**."},
				{Text: "Copy its **HTTP Source Address**."},
			},
			Links:  []api.Link{{Label: "Sumo Logic HTTP source", URL: "https://www.sumologic.com/help/docs/send-data/hosted-collectors/http-source/logs-metrics/"}},
			Fields: []string{"secret_url"}},
		{ID: "azure_rule", Label: "Collection rule", Title: "Create a data collection rule", Presets: azure,
			Do: []api.Action{
				{Text: "In Azure, create a data collection rule with a stream named `Custom-PandoAudit_CL`."},
				{Text: "Give the app that mints the token the **Monitoring Metrics Publisher** role on it."},
				{Text: "Use the rule's logs ingestion endpoint and immutable ID in the URL."},
			},
			Links:  []api.Link{{Label: "Azure Logs Ingestion API", URL: "https://learn.microsoft.com/en-us/azure/azure-monitor/logs/logs-ingestion-api-overview"}},
			Fields: []string{"url"}},
		{ID: "azure_token", Label: "Token", Title: "Get an access token", Presets: azure,
			Do: []api.Action{
				{Text: "Get a Microsoft Entra ID access token for `https://monitor.azure.com`."},
				{Text: "Replace it before it expires: Pando does not refresh it."},
			},
			Fields: []string{"token"}},
		{ID: "endpoint", Label: "Endpoint", Title: "Enter the ingest endpoint", Presets: other,
			Fields: []string{"body", "url", "secret_url"}},
		{ID: "token", Label: "Token", Title: "Enter the token", Presets: other,
			Fields: []string{"token", "auth_header", "auth_scheme"}},
		{ID: "connection", Label: "Connection", Title: "Adjust the connection",
			Fields: []string{"ca_certificate", "extra_headers"}},
		{ID: "events", Label: "Events", Title: "Choose which events to send",
			Fields: []string{"actions", "exclude"}},
	}
}

func presets() []api.Preset {
	return []api.Preset{
		{ID: "splunk_hec", Label: "Splunk HTTP Event Collector",
			Help:   "In Splunk, Settings > Data inputs > HTTP Event Collector: under Global Settings set All Tokens to Enabled, then choose New Token and copy its value. The URL is your Splunk host on the HEC port, usually 8088, ending /services/collector/event. On Splunk Cloud the host is http-inputs-<stack>.splunkcloud.com on port 443.",
			Values: map[string]string{"url": "https://splunk.example.com:8088/services/collector/event", "body": BodySplunkHEC, "auth_scheme": "Splunk"}},
		{ID: "datadog", Label: "Datadog Logs",
			Help:   "In Datadog, Organization Settings > API Keys: choose New Key and set the key as the token. The URL is for the US1 site; for another site use its intake host, such as http-intake.logs.datadoghq.eu for EU or http-intake.logs.us5.datadoghq.com for US5.",
			Values: map[string]string{"url": "https://http-intake.logs.datadoghq.com/api/v2/logs?ddsource=pando&service=pando", "body": BodyJSONArray, "auth_header": "DD-API-KEY", "auth_scheme": SchemeNone}},
		{ID: "elastic", Label: "Elastic",
			Help:   "In Kibana, open API keys and choose Create API key, with create_doc and auto_configure on the data stream, and set its Encoded value as the token. The URL is your Elasticsearch endpoint, then a data stream name such as logs-pando.audit-default, then /_bulk.",
			Values: map[string]string{"url": "https://my-deployment.es.example.com/logs-pando.audit-default/_bulk", "body": BodyElasticBulk, "auth_scheme": "ApiKey"}},
		{ID: "sumo_logic", Label: "Sumo Logic HTTP source",
			Help:   "In Sumo Logic, Data Management > Data Collection > Collection: choose Add Source beside a hosted collector, then HTTP Logs & Metrics, and copy its HTTP Source Address. The URL contains the source's token, so set it as the secret URL credential and leave url and token empty.",
			Values: map[string]string{"body": BodyNDJSON}},
		{ID: "azure_monitor", Label: "Microsoft Sentinel (Azure Monitor Logs ingestion)",
			Help: "In Azure, create a data collection rule with a stream named Custom-PandoAudit_CL whose columns match the events, and give the app that mints the token the Monitoring Metrics Publisher role on it. Use the rule's logs ingestion endpoint, or a data collection endpoint's, and its immutable ID in the URL. " +
				"The token is a Microsoft Entra ID access token for the https://monitor.azure.com scope. This adapter sends a static token and does not mint or refresh one, so a token that expires stops delivery until it is replaced.",
			Values: map[string]string{"url": "https://my-dce.eastus-1.ingest.monitor.azure.com/dataCollectionRules/dcr-00000000000000000000000000000000/streams/Custom-PandoAudit_CL?api-version=2023-01-01", "body": BodyJSONArray, "auth_scheme": "Bearer"}},
	}
}
