import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { createDanceSyncManager, DANCE_EXECUTION_DELAY_MS } from "./dance-sync.js";

const quiet = { info() {}, warn() {} };
const manager = createDanceSyncManager({
  verifyToken: token => token === "token-a" ? { id: "user-a", name: "A" } : token === "token-b" ? { id: "user-b", name: "B" } : null,
  logger: quiet
});
const server = createServer();
manager.attach(server);
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

function client(token) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/dance-sync`);
  const opened = new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const queue = [];
  const waiters = [];
  socket.on("message", raw => {
    const value = JSON.parse(String(raw));
    const index = waiters.findIndex(waiter => waiter.type === value.type);
    if (index >= 0) waiters.splice(index, 1)[0].resolve(value); else queue.push(value);
  });
  const wait = (type, timeout = 1500) => {
    const index = queue.findIndex(value => value.type === type);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve: value => { clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => { const at = waiters.indexOf(waiter); if (at >= 0) waiters.splice(at, 1); reject(new Error(`timeout waiting ${type}`)); }, timeout);
      waiters.push(waiter);
    });
  };
  const send = value => socket.send(JSON.stringify(value));
  return { socket, wait, send, token, opened };
}

async function join(value) {
  await value.opened;
  value.send({ type: "dance_auth", token: value.token });
  await value.wait("dance_authenticated");
  value.send({ type: "dance_join", room: "FORBES_GLOBAL_DANCE" });
  return value.wait("dance_ready");
}

const a = client("token-a");
const b = client("token-b");
await join(a);
const readyB = await join(b);
console.log("TEST A joined");
assert.equal(readyB.participantCount, 2, "TEST A participant count");

a.send({ type: "dance_command_request", dance: 8 });
const [commandA, commandB] = await Promise.all([a.wait("dance_command"), b.wait("dance_command")]);
console.log("TEST B broadcast");
assert.equal(commandA.commandId, commandB.commandId, "TEST B commandId");
assert.equal(commandA.executeAt, commandB.executeAt, "TEST B executeAt");
assert.equal(commandA.dance, 8, "TEST B dance");
assert.ok(commandA.executeAt - commandA.createdAt === DANCE_EXECUTION_DELAY_MS, "TEST B execution delay");

b.send({ type: "dance_command_request", dance: 9 });
const rejected = await b.wait("dance_command_rejected");
console.log("TEST C rejected busy");
assert.equal(rejected.reason, "busy", "TEST C cooldown");

b.socket.close();
await a.wait("dance_presence");
await new Promise(resolve => setTimeout(resolve, 30));
assert.equal(manager.status().participants, 1, "TEST D disconnect");
console.log("TEST D disconnected");

const duplicate = client("token-a");
await join(duplicate);
await new Promise(resolve => setTimeout(resolve, 30));
assert.equal(manager.status().participants, 1, "TEST E duplicate user");
console.log("TEST E duplicate replaced");

duplicate.socket.terminate();
await new Promise(resolve => setTimeout(resolve, 30));
await new Promise(resolve => server.close(resolve));
console.log("Dance Sync backend TEST A-E: PASS");
