import { writeFileSync } from "node:fs";
import nacl from "tweetnacl";
import bs58 from "bs58";

const suffix = process.argv[2] || "PoS";
const need = Number(process.argv[3] || 16);
const out = process.argv[4] || "src/mint-bank.fixtures.json";
const keys = [];
let attempts = 0;
const started = Date.now();

process.stdout.write(`grinding ${need} mints ending in ${suffix}\n`);

while (keys.length < need) {
  const pair = nacl.sign.keyPair();
  attempts += 1;
  const publicKey = bs58.encode(pair.publicKey);
  if (publicKey.endsWith(suffix)) {
    keys.push({ publicKey, secretKey: bs58.encode(pair.secretKey) });
    process.stdout.write(`found ${keys.length}/${need} ${publicKey} after ${attempts}\n`);
  }
}

writeFileSync(out, JSON.stringify({ suffix, keys, attempts, ms: Date.now() - started }, null, 2));
process.stdout.write(`wrote ${out}\n`);
