import forge from "node-forge";
import JSZip from "jszip";
// In Cloudflare Workers these resolve to ArrayBuffer; in Bun they resolve to file paths
import iconPngData from "../assets/icon.png";
import icon2xPngData from "../assets/icon@2x.png";
import logoPngData from "../assets/logo.png";
import logo2xPngData from "../assets/logo@2x.png";

function loadAsset(imported: ArrayBuffer | string): Uint8Array {
  if (typeof imported === "string") {
    // Bun: imported value is a file path
    const fs = require("fs");
    return new Uint8Array(fs.readFileSync(imported));
  }
  // Cloudflare Workers: imported value is ArrayBuffer
  return new Uint8Array(imported);
}

export interface Env {
  PASS_TYPE_IDENTIFIER: string;
  TEAM_IDENTIFIER: string;
  PASS_CERTIFICATE_P12_BASE64: string;
  PASS_CERTIFICATE_PASSWORD: string;
  API_KEY: string;
}

export interface PassLocation {
  latitude: number;
  longitude: number;
  relevantText?: string;
}

export interface PassRequest {
  memberId: string;
  firstName: string;
  lastName: string;
  pinCode?: string;
  locations?: PassLocation[];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(),
      });
    }

    if (request.method !== "POST") {
      return jsonError("Method not allowed", 405);
    }

    // Authenticate
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || authHeader !== `Bearer ${env.API_KEY}`) {
      return jsonError("Unauthorized", 401);
    }

    // Parse request
    let body: PassRequest;
    try {
      body = (await request.json()) as PassRequest;
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    if (!body.memberId) {
      return jsonError("memberId is required", 400);
    }

    try {
      const pkpassData = await generatePass(body, env);
      return new Response(pkpassData, {
        headers: {
          "Content-Type": "application/vnd.apple.pkpass",
          "Content-Disposition": `attachment; filename="espresso-member.pkpass"`,
          ...corsHeaders(),
        },
      });
    } catch (e: any) {
      console.error("Pass generation failed:", e);
      return jsonError(`Pass generation failed: ${e.message}`, 500);
    }
  },
};

export async function generatePass(
  data: PassRequest,
  env: Env
): Promise<ArrayBuffer> {
  const passJson = buildPassJson(data, env);

  // Collect all pass files
  const files: Record<string, Uint8Array> = {
    "pass.json": new TextEncoder().encode(JSON.stringify(passJson)),
    "icon.png": loadAsset(iconPngData),
    "icon@2x.png": loadAsset(icon2xPngData),
    "logo.png": loadAsset(logoPngData),
    "logo@2x.png": loadAsset(logo2xPngData),
  };

  // Build manifest (SHA-256 hex hashes)
  const manifest: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    const hashBuffer = await crypto.subtle.digest("SHA-1", content);
    manifest[name] = bufToHex(new Uint8Array(hashBuffer));
  }
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  files["manifest.json"] = manifestBytes;

  // Sign the manifest
  const signature = signManifest(manifestBytes, env);
  files["signature"] = signature;

  // ZIP into .pkpass
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }

  return await zip.generateAsync({ type: "arraybuffer" });
}

export function buildPassJson(
  data: PassRequest,
  env: Env
): Record<string, unknown> {
  const fullName = [data.firstName, data.lastName]
    .filter((s) => s && s.length > 0)
    .join(" ");

  return {
    formatVersion: 1,
    passTypeIdentifier: env.PASS_TYPE_IDENTIFIER,
    teamIdentifier: env.TEAM_IDENTIFIER,
    serialNumber: `member-${data.memberId}`,
    organizationName: "Espresso House",
    description: "Espresso House Member Card",
    logoText: "Espresso House",
    foregroundColor: "rgb(255, 255, 255)",
    backgroundColor: "rgb(38, 65, 43)",
    labelColor: "rgb(200, 220, 200)",
    ...(data.locations && data.locations.length > 0
      ? {
          locations: data.locations.map((loc) => ({
            latitude: loc.latitude,
            longitude: loc.longitude,
            ...(loc.relevantText ? { relevantText: loc.relevantText } : {}),
          })),
        }
      : {}),
    barcodes: [
      {
        format: "PKBarcodeFormatPDF417",
        message: `${data.memberId}:member`,
        messageEncoding: "iso-8859-1",
      },
    ],
    storeCard: {
      headerFields: fullName
        ? [
            {
              key: "member-name",
              label: "MEMBER",
              value: fullName,
            },
          ]
        : [],
      primaryFields: [
        {
          key: "member-id",
          label: "MEMBERSHIP NO.",
          value: data.memberId,
        },
      ],
      secondaryFields: data.pinCode
        ? [
            {
              key: "pin-code",
              label: "PIN",
              value: data.pinCode,
            },
          ]
        : [],
      auxiliaryFields: [],
      backFields: [
        {
          key: "info",
          label: "About",
          value:
            "Scan in our coffee shops to pay with your Coffee Card, redeem coupons, and collect Fika Points.",
        },
      ],
    },
  };
}

function signManifest(manifestData: Uint8Array, env: Env): Uint8Array {
  // Decode the .p12
  const p12Der = forge.util.decode64(env.PASS_CERTIFICATE_P12_BASE64);
  const p12Asn1 = forge.asn1.fromDer(p12Der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, env.PASS_CERTIFICATE_PASSWORD);

  // Extract all certificates and keys from the .p12
  const allBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certBagList = allBags[forge.pki.oids.certBag] || [];

  // Try both shrouded and unshrouded key bag types
  const shroudedBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const unshroudedBags = p12.getBags({ bagType: forge.pki.oids.keyBag });
  const keyBagList = [
    ...(shroudedBags[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
    ...(unshroudedBags[forge.pki.oids.keyBag] || []),
  ];

  if (certBagList.length === 0) {
    throw new Error("No certificate found in .p12");
  }
  if (keyBagList.length === 0) {
    throw new Error(
      `No private key found in .p12. Found ${certBagList.length} cert(s) but 0 keys.`
    );
  }

  // Find the signing cert (issued by Apple) and the WWDR intermediate
  let signerCert: forge.pki.Certificate | null = null;
  let wwdrCert: forge.pki.Certificate | null = null;

  for (const bag of certBagList) {
    const cert = bag.cert;
    if (!cert) continue;
    const issuerOrg = cert.issuer.getField("O");
    const subjectOrg = cert.subject.getField("O");
    if (subjectOrg && subjectOrg.value === "Apple Inc.") {
      // This IS an Apple cert (WWDR intermediate)
      wwdrCert = cert;
    } else if (issuerOrg && issuerOrg.value === "Apple Inc.") {
      // This cert was issued by Apple — it's our pass signing cert
      signerCert = cert;
    }
  }

  if (!signerCert) {
    // Fallback: use the first non-Apple cert, or just the first cert
    signerCert = certBagList.find(
      (b) => b.cert && b.cert.subject.getField("O")?.value !== "Apple Inc."
    )?.cert || certBagList[0].cert!;
  }

  const privateKey = keyBagList[0].key as forge.pki.PrivateKey;

  // Create PKCS#7 signed data (detached signature)
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(
    String.fromCharCode(...manifestData)
  );

  p7.addCertificate(signerCert);
  if (wwdrCert) {
    p7.addCertificate(wwdrCert);
  }

  p7.addSigner({
    key: privateKey,
    certificate: signerCert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      {
        type: forge.pki.oids.contentType,
        value: forge.pki.oids.data,
      },
      {
        type: forge.pki.oids.messageDigest,
      },
      {
        type: forge.pki.oids.signingTime,
        value: new Date().toISOString(),
      },
    ],
  } as any);

  p7.sign({ detached: true });

  const asn1 = p7.toAsn1();
  const der = forge.asn1.toDer(asn1);
  return new Uint8Array(
    der
      .getBytes()
      .split("")
      .map((c: string) => c.charCodeAt(0))
  );
}

function bufToHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}
