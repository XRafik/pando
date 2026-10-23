package update

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/google/go-containerregistry/pkg/name"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	in_toto "github.com/in-toto/attestation/go/v1"
	"github.com/sigstore/sigstore-go/pkg/bundle"
	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/tuf"
	"github.com/sigstore/sigstore-go/pkg/verify"
)

// What a release's signatures must say about who made them (R-357, R-363):
// GitHub's OIDC provider, vouching for a workflow in Pando's repository on its
// main branch or a version tag. The same identities docs/releasing.md tells a
// person to check with cosign by hand.
const (
	Issuer          = "https://token.actions.githubusercontent.com"
	ImageIdentity   = `^https://github\.com/(bemeek-io|trypando)/pando/\.github/workflows/image\.yml@refs/(heads/main|tags/v)`
	ReleaseIdentity = `^https://github\.com/(bemeek-io|trypando)/pando/\.github/workflows/release\.yml@refs/(heads/main|tags/v)`
)

// bundleType is how cosign 3 attaches a signature to an image: a Sigstore
// bundle, as an OCI 1.1 referrer of the image's index digest.
const (
	bundleType      = "application/vnd.dev.sigstore.bundle.v0.3+json"
	signPredicate   = "https://sigstore.dev/cosign/sign/v1"
	maxBundleLength = 1 << 20
)

// VersionAnnotation is the annotation the image workflow signs with each
// image (`cosign sign -a`), naming the version it was built as. A signature
// covers a digest, not a tag, so without it any image the workflow ever
// signed would pass for any version a tag was pointed at (R-357).
const VersionAnnotation = "org.opencontainers.image.version"

// TrustedRoot fetches Sigstore's public-good trusted root through its TUF
// repository, caching under dir. The root it starts from is embedded in
// sigstore-go, so a compromised mirror cannot substitute one.
func TrustedRoot(ctx context.Context, dir string) (root.TrustedMaterial, error) {
	opts := tuf.DefaultOptions().WithContext(ctx)
	if dir != "" {
		opts = opts.WithCachePath(dir)
	}
	tr, err := root.FetchTrustedRootWithOptions(opts)
	if err != nil {
		return nil, fmt.Errorf("could not fetch Sigstore's trusted root: %w", err)
	}
	return tr, nil
}

// ImageVerifier checks a released image's signature before Pando runs it
// (R-357).
type ImageVerifier struct {
	// Repository is the image, without a tag: index.docker.io/trypando/pando.
	Repository string
	Trusted    func(ctx context.Context) (root.TrustedMaterial, error)
	Remote     []remote.Option
}

// Verify resolves version to its index digest, fetches the signature attached
// to that digest and checks it. It returns the digest, which is what is run
// from then on: a tag resolved again later could name something else.
func (v *ImageVerifier) Verify(ctx context.Context, version string) (string, error) {
	opts := append([]remote.Option{remote.WithContext(ctx)}, v.Remote...)
	tag, err := name.NewTag(v.Repository+":"+strings.TrimPrefix(version, "v"), name.StrictValidation)
	if err != nil {
		return "", err
	}
	desc, err := remote.Head(tag, opts...)
	if err != nil {
		return "", fmt.Errorf("could not find %s: %w", tag, err)
	}
	digest := tag.Context().Digest(desc.Digest.String())

	raw, err := signatureBundle(digest, opts)
	if err != nil {
		return "", err
	}
	tm, err := v.Trusted(ctx)
	if err != nil {
		return "", err
	}
	if err := VerifyImageBundle(tm, raw, desc.Digest, version); err != nil {
		return "", err
	}
	return desc.Digest.String(), nil
}

func signatureBundle(digest name.Digest, opts []remote.Option) ([]byte, error) {
	idx, err := remote.Referrers(digest, opts...)
	if err != nil {
		return nil, fmt.Errorf("could not list the signatures of %s: %w", digest, err)
	}
	m, err := idx.IndexManifest()
	if err != nil {
		return nil, err
	}
	for _, d := range m.Manifests {
		if d.ArtifactType != bundleType {
			continue
		}
		sig, err := remote.Image(digest.Context().Digest(d.Digest.String()), opts...)
		if err != nil {
			return nil, err
		}
		layers, err := sig.Layers()
		if err != nil || len(layers) == 0 {
			return nil, fmt.Errorf("the signature attached to %s has no content", digest)
		}
		rc, err := layers[0].Compressed()
		if err != nil {
			return nil, err
		}
		defer func() { _ = rc.Close() }()
		return io.ReadAll(io.LimitReader(rc, maxBundleLength))
	}
	return nil, fmt.Errorf("%s has no signature attached; Pando runs only images its release workflow signed", digest)
}

// VerifyImageBundle checks a cosign signature bundle against an image's index
// digest and the image workflow's identity, and that what was signed names
// version: the image was built as that version, not merely signed once.
func VerifyImageBundle(tm root.TrustedMaterial, raw []byte, digest v1.Hash, version string) error {
	sum, err := hex.DecodeString(digest.Hex)
	if err != nil {
		return err
	}
	res, err := verifyBundle(tm, raw, ImageIdentity, verify.WithArtifactDigest(digest.Algorithm, sum))
	if err != nil {
		return err
	}
	if res.Statement == nil || res.Statement.GetPredicateType() != signPredicate {
		return fmt.Errorf("the signature on %s is not a cosign image signature", digest)
	}
	return signedVersion(res.Statement, digest, version)
}

// signedVersion checks that the signed statement names version for digest.
func signedVersion(st *in_toto.Statement, digest v1.Hash, version string) error {
	want := strings.TrimPrefix(version, "v")
	for _, sub := range st.GetSubject() {
		if sub.GetDigest()[digest.Algorithm] != digest.Hex {
			continue
		}
		got := sub.GetAnnotations().GetFields()[VersionAnnotation].GetStringValue()
		if got == "" {
			return fmt.Errorf("the signature on %s does not name the version it was built as, so it cannot be told apart from an older image", digest)
		}
		if strings.TrimPrefix(got, "v") != want {
			return fmt.Errorf("the image at %s was signed as %s, not %s", digest, got, want)
		}
		return nil
	}
	return fmt.Errorf("the signature on %s does not name that image", digest)
}

// VerifyChecksums checks a release's checksums.txt against its signature
// bundle and the release workflow's identity (R-363).
func VerifyChecksums(tm root.TrustedMaterial, checksums, raw []byte) error {
	_, err := verifyBundle(tm, raw, ReleaseIdentity, verify.WithArtifact(bytes.NewReader(checksums)))
	return err
}

func verifyBundle(tm root.TrustedMaterial, raw []byte, sanRegex string, artifact verify.ArtifactPolicyOption) (*verify.VerificationResult, error) {
	var b bundle.Bundle
	if err := json.Unmarshal(raw, &b); err != nil {
		return nil, fmt.Errorf("the signature is not a Sigstore bundle: %w", err)
	}
	id, err := verify.NewShortCertificateIdentity(Issuer, "", "", sanRegex)
	if err != nil {
		return nil, err
	}
	v, err := verify.NewVerifier(tm,
		verify.WithSignedCertificateTimestamps(1),
		verify.WithTransparencyLog(1),
		verify.WithObserverTimestamps(1))
	if err != nil {
		return nil, err
	}
	res, err := v.Verify(&b, verify.NewPolicy(artifact, verify.WithCertificateIdentity(id)))
	if err != nil {
		return nil, fmt.Errorf("the signature does not verify: %w", err)
	}
	return res, nil
}
