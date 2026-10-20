package cli

import "time"

// StandInForBrowser replaces opening a browser for one test: f is given the
// address pando login would have opened.
func StandInForBrowser(f func(address string) error) (restore func()) {
	was := openBrowser
	openBrowser = f
	return func() { openBrowser = was }
}

// WaitForBrowser shortens how long pando login waits for the browser.
func WaitForBrowser(d time.Duration) (restore func()) {
	was := browserWait
	browserWait = d
	return func() { browserWait = was }
}
