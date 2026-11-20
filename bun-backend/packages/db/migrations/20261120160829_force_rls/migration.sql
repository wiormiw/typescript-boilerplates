-- The owner would bypass its own policies; FORCE makes them bind it too (only a superuser or
-- BYPASSRLS role escapes, and the app login has neither).
ALTER TABLE "user_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit" FORCE ROW LEVEL SECURITY;
