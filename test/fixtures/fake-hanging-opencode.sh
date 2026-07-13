#!/bin/sh

if [ -n "$RELAY_TEST_PID_FILE" ]; then
  echo "$$" > "$RELAY_TEST_PID_FILE"
fi

while :; do
  sleep 60
done
