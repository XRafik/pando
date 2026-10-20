//go:build !windows

package cli

import (
	"context"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// A terminal resize arrives as SIGWINCH, and each one sends the size again
// until the session ends.
func TestATerminalResizeSendsTheSizeAgain(t *testing.T) {
	resized := notifyResize()
	require.NotNil(t, resized)

	ctx, cancel := context.WithCancel(context.Background())
	sent := make(chan struct{}, 1)
	done := make(chan struct{})
	go func() {
		forwardResizes(ctx, resized, func() { sent <- struct{}{} })
		close(done)
	}()

	require.NoError(t, syscall.Kill(syscall.Getpid(), syscall.SIGWINCH))
	select {
	case <-sent:
	case <-time.After(5 * time.Second):
		t.Fatal("a resize did not send the size")
	}

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the session ended and resizes were still being watched")
	}
}
