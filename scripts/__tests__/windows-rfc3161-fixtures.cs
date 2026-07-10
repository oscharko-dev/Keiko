#nullable enable

using System;
using System.Formats.Asn1;
using System.Security.Cryptography;
using System.Security.Cryptography.Pkcs;
using System.Security.Cryptography.X509Certificates;

public sealed class WindowsRfc3161Fixture
{
    public byte[] Cms { get; init; } = Array.Empty<byte>();
    public X509Certificate2 TrustRoot { get; init; } = null!;
}

public static class WindowsRfc3161Fixtures
{
    private const string Rfc3161Attribute = "1.2.840.113549.1.9.16.2.14";
    private const string TstInfo = "1.2.840.113549.1.9.16.1.4";
    private const string Sha256 = "2.16.840.1.101.3.4.2.1";
    private const string Sha384 = "2.16.840.1.101.3.4.2.2";

    public static WindowsRfc3161Fixture Create(string mode)
    {
        using var outerCertificate = SelfSignedCertificate("1.3.6.1.5.5.7.3.3");
        var outer = Sign(new ContentInfo(new byte[] { 1, 2, 3 }), outerCertificate);
        if (mode == "missing")
        {
            return Fixture(outer, outerCertificate);
        }
        if (mode == "legacy")
        {
            var legacy = TimestampChain("1.3.6.1.5.5.7.3.8");
            outer.SignerInfos[0].ComputeCounterSignature(new CmsSigner(legacy.Leaf));
            return Fixture(outer, legacy.Root);
        }

        bool wrongEku = mode == "wrong-eku";
        var timestamp = TimestampChain(
            wrongEku ? "1.3.6.1.5.5.7.3.3" : "1.3.6.1.5.5.7.3.8");
        byte[] signature = outer.SignerInfos[0].GetSignature();
        string algorithm = mode == "wrong-digest" ? Sha384 : Sha256;
        byte[] imprint = mode == "wrong-imprint"
            ? new byte[32]
            : algorithm == Sha384
                ? SHA384.HashData(signature)
                : SHA256.HashData(signature);
        byte[] token = Token(timestamp, algorithm, imprint);
        if (mode == "corrupt-token")
        {
            token[token.Length - 1] ^= 0x01;
        }
        outer.SignerInfos[0].AddUnsignedAttribute(
            new AsnEncodedData(new Oid(Rfc3161Attribute), token));
        if (mode == "duplicate")
        {
            outer.SignerInfos[0].AddUnsignedAttribute(
                new AsnEncodedData(new Oid(Rfc3161Attribute), token));
        }
        if (mode == "rfc-plus-legacy")
        {
            outer.SignerInfos[0].ComputeCounterSignature(new CmsSigner(timestamp.Leaf));
        }
        if (mode == "wrong-root")
        {
            return Fixture(outer, TimestampChain("1.3.6.1.5.5.7.3.8").Root);
        }
        return Fixture(outer, timestamp.Root);
    }

    private static WindowsRfc3161Fixture Fixture(SignedCms cms, X509Certificate2 trustRoot) =>
        new() { Cms = cms.Encode(), TrustRoot = trustRoot };

    private static SignedCms Sign(ContentInfo content, X509Certificate2 certificate)
    {
        var cms = new SignedCms(content);
        var signer = new CmsSigner(certificate)
        {
            IncludeOption = X509IncludeOption.EndCertOnly,
        };
        cms.ComputeSignature(signer);
        return cms;
    }

    private static byte[] Token(TimestampPair timestamp, string algorithm, byte[] imprint)
    {
        var writer = new AsnWriter(AsnEncodingRules.DER);
        writer.PushSequence();
        writer.WriteInteger(1);
        writer.WriteObjectIdentifier("1.2.3.4.5");
        writer.PushSequence();
        writer.PushSequence();
        writer.WriteObjectIdentifier(algorithm);
        writer.WriteNull();
        writer.PopSequence();
        writer.WriteOctetString(imprint);
        writer.PopSequence();
        writer.WriteInteger(1);
        writer.WriteGeneralizedTime(DateTimeOffset.UtcNow, omitFractionalSeconds: true);
        writer.PopSequence();
        var content = new ContentInfo(new Oid(TstInfo), writer.Encode());
        var cms = new SignedCms(content);
        var signer = new CmsSigner(timestamp.Leaf) { IncludeOption = X509IncludeOption.WholeChain };
        signer.Certificates.Add(timestamp.Root);
        cms.ComputeSignature(signer);
        return cms.Encode();
    }

    private static X509Certificate2 SelfSignedCertificate(string eku)
    {
        using var rsa = RSA.Create(2048);
        var request = new CertificateRequest("CN=Keiko Test", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        var usages = new OidCollection { new Oid(eku) };
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(usages, critical: true));
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        return request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));
    }

    private static TimestampPair TimestampChain(string eku)
    {
        using var rootKey = RSA.Create(2048);
        var rootRequest = new CertificateRequest("CN=Keiko Test Root", rootKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        rootRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        rootRequest.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign, true));
        var root = rootRequest.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-2), DateTimeOffset.UtcNow.AddDays(2));

        using var leafKey = RSA.Create(2048);
        var leafRequest = new CertificateRequest("CN=Keiko Test TSA", leafKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        leafRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        leafRequest.CertificateExtensions.Add(
            new X509EnhancedKeyUsageExtension(new OidCollection { new Oid(eku) }, true));
        byte[] serial = RandomNumberGenerator.GetBytes(16);
        using var issued = leafRequest.Create(
            root,
            DateTimeOffset.UtcNow.AddDays(-1),
            DateTimeOffset.UtcNow.AddDays(1),
            serial);
        var leaf = issued.CopyWithPrivateKey(leafKey);
        return new TimestampPair(root, leaf);
    }

    private sealed class TimestampPair
    {
        public TimestampPair(X509Certificate2 root, X509Certificate2 leaf)
        {
            Root = root;
            Leaf = leaf;
        }
        public X509Certificate2 Root { get; }
        public X509Certificate2 Leaf { get; }
    }
}
