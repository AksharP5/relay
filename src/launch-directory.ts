import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

const errorCode = (cause: unknown) =>
  cause && typeof cause === "object" && "code" in cause ? String(cause.code) : undefined;

export const resolveLaunchDirectory = async (directory: string, cwd = process.cwd()) => {
  const absolute = resolve(cwd, directory);
  let metadata;
  try {
    metadata = await stat(absolute);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT")
      throw new Error(`Relay directory does not exist: ${absolute}`);
    throw new Error(`Relay could not access directory ${absolute}: ${String(cause)}`);
  }
  if (!metadata.isDirectory()) throw new Error(`Relay path is not a directory: ${absolute}`);
  return realpath(absolute);
};
