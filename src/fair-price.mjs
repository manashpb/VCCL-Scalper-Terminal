// The FNO Analyzer's quote-anchored delta, gamma and theta projection.
export function estimatePremium(quote, level, contract, now = Date.now()) {
  if (!contract || !Number.isFinite(level) || level <= 0) return null;
  const call = contract.optionType === 'CE';
  if (now >= Date.parse(contract.expiry + 'T15:30:00+05:30')) {
    return Math.max(0, call ? level - contract.strike : contract.strike - level);
  }
  if (!quote || now - quote.receivedAt >= 5000) return null;
  const { ltp, spot, delta, gamma, theta } = quote;
  if (![ltp, spot, delta, gamma, theta].every(Number.isFinite) || ltp < 0 || spot <= 0 ||
      gamma < 0 || (call ? delta < 0 || delta > 1 : delta < -1 || delta > 0)) return null;
  const move = level - spot;
  const premium = ltp + delta * move + .5 * gamma * move ** 2 + theta / 7;
  return Number.isFinite(premium) ? Math.max(0, premium) : null;
}
