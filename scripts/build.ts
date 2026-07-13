import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const [targetArg, outfileArg] = process.argv.slice(2);

if (targetArg && !outfileArg) {
  console.error("Usage: bun scripts/build.ts [target outfile]");
  process.exit(2);
}

const outfile = outfileArg ?? "dist/relay";
await mkdir(dirname(outfile), { recursive: true });

const result = await Bun.build({
  entrypoints: ["src/cli.ts"],
  target: "bun",
  compile: {
    ...(targetArg ? { target: targetArg as Bun.Build.CompileTarget } : {}),
    outfile,
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
