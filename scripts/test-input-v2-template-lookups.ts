/**
 * Sanity checks for the golden-template fallback lookups.
 * Run: node --import tsx scripts/test-input-v2-template-lookups.ts
 */

import assert from "node:assert/strict";

import {
  clientCodeToDisplay,
  loadInputV2TemplateLookups,
  platformCodeToChannel,
  rawChannelCodeToTemplate,
} from "../src/features/settlement/lib/export/input-v2-template-lookups";

async function main() {
  const lookups = await loadInputV2TemplateLookups();

  // Transactional rows are intentionally stripped from the sanitized v3
  // workbook, so channel modal attributes must not be recovered from a golden
  // settlement file. Known channels remain available and their client fallback
  // is null; DB/raw client codes are authoritative.
  for (const channel of ["cmoa", "piccoma", "line_ads", "booklive", "renta"]) {
    assert.ok(lookups.channelByCode.has(channel), `${channel} channel master exists`);
    assert.equal(lookups.channelByCode.get(channel)?.clients, null, `${channel} has no transactional client fallback`);
  }

  assert.equal(platformCodeToChannel("line_ad"), "line_ads", "line_ad alias");
  assert.equal(platformCodeToChannel("mediado"), "mediado_sales", "mediado alias");
  assert.equal(platformCodeToChannel("ebj_line"), "ebj", "ebj_line alias");
  assert.equal(platformCodeToChannel("u_next"), "u-next", "u_next alias");
  assert.equal(rawChannelCodeToTemplate("sb_creative"), "sb creative", "raw sb_creative alias");
  assert.equal(
    rawChannelCodeToTemplate("piccoma_gaiakuhan"),
    "piccoma_sales",
    "raw piccoma_gaiakuhan alias",
  );
  assert.equal(rawChannelCodeToTemplate("Jumptoon"), "Jumptoon", "known raw channel preserved");

  assert.equal(clientCodeToDisplay("nttsolmare"), "NTTsolmare", "nttsolmare display");
  assert.equal(
    clientCodeToDisplay("line_dl_frontier"),
    "Line Digital Frontier",
    "line_dl_frontier display",
  );
  assert.equal(clientCodeToDisplay("papyless"), "PAPYLESS", "papyless display");
  assert.equal(clientCodeToDisplay("u_next"), "U-NEXT", "u_next display");
  assert.equal(clientCodeToDisplay("sb_creative"), "sb creative", "sb_creative display");
  assert.equal(clientCodeToDisplay("comico_jp"), "comico JP", "comico_jp display");
  assert.equal(clientCodeToDisplay("comico"), "comico JP", "comico display");
  assert.equal(clientCodeToDisplay("MBJ"), "MBJ", "client code lookup is case-insensitive");
  assert.equal(clientCodeToDisplay("unknown_client"), null, "unknown client code → null");

  // Row-level raw channel codes resolve against the template, including
  // mixed-case codes like Jumptoon (matched case-insensitively by the loader).
  const channelClients = new Map(
    [...lookups.channelByCode.values()].map((info) => [
      info.channel.toLowerCase(),
      info.clients,
    ]),
  );
  // Sanitized template channel entries carry no client modal values.
  for (const channel of ["bookcomi", "dmm_fanza", "line", "ebj_webtoon", "jumptoon", "manga mee"]) {
    assert.ok(channelClients.has(channel), `${channel} channel master exists`);
    assert.equal(channelClients.get(channel), null, `${channel} client fallback stays null`);
  }

  assert.ok(lookups.channelByCode.size > 0, "channel lookup is non-empty");
  assert.ok(lookups.titleByChannelTitle.size > 0, "title lookup is non-empty");

  console.log(
    `OK: ${lookups.channelByCode.size} channels, ${lookups.titleByChannelTitle.size} title keys`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
