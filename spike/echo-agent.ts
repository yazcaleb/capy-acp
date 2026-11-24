// Spike: the smallest ACP v1 agent, to confirm T3 Code launches a local ACP command.
// Run: node spike/echo-agent.ts (Node 26 strips the types).
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"

let nextSession = 0

const app = acp.agent({ name: "capy-acp-echo" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {},
    agentInfo: { name: "capy-acp-echo", version: "0.0.0" },
    authMethods: []
  }))
  .onRequest(acp.methods.agent.session.new, () => ({ sessionId: `echo-${++nextSession}` }))
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const text = params.prompt.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("")
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo: ${text}` } }
    })
    return { stopReason: "end_turn" }
  })
  .onNotification(acp.methods.agent.session.cancel, () => {})

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
)
await app.connect(stream).closed
