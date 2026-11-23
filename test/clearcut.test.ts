// Clearcut telemetry: protobuf encoding and ClearcutClient behavior.
import assert from "node:assert/strict";
import { 
    ClearcutClient, 
    buildLogRequest, 
    buildAnalyticsPayload 
} from "../src/server/antigravity-clearcut.ts";

// --- Protobuf encoding tests ---

{
    // encodes analytics payload correctly
    const payload = buildAnalyticsPayload("test_event", {
        session_id: "test-123",
        version: "1.5.15",
        count: 42,
        success: true,
    });
    
    assert.ok(payload instanceof Buffer, "payload should be Buffer");
    assert.ok(payload.length > 0, "payload should not be empty");
    // Field 1 (event_name), wire type 2 (length-delimited)
    assert.strictEqual(payload[0], 0x0a, "first byte should be 0x0a");
}

{
    // encodes log request with client info
    const payload = buildAnalyticsPayload("session_start", { session_id: "test-123" });
    
    const request = buildLogRequest(1673, Date.now(), [
        { eventTimeMs: Date.now(), sourceExtension: payload }
    ], {
        clientType: 3,
        clientVersion: "1.5.15",
        osType: "linux",
        arch: "amd64",
    });
    
    assert.ok(request instanceof Buffer, "request should be Buffer");
    assert.ok(request.length > payload.length, "request should be larger than payload");
    // Field 1 (client_info), wire type 2
    assert.strictEqual(request[0], 0x0a, "first byte should be 0x0a");
}

{
    // encodes log request without client info
    const payload = buildAnalyticsPayload("model_call", { model: "gemini" });
    
    const request = buildLogRequest(1673, Date.now(), [
        { eventTimeMs: Date.now(), sourceExtension: payload }
    ]);
    
    assert.ok(request instanceof Buffer, "request should be Buffer");
    // Field 2 (log_source), wire type 0 (varint)
    assert.strictEqual(request[0], 0x10, "first byte should be 0x10");
}

// --- ClearcutClient tests ---

{
    // skips send when not signed in
    const logs: string[] = [];
    const client = new ClearcutClient({
        send: async () => { throw new Error("Should not be called"); },
        auth: async () => undefined,
        log: (line) => logs.push(line),
    });

    await client.sendSessionStart();
    assert.ok(logs.includes("clearcut: not signed in, skipping"), "should log skip message");
    client.close();
}

{
    // sends request with correct headers
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
    
    assert.ok(capturedRequest, "request should be captured");
    assert.strictEqual(capturedRequest!.url, "https://play.googleapis.com/log");
    assert.strictEqual(capturedRequest!.headers["X-Agy-Proto"], "h2");
    assert.strictEqual(capturedRequest!.headers["Content-Type"], "application/octet-stream");
    assert.strictEqual(capturedRequest!.headers["Authorization"], "Bearer test-token-123");
    assert.strictEqual(capturedRequest!.headers["User-Agent"], "Go-http-client/2.0");
    
    client.close();
}

{
    // does not send after close
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
    assert.strictEqual(sendCount, 1, "should send once");
    
    client.close();
    await client.sendModelCall("test", 100, 50, 1000);
    assert.strictEqual(sendCount, 1, "should not send after close");
}

{
    // tracks event count correctly
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
    
    assert.strictEqual(sendCount, 5, "should send 5 times");
    const endLog = logs.find(l => l.includes("session_end sent"));
    assert.ok(endLog, "should have session_end log");
    assert.ok(endLog!.includes("5 events"), "should report 5 events");
    
    client.close();
}

{
    // logs errors but does not throw
    const logs: string[] = [];
    const client = new ClearcutClient({
        send: async () => { throw new Error("Network error"); },
        auth: async () => ({ token: "test-token" }),
        log: (line) => logs.push(line),
    });

    await client.sendSessionStart();
    assert.ok(logs.some(l => l.includes("request error")), "should log error");
    
    client.close();
}

{
    // logs non-200 status
    const logs: string[] = [];
    const client = new ClearcutClient({
        send: async () => ({ status: 403, headers: new Headers(), body: (async function* () {})() }),
        auth: async () => ({ token: "test-token" }),
        log: (line) => logs.push(line),
    });

    await client.sendSessionStart();
    assert.ok(logs.some(l => l.includes("status 403")), "should log 403 status");
    
    client.close();
}

console.log("clearcut.test.ts: all tests passed");
