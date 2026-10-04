CREATE TABLE IF NOT EXISTS organization_members (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_organization_members_user ON organization_members(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_organization_members_single_owner
  ON organization_members(organization_id) WHERE role = 'owner';
CREATE INDEX IF NOT EXISTS idx_organization_members_org_role
  ON organization_members(organization_id, role);

-- The legacy schema did not record organization creators. Backfill members,
-- then use the oldest attached account as the deterministic owner.
INSERT INTO organization_members (organization_id, user_id, role)
SELECT org_id, id, 'member'
FROM users
WHERE org_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO organization_members (organization_id, user_id, role)
SELECT DISTINCT ON (org_id) org_id, id, 'owner'
FROM users
WHERE org_id IS NOT NULL
ORDER BY org_id, created_at, id
ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role;

ALTER TABLE payment_orders
  ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

UPDATE payment_orders
SET paid_amount = expected_amount, paid_at = created_at
WHERE status = 'paid' AND paid_amount IS NULL;

CREATE INDEX IF NOT EXISTS idx_payment_orders_paid_at
  ON payment_orders(paid_at DESC) WHERE status = 'paid';

CREATE INDEX IF NOT EXISTS idx_payment_orders_provider_status_currency
  ON payment_orders(payment_provider, status, currency);
CREATE INDEX IF NOT EXISTS idx_messages_created_at
  ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_created_at
  ON conversations(created_at DESC);
