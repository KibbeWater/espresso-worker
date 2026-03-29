#!/usr/bin/env bun
/**
 * CLI tool to generate a .pkpass file locally for preview.
 *
 * Usage:
 *   bun run src/generate.ts --p12 ./pass.p12 --password mypassword
 *   bun run src/generate.ts --p12 ./pass.p12 --password mypassword --member-id 9876543210 --name "John Doe"
 *   bun run src/generate.ts --p12 ./pass.p12 --password mypassword -o custom-name.pkpass
 *
 * The .pkpass file can be dragged into the iOS Simulator to preview.
 */

import { generatePass, type Env } from "./index";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--p12":
        opts.p12 = args[++i];
        break;
      case "--password":
        opts.password = args[++i];
        break;
      case "--member-id":
        opts.memberId = args[++i];
        break;
      case "--name":
        opts.name = args[++i];
        break;
      case "--pin":
        opts.pin = args[++i];
        break;
      case "-o":
      case "--output":
        opts.output = args[++i];
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        console.error(`Unknown option: ${args[i]}`);
        printHelp();
        process.exit(1);
    }
  }

  return opts;
}

function printHelp() {
  console.log(`
Usage: bun run src/generate.ts --p12 <path> --password <password> [options]

Required:
  --p12 <path>          Path to the .p12 signing certificate
  --password <string>   Password for the .p12 file

Optional:
  --member-id <string>  Member ID (default: "0000000000")
  --name <string>       Member name, e.g. "John Doe" (default: "Test User")
  --pin <string>        PIN code (optional)
  -o, --output <path>   Output file path (default: ./preview.pkpass)
  -h, --help            Show this help
`);
}

async function main() {
  const opts = parseArgs();

  if (!opts.p12) {
    console.error("Error: --p12 is required");
    printHelp();
    process.exit(1);
  }
  if (!opts.password) {
    console.error("Error: --password is required");
    printHelp();
    process.exit(1);
  }

  // Read and base64-encode the .p12
  const p12Path = resolve(opts.p12);
  const p12Data = readFileSync(p12Path);
  const p12Base64 = p12Data.toString("base64");

  // Build the env object matching what the worker expects
  const env: Env = {
    PASS_TYPE_IDENTIFIER: "pass.com.kibbewater.coffee-shop",
    TEAM_IDENTIFIER: "89625ZHN6X",
    PASS_CERTIFICATE_P12_BASE64: p12Base64,
    PASS_CERTIFICATE_PASSWORD: opts.password,
    API_KEY: "",
  };

  // Parse name
  const nameParts = (opts.name || "Test User").split(" ");
  const firstName = nameParts[0];
  const lastName = nameParts.slice(1).join(" ");

  const request = {
    memberId: opts.memberId || "0000000000",
    firstName,
    lastName,
    pinCode: opts.pin,
  };

  console.log(`Generating pass for member ${request.memberId} (${request.firstName} ${request.lastName})...`);

  const pkpassData = await generatePass(request, env);
  const outputPath = resolve(opts.output || "preview.pkpass");
  writeFileSync(outputPath, Buffer.from(pkpassData));

  console.log(`Written to ${outputPath} (${pkpassData.byteLength} bytes)`);
  console.log(`\nTo preview: drag ${outputPath} into the iOS Simulator`);
}

main().catch((e) => {
  console.error("Failed:", e.message);
  process.exit(1);
});
