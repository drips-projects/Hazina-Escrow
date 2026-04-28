import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express, { Express } from "express";

vi.mock("./webhook.service", () => ({
  notifySeller: vi.fn(() => Promise.resolve()),
  dispatchWebhook: vi.fn(() => Promise.resolve()),
}));

import { webhooksRouter } from "./webhook.router";
import { readStore, writeStore, Store } from "../common/storage";
import fs from "fs";
import path from "path";

const DATA_PATH = path.join(__dirname, "../../../data/datasets.json");
const BACKUP_PATH = path.join(__dirname, "../../../data/datasets.json.bak");

describe("Webhook Router", () => {
  let app: Express;

  beforeEach(async () => {
    // Backup current store
    if (fs.existsSync(DATA_PATH)) {
      fs.copyFileSync(DATA_PATH, BACKUP_PATH);
    }
    // Seed clean store
    const clean: Store = { datasets: [], transactions: [], webhooks: [] };
    await writeStore(clean);

    app = express();
    app.use(express.json());
    app.use("/api/webhooks", webhooksRouter);
  });

  afterEach(() => {
    // Restore backup
    if (fs.existsSync(BACKUP_PATH)) {
      fs.copyFileSync(BACKUP_PATH, DATA_PATH);
      fs.unlinkSync(BACKUP_PATH);
    }
  });

  describe("POST /api/webhooks", () => {
    it("registers a webhook with valid data", async () => {
      const res = await request(app)
        .post("/api/webhooks")
        .send({
          sellerWallet: "G123",
          url: "https://example.com/webhook",
          secret: "supersecret",
          events: ["payment.received", "dataset.created"],
        });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.webhook.sellerWallet).toBe("G123");
      expect(res.body.webhook.url).toBe("https://example.com/webhook");
      expect(res.body.webhook.events).toEqual([
        "payment.received",
        "dataset.created",
      ]);
      expect(res.body.webhook.active).toBe(true);
      expect(res.body.webhook.secret).toBeUndefined();
    });

    it("rejects missing sellerWallet", async () => {
      const res = await request(app).post("/api/webhooks").send({
        url: "https://example.com/webhook",
        secret: "shh",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("sellerWallet");
    });

    it("rejects invalid URL", async () => {
      const res = await request(app).post("/api/webhooks").send({
        sellerWallet: "G123",
        url: "not-a-url",
        secret: "shh",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid URL");
    });

    it("rejects non-http(s) URL", async () => {
      const res = await request(app).post("/api/webhooks").send({
        sellerWallet: "G123",
        url: "ftp://example.com/hook",
        secret: "shh",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("http or https");
    });

    it("rejects invalid event names", async () => {
      const res = await request(app)
        .post("/api/webhooks")
        .send({
          sellerWallet: "G123",
          url: "https://example.com/webhook",
          secret: "shh",
          events: ["invalid.event"],
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid events");
    });
  });

  describe("GET /api/webhooks/:sellerWallet", () => {
    it("lists webhooks for a seller without secrets", async () => {
      await request(app)
        .post("/api/webhooks")
        .send({
          sellerWallet: "GABC",
          url: "https://a.com/hook",
          secret: "secret-a",
          events: ["ping"],
        });

      const res = await request(app).get("/api/webhooks/GABC");
      expect(res.status).toBe(200);
      expect(res.body.webhooks.length).toBe(1);
      expect(res.body.webhooks[0].secret).toBeUndefined();
    });

    it("returns empty array for unknown seller", async () => {
      const res = await request(app).get("/api/webhooks/GUNKNOWN");
      expect(res.status).toBe(200);
      expect(res.body.webhooks).toEqual([]);
    });
  });

  describe("DELETE /api/webhooks/:id", () => {
    it("deletes an existing webhook", async () => {
      const create = await request(app).post("/api/webhooks").send({
        sellerWallet: "G123",
        url: "https://example.com/webhook",
        secret: "shh",
      });
      const id = create.body.webhook.id;

      const del = await request(app).delete(`/api/webhooks/${id}`);
      expect(del.status).toBe(200);
      expect(del.body.success).toBe(true);

      const list = await request(app).get("/api/webhooks/G123");
      expect(list.body.webhooks.length).toBe(0);
    });

    it("returns 404 for non-existent webhook", async () => {
      const res = await request(app).delete("/api/webhooks/wh-nonexistent");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /api/webhooks/:id", () => {
    it("updates webhook fields", async () => {
      const create = await request(app)
        .post("/api/webhooks")
        .send({
          sellerWallet: "G123",
          url: "https://old.com/hook",
          secret: "oldsecret",
          events: ["ping"],
        });
      const id = create.body.webhook.id;

      const patch = await request(app)
        .patch(`/api/webhooks/${id}`)
        .send({
          url: "https://new.com/hook",
          secret: "newsecret",
          events: ["payment.received"],
          active: false,
        });
      expect(patch.status).toBe(200);
      expect(patch.body.webhook.url).toBe("https://new.com/hook");
      expect(patch.body.webhook.events).toEqual(["payment.received"]);
      expect(patch.body.webhook.active).toBe(false);
      expect(patch.body.webhook.secret).toBeUndefined();
    });

    it("rejects invalid URL on patch", async () => {
      const create = await request(app).post("/api/webhooks").send({
        sellerWallet: "G123",
        url: "https://old.com/hook",
        secret: "oldsecret",
      });
      const id = create.body.webhook.id;

      const patch = await request(app).patch(`/api/webhooks/${id}`).send({
        url: "bad-url",
      });
      expect(patch.status).toBe(400);
    });

    it("returns 404 for non-existent webhook", async () => {
      const res = await request(app)
        .patch("/api/webhooks/wh-xyz")
        .send({ active: false });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/webhooks/:id/test", () => {
    it("returns success for test ping (non-blocking)", async () => {
      const create = await request(app).post("/api/webhooks").send({
        sellerWallet: "G123",
        url: "https://example.com/webhook",
        secret: "shh",
      });
      const id = create.body.webhook.id;

      const res = await request(app).post(`/api/webhooks/${id}/test`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("returns 400 for inactive webhook", async () => {
      const create = await request(app).post("/api/webhooks").send({
        sellerWallet: "G123",
        url: "https://example.com/webhook",
        secret: "shh",
      });
      const id = create.body.webhook.id;

      await request(app).patch(`/api/webhooks/${id}`).send({ active: false });

      const res = await request(app).post(`/api/webhooks/${id}/test`);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("inactive");
    });

    it("returns 404 for non-existent webhook", async () => {
      const res = await request(app).post("/api/webhooks/wh-ghost/test");
      expect(res.status).toBe(404);
    });
  });
});
