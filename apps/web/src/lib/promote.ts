// Shared bits for the Promote pages (DESIGN §10.5): labels and money formatting.

export const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

export const CAMPAIGN_STATUS: Record<string, string> = {
  draft: "Draft",
  held: "Waiting for payment",
  paid: "Paid",
  in_review: "In review",
  approved: "Approved",
  scheduled: "Scheduled",
  live: "Running now",
  paused: "Paused",
  completed: "Finished",
  rejected: "Not approved (refunded)",
  refunded: "Refunded",
  cancelled: "Cancelled",
};

export const ORDER_STATUS: Record<string, string> = {
  open: "Waiting for payment",
  paid: "Paid",
  refunded: "Refunded",
  partially_refunded: "Partly refunded",
  disputed: "Disputed",
  expired: "Checkout expired",
  cancelled: "Cancelled",
};

export const day = (iso: string) => iso.slice(0, 10);
