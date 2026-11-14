import { describe, expect, it } from "vitest";
import { WS_OP_BINARY, WS_OP_CLOSE, WS_OP_CONTINUATION, WS_OP_PING, WS_OP_PONG, WS_OP_TEXT, WsFrameParser, encodeClientFrame, encodeCloseFrame } from "../../src/tephra-ws-frames";

const enc = new TextEncoder();

/** An unmasked server frame, the way Tephra sends them. */
function serverFrame(opcode: number, payload: Uint8Array, opts: { fin?: boolean; rsv?: number; masked?: boolean } = {}): Uint8Array {
	const fin = opts.fin ?? true;
	const head: number[] = [(fin ? 0x80 : 0) | (opts.rsv ?? 0) | opcode];
	const maskBit = opts.masked ? 0x80 : 0;
	if (payload.length < 126) head.push(maskBit | payload.length);
	else if (payload.length < 65536) head.push(maskBit | 126, payload.length >> 8, payload.length & 0xff);
	else {
		const len = new Uint8Array(8);
		new DataView(len.buffer).setBigUint64(0, BigInt(payload.length));
		head.push(maskBit | 127, ...len);
	}
	return new Uint8Array([...head, ...payload]);
}
const text = (s: string, opts?: Parameters<typeof serverFrame>[2]) => serverFrame(WS_OP_TEXT, enc.encode(s), opts);

describe("WsFrameParser", () => {
	it("reads a small text frame, a 16-bit-length frame and a 64-bit-length frame", () => {
		const parser = new WsFrameParser(1 << 20);
		const medium = "m".repeat(300);
		const large = "l".repeat(70_000);
		expect(parser.push(text("hello"))).toEqual([{ type: "text", text: "hello" }]);
		expect(parser.push(text(medium))).toEqual([{ type: "text", text: medium }]);
		expect(parser.push(text(large))).toEqual([{ type: "text", text: large }]);
	});

	it("reads several frames in one chunk, and one frame split at every byte boundary", () => {
		const parser = new WsFrameParser();
		expect(parser.push(new Uint8Array([...text("a"), ...text("b")]))).toEqual([
			{ type: "text", text: "a" },
			{ type: "text", text: "b" },
		]);
		const frame = text("héllo ✓");
		const events = [];
		for (const byte of frame) events.push(...parser.push(new Uint8Array([byte])));
		expect(events).toEqual([{ type: "text", text: "héllo ✓" }]);
	});

	it("joins a fragmented text message, with a ping allowed between the fragments", () => {
		const parser = new WsFrameParser();
		const events = [
			...parser.push(serverFrame(WS_OP_TEXT, enc.encode("par"), { fin: false })),
			...parser.push(serverFrame(WS_OP_PING, enc.encode("p"))),
			...parser.push(serverFrame(WS_OP_CONTINUATION, enc.encode("ts"))),
		];
		const ping = events[0];
		expect(ping.type === "ping" && [...ping.payload]).toEqual([...enc.encode("p")]); // (compared as numbers: the test env mixes Uint8Array realms)
		expect(events[1]).toEqual({ type: "text", text: "parts" });
		expect(events).toHaveLength(2);
	});

	it("a multi-byte character split across two fragments decodes whole", () => {
		const parser = new WsFrameParser();
		const bytes = enc.encode("✓"); // three bytes
		const events = [
			...parser.push(serverFrame(WS_OP_TEXT, bytes.slice(0, 1), { fin: false })),
			...parser.push(serverFrame(WS_OP_CONTINUATION, bytes.slice(1))),
		];
		expect(events).toEqual([{ type: "text", text: "✓" }]);
	});

	it("ignores pongs and binary messages (single or fragmented) and goes on reading", () => {
		const parser = new WsFrameParser();
		const events = [
			...parser.push(serverFrame(WS_OP_PONG, new Uint8Array(0))),
			...parser.push(serverFrame(WS_OP_BINARY, new Uint8Array([1, 2]))),
			...parser.push(serverFrame(WS_OP_BINARY, new Uint8Array([1]), { fin: false })),
			...parser.push(serverFrame(WS_OP_CONTINUATION, new Uint8Array([2]))),
			...parser.push(text("after")),
		];
		expect(events).toEqual([{ type: "text", text: "after" }]);
	});

	it("reports a close frame and reads nothing after it", () => {
		const parser = new WsFrameParser();
		const events = parser.push(new Uint8Array([...serverFrame(WS_OP_CLOSE, new Uint8Array([0x03, 0xe8])), ...text("late")]));
		expect(events).toEqual([{ type: "close" }]);
		expect(parser.push(text("later"))).toEqual([]);
	});

	describe("refuses what a broken or hostile peer could send", () => {
		const cases: Array<[string, Uint8Array]> = [
			["a masked server frame", text("x", { masked: true })],
			["reserved bits set", text("x", { rsv: 0x40 })],
			["an unknown opcode", serverFrame(0x3, new Uint8Array(0))],
			["a fragmented control frame", serverFrame(WS_OP_PING, new Uint8Array(0), { fin: false })],
			["a control frame over 125 bytes", serverFrame(WS_OP_PING, new Uint8Array(126))],
			["a continuation with nothing to continue", serverFrame(WS_OP_CONTINUATION, enc.encode("x"))],
			["invalid UTF-8", serverFrame(WS_OP_TEXT, new Uint8Array([0xff, 0xfe]))],
		];
		for (const [name, bytes] of cases) {
			it(name, () => {
				const parser = new WsFrameParser();
				const events = parser.push(bytes);
				expect(events).toHaveLength(1);
				expect(events[0].type).toBe("error");
				expect(parser.push(text("fine"))).toEqual([]); // dead after an error
			});
		}

		it("a new message started inside a fragmented one", () => {
			const parser = new WsFrameParser();
			parser.push(serverFrame(WS_OP_TEXT, enc.encode("a"), { fin: false }));
			expect(parser.push(text("b"))[0].type).toBe("error");
		});

		it("a message over the cap, announced up front or reached by fragments, without buffering it", () => {
			const small = new WsFrameParser(100);
			expect(small.push(text("x".repeat(101)))[0].type).toBe("error");

			const huge = new Uint8Array(10);
			huge[0] = 0x81;
			huge[1] = 127;
			new DataView(huge.buffer).setBigUint64(2, 2n ** 40n); // a terabyte announced, no payload sent
			expect(new WsFrameParser(100).push(huge)[0].type).toBe("error");

			const fragments = new WsFrameParser(100);
			expect(fragments.push(serverFrame(WS_OP_TEXT, enc.encode("x".repeat(60)), { fin: false }))).toEqual([]);
			expect(fragments.push(serverFrame(WS_OP_CONTINUATION, enc.encode("x".repeat(60)), { fin: false }))[0].type).toBe("error");
		});
	});
});

describe("client frames", () => {
	const mask = new Uint8Array([0x37, 0xfa, 0x21, 0x3d]);

	it("encodes a masked pong that unmasks to its payload", () => {
		const frame = encodeClientFrame(WS_OP_PONG, enc.encode("hi"), mask);
		expect(frame[0]).toBe(0x80 | WS_OP_PONG);
		expect(frame[1]).toBe(0x80 | 2);
		expect([...frame.slice(2, 6)]).toEqual([...mask]);
		expect([...frame.slice(6)].map((b, i) => b ^ mask[i % 4])).toEqual([...enc.encode("hi")]);
	});

	it("encodes a close frame with its status code, masked", () => {
		const frame = encodeCloseFrame(1002, mask);
		expect(frame[0]).toBe(0x80 | WS_OP_CLOSE);
		expect([...frame.slice(6)].map((b, i) => b ^ mask[i % 4])).toEqual([0x03, 0xea]);
	});

	it("refuses a bad mask length or a payload that isn't a short control frame", () => {
		expect(() => encodeClientFrame(WS_OP_PONG, new Uint8Array(0), new Uint8Array(3))).toThrow();
		expect(() => encodeClientFrame(WS_OP_PONG, new Uint8Array(126), mask)).toThrow();
	});
});
