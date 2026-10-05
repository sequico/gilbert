/**
 * The object identifiers the S/MIME readers name.
 *
 * One table, because a certificate and a CMS signature name the same
 * algorithms — `rsaEncryption` is read from both, and two tables would be two
 * answers to "what is this OID?".
 */
export const OID = {
  /* CMS SignedData (RFC 5652) and the signed attributes. */
  signedData: "1.2.840.113549.1.7.2",
  data: "1.2.840.113549.1.7.1",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",

  /* Digests. */
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
  sha1: "1.3.14.3.2.26",

  /* Signature algorithms. */
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256WithRsa: "1.2.840.113549.1.1.11",
  sha384WithRsa: "1.2.840.113549.1.1.12",
  sha512WithRsa: "1.2.840.113549.1.1.13",
  rsaPss: "1.2.840.113549.1.1.10",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  ecdsaWithSha384: "1.2.840.10045.4.3.3",
  ecdsaWithSha512: "1.2.840.10045.4.3.4",

  /* Distinguishing-name attributes worth naming, and a subject's public key. */
  commonName: "2.5.4.3",
  emailAddress: "1.2.840.113549.1.9.1",
  organization: "2.5.4.10",
  subjectAltName: "2.5.29.17",
  ecPublicKey: "1.2.840.10045.2.1",
  curveP256: "1.2.840.10045.3.1.7",
  curveP384: "1.3.132.0.34",
  curveP521: "1.3.132.0.35",
} as const;
