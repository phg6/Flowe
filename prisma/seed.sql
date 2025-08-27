-- Create auth user mirror and RLS policies starter
-- Run this in Supabase SQL Editor after pushing Prisma schema

-- Ensure extensions
create extension if not exists pgcrypto;

-- Users table link (users.id should match auth.users.id)
-- Add RLS policies
alter table public.users enable row level security;
create policy users_select_own on public.users
for select using ( id = auth.uid() );

-- Customers policies: read if member
alter table public.customers enable row level security;
create policy customers_select_member on public.customers
for select using ( auth.uid() = any(members) );

-- Tags policies: read if tag customer is a member
alter table public.tags enable row level security;
create policy tags_select_member on public.tags
for select using (
  exists (
    select 1 from public.customers c
    where c.id = tags.customer and auth.uid() = any(c.members)
  )
);

-- Templates policies: owner or shared
alter table public.templates enable row level security;
create policy templates_select_owner on public.templates
for select using (
  owner = auth.uid()
);
create policy templates_select_shared_custom on public.templates
for select using (
  sharing = 'custom' and auth.uid() = any(shared_with)
);
create policy templates_select_everyone on public.templates
for select using (
  sharing = 'everyone'
);

-- Indexes for performance
create index if not exists idx_templates_customer on public.templates(customer);
create index if not exists idx_templates_owner on public.templates(owner);
create index if not exists idx_templates_sharing on public.templates(sharing);
