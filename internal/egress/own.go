package egress

import (
	"bufio"
	"encoding/binary"
	"encoding/hex"
	"io"
	"net"
	"net/netip"
	"os"
	"slices"
	"strings"
)

// OwnAddresses lists what the gateway refuses as its own beyond loopback
// (Gateway.Own): the addresses of its network interfaces, and every router
// its routing table sends traffic through. On a Docker bridge network the
// router is the bridge's address on the host, so a connection to it reaches
// the host's own services rather than anywhere the app's rules describe.
//
// Read from the gateway's own network namespace when it starts. What cannot
// be read is left out: the rules still apply to it.
func OwnAddresses() []netip.Addr {
	var out []netip.Addr
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			if p, err := netip.ParsePrefix(a.String()); err == nil {
				out = append(out, p.Addr())
			}
		}
	}
	out = append(out, readRoutes("/proc/net/route", routersV4)...)
	out = append(out, readRoutes("/proc/net/ipv6_route", routersV6)...)
	return normalizeOwn(out)
}

func readRoutes(path string, parse func(io.Reader) []netip.Addr) []netip.Addr {
	f, err := os.Open(path) //nolint:gosec // G304: a fixed path under /proc.
	if err != nil {
		return nil
	}
	defer func() { _ = f.Close() }()
	return parse(f)
}

// normalizeOwn is addrs without zones, mapping, loopback, the unspecified
// address or duplicates: the form decideAddr compares against.
func normalizeOwn(addrs []netip.Addr) []netip.Addr {
	out := make([]netip.Addr, 0, len(addrs))
	for _, a := range addrs {
		a = a.WithZone("").Unmap()
		if !a.IsValid() || a.IsLoopback() || a.IsUnspecified() || slices.Contains(out, a) {
			continue
		}
		out = append(out, a)
	}
	return out
}

// routersV4 reads the gateway column of /proc/net/route: eight hex digits,
// the address in host (little-endian) byte order.
func routersV4(r io.Reader) []netip.Addr {
	var out []netip.Addr
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 3 || len(f[2]) != 8 {
			continue
		}
		b, err := hex.DecodeString(f[2])
		if err != nil {
			continue
		}
		var a [4]byte
		binary.BigEndian.PutUint32(a[:], binary.LittleEndian.Uint32(b))
		if ip := netip.AddrFrom4(a); !ip.IsUnspecified() {
			out = append(out, ip)
		}
	}
	return out
}

// routersV6 reads the next-hop column of /proc/net/ipv6_route: 32 hex
// digits in network byte order.
func routersV6(r io.Reader) []netip.Addr {
	var out []netip.Addr
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 5 || len(f[4]) != 32 {
			continue
		}
		b, err := hex.DecodeString(f[4])
		if err != nil {
			continue
		}
		if ip := netip.AddrFrom16([16]byte(b)); !ip.IsUnspecified() {
			out = append(out, ip)
		}
	}
	return out
}
