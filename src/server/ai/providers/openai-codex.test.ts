import { describe, expect, test } from "vitest";
import { extractTextFromCodexStream, isCodexSseResponse } from "./openai-codex";

describe("extractTextFromCodexStream", () => {
  test("returns final message text from streamed events", () => {
    const body = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":""}]}}\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"{\\"total\\": 12"}\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"34}"}\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"{\\"total\\": 1234}"}]}}\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1"}}\n',
    ].join("\n");

    expect(extractTextFromCodexStream(body)).toBe('{"total": 1234}');
  });

  test("falls back to delta text when no final item is present", () => {
    const body = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1"}}\n',
    ].join("\n");

    expect(extractTextFromCodexStream(body)).toBe("hello");
  });

  test("throws on failed stream events", () => {
    const body = [
      'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"token expired"}}}\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1"}}\n',
    ].join("\n");

    expect(() => extractTextFromCodexStream(body)).toThrow("token expired");
  });

  test("detects data-only SSE payloads", () => {
    const body = [
      'data: {"type":"response.output_text.delta","delta":"hello"}\n',
      'data: {"type":"response.completed","response":{"id":"resp_1"}}\n',
    ].join("\n");

    expect(isCodexSseResponse(body, "text/event-stream")).toBe(true);
    expect(isCodexSseResponse(body, "application/json")).toBe(true);
  });
});
