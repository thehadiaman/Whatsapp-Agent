-- Runs once, when the Compose Postgres volume is first created.
-- Integration tests use their own database so they never touch dev data.
CREATE DATABASE app_test;
