//go:build !windows

package cli

import (
	"os"
	"os/signal"
	"syscall"
)

// notifyResize delivers a value each time the terminal changes size.
func notifyResize() chan os.Signal {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGWINCH)
	return ch
}
