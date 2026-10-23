-- Native marketplace channels: eBay Commerce Message API, Kaufland Seller API
-- tickets and the Mirakl inbox (Shop Apotheke). Settings live in config, secrets
-- in secrets; sending stays off per connection until a reply route is verified.
ALTER TABLE channel_connections DROP CONSTRAINT channel_connections_kind_check;
ALTER TABLE channel_connections ADD CONSTRAINT channel_connections_kind_check
  CHECK (kind IN ('microsoft_graph', 'ebay_messages', 'kaufland_tickets', 'mirakl_inbox'));
-- OAuth state of a pending eBay consent is looked up by its hash.
CREATE INDEX channel_connections_oauth_state ON channel_connections ((config->>'oauthStateHash')) WHERE kind = 'ebay_messages';
