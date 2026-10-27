import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { setPlatformSending } from "../../packages/services/connections.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { closeDb, createHarness, seedWorkspace, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

describe("sending per marketplace", () => {
  it("one owner click opens replies for one platform; stopping revokes only that platform", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const routes = async () =>
      (await h!.ctx.db.query<{ source_platform: string }>("SELECT source_platform FROM reply_route_verifications WHERE connection_id = $1 AND revoked_at IS NULL ORDER BY 1", [s.connectionId])).rows.map((r) => r.source_platform);
    const sendEnabled = async () => (await h!.ctx.db.query<{ send_enabled: boolean }>("SELECT send_enabled FROM channel_connections WHERE id = $1", [s.connectionId])).rows[0]!.send_enabled;

    await assert.rejects(setPlatformSending(h.ctx, s.agent, s.connectionId, "amazon", true), (e: ServiceError) => e.code === "FORBIDDEN");
    await setPlatformSending(h.ctx, s.owner, s.connectionId, "amazon", true);
    await setPlatformSending(h.ctx, s.owner, s.connectionId, "docmorris", true);
    await setPlatformSending(h.ctx, s.owner, s.connectionId, "amazon", true);
    assert.deepEqual(await routes(), ["amazon", "docmorris"], "a second click does not duplicate the route");
    assert.equal(await sendEnabled(), true);

    await setPlatformSending(h.ctx, s.owner, s.connectionId, "amazon", false);
    assert.deepEqual(await routes(), ["docmorris"]);
    assert.equal(await sendEnabled(), true, "the mailbox keeps sending for DocMorris");
  });
});
