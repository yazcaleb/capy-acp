/**
 * Incremental Server-Sent Events parser (WHATWG event-stream rules, minus reconnection).
 *
 * Capy's stream is read with fetch because EventSource cannot send an Authorization header,
 * so the frames are parsed here. Feed it decoded text in arbitrary chunks; complete frames
 * come out as soon as their terminating blank line arrives.
 */
export interface SseFrame {
  readonly event: string
  readonly data: string
  /** Present only when the frame carried an `id:` line. Capy sets it on `transcript` frames. */
  readonly id?: string
}

export interface SseParser {
  /** Feeds a chunk of text and returns the frames it completed. */
  readonly push: (chunk: string) => ReadonlyArray<SseFrame>
  /** Flushes a final frame that had no trailing blank line. */
  readonly end: () => ReadonlyArray<SseFrame>
}

export const makeSseParser = (): SseParser => {
  let buffer = ""
  let event = ""
  let data: Array<string> = []
  let id: string | undefined
  let sawField = false

  const dispatch = (out: Array<SseFrame>) => {
    if (sawField && data.length > 0) {
      out.push({ event: event === "" ? "message" : event, data: data.join("\n"), ...(id === undefined ? {} : { id }) })
    }
    event = ""
    data = []
    id = undefined
    sawField = false
  }

  const line = (raw: string, out: Array<SseFrame>) => {
    if (raw === "") return dispatch(out)
    if (raw.startsWith(":")) return
    const colon = raw.indexOf(":")
    const field = colon === -1 ? raw : raw.slice(0, colon)
    let value = colon === -1 ? "" : raw.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    switch (field) {
      case "event":
        event = value
        sawField = true
        return
      case "data":
        data.push(value)
        sawField = true
        return
      case "id":
        if (!value.includes("\u0000")) id = value
        sawField = true
        return
      default:
        // `retry:` and unknown fields carry nothing the adapter needs.
        return
    }
  }

  const drain = (final: boolean): ReadonlyArray<SseFrame> => {
    const out: Array<SseFrame> = []
    for (;;) {
      const match = /\r\n|\r|\n/.exec(buffer)
      if (match === null) break
      // A lone trailing "\r" may be the first half of "\r\n"; wait for the next chunk.
      if (match[0] === "\r" && match.index === buffer.length - 1 && !final) break
      line(buffer.slice(0, match.index), out)
      buffer = buffer.slice(match.index + match[0].length)
    }
    if (final) {
      if (buffer !== "") line(buffer, out)
      buffer = ""
      dispatch(out)
    }
    return out
  }

  // Chunks with no line break are only collected, and joined once a break arrives: scanning the
  // whole buffer for every chunk made one long line (a big frame) cost quadratic time.
  let pending: Array<string> = []
  const flush = () => {
    if (pending.length > 0) {
      buffer += pending.join("")
      pending = []
    }
  }

  return {
    push: (chunk) => {
      if (!/[\r\n]/.test(chunk) && !buffer.endsWith("\r")) {
        pending.push(chunk)
        return []
      }
      flush()
      buffer += chunk
      return drain(false)
    },
    end: () => {
      flush()
      return drain(true)
    }
  }
}

/** Parses a complete recorded stream, for fixtures and tests. */
export const parseSse = (text: string): ReadonlyArray<SseFrame> => {
  const parser = makeSseParser()
  return [...parser.push(text), ...parser.end()]
}
