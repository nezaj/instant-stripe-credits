import { NextRequest, NextResponse } from "next/server";
import { getStripe, CREDITS_PER_PACK } from "@/lib/stripe";
import { adminDb } from "@/lib/adminDb";

export async function POST(request: NextRequest) {
  try {
    const { userId, sessionId } = await request.json();

    if (!userId || !sessionId) {
      return NextResponse.json(
        { error: "User ID and session ID required" },
        { status: 400 }
      );
    }

    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      return NextResponse.json({ synced: false });
    }

    // Skip if already processed (by webhook or a previous sync)
    if (session.metadata?.creditsProcessed === "true") {
      return NextResponse.json({ synced: true });
    }

    // Mark as processed in Stripe to prevent double-crediting
    await stripe.checkout.sessions.update(sessionId, {
      metadata: { ...session.metadata, creditsProcessed: "true" },
    });

    const { $users } = await adminDb.query({
      $users: { $: { where: { id: userId } } },
    });

    await adminDb.transact(
      adminDb.tx.$users[userId].update({
        credits: ($users[0]?.credits || 0) + CREDITS_PER_PACK,
      })
    );

    return NextResponse.json({ synced: true });
  } catch (error) {
    console.error("Sync error:", error);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}
