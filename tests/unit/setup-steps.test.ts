import { test } from "node:test";
import assert from "node:assert/strict";
import { marketSetup, microsoftSetup, weclappSetup, type SetupInput } from "../../apps/web/src/setup-steps.ts";

const empty: SetupInput = { connections: [], accounts: [], rules: [], routes: [], erp: null };
const conn = (id: string, kind: string, extra: Partial<SetupInput["connections"][number]> = {}) =>
  ({ id, kind, health: "ok", paused: false, last_error: null, default_source_platform: "email", config: {}, ...extra });

test("nothing set up: every card starts with its first step, none is connected", () => {
  for (const m of ["kaufland", "ebay", "shop_apotheke"] as const) {
    const s = marketSetup(m, empty);
    assert.equal(s.connected, false);
    assert.equal(s.next?.key, "connect");
  }
  const amazon = marketSetup("amazon", empty);
  assert.equal(amazon.steps[0]!.external, true);
  assert.equal(amazon.next?.key, "external", "the step at the marketplace comes first");
  assert.equal(amazon.next?.action, "confirm");
  assert.equal(microsoftSetup(empty).next?.key, "connect");
  assert.equal(weclappSetup(empty).next?.key, "erp");
});

test("API market: connected once its own connection is healthy; eBay needs the seller login first", () => {
  const unchecked = marketSetup("kaufland", { ...empty, connections: [conn("k1", "kaufland_tickets", { health: "unknown" })] });
  assert.equal(unchecked.connected, false);
  assert.equal(unchecked.next?.key, "check");
  const ok = marketSetup("kaufland", { ...empty, connections: [conn("k1", "kaufland_tickets")] });
  assert.equal(ok.connected, true);
  assert.equal(ok.next?.key, "account");

  const ebay = marketSetup("ebay", { ...empty, connections: [conn("e1", "ebay_messages", { health: "unknown" })] });
  assert.equal(ebay.next?.key, "ebay_login");
  const paused = marketSetup("ebay", { ...empty, connections: [conn("e1", "ebay_messages", { paused: true, config: { sellerUsername: "x" } })] });
  assert.equal(paused.connected, false, "a paused connection does not count");
});

test("a connection of another market never counts, routes only count on the market's own connection", () => {
  const input: SetupInput = {
    ...empty,
    connections: [conn("k1", "kaufland_tickets"), conn("g1", "microsoft_graph")],
    accounts: [{ platform: "kaufland", paused: false }],
    routes: [{ connection_id: "g1", source_platform: "kaufland" }],
  };
  assert.equal(marketSetup("ebay", input).connected, false);
  const k = marketSetup("kaufland", input);
  assert.equal(k.steps.find((s) => s.key === "route")!.done, false);
  assert.equal(k.next?.key, "route");
  const done = marketSetup("kaufland", { ...input, routes: [{ connection_id: "k1", source_platform: "kaufland" }] });
  assert.equal(done.next, null);
});

test("mail market: connected only after the marketplace step is ticked off, with a healthy mailbox and a rule or the mailbox default", () => {
  const graph = conn("g1", "microsoft_graph", { default_source_platform: "shopify" });
  const ticked = { shopify: { at: "2026-10-23T09:00:00Z", by: "Alex" }, docmorris: { at: "2026-10-23T09:00:00Z", by: null } };
  const unticked = marketSetup("shopify", { ...empty, connections: [graph] });
  assert.equal(unticked.connected, false, "mail not yet set up at Shopify");
  assert.equal(unticked.next?.key, "external");
  const shop = marketSetup("shopify", { ...empty, connections: [graph], confirmations: ticked });
  assert.equal(shop.connected, true, "ticked off and the mailbox default routes to Shopify");
  const ext = shop.steps.find((s) => s.key === "external")!;
  assert.equal(ext.done, true);
  assert.equal(ext.action, "unconfirm");
  assert.match(ext.hint!, /Alex am 23\.10\.2026/);
  const dm = marketSetup("docmorris", { ...empty, connections: [graph], confirmations: ticked });
  assert.equal(dm.connected, false);
  assert.equal(dm.next?.key, "rule");
  const withRule = marketSetup("docmorris", { ...empty, connections: [graph], rules: [{ connection_id: "g1", source_platform: "docmorris" }], confirmations: ticked });
  assert.equal(withRule.connected, true);
  const broken = marketSetup("docmorris", { ...empty, connections: [{ ...graph, health: "error" }], rules: [{ connection_id: "g1", source_platform: "docmorris" }], confirmations: ticked });
  assert.equal(broken.connected, false);
});

test("errors surface on the card; weclapp is connected only after a successful check", () => {
  const k = marketSetup("kaufland", { ...empty, connections: [conn("k1", "kaufland_tickets", { health: "error", last_error: "401" })] });
  assert.equal(k.error, "401");
  assert.equal(weclappSetup({ ...empty, erp: { has_secret: true, status: "unchecked", last_error: null } }).connected, false);
  assert.equal(weclappSetup({ ...empty, erp: { has_secret: true, status: "ok", last_error: null } }).connected, true);
});

test("steps that need a connection offer no button until it exists", () => {
  const k = marketSetup("kaufland", empty);
  assert.equal(k.steps.find((s) => s.key === "check")!.action, undefined);
  assert.equal(k.steps.find((s) => s.key === "route")!.action, undefined);
  assert.equal(k.steps.find((s) => s.key === "account")!.action, "account");
  assert.equal(marketSetup("amazon", empty).steps.find((s) => s.key === "rule")!.action, undefined);
});
