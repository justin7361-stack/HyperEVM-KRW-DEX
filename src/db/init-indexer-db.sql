-- Create the Ponder indexer database (krwdex_indexer) alongside the server DB (krwdex).
-- Ponder manages its own schema internally — we just need the DB to exist.
-- This script runs before 01-schema.sql (alphabetical order in initdb.d/).

SELECT 'CREATE DATABASE krwdex_indexer OWNER krwdex'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'krwdex_indexer')\gexec
