package cli

import "os"

// notifyResize is nil on Windows, which has no signal for a console resize. The
// size is still sent once when the session opens.
func notifyResize() chan os.Signal { return nil }
