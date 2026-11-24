// A minimal ACP client that drives capy-acp end to end, printing every session update.
// Usage: node spike/acp-client.ts <cwd> <prompt> [<follow-up prompt>] [--cancel-after-ms N] [--between <shell command>]
//          [--image N:<file>]... [--load <sessionId> | --resume <sessionId>]
// `--between` runs a command after each prompt but the last (to change setup between turns).
// `--image 2:shot.png` attaches a file to prompt 2. `--load`/`--resume` continue a saved session
// instead of opening a new one. Environment for the adapter (CAPY_ACP_*) passes through.
import { execSync, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { basename, extname } from "node:path"
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"

const args = process.argv.slice(2)
const cancelIndex = args.indexOf("--cancel-after-ms")
const cancelAfter = cancelIndex === -1 ? undefined : Number(args.splice(cancelIndex, 2)[1])
const betweenIndex = args.indexOf("--between")
const between = betweenIndex === -1 ? undefined : args.splice(betweenIndex, 2)[1]
const images = new Map<number, Array<string>>()
for (let i = args.indexOf("--image"); i !== -1; i = args.indexOf("--image")) {
  const [, spec] = args.splice(i, 2)
  const [n, ...path] = spec!.split(":")
  images.set(Number(n), [...(images.get(Number(n)) ?? []), path.join(":")])
}
const takeFlag = (flag: string) => {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args.splice(i, 2)[1]
}
const load = takeFlag("--load")
const resume = takeFlag("--resume")
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }
const [cwd, ...prompts] = args
if (!cwd || prompts.length === 0) throw new Error("usage: acp-client.ts <cwd> <prompt> [<follow-up>] [--cancel-after-ms N]")

const child = spawn(process.execPath, [new URL("../dist/bin.js", import.meta.url).pathname], {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env
})

const started = Date.now()
const t = () => `+${((Date.now() - started) / 1000).toFixed(1)}s`

const client = acp.client({ name: "capy-acp-spike-client" }).onNotification(acp.methods.client.session.update, ({ params }) => {
  const u = params.update
  if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") process.stdout.write(u.content.text)
  else process.stdout.write(`\n${t()} ${JSON.stringify(u)}\n`)
})

await client.connectWith(
  acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>),
  async (agent) => {
    const init = await agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} })
    console.log(`${t()} initialize →`, JSON.stringify(init.agentInfo))
    console.log(`${t()} capabilities →`, JSON.stringify(init.agentCapabilities))
    const existing = load ?? resume
    const session =
      existing === undefined
        ? await agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] })
        : {
            sessionId: existing,
            ...(load !== undefined
              ? await agent.request(acp.methods.agent.session.load, { sessionId: existing, cwd, mcpServers: [] })
              : await agent.request(acp.methods.agent.session.resume, { sessionId: existing, cwd }))
          }
    const model = session.configOptions?.find((o) => o.id === "model")
    const method = load !== undefined ? "session/load" : resume !== undefined ? "session/resume" : "session/new"
    console.log(`\n${t()} ${method} → ${session.sessionId} model=${model && "currentValue" in model ? model.currentValue : "?"} options=${session.configOptions?.length}`)
    for (const [i, text] of prompts.entries()) {
      console.log(`\n${t()} ── prompt ${i + 1}: ${text}`)
      if (cancelAfter !== undefined && i === prompts.length - 1) {
        setTimeout(() => {
          console.log(`\n${t()} ── session/cancel`)
          void agent.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId })
        }, cancelAfter)
      }
      const attached: Array<acp.ContentBlock> = (images.get(i + 1) ?? []).map((path) => ({
        type: "image",
        data: readFileSync(path).toString("base64"),
        mimeType: MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
        uri: `file://${path}`
      }))
      if (attached.length > 0) console.log(`${t()} ── attached: ${(images.get(i + 1) ?? []).map((p) => basename(p)).join(", ")}`)
      const result = await agent.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [...(text === "" ? [] : [{ type: "text" as const, text }]), ...attached]
      })
      console.log(`\n${t()} ── stopReason: ${result.stopReason}`)
      if (between !== undefined && i < prompts.length - 1) {
        console.log(`${t()} ── between: ${between}`)
        execSync(between, { stdio: "inherit" })
      }
    }
  }
)
child.kill()
