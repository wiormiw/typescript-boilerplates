-- The group every API login role joins. NOLOGIN, so it holds no secret; db:migrate adds the login.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'starter_app') THEN
		CREATE ROLE starter_app NOLOGIN;
	END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO starter_app;
--> statement-breakpoint
-- Tables and sequences the owner creates later are usable by the group without a grant each.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO starter_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO starter_app;
