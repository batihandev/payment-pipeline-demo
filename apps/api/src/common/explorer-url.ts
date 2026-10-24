/** The block explorer page for a transaction, or null when the payment has none. */
export function explorerUrl(
  explorer: string,
  transactionHash: string | null,
): string | null {
  return transactionHash
    ? `${explorer.replace(/\/$/, '')}/tx/${transactionHash}`
    : null;
}
