package httpapi

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/trypando/pando/internal/errs"
)

// readAll is a handler that reads its whole body the way most handlers do,
// answering with how much it read or with the error.
func readAll(limit int64) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if limit > 0 {
			allowBody(r, limit, 0)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			Error(w, r, errs.Wrap(errs.ValidInvalid, "The request body could not be read.", err))
			return
		}
		JSON(w, http.StatusOK, map[string]int{"read": len(body)})
	})
}

func post(t *testing.T, h http.Handler, body io.Reader) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/apps", body)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// TestR411_ARequestBodyIsBoundedInSize asserts R-411: a body over the default
// limit is refused with a message saying so, a body at the limit is read
// whole, and a route that raises the limit for itself reads more.
func TestR411_ARequestBodyIsBoundedInSize(t *testing.T) {
	h := boundBodies(readAll(0))

	rec := post(t, h, bytes.NewReader(make([]byte, defaultBodyLimit)))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"read": 8388608}`, rec.Body.String())

	rec = post(t, h, bytes.NewReader(make([]byte, defaultBodyLimit+1)))
	require.Equal(t, http.StatusBadRequest, rec.Code)
	var envelope struct {
		Message string `json:"message"`
		Remedy  string `json:"remedy"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &envelope), rec.Body.String())
	require.Contains(t, envelope.Message, "larger than 8 MB")
	require.NotEmpty(t, envelope.Remedy)

	// A body with no length declared is held to the same limit.
	rec = post(t, h, io.MultiReader(strings.NewReader("x"), bytes.NewReader(make([]byte, defaultBodyLimit))))
	require.Equal(t, http.StatusBadRequest, rec.Code)

	raised := boundBodies(readAll(defaultBodyLimit * 2))
	rec = post(t, raised, bytes.NewReader(make([]byte, defaultBodyLimit+1)))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	// No body at all passes through untouched.
	rec = post(t, h, http.NoBody)
	require.Equal(t, http.StatusOK, rec.Code)
}

// TestR411_ABodyThatStallsIsRefused asserts R-411: a body that stops arriving
// fails the read rather than holding the handler, and once the body has been
// read the response may take as long as it takes.
func TestR411_ABodyThatStallsIsRefused(t *testing.T) {
	idle := bodyIdleTimeout
	bodyIdleTimeout = 200 * time.Millisecond
	t.Cleanup(func() { bodyIdleTimeout = idle })

	srv := httptest.NewServer(boundBodies(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.ReadAll(r.Body); err != nil {
			Error(w, r, errs.Wrap(errs.ValidInvalid, "The request body could not be read.", err))
			return
		}
		// Slower than the idle limit: a response that streams is not cut.
		time.Sleep(3 * bodyIdleTimeout)
		JSON(w, http.StatusOK, map[string]bool{"ok": true})
	})))
	t.Cleanup(srv.Close)

	t.Run("a stalled body fails", func(t *testing.T) {
		pr, pw := io.Pipe()
		t.Cleanup(func() { _ = pw.Close() })
		go func() { _, _ = pw.Write([]byte("{")) }()

		req, err := http.NewRequest(http.MethodPost, srv.URL, pr)
		require.NoError(t, err)
		start := time.Now()
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			_ = resp.Body.Close()
			require.NotEqual(t, http.StatusOK, resp.StatusCode)
		}
		require.Less(t, time.Since(start), 5*time.Second)
	})

	t.Run("a complete body is answered however long the answer takes", func(t *testing.T) {
		resp, err := http.Post(srv.URL, "application/json", strings.NewReader(`{}`))
		require.NoError(t, err)
		defer func() { _ = resp.Body.Close() }()
		require.Equal(t, http.StatusOK, resp.StatusCode)
	})
}

// TestR411_ABodyRefusedForItsSizeStaysRefused asserts a body that has ended
// keeps answering the same way when read again.
func TestR411_ABodyRefusedForItsSizeStaysRefused(t *testing.T) {
	b := &boundedBody{
		body:  io.NopCloser(strings.NewReader("0123456789")),
		rc:    http.NewResponseController(httptest.NewRecorder()),
		limit: 4,
	}
	buf := make([]byte, 16)
	n, err := b.Read(buf)
	require.Equal(t, 4, n)
	var tooBig *http.MaxBytesError
	require.ErrorAs(t, err, &tooBig)
	_, err = b.Read(buf)
	require.ErrorAs(t, err, &tooBig)
	require.NoError(t, b.Close())

	done := &boundedBody{body: io.NopCloser(strings.NewReader("")), rc: http.NewResponseController(httptest.NewRecorder()), limit: 4}
	_, err = done.Read(buf)
	require.ErrorIs(t, err, io.EOF)
	_, err = done.Read(buf)
	require.ErrorIs(t, err, io.EOF)
}

// TestR411_ABodyLeftUnreadCannotHoldTheConnection asserts R-411 after the
// handler: a body the handler did not read, sent partly and then stalled, does
// not hold the server draining it, and a handler that closes its body and then
// takes its time still answers.
func TestR411_ABodyLeftUnreadCannotHoldTheConnection(t *testing.T) {
	idle := bodyIdleTimeout
	bodyIdleTimeout = 200 * time.Millisecond
	t.Cleanup(func() { bodyIdleTimeout = idle })

	srv := httptest.NewServer(boundBodies(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/close" {
			buf := make([]byte, 4)
			_, _ = r.Body.Read(buf)
			_ = r.Body.Close()
			time.Sleep(3 * bodyIdleTimeout)
		}
		w.WriteHeader(http.StatusNoContent)
	})))
	t.Cleanup(srv.Close)

	for _, path := range []string{"/", "/close"} {
		t.Run(path, func(t *testing.T) {
			conn, err := net.Dial("tcp", srv.Listener.Addr().String())
			require.NoError(t, err)
			t.Cleanup(func() { _ = conn.Close() })
			_, err = fmt.Fprintf(conn, "POST %s HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n0123456789", path)
			require.NoError(t, err)

			require.NoError(t, conn.SetReadDeadline(time.Now().Add(5*time.Second)))
			resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
			require.NoError(t, err)
			require.Equal(t, http.StatusNoContent, resp.StatusCode)

			// The server gives up on the rest of the body and closes the
			// connection, well before the client's own deadline.
			start := time.Now()
			_, err = io.ReadAll(conn)
			require.NoError(t, err, "the server closed the connection")
			require.Less(t, time.Since(start), 4*time.Second)
		})
	}
}
