import { Config, Context, Effect, Layer } from "effect";

export interface RelayPathsShape {
  readonly root: string;
}

const resolveRoot = Effect.gen(function* () {
  const override = yield* Config.option(Config.string("RELAY_DATA_DIR"));
  if (override._tag === "Some") {
    const root = override.value.trim();
    if (root) return root;
  }

  const home = yield* Config.option(Config.string("HOME"));
  return home._tag === "Some" && home.value
    ? `${home.value}/.local/share/relay`
    : `${process.cwd()}/.relay`;
});

export class RelayPaths extends Context.Service<RelayPaths, RelayPathsShape>()(
  "@relay/RelayPaths",
) {
  static readonly layer = Layer.effect(
    RelayPaths,
    resolveRoot.pipe(Effect.map((root) => RelayPaths.of({ root }))),
  );

  static readonly layerFromRoot = (root: string) =>
    Layer.succeed(RelayPaths, RelayPaths.of({ root }));
}
