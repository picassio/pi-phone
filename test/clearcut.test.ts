import { describe, it, expect } from "vitest";
import { 
    ClearcutClient, 
    buildLogRequest, 
    buildAnalyticsPayload 
} from "../src/server/antigravity-clearcut.ts";

describe("Clearcut telemetry", () => {
    describe("protobuf encoding", () => {
        it("encodes analytics payload correctly", () => {
            const payload = buildAnalyticsPayload("test_event", {
                session_id: "test-123",
                version: "1.5.15",
                count: 42,
                success: true,
            });
            
            expect(payload).toBeInstanceOf(Buffer);
            expect(payload.length).toBeGreaterThan(0);
            // Field 1 (event_name), wire type 2 (length-delimited)
            expect(payload[0]).toBe(0x0a);
        });

        it("encodes log request with client info", () => {
            const payload = buildAnalyticsPayload("session_start", {
                session_id: "test-123",
            });
            
            const request = buildLogRequest(1673, Date.now(), [
                { eventTimeMs: Date.now(), sourceExtension: payload }
            ], {
                clientType: 3,
                clientVersion: "1.5.15",
                osType: "linux",
                arch: "amd64",
            });
            
            expect(request).toBeInstanceOf(Buffer);
            expect(request.length).toBeGreaterThan(payload.length);
            // Field 1 (client_info), wire type 2
            expect(request[0]).toBe(0x0a);
        });

        it("encodes log request without client info", () => {
            const payload = buildAnalyticsPayload("model_call", { model: "gemini" });
            
            const request = buildLogRequest(1673, Date.now(), [
                { eventTimeMs: Date.now(), sourceExtension: payload }
            ]);
            
            expect(request).toBeInstanceOf(Buffer);
            // Field 2 (log_source), wire type 0 (varint)
            expect(request[0]).toBe(0x10);
        });
    });

    describe("ClearcutClient", () => {
        // Mock send function that returns proper WireResponse
        const mockSend = (statusCode = 200) => async () => ({
            status: statusCode,
            headers: new Headers(),
            body: (async function* () {})(),
        });

        it("skips send when not signed in", async () => {
            const logs: string[] = [];
            const client = new ClearcutClient({
                send: async () => { throw new Error("Should not be called"); },
                auth: async () => undefined,
                log: (line) => logs.push(line),
            });

            await client.sendSessionStart();
            expect(logs).toContain("clearcut: not signed in, skipping");
            client.close();
        });

        it("sends request with correct headers", async () => {
            let capturedRequest: { url: string; headers: Record<string, string>; body: string } | undefined;
            
            const client = new ClearcutClient({
                send: async (url, init) => {
                    capturedRequest = { url, headers: init.headers ?? {}, body: init.body ?? "" };
                    return { status: 200, headers: new Headers(), body: (async function* () {})() };
                },
                auth: async () => ({ token: "test-token-123" }),
                platform: { osType: "linux", arch: "amd64" },
                log: () => {},
            });

            await client.sendSessionStart();
            
            expect(capturedRequest).toBeDefined();
            expect(capturedRequest!.url).toBe("https://play.googleapis.com/log");
            expect(capturedRequest!.headers["X-Agy-Proto"]).toBe("h2");
            expect(capturedRequest!.headers["Content-Type"]).toBe("application/octet-stream");
            expect(capturedRequest!.headers["Authorization"]).toBe("Bearer test-token-123");
            expect(capturedRequest!.headers["User-Agent"]).toBe("Go-http-client/2.0");
            
            client.close();
        });

        it("does not send after close", async () => {
            let sendCount = 0;
            const client = new ClearcutClient({
                send: async () => {
                    sendCount++;
                    return { status: 200, headers: new Headers(), body: (async function* () {})() };
                },
                auth: async () => ({ token: "test-token" }),
                log: () => {},
            });

            await client.sendSessionStart();
            expect(sendCount).toBe(1);
            
            client.close();
            await client.sendModelCall("test", 100, 50, 1000);
            expect(sendCount).toBe(1); // No new send after close
        });

        it("tracks event count correctly", async () => {
            let sendCount = 0;
            const logs: string[] = [];
            
            const client = new ClearcutClient({
                send: async () => {
                    sendCount++;
                    return { status: 200, headers: new Headers(), body: (async function* () {})() };
                },
                auth: async () => ({ token: "test-token" }),
                log: (line) => logs.push(line),
            });

            await client.sendSessionStart();
            await client.sendModelCall("gemini-2.5-pro", 1000, 500, 2000);
            await client.sendModelCall("gemini-2.5-pro", 500, 200, 1000);
            await client.sendToolUse("bash", true, 100);
            await client.sendSessionEnd();
            
            expect(sendCount).toBe(5);
            const endLog = logs.find(l => l.includes("session_end sent"));
            expect(endLog).toContain("5 events");
            
            client.close();
        });

        it("logs errors but does not throw", async () => {
            const logs: string[] = [];
            const client = new ClearcutClient({
                send: async () => { throw new Error("Network error"); },
                auth: async () => ({ token: "test-token" }),
                log: (line) => logs.push(line),
            });

            // Should not throw
            await client.sendSessionStart();
            expect(logs.some(l => l.includes("request error"))).toBe(true);
            
            client.close();
        });

        it("logs non-200 status", async () => {
            const logs: string[] = [];
            const client = new ClearcutClient({
                send: async () => ({ status: 403, headers: new Headers(), body: (async function* () {})() }),
                auth: async () => ({ token: "test-token" }),
                log: (line) => logs.push(line),
            });

            await client.sendSessionStart();
            expect(logs.some(l => l.includes("status 403"))).toBe(true);
            
            client.close();
        });
    });
});
