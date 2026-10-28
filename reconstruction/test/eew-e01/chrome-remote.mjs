// P3-PH-AC03: Mac mini の上で前景の Chrome を起こし、loopback に開く CDP を --listen の 1 つの IPv4 へ、--allow-from の相手にだけ転送する。
// 無いと Pi の runner（run.mjs --chrome-cdp）が Mac mini の Chrome につなげない（--remote-debugging-address には頼らない）。
// この道具は測る値を作らない（試行・時計・記録は Pi の runner）。窓の間だけ動かし、窓の後に止める。
//   node reconstruction/test/eew-e01/chrome-remote.mjs --listen <Mac mini の tailscale の IPv4>:<port> --allow-from <Pi の tailscale の IPv4>
import { spawn } from "node:child_process";
import { createConnection, createServer, isIPv4 } from "node:net";

import { activate, launchChrome } from "./chrome.mjs";

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1] ?? null; };
const [listenHost, listenPort, ...extra] = String(arg("listen") ?? "").split(":");
const allowFrom = arg("allow-from");
// wildcard・名前・IPv6 は拒む（既定で外へ開けない）。
if (extra.length > 0 || !isIPv4(listenHost) || listenHost === "0.0.0.0" || !/^\d+$/.test(listenPort ?? "") || allowFrom == null || !isIPv4(allowFrom)) {
  console.error("usage: chrome-remote.mjs --listen <IPv4>:<port> --allow-from <IPv4> (0.0.0.0, names and IPv6 are refused)");
  process.exit(2);
}

const launched = await launchChrome();
console.log(`activation=${await activate(launched.chrome.pid)}`);
const caffeinate = spawn("caffeinate", ["-dims", "-w", String(process.pid)], { stdio: "ignore" });
caffeinate.on("error", () => {});

const sockets = new Set();
const server = createServer((socket) => {
  // CDP は認証を持たず、つないだ相手が Chrome を操り file:// も読めるので、--allow-from 以外の相手はすぐ切る。
  if (socket.remoteAddress !== allowFrom) { socket.destroy(); return; }
  const upstream = createConnection({ host: "127.0.0.1", port: Number(launched.port) });
  const end = () => { socket.destroy(); upstream.destroy(); sockets.delete(socket); sockets.delete(upstream); };
  for (const s of [socket, upstream]) { sockets.add(s); s.on("error", end); s.on("close", end); }
  socket.pipe(upstream).pipe(socket);
});
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(Number(listenPort), listenHost, resolve); });
} catch (error) {
  // listen できない（その IP が無い・port が使用中）ときに Chrome を残さない。
  await launched.close();
  throw error;
}
const version = (await launched.browser.send("Browser.getVersion")).product.replace(/^Chrome\//, "");
console.log(`cdp=${listenHost}:${server.address().port} chrome=${version}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  server.close();
  for (const s of sockets) s.destroy();
  await launched.close();
  caffeinate.kill();
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void stop(); });
