export const JPY = (n: number | null | undefined) =>
  "¥" + Math.round(Number(n ?? 0)).toLocaleString();

export const KRW = (n: number | null | undefined) =>
  "₩" + Math.round(Number(n ?? 0)).toLocaleString();

export const PCT = (ratio: number) => {
  if (!isFinite(ratio)) return "n/a";
  return `${(ratio * 100).toFixed(1)}%`;
};
