-- Run this once in the Supabase SQL Editor to create the dedicated
-- webapp-only users table (separate from the chatbot's `users` table).
create table if not exists webapp_users (
    id text primary key,
    name text not null,
    email text unique not null,
    password_hash text not null,
    location text not null,
    created_at timestamptz default now()
);

-- If the table already exists from before email/password support was added:
-- alter table webapp_users add column if not exists email text unique;
-- alter table webapp_users add column if not exists password_hash text;
