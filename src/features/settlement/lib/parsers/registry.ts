/**
 * Platform detection registry.
 *
 * A file gets routed to exactly one parser. Detection uses 3 signals
 * (filename, header row, sheet name) and produces a confidence score.
 * If confidence < 0.5 the file falls through to manual review.
 */
import type { PlatformDetection } from "@/features/settlement/lib/schema/sales";

export interface PlatformSignature {
  code: string;
  filenamePatterns: RegExp[];
  headerKeywords?: string[];      // any header cell contains one of these
  sheetPatterns?: RegExp[];
  weight?: number;                // detection priority (higher wins on tie)
}

export const SIGNATURES: PlatformSignature[] = [
  {
    code: "cmoa",
    filenamePatterns: [/CD\d+_N\d+_\d+_.*(支払案内書|meisai)/i, /cmoa/i],
    headerKeywords: ["作品ID", "サービス区分"],
    weight: 10,
  },
  {
    code: "mbj",
    filenamePatterns: [
      /Apple Books/i,
      /アニメイトブックストア/,
      /PF_\d+_RIVERSE_\d+_支払通知書/i,
    ],
    weight: 10,
  },
  {
    code: "piccoma_ads",
    filenamePatterns: [/動画リワード.*RIVERSE/, /砂時計/],
    weight: 10,
  },
  {
    code: "mediado",
    filenamePatterns: [
      /BR\d+_RIVERSE_コミック/,
      /BR\d+_RIVERSE_タテヨミ/,
      /BR\d+_RIVERSE_書籍/,
    ],
    weight: 10,
  },
  {
    code: "beltoon",
    filenamePatterns: [/beltoon/i],
    weight: 10,
  },
  {
    code: "lezhin",
    filenamePatterns: [/lezhin/i],
    weight: 10,
  },
  {
    code: "beaglee",
    filenamePatterns: [/beaglee/i, /まんが王国/],
    weight: 10,
  },
  {
    code: "renta",
    filenamePatterns: [/PAS\d+-A-\d+rnt_jp/i, /パピレス掲載料通知書/],
    weight: 10,
  },
  {
    code: "booklive",
    filenamePatterns: [/株式会社ＲＩＶＥＲＳＥ.*売上報告書/, /A0698a_株式会社ＲＩＶＥＲＳＥ/],
    weight: 10,
  },
  {
    code: "comico",
    filenamePatterns: [/^2026\d{2}\.xlsx$/, /comico/i],
    weight: 5,
  },
  {
    code: "dmm",
    filenamePatterns: [/\d+_株式会社RIVERSE_支払通知書/, /DMM/i],
    weight: 10,
  },
  {
    code: "ebj_line",
    filenamePatterns: [/ExportCSV_PaymentReport_\d+_EpiVol/i, /payment-report-\d+/i],
    weight: 10,
  },
  {
    code: "line_ad",
    filenamePatterns: [/\d+_N\d+_R\d+_N\d+_\(株\)RIVERSE様/],
    weight: 10,
  },
  {
    code: "mangabang",
    filenamePatterns: [/mangabang.*ticket/i, /RIVERSE様_支払通知書/],
    weight: 10,
  },
  {
    code: "sb_creative_m",
    filenamePatterns: [/\d+_株式会社RIVERSE様【\d+年\d+月】前払印税報告書/],
    weight: 10,
  },
  {
    code: "shueisha",
    filenamePatterns: [/\d+_支払通知書（集英社）/],
    weight: 10,
  },
  {
    code: "u_next",
    filenamePatterns: [/hol\d+_株式会社RIVERSE御中_\d+/],
    weight: 10,
  },
  {
    code: "piccoma",
    filenamePatterns: [/取次report_株式会社RIVERSE/, /出版社report_株式会社RIVERSE/],
    weight: 10,
  },
  {
    code: "piccoma_gaiakuhan",
    filenamePatterns: [
      /外販お支払報告書/,
      /ピッコマEPUB外販ロイヤリティー/,
    ],
    weight: 10,
  },
  {
    code: "mechacomic",
    filenamePatterns: [/^RIVERSE_\d{6}\.xlsx$/],
    weight: 10,
  },
  {
    code: "ichijinsha",
    filenamePatterns: [/支払通知書\.pdf$/, /詳細別送の内訳/],
    // Folder-based signal is the tiebreaker: `20260331_ICHIJINSHA/`
    weight: 5,
  },
  {
    code: "kadokawa",
    filenamePatterns: [/\d+_R\d+_\d+\.pdf$/, /支払通知書_\d{8}_\d+\.csv/],
    weight: 10,
  },
  {
    code: "sb_creative_e",
    filenamePatterns: [/支払通知書_\d+年\d+月\d+日お支払い/],
    weight: 10,
  },
];

export function detectPlatform(opts: {
  filename: string;
  folderName?: string;
  headerSample?: string[];
  sheetNames?: string[];
}): PlatformDetection {
  const { filename, folderName, headerSample = [] } = opts;
  const signals: string[] = [];
  const scores: Record<string, { score: number; reasons: string[] }> = {};

  for (const sig of SIGNATURES) {
    let score = 0;
    const reasons: string[] = [];

    // Filename match is the strongest signal
    for (const pat of sig.filenamePatterns) {
      if (pat.test(filename)) {
        score += (sig.weight ?? 1) * 10;
        reasons.push(`filename~${pat.source}`);
      }
    }

    // Folder name hint (202603_cmoa → cmoa)
    if (folderName && folderName.toLowerCase().includes(sig.code.replace(/_/g, ""))) {
      score += 3;
      reasons.push(`folder~${folderName}`);
    }

    // Header keyword match
    if (sig.headerKeywords) {
      for (const kw of sig.headerKeywords) {
        if (headerSample.some(h => h && String(h).includes(kw))) {
          score += 2;
          reasons.push(`header~${kw}`);
        }
      }
    }

    if (score > 0) scores[sig.code] = { score, reasons };
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1].score - a[1].score);
  if (sorted.length === 0) {
    return { platform_code: "unknown", confidence: 0, signals: ["no match"] };
  }

  const [topCode, top] = sorted[0];
  const second = sorted[1]?.[1].score ?? 0;
  const confidence = Math.min(1, top.score / (top.score + second + 5));

  signals.push(...top.reasons);
  return { platform_code: topCode, confidence, signals };
}
