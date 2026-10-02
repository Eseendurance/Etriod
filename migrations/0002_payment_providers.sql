ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS payment_provider TEXT NOT NULL DEFAULT 'stripe',
  ADD COLUMN IF NOT EXISTS provider_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_customer_id TEXT;

UPDATE subscriptions
SET provider_subscription_id = stripe_subscription_id
WHERE payment_provider = 'stripe'
  AND provider_subscription_id IS NULL
  AND stripe_subscription_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_provider_ref
  ON subscriptions(payment_provider, provider_subscription_id);
