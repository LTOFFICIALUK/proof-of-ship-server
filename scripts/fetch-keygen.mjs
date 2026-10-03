import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";

if (process.platform !== "linux" || process.arch !== "x64") {
  process.exit(0);
}

const dest = "bin/solana-keygen";
if (existsSync(dest)) {
  process.exit(0);
}

mkdirSync("bin", { recursive: true });
const url = "https://github.com/anza-xyz/agave/releases/download/v3.1.10/solana-release-x86_64-unknown-linux-gnu.tar.bz2";
execFileSync("curl", ["-fsSL", url, "-o", "/tmp/solana-release.tar.bz2"], { stdio: "inherit" });
execFileSync(
  "tar",
  ["-xj", "-C", "bin", "--strip-components=2", "-f", "/tmp/solana-release.tar.bz2", "solana-release/bin/solana-keygen"],
  { stdio: "inherit" },
);
chmodSync(dest, 0o755);
