const result = await Bun.build({
  entrypoints: ["src/cli.ts"],
  target: "bun",
  compile: {
    outfile: "dist/relay",
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
