package egress

import (
	"net/http"
	"net/netip"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestR185_AnIPv6ZoneDoesNotGetPastARange asserts R-185 and R-181: an
// address written with an IPv6 zone is matched, and judged private, as the
// address without it. netip.Prefix.Contains is false for every zoned address,
// so a zone would otherwise slip past every range entry.
func TestR185_AnIPv6ZoneDoesNotGetPastARange(t *testing.T) {
	t.Parallel()
	e, err := Parse("64:ff9b::/96")
	require.NoError(t, err)
	require.True(t, e.MatchesAddr(netip.MustParseAddr("64:ff9b::a9fe:a9fe%x"), 80))

	deny := compile(t, Rules{Layers: []Layer{{Mode: Denylist, List: []string{"fec0::/10"}}}})
	require.False(t, deny.Allows("x.example", 80, addr("fec0::1%eth0")).Allowed)

	blocked := compile(t, Rules{BlockPrivate: true})
	d := blocked.Allows("64:ff9b::a9fe:a9fe%x", 80, addr("64:ff9b::a9fe:a9fe%x"))
	require.False(t, d.Allowed)
	require.Equal(t, "64:ff9b::a9fe:a9fe is a private address, and private addresses are blocked", d.Reason)
}

// TestR185_TheGatewayRefusesADestinationWithAZone asserts R-185: a CONNECT or
// plain request to an address with an IPv6 zone is refused before anything is
// decided or dialed, whatever the rules allow.
func TestR185_TheGatewayRefusesADestinationWithAZone(t *testing.T) {
	t.Parallel()
	h := newHarness(t, Rules{Layers: []Layer{{Mode: Denylist, List: []string{"64:ff9b::/96", "fec0::/10"}}}})

	_, _, resp := h.connect("[64:ff9b::a9fe:a9fe%25x]:80")
	require.Equal(t, http.StatusBadRequest, resp.StatusCode)
	require.Contains(t, body(t, resp), "names a network interface")

	// A bare % is not a valid Host at all; the server refuses it first.
	_, _, resp = h.connect("[fec0::1%eth0]:443")
	require.Equal(t, http.StatusBadRequest, resp.StatusCode)
	_ = resp.Body.Close()

	// Go's client drops the zone from what it sends, so this one arrives as
	// fec0::1 and the denylist refuses it.
	res, err := h.client().Get("http://[fec0::1%25eth0]/")
	require.NoError(t, err)
	require.Equal(t, http.StatusForbidden, res.StatusCode)
	_ = res.Body.Close()

	_, _, err = splitTarget("[fe80::1%eth0]", 80)
	require.ErrorContains(t, err, "names a network interface")
	require.Empty(t, h.dials())
}

// TestR180_TheGatewayNeverConnectsToTheHostItRunsOn asserts R-180: the
// router of the gateway's outbound network, which on a bridge is the host,
// and the gateway's own interface addresses are refused whatever the rules
// say, private-range blocking off included.
func TestR180_TheGatewayNeverConnectsToTheHostItRunsOn(t *testing.T) {
	t.Parallel()
	h := newHarness(t, Rules{Layers: []Layer{{Mode: Allowlist, List: []string{"*"}}}})
	h.gw.Own = normalizeOwn([]netip.Addr{
		addr("10.213.0.17"), addr("::ffff:10.213.0.9"), addr("127.0.0.1"), addr("10.213.0.17"),
	})
	require.Equal(t, []netip.Addr{addr("10.213.0.17"), addr("10.213.0.9")}, h.gw.Own)
	h.route("host.example", "10.213.0.17", 22, echoServer(t))
	h.route("other.example", "10.0.0.5", 22, echoServer(t))

	for _, target := range []string{"10.213.0.17:22", "host.example:22", "10.213.0.9:3128"} {
		_, _, resp := h.connect(target)
		require.Equal(t, http.StatusForbidden, resp.StatusCode, target)
		require.Contains(t, body(t, resp), "the gateway's own address", target)
	}
	_, _, resp := h.connect("other.example:22")
	require.Equal(t, http.StatusOK, resp.StatusCode)
	_ = resp.Body.Close()
	require.Equal(t, []string{"10.0.0.5:22"}, h.dials())
}

// TestR180_TheGatewayReadsItsRoutersFromTheRoutingTable asserts that the
// routers OwnAddresses refuses are read from the kernel's routing tables, in
// the byte order each one is written in.
func TestR180_TheGatewayReadsItsRoutersFromTheRoutingTable(t *testing.T) {
	t.Parallel()
	v4 := "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n" +
		"eth1\t00000000\t01D50D0A\t0003\t0\t0\t0\t00000000\t0\t0\t0\n" +
		"eth1\t10D50D0A\t00000000\t0001\t0\t0\t0\tF8FFFFFF\t0\t0\t0\n" +
		"bad\t00000000\tZZZZZZZZ\t0003\n"
	require.Equal(t, []netip.Addr{addr("10.13.213.1")}, routersV4(strings.NewReader(v4)))

	v6 := "00000000000000000000000000000000 00 00000000000000000000000000000000 00 fd000000000000000000000000000001 00000400 00000001 00000000 00000003 eth1\n" +
		"fd000000000000000000000000000000 40 00000000000000000000000000000000 00 00000000000000000000000000000000 00000100 00000001 00000000 00000001 eth1\n" +
		"short line\n"
	require.Equal(t, []netip.Addr{addr("fd00::1")}, routersV6(strings.NewReader(v6)))

	require.Nil(t, readRoutes("/nonexistent/route", routersV4))
	for _, a := range OwnAddresses() {
		require.False(t, a.IsLoopback() || a.IsUnspecified() || a.Zone() != "", a)
	}
}
