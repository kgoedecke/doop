#!/usr/bin/env node
/**
 * One-shot Stripe setup for doop's Team plan: creates the product and its
 * two per-seat prices ($20/seat/month, $192/seat/year) and prints the env
 * lines the server needs. Idempotent by lookup key — run it again and it
 * finds the prices it made last time.
 *
 *   STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-setup.mjs
 *
 * Then set STRIPE_WEBHOOK_SECRET from a webhook endpoint pointed at
 * <your origin>/stripe/webhook listening for checkout.session.completed and
 * customer.subscription.{created,updated,deleted}.
 */
import Stripe from 'stripe'

const key = process.env.STRIPE_SECRET_KEY
if (!key) {
  console.error('STRIPE_SECRET_KEY is required')
  process.exit(1)
}
const stripe = new Stripe(key)

/* mirrors shared/billing.ts — keep the two in step */
const PRICES = [
  { lookup: 'doop_team_month', interval: 'month', unitAmount: 2000, env: 'STRIPE_PRICE_TEAM_MONTHLY' },
  { lookup: 'doop_team_year', interval: 'year', unitAmount: 19200, env: 'STRIPE_PRICE_TEAM_YEARLY' },
]

async function findOrCreateProduct() {
  const existing = await stripe.products.search({ query: "name:'Doop Team' AND active:'true'", limit: 1 })
  if (existing.data[0]) return existing.data[0]
  return stripe.products.create({
    name: 'Doop Team',
    description: 'Shared workspaces for your whole org — billed per seat.',
  })
}

const product = await findOrCreateProduct()
const lines = []
for (const p of PRICES) {
  const found = await stripe.prices.list({ lookup_keys: [p.lookup], active: true, limit: 1 })
  const price =
    found.data[0] ??
    (await stripe.prices.create({
      product: product.id,
      currency: 'usd',
      unit_amount: p.unitAmount,
      recurring: { interval: p.interval },
      lookup_key: p.lookup,
      nickname: `Team, per seat, ${p.interval}ly`,
    }))
  lines.push(`${p.env}=${price.id}`)
}

console.log(`# product ${product.id}`)
console.log(lines.join('\n'))
