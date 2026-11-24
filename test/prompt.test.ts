import { describe, expect, it } from "@effect/vitest"
import { MAX_UPLOAD_BYTES, promptParts, promptText } from "../src/prompt.js"

const t3 = `<t3_code_instructions>
## T3 Code interaction mode: Default
Use delegate_task …
</t3_code_instructions>

<user_request>
Fix the flaky login test.
</user_request><runtime_info>In case you're asked: you are running in T3 Code.</runtime_info>

<pull_request_linking>
Link each PR …
</pull_request_linking>`

// The shape T3 sends when another agent starts or messages the thread (recorded in Capy's transcript).
const t3FromAgent = `[T3 Code: the agent in T3 thread "mcp:launch:abc123" sent this message, not the user.]

Read README.md, then create scripts/hello.sh.

<runtime_info>In case you're asked: you are running in T3 Code through the acpRegistry harness.</runtime_info>
<pull_request_linking>
Link each PR you create … checks and reviews <state>.
</pull_request_linking>`

describe("promptText", () => {
  it("forwards only the request from an agent-sent T3 message", () => {
    expect(promptText([{ type: "text", text: t3FromAgent }], { forwardHostInstructions: false })).toBe(
      "Read README.md, then create scripts/hello.sh."
    )
  })

  it("drops the attribution inside T3's full envelope too", () => {
    const text = t3.replace("Fix the flaky login test.", '[T3 Code: the agent in T3 thread "x" sent this message, not the user.]\n\nFix the flaky login test.')
    expect(promptText([{ type: "text", text }], { forwardHostInstructions: false })).toBe("Fix the flaky login test.")
  })

  it("gives the same answer on repeated calls", () => {
    for (let i = 0; i < 3; i++) {
      expect(promptText([{ type: "text", text: t3 }], { forwardHostInstructions: false })).toBe("Fix the flaky login test.")
      expect(promptText([{ type: "text", text: t3FromAgent }], { forwardHostInstructions: false })).toBe(
        "Read README.md, then create scripts/hello.sh."
      )
    }
  })

  it("leaves look-alike text alone when it is not T3's envelope", () => {
    const text = "Explain the <user_request> tag in our parser, and what [T3 Code: x] means mid-sentence."
    expect(promptText([{ type: "text", text }], { forwardHostInstructions: false })).toBe(text)
  })

  it("forwards only the user request from T3's host envelope", () => {
    expect(promptText([{ type: "text", text: t3 }], { forwardHostInstructions: false })).toBe("Fix the flaky login test.")
  })

  it("forwards everything when asked to", () => {
    expect(promptText([{ type: "text", text: t3 }], { forwardHostInstructions: true })).toContain("t3_code_instructions")
  })

  it("keeps plain prompts and attached context blocks", () => {
    const text = promptText(
      [
        { type: "text", text: "Explain this file." },
        { type: "resource", resource: { uri: "file:///repo/a.ts", text: "export {}" } },
        { type: "resource_link", name: "b.ts", uri: "file:///repo/b.ts" }
      ],
      { forwardHostInstructions: false }
    )
    expect(text).toBe("Explain this file.\n\n<file uri=\"file:///repo/a.ts\">\nexport {}\n</file>\n\n[b.ts](file:///repo/b.ts)")
  })
})

describe("promptParts", () => {
  const options = { forwardHostInstructions: false }
  const b64 = (bytes: Array<number>) => Buffer.from(bytes).toString("base64")

  it("turns images, audio and binary resources into uploads, and keeps the text", () => {
    const { text, files } = promptParts(
      [
        { type: "text", text: t3 },
        { type: "image", data: b64([1, 2, 3]), mimeType: "image/png" },
        { type: "image", data: b64([4]), mimeType: "image/jpeg", uri: "file:///home/dev/shots/login%20bug.jpg" },
        { type: "audio", data: b64([5, 6]), mimeType: "audio/wav" },
        { type: "resource", resource: { uri: "file:///home/dev/report.pdf", blob: b64([7]), mimeType: "application/pdf" } }
      ],
      options
    )
    expect(text).toBe("Fix the flaky login test.")
    expect(files.map((f) => [f.name, f.mediaType, [...f.bytes]])).toEqual([
      ["image-1.png", "image/png", [1, 2, 3]],
      ["login bug.jpg", "image/jpeg", [4]],
      ["audio-1.wav", "audio/wav", [5, 6]],
      ["report.pdf", "application/pdf", [7]]
    ])
  })

  it("numbers unnamed images and skips empty ones", () => {
    const { files } = promptParts(
      [
        { type: "image", data: b64([1]), mimeType: "image/png" },
        { type: "image", data: "", mimeType: "image/png" },
        { type: "image", data: b64([2]), mimeType: "image/x-unknown" }
      ],
      options
    )
    expect(files.map((f) => f.name)).toEqual(["image-1.png", "image-3.bin"])
  })

  it("says so in the text when a file is over Capy's limit", () => {
    const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString("base64")
    const { text, files } = promptParts([{ type: "text", text: "see video" }, { type: "audio", data: big, mimeType: "audio/wav" }], options)
    expect(files).toEqual([])
    expect(text).toBe("see video\n\n[audio-1.wav was not attached: it is over Capy's 250 MB file limit]")
  })

  it("leaves media out of the text", () => {
    expect(promptText([{ type: "image", data: b64([1]), mimeType: "image/png" }], options)).toBe("")
  })

  it("keeps a file name with a stray percent sign instead of failing the prompt", () => {
    const { files } = promptParts([{ type: "image", data: b64([1]), mimeType: "image/png", uri: "file:///tmp/100%.png" }], { forwardHostInstructions: false })
    expect(files.map((f) => f.name)).toEqual(["100%.png"])
  })
})
