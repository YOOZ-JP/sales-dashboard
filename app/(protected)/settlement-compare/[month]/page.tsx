import { notFound } from "next/navigation";

import SettlementCompareClient from "@/features/settlement/components/SettlementCompareClient";

function validMonth(month: string) {
  if (!/^\d{6}$/.test(month)) return false;
  const m = Number(month.slice(4, 6));
  return m >= 1 && m <= 12;
}

export default async function SettlementComparePage({
  params,
}: {
  params: Promise<{ month: string }>;
}) {
  const { month } = await params;
  if (!validMonth(month)) notFound();
  return <SettlementCompareClient month={month} />;
}
