#!/usr/bin/env node
import { runCli } from "../backend/common/log_rotator.mjs";

runCli(process.argv.slice(2)).catch((err) => {
  console.error("[LogRotator] Fatal error:", err);
  process.exit(1);
});
