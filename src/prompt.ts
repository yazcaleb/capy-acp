/**
 * Turns an ACP prompt into the text sent to Capy.
 *
 * T3 Code adds host instructions to prompts that describe T3-only tools Capy's agent does not
 * have. It sends two shapes (both seen in T3 Code 0.1.12):
 * - Typed in T3: `<t3_code_instructions>…</t3_code_instructions><user_request>…</user_request>`
 *   followed by `<runtime_info>` and `<pull_request_linking>` blocks.
 * - Sent by another agent: an attribution line
 *   `[T3 Code: the agent in T3 thread "…" sent this message, not the user.]` before the request,
 *   either inside that same envelope or bare with only the trailing blocks.
 * By default only the request itself is forwarded; `CAPY_ACP_FORWARD_HOST_INSTRUCTIONS=1` forwards
 * everything.
 *
 * Images, audio and binary embedded resources become files attached to the Capy message, which
 * land on the agent's machine (Capy's models see attached images).
 */
import type { ContentBlock } from "@agentclientprotocol/sdk"
import type { FileUpload } from "./capy/client.js"

/** Capy's per-file upload limit (`POST /files`). */
export const MAX_UPLOAD_BYTES = 262_144_000

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "application/pdf": "pdf"
}

/** The file name a block's URI ends in, if it has one. */
const uriName = (uri: string | null | undefined): string | undefined => {
  if (!uri) return undefined
  const path = uri.replace(/[?#].*$/, "")
  const raw = path.slice(path.lastIndexOf("/") + 1)
  let name = raw
  try {
    name = decodeURIComponent(raw)
  } catch {
    // A stray "%" (`100%.png`) is not an escape; keep the name as written.
  }
  return name === "" ? undefined : name
}

const blockText = (block: ContentBlock): string => {
  switch (block.type) {
    case "text":
      return block.text
    case "resource_link":
      return `[${block.name}](${block.uri})`
    case "resource": {
      const resource = block.resource
      if ("text" in resource) {
        return `<file uri="${resource.uri}">\n${resource.text}\n</file>`
      }
      return ""
    }
    case "image":
    case "audio":
      return ""
    default:
      return ""
  }
}

const USER_REQUEST = /<user_request>\s*([\s\S]*?)\s*<\/user_request>/
const HOST_BLOCK = /<(t3_code_instructions|runtime_info|pull_request_linking)>[\s\S]*?<\/\1>/
// Global copy for replace only: `test` on a /g regex keeps `lastIndex` between calls.
const HOST_BLOCKS = new RegExp(HOST_BLOCK.source, "g")
const ATTRIBUTION = /^\s*\[T3 Code: [^\]\n]* sent this message, not the user\.\]\s*/

/** Strips T3's host instructions from one text block, keeping the user's request. */
export const unwrapHostEnvelope = (text: string): string => {
  const request = USER_REQUEST.exec(text)
  const body =
    request?.[1] !== undefined && HOST_BLOCK.test(text.replace(USER_REQUEST, "")) ? request[1] : text.replace(HOST_BLOCKS, "")
  // The attribution can sit inside `<user_request>` too, when an agent starts a thread.
  return body.replace(ATTRIBUTION, "").trim()
}

export const promptText = (
  blocks: ReadonlyArray<ContentBlock>,
  options: { readonly forwardHostInstructions: boolean }
): string =>
  blocks
    .map((block) =>
      block.type === "text" && !options.forwardHostInstructions ? unwrapHostEnvelope(block.text) : blockText(block)
    )
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join("\n\n")

export interface PromptParts {
  readonly text: string
  readonly files: ReadonlyArray<FileUpload>
}

/** The prompt's text plus its media, decoded for upload. */
export const promptParts = (
  blocks: ReadonlyArray<ContentBlock>,
  options: { readonly forwardHostInstructions: boolean }
): PromptParts => {
  const files: Array<FileUpload> = []
  const notes: Array<string> = []
  const counts = new Map<string, number>()
  const add = (kind: string, data: string, mediaType: string, uri: string | null | undefined) => {
    const bytes = Buffer.from(data, "base64")
    const n = (counts.get(kind) ?? 0) + 1
    counts.set(kind, n)
    const name = uriName(uri) ?? `${kind}-${n}.${EXTENSIONS[mediaType] ?? "bin"}`
    if (bytes.byteLength === 0) return
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      notes.push(`[${name} was not attached: it is over Capy's 250 MB file limit]`)
      return
    }
    files.push({ name, mediaType, bytes })
  }
  for (const block of blocks) {
    if (block.type === "image") add("image", block.data, block.mimeType, block.uri)
    else if (block.type === "audio") add("audio", block.data, block.mimeType, undefined)
    else if (block.type === "resource" && "blob" in block.resource) {
      add("file", block.resource.blob, block.resource.mimeType ?? "application/octet-stream", block.resource.uri)
    }
  }
  const text = [promptText(blocks, options), ...notes].filter((part) => part !== "").join("\n\n")
  return { text, files }
}
