#!/bin/sh

set -eu

self=$0
while [ -L "$self" ]; do
  directory=$(CDPATH= cd -P "$(dirname "$self")" && pwd)
  link=$(readlink "$self")
  case $link in
    /*) self=$link ;;
    *) self=$directory/$link ;;
  esac
done

package_root=$(CDPATH= cd -P "$(dirname "$self")/.." && pwd)
system=$(uname -s)
machine=$(uname -m)

case "$system/$machine" in
  Darwin/arm64) native=relay-darwin-arm64 ;;
  Darwin/x86_64) native=relay-darwin-x64 ;;
  Linux/x86_64) native=relay-linux-x64-gnu ;;
  Linux/aarch64 | Linux/arm64) native=relay-linux-arm64-gnu ;;
  *)
    echo "Relay does not have a native build for $system/$machine." >&2
    exit 1
    ;;
esac

if [ "$system" = Linux ] && ! getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
  echo "Relay currently requires glibc on Linux; musl Linux is not supported yet." >&2
  exit 1
fi

for executable in \
  "$package_root/node_modules/@akshar5/$native/bin/relay" \
  "$package_root/../$native/bin/relay"
do
  if [ -x "$executable" ]; then
    exec "$executable" "$@"
  fi
done

echo "Relay's native package (@akshar5/$native) is missing." >&2
echo "Reinstall Relay so npm can restore it:" >&2
echo "  npm install --global @akshar5/relay@latest" >&2
exit 1
