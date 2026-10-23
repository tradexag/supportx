import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { ebayChallengeResponse, isValidVerificationToken, parseEbayDeletionNotice, parseEbaySignatureHeader, verifyEbaySignature } from "../../packages/connectors/ebay/account-deletion.ts";
import { signEbayNotice as signedNotice } from "../../packages/testing/fake-marketplaces.ts";

const BODY = JSON.stringify({ metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION", schemaVersion: "1.0", deprecated: false }, notification: { notificationId: "n-1", eventDate: "2026-10-22T08:00:00.000Z", publishDate: "2026-10-22T08:00:01.000Z", publishAttemptCount: 1, data: { username: "Kunde_1", userId: "u9", eiasToken: "x" } } });

describe("eBay account deletion", () => {
  it("answers the challenge with sha256(code + token + endpoint)", () => {
    const token = "a".repeat(40);
    const endpoint = "https://support.example/webhooks/ebay/account-deletion";
    assert.equal(ebayChallengeResponse("123", token, endpoint), createHash("sha256").update(`123${token}${endpoint}`).digest("hex"));
    assert.notEqual(ebayChallengeResponse("123", token, endpoint), createHash("sha256").update(`${token}123${endpoint}`).digest("hex"));
  });
  it("accepts only tokens eBay accepts", () => {
    assert.ok(isValidVerificationToken("Ab_-".repeat(8)));
    assert.ok(!isValidVerificationToken("short"));
    assert.ok(!isValidVerificationToken("a".repeat(31) + "!"));
  });
  it("verifies a signed notice and rejects a changed body or another key", () => {
    const { header, key } = signedNotice(BODY);
    const parsed = parseEbaySignatureHeader(header)!;
    assert.equal(parsed.kid, "kid-1");
    assert.ok(verifyEbaySignature(BODY, parsed, key));
    assert.ok(!verifyEbaySignature(BODY.replace("Kunde_1", "Kunde_2"), parsed, key));
    assert.ok(!verifyEbaySignature(BODY, parsed, signedNotice(BODY).key));
    assert.equal(parseEbaySignatureHeader("not base64 json"), null);
    assert.equal(parseEbaySignatureHeader(undefined), null);
  });
  it("reads username and user id, ignores other topics", () => {
    assert.deepEqual(parseEbayDeletionNotice(BODY), { notificationId: "n-1", username: "Kunde_1", userId: "u9" });
    assert.equal(parseEbayDeletionNotice(BODY.replace("MARKETPLACE_ACCOUNT_DELETION", "OTHER")), null);
    assert.equal(parseEbayDeletionNotice("{"), null);
  });
});
