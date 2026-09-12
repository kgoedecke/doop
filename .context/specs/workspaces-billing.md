# Workspaces and billing

Status: shipped 2026-09-11. Code: `server/workspaces.ts`, `server/billing.ts`, `shared/billing.ts`,
`src/pages/Workspace.tsx`, `src/components/WorkspaceModals.tsx`.

## Problem

Canvas access was per canvas (owner + invited members + optional edit link). An org with many
canvases had to invite the same people to each one. There was also nothing to sell.

## Shape

- A **workspace** is a named container of canvases with members and roles (`owner`, `admin`,
  `member`). Every member opens every canvas in it. `canvases.workspace_id` is nullable; null is
  the owner's personal space, which behaves exactly as before.
- Access: `canAccessCanvas` gains one clause — workspace membership. `hasDurableCanvasAccess`
  likewise. `canManageCanvas` (delete, move out) = canvas owner or workspace owner/admin.
- Membership lives in memory next to the store (`server/workspaces.ts`), hydrated at boot before
  the first request, written through to `workspace_members`. The owner is a row too, so seats =
  row count.
- Invites for emails without an account are rows in `workspace_invites`; they are accepted in the
  auth hooks (after signup when no mailer exists, after email verification when one does).
- Removing a member revokes access to workspace canvases they do not own; canvases they own stay
  filed in the workspace and stay theirs. Deleting a workspace detaches every canvas back to its
  owner and cancels the subscription.

## Plans (`shared/billing.ts`)

Personal (free), Team ($20/seat/month or $192/seat/year), Enterprise (contact). Only Team is
self-serve. Display prices live in shared code; charged prices are Stripe price ids from env.

## Entitlement

`isActive(ws)` = billing disabled OR status in {active, trialing, past_due}. Only three operations
require an active workspace: create a canvas in it, invite/add a member, move a canvas in. Every
one answers `402 {error:'workspace_plan_required', workspaceId}`, which every client surface
turns into `UpgradeModal` for that workspace. Reads and edits of existing workspace canvases are
never gated.

A new workspace starts `inactive`; the client opens the plan picker immediately after creation.

## Stripe flow

1. `POST /api/workspaces/:id/billing/checkout {interval}` (admin+): ensure a Customer (metadata
   `workspaceId`), create a Checkout Session in subscription mode, quantity = member count,
   `subscription_data.metadata.workspaceId`. Browser is sent to Stripe.
2. Stripe returns to `/w/:id?checkout=success&session_id=…`. The page calls
   `POST …/billing/sync {sessionId}`; the server retrieves the session → subscription and applies
   it. This is what makes local dev work without a webhook tunnel.
3. `POST /stripe/webhook` (raw body, signature-verified, outside the session gate) handles
   `checkout.session.completed` and `customer.subscription.{created,updated,deleted}`, finds the
   workspace by `metadata.workspaceId`, applies the same `subscriptionPatch`.
4. Seat changes: `addMember`/`removeMember` call `billing.syncSeats` in the background (updates
   the subscription item quantity; Stripe prorates). Never blocks the invite.
5. Portal: `POST …/billing/portal` opens Stripe's hosted portal for cards, invoices, cancel,
   interval switches.

Statuses map via `workspaceStatusFrom`: active/trialing as is, past_due+unpaid → past_due,
canceled+incomplete_expired → canceled, else inactive.

## Env

`STRIPE_SECRET_KEY`, `STRIPE_PRICE_TEAM_MONTHLY`, `STRIPE_PRICE_TEAM_YEARLY`,
`STRIPE_WEBHOOK_SECRET`. `scripts/stripe-setup.mjs` creates the product and prices.

## Tests

`tests/workspaces.test.ts` (billing off: membership, access over REST and WS, moves, roles,
invites accepted at signup, restart, delete) and `tests/billing.test.ts` (billing on: 402 gating,
signed webhook activates/cancels, plan catalogue).

## Deliberately not done

- No trial period (Stripe can add one on the price without code changes).
- No ownership transfer; the owner cannot leave — delete instead.
- Per-canvas invites and link sharing are untouched and still work inside a workspace.
