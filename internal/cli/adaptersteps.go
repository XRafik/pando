package cli

import (
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"
	"golang.org/x/term"
)

// interactive is whether the command reads from a person at a terminal.
func interactive(cmd *cobra.Command) bool {
	f, ok := cmd.InOrStdin().(*os.File)
	return ok && term.IsTerminal(int(f.Fd()))
}

// ref is a {key} in a suggestion or a link.
var ref = regexp.MustCompile(`\{([a-z0-9_]+)\}`)

// marks are step text's two marks, **bold** and `code`; a terminal shows
// neither, only the words.
var marks = regexp.MustCompile("\\*\\*([^*]+)\\*\\*|`([^`]+)`")

func plain(text string) string {
	return marks.ReplaceAllString(text, "$1$2")
}

// effective is a setting as the adapter will read it: what was given, or its
// default.
func effective(info *kindInfo, values map[string]string, key string) string {
	if v := values[key]; v != "" {
		return v
	}
	for _, f := range info.Fields {
		if f.Key == key {
			return f.Default
		}
	}
	return ""
}

func shown(info *kindInfo, values map[string]string, c *condition) bool {
	if c == nil {
		return true
	}
	v := effective(info, values, c.Key)
	for _, want := range c.Values {
		if v == want {
			return true
		}
	}
	return false
}

// fill replaces each {key} with that setting's value, or reports one empty.
func fill(info *kindInfo, values map[string]string, template string) (string, bool) {
	ok := true
	out := ref.ReplaceAllStringFunc(template, func(m string) string {
		v := effective(info, values, m[1:len(m)-1])
		if v == "" {
			ok = false
		}
		return v
	})
	return out, ok
}

// walkSteps asks for each setting of each step that applies and --set did not
// give, showing the step's instructions first. Answers go into values, and
// secrets into credentials; it returns the keys it asked for.
func walkSteps(cmd *cobra.Command, info *kindInfo, values, credentials map[string]string) (map[string]bool, error) {
	out := cmd.ErrOrStderr()
	fields := map[string]kindField{}
	for _, f := range info.Fields {
		fields[f.Key] = f
	}
	asked := map[string]bool{}
	for i, st := range info.Steps {
		if !shown(info, values, st.ShownWhen) {
			continue
		}
		var pending []kindField
		for _, key := range st.Fields {
			f, ok := fields[key]
			if _, given := values[key]; ok && !given && shown(info, values, f.ShownWhen) {
				pending = append(pending, f)
			}
		}
		if len(pending) == 0 {
			continue
		}
		fmt.Fprintf(out, "\n%s (step %d of %d)\n", st.Title, i+1, len(info.Steps))
		printInstructions(out, info, values, st)
		for _, f := range pending {
			asked[f.Key] = true
			if err := ask(cmd, info, values, credentials, f); err != nil {
				return nil, err
			}
		}
	}
	return asked, nil
}

func printInstructions(out io.Writer, info *kindInfo, values map[string]string, st kindStep) {
	for n, a := range st.Do {
		fmt.Fprintf(out, "  %d. %s\n", n+1, plain(a.Text))
		if a.Table != nil {
			w := tabwriter.NewWriter(out, 0, 2, 2, ' ', 0)
			fmt.Fprintln(w, "     "+strings.Join(a.Table.Columns, "\t"))
			for _, row := range a.Table.Rows {
				fmt.Fprintln(w, "     "+strings.Join(row, "\t"))
			}
			_ = w.Flush()
		}
	}
	for _, l := range st.Links {
		if url, ok := fill(info, values, l.URL); ok {
			fmt.Fprintf(out, "  %s: %s\n", l.Label, url)
		}
	}
}

// ask asks for one setting. Enter keeps what it shows in brackets: its
// suggestion, filled in from what was answered before it, or its default.
func ask(cmd *cobra.Command, info *kindInfo, values, credentials map[string]string, f kindField) error {
	if f.Credential {
		v, err := promptSecret(cmd, f.Label+": ")
		if err != nil {
			return err
		}
		if v != "" {
			credentials[f.Key] = v
		}
		return nil
	}
	start := f.Default
	if f.Suggest != "" {
		if s, ok := fill(info, values, f.Suggest); ok {
			start = s
		}
	}
	if len(f.Options) > 0 {
		for n, o := range f.Options {
			fmt.Fprintf(cmd.ErrOrStderr(), "  %d) %s\n", n+1, o.Label)
		}
	}
	label := f.Label
	if start != "" {
		label += " [" + start + "]"
	}
	v, err := prompt(cmd, label+": ")
	if err != nil && err != io.EOF {
		return err
	}
	if len(f.Options) > 0 && v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= len(f.Options) {
			v = f.Options[n-1].Value
		}
	}
	if v == "" && f.Suggest != "" {
		v = start
	}
	if v != "" {
		values[f.Key] = v
	}
	return nil
}
