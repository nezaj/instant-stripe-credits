# Stripe Strategy for Usage-Based Credits

A simple pattern for adding credit pack purchases to InstantDB apps.

## The Pattern

```
1. User signs in (required — credits are tied to accounts)
2. User clicks "Buy Credits"
3. Create/fetch Stripe customer, link to InstantDB user
4. Redirect to Stripe checkout (one-time payment)
5. User pays → webhook adds credits to account
6. Success page syncs eagerly (beats webhook race)
7. User spends credits → server deducts per use
```

**The key idea:** Credits live on the user record. Stripe handles payment, our server handles the balance. Both webhook and sync use Stripe session metadata for idempotency.

## Three Moving Parts

**1. Checkout API** — Get or create Stripe customer, create session
```ts
let customerId = user.stripeCustomerId;
if (!customerId) {
  const customer = await stripe.customers.create({ email: user.email });
  customerId = customer.id;
  await adminDb.transact(
    adminDb.tx.$users[userId].update({ stripeCustomerId: customerId })
  );
}

stripe.checkout.sessions.create({
  customer: customerId,
  mode: "payment",
  metadata: { instantUserId: userId },
});
```

**2. Webhook** — Add credits on successful payment

Only one event needed: `checkout.session.completed`. Unlike subscriptions, there's no ongoing lifecycle to track.

```ts
// checkout.session.completed
if (session.metadata?.creditsProcessed === "true") break; // idempotent

await stripe.checkout.sessions.update(session.id, {
  metadata: { ...session.metadata, creditsProcessed: "true" },
});

await adminDb.transact(
  adminDb.tx.$users[userId].update({
    credits: currentCredits + CREDITS_PER_PACK,
  })
);
```

**3. Sync on Success** — Beat the webhook race
```ts
useEffect(() => {
  if (success && sessionId && user) {
    fetch("/api/stripe/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id, sessionId }),
    });
  }
}, [success, sessionId, user]);
```

## Idempotency

Both webhook and sync share the same guard:

1. Check `session.metadata.creditsProcessed`
2. If `"true"`, skip — already handled
3. Otherwise, set it to `"true"` and add credits

This prevents double-crediting regardless of which runs first or if either runs multiple times.

## Credit Deduction

Credits are spent server-side via the admin SDK:

```ts
// POST /api/generate
const currentCredits = user.credits || 0;
if (currentCredits < 1) return 402;

await adminDb.transact([
  adminDb.tx.$users[userId].update({ credits: currentCredits - 1 }),
  adminDb.tx.haikus[haikuId]
    .update({ topic, content, createdAt: Date.now() })
    .link({ author: userId }),
]);
```

Credit checks and deductions happen server-side — clients can't manipulate their balance.

## Access Control

Haikus are scoped to their author via permissions:

```ts
// instant.perms.ts
haikus: {
  allow: {
    view: "isAuthor",
    create: "false",  // Created via admin SDK
    delete: "isAuthor",
  },
  bind: ["isAuthor", "auth.id in data.ref('author.id')"],
}
```

Query normally — permissions are automatic:
```ts
db.useQuery({ haikus: { $: { order: { createdAt: "desc" } } } });
```

## Production Testing

Use a 100% off coupon to test live without real charges:

1. Create a coupon in Stripe Dashboard (live mode): 100% off, one-time
2. Checkout has `allow_promotion_codes: true` — enter the code at payment
3. Credits are added at $0 cost
4. Delete the coupon after testing

## That's It

- Stripe customer linked to InstantDB user = repeat purchases work
- Session metadata flag = idempotent credit fulfillment
- Server-side deduction = tamper-proof balance
- InstantDB permissions = users only see their own haikus

See `tutorial.md` for full implementation details.
