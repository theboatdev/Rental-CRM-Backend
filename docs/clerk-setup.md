# Clerk setup

Both apps (and later the backend) share **one Clerk application**. Use its *development* instance locally and a separate *production* instance when deploying. Setting names below are as they appear in the Clerk dashboard (dashboard.clerk.com).

## 1. Create the application

Create an application and choose the sign-in methods you want (email + password and/or Google work well for B2B). Under **API keys**, keep the publishable key (`pk_test_…`) and secret key (`sk_test_…`) for step 6.

## 2. Organizations

- **Enable Organizations.** Each tenant is one organization.
- **Turn off personal accounts.** Tenant users must belong to an organization; there is no personal workspace.
- **Keep the default roles** `org:admin` and `org:member`. Don't add custom roles or permissions in Clerk; tenant RBAC lives in the tenant database ([rbac.md](rbac.md)).
- **Turn off organization creation by users.** Only the platform creates organizations, during provisioning.

## 3. Restrict sign-up

Set the sign-up mode to **Restricted**, so only invited people can create accounts. Tenant admins and their teams arrive through organization invitations; super admins are added by hand.

## 4. Customize the session token

Under **Sessions → Customize session token**, add:

```json
{
  "metadata": "{{user.public_metadata}}",
  "name": "{{user.full_name}}",
  "email": "{{user.primary_email_address}}"
}
```

This adds three things to the session token, without an extra API call per request:

- `sessionClaims.metadata.platformRole`, read by the admin dashboard's proxy and data layer and by the backend's `requirePlatformAdmin`;
- the name and email the backend records in audit entries. Keep public metadata small: the whole session token should stay under roughly 1.2 KB.

## 5. Make yourself a super admin

Under **Users**, open your user, and in **Metadata → Public** set:

```json
{
  "platformRole": "super_admin"
}
```

Sign out and back in (or wait for the session token to refresh, about a minute) so the new claim shows up. Public metadata can only be changed from the dashboard or the Backend API, so users can't promote themselves.

## 6. Configure the backend and the admin dashboard

Both need the keys. The admin dashboard calls the backend with your session token, and the backend checks it.

```sh
# backend repo
cp .env.example .env         # set CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY, CLERK_AUTHORIZED_PARTIES
npm run dev                  # http://localhost:5000

# adminDashboard repo
cp .env.example .env.local   # set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY, PLATFORM_API_URL
npm run dev                  # http://localhost:3001
```

To check the setup:

- **Signed out:** every page redirects to `/sign-in`.
- **Signed in without `platformRole`:** you land on `/unauthorized`.
- **Signed in as a super admin:** you see the overview, with Shenaly and two demo tenants from the backend's in-memory store.
- **Backend stopped:** pages show "Couldn't load data from the platform API".

## 7. Call the tenant API locally

Until provisioning creates real organizations (Phase 2), the seeded tenants have mock organization ids, and nobody is a member of them. To call `/api/v1` as yourself:

1. In the Clerk dashboard, under **Organizations**, create an organization (e.g. "Shenaly Rent a Car") and add yourself as a member. Copy its id (`org_…`) and your user id (`user_…`).
2. In the backend's `.env`, set `MONGODB_URI` and link the organization to a seeded tenant:

   ```sh
   SEED_CLERK_ORG_IDS=shenaly=org_…
   ```

3. Prepare the tenant database and add yourself as its owner. `--demo` adds sample vehicles and renters.

   ```sh
   npm run seed -- --user user_… --email you@example.com --name "Your Name" --demo
   ```

   `--role staff` (or `manager`, `accountant`) tries another role. `--tenant <id>` targets another tenant; the default is Shenaly.

4. Restart the backend. Call `GET /api/v1/me` with a session token whose active organization is that organization. Activate it in the app, or get a token with `getToken()` after `setActive({ organization })`.

The seed script writes to the database in `MONGODB_URI`. It's idempotent, so running it again updates your member record and skips demo data the tenant already has.

## Later phases

- **Phase 2, webhooks.** Add a webhook endpoint pointing at `<backend>/webhooks/clerk` for these events:
  - `organizationMembership.created`, `organizationMembership.updated`, `organizationMembership.deleted`
  - `organizationInvitation.accepted`
  - `user.updated`
  - `organization.deleted`

  Store its signing secret as `CLERK_WEBHOOK_SIGNING_SECRET`.
- **Phase 4, tenant app.** Add `@clerk/nextjs` to `frontend/` with the same keys. Signed-in users without an active organization are asked to choose one, since personal accounts are off.
- **Production.** Create the production instance on the root domain (e.g. `example.com`), with the tenant app on `app.example.com` and the admin dashboard on `admin.example.com`. One production instance covers subdomains of the same root domain.
