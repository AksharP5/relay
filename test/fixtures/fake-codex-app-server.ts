#!/usr/bin/env bun

import { createInterface } from "node:readline";

const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
let handoffSeeded = false;

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line) as {
    id?: number;
    method: string;
    params?: Record<string, unknown>;
  };
  if (message.id === undefined) continue;
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake" } });
    continue;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: "codex-thread" } } });
    continue;
  }
  if (message.method === "thread/inject_items") {
    handoffSeeded = JSON.stringify(message.params).includes("prior Relay conversation");
    send({ id: message.id, result: {} });
    continue;
  }
  if (message.method === "thread/compact/start") {
    send({ id: message.id, result: {} });
    send({ method: "turn/started", params: { threadId: "codex-thread", turn: { id: "t1" } } });
    send({
      method: "turn/completed",
      params: { threadId: "codex-thread", turn: { id: "t1", status: "completed" } },
    });
    continue;
  }
  if (message.method === "review/start") {
    if (!handoffSeeded) {
      send({ id: message.id, error: { code: -32000, message: "review ran before its handoff" } });
      continue;
    }
    send({ id: message.id, result: { turn: { id: "t2" }, reviewThreadId: "codex-thread" } });
    send({
      method: "item/agentMessage/delta",
      params: { threadId: "codex-thread", turnId: "t2", itemId: "i1", delta: "Review " },
    });
    send({
      method: "item/agentMessage/delta",
      params: { threadId: "codex-thread", turnId: "t2", itemId: "i1", delta: "complete" },
    });
    send({
      method: "turn/completed",
      params: { threadId: "codex-thread", turn: { id: "t2", status: "completed" } },
    });
  }
}
