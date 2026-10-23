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
- **Signed in as a super admin:** you see the overview. The tenant list is empty until you create a tenant (step 7).
- **Backend stopped:** pages show "Couldn't load data from the platform API".

## 7. Create a tenant and call its API

Creating a tenant from the dashboard does real work in Clerk and in MongoDB. It creates a Clerk organization, a `tenant_<id>` database with the system roles, and config v1, and it emails an invitation.

1. Set `MONGODB_URI` in the backend's `.env` and start the backend and the admin dashboard.
2. In the dashboard, open **Tenants → New tenant**. Fill in the name (e.g. "Shenaly Rent a Car"), slug (`shenaly`), template and limits. For the admin email, use an inbox you can read.

   Prefer an address other than your super admin login (e.g. `you+shenaly@gmail.com`): super admins aren't meant to be tenant members.

3. The result page lists the provisioning steps. In the Clerk dashboard, **Organizations** now shows the organization, and the admin email receives the invitation.

   If a step fails, the error is on that step. Fix the cause, then use **Retry provisioning** on the tenant page; completed steps don't run again.
4. Accept the invitation by following the email link and signing up.
   - With webhooks set up (step 8), the backend adds you to the tenant's `members` as its Owner.
   - Without webhooks, add yourself with the seed script. `--demo` also adds sample vehicles and renters.

     ```sh
     npm run seed -- --tenant shenaly --user user_… --email you+shenaly@gmail.com --name "Your Name" --demo
     ```

     `--role staff` (or `manager`, `accountant`) tries another role.
5. Call `GET /api/v1/me` with a session token whose active organization is the tenant's. The tenant app does this from Phase 4. Until then, get a token with `getToken()` after `setActive({ organization })`.

The seed script writes to the database in `MONGODB_URI`. It's idempotent: running it again updates your member record and skips demo data the tenant already has.

## 8. Webhooks

Webhooks keep each tenant's `members` in step with Clerk: joins, removals, and name or email changes. See [platform-architecture.md](platform-architecture.md#clerk-webhooks).

1. Clerk must reach the backend over HTTPS. Locally, run a tunnel such as `ngrok http 5000` or `cloudflared tunnel --url http://localhost:5000`.
2. In the Clerk dashboard, open **Webhooks → Add Endpoint**:
   - **URL:** `https://<your tunnel or backend host>/webhooks/clerk`
   - **Events:**
     - `organizationMembership.created`, `organizationMembership.updated`, `organizationMembership.deleted`
     - `organizationInvitation.accepted`
     - `user.updated`
     - `organization.deleted`
3. Copy the endpoint's **Signing Secret** (`whsec_…`) into the backend's `.env` as `CLERK_WEBHOOK_SIGNING_SECRET`, then restart the backend.

Without the secret, `/webhooks/clerk` responds 503 and Clerk keeps retrying for a while. Use the endpoint's **Testing** tab to send a sample event. An event for an organization that isn't a tenant is acknowledged and ignored.

## Later phases

- **Phase 4, tenant app.** Add `@clerk/nextjs` to `frontend/` with the same keys. Signed-in users without an active organization are asked to choose one, since personal accounts are off.
- **Production.** Create the production instance on the root domain (e.g. `example.com`), with the tenant app on `app.example.com` and the admin dashboard on `admin.example.com`. One production instance covers subdomains of the same root domain.
