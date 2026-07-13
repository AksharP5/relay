import solidPlugin from "@opentui/solid/bun-plugin";

const result = await Bun.build({
  entrypoints: ["src/cli.ts"],
  target: "bun",
  plugins: [solidPlugin],
  compile: {
    outfile: "dist/relay",
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
