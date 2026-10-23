package update

import (
	"strings"
	"testing"

	v1 "github.com/google/go-containerregistry/pkg/v1"
	in_toto "github.com/in-toto/attestation/go/v1"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/structpb"
)

// TestR357_ASignedImageIsRunOnlyAsTheVersionItWasSignedAs asserts that a
// signature binds an image to the version it was built as: a genuinely
// signed older image under a newer version's tag is refused.
func TestR357_ASignedImageIsRunOnlyAsTheVersionItWasSignedAs(t *testing.T) {
	digest, err := v1.NewHash("sha256:" + strings.Repeat("a", 64))
	require.NoError(t, err)
	statement := func(digestHex string, annotations map[string]any) *in_toto.Statement {
		t.Helper()
		a, err := structpb.NewStruct(annotations)
		require.NoError(t, err)
		return &in_toto.Statement{Subject: []*in_toto.ResourceDescriptor{{
			Digest: map[string]string{"sha256": digestHex}, Annotations: a,
		}}}
	}
	named := func(v string) *in_toto.Statement {
		return statement(digest.Hex, map[string]any{VersionAnnotation: v})
	}

	require.NoError(t, signedVersion(named("0.14.0"), digest, "0.14.0"))
	require.NoError(t, signedVersion(named("0.14.0"), digest, "v0.14.0"), "the v is not part of the version")
	require.ErrorContains(t, signedVersion(named("0.13.0"), digest, "0.14.0"), "signed as 0.13.0, not 0.14.0")
	require.ErrorContains(t, signedVersion(statement(digest.Hex, nil), digest, "0.14.0"), "does not name the version")
	require.ErrorContains(t, signedVersion(statement(strings.Repeat("b", 64), map[string]any{VersionAnnotation: "0.14.0"}), digest, "0.14.0"),
		"does not name that image")
}
