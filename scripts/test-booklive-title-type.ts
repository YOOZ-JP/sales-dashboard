/**
 * Unit checks for BookLive resolveTitleAndType after the 版面→EB override
 * audit (six-month official ledger review removed one unsupported title).
 * Run: node --import tsx scripts/test-booklive-title-type.ts
 */
import assert from "node:assert/strict";

import { resolveTitleAndType } from "../src/features/settlement/lib/parsers/booklive";

// Removed override: 融点〜とけあい〜[完全版]【特装版】 with 版面 falls back to base EP.
{
  const r = resolveTitleAndType("融点〜とけあい〜[完全版]【特装版】", "版面");
  assert.equal(r.type, "EP", "removed 版面→EB override falls back to base EP");
  // The title_aliases rewrite is independent of the type override and must survive.
  assert.equal(r.title_jp, "融点 [完全版](巻)", "title alias rewrite still applies");
}

// Still-supported override: 肝臓を奪われた妻 with 版面 stays EB.
{
  const r = resolveTitleAndType("肝臓を奪われた妻", "版面");
  assert.equal(r.type, "EB", "remaining 版面→EB override still resolves EB");
  assert.equal(r.title_jp, "肝臓を奪われた妻");
}

// WT→WR override: 融点〜とけあい〜 with WT resolves WR.
{
  const r = resolveTitleAndType("融点〜とけあい〜", "WT");
  assert.equal(r.type, "WR", "WT→WR override still resolves WR");
  assert.equal(r.title_jp, "融点〜とけあい〜");
}

console.log("test-booklive-title-type: all assertions passed");
