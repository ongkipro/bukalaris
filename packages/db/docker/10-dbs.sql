-- Fresh compose volume: every local database is owned by the migration role so
-- `bukalaris_owner` can create the public/drizzle schema objects (05-roles.sql runs first).
ALTER DATABASE bukalaris OWNER TO bukalaris_owner;
CREATE DATABASE bukalaris_test OWNER bukalaris_owner;
CREATE DATABASE bukalaris_e2e OWNER bukalaris_owner;
