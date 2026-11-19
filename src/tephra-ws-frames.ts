/**
 * The WebSocket framing (RFC 6455) a push-only client needs, with no I/O: a parser for what the server sends
 * and an encoder for the few frames a client sends back (pong and close, always masked). Pure so it can be
 * tested byte by byte. The parser is strict about what a hostile or broken peer could send: it refuses a
 * masked server frame, reserved bits, an oversized message, a bad control frame and invalid UTF-8, and it
 * never buffers more than `maxMessageBytes` of one message.
 */

export const WS_OP_CONTINUATION = 0x0;
export const WS_OP_TEXT = 0x1;
export const WS_OP_BINARY = 0x2;
export const WS_OP_CLOSE = 0x8;
export const WS_OP_PING = 0x9;
export const WS_OP_PONG = 0xa;

/** Tephra's `graph:changed` notification is a few hundred bytes; nothing it sends needs more than this. */
export const WS_MAX_MESSAGE_BYTES = 1024 * 1024;

export type WsEvent =
	| { type: "text"; text: string }
	| { type: "ping"; payload: Uint8Array }
	| { type: "close" }
	| { type: "error"; reason: string };

export class WsFrameParser {
	private buffer: Uint8Array = new Uint8Array(0);
	/** Parts of a fragmented text message in progress, or null when none is. */
	private fragments: Uint8Array[] | null = null;
	private fragmentBytes = 0;
	/** A fragmented binary message in progress: its bytes are dropped, only the sequence is tracked. */
	private skippingBinary = false;
	private failed = false;

	constructor(private readonly maxMessageBytes: number = WS_MAX_MESSAGE_BYTES) {}

	/** Feeds received bytes; returns the events they complete. After an `error` event the parser yields nothing more. */
	push(chunk: Uint8Array): WsEvent[] {
		if (this.failed) return [];
		const events: WsEvent[] = [];
		this.buffer = this.buffer.length === 0 ? chunk : concat(this.buffer, chunk);
		for (;;) {
			const step = this.nextFrame(events);
			if (step === "need-more") break;
			if (step === "failed") {
				this.failed = true;
				this.buffer = new Uint8Array(0);
				break;
			}
		}
		return events;
	}

	private fail(events: WsEvent[], reason: string): "failed" {
		events.push({ type: "error", reason });
		return "failed";
	}

	private nextFrame(events: WsEvent[]): "ok" | "need-more" | "failed" {
		const buf = this.buffer;
		if (buf.length < 2) return "need-more";
		const fin = (buf[0] & 0x80) !== 0;
		const rsv = buf[0] & 0x70;
		const opcode = buf[0] & 0x0f;
		const masked = (buf[1] & 0x80) !== 0;
		let length = buf[1] & 0x7f;
		let offset = 2;
		if (rsv !== 0) return this.fail(events, "reserved bits set");
		if (masked) return this.fail(events, "server frame is masked");
		if (length === 126) {
			if (buf.length < 4) return "need-more";
			length = (buf[2] << 8) | buf[3];
			offset = 4;
		} else if (length === 127) {
			if (buf.length < 10) return "need-more";
			const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
			const big = view.getBigUint64(2);
			if (big > BigInt(this.maxMessageBytes)) return this.fail(events, "frame too large");
			length = Number(big);
			offset = 10;
		}
		const isControl = (opcode & 0x8) !== 0;
		if (isControl && (!fin || length > 125)) return this.fail(events, "bad control frame");
		if (!isControl && length > this.maxMessageBytes) return this.fail(events, "frame too large");
		if (buf.length < offset + length) return "need-more";
		const payload = buf.slice(offset, offset + length);
		this.buffer = buf.slice(offset + length);

		switch (opcode) {
			case WS_OP_PING:
				events.push({ type: "ping", payload });
				return "ok";
			case WS_OP_PONG:
				return "ok";
			case WS_OP_CLOSE:
				events.push({ type: "close" });
				this.failed = true; // nothing after a close frame is read
				return "failed";
			case WS_OP_TEXT:
			case WS_OP_BINARY:
				if (this.fragments !== null || this.skippingBinary) return this.fail(events, "new message inside a fragmented one");
				if (opcode === WS_OP_BINARY) {
					this.skippingBinary = !fin;
					return "ok";
				}
				if (fin) return this.deliver(events, [payload], payload.length);
				this.fragments = [payload];
				this.fragmentBytes = payload.length;
				return "ok";
			case WS_OP_CONTINUATION: {
				if (this.skippingBinary) {
					if (fin) this.skippingBinary = false;
					return "ok";
				}
				if (this.fragments === null) return this.fail(events, "continuation with nothing to continue");
				this.fragments.push(payload);
				this.fragmentBytes += payload.length;
				if (this.fragmentBytes > this.maxMessageBytes) return this.fail(events, "message too large");
				if (!fin) return "ok";
				const parts = this.fragments;
				const total = this.fragmentBytes;
				this.fragments = null;
				this.fragmentBytes = 0;
				return this.deliver(events, parts, total);
			}
			default:
				return this.fail(events, "unknown opcode");
		}
	}

	private deliver(events: WsEvent[], parts: Uint8Array[], total: number): "ok" | "failed" {
		const whole = new Uint8Array(total);
		let at = 0;
		for (const part of parts) {
			whole.set(part, at);
			at += part.length;
		}
		try {
			events.push({ type: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(whole) });
			return "ok";
		} catch {
			return this.fail(events, "text is not valid UTF-8");
		}
	}
}

/** A client frame: always FIN, always masked (RFC 6455 §5.3). `mask` is four random bytes. */
export function encodeClientFrame(opcode: number, payload: Uint8Array, mask: Uint8Array): Uint8Array {
	if (mask.length !== 4) throw new Error("a WebSocket mask is four bytes");
	if (payload.length > 125) throw new Error("only short control frames are sent");
	const frame = new Uint8Array(2 + 4 + payload.length);
	frame[0] = 0x80 | opcode;
	frame[1] = 0x80 | payload.length;
	frame.set(mask, 2);
	for (let i = 0; i < payload.length; i++) frame[6 + i] = payload[i] ^ mask[i % 4];
	return frame;
}

/** A close frame carrying a status code (1000 normal, 1002 protocol error). */
export function encodeCloseFrame(code: number, mask: Uint8Array): Uint8Array {
	return encodeClientFrame(WS_OP_CLOSE, new Uint8Array([(code >> 8) & 0xff, code & 0xff]), mask);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}
