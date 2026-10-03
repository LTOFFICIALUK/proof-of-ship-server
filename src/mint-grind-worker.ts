import { parentPort, workerData } from "node:worker_threads";
import nacl from "tweetnacl";
import bs58 from "bs58";

const suffix = String((workerData as { suffix?: string } | undefined)?.suffix || "PoS");

while (true) {
  const keys = nacl.sign.keyPair();
  const publicKey = bs58.encode(keys.publicKey);
  if (publicKey.endsWith(suffix)) {
    parentPort?.postMessage({ publicKey, secretKey: bs58.encode(keys.secretKey) });
    break;
  }
}
