const number = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const debitTotal = ({
  amount,
  tip = 0,
  fee = 0,
  ourfee = 0,
}: {
  amount: unknown;
  tip?: unknown;
  fee?: unknown;
  ourfee?: unknown;
}) => number(amount) + number(tip) + number(fee) + number(ourfee);

// Enforce a caller-specific spending allowance at debit's final choke point,
// after mutable invoice metadata (notably an internal invoice tip) and fees have
// been captured. Checking earlier lets a recipient mutate the tip between the
// NWC budget check and the ledger debit.
export const assertWithinSpendLimit = ({
  amount,
  tip = 0,
  fee = 0,
  ourfee = 0,
  maxTotal,
}: {
  amount: unknown;
  tip?: unknown;
  fee?: unknown;
  ourfee?: unknown;
  maxTotal?: number;
}) => {
  const total = debitTotal({ amount, tip, fee, ourfee });
  if (maxTotal !== undefined && total > maxTotal)
    throw new Error(`Budget exceeded: ${total} of ${maxTotal} remaining`);
  return total;
};
