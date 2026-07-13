export const nativeTargets = {
  "darwin-arm64": {
    packageName: "@akshar5/relay-darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    bunTarget: "bun-darwin-arm64",
  },
  "darwin-x64": {
    packageName: "@akshar5/relay-darwin-x64",
    os: "darwin",
    cpu: "x64",
    bunTarget: "bun-darwin-x64",
  },
  "linux-x64-gnu": {
    packageName: "@akshar5/relay-linux-x64-gnu",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
    bunTarget: "bun-linux-x64-baseline",
  },
  "linux-arm64-gnu": {
    packageName: "@akshar5/relay-linux-arm64-gnu",
    os: "linux",
    cpu: "arm64",
    libc: "glibc",
    bunTarget: "bun-linux-arm64",
  },
} as const;

export type NativeTarget = keyof typeof nativeTargets;

export interface RuntimePlatform {
  readonly platform: string;
  readonly arch: string;
  readonly libc?: "glibc" | "other";
}

export const nativePackageFor = ({ platform, arch, libc }: RuntimePlatform): string => {
  if (platform === "darwin" && arch === "arm64") {
    return nativeTargets["darwin-arm64"].packageName;
  }
  if (platform === "darwin" && arch === "x64") {
    return nativeTargets["darwin-x64"].packageName;
  }
  if (platform === "linux" && libc !== "glibc") {
    throw new Error("Relay currently requires glibc on Linux; musl Linux is not supported yet.");
  }
  if (platform === "linux" && arch === "x64") {
    return nativeTargets["linux-x64-gnu"].packageName;
  }
  if (platform === "linux" && arch === "arm64") {
    return nativeTargets["linux-arm64-gnu"].packageName;
  }
  throw new Error(`Relay does not have a native build for ${platform}/${arch}.`);
};

export const isNativeTarget = (value: string): value is NativeTarget =>
  Object.hasOwn(nativeTargets, value);
