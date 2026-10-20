package cli

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strconv"
	"time"

	"github.com/spf13/cobra"
)

// Signing in through the browser (R-406, design 06 §3.5).
//
// OAuth 2.0 for a native app (RFC 8252): the CLI makes a PKCE verifier (RFC
// 7636) and opens the console's approval page with only its SHA-256. The
// person signs in there however their account signs in — this is how an
// account from an identity provider gets a token at all — and approves. The
// browser brings a one-time code back to a port the CLI listens on, on
// 127.0.0.1 only, or the person pastes it; the CLI trades code and verifier
// for a token. Nothing but this process ever holds the verifier, so a code
// that goes astray signs nobody in.

// openBrowser opens an address in the person's browser. A variable so a test
// can stand in for the person.
//
// Each opener is named by its full path rather than looked up on PATH, which
// a writable directory early on it could answer instead. Where one is not at
// that path, the address is already on the screen to open by hand.
var openBrowser = func(address string) error {
	var c *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		c = exec.Command("/usr/bin/open", address)
	case "windows":
		c = exec.Command(`C:\Windows\System32\rundll32.exe`, "url.dll,FileProtocolHandler", address)
	default:
		c = exec.Command("/usr/bin/xdg-open", address)
	}
	return c.Start()
}

// browserWait is how long the CLI waits for the browser: twice the time an
// approval stays good, so a slow sign-in at an identity provider still has
// its 5 minutes once it is approved.
var browserWait = 10 * time.Minute

// errCanceled is the person pressing Cancel on the approval page.
var errCanceled = errors.New("sign-in was canceled in the browser, so nothing was stored. Run pando login again to sign in")

// randomString is n random bytes, base64url without padding.
func randomString(n int) (string, error) {
	raw := make([]byte, n)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// approvalAddress is the console's page that approves this sign-in.
func approvalAddress(server string, q url.Values) string {
	return server + "/admin/cli?" + q.Encode()
}

func browserLogin(cmd *cobra.Command, server string, noBrowser bool) error {
	verifier, err := randomString(32)
	if err != nil {
		return err
	}
	sum := sha256.Sum256([]byte(verifier))
	q := url.Values{
		"code_challenge":        {base64.RawURLEncoding.EncodeToString(sum[:])},
		"code_challenge_method": {"S256"},
		"name":                  {tokenName()},
	}

	var code string
	if !noBrowser {
		ln, lerr := net.Listen("tcp", "127.0.0.1:0")
		if lerr != nil {
			fmt.Fprintf(cmd.ErrOrStderr(), "Could not listen for the browser on 127.0.0.1 (%v), so you will paste the code instead.\n", lerr)
			noBrowser = true
		} else if code, err = viaLoopback(cmd, server, ln, q); err != nil {
			return err
		}
	}
	if noBrowser {
		if code, err = viaPaste(cmd, server, q); err != nil {
			return err
		}
	}

	anon := &Client{BaseURL: server, HTTP: &http.Client{Timeout: time.Minute}}
	var issued struct {
		Secret   string `json:"secret"`
		Username string `json:"username"`
	}
	if err := anon.Do("POST", "/cli-sign-ins/token",
		map[string]string{"code": code, "code_verifier": verifier}, &issued); err != nil {
		return err
	}
	return signedIn(cmd, server, issued.Secret, issued.Username)
}

// viaPaste asks for the code the approval page shows.
func viaPaste(cmd *cobra.Command, server string, q url.Values) (string, error) {
	fmt.Fprintf(cmd.ErrOrStderr(),
		"Open this address in a browser signed in to Pando, on any computer, and approve:\n\n  %s\n\n",
		approvalAddress(server, q))
	code, err := prompt(cmd, "Then paste the code it shows: ")
	if err != nil {
		return "", err
	}
	if code == "" {
		return "", errors.New("no code was pasted, so nothing was stored. Run pando login --no-browser again")
	}
	return code, nil
}

// callback is what reached the loopback address: a code, or a cancel.
type callback struct {
	code     string
	canceled bool
}

// viaLoopback opens the approval page and waits for the browser to bring the
// code to ln.
func viaLoopback(cmd *cobra.Command, server string, ln net.Listener, q url.Values) (string, error) {
	defer func() { _ = ln.Close() }()

	state, err := randomString(24)
	if err != nil {
		return "", err
	}
	q.Set("port", strconv.Itoa(ln.Addr().(*net.TCPAddr).Port))
	q.Set("state", state)
	address := approvalAddress(server, q)

	got := make(chan callback, 1)
	srv := &http.Server{
		ReadHeaderTimeout: 10 * time.Second,
		Handler:           loopbackHandler(server, state, got),
	}
	go func() { _ = srv.Serve(ln) }()
	defer func() { _ = srv.Close() }()

	fmt.Fprintf(cmd.ErrOrStderr(), "Opening Pando in your browser to sign in. If it does not open, go to:\n\n  %s\n\n", address)
	if err := openBrowser(address); err != nil {
		fmt.Fprintf(cmd.ErrOrStderr(), "Could not open a browser (%v). Open the address above yourself, or run pando login --no-browser.\n", err)
	}
	fmt.Fprintln(cmd.ErrOrStderr(), "Waiting for you to approve this CLI in the browser…")

	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case c := <-got:
		if c.canceled {
			return "", errCanceled
		}
		return c.code, nil
	case <-time.After(browserWait):
		return "", fmt.Errorf("no approval came back from the browser within %s, so nothing was stored. "+
			"Run pando login again, or pando login --no-browser to paste the code instead", browserWait)
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// loopbackHandler answers the browser's one visit: a code or a cancel for
// this sign-in's state. Anything else — another page probing the port, a
// stale tab — is not found, and the CLI keeps waiting. The browser is then
// sent back to the console to say what happened, so what the person sees is
// Pando's page rather than one this process draws.
func loopbackHandler(server, state string, got chan<- callback) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		v := r.URL.Query()
		if r.URL.Path != "/callback" || v.Get("state") != state {
			http.NotFound(w, r)
			return
		}
		var c callback
		switch {
		case v.Get("error") == "access_denied":
			c.canceled = true
		case v.Get("code") != "":
			c.code = v.Get("code")
		default:
			http.NotFound(w, r)
			return
		}
		select {
		case got <- c:
		default:
			// Already answered: a reload of the redirect.
		}
		outcome := "signed_in"
		if c.canceled {
			outcome = "canceled"
		}
		http.Redirect(w, r, server+"/admin/cli?"+outcome+"=1", http.StatusSeeOther)
	})
}
