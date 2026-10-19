package api

import (
	"fmt"
	"regexp"
)

// KindInfo describes a kind of adapter this build of Pando can run: what it is
// called, what it is for, and the settings configuring one takes.
//
// Data, like capabilities (R-254). Each adapter package describes itself, and
// the console and the CLI build their "add an adapter" forms from it — so a
// kind added to Pando is configurable from every surface without either being
// taught about it (R-261).
type KindInfo struct {
	Category    Category `json:"category"`
	Kind        string   `json:"kind"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Fields      []Field  `json:"fields"`

	// IDPrefix is the prefix an instance's ID conventionally takes, such as
	// "ai_" — so a form can suggest "ai_anthropic" rather than ask for one.
	IDPrefix string `json:"id_prefix"`

	// Presets are known providers of this kind — Okta, Microsoft Entra ID —
	// with the settings each needs filled in, so connecting one is choosing it
	// rather than knowing its quirks. A form offers them; the settings are the
	// same ones Fields describes.
	Presets []Preset `json:"presets,omitempty"`

	// Steps walk someone through setting one up, one screen at a time: what to
	// do in the provider's own console, then the settings that produces. Every
	// basic setting is asked on exactly one step; advanced ones on none — a
	// form shows them on its review, closed (Validate). Choosing the kind,
	// naming the adapter and reviewing it are the form's own steps, the same
	// for every kind, and are not listed here.
	Steps []Step `json:"steps,omitempty"`
}

// Step is one screen of guided setup.
type Step struct {
	// ID names the step for a form's progress and its "change" links.
	ID string `json:"id"`

	// Label is the step's name in a form's list of steps, a word or two:
	// "API token", "Domain".
	Label string `json:"label"`

	// Title is an instruction or a question, in sentence case: "Create an
	// API token", "Which domain should apps use?".
	Title string `json:"title"`

	// Lede is one sentence on why the step is asked, shown under the title.
	Lede string `json:"lede,omitempty"`

	// Do is what to do outside Pando, in order, one action to an item, in the
	// provider's own words. **Bold** marks the name of something on the
	// provider's screen and `backticks` a command, path or value typed
	// exactly; nothing else is markup.
	Do []Action `json:"do,omitempty"`

	// Links open the provider's pages the step starts on: usually one, and
	// one per way when there is more than one way to do it, as there is to
	// make a Cloudflare token.
	Links []Link `json:"links,omitempty"`

	// Fields are the keys of the settings asked on this step, in order.
	Fields []string `json:"fields"`

	// ShownWhen skips the step unless a setting asked on an earlier step has
	// one of the given values — the GitHub App steps only for a GitHub App.
	ShownWhen *Condition `json:"shown_when,omitempty"`
}

// Action is one thing to do in a step.
type Action struct {
	Text string `json:"text"`

	// Table is shown under the text, for something with columns, such as an
	// API token's permissions.
	Table *Table `json:"table,omitempty"`
}

// Table is a small grid of plain text.
type Table struct {
	Columns []string   `json:"columns"`
	Rows    [][]string `json:"rows"`
}

// Link is a page on the provider's site. Its URL may hold {key} for a
// setting's value, as Suggest does — https://{host}/settings/apps — so a link
// follows a self-managed host.
type Link struct {
	Label string `json:"label"`
	URL   string `json:"url"`
}

// Preset is a starting configuration for a known provider.
type Preset struct {
	ID    string `json:"id"`
	Label string `json:"label"`

	// Help says where in the provider's own console to find what the form
	// still asks for.
	Help string `json:"help,omitempty"`

	// Values are settings to fill in, keyed like Fields.
	Values map[string]string `json:"values,omitempty"`
}

// Field is one setting.
type Field struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Help  string `json:"help,omitempty"`

	// Type is "string", "int", "bool" or "select": how a form should ask for
	// it and how the value goes into the configuration's JSON. A select's value
	// is a string.
	Type string `json:"type"`

	// Options are what a "select" offers.
	Options []Option `json:"options,omitempty"`

	// Other lets a "select" take a value not among Options, typed in — a DNS
	// provider Pando does not name, say.
	Other bool `json:"other,omitempty"`

	// Multiline asks for a text area: a credential given as KEY=value lines.
	Multiline bool `json:"multiline,omitempty"`

	// List asks for any number of values of a "string" setting in one field:
	// each one typed is kept as it is entered, as a form sees fit — the
	// console's a chip. They are sent as one string, separated by commas, so
	// an adapter reads a list the same way whichever surface set it.
	List bool `json:"list,omitempty"`

	// ShownWhen hides the setting unless another setting has one of the
	// given values — DNS provider fields only when certificates use DNS. A
	// form that ignores it still works; it only shows more than it needs to.
	ShownWhen *Condition `json:"shown_when,omitempty"`

	Required bool `json:"required,omitempty"`

	// Advanced marks a setting most people never change: a form asks for it
	// under "Advanced settings" rather than beside the ones that matter, and
	// the CLI lists it under its own heading. It means less common, not
	// restricted — anyone who may configure the adapter may set it. An advanced
	// setting is never required, never a credential, and states its Default,
	// so leaving every one empty sets the adapter up (Validate).
	Advanced bool `json:"advanced,omitempty"`

	// Credential marks a secret such as an API key. It is sent in the create
	// request's write-only "credentials", stored encrypted, and never shown
	// again (R-190) — never in "config", which the database refuses it in.
	Credential bool `json:"credential,omitempty"`

	// Default is the value used when the setting is left empty — the
	// adapter's own default, stated so a form can show it rather than an
	// example that might be mistaken for it.
	Default string `json:"default,omitempty"`

	// Placeholder is an example value, for a setting with no default.
	Placeholder string `json:"placeholder,omitempty"`

	// Suggest is the value a form starts a new adapter's setting at, with
	// {key} standing for another setting's value: "pando.{zone}". It follows
	// that setting until the setting is edited, and is then the person's own.
	// Unlike Default it is sent as if typed; the adapter never applies it.
	Suggest string `json:"suggest,omitempty"`
}

// Option is one choice a "select" offers.
type Option struct {
	Value string `json:"value"`
	Label string `json:"label"`

	// Description says what choosing it means, for a short list shown as
	// radio buttons where the tradeoff should be visible.
	Description string `json:"description,omitempty"`
}

// Condition is a setting's value a form checks before showing another.
type Condition struct {
	Key    string   `json:"key"`
	Values []string `json:"values"`
}

// Validate checks what a kind says about its settings that a form relies on.
//
// An advanced setting is one a form puts out of the way, so it must be safe to
// leave empty: not required, and with its default stated, so someone who never
// opens "Advanced settings" can still see what they get. Not a credential
// either: the CLI asks for secrets as it adds an adapter, and asks only for the
// basic settings.
func (k KindInfo) Validate() error {
	seen := map[string]bool{}
	for _, f := range k.Fields {
		if seen[f.Key] {
			return fmt.Errorf("%s/%s has two settings named %q", k.Category, k.Kind, f.Key)
		}
		seen[f.Key] = true
		if f.List && (f.Type != "string" || f.Credential || f.Multiline) {
			return fmt.Errorf("%s/%s setting %q is a list: a list is a plain string setting, neither a credential nor multiline", k.Category, k.Kind, f.Key)
		}
		for _, m := range suggestRef.FindAllStringSubmatch(f.Suggest, -1) {
			if !k.hasField(m[1]) || m[1] == f.Key {
				return fmt.Errorf("%s/%s setting %q suggests from {%s}, which is not another of its settings", k.Category, k.Kind, f.Key, m[1])
			}
		}
		if !f.Advanced {
			continue
		}
		switch {
		case f.Required:
			return fmt.Errorf("%s/%s setting %q is both required and advanced: a required setting belongs among the basic ones", k.Category, k.Kind, f.Key)
		case f.Credential:
			return fmt.Errorf("%s/%s setting %q is a credential marked advanced: the CLI asks for credentials only among the basic settings", k.Category, k.Kind, f.Key)
		case f.Default == "" && f.Type != "bool":
			return fmt.Errorf("%s/%s setting %q is advanced and states no default: say what leaving it empty does", k.Category, k.Kind, f.Key)
		}
	}
	return k.validateSteps()
}

// suggestRef is a {key} in a Suggest.
var suggestRef = regexp.MustCompile(`\{([a-z0-9_]+)\}`)

func (k KindInfo) hasField(key string) bool {
	for _, f := range k.Fields {
		if f.Key == key {
			return true
		}
	}
	return false
}

// validateSteps checks that guided setup asks for every basic setting once, in
// an order that works: a setting, or a step, shown only for another setting's
// value comes after the step that asks for that value.
func (k KindInfo) validateSteps() error {
	if len(k.Steps) == 0 {
		return nil
	}
	where := fmt.Sprintf("%s/%s", k.Category, k.Kind)
	fields := map[string]Field{}
	for _, f := range k.Fields {
		fields[f.Key] = f
	}
	askedOn := map[string]int{} // field key -> index of the step asking it
	stepIDs := map[string]bool{}
	for i, st := range k.Steps {
		switch {
		case st.ID == "":
			return fmt.Errorf("%s step %d has no ID", where, i+1)
		case stepIDs[st.ID]:
			return fmt.Errorf("%s has two steps named %q", where, st.ID)
		case st.Label == "":
			return fmt.Errorf("%s step %q has no label: name it in a word or two for the list of steps", where, st.ID)
		case st.Title == "":
			return fmt.Errorf("%s step %q has no title: say what to do, or ask a question", where, st.ID)
		case len(st.Fields) == 0:
			return fmt.Errorf("%s step %q asks for no settings: fold its instructions into the step that uses them", where, st.ID)
		}
		for _, l := range st.Links {
			if l.Label == "" || l.URL == "" {
				return fmt.Errorf("%s step %q has a link without both a label and an address", where, st.ID)
			}
		}
		stepIDs[st.ID] = true
		for _, l := range st.Links {
			for _, m := range suggestRef.FindAllStringSubmatch(l.URL, -1) {
				if !k.hasField(m[1]) {
					return fmt.Errorf("%s step %q links with {%s}, which is not one of its settings", where, st.ID, m[1])
				}
			}
		}
		if c := st.ShownWhen; c != nil {
			if j, ok := askedOn[c.Key]; !ok || j >= i {
				return fmt.Errorf("%s step %q is shown for setting %q, which no earlier step asks for", where, st.ID, c.Key)
			}
		}
		for _, a := range st.Do {
			if a.Text == "" {
				return fmt.Errorf("%s step %q has an empty instruction", where, st.ID)
			}
		}
		for _, key := range st.Fields {
			f, ok := fields[key]
			switch {
			case !ok:
				return fmt.Errorf("%s step %q asks for %q, which is not one of its settings", where, st.ID, key)
			case f.Advanced:
				return fmt.Errorf("%s step %q asks for advanced setting %q: advanced settings are shown on the review, not on a step", where, st.ID, key)
			}
			if j, dup := askedOn[key]; dup {
				return fmt.Errorf("%s asks for setting %q on both step %q and step %q", where, key, k.Steps[j].ID, st.ID)
			}
			if c := f.ShownWhen; c != nil {
				if j, ok := askedOn[c.Key]; !ok || j > i {
					return fmt.Errorf("%s setting %q is shown for setting %q, which is not asked before it", where, key, c.Key)
				}
			}
			askedOn[key] = i
		}
	}
	for _, f := range k.Fields {
		if _, ok := askedOn[f.Key]; !ok && !f.Advanced {
			return fmt.Errorf("%s setting %q is on no step: every basic setting is asked on exactly one", where, f.Key)
		}
	}
	return nil
}
