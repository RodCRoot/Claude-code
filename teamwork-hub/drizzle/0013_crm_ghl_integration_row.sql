-- GoHighLevel (LeadConnector) integration status row for every existing org (additive, honest default).
INSERT INTO "integrations" ("org_id", "provider", "status", "mode")
SELECT "id", 'gohighlevel', 'not_configured', 'none' FROM "organizations"
ON CONFLICT DO NOTHING;
