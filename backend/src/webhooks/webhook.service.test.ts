import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import https from "https";
import { EventEmitter } from "events";
import { dispatchWebhook, notifySeller, signPayload } from "./webhook.service";
import * as storage from "../common/storage";

// Mock storage
vi.mock("../common/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof storage>();
  return {
    ...actual,
    getWebhooksForSeller: vi.fn(),
  };
});

describe("Webhook Service", () => {
  let requestMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    requestMock = vi.fn();
    vi.spyOn(http, "request").mockImplementation(requestMock);
    vi.spyOn(https, "request").mockImplementation(requestMock);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("signPayload", () => {
    it("generates consistent HMAC-SHA256 hex signatures", () => {
      const sig1 = signPayload("hello world", "secret123");
      const sig2 = signPayload("hello world", "secret123");
      expect(sig1).toBe(sig2);
      expect(sig1).toMatch(/^[a-f0-9]{64}$/);
    });

    it("produces different signatures for different secrets", () => {
      const sig1 = signPayload("hello world", "secret1");
      const sig2 = signPayload("hello world", "secret2");
      expect(sig1).not.toBe(sig2);
    });
  });

  describe("dispatchWebhook", () => {
    it("dispatches successfully on 200 status", async () => {
      const res = new EventEmitter();
      (res as any).statusCode = 200;
      requestMock.mockImplementation((_opts, cb) => {
        setTimeout(() => {
          cb(res as any);
          setTimeout(() => res.emit("end"), 0);
        }, 0);
        const req = new EventEmitter();
        (req as any).write = vi.fn();
        (req as any).end = vi.fn();
        (req as any).destroy = vi.fn();
        return req;
      });

      const sub = {
        id: "wh-1",
        sellerWallet: "G123",
        url: "https://example.com/webhook",
        secret: "shh",
        events: ["payment.received"] as storage.WebhookEvent[],
        active: true,
        createdAt: new Date().toISOString(),
      };

      await dispatchWebhook(sub, "payment.received", { amount: 0.05 });
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it("retries up to 3 times then silently fails on persistent errors", async () => {
      const res = new EventEmitter();
      (res as any).statusCode = 500;
      requestMock.mockImplementation((_opts, cb) => {
        setTimeout(() => {
          cb(res as any);
          setTimeout(() => res.emit("end"), 0);
        }, 0);
        const req = new EventEmitter();
        (req as any).write = vi.fn();
        (req as any).end = vi.fn();
        (req as any).destroy = vi.fn();
        return req;
      });

      const sub = {
        id: "wh-2",
        sellerWallet: "G123",
        url: "http://example.com/webhook",
        secret: "shh",
        events: [] as storage.WebhookEvent[],
        active: true,
        createdAt: new Date().toISOString(),
      };

      await dispatchWebhook(sub, "ping", { test: true });
      expect(requestMock).toHaveBeenCalledTimes(3);
    });

    it("retries on request error", async () => {
      requestMock.mockImplementation(() => {
        const req = new EventEmitter();
        (req as any).write = vi.fn();
        (req as any).end = vi.fn(() => {
          setTimeout(() => req.emit("error", new Error("ECONNREFUSED")), 0);
        });
        (req as any).destroy = vi.fn();
        return req;
      });

      const sub = {
        id: "wh-3",
        sellerWallet: "G123",
        url: "http://example.com/webhook",
        secret: "shh",
        events: [] as storage.WebhookEvent[],
        active: true,
        createdAt: new Date().toISOString(),
      };

      await dispatchWebhook(sub, "ping", { test: true });
      expect(requestMock).toHaveBeenCalledTimes(3);
    });
  });

  describe("notifySeller", () => {
    it("dispatches to all matching webhooks in parallel", async () => {
      const webhooks: storage.WebhookSubscription[] = [
        {
          id: "wh-a",
          sellerWallet: "G123",
          url: "http://a.com/hook",
          secret: "sa",
          events: ["payment.received"],
          active: true,
          createdAt: new Date().toISOString(),
        },
        {
          id: "wh-b",
          sellerWallet: "G123",
          url: "http://b.com/hook",
          secret: "sb",
          events: ["dataset.queried"],
          active: true,
          createdAt: new Date().toISOString(),
        },
      ];

      vi.mocked(storage.getWebhooksForSeller).mockResolvedValue(webhooks);

      const resA = new EventEmitter();
      (resA as any).statusCode = 200;
      const resB = new EventEmitter();
      (resB as any).statusCode = 200;

      requestMock.mockImplementation((opts, cb) => {
        setTimeout(() => {
          cb(opts.hostname === "a.com" ? resA : resB);
          setTimeout(
            () => (opts.hostname === "a.com" ? resA : resB).emit("end"),
            0,
          );
        }, 0);
        const req = new EventEmitter();
        (req as any).write = vi.fn();
        (req as any).end = vi.fn();
        (req as any).destroy = vi.fn();
        return req;
      });

      await notifySeller("G123", "payment.received", { amount: 0.05 });
      expect(requestMock).toHaveBeenCalledTimes(1); // only wh-a matches event
    });

    it("dispatches to wildcard (empty events) webhooks for any event", async () => {
      const webhooks: storage.WebhookSubscription[] = [
        {
          id: "wh-c",
          sellerWallet: "G123",
          url: "http://c.com/hook",
          secret: "sc",
          events: [],
          active: true,
          createdAt: new Date().toISOString(),
        },
      ];

      vi.mocked(storage.getWebhooksForSeller).mockResolvedValue(webhooks);

      const res = new EventEmitter();
      (res as any).statusCode = 200;
      requestMock.mockImplementation((_opts, cb) => {
        setTimeout(() => {
          cb(res as any);
          setTimeout(() => res.emit("end"), 0);
        }, 0);
        const req = new EventEmitter();
        (req as any).write = vi.fn();
        (req as any).end = vi.fn();
        (req as any).destroy = vi.fn();
        return req;
      });

      await notifySeller("G123", "dataset.created", { datasetId: "ds-1" });
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it("does nothing when no webhooks exist", async () => {
      vi.mocked(storage.getWebhooksForSeller).mockResolvedValue([]);
      await notifySeller("G999", "ping", {});
      expect(requestMock).not.toHaveBeenCalled();
    });
  });
});
