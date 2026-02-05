# Adding Usage-Based Credits to Your App

So you've built an app and want to charge per use? This tutorial walks through adding Stripe credit packs with InstantDB for balance tracking.

By the end, you'll have:
- A purchase flow that adds credits to a user's account
- Idempotent fulfillment via webhook and sync
- A server-side API that deducts credits per use
- Real-time balance updates via InstantDB

Let's get started!

1. [How it works](#how-it-works)
1. [Setting up Stripe](#setting-up-stripe)
1. [Updating the schema](#updating-the-schema)
1. [Creating the checkout flow](#creating-the-checkout-flow)
1. [Handling webhooks](#handling-webhooks)
1. [The sync strategy](#the-sync-strategy)
1. [Spending credits](#spending-credits)
1. [Protecting content with permissions](#protecting-content-with-permissions)
1. [Testing your integration](#testing-your-integration)
1. [Common mistakes](#common-mistakes)
1. [Fin](#fin)

## How it works

Before diving into code, let's understand the flow:

```
1. User signs in → Required for credit tracking
2. User clicks "Buy Credits" → Redirected to Stripe
3. User pays → Webhook adds credits to account
4. Success page syncs eagerly → Beats the webhook race
5. User generates haiku → Server deducts 1 credit
```

The key insight: credits live on the `$users` record. Stripe handles payment, our server handles the balance. Both webhook and sync use Stripe session metadata to prevent double-crediting.

## Setting up Stripe

First, create a Stripe account at [stripe.com](https://stripe.com) if you haven't already.

Install the Stripe SDK:

```bash
pnpm add stripe
```

### Create a credit pack product

1. Go to [Stripe Dashboard](https://dashboard.stripe.com/products) → Products
2. Click "Add product"
3. Name: "10 Credit Pack" (or whatever you like)
4. Pricing: $2.00, one-time
5. Copy the Price ID (`price_...`)

### Get your API keys

Grab your keys from the [Stripe Dashboard](https://dashboard.stripe.com/apikeys) and add to `.env.local`:

```bash
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PRICE_ID=price_...
STRIPE_WEBHOOK_SECRET=whsec_...  # We'll get this shortly
```

Create a Stripe client:

```ts
// src/lib/stripe.ts
import Stripe from "stripe";

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  }
  return _stripe;
}

export function getPriceId(): string {
  return process.env.STRIPE_PRICE_ID!;
}

export const CREDITS_PER_PACK = 10;
```

## Updating the schema

We store credits and the Stripe customer ID directly on the user, plus a `haikus` entity for generated content:

```ts
// instant.schema.ts
$users: i.entity({
  email: i.string().unique().indexed().optional(),
  credits: i.number().optional(),
  stripeCustomerId: i.string().optional(),
}),
haikus: i.entity({
  topic: i.string(),
  content: i.string(),
  createdAt: i.number().indexed(),
}),
```

Link haikus to their author:

```ts
links: {
  userHaikus: {
    forward: { on: "haikus", has: "one", label: "author", onDelete: "cascade" },
    reverse: { on: "$users", has: "many", label: "haikus" },
  },
},
```

Push your schema:

```bash
npx instant-cli push schema --yes
```

## Creating the checkout flow

The buy button calls our checkout API with the user ID:

```tsx
async function handlePurchase() {
  const res = await fetch("/api/stripe/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: user.id }),
  });
  const { url } = await res.json();
  window.location.href = url;
}
```

The checkout API route gets or creates a Stripe customer and creates a one-time payment session:

```ts
// src/app/api/stripe/checkout/route.ts
export async function POST(request: NextRequest) {
  const { userId } = await request.json();

  // Get user from InstantDB
  const { $users } = await adminDb.query({
    $users: { $: { where: { id: userId } } },
  });
  const user = $users[0];

  // Get or create Stripe customer
  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email || undefined,
      metadata: { instantUserId: userId },
    });
    customerId = customer.id;
    await adminDb.transact(
      adminDb.tx.$users[userId].update({ stripeCustomerId: customerId })
    );
  }

  // Create checkout session
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "payment",
    line_items: [{ price: getPriceId(), quantity: 1 }],
    success_url: `${origin}/?success=true&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/?canceled=true`,
    metadata: { instantUserId: userId },
  });

  return NextResponse.json({ url: session.url });
}
```

Note `{CHECKOUT_SESSION_ID}` in the success URL — Stripe replaces this with the actual session ID, which we use for the sync endpoint.

## Handling webhooks

When payment completes, Stripe sends a `checkout.session.completed` event. We add credits to the user:

```ts
// src/app/api/stripe/webhook/route.ts
export async function POST(request: NextRequest) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature")!;

  const event = stripe.webhooks.constructEvent(
    body, signature, process.env.STRIPE_WEBHOOK_SECRET!
  );

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;

      if (session.payment_status !== "paid") break;

      // Idempotency check
      if (session.metadata?.creditsProcessed === "true") break;

      const userId = session.metadata?.instantUserId;
      if (!userId) break;

      // Mark as processed
      await stripe.checkout.sessions.update(session.id, {
        metadata: { ...session.metadata, creditsProcessed: "true" },
      });

      // Add credits
      const { $users } = await adminDb.query({
        $users: { $: { where: { id: userId } } },
      });
      await adminDb.transact(
        adminDb.tx.$users[userId].update({
          credits: ($users[0]?.credits || 0) + CREDITS_PER_PACK,
        })
      );
      break;
    }
  }

  return NextResponse.json({ received: true });
}
```

The idempotency flag (`creditsProcessed`) prevents double-crediting if Stripe retries the webhook.

### Setting up webhook forwarding

For local development, use the Stripe CLI:

```bash
# Install Stripe CLI
brew install stripe/stripe-cli/stripe

# Login (one time)
stripe login

# Forward webhooks to your local server
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Copy the webhook signing secret (`whsec_...`) to `STRIPE_WEBHOOK_SECRET`.

For production, add the endpoint in [Stripe Dashboard](https://dashboard.stripe.com/webhooks):
- URL: `https://your-app.com/api/stripe/webhook`
- Events: `checkout.session.completed`

## The sync strategy

Webhooks can be delayed. The success page sync beats the race by checking Stripe directly:

```tsx
// Client: on success redirect
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

The sync API retrieves the specific checkout session and uses the same idempotency flag:

```ts
// src/app/api/stripe/sync/route.ts
export async function POST(request: NextRequest) {
  const { userId, sessionId } = await request.json();

  const session = await stripe.checkout.sessions.retrieve(sessionId);

  if (session.payment_status !== "paid") return;
  if (session.metadata?.creditsProcessed === "true") return; // already done

  // Mark as processed
  await stripe.checkout.sessions.update(sessionId, {
    metadata: { ...session.metadata, creditsProcessed: "true" },
  });

  // Add credits
  const { $users } = await adminDb.query({
    $users: { $: { where: { id: userId } } },
  });
  await adminDb.transact(
    adminDb.tx.$users[userId].update({
      credits: ($users[0]?.credits || 0) + CREDITS_PER_PACK,
    })
  );
}
```

Both webhook and sync share the same idempotency mechanism — whichever runs first sets the flag, the other skips.

| Location | Why |
|----------|-----|
| Webhook | Primary fulfillment path |
| Success page sync | Beats the webhook race for instant feedback |

## Spending credits

The generate API checks the balance, deducts a credit, and creates the content in a single transaction:

```ts
// src/app/api/generate/route.ts
export async function POST(request: NextRequest) {
  const { userId, topic } = await request.json();

  const { $users } = await adminDb.query({
    $users: { $: { where: { id: userId } } },
  });
  const user = $users[0];

  const currentCredits = user.credits || 0;
  if (currentCredits < 1) {
    return NextResponse.json(
      { error: "Insufficient credits", needsCredits: true },
      { status: 402 }
    );
  }

  const content = generateHaiku(topic);
  const haikuId = id();

  // Deduct credit and create haiku atomically
  await adminDb.transact([
    adminDb.tx.$users[userId].update({ credits: currentCredits - 1 }),
    adminDb.tx.haikus[haikuId]
      .update({ topic, content, createdAt: Date.now() })
      .link({ author: userId }),
  ]);

  return NextResponse.json({ haiku: { id: haikuId, topic, content } });
}
```

The credit check and deduction happen server-side via the admin SDK. Clients can't manipulate their balance.

The client handles a `402` response by opening the purchase modal:

```tsx
const data = await res.json();
if (data.needsCredits) {
  onNeedCredits(); // opens purchase modal
  return;
}
```

## Protecting content with permissions

Haikus are scoped to their author:

```ts
// instant.perms.ts
const rules = {
  haikus: {
    allow: {
      view: "isAuthor",
      create: "false",  // Created via admin SDK
      delete: "isAuthor",
    },
    bind: ["isAuthor", "auth.id in data.ref('author.id')"],
  },
};
```

Query normally — permissions are automatic:

```tsx
const { data } = db.useQuery({
  haikus: { $: { order: { createdAt: "desc" } } },
});
```

Each user only sees their own haikus. The permission enforcement happens server-side in InstantDB.

Push permissions:

```bash
npx instant-cli push perms --yes
```

## Testing your integration

### Test mode

Use Stripe's test cards:

| Card | Result |
|------|--------|
| `4242 4242 4242 4242` | Success |
| `4000 0000 0000 0002` | Declined |

Any future expiry, any CVC, any ZIP.

### Testing credit flow

1. Sign in, buy a credit pack
2. Generate haikus until credits run out
3. Verify the "no credits" prompt appears
4. Buy another pack, verify credits stack

### Production testing

To test your live deployment without spending real money:

1. Go to [Stripe Dashboard](https://dashboard.stripe.com/coupons) → Coupons (in live mode)
2. Create a coupon: 100% off, one-time use
3. Give it a memorable code like `TESTING100`
4. Deploy your app and go through checkout
5. Enter the coupon code on the Stripe checkout page — the total drops to $0
6. Complete the purchase — your webhook fires and credits are added, no charge

This works because the checkout session has `allow_promotion_codes: true`:

```ts
const session = await stripe.checkout.sessions.create({
  // ...
  allow_promotion_codes: true,
});
```

Clean up after testing:
- Delete or deactivate the coupon in the Stripe Dashboard
- Optionally reset the test user's credits via the InstantDB admin SDK

## Common mistakes

### 1. Webhook secret mismatch

Every time you restart `stripe listen`, it prints a new `whsec_...` secret. You must update `STRIPE_WEBHOOK_SECRET` and restart your dev server.

### 2. Not handling duplicate webhooks

Stripe may send the same event multiple times. Always use an idempotency mechanism:

```ts
// BAD - Credits added twice!
await addCredits(userId, CREDITS_PER_PACK);

// GOOD - Check the flag first
if (session.metadata?.creditsProcessed === "true") break;
await stripe.checkout.sessions.update(session.id, {
  metadata: { ...session.metadata, creditsProcessed: "true" },
});
await addCredits(userId, CREDITS_PER_PACK);
```

### 3. Client-side credit enforcement only

Never trust the client to enforce credit limits:

```ts
// BAD - Client checks credits, server blindly generates
if (credits > 0) callGenerateApi();

// GOOD - Server checks and deducts
const currentCredits = user.credits || 0;
if (currentCredits < 1) return 402;
```

### 4. Not setting up the production webhook

Your webhook works locally with `stripe listen`, but you need to add it in the [Stripe Dashboard](https://dashboard.stripe.com/webhooks) for production.

## Fin

You now have a usage-based payment system with:

- Stripe Checkout for credit packs
- Idempotent webhook + sync fulfillment
- Server-side credit deduction via InstantDB admin SDK
- Real-time balance updates
- Author-scoped content via permissions

The best part? Credit enforcement and content permissions happen server-side. Even if someone inspects your client code, they can't bypass it.

For more Stripe features like tiered pricing, volume discounts, or metered billing, check out the [Stripe docs](https://stripe.com/docs).
