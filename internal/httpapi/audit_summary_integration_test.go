//go:build integration

package httpapi_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestR379_TheAuditLogReadsAsSentencesThroughTheAPI asserts R-379's summary
// through GET /audit: each event carries its sentence and the app's name, the
// log narrows by outcome and by text, and an outcome that is not one is
// refused rather than ignored.
func TestR379_TheAuditLogReadsAsSentencesThroughTheAPI(t *testing.T) {
	i := newInstall(t)
	admin := i.admin()
	id := i.createApp(admin, "crewmate")

	var page struct {
		Events []struct {
			Action  string `json:"action"`
			AppID   string `json:"app_id"`
			AppName string `json:"app_name"`
			Summary string `json:"summary"`
		} `json:"events"`
	}
	got := i.do(admin, http.MethodGet, "/audit?action=app.create&q=crewmate", nil)
	require.Equal(t, http.StatusOK, got.Code, got.String())
	got.JSON(t, &page)
	require.Len(t, page.Events, 1)
	require.Equal(t, id, page.Events[0].AppID)
	require.Equal(t, "crewmate", page.Events[0].AppName)
	require.Equal(t, "Created crewmate", page.Events[0].Summary)

	got = i.do(admin, http.MethodGet, "/audit?action=app.create&outcome=denied", nil)
	require.Equal(t, http.StatusOK, got.Code, got.String())
	page.Events = nil
	got.JSON(t, &page)
	require.Empty(t, page.Events)

	got = i.do(admin, http.MethodGet, "/audit?outcome=maybe", nil)
	require.Equal(t, http.StatusBadRequest, got.Code, got.String())
	require.Contains(t, got.String(), "success, denied or failed")
}
