# Espresso House Pass Signing Worker

Cloudflare Worker that generates signed Apple Wallet passes (`.pkpass`) for Espresso House member cards. The iOS app sends member data, this worker builds, signs, and returns the pass.

## How it works

```
iOS App                    Cloudflare Worker                Apple Wallet
  │                              │                              │
  ├── POST /generate ────────────►                              │
  │   { memberId, firstName,     │                              │
  │     lastName }               │                              │
  │                              ├── Build pass.json            │
  │                              ├── Generate manifest.json     │
  │                              ├── Sign with .p12 cert        │
  │                              ├── ZIP into .pkpass            │
  │                              │                              │
  │   ◄── application/vnd.apple ─┤                              │
  │       .pkpass (binary)       │                              │
  │                              │                              │
  ├── PKPass(data:) ─────────────────── Add to Wallet ─────────►│
```

## Pass contents

- **Type**: Store Card
- **Barcode**: PDF417, message `{memberId}:member`
- **Fields**: Member name (header), membership number (primary)
- **Colors**: Dark green background (`rgb(38, 65, 43)`), white text

## Prerequisites

- [Bun](https://bun.sh) runtime
- Cloudflare account with `lrlnet.se` domain
- Apple Developer account
- Pass Type ID Certificate (`.p12`) for `pass.com.kibbewater.coffee-shop`

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Login to Cloudflare

```bash
bunx wrangler login
```

### 3. Configure secrets

You need three secrets. Set each one:

**API key** — a shared secret the iOS app uses to authenticate requests. Generate one:

```bash
openssl rand -hex 32
```

Then store it:

```bash
bunx wrangler secret put API_KEY
# Paste the generated hex string
```

**Pass certificate** — your `.p12` file, base64-encoded:

```bash
base64 -i /path/to/your/pass.p12 | bunx wrangler secret put PASS_CERTIFICATE_P12_BASE64
```

**Certificate password** — the password you set when exporting the `.p12`:

```bash
bunx wrangler secret put PASS_CERTIFICATE_PASSWORD
# Type the password
```

### 4. Deploy

```bash
bun run deploy
```

### 5. Set up the domain route

In Cloudflare Dashboard:

1. Go to **Workers & Pages** > `espresso-pass`
2. **Settings** > **Domains & Routes**
3. Add a **Custom Domain**: `pass.lrlnet.se`
4. Cloudflare handles DNS and SSL automatically

### 6. Update the iOS app

In `PassGenerator.swift`, set the `apiKey` constant to match the `API_KEY` you generated in step 3.

## Local development

```bash
bun run dev
```

This starts a local server at `http://localhost:8787`. Test with:

```bash
curl -X POST http://localhost:8787 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"memberId": "1234567890", "firstName": "Test", "lastName": "User"}' \
  -o test.pkpass
```

Note: for local dev, you still need the secrets. Set them in a `.dev.vars` file (gitignored):

```
API_KEY=your-api-key
PASS_CERTIFICATE_P12_BASE64=base64-encoded-p12
PASS_CERTIFICATE_PASSWORD=your-password
```

## Project structure

```
espresso-worker/
├── src/
│   └── index.ts          # Worker entry point — pass building, signing, ZIP
├── wrangler.toml          # Cloudflare Worker configuration
├── package.json
└── tsconfig.json
```

## Security

- The `.p12` private key is stored as a Cloudflare secret — never in code or git
- All requests require a `Bearer` token in the `Authorization` header
- The worker only accepts `POST` requests
- CORS headers are included for flexibility but the iOS app calls directly

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `No certificate found in .p12` | Re-export from Keychain Access — make sure to expand the cert and export the certificate (not just the key) |
| `No private key found in .p12` | The .p12 must include the private key — expand the cert in Keychain, both cert and key should be visible |
| Pass rejected by iOS | Check that `passTypeIdentifier` and `teamIdentifier` in `wrangler.toml` match your Apple Developer account |
| 401 Unauthorized | Verify the `API_KEY` secret matches what the iOS app sends |
