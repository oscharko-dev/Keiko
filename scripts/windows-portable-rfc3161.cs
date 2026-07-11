#nullable enable

using System;
using System.Formats.Asn1;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.Pkcs;
using System.Security.Cryptography.X509Certificates;

public sealed class WindowsPortableTimestampResult
{
    public bool Valid { get; init; }
    public string Reason { get; init; } = "windows-timestamp-unverified";
    public X509Certificate2[] Certificates { get; init; } = Array.Empty<X509Certificate2>();
}

public static class WindowsPortableRfc3161
{
    private const string TimestampTokenOid = "1.2.840.113549.1.9.16.2.14";
    private const string LegacyCounterSignatureOid = "1.2.840.113549.1.9.6";
    private const string TstInfoOid = "1.2.840.113549.1.9.16.1.4";
    private const string Sha256Oid = "2.16.840.1.101.3.4.2.1";
    private const int CertQueryObjectFile = 1;
    private const int CertQueryContentFlagPkcs7SignedEmbed = 0x400;
    private const int CertQueryFormatFlagBinary = 2;
    private const int CertQueryContentPkcs7SignedEmbed = 10;
    private const int CmsgEncodedMessageParam = 29;
    private const int MaxCmsBytes = 4 * 1024 * 1024;

    public static WindowsPortableTimestampResult VerifyFile(string path)
    {
        try
        {
            return VerifyAuthenticodeCms(ReadAuthenticodeCms(path));
        }
        catch
        {
            return Failure();
        }
    }

    public static WindowsPortableTimestampResult VerifyAuthenticodeCms(
        byte[] encodedCms,
        X509Certificate2Collection? customTrustRoots = null)
    {
        try
        {
            if (encodedCms.Length == 0 || encodedCms.Length > MaxCmsBytes)
            {
                return Failure();
            }
            var outer = new SignedCms();
            outer.Decode(encodedCms);
            outer.CheckSignature(verifySignatureOnly: true);
            if (outer.SignerInfos.Count == 0)
            {
                return Failure();
            }

            var certificates = new X509Certificate2[outer.SignerInfos.Count];
            for (int index = 0; index < outer.SignerInfos.Count; index++)
            {
                var signer = outer.SignerInfos[index];
                if (!TryVerifySignerTimestamp(
                    signer,
                    customTrustRoots,
                    out X509Certificate2? certificate))
                {
                    return Failure();
                }
                certificates[index] = certificate!;
            }

            return new WindowsPortableTimestampResult
            {
                Valid = true,
                Reason = "verified",
                Certificates = certificates,
            };
        }
        catch
        {
            return Failure();
        }
    }

    private static bool TryVerifySignerTimestamp(
        SignerInfo signer,
        X509Certificate2Collection? customTrustRoots,
        out X509Certificate2? certificate)
    {
        certificate = null;
        CryptographicAttributeObject? tokenAttribute = null;
        foreach (CryptographicAttributeObject attribute in signer.UnsignedAttributes)
        {
            if (attribute.Oid?.Value == LegacyCounterSignatureOid)
            {
                return false;
            }
            if (attribute.Oid?.Value == TimestampTokenOid)
            {
                if (tokenAttribute != null)
                {
                    return false;
                }
                tokenAttribute = attribute;
            }
        }
        if (tokenAttribute == null || tokenAttribute.Values.Count != 1)
        {
            return false;
        }

        var token = new SignedCms();
        token.Decode(tokenAttribute.Values[0].RawData);
        if (token.ContentInfo.ContentType.Value != TstInfoOid || token.SignerInfos.Count != 1)
        {
            return false;
        }
        token.CheckSignature(verifySignatureOnly: true);
        certificate = token.SignerInfos[0].Certificate;
        if (certificate == null || !TryReadTstInfo(
            token.ContentInfo.Content,
            signer.GetSignature(),
            out DateTimeOffset generationTime))
        {
            return false;
        }
        return HasExactTimestampEku(certificate) &&
            VerifyTimestampChain(certificate, token.Certificates, generationTime, customTrustRoots);
    }

    private static bool TryReadTstInfo(
        byte[] encoded,
        byte[] signerSignature,
        out DateTimeOffset generationTime)
    {
        generationTime = default;
        var reader = new AsnReader(encoded, AsnEncodingRules.DER);
        var tstInfo = reader.ReadSequence();
        if (tstInfo.ReadInteger() != 1)
        {
            return false;
        }
        if (string.IsNullOrEmpty(tstInfo.ReadObjectIdentifier()))
        {
            return false;
        }
        var imprint = tstInfo.ReadSequence();
        var algorithm = imprint.ReadSequence();
        if (algorithm.ReadObjectIdentifier() != Sha256Oid)
        {
            return false;
        }
        if (algorithm.HasData)
        {
            if (!algorithm.PeekTag().HasSameClassAndValue(Asn1Tag.Null))
            {
                return false;
            }
            algorithm.ReadNull();
        }
        algorithm.ThrowIfNotEmpty();
        byte[] observed = imprint.ReadOctetString();
        imprint.ThrowIfNotEmpty();
        if (observed.Length != 32 || tstInfo.ReadInteger() <= 0)
        {
            return false;
        }
        generationTime = tstInfo.ReadGeneralizedTime();
        ReadOptionalTstInfoFields(tstInfo);
        tstInfo.ThrowIfNotEmpty();
        reader.ThrowIfNotEmpty();
        byte[] expected = SHA256.HashData(signerSignature);
        return CryptographicOperations.FixedTimeEquals(observed, expected);
    }

    private static void ReadOptionalTstInfoFields(AsnReader tstInfo)
    {
        var expected = new[]
        {
            new Asn1Tag(UniversalTagNumber.Sequence, true),
            Asn1Tag.Boolean,
            Asn1Tag.Integer,
            new Asn1Tag(TagClass.ContextSpecific, 0, true),
            new Asn1Tag(TagClass.ContextSpecific, 1, true),
        };
        int next = 0;
        while (tstInfo.HasData)
        {
            var observed = tstInfo.PeekTag();
            while (next < expected.Length && !observed.HasSameClassAndValue(expected[next]))
            {
                next++;
            }
            if (next == expected.Length)
            {
                throw new CryptographicException();
            }
            tstInfo.ReadEncodedValue();
            next++;
        }
    }

    private static bool VerifyTimestampChain(
        X509Certificate2 certificate,
        X509Certificate2Collection tokenCertificates,
        DateTimeOffset generationTime,
        X509Certificate2Collection? customTrustRoots)
    {
        using var chain = new X509Chain();
        if (customTrustRoots == null)
        {
            chain.ChainPolicy.RevocationMode = X509RevocationMode.Online;
            chain.ChainPolicy.RevocationFlag = X509RevocationFlag.EntireChain;
        }
        else
        {
            chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
            chain.ChainPolicy.CustomTrustStore.AddRange(customTrustRoots);
            chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        }
        chain.ChainPolicy.VerificationTime = generationTime.UtcDateTime;
        chain.ChainPolicy.ApplicationPolicy.Add(new Oid("1.3.6.1.5.5.7.3.8"));
        chain.ChainPolicy.ExtraStore.AddRange(tokenCertificates);
        return chain.Build(certificate);
    }

    private static bool HasExactTimestampEku(X509Certificate2 certificate)
    {
        X509EnhancedKeyUsageExtension? found = null;
        foreach (X509Extension extension in certificate.Extensions)
        {
            if (extension.Oid?.Value != "2.5.29.37")
            {
                continue;
            }
            if (found != null || !extension.Critical)
            {
                return false;
            }
            found = new X509EnhancedKeyUsageExtension(extension, extension.Critical);
        }
        return found != null &&
            found.EnhancedKeyUsages.Count == 1 &&
            found.EnhancedKeyUsages[0].Value == "1.3.6.1.5.5.7.3.8";
    }

    private static byte[] ReadAuthenticodeCms(string path)
    {
        if (!CryptQueryObject(
            CertQueryObjectFile,
            path,
            CertQueryContentFlagPkcs7SignedEmbed,
            CertQueryFormatFlagBinary,
            0,
            out _,
            out int contentType,
            out _,
            out IntPtr store,
            out IntPtr message,
            IntPtr.Zero))
        {
            throw new CryptographicException();
        }
        try
        {
            if (contentType != CertQueryContentPkcs7SignedEmbed)
            {
                throw new CryptographicException();
            }
            int size = 0;
            if (!CryptMsgGetParam(message, CmsgEncodedMessageParam, 0, null, ref size) ||
                size <= 0 || size > MaxCmsBytes)
            {
                throw new CryptographicException();
            }
            byte[] encoded = new byte[size];
            if (!CryptMsgGetParam(message, CmsgEncodedMessageParam, 0, encoded, ref size))
            {
                throw new CryptographicException();
            }
            if (size != encoded.Length)
            {
                throw new CryptographicException();
            }
            return encoded;
        }
        finally
        {
            if (message != IntPtr.Zero) CryptMsgClose(message);
            if (store != IntPtr.Zero) CertCloseStore(store, 0);
        }
    }

    private static WindowsPortableTimestampResult Failure() => new();

    [DllImport("crypt32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CryptQueryObject(
        int objectType,
        string objectPath,
        int expectedContentTypeFlags,
        int expectedFormatTypeFlags,
        int flags,
        out int encodingType,
        out int contentType,
        out int formatType,
        out IntPtr certificateStore,
        out IntPtr message,
        IntPtr context);

    [DllImport("crypt32.dll", SetLastError = true)]
    private static extern bool CryptMsgGetParam(
        IntPtr message,
        int paramType,
        int index,
        [Out] byte[]? data,
        ref int dataSize);

    [DllImport("crypt32.dll")]
    private static extern bool CryptMsgClose(IntPtr message);

    [DllImport("crypt32.dll")]
    private static extern bool CertCloseStore(IntPtr store, int flags);

}
