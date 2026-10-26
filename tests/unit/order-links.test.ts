import { test } from "node:test";
import assert from "node:assert/strict";
import { orderLinks } from "../../apps/web/src/order-links.ts";

test("Amazon and eBay order numbers link to the order on the marketplace", () => {
  const amazon = orderLinks({ order: { id: "1", orderNumber: "028-0960602-3405919" }, platforms: ["email"] });
  assert.deepEqual(amazon.map((l) => l.href), ["https://sellercentral.amazon.de/orders-v3/order/028-0960602-3405919"]);
  const ebay = orderLinks({ order: { id: "2", orderNumber: "AU-1", orderNumberAtCustomer: "12-34567-89012" }, platforms: ["ebay"] });
  assert.deepEqual(ebay.map((l) => l.href), ["https://www.ebay.de/sh/ord/details?orderid=12-34567-89012"]);
});

test("Shop Apotheke links into the Mirakl back office only when it is connected over https", () => {
  const order = { id: "3", orderNumberAtCustomer: "SA-123-A" };
  assert.deepEqual(orderLinks({ order, platforms: ["shop_apotheke"], miraklBaseUrl: "https://shop.mirakl.net/api" }).map((l) => l.href), ["https://shop.mirakl.net/mmp/shop/order/SA-123-A"]);
  assert.deepEqual(orderLinks({ order, platforms: ["shop_apotheke"] }), []);
  assert.deepEqual(orderLinks({ order, platforms: ["shop_apotheke"], miraklBaseUrl: "http://shop.mirakl.net" }), []);
});

test("the weclapp order page is built from the tenant address, no marketplace link is guessed for unknown numbers", () => {
  const links = orderLinks({ order: { id: "108472266", orderNumber: "AU-10003", orderNumberAtCustomer: "1001" }, platforms: ["shopify"], erpBaseUrl: "https://firma.weclapp.com/webapp/api/v2" });
  assert.deepEqual(links.map((l) => l.href), ["https://firma.weclapp.com/app/sales-order/108472266"]);
  assert.deepEqual(orderLinks({ order: { id: "so-shop-1" }, platforms: [], erpBaseUrl: "https://firma.weclapp.com/webapp/api/v2" }), [], "only numeric weclapp ids");
});
